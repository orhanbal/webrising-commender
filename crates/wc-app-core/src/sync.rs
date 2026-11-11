//! Library sync between the user's computers (A20), end-to-end encrypted.
//!
//! The app moves an opaque *envelope* to and from the server
//! (`/api/center/library`); everything else happens here:
//!
//! * The key comes from the user's sync passphrase (Argon2id, salt stored in
//!   the envelope) and is kept in this computer's keyring. The server never
//!   sees the passphrase, the key or the library.
//! * The library (hosts, groups, tunnels, terminal options, identities,
//!   snippets, app keys, trusted host keys and the saved passwords and
//!   private keys) is encrypted with AES-256-GCM.
//! * Merging is three-way per item: what changed here since the last sync
//!   wins over the server only where the server did not change it too, so
//!   additions, edits and deletions from every computer survive. When both
//!   sides changed the same item, the server's version wins (except that a
//!   deletion never wins over an edit).
//! * The base (hashes of the last synced items, no secrets) is written only
//!   after the server accepted the upload ([`committed`]).
use crate::store::{self, Data, Identity, KeyMeta, SavedHost, Snippet};
use crate::AppState;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes256Gcm;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

const FORMAT: &str = "wecommander-sync";
const VERSION: u32 = 1;
const KEY_ENTRY: &str = "sync/key";
const SALT_ENTRY: &str = "sync/salt";
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Which library: this user's own (passphrase key) or the team's (A22,
/// team key exchanged between the team's apps).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Personal,
    Team,
}

impl Scope {
    fn base_file(self) -> &'static str {
        match self {
            Scope::Personal => "sync-base.json",
            Scope::Team => "team-base.json",
        }
    }
}

/// What the server stores.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Envelope {
    pub format: String,
    pub v: u32,
    pub salt: String,
    pub nonce: String,
    pub data: String,
}

/// The decrypted library.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    #[serde(default)]
    pub hosts: BTreeMap<String, SavedHost>,
    #[serde(default)]
    pub snippets: BTreeMap<String, Snippet>,
    #[serde(default)]
    pub identities: BTreeMap<String, Identity>,
    #[serde(default)]
    pub keys: BTreeMap<String, KeyMeta>,
    #[serde(default)]
    pub known_hosts: BTreeMap<String, String>,
    /// Keyring entries of the items above (`host/<id>/password`, ...).
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
}

/// Hashes of the last synced items, per collection and item id.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Base(pub BTreeMap<String, BTreeMap<String, String>>);

/// Set by [`merge`], written by [`committed`] once the server took it.
#[derive(Default)]
pub struct Pending(pub Mutex<Option<Base>>);

