//! Autocomplete: the commands typed in each host's terminals, kept on this
//! computer, and suggestions from them and from the snippets.

use std::sync::Arc;

use crate::AppState;

/// Commands kept per host.
const KEEP: usize = 500;

/// Lines that are never kept: empty, very long, or typed right after the
/// screen asked for a password (the app passes that screen line along).
fn worth_keeping(command: &str, prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    let secret_prompt = [
        "password",
        "passphrase",
        "parola",
        "şifre",
        "passcode",
        "pin:",
        "token",
    ]
    .iter()
    .any(|w| p.contains(w));
    !secret_prompt
        && !command.is_empty()
        && command.len() <= 1000
        && !command.chars().any(|c| c.is_control())
}

/// Records a command typed in host `host_id`'s terminal. `prompt` is the
/// screen text just before it (to skip password answers).
pub fn add(
    state: &Arc<AppState>,
    host_id: &str,
    command: &str,
    prompt: &str,
) -> Result<(), String> {
    let command = command.trim();
    if !worth_keeping(command, prompt) {
        return Ok(());
    }
    let mut data = state.data.lock().map_err(|_| "busy")?;
    if !data.hosts.iter().any(|h| h.id == host_id) {
        return Ok(());
    }
    let list = data.commands.entry(host_id.to_owned()).or_default();
    list.retain(|c| c != command);
    list.push(command.to_owned());
    if list.len() > KEEP {
        let extra = list.len() - KEEP;
        list.drain(..extra);
    }
    state.save(&data)
}

/// Up to `limit` completions for `prefix` on host `host_id`: its own
/// commands (newest first), then the other hosts' and the snippets.
pub fn suggest(
    state: &Arc<AppState>,
    host_id: &str,
    prefix: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    if prefix.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let data = state.data.lock().map_err(|_| "busy")?;
    let mut out: Vec<String> = Vec::new();
    let mut push = |c: &str| {
        if c.len() > prefix.len() && c.starts_with(prefix) && !out.iter().any(|o| o == c) {
            out.push(c.to_owned());
        }
    };
    if let Some(own) = data.commands.get(host_id) {
        own.iter().rev().for_each(|c| push(c));
    }
    for snippet in &data.snippets {
        push(snippet.command.trim());
    }
    for (other, list) in &data.commands {
        if other != host_id {
            list.iter().rev().for_each(|c| push(c));
        }
    }
    out.truncate(limit.clamp(1, 20));
    Ok(out)
}

/// Every command kept for host `host_id`, newest last (the app keeps a copy
/// per terminal so suggestions appear without a round trip).
pub fn list(state: &Arc<AppState>, host_id: &str) -> Result<Vec<String>, String> {
    let data = state.data.lock().map_err(|_| "busy")?;
    Ok(data.commands.get(host_id).cloned().unwrap_or_default())
}

/// Forgets host `host_id`'s commands.
pub fn clear(state: &Arc<AppState>, host_id: &str) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|_| "busy")?;
    data.commands.remove(host_id);
    state.save(&data)
}

#[cfg(test)]
mod tests {
    use super::worth_keeping;

    #[test]
    fn password_answers_are_never_kept() {
        assert!(!worth_keeping("hunter2", "[sudo] password for deploy: "));
        assert!(!worth_keeping(
            "hunter2",
            "Enter passphrase for key '/root/.ssh/id':"
        ));
        assert!(!worth_keeping("gizli", "Parola: "));
        assert!(worth_keeping("git status", "deploy@web:~/app$ "));
        assert!(!worth_keeping("", "$ "));
        assert!(!worth_keeping("a\u{1b}[A", "$ "));
    }
}
