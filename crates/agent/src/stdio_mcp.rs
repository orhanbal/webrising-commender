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
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Map, Value};
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

pub struct LocalOptions {
    pub allowed_roots: Vec<PathBuf>,
    pub allow_writes: bool,
    pub allow_commands: bool,
    pub audit_log: Option<PathBuf>,
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
        if !self.tool_names.iter().any(|tool| tool == name) {
            return (json!({ "error": "unknown_tool", "tool": name }), true);
        }
        let action = match action_from_call(name, args) {
            Ok(action) => action,
            Err(error) => {
                self.audit(name, "unknown", "invalid_arguments");
                return (json!({ "error": error.to_string() }), true);
            }
        };
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
        let unknown = handle(&mut local, json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"devices_list","arguments":{}}})).await.unwrap();
        assert_eq!(unknown["result"]["isError"], true);
        std::fs::remove_dir_all(&root).ok();
    }
}
