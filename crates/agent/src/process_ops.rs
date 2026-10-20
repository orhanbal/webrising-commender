use crate::policy::PathPolicy;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::Duration;
use sysinfo::{Pid, ProcessesToUpdate, Signal, System};
use tokio::process::Command;

const OUTPUT_LIMIT: usize = 1024 * 1024;

pub async fn exec(
    policy: &PathPolicy,
    command: &str,
    cwd: Option<&str>,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    if command.trim().is_empty() {
        return Err(anyhow!("command cannot be empty"));
    }
    if command.len() > 32_000 {
        return Err(anyhow!("command is too long"));
    }

    let workdir = match cwd {
        Some(raw) => Some(policy.resolve_existing(raw)?),
        None => policy.roots().first().cloned(),
    };

    #[cfg(windows)]
    let mut child = {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/D").arg("/S").arg("/C").arg(command);
        cmd
    };

    #[cfg(not(windows))]
    let mut child = {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-lc").arg(command);
        cmd
    };

    if let Some(dir) = workdir {
        child.current_dir(dir);
    }
    child.kill_on_drop(true);

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(100, 10 * 60_000));
    let output = tokio::time::timeout(timeout, child.output())
        .await
        .map_err(|_| anyhow!("process execution timed out"))??;

    let stdout = cap(output.stdout);
    let stderr = cap(output.stderr);

    Ok(json!({
        "exitCode": output.status.code(),
        "success": output.status.success(),
        "stdout": String::from_utf8_lossy(&stdout),
        "stderr": String::from_utf8_lossy(&stderr),
        "stdoutTruncated": stdout.len() == OUTPUT_LIMIT,
        "stderrTruncated": stderr.len() == OUTPUT_LIMIT
    }))
}

pub fn list() -> Result<Value> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let items: Vec<Value> = system
        .processes()
        .iter()
        .take(5000)
        .map(|(pid, process)| {
            json!({
                "pid": pid.as_u32(),
                "name": process.name().to_string_lossy(),
                "exe": process.exe().map(|p| p.to_string_lossy().to_string()),
                "cpu": process.cpu_usage(),
                "memory": process.memory()
            })
        })
        .collect();

    Ok(json!({ "items": items }))
}

pub fn kill(pid: u32) -> Result<Value> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let process = system
        .process(Pid::from_u32(pid))
        .ok_or_else(|| anyhow!("process not found"))?;

    let killed = process
        .kill_with(Signal::Term)
        .unwrap_or_else(|| process.kill());
    if !killed {
        return Err(anyhow!("process could not be terminated"));
    }
    Ok(json!({ "ok": true, "pid": pid }))
}

fn cap(mut data: Vec<u8>) -> Vec<u8> {
    if data.len() > OUTPUT_LIMIT {
        data.truncate(OUTPUT_LIMIT);
    }
    data
}
