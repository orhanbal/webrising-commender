//! The MCP tools on SSH targets and their policy, for AI clients on this
//! computer (local MCP, H2) and remote ones through wecommander.app with
//! this computer as the connector (H3).
//!
//! Names and arguments are the gateway's (`process_exec`, `fs_list`,
//! `fs_read`, `fs_stat`, `server_overview`, `server_disk_usage`,
//! `server_processes`, and since H4 `fs_write`, `fs_mkdir`, `fs_move`,
//! `fs_delete`; then `server_cleanup_scan`, `server_cleanup_run`,
//! `server_process_signal`, `server_timers_list`, `docker_containers_list`,
//! `docker_container_logs`, `docker_container_action`, the same
//! `wc-server` scripts as the server window) plus `targets_list`; each takes a `target` (a host the
//! person exposed with `aiAccess.local`, or `aiAccess.remote` for remote
//! calls). Order of checks for every call: target exposed → host key
//! trusted → preset (readonly refuses commands and changes) → sudo guard →
//! approval (one-time, bound to the exact call: asked in this app for local
//! clients, already enforced by the gateway for remote ones) → silent SSH
//! login (never trust-on-first-use) → run → redact → audit.
//!
//! Run as root (remote only, docs/AI_PERMISSIONS.md): the gateway sends
//! `run_as: "root"` with `process_exec` and `fs_write` when the person set
//! that SSH target to root in the web panel. This side is the second key:
//! it escalates (`sudo -n`) only when its own `sudo` setting for the host is
//! `sudoers`, and refuses the call otherwise (never runs it as the user
//! instead). Local clients cannot ask for it.
use std::sync::Arc;

use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use wc_ssh_core::client::Connection;
use wc_ssh_core::sftp::{ReadLimit, Sftp};

use super::{binding, binding_call, redact, AuditEntry};
use crate::store::{AiAccess, SavedHost};
use crate::targets::{effective_preset, local_targets, remote_preset, remote_targets, target_view};
use crate::time::{format_rfc3339, now_unix};
use crate::AppState;

const TOOLS: &str = include_str!("tools.json");

/// Tools an SSH target supports.
pub const SSH_TOOLS: [&str; 19] = [
    "targets_list",
    "process_exec",
    "fs_list",
    "fs_read",
    "fs_stat",
    "server_overview",
    "server_disk_usage",
    "server_processes",
    "fs_write",
    "fs_mkdir",
    "fs_move",
    "fs_delete",
    "server_cleanup_scan",
    "server_cleanup_run",
    "server_process_signal",
    "server_timers_list",
    "docker_containers_list",
    "docker_container_logs",
    "docker_container_action",
];

/// Tools that change the server: refused on readonly targets, each needs a
/// one-time approval (locally unless a timed period runs; remotely always).
pub const CHANGE_TOOLS: [&str; 8] = [
    "process_exec",
    "fs_write",
    "fs_mkdir",
    "fs_move",
    "fs_delete",
    "server_cleanup_run",
    "server_process_signal",
    "docker_container_action",
];

/// The changes that run `wc-server`'s fixed scripts (not SFTP).
pub const SERVER_CHANGE_TOOLS: [&str; 3] = [
    "server_cleanup_run",
    "server_process_signal",
    "docker_container_action",
];

/// Gateway tools an SSH target does not support (yet).
const NOT_ON_SSH: &[&str] = &[
    "fs_append",
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
/// Largest `fs_write` (decoded bytes).
pub const MAX_WRITE: usize = 4 * 1024 * 1024;
/// Most entries a recursive `fs_delete` removes (counted before anything is deleted).
pub const MAX_DELETE_ENTRIES: usize = 10_000;
const MAX_DELETE_DEPTH: usize = 64;
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

/// Where a call comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin {
    /// An AI client on this computer (the local endpoint); approvals are
    /// asked in this app.
    Local,
    /// A remote AI client through wecommander.app (H3); this computer is
    /// the connector `center_id`. `approved`: the gateway holds the
    /// person's one-time approval of exactly this call, or the target's
    /// trust set in the web panel stands in for it (readonly still wins).
    Remote { center_id: String, approved: bool },
}

impl Origin {
    fn audit_name(&self) -> &'static str {
        match self {
            Origin::Local => "local-mcp",
            Origin::Remote { .. } => "remote-mcp",
        }
    }
}

/// A refused or failed call: a stable code and a sentence.
#[derive(Debug, PartialEq, Eq)]
pub struct Fail {
    pub code: String,
    pub message: String,
}

impl Fail {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
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

    pub(crate) fn value(&self) -> Value {
        json!({ "error": self.code, "message": self.message })
    }
}

