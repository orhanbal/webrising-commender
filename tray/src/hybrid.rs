//! Hybrid Access on Linux ("SSH ile, kurulum yok", docs/HYBRID_ACCESS.md §5
//! and §8): remote AI clients (ChatGPT, Claude.ai) use the SSH servers the
//! person shared, through this computer. The SSH keys and passwords stay
//! here; the connection to the server is made from this computer.
//!
//! This app holds the WECOMMANDER app core (`wc-app-core`) in process: the
//! same host store, keyring vault, host-key list and SSH engine the Windows
//! and macOS apps use through `wecommander-core`. Its data lives in
//! `<config dir>/core`. While the app is signed in, the core's connector loop
//! (`wc_app_core::mcp::connector`) publishes the shared hosts, claims the
//! calls queued for this Management Center and answers them; it never
//! approves anything (approvals are the gateway's, decided by the person in
//! this app's Approvals list, its notifications or on the web).
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
use wc_app_core as core;

use crate::api::{Api, ApiError};
use crate::AppState;
use core::mcp::connector::{
    Connector, ConnectorCall, ConnectorStatus, ConnectorTransport, TransportError,
};
use core::store::AiAccess;

/// The OS keyring service the core keeps passwords and keys under (the
/// default of `wecommander-core`).
const KEYRING_SERVICE: &str = "app.wecommander";

struct NoEvents;

impl core::EventSink for NoEvents {
    fn emit(&self, _name: &str, _payload: Value) {}
}

/// The gateway's connector routes with this app's Center token.
struct GatewayTransport {
    api: Api,
    token: String,
}

fn transport_error(error: ApiError) -> TransportError {
    match error {
        ApiError::Unauthorized => TransportError::Unauthorized,
        ApiError::Network(detail) => TransportError::Network(detail),
        ApiError::Http { status, code } => TransportError::Rejected { status, code },
    }
}

impl ConnectorTransport for GatewayTransport {
    async fn publish(&self, targets: Value) -> Result<(), TransportError> {
        self.api
            .connector_publish(&self.token, targets)
            .await
            .map_err(transport_error)
    }

    async fn claim(&self, wait_ms: u64) -> Result<Vec<ConnectorCall>, TransportError> {
        let body = self
            .api
            .connector_claim(&self.token, wait_ms)
            .await
            .map_err(transport_error)?;
        Ok(ConnectorCall::from_claim(&body))
    }

    async fn post_result(&self, call_id: &str, result: Value) -> Result<(), TransportError> {
        self.api
            .connector_result(&self.token, call_id, result)
            .await
            .map_err(transport_error)
    }
}

struct Running {
    token: String,
    server: String,
    connector: Arc<Connector>,
    /// Dropped (or set) to stop the loop.
    _stop: watch::Sender<bool>,
}

pub struct Hybrid {
    dir: PathBuf,
    core: OnceLock<Arc<core::AppState>>,
    running: Mutex<Option<Running>>,
}

impl Hybrid {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            dir: config_dir.join("core"),
            core: OnceLock::new(),
            running: Mutex::new(None),
        }
    }

    /// The core, opened on first use (it asks the OS keyring once).
    fn core(&self) -> Arc<core::AppState> {
        self.core
            .get_or_init(|| {
                let _ = std::fs::create_dir_all(&self.dir);
                core::open(&self.dir, KEYRING_SERVICE, Arc::new(NoEvents))
            })
            .clone()
    }

    fn status(&self) -> ConnectorStatus {
        self.running
            .lock()
            .ok()
            .and_then(|r| r.as_ref().map(|r| r.connector.status()))
            .unwrap_or_default()
    }

    fn nudge(&self) {
        if let Ok(running) = self.running.lock() {
            if let Some(r) = running.as_ref() {
                r.connector.nudge();
            }
        }
    }

    /// Starts the loop while signed in, stops it on sign-out (or when the
    /// account changes). Without a host store yet there is nothing to share:
    /// the core is not opened just for the loop.
    fn ensure(&self, app: &AppHandle, session: Option<(String, String)>) {
        let Ok(mut running) = self.running.lock() else {
            return;
        };
        let Some((server, token)) = session else {
            *running = None;
            return;
        };
        if running
            .as_ref()
            .is_some_and(|r| r.token == token && r.server == server)
        {
            return;
        }
        *running = None;
        if self.core.get().is_none() && !self.dir.join("hosts.json").exists() {
            return;
        }
        let connector = Connector::new();
        let (stop, rx) = watch::channel(false);
        let transport = Arc::new(GatewayTransport {
            api: Api::new(&server),
            token: token.clone(),
        });
        let handle = app.clone();
        let center_id = move || center_id(&handle);
        tauri::async_runtime::spawn(connector.clone().run(
            transport,
            Arc::new(self.core()),
            center_id,
            rx,
        ));
        *running = Some(Running {
            token,
            server,
            connector,
            _stop: stop,
        });
    }
}

