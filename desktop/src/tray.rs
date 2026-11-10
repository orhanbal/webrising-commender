//! Tray icon (A10 follow-up): quick connect to saved hosts and saved
//! tunnels that keep running while the window is closed. Closing the
//! window hides it; "Çıkış" in the tray menu quits.
use crate::{connect_saved, AppState};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use wc_ssh_core::client::{Connection, LocalForward};

const TRAY_ID: &str = "main";

struct Running {
    _forward: LocalForward,
    _connection: Arc<Connection>,
    _jump: Option<Arc<Connection>>,
}

/// Tunnels started from the tray or the tunnel list, keyed `host#index`.
#[derive(Default)]
pub struct Background {
    running: Mutex<HashMap<String, Running>>,
}

fn key(host_id: &str, index: usize) -> String {
    format!("{host_id}#{index}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTunnelView {
    host_id: String,
    host_label: String,
    index: usize,
    local: String,
    remote: String,
    running: bool,
}

fn views(app: &AppHandle) -> Vec<SavedTunnelView> {
    let state = app.state::<AppState>();
    let bg = app.state::<Background>();
    let running = bg
        .running
        .lock()
        .map(|r| r.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let Ok(data) = state.data.lock() else {
        return vec![];
    };
    data.hosts
        .iter()
        .flat_map(|h| {
            h.tunnels.iter().enumerate().map(|(i, t)| SavedTunnelView {
                host_id: h.id.clone(),
                host_label: h.profile.label.clone(),
                index: i,
                local: format!("127.0.0.1:{}", t.local_port),
                remote: format!("{}:{}", t.remote_host, t.remote_port),
                running: running.contains(&key(&h.id, i)),
            })
        })
        .collect()
}

#[tauri::command]
pub fn saved_tunnels(app: AppHandle) -> Vec<SavedTunnelView> {
    views(&app)
}

#[tauri::command]
pub fn tunnel_save(
    app: AppHandle,
    host_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<Vec<SavedTunnelView>, String> {
    let remote_host = remote_host.trim().to_owned();
    if local_port == 0 || remote_port == 0 || remote_host.is_empty() || remote_host.len() > 253 {
        return Err("a saved tunnel needs a fixed local port, a remote host and a port".into());
    }
    {
        let state = app.state::<AppState>();
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let taken = data
            .hosts
            .iter()
            .flat_map(|h| h.tunnels.iter())
            .any(|t| t.local_port == local_port);
        if taken {
            return Err(format!(
                "local port {local_port} is already used by a saved tunnel"
            ));
        }
        let host = data
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or("host not found")?;
        host.tunnels.push(crate::store::SavedTunnel {
            local_port,
            remote_host,
            remote_port,
        });
        state.save(&data)?;
    }
    refresh(&app);
    Ok(views(&app))
}

#[tauri::command]
pub fn tunnel_delete(
    app: AppHandle,
    host_id: String,
    index: usize,
) -> Result<Vec<SavedTunnelView>, String> {
    stop_all_for(&app, &host_id);
    {
        let state = app.state::<AppState>();
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let host = data
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or("host not found")?;
        if index < host.tunnels.len() {
            host.tunnels.remove(index);
        }
        state.save(&data)?;
    }
    refresh(&app);
    Ok(views(&app))
}

/// Indexes shift when a tunnel is deleted, so stop the host's tunnels first.
fn stop_all_for(app: &AppHandle, host_id: &str) {
    if let Ok(mut running) = app.state::<Background>().running.lock() {
        running.retain(|k, _| !k.starts_with(&format!("{host_id}#")));
    }
}

#[tauri::command]
pub async fn tunnel_toggle(
    app: AppHandle,
    host_id: String,
    index: usize,
) -> Result<Vec<SavedTunnelView>, String> {
    toggle(&app, &host_id, index).await?;
    Ok(views(&app))
}

async fn toggle(app: &AppHandle, host_id: &str, index: usize) -> Result<(), String> {
    let k = key(host_id, index);
    let was_running = app
        .state::<Background>()
        .running
        .lock()
        .map_err(|_| "busy")?
        .remove(&k)
        .is_some();
    if !was_running {
        let tunnel = {
            let state = app.state::<AppState>();
            let data = state.data.lock().map_err(|_| "busy")?;
            data.hosts
                .iter()
                .find(|h| h.id == host_id)
                .and_then(|h| h.tunnels.get(index).cloned())
                .ok_or("tunnel not found")?
        };
        let state = app.state::<AppState>();
        let (conn, jump) = connect_saved(&state, host_id).await?;
        let conn = Arc::new(conn);
        let forward = conn
            .forward_local(
                &format!("127.0.0.1:{}", tunnel.local_port),
                &tunnel.remote_host,
                tunnel.remote_port,
            )
            .await
            .map_err(|e| e.to_string())?;
        app.state::<Background>()
            .running
            .lock()
            .map_err(|_| "busy")?
            .insert(
                k,
                Running {
                    _forward: forward,
                    _connection: conn,
                    _jump: jump,
                },
            );
    }
    refresh(app);
    let _ = app.emit("tunnels-changed", ());
    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let hosts: Vec<(String, String)> = state
        .data
        .lock()
        .map(|d| {
            d.hosts
                .iter()
                .map(|h| (h.id.clone(), h.profile.label.clone()))
                .collect()
        })
        .unwrap_or_default();
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "show",
        "WECOMMANDER'ı aç",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let connect = Submenu::with_id(app, "hosts", "Bağlan", !hosts.is_empty())?;
    for (id, label) in &hosts {
        connect.append(&MenuItem::with_id(
            app,
            format!("host:{id}"),
            label,
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&connect)?;
    let tunnels = views(app);
    let tunnel_menu = Submenu::with_id(app, "tunnels", "Tüneller", !tunnels.is_empty())?;
    for t in &tunnels {
        tunnel_menu.append(&CheckMenuItem::with_id(
            app,
            format!("tun:{}:{}", t.host_id, t.index),
            format!("{}  {} → {}", t.host_label, t.local, t.remote),
            true,
            t.running,
            None::<&str>,
        )?)?;
    }
    menu.append(&tunnel_menu)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Çıkış",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

/// Rebuilds the tray menu (hosts or tunnels changed).
pub fn refresh(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app)) {
        let _ = tray.set_menu(Some(menu));
        let count = app
            .state::<Background>()
            .running
            .lock()
            .map(|r| r.len())
            .unwrap_or(0);
        let tip = if count == 0 {
            "WECOMMANDER".to_owned()
        } else {
            format!("WECOMMANDER · {count} tünel açık")
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.manage(Background::default());
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("WECOMMANDER")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_owned();
            match id.as_str() {
                "show" => show_window(app),
                "quit" => app.exit(0),
                _ if id.starts_with("host:") => {
                    show_window(app);
                    let _ = app.emit("tray-open-host", id.trim_start_matches("host:").to_owned());
                }
                _ if id.starts_with("tun:") => {
                    let mut parts = id.splitn(3, ':').skip(1);
                    let (Some(host), Some(index)) =
                        (parts.next(), parts.next().and_then(|i| i.parse().ok()))
                    else {
                        return;
                    };
                    let (app, host) = (app.clone(), host.to_owned());
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = toggle(&app, &host, index).await {
                            refresh(&app);
                            show_window(&app);
                            let _ = app.emit("tray-error", e);
                        }
                    });
                }
                _ => {}
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