/// Desktop Commander-style names accepted for the SSH tools.
pub fn canonical(name: &str) -> &str {
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

fn arg_bool(args: &Map<String, Value>, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
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

fn not_exposed(origin: &Origin) -> Fail {
    match origin {
        Origin::Local => Fail::new(
            "target_not_exposed",
            "this server is not visible to AI clients on this computer (WECOMMANDER → server → AI access)",
        ),
        Origin::Remote { .. } => Fail::new(
            "target_not_exposed",
            "this server is not shared with remote AI clients through this computer (WECOMMANDER → server → AI access)",
        ),
    }
}

/// The hosts the call's origin may use.
fn exposed(data: &crate::store::Data, origin: &Origin) -> Vec<(SavedHost, AiAccess)> {
    match origin {
        Origin::Local => local_targets(data),
        Origin::Remote { center_id, .. } => remote_targets(data, center_id),
    }
}

/// Resolves the call's target among the exposed hosts.
fn resolve(
    state: &AppState,
    origin: &Origin,
    args: &Map<String, Value>,
) -> Result<(SavedHost, AiAccess), Fail> {
    let wanted = arg_str(args, "target")
        .or_else(|| arg_str(args, "device_id"))
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let data = state.data.lock().map_err(|_| Fail::new("busy", "busy"))?;
    let mut exposed = exposed(&data, origin);
    let found = match wanted {
        Some(t) => exposed.into_iter().find(|(h, _)| h.id == t),
        None if exposed.len() == 1 && *origin == Origin::Local => exposed.pop(),
        None if exposed.is_empty() => None,
        None => {
            return Err(Fail::new(
                "target_required",
                "more than one server is available: pass target (see targets_list)",
            ))
        }
    };
    // Unknown and not-exposed hosts look the same to the AI.
    let (host, ai) = found.ok_or_else(|| not_exposed(origin))?;
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

/// Runs one local MCP tool call for `caller`: `(result, is_error)`.
pub async fn call(
    state: &Arc<AppState>,
    caller: &Caller,
    name: &str,
    args: &Map<String, Value>,
) -> (Value, bool) {
    call_from(state, caller, &Origin::Local, name, args).await
}

/// Runs one tool call from `origin`: `(result, is_error)`.
pub async fn call_from(
    state: &Arc<AppState>,
    caller: &Caller,
    origin: &Origin,
    name: &str,
    args: &Map<String, Value>,
) -> (Value, bool) {
    let name = canonical(name);
    if name == "targets_list" {
        return targets_list(state, caller, origin, args);
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
    let risk = if CHANGE_TOOLS.contains(&name) {
        "high"
    } else {
        "low"
    };
    let (target_id, label, result) = match resolve(state, origin, args) {
        Ok((host, ai)) => {
            let r = run(state, caller, origin, name, args, &host, &ai).await;
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
    record(
        state, caller, origin, name, &target_id, &label, risk, &outcome,
    );
    match result {
        Ok(v) => (v, false),
        Err(f) => (f.value(), true),
    }
}

/// Audit line and `mcp-activity` event.
#[allow(clippy::too_many_arguments)]
fn record(
    state: &AppState,
    caller: &Caller,
    origin: &Origin,
    tool: &str,
    target: &str,
    label: &str,
    risk: &str,
    outcome: &str,
) {
    state.mcp.audit(&AuditEntry {
        time: format_rfc3339(now_unix()),
        origin: origin.audit_name().into(),
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
            "origin": origin.audit_name(),
            "at": format_rfc3339(now_unix()),
        }),
    );
}

fn targets_list(
    state: &AppState,
    caller: &Caller,
    origin: &Origin,
    args: &Map<String, Value>,
) -> (Value, bool) {
    let now = now_unix();
    let result = (|| {
        let data = state.data.lock().map_err(|_| Fail::new("busy", "busy"))?;
        let mut list: Vec<_> = exposed(&data, origin)
            .iter()
            .map(|(h, a)| {
                let mut v = target_view(h, a, now);
                if let Origin::Remote { .. } = origin {
                    let preset = remote_preset(a, now);
                    v.preset = preset.to_owned();
                    v.capabilities = crate::targets::capabilities(preset);
                    v.timed_until = None;
                }
                v
            })
            .collect();
        if let Some(t) = arg_str(args, "target").filter(|t| !t.trim().is_empty()) {
            list.retain(|v| v.target_id == t.trim());
            if list.is_empty() {
                return Err(not_exposed(origin));
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
    record(
        state,
        caller,
        origin,
        "targets_list",
        "",
        "",
        "low",
        &outcome,
    );
    match result {
        Ok(v) => (v, false),
        Err(f) => (f.value(), true),
    }
}

/// Whether a call runs as root: `run_as` from the gateway (`"root"` or
/// `"user"`, absent means user). Root needs a remote origin and the host's
/// `sudo` setting `sudoers` on this computer; otherwise it is refused, never
/// run as the SSH user instead. Only `process_exec` and `fs_write` escalate.
pub fn check_run_as(
    origin: &Origin,
    ai: &AiAccess,
    tool: &str,
    args: &Map<String, Value>,
) -> Result<bool, Fail> {
    let root = match args.get("run_as") {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) if s == "user" => false,
        Some(Value::String(s)) if s == "root" => true,
        Some(_) => return Err(invalid("run_as must be user or root")),
    };
    if !root || !ROOT_TOOLS.contains(&tool) {
        return Ok(false);
    }
    if *origin == Origin::Local {
        return Err(Fail::new(
            "run_as_root_unavailable",
            "run as root is set per server in the WECOMMANDER web panel for remote AI clients only",
        ));
    }
    if ai.sudo != "sudoers" {
        return Err(Fail::new(
            "run_as_root_unavailable",
            "this computer does not allow sudo for AI on this server (WECOMMANDER → server → AI access → sudo), so nothing runs as root here",
        ));
    }
    Ok(true)
}

/// Tools that run as root when the gateway asks for it (and sudo is allowed).
pub const ROOT_TOOLS: [&str; 2] = ["process_exec", "fs_write"];

/// A command line as root: `sudo -n` (never asks for a password) runs it in
/// `sh -c`.
pub fn as_root(line: &str) -> String {
    format!("sudo -n -- sh -c {}", wc_server::quote(line))
}

/// `fs_write` as root: one `sh` under `sudo -n` checks the path (no link,
/// a regular file, `expected_sha256`, the folder) and writes standard input
/// over it in place (an existing file keeps its owner and mode). Exit codes
/// 90-96 are mapped by [`root_write_fail`].
const ROOT_WRITE: &str = r#"p=$1; e=$2; c=$3
if [ -L "$p" ]; then exit 90; fi
if [ -e "$p" ]; then
  [ -f "$p" ] || exit 91
  if [ -n "$e" ]; then s=$(sha256sum -- "$p" | cut -d' ' -f1); [ "$s" = "$e" ] || exit 93; fi
else
  [ -z "$e" ] || exit 93
  d=$(dirname -- "$p")
  if [ "$c" = 1 ]; then mkdir -p -- "$d" || exit 94; elif [ ! -d "$d" ]; then exit 95; fi
fi
cat > "$p" || exit 96
"#;

/// The command of a root `fs_write` (the content goes to standard input).
pub fn root_write_command(path: &str, expected: Option<&str>, create_parents: bool) -> String {
    format!(
        "sudo -n -- sh -c {} wc-write {} {} {}",
        wc_server::quote(ROOT_WRITE),
        wc_server::quote(path),
        wc_server::quote(expected.unwrap_or("")),
        if create_parents { "1" } else { "0" }
    )
}

/// The failure of a root `fs_write` from its exit status and error text.
pub fn root_write_fail(status: Option<u32>, stderr: &str) -> Option<Fail> {
    let text = stderr.trim();
    Some(match status {
        Some(0) => return None,
        Some(90) => Fail::new(
            "symlink_refused",
            "the path is a symbolic link; write to the file it points to instead (links are never followed)",
        ),
        Some(91) => Fail::new("fs_error", "the path is not a regular file"),
        Some(93) => stale(),
        Some(94) => Fail::new("fs_error", "the missing folders could not be created"),
        Some(95) => Fail::new(
            "fs_error",
            "the folder does not exist (pass create_parents to create it)",
        ),
        _ if text.starts_with("sudo:") => Fail::new(
            "sudo_failed",
            format!("sudo -n did not run on the server (the SSH user needs passwordless sudo): {text}"),
        ),
        _ => Fail::new(
            "fs_error",
            if text.is_empty() {
                "the file could not be written as root".to_owned()
            } else {
                text.chars().take(300).collect()
            },
        ),
    })
}

fn readonly_fail(what: &str) -> Fail {
    Fail::new(
        "readonly_preset",
        format!("this server is read-only for AI clients: {what} are off (the person can change this in WECOMMANDER)"),
    )
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
        return Err(readonly_fail("commands"));
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

/// A file change (`fs_write`, `fs_mkdir`, `fs_move`, `fs_delete`) checked
/// before connecting: what it is, in one exact line for the approval, and
/// the canonical arguments the approval is bound to.
#[derive(Debug, PartialEq)]
pub struct Change {
    pub tool: &'static str,
    /// The exact operation as the person sees it.
    pub describe: String,
    /// Canonical arguments (content as its SHA-256), the approval binding.
    pub bound: Value,
    /// Decoded bytes for `fs_write`.
    pub content: Vec<u8>,
}

fn check_path(raw: Option<&str>, what: &str) -> Result<String, Fail> {
    let p = raw.unwrap_or("").trim();
    if p.is_empty() || p.len() > 4096 || p.chars().any(|c| c.is_control()) {
        return Err(Fail::new(
            "invalid_path",
            format!("{what} is not a valid path"),
        ));
    }
    Ok(p.to_owned())
}

fn check_sha(raw: Option<&str>) -> Result<Option<String>, Fail> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) => {
            Ok(Some(s.to_ascii_lowercase()))
        }
        Some(_) => Err(Fail::new(
            "invalid_sha256",
            "expected_sha256 must be 64 hex characters",
        )),
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn size_text(n: usize) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KiB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MiB", n as f64 / (1024.0 * 1024.0))
    }
}

/// The checks before a file change connects: preset, arguments and limits.
/// Returns the change and whether it needs an approval (not in a timed
/// period; remote changes are decided by the gateway: approval or the target's trust).
pub fn check_change(
    ai: &AiAccess,
    tool: &str,
    args: &Map<String, Value>,
    now: i64,
) -> Result<(Change, bool), Fail> {
    let preset = effective_preset(ai, now);
    if preset == "readonly" {
        return Err(readonly_fail(if SERVER_CHANGE_TOOLS.contains(&tool) {
            "server changes"
        } else {
            "file changes"
        }));
    }
    let change = match tool {
        "fs_write" => {
            let path = check_path(arg_str(args, "path"), "path")?;
            let encoded = arg_str(args, "content_base64").unwrap_or("");
            if encoded.len() > MAX_WRITE.div_ceil(3) * 4 + 4 {
                return Err(Fail::new(
                    "file_too_large",
                    format!("at most {} can be written at once", size_text(MAX_WRITE)),
                ));
            }
            let content = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .map_err(|_| Fail::new("invalid_content", "content_base64 is not valid base64"))?;
            if content.len() > MAX_WRITE {
                return Err(Fail::new(
                    "file_too_large",
                    format!("at most {} can be written at once", size_text(MAX_WRITE)),
                ));
            }
            let sha = sha256_hex(&content);
            let expected = check_sha(arg_str(args, "expected_sha256"))?;
            let create_parents = arg_bool(args, "create_parents");
            Change {
                tool: "fs_write",
                describe: format!(
                    "write {} to {path} (sha256 {}){}",
                    size_text(content.len()),
                    &sha[..16],
                    if create_parents {
                        ", creating missing folders"
                    } else {
                        ""
                    }
                ),
                bound: json!({
                    "path": path, "size": content.len(), "sha256": sha,
                    "createParents": create_parents, "expectedSha256": expected,
                }),
                content,
            }
        }
        "fs_mkdir" => {
            let path = check_path(arg_str(args, "path"), "path")?;
            let recursive = arg_bool(args, "recursive");
            Change {
                tool: "fs_mkdir",
                describe: format!(
                    "create folder {path}{}",
                    if recursive {
                        " (and missing parents)"
                    } else {
                        ""
                    }
                ),
                bound: json!({ "path": path, "recursive": recursive }),
                content: Vec::new(),
            }
        }
        "fs_move" => {
            let source = check_path(arg_str(args, "source"), "source")?;
            let destination = check_path(arg_str(args, "destination"), "destination")?;
            Change {
                tool: "fs_move",
                describe: format!("move {source} → {destination}"),
                bound: json!({ "source": source, "destination": destination }),
                content: Vec::new(),
            }
        }
        "fs_delete" => {
            let path = check_path(arg_str(args, "path"), "path")?;
            let recursive = arg_bool(args, "recursive");
            let expected = check_sha(arg_str(args, "expected_sha256"))?;
            Change {
                tool: "fs_delete",
                describe: format!(
                    "delete {path}{}",
                    if recursive {
                        " (folder with everything in it)"
                    } else {
                        ""
                    }
                ),
                bound: json!({ "path": path, "recursive": recursive, "expectedSha256": expected }),
                content: Vec::new(),
            }
        }
        "server_cleanup_run" | "server_process_signal" | "docker_container_action" => {
            server_change(tool, args)?
        }
        other => return Err(Fail::new("unknown_tool", format!("unknown tool {other}"))),
    };
    Ok((change, preset != "timed"))
}

fn invalid(message: impl Into<String>) -> Fail {
    Fail::new("invalid_arguments", message)
}

/// A cleanup id from `server_cleanup_scan`: `apt-cache`, `docker-build@u1000`
/// (the gateway's `^[a-z-]{2,40}(@u[0-9]{1,10})?$`).
pub fn valid_cleanup_id(id: &str) -> bool {
    let (kind, daemon) = match id.split_once('@') {
        Some((k, d)) => (k, Some(d)),
        None => (id, None),
    };
    (2..=40).contains(&kind.len())
        && kind.chars().all(|c| c.is_ascii_lowercase() || c == '-')
        && daemon.is_none_or(|d| {
            d.strip_prefix('u').is_some_and(|n| {
                (1..=10).contains(&n.len()) && n.chars().all(|c| c.is_ascii_digit())
            })
        })
}

/// The checks of a server change (`server_cleanup_run`,
/// `server_process_signal`, `docker_container_action`), as the gateway's
/// agent schema checks them: the exact operation and its binding.
fn server_change(tool: &str, args: &Map<String, Value>) -> Result<Change, Fail> {
    let change = |tool: &'static str, describe: String, bound: Value| Change {
        tool,
        describe,
        bound,
        content: Vec::new(),
    };
    match tool {
        "server_cleanup_run" => {
            let list = args
                .get("ids")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("ids must be a list of ids from server_cleanup_scan"))?;
            if list.is_empty() || list.len() > 20 {
                return Err(invalid("ids must have 1-20 ids from server_cleanup_scan"));
            }
            let mut ids = Vec::new();
            for v in list {
                match v.as_str() {
                    Some(id) if valid_cleanup_id(id) => ids.push(id.to_owned()),
                    _ => return Err(invalid("ids must be ids from server_cleanup_scan")),
                }
            }
            Ok(change(
                "server_cleanup_run",
                format!("free disk space: {}", ids.join(", ")),
                json!({ "ids": ids }),
            ))
        }
        "server_process_signal" => {
            let pid = args
                .get("pid")
                .and_then(Value::as_u64)
                .filter(|p| (2..=4_194_304).contains(p))
                .ok_or_else(|| invalid("pid must be a process id (2-4194304)"))?;
            let name = arg_str(args, "name").unwrap_or("").to_owned();
            if name.is_empty() || name.len() > 64 || name.contains(['\n', '\0']) {
                return Err(invalid(
                    "name must be the process name from server_processes",
                ));
            }
            let action = arg_str(args, "action").unwrap_or("");
            let signal = match action {
                "reap" => "SIGCHLD (collect its zombies)",
                "term" => "SIGTERM (ask it to stop)",
                "kill" => "SIGKILL (stop it at once)",
                _ => return Err(invalid("action must be reap, term or kill")),
            };
            let confirm_database = arg_bool(args, "confirm_database");
            Ok(change(
                "server_process_signal",
                format!(
                    "send {signal} to process {pid} ({name}){}",
                    if confirm_database {
                        ", database confirmed"
                    } else {
                        ""
                    }
                ),
                json!({ "pid": pid, "name": name, "action": action, "confirmDatabase": confirm_database }),
            ))
        }
        _ => {
            let (daemon, container) = wc_server::container_target(
                arg_str(args, "container").unwrap_or(""),
                arg_str(args, "daemon"),
            )
            .map_err(invalid)?;
            let action = arg_str(args, "action").unwrap_or("");
            if !wc_server::CONTAINER_ACTIONS.contains(&action) {
                return Err(invalid("action must be start, stop or restart"));
            }
            let on = if daemon == "system" {
                "the system Docker".to_owned()
            } else {
                format!("the rootless Docker of {daemon}")
            };
            Ok(change(
                "docker_container_action",
                format!("{action} Docker container {container} on {on}"),
                json!({ "daemon": daemon, "container": container, "action": action }),
            ))
        }
    }
}

/// What the person is asked to approve.
struct Ask<'a> {
    tool: &'a str,
    binding: String,
    command: &'a str,
    cwd: Option<&'a str>,
    timeout_ms: Option<u64>,
}

/// Local: asks the person (event `mcp-approval`) and waits for the
/// one-time approval of exactly this call. Remote: the gateway already
/// holds the approval (`approved`), else the call is refused.
async fn approve(
    state: &AppState,
    caller: &Caller,
    origin: &Origin,
    host: &SavedHost,
    ask: Ask<'_>,
) -> Result<(), Fail> {
    if let Origin::Remote { approved, .. } = origin {
        return if *approved {
            Ok(())
        } else {
            Err(Fail::new(
                "approval_required",
                "this change needs the person's one-time approval in WECOMMANDER first",
            ))
        };
    }
    let (id, expires_at, new) = state.mcp.approvals.request(&ask.binding, now_unix());
    if new {
        let what = if ask.tool == "process_exec" {
            "run a command"
        } else if SERVER_CHANGE_TOOLS.contains(&ask.tool) {
            "change the server"
        } else {
            "change files"
        };
        state.emit(
            "mcp-approval",
            json!({
                "approvalId": id,
                "clientName": caller.name,
                "clientId": caller.id,
                "targetId": host.id,
                "targetLabel": host.profile.label,
                "tool": ask.tool,
                "summary": format!(
                    "{} wants to {what} on {}{}",
                    caller.name,
                    host.profile.label,
                    ask.cwd.map(|c| format!(" in {c}")).unwrap_or_default()
                ),
                "command": ask.command,
                "cwd": ask.cwd,
                "timeoutMs": ask.timeout_ms,
                "expiresAt": format_rfc3339(expires_at),
            }),
        );
    }
    state
        .mcp
        .approvals
        .wait(&id, &ask.binding)
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
    origin: &Origin,
    name: &str,
    args: &Map<String, Value>,
    host: &SavedHost,
    ai: &AiAccess,
) -> Result<Value, Fail> {
    let now = now_unix();
    let remote = matches!(origin, Origin::Remote { .. });
    if name == "process_exec" {
        let (command, cwd, timeout_ms, needs_approval) = check_exec(ai, args, now)?;
        // After the preset: a readonly server refuses before anything else.
        let root = check_run_as(origin, ai, name, args)?;
        if needs_approval || remote {
            let ask = Ask {
                tool: "process_exec",
                binding: binding(&caller.id, &host.id, &command, cwd.as_deref(), timeout_ms),
                command: &command,
                cwd: cwd.as_deref(),
                timeout_ms: Some(timeout_ms),
            };
            approve(state, caller, origin, host, ask).await?;
        }
        let (conn, _jump) = connect(state, host).await?;
        let line = match &cwd {
            Some(c) => format!("cd {} && {command}", wc_server::quote(c)),
            None => command.clone(),
        };
        let line = if root { as_root(&line) } else { line };
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
            "runAs": if root { "root" } else { "user" },
            "output": output,
            "timedOut": out.timed_out,
            "truncated": out.truncated,
            "redactions": redactions,
        }));
    }
    if SERVER_CHANGE_TOOLS.contains(&name) {
        let (change, needs_approval) = check_change(ai, name, args, now)?;
        if needs_approval || remote {
            let ask = Ask {
                tool: change.tool,
                binding: binding_call(change.tool, &caller.id, &host.id, &change.bound),
                command: &change.describe,
                cwd: None,
                timeout_ms: None,
            };
            approve(state, caller, origin, host, ask).await?;
        }
        let (conn, _jump) = connect(state, host).await?;
        return server_change_run(guarded(conn, ai), &change).await;
    }
    if CHANGE_TOOLS.contains(&name) {
        let (change, needs_approval) = check_change(ai, name, args, now)?;
        let root = check_run_as(origin, ai, name, args)?;
        if needs_approval || remote {
            let ask = Ask {
                tool: change.tool,
                binding: binding_call(change.tool, &caller.id, &host.id, &change.bound),
                command: &change.describe,
                cwd: None,
                timeout_ms: None,
            };
            approve(state, caller, origin, host, ask).await?;
        }
        let (conn, _jump) = connect(state, host).await?;
        let sftp = conn
            .sftp()
            .await
            .map_err(|e| Fail::new("sftp_failed", e.to_string()));
        let result = match sftp {
            Ok(sftp) if root => {
                let r = root_write(&conn, &sftp, &change).await;
                let _ = sftp.close().await;
                r
            }
            Ok(sftp) => {
                let r = sftp_change(&sftp, &change).await;
                let _ = sftp.close().await;
                r
            }
            Err(e) => Err(e),
        };
        let _ = conn.close().await;
        return result;
    }
    let read = check_server_read(name, args)?;
    let (conn, _jump) = connect(state, host).await?;
    match name {
        "fs_list" | "fs_read" | "fs_stat" => sftp_tool(&conn, name, args).await,
        "server_overview" | "server_disk_usage" | "server_processes" => {
            server_tool(conn, name, args).await
        }
        _ => server_read(guarded(conn, ai), name, read).await,
    }
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

/// The SHA-256 of a regular file (at most 4 MiB), for `expected_sha256`.
async fn file_sha(sftp: &Sftp, path: &str) -> Result<String, Fail> {
    match sftp
        .read_limited(path, HARD_READ_MAX)
        .await
        .map_err(sftp_fail)?
    {
        ReadLimit::Read(bytes) => Ok(sha256_hex(&bytes)),
        ReadLimit::TooLarge(_) => Err(Fail::new(
            "file_too_large",
            "the file is larger than 4 MiB; expected_sha256 cannot be checked",
        )),
    }
}

fn stale() -> Fail {
    Fail::new(
        "stale_content",
        "the file changed since it was read (expected_sha256 does not match); read it again",
    )
}

/// Creates `path` and its missing parents; an existing part must be a
/// folder (a link to one is accepted only for parents that already exist).
async fn mkdir_all(sftp: &Sftp, path: &str) -> Result<bool, Fail> {
    let mut missing = Vec::new();
    let mut at = path.trim_end_matches('/').to_owned();
    loop {
        if at.is_empty() || at == "/" {
            break;
        }
        match sftp.lstat(&at).await.map_err(sftp_fail)? {
            None => {
                missing.push(at.clone());
                at = wc_ssh_core::sftp::parent(&at);
            }
            Some(e) if e.kind == "dir" => break,
            Some(e) if e.kind == "link" => {
                // An existing link: it must lead to a folder.
                let target = sftp.stat(&at).await.map_err(sftp_fail)?;
                if target.kind != "dir" {
                    return Err(Fail::new("fs_error", format!("{at} is not a folder")));
                }
                break;
            }
            Some(_) => return Err(Fail::new("fs_error", format!("{at} is not a folder"))),
        }
        if missing.len() > MAX_DELETE_DEPTH {
            return Err(Fail::new("invalid_path", "path is too deep"));
        }
    }
    let created = !missing.is_empty();
    for dir in missing.iter().rev() {
        sftp.mkdir(dir).await.map_err(sftp_fail)?;
    }
    Ok(created)
}

/// Every entry under folder `dir` (links are entries, never followed),
/// deepest first; refuses more than [`MAX_DELETE_ENTRIES`].
async fn collect_tree(sftp: &Sftp, dir: &str) -> Result<Vec<(String, bool)>, Fail> {
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut stack = vec![(dir.to_owned(), 0usize)];
    let mut dirs: Vec<(String, usize)> = Vec::new();
    while let Some((d, depth)) = stack.pop() {
        if depth > MAX_DELETE_DEPTH {
            return Err(Fail::new(
                "too_many_entries",
                "the folder is nested too deeply to delete here",
            ));
        }
        for e in sftp.list(&d).await.map_err(sftp_fail)? {
            if e.kind == "dir" {
                stack.push((e.path.clone(), depth + 1));
                dirs.push((e.path, depth + 1));
            } else {
                out.push((e.path, false));
            }
            if out.len() + dirs.len() > MAX_DELETE_ENTRIES {
                return Err(Fail::new(
                    "too_many_entries",
                    format!("the folder has more than {MAX_DELETE_ENTRIES} entries; delete it with a command instead"),
                ));
            }
        }
    }
    // Files and links first, then folders from the deepest.
    dirs.sort_by_key(|d| std::cmp::Reverse(d.1));
    out.extend(dirs.into_iter().map(|(p, _)| (p, true)));
    Ok(out)
}

async fn sftp_change(sftp: &Sftp, change: &Change) -> Result<Value, Fail> {
    let b = &change.bound;
    let s = |k: &str| b[k].as_str().unwrap_or("").to_owned();
    match change.tool {
        "fs_write" => {
            let path = remote_path(sftp, &s("path")).await?;
            match sftp.lstat(&path).await.map_err(sftp_fail)? {
                Some(e) if e.kind == "link" => {
                    return Err(Fail::new(
                        "symlink_refused",
                        "the path is a symbolic link; write to the file it points to instead (links are never followed)",
                    ))
                }
                Some(e) if e.kind != "file" => {
                    return Err(Fail::new("fs_error", "the path is not a regular file"))
                }
                Some(_) => {
                    if let Some(expected) = b["expectedSha256"].as_str() {
                        if file_sha(sftp, &path).await? != expected {
                            return Err(stale());
                        }
                    }
                }
                None => {
                    if b["expectedSha256"].is_string() {
                        return Err(stale());
                    }
                    let dir = wc_ssh_core::sftp::parent(&path);
                    if b["createParents"].as_bool() == Some(true) {
                        mkdir_all(sftp, &dir).await?;
                    } else if sftp.lstat(&dir).await.map_err(sftp_fail)?.is_none() {
                        return Err(Fail::new(
                            "fs_error",
                            "the folder does not exist (pass create_parents to create it)",
                        ));
                    }
                }
            }
            sftp.write_bytes(&path, &change.content)
                .await
                .map_err(sftp_fail)?;
            Ok(json!({ "path": path, "size": change.content.len(), "sha256": s("sha256") }))
        }
        "fs_mkdir" => {
            let path = remote_path(sftp, &s("path")).await?;
            if b["recursive"].as_bool() == Some(true) {
                let created = mkdir_all(sftp, &path).await?;
                return Ok(json!({ "path": path, "created": created }));
            }
            match sftp.lstat(&path).await.map_err(sftp_fail)? {
                Some(e) if e.kind == "dir" => Ok(json!({ "path": path, "created": false })),
                Some(_) => Err(Fail::new(
                    "fs_error",
                    "something else already has this name",
                )),
                None => {
                    sftp.mkdir(&path).await.map_err(sftp_fail)?;
                    Ok(json!({ "path": path, "created": true }))
                }
            }
        }
        "fs_move" => {
            let source = remote_path(sftp, &s("source")).await?;
            let destination = remote_path(sftp, &s("destination")).await?;
            if sftp.lstat(&source).await.map_err(sftp_fail)?.is_none() {
                return Err(Fail::new("fs_error", "the source does not exist"));
            }
            if sftp.lstat(&destination).await.map_err(sftp_fail)?.is_some() {
                return Err(Fail::new(
                    "destination_exists",
                    "the destination already exists; nothing was moved",
                ));
            }
            sftp.rename(&source, &destination)
                .await
                .map_err(sftp_fail)?;
            Ok(json!({ "source": source, "destination": destination }))
        }
        _ => {
            let path = remote_path(sftp, &s("path")).await?;
            let home = sftp.home().await.map_err(sftp_fail)?;
            let norm = |p: &str| {
                let t = p.trim_end_matches('/');
                if t.is_empty() {
                    "/".to_owned()
                } else {
                    t.to_owned()
                }
            };
            if norm(&path) == "/" || norm(&path) == norm(&home) {
                return Err(Fail::new(
                    "protected_path",
                    "the root folder and the SSH user's home folder are never deleted",
                ));
            }
            let entry = sftp
                .lstat(&path)
                .await
                .map_err(sftp_fail)?
                .ok_or_else(|| Fail::new("fs_error", "nothing to delete at this path"))?;
            if let Some(expected) = b["expectedSha256"].as_str() {
                if entry.kind != "file" {
                    return Err(Fail::new(
                        "fs_error",
                        "expected_sha256 works only for a regular file",
                    ));
                }
                if file_sha(sftp, &path).await? != expected {
                    return Err(stale());
                }
            }
            if entry.kind != "dir" {
                sftp.remove_file(&path).await.map_err(sftp_fail)?;
                return Ok(json!({ "path": path, "deleted": 1 }));
            }
            let tree = collect_tree(sftp, &path).await?;
            if !tree.is_empty() && b["recursive"].as_bool() != Some(true) {
                return Err(Fail::new(
                    "folder_not_empty",
                    "the folder is not empty; pass recursive to delete it with everything in it",
                ));
            }
            for (p, is_dir) in &tree {
                if *is_dir {
                    sftp.remove_dir(p).await.map_err(sftp_fail)?;
                } else {
                    sftp.remove_file(p).await.map_err(sftp_fail)?;
                }
            }
            sftp.remove_dir(&path).await.map_err(sftp_fail)?;
            Ok(json!({ "path": path, "deleted": tree.len() + 1 }))
        }
    }
}

/// `fs_write` as root (see [`ROOT_WRITE`]); `~` is the SSH user's home.
async fn root_write(conn: &Connection, sftp: &Sftp, change: &Change) -> Result<Value, Fail> {
    let b = &change.bound;
    let path = remote_path(sftp, b["path"].as_str().unwrap_or("")).await?;
    let command = root_write_command(
        &path,
        b["expectedSha256"].as_str(),
        b["createParents"].as_bool() == Some(true),
    );
    let out = conn
        .exec_input(&command, &change.content, 4096)
        .await
        .map_err(|e| Fail::new("exec_failed", e.to_string()))?;
    if let Some(fail) = root_write_fail(out.exit_status, &String::from_utf8_lossy(&out.stderr)) {
        return Err(fail);
    }
    Ok(json!({
        "path": path,
        "size": change.content.len(),
        "sha256": b["sha256"].as_str().unwrap_or(""),
        "runAs": "root",
    }))
}

/// A `PRELUDE` without sudo: privileged steps run only when the SSH user is
/// root. Used when the person did not allow sudoers for AI clients.
pub const NO_SUDO_PRELUDE: &str = r#"export LC_ALL=C
R=; if [ "$(id -u)" = 0 ]; then R=root; fi
r() { "$@"; }
"#;

/// Runs `wc-server` scripts over SSH; with `sudo: never` the scripts never
/// raise privileges with sudo (a root login stays root).
pub(crate) struct Guarded {
    ssh: crate::server::Ssh,
    sudo: bool,
}

fn guarded(conn: Connection, ai: &AiAccess) -> Guarded {
    Guarded {
        ssh: crate::server::Ssh(Arc::new(conn)),
        sudo: ai.sudo == "sudoers",
    }
}

/// The script as it runs with sudoers allowed (`sudo`) or not.
pub fn guard_script(script: &str, sudo: bool) -> String {
    if sudo {
        script.to_owned()
    } else {
        script.replacen(wc_server::PRELUDE, NO_SUDO_PRELUDE, 1)
    }
}

impl wc_server::Shell for Guarded {
    async fn run_script(&self, script: &str, secs: u64) -> Result<String, String> {
        wc_server::Shell::run_script(&self.ssh, &guard_script(script, self.sudo), secs).await
    }
}

/// Docker calls as quoted argument vectors over SSH. Without sudoers the
/// discovery never reports `sudo`, so no call starts with it; one that does
/// anyway is refused.
impl wc_server::Exec for Guarded {
    async fn exec(&self, argv: &[String], secs: u64) -> Result<wc_server::ExecOutput, String> {
        if !self.sudo && argv.first().is_some_and(|p| p == "sudo") {
            return Err(wc_server::NEEDS_ROOT.into());
        }
        wc_server::Exec::exec(&self.ssh, argv, secs).await
    }
}

/// Arguments of a read-only server tool, checked before connecting.
#[derive(Debug, PartialEq)]
pub enum ServerRead {
    None,
    Daemon(Option<String>),
    Logs {
        daemon: String,
        container: String,
        tail: usize,
        since: Option<String>,
    },
}

pub fn check_server_read(name: &str, args: &Map<String, Value>) -> Result<ServerRead, Fail> {
    match name {
        "docker_containers_list" => {
            match arg_str(args, "daemon")
                .map(str::trim)
                .filter(|d| !d.is_empty())
            {
                None => Ok(ServerRead::Daemon(None)),
                Some(d) if wc_server::valid_daemon_id(d) => {
                    Ok(ServerRead::Daemon(Some(d.to_owned())))
                }
                Some(_) => Err(invalid("daemon must be system or u<uid>")),
            }
        }
        "docker_container_logs" => {
            let (daemon, container) = wc_server::container_target(
                arg_str(args, "container").unwrap_or(""),
                arg_str(args, "daemon"),
            )
            .map_err(invalid)?;
            let tail = match args.get("tail") {
                None | Some(Value::Null) => wc_server::DEFAULT_LOG_LINES,
                Some(v) => v
                    .as_u64()
                    .filter(|n| (1..=wc_server::MAX_LOG_LINES as u64).contains(n))
                    .map(|n| n as usize)
                    .ok_or_else(|| invalid("tail must be 1-2000"))?,
            };
            let since = match args.get("since") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if wc_server::valid_since(s) => Some(s.clone()),
                Some(_) => {
                    return Err(invalid(
                        "since must be a duration like 10m, a Unix time or an RFC 3339 time",
                    ))
                }
            };
            Ok(ServerRead::Logs {
                daemon,
                container,
                tail,
                since,
            })
        }
        _ => Ok(ServerRead::None),
    }
}

