//! Local mode (v1.1 item 4): the agent serves MCP over stdio for a local AI
//! client (Claude Desktop, Cursor, …) with no gateway and no account.
//!
//! The same safety rules as remote mode apply on this machine: tools only
//! touch the `--allowed-root` folders, file writes and commands are off unless
//! the person starting the agent passes `--allow-writes` / `--allow-commands`,
//! writes keep undo snapshots, and every call is appended to a local audit
//! log (tool, risk, outcome, never file contents). High-risk operations get a
//! single-use approval for exactly that call, signed with a per-process key:
//! the consent is the flag the person passed, since there is no browser to
//! approve in.
//!
//! Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio
//! transport). Logs go to stderr only. The tool list is generated from the
//! gateway (`local_tools.json`); argument names are the gateway's snake_case
//! names, converted to the agent's camelCase action fields.
use crate::{
    config::DeviceCapabilities,
    ops::{self, ExecutionContext},
    policy::PathPolicy,
    protocol::{AgentAction, Risk, UndoScope},
    task_manager::TaskManager,
    terminal::TerminalManager,
};
use anyhow::{anyhow, Context, Result};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};

const TOOLS: &str = include_str!("local_tools.json");
// Fixed identity for this machine in local mode (terminal history and undo
// are kept per device id, which must be a UUID).
const DEVICE_ID: &str = "00000000-0000-4000-8000-00000000000a";
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// Desktop Commander-compatible names, translated here to native tools the
/// same way the gateway does (gateway/src/dc-compat.ts). url_fetch is
/// gateway-only. Keep in sync with LOCAL_ALIASES in gateway/src/local-tools.ts.
const ALIASES: &[&str] = &[
    "read_file",
    "read_multiple_files",
    "write_file",
    "list_directory",
    "create_directory",
    "move_file",
    "get_file_info",
    "edit_block",
];

pub struct LocalOptions {
    pub allowed_roots: Vec<PathBuf>,
    pub allow_writes: bool,
    pub allow_commands: bool,
    pub audit_log: Option<PathBuf>,
    pub redact_output: bool,
}

