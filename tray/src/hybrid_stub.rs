//! Hybrid Access is served by the native apps on Windows and macOS; this
//! tray app shows its SSH sharing list on Linux only (hybrid.rs).
use serde_json::Value;
use tauri::AppHandle;

const UNSUPPORTED: &str = "unsupported_platform";

#[tauri::command]
pub fn hybrid_view(_app: AppHandle) -> Result<Value, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn hybrid_import(_app: AppHandle) -> Result<Value, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn hybrid_add(
    _app: AppHandle,
    _label: String,
    _host: String,
    _port: Option<u16>,
    _user: String,
    _auth_kind: String,
) -> Result<Value, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn hybrid_verify(
    _app: AppHandle,
    _id: String,
    _password: Option<String>,
    _accept_fingerprint: Option<String>,
) -> Result<Value, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn hybrid_set(
    _app: AppHandle,
    _id: String,
    _remote: bool,
    _preset: String,
    _sudo: String,
) -> Result<Value, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn hybrid_delete(_app: AppHandle, _id: String) -> Result<Value, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn hybrid_root_terminal(
    _app: AppHandle,
    _id: String,
    _allow: bool,
    _close_text: String,
) -> Result<Value, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn hybrid_open_permissions(_app: AppHandle, _url: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
