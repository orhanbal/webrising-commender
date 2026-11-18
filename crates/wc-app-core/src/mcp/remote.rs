//! Remote MCP through this computer (Hybrid Access H3, docs/HYBRID_ACCESS.md
//! §5): AI clients connected to wecommander.app (ChatGPT, Claude.ai) use the
//! SSH hosts the person shared with `aiAccess.remote` and this computer as
//! the connector. The app, signed in as Management Center `centerId`,
//!
//! * publishes [`targets`] (name, preset, sudo, capabilities; never the
//!   address, user or credential) to the gateway, and
//! * claims the calls the gateway queued for it and hands each to [`call`];
//!   the SSH keys and passwords stay on this computer, the connection to the
//!   server is made from here.
//!
//! The gateway is the approval authority for remote calls: every command
//! and file change needs the person's one-time approval there, bound to the
//! client, target and exact arguments, before it is queued with
//! `approved: true`. This side still checks everything it can on its own:
//! the host is shared remotely through this computer, the host key is
//! trusted, readonly refuses changes, the sudo guard, limits, and each call
//! id runs only once.
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::tools::{self, Caller, Fail, Origin};
use crate::targets::{published_targets, PublishedTarget};
use crate::time::now_unix;
use crate::AppState;

/// How long a handled call id is remembered (replays refused).
const SEEN_SECS: i64 = 24 * 3600;

/// `mcp.remoteTargets`: what this computer publishes as connector `center_id`.
pub fn targets(state: &AppState, center_id: &str) -> Result<Vec<PublishedTarget>, String> {
    let center_id = center_id.trim();
    if center_id.is_empty() {
        return Ok(Vec::new());
    }
    let data = state.data.lock().map_err(|_| "busy")?;
    Ok(published_targets(&data, center_id, now_unix()))
}

/// One call the gateway queued for this computer (`mcp.remoteCall`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCall {
    pub call_id: String,
    pub center_id: String,
    /// The AI client as the gateway knows it (for the audit and activity list).
    #[serde(default)]
    pub client: String,
    pub tool: String,
    /// The tool's arguments; `target` is the host id.
    #[serde(default)]
    pub args: Map<String, Value>,
    /// The gateway holds the person's approval of exactly this call.
    #[serde(default)]
    pub approved: bool,
}

