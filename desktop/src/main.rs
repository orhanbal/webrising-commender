//! WECOMMANDER desktop app.
//!
//! One window with two workspaces: **User** (SSH to your own servers) and
//! **Agent** (the WECOMMANDER account and its approvals, B09).
//!
//! User Mode today: saved hosts and trusted host keys (A07, `store.rs`),
//! passwords and keys in the OS keyring (wc-vault), connection test with
//! host key approval (A02) and interactive terminals (A03): the shell runs
//! on a pseudo-terminal through wc-ssh-core and is drawn by xterm.js.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod store;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use store::{secret_key, Data, SavedHost, Store};
use tauri::{Emitter, Manager};
use wc_ssh_core::client::{
    connect, ConnectOptions, Connection, Credential, ShellEvent, ShellWriter, SshError,
};
use wc_ssh_core::HostProfile;
use wc_vault::{Backend, MemoryStore, OsKeyring, SecretStore};

const KEYRING_SERVICE: &str = "app.wecommander.desktop";

struct Terminal {
    writer: Arc<ShellWriter>,
    // Keeps the SSH connection open while the terminal is.
    _connection: Arc<Connection>,
}

struct AppState {
    data: Mutex<Data>,
    store: Store,
    vault: Box<dyn SecretStore>,
    /// False when no OS keyring answered (headless Linux): secrets are then
    /// kept only until the app closes.
    vault_persistent: bool,
    terminals: Mutex<HashMap<String, Terminal>>,
}