fn hash<T: Serialize>(item: &T) -> String {
    let bytes = serde_json::to_vec(item).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

/// Keyring entries that belong to the items of `data`.
fn secret_names(data: &Data) -> Vec<String> {
    let mut names = Vec::new();
    for h in &data.hosts {
        for part in ["password", "key", "passphrase"] {
            names.push(store::secret_key(&h.id, part));
        }
    }
    for k in &data.keys {
        for part in ["private", "passphrase"] {
            names.push(store::key_secret(&k.id, part));
        }
    }
    for i in &data.identities {
        names.push(store::identity_secret(&i.id));
    }
    names
}

/// This computer's library as a sync document. Key files, app keys and
/// identities are this computer's (or this user's) own: they are not in the
/// team library, and key files are never synced.
pub fn local_doc(state: &AppState, data: &Data, scope: Scope) -> Doc {
    let team = scope == Scope::Team;
    let team_ids: BTreeSet<&String> = data
        .hosts
        .iter()
        .filter(|h| h.team)
        .map(|h| &h.id)
        .collect();
    let mut doc = Doc {
        hosts: data
            .hosts
            .iter()
            .filter(|h| h.team == team)
            .map(|h| {
                let mut h = h.clone();
                h.key_path = None;
                if team {
                    h.key_id = None;
                    h.identity_id = None;
                    h.jump_id = h.jump_id.filter(|j| team_ids.contains(j));
                }
                (h.id.clone(), h)
            })
            .collect(),
        snippets: data
            .snippets
            .iter()
            .filter(|s| s.team == team)
            .map(|s| (s.id.clone(), s.clone()))
            .collect(),
        ..Default::default()
    };
    if team {
        let targets: BTreeSet<String> = doc
            .hosts
            .values()
            .map(|h| format!("{}:{}", h.profile.host, h.profile.port))
            .collect();
        doc.known_hosts = data
            .known_hosts
            .iter()
            .filter(|(k, _)| targets.contains(*k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
    } else {
        doc.identities = data
            .identities
            .iter()
            .map(|i| (i.id.clone(), i.clone()))
            .collect();
        doc.keys = data
            .keys
            .iter()
            .map(|k| (k.id.clone(), k.clone()))
            .collect();
        doc.known_hosts = data.known_hosts.clone().into_iter().collect();
    }
    let mut names: Vec<String> = doc
        .hosts
        .keys()
        .flat_map(|id| ["password", "key", "passphrase"].map(|part| store::secret_key(id, part)))
        .collect();
    if !team {
        names.extend(
            secret_names(data)
                .into_iter()
                .filter(|n| !n.starts_with("host/")),
        );
    }
    for name in names {
        if let Ok(Some(value)) = state.vault.get(&name) {
            doc.secrets.insert(name, value);
        }
    }
    doc
}

fn base_of(doc: &Doc) -> Base {
    fn hashes<T: Serialize>(m: &BTreeMap<String, T>) -> BTreeMap<String, String> {
        m.iter().map(|(k, v)| (k.clone(), hash(v))).collect()
    }
    let mut b = BTreeMap::new();
    b.insert("hosts".into(), hashes(&doc.hosts));
    b.insert("snippets".into(), hashes(&doc.snippets));
    b.insert("identities".into(), hashes(&doc.identities));
    b.insert("keys".into(), hashes(&doc.keys));
    b.insert("knownHosts".into(), hashes(&doc.known_hosts));
    b.insert("secrets".into(), hashes(&doc.secrets));
    Base(b)
}

/// Three-way merge of one collection.
fn merge_map<T: Serialize + Clone>(
    local: &BTreeMap<String, T>,
    remote: &BTreeMap<String, T>,
    base: Option<&BTreeMap<String, String>>,
) -> BTreeMap<String, T> {
    let empty = BTreeMap::new();
    let base = base.unwrap_or(&empty);
    let ids: BTreeSet<&String> = local
        .keys()
        .chain(remote.keys())
        .chain(base.keys())
        .collect();
    let mut out = BTreeMap::new();
    for id in ids {
        let l = local.get(id);
        let r = remote.get(id);
        let b = base.get(id);
        let lh = l.map(hash);
        let rh = r.map(hash);
        let local_changed = lh.as_ref() != b;
        let remote_changed = rh.as_ref() != b;
        let pick = match (local_changed, remote_changed) {
            (_, false) => l,
            (false, true) => r,
            // Both changed: the server wins, but an edit beats a deletion.
            (true, true) => r.or(l),
        };
        if let Some(v) = pick {
            out.insert(id.clone(), v.clone());
        }
    }
    out
}

pub fn merge_docs(local: &Doc, remote: &Doc, base: &Base) -> Doc {
    let b = |name: &str| base.0.get(name);
    let mut doc = Doc {
        hosts: merge_map(&local.hosts, &remote.hosts, b("hosts")),
        snippets: merge_map(&local.snippets, &remote.snippets, b("snippets")),
        identities: merge_map(&local.identities, &remote.identities, b("identities")),
        keys: merge_map(&local.keys, &remote.keys, b("keys")),
        known_hosts: merge_map(&local.known_hosts, &remote.known_hosts, b("knownHosts")),
        secrets: merge_map(&local.secrets, &remote.secrets, b("secrets")),
    };
    // References to items that are gone are dropped.
    let host_ids: BTreeSet<String> = doc.hosts.keys().cloned().collect();
    let key_ids: BTreeSet<String> = doc.keys.keys().cloned().collect();
    let identity_ids: BTreeSet<String> = doc.identities.keys().cloned().collect();
    for h in doc.hosts.values_mut() {
        if h.jump_id.as_ref().is_some_and(|j| !host_ids.contains(j)) {
            h.jump_id = None;
        }
        if h.key_id.as_ref().is_some_and(|k| !key_ids.contains(k)) {
            h.key_id = None;
        }
        if h.identity_id
            .as_ref()
            .is_some_and(|i| !identity_ids.contains(i))
        {
            h.identity_id = None;
        }
    }
    for i in doc.identities.values_mut() {
        if i.key_id.as_ref().is_some_and(|k| !key_ids.contains(k)) {
            i.key_id = None;
        }
    }
    doc
}

// ---- crypto ----

fn derive(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("could not derive the sync key: {e}"))?;
    Ok(key)
}

fn cipher(key: &[u8]) -> Result<Aes256Gcm, String> {
    Aes256Gcm::new_from_slice(key).map_err(|_| "bad sync key".to_string())
}

pub fn seal(key: &[u8], salt: &[u8], doc: &Doc) -> Result<Envelope, String> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let plain = serde_json::to_vec(doc).map_err(|e| e.to_string())?;
    let data = cipher(key)?
        .encrypt(&nonce.into(), plain.as_slice())
        .map_err(|_| "could not encrypt the library".to_string())?;
    Ok(Envelope {
        format: FORMAT.into(),
        v: VERSION,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        data: B64.encode(data),
    })
}

pub fn open(key: &[u8], envelope: &Envelope) -> Result<Doc, String> {
    if envelope.format != FORMAT {
        return Err("not a WECOMMANDER sync envelope".into());
    }
    if envelope.v > VERSION {
        return Err("the library was synced by a newer version; update the app first".into());
    }
    let nonce: [u8; 12] = B64
        .decode(&envelope.nonce)
        .ok()
        .and_then(|n| n.try_into().ok())
        .ok_or("damaged sync envelope")?;
    let data = B64
        .decode(&envelope.data)
        .map_err(|_| "damaged sync envelope")?;
    let plain = cipher(key)?
        .decrypt(&nonce.into(), data.as_slice())
        .map_err(|_| "wrong sync passphrase".to_string())?;
    serde_json::from_slice(&plain).map_err(|_| "damaged sync envelope".to_string())
}

fn parse(envelope: &str) -> Result<Envelope, String> {
    serde_json::from_str(envelope).map_err(|_| "not a WECOMMANDER sync envelope".to_string())
}

// ---- state ----

fn base_path(state: &AppState, scope: Scope) -> std::path::PathBuf {
    state.store.dir().join(scope.base_file())
}

fn load_base(state: &AppState, scope: Scope) -> Base {
    std::fs::read(base_path(state, scope))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn stored_key(state: &AppState) -> Option<(Vec<u8>, Vec<u8>)> {
    let key = B64.decode(state.vault.get(KEY_ENTRY).ok()??).ok()?;
    let salt = B64.decode(state.vault.get(SALT_ENTRY).ok()??).ok()?;
    (key.len() == 32).then_some((key, salt))
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    /// False when the keyring only keeps secrets until the app closes.
    pub persistent: bool,
}

pub fn status(state: &Arc<AppState>) -> Status {
    Status {
        configured: stored_key(state).is_some(),
        persistent: state.vault_persistent,
    }
}

/// Turns sync on with `passphrase`. With the server's current `remote`
/// envelope, its salt is used and the passphrase is checked against it.
pub fn setup(
    state: &Arc<AppState>,
    passphrase: String,
    remote: Option<String>,
) -> Result<Status, String> {
    if passphrase.chars().count() < 8 {
        return Err("the sync passphrase needs at least 8 characters".into());
    }
    let (key, salt) = match remote.filter(|r| !r.is_empty()) {
        Some(r) => {
            let envelope = parse(&r)?;
            let salt = B64
                .decode(&envelope.salt)
                .map_err(|_| "damaged sync envelope")?;
            let key = derive(&passphrase, &salt)?;
            open(&key, &envelope)?;
            (key, salt)
        }
        None => {
            let mut salt = vec![0u8; 16];
            getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
            (derive(&passphrase, &salt)?, salt)
        }
    };
    state
        .vault
        .put(KEY_ENTRY, &B64.encode(key))
        .and_then(|_| state.vault.put(SALT_ENTRY, &B64.encode(&salt)))
        .map_err(|e| format!("could not store the sync key: {e:?}"))?;
    // A new key starts from a clean base: the first merge keeps both sides.
    let _ = std::fs::remove_file(base_path(state, Scope::Personal));
    Ok(status(state))
}

/// Turns sync off on this computer (the server copy stays).
pub fn forget(state: &Arc<AppState>) -> Status {
    let _ = state.vault.delete(KEY_ENTRY);
    let _ = state.vault.delete(SALT_ENTRY);
    let _ = std::fs::remove_file(base_path(state, Scope::Personal));
    status(state)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// The envelope to upload (None when the server already has this library).
    pub envelope: Option<String>,
    /// True when this computer's library changed.
    pub changed_here: bool,
}

/// Merges the server's `remote` envelope (None: nothing synced yet) into
/// this computer's library and returns what to upload.
pub fn merge(
    state: &Arc<AppState>,
    pending: &Pending,
    remote: Option<String>,
) -> Result<MergeResult, String> {
    let (key, salt) = stored_key(state).ok_or("sync is not set up on this computer")?;
    if let Some(r) = remote.as_deref().filter(|r| !r.is_empty()) {
        if B64.decode(&parse(r)?.salt).ok().as_deref() != Some(salt.as_slice()) {
            return Err(
                "the sync passphrase was changed on another computer; enter it again".into(),
            );
        }
    }
    merge_scope(state, pending, remote, Scope::Personal, &key, &salt)
}

pub(crate) fn merge_scope(
    state: &Arc<AppState>,
    pending: &Pending,
    remote: Option<String>,
    scope: Scope,
    key: &[u8],
    salt: &[u8],
) -> Result<MergeResult, String> {
    let remote_doc = match remote.filter(|r| !r.is_empty()) {
        Some(r) => Some(open(key, &parse(&r)?)?),
        None => None,
    };
    let base = load_base(state, scope);
    let (merged, local) = {
        let data = state.data.lock().map_err(|_| "busy")?;
        let local = local_doc(state, &data, scope);
        let merged = match &remote_doc {
            Some(r) => merge_docs(&local, r, &base),
            None => local.clone(),
        };
        (merged, local)
    };
    let changed_here = merged != local;
    if changed_here {
        apply(state, &local, &merged, scope)?;
    }
    let upload = remote_doc.as_ref() != Some(&merged);
    let envelope = if upload {
        Some(serde_json::to_string(&seal(key, salt, &merged)?).map_err(|e| e.to_string())?)
    } else {
        None
    };
    *pending.0.lock().map_err(|_| "busy")? = Some(base_of(&merged));
    if !upload {
        committed_scope(state, pending, scope)?;
    }
    Ok(MergeResult {
        envelope,
        changed_here,
    })
}

/// The server accepted the upload: the merged library is the new base.
pub fn committed(state: &Arc<AppState>, pending: &Pending) -> Result<(), String> {
    committed_scope(state, pending, Scope::Personal)
}

pub(crate) fn committed_scope(
    state: &Arc<AppState>,
    pending: &Pending,
    scope: Scope,
) -> Result<(), String> {
    let Some(base) = pending.0.lock().map_err(|_| "busy")?.take() else {
        return Ok(());
    };
    let path = base_path(state, scope);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&base).map_err(|e| e.to_string())?)
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("could not save the sync state: {e}"))
}