fn center_id(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let inner = state.inner.lock().ok()?;
    inner
        .me
        .as_ref()
        .map(|m| m.center_id.clone())
        .filter(|c| !c.is_empty())
}

/// From the app's background loop: keep the connector in step with the sign-in.
pub fn tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    let session = {
        let inner = state.inner.lock().unwrap();
        inner
            .token
            .clone()
            .map(|token| (inner.settings.server.clone(), token))
    };
    state.hybrid.ensure(app, session);
}

/// One saved host as the AI access list shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRow {
    id: String,
    label: String,
    target: String,
    protocol: String,
    auth_kind: String,
    trusted: bool,
    /// Why AI access cannot be switched on yet: "not_ssh",
    /// "host_key_untrusted" or "needs_credential" (the core decides).
    blocker: Option<String>,
    remote: bool,
    /// Remote access is served by this computer (not another one).
    served_here: bool,
    /// "readonly" or "approval": remote changes always need an approval.
    preset: String,
    sudo: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    status: ConnectorStatus,
    signed_in: bool,
    center_id: Option<String>,
    /// False when no OS keyring answered: passwords last until the app quits.
    keyring: bool,
    hosts: Vec<HostRow>,
}

fn code(error: &str) -> String {
    error.split(':').next().unwrap_or(error).trim().to_owned()
}

fn view(app: &AppHandle) -> Result<View, String> {
    let state = app.state::<AppState>();
    let hybrid = &state.hybrid;
    let core = hybrid.core();
    let center = center_id(app);
    let signed_in = state.inner.lock().unwrap().token.is_some();
    let keyring = core::app_info(&core, "").vault_persistent;
    let data = core.data.lock().map_err(|_| "busy")?;
    let hosts = data
        .hosts
        .iter()
        .map(|host| {
            let ai = host.ai_access.clone().unwrap_or_default();
            HostRow {
                id: host.id.clone(),
                label: host.profile.label.clone(),
                target: host.profile.display_target(),
                protocol: host.link.kind().to_owned(),
                auth_kind: host.auth_kind.clone(),
                trusted: data
                    .known_hosts
                    .contains_key(&format!("{}:{}", host.profile.host, host.profile.port)),
                blocker: core::targets::precondition_error(&core, &data, host).map(|e| code(&e)),
                remote: ai.remote,
                served_here: !ai.remote
                    || center
                        .as_deref()
                        .is_some_and(|c| core::targets::served_by(&ai, c)),
                preset: if ai.preset == "readonly" {
                    "readonly"
                } else {
                    "approval"
                }
                .to_owned(),
                sudo: ai.sudo.clone(),
            }
        })
        .collect();
    drop(data);
    Ok(View {
        status: hybrid.status(),
        signed_in,
        center_id: center,
        keyring,
        hosts,
    })
}

/// After a change: the loop starts if this was the first host and publishes now.
fn changed(app: &AppHandle) {
    tick(app);
    app.state::<AppState>().hybrid.nudge();
}

// ---- commands called by the window ----

#[tauri::command]
pub fn hybrid_view(app: AppHandle) -> Result<View, String> {
    view(&app)
}

/// Adds the concrete hosts of `~/.ssh/config` (already saved ones are skipped).
#[tauri::command]
pub fn hybrid_import(app: AppHandle) -> Result<Value, String> {
    let core = app.state::<AppState>().hybrid.core();
    let result = core::import_ssh_config(&core)?;
    changed(&app);
    Ok(json!({ "added": result.added, "skipped": result.skipped, "view": view(&app)? }))
}

