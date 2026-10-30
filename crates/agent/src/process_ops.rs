use crate::policy::PathPolicy;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{process::Stdio, time::Duration};
use sysinfo::{Pid, ProcessesToUpdate, Signal, System};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const OUTPUT_LIMIT: usize = 1024 * 1024;

// Each shell is placed in its own Unix process group. Killing only the shell
// leaves background children alive, including after task cancellation. The
// guard also runs when Tokio aborts the executing future.
#[cfg(unix)]
struct ProcessGroupGuard {
    pgid: i32,
}

#[cfg(unix)]
impl ProcessGroupGuard {
    fn new(pid: u32) -> Result<Self> {
        let pgid = i32::try_from(pid).context("invalid child process id")?;
        if pgid <= 0 {
            return Err(anyhow!("invalid child process group"));
        }
        Ok(Self { pgid })
    }

    fn signal(&self, signal: i32) {
        // A negative PID addresses the child's private process group, never
        // the Agent's own group. ESRCH is expected after normal completion.
        unsafe {
            libc::kill(-self.pgid, signal);
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        self.signal(libc::SIGKILL);
    }
}

pub async fn exec(
    policy: &PathPolicy,
    command: &str,
    cwd: Option<&str>,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    exec_with_timeout_bounds(policy, command, cwd, timeout_ms, 30_000, 10 * 60_000).await
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
    #[cfg(unix)]
    process.as_std_mut().process_group(0);
    process
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = process.spawn().context("failed to start command")?;
    #[cfg(unix)]
    let group = ProcessGroupGuard::new(
        child
            .id()
            .ok_or_else(|| anyhow!("spawned process has no pid"))?,
    )?;
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
            #[cfg(unix)]
            {
                group.signal(libc::SIGTERM);
                tokio::time::sleep(Duration::from_millis(250)).await;
                group.signal(libc::SIGKILL);
            }
            let _ = child.kill().await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(anyhow!("process execution timed out"));
        }
    };

    // A successful shell can still have background children holding its pipes.
    // Reap those descendants before joining stdout/stderr readers.
    #[cfg(unix)]
    group.signal(libc::SIGKILL);

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

