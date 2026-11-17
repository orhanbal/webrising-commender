//! The local MCP tools on SSH targets and their policy.
//!
//! Names and arguments are the gateway's (`process_exec`, `fs_list`,
//! `fs_read`, `fs_stat`, `server_overview`, `server_disk_usage`,
//! `server_processes`) plus `targets_list`; each takes a `target` (a host
//! the person exposed with `aiAccess.local`). Order of checks for every
//! call: target exposed → host key trusted → preset (readonly refuses
//! `process_exec`) → sudo guard → approval (one-time, bound to the exact
//! call) → silent SSH login (never trust-on-first-use) → run → redact →
//! audit.
use std::sync::Arc;

use base64::Engine;
use serde_json::{json, Map, Value};
use wc_ssh_core::client::Connection;
use wc_ssh_core::sftp::{ReadLimit, Sftp};

use super::{binding, redact, AuditEntry};
use crate::store::{AiAccess, SavedHost};
use crate::targets::{effective_preset, local_targets, target_view};
use crate::time::{format_rfc3339, now_unix};
use crate::AppState;

const TOOLS: &str = include_str!("tools.json");

/// Tools an SSH target supports in this phase.
pub const SSH_TOOLS: [&str; 8] = [
    "targets_list",
    "process_exec",
    "fs_list",
    "fs_read",
    "fs_stat",
    "server_overview",
    "server_disk_usage",
    "server_processes",
];

/// Gateway tools an SSH target does not support (yet).
const NOT_ON_SSH: &[&str] = &[
    "fs_write",
    "fs_append",
    "fs_delete",
    "fs_move",
    "fs_mkdir",
    "fs_replace",
    "fs_undo",
    "fs_versions",
    "fs_tree",
    "fs_search",
    "fs_read_lines",
    "fs_read_multiple",
    "code_search",
    "text_search",
    "terminal_start",
    "terminal_input",
    "terminal_read",
    "terminal_read_page",
    "terminal_list",
    "terminal_resize",
    "terminal_stop",
    "task_start",
    "task_status",
    "task_list",
    "task_cancel",
    "process_list",
    "process_kill",
    "server_cleanup_scan",
    "server_cleanup_run",
    "server_process_signal",
    "server_restart_owner",
    "system_info",
    "write_file",
    "edit_block",
    "move_file",
    "create_directory",
];

pub const MAX_LIST: usize = 1000;
pub const DEFAULT_READ_MAX: usize = 1024 * 1024;
pub const HARD_READ_MAX: usize = 4 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MAX_TIMEOUT_MS: u64 = 10 * 60_000;
/// Command output kept (the end).
pub const MAX_OUTPUT: usize = 64 * 1024;

pub fn tool_list() -> Value {
    serde_json::from_str(TOOLS).unwrap_or_else(|_| json!([]))
}

/// The client a call comes from (as it introduced itself).
#[derive(Clone, Debug)]
pub struct Caller {
    pub id: String,
    pub name: String,
    pub version: String,
}

/// A refused or failed call: a stable code and a sentence.
#[derive(Debug, PartialEq, Eq)]
pub struct Fail {
    pub code: String,
    pub message: String,
}

impl Fail {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    /// From a core error `code: text` (codes as in `hosts.exec`).
    fn from_coded(text: &str, fallback: &str) -> Self {
        match text.split_once(": ") {
            Some((code, rest))
                if !code.is_empty() && code.chars().all(|c| c.is_ascii_lowercase() || c == '_') =>
            {
                Self::new(code, rest)
            }
            _ => Self::new(fallback, text),
        }
    }

    fn value(&self) -> Value {
        json!({ "error": self.code, "message": self.message })
    }
}

/// Desktop Commander-style names accepted for the SSH tools.
fn canonical(name: &str) -> &str {
    match name {
        "list_directory" => "fs_list",
        "read_file" => "fs_read",
        "get_file_info" => "fs_stat",
        other => other,
    }
}

fn arg_str<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// The command word that would raise privileges (`sudo`, `su`, `doas`,
/// `pkexec`, `run0`), anywhere in the command line. A guard against the
/// obvious cases, not a sandbox: a shell can always build a word at run
/// time. The real limit is the SSH user's own rights (and sudoers).
pub fn privilege_word(command: &str) -> Option<&'static str> {
    const WORDS: [&str; 5] = ["sudo", "su", "doas", "pkexec", "run0"];
    command
        .split(|c: char| c.is_whitespace() || ";&|()`$<>{}\"'\\=!".contains(c))
        .filter(|t| !t.is_empty())
        .map(|t| t.rsplit('/').next().unwrap_or(t))
        .find_map(|t| WORDS.iter().copied().find(|w| *w == t))
}

