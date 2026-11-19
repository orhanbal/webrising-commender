//! Server management for MCP: the same fixed scripts as the apps' "Sunucu
//! yönetimi" (`wc-server`), run with `sh` on this machine instead of over
//! SSH. Nothing is installed; changes need root (or sudo without a
//! password) and refuse the processes that keep the server reachable.

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::protocol::AgentAction;

const MAX_OUTPUT: usize = 4 * 1024 * 1024;

/// Runs a script with this machine's `sh`; the output is capped like the
/// SSH runner's.
#[cfg(target_os = "linux")]
struct Local;

#[cfg(target_os = "linux")]
impl wc_server::Shell for Local {
    async fn run_script(&self, script: &str, secs: u64) -> Result<String, String> {
        let child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("sh could not start: {e}"))?;
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(secs),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| "Sunucu zamanında yanıt vermedi.".to_owned())?
        .map_err(|e| e.to_string())?;
        let mut stdout = out.stdout;
        stdout.truncate(MAX_OUTPUT);
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    }
}

fn json<T: serde::Serialize>(value: T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

#[cfg(target_os = "linux")]
pub async fn execute(action: AgentAction) -> Result<Value> {
    let sh = Local;
    let done = |r: Result<String, String>| -> Result<Value> {
        r.map(|_| serde_json::json!({ "ok": true }))
            .map_err(|e| anyhow!(e))
    };
    match action {
        AgentAction::ServerOverview => {
            json(wc_server::overview(&sh).await.map_err(|e| anyhow!(e))?)
        }
        AgentAction::ServerDiskUsage { path } => json(
            wc_server::disk_usage(&sh, path, &|_, _| {})
                .await
                .map_err(|e| anyhow!(e))?,
        ),
        AgentAction::ServerCleanupScan => {
            json(wc_server::cleanup_scan(&sh).await.map_err(|e| anyhow!(e))?)
        }
        AgentAction::ServerCleanupRun { ids } => json(
            wc_server::cleanup_run(&sh, ids)
                .await
                .map_err(|e| anyhow!(e))?,
        ),
        AgentAction::ServerProcesses => {
            json(wc_server::processes(&sh).await.map_err(|e| anyhow!(e))?)
        }
        AgentAction::ServerTimersList => timers_list(&sh).await,
        AgentAction::ServerProcessSignal {
            pid,
            name,
            action,
            confirm_database,
        } => done(
            wc_server::process_signal(&sh, pid, name, action, confirm_database.unwrap_or(false))
                .await,
        ),
        AgentAction::ServerRestartOwner { owner_kind, id } => {
            done(wc_server::restart_owner(&sh, owner_kind, id).await)
        }
        other => Err(anyhow!("not a server action: {}", other.kind_name())),
    }
}

/// Timers and cron entries as the agent's user sees them (no root needed),
/// with `unreadable`: what could not be read or is never read, so a short
/// list is not mistaken for a complete one. Unreadable cron files are listed
/// there instead of as empty entries.
#[cfg(target_os = "linux")]
async fn timers_list<S: wc_server::Shell>(sh: &S) -> Result<Value> {
    let mut timers = wc_server::timers(sh).await.map_err(|e| anyhow!(e))?;
    let unreadable = wc_server::timers_unreadable(&timers);
    timers
        .cron
        .retain(|entry| !wc_server::cron_unreadable(entry));
    let mut value = json(&timers)?;
    if let Some(object) = value.as_object_mut() {
        object.insert("unreadable".into(), json(unreadable)?);
    }
    Ok(value)
}

/// The scripts are written for Linux (procfs, systemd, GNU find).
#[cfg(not(target_os = "linux"))]
pub async fn execute(action: AgentAction) -> Result<Value> {
    let _ = (MAX_OUTPUT, json::<()>);
    Err(anyhow!(
        "server_unsupported: {} works on Linux servers only",
        action.kind_name()
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn action(json: serde_json::Value) -> AgentAction {
        serde_json::from_value(json).unwrap()
    }

    #[tokio::test]
    async fn the_gateway_actions_run_the_app_scripts_here() {
        let overview = execute(action(serde_json::json!({ "kind": "server_overview" })))
            .await
            .unwrap();
        assert!(overview["cpus"].as_u64().unwrap_or(0) >= 1, "{overview}");
        assert!(!overview["disks"].as_array().unwrap().is_empty());

        let scan = execute(action(serde_json::json!({ "kind": "server_cleanup_scan" })))
            .await
            .unwrap();
        assert!(scan["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == "journal"));

        let processes = execute(action(serde_json::json!({ "kind": "server_processes" })))
            .await
            .unwrap();
        let me = std::process::id() as u64;
        assert!(processes["processes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["pid"].as_u64() == Some(me)));

        let timers = execute(action(serde_json::json!({ "kind": "server_timers_list" })))
            .await
            .unwrap();
        assert!(timers["timers"].is_array(), "{timers}");
        assert!(timers["cron"].is_array());
        assert!(timers["unreadable"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u["source"] == "other users"));
    }

    #[test]
    fn change_actions_carry_the_gateway_field_names() {
        let a = action(serde_json::json!({
            "kind": "server_process_signal", "pid": 42, "name": "nginx", "action": "reap", "confirmDatabase": false
        }));
        assert_eq!(a.kind_name(), "server_process_signal");
        assert_eq!(a.risk(), crate::protocol::Risk::High);
        let r = action(
            serde_json::json!({ "kind": "server_restart_owner", "ownerKind": "service", "id": "nginx.service" }),
        );
        assert!(
            matches!(r, AgentAction::ServerRestartOwner { ref owner_kind, .. } if owner_kind == "service")
        );
        let c = action(serde_json::json!({ "kind": "server_cleanup_run", "ids": ["apt-cache"] }));
        assert_eq!(c.risk(), crate::protocol::Risk::High);
    }

    #[tokio::test]
    async fn unsafe_restarts_are_refused_before_anything_runs() {
        let err = execute(action(serde_json::json!({ "kind": "server_restart_owner", "ownerKind": "service", "id": "sshd.service" })))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("yeniden başlatılamaz"), "{err}");
    }
}
