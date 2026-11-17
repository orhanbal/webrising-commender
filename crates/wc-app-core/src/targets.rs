//! Hybrid Access targets (docs/HYBRID_ACCESS.md, H1): the AI access setting
//! of saved SSH hosts and what an AI client may see of them.
//!
//! Only the person changes AI access (`hosts.setAiAccess`); there is no MCP
//! tool for it. Switching `local` or `remote` on is refused unless the host
//! is SSH, its host key is already trusted (never trust-on-first-use for AI)
//! and it can log in without asking anything.
use std::sync::Arc;

use serde::Serialize;
use wc_ssh_core::client::Credential;

use crate::store::{AiAccess, Data, SavedHost};
use crate::{host_views, AppState, HostView};

/// Longest "timed" (autonomous) period.
pub const MAX_TIMED_SECS: i64 = 8 * 3600;
/// Clock skew tolerated between the app and the core for `timedUntil`.
const SKEW_SECS: i64 = 120;

/// Checks and normalises an AI access setting at time `now`.
pub fn validate(mut ai: AiAccess, now: i64) -> Result<AiAccess, String> {
    if !["readonly", "approval", "timed"].contains(&ai.preset.as_str()) {
        return Err("invalid_preset: preset must be readonly, approval or timed".into());
    }
    if !["never", "sudoers"].contains(&ai.sudo.as_str()) {
        return Err("invalid_sudo: sudo must be never or sudoers".into());
    }
    let connector = ai.connector.trim();
    if connector.is_empty() {
        ai.connector = "this-computer".into();
    } else if connector.len() > 128
        || !connector
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid_connector: unknown connector".into());
    } else {
        ai.connector = connector.to_owned();
    }
    if ai.preset == "timed" {
        let until = ai
            .timed_until
            .as_deref()
            .and_then(crate::time::parse_rfc3339)
            .ok_or("invalid_timed_until: timed needs timedUntil (RFC 3339)")?;
        if until <= now {
            return Err("invalid_timed_until: timedUntil is in the past".into());
        }
        if until > now + MAX_TIMED_SECS + SKEW_SECS {
            return Err("invalid_timed_until: at most 8 hours from now".into());
        }
        ai.timed_until = Some(crate::time::format_rfc3339(until));
    } else {
        ai.timed_until = None;
    }
    Ok(ai)
}

fn known_key(data: &Data, host: &SavedHost) -> Option<String> {
    data.known_hosts
        .get(&format!("{}:{}", host.profile.host, host.profile.port))
        .cloned()
}

/// Whether the saved host can log in with nothing to ask: a saved password,
/// a key that opens without a typed passphrase, or (no jump host) this
/// computer's own unencrypted `~/.ssh` keys or SSH agent. A jump host must
/// be trusted and have a saved credential too.
pub fn silent_login(state: &AppState, data: &Data, host: &SavedHost) -> bool {
    let h = crate::effective_host(data, host);
    let usable = |c: Option<Credential>| match c {
        Some(Credential::PrivateKey { key, passphrase }) => {
            wc_ssh_core::keys::inspect(&key, passphrase.as_deref()).is_ok()
        }
        Some(_) => true,
        None => false,
    };
    let direct = match crate::saved_credential(state, &h) {
        Some(c) => usable(Some(c)),
        None => {
            // A remembered key file that is gone (or an app key without its
            // private half) needs the person; only a host with no key of its
            // own falls back to this computer's keys or agent.
            h.jump_id.is_none()
                && h.auth_kind != "password"
                && h.key_path.is_none()
                && h.key_id.is_none()
                && (!crate::default_key_files().is_empty()
                    || wc_ssh_core::agent::local_agent_path().is_some())
        }
    };
    if !direct {
        return false;
    }
    match &h.jump_id {
        None => true,
        Some(jump_id) => data
            .hosts
            .iter()
            .find(|j| &j.id == jump_id)
            .map(|j| crate::effective_host(data, j))
            .is_some_and(|j| {
                known_key(data, &j).is_some() && usable(crate::saved_credential(state, &j))
            }),
    }
}

