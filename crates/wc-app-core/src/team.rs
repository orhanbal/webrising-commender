//! Team library (A22): hosts and snippets shared with the team, end-to-end
//! encrypted with a random team key.
//!
//! Each app has an X25519 key pair (private half in the keyring) and
//! publishes the public half. An app that has the team key gives it to
//! another app by sealing it to that app's public key (ephemeral X25519 +
//! SHA-256 + AES-256-GCM); the server only relays public keys and sealed
//! keys. The team library itself is merged exactly like the personal one
//! ([`crate::sync`] with [`Scope::Team`]).
use crate::sync::{self, MergeResult, Pending, Scope};
use crate::AppState;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes256Gcm;
use base64::Engine;
use curve25519_dalek::montgomery::MontgomeryPoint;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;

const TEAM_KEY_ENTRY: &str = "team/key";
const DEVICE_KEY_ENTRY: &str = "team/device-private";
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The team library waiting for the server to accept it.
#[derive(Default)]
pub struct TeamPending(pub Pending);

fn random32() -> Result<[u8; 32], String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(b)
}

fn device_private(state: &AppState) -> Result<[u8; 32], String> {
    if let Some(k) = state
        .vault
        .get(DEVICE_KEY_ENTRY)
        .ok()
        .flatten()
        .and_then(|t| B64.decode(t).ok())
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
    {
        return Ok(k);
    }
    let k = random32()?;
    state
        .vault
        .put(DEVICE_KEY_ENTRY, &B64.encode(k))
        .map_err(|e| format!("could not store the team key pair: {e:?}"))?;
    Ok(k)
}

fn public_of(private: [u8; 32]) -> [u8; 32] {
    MontgomeryPoint::mul_base_clamped(private).to_bytes()
}

fn seal_key(recipient: [u8; 32], team_key: &[u8; 32]) -> Result<String, String> {
    let eph = random32()?;
    let eph_pub = public_of(eph);
    let shared = MontgomeryPoint(recipient).mul_clamped(eph).to_bytes();
    if shared == [0u8; 32] {
        return Err("invalid public key".into());
    }
    let key = kdf(&shared, &eph_pub, &recipient);
    let nonce = [0u8; 12]; // each sealing uses a fresh ephemeral key
    let ct = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "bad key")?
        .encrypt(&nonce.into(), team_key.as_slice())
        .map_err(|_| "could not seal the team key")?;
    let mut out = eph_pub.to_vec();
    out.extend_from_slice(&ct);
    Ok(B64.encode(out))
}

fn open_key(private: [u8; 32], sealed: &str) -> Result<[u8; 32], String> {
    let raw = B64.decode(sealed).map_err(|_| "damaged team key")?;
    if raw.len() != 32 + 32 + 16 {
        return Err("damaged team key".into());
    }
    let eph_pub: [u8; 32] = raw[..32].try_into().map_err(|_| "damaged team key")?;
    let me = public_of(private);
    let shared = MontgomeryPoint(eph_pub).mul_clamped(private).to_bytes();
    let key = kdf(&shared, &eph_pub, &me);
    let plain = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "bad key")?
        .decrypt(&[0u8; 12].into(), &raw[32..])
        .map_err(|_| "this team key was sealed for another app".to_string())?;
    plain.try_into().map_err(|_| "damaged team key".into())
}

fn kdf(shared: &[u8; 32], eph_pub: &[u8; 32], recipient: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"wecommander-team-v1");
    h.update(shared);
    h.update(eph_pub);
    h.update(recipient);
    h.finalize().into()
}

fn team_key(state: &AppState) -> Option<[u8; 32]> {
    state
        .vault
        .get(TEAM_KEY_ENTRY)
        .ok()
        .flatten()
        .and_then(|t| B64.decode(t).ok())
        .and_then(|b| b.try_into().ok())
}