#[tauri::command]
pub fn hybrid_add(
    app: AppHandle,
    label: String,
    host: String,
    port: Option<u16>,
    user: String,
    auth_kind: String,
) -> Result<View, String> {
    let core = app.state::<AppState>().hybrid.core();
    let label = if label.trim().is_empty() {
        host.trim().to_owned()
    } else {
        label.trim().to_owned()
    };
    core::add_host(
        &core,
        label,
        host.trim().to_owned(),
        port.unwrap_or(22),
        user.trim().to_owned(),
        auth_kind,
        None,
    )?;
    changed(&app);
    view(&app)
}

/// Connects once (runs `whoami`) to check the login and, the first time,
/// show the server's host key; `accept_fingerprint` is the key the person
/// just confirmed. A password typed here is saved in the OS keyring after a
/// successful login so AI calls can log in without asking.
#[tauri::command]
pub async fn hybrid_verify(
    app: AppHandle,
    id: String,
    password: Option<String>,
    accept_fingerprint: Option<String>,
) -> Result<Value, String> {
    let core = app.state::<AppState>().hybrid.core();
    let kind = {
        let data = core.data.lock().map_err(|_| "busy")?;
        data.hosts
            .iter()
            .find(|h| h.id == id)
            .map(|h| h.auth_kind.clone())
            .ok_or("host_not_found")?
    };
    let auth = core::AuthInput {
        kind,
        secret: password.unwrap_or_default(),
        passphrase: None,
        remember: true,
        key_path: None,
        install_key: false,
    };
    let outcome = core::connect_host(
        &core,
        id,
        auth,
        accept_fingerprint.filter(|f| !f.is_empty()),
        "test".into(),
        None,
        None,
    )
    .await?;
    let outcome = serde_json::to_value(outcome).map_err(|e| e.to_string())?;
    Ok(json!({ "outcome": outcome, "view": view(&app)? }))
}

/// Shares a host with remote AI through this computer (or stops sharing),
/// with its preset and sudo setting. The core refuses it unless the host is
/// SSH, its host key is trusted and it can log in without asking.
#[tauri::command]
pub fn hybrid_set(
    app: AppHandle,
    id: String,
    remote: bool,
    preset: String,
    sudo: String,
) -> Result<View, String> {
    let core = app.state::<AppState>().hybrid.core();
    let center = center_id(&app);
    if remote && center.is_none() {
        return Err("not_signed_in".into());
    }
    let stored = {
        let data = core.data.lock().map_err(|_| "busy")?;
        data.hosts
            .iter()
            .find(|h| h.id == id)
            .ok_or("host_not_found")?
            .ai_access
            .clone()
            .unwrap_or_default()
    };
    // A timed period set on another computer stays for its local AI
    // clients; through wecommander.app it counts as "approval" anyway.
    let keep_timed = preset != "readonly"
        && core::targets::effective_preset(&stored, core::time::now_unix()) == "timed";
    let access = AiAccess {
        local: stored.local,
        remote,
        // Kept when it was already on (another computer may serve it),
        // else this Management Center.
        connector: if !remote {
            "this-computer".into()
        } else if stored.remote && !stored.connector.trim().is_empty() {
            stored.connector.clone()
        } else {
            center.unwrap_or_default()
        },
        preset: if keep_timed {
            "timed".into()
        } else if preset == "readonly" {
            "readonly".into()
        } else {
            "approval".into()
        },
        timed_until: if keep_timed {
            stored.timed_until.clone()
        } else {
            None
        },
        sudo,
    };
    core::targets::set_ai_access(&core, id, access)?;
    changed(&app);
    view(&app)
}

#[tauri::command]
pub fn hybrid_delete(app: AppHandle, id: String) -> Result<View, String> {
    let core = app.state::<AppState>().hybrid.core();
    core::delete_host(&core, id)?;
    changed(&app);
    view(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_gateway_errors_and_core_codes() {
        assert_eq!(
            transport_error(ApiError::Unauthorized),
            TransportError::Unauthorized
        );
        assert_eq!(
            transport_error(ApiError::Http {
                status: 429,
                code: "rate_limited".into()
            }),
            TransportError::Rejected {
                status: 429,
                code: "rate_limited".into()
            }
        );
        assert!(matches!(
            transport_error(ApiError::Network("x".into())),
            TransportError::Network(_)
        ));
        assert_eq!(
            code("host_key_untrusted: connect to Web once"),
            "host_key_untrusted"
        );
        assert_eq!(code("not_signed_in"), "not_signed_in");
    }
}