/// Why AI access cannot be switched on for `host`, as `code: text`.
pub fn precondition_error(state: &AppState, data: &Data, host: &SavedHost) -> Option<String> {
    if host.link.kind() != "ssh" {
        return Some(format!(
            "not_ssh: AI access works only on SSH hosts ({} is {})",
            host.profile.label,
            host.link.kind()
        ));
    }
    if known_key(data, host).is_none() {
        return Some(format!(
            "host_key_untrusted: connect to {} once and approve its host key first",
            host.profile.label
        ));
    }
    if !silent_login(state, data, host) {
        return Some(format!(
            "needs_credential: {} needs a saved password or key (or the SSH agent) so it can log in without asking",
            host.profile.label
        ));
    }
    None
}

/// `hosts.setAiAccess`: stores the host's AI access after the checks.
pub fn set_ai_access(
    state: &Arc<AppState>,
    id: String,
    ai: AiAccess,
) -> Result<Vec<HostView>, String> {
    let ai = validate(ai, crate::time::now_unix())?;
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let host = data
            .hosts
            .iter()
            .find(|h| h.id == id)
            .ok_or("host_not_found: host not found")?;
        if ai.local || ai.remote {
            if let Some(err) = precondition_error(state, &data, host) {
                return Err(err);
            }
        }
        let host = data
            .hosts
            .iter_mut()
            .find(|h| h.id == id)
            .ok_or("host_not_found: host not found")?;
        // The default is not stored: the host stays as it was in older files
        // (and in the sync base).
        host.ai_access = (ai != AiAccess::default()).then_some(ai);
        state.save(&data)?;
    }
    state.changed();
    host_views(state)
}

/// What a target can do, as `targets_list` reports it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Capabilities {
    pub exec: bool,
    pub read: bool,
    pub write: bool,
    pub terminal: bool,
    pub persistent_tasks: bool,
    /// "enforced" (agent) or "none" (SSH: no folder boundary).
    pub path_policy: &'static str,
}

/// One AI-visible target (`targets_list`). Never the address, user or
/// credential.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct TargetView {
    pub target_id: String,
    pub name: String,
    pub kind: &'static str,
    /// The connector (this app) answers; the server itself is reached on use.
    pub online: bool,
    pub capabilities: Capabilities,
    /// "readonly", "approval" or "timed" (a timed period that ended reads
    /// "approval").
    pub preset: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_until: Option<String>,
    pub sudo: String,
}

/// The preset in force at `now`: an expired "timed" behaves as "approval".
pub fn effective_preset(ai: &AiAccess, now: i64) -> &'static str {
    match ai.preset.as_str() {
        "readonly" => "readonly",
        "timed"
            if ai
                .timed_until
                .as_deref()
                .and_then(crate::time::parse_rfc3339)
                .is_some_and(|t| t > now) =>
        {
            "timed"
        }
        _ => "approval",
    }
}

pub fn capabilities(preset: &str) -> Capabilities {
    Capabilities {
        exec: preset != "readonly",
        read: true,
        // SFTP writes (H4): with an approval, like commands.
        write: preset != "readonly",
        terminal: false,
        persistent_tasks: false,
        path_policy: "none",
    }
}

/// The hosts exposed to AI clients on this computer (`aiAccess.local`).
pub fn local_targets(data: &Data) -> Vec<(SavedHost, AiAccess)> {
    data.hosts
        .iter()
        .filter(|h| h.link.kind() == "ssh")
        .filter_map(|h| {
            h.ai_access
                .as_ref()
                .filter(|a| a.local)
                .map(|a| (h.clone(), a.clone()))
        })
        .collect()
}

/// Whether a host's remote access is served by the connector `center_id`
/// (this computer's WECOMMANDER, signed in as that Management Center).
/// `this-computer` (stored before the app knew its own id) is served by any
/// signed-in computer that has the host.
pub fn served_by(ai: &AiAccess, center_id: &str) -> bool {
    !center_id.is_empty() && (ai.connector == center_id || ai.connector == "this-computer")
}

/// The hosts exposed to remote AI clients through this computer
/// (`aiAccess.remote` with this computer as the connector, phase H3).
pub fn remote_targets(data: &Data, center_id: &str) -> Vec<(SavedHost, AiAccess)> {
    data.hosts
        .iter()
        .filter(|h| h.link.kind() == "ssh")
        .filter_map(|h| {
            h.ai_access
                .as_ref()
                .filter(|a| a.remote && served_by(a, center_id))
                .map(|a| (h.clone(), a.clone()))
        })
        .collect()
}

/// What this computer publishes to the gateway for one remote target:
/// never the address, user or credential (docs/HYBRID_ACCESS.md §5).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublishedTarget {
    pub host_id: String,
    pub name: String,
    /// "readonly" or "approval": remote changes always need an approval.
    pub preset: String,
    pub sudo: String,
    pub capabilities: Capabilities,
}

