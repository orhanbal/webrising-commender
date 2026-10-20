mod config;
mod fs_ops;
mod ops;
mod policy;
mod process_ops;
mod protocol;
mod system_ops;
mod task_manager;
mod terminal;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use config::{default_allowed_root, AgentConfig, EnrollmentResponse};
use futures_util::{Sink, SinkExt, StreamExt};
use policy::PathPolicy;
use protocol::{AgentError, AgentMessage, GatewayMessage};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use task_manager::TaskManager;
use terminal::TerminalManager;
use tokio::sync::Mutex;
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
    let policy = Arc::new(PathPolicy::new(&config.allowed_roots)?);
    let terminals = TerminalManager::default();
    let tasks = TaskManager::default();
    let active = Arc::new(Mutex::new(
        HashMap::<String, tokio::task::AbortHandle>::new(),
    ));

    let mut backoff = Duration::from_secs(1);
    loop {
        let connected = match connected_loop(
            &config,
            Arc::clone(&policy),
            terminals.clone(),
            tasks.clone(),
            Arc::clone(&active),
        )
        .await
        {
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

        tokio::time::sleep(backoff).await;
        if !connected {
            backoff = std::cmp::min(backoff.saturating_mul(2), Duration::from_secs(30));
        }
    }
}

async fn connected_loop(
    config: &AgentConfig,
    policy: Arc<PathPolicy>,
    terminals: TerminalManager,
    tasks: TaskManager,
    active: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
) -> Result<()> {
    let mut request = config.gateway_ws_url.clone().into_client_request()?;
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

    while let Some(message) = reader.next().await {
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

                        let handle = tokio::spawn(async move {
                            let result = ops::execute(
                                &task_policy,
                                &task_terminals,
                                &persistent_tasks,
                                action,
                                approval_token.as_deref(),
                            )
                            .await;

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

                        active
                            .lock()
                            .await
                            .insert(request_id, handle.abort_handle());
                    }
                    GatewayMessage::Cancel { request_id } => {
                        if let Some(handle) = active.lock().await.remove(&request_id) {
                            handle.abort();
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
