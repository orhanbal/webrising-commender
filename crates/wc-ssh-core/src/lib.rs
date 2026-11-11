//! WECOMMANDER User Mode SSH core.
//!
//! V2 A01 skeleton: the host profile model the desktop app saves and lists.
//! The SSH protocol itself (russh, auth methods, SFTP) arrives with A02 and
//! is gated by G2 (compatibility matrix).
pub mod agent;
pub mod client;
pub mod keys;
pub mod sftp;
pub mod socks;
pub mod ssh_config;

use serde::{Deserialize, Serialize};

/// A saved SSH destination.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    /// Shown in the host list ("Prod web 1").
    pub label: String,
    /// DNS name or IP address.
    pub host: String,
    pub port: u16,
    pub user: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProfileError {
    EmptyLabel,
    InvalidHost,
    InvalidPort,
    InvalidUser,
}

impl std::fmt::Display for ProfileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ProfileError::EmptyLabel => "label is empty",
            ProfileError::InvalidHost => "host is not a valid name or address",
            ProfileError::InvalidPort => "port must be between 1 and 65535",
            ProfileError::InvalidUser => "user name is not valid",
        })
    }
}

impl std::error::Error for ProfileError {}

impl HostProfile {
    pub fn new(label: &str, host: &str, port: u16, user: &str) -> Result<Self, ProfileError> {
        let profile = Self {
            label: label.trim().to_owned(),
            host: host.trim().to_owned(),
            port,
            user: user.trim().to_owned(),
        };
        profile.validate()?;
        Ok(profile)
    }

    pub fn validate(&self) -> Result<(), ProfileError> {
        if self.label.is_empty() || self.label.len() > 120 {
            return Err(ProfileError::EmptyLabel);
        }
        if !valid_host(&self.host) {
            return Err(ProfileError::InvalidHost);
        }
        if self.port == 0 {
            return Err(ProfileError::InvalidPort);
        }
        if !valid_user(&self.user) {
            return Err(ProfileError::InvalidUser);
        }
        Ok(())
    }

    /// `user@host` or `user@host:port`, as shown in the host list.
    pub fn display_target(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        if self.port == 22 {
            format!("{}@{}", self.user, host)
        } else {
            format!("{}@{}:{}", self.user, host, self.port)
        }
    }
}

fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

fn valid_user(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_names_ipv4_and_ipv6() {
        assert!(HostProfile::new("web", "web-1.example.com", 22, "deploy").is_ok());
        assert!(HostProfile::new("db", "10.0.0.5", 2222, "root").is_ok());
        assert!(HostProfile::new("v6", "2001:db8::1", 22, "admin").is_ok());
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(
            HostProfile::new(" ", "a.b", 22, "u"),
            Err(ProfileError::EmptyLabel)
        );
        assert_eq!(
            HostProfile::new("x", "bad host", 22, "u"),
            Err(ProfileError::InvalidHost)
        );
        assert_eq!(
            HostProfile::new("x", "-a.com", 22, "u"),
            Err(ProfileError::InvalidHost)
        );
        assert_eq!(
            HostProfile::new("x", "a.com", 0, "u"),
            Err(ProfileError::InvalidPort)
        );
        assert_eq!(
            HostProfile::new("x", "a.com", 22, "u;rm"),
            Err(ProfileError::InvalidUser)
        );
    }

    #[test]
    fn display_target_hides_default_port_and_brackets_ipv6() {
        assert_eq!(
            HostProfile::new("a", "srv", 22, "u")
                .unwrap()
                .display_target(),
            "u@srv"
        );
        assert_eq!(
            HostProfile::new("a", "srv", 2200, "u")
                .unwrap()
                .display_target(),
            "u@srv:2200"
        );
        assert_eq!(
            HostProfile::new("a", "::1", 2200, "u")
                .unwrap()
                .display_target(),
            "u@[::1]:2200"
        );
    }
}
