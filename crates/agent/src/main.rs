mod approval;
mod config;
mod docx_ops;
mod fs_ops;
mod image_ops;
mod ops;
mod policy;
mod process_ops;
mod protocol;
mod spreadsheet_ops;
mod system_ops;
mod task_manager;
mod terminal;
#[cfg(windows)]
mod windows_service_host;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use config::{default_allowed_root, AgentConfig, EnrollmentResponse, RouteResponse};
use futures_util::{Sink, SinkExt, StreamExt};
use policy::PathPolicy;
use protocol::{AgentAction, AgentError, AgentMessage, GatewayMessage};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use task_manager::TaskManager;
use terminal::TerminalManager;
use tokio::sync::{watch, Mutex};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
        Message,
    },
};
use tracing::{error, info, warn};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
struct ActiveRequest {
    handle: tokio::task::AbortHandle,
    cancelled: Arc<AtomicBool>,
    is_search: bool,
}

#[derive(Parser)]
#[command(
    name = "webrising-commender",
    version,
    about = "WebRising Commender native agent"
)]
struct Cli {
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Enroll {
        #[arg(long)]
        control_url: String,
        #[arg(long, allow_hyphen_values = true)]
        pairing_code: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long = "allowed-root")]
        allowed_roots: Vec<PathBuf>,
    },
    Run,
    #[cfg(windows)]
    Service,
    PrintConfig,
    Doctor,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,webrising_commender=info".into()),
        )
        .init();

    let cli = Cli::parse();
    let config_path = match cli.config {
        Some(path) => path,
        None => AgentConfig::default_path()?,
    };

    match cli.command {
        Command::Enroll {
            control_url,
            pairing_code,
            name,
            allowed_roots,
        } => {
            enroll(
                &config_path,
                &control_url,
                &pairing_code,
                name,
                allowed_roots,
            )
            .await
        }
        Command::Run => {
            let config = AgentConfig::load(&config_path)?;
            run(config).await
        }
        #[cfg(windows)]
        Command::Service => windows_service_host::dispatch(config_path),
        Command::PrintConfig => {
            let config = AgentConfig::load(&config_path)?;
            println!("{}", config.masked_json()?);
            Ok(())
        }
        Command::Doctor => {
            let config = AgentConfig::load(&config_path)?;
            let policy = PathPolicy::new(&config.allowed_roots)?;
            println!("config: ok");
            println!("device: {}", config.device_id);
            println!("gateway: {}", config.gateway_ws_url);
            println!("allowed roots: {}", policy.roots().len());
            for root in policy.roots() {
                println!("  - {}", root.display());
            }
            Ok(())
        }
    }
}

async fn enroll(
    config_path: &std::path::Path,
    control_url: &str,
    pairing_code: &str,
    name: Option<String>,
    mut allowed_roots: Vec<PathBuf>,
) -> Result<()> {
    if allowed_roots.is_empty() {
        allowed_roots.push(default_allowed_root()?);
    }

    let hostname = hostname::get()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let platform = std::env::consts::OS.to_owned();
    let endpoint = format!("{}/api/agent/enroll", control_url.trim_end_matches('/'));

    let response = reqwest::Client::new()
        .post(&endpoint)
        .json(&serde_json::json!({
            "pairingCode": pairing_code,
            "name": name,
            "hostname": hostname,
            "platform": platform
        }))
        .send()
        .await
        .context("enrollment request failed")?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "enrollment rejected: HTTP {} {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ));
    }

    let enrolled: EnrollmentResponse = response.json().await?;
    let config = AgentConfig {
        device_id: enrolled.device_id,
        device_token: enrolled.device_token,
        approval_key: enrolled.approval_key,
        gateway_ws_url: enrolled.gateway_ws_url,
        control_url: control_url.trim_end_matches('/').to_owned(),
        name: name.unwrap_or_else(|| hostname.clone()),
        allowed_roots,
    };

    config.save(config_path)?;
    // Re-load to canonicalize roots and fail before claiming success.
    AgentConfig::load(config_path)?;
    println!("Enrollment complete.");
    println!("Config: {}", config_path.display());
    println!("Device: {}", config.device_id);
    Ok(())
}

async fn run(config: AgentConfig) -> Result<()> {
    let (_shutdown_tx, shutdown_rx) = watch::channel(false);
    run_until_shutdown(config, shutdown_rx).await
}