impl AppState {
    fn save(&self, data: &Data) -> Result<(), String> {
        self.store
            .save(data)
            .map_err(|e| format!("could not save hosts: {e}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    vault_backend: &'static str,
    vault_persistent: bool,
    os: &'static str,
}

#[tauri::command]
fn app_info(state: tauri::State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        vault_backend: state.vault.backend().label(),
        vault_persistent: state.vault_persistent,
        os: std::env::consts::OS,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostView {
    id: String,
    label: String,
    target: String,
    auth_kind: String,
    saved_secret: bool,
    trusted_key: Option<String>,
}

fn host_views(state: &AppState) -> Result<Vec<HostView>, String> {
    let data = state.data.lock().map_err(|_| "busy")?;
    Ok(data
        .hosts
        .iter()
        .map(|h| HostView {
            id: h.id.clone(),
            label: h.profile.label.clone(),
            target: h.profile.display_target(),
            auth_kind: h.auth_kind.clone(),
            saved_secret: state
                .vault
                .get(&secret_key(&h.id, &h.auth_kind))
                .ok()
                .flatten()
                .is_some(),
            trusted_key: data
                .known_hosts
                .get(&format!("{}:{}", h.profile.host, h.profile.port))
                .cloned(),
        })
        .collect())
}

#[tauri::command]
fn list_hosts(state: tauri::State<'_, AppState>) -> Result<Vec<HostView>, String> {
    host_views(&state)
}

#[tauri::command]
fn add_host(
    state: tauri::State<'_, AppState>,
    label: String,
    host: String,
    port: u16,
    user: String,
    auth_kind: String,
) -> Result<Vec<HostView>, String> {
    let profile = HostProfile::new(&label, &host, port, &user).map_err(|e| e.to_string())?;
    let auth_kind = if auth_kind == "password" {
        "password"
    } else {
        "key"
    };
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.hosts.push(SavedHost {
            id: uuid::Uuid::new_v4().to_string(),
            profile,
            auth_kind: auth_kind.into(),
        });
        state.save(&data)?;
    }
    host_views(&state)
}

fn forget_secrets(state: &AppState, id: &str) {
    for part in ["password", "key", "passphrase"] {
        let _ = state.vault.delete(&secret_key(id, part));
    }
}

#[tauri::command]
fn delete_host(state: tauri::State<'_, AppState>, id: String) -> Result<Vec<HostView>, String> {
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.hosts.retain(|h| h.id != id);
        state.save(&data)?;
    }
    forget_secrets(&state, &id);
    host_views(&state)
}

#[tauri::command]
fn forget_secret(state: tauri::State<'_, AppState>, id: String) -> Result<Vec<HostView>, String> {
    forget_secrets(&state, &id);
    host_views(&state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthInput {
    /// "password" or "key".
    kind: String,
    /// Empty: use the secret saved in the keyring.
    secret: String,
    passphrase: Option<String>,
    /// Save the secret in the OS keyring after a successful login.
    remember: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum ConnectOutcome {
    #[serde(rename_all = "camelCase")]
    Connected { fingerprint: String, output: String },
    #[serde(rename_all = "camelCase")]
    TerminalOpened {
        fingerprint: String,
        session_id: String,
    },
    /// First contact: show the key and ask before trusting it.
    #[serde(rename_all = "camelCase")]
    HostKeyUnknown {
        algorithm: String,
        fingerprint: String,
    },
    /// The host key differs from the trusted one: possible attack.
    #[serde(rename_all = "camelCase")]
    HostKeyChanged {
        trusted: String,
        algorithm: String,
        fingerprint: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    /// Base64: output is raw bytes, not always valid UTF-8 at chunk edges.
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    code: Option<u32>,
}

/// Connects to saved host `id`, checks the host key, then either runs
/// `whoami` (`mode` "test") or opens an interactive terminal of `cols` x
/// `rows` (`mode` "terminal"). `accept_fingerprint` is the key the person
/// just approved in the host key dialog.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn connect_host(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    auth: AuthInput,
    accept_fingerprint: Option<String>,
    mode: String,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<ConnectOutcome, String> {
    let (saved, trusted) = {
        let data = state.data.lock().map_err(|_| "busy")?;
        let saved = data
            .hosts
            .iter()
            .find(|h| h.id == id)
            .cloned()
            .ok_or("host not found")?;
        let trusted = data
            .known_hosts
            .get(&format!("{}:{}", saved.profile.host, saved.profile.port))
            .cloned();
        (saved, trusted)
    };
    let host_id = format!("{}:{}", saved.profile.host, saved.profile.port);
    let kind = if auth.kind == "password" {
        "password"
    } else {
        "key"
    };
    let typed = !auth.secret.is_empty();
    let secret = if typed {
        auth.secret.clone()
    } else {
        state
            .vault
            .get(&secret_key(&id, kind))
            .ok()
            .flatten()
            .ok_or("no saved credential for this host; enter it once")?
    };
    let passphrase = if typed {
        auth.passphrase.clone().filter(|p| !p.is_empty())
    } else {
        state
            .vault
            .get(&secret_key(&id, "passphrase"))
            .ok()
            .flatten()
    };
    let credential = if kind == "password" {
        Credential::Password(secret.clone())
    } else {
        Credential::PrivateKey {
            key: secret.clone(),
            passphrase: passphrase.clone(),
        }
    };
    let options = ConnectOptions {
        // A just-approved key wins over the stored one (the person saw the
        // "key changed" warning before approving).
        trusted_fingerprint: accept_fingerprint.or(trusted),
        ..Default::default()
    };
    let conn = match connect(&saved.profile, &credential, &options).await {
        Ok(conn) => conn,
        Err(SshError::HostKeyUnknown(key)) => {
            return Ok(ConnectOutcome::HostKeyUnknown {
                algorithm: key.algorithm,
                fingerprint: key.fingerprint,
            })
        }
        Err(SshError::HostKeyChanged { trusted, presented }) => {
            return Ok(ConnectOutcome::HostKeyChanged {
                trusted,
                algorithm: presented.algorithm,
                fingerprint: presented.fingerprint,
            })
        }
        Err(err) => return Err(err.to_string()),
    };

    // Logged in: remember the host key, the auth method and, if asked, the secret.
    let fingerprint = conn.host_key().fingerprint.clone();
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.known_hosts.insert(host_id, fingerprint.clone());
        if let Some(h) = data.hosts.iter_mut().find(|h| h.id == id) {
            h.auth_kind = kind.into();
        }
        state.save(&data)?;
    }
    if typed && auth.remember {
        let _ = state.vault.put(&secret_key(&id, kind), &secret);
        match &passphrase {
            Some(p) if kind == "key" => {
                let _ = state.vault.put(&secret_key(&id, "passphrase"), p);
            }
            _ => {
                let _ = state.vault.delete(&secret_key(&id, "passphrase"));
            }
        }
    }

    if mode != "terminal" {
        let out = conn.exec("whoami", 4096).await.map_err(|e| e.to_string())?;
        let _ = conn.close().await;
        return Ok(ConnectOutcome::Connected {
            fingerprint,
            output: String::from_utf8_lossy(&out.stdout).trim().to_owned(),
        });
    }

    let shell = conn
        .open_shell(
            "xterm-256color",
            cols.unwrap_or(80).clamp(10, 1000),
            rows.unwrap_or(24).clamp(4, 500),
        )
        .await
        .map_err(|e| e.to_string())?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let writer = Arc::new(shell.writer);
    state.terminals.lock().map_err(|_| "busy")?.insert(
        session_id.clone(),
        Terminal {
            writer,
            _connection: Arc::new(conn),
        },
    );
    let mut reader = shell.reader;
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let engine = base64::engine::general_purpose::STANDARD;
        while let Some(event) = reader.next().await {
            match event {
                ShellEvent::Output(bytes) => {
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id: sid.clone(),
                            data: engine.encode(bytes),
                        },
                    );
                }
                ShellEvent::Exit(code) => {
                    let _ = app.emit(
                        "terminal-exit",
                        TerminalExit {
                            session_id: sid.clone(),
                            code,
                        },
                    );
                }
            }
        }
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut terminals) = state.terminals.lock() {
                terminals.remove(&sid);
            }
        }
    });
    Ok(ConnectOutcome::TerminalOpened {
        fingerprint,
        session_id,
    })
}

