//! WECOMMANDER local vault.
//!
//! V2 A01 skeleton: the secret store interface the desktop app uses and an
//! in-memory backend for tests. The OS keyrings (Windows Credential Manager,
//! macOS Keychain, Linux Secret Service) and the master-password fallback
//! arrive with A05 after the G1 keyring smoke test.
use std::collections::HashMap;
use std::sync::Mutex;

/// Where secrets would be kept on this computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    WindowsCredentialManager,
    MacKeychain,
    LinuxSecretService,
    /// No OS keyring (headless Linux): encrypted file behind a master password.
    MasterPassword,
    Memory,
}

impl Backend {
    /// The backend this platform uses by default.
    pub fn platform_default() -> Self {
        if cfg!(windows) {
            Backend::WindowsCredentialManager
        } else if cfg!(target_os = "macos") {
            Backend::MacKeychain
        } else {
            Backend::LinuxSecretService
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Backend::WindowsCredentialManager => "Windows Credential Manager",
            Backend::MacKeychain => "macOS Keychain",
            Backend::LinuxSecretService => "Secret Service",
            Backend::MasterPassword => "Master password",
            Backend::Memory => "Memory (test)",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum VaultError {
    InvalidKey,
    Unavailable,
}

/// A store for secrets (passwords, private key passphrases, tokens) keyed by
/// a stable id such as `host/<uuid>/password`.
pub trait SecretStore: Send + Sync {
    fn backend(&self) -> Backend;
    fn put(&self, key: &str, secret: &str) -> Result<(), VaultError>;
    fn get(&self, key: &str) -> Result<Option<String>, VaultError>;
    fn delete(&self, key: &str) -> Result<bool, VaultError>;
}

fn check_key(key: &str) -> Result<(), VaultError> {
    if key.is_empty()
        || key.len() > 200
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
    {
        return Err(VaultError::InvalidKey);
    }
    Ok(())
}

/// In-memory store: tests and the skeleton app until A05.
#[derive(Default)]
pub struct MemoryStore {
    items: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemoryStore {
    fn backend(&self) -> Backend {
        Backend::Memory
    }
    fn put(&self, key: &str, secret: &str) -> Result<(), VaultError> {
        check_key(key)?;
        self.items
            .lock()
            .map_err(|_| VaultError::Unavailable)?
            .insert(key.to_owned(), secret.to_owned());
        Ok(())
    }
    fn get(&self, key: &str) -> Result<Option<String>, VaultError> {
        check_key(key)?;
        Ok(self
            .items
            .lock()
            .map_err(|_| VaultError::Unavailable)?
            .get(key)
            .cloned())
    }
    fn delete(&self, key: &str) -> Result<bool, VaultError> {
        check_key(key)?;
        Ok(self
            .items
            .lock()
            .map_err(|_| VaultError::Unavailable)?
            .remove(key)
            .is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trip() {
        let store = MemoryStore::default();
        assert_eq!(store.get("host/1/password"), Ok(None));
        store.put("host/1/password", "s3cret").unwrap();
        assert_eq!(store.get("host/1/password"), Ok(Some("s3cret".into())));
        assert_eq!(store.delete("host/1/password"), Ok(true));
        assert_eq!(store.delete("host/1/password"), Ok(false));
    }

    #[test]
    fn rejects_unsafe_keys() {
        let store = MemoryStore::default();
        assert_eq!(store.put("", "x"), Err(VaultError::InvalidKey));
        assert_eq!(store.put("a b", "x"), Err(VaultError::InvalidKey));
        assert_eq!(store.get("../etc"), Ok(None));
    }

    #[test]
    fn platform_default_is_an_os_keyring() {
        assert_ne!(Backend::platform_default(), Backend::Memory);
        assert!(!Backend::platform_default().label().is_empty());
    }
}
