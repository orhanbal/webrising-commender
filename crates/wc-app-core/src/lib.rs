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
pub mod serial;
pub mod store;
pub mod stream;
pub mod sync;
pub mod team;
pub mod telnet;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use store::{secret_key, Data, SavedHost, Store};
use wc_ssh_core::client::{
    connect, connect_via, ConnectOptions, Connection, Credential, LocalForward, RemoteForward,
    ShellEvent, SshError,
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
        sync_pending: sync::Pending::default(),
        team_pending: team::TeamPending::default(),
        events,
    })
}

pub struct Terminal {
    pub writer: stream::TermWriter,
    // Keeps the SSH connection open while the terminal is; the file
    // manager (A09) opens its SFTP session on the same connection. None for
    // Telnet, serial and Mosh terminals (no files or tunnels there).
    pub connection: Option<Arc<Connection>>,
    pub sftp: Arc<tokio::sync::Mutex<Option<Arc<Sftp>>>>,
    /// Local port forwards on this connection (A10); dropped with the tab.
    pub forwards: Arc<Mutex<Vec<ActiveForward>>>,
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
    /// A20: the merged library waiting for the server to accept it.
    pub sync_pending: sync::Pending,
    /// A22: the merged team library waiting for the server.
    pub team_pending: team::TeamPending,
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
    pub key_id: Option<String>,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub startup_command: Option<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub agent_forwarding: bool,
    pub identity_id: Option<String>,
    /// Shared with the team (A22).
    pub team: bool,
    /// "ssh", "telnet", "serial" or "mosh".
    pub protocol: String,
    pub serial: Option<store::SerialSettings>,
}

/// What the host list shows under the name.
fn link_target(h: &SavedHost) -> String {
    match h.link.kind() {
        "telnet" if h.profile.port == 23 => format!("telnet://{}", h.profile.host),
        "telnet" => format!("telnet://{}:{}", h.profile.host, h.profile.port),
        "serial" => match &h.link.serial {
            Some(s) => format!(
                "{} · {} {}{}{}",
                s.device,
                s.baud,
                s.data_bits,
                s.parity.chars().next().unwrap_or('n').to_ascii_uppercase(),
                s.stop_bits
            ),
            None => "serial".into(),
        },
        "mosh" => format!("mosh {}", h.profile.display_target()),
        _ => h.profile.display_target(),
    }
}

