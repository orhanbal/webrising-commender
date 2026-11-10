//! Agent workspace (B09): the WECOMMANDER account on this desktop. It links
//! like a Management Center (browser approval, center token in the OS
//! keyring) and shares the Center's gateway client (`tray/src/api.rs`), so
//! approvals, devices and error texts behave the same in both apps.
use crate::AppState;
use serde::Serialize;
use tauri::{Emitter, Manager};

#[path = "../../tray/src/api.rs"]
#[allow(dead_code)]
mod center_api;

use center_api::{Api, ApiError, Device, Me};

const DEFAULT_SERVER: &str = "https://wecommander.app";
const TOKEN_KEY: &str = "center/token";

/// `WECOMMANDER_SERVER` points the app at a self-hosted gateway.
fn server() -> String {
    std::env::var("WECOMMANDER_SERVER")
        .ok()
        .filter(|s| {
            s.starts_with("https://")
                || s.starts_with("http://127.0.0.1")
                || s.starts_with("http://localhost")
        })
        .unwrap_or_else(|| DEFAULT_SERVER.to_owned())
}

fn api() -> Api {
    Api::new(&server())
}

fn token(state: &AppState) -> Option<String> {
    state.vault.get(TOKEN_KEY).ok().flatten()
}

fn err(e: ApiError, state: &AppState) -> String {
    if matches!(e, ApiError::Unauthorized) {
        // Revoked in the web panel or expired: forget it so the UI offers to link again.
        let _ = state.vault.delete(TOKEN_KEY);
    }
    e.message()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    linked: bool,
    me: Option<Me>,
    server: String,
    keyring: bool,
}

#[tauri::command]
pub async fn agent_status(state: tauri::State<'_, AppState>) -> Result<Status, String> {
    let Some(t) = token(&state) else {
        return Ok(Status {
            linked: false,
            me: None,
            server: server(),
            keyring: state.vault_persistent,
        });
    };
    let me = api().me(&t).await.map_err(|e| err(e, &state))?;
    Ok(Status {
        linked: true,
        me: Some(me),
        server: server(),
        keyring: state.vault_persistent,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStarted {
    approve_url: String,
    expires_in_seconds: u64,
}

/// Starts linking: the UI opens `approve_url` in the browser; a background
/// poll stores the token and emits `agent-linked` (or `agent-link-failed`).
#[tauri::command]
pub async fn agent_link_start(app: tauri::AppHandle) -> Result<LinkStarted, String> {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let name = if host.is_empty() {
        "WECOMMANDER Desktop".to_owned()
    } else {
        format!("WECOMMANDER Desktop ({host})")
    };
    let start = api().link_start(&name).await.map_err(|e| e.message())?;
    let (id, secret) = (start.request_id.clone(), start.request_secret.clone());
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(start.expires_in_seconds.max(30));
    tauri::async_runtime::spawn(async move {
        let api = api();
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            match api.link_poll(&id, &secret).await {
                Ok(poll) if poll.status == "approved" => {
                    if let (Some(token), Some(state)) =
                        (poll.center_token, app.try_state::<AppState>())
                    {
                        let saved = state.vault.put(TOKEN_KEY, &token).is_ok();
                        let _ = app.emit("agent-linked", saved);
                    }
                    return;
                }
                Ok(poll) if poll.status == "pending" => {}
                Ok(poll) => {
                    let _ = app.emit("agent-link-failed", poll.status);
                    return;
                }
                Err(ApiError::Network(_)) => {}
                Err(e) => {
                    let _ = app.emit("agent-link-failed", e.message());
                    return;
                }
            }
        }
        let _ = app.emit("agent-link-failed", "expired");
    });
    Ok(LinkStarted {
        approve_url: start.approve_url,
        expires_in_seconds: start.expires_in_seconds,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    id: String,
    device: String,
    kind: String,
    summary: String,
    expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    devices: Vec<Device>,
    pending: Vec<PendingView>,
}

#[tauri::command]
pub async fn agent_overview(state: tauri::State<'_, AppState>) -> Result<Overview, String> {
    let t = token(&state).ok_or("not linked")?;
    let api = api();
    let (devices, pending) =
        tokio::try_join!(api.devices(&t), api.pending(&t)).map_err(|e| err(e, &state))?;
    let name_of = |id: &str| {
        devices
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.name.clone())
            .unwrap_or_else(|| id.chars().take(8).collect())
    };
    let pending = pending
        .into_iter()
        .map(|a| PendingView {
            device: name_of(&a.device_id),
            summary: center_api::summary(&a.action),
            kind: a.action_kind.clone(),
            expires_at: a.expires_at.clone(),
            id: a.id,
        })
        .collect();
    Ok(Overview { devices, pending })
}

#[tauri::command]
pub async fn agent_decide(
    state: tauri::State<'_, AppState>,
    id: String,
    approve: bool,
) -> Result<(), String> {
    let t = token(&state).ok_or("not linked")?;
    api()
        .decide(&t, &id, approve)
        .await
        .map_err(|e| err(e, &state))
}

#[tauri::command]
pub async fn agent_unlink(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(t) = token(&state) {
        let _ = api().disconnect(&t).await;
    }
    let _ = state.vault.delete(TOKEN_KEY);
    Ok(())
}
