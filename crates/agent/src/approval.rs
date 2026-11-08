use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::Value;

use crate::protocol::AgentAction;
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalClaim {
    device_id: String,
    action: String,
    request: Value,
    exp: u64,
    nonce: String,
}

pub fn verify(
    token: &str,
    approval_key: &str,
    device_id: &str,
    action: &AgentAction,
) -> Result<()> {
    let (payload, signature) = token
        .split_once('.')
        .ok_or_else(|| anyhow!("invalid approval token format"))?;

    let key = URL_SAFE_NO_PAD
        .decode(approval_key)
        .context("invalid device approval key")?;
    if key.len() < 32 {
        return Err(anyhow!("device approval key is too short"));
    }

    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .context("invalid approval token signature")?;

    let mut mac = HmacSha256::new_from_slice(&key)
        .map_err(|_| anyhow!("invalid approval verification key"))?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| anyhow!("approval token signature mismatch"))?;

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .context("invalid approval token payload")?;
    let claim: ApprovalClaim =
        serde_json::from_slice(&payload_bytes).context("invalid approval token claim")?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| anyhow!("system clock is before unix epoch"))?
        .as_secs();

    if claim.device_id != device_id {
        return Err(anyhow!("approval token is for another device"));
    }
    if claim.action != action.kind_name() {
        return Err(anyhow!("approval token is for another action"));
    }

    let approved_action: AgentAction =
        serde_json::from_value(claim.request).context("invalid approved operation payload")?;
    if &approved_action != action {
        return Err(anyhow!(
            "approval token parameters do not match the requested operation"
        ));
    }

    if claim.exp < now {
        return Err(anyhow!("approval token has expired"));
    }
    if claim.nonce.len() < 16
        || claim.nonce.len() > 128
        || !claim
            .nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(anyhow!("approval token nonce is invalid"));
    }

    // One approval runs one operation, also on this side: the nonce is
    // written to disk before the operation starts, and a token whose nonce
    // was already used is refused, even after an Agent restart.
    nonce_journal::record(device_id, &claim.nonce, claim.exp, now)
}

mod nonce_journal {
    use anyhow::{anyhow, Context, Result};
    use std::collections::HashMap;
    use std::fs::{self, File, OpenOptions};
    use std::io::{BufRead, BufReader, Write};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    struct Journal {
        file: File,
        seen: HashMap<String, u64>,
    }

    static JOURNALS: OnceLock<Mutex<HashMap<PathBuf, Journal>>> = OnceLock::new();

    fn path_for(device_id: &str) -> Result<PathBuf> {
        let safe: String = device_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(64)
            .collect();
        if safe.is_empty() {
            return Err(anyhow!("invalid device id for the approval journal"));
        }
        // Unit tests keep their journals out of the real data directory.
        #[cfg(test)]
        let root = std::env::temp_dir().join(format!("wc-approval-nonces-{}", std::process::id()));
        #[cfg(not(test))]
        let root = dirs::data_local_dir()
            .ok_or_else(|| anyhow!("local data directory unavailable"))?
            .join("webrising-commender")
            .join("approval-nonces");
        Ok(root.join(format!("{safe}.log")))
    }

