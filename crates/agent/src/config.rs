use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_AGENT_CONFIG_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub device_id: String,
    pub device_token: String,
    pub approval_key: String,
    pub gateway_ws_url: String,
    pub control_url: String,
    pub name: String,
    pub allowed_roots: Vec<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentResponse {
    pub device_id: String,
    pub device_token: String,
    pub approval_key: String,
    pub gateway_ws_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteResponse {
    pub gateway_ws_url: String,
    pub relay_id: Option<String>,
    pub region: Option<String>,
}

impl AgentConfig {
    pub fn default_path() -> Result<PathBuf> {
        let base =
            dirs::config_dir().ok_or_else(|| anyhow!("cannot determine config directory"))?;
        Ok(base.join("webrising-commender").join("agent.json"))
    }

    pub fn load(path: &Path) -> Result<Self> {
        // A config holds device credentials: never follow a replaced symlink,
        // read a directory/device, or allocate unbounded memory for JSON.
        let metadata = fs::symlink_metadata(path)
            .with_context(|| format!("cannot read config {}", path.display()))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(anyhow!("unsafe_agent_config_target"));
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(0o400000); // O_NOFOLLOW
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(0x100); // O_NOFOLLOW
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let mut file = options
            .open(path)
            .with_context(|| format!("cannot read config {}", path.display()))?;
        let opened = file.metadata()?;
        if !opened.is_file() || opened.len() > MAX_AGENT_CONFIG_BYTES {
            return Err(anyhow!("unsafe_agent_config_target"));
        }
        let mut raw = Vec::new();
        file.take(MAX_AGENT_CONFIG_BYTES + 1)
            .read_to_end(&mut raw)?;
        if raw.len() as u64 > MAX_AGENT_CONFIG_BYTES {
            return Err(anyhow!("agent_config_too_large"));
        }
        let mut config: Self = serde_json::from_slice(&raw).context("invalid agent config")?;
        config.normalize_roots()?;
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("config parent unavailable"))?;
        fs::create_dir_all(parent)?;
        // A symlinked config directory could redirect credentials into an
        // attacker-controlled location even when the file itself is regular.
        let parent_meta = fs::symlink_metadata(parent)?;
        if !parent_meta.is_dir() || parent_meta.file_type().is_symlink() {
            return Err(anyhow!("unsafe_agent_config_parent"));
        }
        // Never follow an existing config symlink when writing credentials.
        match fs::symlink_metadata(path) {
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                return Err(anyhow!("unsafe_agent_config_target"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let data = serde_json::to_vec_pretty(self)?;
        let temporary = parent.join(format!(".agent-config-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&data)?;
            file.sync_all()?;
            drop(file);
            // Publish only fully synced content; failed writes preserve the
            // previous config instead of truncating its secrets or JSON.
            fs::rename(&temporary, path)?;
            #[cfg(unix)]
            {
                if let Ok(directory) = fs::File::open(parent) {
                    let _ = directory.sync_all();
                }
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn masked_json(&self) -> Result<String> {
        let mut value = serde_json::to_value(self)?;
        for key in ["deviceToken", "approvalKey"] {
            if let Some(secret) = value.get_mut(key) {
                *secret = serde_json::Value::String("[REDACTED]".into());
            }
        }
        Ok(serde_json::to_string_pretty(&value)?)
    }

    fn normalize_roots(&mut self) -> Result<()> {
        let mut normalized = Vec::new();
        for root in &self.allowed_roots {
            let canonical = fs::canonicalize(root)
                .with_context(|| format!("allowed root does not exist: {}", root.display()))?;
            if !normalized.contains(&canonical) {
                normalized.push(canonical);
            }
        }
        if normalized.is_empty() {
            return Err(anyhow!("at least one allowed root is required"));
        }
        self.allowed_roots = normalized;
        Ok(())
    }
}

pub fn default_allowed_root() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow!("cannot determine home directory"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_save_is_atomic_and_roundtrips_credentials() {
        let root = std::env::temp_dir().join(format!("wc-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("private").join("agent.json");
        let mut config = AgentConfig {
            device_id: "device".into(),
            device_token: "secret-token".into(),
            approval_key: "secret-approval".into(),
            gateway_ws_url: "wss://example.invalid/agent".into(),
            control_url: "https://example.invalid".into(),
            name: "test".into(),
            allowed_roots: vec![root.clone()],
        };
        config.save(&path).unwrap();
        assert_eq!(
            AgentConfig::load(&path).unwrap().device_token,
            "secret-token"
        );
        config.device_token = "new-token".into();
        config.save(&path).unwrap();
        assert_eq!(AgentConfig::load(&path).unwrap().device_token, "new-token");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn config_save_rejects_symlink_without_modifying_target() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("wc-config-link-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("target.json");
        fs::write(&target, b"unchanged").unwrap();
        let link = root.join("agent.json");
        symlink(&target, &link).unwrap();
        let config = AgentConfig {
            device_id: "device".into(),
            device_token: "secret".into(),
            approval_key: "key".into(),
            gateway_ws_url: String::new(),
            control_url: String::new(),
            name: String::new(),
            allowed_roots: vec![root.clone()],
        };
        assert!(config.save(&link).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"unchanged");
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn config_load_rejects_symlink_and_oversized_json() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("wc-config-read-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("target.json");
        fs::write(&target, b"{}").unwrap();
        let link = root.join("agent.json");
        symlink(&target, &link).unwrap();
        assert!(AgentConfig::load(&link).is_err());
        let oversized = root.join("oversized.json");
        fs::write(&oversized, vec![b'x'; MAX_AGENT_CONFIG_BYTES as usize + 1]).unwrap();
        assert!(AgentConfig::load(&oversized).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn config_save_rejects_symlinked_parent_without_leaking_credentials() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("wc-config-parent-{}", uuid::Uuid::new_v4()));
        let destination = root.join("destination");
        fs::create_dir_all(&destination).unwrap();
        let link = root.join("config-link");
        symlink(&destination, &link).unwrap();
        let config = AgentConfig {
            device_id: "device".into(),
            device_token: "secret".into(),
            approval_key: "key".into(),
            gateway_ws_url: String::new(),
            control_url: String::new(),
            name: String::new(),
            allowed_roots: vec![root.clone()],
        };
        assert!(config.save(&link.join("agent.json")).is_err());
        assert!(!destination.join("agent.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
