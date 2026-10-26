use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_AGENT_CONFIG_BYTES: u64 = 256 * 1024;

// Reject an untrusted redirect at any component below the user's home or
// the OS temporary root, not just at the immediate config directory.
// These roots are trust boundaries: macOS, for example, uses /var -> /private/var.
fn validate_config_parent_chain(parent: &Path) -> Result<()> {
    let home = dirs::home_dir();
    let temporary_root = std::env::temp_dir();
    for ancestor in parent.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(anyhow!("unsafe_agent_config_parent"));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    // Junctions and other reparse directories need not report
                    // themselves as ordinary symbolic links.
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err(anyhow!("unsafe_agent_config_parent"));
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if home.as_deref() == Some(ancestor) || temporary_root == ancestor {
            break;
        }
    }
    Ok(())
}

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
        // The final file can be regular while a symlinked parent redirects
        // credential reads outside the intended config directory.
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("config parent unavailable"))?;
        validate_config_parent_chain(parent)?;
        // The immediate parent must exist for a credential read.
        fs::symlink_metadata(parent)?;
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
        let file = options
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
        // Check before mkdir: otherwise an ancestor link could create a new
        // directory outside the intended config tree before being rejected.
        validate_config_parent_chain(parent)?;
        fs::create_dir_all(parent)?;
        validate_config_parent_chain(parent)?;
        // Never follow an existing config symlink when writing credentials.
        match fs::symlink_metadata(path) {
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                return Err(anyhow!("unsafe_agent_config_target"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        // Validate before replacing the last usable credential file. A saved
        // config must be loadable, including its allowlisted root paths.
        let mut checked = self.clone();
        checked.normalize_roots()?;
        let data = serde_json::to_vec_pretty(&checked)?;
        // A config we save must remain loadable by the bounded reader. Reject
        // oversized updates before creating a temporary file or replacing
        // existing device credentials.
        if data.len() as u64 > MAX_AGENT_CONFIG_BYTES {
            return Err(anyhow!("agent_config_too_large"));
        }
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
            // Narrow the window for a replaced ancestor before publication.
            // This is not a handle-relative, adversarial TOCTOU guarantee.
            validate_config_parent_chain(parent)?;
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

    #[test]
    fn config_save_rejects_oversized_update_without_losing_credentials() {
        let root = std::env::temp_dir().join(format!("wc-config-size-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("private").join("agent.json");
        let mut config = AgentConfig {
            device_id: "device".into(),
            device_token: "original-secret".into(),
            approval_key: "original-approval".into(),
            gateway_ws_url: String::new(),
            control_url: String::new(),
            name: "test".into(),
            allowed_roots: vec![root.clone()],
        };
        config.save(&path).unwrap();
        let original = fs::read(&path).unwrap();
        config.device_token = "replacement-secret".into();
        config.name = "x".repeat(MAX_AGENT_CONFIG_BYTES as usize);
        let error = config.save(&path).unwrap_err();
        assert!(error.to_string().contains("agent_config_too_large"));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(
            AgentConfig::load(&path).unwrap().device_token,
            "original-secret"
        );
        let parent = path.parent().unwrap();
        assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_save_rejects_invalid_roots_without_replacing_credentials() {
        let root = std::env::temp_dir().join(format!("wc-config-roots-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("private").join("agent.json");
        let mut config = AgentConfig {
            device_id: "device".into(),
            device_token: "original-secret".into(),
            approval_key: "original-approval".into(),
            gateway_ws_url: String::new(),
            control_url: String::new(),
            name: "test".into(),
            allowed_roots: vec![root.clone()],
        };
        config.save(&path).unwrap();
        let original = fs::read(&path).unwrap();
        config.device_token = "new-secret".into();
        config.allowed_roots.clear();
        assert!(config.save(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        config.allowed_roots.push(root.join("missing"));
        assert!(config.save(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(
            AgentConfig::load(&path).unwrap().device_token,
            "original-secret"
        );
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
    fn config_load_rejects_symlinked_parent_without_reading_credentials() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("wc-config-load-parent-{}", uuid::Uuid::new_v4()));
        let actual = root.join("actual");
        fs::create_dir_all(&actual).unwrap();
        let config = AgentConfig {
            device_id: "device".into(),
            device_token: "private-token".into(),
            approval_key: "private-approval".into(),
            gateway_ws_url: String::new(),
            control_url: String::new(),
            name: String::new(),
            allowed_roots: vec![root.clone()],
        };
        config.save(&actual.join("agent.json")).unwrap();
        let alias = root.join("alias");
        symlink(&actual, &alias).unwrap();
        assert!(AgentConfig::load(&alias.join("agent.json")).is_err());
        assert_eq!(
            AgentConfig::load(&actual.join("agent.json"))
                .unwrap()
                .device_token,
            "private-token"
        );
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

    #[cfg(unix)]
    #[test]
    fn config_rejects_symlinked_grandparent_before_mkdir_or_secret_read() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("wc-config-grandparent-{}", uuid::Uuid::new_v4()));
        let destination = root.join("destination");
        let actual_parent = destination.join("private");
        fs::create_dir_all(&actual_parent).unwrap();
        let config = AgentConfig {
            device_id: "device".into(),
            device_token: "secret".into(),
            approval_key: "approval".into(),
            gateway_ws_url: String::new(),
            control_url: String::new(),
            name: String::new(),
            allowed_roots: vec![root.clone()],
        };
        let actual_path = actual_parent.join("agent.json");
        config.save(&actual_path).unwrap();
        let original_bytes = fs::read(&actual_path).unwrap();
        let alias = root.join("alias");
        symlink(&destination, &alias).unwrap();
        let redirected = alias.join("private").join("agent.json");
        let load_error = AgentConfig::load(&redirected).unwrap_err();
        assert!(load_error
            .to_string()
            .contains("unsafe_agent_config_parent"));
        let save_error = config.save(&redirected).unwrap_err();
        assert!(save_error
            .to_string()
            .contains("unsafe_agent_config_parent"));
        assert_eq!(fs::read(&actual_path).unwrap(), original_bytes);

        let nonexistent = alias.join("new-private").join("agent.json");
        let create_error = config.save(&nonexistent).unwrap_err();
        assert!(create_error
            .to_string()
            .contains("unsafe_agent_config_parent"));
        assert!(!destination.join("new-private").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_config_junction_grandparent_cannot_redirect_credentials() {
        use std::process::Command;
        let root =
            std::env::temp_dir().join(format!("wc-config-junction-{}", uuid::Uuid::new_v4()));
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let config = AgentConfig {
            device_id: "device".into(),
            device_token: "private-token".into(),
            approval_key: "private-approval".into(),
            gateway_ws_url: String::new(),
            control_url: String::new(),
            name: String::new(),
            allowed_roots: vec![root.clone()],
        };
        let original = outside.join("private").join("agent.json");
        config.save(&original).unwrap();
        let original_bytes = fs::read(&original).unwrap();
        let junction = root.join("alias");
        let output = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&junction)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let redirected = junction.join("private").join("agent.json");
        assert!(AgentConfig::load(&redirected).is_err());
        assert!(config.save(&redirected).is_err());
        assert_eq!(fs::read(&original).unwrap(), original_bytes);
        let new_path = junction.join("new-private").join("agent.json");
        assert!(config.save(&new_path).is_err());
        assert!(!outside.join("new-private").exists());
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