fn server_fail(e: String) -> Fail {
    Fail::new("server_error", e)
}

fn to_json<T: serde::Serialize>(v: T) -> Result<Value, Fail> {
    serde_json::to_value(v).map_err(|e| server_fail(e.to_string()))
}

/// `server_cleanup_scan`, `server_timers_list`, `docker_containers_list`,
/// `docker_container_logs`.
async fn server_read(sh: Guarded, name: &str, read: ServerRead) -> Result<Value, Fail> {
    match (name, read) {
        ("server_cleanup_scan", _) => {
            to_json(wc_server::cleanup_scan(&sh).await.map_err(server_fail)?)
        }
        ("server_timers_list", _) => {
            let mut v = to_json(wc_server::timers(&sh).await.map_err(server_fail)?)?;
            redact::redact_value(&mut v);
            Ok(v)
        }
        ("docker_containers_list", ServerRead::Daemon(only)) => to_json(
            wc_server::docker_containers(&sh, only.as_deref())
                .await
                .map_err(server_fail)?,
        ),
        (
            "docker_container_logs",
            ServerRead::Logs {
                daemon,
                container,
                tail,
                since,
            },
        ) => {
            let logs = wc_server::container_logs(
                &sh,
                &container,
                Some(&daemon),
                Some(tail),
                since.as_deref(),
            )
            .await
            .map_err(server_fail)?;
            let (text, redactions) = redact::redact_text(&logs.text);
            let mut v = to_json(&logs)?;
            v["text"] = json!(text);
            v["redactions"] = json!(redactions);
            Ok(v)
        }
        (other, _) => Err(Fail::new("unknown_tool", format!("unknown tool {other}"))),
    }
}

