//! Server management over the terminal's own SSH connection. The scripts,
//! their parsing and the safety rules live in `wc-server` (the agent runs the
//! same ones for MCP); here they run over SSH, plus Coolify's API.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use wc_server::{first, quote, sections, valid_owner, Shell, NEEDS_ROOT, PRELUDE};
pub use wc_server::{
    Cleanup, CleanupResult, CleanupScan, Disk, DiskUsage, DockerUsage, Overview, Owner, Process,
    ProcessList, Sample, UsageEntry, ZombieGroup,
};
use wc_ssh_core::client::Connection;

use crate::AppState;

const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const NOT_SSH: &str = "server management works only on SSH terminals";

/// The SSH connection of a terminal, or of a monitor (gauge) opened with
/// [`monitor_open`]: every server.* call works on either.
fn connection(state: &AppState, session_id: &str) -> Result<Arc<Connection>, String> {
    if let Some(m) = state.monitors.lock().map_err(|_| "busy")?.get(session_id) {
        if m.connection.is_closed() {
            return Err("monitor closed".into());
        }
        return Ok(m.connection.clone());
    }
    let terminals = state.terminals.lock().map_err(|_| "busy")?;
    let t = terminals.get(session_id).ok_or("terminal closed")?;
    t.connection.clone().ok_or_else(|| NOT_SSH.to_owned())
}

/// Connects to saved host `host_id` without a terminal (saved credential
/// or this computer's SSH keys; nothing is asked) and returns an id that
/// server.* calls take as `sessionId`.
pub async fn monitor_open(state: &Arc<AppState>, host_id: String) -> Result<String, String> {
    let (conn, jump) = crate::connect_quietly(state, &host_id).await?;
    let id = format!("monitor-{}", uuid::Uuid::new_v4());
    state.monitors.lock().map_err(|_| "busy")?.insert(
        id.clone(),
        crate::Monitor {
            connection: Arc::new(conn),
            _jump: jump,
        },
    );
    Ok(id)
}

pub fn monitor_close(state: &Arc<AppState>, monitor_id: String) -> Result<(), String> {
    state
        .monitors
        .lock()
        .map_err(|_| "busy")?
        .remove(&monitor_id);
    Ok(())
}

/// Runs the scripts with `sh` over the SSH connection (whatever the user's
/// login shell is).
struct Ssh(Arc<Connection>);