/// Resolves the call's target among the exposed hosts.
fn resolve(state: &AppState, args: &Map<String, Value>) -> Result<(SavedHost, AiAccess), Fail> {
    let wanted = arg_str(args, "target")
        .or_else(|| arg_str(args, "device_id"))
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let data = state.data.lock().map_err(|_| Fail::new("busy", "busy"))?;
    let mut exposed = local_targets(&data);
    let found = match wanted {
        Some(t) => exposed.into_iter().find(|(h, _)| h.id == t),
        None if exposed.len() == 1 => exposed.pop(),
        None if exposed.is_empty() => None,
        None => {
            return Err(Fail::new(
                "target_required",
                "more than one server is available: pass target (see targets_list)",
            ))
        }
    };
    // Unknown and not-exposed hosts look the same to the AI.
    let (host, ai) = found.ok_or_else(|| {
        Fail::new(
            "target_not_exposed",
            "this server is not visible to AI clients on this computer (WECOMMANDER → server → AI access)",
        )
    })?;
    let trusted = data
        .known_hosts
        .contains_key(&format!("{}:{}", host.profile.host, host.profile.port));
    if !trusted {
        return Err(Fail::new(
            "host_key_untrusted",
            "the server's host key is not trusted on this computer: connect to it once in WECOMMANDER and approve it",
        ));
    }
    Ok((host, ai))
}

/// Runs one tool call for `caller`: `(result, is_error)`.
pub async fn call(
    state: &Arc<AppState>,
    caller: &Caller,
    name: &str,
    args: &Map<String, Value>,
) -> (Value, bool) {
    let name = canonical(name);
    if name == "targets_list" {
        return targets_list(state, caller, args);
    }
    if !SSH_TOOLS.contains(&name) {
        let fail = if NOT_ON_SSH.contains(&name) {
            Fail::new(
                "unsupported_for_target",
                format!("{name} is not available on SSH targets in this version (SSH targets: {}); install the WECOMMANDER agent on the server for more", SSH_TOOLS.join(", ")),
            )
        } else {
            Fail::new("unknown_tool", format!("unknown tool {name}"))
        };
        return (fail.value(), true);
    }
    let risk = if name == "process_exec" {
        "high"
    } else {
        "low"
    };
    let (target_id, label, result) = match resolve(state, args) {
        Ok((host, ai)) => {
            let r = run(state, caller, name, args, &host, &ai).await;
            (host.id, host.profile.label, r)
        }
        Err(fail) => (
            arg_str(args, "target")
                .unwrap_or("")
                .chars()
                .take(80)
                .collect(),
            String::new(),
            Err(fail),
        ),
    };
    let outcome = match &result {
        Ok(_) => "success".to_owned(),
        Err(f) => f.code.clone(),
    };
    record(state, caller, name, &target_id, &label, risk, &outcome);
    match result {
        Ok(v) => (v, false),
        Err(f) => (f.value(), true),
    }
}

/// Audit line and `mcp-activity` event.
fn record(
    state: &AppState,
    caller: &Caller,
    tool: &str,
    target: &str,
    label: &str,
    risk: &str,
    outcome: &str,
) {
    state.mcp.audit(&AuditEntry {
        time: format_rfc3339(now_unix()),
        origin: "local-mcp".into(),
        client: caller.name.clone(),
        client_version: caller.version.clone(),
        tool: tool.into(),
        target: target.into(),
        target_label: label.into(),
        risk: risk.into(),
        outcome: outcome.into(),
    });
    state.emit(
        "mcp-activity",
        json!({
            "clientName": caller.name,
            "targetLabel": label,
            "targetId": target,
            "tool": tool,
            "outcome": outcome,
            "at": format_rfc3339(now_unix()),
        }),
    );
}

