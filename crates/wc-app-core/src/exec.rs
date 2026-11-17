//! `hosts.exec`: one command on a saved SSH host, non-interactively, for
//! scheduled tasks. An exec channel (no pseudo-terminal, standard input
//! closed): no startup command, no history entry, no session log. Silent
//! only, like the monitors: the saved credential or this computer's own keys
//! and an already trusted host key. Anything that would need a person
//! (a password, approving a host key) fails with a code the app can show.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::AppState;

/// Output kept per run (the end: the error is usually last).
pub const MAX_OUTPUT: usize = 64 * 1024;
pub const MAX_COMMAND: usize = 4000;
pub const MAX_TIMEOUT_SEC: u64 = 3600;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    /// `None` when the command gave no exit status (timed out, killed).
    pub exit_code: Option<u32>,
    /// stdout and stderr interleaved as received, at most 64 KiB (the tail).
    pub output: String,
    pub timed_out: bool,
    /// Earlier output was dropped to stay within 64 KiB.
    pub truncated: bool,
}

/// 1..=3600 seconds (0 means the 600 s default).
pub fn timeout_for(timeout_sec: u64) -> Duration {
    let secs = if timeout_sec == 0 { 600 } else { timeout_sec };
    Duration::from_secs(secs.clamp(1, MAX_TIMEOUT_SEC))
}

pub fn check_command(command: &str) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("invalid_command: the command is empty".into());
    }
    if command.len() > MAX_COMMAND * 4 || command.chars().count() > MAX_COMMAND {
        return Err(format!(
            "invalid_command: the command is longer than {MAX_COMMAND} characters"
        ));
    }
    Ok(())
}

/// The connect error with a stable code in front:
/// `needs_credential`, `host_key_unknown`, `host_key_changed`, `host_not_found`
/// or `connect_failed`.
pub fn classify_connect_error(err: &str) -> String {
    let code = if err.contains("host no longer exists") || err.contains("host not found") {
        "host_not_found"
    } else if err.contains("HOST KEY CHANGED") {
        "host_key_changed"
    } else if err.contains("approve its host key") || err.contains("unknown host key") {
        "host_key_unknown"
    } else if err.contains("no saved credential")
        || err.contains("authentication failed")
        || err.contains("private key could not be used")
    {
        "needs_credential"
    } else {
        "connect_failed"
    };
    format!("{code}: {err}")
}

/// The kept bytes as text: a character cut at the front by the cap is dropped.
pub fn tail_text(bytes: &[u8], truncated: bool) -> String {
    let start = if truncated {
        bytes
            .iter()
            .take(3)
            .take_while(|b| (**b & 0xC0) == 0x80)
            .count()
    } else {
        0
    };
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

pub async fn host_exec(
    state: &Arc<AppState>,
    host_id: String,
    command: String,
    timeout_sec: u64,
) -> Result<ExecResult, String> {
    check_command(&command)?;
    let kind = {
        let data = state.data.lock().map_err(|_| "busy")?;
        data.hosts
            .iter()
            .find(|h| h.id == host_id)
            .map(|h| h.link.kind().to_owned())
            .ok_or_else(|| classify_connect_error("host not found"))?
    };
    if kind != "ssh" && kind != "mosh" {
        return Err(format!("not_ssh: {kind} hosts cannot run commands"));
    }
    let (conn, _jump) = crate::connect_quietly(state, &host_id)
        .await
        .map_err(|e| classify_connect_error(&e))?;
    let run = conn
        .exec_tail(&command, MAX_OUTPUT, timeout_for(timeout_sec))
        .await
        .map_err(|e| format!("exec_failed: {e}"));
    let _ = conn.close().await;
    let out = run?;
    Ok(ExecResult {
        exit_code: out.exit_status,
        output: tail_text(&out.output, out.truncated),
        timed_out: out.timed_out,
        truncated: out.truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_is_clamped_with_a_default() {
        assert_eq!(timeout_for(0), Duration::from_secs(600));
        assert_eq!(timeout_for(30), Duration::from_secs(30));
        assert_eq!(timeout_for(99_999), Duration::from_secs(3600));
    }

    #[test]
    fn commands_must_be_present_and_bounded() {
        assert!(check_command("uptime").is_ok());
        assert!(check_command("  \n")
            .unwrap_err()
            .starts_with("invalid_command"));
        assert!(check_command(&"a".repeat(4000)).is_ok());
        assert!(check_command(&"a".repeat(4001)).is_err());
        assert!(check_command(&"ğ".repeat(4000)).is_ok());
    }

    #[test]
    fn connect_errors_get_a_code() {
        assert!(
            classify_connect_error("web: no saved credential; connect to it once and save it")
                .starts_with("needs_credential: ")
        );
        assert!(
            classify_connect_error("web: authentication failed (server accepts: publickey)")
                .starts_with("needs_credential: ")
        );
        assert!(classify_connect_error(
            "web: connect to it once in a terminal to approve its host key"
        )
        .starts_with("host_key_unknown: "));
        assert!(
            classify_connect_error("web: HOST KEY CHANGED: trusted A, server presented B")
                .starts_with("host_key_changed: ")
        );
        assert!(classify_connect_error("host no longer exists").starts_with("host_not_found: "));
        assert!(classify_connect_error("web: connection timed out").starts_with("connect_failed: "));
    }

    #[test]
    fn tail_text_drops_a_cut_character() {
        let text = "çalıştı".as_bytes();
        // Cut inside the two-byte "ç".
        assert_eq!(tail_text(&text[1..], true), "alıştı");
        assert_eq!(tail_text(text, false), "çalıştı");
        assert_eq!(tail_text(b"", true), "");
    }
}