pub(crate) async fn run_until_shutdown(
    config: AgentConfig,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let policy = Arc::new(PathPolicy::new(&config.allowed_roots)?);
    let terminals = TerminalManager::default();
    let tasks = TaskManager::default();
    let active = Arc::new(Mutex::new(HashMap::<String, ActiveRequest>::new()));

    let mut backoff = Duration::from_secs(1);
    let mut gateway_ws_url = config.gateway_ws_url.clone();
    loop {
        if *shutdown.borrow() {
            abort_active(&active).await;
            return Ok(());
        }

        let result = connected_loop(
            &config,
            &gateway_ws_url,
            Arc::clone(&policy),
            terminals.clone(),
            tasks.clone(),
            Arc::clone(&active),
            shutdown.clone(),
        )
        .await;
        // A disconnected relay must not leave stale native scans running.
        abort_active(&active).await;

        if *shutdown.borrow() {
            abort_active(&active).await;
            return Ok(());
        }

        let connected = match result {
            Ok(()) => {
                warn!("gateway connection closed");
                true
            }
            Err(error) => {
                warn!(%error, "gateway connection failed");
                false
            }
        };

        if connected {
            backoff = Duration::from_secs(1);
        }

        if let Some(route) = refresh_gateway_route(&config).await {
            if route != gateway_ws_url {
                info!(gateway = %route, "updated gateway route");
                gateway_ws_url = route;
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    abort_active(&active).await;
                    return Ok(());
                }
            }
        }

        if !connected {
            backoff = std::cmp::min(backoff.saturating_mul(2), Duration::from_secs(30));
        }
    }
}

async fn refresh_gateway_route(config: &AgentConfig) -> Option<String> {
    let endpoint = format!(
        "{}/api/agent/route",
        config.control_url.trim_end_matches('/')
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let response = match client
        .post(endpoint)
        .header("x-device-id", &config.device_id)
        .bearer_auth(&config.device_token)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            warn!(%error, "gateway route refresh failed");
            return None;
        }
    };

    if !response.status().is_success() {
        warn!(
            status = %response.status(),
            "gateway route refresh rejected"
        );
        return None;
    }

    let route: RouteResponse = match response.json().await {
        Ok(route) => route,
        Err(error) => {
            warn!(%error, "invalid gateway route response");
            return None;
        }
    };

    if !route.gateway_ws_url.starts_with("ws://") && !route.gateway_ws_url.starts_with("wss://") {
        warn!("route response returned a non-WebSocket URL");
        return None;
    }

    if let Some(relay_id) = route.relay_id.as_deref() {
        info!(
            relay = relay_id,
            region = route.region.as_deref().unwrap_or("unknown"),
            "selected regional relay"
        );
    }

    Some(route.gateway_ws_url)
}

async fn abort_active(active: &Arc<Mutex<HashMap<String, ActiveRequest>>>) {
    let handles: Vec<_> = active
        .lock()
        .await
        .drain()
        .map(|(_, request)| request)
        .collect();
    for request in handles {
        request.cancelled.store(true, Ordering::Relaxed);
        request.handle.abort();
    }
}

