//! The host library around the terminals: editing hosts and their groups
//! (A07), trusted host keys (A06), saved commands (A14) and the connection
//! history. Plain data in hosts.json; no secrets.
use crate::store::{
    identity_secret, key_secret, Data, HistoryEntry, Identity, KeyMeta, SavedHost, Snippet,
};
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
                team: false,
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

// ---- keys (A05): made or imported here, private half in the keyring ----

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn clean_label(label: &str, fallback: &str) -> String {
    let l: String = label
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    if l.is_empty() {
        fallback.into()
    } else {
        l
    }
}

pub fn keys_list(state: &Arc<AppState>) -> Result<Vec<KeyMeta>, String> {
    Ok(state.data.lock().map_err(|_| "busy")?.keys.clone())
}

fn add_key(
    state: &Arc<AppState>,
    label: String,
    private: &str,
    passphrase: Option<&str>,
    info: wc_ssh_core::keys::KeyInfo,
) -> Result<Vec<KeyMeta>, String> {
    let id = uuid::Uuid::new_v4().to_string();
    state
        .vault
        .put(&key_secret(&id, "private"), private)
        .map_err(|e| format!("could not save the key in the keyring: {e:?}"))?;
    if let Some(p) = passphrase.filter(|p| !p.is_empty()) {
        let _ = state.vault.put(&key_secret(&id, "passphrase"), p);
    }
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.keys.push(KeyMeta {
            id,
            label,
            algorithm: info.algorithm,
            fingerprint: info.fingerprint,
            public_key: info.public_openssh,
            created: now(),
        });
        state.save(&data)?;
    }
    state.changed();
    keys_list(state)
}

/// A new Ed25519 key; its public key line goes into the server's
/// `~/.ssh/authorized_keys`.
pub fn key_generate(state: &Arc<AppState>, label: String) -> Result<Vec<KeyMeta>, String> {
    let label = clean_label(&label, "WECOMMANDER anahtarı");
    let made = wc_ssh_core::keys::generate_ed25519(&label)?;
    add_key(state, label, &made.private_openssh, None, made.info)
}

/// Saves a key the core just made (used by the install-key login).
pub(crate) fn add_key_material(
    state: &Arc<AppState>,
    label: String,
    private: &str,
    info: wc_ssh_core::keys::KeyInfo,
) -> Result<Vec<KeyMeta>, String> {
    add_key(state, label, private, None, info)
}

/// An existing private key (pasted or read from a file), checked first.
pub fn key_import(
    state: &Arc<AppState>,
    label: String,
    private: String,
    passphrase: Option<String>,
) -> Result<Vec<KeyMeta>, String> {
    let info = wc_ssh_core::keys::inspect(&private, passphrase.as_deref())?;
    let label = clean_label(&label, &info.fingerprint);
    add_key(state, label, &private, passphrase.as_deref(), info)
}

/// Deletes a key; hosts that used it ask for a credential again.
pub fn key_delete(state: &Arc<AppState>, id: String) -> Result<Vec<KeyMeta>, String> {
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.keys.retain(|k| k.id != id);
        for h in data.hosts.iter_mut() {
            if h.key_id.as_deref() == Some(id.as_str()) {
                h.key_id = None;
            }
        }
        for i in data.identities.iter_mut() {
            if i.key_id.as_deref() == Some(id.as_str()) {
                i.key_id = None;
            }
        }
        state.save(&data)?;
    }
    for part in ["private", "passphrase"] {
        let _ = state.vault.delete(&key_secret(&id, part));
    }
    state.changed();
    keys_list(state)
}

/// Uses an app key for a host (or none).
pub fn host_set_key(
    state: &Arc<AppState>,
    host_id: String,
    key_id: Option<String>,
) -> Result<Vec<HostView>, String> {
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let key_id = key_id.filter(|k| data.keys.iter().any(|m| &m.id == k));
        let h = data
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or("host not found")?;
        if key_id.is_some() {
            h.auth_kind = "key".into();
        }
        h.key_id = key_id;
        state.save(&data)?;
    }
    state.changed();
    host_views(state)
}

/// Shares a host or snippet with the team (A22), or takes it back.
pub fn set_team(state: &Arc<AppState>, kind: String, id: String, team: bool) -> Result<(), String> {
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        match kind.as_str() {
            "host" => {
                data.hosts
                    .iter_mut()
                    .find(|h| h.id == id)
                    .ok_or("host not found")?
                    .team = team
            }
            "snippet" => {
                data.snippets
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or("snippet not found")?
                    .team = team
            }
            _ => return Err("kind must be host or snippet".into()),
        }
        state.save(&data)?;
    }
    state.changed();
    Ok(())
}