fn terminal_writer(state: &AppState, session_id: &str) -> Result<Arc<ShellWriter>, String> {
    state
        .terminals
        .lock()
        .map_err(|_| "busy")?
        .get(session_id)
        .map(|t| t.writer.clone())
        .ok_or_else(|| "terminal closed".to_string())
}

#[tauri::command]
async fn terminal_write(
    state: tauri::State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let writer = terminal_writer(&state, &session_id)?;
    writer
        .write(data.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn terminal_resize(
    state: tauri::State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let writer = terminal_writer(&state, &session_id)?;
    writer
        .resize(cols.clamp(10, 1000), rows.clamp(4, 500))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn terminal_close(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let removed = state
        .terminals
        .lock()
        .map_err(|_| "busy")?
        .remove(&session_id);
    if let Some(terminal) = removed {
        let _ = terminal.writer.close().await;
    }
    Ok(())
}

fn open_vault() -> (Box<dyn SecretStore>, bool) {
    let keyring = OsKeyring::new(KEYRING_SERVICE);
    if keyring.probe() {
        (Box::new(keyring), true)
    } else {
        (Box::new(MemoryStore::default()), false)
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = Store::new(&dir);
            let data = store.load();
            let (vault, vault_persistent) = open_vault();
            debug_assert!(vault_persistent || vault.backend() == Backend::Memory);
            app.manage(AppState {
                data: Mutex::new(data),
                store,
                vault,
                vault_persistent,
                terminals: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_hosts,
            add_host,
            delete_host,
            forget_secret,
            connect_host,
            terminal_write,
            terminal_resize,
            terminal_close
        ])
        .run(tauri::generate_context!())
        .expect("WECOMMANDER desktop failed to start");
}