fn snake_to_camel(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut upper = false;
    for ch in key.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// MCP tool arguments -> agent action. Mirrors gateway/src/local-tools.ts
/// `genericAction`; local-tools.test.ts proves it equals the gateway mapping.
pub fn action_from_call(name: &str, args: &Map<String, Value>) -> Result<AgentAction> {
    let mut action = Map::new();
    action.insert("kind".into(), Value::String(name.into()));
    for (key, value) in args {
        if key == "device_id" || key == "approval_token" {
            continue;
        }
        action.insert(snake_to_camel(key), value.clone());
    }
    serde_json::from_value(Value::Object(action))
        .map_err(|error| anyhow!("invalid arguments for {name}: {error}"))
}

fn tool_list() -> Result<Value> {
    serde_json::from_str(TOOLS).context("embedded tool list is invalid")
}

struct Local {
    policy: PathPolicy,
    terminals: TerminalManager,
    tasks: TaskManager,
    approval_key: String,
    capabilities: DeviceCapabilities,
    undo_scope: UndoScope,
    tool_names: Vec<String>,
    audit: Option<std::fs::File>,
}

impl Local {
    fn audit(&mut self, tool: &str, risk: &str, outcome: &str) {
        let Some(file) = self.audit.as_mut() else {
            return;
        };
        let line = json!({
            "time": chrono_like_now(),
            "tool": tool,
            "risk": risk,
            "outcome": outcome,
        });
        let _ = writeln!(file, "{line}");
    }

    async fn call(&mut self, name: &str, args: &Map<String, Value>) -> (Value, bool) {
        if ALIASES.contains(&name) {
            return self.alias_call(name, args).await;
        }
        if !self.tool_names.iter().any(|tool| tool == name) {
            return (json!({ "error": "unknown_tool", "tool": name }), true);
        }
        self.native(name, args).await
    }

    async fn native(&mut self, name: &str, args: &Map<String, Value>) -> (Value, bool) {
        let action = match action_from_call(name, args) {
            Ok(action) => action,
            Err(error) => {
                self.audit(name, "unknown", "invalid_arguments");
                return (json!({ "error": error.to_string() }), true);
            }
        };
        self.run(name, action).await
    }

    async fn alias_call(&mut self, name: &str, args: &Map<String, Value>) -> (Value, bool) {
        if name == "edit_block" {
            return self.edit_block(args).await;
        }
        match translate_alias(name, args) {
            Some((target, native_args)) => self.native(target, &native_args).await,
            None => (json!({ "error": "unknown_tool", "tool": name }), true),
        }
    }

    /// Exact match first, then a unique whitespace-tolerant match; the write
    /// is guarded by the file's SHA-256 and keeps an undo snapshot.
    async fn edit_block(&mut self, args: &Map<String, Value>) -> (Value, bool) {
        let text = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let path = text("file_path");
        let expected = args
            .get("expected_replacements")
            .map(|v| v.as_i64().unwrap_or(-1))
            .unwrap_or(1);
        let (read, failed) = self.native("fs_read", &obj(json!({ "path": path }))).await;
        if failed {
            return (read, true);
        }
        let Some(content) = read
            .get("content")
            .and_then(Value::as_str)
            .filter(|_| read.get("encoding").and_then(Value::as_str) == Some("utf8"))
        else {
            return (json!({ "error": "not_a_text_file" }), true);
        };
        let (updated, replacements, mode) =
            match plan_edit(content, &text("old_string"), &text("new_string"), expected) {
                Ok(plan) => plan,
                Err(plan) => {
                    self.audit("edit_block", "medium", "error");
                    return (plan, true);
                }
            };
        let sha = format!("{:x}", Sha256::digest(content.as_bytes()));
        let write = obj(json!({
            "path": path,
            "content_base64": STANDARD.encode(updated.as_bytes()),
            "create_parents": false,
            "expected_sha256": sha,
            "with_undo": true,
        }));
        let (written, failed) = self.native("fs_write", &write).await;
        if failed {
            return (written, true);
        }
        self.audit("edit_block", "medium", "success");
        (
            json!({ "ok": true, "replacements": replacements, "match": mode, "undo": "fs_versions/fs_undo can restore the previous content" }),
            false,
        )
    }

    async fn run(&mut self, name: &str, action: AgentAction) -> (Value, bool) {
        let risk = action.risk();
        let risk_name = match risk {
            Risk::Low => "low",
            Risk::Medium => "medium",
            Risk::High => "high",
        };
        let token = if risk == Risk::High {
            match crate::approval::sign(&self.approval_key, DEVICE_ID, &action, 60) {
                Ok(token) => Some(token),
                Err(error) => return (json!({ "error": error.to_string() }), true),
            }
        } else {
            None
        };
        let result = ops::execute(
            ExecutionContext {
                policy: &self.policy,
                terminals: &self.terminals,
                tasks: &self.tasks,
                approval_token: token.as_deref(),
                approval_key: &self.approval_key,
                device_id: DEVICE_ID,
                undo_scope: Some(&self.undo_scope),
                cancelled: Arc::new(AtomicBool::new(false)),
                paused: Arc::new(AtomicBool::new(false)),
                search_progress: None,
                capabilities: self.capabilities,
            },
            action,
        )
        .await;
        match result {
            Ok(value) => {
                self.audit(name, risk_name, "success");
                (value, false)
            }
            Err(error) => {
                let message = error.to_string();
                let outcome = if message.starts_with("device_policy_denied")
                    || message.contains("outside configured allowed roots")
                {
                    "denied"
                } else {
                    "error"
                };
                self.audit(name, risk_name, outcome);
                (json!({ "error": message }), true)
            }
        }
    }
}

fn obj(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Desktop Commander call -> native tool name and gateway-style arguments.
/// Mirrors translateAlias in gateway/src/dc-compat.ts.
fn translate_alias(
    name: &str,
    a: &Map<String, Value>,
) -> Option<(&'static str, Map<String, Value>)> {
    let get = |key: &str| a.get(key).cloned().unwrap_or(Value::Null);
    let path = get("path");
    let mut out = Map::new();
    let target = match name {
        "read_file" => {
            out.insert("path".into(), path.clone());
            let is_pdf = path
                .as_str()
                .is_some_and(|p| p.to_ascii_lowercase().ends_with(".pdf"));
            if is_pdf {
                if let Some(offset) = a.get("offset").and_then(Value::as_i64) {
                    let page = if offset < 0 { offset } else { offset + 1 };
                    out.insert("start_page".into(), json!(page));
                }
                if let Some(length) = a.get("length") {
                    out.insert("page_count".into(), length.clone());
                }
                "pdf_read"
            } else if a.contains_key("offset") || a.contains_key("length") {
                if let Some(offset) = a.get("offset") {
                    out.insert("offset_lines".into(), offset.clone());
                }
                if let Some(length) = a.get("length") {
                    out.insert("limit_lines".into(), length.clone());
                }
                "fs_read_lines"
            } else {
                "fs_read"
            }
        }
        "read_multiple_files" => {
            out.insert("paths".into(), get("paths"));
            out.insert("max_bytes".into(), json!(64 * 1024));
            "fs_read_multiple"
        }
        "write_file" => {
            out.insert("path".into(), path);
            let content = a.get("content").and_then(Value::as_str).unwrap_or("");
            out.insert(
                "content_base64".into(),
                json!(STANDARD.encode(content.as_bytes())),
            );
            if a.get("mode").and_then(Value::as_str) == Some("append") {
                "fs_append"
            } else {
                out.insert("create_parents".into(), json!(true));
                "fs_write"
            }
        }
        "list_directory" => {
            out.insert("path".into(), path);
            "fs_list"
        }
        "create_directory" => {
            out.insert("path".into(), path);
            out.insert("recursive".into(), json!(true));
            "fs_mkdir"
        }
        "move_file" => {
            out.insert("source".into(), get("source"));
            out.insert("destination".into(), get("destination"));
            "fs_move"
        }
        "get_file_info" => {
            out.insert("path".into(), path);
            "fs_stat"
        }
        _ => return None,
    };
    Some((target, out))
}

enum Token<'a> {
    Literal(&'a str),
    Spaces,
    Newlines(usize),
}

/// old_string split into literals and whitespace runs: a run of spaces/tabs
/// matches any such run, a run with line breaks matches the same number of
/// line breaks (\n or \r\n) with any surrounding spaces/tabs. Mirrors
/// whitespaceTolerant in gateway/src/dc-compat.ts.
fn tokens(old: &str) -> Vec<Token<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_space = false;
    let space_token = |seg: &str| match seg.matches('\n').count() {
        0 => Token::Spaces,
        lines => Token::Newlines(lines),
    };
    let text = old.trim();
    for (i, ch) in text.char_indices() {
        let space = matches!(ch, ' ' | '\t' | '\r' | '\n');
        if i > start && space != in_space {
            if in_space {
                out.push(space_token(&text[start..i]));
            } else {
                out.push(Token::Literal(&text[start..i]));
            }
            start = i;
        }
        in_space = space;
    }
    if start < text.len() {
        if in_space {
            out.push(space_token(&text[start..]));
        } else {
            out.push(Token::Literal(&text[start..]));
        }
    }
    out
}

fn match_at(content: &[u8], mut i: usize, tokens: &[Token<'_>]) -> Option<usize> {
    let blank = |c: u8| c == b' ' || c == b'\t';
    for token in tokens {
        match token {
            Token::Literal(lit) => {
                if !content[i..].starts_with(lit.as_bytes()) {
                    return None;
                }
                i += lit.len();
            }
            Token::Spaces => {
                let begin = i;
                while i < content.len() && blank(content[i]) {
                    i += 1;
                }
                if i == begin {
                    return None;
                }
            }
            Token::Newlines(count) => {
                for _ in 0..*count {
                    while i < content.len() && blank(content[i]) {
                        i += 1;
                    }
                    if content.get(i) == Some(&b'\r') {
                        i += 1;
                    }
                    if content.get(i) != Some(&b'\n') {
                        return None;
                    }
                    i += 1;
                }
                while i < content.len() && blank(content[i]) {
                    i += 1;
                }
            }
        }
    }
    Some(i)
}

fn trigrams(s: &str) -> std::collections::HashSet<Vec<char>> {
    let chars: Vec<char> = s.chars().collect();
    chars.windows(3).map(<[char]>::to_vec).collect()
}

/// Mirrors planEdit in gateway/src/dc-compat.ts: Ok((content, replacements,
/// mode)) or Err(the error object returned to the caller).
fn plan_edit(
    content: &str,
    old: &str,
    new: &str,
    expected: i64,
) -> Result<(String, usize, &'static str), Value> {
    if old.is_empty() {
        return Err(json!({ "ok": false, "error": "old_string_empty" }));
    }
    if !(1..=1000).contains(&expected) {
        return Err(json!({ "ok": false, "error": "invalid_expected_replacements" }));
    }
    let expected = expected as usize;
    let exact = content.matches(old).count();
    if exact > 0 {
        if exact != expected {
            return Err(json!({ "ok": false, "error": "match_count_mismatch", "matches": exact }));
        }
        return Ok((content.replace(old, new), exact, "exact"));
    }
    if !old.trim().is_empty() {
        let toks = tokens(old);
        let bytes = content.as_bytes();
        let mut found = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if content.is_char_boundary(i) {
                if let Some(end) = match_at(bytes, i, &toks) {
                    found.push((i, end));
                    i = end.max(i + 1);
                    continue;
                }
            }
            i += 1;
        }
        if found.len() == expected {
            let mut out = String::with_capacity(content.len());
            let mut last = 0;
            for (start, end) in &found {
                out.push_str(&content[last..*start]);
                out.push_str(new.trim());
                last = *end;
            }
            out.push_str(&content[last..]);
            return Ok((out, found.len(), "whitespace"));
        }
        if !found.is_empty() {
            return Err(
                json!({ "ok": false, "error": "match_count_mismatch", "matches": found.len() }),
            );
        }
    }
    let first = old.trim().lines().next().unwrap_or("").trim();
    let target = trigrams(first);
    let mut best: Option<(usize, f64)> = None;
    for (index, line) in content.split('\n').enumerate() {
        let grams = trigrams(line.trim());
        if grams.is_empty() || target.is_empty() {
            continue;
        }
        let shared = grams.intersection(&target).count();
        let score = (2 * shared) as f64 / (grams.len() + target.len()) as f64;
        if best.is_none_or(|(_, b)| score > b) {
            best = Some((index, score));
        }
    }
    match best {
        Some((index, score)) if score >= 0.5 => {
            let line: String = content
                .split('\n')
                .nth(index)
                .unwrap_or("")
                .trim_end_matches('\r')
                .chars()
                .take(300)
                .collect();
            Err(
                json!({ "ok": false, "error": "no_match", "closest_line": index + 1, "closest_text": line }),
            )
        }
        _ => Err(json!({ "ok": false, "error": "no_match" })),
    }
}

fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

fn response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn handle(local: &mut Local, request: Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    // Notifications (no id) never get a response.
    let id = id?;
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("");
            let version = PROTOCOL_VERSIONS
                .iter()
                .find(|v| **v == requested)
                .unwrap_or(&PROTOCOL_VERSIONS[0]);
            response(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "wecommander-local", "version": crate::VERSION },
                    "instructions": format!(
                        "WECOMMANDER local mode on this computer. File tools only work inside: {}. File writes are {}; commands are {}.",
                        local.policy.roots().iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "),
                        if local.capabilities.file_writes { "on" } else { "off (start with --allow-writes)" },
                        if local.capabilities.commands { "on" } else { "off (start with --allow-commands)" },
                    ),
                }),
            )
        }
        "ping" => response(&id, json!({})),
        "tools/list" => match tool_list() {
            Ok(tools) => response(&id, json!({ "tools": tools })),
            Err(e) => error(&id, -32603, &e.to_string()),
        },
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let args = params
                .get("arguments")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let (data, is_error) = local.call(&name, &args).await;
            response(
                &id,
                json!({
                    "content": [{ "type": "text", "text": serde_json::to_string(&data).unwrap_or_default() }],
                    "structuredContent": data,
                    "isError": is_error,
                }),
            )
        }
        _ => error(&id, -32601, "method not found"),
    })
}