pub fn identities_list(state: &Arc<AppState>) -> Result<Vec<Identity>, String> {
    Ok(state.data.lock().map_err(|_| "busy")?.identities.clone())
}

/// Adds (`id` None) or changes an identity. `password` is stored in the
/// keyring when given; an empty one keeps the stored password.
pub fn identity_save(
    state: &Arc<AppState>,
    id: Option<String>,
    label: String,
    user: String,
    auth_kind: String,
    key_id: Option<String>,
    password: Option<String>,
) -> Result<Vec<Identity>, String> {
    let user = user.trim().to_owned();
    if user.is_empty()
        || user.len() > 64
        || user
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '@')
    {
        return Err("identity needs a valid user name".into());
    }
    let label = clean_label(&label, &user);
    let auth_kind = if auth_kind == "password" {
        "password"
    } else {
        "key"
    }
    .to_owned();
    let id = {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let key_id = key_id
            .filter(|k| data.keys.iter().any(|m| &m.id == k))
            .filter(|_| auth_kind == "key");
        if auth_kind == "key" && key_id.is_none() {
            return Err("choose a key for this identity".into());
        }
        let id = match id {
            Some(id) => {
                let i = data
                    .identities
                    .iter_mut()
                    .find(|i| i.id == id)
                    .ok_or("identity not found")?;
                i.label = label;
                i.user = user;
                i.auth_kind = auth_kind.clone();
                i.key_id = key_id;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                data.identities.push(Identity {
                    id: id.clone(),
                    label,
                    user,
                    auth_kind: auth_kind.clone(),
                    key_id,
                });
                id
            }
        };
        state.save(&data)?;
        id
    };
    match password.filter(|p| !p.is_empty()) {
        Some(p) if auth_kind == "password" => state
            .vault
            .put(&identity_secret(&id), &p)
            .map_err(|e| format!("could not store the password: {e:?}"))?,
        _ if auth_kind == "key" => {
            let _ = state.vault.delete(&identity_secret(&id));
        }
        _ => {}
    }
    state.changed();
    identities_list(state)
}

/// Deletes an identity; hosts that used it go back to their own credential.
pub fn identity_delete(state: &Arc<AppState>, id: String) -> Result<Vec<Identity>, String> {
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.identities.retain(|i| i.id != id);
        for h in data.hosts.iter_mut() {
            if h.identity_id.as_deref() == Some(id.as_str()) {
                h.identity_id = None;
            }
        }
        state.save(&data)?;
    }
    let _ = state.vault.delete(&identity_secret(&id));
    state.changed();
    identities_list(state)
}

/// Uses an identity for a host (or none).
pub fn host_set_identity(
    state: &Arc<AppState>,
    host_id: String,
    identity_id: Option<String>,
) -> Result<Vec<HostView>, String> {
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let identity_id = identity_id.filter(|i| data.identities.iter().any(|x| &x.id == i));
        let h = data
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or("host not found")?;
        h.identity_id = identity_id;
        state.save(&data)?;
    }
    state.changed();
    host_views(state)
}

/// Terminal options of a host: a command typed when the terminal opens,
/// environment variables, and SSH agent forwarding.
/// Sets how host `host_id` is reached: "ssh", "telnet", "serial" (with
/// its line settings) or "mosh".
pub fn host_set_connection(
    state: &Arc<AppState>,
    host_id: String,
    protocol: String,
    serial: Option<crate::store::SerialSettings>,
) -> Result<Vec<HostView>, String> {
    let protocol = match protocol.as_str() {
        "" | "ssh" => String::new(),
        "telnet" | "serial" | "mosh" => protocol,
        other => return Err(format!("unknown connection type: {other}")),
    };
    let serial = if protocol == "serial" {
        let s = serial.ok_or("serial port settings are missing")?;
        let device = s.device.trim().to_owned();
        if device.is_empty() || device.len() > 200 || device.chars().any(|c| c.is_control()) {
            return Err("invalid serial port".into());
        }
        if !(50..=4_000_000).contains(&s.baud)
            || !(5..=8).contains(&s.data_bits)
            || !(1..=2).contains(&s.stop_bits)
        {
            return Err("invalid serial line settings".into());
        }
        if !["none", "even", "odd"].contains(&s.parity.as_str())
            || !["none", "hardware", "software"].contains(&s.flow.as_str())
        {
            return Err("invalid serial line settings".into());
        }
        Some(crate::store::SerialSettings { device, ..s })
    } else {
        None
    };
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let h = data
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or("host not found")?;
        h.link = crate::store::Link { protocol, serial };
        state.save(&data)?;
    }
    state.changed();
    host_views(state)
}

