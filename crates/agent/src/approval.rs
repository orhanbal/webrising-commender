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

    let approved_action: AgentAction = serde_json::from_value(claim.request)
        .context("invalid approved operation payload")?;
    if &approved_action != action {
        return Err(anyhow!(
            "approval token parameters do not match the requested operation"
        ));
    }

    if claim.exp < now {
        return Err(anyhow!("approval token has expired"));
    }
    if claim.nonce.len() < 16 {
        return Err(anyhow!("approval token nonce is invalid"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token(key: &[u8], device_id: &str, action: &AgentAction, exp: u64) -> String {
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "deviceId": device_id,
                "action": action.kind_name(),
                "request": serde_json::to_value(action).unwrap(),
                "exp": exp,
                "nonce": "0123456789abcdef"
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
}