pub fn published_targets(data: &Data, center_id: &str, now: i64) -> Vec<PublishedTarget> {
    remote_targets(data, center_id)
        .iter()
        .map(|(h, a)| {
            let preset = remote_preset(a, now);
            PublishedTarget {
                host_id: h.id.clone(),
                name: h.profile.label.clone(),
                preset: preset.to_owned(),
                sudo: a.sudo.clone(),
                capabilities: capabilities(preset),
            }
        })
        .collect()
}

/// The preset remote calls get: a timed (autonomous) period applies to AI
/// clients on this computer only; through wecommander.app every command and
/// every change needs a one-time approval.
pub fn remote_preset(ai: &AiAccess, now: i64) -> &'static str {
    match effective_preset(ai, now) {
        "readonly" => "readonly",
        _ => "approval",
    }
}

pub fn target_view(host: &SavedHost, ai: &AiAccess, now: i64) -> TargetView {
    let preset = effective_preset(ai, now);
    TargetView {
        target_id: host.id.clone(),
        name: host.profile.label.clone(),
        kind: "ssh",
        online: true,
        capabilities: capabilities(preset),
        preset: preset.to_owned(),
        timed_until: (preset == "timed")
            .then(|| ai.timed_until.clone())
            .flatten(),
        sudo: ai.sudo.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::format_rfc3339;

    #[derive(Default)]
    struct Sink;
    impl crate::EventSink for Sink {
        fn emit(&self, _: &str, _: serde_json::Value) {}
    }

    fn state(tag: &str) -> (Arc<AppState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("wc-targets-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (
            crate::open(&dir, "app.wecommander.test.targets", Arc::new(Sink)),
            dir,
        )
    }

    fn on(preset: &str) -> AiAccess {
        AiAccess {
            local: true,
            preset: preset.into(),
            ..Default::default()
        }
    }

    #[test]
    fn validation_of_presets_and_timed_until() {
        let now = 1_800_000_000;
        assert!(validate(on("approval"), now).is_ok());
        assert!(validate(on("yolo"), now)
            .unwrap_err()
            .starts_with("invalid_preset"));
        let mut s = on("approval");
        s.sudo = "always".into();
        assert!(validate(s, now).unwrap_err().starts_with("invalid_sudo"));
        let mut t = on("timed");
        assert!(validate(t.clone(), now)
            .unwrap_err()
            .starts_with("invalid_timed_until"));
        t.timed_until = Some(format_rfc3339(now + 9 * 3600));
        assert!(validate(t.clone(), now).unwrap_err().contains("8 hours"));
        t.timed_until = Some(format_rfc3339(now - 1));
        assert!(validate(t.clone(), now).unwrap_err().contains("past"));
        t.timed_until = Some(format_rfc3339(now + 8 * 3600));
        assert!(validate(t, now).is_ok());
        // Not timed: a leftover timedUntil is dropped.
        let mut a = on("approval");
        a.timed_until = Some(format_rfc3339(now + 60));
        assert_eq!(validate(a, now).unwrap().timed_until, None);
    }

    #[test]
    fn effective_preset_falls_back_to_approval() {
        let now = 1_800_000_000;
        let mut t = on("timed");
        t.timed_until = Some(format_rfc3339(now + 60));
        assert_eq!(effective_preset(&t, now), "timed");
        assert_eq!(effective_preset(&t, now + 61), "approval");
        assert_eq!(effective_preset(&on("readonly"), now), "readonly");
        assert!(!capabilities("readonly").exec);
        assert_eq!(capabilities("approval").path_policy, "none");
    }

    #[test]
    fn preconditions_refuse_with_codes() {
        let (st, dir) = state("pre");
        let hosts = crate::add_host(
            &st,
            "Web".into(),
            "srv.example.com".into(),
            22,
            "deploy".into(),
            "password".into(),
            None,
        )
        .unwrap();
        let id = hosts[0].id.clone();
        // Untrusted host key first.
        let err = set_ai_access(&st, id.clone(), on("approval")).unwrap_err();
        assert!(err.starts_with("host_key_untrusted:"), "{err}");
        st.data
            .lock()
            .unwrap()
            .known_hosts
            .insert("srv.example.com:22".into(), "SHA256:x".into());
        // Password host with nothing saved: cannot log in silently.
        let err = set_ai_access(&st, id.clone(), on("approval")).unwrap_err();
        assert!(err.starts_with("needs_credential:"), "{err}");
        st.vault
            .put(&crate::store::secret_key(&id, "password"), "pw")
            .unwrap();
        let hosts = set_ai_access(&st, id.clone(), on("readonly")).unwrap();
        assert!(hosts[0].ai_access.local);
        assert_eq!(hosts[0].ai_access.preset, "readonly");
        // Remote MCP (H3) through this computer.
        let remote = AiAccess {
            remote: true,
            connector: "center-1".into(),
            preset: "timed".into(),
            timed_until: Some(format_rfc3339(crate::time::now_unix() + 600)),
            ..on("approval")
        };
        let hosts = set_ai_access(&st, id.clone(), remote).unwrap();
        assert!(hosts[0].ai_access.remote);
        {
            let d = st.data.lock().unwrap();
            assert_eq!(remote_targets(&d, "center-1").len(), 1);
            // Another computer (another center) does not serve it, nor a signed-out one.
            assert!(remote_targets(&d, "center-2").is_empty());
            assert!(remote_targets(&d, "").is_empty());
            let published = published_targets(&d, "center-1", crate::time::now_unix());
            let text = serde_json::to_string(&published).unwrap();
            assert!(
                !text.contains("srv.example.com") && !text.contains("deploy"),
                "{text}"
            );
            // Timed is local only: remote changes still need approval.
            assert_eq!(published[0].preset, "approval");
            assert!(published[0].capabilities.write);
        }
        // A key that needs a typed passphrase, or a key file that is gone.
        crate::library::host_set_identity(&st, id.clone(), None).unwrap();
        {
            let mut d = st.data.lock().unwrap();
            d.hosts[0].auth_kind = "key".into();
            d.hosts[0].key_path = Some(dir.join("missing_key").to_string_lossy().into_owned());
        }
        let err = set_ai_access(&st, id.clone(), on("approval")).unwrap_err();
        assert!(err.starts_with("needs_credential:"), "{err}");
        st.vault
            .put(&crate::store::secret_key(&id, "key"), "-----BEGIN OPENSSH PRIVATE KEY-----\nbm90IGEga2V5\n-----END OPENSSH PRIVATE KEY-----\n")
            .unwrap();
        let err = set_ai_access(&st, id.clone(), on("approval")).unwrap_err();
        assert!(err.starts_with("needs_credential:"), "{err}");
        {
            let mut d = st.data.lock().unwrap();
            d.hosts[0].auth_kind = "password".into();
            d.hosts[0].key_path = None;
        }
        // Telnet hosts never.
        crate::library::host_set_connection(&st, id.clone(), "telnet".into(), None).unwrap();
        let err = set_ai_access(&st, id.clone(), on("approval")).unwrap_err();
        assert!(err.starts_with("not_ssh:"), "{err}");
        // Turning it off is always possible, and the default is not stored.
        set_ai_access(&st, id.clone(), AiAccess::default()).unwrap();
        assert!(st.data.lock().unwrap().hosts[0].ai_access.is_none());
        assert!(set_ai_access(&st, "nope".into(), AiAccess::default())
            .unwrap_err()
            .starts_with("host_not_found"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn old_host_files_load_with_ai_access_off() {
        let json = r#"{"hosts":[{"id":"a","label":"Web","host":"srv.example.com","port":22,"user":"deploy","authKind":"key"}],"knownHosts":{}}"#;
        let data: Data = serde_json::from_str(json).unwrap();
        assert_eq!(data.hosts[0].ai_access, None);
        // And nothing new is written for them (sync hashes stay the same).
        assert!(!serde_json::to_string(&data.hosts[0])
            .unwrap()
            .contains("aiAccess"));
        let partial = r#"{"local":true}"#;
        let ai: AiAccess = serde_json::from_str(partial).unwrap();
        assert_eq!(
            (ai.preset.as_str(), ai.sudo.as_str(), ai.connector.as_str()),
            ("approval", "never", "this-computer")
        );
        let now = 1_800_000_000;
        let mut d = data;
        assert!(local_targets(&d).is_empty());
        d.hosts[0].ai_access = Some(on("approval"));
        let view = target_view(&local_targets(&d)[0].0, &on("approval"), now);
        let text = serde_json::to_string(&view).unwrap();
        assert!(
            !text.contains("srv.example.com") && !text.contains("deploy"),
            "{text}"
        );
    }
}