impl Shell for Ssh {
    async fn run_script(&self, script: &str, secs: u64) -> Result<String, String> {
        let command = format!("sh -c {}", quote(script));
        let out = tokio::time::timeout(Duration::from_secs(secs), self.0.exec(&command, MAX_OUTPUT))
            .await
            .map_err(|_| "Sunucu zamanında yanıt vermedi.".to_owned())?
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

fn shell(state: &AppState, session_id: &str) -> Result<Ssh, String> {
    Ok(Ssh(connection(state, session_id)?))
}

/// For Coolify's API calls.
async fn run(conn: &Connection, script: &str, secs: u64) -> Result<String, String> {
    let command = format!("sh -c {}", quote(&format!("{PRELUDE}{script}")));
    let out = tokio::time::timeout(Duration::from_secs(secs), conn.exec(&command, MAX_OUTPUT))
        .await
        .map_err(|_| "Sunucu zamanında yanıt vermedi.".to_owned())?
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Like [`run`], with `input` on the script's standard input (secrets).
async fn run_input(
    conn: &Connection,
    script: &str,
    input: &str,
    secs: u64,
) -> Result<String, String> {
    let command = format!("sh -c {}", quote(&format!("{PRELUDE}{script}")));
    let out = tokio::time::timeout(
        Duration::from_secs(secs),
        conn.exec_input(&command, input.as_bytes(), MAX_OUTPUT),
    )
    .await
    .map_err(|_| "Sunucu zamanında yanıt vermedi.".to_owned())?
    .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub async fn overview(state: &Arc<AppState>, session_id: String) -> Result<Overview, String> {
    wc_server::overview(&shell(state, &session_id)?).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    transfer_id: String,
    done: u64,
    total: u64,
}

/// The largest folders in `path` (never crossing into another disk).
/// With `transfer_id`, `transfer-progress` events report how far it got.
pub async fn disk_usage(
    state: &Arc<AppState>,
    session_id: String,
    path: Option<String>,
    transfer_id: Option<String>,
) -> Result<DiskUsage, String> {
    let sh = shell(state, &session_id)?;
    let report = |done: u64, total: u64| {
        if let Some(id) = &transfer_id {
            state.emit(
                "transfer-progress",
                ScanProgress {
                    transfer_id: id.clone(),
                    done,
                    total,
                },
            );
        }
    };
    wc_server::disk_usage(&sh, path, &report).await
}

pub async fn sample(state: &Arc<AppState>, session_id: String) -> Result<Sample, String> {
    wc_server::sample(&shell(state, &session_id)?).await
}

pub async fn cleanup_scan(state: &Arc<AppState>, session_id: String) -> Result<CleanupScan, String> {
    wc_server::cleanup_scan(&shell(state, &session_id)?).await
}

pub async fn cleanup_run(
    state: &Arc<AppState>,
    session_id: String,
    ids: Vec<String>,
) -> Result<Vec<CleanupResult>, String> {
    wc_server::cleanup_run(&shell(state, &session_id)?, ids).await
}

pub async fn processes(state: &Arc<AppState>, session_id: String) -> Result<ProcessList, String> {
    wc_server::processes(&shell(state, &session_id)?).await
}

pub async fn process_signal(
    state: &Arc<AppState>,
    session_id: String,
    pid: u32,
    name: String,
    action: String,
    confirm_database: bool,
) -> Result<String, String> {
    wc_server::process_signal(&shell(state, &session_id)?, pid, name, action, confirm_database).await
}

pub async fn restart_owner(
    state: &Arc<AppState>,
    session_id: String,
    kind: String,
    id: String,
) -> Result<String, String> {
    wc_server::restart_owner(&shell(state, &session_id)?, kind, id).await
}

// ---- Coolify: the lasting zombie fix ---------------------------------------

/// What "Öneriyi uygula" did.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InitFix {
    /// `applied` (saved and redeploying), `already` (was on; redeploying),
    /// `needs-token`, `compose` (a Docker Compose app: the user edits it),
    /// `not-coolify` (a container Coolify does not manage).
    pub status: String,
    /// The app's name in Coolify.
    pub app: String,
    pub message: String,
}

fn fix(status: &str, app: &str, message: &str) -> InitFix {
    InitFix {
        status: status.into(),
        app: app.into(),
        message: message.into(),
    }
}

/// Coolify names an app's container `<app uuid>-<deploy time>`.
fn coolify_uuid(container_name: &str) -> Option<String> {
    let name = container_name.trim_start_matches('/');
    let (uuid, stamp) = name.rsplit_once('-')?;
    (stamp.chars().all(|c| c.is_ascii_digit())
        && !uuid.is_empty()
        && uuid.len() <= 64
        && uuid.chars().all(|c| c.is_ascii_alphanumeric()))
    .then(|| uuid.to_owned())
}

fn token_key(conn: &Connection) -> String {
    let fp: String = conn
        .host_key()
        .fingerprint
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("coolify/{fp}")
}

/// `--init` added to Coolify's "custom Docker options" (once).
fn with_init(options: &str) -> Option<String> {
    let has = options.split_whitespace().any(|o| o == "--init");
    (!has).then(|| format!("{} --init", options.trim()).trim().to_owned())
}

/// Calls Coolify's API on the server itself (curl to its local port), the
/// token on standard input: it never leaves the server or shows in `ps`.
async fn coolify_api(
    conn: &Connection,
    base: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    token: &str,
) -> Result<(u16, serde_json::Value), String> {
    let data = body
        .map(|b| {
            format!(
                "-H 'Content-Type: application/json' --data-binary {}",
                quote(b)
            )
        })
        .unwrap_or_default();
    let script = format!(
        "command -v curl >/dev/null 2>&1 || {{ echo @@nocurl; exit 0; }}\necho @@body; curl -sS -m 60 -X {method} -H @- -H 'Accept: application/json' {data} -w '\\n@@status\\n%{{http_code}}\\n' {} 2>&1\n",
        quote(&format!("{base}{path}"))
    );
    let s = sections(
        &run_input(
            conn,
            &script,
            &format!("Authorization: Bearer {token}\n"),
            90,
        )
        .await?,
    );
    if s.contains_key("nocurl") {
        return Err("Sunucuda curl yok.".into());
    }
    let status: u16 = first(&s, "status").parse().unwrap_or(0);
    if status == 0 {
        return Err(format!(
            "Coolify'a ulaşılamadı ({base}): {}",
            s.get("body")
                .map(|l| l.join(" "))
                .unwrap_or_default()
                .trim()
        ));
    }
    let text = s.get("body").map(|l| l.join("\n")).unwrap_or_default();
    Ok((
        status,
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
    ))
}

/// Adds `--init` to the Coolify app that runs `container_id` and redeploys
/// it: the app then starts under a small init that collects zombies.
pub async fn coolify_init(
    state: &Arc<AppState>,
    session_id: String,
    container_id: String,
    token: Option<String>,
) -> Result<InitFix, String> {
    valid_owner("container", &container_id)?;
    let conn = connection(state, &session_id)?;
    let probe = format!(
        "[ \"$R\" ] || {{ echo @@noroot; exit 0; }}\necho @@info; r docker inspect -f '{{{{.Name}}}}\t{{{{index .Config.Labels \"coolify.managed\"}}}}' {container_id} 2>/dev/null\necho @@port; r docker port coolify 8080/tcp 2>/dev/null | head -1\n"
    );
    let s = sections(&run(&conn, &probe, 30).await?);
    if s.contains_key("noroot") {
        return Err(NEEDS_ROOT.into());
    }
    let (name, managed) = first(&s, "info").split_once('\t').unwrap_or(("", ""));
    let Some(uuid) = (managed.trim() == "true")
        .then(|| coolify_uuid(name))
        .flatten()
    else {
        return Ok(fix(
            "not-coolify",
            name.trim_start_matches('/'),
            "Bu konteyneri Coolify yönetmiyor. Kalıcı çözüm, konteyneri nasıl başlattıysan orada: docker run'a --init ekle ya da docker-compose.yml'de servise init: true yaz, sonra konteyneri yeniden oluştur.",
        ));
    };
    let port = first(&s, "port")
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8000);
    let base = format!("http://127.0.0.1:{port}");
    let key = token_key(&conn);
    let given = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    let Some(token) = given
        .clone()
        .or_else(|| state.vault.get(&key).ok().flatten())
    else {
        return Ok(fix("needs-token", "", ""));
    };
    let (code, app) = coolify_api(
        &conn,
        &base,
        "GET",
        &format!("/api/v1/applications/{uuid}"),
        None,
        &token,
    )
    .await?;
    match code {
        200 => {}
        401 => {
            let _ = state.vault.delete(&key);
            return Ok(fix("needs-token", "", "Coolify bu anahtarı kabul etmedi; yeni bir anahtar gir."));
        }
        403 => return Err("Coolify API kapalı ya da anahtarın yetkisi yetmiyor. Coolify'da Ayarlar > API erişimini aç; anahtar \"write\" ve \"deploy\" yetkili olmalı.".into()),
        404 => return Ok(fix("not-coolify", &uuid, "Coolify'da bu konteynerin uygulaması bulunamadı (bir servis ya da veritabanı olabilir). Coolify'da o kaynağın ayarlarına --init / init: true ekle.")),
        c => return Err(format!("Coolify beklenmeyen bir yanıt verdi ({c}).")),
    }
    let app_name = app["name"].as_str().unwrap_or(&uuid).to_owned();
    if given.is_some() {
        let _ = state.vault.put(&key, &token);
    }
    if app["build_pack"].as_str() == Some("dockercompose") {
        return Ok(fix(
            "compose",
            &app_name,
            "Bu uygulama Docker Compose ile tanımlı. Coolify'da uygulamanın Compose dosyasında bu servise init: true satırını ekleyip yeniden dağıt.",
        ));
    }
    let options = app["custom_docker_run_options"].as_str().unwrap_or("");
    let status = match with_init(options) {
        Some(new) => {
            let body = serde_json::json!({ "custom_docker_run_options": new }).to_string();
            let (code, reply) = coolify_api(
                &conn,
                &base,
                "PATCH",
                &format!("/api/v1/applications/{uuid}"),
                Some(&body),
                &token,
            )
            .await?;
            if code != 200 && code != 201 {
                return Err(format!(
                    "Coolify ayarı kaydetmedi ({code}): {}",
                    reply["message"].as_str().unwrap_or("")
                ));
            }
            "applied"
        }
        None => "already",
    };
    let (code, reply) = coolify_api(
        &conn,
        &base,
        "GET",
        &format!("/api/v1/deploy?uuid={uuid}"),
        None,
        &token,
    )
    .await?;
    if code != 200 && code != 201 {
        return Err(format!(
            "Ayar kaydedildi ama yeniden dağıtım başlamadı ({code}): {}. Coolify'dan Redeploy'a bas.",
            reply["message"].as_str().unwrap_or("")
        ));
    }
    Ok(fix(status, &app_name, ""))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coolify_apps_are_found_from_the_container_name() {
        assert_eq!(
            coolify_uuid("/sbniis4s6edpjklxoldkozem-174020068578").as_deref(),
            Some("sbniis4s6edpjklxoldkozem")
        );
        assert_eq!(coolify_uuid("web-app"), None);
        assert_eq!(coolify_uuid("a;b-123"), None);
        assert_eq!(with_init("").as_deref(), Some("--init"));
        assert_eq!(
            with_init("--cap-add SYS_ADMIN").as_deref(),
            Some("--cap-add SYS_ADMIN --init")
        );
        assert_eq!(with_init("--init --ulimit nofile=1024"), None);
    }

}