fn targets_list(state: &AppState, caller: &Caller, args: &Map<String, Value>) -> (Value, bool) {
    let now = now_unix();
    let result = (|| {
        let data = state.data.lock().map_err(|_| Fail::new("busy", "busy"))?;
        let mut list: Vec<_> = local_targets(&data)
            .iter()
            .map(|(h, a)| target_view(h, a, now))
            .collect();
        if let Some(t) = arg_str(args, "target").filter(|t| !t.trim().is_empty()) {
            list.retain(|v| v.target_id == t.trim());
            if list.is_empty() {
                return Err(Fail::new(
                    "target_not_exposed",
                    "this server is not visible to AI clients on this computer",
                ));
            }
        }
        Ok(json!({
            "targets": list,
            "note": "SSH targets have no folder boundary (path_policy none): a command reaches everything the SSH user can. Approvals are asked in the WECOMMANDER app.",
        }))
    })();
    let outcome = match &result {
        Ok(_) => "success".to_owned(),
        Err(f) => f.code.clone(),
    };
    record(state, caller, "targets_list", "", "", "low", &outcome);
    match result {
        Ok(v) => (v, false),
        Err(f) => (f.value(), true),
    }
}

/// The checks before `process_exec` connects: preset, sudo guard, command,
/// folder and timeout. Returns `(command, cwd, timeout_ms, needs_approval)`.
pub fn check_exec(
    ai: &AiAccess,
    args: &Map<String, Value>,
    now: i64,
) -> Result<(String, Option<String>, u64, bool), Fail> {
    let preset = effective_preset(ai, now);
    if preset == "readonly" {
        return Err(Fail::new(
            "readonly_preset",
            "this server is read-only for AI clients: commands are off (the person can change this in WECOMMANDER)",
        ));
    }
    let command = arg_str(args, "command").unwrap_or("").to_owned();
    crate::exec::check_command(&command).map_err(|e| Fail::from_coded(&e, "invalid_command"))?;
    if ai.sudo != "sudoers" {
        if let Some(word) = privilege_word(&command) {
            return Err(Fail::new(
                "sudo_not_allowed",
                format!("`{word}` is not allowed on this server for AI clients (sudo: never)"),
            ));
        }
    }
    let cwd = arg_str(args, "cwd")
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    if let Some(c) = &cwd {
        if c.len() > 4096 || c.chars().any(|ch| ch.is_control()) {
            return Err(Fail::new("invalid_cwd", "cwd is not a valid folder"));
        }
    }
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1000, MAX_TIMEOUT_MS);
    Ok((command, cwd, timeout_ms, preset != "timed"))
}

/// Asks the person (event `mcp-approval`) and waits for the one-time
/// approval of exactly this call.
async fn approve(
    state: &AppState,
    caller: &Caller,
    host: &SavedHost,
    command: &str,
    cwd: Option<&str>,
    timeout_ms: u64,
) -> Result<(), Fail> {
    let b = binding(&caller.id, &host.id, command, cwd, timeout_ms);
    let (id, expires_at, new) = state.mcp.approvals.request(&b, now_unix());
    if new {
        state.emit(
            "mcp-approval",
            json!({
                "approvalId": id,
                "clientName": caller.name,
                "clientId": caller.id,
                "targetId": host.id,
                "targetLabel": host.profile.label,
                "tool": "process_exec",
                "summary": format!(
                    "{} wants to run a command on {}{}",
                    caller.name,
                    host.profile.label,
                    cwd.map(|c| format!(" in {c}")).unwrap_or_default()
                ),
                "command": command,
                "cwd": cwd,
                "timeoutMs": timeout_ms,
                "expiresAt": format_rfc3339(expires_at),
            }),
        );
    }
    state
        .mcp
        .approvals
        .wait(&id, &b)
        .await
        .map_err(|e| Fail::from_coded(&e, "approval_failed"))
}

async fn connect(
    state: &AppState,
    host: &SavedHost,
) -> Result<(Connection, Option<Arc<Connection>>), Fail> {
    crate::connect_quietly(state, &host.id)
        .await
        .map_err(|e| Fail::from_coded(&crate::exec::classify_connect_error(&e), "connect_failed"))
}