/// Runs a checked, approved server change.
async fn server_change_run(sh: Guarded, change: &Change) -> Result<Value, Fail> {
    let b = &change.bound;
    let s = |k: &str| b[k].as_str().unwrap_or("").to_owned();
    match change.tool {
        "server_cleanup_run" => {
            let ids = b["ids"]
                .as_array()
                .map(|l| {
                    l.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let results = wc_server::cleanup_run(&sh, ids)
                .await
                .map_err(server_fail)?;
            Ok(json!({ "results": results }))
        }
        "server_process_signal" => {
            let pid = b["pid"].as_u64().unwrap_or(0) as u32;
            match wc_server::process_signal(
                &sh,
                pid,
                s("name"),
                s("action"),
                b["confirmDatabase"].as_bool() == Some(true),
            )
            .await
            {
                Ok(_) => Ok(json!({ "ok": true, "pid": pid, "action": s("action") })),
                Err(e) if e == "database" => Err(Fail::new(
                    "confirm_database_required",
                    "this process is a database: pass confirm_database to stop it",
                )),
                Err(e) => Err(server_fail(e)),
            }
        }
        _ => to_json(
            wc_server::container_action(&sh, &s("container"), Some(&s("daemon")), &s("action"))
                .await
                .map_err(server_fail)?,
        ),
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
            let name = t["name"].as_str().unwrap();
            let change = CHANGE_TOOLS.contains(&name);
            assert_eq!(t["annotations"]["readOnlyHint"], json!(!change), "{name}");
            let destructive = change && name != "fs_mkdir";
            assert_eq!(
                t["annotations"]["destructiveHint"],
                json!(destructive),
                "{name}"
            );
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
    fn changes_check_preset_limits_and_bind_the_content() {
        let now = 1_800_000_000;
        let mut ai = AiAccess {
            local: true,
            preset: "readonly".into(),
            ..Default::default()
        };
        let w = args(json!({"path": "/srv/a.txt", "content_base64": "aGVsbG8="}));
        for tool in ["fs_write", "fs_mkdir", "fs_move", "fs_delete"] {
            assert_eq!(
                check_change(&ai, tool, &w, now).unwrap_err().code,
                "readonly_preset",
                "{tool}"
            );
        }
        ai.preset = "approval".into();
        let (change, approval) = check_change(&ai, "fs_write", &w, now).unwrap();
        assert!(approval);
        assert_eq!(change.content, b"hello");
        assert_eq!(change.bound["sha256"], sha256_hex(b"hello"));
        assert!(change.describe.contains("/srv/a.txt") && change.describe.contains("5 B"));
        // Another content gives another binding.
        let w2 = args(json!({"path": "/srv/a.txt", "content_base64": "aGVsbG8h"}));
        let (change2, _) = check_change(&ai, "fs_write", &w2, now).unwrap();
        assert_ne!(
            binding_call("fs_write", "c", "t", &change.bound),
            binding_call("fs_write", "c", "t", &change2.bound)
        );
        // Size limit and bad input.
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_WRITE + 1]);
        assert_eq!(
            check_change(
                &ai,
                "fs_write",
                &args(json!({"path": "/x", "content_base64": big})),
                now
            )
            .unwrap_err()
            .code,
            "file_too_large"
        );
        assert_eq!(
            check_change(
                &ai,
                "fs_write",
                &args(json!({"path": "/x", "content_base64": "!!"})),
                now
            )
            .unwrap_err()
            .code,
            "invalid_content"
        );
        assert_eq!(
            check_change(&ai, "fs_delete", &args(json!({"path": " "})), now)
                .unwrap_err()
                .code,
            "invalid_path"
        );
        assert_eq!(
            check_change(
                &ai,
                "fs_delete",
                &args(json!({"path": "/x", "expected_sha256": "abc"})),
                now
            )
            .unwrap_err()
            .code,
            "invalid_sha256"
        );
        let (mv, _) = check_change(
            &ai,
            "fs_move",
            &args(json!({"source": "/a", "destination": "/b"})),
            now,
        )
        .unwrap();
        assert_eq!(mv.describe, "move /a → /b");
        // Timed: no approval while it lasts (locally).
        ai.preset = "timed".into();
        ai.timed_until = Some(format_rfc3339(now + 60));
        assert!(
            !check_change(&ai, "fs_mkdir", &args(json!({"path": "/x"})), now)
                .unwrap()
                .1
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

    #[test]
    fn server_tools_are_ssh_tools_and_their_changes_need_approval() {
        for name in [
            "server_cleanup_scan",
            "server_cleanup_run",
            "server_process_signal",
            "server_timers_list",
            "docker_containers_list",
            "docker_container_logs",
            "docker_container_action",
        ] {
            assert!(SSH_TOOLS.contains(&name), "{name}");
            assert!(!NOT_ON_SSH.contains(&name), "{name}");
        }
        for name in SERVER_CHANGE_TOOLS {
            assert!(CHANGE_TOOLS.contains(&name), "{name}");
        }
        for name in [
            "server_cleanup_scan",
            "server_timers_list",
            "docker_containers_list",
            "docker_container_logs",
        ] {
            assert!(!CHANGE_TOOLS.contains(&name), "{name}");
        }
    }

    #[test]
    fn server_changes_check_preset_and_arguments() {
        let now = 1_800_000_000;
        let mut ai = AiAccess {
            local: true,
            preset: "readonly".into(),
            ..Default::default()
        };
        let cleanup = args(json!({"ids": ["apt-cache", "docker-build@u1000"]}));
        let signal = args(json!({"pid": 42, "name": "nginx", "action": "term"}));
        let docker = args(json!({"container": "web@u1000", "action": "restart"}));
        for (tool, a) in [
            ("server_cleanup_run", &cleanup),
            ("server_process_signal", &signal),
            ("docker_container_action", &docker),
        ] {
            let fail = check_change(&ai, tool, a, now).unwrap_err();
            assert_eq!(fail.code, "readonly_preset", "{tool}");
            assert!(fail.message.contains("server changes"), "{tool}");
        }
        ai.preset = "approval".into();
        let (c, approval) = check_change(&ai, "server_cleanup_run", &cleanup, now).unwrap();
        assert!(approval);
        assert_eq!(c.bound, json!({"ids": ["apt-cache", "docker-build@u1000"]}));
        assert_eq!(c.describe, "free disk space: apt-cache, docker-build@u1000");
        let (s, _) = check_change(&ai, "server_process_signal", &signal, now).unwrap();
        assert_eq!(
            s.bound,
            json!({"pid": 42, "name": "nginx", "action": "term", "confirmDatabase": false})
        );
        assert!(s.describe.contains("SIGTERM") && s.describe.contains("42"));
        let (d, _) = check_change(&ai, "docker_container_action", &docker, now).unwrap();
        assert_eq!(
            d.bound,
            json!({"daemon": "u1000", "container": "web", "action": "restart"})
        );
        // Another action is another approval.
        let (d2, _) = check_change(
            &ai,
            "docker_container_action",
            &args(json!({"container": "web", "daemon": "u1000", "action": "stop"})),
            now,
        )
        .unwrap();
        assert_ne!(
            binding_call(d.tool, "c", "t", &d.bound),
            binding_call(d2.tool, "c", "t", &d2.bound)
        );
        for (tool, bad) in [
            ("server_cleanup_run", json!({"ids": []})),
            ("server_cleanup_run", json!({"ids": "apt-cache"})),
            (
                "server_cleanup_run",
                json!({"ids": ["apt-cache; rm -rf /"]}),
            ),
            ("server_cleanup_run", json!({"ids": ["docker-build@root"]})),
            ("server_cleanup_run", json!({"ids": vec!["journal"; 21]})),
            (
                "server_process_signal",
                json!({"pid": 1, "name": "init", "action": "kill"}),
            ),
            (
                "server_process_signal",
                json!({"pid": 5_000_000, "name": "x", "action": "kill"}),
            ),
            (
                "server_process_signal",
                json!({"pid": 42, "name": "", "action": "kill"}),
            ),
            (
                "server_process_signal",
                json!({"pid": 42, "name": "x", "action": "stop"}),
            ),
            (
                "server_process_signal",
                json!({"pid": "42", "name": "x", "action": "kill"}),
            ),
            (
                "docker_container_action",
                json!({"container": "web", "action": "rm"}),
            ),
            (
                "docker_container_action",
                json!({"container": "web; id", "action": "stop"}),
            ),
            (
                "docker_container_action",
                json!({"container": "web@u1000", "daemon": "system", "action": "stop"}),
            ),
            (
                "docker_container_action",
                json!({"container": "web", "daemon": "u0", "action": "stop"}),
            ),
        ] {
            assert_eq!(
                check_change(&ai, tool, &args(bad.clone()), now)
                    .unwrap_err()
                    .code,
                "invalid_arguments",
                "{tool} {bad}"
            );
        }
    }

    #[test]
    fn docker_reads_are_checked_before_connecting() {
        assert_eq!(
            check_server_read("docker_container_logs", &args(json!({"container": "web"}))).unwrap(),
            ServerRead::Logs {
                daemon: "system".into(),
                container: "web".into(),
                tail: 200,
                since: None,
            }
        );
        assert_eq!(
            check_server_read(
                "docker_container_logs",
                &args(json!({"container": "0123456789ab@u1000", "tail": 2000, "since": "1h30m"}))
            )
            .unwrap(),
            ServerRead::Logs {
                daemon: "u1000".into(),
                container: "0123456789ab".into(),
                tail: 2000,
                since: Some("1h30m".into()),
            }
        );
        for bad in [
            json!({"container": "web", "tail": 0}),
            json!({"container": "web", "tail": 2001}),
            json!({"container": "web", "since": "1h; id"}),
            json!({"container": "web", "since": 10}),
            json!({"container": "web", "tail": "x"}),
            json!({"container": "$(id)"}),
            json!({}),
        ] {
            assert_eq!(
                check_server_read("docker_container_logs", &args(bad.clone()))
                    .unwrap_err()
                    .code,
                "invalid_arguments",
                "{bad}"
            );
        }
        assert_eq!(
            check_server_read("docker_containers_list", &args(json!({"daemon": "u1000"}))).unwrap(),
            ServerRead::Daemon(Some("u1000".into()))
        );
        assert!(
            check_server_read("docker_containers_list", &args(json!({"daemon": "x;id"}))).is_err()
        );
    }

    #[test]
    fn sudo_never_keeps_the_scripts_from_using_sudo() {
        let script = format!("{}echo @@priv; echo \"$R\"\n", wc_server::PRELUDE);
        assert_eq!(guard_script(&script, true), script);
        let guarded = guard_script(&script, false);
        assert!(!guarded.contains("sudo"), "{guarded}");
        assert!(guarded.starts_with(NO_SUDO_PRELUDE));
        assert!(valid_cleanup_id("docker-unused@u1000") && valid_cleanup_id("journal"));
        assert!(!valid_cleanup_id("journal@x") && !valid_cleanup_id("a"));
    }

    #[test]
    fn run_as_root_needs_remote_and_the_hosts_sudo_setting() {
        let remote = Origin::Remote {
            center_id: "c".into(),
            approved: true,
        };
        let mut ai = AiAccess {
            remote: true,
            ..Default::default()
        };
        let root = args(json!({"command": "id", "run_as": "root"}));
        // sudo: never on this computer → refused, never run as the user.
        assert_eq!(
            check_run_as(&remote, &ai, "process_exec", &root)
                .unwrap_err()
                .code,
            "run_as_root_unavailable"
        );
        ai.sudo = "sudoers".into();
        assert!(check_run_as(&remote, &ai, "process_exec", &root).unwrap());
        assert!(check_run_as(&remote, &ai, "fs_write", &root).unwrap());
        // Only commands and file writes escalate; other tools stay the SSH user.
        for tool in ["fs_mkdir", "fs_delete", "fs_move", "server_cleanup_run"] {
            assert!(!check_run_as(&remote, &ai, tool, &root).unwrap(), "{tool}");
        }
        // Local AI clients cannot ask for root.
        assert_eq!(
            check_run_as(&Origin::Local, &ai, "process_exec", &root)
                .unwrap_err()
                .code,
            "run_as_root_unavailable"
        );
        for (v, ok) in [
            (json!({}), Some(false)),
            (json!({"run_as": "user"}), Some(false)),
            (json!({"run_as": null}), Some(false)),
            (json!({"run_as": "admin"}), None),
            (json!({"run_as": true}), None),
        ] {
            let r = check_run_as(&remote, &ai, "process_exec", &args(v.clone()));
            match ok {
                Some(want) => assert_eq!(r.unwrap(), want, "{v}"),
                None => assert_eq!(r.unwrap_err().code, "invalid_arguments", "{v}"),
            }
        }
    }

    #[test]
    fn root_command_lines_quote_everything() {
        assert_eq!(
            as_root("cd '/srv' && echo 'a' > /etc/x"),
            r#"sudo -n -- sh -c 'cd '\''/srv'\'' && echo '\''a'\'' > /etc/x'"#
        );
        let cmd = root_write_command("/etc/it's", None, true);
        assert!(cmd.starts_with("sudo -n -- sh -c '"), "{cmd}");
        assert!(cmd.ends_with(r#" wc-write '/etc/it'\''s' '' 1"#), "{cmd}");
        assert!(root_write_command("/a", Some("ab"), false).ends_with(" '/a' 'ab' 0"));
        assert_eq!(root_write_fail(Some(0), ""), None);
        for (code, want) in [
            (90, "symlink_refused"),
            (91, "fs_error"),
            (93, "stale_content"),
            (95, "fs_error"),
        ] {
            assert_eq!(root_write_fail(Some(code), "").unwrap().code, want);
        }
        assert_eq!(
            root_write_fail(Some(1), "sudo: a password is required\n")
                .unwrap()
                .code,
            "sudo_failed"
        );
        assert_eq!(root_write_fail(None, "").unwrap().code, "fs_error");
    }

    /// The root write script itself, run with the local `sh` (without sudo):
    /// links refused, stale content refused, owner and mode kept, folders.
    #[cfg(unix)]
    #[test]
    fn root_write_script_checks_before_writing() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("wc-root-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |path: &std::path::Path, expected: &str, parents: &str, input: &[u8]| {
            let mut child = Command::new("sh")
                .arg("-c")
                .arg(ROOT_WRITE)
                .arg("wc-write")
                .arg(path)
                .arg(expected)
                .arg(parents)
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            // A refusal (stale hash, symlink) exits before reading stdin: the write
            // can then fail with a broken pipe, which is not what is under test.
            if let Err(e) = child.stdin.take().unwrap().write_all(input) {
                assert_eq!(e.kind(), std::io::ErrorKind::BrokenPipe, "{e}");
            }
            child.wait().unwrap().code()
        };
        let file = dir.join("f.conf");
        std::fs::write(&file, b"old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        // Stale: expected hash does not match → nothing written.
        assert_eq!(run(&file, &"0".repeat(64), "0", b"new"), Some(93));
        assert_eq!(std::fs::read(&file).unwrap(), b"old");
        // Matching hash → written in place, mode kept.
        assert_eq!(run(&file, &sha256_hex(b"old"), "0", b"new"), Some(0));
        assert_eq!(std::fs::read(&file).unwrap(), b"new");
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o640
        );
        // A link is never followed.
        let link = dir.join("l");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert_eq!(run(&link, "", "0", b"x"), Some(90));
        assert_eq!(std::fs::read(&file).unwrap(), b"new");
        // A folder is not a file; a missing folder needs create_parents.
        assert_eq!(run(&dir, "", "0", b"x"), Some(91));
        let deep = dir.join("a/b/c.txt");
        assert_eq!(run(&deep, "", "0", b"x"), Some(95));
        assert_eq!(run(&deep, "", "1", b"x"), Some(0));
        assert_eq!(std::fs::read(&deep).unwrap(), b"x");
        // A new file with expected_sha256 is stale (it was expected to exist).
        assert_eq!(run(&dir.join("new"), &sha256_hex(b""), "0", b"x"), Some(93));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
