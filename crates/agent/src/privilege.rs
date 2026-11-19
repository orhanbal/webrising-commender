//! Run as root (docs/AI_PERMISSIONS.md).
//!
//! Two keys: the person on the machine allows root once
//! (`install-linux.sh --allow-root` adds a sudoers drop-in and sets
//! `capabilities.allowRoot` in the agent config), and an admin turns on
//! "run as root" for the device in the web panel. The gateway then sends
//! `runAs: "root"` inside the signed action. This module is the agent's own
//! half: a root action is refused unless the local ceiling allows it, so the
//! gateway alone can never escalate past the machine owner's choice.
//!
//! Commands go through `sudo -n` with an argument vector; nothing is built
//! into a shell line beyond the command text process_exec already runs.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use crate::config::DeviceCapabilities;

/// The refusal when the gateway asks for root but this machine does not allow it.
pub const ROOT_NOT_ALLOWED: &str =
    "device_policy_denied: running as root is not allowed on this device \
     (the machine owner can allow it with: sudo bash install-linux.sh --allow-root)";

/// The agent process itself runs as root (uid 0).
pub fn agent_is_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// `sudo` from a fixed system location (never from PATH, which the service
/// user could change).
#[cfg(unix)]
pub fn sudo_program() -> &'static str {
    for candidate in ["/usr/bin/sudo", "/bin/sudo", "/usr/local/bin/sudo"] {
        if std::path::Path::new(candidate).exists() {
            return candidate;
        }
    }
    "/usr/bin/sudo"
}

/// `sudo -n true` succeeds within a few seconds.
#[cfg(unix)]
pub fn sudo_works() -> bool {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let Ok(mut child) = Command::new(sudo_program())
        .args(["-n", "--", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Whether the local ceiling allows root actions at all (config only; the
/// sudoers drop-in is checked by sudo itself).
pub fn ceiling_allows_root(capabilities: DeviceCapabilities) -> bool {
    ceiling_allows(capabilities.allow_root, agent_is_root())
}

/// The ceiling rule: the owner's allow_root, or an agent that is root
/// already (nothing to escalate); never on Windows.
fn ceiling_allows(allow_root: bool, process_is_root: bool) -> bool {
    cfg!(unix) && (allow_root || process_is_root)
}

/// What the agent reports to the gateway as `rootCapable`: the ceiling is
/// set and sudo works without a password, or the agent already runs as root.
pub fn root_capable(capabilities: DeviceCapabilities) -> bool {
    #[cfg(unix)]
    {
        agent_is_root() || (capabilities.allow_root && sudo_works())
    }
    #[cfg(not(unix))]
    {
        let _ = capabilities;
        false
    }
}

/// Refuses a root action unless this machine's owner allowed root.
pub fn ensure_root_allowed(capabilities: DeviceCapabilities) -> Result<()> {
    if ceiling_allows_root(capabilities) {
        Ok(())
    } else {
        Err(anyhow!(ROOT_NOT_ALLOWED))
    }
}

/// Whether a root action must go through sudo (false when already root).
pub fn needs_sudo() -> bool {
    !agent_is_root()
}

/// An fs_write error that root could get past.
pub fn is_permission_error(error: &anyhow::Error) -> bool {
    if error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::PermissionDenied)
    }) {
        return true;
    }
    let text = format!("{error:#}");
    text.contains("os error 13") || text.contains("Permission denied")
}

#[cfg(unix)]
async fn sudo_run(args: &[&std::ffi::OsStr], stdin: Option<&[u8]>) -> Result<Vec<u8>> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut command = tokio::process::Command::new(sudo_program());
    command
        .arg("-n")
        .arg("--")
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().context("failed to start sudo")?;
    if let Some(bytes) = stdin {
        let mut pipe = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("sudo stdin unavailable"))?;
        pipe.write_all(bytes)
            .await
            .context("writing to sudo failed")?;
        drop(pipe);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| anyhow!("root file operation timed out"))??;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "root file operation failed: {}",
            message.trim().chars().take(300).collect::<String>()
        ));
    }
    Ok(output.stdout)
}

/// fs_write as root: the same allowed-folder resolution and size limit as the
/// normal write, then `sudo -n tee -- <path>` (an existing file keeps its
/// owner and mode). No undo snapshot. expected_sha256 is checked against the
/// current content read with `sudo -n cat`.
#[cfg(unix)]
pub async fn write_file_as_root(
    policy: &crate::policy::PathPolicy,
    raw: &str,
    content_base64: &str,
    create_parents: bool,
    expected_sha256: Option<&str>,
) -> Result<Value> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use sha2::{Digest, Sha256};
    let path = policy.resolve_for_create(raw)?;
    let bytes = STANDARD
        .decode(content_base64)
        .context("contentBase64 is not valid base64")?;
    if bytes.len() > crate::fs_ops::HARD_WRITE_MAX {
        return Err(anyhow!(
            "write exceeds hard limit of {} bytes",
            crate::fs_ops::HARD_WRITE_MAX
        ));
    }
    if let Some(expected) = expected_sha256 {
        let current = sudo_run(&["cat".as_ref(), "--".as_ref(), path.as_os_str()], None)
            .await
            .map_err(|_| anyhow!("file_changed_since_read"))?;
        let sha = format!("{:x}", Sha256::digest(&current));
        if !sha.eq_ignore_ascii_case(expected) {
            return Err(anyhow!("file_changed_since_read"));
        }
    }
    if create_parents && expected_sha256.is_none() {
        if let Some(parent) = path.parent() {
            sudo_run(
                &[
                    "mkdir".as_ref(),
                    "-p".as_ref(),
                    "--".as_ref(),
                    parent.as_os_str(),
                ],
                None,
            )
            .await?;
        }
    }
    sudo_run(
        &["tee".as_ref(), "--".as_ref(), path.as_os_str()],
        Some(&bytes),
    )
    .await?;
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "size": bytes.len(),
        "sha256": format!("{:x}", Sha256::digest(&bytes)),
        "runAs": "root",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ceiling_is_off_by_default_and_refuses_root() {
        let capabilities = DeviceCapabilities::default();
        assert!(!capabilities.allow_root);
        if !agent_is_root() {
            assert!(!ceiling_allows_root(capabilities));
            let error = ensure_root_allowed(capabilities).unwrap_err().to_string();
            assert!(error.contains("not allowed"), "{error}");
            assert!(!root_capable(capabilities));
        }
    }

    #[test]
    fn without_the_owners_ceiling_a_non_root_agent_never_escalates() {
        // Independent of the uid the tests run as.
        assert!(!ceiling_allows(false, false));
        assert_eq!(ceiling_allows(true, false), cfg!(unix));
        assert_eq!(ceiling_allows(false, true), cfg!(unix));
    }

    #[test]
    fn the_ceiling_allows_root_only_on_unix() {
        let capabilities = DeviceCapabilities {
            allow_root: true,
            ..DeviceCapabilities::default()
        };
        assert_eq!(ceiling_allows_root(capabilities), cfg!(unix));
    }

    #[test]
    fn permission_errors_are_recognised() {
        let io = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(is_permission_error(&anyhow::Error::from(io)));
        assert!(is_permission_error(&anyhow!(
            "open failed: Permission denied (os error 13)"
        )));
        assert!(!is_permission_error(&anyhow!(
            "path is outside configured allowed roots"
        )));
    }
}