async fn run(
    state: &Arc<AppState>,
    caller: &Caller,
    name: &str,
    args: &Map<String, Value>,
    host: &SavedHost,
    ai: &AiAccess,
) -> Result<Value, Fail> {
    if name == "process_exec" {
        let (command, cwd, timeout_ms, needs_approval) = check_exec(ai, args, now_unix())?;
        if needs_approval {
            approve(state, caller, host, &command, cwd.as_deref(), timeout_ms).await?;
        }
        let (conn, _jump) = connect(state, host).await?;
        let line = match &cwd {
            Some(c) => format!("cd {} && {command}", wc_server::quote(c)),
            None => command.clone(),
        };
        let out = conn
            .exec_tail(
                &line,
                MAX_OUTPUT,
                std::time::Duration::from_millis(timeout_ms),
            )
            .await
            .map_err(|e| Fail::new("exec_failed", e.to_string()));
        let _ = conn.close().await;
        let out = out?;
        let (output, redactions) =
            redact::redact_text(&crate::exec::tail_text(&out.output, out.truncated));
        return Ok(json!({
            "exitCode": out.exit_status,
            "output": output,
            "timedOut": out.timed_out,
            "truncated": out.truncated,
            "redactions": redactions,
        }));
    }
    let (conn, _jump) = connect(state, host).await?;
    let result = match name {
        "fs_list" | "fs_read" | "fs_stat" => sftp_tool(&conn, name, args).await,
        _ => server_tool(conn, name, args).await,
    };
    result
}

async fn sftp_tool(
    conn: &Connection,
    name: &str,
    args: &Map<String, Value>,
) -> Result<Value, Fail> {
    let sftp = conn
        .sftp()
        .await
        .map_err(|e| Fail::new("sftp_failed", e.to_string()))?;
    let result = sftp_call(&sftp, name, args).await;
    let _ = sftp.close().await;
    result
}

/// `~`, `~/x`, `.` and an empty path start at the SSH user's home folder.
async fn remote_path(sftp: &Sftp, raw: &str) -> Result<String, Fail> {
    let raw = raw.trim();
    if raw.contains('\0') || raw.len() > 4096 {
        return Err(Fail::new("invalid_path", "path is not valid"));
    }
    let home = || async {
        sftp.home()
            .await
            .map_err(|e| Fail::new("sftp_failed", e.to_string()))
    };
    Ok(match raw {
        "" | "~" | "." => home().await?,
        _ if raw.starts_with("~/") => wc_ssh_core::sftp::join(&home().await?, &raw[2..]),
        _ => raw.to_owned(),
    })
}

fn sftp_fail(e: wc_ssh_core::client::SshError) -> Fail {
    Fail::new("fs_error", e.to_string())
}

async fn sftp_call(sftp: &Sftp, name: &str, args: &Map<String, Value>) -> Result<Value, Fail> {
    let path = remote_path(sftp, arg_str(args, "path").unwrap_or("")).await?;
    match name {
        "fs_list" => {
            let mut entries = sftp.list(&path).await.map_err(sftp_fail)?;
            let truncated = entries.len() > MAX_LIST;
            entries.truncate(MAX_LIST);
            Ok(json!({ "path": path, "entries": entries, "truncated": truncated }))
        }
        "fs_stat" => {
            let e = sftp.stat(&path).await.map_err(sftp_fail)?;
            Ok(json!({
                "path": path,
                "kind": e.kind,
                "isFile": e.kind == "file",
                "isDirectory": e.kind == "dir",
                "size": e.size,
                "modified": e.modified,
                "permissions": e.permissions,
            }))
        }
        _ => {
            let limit = args
                .get("max_bytes")
                .and_then(Value::as_u64)
                .map(|n| n as usize)
                .unwrap_or(DEFAULT_READ_MAX)
                .clamp(1, HARD_READ_MAX);
            match sftp.read_limited(&path, limit).await.map_err(sftp_fail)? {
                ReadLimit::TooLarge(_) => Err(Fail::new(
                    "file_too_large",
                    format!("file exceeds read limit of {limit} bytes"),
                )),
                ReadLimit::Read(bytes) => Ok(match String::from_utf8(bytes) {
                    Ok(text) => {
                        json!({ "path": path, "encoding": "utf8", "size": text.len(), "content": text })
                    }
                    Err(e) => {
                        let bytes = e.into_bytes();
                        json!({
                            "path": path,
                            "encoding": "base64",
                            "size": bytes.len(),
                            "content": base64::engine::general_purpose::STANDARD.encode(&bytes),
                        })
                    }
                }),
            }
        }
    }
}