/// Forgets the team merge base (team key replaced or left the team).
pub(crate) fn forget_base(state: &AppState, scope: Scope) {
    let _ = std::fs::remove_file(base_path(state, scope));
}

/// Writes the merged library here: hosts.json and the keyring. Only the
/// items of `scope` are replaced; the other scope's items stay as they are.
fn apply(state: &Arc<AppState>, local: &Doc, merged: &Doc, scope: Scope) -> Result<(), String> {
    let team = scope == Scope::Team;
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        let current: BTreeMap<String, SavedHost> = data
            .hosts
            .iter()
            .map(|h| (h.id.clone(), h.clone()))
            .collect();
        // Keep this computer's order; new items go to the end.
        let mut hosts: Vec<SavedHost> = Vec::new();
        for h in &data.hosts {
            if h.team != team {
                hosts.push(h.clone());
            } else if let Some(m) = merged.hosts.get(&h.id) {
                hosts.push(m.clone());
            }
        }
        for (id, h) in &merged.hosts {
            if !hosts.iter().any(|x| &x.id == id) {
                hosts.push(h.clone());
            }
        }
        for h in hosts.iter_mut().filter(|h| h.team == team) {
            // This computer's own fields: key file, and for team hosts the
            // app key, identity and a personal jump host.
            if let Some(c) = current.get(&h.id) {
                h.key_path = c.key_path.clone();
                if team {
                    h.key_id = c.key_id.clone();
                    h.identity_id = c.identity_id.clone();
                    if h.jump_id.is_none() {
                        h.jump_id = c.jump_id.clone();
                    }
                }
            } else {
                h.key_path = None;
            }
        }
        hosts.retain(|h| h.profile.validate().is_ok());
        data.hosts = hosts;
        let mut snippets: Vec<Snippet> = data
            .snippets
            .iter()
            .filter_map(|s| {
                if s.team != team {
                    Some(s.clone())
                } else {
                    merged.snippets.get(&s.id).cloned()
                }
            })
            .collect();
        for (id, s) in &merged.snippets {
            if !snippets.iter().any(|x| &x.id == id) {
                snippets.push(s.clone());
            }
        }
        data.snippets = snippets;
        if team {
            for k in local.known_hosts.keys() {
                if !merged.known_hosts.contains_key(k) {
                    data.known_hosts.remove(k);
                }
            }
            for (k, v) in &merged.known_hosts {
                data.known_hosts.insert(k.clone(), v.clone());
            }
        } else {
            data.identities = ordered(&data.identities, &merged.identities, |i| &i.id);
            data.keys = ordered(&data.keys, &merged.keys, |k| &k.id);
            // Team hosts' trusted keys stay even when the personal library
            // does not have them yet.
            let team_targets: BTreeSet<String> = data
                .hosts
                .iter()
                .filter(|h| h.team)
                .map(|h| format!("{}:{}", h.profile.host, h.profile.port))
                .collect();
            let mut known: std::collections::HashMap<String, String> =
                merged.known_hosts.clone().into_iter().collect();
            for (k, v) in data
                .known_hosts
                .iter()
                .filter(|(k, _)| team_targets.contains(*k))
            {
                known.entry(k.clone()).or_insert_with(|| v.clone());
            }
            data.known_hosts = known;
        }
        state.save(&data)?;
    }
    for (name, value) in &merged.secrets {
        if local.secrets.get(name) != Some(value) {
            let _ = state.vault.put(name, value);
        }
    }
    for name in local.secrets.keys() {
        if !merged.secrets.contains_key(name) {
            let _ = state.vault.delete(name);
        }
    }
    state.changed();
    Ok(())
}