async fn connected_loop(
    config: &AgentConfig,
    gateway_ws_url: &str,
    policy: Arc<PathPolicy>,
    terminals: TerminalManager,
    tasks: TaskManager,
    active: Arc<Mutex<HashMap<String, ActiveRequest>>>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let mut request = gateway_ws_url.to_owned().into_client_request()?;
    request.headers_mut().insert(
        HeaderName::from_static("x-device-id"),
        HeaderValue::from_str(&config.device_id)?,
    );
    request.headers_mut().insert(
        HeaderName::from_static("authorization"),
        HeaderValue::from_str(&format!("Bearer {}", config.device_token))?,
    );

    let (stream, _) = connect_async(request).await?;
    info!("connected to gateway");

    let (writer, mut reader) = stream.split();
    let writer = Arc::new(Mutex::new(writer));

    send(
        &writer,
        AgentMessage::Hello {
            device_id: config.device_id.clone(),
            hostname: hostname::get()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            os: std::env::consts::OS.to_owned(),
            version: VERSION.to_owned(),
            capabilities: vec![
                "fs".into(),
                "xlsx-read".into(),
                "docx-read".into(),
                "process".into(),
                "task".into(),
                "pty".into(),
                "system".into(),
            ],
        },
    )
    .await?;

    let heartbeat_writer = Arc::clone(&writer);
    let heartbeat = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(20));
        loop {
            interval.tick().await;
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_secs())
                .unwrap_or(0)
                .to_string();
            if send(&heartbeat_writer, AgentMessage::Heartbeat { timestamp })
                .await
                .is_err()
            {
                break;
            }
        }
    });

    loop {
        let message = tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
                continue;
            }
            message = reader.next() => message,
        };

        let Some(message) = message else {
            break;
        };
        let message = message?;
        match message {
            Message::Text(text) => {
                let gateway: GatewayMessage = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(error) => {
                        warn!(%error, "invalid gateway message");
                        continue;
                    }
                };

                match gateway {
                    GatewayMessage::Request {
                        request_id,
                        action,
                        approval_token,
                    } => {
                        let task_writer = Arc::clone(&writer);
                        let task_policy = Arc::clone(&policy);
                        let task_terminals = terminals.clone();
                        let persistent_tasks = tasks.clone();
                        let active_map = Arc::clone(&active);
                        let id_for_task = request_id.clone();
                        let approval_key = config.approval_key.clone();
                        let device_id = config.device_id.clone();
                        let is_search = matches!(
                            &action,
                            AgentAction::FsSearch { .. } | AgentAction::TextSearch { .. }
                        );
                        let cancelled = Arc::new(AtomicBool::new(false));
                        let task_cancelled = Arc::clone(&cancelled);
                        // Register the handle before allowing a fast task to complete.
                        let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();

                        let handle = tokio::spawn(async move {
                            if start_rx.await.is_err() {
                                return;
                            }
                            let (progress_tx, mut progress_rx) =
                                tokio::sync::mpsc::channel::<serde_json::Value>(8);
                            let progress_writer = Arc::clone(&task_writer);
                            let progress_request = id_for_task.clone();
                            let progress_forwarder = tokio::spawn(async move {
                                while let Some(progress) = progress_rx.recv().await {
                                    let items =
                                        progress["items"].as_array().cloned().unwrap_or_default();
                                    let scanned_entries =
                                        progress["scannedEntries"].as_u64().unwrap_or(0) as usize;
                                    let scanned_bytes =
                                        progress["scannedBytes"].as_u64().unwrap_or(0);
                                    if send(
                                        &progress_writer,
                                        AgentMessage::SearchProgress {
                                            request_id: progress_request.clone(),
                                            items,
                                            scanned_entries,
                                            scanned_bytes,
                                        },
                                    )
                                    .await
                                    .is_err()
                                    {
                                        break;
                                    }
                                }
                            });
                            let result = ops::execute(
                                ops::ExecutionContext {
                                    policy: &task_policy,
                                    terminals: &task_terminals,
                                    tasks: &persistent_tasks,
                                    approval_token: approval_token.as_deref(),
                                    approval_key: &approval_key,
                                    device_id: &device_id,
                                    cancelled: task_cancelled,
                                    // Consume the sender on every path. If this is not a
                                    // search, then_some drops it immediately, allowing the
                                    // progress forwarder to exit instead of deadlocking the
                                    // normal operation while waiting for a channel close.
                                    search_progress: is_search.then_some(progress_tx),
                                },
                                action,
                            )
                            .await;
                            // Flush ordered progress messages before the terminal result.
                            let _ = progress_forwarder.await;

                            let message = match result {
                                Ok(data) => AgentMessage::Result {
                                    request_id: id_for_task.clone(),
                                    ok: true,
                                    data: Some(data),
                                    error: None,
                                },
                                Err(error) => AgentMessage::Result {
                                    request_id: id_for_task.clone(),
                                    ok: false,
                                    data: None,
                                    error: Some(AgentError {
                                        code: "operation_failed".into(),
                                        message: error.to_string(),
                                    }),
                                },
                            };

                            if let Err(error) = send(&task_writer, message).await {
                                error!(%error, "failed to send operation result");
                            }
                            active_map.lock().await.remove(&id_for_task);
                        });

                        active.lock().await.insert(
                            request_id,
                            ActiveRequest {
                                handle: handle.abort_handle(),
                                cancelled,
                                is_search,
                            },
                        );
                        let _ = start_tx.send(());
                    }
                    GatewayMessage::Cancel { request_id } => {
                        let request = active.lock().await.get(&request_id).cloned();
                        if let Some(request) = request {
                            request.cancelled.store(true, Ordering::Relaxed);
                            // Tokio abort does not stop a running blocking scan.
                            // Let the scan observe cancellation and finish cooperatively.
                            if !request.is_search {
                                active.lock().await.remove(&request_id);
                                request.handle.abort();
                            }
                        }
                    }
                    GatewayMessage::Ping { .. } => {}
                }
            }
            Message::Close(_) => break,
            Message::Ping(payload) => {
                writer.lock().await.send(Message::Pong(payload)).await?;
            }
            _ => {}
        }
    }

    heartbeat.abort();
    Ok(())
}

async fn send<S>(writer: &Arc<Mutex<S>>, message: AgentMessage) -> Result<()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let payload = serde_json::to_string(&message)?;
    writer
        .lock()
        .await
        .send(Message::Text(payload.into()))
        .await?;
    Ok(())
}
