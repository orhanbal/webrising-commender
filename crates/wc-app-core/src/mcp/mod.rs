//! Local MCP (Hybrid Access phase H2, docs/HYBRID_ACCESS.md): AI clients on
//! this computer use the SSH hosts the person exposed (`aiAccess.local`)
//! through the running app.
//!
//! * [`endpoint`]: the per-user local endpoint (Windows named pipe with an
//!   ACL for the current user, Unix socket 0600 in a 0700 folder) the running
//!   core listens on; one core owns it.
//! * [`bridge`]: `wecommander-core --mcp-stdio`, what AI clients start: it
//!   only moves lines between stdio and the endpoint (no hosts, no secrets).
//! * [`session`]: MCP JSON-RPC on one endpoint connection.
//! * [`tools`]: the SSH-target tools, their policy (presets, sudo guard,
//!   approvals) and the audit.
//! * [`clientconfig`]: adds WECOMMANDER to Claude Desktop, Claude Code,
//!   Cursor and Codex.
//!
//! This module holds the shared state: the client allow-list, pending
//! approvals and the endpoint status.
pub mod bridge;
pub mod clientconfig;
pub mod endpoint;
pub mod redact;
pub mod session;
pub mod tools;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use crate::time::{format_rfc3339, now_unix};
use crate::AppState;

/// How long an unknown client's requests wait for the person (2 min).
pub const CLIENT_WAIT: Duration = Duration::from_secs(120);
/// How long an approval stays valid (5 min).
pub const APPROVAL_SECS: i64 = 300;

const CLIENTS_FILE: &str = "mcp-clients.json";
pub const AUDIT_FILE: &str = "mcp-audit.jsonl";

/// One AI client as it introduced itself (`clientInfo` of `initialize`),
/// identified by its name; `version` is the last one it reported.
/// Self-declared: the allow-list is consent, not authentication.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub allowed: bool,
    /// The person answered (allowed or denied). Undecided clients are asked
    /// again on their next connection.
    #[serde(default)]
    pub decided: bool,
    pub first_seen: String,
    pub last_seen: String,
}

