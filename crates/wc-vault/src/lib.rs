//! WECOMMANDER local vault.
//!
//! The secret store interface the desktop app uses, an in-memory backend for
//! tests and sessions without a keyring, and (feature `os-keyring`) the OS
//! keyrings: Windows Credential Manager, macOS Keychain, Linux Secret Service.
//! The master-password file for headless Linux is a later slice (A05).
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

/// The OS keyring. Items are stored under the service name (for example
/// `app.wecommander.desktop`) with the vault key as the account.
#[cfg(feature = "os-keyring")]
pub struct OsKeyring {
    service: String,
}

#[cfg(feature = "os-keyring")]
impl OsKeyring {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_owned(),
        }
    }

    /// Writes, reads and deletes a probe item; `false` means the keyring is
    /// missing or locked (headless Linux without a Secret Service).
    pub fn probe(&self) -> bool {
        let key = "probe/availability";
        self.put(key, "ok").is_ok()
            && self.get(key).ok().flatten().as_deref() == Some("ok")
            && self.delete(key).is_ok()
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, VaultError> {
        check_key(key)?;
        keyring::Entry::new(&self.service, key).map_err(|_| VaultError::Unavailable)
    }
}

#[cfg(feature = "os-keyring")]
impl SecretStore for OsKeyring {
    fn backend(&self) -> Backend {
        Backend::platform_default()
    }
    fn put(&self, key: &str, secret: &str) -> Result<(), VaultError> {
        self.entry(key)?
            .set_password(secret)
            .map_err(|_| VaultError::Unavailable)
    }
    fn get(&self, key: &str) -> Result<Option<String>, VaultError> {
        match self.entry(key)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(VaultError::Unavailable),
        }
    }
    fn delete(&self, key: &str) -> Result<bool, VaultError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(VaultError::Unavailable),
        }
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

    /// G1 keyring smoke test. Needs an unlocked OS keyring, so it is ignored
    /// by default; CI runs it with `--ignored` on Windows, macOS and Linux
    /// (gnome-keyring in a D-Bus session).
    #[cfg(feature = "os-keyring")]
    #[test]
    #[ignore]
    fn os_keyring_smoke() {
        let store = OsKeyring::new("app.wecommander.desktop.ci");
        assert!(store.probe(), "OS keyring is not available");
        let key = format!("ci/{}/password", std::process::id());
        store.put(&key, "s3cret ü").unwrap();
        assert_eq!(store.get(&key), Ok(Some("s3cret ü".into())));
        store.put(&key, "rotated").unwrap();
        assert_eq!(store.get(&key), Ok(Some("rotated".into())));
        assert_eq!(store.delete(&key), Ok(true));
        assert_eq!(store.get(&key), Ok(None));
        assert_eq!(store.delete(&key), Ok(false));
    }
}
