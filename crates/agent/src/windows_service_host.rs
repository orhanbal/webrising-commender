#![cfg(windows)]

use crate::{config::AgentConfig, run_until_shutdown};
use anyhow::{anyhow, Context, Result};
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::OnceLock,
    time::Duration,
};
use tokio::sync::watch;
use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};

const SERVICE_NAME: &str = "WebRisingCommender";
static CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();

define_windows_service!(ffi_service_main, service_main);

pub fn dispatch(config_path: PathBuf) -> Result<()> {
    CONFIG_PATH
        .set(config_path)
        .map_err(|_| anyhow!("Windows service config path was already initialized"))?;

    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("failed to connect to the Windows Service Control Manager")
}

fn service_main(_arguments: Vec<OsString>) {
    if let Err(error) = run_service() {
        eprintln!("WebRising Commender service failed: {error:#}");
    }
}

fn run_service() -> Result<()> {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            ServiceControl::Stop => {
                let _ = shutdown_tx.send(true);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };

    let status_handle =
        service_control_handler::register(SERVICE_NAME, event_handler)
            .context("failed to register Windows service control handler")?;

    status_handle
        .set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP))
        .context("failed to report Windows service Running state")?;

    let config_path = CONFIG_PATH
        .get()
        .cloned()
        .ok_or_else(|| anyhow!("Windows service config path is unavailable"))?;
    let config = AgentConfig::load(&config_path)?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to create Windows service async runtime")?;

    let run_result = runtime.block_on(run_until_shutdown(config, shutdown_rx));

    status_handle
        .set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()))
        .context("failed to report Windows service Stopped state")?;

    run_result
}

fn status(state: ServiceState, controls_accepted: ServiceControlAccept) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    }
}