// process_kill is a HIGH-risk, approval-gated operation. Never allow it to
// terminate the Agent, its supervisors, or PID 1. Snapshot descendants before
// sending signals so a parent cannot orphan its still-running children.
pub fn kill(pid: u32) -> Result<Value> {
    if pid <= 1 {
        return Err(anyhow!("protected process cannot be terminated"));
    }

    let target = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    // An Agent may be started by a service manager or interactive shell.
    // Killing any ancestor would sever the Agent's own control plane.
    let mut ancestor = Some(Pid::from_u32(std::process::id()));
    let mut ancestors_seen = std::collections::HashSet::new();
    while let Some(current) = ancestor {
        if current == target {
            return Err(anyhow!("protected process cannot be terminated"));
        }
        if !ancestors_seen.insert(current) {
            break;
        }
        ancestor = system.process(current).and_then(|process| process.parent());
    }

    let original = system
        .process(target)
        .ok_or_else(|| anyhow!("process not found"))?;
    let target_start = original.start_time();

    let mut children: std::collections::HashMap<Pid, Vec<Pid>> = std::collections::HashMap::new();
    for (child_pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(*child_pid);
        }
    }

    // Postorder ensures descendants are signaled before their parent.
    // Refuse excessively large trees rather than partially terminating one.
    let mut stack = vec![(target, false)];
    let mut seen = std::collections::HashSet::new();
    let mut order = Vec::new();
    while let Some((current, visited)) = stack.pop() {
        if visited {
            order.push(current);
            continue;
        }
        if !seen.insert(current) {
            continue;
        }
        if seen.len() > 4096 {
            return Err(anyhow!("process tree exceeds safe termination limit"));
        }
        stack.push((current, true));
        if let Some(descendants) = children.get(&current) {
            for child in descendants {
                stack.push((*child, false));
            }
        }
    }

    let snapshot: Vec<(Pid, u64)> = order
        .into_iter()
        .filter_map(|id| system.process(id).map(|process| (id, process.start_time())))
        .collect();

    // Reject a reused root PID and skip descendants whose PID was recycled
    // between snapshots. This is best-effort tree termination, not an atomic
    // OS-level process-tree guarantee (Windows Job Objects remain pending).
    let mut current = System::new();
    current.refresh_processes(ProcessesToUpdate::All, true);
    if current.process(target).map(|process| process.start_time()) != Some(target_start) {
        return Err(anyhow!("process changed before termination"));
    }

    let mut terminated_descendants = 0usize;
    for (id, start_time) in &snapshot {
        let Some(process) = current.process(*id) else {
            continue;
        };
        if process.start_time() != *start_time {
            continue;
        }
        let killed = process
            .kill_with(Signal::Term)
            .unwrap_or_else(|| process.kill());
        if *id == target && !killed {
            return Err(anyhow!("process could not be terminated"));
        }
        if *id != target && killed {
            terminated_descendants += 1;
        }
    }

    // SIGTERM is advisory: shells and descendants can ignore it. After a
    // bounded grace period, escalate only the original, still-identifiable
    // process-tree snapshot. Never sweep unrelated new descendants or PIDs
    // whose recorded start time changed. This is best-effort, not pidfd-based
    // atomic process ownership.
    let mut escalated_processes = 0usize;
    #[cfg(unix)]
    {
        std::thread::sleep(Duration::from_millis(250));
        current.refresh_processes(ProcessesToUpdate::All, true);
        for (id, start_time) in &snapshot {
            let Some(process) = current.process(*id) else {
                continue;
            };
            if process.start_time() != *start_time {
                continue;
            }
            if process
                .kill_with(Signal::Kill)
                .unwrap_or_else(|| process.kill())
            {
                escalated_processes += 1;
            }
        }

        // A successful signal delivery is not proof of termination. Wait
        // briefly for the original PID/start-time snapshot to become exited
        // or zombie; never claim success while a resistant process remains
        // runnable. Zombies are already dead and await their own parent.
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        loop {
            current.refresh_processes(ProcessesToUpdate::All, true);
            let remaining = snapshot
                .iter()
                .filter(|(id, started)| {
                    current.process(*id).is_some_and(|process| {
                        process.start_time() == *started
                            && process.status() != sysinfo::ProcessStatus::Zombie
                    })
                })
                .count();
            if remaining == 0 {
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err(anyhow!(
                    "process tree termination not confirmed for {remaining} processes"
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    Ok(json!({
        "ok": true,
        "pid": pid,
        "signaledDescendants": terminated_descendants,
        "escalatedProcesses": escalated_processes,
        "terminationConfirmed": cfg!(unix)
    }))
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

    #[test]
    fn process_kill_rejects_agent_and_system_processes() {
        assert!(kill(1).unwrap_err().to_string().contains("protected"));
        assert!(kill(std::process::id())
            .unwrap_err()
            .to_string()
            .contains("protected"));
    }

    #[cfg(unix)]
    #[test]
    fn process_kill_escalates_term_ignoring_descendants() {
        let root = std::env::temp_dir().join(format!("wc-kill-term-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let ready = root.join("ready");
        let marker = root.join("leaked");
        let command = format!(
            "trap '' TERM; (sleep 2; printf leaked > '{}') & printf ready > '{}'; wait",
            marker.display(),
            ready.display()
        );
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(command)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "TERM-ignoring child did not start");
        let result = kill(child.id()).unwrap();
        assert!(result["escalatedProcesses"].as_u64().unwrap_or(0) >= 1);
        assert_eq!(result["terminationConfirmed"], true);
        assert!(
            child.try_wait().unwrap().is_some(),
            "process_kill returned before the direct child exited"
        );
        std::thread::sleep(Duration::from_millis(2300));
        assert!(!marker.exists(), "SIGTERM-ignoring descendant survived");
        let _ = child.kill();
        let _ = child.wait();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_background_process_group() {
        let root = std::env::temp_dir().join(format!("wc-proc-timeout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let marker = root.join("orphaned");
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let command = format!("(sleep 1; printf leaked > '{}') & wait", marker.display());
        let result = exec(&policy, &command, None, Some(150)).await;
        assert!(result.unwrap_err().to_string().contains("timed out"));
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!marker.exists(), "timed-out descendant survived");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn abort_kills_background_process_group() {
        let root = std::env::temp_dir().join(format!("wc-proc-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let ready = root.join("ready");
        let marker = root.join("orphaned");
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let command = format!(
            "printf ready > '{}'; (sleep 1; printf leaked > '{}') & wait",
            ready.display(),
            marker.display()
        );
        let job =
            tokio::spawn(async move { exec_task(&policy, &command, None, Some(10_000)).await });
        let started = tokio::time::timeout(Duration::from_secs(5), async {
            while !ready.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(started.is_ok(), "shell did not start");
        job.abort();
        let _ = job.await;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!marker.exists(), "canceled descendant survived");
        std::fs::remove_dir_all(root).unwrap();
    }
}
