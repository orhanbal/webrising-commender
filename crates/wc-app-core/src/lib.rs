//! WECOMMANDER app core: everything behind the app windows, without any UI
//! toolkit. The native apps (WinUI 3, SwiftUI) use it through the
//! `wecommander-core` helper process; the Linux app (Tauri) links it.
//!
//! Saved hosts and trusted host keys (`store`), credentials in the OS keyring
//! (wc-vault), connection with host key approval, terminals on a pty, SFTP,
//! jump hosts, local forwards and saved tunnels. Events (terminal output,
//! transfer progress, changes) go to an [`EventSink`].
#![allow(clippy::too_many_arguments)]

pub mod library;
pub mod store;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use store::{secret_key, Data, SavedHost, Store};
use wc_ssh_core::client::{
    connect, connect_via, ConnectOptions, Connection, Credential, LocalForward, ShellEvent,
    ShellWriter, SshError,
};
use wc_ssh_core::sftp::{self as sftp_path, Entry, Sftp};
use wc_ssh_core::HostProfile;
use wc_vault::{MemoryStore, OsKeyring, SecretStore};

/// Receives events: `terminal-output`, `terminal-exit`, `transfer-progress`,
/// `tunnels-changed` and `changed` (hosts or tunnels changed).
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, name: &str, payload: serde_json::Value);
}

impl AppState {
    pub fn emit<T: Serialize>(&self, name: &str, payload: T) {
        self.events.emit(
            name,
            serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
        );
    }

    /// Hosts or saved tunnels changed (menus and lists refresh).
    pub fn changed(&self) {
        self.emit("changed", ());
    }
}

/// Opens the core: hosts from `data_dir/hosts.json`, secrets in the OS
/// keyring under `keyring_service` (memory only when no keyring answers).
pub fn open(data_dir: &Path, keyring_service: &str, events: Arc<dyn EventSink>) -> Arc<AppState> {
    let store = Store::new(data_dir);
    let data = store.load();
    let keyring = OsKeyring::new(keyring_service);
    let (vault, vault_persistent): (Box<dyn SecretStore>, bool) = if keyring.probe() {
        (Box::new(keyring), true)
    } else {
        (Box::new(MemoryStore::default()), false)
    };
    Arc::new(AppState {
        data: Mutex::new(data),
        store,
        vault,
        vault_persistent,
        terminals: Mutex::new(HashMap::new()),
        background: Background::default(),
        events,
    })
}

pub struct Terminal {
    pub writer: Arc<ShellWriter>,
    // Keeps the SSH connection open while the terminal is; the file
    // manager (A09) opens its SFTP session on the same connection.
    pub connection: Arc<Connection>,
    pub sftp: Arc<tokio::sync::Mutex<Option<Arc<Sftp>>>>,
    /// Local port forwards on this connection (A10); dropped with the tab.
    pub forwards: Arc<Mutex<Vec<(LocalForward, String)>>>,
    /// Keeps the jump host connection alive while this terminal uses it.
    pub _jump: Option<Arc<Connection>>,
}

pub struct AppState {
    pub data: Mutex<Data>,
    pub store: Store,
    pub(crate) vault: Box<dyn SecretStore>,
    /// False when no OS keyring answered (headless Linux): secrets are then
    /// kept only until the app closes.
    pub(crate) vault_persistent: bool,
    pub terminals: Mutex<HashMap<String, Terminal>>,
    pub background: Background,
    events: Arc<dyn EventSink>,
}

impl AppState {
    pub(crate) fn save(&self, data: &Data) -> Result<(), String> {
        self.store
            .save(data)
            .map_err(|e| format!("could not save hosts: {e}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub vault_backend: &'static str,
    pub vault_persistent: bool,
    pub os: &'static str,
}

pub fn app_info(state: &Arc<AppState>, version: &str) -> AppInfo {
    AppInfo {
        // The installer version (0.1.<CI run>), not the crate version.
        version: version.to_owned(),
        vault_backend: state.vault.backend().label(),
        vault_persistent: state.vault_persistent,
        os: std::env::consts::OS,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub id: String,
    pub label: String,
    pub target: String,
    pub auth_kind: String,
    pub saved_secret: bool,
    pub key_path: Option<String>,
    pub jump_id: Option<String>,
    pub trusted_key: Option<String>,
    pub group: Option<String>,
    pub user: String,
    pub host: String,
    pub port: u16,
}

pub(crate) fn host_views(state: &AppState) -> Result<Vec<HostView>, String> {
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
            group: h.group.clone(),
            user: h.profile.user.clone(),
            host: h.profile.host.clone(),
            port: h.profile.port,
        })
        .collect())
}

pub fn list_hosts(state: &Arc<AppState>) -> Result<Vec<HostView>, String> {
    host_views(state)
}

#[allow(clippy::too_many_arguments)]
pub fn add_host(
    state: &Arc<AppState>,
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
            tunnels: Vec::new(),
            group: None,
        });
        state.save(&data)?;
    }
    state.changed();
    host_views(state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: usize,
    pub skipped: usize,
    pub hosts: Vec<HostView>,
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(Into::into)
}