pub async fn serve(options: LocalOptions) -> Result<()> {
    if options.allowed_roots.is_empty() {
        return Err(anyhow!("local mode needs at least one --allowed-root"));
    }
    let policy = PathPolicy::new(&options.allowed_roots)?;
    let mut key = [0_u8; 32];
    for chunk in key.chunks_mut(16) {
        chunk.copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    let audit = match &options.audit_log {
        Some(path) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            Some(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .with_context(|| format!("cannot open audit log {}", path.display()))?,
            )
        }
        None => None,
    };
    let tool_names = tool_list()?
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let mut local = Local {
        policy,
        terminals: TerminalManager::for_device(DEVICE_ID)?,
        tasks: TaskManager::default(),
        approval_key: URL_SAFE_NO_PAD.encode(key),
        capabilities: DeviceCapabilities {
            commands: options.allow_commands,
            file_writes: options.allow_writes,
            redact_output: options.redact_output,
            system_logs: true,
        },
        undo_scope: UndoScope {
            organization_id: "local".into(),
            actor: "local".into(),
        },
        tool_names,
        audit,
    };
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = std::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(line) {
            Ok(request) => handle(&mut local, request).await,
            Err(_) => Some(error(&Value::Null, -32700, "parse error")),
        };
        if let Some(reply) = reply {
            writeln!(stdout, "{reply}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_gateway_argument_names() {
        let args = serde_json::from_value::<Map<String, Value>>(json!({ "path": "/tmp/a", "offset_lines": 2, "limit_lines": 3, "device_id": "ignored" })).unwrap();
        let action = action_from_call("fs_read_lines", &args).unwrap();
        assert_eq!(
            serde_json::to_value(&action).unwrap(),
            json!({ "kind": "fs_read_lines", "path": "/tmp/a", "offsetLines": 2, "limitLines": 3 })
        );
        assert!(action_from_call("fs_read_lines", &Map::new()).is_err());
    }

    #[test]
    fn plans_edits_like_the_gateway() {
        let (out, n, mode) = plan_edit("a = 1\nb = 2\n", "b = 2", "b = 3", 1).unwrap();
        assert_eq!((out.as_str(), n, mode), ("a = 1\nb = 3\n", 1, "exact"));
        let (out, _, mode) = plan_edit(
            "fn x() {\n    let a  =  1;\r\n}\n",
            "let a = 1;\n}",
            "let a = 2;\n}",
            1,
        )
        .unwrap();
        assert_eq!(mode, "whitespace");
        assert_eq!(out, "fn x() {\n    let a = 2;\n}\n");
        let err = plan_edit("x\nx\n", "x", "y", 1).unwrap_err();
        assert_eq!(err["error"], "match_count_mismatch");
        assert_eq!(err["matches"], 2);
        let err = plan_edit("let total = 1;\n", "let totl = 1;", "", 1).unwrap_err();
        assert_eq!(err["error"], "no_match");
        assert_eq!(err["closest_line"], 1);
        assert_eq!(
            plan_edit("x", "", "y", 1).unwrap_err()["error"],
            "old_string_empty"
        );
        assert_eq!(
            plan_edit("x", "x", "y", 0).unwrap_err()["error"],
            "invalid_expected_replacements"
        );
    }

    #[test]
    fn translates_desktop_commander_names() {
        let args = |v: Value| obj(v);
        let (t, a) = translate_alias("list_directory", &args(json!({"path":"/r"}))).unwrap();
        assert_eq!((t, Value::Object(a)), ("fs_list", json!({"path":"/r"})));
        let (t, a) = translate_alias(
            "read_file",
            &args(json!({"path":"/r/a.txt","offset":2,"length":3})),
        )
        .unwrap();
        assert_eq!(
            (t, Value::Object(a)),
            (
                "fs_read_lines",
                json!({"path":"/r/a.txt","offset_lines":2,"limit_lines":3})
            )
        );
        let (t, a) = translate_alias(
            "read_file",
            &args(json!({"path":"/r/a.PDF","offset":0,"length":2})),
        )
        .unwrap();
        assert_eq!(
            (t, Value::Object(a)),
            (
                "pdf_read",
                json!({"path":"/r/a.PDF","start_page":1,"page_count":2})
            )
        );
        let (t, a) = translate_alias(
            "write_file",
            &args(json!({"path":"/r/b","content":"hi","mode":"append"})),
        )
        .unwrap();
        assert_eq!(
            (t, Value::Object(a)),
            ("fs_append", json!({"path":"/r/b","content_base64":"aGk="}))
        );
        let (t, _) =
            translate_alias("write_file", &args(json!({"path":"/r/b","content":"hi"}))).unwrap();
        assert_eq!(t, "fs_write");
        for name in ALIASES.iter().filter(|n| **n != "edit_block") {
            assert!(translate_alias(name, &Map::new()).is_some(), "{name}");
        }
        assert!(translate_alias("url_fetch", &Map::new()).is_none());
    }

    #[test]
    fn embedded_tool_list_lists_every_alias() {
        let tools = tool_list().unwrap();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        for alias in ALIASES {
            assert!(names.contains(alias), "{alias}");
        }
    }

    #[test]
    fn embedded_tool_list_has_device_tools_without_gateway_fields() {
        let tools = tool_list().unwrap();
        let tools = tools.as_array().unwrap();
        assert!(tools.len() > 30);
        for tool in tools {
            let props = &tool["inputSchema"]["properties"];
            assert!(props.get("device_id").is_none(), "{}", tool["name"]);
            assert!(props.get("approval_token").is_none(), "{}", tool["name"]);
        }
    }

    #[tokio::test]
    async fn serves_mcp_over_the_local_policy() {
        let root = std::env::temp_dir().join(format!("wc-local-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        let mut local = Local {
            policy: PathPolicy::new(std::slice::from_ref(&root)).unwrap(),
            terminals: TerminalManager::for_device(DEVICE_ID).unwrap(),
            tasks: TaskManager::default(),
            approval_key: URL_SAFE_NO_PAD.encode([9_u8; 32]),
            capabilities: DeviceCapabilities {
                commands: false,
                file_writes: false,
                redact_output: true,
                system_logs: true,
            },
            undo_scope: UndoScope {
                organization_id: "local".into(),
                actor: "local".into(),
            },
            tool_names: tool_list()
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_owned())
                .collect(),
            audit: None,
        };
        let init = handle(&mut local, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})).await.unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert!(handle(
            &mut local,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .await
        .is_none());
        let read = handle(&mut local, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fs_read","arguments":{"path": root.join("a.txt")}}})).await.unwrap();
        assert_eq!(read["result"]["isError"], false);
        assert_eq!(read["result"]["structuredContent"]["content"], "hello");
        let outside = handle(&mut local, json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fs_read","arguments":{"path":"/etc/hostname"}}})).await.unwrap();
        assert_eq!(outside["result"]["isError"], true);
        let write = handle(&mut local, json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"fs_write","arguments":{"path": root.join("b.txt"),"content_base64":"aGk="}}})).await.unwrap();
        assert!(write["result"]["structuredContent"]["error"]
            .as_str()
            .unwrap()
            .contains("device_policy_denied"));
        let exec = handle(&mut local, json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"process_exec","arguments":{"command":"id"}}})).await.unwrap();
        assert!(exec["result"]["structuredContent"]["error"]
            .as_str()
            .unwrap()
            .contains("device_policy_denied"));
        local.capabilities = DeviceCapabilities {
            commands: true,
            file_writes: true,
            redact_output: true,
            system_logs: true,
        };
        let write = handle(&mut local, json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"fs_write","arguments":{"path": root.join("b.txt"),"content_base64":"aGk="}}})).await.unwrap();
        assert_eq!(write["result"]["isError"], false, "{write}");
        assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "hi");
        #[cfg(unix)]
        {
            let exec = handle(&mut local, json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"process_exec","arguments":{"command":"echo local-ok","cwd": root}}})).await.unwrap();
            assert_eq!(exec["result"]["isError"], false, "{exec}");
            assert!(exec["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("local-ok"));
        }
        let listed = handle(&mut local, json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"list_directory","arguments":{"path": root}}})).await.unwrap();
        assert_eq!(listed["result"]["isError"], false, "{listed}");
        assert!(listed["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("a.txt"));
        let edit = handle(&mut local, json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"edit_block","arguments":{"file_path": root.join("a.txt"),"old_string":"hello","new_string":"hello world"}}})).await.unwrap();
        assert_eq!(edit["result"]["isError"], false, "{edit}");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "hello world"
        );
        let read = handle(&mut local, json!({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"read_file","arguments":{"path": root.join("a.txt")}}})).await.unwrap();
        assert_eq!(
            read["result"]["structuredContent"]["content"],
            "hello world"
        );
        let many = handle(&mut local, json!({"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"read_multiple_files","arguments":{"paths": [root.join("a.txt"), root.join("b.txt")]}}})).await.unwrap();
        assert_eq!(many["result"]["isError"], false, "{many}");
        let unknown = handle(&mut local, json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"devices_list","arguments":{}}})).await.unwrap();
        assert_eq!(unknown["result"]["isError"], true);
        std::fs::remove_dir_all(&root).ok();
    }
}
