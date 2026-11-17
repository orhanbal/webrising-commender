//! MCP (JSON-RPC 2.0, one message per line) on one endpoint connection.
//!
//! `initialize` answers at once and records the client (`clientInfo`
//! name, version kept as information); an unknown client raises `mcp-client-request` and its
//! `tools/call` requests wait up to 2 minutes for `mcp.allowClient`.
//! `tools/list` is static and needs no decision. Requests run concurrently;
//! when the connection closes (or the client cancels one), its running
//! calls stop, so nothing runs after the AI client gave up.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use super::tools::{self, Caller};
use super::CLIENT_WAIT;
use crate::AppState;

pub const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// Longest accepted message line.
pub const MAX_LINE: usize = 4 * 1024 * 1024;

pub const INSTRUCTIONS: &str = "WECOMMANDER local access to servers the person chose (targets_list). Commands and file reads go from this computer straight to the server over SSH. SSH targets have no folder boundary: a command can reach everything the SSH user can. Commands need a one-time approval in the WECOMMANDER app unless the server is in a timed autonomous period; read-only servers refuse commands. Output is masked for passwords, keys and tokens.";

/// One line (without the newline), at most `max` bytes; `None` at the end.
pub(crate) async fn read_line<R: AsyncBufRead + Unpin>(
    r: &mut R,
    max: usize,
) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    loop {
        let available = r.fill_buf().await?;
        if available.is_empty() {
            return Ok((!buf.is_empty()).then(|| String::from_utf8_lossy(&buf).into_owned()));
        }
        if let Some(i) = available.iter().position(|b| *b == b'\n') {
            buf.extend_from_slice(&available[..i]);
            r.consume(i + 1);
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
        let n = available.len();
        buf.extend_from_slice(available);
        r.consume(n);
        if buf.len() > max {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "message too long",
            ));
        }
    }
}

pub fn response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A `tools/call` result.
pub fn tool_result(data: Value, is_error: bool) -> Value {
    // Errors read `code: sentence`, like the core's own errors.
    let text = match (data["error"].as_str(), data["message"].as_str()) {
        (Some(code), Some(message)) if is_error => format!("{code}: {message}"),
        _ => serde_json::to_string(&data).unwrap_or_default(),
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": data,
        "isError": is_error,
    })
}

/// The `initialize` result (also given by the bridge when the app is closed).
pub fn initialize_result(params: &Value, version: &str) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("");
    let protocol = PROTOCOL_VERSIONS
        .iter()
        .find(|v| **v == requested)
        .unwrap_or(&PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "WECOMMANDER", "title": "WECOMMANDER", "version": version },
        "instructions": INSTRUCTIONS,
    })
}

fn clean(text: Option<&str>, fallback: &str, max: usize) -> String {
    let t: String = text
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned();
    if t.is_empty() {
        fallback.to_owned()
    } else {
        t
    }
}

type Running = Arc<Mutex<HashMap<String, AbortHandle>>>;

/// Serves one connection until it closes.
pub async fn serve<R, W>(state: Arc<AppState>, reader: R, mut writer: W)
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let writing = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
    });
    let caller: Arc<Mutex<Option<Caller>>> = Arc::new(Mutex::new(None));
    let running: Running = Arc::default();
    let mut reader = BufReader::new(reader);
    while let Ok(Some(line)) = read_line(&mut reader, MAX_LINE).await {
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                let _ = tx.send(error(&Value::Null, -32700, "parse error"));
                continue;
            }
        };
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = request.get("id").cloned() else {
            // Notifications: only cancellation matters here.
            if method == "notifications/cancelled" {
                if let Some(rid) = params.get("requestId") {
                    if let Some(h) = running
                        .lock()
                        .ok()
                        .and_then(|mut r| r.remove(&rid.to_string()))
                    {
                        h.abort();
                    }
                }
            }
            continue;
        };
        match method.as_str() {
            "initialize" => {
                let info = params.get("clientInfo").cloned().unwrap_or(Value::Null);
                let name = clean(
                    info.get("name").and_then(Value::as_str),
                    "unknown client",
                    100,
                );
                let version = clean(info.get("version").and_then(Value::as_str), "", 50);
                match state.mcp.hello(&name, &version) {
                    Ok(record) => {
                        if !record.decided {
                            state.emit(
                                "mcp-client-request",
                                json!({ "id": record.id, "name": record.name, "version": record.version }),
                            );
                        }
                        if let Ok(mut c) = caller.lock() {
                            *c = Some(Caller {
                                id: record.id,
                                name,
                                version,
                            });
                        }
                        let _ = tx.send(response(
                            &id,
                            initialize_result(&params, env!("CARGO_PKG_VERSION")),
                        ));
                    }
                    Err(e) => {
                        let _ = tx.send(error(&id, -32603, &e));
                    }
                }
            }
            "ping" => {
                let _ = tx.send(response(&id, json!({})));
            }
            "tools/list" => {
                let _ = tx.send(response(&id, json!({ "tools": tools::tool_list() })));
            }
            "tools/call" => {
                let Some(who) = caller.lock().ok().and_then(|c| c.clone()) else {
                    let _ = tx.send(error(&id, -32002, "initialize first"));
                    continue;
                };
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let args: Map<String, Value> = params
                    .get("arguments")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let (state, tx2, running2) = (state.clone(), tx.clone(), running.clone());
                let key = id.to_string();
                let task = tokio::spawn(async move {
                    let (data, is_error) = match allowed(&state, &who).await {
                        Ok(()) => tools::call(&state, &who, &name, &args).await,
                        Err(e) => (e, true),
                    };
                    let _ = tx2.send(response(&id, tool_result(data, is_error)));
                    if let Ok(mut r) = running2.lock() {
                        r.remove(&id.to_string());
                    }
                });
                if let Ok(mut r) = running.lock() {
                    if !task.is_finished() {
                        r.insert(key, task.abort_handle());
                    }
                }
            }
            _ => {
                let _ = tx.send(error(&id, -32601, "method not found"));
            }
        }
    }
    // The client is gone: stop its calls (an approval it waits for stays
    // usable for the same call later, once).
    if let Ok(mut r) = running.lock() {
        for (_, h) in r.drain() {
            h.abort();
        }
    }
    drop(tx);
    let _ = writing.await;
}

