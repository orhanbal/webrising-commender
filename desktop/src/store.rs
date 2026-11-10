//! Saved hosts and trusted host keys (A07), kept as JSON in the app data
//! folder. Secrets never go here: passwords and keys live in the OS keyring
//! (wc-vault), keyed by the host id.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use wc_ssh_core::HostProfile;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedHost {
    pub id: String,
    #[serde(flatten)]
    pub profile: HostProfile,
    /// "key" or "password": which form the connect dialog opens with.
    pub auth_kind: String,
    /// Private key file on this computer (for example `~/.ssh/id_ed25519`).
    /// The key is read at connect time and never copied into the keyring.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
}

#[derive(Default, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    pub hosts: Vec<SavedHost>,
    /// `host:port` -> trusted `SHA256:` fingerprint.
    pub known_hosts: HashMap<String, String>,
}

pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("hosts.json"),
        }
    }

    pub fn load(&self) -> Data {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Data>(&bytes).ok())
            .map(|mut data| {
                data.hosts.retain(|h| h.profile.validate().is_ok());
                data
            })
            .unwrap_or_default()
    }

    /// Atomic write (temp file + rename), readable only by this user.
    pub fn save(&self, data: &Data) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, &self.path)
    }
}

pub fn secret_key(host_id: &str, part: &str) -> String {
    format!("host/{host_id}/{part}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_bad_entries_dropped() {
        let dir = std::env::temp_dir().join(format!("wc-store-{}", std::process::id()));
        let store = Store::new(&dir);
        assert_eq!(store.load(), Data::default());
        let mut data = Data::default();
        data.hosts.push(SavedHost {
            id: "a".into(),
            profile: HostProfile::new("Web", "srv.example.com", 22, "deploy").unwrap(),
            auth_kind: "key".into(),
            key_path: None,
        });
        data.known_hosts
            .insert("srv.example.com:22".into(), "SHA256:x".into());
        store.save(&data).unwrap();
        assert_eq!(store.load(), data);
        // A hand-edited invalid host is ignored, not fatal.
        let text = std::fs::read_to_string(dir.join("hosts.json"))
            .unwrap()
            .replace("srv.example.com\"", "bad host\"");
        std::fs::write(dir.join("hosts.json"), text).unwrap();
        assert!(store.load().hosts.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
