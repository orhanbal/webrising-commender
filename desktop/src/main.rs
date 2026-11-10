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

mod agent;
mod store;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use store::{secret_key, Data, SavedHost, Store};
use tauri::{Emitter, Manager};
use wc_ssh_core::client::{
    connect, connect_via, ConnectOptions, Connection, Credential, LocalForward, ShellEvent,
    ShellWriter, SshError,
};
use wc_ssh_core::sftp::{self as sftp_path, Entry, Sftp};
use wc_ssh_core::HostProfile;
use wc_vault::{Backend, MemoryStore, OsKeyring, SecretStore};

pub(crate) const KEYRING_SERVICE: &str = "app.wecommander.desktop";

struct Terminal {
    writer: Arc<ShellWriter>,
    // Keeps the SSH connection open while the terminal is; the file
    // manager (A09) opens its SFTP session on the same connection.
    connection: Arc<Connection>,
    sftp: Arc<tokio::sync::Mutex<Option<Arc<Sftp>>>>,
    /// Local port forwards on this connection (A10); dropped with the tab.
    forwards: Arc<Mutex<Vec<(LocalForward, String)>>>,
    /// Keeps the jump host connection alive while this terminal uses it.
    _jump: Option<Arc<Connection>>,
}

pub(crate) struct AppState {
    data: Mutex<Data>,
    store: Store,
    pub(crate) vault: Box<dyn SecretStore>,
    /// False when no OS keyring answered (headless Linux): secrets are then
    /// kept only until the app closes.
    pub(crate) vault_persistent: bool,
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
    version: String,
    vault_backend: &'static str,
    vault_persistent: bool,
    os: &'static str,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> AppInfo {
    AppInfo {
        // The installer version (0.1.<CI run>), not the crate version.
        version: app.package_info().version.to_string(),
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
    key_path: Option<String>,
    jump_id: Option<String>,
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
            key_path: h.key_path.clone(),
            jump_id: h.jump_id.clone(),
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
    jump_id: Option<String>,
) -> Result<Vec<HostView>, String> {
    let profile = HostProfile::new(&label, &host, port, &user).map_err(|e| e.to_string())?;
    let auth_kind = if auth_kind == "password" {
        "password"
    } else {
        "key"
    };
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let jump_id = jump_id.filter(|j| data.hosts.iter().any(|h| &h.id == j));
        data.hosts.push(SavedHost {
            id: uuid::Uuid::new_v4().to_string(),
            profile,
            auth_kind: auth_kind.into(),
            key_path: None,
            jump_id,
        });
        state.save(&data)?;
    }
    host_views(&state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    added: usize,
    skipped: usize,
    hosts: Vec<HostView>,
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(Into::into)
}

/// Imports the concrete hosts of `~/.ssh/config`; hosts already saved
/// (same user, address and port) are skipped.
#[tauri::command]
fn import_ssh_config(state: tauri::State<'_, AppState>) -> Result<ImportResult, String> {
    let home = home_dir().ok_or("home folder not found")?;
    let path = home.join(".ssh").join("config");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let default_user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".into());
    let found = wc_ssh_core::ssh_config::parse(&text, &home.to_string_lossy(), &default_user);
    let (mut added, mut skipped) = (0, 0);
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        for host in found {
            let exists = data.hosts.iter().any(|h| {
                h.profile.host == host.profile.host
                    && h.profile.port == host.profile.port
                    && h.profile.user == host.profile.user
            });
            if exists {
                skipped += 1;
                continue;
            }
            data.hosts.push(SavedHost {
                id: uuid::Uuid::new_v4().to_string(),
                profile: host.profile,
                auth_kind: "key".into(),
                key_path: host.identity_file,
                jump_id: None,
            });
            added += 1;
        }
        state.save(&data)?;
    }
    Ok(ImportResult {
        added,
        skipped,
        hosts: host_views(&state)?,
    })
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
        for h in data.hosts.iter_mut() {
            if h.jump_id.as_deref() == Some(id.as_str()) {
                h.jump_id = None;
            }
        }
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
    /// Read the private key from this file instead (remembered per host).
    key_path: Option<String>,
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
    // Key file: chosen now, or remembered for the host.
    let key_file = auth
        .key_path
        .clone()
        .filter(|p| !p.is_empty())
        .or_else(|| saved.key_path.clone());
    let typed = !auth.secret.is_empty();
    let from_file =
        kind == "key" && !typed && auth.key_path.as_deref().is_some_and(|p| !p.is_empty());
    let secret = if typed {
        auth.secret.clone()
    } else if let Some(stored) = (!from_file)
        .then(|| state.vault.get(&secret_key(&id, kind)).ok().flatten())
        .flatten()
    {
        stored
    } else if let (true, Some(path)) = (kind == "key", key_file.as_deref()) {
        std::fs::read_to_string(path).map_err(|e| format!("key file {path}: {e}"))?
    } else {
        return Err("no saved credential for this host; enter it once".into());
    };
    let passphrase = if typed || from_file {
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
    // A10: reach the host through its jump host with the jump host's own
    // saved credential and trusted key.
    let jump_conn = match &saved.jump_id {
        Some(jump_id) => Some(Arc::new(connect_jump(&state, jump_id).await?)),
        None => None,
    };
    let attempt = match &jump_conn {
        Some(jump) => connect_via(jump, &saved.profile, &credential, &options).await,
        None => connect(&saved.profile, &credential, &options).await,
    };
    let conn = match attempt {
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
            if from_file {
                h.key_path = auth.key_path.clone();
            }
        }
        state.save(&data)?;
    }
    if from_file && auth.remember {
        // The key stays in its file; only its passphrase goes to the keyring.
        if let Some(p) = &passphrase {
            let _ = state.vault.put(&secret_key(&id, "passphrase"), p);
        }
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
            connection: Arc::new(conn),
            sftp: Arc::new(tokio::sync::Mutex::new(None)),
            forwards: Arc::new(Mutex::new(Vec::new())),
            _jump: jump_conn,
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

/// Connects to a saved host used as a jump host, with its saved credential
/// (keyring secret or key file) and the host key already trusted for it.
async fn connect_jump(state: &AppState, jump_id: &str) -> Result<Connection, String> {
    let (jump, trusted) = {
        let data = state.data.lock().map_err(|_| "busy")?;
        let jump = data
            .hosts
            .iter()
            .find(|h| h.id == jump_id)
            .cloned()
            .ok_or("jump host no longer exists")?;
        let trusted = data
            .known_hosts
            .get(&format!("{}:{}", jump.profile.host, jump.profile.port))
            .cloned();
        (jump, trusted)
    };
    let name = jump.profile.label.clone();
    let trusted = trusted.ok_or(format!(
        "jump host {name}: connect to it once directly to approve its host key"
    ))?;
    let kind = jump.auth_kind.as_str();
    let secret = state
        .vault
        .get(&secret_key(&jump.id, kind))
        .ok()
        .flatten()
        .or_else(|| {
            (kind == "key")
                .then(|| {
                    jump.key_path
                        .as_deref()
                        .and_then(|p| std::fs::read_to_string(p).ok())
                })
                .flatten()
        })
        .ok_or(format!(
            "jump host {name}: no saved credential; connect to it once and save it"
        ))?;
    let credential = if kind == "password" {
        Credential::Password(secret)
    } else {
        Credential::PrivateKey {
            key: secret,
            passphrase: state
                .vault
                .get(&secret_key(&jump.id, "passphrase"))
                .ok()
                .flatten(),
        }
    };
    let options = ConnectOptions {
        trusted_fingerprint: Some(trusted),
        ..Default::default()
    };
    connect(&jump.profile, &credential, &options)
        .await
        .map_err(|e| format!("jump host {name}: {e}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardView {
    local: String,
    remote: String,
}

fn forward_views(list: &[(LocalForward, String)]) -> Vec<ForwardView> {
    list.iter()
        .map(|(f, remote)| ForwardView {
            local: f.local.to_string(),
            remote: remote.clone(),
        })
        .collect()
}

/// Starts `ssh -L`-style forwarding on terminal `session_id`'s connection:
/// 127.0.0.1:`local_port` (0 = any free port) -> `remote_host:remote_port`
/// as seen from the server.
#[tauri::command]
async fn forward_start(
    state: tauri::State<'_, AppState>,
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<Vec<ForwardView>, String> {
    let remote_host = remote_host.trim().to_owned();
    if remote_host.is_empty() || remote_host.len() > 253 || remote_port == 0 {
        return Err("remote host and port are required".into());
    }
    let (connection, forwards) = {
        let terminals = state.terminals.lock().map_err(|_| "busy")?;
        let t = terminals.get(&session_id).ok_or("terminal closed")?;
        (t.connection.clone(), t.forwards.clone())
    };
    // Only on this computer: never listen on other interfaces.
    let forward = connection
        .forward_local(
            &format!("127.0.0.1:{local_port}"),
            &remote_host,
            remote_port,
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut list = forwards.lock().map_err(|_| "busy")?;
    list.push((forward, format!("{remote_host}:{remote_port}")));
    Ok(forward_views(&list))
}

#[tauri::command]
fn forward_list(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ForwardView>, String> {
    let forwards = {
        let terminals = state.terminals.lock().map_err(|_| "busy")?;
        terminals
            .get(&session_id)
            .ok_or("terminal closed")?
            .forwards
            .clone()
    };
    let list = forwards.lock().map_err(|_| "busy")?;
    Ok(forward_views(&list))
}

#[tauri::command]
fn forward_stop(
    state: tauri::State<'_, AppState>,
    session_id: String,
    local: String,
) -> Result<Vec<ForwardView>, String> {
    let forwards = {
        let terminals = state.terminals.lock().map_err(|_| "busy")?;
        terminals
            .get(&session_id)
            .ok_or("terminal closed")?
            .forwards
            .clone()
    };
    let mut list = forwards.lock().map_err(|_| "busy")?;
    list.retain(|(f, _)| f.local.to_string() != local);
    Ok(forward_views(&list))
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

// ---- file manager (A09) ---------------------------------------------------

async fn sftp_for(state: &AppState, session_id: &str) -> Result<Arc<Sftp>, String> {
    let (connection, slot) = {
        let terminals = state.terminals.lock().map_err(|_| "busy")?;
        let t = terminals.get(session_id).ok_or("terminal closed")?;
        (t.connection.clone(), t.sftp.clone())
    };
    let mut slot = slot.lock().await;
    if let Some(sftp) = slot.as_ref() {
        return Ok(sftp.clone());
    }
    let sftp = Arc::new(connection.sftp().await.map_err(|e| e.to_string())?);
    *slot = Some(sftp.clone());
    Ok(sftp)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Listing {
    path: String,
    parent: String,
    entries: Vec<Entry>,
}

#[tauri::command]
async fn files_list(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: Option<String>,
) -> Result<Listing, String> {
    let sftp = sftp_for(&state, &session_id).await?;
    let path = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => p,
        None => sftp.home().await.map_err(|e| e.to_string())?,
    };
    let entries = sftp.list(&path).await.map_err(|e| e.to_string())?;
    Ok(Listing {
        parent: sftp_path::parent(&path),
        path,
        entries,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    transfer_id: String,
    done: u64,
    total: u64,
}

fn progress_reporter(app: tauri::AppHandle, transfer_id: String) -> impl FnMut(u64, u64) {
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    move |done, total| {
        // At most ~10 events a second, plus the final one.
        if done == total || last.elapsed().as_millis() >= 100 {
            last = std::time::Instant::now();
            let _ = app.emit(
                "transfer-progress",
                TransferProgress {
                    transfer_id: transfer_id.clone(),
                    done,
                    total,
                },
            );
        }
    }
}

#[tauri::command]
async fn files_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    remote: String,
    local: String,
    transfer_id: String,
) -> Result<u64, String> {
    let sftp = sftp_for(&state, &session_id).await?;
    sftp.download(
        &remote,
        std::path::Path::new(&local),
        progress_reporter(app, transfer_id),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn files_upload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    local: String,
    remote_dir: String,
    transfer_id: String,
) -> Result<u64, String> {
    let local = std::path::PathBuf::from(local);
    let name = local
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("not a file")?
        .to_owned();
    if !local.is_file() {
        return Err(format!("{name}: only files can be uploaded (not folders)"));
    }
    let sftp = sftp_for(&state, &session_id).await?;
    sftp.upload(
        &local,
        &sftp_path::join(&remote_dir, &name),
        progress_reporter(app, transfer_id),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn files_mkdir(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sftp = sftp_for(&state, &session_id).await?;
    sftp.mkdir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn files_rename(
    state: tauri::State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = sftp_for(&state, &session_id).await?;
    sftp.rename(&from, &to).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn files_delete(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sftp = sftp_for(&state, &session_id).await?;
    sftp.remove(&path).await.map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            import_ssh_config,
            connect_host,
            terminal_write,
            terminal_resize,
            terminal_close,
            files_list,
            files_download,
            files_upload,
            files_mkdir,
            files_rename,
            files_delete,
            forward_start,
            forward_list,
            forward_stop,
            agent::agent_status,
            agent::agent_link_start,
            agent::agent_overview,
            agent::agent_decide,
            agent::agent_unlink
        ])
        .run(tauri::generate_context!())
        .expect("WECOMMANDER desktop failed to start");
}