pub fn host_views(state: &AppState) -> Result<Vec<HostView>, String> {
    let data = state.data.lock().map_err(|_| "busy")?;
    Ok(data
        .hosts
        .iter()
        .map(|own| (own, effective_host(&data, own)))
        .map(|(own, h)| HostView {
            identity_id: own.identity_id.clone(),
            team: own.team,
            id: h.id.clone(),
            label: h.profile.label.clone(),
            target: link_target(&h),
            protocol: h.link.kind().to_owned(),
            serial: h.link.serial.clone(),
            auth_kind: h.auth_kind.clone(),
            saved_secret: state
                .vault
                .get(&secret_key(&h.id, &h.auth_kind))
                .ok()
                .flatten()
                .is_some()
                || (h.auth_kind == "key" && h.key_id.is_some())
                || identity_password(state, &h).is_some(),
            key_path: h.key_path.clone(),
            jump_id: h.jump_id.clone(),
            trusted_key: data
                .known_hosts
                .get(&format!("{}:{}", h.profile.host, h.profile.port))
                .cloned(),
            group: h.group.clone(),
            key_id: h.key_id.clone(),
            user: h.profile.user.clone(),
            host: h.profile.host.clone(),
            port: h.profile.port,
            startup_command: h.startup_command.clone(),
            env: h.env.clone(),
            agent_forwarding: h.agent_forwarding,
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
            key_id: None,
            startup_command: None,
            env: Default::default(),
            agent_forwarding: false,
            identity_id: None,
            team: false,
            link: Default::default(),
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
                key_id: None,
                startup_command: None,
                env: Default::default(),
                agent_forwarding: false,
                identity_id: None,
                team: false,
                link: Default::default(),
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
    /// After a password login: put this computer's app key on the server
    /// (like `ssh-copy-id`) so the next logins need no password.
    #[serde(default)]
    pub install_key: bool,
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
/// Private keys in `~/.ssh` that open without a passphrase, the ones
/// OpenSSH tries by itself.
pub fn default_key_files() -> Vec<String> {
    let Some(dir) = home_dir().map(|h| h.join(".ssh")) else {
        return Vec::new();
    };
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| dir.join(name))
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            wc_ssh_core::keys::inspect(&text, None).ok()?;
            Some(p.to_string_lossy().into_owned())
        })
        .collect()
}

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
    let wants_key = auth.kind != "password"
        && auth.secret.is_empty()
        && auth.key_path.as_deref().unwrap_or("").is_empty();
    let first = connect_host_once(
        state,
        id.clone(),
        auth,
        Vec::new(),
        accept_fingerprint.clone(),
        mode.clone(),
        cols,
        rows,
    )
    .await;
    match first {
        // Nothing saved for this host: offer this computer's own SSH keys
        // (~/.ssh) like the ssh command does, all in ONE connection (one
        // connection per key looks like an attack to fail2ban, which then
        // bans this computer). The key that works is kept.
        Err(e) if wants_key && e.starts_with("no saved credential") => {
            let mut files = default_key_files();
            if files.is_empty() {
                return Err(e);
            }
            let first_file = files.remove(0);
            let attempt = AuthInput {
                kind: "key".into(),
                secret: String::new(),
                passphrase: None,
                remember: true,
                key_path: Some(first_file),
                install_key: false,
            };
            connect_host_once(
                state,
                id,
                attempt,
                files,
                accept_fingerprint,
                mode,
                cols,
                rows,
            )
            .await
        }
        other => other,
    }
}

/// The app key this computer puts on servers after a password login
/// (made the first time it is needed).
fn install_key_for(state: &Arc<AppState>) -> Result<(String, String), String> {
    let name = std::env::var(if cfg!(windows) {
        "COMPUTERNAME"
    } else {
        "HOSTNAME"
    })
    .unwrap_or_default();
    let label = format!("WECOMMANDER {}", name.trim()).trim().to_owned();
    if let Some(k) = state
        .data
        .lock()
        .map_err(|_| "busy")?
        .keys
        .iter()
        .find(|k| k.label == label)
    {
        return Ok((k.id.clone(), k.public_key.clone()));
    }
    let made = wc_ssh_core::keys::generate_ed25519("wecommander")?;
    let list = library::add_key_material(state, label.clone(), &made.private_openssh, made.info)?;
    let k = list
        .iter()
        .find(|k| k.label == label)
        .ok_or("key not saved")?;
    Ok((k.id.clone(), k.public_key.clone()))
}

