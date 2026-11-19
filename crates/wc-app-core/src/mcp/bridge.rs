//! `wecommander-core --mcp-stdio`: what AI clients start. It moves MCP lines
//! between stdio and the running app's local endpoint and nothing else: it
//! opens no host list, no keyring and no SSH connection.
//!
//! When the app is not running, `initialize`, `ping` and `tools/list` are
//! answered here and every `tools/call` returns `wecommander_not_running`.
//! Each later `tools/call` tries the endpoint again (replaying the client's
//! `initialize`), so opening the app is enough; no client restart needed.
//! If the app closes during calls, they are answered with the same error.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::endpoint::{self, Writer};
use super::session::{error, initialize_result, read_line, response, tool_result, MAX_LINE};

/// The error text when the app is not running (Turkish, then English).
pub const NOT_RUNNING: &str = "WECOMMANDER'ı aç; yerel yapay zekâ erişimi uygulama açıkken çalışır. (Open WECOMMANDER: local AI access works while the app is open.)";
pub const NOT_RUNNING_CODE: &str = "wecommander_not_running";
const INIT_ID: &str = "wecommander-bridge-init";

fn not_running() -> Value {
    json!({ "error": NOT_RUNNING_CODE, "message": NOT_RUNNING })
}

/// The answer given here while the app is not reachable.
pub fn offline_reply(message: &Value) -> Option<Value> {
    let id = message.get("id")?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => response(id, initialize_result(&params, env!("CARGO_PKG_VERSION"))),
        "ping" => response(id, json!({})),
        "tools/list" => response(id, json!({ "tools": super::tools::tool_list() })),
        "tools/call" => response(id, tool_result(not_running(), true)),
        _ => error(id, -32601, "method not found"),
    })
}

type Inflight = Arc<Mutex<HashMap<String, (Value, String)>>>;

struct Link {
    writer: Writer,
    alive: Arc<AtomicBool>,
}

async fn send_line(w: &mut Writer, line: &str) -> std::io::Result<()> {
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await
}

/// Connects to the endpoint; with `init`, replays the client's
/// `initialize` first (its answer is not passed on).
async fn attach(
    path: &str,
    init: Option<&Value>,
    out: &mpsc::UnboundedSender<String>,
    inflight: &Inflight,
) -> Option<Link> {
    let (reader, mut writer) = endpoint::connect(path).await.ok()?;
    if let Some(init) = init {
        let mut replay = init.clone();
        replay["id"] = json!(INIT_ID);
        send_line(&mut writer, &replay.to_string()).await.ok()?;
        let done = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        send_line(&mut writer, &done.to_string()).await.ok()?;
    }
    let alive = Arc::new(AtomicBool::new(true));
    let (out, inflight, flag) = (out.clone(), inflight.clone(), alive.clone());
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        while let Ok(Some(line)) = read_line(&mut reader, MAX_LINE).await {
            let id = serde_json::from_str::<Value>(&line)
                .ok()
                .and_then(|v| v.get("id").cloned());
            if let Some(id) = &id {
                if id == INIT_ID {
                    continue;
                }
                if let Ok(mut f) = inflight.lock() {
                    f.remove(&id.to_string());
                }
            }
            let _ = out.send(line);
        }
        flag.store(false, Ordering::SeqCst);
        // The app went away: answer what it left open.
        let left: Vec<(Value, String)> = inflight
            .lock()
            .map(|mut f| f.drain().map(|(_, v)| v).collect())
            .unwrap_or_default();
        for (id, method) in left {
            let msg = json!({"id": id, "method": method});
            if let Some(reply) = offline_reply(&msg) {
                let _ = out.send(reply.to_string());
            }
        }
    });
    Some(Link { writer, alive })
}

/// Runs the bridge between `input`/`output` (stdin/stdout) and the endpoint
/// at `path` until `input` ends.
pub async fn run<I, O>(path: String, input: I, mut output: O)
where
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin + Send + 'static,
{
    let (out, mut lines) = mpsc::unbounded_channel::<String>();
    let writing = tokio::spawn(async move {
        while let Some(line) = lines.recv().await {
            if output.write_all(line.as_bytes()).await.is_err()
                || output.write_all(b"\n").await.is_err()
                || output.flush().await.is_err()
            {
                break;
            }
        }
    });
    let inflight: Inflight = Arc::default();
    let mut link = attach(&path, None, &out, &inflight).await;
    let mut init: Option<Value> = None;
    let mut input = BufReader::new(input);
    while let Ok(Some(line)) = read_line(&mut input, MAX_LINE).await {
        if line.trim().is_empty() {
            continue;
        }
        let message: Option<Value> = serde_json::from_str(&line).ok();
        let method = message
            .as_ref()
            .and_then(|m| m.get("method"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let id = message.as_ref().and_then(|m| m.get("id")).cloned();
        if method == "initialize" {
            init = message.clone();
        }
        if link
            .as_ref()
            .is_some_and(|l| !l.alive.load(Ordering::SeqCst))
        {
            link = None;
        }
        if link.is_none() && method == "tools/call" {
            link = attach(&path, init.as_ref(), &out, &inflight).await;
        }
        if let Some(l) = link.as_mut() {
            if let Some(id) = &id {
                if let Ok(mut f) = inflight.lock() {
                    f.insert(id.to_string(), (id.clone(), method.clone()));
                }
            }
            if send_line(&mut l.writer, &line).await.is_ok() {
                continue;
            }
            if let Some(id) = &id {
                if let Ok(mut f) = inflight.lock() {
                    f.remove(&id.to_string());
                }
            }
            link = None;
        }
        let reply = match &message {
            Some(m) => offline_reply(m),
            None => Some(error(&Value::Null, -32700, "parse error")),
        };
        if let Some(reply) = reply {
            let _ = out.send(reply.to_string());
        }
    }
    drop(link);
    drop(out);
    let _ = writing.await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn not_running_answers_initialize_and_refuses_calls() {
        let missing = std::env::temp_dir()
            .join(format!("wc-no-endpoint-{}", std::process::id()))
            .join("mcp.sock");
        let (mut client_in, bridge_in) = tokio::io::duplex(1 << 16);
        let (bridge_out, client_out) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(run(
            missing.to_string_lossy().into_owned(),
            bridge_in,
            bridge_out,
        ));
        for m in [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"t","version":"1"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"targets_list","arguments":{}}}),
        ] {
            client_in
                .write_all(format!("{m}\n").as_bytes())
                .await
                .unwrap();
        }
        client_in.write_all(b"not json\n").await.unwrap();
        drop(client_in);
        let mut lines = tokio::io::BufReader::new(client_out).lines();
        let mut got = Vec::new();
        while let Some(l) = lines.next_line().await.unwrap() {
            got.push(serde_json::from_str::<Value>(&l).unwrap());
        }
        task.await.unwrap();
        assert_eq!(got.len(), 4, "{got:?}");
        assert_eq!(got[0]["result"]["serverInfo"]["name"], "WECOMMANDER");
        assert_eq!(got[0]["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(got[1]["result"]["tools"].as_array().unwrap().len(), 19);
        assert_eq!(got[2]["result"]["isError"], true);
        assert_eq!(
            got[2]["result"]["structuredContent"]["error"],
            NOT_RUNNING_CODE
        );
        assert!(got[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("WECOMMANDER'ı aç; yerel yapay zekâ erişimi uygulama açıkken çalışır."));
        assert_eq!(got[3]["error"]["code"], -32700);
    }
}