async fn server_tool(
    conn: Connection,
    name: &str,
    args: &Map<String, Value>,
) -> Result<Value, Fail> {
    let sh = crate::server::Ssh(Arc::new(conn));
    let fail = |e: String| Fail::new("server_error", e);
    let to_value = |v: Result<Value, serde_json::Error>| v.map_err(|e| fail(e.to_string()));
    match name {
        "server_overview" => to_value(serde_json::to_value(
            wc_server::overview(&sh).await.map_err(fail)?,
        )),
        "server_disk_usage" => {
            let path = arg_str(args, "path")
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_owned);
            let none = |_: u64, _: u64| {};
            to_value(serde_json::to_value(
                wc_server::disk_usage(&sh, path, &none)
                    .await
                    .map_err(fail)?,
            ))
        }
        _ => {
            let mut v = to_value(serde_json::to_value(
                wc_server::processes(&sh).await.map_err(fail)?,
            ))?;
            redact::redact_value(&mut v);
            Ok(v)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => Map::new(),
        }
    }

    #[test]
    fn tool_list_has_the_ssh_tools_with_hints() {
        let list = tool_list();
        let names: Vec<&str> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, SSH_TOOLS);
        for t in list.as_array().unwrap() {
            let destructive = t["name"] == "process_exec";
            assert_eq!(t["annotations"]["readOnlyHint"], json!(!destructive));
            assert_eq!(t["annotations"]["destructiveHint"], json!(destructive));
        }
    }

    #[test]
    fn sudo_guard_catches_the_obvious_forms() {
        for cmd in [
            "sudo id",
            "ls; sudo rm -rf /x",
            "echo hi && su - root",
            "doas reboot",
            "/usr/bin/sudo -n true",
            "sh -c 'sudo id'",
            "x=$(sudo cat /etc/shadow)",
            "pkexec bash",
            "true|sudo tee /etc/x",
        ] {
            assert!(privilege_word(cmd).is_some(), "{cmd}");
        }
        for cmd in [
            "ls -la",
            "echo pseudo",
            "cat /etc/sudoers.d/README",
            "subl x",
            "grep -r issue .",
        ] {
            assert_eq!(privilege_word(cmd), None, "{cmd}");
        }
    }

    #[test]
    fn exec_checks_presets_sudo_and_bounds() {
        let now = 1_800_000_000;
        let mut ai = AiAccess {
            local: true,
            preset: "readonly".into(),
            ..Default::default()
        };
        let a = args(json!({"command": "uptime"}));
        assert_eq!(
            check_exec(&ai, &a, now).unwrap_err().code,
            "readonly_preset"
        );
        ai.preset = "approval".into();
        let (cmd, cwd, t, approval) = check_exec(&ai, &a, now).unwrap();
        assert_eq!(
            (cmd.as_str(), cwd, t, approval),
            ("uptime", None, DEFAULT_TIMEOUT_MS, true)
        );
        let s = args(json!({"command": "sudo systemctl restart web"}));
        assert_eq!(
            check_exec(&ai, &s, now).unwrap_err().code,
            "sudo_not_allowed"
        );
        ai.sudo = "sudoers".into();
        assert!(check_exec(&ai, &s, now).is_ok());
        // Timed: no approval while the period lasts, then approval again.
        ai.preset = "timed".into();
        ai.timed_until = Some(format_rfc3339(now + 60));
        assert!(!check_exec(&ai, &a, now).unwrap().3);
        assert!(check_exec(&ai, &a, now + 61).unwrap().3);
        let bounds = args(json!({"command": "x", "timeout_ms": 99_999_999, "cwd": " /srv "}));
        let (_, cwd, t, _) = check_exec(&ai, &bounds, now).unwrap();
        assert_eq!((cwd.as_deref(), t), (Some("/srv"), MAX_TIMEOUT_MS));
        assert_eq!(
            check_exec(&ai, &args(json!({"command": " "})), now)
                .unwrap_err()
                .code,
            "invalid_command"
        );
        assert_eq!(
            check_exec(&ai, &args(json!({"command": "x", "cwd": "a\nb"})), now)
                .unwrap_err()
                .code,
            "invalid_cwd"
        );
    }

    #[test]
    fn coded_errors_split() {
        assert_eq!(
            Fail::from_coded("needs_credential: web: no saved credential", "x"),
            Fail::new("needs_credential", "web: no saved credential")
        );
        assert_eq!(Fail::from_coded("Weird: thing", "x").code, "x");
    }
}