pub fn host_set_options(
    state: &Arc<AppState>,
    host_id: String,
    startup_command: Option<String>,
    env: std::collections::BTreeMap<String, String>,
    agent_forwarding: bool,
    session_log: bool,
) -> Result<Vec<HostView>, String> {
    let startup_command = startup_command
        .map(|c| {
            c.trim()
                .chars()
                .filter(|c| *c != '\r' && *c != '\n')
                .take(2000)
                .collect::<String>()
        })
        .filter(|c| !c.is_empty());
    let mut clean = std::collections::BTreeMap::new();
    for (name, value) in env {
        let name = name.trim().to_owned();
        if name.is_empty() {
            continue;
        }
        if name.len() > 128
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || name.starts_with(|c: char| c.is_ascii_digit())
        {
            return Err(format!("invalid variable name: {name}"));
        }
        if value.len() > 4096 || value.chars().any(|c| c == '\0') {
            return Err(format!("value of {name} is too long"));
        }
        clean.insert(name, value);
    }
    if clean.len() > 64 {
        return Err("at most 64 variables".into());
    }
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let h = data
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or("host not found")?;
        h.startup_command = startup_command;
        h.env = clean;
        h.agent_forwarding = agent_forwarding;
        h.session_log = session_log;
        state.save(&data)?;
    }
    state.changed();
    host_views(state)
}

/// Backup file format version written by [`library_export`].
pub const BACKUP_VERSION: u32 = 1;

/// What a backup holds: hosts (with groups, tunnels and terminal options),
/// saved commands, trusted host keys and the public part of app keys. No
/// passwords and no private keys: those stay in this computer's keyring.
#[derive(Serialize, serde::Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub hosts: Vec<SavedHost>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub known_hosts: std::collections::BTreeMap<String, String>,
    /// Without passwords and without the key (keys stay on this computer).
    #[serde(default)]
    pub identities: Vec<Identity>,
}

const BACKUP_FORMAT: &str = "wecommander-library";

pub fn backup_of(data: &Data) -> Backup {
    Backup {
        format: BACKUP_FORMAT.into(),
        version: BACKUP_VERSION,
        hosts: data
            .hosts
            .iter()
            .cloned()
            .map(|mut h| {
                // A key file path or app key belongs to this computer.
                h.key_path = None;
                h.key_id = None;
                h
            })
            .collect(),
        snippets: data.snippets.clone(),
        known_hosts: data.known_hosts.clone().into_iter().collect(),
        identities: data
            .identities
            .iter()
            .cloned()
            .map(|mut i| {
                i.key_id = None;
                i
            })
            .collect(),
    }
}

/// The library as JSON for a backup file.
pub fn library_export(state: &Arc<AppState>) -> Result<String, String> {
    let data = state.data.lock().map_err(|_| "busy")?;
    serde_json::to_string_pretty(&backup_of(&data)).map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub hosts: usize,
    pub snippets: usize,
    pub known_hosts: usize,
    pub skipped: usize,
}

/// Adds what is new in `backup` to `data`; nothing already here is changed.
/// A host already here (same id, or same address and user) is skipped.
pub fn merge_backup(data: &mut Data, backup: Backup) -> Result<ImportSummary, String> {
    if backup.format != BACKUP_FORMAT {
        return Err("this is not a WECOMMANDER backup file".into());
    }
    if backup.version > BACKUP_VERSION {
        return Err("this backup was made by a newer version; update the app first".into());
    }
    let mut summary = ImportSummary::default();
    for i in backup.identities {
        if !data.identities.iter().any(|e| e.id == i.id) {
            data.identities.push(i);
        }
    }
    let incoming_ids: Vec<String> = backup.hosts.iter().map(|h| h.id.clone()).collect();
    for mut h in backup.hosts {
        let exists = data.hosts.iter().any(|e| {
            e.id == h.id
                || (e.profile.host == h.profile.host
                    && e.profile.port == h.profile.port
                    && e.profile.user == h.profile.user)
        });
        if exists || h.profile.validate().is_err() {
            summary.skipped += 1;
            continue;
        }
        h.key_path = None;
        h.key_id = None;
        h.group = clean_group(h.group);
        data.hosts.push(h);
        summary.hosts += 1;
    }
    // Jump hosts must point at a host that is here.
    let ids: Vec<String> = data.hosts.iter().map(|h| h.id.clone()).collect();
    for h in data
        .hosts
        .iter_mut()
        .filter(|h| incoming_ids.contains(&h.id))
    {
        if h.jump_id.as_ref().is_some_and(|j| !ids.contains(j)) {
            h.jump_id = None;
        }
        if h.identity_id
            .as_ref()
            .is_some_and(|i| !data.identities.iter().any(|x| &x.id == i))
        {
            h.identity_id = None;
        }
    }
    for s in backup.snippets {
        if data
            .snippets
            .iter()
            .any(|e| e.id == s.id || (e.label == s.label && e.command == s.command))
        {
            continue;
        }
        data.snippets.push(s);
        summary.snippets += 1;
    }
    for (target, fp) in backup.known_hosts {
        if let std::collections::hash_map::Entry::Vacant(slot) = data.known_hosts.entry(target) {
            slot.insert(fp);
            summary.known_hosts += 1;
        }
    }
    Ok(summary)
}

