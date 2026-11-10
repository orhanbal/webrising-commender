//! WECOMMANDER desktop app (V2 A01 skeleton).
//!
//! One window with two workspaces: **User** (SSH and SFTP to your servers,
//! filled by A02, A03, A07–A10) and **Agent** (the WECOMMANDER account and
//! its approvals, B09). The skeleton wires the shared crates in so the
//! three-OS build (G1) exercises the real dependency graph.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use wc_ssh_core::client::{connect, ConnectOptions, Credential, SshError};
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
    /// `host:port` -> trusted `SHA256:` fingerprint, for this session only
    /// (A07 persists it as known_hosts).
    known_hosts: Mutex<HashMap<String, String>>,
    vault: MemoryStore,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthInput {
    /// "password" or "key".
    kind: String,
    secret: String,
    passphrase: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum ConnectOutcome {
    #[serde(rename_all = "camelCase")]
    Connected { fingerprint: String, output: String },
    /// First contact: show the key and ask before trusting it.
    #[serde(rename_all = "camelCase")]
    HostKeyUnknown {
        algorithm: String,
        fingerprint: String,
    },
    /// The host key differs from the trusted one: possible attack.
    #[serde(rename_all = "camelCase")]
    HostKeyChanged {
        trusted: String,
        algorithm: String,
        fingerprint: String,
    },
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

/// Connects to saved host `index`, checks the host key and runs a short
/// identity command. `accept_fingerprint` is the key the person just
/// approved in the host key dialog.
#[tauri::command]
async fn test_connection(
    state: tauri::State<'_, AppState>,
    index: usize,
    auth: AuthInput,
    accept_fingerprint: Option<String>,
) -> Result<ConnectOutcome, String> {
    let profile = state
        .hosts
        .lock()
        .map_err(|_| "busy".to_string())?
        .get(index)
        .cloned()
        .ok_or("host not found")?;
    let host_id = format!("{}:{}", profile.host, profile.port);
    let trusted = state
        .known_hosts
        .lock()
        .map_err(|_| "busy".to_string())?
        .get(&host_id)
        .cloned();
    let credential = match auth.kind.as_str() {
        "password" => Credential::Password(auth.secret),
        "key" => Credential::PrivateKey {
            key: auth.secret,
            passphrase: auth.passphrase.filter(|p| !p.is_empty()),
        },
        _ => return Err("unknown auth method".into()),
    };
    let options = ConnectOptions {
        // A just-approved key wins over the stored one (the person saw the
        // "key changed" warning before approving).
        trusted_fingerprint: accept_fingerprint.or(trusted),
        ..Default::default()
    };
    match connect(&profile, &credential, &options).await {
        Ok(conn) => {
            let fingerprint = conn.host_key().fingerprint.clone();
            if let Ok(mut known) = state.known_hosts.lock() {
                known.insert(host_id, fingerprint.clone());
            }
            let out = conn
                .exec("whoami", 4096)
                .await
                .map_err(|e| e.to_string())?;
            let _ = conn.close().await;
            Ok(ConnectOutcome::Connected {
                fingerprint,
                output: String::from_utf8_lossy(&out.stdout).trim().to_owned(),
            })
        }
        Err(SshError::HostKeyUnknown(key)) => Ok(ConnectOutcome::HostKeyUnknown {
            algorithm: key.algorithm,
            fingerprint: key.fingerprint,
        }),
        Err(SshError::HostKeyChanged { trusted, presented }) => {
            Ok(ConnectOutcome::HostKeyChanged {
                trusted,
                algorithm: presented.algorithm,
                fingerprint: presented.fingerprint,
            })
        }
        Err(err) => Err(err.to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            hosts: Mutex::new(Vec::new()),
            known_hosts: Mutex::new(HashMap::new()),
            vault: MemoryStore::default(),
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_hosts,
            add_host,
            test_connection
        ])
        .run(tauri::generate_context!())
        .expect("WECOMMANDER desktop failed to start");
}