fn clean(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// Remembers `call_id`; false when it was already handled.
fn first_time(state: &AppState, call_id: &str, now: i64) -> bool {
    let Ok(mut seen) = state.mcp.remote_seen.lock() else {
        return false;
    };
    seen.retain(|_, at| *at > now - SEEN_SECS);
    if seen.contains_key(call_id) {
        return false;
    }
    seen.insert(call_id.to_owned(), now);
    true
}

/// Runs one remote call: `{ok: true, result}` or `{ok: false, error, message}`.
pub async fn call(state: &Arc<AppState>, request: RemoteCall) -> Value {
    let failed = |f: Fail| json!({ "ok": false, "error": f.code, "message": f.message });
    let call_id = request.call_id.trim();
    let center_id = request.center_id.trim();
    if call_id.is_empty() || call_id.len() > 100 || center_id.is_empty() {
        return failed(Fail::new(
            "invalid_call",
            "call id and connector id are required",
        ));
    }
    if !first_time(state, call_id, now_unix()) {
        return failed(Fail::new(
            "duplicate_call",
            "this call was already handled by this computer",
        ));
    }
    let name = {
        let c = clean(&request.client, 100);
        if c.is_empty() {
            "remote AI client".to_owned()
        } else {
            c
        }
    };
    let caller = Caller {
        id: format!("remote:{}", super::client_id(&name)),
        name,
        version: String::new(),
    };
    let origin = Origin::Remote {
        center_id: center_id.to_owned(),
        approved: request.approved,
    };
    let (data, is_error) =
        tools::call_from(state, &caller, &origin, &request.tool, &request.args).await;
    if is_error {
        json!({
            "ok": false,
            "error": data["error"].as_str().unwrap_or("error"),
            "message": data["message"].as_str().unwrap_or(""),
        })
    } else {
        json!({ "ok": true, "result": data })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::AiAccess;

    #[derive(Default)]
    struct Sink;
    impl crate::EventSink for Sink {
        fn emit(&self, _: &str, _: Value) {}
    }

    fn remote_call(id: &str, tool: &str, args: Value, approved: bool) -> RemoteCall {
        RemoteCall {
            call_id: id.into(),
            center_id: "center-1".into(),
            client: "ChatGPT".into(),
            tool: tool.into(),
            args: args.as_object().cloned().unwrap_or_default(),
            approved,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn remote_policy_before_any_connection() {
        let dir = std::env::temp_dir().join(format!("wc-mcp-remote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = crate::open(&dir, "app.wecommander.test.remote", Arc::new(Sink));
        let hosts = crate::add_host(
            &state,
            "Web".into(),
            "203.0.113.9".into(),
            22,
            "deploy".into(),
            "password".into(),
            None,
        )
        .unwrap();
        let web = hosts[0].id.clone();
        let hosts = crate::add_host(
            &state,
            "LocalOnly".into(),
            "203.0.113.10".into(),
            22,
            "deploy".into(),
            "password".into(),
            None,
        )
        .unwrap();
        let local_only = hosts[1].id.clone();
        {
            let mut d = state.data.lock().unwrap();
            d.known_hosts
                .insert("203.0.113.9:22".into(), "SHA256:x".into());
            d.known_hosts
                .insert("203.0.113.10:22".into(), "SHA256:y".into());
        }
        for id in [&web, &local_only] {
            state
                .vault
                .put(&crate::store::secret_key(id, "password"), "pw")
                .unwrap();
        }
        crate::targets::set_ai_access(
            &state,
            web.clone(),
            AiAccess {
                remote: true,
                connector: "center-1".into(),
                preset: "readonly".into(),
                ..Default::default()
            },
        )
        .unwrap();
        crate::targets::set_ai_access(
            &state,
            local_only.clone(),
            AiAccess {
                local: true,
                ..Default::default()
            },
        )
        .unwrap();

        // Published: only the remote host, without address or user.
        let published = targets(&state, "center-1").unwrap();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].host_id, web);
        assert!(targets(&state, "center-2").unwrap().is_empty());
        let text = serde_json::to_string(&published).unwrap();
        assert!(!text.contains("203.0.113") && !text.contains("deploy"));

        let code = |v: &Value| v["error"].as_str().unwrap_or("").to_owned();
        // targets_list sees only remote targets.
        let r = call(&state, remote_call("c1", "targets_list", json!({}), false)).await;
        assert_eq!(r["ok"], true);
        assert_eq!(r["result"]["targets"].as_array().unwrap().len(), 1);
        // A local-only host is not reachable remotely; nor through another center.
        let r = call(
            &state,
            remote_call(
                "c2",
                "fs_list",
                json!({"target": local_only, "path": "/"}),
                false,
            ),
        )
        .await;
        assert_eq!(code(&r), "target_not_exposed");
        let mut other = remote_call("c3", "fs_list", json!({"target": web, "path": "/"}), false);
        other.center_id = "center-2".into();
        assert_eq!(code(&call(&state, other).await), "target_not_exposed");
        // Readonly: commands and file changes refused even when "approved".
        for (i, (tool, args)) in [
            ("process_exec", json!({"target": web, "command": "uptime"})),
            (
                "fs_write",
                json!({"target": web, "path": "/tmp/x", "content_base64": "eA=="}),
            ),
            ("fs_delete", json!({"target": web, "path": "/tmp/x"})),
        ]
        .into_iter()
        .enumerate()
        {
            let r = call(&state, remote_call(&format!("ro{i}"), tool, args, true)).await;
            assert_eq!(code(&r), "readonly_preset", "{tool}");
        }
        // Approval preset: without the gateway's approval, refused (also in a timed period).
        crate::targets::set_ai_access(
            &state,
            web.clone(),
            AiAccess {
                remote: true,
                connector: "center-1".into(),
                preset: "timed".into(),
                timed_until: Some(crate::time::format_rfc3339(now_unix() + 600)),
                ..Default::default()
            },
        )
        .unwrap();
        let r = call(
            &state,
            remote_call(
                "e1",
                "process_exec",
                json!({"target": web, "command": "uptime"}),
                false,
            ),
        )
        .await;
        assert_eq!(code(&r), "approval_required");
        let r = call(
            &state,
            remote_call(
                "w1",
                "fs_mkdir",
                json!({"target": web, "path": "/tmp/x"}),
                false,
            ),
        )
        .await;
        assert_eq!(code(&r), "approval_required");
        // Sudo guard applies remotely too.
        let r = call(
            &state,
            remote_call(
                "e2",
                "process_exec",
                json!({"target": web, "command": "sudo id"}),
                true,
            ),
        )
        .await;
        assert_eq!(code(&r), "sudo_not_allowed");
        // A call id runs once.
        let r = call(&state, remote_call("e2", "targets_list", json!({}), false)).await;
        assert_eq!(code(&r), "duplicate_call");
        // Host key forgotten: never trust-on-first-use.
        state.data.lock().unwrap().known_hosts.clear();
        let r = call(
            &state,
            remote_call(
                "k1",
                "fs_read",
                json!({"target": web, "path": "/etc/hostname"}),
                false,
            ),
        )
        .await;
        assert_eq!(code(&r), "host_key_untrusted");
        // Audit: origin remote-mcp, never command text.
        let audit = std::fs::read_to_string(dir.join(crate::mcp::AUDIT_FILE)).unwrap();
        assert!(audit.contains("remote-mcp") && audit.contains("approval_required"));
        assert!(!audit.contains("uptime") && !audit.contains("sudo id"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