/// Reads a backup made by [`library_export`] and adds what is new.
pub fn library_import(state: &Arc<AppState>, json: String) -> Result<ImportSummary, String> {
    if json.len() > 20 * 1024 * 1024 {
        return Err("backup file is too large".into());
    }
    let backup: Backup = serde_json::from_str(&json)
        .map_err(|_| "this is not a WECOMMANDER backup file".to_string())?;
    let summary = {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let summary = merge_backup(&mut data, backup)?;
        state.save(&data)?;
        summary
    };
    state.changed();
    Ok(summary)
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
            key_id: None,
            startup_command: None,
            env: Default::default(),
            agent_forwarding: false,
            identity_id: None,
            team: false,
            link: Default::default(),
            session_log: false,
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

    #[test]
    fn backup_round_trip_adds_only_new_entries_and_no_secrets() {
        let mut src = Data::default();
        let mut a = host("a", Some("b"));
        a.profile = HostProfile::new("a", "a.example.com", 22, "deploy").unwrap();
        a.key_id = Some("k1".into());
        a.key_path = Some("/home/me/.ssh/id".into());
        a.startup_command = Some("cd /srv".into());
        src.hosts.push(a);
        src.hosts.push(host("b", None));
        src.snippets.push(Snippet {
            id: "s".into(),
            label: "up".into(),
            command: "uptime".into(),
            team: false,
        });
        src.known_hosts.insert("h:22".into(), "SHA256:x".into());
        let json = serde_json::to_string(&backup_of(&src)).unwrap();
        assert!(!json.contains("/home/me") && !json.contains("k1"));

        let mut dst = Data::default();
        dst.hosts.push(host("b", None));
        let backup: Backup = serde_json::from_str(&json).unwrap();
        let sum = merge_backup(&mut dst, backup).unwrap();
        assert_eq!(
            sum,
            ImportSummary {
                hosts: 1,
                snippets: 1,
                known_hosts: 1,
                skipped: 1
            }
        );
        let a = dst.hosts.iter().find(|h| h.id == "a").unwrap();
        assert_eq!(a.jump_id.as_deref(), Some("b"));
        assert_eq!(a.startup_command.as_deref(), Some("cd /srv"));
        assert_eq!(a.key_id, None);

        // Importing again changes nothing.
        let backup: Backup = serde_json::from_str(&json).unwrap();
        let sum = merge_backup(&mut dst, backup).unwrap();
        assert_eq!((sum.hosts, sum.snippets, sum.known_hosts), (0, 0, 0));

        let bad = Backup {
            format: "other".into(),
            version: 1,
            hosts: vec![],
            snippets: vec![],
            known_hosts: Default::default(),
            identities: vec![],
        };
        assert!(merge_backup(&mut dst, bad).is_err());
    }

    #[test]
    fn identity_overrides_user_auth_and_key() {
        let mut data = Data::default();
        data.identities.push(Identity {
            id: "i".into(),
            label: "Team".into(),
            user: "deploy".into(),
            auth_kind: "key".into(),
            key_id: Some("k".into()),
        });
        let mut h = host("a", None);
        h.profile = HostProfile::new("a", "a.example.com", 22, "root").unwrap();
        h.auth_kind = "password".into();
        h.identity_id = Some("i".into());
        let e = crate::effective_host(&data, &h);
        assert_eq!(
            (
                e.profile.user.as_str(),
                e.auth_kind.as_str(),
                e.key_id.as_deref()
            ),
            ("deploy", "key", Some("k"))
        );
        h.identity_id = Some("gone".into());
        assert_eq!(crate::effective_host(&data, &h).profile.user, "root");
    }
}