/// Stable id of a client: its name (the version is kept as information; a
/// new version of an allowed client is not asked about again).
pub fn client_id(name: &str) -> String {
    let digest = Sha256::digest(name.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("client-{hex}")
}

/// What `mcp.status` reports about the endpoint.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInfo {
    pub listening: bool,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct Hub {
    dir: PathBuf,
    clients: Mutex<Vec<ClientRecord>>,
    clients_changed: Notify,
    pub approvals: Approvals,
    endpoint: Mutex<EndpointInfo>,
    bridge_command: Mutex<Vec<String>>,
    audit_lock: Mutex<()>,
}

impl Hub {
    pub fn new(dir: &Path) -> Self {
        let clients = std::fs::read(dir.join(CLIENTS_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<ClientRecord>>(&b).ok())
            .unwrap_or_default();
        Self {
            dir: dir.to_owned(),
            clients: Mutex::new(clients),
            clients_changed: Notify::new(),
            approvals: Approvals::default(),
            endpoint: Mutex::new(EndpointInfo::default()),
            bridge_command: Mutex::new(Vec::new()),
            audit_lock: Mutex::new(()),
        }
    }

    fn save_clients(&self, list: &[ClientRecord]) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
        write_private(&self.dir.join(CLIENTS_FILE), &bytes)
            .map_err(|e| format!("could not save AI clients: {e}"))
    }

    /// A client said hello: known clients get `lastSeen`, unknown ones are
    /// recorded as not allowed (the caller asks the person).
    pub fn hello(&self, name: &str, version: &str) -> Result<ClientRecord, String> {
        let id = client_id(name);
        let now = format_rfc3339(now_unix());
        let mut list = self.clients.lock().map_err(|_| "busy")?;
        let record = match list.iter_mut().find(|c| c.id == id) {
            Some(c) => {
                c.last_seen = now;
                c.version = version.to_owned();
                c.clone()
            }
            None => {
                let c = ClientRecord {
                    id,
                    name: name.to_owned(),
                    version: version.to_owned(),
                    allowed: false,
                    decided: false,
                    first_seen: now.clone(),
                    last_seen: now,
                };
                list.push(c.clone());
                c
            }
        };
        self.save_clients(&list)?;
        Ok(record)
    }

    pub fn clients(&self) -> Vec<ClientRecord> {
        self.clients.lock().map(|l| l.clone()).unwrap_or_default()
    }

    pub fn client(&self, id: &str) -> Option<ClientRecord> {
        self.clients().into_iter().find(|c| c.id == id)
    }

    /// `mcp.allowClient`: the person's answer, remembered.
    pub fn allow(&self, id: &str, allow: bool) -> Result<Vec<ClientRecord>, String> {
        let list = {
            let mut list = self.clients.lock().map_err(|_| "busy")?;
            let c = list
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or("unknown_client: unknown AI client")?;
            c.allowed = allow;
            c.decided = true;
            self.save_clients(&list)?;
            list.clone()
        };
        self.clients_changed.notify_waiters();
        Ok(list)
    }

    /// `mcp.forgetClient`: the client is asked about again next time.
    pub fn forget(&self, id: &str) -> Result<Vec<ClientRecord>, String> {
        let list = {
            let mut list = self.clients.lock().map_err(|_| "busy")?;
            list.retain(|c| c.id != id);
            self.save_clients(&list)?;
            list.clone()
        };
        self.clients_changed.notify_waiters();
        Ok(list)
    }

    /// Waits (at most `limit`) until the person allowed client `id`.
    /// Errors: `client_denied`, `client_not_allowed` (no answer in time, or
    /// forgotten meanwhile).
    pub async fn wait_allowed(&self, id: &str, limit: Duration) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let changed = self.clients_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.client(id) {
                Some(c) if c.decided && c.allowed => return Ok(()),
                Some(c) if c.decided => return Err(
                    "client_denied: this AI client was not allowed in WECOMMANDER (Settings → AI)"
                        .into(),
                ),
                Some(_) => {}
                None => return Err(not_allowed()),
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return Err(not_allowed());
            }
        }
    }

    pub fn set_endpoint(&self, info: EndpointInfo) {
        if let Ok(mut e) = self.endpoint.lock() {
            *e = info;
        }
    }

    pub fn endpoint(&self) -> EndpointInfo {
        self.endpoint.lock().map(|e| e.clone()).unwrap_or_default()
    }

    /// What AI clients start: `[exe, "--mcp-stdio", ...]` (set by the core).
    pub fn set_bridge_command(&self, command: Vec<String>) {
        if let Ok(mut c) = self.bridge_command.lock() {
            *c = command;
        }
    }

    pub fn bridge_command(&self) -> Vec<String> {
        self.bridge_command
            .lock()
            .map(|c| c.clone())
            .unwrap_or_default()
    }

    /// Appends one line to `<data dir>/mcp-audit.jsonl`: what was called on
    /// which target and how it ended. Never file contents, command text or
    /// command output.
    pub fn audit(&self, entry: &AuditEntry) {
        let Ok(_guard) = self.audit_lock.lock() else {
            return;
        };
        let path = self.dir.join(AUDIT_FILE);
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let _ = std::fs::create_dir_all(&self.dir);
        if let Ok(mut file) = options.open(path) {
            if let Ok(line) = serde_json::to_string(entry) {
                let _ = writeln!(file, "{line}");
            }
        }
    }
}

fn not_allowed() -> String {
    "client_not_allowed: allow this AI client in WECOMMANDER first (it was asked in the app)".into()
}

/// One line of the local MCP audit file.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub time: String,
    pub origin: String,
    pub client: String,
    pub client_version: String,
    pub tool: String,
    pub target: String,
    pub target_label: String,
    pub risk: String,
    pub outcome: String,
}