    /// Loads unexpired nonces and rewrites the file without the expired ones.
    fn open(path: &Path, now: u64) -> Result<Journal> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).context("cannot create the approval journal directory")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
            }
        }
        let mut seen = HashMap::new();
        if let Ok(file) = File::open(path) {
            for line in BufReader::new(file).lines() {
                let line = line.context("cannot read the approval journal")?;
                if let Some((nonce, exp)) = line.split_once(' ') {
                    if let Ok(exp) = exp.parse::<u64>() {
                        if exp >= now {
                            seen.insert(nonce.to_owned(), exp);
                        }
                    }
                }
            }
        }
        let compacted = path.with_extension("log.tmp");
        {
            let mut out = File::create(&compacted).context("cannot write the approval journal")?;
            for (nonce, exp) in &seen {
                writeln!(out, "{nonce} {exp}")?;
            }
            out.sync_all()?;
        }
        fs::rename(&compacted, path).context("cannot replace the approval journal")?;
        let file = OpenOptions::new()
            .append(true)
            .open(path)
            .context("cannot open the approval journal")?;
        Ok(Journal { file, seen })
    }

    pub fn record(device_id: &str, nonce: &str, exp: u64, now: u64) -> Result<()> {
        let path = path_for(device_id)?;
        let journals = JOURNALS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut journals = journals
            .lock()
            .map_err(|_| anyhow!("approval journal lock poisoned"))?;
        if !journals.contains_key(&path) {
            let journal = open(&path, now)?;
            journals.insert(path.clone(), journal);
        }
        let journal = journals
            .get_mut(&path)
            .ok_or_else(|| anyhow!("approval journal unavailable"))?;
        if journal.seen.contains_key(nonce) {
            return Err(anyhow!("approval token was already used"));
        }
        writeln!(journal.file, "{nonce} {exp}").context("cannot write the approval journal")?;
        journal
            .file
            .sync_data()
            .context("cannot write the approval journal")?;
        journal.seen.insert(nonce.to_owned(), exp);
        if journal.seen.len() > 4096 {
            journal.seen.retain(|_, until| *until >= now);
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn forget_open_journals() {
        if let Some(journals) = JOURNALS.get() {
            journals.lock().unwrap().clear();
        }
    }
}

/// Signs a single-use approval for exactly `action` with the device key. Used
/// only by local stdio mode, where the person running the agent is the
/// approver and `--allow-commands`/`--allow-writes` express that consent.
pub fn sign(
    approval_key: &str,
    device_id: &str,
    action: &AgentAction,
    ttl_secs: u64,
) -> Result<String> {
    let key = URL_SAFE_NO_PAD
        .decode(approval_key)
        .context("invalid device approval key")?;
    let exp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| anyhow!("system clock is before unix epoch"))?
        .as_secs()
        + ttl_secs;
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({
        "deviceId": device_id,
        "action": action.kind_name(),
        "request": serde_json::to_value(action)?,
        "exp": exp,
        "nonce": uuid::Uuid::new_v4().simple().to_string(),
    }))?);
    let mut mac = HmacSha256::new_from_slice(&key).map_err(|_| anyhow!("invalid approval key"))?;
    mac.update(payload.as_bytes());
    Ok(format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signed_local_approval_verifies_only_for_the_same_action() {
        let key = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        let action = AgentAction::ProcessExec {
            command: "id".into(),
            cwd: None,
            timeout_ms: None,
        };
        let token = sign(&key, "local", &action, 60).unwrap();
        verify(&token, &key, "local", &action).unwrap();
        let other = AgentAction::ProcessExec {
            command: "rm -rf /".into(),
            cwd: None,
            timeout_ms: None,
        };
        assert!(verify(&token, &key, "local", &other).is_err());
        assert!(verify(&token, &key, "another-device", &action).is_err());
    }

    fn token(key: &[u8], device_id: &str, action: &AgentAction, exp: u64) -> String {
        token_with_nonce(
            key,
            device_id,
            action,
            exp,
            &uuid::Uuid::new_v4().simple().to_string(),
        )
    }

    fn token_with_nonce(
        key: &[u8],
        device_id: &str,
        action: &AgentAction,
        exp: u64,
        nonce: &str,
    ) -> String {
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "deviceId": device_id,
                "action": action.kind_name(),
                "request": serde_json::to_value(action).unwrap(),
                "exp": exp,
                "nonce": nonce
            }))
            .unwrap(),
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(payload.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{payload}.{signature}")
    }

    #[test]
    fn validates_device_bound_claim() {
        let key = [7_u8; 32];
        let key_text = URL_SAFE_NO_PAD.encode(key);
        let exp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 60;

        let action = AgentAction::ProcessExec {
            command: "echo approved".into(),
            cwd: None,
            timeout_ms: Some(30_000),
        };
        let value = token(&key, "device-a", &action, exp);
        assert!(verify(&value, &key_text, "device-a", &action).is_ok());
        assert!(verify(&value, &key_text, "device-b", &action).is_err());

        let changed = AgentAction::ProcessExec {
            command: "echo changed".into(),
            cwd: None,
            timeout_ms: Some(30_000),
        };
        assert!(verify(&value, &key_text, "device-a", &changed).is_err());
    }

    fn exp_in(secs: u64) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + secs
    }

    // B03: a token runs one operation on the Agent too, also after the Agent
    // restarted (the journal is read back from disk).
    #[test]
    fn a_used_token_is_refused_also_after_a_restart() {
        let key = [3_u8; 32];
        let key_text = URL_SAFE_NO_PAD.encode(key);
        let device = format!("replay-{}", uuid::Uuid::new_v4().simple());
        let action = AgentAction::ProcessExec {
            command: "id".into(),
            cwd: None,
            timeout_ms: None,
        };
        let value = token(&key, &device, &action, exp_in(60));
        verify(&value, &key_text, &device, &action).unwrap();
        let replay = verify(&value, &key_text, &device, &action).unwrap_err();
        assert!(replay.to_string().contains("already used"), "{replay}");

        nonce_journal::forget_open_journals();
        let after_restart = verify(&value, &key_text, &device, &action).unwrap_err();
        assert!(after_restart.to_string().contains("already used"));

        // A different token for the same operation is a new approval.
        let second = token(&key, &device, &action, exp_in(60));
        verify(&second, &key_text, &device, &action).unwrap();
    }

    #[test]
    fn expired_nonces_are_dropped_and_odd_nonces_refused() {
        let key = [4_u8; 32];
        let key_text = URL_SAFE_NO_PAD.encode(key);
        let device = format!("prune-{}", uuid::Uuid::new_v4().simple());
        let action = AgentAction::ProcessKill { pid: 1 };
        let value = token(&key, &device, &action, exp_in(60));
        verify(&value, &key_text, &device, &action).unwrap();
        let expired = token(&key, &device, &action, exp_in(0).saturating_sub(5));
        assert!(verify(&expired, &key_text, &device, &action)
            .unwrap_err()
            .to_string()
            .contains("expired"));
        for nonce in ["short", "has space in it 0123", "line\nbreak0123456789"] {
            let odd = token_with_nonce(&key, &device, &action, exp_in(60), nonce);
            assert!(verify(&odd, &key_text, &device, &action)
                .unwrap_err()
                .to_string()
                .contains("nonce is invalid"));
        }
    }
}
