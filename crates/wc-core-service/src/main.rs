//! `wecommander-core --data-dir <folder>`: the app core for the native apps.
//!
//! Protocol: one JSON object per line.
//! - request  `{"id": 7, "method": "hosts.list", "params": {...}}`
//! - response `{"id": 7, "result": ...}` or `{"id": 7, "error": "..."}`
//! - event    `{"event": "terminal-output", "data": {...}}`
//!
//! Requests run concurrently; responses may come back out of order (match
//! them by `id`). The process exits when stdin closes, closing every SSH
//! connection. Method and field names: docs/CORE_PROTOCOL.md.
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use wc_app_core as core;

struct Stdout(Mutex<std::io::Stdout>);

impl Stdout {
    fn line(&self, value: &Value) {
        if let Ok(mut out) = self.0.lock() {
            let _ = writeln!(out, "{value}");
            let _ = out.flush();
        }
    }
}

struct Events(Arc<Stdout>);

impl core::EventSink for Events {
    fn emit(&self, name: &str, payload: Value) {
        self.0.line(&json!({ "event": name, "data": payload }));
    }
}

#[derive(Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

fn p<T: DeserializeOwned>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("invalid params: {e}"))
}

fn ok<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddHost {
    label: String,
    host: String,
    port: u16,
    user: String,
    auth_kind: String,
    jump_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateHost {
    id: String,
    label: String,
    host: String,
    port: u16,
    user: String,
    auth_kind: String,
    jump_id: Option<String>,
    group: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Label {
    label: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportKey {
    label: String,
    private: String,
    passphrase: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostKey {
    id: String,
    key_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    target: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSnippet {
    id: Option<String>,
    label: String,
    command: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connect {
    id: String,
    auth: core::AuthInput,
    accept_fingerprint: Option<String>,
    mode: String,
    cols: Option<u32>,
    rows: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Write_ {
    session_id: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Resize {
    session_id: String,
    cols: u32,
    rows: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesList {
    session_id: String,
    path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Download {
    session_id: String,
    remote: String,
    local: String,
    transfer_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Upload {
    session_id: String,
    local: String,
    remote_dir: String,
    transfer_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArg {
    session_id: String,
    path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rename {
    session_id: String,
    from: String,
    to: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardStart {
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardStop {
    session_id: String,
    local: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelSave {
    host_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelRef {
    host_id: String,
    index: usize,
}

async fn dispatch(
    state: &Arc<core::AppState>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "app.info" => ok(core::app_info(state, env!("CARGO_PKG_VERSION"))),
        "hosts.list" => ok(core::list_hosts(state)?),
        "hosts.add" => {
            let a: AddHost = p(params)?;
            ok(core::add_host(
                state,
                a.label,
                a.host,
                a.port,
                a.user,
                a.auth_kind,
                a.jump_id,
            )?)
        }
        "hosts.delete" => ok(core::delete_host(state, p::<Id>(params)?.id)?),
        "hosts.import" => ok(core::import_ssh_config(state)?),
        "secret.forget" => ok(core::forget_secret(state, p::<Id>(params)?.id)?),
        "connect" => {
            let c: Connect = p(params)?;
            ok(core::connect_host(
                state,
                c.id,
                c.auth,
                c.accept_fingerprint,
                c.mode,
                c.cols,
                c.rows,
            )
            .await?)
        }
        "terminal.write" => {
            let w: Write_ = p(params)?;
            ok(core::terminal_write(state, w.session_id, w.data).await?)
        }
        "terminal.resize" => {
            let r: Resize = p(params)?;
            ok(core::terminal_resize(state, r.session_id, r.cols, r.rows).await?)
        }
        "terminal.close" => {
            ok(core::terminal_close(state, p::<Session>(params)?.session_id).await?)
        }
        "files.list" => {
            let f: FilesList = p(params)?;
            ok(core::files_list(state, f.session_id, f.path).await?)
        }
        "files.download" => {
            let d: Download = p(params)?;
            ok(core::files_download(state, d.session_id, d.remote, d.local, d.transfer_id).await?)
        }
        "files.upload" => {
            let u: Upload = p(params)?;
            ok(
                core::files_upload(state, u.session_id, u.local, u.remote_dir, u.transfer_id)
                    .await?,
            )
        }
        "files.mkdir" => {
            let a: PathArg = p(params)?;
            ok(core::files_mkdir(state, a.session_id, a.path).await?)
        }
        "files.rename" => {
            let r: Rename = p(params)?;
            ok(core::files_rename(state, r.session_id, r.from, r.to).await?)
        }
        "files.delete" => {
            let a: PathArg = p(params)?;
            ok(core::files_delete(state, a.session_id, a.path).await?)
        }
        "forward.start" => {
            let f: ForwardStart = p(params)?;
            ok(core::forward_start(
                state,
                f.session_id,
                f.local_port,
                f.remote_host,
                f.remote_port,
            )
            .await?)
        }
        "forward.list" => ok(core::forward_list(state, p::<Session>(params)?.session_id)?),
        "forward.stop" => {
            let f: ForwardStop = p(params)?;
            ok(core::forward_stop(state, f.session_id, f.local)?)
        }
        "tunnels.saved" => ok(core::saved_tunnels(state)),
        "tunnels.save" => {
            let t: TunnelSave = p(params)?;
            ok(core::tunnel_save(
                state,
                t.host_id,
                t.local_port,
                t.remote_host,
                t.remote_port,
            )?)
        }
        "tunnels.delete" => {
            let t: TunnelRef = p(params)?;
            ok(core::tunnel_delete(state, t.host_id, t.index)?)
        }
        "tunnels.toggle" => {
            let t: TunnelRef = p(params)?;
            ok(core::tunnel_toggle(state, t.host_id, t.index).await?)
        }
        "hosts.update" => {
            let u: UpdateHost = p(params)?;
            ok(core::library::update_host(
                state,
                u.id,
                u.label,
                u.host,
                u.port,
                u.user,
                u.auth_kind,
                u.jump_id,
                u.group,
            )?)
        }
        "known.list" => ok(core::library::known_list(state)?),
        "known.forget" => ok(core::library::known_forget(
            state,
            p::<Target>(params)?.target,
        )?),
        "snippets.list" => ok(core::library::snippets_list(state)?),
        "snippets.save" => {
            let s: SaveSnippet = p(params)?;
            ok(core::library::snippet_save(
                state, s.id, s.label, s.command,
            )?)
        }
        "snippets.delete" => ok(core::library::snippet_delete(state, p::<Id>(params)?.id)?),
        "keys.list" => ok(core::library::keys_list(state)?),
        "keys.generate" => ok(core::library::key_generate(
            state,
            p::<Label>(params)?.label,
        )?),
        "keys.import" => {
            let k: ImportKey = p(params)?;
            ok(core::library::key_import(
                state,
                k.label,
                k.private,
                k.passphrase,
            )?)
        }
        "keys.delete" => ok(core::library::key_delete(state, p::<Id>(params)?.id)?),
        "hosts.setKey" => {
            let h: HostKey = p(params)?;
            ok(core::library::host_set_key(state, h.id, h.key_id)?)
        }
        "history.list" => ok(core::library::history_list(state)?),
        "history.clear" => ok(core::library::history_clear(state)?),
        other => Err(format!("unknown method {other}")),
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let (mut data_dir, mut service) = (None, "app.wecommander".to_owned());
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => data_dir = args.next(),
            "--keyring-service" => service = args.next().unwrap_or(service),
            "--version" => {
                println!("wecommander-core {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            _ => {}
        }
    }
    let Some(data_dir) = data_dir else {
        eprintln!("usage: wecommander-core --data-dir <folder> [--keyring-service <name>]");
        std::process::exit(2);
    };
    let out = Arc::new(Stdout(Mutex::new(std::io::stdout())));
    let state = core::open(
        std::path::Path::new(&data_dir),
        &service,
        Arc::new(Events(out.clone())),
    );
    out.line(
        &json!({ "event": "ready", "data": core::app_info(&state, env!("CARGO_PKG_VERSION")) }),
    );

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                out.line(&json!({ "id": null, "error": format!("invalid request: {e}") }));
                continue;
            }
        };
        let (state, out) = (state.clone(), out.clone());
        tokio::spawn(async move {
            let reply = match dispatch(&state, &request.method, request.params).await {
                Ok(result) => json!({ "id": request.id, "result": result }),
                Err(error) => json!({ "id": request.id, "error": error }),
            };
            out.line(&reply);
        });
    }
}