/// Writes `bytes` to `path` atomically, readable only by this user.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

// ---- approvals ------------------------------------------------------------

/// The exact call an approval is for: client, target, command, folder and
/// timeout. Any change (one byte of the command) gives another binding.
pub fn binding(
    client_id: &str,
    target_id: &str,
    command: &str,
    cwd: Option<&str>,
    timeout_ms: u64,
) -> String {
    let canonical = serde_json::json!([
        "process_exec",
        client_id,
        target_id,
        command,
        cwd,
        timeout_ms
    ])
    .to_string();
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

#[derive(Debug)]
struct Approval {
    binding: String,
    expires_at: i64,
    decision: Option<bool>,
    consumed: bool,
}

/// Pending and decided approvals, single use, bound to one call.
#[derive(Default)]
pub struct Approvals {
    items: Mutex<HashMap<String, Approval>>,
    changed: Notify,
}

impl Approvals {
    /// A usable approval for `binding` (pending, or approved and not used
    /// yet), else a new pending one. Returns `(id, expires_at, new)`. A
    /// retried call after a client timeout so reuses the person's answer.
    pub fn request(&self, binding: &str, now: i64) -> (String, i64, bool) {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        items.retain(|_, a| a.expires_at > now - 600 && !(a.consumed && a.expires_at <= now));
        if let Some((id, a)) = items.iter().find(|(_, a)| {
            a.binding == binding && !a.consumed && a.expires_at > now && a.decision != Some(false)
        }) {
            return (id.clone(), a.expires_at, false);
        }
        let id = format!("appr-{}", uuid::Uuid::new_v4());
        let expires_at = now + APPROVAL_SECS;
        items.insert(
            id.clone(),
            Approval {
                binding: binding.to_owned(),
                expires_at,
                decision: None,
                consumed: false,
            },
        );
        (id, expires_at, true)
    }

    /// `mcp.decide`.
    pub fn decide(&self, id: &str, approve: bool, now: i64) -> Result<(), String> {
        {
            let mut items = self.items.lock().map_err(|_| "busy")?;
            let a = items
                .get_mut(id)
                .ok_or("unknown_approval: no such approval")?;
            if a.consumed {
                return Err("approval_used: this approval was already used".into());
            }
            if a.expires_at <= now {
                return Err("approval_expired: this approval expired".into());
            }
            if a.decision.is_some() {
                return Err("approval_decided: this approval was already answered".into());
            }
            a.decision = Some(approve);
        }
        self.changed.notify_waiters();
        Ok(())
    }

    /// Uses approval `id` for the call with `binding`: only once, only for
    /// exactly that call, only before it expires, only if approved.
    pub fn consume(&self, id: &str, binding: &str, now: i64) -> Result<(), String> {
        let mut items = self.items.lock().map_err(|_| "busy")?;
        let a = items
            .get_mut(id)
            .ok_or("unknown_approval: no such approval")?;
        if a.binding != binding {
            return Err("approval_mismatch: the approval is for another call".into());
        }
        if a.consumed {
            return Err("approval_used: this approval was already used".into());
        }
        if a.expires_at <= now {
            return Err("approval_expired: the approval expired; ask again".into());
        }
        match a.decision {
            Some(true) => {
                a.consumed = true;
                Ok(())
            }
            Some(false) => Err("approval_denied: the person denied this command".into()),
            None => Err("approval_pending: not answered yet".into()),
        }
    }

    /// Waits until approval `id` is answered or expires, then uses it.
    pub async fn wait(&self, id: &str, binding: &str) -> Result<(), String> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let now = now_unix();
            match self.consume(id, binding, now) {
                Err(e) if e.starts_with("approval_pending") => {}
                other => return other,
            }
            let expires_at = self
                .items
                .lock()
                .ok()
                .and_then(|i| i.get(id).map(|a| a.expires_at))
                .unwrap_or(now);
            let left = Duration::from_secs((expires_at - now).max(0) as u64 + 1);
            let _ = tokio::time::timeout(left, changed).await;
        }
    }
}