fn ordered<T: Clone>(
    current: &[T],
    merged: &BTreeMap<String, T>,
    id: impl Fn(&T) -> &String,
) -> Vec<T> {
    let mut out: Vec<T> = current
        .iter()
        .filter_map(|x| merged.get(id(x)).cloned())
        .collect();
    for (k, v) in merged {
        if !out.iter().any(|x| id(x) == k) {
            out.push(v.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wc_ssh_core::HostProfile;

    fn host(id: &str, label: &str) -> SavedHost {
        SavedHost {
            id: id.into(),
            profile: HostProfile::new(label, &format!("{id}.example.com"), 22, "deploy").unwrap(),
            auth_kind: "key".into(),
            key_path: None,
            jump_id: None,
            tunnels: Vec::new(),
            group: None,
            key_id: None,
            startup_command: None,
            env: Default::default(),
            agent_forwarding: false,
            identity_id: None,
            team: false,
        }
    }

    fn doc(hosts: &[SavedHost]) -> Doc {
        Doc {
            hosts: hosts.iter().map(|h| (h.id.clone(), h.clone())).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn three_way_merge_keeps_changes_from_both_sides() {
        let base_doc = doc(&[host("a", "A"), host("b", "B"), host("c", "C")]);
        let base = base_of(&base_doc);
        // Here: edited a, deleted b, added d.
        let local = doc(&[host("a", "A here"), host("c", "C"), host("d", "D")]);
        // There: deleted c, added e, b unchanged.
        let remote = doc(&[host("a", "A"), host("b", "B"), host("e", "E")]);
        let m = merge_docs(&local, &remote, &base);
        let labels: Vec<_> = m.hosts.values().map(|h| h.profile.label.clone()).collect();
        assert_eq!(labels, ["A here", "D", "E"]);
    }

    #[test]
    fn conflicts_prefer_the_server_but_never_lose_an_edit() {
        let base = base_of(&doc(&[host("a", "A"), host("b", "B")]));
        let local = doc(&[host("a", "A here"), host("b", "B here")]);
        let remote = doc(&[host("a", "A there")]); // b deleted there
        let m = merge_docs(&local, &remote, &base);
        assert_eq!(m.hosts["a"].profile.label, "A there");
        assert_eq!(m.hosts["b"].profile.label, "B here");
    }

    #[test]
    fn first_sync_is_a_union() {
        let m = merge_docs(
            &doc(&[host("a", "A")]),
            &doc(&[host("b", "B")]),
            &Base::default(),
        );
        assert_eq!(m.hosts.len(), 2);
    }

    #[test]
    fn dangling_references_are_dropped() {
        let mut a = host("a", "A");
        a.jump_id = Some("gone".into());
        a.key_id = Some("k".into());
        let m = merge_docs(&doc(&[a]), &Doc::default(), &Base::default());
        assert_eq!(
            (m.hosts["a"].jump_id.clone(), m.hosts["a"].key_id.clone()),
            (None, None)
        );
    }

    #[test]
    fn envelope_round_trip_and_wrong_key() {
        let mut d = doc(&[host("a", "A")]);
        d.secrets.insert("host/a/password".into(), "s3cret".into());
        let salt = [7u8; 16];
        let key = derive("correct horse battery", &salt).unwrap();
        let env = seal(&key, &salt, &d).unwrap();
        let text = serde_json::to_string(&env).unwrap();
        assert!(
            !text.contains("s3cret") && !text.contains("example.com"),
            "nothing readable on the server"
        );
        assert_eq!(open(&key, &env).unwrap(), d);
        let wrong = derive("another passphrase", &salt).unwrap();
        assert_eq!(open(&wrong, &env).unwrap_err(), "wrong sync passphrase");
    }
}
