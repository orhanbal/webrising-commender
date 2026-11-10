//! WECOMMANDER desktop app (V2 A01 skeleton).
//!
//! One window with two workspaces: **User** (SSH and SFTP to your servers,
//! filled by A02, A03, A07–A10) and **Agent** (the WECOMMANDER account and
//! its approvals, B09). The skeleton wires the shared crates in so the
//! three-OS build (G1) exercises the real dependency graph.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::sync::Mutex;
use wc_ssh_core::HostProfile;
use wc_vault::{Backend, MemoryStore, SecretStore};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    vault_backend: &'static str,
    vault_planned: &'static str,
    os: &'static str,
}

struct AppState {
    hosts: Mutex<Vec<HostProfile>>,
    vault: MemoryStore,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostView {
    label: String,
    target: String,
}

#[tauri::command]
fn app_info(state: tauri::State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        vault_backend: state.vault.backend().label(),
        vault_planned: Backend::platform_default().label(),
        os: std::env::consts::OS,
    }
}

#[tauri::command]
fn list_hosts(state: tauri::State<'_, AppState>) -> Vec<HostView> {
    state
        .hosts
        .lock()
        .map(|hosts| {
            hosts
                .iter()
                .map(|h| HostView {
                    label: h.label.clone(),
                    target: h.display_target(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Skeleton only: keeps the host for this session (persistence is A07).
#[tauri::command]
fn add_host(
    state: tauri::State<'_, AppState>,
    label: String,
    host: String,
    port: u16,
    user: String,
) -> Result<Vec<HostView>, String> {
    let profile = HostProfile::new(&label, &host, port, &user).map_err(|e| e.to_string())?;
    state
        .hosts
        .lock()
        .map_err(|_| "busy".to_string())?
        .push(profile);
    Ok(list_hosts(state))
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            hosts: Mutex::new(Vec::new()),
            vault: MemoryStore::default(),
        })
        .invoke_handler(tauri::generate_handler![app_info, list_hosts, add_host])
        .run(tauri::generate_context!())
        .expect("WECOMMANDER desktop failed to start");
}
