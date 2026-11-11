//! The host library around the terminals: editing hosts and their groups
//! (A07), trusted host keys (A06), saved commands (A14) and the connection
//! history. Plain data in hosts.json; no secrets.
use crate::store::{Data, HistoryEntry, SavedHost, Snippet};
use crate::{host_views, AppState, HostView};
use serde::Serialize;
use std::sync::Arc;
use wc_ssh_core::HostProfile;

/// Newest connections kept in the history.
pub const HISTORY_LIMIT: usize = 200;

fn clean_group(group: Option<String>) -> Option<String> {
    group
        .map(|g| {
            g.trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(80)
                .collect::<String>()
        })
        .filter(|g| !g.is_empty())
}

/// Changes a saved host. The trusted key stays with the address; a new
/// address is checked again on the next connect.
pub fn update_host(
    state: &Arc<AppState>,
    id: String,
    label: String,
    host: String,
    port: u16,
    user: String,
    auth_kind: String,
    jump_id: Option<String>,
    group: Option<String>,
) -> Result<Vec<HostView>, String> {
    let profile = HostProfile::new(&label, &host, port, &user).map_err(|e| e.to_string())?;
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        // A host cannot be its own jump host, and the chain must not loop.
        let jump_id = jump_id
            .filter(|j| j != &id && data.hosts.iter().any(|h| &h.id == j))
            .filter(|j| !reaches(&data, j, &id));
        let h = data
            .hosts
            .iter_mut()
            .find(|h| h.id == id)
            .ok_or("host not found")?;
        h.profile = profile;
        h.auth_kind = if auth_kind == "password" {
            "password"
        } else {
            "key"
        }
        .into();
        h.jump_id = jump_id;
        h.group = clean_group(group);
        state.save(&data)?;
    }
    state.changed();
    host_views(state)
}

/// Whether following jump hosts from `start` reaches `target`.
fn reaches(data: &Data, start: &str, target: &str) -> bool {
    let mut current = Some(start.to_owned());
    for _ in 0..16 {
        match current {
            Some(c) if c == target => return true,
            Some(c) => {
                current = data
                    .hosts
                    .iter()
                    .find(|h| h.id == c)
                    .and_then(|h| h.jump_id.clone())
            }
            None => return false,
        }
    }
    true
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostView {
    /// `host:port`.
    pub target: String,
    pub fingerprint: String,
    /// Saved hosts at this address.
    pub labels: Vec<String>,
}

pub fn known_list(state: &Arc<AppState>) -> Result<Vec<KnownHostView>, String> {
    let data = state.data.lock().map_err(|_| "busy")?;
    let mut list: Vec<KnownHostView> = data
        .known_hosts
        .iter()
        .map(|(target, fingerprint)| KnownHostView {
            target: target.clone(),
            fingerprint: fingerprint.clone(),
            labels: data
                .hosts
                .iter()
                .filter(|h| &format!("{}:{}", h.profile.host, h.profile.port) == target)
                .map(|h| h.profile.label.clone())
                .collect(),
        })
        .collect();
    list.sort_by(|a, b| a.target.cmp(&b.target));
    Ok(list)
}

/// Forgets a trusted key: the next connect asks again.
pub fn known_forget(state: &Arc<AppState>, target: String) -> Result<Vec<KnownHostView>, String> {
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.known_hosts.remove(&target);
        state.save(&data)?;
    }
    state.changed();
    known_list(state)
}

pub fn snippets_list(state: &Arc<AppState>) -> Result<Vec<Snippet>, String> {
    Ok(state.data.lock().map_err(|_| "busy")?.snippets.clone())
}

/// Adds a snippet, or changes the one with `id`.
pub fn snippet_save(
    state: &Arc<AppState>,
    id: Option<String>,
    label: String,
    command: String,
) -> Result<Vec<Snippet>, String> {
    let label = label.trim().to_owned();
    if label.is_empty() || command.trim().is_empty() {
        return Err("a snippet needs a name and a command".into());
    }
    if command.len() > 16 * 1024 {
        return Err("the command is too long".into());
    }
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        match id.and_then(|id| data.snippets.iter_mut().find(|s| s.id == id)) {
            Some(s) => {
                s.label = label;
                s.command = command;
            }
            None => data.snippets.push(Snippet {
                id: uuid::Uuid::new_v4().to_string(),
                label,
                command,
            }),
        }
        state.save(&data)?;
    }
    state.changed();
    snippets_list(state)
}

pub fn snippet_delete(state: &Arc<AppState>, id: String) -> Result<Vec<Snippet>, String> {
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.snippets.retain(|s| s.id != id);
        state.save(&data)?;
    }
    state.changed();
    snippets_list(state)
}

pub fn history_list(state: &Arc<AppState>) -> Result<Vec<HistoryEntry>, String> {
    Ok(state.data.lock().map_err(|_| "busy")?.history.clone())
}

pub fn history_clear(state: &Arc<AppState>) -> Result<Vec<HistoryEntry>, String> {
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.history.clear();
        state.save(&data)?;
    }
    Ok(Vec::new())
}

/// Called on every successful connect (the caller saves `data`).
pub(crate) fn record_connection(data: &mut Data, host: &SavedHost) {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    data.history.insert(
        0,
        HistoryEntry {
            host_id: host.id.clone(),
            label: host.profile.label.clone(),
            target: host.profile.display_target(),
            at,
        },
    );
    data.history.truncate(HISTORY_LIMIT);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: &str, jump: Option<&str>) -> SavedHost {
        SavedHost {
            id: id.into(),
            profile: HostProfile::new(id, "srv.example.com", 22, "deploy").unwrap(),
            auth_kind: "key".into(),
            key_path: None,
            jump_id: jump.map(Into::into),
            tunnels: Vec::new(),
            group: None,
        }
    }

    #[test]
    fn jump_chains_are_followed() {
        let mut data = Data::default();
        data.hosts.push(host("a", Some("b")));
        data.hosts.push(host("b", Some("c")));
        data.hosts.push(host("c", None));
        assert!(reaches(&data, "a", "c"));
        assert!(!reaches(&data, "c", "a"));
    }

    #[test]
    fn history_is_newest_first_and_bounded() {
        let mut data = Data::default();
        for i in 0..(HISTORY_LIMIT + 5) {
            record_connection(&mut data, &host(&format!("h{i}"), None));
        }
        assert_eq!(data.history.len(), HISTORY_LIMIT);
        assert_eq!(data.history[0].host_id, format!("h{}", HISTORY_LIMIT + 4));
    }

    #[test]
    fn groups_are_trimmed_and_empty_ones_dropped() {
        assert_eq!(clean_group(Some("  Prod  ".into())), Some("Prod".into()));
        assert_eq!(clean_group(Some("   ".into())), None);
        assert_eq!(clean_group(None), None);
    }
}
