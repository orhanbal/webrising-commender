//! SSH key pairs made or imported in the app (A05): a new Ed25519 key, or an
//! existing private key checked and described. Private keys go to the OS
//! keyring (wc-vault); only the public half and the fingerprint are stored
//! in plain files.
use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
use russh::keys::ssh_key::LineEnding;
use russh::keys::{HashAlg, PrivateKey};

/// A key pair: the private key in OpenSSH format (secret) and what may be
/// shown or copied (public key line, fingerprint, algorithm).
pub struct KeyMaterial {
    pub private_openssh: String,
    pub info: KeyInfo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInfo {
    /// `ssh-ed25519 AAAA... comment`, for `~/.ssh/authorized_keys`.
    pub public_openssh: String,
    /// `SHA256:...`.
    pub fingerprint: String,
    pub algorithm: String,
}

fn describe(key: &PrivateKey) -> Result<KeyInfo, String> {
    Ok(KeyInfo {
        public_openssh: key.public_key().to_openssh().map_err(|e| e.to_string())?,
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        algorithm: key.algorithm().as_str().to_owned(),
    })
}

/// A new Ed25519 key pair with `comment` (for example "WECOMMANDER laptop").
pub fn generate_ed25519(comment: &str) -> Result<KeyMaterial, String> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| format!("no system randomness: {e}"))?;
    let pair = Ed25519Keypair::from_seed(&seed);
    seed.fill(0);
    let key = PrivateKey::new(KeypairData::from(pair), comment).map_err(|e| e.to_string())?;
    let private_openssh = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| e.to_string())?
        .to_string();
    Ok(KeyMaterial {
        info: describe(&key)?,
        private_openssh,
    })
}

/// Checks a pasted or read private key (with its passphrase, if any) and
/// describes it. The key itself is returned unchanged by the caller.
pub fn inspect(private: &str, passphrase: Option<&str>) -> Result<KeyInfo, String> {
    let key = russh::keys::decode_secret_key(private, passphrase)
        .map_err(|e| format!("private key could not be used: {e}"))?;
    describe(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_are_unique_and_readable_again() {
        let a = generate_ed25519("test key").unwrap();
        let b = generate_ed25519("test key").unwrap();
        assert_ne!(a.info.fingerprint, b.info.fingerprint);
        assert!(a
            .private_openssh
            .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(a.info.public_openssh.starts_with("ssh-ed25519 AAAA"));
        assert!(a.info.public_openssh.ends_with(" test key"));
        assert!(a.info.fingerprint.starts_with("SHA256:"));
        assert_eq!(a.info.algorithm, "ssh-ed25519");
        assert_eq!(inspect(&a.private_openssh, None).unwrap(), a.info);
    }

    #[test]
    fn garbage_is_refused() {
        assert!(inspect("not a key", None)
            .unwrap_err()
            .starts_with("private key could not be used"));
    }
}
