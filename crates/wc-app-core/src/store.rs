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
    /// Another saved host used as the jump host (bastion), A10.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_id: Option<String>,
    /// Saved local forwards, started from the tray (A10).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tunnels: Vec<SavedTunnel>,
    /// Group shown in the host list ("Production", "Customers/Acme").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// A key from the app's key list (its private half is in the keyring).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    /// Typed into the terminal right after it opens (e.g. `cd /srv && ls`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_command: Option<String>,
    /// Environment variables sent when the terminal opens (the server's
    /// `AcceptEnv` decides which it keeps).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
    /// Lets this server use this computer's SSH agent (`ssh -A`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub agent_forwarding: bool,
    /// A saved identity (user + key or password) used instead of the
    /// host's own user and credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_id: Option<String>,
    /// Shared with the team (A22): synced through the team library.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub team: bool,
    /// How the app reaches the host: SSH unless it says otherwise.
    #[serde(flatten)]
    pub link: Link,
}

/// The connection kind of a host: SSH (empty), "telnet", "serial" or "mosh".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<SerialSettings>,
}

impl Link {
    /// "ssh", "telnet", "serial" or "mosh".
    pub fn kind(&self) -> &str {
        if self.protocol.is_empty() {
            "ssh"
        } else {
            &self.protocol
        }
    }
}

/// A serial port and its line settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialSettings {
    /// COM3, /dev/ttyUSB0, /dev/cu.usbserial-1410 ...
    pub device: String,
    pub baud: u32,
    #[serde(default = "eight")]
    pub data_bits: u8,
    /// "none", "even" or "odd".
    #[serde(default = "none")]
    pub parity: String,
    #[serde(default = "one")]
    pub stop_bits: u8,
    /// "none", "hardware" (RTS/CTS) or "software" (XON/XOFF).
    #[serde(default = "none")]
    pub flow: String,
}

fn eight() -> u8 {
    8
}
fn one() -> u8 {
    1
}
fn none() -> String {
    "none".into()
}

/// A user name with a credential, shared by many hosts ("deploy with the
/// team key"). A password lives in the keyring under
/// `identity/<id>/password`; a key is one of the app keys.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub label: String,
    pub user: String,
    /// "key" or "password".
    pub auth_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

/// Keyring entry of an identity's password.
pub fn identity_secret(identity_id: &str) -> String {
    format!("identity/{identity_id}/password")
}

/// A key pair made or imported in the app. The private key is in the OS
/// keyring under `key/<id>/private`; this is what may be shown.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyMeta {
    pub id: String,
    pub label: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
    /// Unix seconds.
    pub created: u64,
}

/// A saved command (A14), sent to a terminal or several at once.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub label: String,
    pub command: String,
    /// Shared with the team (A22).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub team: bool,
}

/// One connection, newest first in the history view.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub host_id: String,
    pub label: String,
    pub target: String,
    /// Unix seconds.
    pub at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedTunnel {
    /// `local` (ssh -L), `remote` (ssh -R) or `dynamic` (ssh -D, SOCKS5).
    #[serde(default = "local_kind", skip_serializing_if = "is_local_kind")]
    pub kind: String,
    /// local/dynamic: the port on this computer. remote: the port of the
    /// service on this computer that the server reaches.
    pub local_port: u16,
    /// remote only: the host on this side the server reaches (default
    /// 127.0.0.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_host: Option<String>,
    /// local: the target host as seen from the server. remote: the address
    /// the server listens on. dynamic: unused.
    pub remote_host: String,
    /// local: the target port. remote: the port the server listens on.
    pub remote_port: u16,
}

fn local_kind() -> String {
    "local".into()
}

fn is_local_kind(kind: &String) -> bool {
    kind == "local"
}

#[derive(Default, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    pub hosts: Vec<SavedHost>,
    /// `host:port` -> trusted `SHA256:` fingerprint.
    pub known_hosts: HashMap<String, String>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    #[serde(default)]
    pub keys: Vec<KeyMeta>,
    #[serde(default)]
    pub identities: Vec<Identity>,
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

    /// The app data folder.
    pub fn dir(&self) -> &Path {
        self.path.parent().unwrap_or(Path::new("."))
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

/// Keyring entry of an app key: `private` or `passphrase`.
pub fn key_secret(key_id: &str, part: &str) -> String {
    format!("key/{key_id}/{part}")
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
            jump_id: None,
            tunnels: Vec::new(),
            group: None,
            key_id: None,
            startup_command: None,
            env: Default::default(),
            agent_forwarding: false,
            identity_id: None,
            team: false,
            link: Default::default(),
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
