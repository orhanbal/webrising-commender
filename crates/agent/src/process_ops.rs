use crate::policy::PathPolicy;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use sysinfo::{Pid, ProcessesToUpdate, Signal, System};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const OUTPUT_LIMIT: usize = 1024 * 1024;

pub async fn exec(
    policy: &PathPolicy,
    command: &str,
    cwd: Option<&str>,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    exec_with_timeout_bounds(
        policy,
        command,
        cwd,
        timeout_ms,
        30_000,
        10 * 60_000,
    )
    .await
}

pub async fn exec_task(
    policy: &PathPolicy,
    command: &str,
    cwd: Option<&str>,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    exec_with_timeout_bounds(
        policy,
        command,
        cwd,
        timeout_ms,
        60 * 60_000,
        24 * 60 * 60_000,
    )
    .await
}

async fn exec_with_timeout_bounds(
    policy: &PathPolicy,
    command: &str,
    cwd: Option<&str>,
    timeout_ms: Option<u64>,
    default_timeout_ms: u64,
    max_timeout_ms: u64,
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
    let mut process = {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/D").arg("/S").arg("/C").arg(command);
        cmd
    };

    #[cfg(not(windows))]
    let mut process = {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-lc").arg(command);
        cmd
    };

    if let Some(dir) = workdir {
        process.current_dir(dir);
    }
    process
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = process.spawn().context("failed to start command")?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("failed to capture process stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("failed to capture process stderr"))?;

    let stdout_task = tokio::spawn(read_capped(stdout, OUTPUT_LIMIT));
    let stderr_task = tokio::spawn(read_capped(stderr, OUTPUT_LIMIT));

    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(default_timeout_ms)
            .clamp(100, max_timeout_ms),
    );
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.context("failed while waiting for command")?,
        Err(_) => {
            let _ = child.kill().await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(anyhow!("process execution timed out"));
        }
    };

    let stdout = stdout_task
        .await
        .map_err(|error| anyhow!("stdout capture task failed: {error}"))??;
    let stderr = stderr_task
        .await
        .map_err(|error| anyhow!("stderr capture task failed: {error}"))??;

    Ok(json!({
        "exitCode": status.code(),
        "success": status.success(),
        "stdout": String::from_utf8_lossy(&stdout.data),
        "stderr": String::from_utf8_lossy(&stderr.data),
        "stdoutTruncated": stdout.truncated,
        "stderrTruncated": stderr.truncated
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

struct CapturedOutput {
    data: Vec<u8>,
    truncated: bool,
}

async fn read_capped<R>(mut reader: R, limit: usize) -> Result<CapturedOutput>
where
    R: AsyncRead + Unpin,
{
    let mut data = Vec::with_capacity(limit.min(64 * 1024));
    let mut truncated = false;
    let mut chunk = [0_u8; 8192];

    loop {
        let size = reader.read(&mut chunk).await?;
        if size == 0 {
            break;
        }

        let remaining = limit.saturating_sub(data.len());
        let keep = remaining.min(size);
        if keep > 0 {
            data.extend_from_slice(&chunk[..keep]);
        }
        if keep < size {
            truncated = true;
        }
    }

    Ok(CapturedOutput { data, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn capture_is_bounded_and_marks_truncation() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let write = tokio::spawn(async move {
            writer.write_all(b"0123456789").await.unwrap();
        });

        let captured = read_capped(reader, 4).await.unwrap();
        write.await.unwrap();

        assert_eq!(captured.data, b"0123");
        assert!(captured.truncated);
    }
}