fn store_team_key(state: &AppState, key: &[u8; 32]) -> Result<(), String> {
    let changed = team_key(state).as_ref() != Some(key);
    state
        .vault
        .put(TEAM_KEY_ENTRY, &B64.encode(key))
        .map_err(|e| format!("could not store the team key: {e:?}"))?;
    if changed {
        sync::forget_base(state, Scope::Team);
    }
    Ok(())
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamStatus {
    /// This app's public key, to publish (`PUT /api/center/team/key`).
    pub public_key: String,
    pub has_key: bool,
}

pub fn status(state: &Arc<AppState>) -> Result<TeamStatus, String> {
    Ok(TeamStatus {
        public_key: B64.encode(public_of(device_private(state)?)),
        has_key: team_key(state).is_some(),
    })
}

/// Makes a new team key (the first app of a team) and returns it sealed for
/// this app, to publish as this app's wrapped key.
pub fn create(state: &Arc<AppState>) -> Result<String, String> {
    let key = random32()?;
    let sealed = seal_key(public_of(device_private(state)?), &key)?;
    store_team_key(state, &key)?;
    Ok(sealed)
}

/// Takes the team key another app sealed for this one.
pub fn accept(state: &Arc<AppState>, sealed: String) -> Result<TeamStatus, String> {
    let key = open_key(device_private(state)?, &sealed)?;
    store_team_key(state, &key)?;
    status(state)
}

/// Seals the team key for another app of the team.
pub fn share(state: &Arc<AppState>, public_key: String) -> Result<String, String> {
    let key = team_key(state).ok_or("this app does not have the team key yet")?;
    let recipient: [u8; 32] = B64
        .decode(public_key.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("invalid public key")?;
    seal_key(recipient, &key)
}

/// Left the team or removed: the team key and the shared items go.
pub fn leave(state: &Arc<AppState>) -> Result<(), String> {
    let _ = state.vault.delete(TEAM_KEY_ENTRY);
    sync::forget_base(state, Scope::Team);
    {
        let mut data = state.data.lock().map_err(|_| "busy")?;
        data.hosts.retain(|h| !h.team);
        data.snippets.retain(|s| !s.team);
        state.save(&data)?;
    }
    state.changed();
    Ok(())
}

/// A27: seals one frame of a shared terminal (output or keys) with the team
/// key, so the relay never sees the session.
pub fn seal_frame(state: &Arc<AppState>, data: String) -> Result<String, String> {
    let key = team_key(state).ok_or("this app does not have the team key yet")?;
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let ct = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "bad key")?
        .encrypt(&nonce.into(), data.as_bytes())
        .map_err(|_| "could not encrypt")?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(B64.encode(out))
}

pub fn open_frame(state: &Arc<AppState>, sealed: String) -> Result<String, String> {
    let key = team_key(state).ok_or("this app does not have the team key yet")?;
    let raw = B64.decode(sealed).map_err(|_| "damaged frame")?;
    if raw.len() < 12 + 16 {
        return Err("damaged frame".into());
    }
    let nonce: [u8; 12] = raw[..12].try_into().map_err(|_| "damaged frame")?;
    let plain = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "bad key")?
        .decrypt(&nonce.into(), &raw[12..])
        .map_err(|_| "this frame was not sealed with the team key".to_string())?;
    String::from_utf8(plain).map_err(|_| "damaged frame".into())
}

pub fn merge(
    state: &Arc<AppState>,
    pending: &TeamPending,
    remote: Option<String>,
) -> Result<MergeResult, String> {
    let key = team_key(state).ok_or("this app does not have the team key yet")?;
    sync::merge_scope(state, &pending.0, remote, Scope::Team, &key, b"")
}

pub fn committed(state: &Arc<AppState>, pending: &TeamPending) -> Result<(), String> {
    sync::committed_scope(state, &pending.0, Scope::Team)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_team_key_opens_only_for_its_recipient() {
        let alice = random32().unwrap();
        let bob = random32().unwrap();
        let key = random32().unwrap();
        let sealed = seal_key(public_of(bob), &key).unwrap();
        assert_eq!(open_key(bob, &sealed).unwrap(), key);
        assert!(open_key(alice, &sealed).is_err());
        assert!(open_key(bob, "AAAA").is_err());
        assert!(
            seal_key([0u8; 32], &key).is_err(),
            "a low-order public key is refused"
        );
    }
}
