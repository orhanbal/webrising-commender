//! Settings (plain JSON in the app config folder) and the center token.
//!
//! The token goes to the operating system's credential store on Windows
//! (Credential Manager) and macOS (Keychain). On Linux it is a file readable
//! only by the user (0600). It is never logged and never sent to the window.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_SERVER: &str = "https://wecommander.app";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub server: String,
    /// Desktop notification for each new approval request.
    pub notifications: bool,
    /// Bring the window to the front when a new request arrives.
    pub open_on_request: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: DEFAULT_SERVER.to_owned(),
            notifications: true,
            open_on_request: true,
        }
    }
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

/// Settings and whether they existed before (first run enables autostart).
pub fn load_settings(dir: &Path) -> (Settings, bool) {
    match std::fs::read(settings_path(dir)) {
        Ok(bytes) => (serde_json::from_slice(&bytes).unwrap_or_default(), true),
        Err(_) => (Settings::default(), false),
    }
}

pub fn save_settings(dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(dir), body).map_err(|e| e.to_string())
}

/// Accept https, or http only for this computer (development gateways).
pub fn normalize_server(input: &str) -> Result<String, String> {
    let parsed =
        url::Url::parse(input.trim()).map_err(|_| "Geçerli bir sunucu adresi girin.".to_owned())?;
    let host = parsed.host_str().unwrap_or("");
    let local = matches!(host, "127.0.0.1" | "localhost" | "[::1]");
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local) {
        return Err("Sunucu adresi https:// ile başlamalı.".to_owned());
    }
    if host.is_empty() || parsed.path() != "/" || parsed.query().is_some() {
        return Err(
            "Sunucu adresi yalnızca alan adı olmalı, ör. https://wecommander.app".to_owned(),
        );
    }
    Ok(parsed.as_str().trim_end_matches('/').to_owned())
}

#[cfg(any(windows, target_os = "macos"))]
mod secret {
    const SERVICE: &str = "WECOMMANDER Center";

    fn entry(server: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, server).map_err(|e| e.to_string())
    }
    pub fn load(_dir: &std::path::Path, server: &str) -> Option<String> {
        entry(server).ok()?.get_password().ok()
    }
    pub fn save(_dir: &std::path::Path, server: &str, token: &str) -> Result<(), String> {
        entry(server)?
            .set_password(token)
            .map_err(|e| e.to_string())
    }
    pub fn delete(_dir: &std::path::Path, server: &str) {
        if let Ok(entry) = entry(server) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod secret {
    use std::path::{Path, PathBuf};

    #[derive(serde::Serialize, serde::Deserialize)]
    struct Stored {
        server: String,
        token: String,
    }
    fn path(dir: &Path) -> PathBuf {
        dir.join("center-token.json")
    }
    pub fn load(dir: &Path, server: &str) -> Option<String> {
        let stored: Stored = serde_json::from_slice(&std::fs::read(path(dir)).ok()?).ok()?;
        (stored.server == server).then_some(stored.token)
    }
    pub fn save(dir: &Path, server: &str, token: &str) -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let body = serde_json::to_vec(&Stored {
            server: server.to_owned(),
            token: token.to_owned(),
        })
        .map_err(|e| e.to_string())?;
        let tmp = dir.join("center-token.json.tmp");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        file.write_all(&body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path(dir)).map_err(|e| e.to_string())
    }
    pub fn delete(dir: &Path, _server: &str) {
        let _ = std::fs::remove_file(path(dir));
    }
}

pub use secret::{delete as delete_token, load as load_token, save as save_token};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_must_be_https_origin() {
        assert_eq!(
            normalize_server("https://wecommander.app/").unwrap(),
            "https://wecommander.app"
        );
        assert_eq!(
            normalize_server(" https://example.com ").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            normalize_server("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(normalize_server("http://wecommander.app").is_err());
        assert!(normalize_server("https://wecommander.app/mcp").is_err());
        assert!(normalize_server("ftp://x").is_err());
        assert!(normalize_server("wecommander.app").is_err());
    }

    #[test]
    fn settings_round_trip_and_defaults() {
        let dir = std::env::temp_dir().join(format!("wmc-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (initial, existed) = load_settings(&dir);
        assert!(!existed);
        assert_eq!(initial.server, DEFAULT_SERVER);
        let changed = Settings {
            notifications: false,
            ..initial
        };
        save_settings(&dir, &changed).unwrap();
        let (loaded, existed) = load_settings(&dir);
        assert!(existed);
        assert!(!loaded.notifications && loaded.open_on_request);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