/// Imports the concrete hosts of `~/.ssh/config`; hosts already saved
/// (same user, address and port) are skipped.
pub fn import_ssh_config(state: &Arc<AppState>) -> Result<ImportResult, String> {
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
                tunnels: Vec::new(),
                group: None,
            });
            added += 1;
        }
        state.save(&data)?;
    }
    state.changed();
    Ok(ImportResult {
        added,
        skipped,
        hosts: host_views(state)?,
    })
}

fn forget_secrets(state: &AppState, id: &str) {
    for part in ["password", "key", "passphrase"] {
        let _ = state.vault.delete(&secret_key(id, part));
    }
}

pub fn delete_host(state: &Arc<AppState>, id: String) -> Result<Vec<HostView>, String> {
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
    forget_secrets(state, &id);
    state.changed();
    host_views(state)
}

pub fn forget_secret(state: &Arc<AppState>, id: String) -> Result<Vec<HostView>, String> {
    forget_secrets(state, &id);
    host_views(state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthInput {
    /// "password" or "key".
    pub kind: String,
    /// Empty: use the secret saved in the keyring.
    pub secret: String,
    pub passphrase: Option<String>,
    /// Save the secret in the OS keyring after a successful login.
    pub remember: bool,
    /// Read the private key from this file instead (remembered per host).
    pub key_path: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ConnectOutcome {
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
pub struct TerminalOutput {
    pub session_id: String,
    /// Base64: output is raw bytes, not always valid UTF-8 at chunk edges.
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub session_id: String,
    pub code: Option<u32>,
}

/// Connects to saved host `id`, checks the host key, then either runs
/// `whoami` (`mode` "test") or opens an interactive terminal of `cols` x
/// `rows` (`mode` "terminal"). `accept_fingerprint` is the key the person
/// just approved in the host key dialog.
#[allow(clippy::too_many_arguments)]
pub async fn connect_host(
    state: &Arc<AppState>,
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
        Some(jump_id) => Some(Arc::new(connect_jump(state, jump_id).await?)),
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
        library::record_connection(&mut data, &saved);
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
    let st = state.clone();
    tokio::spawn(async move {
        let engine = base64::engine::general_purpose::STANDARD;
        while let Some(event) = reader.next().await {
            match event {
                ShellEvent::Output(bytes) => {
                    st.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id: sid.clone(),
                            data: engine.encode(bytes),
                        },
                    );
                }
                ShellEvent::Exit(code) => {
                    st.emit(
                        "terminal-exit",
                        TerminalExit {
                            session_id: sid.clone(),
                            code,
                        },
                    );
                }
            }
        }
        if let Ok(mut terminals) = st.terminals.lock() {
            terminals.remove(&sid);
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
    connect_saved_direct(state, jump_id)
        .await
        .map_err(|e| format!("jump host {e}"))
}

/// Connects to saved host `id` without any dialog: saved credential, host
/// key already trusted. Errors start with the host's label.
pub async fn connect_saved_direct(state: &AppState, id: &str) -> Result<Connection, String> {
    let (host, trusted) = {
        let data = state.data.lock().map_err(|_| "busy")?;
        let host = data
            .hosts
            .iter()
            .find(|h| h.id == id)
            .cloned()
            .ok_or("host no longer exists")?;
        let trusted = data
            .known_hosts
            .get(&format!("{}:{}", host.profile.host, host.profile.port))
            .cloned();
        (host, trusted)
    };
    let name = host.profile.label.clone();
    let trusted = trusted.ok_or(format!(
        "{name}: connect to it once in a terminal to approve its host key"
    ))?;
    let credential = saved_credential(state, &host).ok_or(format!(
        "{name}: no saved credential; connect to it once and save it"
    ))?;
    let options = ConnectOptions {
        trusted_fingerprint: Some(trusted),
        ..Default::default()
    };
    connect(&host.profile, &credential, &options)
        .await
        .map_err(|e| format!("{name}: {e}"))
}

/// Connects to saved host `id` with saved credentials, through its jump host
/// when it has one. The jump connection is returned too: it must stay alive.
pub async fn connect_saved(
    state: &AppState,
    id: &str,
) -> Result<(Connection, Option<Arc<Connection>>), String> {
    let (host, trusted) = {
        let data = state.data.lock().map_err(|_| "busy")?;
        let host = data
            .hosts
            .iter()
            .find(|h| h.id == id)
            .cloned()
            .ok_or("host no longer exists")?;
        let trusted = data
            .known_hosts
            .get(&format!("{}:{}", host.profile.host, host.profile.port))
            .cloned();
        (host, trusted)
    };
    let Some(jump_id) = host.jump_id.clone() else {
        return Ok((connect_saved_direct(state, id).await?, None));
    };
    let name = host.profile.label.clone();
    let jump = Arc::new(connect_jump(state, &jump_id).await?);
    let trusted = trusted.ok_or(format!(
        "{name}: connect to it once in a terminal to approve its host key"
    ))?;
    let credential = saved_credential(state, &host).ok_or(format!(
        "{name}: no saved credential; connect to it once and save it"
    ))?;
    let options = ConnectOptions {
        trusted_fingerprint: Some(trusted),
        ..Default::default()
    };
    let conn = connect_via(&jump, &host.profile, &credential, &options)
        .await
        .map_err(|e| format!("{name}: {e}"))?;
    Ok((conn, Some(jump)))
}

fn saved_credential(state: &AppState, host: &SavedHost) -> Option<Credential> {
    let kind = host.auth_kind.as_str();
    let secret = state
        .vault
        .get(&secret_key(&host.id, kind))
        .ok()
        .flatten()
        .or_else(|| {
            (kind == "key")
                .then(|| {
                    host.key_path
                        .as_deref()
                        .and_then(|p| std::fs::read_to_string(p).ok())
                })
                .flatten()
        })?;
    Some(if kind == "password" {
        Credential::Password(secret)
    } else {
        Credential::PrivateKey {
            key: secret,
            passphrase: state
                .vault
                .get(&secret_key(&host.id, "passphrase"))
                .ok()
                .flatten(),
        }
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardView {
    pub local: String,
    pub remote: String,
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
pub async fn forward_start(
    state: &Arc<AppState>,
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

pub fn forward_list(state: &Arc<AppState>, session_id: String) -> Result<Vec<ForwardView>, String> {
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

pub fn forward_stop(
    state: &Arc<AppState>,
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

pub async fn terminal_write(
    state: &Arc<AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let writer = terminal_writer(state, &session_id)?;
    writer
        .write(data.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

pub async fn terminal_resize(
    state: &Arc<AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let writer = terminal_writer(state, &session_id)?;
    writer
        .resize(cols.clamp(10, 1000), rows.clamp(4, 500))
        .await
        .map_err(|e| e.to_string())
}

pub async fn terminal_close(state: &Arc<AppState>, session_id: String) -> Result<(), String> {
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
pub struct Listing {
    pub path: String,
    pub parent: String,
    pub entries: Vec<Entry>,
}

pub async fn files_list(
    state: &Arc<AppState>,
    session_id: String,
    path: Option<String>,
) -> Result<Listing, String> {
    let sftp = sftp_for(state, &session_id).await?;
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
pub struct TransferProgress {
    pub transfer_id: String,
    pub done: u64,
    pub total: u64,
}

fn progress_reporter(state: Arc<AppState>, transfer_id: String) -> impl FnMut(u64, u64) {
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    move |done, total| {
        // At most ~10 events a second, plus the final one.
        if done == total || last.elapsed().as_millis() >= 100 {
            last = std::time::Instant::now();
            state.emit(
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

pub async fn files_download(
    state: &Arc<AppState>,
    session_id: String,
    remote: String,
    local: String,
    transfer_id: String,
) -> Result<u64, String> {
    let sftp = sftp_for(state, &session_id).await?;
    sftp.download(
        &remote,
        std::path::Path::new(&local),
        progress_reporter(state.clone(), transfer_id),
    )
    .await
    .map_err(|e| e.to_string())
}

pub async fn files_upload(
    state: &Arc<AppState>,
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
    let sftp = sftp_for(state, &session_id).await?;
    sftp.upload(
        &local,
        &sftp_path::join(&remote_dir, &name),
        progress_reporter(state.clone(), transfer_id),
    )
    .await
    .map_err(|e| e.to_string())
}

pub async fn files_mkdir(
    state: &Arc<AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sftp = sftp_for(state, &session_id).await?;
    sftp.mkdir(&path).await.map_err(|e| e.to_string())
}

pub async fn files_rename(
    state: &Arc<AppState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = sftp_for(state, &session_id).await?;
    sftp.rename(&from, &to).await.map_err(|e| e.to_string())
}

pub async fn files_delete(
    state: &Arc<AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sftp = sftp_for(state, &session_id).await?;
    sftp.remove(&path).await.map_err(|e| e.to_string())
}

// ---- saved tunnels (run in the background, also from the tray) ----------

pub struct Running {
    pub _forward: LocalForward,
    pub _connection: Arc<Connection>,
    pub _jump: Option<Arc<Connection>>,
}

/// Tunnels started from the tray or the tunnel list, keyed `host#index`.
#[derive(Default)]
pub struct Background {
    pub running: Mutex<HashMap<String, Running>>,
}

fn key(host_id: &str, index: usize) -> String {
    format!("{host_id}#{index}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTunnelView {
    pub host_id: String,
    pub host_label: String,
    pub index: usize,
    pub local: String,
    pub remote: String,
    pub running: bool,
}

fn views(state: &AppState) -> Vec<SavedTunnelView> {
    let running = state
        .background
        .running
        .lock()
        .map(|r| r.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let Ok(data) = state.data.lock() else {
        return vec![];
    };
    data.hosts
        .iter()
        .flat_map(|h| {
            h.tunnels.iter().enumerate().map(|(i, t)| SavedTunnelView {
                host_id: h.id.clone(),
                host_label: h.profile.label.clone(),
                index: i,
                local: format!("127.0.0.1:{}", t.local_port),
                remote: format!("{}:{}", t.remote_host, t.remote_port),
                running: running.contains(&key(&h.id, i)),
            })
        })
        .collect()
}

pub fn saved_tunnels(state: &Arc<AppState>) -> Vec<SavedTunnelView> {
    views(state)
}

pub fn tunnel_save(
    state: &Arc<AppState>,
    host_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<Vec<SavedTunnelView>, String> {
    let remote_host = remote_host.trim().to_owned();
    if local_port == 0 || remote_port == 0 || remote_host.is_empty() || remote_host.len() > 253 {
        return Err("a saved tunnel needs a fixed local port, a remote host and a port".into());
    }
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let taken = data
            .hosts
            .iter()
            .flat_map(|h| h.tunnels.iter())
            .any(|t| t.local_port == local_port);
        if taken {
            return Err(format!(
                "local port {local_port} is already used by a saved tunnel"
            ));
        }
        let host = data
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or("host not found")?;
        host.tunnels.push(crate::store::SavedTunnel {
            local_port,
            remote_host,
            remote_port,
        });
        state.save(&data)?;
    }
    state.changed();
    Ok(views(state))
}

pub fn tunnel_delete(
    state: &Arc<AppState>,
    host_id: String,
    index: usize,
) -> Result<Vec<SavedTunnelView>, String> {
    stop_all_for(state, &host_id);
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let host = data
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or("host not found")?;
        if index < host.tunnels.len() {
            host.tunnels.remove(index);
        }
        state.save(&data)?;
    }
    state.changed();
    Ok(views(state))
}

/// Indexes shift when a tunnel is deleted, so stop the host's tunnels first.
fn stop_all_for(state: &AppState, host_id: &str) {
    if let Ok(mut running) = state.background.running.lock() {
        running.retain(|k, _| !k.starts_with(&format!("{host_id}#")));
    }
}

pub async fn tunnel_toggle(
    state: &Arc<AppState>,
    host_id: String,
    index: usize,
) -> Result<Vec<SavedTunnelView>, String> {
    toggle(state, &host_id, index).await?;
    Ok(views(state))
}

pub async fn toggle(state: &Arc<AppState>, host_id: &str, index: usize) -> Result<(), String> {
    let k = key(host_id, index);
    let was_running = state
        .background
        .running
        .lock()
        .map_err(|_| "busy")?
        .remove(&k)
        .is_some();
    if !was_running {
        let tunnel = {
            let data = state.data.lock().map_err(|_| "busy")?;
            data.hosts
                .iter()
                .find(|h| h.id == host_id)
                .and_then(|h| h.tunnels.get(index).cloned())
                .ok_or("tunnel not found")?
        };
        let (conn, jump) = connect_saved(state, host_id).await?;
        let conn = Arc::new(conn);
        let forward = conn
            .forward_local(
                &format!("127.0.0.1:{}", tunnel.local_port),
                &tunnel.remote_host,
                tunnel.remote_port,
            )
            .await
            .map_err(|e| e.to_string())?;
        state.background.running.lock().map_err(|_| "busy")?.insert(
            k,
            Running {
                _forward: forward,
                _connection: conn,
                _jump: jump,
            },
        );
    }
    state.changed();
    state.emit("tunnels-changed", ());
    Ok(())
}
