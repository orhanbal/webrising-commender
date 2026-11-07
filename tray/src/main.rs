// WECOMMANDER Management Center: a tray app on the owner's own computer.
// It signs in through the browser, shows approval requests from every device
// as they arrive, approves or denies them, and turns autonomous mode on and
// off. It never runs device tools and never sees the account password, except
// the one typed to start autonomous mode, which goes straight to the gateway.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod store;

use api::{Api, ApiError, AutonomyItem, Device, Me};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use store::Settings;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const SYNC_EVERY: Duration = Duration::from_secs(4);
const TICK: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct Link {
    id: String,
    secret: String,
    approve_url: String,
    deadline: Instant,
}

#[derive(Default)]
struct Inner {
    settings: Settings,
    token: Option<String>,
    me: Option<Me>,
    pending: Vec<ApprovalView>,
    devices: Vec<Device>,
    autonomy: Vec<AutonomyItem>,
    error: Option<String>,
    last_sync: Option<Instant>,
    synced_once: bool,
    seen: HashSet<String>,
    link: Option<Link>,
}

struct Menus {
    pending: MenuItem<Wry>,
    autonomy: MenuItem<Wry>,
    stop_autonomy: MenuItem<Wry>,
    notify: CheckMenuItem<Wry>,
}

struct AppState {
    dir: PathBuf,
    inner: Mutex<Inner>,
    tray: Mutex<Option<TrayIcon>>,
    menus: Mutex<Option<Menus>>,
    wake: tokio::sync::Notify,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalView {
    id: String,
    device_id: String,
    device_name: String,
    kind: String,
    summary: String,
    expires_at: String,
    created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    phase: &'static str,
    server: String,
    approve_url: Option<String>,
    me: Option<Me>,
    pending: Vec<ApprovalView>,
    devices: Vec<Device>,
    autonomy: Vec<AutonomyItem>,
    error: Option<String>,
    synced_seconds_ago: Option<u64>,
    settings: Settings,
    autostart: bool,
    version: &'static str,
}

fn snapshot(app: &AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let inner = state.inner.lock().unwrap();
    let phase = if inner.token.is_some() {
        "signedIn"
    } else if inner.link.is_some() {
        "linking"
    } else {
        "signedOut"
    };
    Snapshot {
        phase,
        server: inner.settings.server.clone(),
        approve_url: inner.link.as_ref().map(|l| l.approve_url.clone()),
        me: inner.me.clone(),
        pending: inner.pending.clone(),
        devices: inner.devices.clone(),
        autonomy: inner.autonomy.clone(),
        error: inner.error.clone(),
        synced_seconds_ago: inner.last_sync.map(|t| t.elapsed().as_secs()),
        settings: inner.settings.clone(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        version: env!("CARGO_PKG_VERSION"),
    }
}

fn publish(app: &AppHandle) {
    update_tray(app);
    let _ = app.emit("state", snapshot(app));
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn tray_image(pending: bool, autonomy: bool) -> Option<Image<'static>> {
    let bytes: &[u8] = match (autonomy, pending) {
        (false, false) => include_bytes!("../icons/tray.png"),
        (false, true) => include_bytes!("../icons/tray-pending.png"),
        (true, false) => include_bytes!("../icons/tray-autonomy.png"),
        (true, true) => include_bytes!("../icons/tray-autonomy-pending.png"),
    };
    Image::from_bytes(bytes).ok()
}

fn update_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (signed_in, pending, autonomy, notifications) = {
        let inner = state.inner.lock().unwrap();
        (
            inner.token.is_some(),
            inner.pending.len(),
            inner.autonomy.len(),
            inner.settings.notifications,
        )
    };
    let tooltip = if !signed_in {
        "WECOMMANDER Yönetim Merkezi — bağlı değil".to_owned()
    } else {
        let mut text = match pending {
            0 => "WECOMMANDER — bekleyen onay yok".to_owned(),
            n => format!("WECOMMANDER — {n} bekleyen onay"),
        };
        if autonomy > 0 {
            text.push_str(&format!(" · otonom mod açık ({autonomy} cihaz)"));
        }
        text
    };
    if let Some(tray) = state.tray.lock().unwrap().as_ref() {
        let _ = tray.set_icon(tray_image(pending > 0, autonomy > 0));
        let _ = tray.set_tooltip(Some(&tooltip));
    };
    if let Some(menus) = state.menus.lock().unwrap().as_ref() {
        let _ = menus.pending.set_text(match (signed_in, pending) {
            (false, _) => "Bağlı değil — bağlanmak için aç".to_owned(),
            (true, 0) => "Bekleyen onay yok".to_owned(),
            (true, n) => format!("Bekleyen onaylar: {n}"),
        });
        let _ = menus.autonomy.set_text(if autonomy > 0 {
            format!("Otonom mod açık: {autonomy} cihaz")
        } else {
            "Otonom mod kapalı".to_owned()
        });
        let _ = menus.stop_autonomy.set_enabled(signed_in && autonomy > 0);
        let _ = menus.notify.set_checked(notifications);
    };
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

fn session(app: &AppHandle) -> Result<(Api, String), String> {
    let state = app.state::<AppState>();
    let inner = state.inner.lock().unwrap();
    let token = inner.token.clone().ok_or("Önce hesabına bağlan.")?;
    Ok((Api::new(&inner.settings.server), token))
}

/// Forget the token everywhere (revoked on the server, or the user left).
fn sign_out(app: &AppHandle, message: Option<String>) {
    let state = app.state::<AppState>();
    let server = {
        let mut inner = state.inner.lock().unwrap();
        let server = inner.settings.server.clone();
        *inner = Inner {
            settings: inner.settings.clone(),
            error: message,
            ..Inner::default()
        };
        server
    };
    store::delete_token(&state.dir, &server);
}

async fn sync(app: &AppHandle) {
    let Ok((api, token)) = session(app) else {
        return;
    };
    let need_me = app.state::<AppState>().inner.lock().unwrap().me.is_none();
    let me = if need_me {
        Some(api.me(&token).await)
    } else {
        None
    };
    let (pending, devices, autonomy) = tokio::join!(
        api.pending(&token),
        api.devices(&token),
        api.autonomy(&token)
    );
    let first_error = [
        me.as_ref().and_then(|r| r.as_ref().err()),
        pending.as_ref().err(),
        devices.as_ref().err(),
        autonomy.as_ref().err(),
    ]
    .into_iter()
    .flatten()
    .next()
    .map(|e| (matches!(e, ApiError::Unauthorized), e.message()));
    if let Some((true, message)) = &first_error {
        sign_out(app, Some(message.clone()));
        publish(app);
        return;
    }

    let state = app.state::<AppState>();
    let (fresh, open_on_request, notifications, first) = {
        let mut inner = state.inner.lock().unwrap();
        if let Some(Ok(me)) = me {
            inner.me = Some(me);
        }
        if let Ok(devices) = devices {
            inner.devices = devices;
        }
        if let Ok(autonomy) = autonomy {
            inner.autonomy = autonomy;
        }
        let mut fresh = Vec::new();
        if let Ok(pending) = pending {
            let names: std::collections::HashMap<_, _> = inner
                .devices
                .iter()
                .map(|d| (d.id.clone(), d.name.clone()))
                .collect();
            inner.pending = pending
                .into_iter()
                .map(|a| ApprovalView {
                    device_name: names
                        .get(&a.device_id)
                        .cloned()
                        .unwrap_or_else(|| "bilinmeyen cihaz".into()),
                    summary: api::summary(&a.action),
                    id: a.id,
                    device_id: a.device_id,
                    kind: a.action_kind,
                    expires_at: a.expires_at,
                    created_at: a.created_at,
                })
                .collect();
            let Inner { pending, seen, .. } = &mut *inner;
            for item in pending.iter() {
                if seen.insert(item.id.clone()) {
                    fresh.push(item.clone());
                }
            }
        }
        inner.error = first_error.map(|(_, message)| message);
        inner.last_sync = Some(Instant::now());
        let first = !inner.synced_once;
        inner.synced_once = true;
        (
            fresh,
            inner.settings.open_on_request,
            inner.settings.notifications,
            first,
        )
    };

    if !fresh.is_empty() {
        if notifications {
            if first {
                notify(
                    app,
                    "WECOMMANDER",
                    &format!("{} bekleyen onay isteği var.", fresh.len()),
                );
            } else {
                for item in fresh.iter().take(3) {
                    let what = if item.summary.is_empty() {
                        item.kind.clone()
                    } else {
                        item.summary.clone()
                    };
                    notify(
                        app,
                        &format!("Onay bekliyor · {}", item.device_name),
                        &format!("{}: {}", item.kind, what),
                    );
                }
            }
        }
        if open_on_request {
            show_main(app);
        }
    }
    publish(app);
}

async fn poll_link(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (link, server) = {
        let inner = state.inner.lock().unwrap();
        (inner.link.clone(), inner.settings.server.clone())
    };
    let Some(link) = link else { return };
    if Instant::now() > link.deadline {
        state.inner.lock().unwrap().link = None;
        state.inner.lock().unwrap().error =
            Some("Bağlantı isteğinin süresi doldu. Yeniden dene.".into());
        publish(app);
        return;
    }
    match Api::new(&server).link_poll(&link.id, &link.secret).await {
        Ok(poll) if poll.status == "approved" => {
            let Some(token) = poll.center_token else {
                return;
            };
            let saved = store::save_token(&state.dir, &server, &token);
            {
                let mut inner = state.inner.lock().unwrap();
                inner.link = None;
                inner.token = Some(token);
                inner.error = saved.err().map(|e| format!("Bağlandı, ancak anahtar kaydedilemedi ({e}); yeniden açılışta tekrar bağlanman gerekir."));
            }
            notify(app, "WECOMMANDER", "Yönetim Merkezi hesabına bağlandı.");
            show_main(app);
            sync(app).await;
        }
        Ok(poll) if poll.status == "pending" => {}
        Ok(_) => {
            let mut inner = state.inner.lock().unwrap();
            inner.link = None;
            inner.error = Some("Bağlantı isteği geçersiz ya da kullanılmış. Yeniden dene.".into());
            drop(inner);
            publish(app);
        }
        Err(error) => {
            state.inner.lock().unwrap().error = Some(error.message());
            publish(app);
        }
    }
}

async fn background(app: AppHandle) {
    let mut last = Instant::now() - SYNC_EVERY;
    loop {
        let state = app.state::<AppState>();
        tokio::select! {
            _ = tokio::time::sleep(TICK) => {}
            _ = state.wake.notified() => { last = Instant::now() - SYNC_EVERY; }
        }
        let (linking, signed_in) = {
            let inner = state.inner.lock().unwrap();
            (inner.link.is_some(), inner.token.is_some())
        };
        if linking {
            poll_link(&app).await;
        } else if signed_in && last.elapsed() >= SYNC_EVERY {
            last = Instant::now();
            sync(&app).await;
        }
    }
}

fn wake(app: &AppHandle) {
    app.state::<AppState>().wake.notify_one();
}

// ---- commands called by the window ----

#[tauri::command]
fn get_state(app: AppHandle) -> Snapshot {
    snapshot(&app)
}

#[tauri::command]
async fn connect(app: AppHandle, server: String, name: String) -> Result<Snapshot, String> {
    let server = store::normalize_server(&server)?;
    let name = name
        .trim()
        .chars()
        .filter(|c| !c.is_control() && *c != '<' && *c != '>')
        .take(80)
        .collect::<String>();
    let name = if name.is_empty() {
        "Yönetim Merkezi".to_owned()
    } else {
        name
    };
    let start = Api::new(&server)
        .link_start(&name)
        .await
        .map_err(|e| e.message())?;
    {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().unwrap();
        inner.settings.server = server;
        let _ = store::save_settings(&state.dir, &inner.settings);
        inner.error = None;
        inner.link = Some(Link {
            id: start.request_id,
            secret: start.request_secret,
            approve_url: start.approve_url.clone(),
            deadline: Instant::now() + Duration::from_secs(start.expires_in_seconds.min(600)),
        });
    }
    let _ = app.opener().open_url(start.approve_url, None::<&str>);
    wake(&app);
    publish(&app);
    Ok(snapshot(&app))
}

#[tauri::command]
fn cancel_connect(app: AppHandle) -> Snapshot {
    app.state::<AppState>().inner.lock().unwrap().link = None;
    publish(&app);
    snapshot(&app)
}

#[tauri::command]
fn open_link(app: AppHandle) -> Result<(), String> {
    let url = app
        .state::<AppState>()
        .inner
        .lock()
        .unwrap()
        .link
        .as_ref()
        .map(|l| l.approve_url.clone());
    match url {
        Some(url) => app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
async fn decide(app: AppHandle, id: String, approve: bool) -> Result<Snapshot, String> {
    let (api, token) = session(&app)?;
    let result = api.decide(&token, &id, approve).await;
    sync(&app).await;
    result.map_err(|e| e.message())?;
    Ok(snapshot(&app))
}

#[tauri::command]
async fn autonomy_start(
    app: AppHandle,
    minutes: Option<u32>,
    device_ids: Option<Vec<String>>,
    password: String,
) -> Result<Snapshot, String> {
    if password.is_empty() {
        return Err("Otonom modu açmak için hesap şifreni gir.".into());
    }
    if let Some(m) = minutes {
        if !(5..=30 * 24 * 60).contains(&m) {
            return Err("Süre 5 dakika ile 30 gün arasında olmalı.".into());
        }
    }
    let (api, token) = session(&app)?;
    api.set_autonomy(&token, true, minutes, device_ids, Some(password))
        .await
        .map_err(|e| e.message())?;
    sync(&app).await;
    Ok(snapshot(&app))
}

#[tauri::command]
async fn autonomy_stop(
    app: AppHandle,
    device_ids: Option<Vec<String>>,
) -> Result<Snapshot, String> {
    let (api, token) = session(&app)?;
    api.set_autonomy(&token, false, None, device_ids, None)
        .await
        .map_err(|e| e.message())?;
    sync(&app).await;
    Ok(snapshot(&app))
}

#[tauri::command]
async fn disconnect(app: AppHandle) -> Result<Snapshot, String> {
    if let Ok((api, token)) = session(&app) {
        let _ = api.disconnect(&token).await;
    }
    sign_out(&app, None);
    publish(&app);
    Ok(snapshot(&app))
}

#[tauri::command]
fn open_dashboard(app: AppHandle, page: Option<String>) -> Result<(), String> {
    let server = app
        .state::<AppState>()
        .inner
        .lock()
        .unwrap()
        .settings
        .server
        .clone();
    let page = match page.as_deref() {
        Some("approvals") => "/approvals",
        Some("devices") => "/devices",
        Some("audit") => "/audit",
        _ => "/dashboard",
    };
    app.opener()
        .open_url(format!("{server}{page}"), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_settings(
    app: AppHandle,
    notifications: bool,
    open_on_request: bool,
) -> Result<Snapshot, String> {
    {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().unwrap();
        inner.settings.notifications = notifications;
        inner.settings.open_on_request = open_on_request;
        store::save_settings(&state.dir, &inner.settings)?;
    }
    publish(&app);
    Ok(snapshot(&app))
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<Snapshot, String> {
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    }
    .map_err(|e| e.to_string())?;
    Ok(snapshot(&app))
}

#[tauri::command]
fn refresh(app: AppHandle) {
    wake(&app);
}

fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|n| !n.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_owned())
        })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Yönetim Merkezi".to_owned())
}

#[tauri::command]
fn default_name() -> String {
    computer_name()
}

/// Windows shows toasts of an unpackaged app only when its AppUserModelID is
/// registered; the per-user key needs no administrator rights.
#[cfg(windows)]
fn register_toast_identity(app: &AppHandle) {
    use winreg::enums::HKEY_CURRENT_USER;
    let identifier = app.config().identifier.clone();
    let key = format!("Software\\Classes\\AppUserModelId\\{identifier}");
    if let Ok((entry, _)) = winreg::RegKey::predef(HKEY_CURRENT_USER).create_subkey(&key) {
        let _ = entry.set_value("DisplayName", &"WECOMMANDER Yönetim Merkezi");
        let dir = app.state::<AppState>().dir.clone();
        let icon = dir.join("icon.png");
        if std::fs::create_dir_all(&dir).is_ok()
            && std::fs::write(&icon, include_bytes!("../icons/128x128.png")).is_ok()
        {
            let _ = entry.set_value("IconUri", &icon.to_string_lossy().to_string());
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Yönetim Merkezini aç", true, None::<&str>)?;
    let pending = MenuItem::with_id(
        app,
        "pending",
        "Bağlı değil — bağlanmak için aç",
        true,
        None::<&str>,
    )?;
    let autonomy = MenuItem::with_id(app, "autonomy", "Otonom mod kapalı", true, None::<&str>)?;
    let stop_autonomy = MenuItem::with_id(
        app,
        "stop_autonomy",
        "Otonom modu durdur (tüm cihazlar)",
        false,
        None::<&str>,
    )?;
    let dashboard =
        MenuItem::with_id(app, "dashboard", "Paneli tarayıcıda aç", true, None::<&str>)?;
    let notifications = app
        .state::<AppState>()
        .inner
        .lock()
        .unwrap()
        .settings
        .notifications;
    let notify_item = CheckMenuItem::with_id(
        app,
        "notify",
        "Bildirimler",
        true,
        notifications,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Çıkış", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &pending,
            &autonomy,
            &stop_autonomy,
            &PredefinedMenuItem::separator(app)?,
            &dashboard,
            &notify_item,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("WECOMMANDER Yönetim Merkezi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" | "pending" | "autonomy" => show_main(app),
            "stop_autonomy" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok((api, token)) = session(&app) {
                        match api.set_autonomy(&token, false, None, None, None).await {
                            Ok(()) => notify(
                                &app,
                                "WECOMMANDER",
                                "Otonom mod durduruldu. Onaylar yeniden isteniyor.",
                            ),
                            Err(e) => notify(&app, "WECOMMANDER", &e.message()),
                        }
                        sync(&app).await;
                    }
                });
            }
            "dashboard" => {
                let _ = open_dashboard(app.clone(), None);
            }
            "notify" => {
                let state = app.state::<AppState>();
                let mut inner = state.inner.lock().unwrap();
                inner.settings.notifications = !inner.settings.notifications;
                let _ = store::save_settings(&state.dir, &inner.settings);
                drop(inner);
                publish(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = tray_image(false, false) {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;
    let state = app.state::<AppState>();
    *state.tray.lock().unwrap() = Some(tray);
    *state.menus.lock().unwrap() = Some(Menus {
        pending,
        autonomy,
        stop_autonomy,
        notify: notify_item,
    });
    Ok(())
}

fn main() {
    let hidden = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .setup(move |app| {
            let dir = app.path().app_config_dir()?;
            let (settings, existed) = store::load_settings(&dir);
            let token = store::load_token(&dir, &settings.server);
            if !existed {
                let _ = store::save_settings(&dir, &settings);
                // First start: come back after every sign-in to Windows/macOS.
                let _ = app.autolaunch().enable();
            }
            let signed_in = token.is_some();
            app.manage(AppState {
                dir,
                inner: Mutex::new(Inner {
                    settings,
                    token,
                    ..Inner::default()
                }),
                tray: Mutex::new(None),
                menus: Mutex::new(None),
                wake: tokio::sync::Notify::new(),
            });
            #[cfg(windows)]
            register_toast_identity(app.handle());
            build_tray(app.handle())?;
            update_tray(app.handle());
            if !hidden || !signed_in {
                show_main(app.handle());
            }
            tauri::async_runtime::spawn(background(app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app in the tray; "Çıkış" quits.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            connect,
            cancel_connect,
            open_link,
            decide,
            autonomy_start,
            autonomy_stop,
            disconnect,
            open_dashboard,
            set_settings,
            set_autostart,
            refresh,
            default_name
        ])
        .run(tauri::generate_context!())
        .expect("WECOMMANDER Management Center failed to start");
}