// ---- RPC helpers ----------------------------------------------------------

/// `mcp.status`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    /// Remote MCP through a connector (phase H3) is not built yet.
    pub remote_supported: bool,
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub bridge_command: Vec<String>,
    pub clients: Vec<ClientRecord>,
    /// Hosts AI clients on this computer can use.
    pub targets: usize,
}

pub fn status(state: &Arc<AppState>) -> Status {
    let info = state.mcp.endpoint();
    let targets = state
        .data
        .lock()
        .map(|d| crate::targets::local_targets(&d).len())
        .unwrap_or(0);
    Status {
        enabled: info.listening,
        remote_supported: false,
        endpoint: info.path,
        error: info.error,
        bridge_command: state.mcp.bridge_command(),
        clients: state.mcp.clients(),
        targets,
    }
}

/// `mcp.decide`: the person's answer to an `mcp-approval` event.
pub fn decide(state: &Arc<AppState>, approval_id: &str, approve: bool) -> Result<(), String> {
    state.mcp.approvals.decide(approval_id, approve, now_unix())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub(tag: &str) -> (Hub, PathBuf) {
        let dir = std::env::temp_dir().join(format!("wc-mcp-hub-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Hub::new(&dir), dir)
    }

    #[test]
    fn approval_is_bound_single_use_and_expires() {
        let a = Approvals::default();
        let now = 1_800_000_000;
        let b = binding(
            "client-1",
            "host-1",
            "systemctl restart web",
            Some("/srv"),
            30_000,
        );
        let (id, expires, new) = a.request(&b, now);
        assert!(new);
        assert_eq!(expires, now + APPROVAL_SECS);
        // The same call while pending reuses the request (one prompt).
        assert_eq!(a.request(&b, now + 1).0, id);
        assert!(a
            .consume(&id, &b, now)
            .unwrap_err()
            .starts_with("approval_pending"));
        a.decide(&id, true, now + 2).unwrap();
        // One byte changed: another call, not covered.
        let other = binding(
            "client-1",
            "host-1",
            "systemctl restart wed",
            Some("/srv"),
            30_000,
        );
        assert!(a
            .consume(&id, &other, now + 3)
            .unwrap_err()
            .starts_with("approval_mismatch"));
        for changed in [
            binding(
                "client-2",
                "host-1",
                "systemctl restart web",
                Some("/srv"),
                30_000,
            ),
            binding(
                "client-1",
                "host-2",
                "systemctl restart web",
                Some("/srv"),
                30_000,
            ),
            binding(
                "client-1",
                "host-1",
                "systemctl restart web",
                Some("/srv/x"),
                30_000,
            ),
            binding("client-1", "host-1", "systemctl restart web", None, 30_000),
            binding(
                "client-1",
                "host-1",
                "systemctl restart web",
                Some("/srv"),
                30_001,
            ),
        ] {
            assert_ne!(changed, b);
        }
        a.consume(&id, &b, now + 3).unwrap();
        // Replay refused.
        assert!(a
            .consume(&id, &b, now + 4)
            .unwrap_err()
            .starts_with("approval_used"));
        // A new identical call needs a new approval.
        let (id2, _, new2) = a.request(&b, now + 5);
        assert!(new2 && id2 != id);
        // Expiry.
        a.decide(&id2, true, now + 6).unwrap();
        assert!(a
            .consume(&id2, &b, now + 5 + APPROVAL_SECS)
            .unwrap_err()
            .starts_with("approval_expired"));
        // Approved but not used yet: a retried identical call reuses it.
        assert_eq!(a.request(&b, now + 10).0, id2);
        let b3 = binding("client-1", "host-1", "df -h", None, 30_000);
        let (id3, _, _) = a.request(&b3, now + 10);
        assert!(a
            .decide(&id3, true, now + 10 + APPROVAL_SECS)
            .unwrap_err()
            .starts_with("approval_expired"));
        // Denied stays denied; a retry asks again.
        let b4 = binding("client-1", "host-1", "reboot", None, 30_000);
        let (id4, _, _) = a.request(&b4, now + 20);
        a.decide(&id4, false, now + 21).unwrap();
        assert!(a
            .consume(&id4, &b4, now + 22)
            .unwrap_err()
            .starts_with("approval_denied"));
        assert!(a
            .decide(&id4, true, now + 23)
            .unwrap_err()
            .starts_with("approval_decided"));
        assert_ne!(a.request(&b4, now + 24).0, id4);
        assert!(a
            .decide("nope", true, now)
            .unwrap_err()
            .starts_with("unknown_approval"));
    }

    #[tokio::test]
    async fn waiting_approval_is_released_by_the_decision() {
        let a = Arc::new(Approvals::default());
        let b = binding("c", "t", "uptime", None, 1000);
        let (id, _, _) = a.request(&b, now_unix());
        let waiter = {
            let (a, id, b) = (a.clone(), id.clone(), b.clone());
            tokio::spawn(async move { a.wait(&id, &b).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        a.decide(&id, false, now_unix()).unwrap();
        assert!(waiter
            .await
            .unwrap()
            .unwrap_err()
            .starts_with("approval_denied"));
    }

    #[tokio::test]
    async fn allow_list_flow() {
        let (hub, dir) = hub("allow");
        let hub = Arc::new(hub);
        let c = hub.hello("Claude Desktop", "1.0").unwrap();
        assert!(!c.allowed && !c.decided);
        // No answer: refused after the wait.
        assert!(hub
            .wait_allowed(&c.id, Duration::from_millis(30))
            .await
            .unwrap_err()
            .starts_with("client_not_allowed"));
        // Allowed while waiting.
        let waiter = {
            let (hub, id) = (hub.clone(), c.id.clone());
            tokio::spawn(async move { hub.wait_allowed(&id, Duration::from_secs(5)).await })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        hub.allow(&c.id, true).unwrap();
        waiter.await.unwrap().unwrap();
        // Remembered across restarts, per name and version.
        let again = Hub::new(&dir);
        assert!(again.hello("Claude Desktop", "1.0").unwrap().allowed);
        // Per name: an update keeps the decision and records the new version.
        let updated = again.hello("Claude Desktop", "1.1").unwrap();
        assert!(updated.allowed && updated.id == c.id && updated.version == "1.1");
        assert_eq!(again.clients()[0].version, "1.1");
        assert!(!again.hello("Cursor", "1.0").unwrap().allowed);
        // Denied: refused at once.
        again.allow(&c.id, false).unwrap();
        assert!(again
            .wait_allowed(&c.id, Duration::from_secs(5))
            .await
            .unwrap_err()
            .starts_with("client_denied"));
        // Forgotten: asked again.
        again.forget(&c.id).unwrap();
        assert!(!again.hello("Claude Desktop", "1.0").unwrap().decided);
        assert!(again
            .allow("client-nope", true)
            .unwrap_err()
            .starts_with("unknown_client"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn audit_lines_are_appended() {
        let (hub, dir) = hub("audit");
        let entry = AuditEntry {
            time: format_rfc3339(0),
            origin: "local-mcp".into(),
            client: "Cursor".into(),
            client_version: "1".into(),
            tool: "fs_read".into(),
            target: "h".into(),
            target_label: "Web".into(),
            risk: "low".into(),
            outcome: "success".into(),
        };
        hub.audit(&entry);
        hub.audit(&entry);
        let text = std::fs::read_to_string(dir.join(AUDIT_FILE)).unwrap();
        assert_eq!(text.lines().count(), 2);
        let back: AuditEntry = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(back, entry);
        let _ = std::fs::remove_dir_all(dir);
    }
}