/// Waits for the person's decision on an unknown client.
async fn allowed(state: &AppState, who: &Caller) -> Result<(), Value> {
    if let Some(c) = state.mcp.client(&who.id) {
        if c.decided {
            return state
                .mcp
                .wait_allowed(&who.id, CLIENT_WAIT)
                .await
                .map_err(|e| coded(&e));
        }
        state.emit(
            "mcp-client-request",
            json!({ "id": c.id, "name": c.name, "version": c.version }),
        );
    }
    let result = state.mcp.wait_allowed(&who.id, CLIENT_WAIT).await;
    result.map_err(|e| {
        let v = coded(&e);
        state.mcp.audit(&super::AuditEntry {
            time: crate::time::format_rfc3339(crate::time::now_unix()),
            origin: "local-mcp".into(),
            client: who.name.clone(),
            client_version: who.version.clone(),
            tool: "tools/call".into(),
            target: String::new(),
            target_label: String::new(),
            risk: "low".into(),
            outcome: v["error"].as_str().unwrap_or("client_not_allowed").into(),
        });
        v
    })
}

fn coded(text: &str) -> Value {
    match text.split_once(": ") {
        Some((code, message)) => json!({ "error": code, "message": message }),
        None => json!({ "error": "error", "message": text }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::AiAccess;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, DuplexStream};

    #[derive(Default)]
    struct Events(Mutex<Vec<(String, Value)>>);
    impl crate::EventSink for Events {
        fn emit(&self, name: &str, payload: Value) {
            self.0.lock().unwrap().push((name.to_owned(), payload));
        }
    }

    struct Client {
        write: tokio::io::WriteHalf<DuplexStream>,
        read: tokio::io::Lines<BufReader<tokio::io::ReadHalf<DuplexStream>>>,
        next: u64,
    }

    impl Client {
        async fn send(&mut self, method: &str, params: Value) -> u64 {
            self.next += 1;
            let line =
                json!({"jsonrpc": "2.0", "id": self.next, "method": method, "params": params});
            self.write
                .write_all(format!("{line}\n").as_bytes())
                .await
                .unwrap();
            self.next
        }
        async fn reply(&mut self) -> Value {
            let line = tokio::time::timeout(Duration::from_secs(10), self.read.next_line())
                .await
                .expect("reply in time")
                .unwrap()
                .unwrap();
            serde_json::from_str(&line).unwrap()
        }
        async fn call(&mut self, method: &str, params: Value) -> Value {
            self.send(method, params).await;
            self.reply().await
        }
    }

    fn start(state: Arc<AppState>) -> Client {
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (r, w) = tokio::io::split(theirs);
        tokio::spawn(serve(state, r, w));
        let (r, w) = tokio::io::split(ours);
        Client {
            write: w,
            read: BufReader::new(r).lines(),
            next: 0,
        }
    }

    async fn wait_event(events: &Events, name: &str) -> Value {
        for _ in 0..200 {
            if let Some((_, v)) = events.0.lock().unwrap().iter().find(|(n, _)| n == name) {
                return v.clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no {name} event");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn policy_refusals_before_any_connection() {
        let dir = std::env::temp_dir().join(format!("wc-mcp-session-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let events = Arc::new(Events::default());
        let state = crate::open(&dir, "app.wecommander.test.mcp", events.clone());
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
            "Hidden".into(),
            "203.0.113.10".into(),
            22,
            "deploy".into(),
            "password".into(),
            None,
        )
        .unwrap();
        let hidden = hosts[1].id.clone();
        {
            let mut d = state.data.lock().unwrap();
            d.known_hosts
                .insert("203.0.113.9:22".into(), "SHA256:x".into());
        }
        state
            .vault
            .put(&crate::store::secret_key(&web, "password"), "pw")
            .unwrap();
        crate::targets::set_ai_access(
            &state,
            web.clone(),
            AiAccess {
                local: true,
                preset: "readonly".into(),
                ..Default::default()
            },
        )
        .unwrap();

        let mut c = start(state.clone());
        // Before initialize: refused.
        let r = c.call("tools/call", json!({"name": "targets_list"})).await;
        assert_eq!(r["error"]["code"], -32002);
        let init = c.call("initialize", json!({"protocolVersion": "2025-03-26", "clientInfo": {"name": "Cursor", "version": "1.2"}})).await;
        assert_eq!(init["result"]["serverInfo"]["name"], "WECOMMANDER");
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        let request = wait_event(&events, "mcp-client-request").await;
        assert_eq!(request["name"], "Cursor");
        let client = request["id"].as_str().unwrap().to_owned();
        // The tool list needs no decision.
        let list = c.call("tools/list", json!({})).await;
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 12);
        // A call waits for the person; allowing releases it.
        let pending = c
            .send(
                "tools/call",
                json!({"name": "targets_list", "arguments": {}}),
            )
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        state.mcp.allow(&client, true).unwrap();
        let r = c.reply().await;
        assert_eq!(r["id"], pending);
        let targets = &r["result"]["structuredContent"]["targets"];
        assert_eq!(targets.as_array().unwrap().len(), 1);
        assert_eq!(targets[0]["target_id"], json!(web));
        assert_eq!(targets[0]["capabilities"]["exec"], false);
        assert_eq!(targets[0]["capabilities"]["path_policy"], "none");
        assert!(
            !r.to_string().contains("203.0.113.9"),
            "no address for the AI"
        );

        let tool = |name: &str, args: Value| json!({"name": name, "arguments": args});
        let code = |r: &Value| {
            r["result"]["structuredContent"]["error"]
                .as_str()
                .unwrap_or("")
                .to_owned()
        };
        // Readonly preset.
        let r = c
            .call(
                "tools/call",
                tool("process_exec", json!({"target": web, "command": "uptime"})),
            )
            .await;
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(code(&r), "readonly_preset");
        // Sudo guard (approval preset, sudo never).
        crate::targets::set_ai_access(
            &state,
            web.clone(),
            AiAccess {
                local: true,
                ..Default::default()
            },
        )
        .unwrap();
        let r = c
            .call(
                "tools/call",
                tool(
                    "process_exec",
                    json!({"target": web, "command": "sudo reboot"}),
                ),
            )
            .await;
        assert_eq!(code(&r), "sudo_not_allowed");
        // Not exposed (exists, but AI access off) and unknown look the same.
        for t in [hidden.as_str(), "no-such-host"] {
            let r = c
                .call(
                    "tools/call",
                    tool("fs_list", json!({"target": t, "path": "/"})),
                )
                .await;
            assert_eq!(code(&r), "target_not_exposed");
        }
        // Unsupported tool on SSH.
        let r = c
            .call("tools/call", tool("terminal_start", json!({"target": web})))
            .await;
        assert_eq!(code(&r), "unsupported_for_target");
        // Host key forgotten after AI access was turned on: never TOFU.
        state.data.lock().unwrap().known_hosts.clear();
        let r = c
            .call(
                "tools/call",
                tool("fs_read", json!({"target": web, "path": "/etc/hostname"})),
            )
            .await;
        assert_eq!(code(&r), "host_key_untrusted");
        // Approval: denied in the app → refused, and the event shows the exact command.
        state
            .data
            .lock()
            .unwrap()
            .known_hosts
            .insert("203.0.113.9:22".into(), "SHA256:x".into());
        let id = c
            .send(
                "tools/call",
                tool(
                    "process_exec",
                    json!({"target": web, "command": "systemctl restart web", "cwd": "/srv"}),
                ),
            )
            .await;
        let ask = wait_event(&events, "mcp-approval").await;
        assert_eq!(ask["command"], "systemctl restart web");
        assert_eq!(ask["targetLabel"], "Web");
        assert_eq!(ask["clientName"], "Cursor");
        crate::mcp::decide(&state, ask["approvalId"].as_str().unwrap(), false).unwrap();
        let r = c.reply().await;
        assert_eq!(r["id"], id);
        assert_eq!(code(&r), "approval_denied");
        // Activity events and the audit file (no command text in it).
        assert!(events
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|(n, v)| n == "mcp-activity" && v["outcome"] == "approval_denied"));
        let audit = std::fs::read_to_string(dir.join(crate::mcp::AUDIT_FILE)).unwrap();
        assert!(audit.contains("readonly_preset") && audit.contains("sudo_not_allowed"));
        assert!(!audit.contains("systemctl") && !audit.contains("reboot"));

        // A denied client is refused at once.
        state.mcp.allow(&client, false).unwrap();
        let r = c.call("tools/call", tool("targets_list", json!({}))).await;
        assert_eq!(code(&r), "client_denied");
        let _ = std::fs::remove_dir_all(dir);
    }
}