#[allow(clippy::too_many_arguments)]
async fn connect_host_once(
    state: &Arc<AppState>,
    id: String,
    auth: AuthInput,
    extra_key_files: Vec<String>,
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
            .map(|h| effective_host(&data, h))
            .ok_or("host not found")?;
        let trusted = data
            .known_hosts
            .get(&format!("{}:{}", saved.profile.host, saved.profile.port))
            .cloned();
        (saved, trusted)
    };
    if saved.link.kind() != "ssh" {
        return connect_stream_host(state, &saved, &mode, cols, rows).await;
    }
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
    // A key from the app's key list, chosen for this host.
    let app_key = (kind == "key" && !typed && !from_file)
        .then(|| saved.key_id.clone())
        .flatten()
        .and_then(|k| {
            let private = state
                .vault
                .get(&store::key_secret(&k, "private"))
                .ok()
                .flatten()?;
            let passphrase = state
                .vault
                .get(&store::key_secret(&k, "passphrase"))
                .ok()
                .flatten();
            Some((private, passphrase))
        });
    let secret = if typed {
        auth.secret.clone()
    } else if let Some((private, _)) = &app_key {
        private.clone()
    } else if let Some(stored) = (!from_file)
        .then(|| {
            identity_password(state, &saved)
                .filter(|_| kind == "password")
                .or_else(|| state.vault.get(&secret_key(&id, kind)).ok().flatten())
        })
        .flatten()
    {
        stored
    } else if let (true, Some(path)) = (kind == "key", key_file.as_deref()) {
        std::fs::read_to_string(path).map_err(|e| format!("key file {path}: {e}"))?
    } else {
        return Err("no saved credential for this host; enter it once".into());
    };
    let passphrase = if let Some((_, p)) = app_key.as_ref().filter(|_| !typed) {
        p.clone()
    } else if typed || from_file {
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
        agent_forwarding: saved.agent_forwarding,
        extra_keys: extra_key_files
            .iter()
            .filter_map(|p| std::fs::read_to_string(p).ok())
            .collect(),
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
                // One of the other ~/.ssh keys may be the one that logged in.
                h.key_path = match conn.used_extra_key() {
                    Some(i) => extra_key_files
                        .iter()
                        .filter(|p| std::fs::read_to_string(p).is_ok())
                        .nth(i)
                        .cloned(),
                    None => auth.key_path.clone(),
                };
            }
        }
        state.save(&data)?;
    }
    if kind == "password" && auth.install_key {
        // Like ssh-copy-id: the next logins use this computer's key. A
        // failure here never blocks the terminal.
        if let Ok((key_id, public)) = install_key_for(state) {
            let line: String = public
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" ")
                + " wecommander";
            if line
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " +/=-_.@".contains(c))
            {
                let cmd = format!(
                    "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qF '{line}' ~/.ssh/authorized_keys || echo '{line}' >> ~/.ssh/authorized_keys) && echo WC_KEY_OK"
                );
                if let Ok(out) = conn.exec(&cmd, 4096).await {
                    if String::from_utf8_lossy(&out.stdout).contains("WC_KEY_OK") {
                        if let Ok(mut data) = state.data.lock() {
                            if let Some(h) = data.hosts.iter_mut().find(|h| h.id == id) {
                                h.key_id = Some(key_id);
                                h.auth_kind = "key".into();
                            }
                            let _ = state.save(&data);
                        }
                        state.changed();
                    }
                }
            }
        }
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

    let env: Vec<(String, String)> = saved.env.clone().into_iter().collect();
    let shell = conn
        .open_shell(
            "xterm-256color",
            cols.unwrap_or(80).clamp(10, 1000),
            rows.unwrap_or(24).clamp(4, 500),
            &env,
        )
        .await
        .map_err(|e| e.to_string())?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let writer = stream::TermWriter::Ssh(Arc::new(shell.writer));
    if let Some(command) = saved
        .startup_command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        // The shell reads it once its prompt is up, like a typed command.
        let _ = writer.write(format!("{command}\r").as_bytes()).await;
    }
    state.terminals.lock().map_err(|_| "busy")?.insert(
        session_id.clone(),
        Terminal {
            writer,
            connection: Some(Arc::new(conn)),
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

/// Telnet, serial and Mosh hosts: no host key and no SSH login; the
/// terminal talks to the connection through a stream task.
async fn connect_stream_host(
    state: &Arc<AppState>,
    saved: &SavedHost,
    mode: &str,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<ConnectOutcome, String> {
    let cols = cols.unwrap_or(80).clamp(10, 1000) as u16;
    let rows = rows.unwrap_or(24).clamp(4, 500) as u16;
    let start: Box<
        dyn FnOnce(tokio::sync::mpsc::UnboundedReceiver<stream::StreamCmd>, stream::StreamEvents)
            + Send,
    > = match saved.link.kind() {
        "telnet" => {
            let tcp = telnet::connect(&saved.profile.host, saved.profile.port).await?;
            Box::new(move |rx, events| {
                tokio::spawn(telnet::run(tcp, cols, rows, rx, events));
            })
        }
        "serial" => {
            let settings = saved
                .link
                .serial
                .clone()
                .ok_or("serial port settings are missing")?;
            let port = serial::open(&settings)?;
            Box::new(move |rx, events| {
                tokio::spawn(serial::run(port, rx, events));
            })
        }
        other => {
            return Err(format!(
                "{other} connections are not available in this version"
            ))
        }
    };
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        library::record_connection(&mut data, saved);
        state.save(&data)?;
    }
    if mode != "terminal" {
        // A test connect: reaching the host is the whole check.
        return Ok(ConnectOutcome::Connected {
            fingerprint: String::new(),
            output: String::new(),
        });
    }
    let (writer, rx) = stream::StreamWriter::new();
    let session_id = uuid::Uuid::new_v4().to_string();
    state.terminals.lock().map_err(|_| "busy")?.insert(
        session_id.clone(),
        Terminal {
            writer: stream::TermWriter::Stream(Arc::new(writer)),
            connection: None,
            sftp: Arc::new(tokio::sync::Mutex::new(None)),
            forwards: Arc::new(Mutex::new(Vec::new())),
            _jump: None,
        },
    );
    start(
        rx,
        stream::StreamEvents {
            state: state.clone(),
            session_id: session_id.clone(),
        },
    );
    Ok(ConnectOutcome::TerminalOpened {
        fingerprint: String::new(),
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
            .map(|h| effective_host(&data, h))
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
            .map(|h| effective_host(&data, h))
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

/// The host as it connects: with its identity's user, auth kind and key
/// when it uses one.
pub(crate) fn effective_host(data: &Data, host: &SavedHost) -> SavedHost {
    let mut h = host.clone();
    if let Some(identity) = host
        .identity_id
        .as_ref()
        .and_then(|i| data.identities.iter().find(|x| &x.id == i))
    {
        h.profile.user = identity.user.clone();
        h.auth_kind = identity.auth_kind.clone();
        h.key_id = if identity.auth_kind == "key" {
            identity.key_id.clone()
        } else {
            None
        };
        h.key_path = None;
    }
    h
}

/// The identity's password, when the host uses a password identity.
fn identity_password(state: &AppState, host: &SavedHost) -> Option<String> {
    let id = host.identity_id.as_deref()?;
    (host.auth_kind == "password")
        .then(|| state.vault.get(&store::identity_secret(id)).ok().flatten())
        .flatten()
}

/// The private key (and passphrase) of the app key the host uses.
fn app_key_secret(state: &AppState, host: &SavedHost) -> Option<(String, Option<String>)> {
    let k = host.key_id.as_deref().filter(|_| host.auth_kind == "key")?;
    let private = state
        .vault
        .get(&store::key_secret(k, "private"))
        .ok()
        .flatten()?;
    let passphrase = state
        .vault
        .get(&store::key_secret(k, "passphrase"))
        .ok()
        .flatten();
    Some((private, passphrase))
}

fn saved_credential(state: &AppState, host: &SavedHost) -> Option<Credential> {
    if let Some((key, passphrase)) = app_key_secret(state, host) {
        return Some(Credential::PrivateKey { key, passphrase });
    }
    if let Some(password) = identity_password(state, host) {
        return Some(Credential::Password(password));
    }
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

/// Keeps a forward running; dropping it stops the forward.
pub enum ForwardGuard {
    /// Local (`ssh -L`) or dynamic (`ssh -D`): a listener on this computer.
    Listener(LocalForward),
    /// Remote (`ssh -R`): the server listens.
    Remote(RemoteForward),
}

/// A forward on a terminal's connection.
pub struct ActiveForward {
    pub view: ForwardView,
    pub _guard: ForwardGuard,
}

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardView {
    /// Stops this forward (`forward.stop`).
    pub id: String,
    /// `local`, `remote` or `dynamic`.
    pub kind: String,
    /// Where it listens: on this computer (local, dynamic) or on the
    /// server (remote).
    pub local: String,
    /// Where connections go: `host:port` from the server (local), from this
    /// computer (remote), or `SOCKS5` (dynamic).
    pub remote: String,
}

fn forward_views(list: &[ActiveForward]) -> Vec<ForwardView> {
    list.iter().map(|f| f.view.clone()).collect()
}

/// What a tunnel does, as given by the person.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub local_port: u16,
    #[serde(default)]
    pub local_host: Option<String>,
    #[serde(default)]
    pub remote_host: String,
    #[serde(default)]
    pub remote_port: u16,
}

fn default_kind() -> String {
    "local".into()
}

impl TunnelSpec {
    /// Checks the fields the kind needs and fills defaults.
    pub fn validated(mut self, fixed_port: bool) -> Result<Self, String> {
        self.remote_host = self.remote_host.trim().to_owned();
        let bad_host =
            |h: &str| h.len() > 253 || h.chars().any(|c| c.is_whitespace() || c.is_control());
        match self.kind.as_str() {
            "local" => {
                if self.remote_host.is_empty()
                    || bad_host(&self.remote_host)
                    || self.remote_port == 0
                {
                    return Err("remote host and port are required".into());
                }
                if fixed_port && self.local_port == 0 {
                    return Err("a saved tunnel needs a fixed local port".into());
                }
                self.local_host = None;
            }
            "dynamic" => {
                if fixed_port && self.local_port == 0 {
                    return Err("a saved tunnel needs a fixed local port".into());
                }
                self.remote_host = String::new();
                self.remote_port = 0;
                self.local_host = None;
            }
            "remote" => {
                if self.local_port == 0 {
                    return Err("the port on this computer is required".into());
                }
                if fixed_port && self.remote_port == 0 {
                    return Err("a saved tunnel needs a fixed server port".into());
                }
                if self.remote_host.is_empty() {
                    // Like ssh -R: only the server itself can connect.
                    self.remote_host = "localhost".into();
                }
                let lh = self
                    .local_host
                    .take()
                    .map(|h| h.trim().to_owned())
                    .filter(|h| !h.is_empty())
                    .unwrap_or_else(|| "127.0.0.1".into());
                if bad_host(&self.remote_host) || bad_host(&lh) {
                    return Err("invalid host name".into());
                }
                self.local_host = Some(lh);
            }
            _ => return Err("tunnel kind must be local, remote or dynamic".into()),
        }
        Ok(self)
    }

    /// Starts it on `conn`.
    pub async fn start(&self, conn: &Arc<Connection>) -> Result<ActiveForward, String> {
        // Listeners are only on this computer: never on other interfaces.
        let bind = format!("127.0.0.1:{}", self.local_port);
        match self.kind.as_str() {
            "dynamic" => {
                let f = conn
                    .forward_dynamic(&bind)
                    .await
                    .map_err(|e| e.to_string())?;
                let local = f.local.to_string();
                Ok(ActiveForward {
                    view: ForwardView {
                        id: local.clone(),
                        kind: "dynamic".into(),
                        local,
                        remote: "SOCKS5".into(),
                    },
                    _guard: ForwardGuard::Listener(f),
                })
            }
            "remote" => {
                let lh = self
                    .local_host
                    .clone()
                    .unwrap_or_else(|| "127.0.0.1".into());
                let f = conn
                    .forward_remote(&self.remote_host, self.remote_port, &lh, self.local_port)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(ActiveForward {
                    view: ForwardView {
                        id: format!("remote:{}:{}", self.remote_host, f.port),
                        kind: "remote".into(),
                        local: format!("{}:{} (sunucu)", self.remote_host, f.port),
                        remote: format!("{lh}:{}", self.local_port),
                    },
                    _guard: ForwardGuard::Remote(f),
                })
            }
            _ => {
                let f = conn
                    .forward_local(&bind, &self.remote_host, self.remote_port)
                    .await
                    .map_err(|e| e.to_string())?;
                let local = f.local.to_string();
                Ok(ActiveForward {
                    view: ForwardView {
                        id: local.clone(),
                        kind: "local".into(),
                        local,
                        remote: format!("{}:{}", self.remote_host, self.remote_port),
                    },
                    _guard: ForwardGuard::Listener(f),
                })
            }
        }
    }
}

/// Starts a forward on terminal `session_id`'s connection: `local`
/// (127.0.0.1:`local_port`, 0 = any free port -> `remote_host:remote_port`
/// from the server), `dynamic` (a SOCKS5 proxy on 127.0.0.1:`local_port`)
/// or `remote` (the server listens on `remote_host:remote_port` and
/// connections go to `local_host:local_port` on this computer).
pub async fn forward_start(
    state: &Arc<AppState>,
    session_id: String,
    spec: TunnelSpec,
) -> Result<Vec<ForwardView>, String> {
    let spec = spec.validated(false)?;
    let (connection, forwards) = {
        let terminals = state.terminals.lock().map_err(|_| "busy")?;
        let t = terminals.get(&session_id).ok_or("terminal closed")?;
        (t.connection.clone(), t.forwards.clone())
    };
    let connection = connection.ok_or(NOT_SSH)?;
    let forward = spec.start(&connection).await?;
    let mut list = forwards.lock().map_err(|_| "busy")?;
    list.push(forward);
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
    list.retain(|f| f.view.id != local);
    Ok(forward_views(&list))
}

/// Files and tunnels need an SSH connection.
const NOT_SSH: &str = "files and tunnels work only on SSH terminals";

fn terminal_writer(state: &AppState, session_id: &str) -> Result<stream::TermWriter, String> {
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
    writer.write(data.as_bytes()).await
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
    let connection = connection.ok_or(NOT_SSH)?;
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
    pub _forward: ForwardGuard,
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
    pub kind: String,
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
            h.tunnels.iter().enumerate().map(|(i, t)| {
                let (local, remote) = match t.kind.as_str() {
                    "dynamic" => (format!("127.0.0.1:{}", t.local_port), "SOCKS5".to_owned()),
                    "remote" => (
                        format!("{}:{} (sunucu)", t.remote_host, t.remote_port),
                        format!(
                            "{}:{}",
                            t.local_host.as_deref().unwrap_or("127.0.0.1"),
                            t.local_port
                        ),
                    ),
                    _ => (
                        format!("127.0.0.1:{}", t.local_port),
                        format!("{}:{}", t.remote_host, t.remote_port),
                    ),
                };
                SavedTunnelView {
                    host_id: h.id.clone(),
                    host_label: h.profile.label.clone(),
                    index: i,
                    kind: t.kind.clone(),
                    local,
                    remote,
                    running: running.contains(&key(&h.id, i)),
                }
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
    spec: TunnelSpec,
) -> Result<Vec<SavedTunnelView>, String> {
    let spec = spec.validated(true)?;
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        // Two saved listeners on this computer cannot share a port.
        let taken = spec.kind != "remote"
            && data
                .hosts
                .iter()
                .flat_map(|h| h.tunnels.iter())
                .any(|t| t.kind != "remote" && t.local_port == spec.local_port);
        if taken {
            return Err(format!(
                "local port {} is already used by a saved tunnel",
                spec.local_port
            ));
        }
        let host = data
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or("host not found")?;
        host.tunnels.push(crate::store::SavedTunnel {
            kind: spec.kind,
            local_port: spec.local_port,
            local_host: spec.local_host,
            remote_host: spec.remote_host,
            remote_port: spec.remote_port,
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
        let spec = TunnelSpec {
            kind: tunnel.kind.clone(),
            local_port: tunnel.local_port,
            local_host: tunnel.local_host.clone(),
            remote_host: tunnel.remote_host.clone(),
            remote_port: tunnel.remote_port,
        }
        .validated(true)?;
        let (conn, jump) = connect_saved(state, host_id).await?;
        let conn = Arc::new(conn);
        let forward = spec.start(&conn).await?._guard;
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
