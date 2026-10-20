use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

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
    pub gateway_ws_url: String,
}

impl AgentConfig {
    pub fn default_path() -> Result<PathBuf> {
        let base =
            dirs::config_dir().ok_or_else(|| anyhow!("cannot determine config directory"))?;
        Ok(base.join("webrising-commender").join("agent.json"))
    }

    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("cannot read config {}", path.display()))?;
        let mut config: Self = serde_json::from_str(&raw).context("invalid agent config")?;
        config.normalize_roots()?;
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_vec_pretty(self)?;
        fs::write(path, data)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }

        Ok(())
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
