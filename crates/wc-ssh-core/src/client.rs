//! SSH client (V2 A02): connect, verify the host key, authenticate, run a
//! command. Built on russh; terminal sessions (A03) and SFTP (A09) build on
//! the same [`Connection`].
//!
//! Host keys are never accepted silently. The caller passes the fingerprint
//! it trusts for this host (from its known-hosts store) or `None`. When the
//! server presents a key that is not that one, [`connect`] fails with
//! [`SshError::HostKeyUnknown`] or [`SshError::HostKeyChanged`] carrying the
//! presented key, so the app can ask the person and retry with it trusted.
use crate::HostProfile;
use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How the client proves who it is.
#[derive(Clone)]
pub enum Credential {
    Password(String),
    /// An OpenSSH, PKCS#8 or PuTTY private key, optionally encrypted.
    PrivateKey {
        key: String,
        passphrase: Option<String>,
    },
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print secrets, not even in debug logs.
        match self {
            Credential::Password(_) => f.write_str("Password(..)"),
            Credential::PrivateKey { .. } => f.write_str("PrivateKey(..)"),
        }
    }
}

/// The server's host key as shown to the person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostKey {
    /// e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// OpenSSH style `SHA256:...`, the same text `ssh-keygen -lf` prints.
    pub fingerprint: String,
}

#[derive(Debug)]
pub enum SshError {
    Timeout,
    Io(String),
    /// First connection to this host: ask the person to check the key.
    HostKeyUnknown(HostKey),
    /// The host presents a different key than the trusted one.
    HostKeyChanged {
        trusted: String,
        presented: HostKey,
    },
    AuthFailed {
        /// Methods the server would still accept (e.g. `publickey`).
        remaining: Vec<String>,
    },
    /// The private key could not be read (wrong passphrase, bad format).
    BadKey(String),
    Protocol(String),
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshError::Timeout => f.write_str("connection timed out"),
            SshError::Io(e) => write!(f, "connection failed: {e}"),
            SshError::HostKeyUnknown(k) => {
                write!(f, "unknown host key {} {}", k.algorithm, k.fingerprint)
            }
            SshError::HostKeyChanged { trusted, presented } => write!(
                f,
                "HOST KEY CHANGED: trusted {trusted}, server presented {} {}",
                presented.algorithm, presented.fingerprint
            ),
            SshError::AuthFailed { remaining } if remaining.is_empty() => {
                f.write_str("authentication failed")
            }
            SshError::AuthFailed { remaining } => write!(
                f,
                "authentication failed (server accepts: {})",
                remaining.join(", ")
            ),
            SshError::BadKey(e) => write!(f, "private key could not be used: {e}"),
            SshError::Protocol(e) => write!(f, "ssh error: {e}"),
        }
    }
}

impl std::error::Error for SshError {}

/// Output of [`Connection::exec`].
#[derive(Debug, Default)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// `None` when the server closed the channel without an exit status
    /// (for example, the command was killed by a signal).
    pub exit_status: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct ConnectOptions {
    /// Covers TCP connect, key exchange and authentication.
    pub timeout: Duration,
    /// Fingerprint (`SHA256:...`) the caller trusts for this host, if any.
    pub trusted_fingerprint: Option<String>,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(15),
            trusted_fingerprint: None,
        }
    }
}

struct Handler {
    trusted: Option<String>,
    presented: Arc<Mutex<Option<HostKey>>>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Host certificates are pinned by the host's own key for now; CA
        // trust (@cert-authority) comes with the known_hosts import (A07).
        let data = match server_public_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data(),
            russh::keys::PublicKeyOrCertificate::Certificate(cert) => cert.public_key(),
        };
        let key = HostKey {
            algorithm: data.algorithm().as_str().to_owned(),
            fingerprint: data.fingerprint(HashAlg::Sha256).to_string(),
        };
        let ok = self.trusted.as_deref() == Some(key.fingerprint.as_str());
        if let Ok(mut slot) = self.presented.lock() {
            *slot = Some(key);
        }
        Ok(ok)
    }
}

/// An authenticated SSH connection.
pub struct Connection {
    handle: client::Handle<Handler>,
    host_key: HostKey,
}

/// Connects, verifies the host key against `options.trusted_fingerprint`
/// and authenticates as `profile.user`.
pub async fn connect(
    profile: &HostProfile,
    credential: &Credential,
    options: &ConnectOptions,
) -> Result<Connection, SshError> {
    profile
        .validate()
        .map_err(|e| SshError::Protocol(e.to_string()))?;
    tokio::time::timeout(options.timeout, connect_inner(profile, credential, options))
        .await
        .map_err(|_| SshError::Timeout)?
}

async fn connect_inner(
    profile: &HostProfile,
    credential: &Credential,
    options: &ConnectOptions,
) -> Result<Connection, SshError> {
    // Decode the key first so a wrong passphrase fails before any network I/O.
    let key = match credential {
        Credential::PrivateKey { key, passphrase } => Some(Arc::new(
            russh::keys::decode_secret_key(key, passphrase.as_deref())
                .map_err(|e| SshError::BadKey(e.to_string()))?,
        )),
        Credential::Password(_) => None,
    };

    let presented = Arc::new(Mutex::new(None));
    let handler = Handler {
        trusted: options.trusted_fingerprint.clone(),
        presented: presented.clone(),
    };
    let config = Arc::new(client::Config {
        // Keepalives detect dead links; A08 makes this configurable.
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let connected = client::connect(config, (profile.host.as_str(), profile.port), handler).await;
    let mut handle = match connected {
        Ok(handle) => handle,
        Err(err) => {
            let seen = presented.lock().ok().and_then(|slot| slot.clone());
            return Err(match (seen, &options.trusted_fingerprint) {
                (Some(key), None) => SshError::HostKeyUnknown(key),
                (Some(key), Some(trusted)) if &key.fingerprint != trusted => {
                    SshError::HostKeyChanged {
                        trusted: trusted.clone(),
                        presented: key,
                    }
                }
                _ => map_error(err),
            });
        }
    };
    let host_key = presented
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .ok_or_else(|| SshError::Protocol("server sent no host key".into()))?;

    let result = match (credential, key) {
        (Credential::Password(password), _) => handle
            .authenticate_password(profile.user.clone(), password.clone())
            .await
            .map_err(map_error)?,
        (Credential::PrivateKey { .. }, Some(key)) => {
            // RSA keys sign with rsa-sha2-256/512 when the server supports it.
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(map_error)?
                .flatten();
            handle
                .authenticate_publickey(profile.user.clone(), PrivateKeyWithHashAlg::new(key, hash))
                .await
                .map_err(map_error)?
        }
        (Credential::PrivateKey { .. }, None) => unreachable!("key decoded above"),
    };
    match result {
        russh::client::AuthResult::Success => Ok(Connection { handle, host_key }),
        russh::client::AuthResult::Failure {
            remaining_methods, ..
        } => Err(SshError::AuthFailed {
            remaining: remaining_methods
                .iter()
                .map(|m| <&str>::from(m).to_owned())
                .collect(),
        }),
    }
}

fn map_error(err: russh::Error) -> SshError {
    match err {
        russh::Error::IO(e) => SshError::Io(e.to_string()),
        russh::Error::ConnectionTimeout | russh::Error::InactivityTimeout => SshError::Timeout,
        other => SshError::Protocol(other.to_string()),
    }
}

impl Connection {
    /// The host key this connection verified.
    pub fn host_key(&self) -> &HostKey {
        &self.host_key
    }

    /// Runs `command` through the user's shell and collects its output.
    /// Output is capped at `max_output` bytes per stream; the rest is dropped.
    pub async fn exec(&self, command: &str, max_output: usize) -> Result<ExecOutput, SshError> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(map_error)?;
        channel.exec(true, command).await.map_err(map_error)?;
        let mut out = ExecOutput::default();
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => {
                    append_capped(&mut out.stdout, &data, max_output)
                }
                russh::ChannelMsg::ExtendedData { data, ext: 1 } => {
                    append_capped(&mut out.stderr, &data, max_output)
                }
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    out.exit_status = Some(exit_status)
                }
                _ => {}
            }
        }
        Ok(out)
    }

    pub async fn close(self) -> Result<(), SshError> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await
            .map_err(map_error)
    }
}

fn append_capped(buf: &mut Vec<u8>, data: &[u8], cap: usize) {
    let room = cap.saturating_sub(buf.len());
    buf.extend_from_slice(&data[..data.len().min(room)]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_debug_hides_secrets() {
        let text = format!(
            "{:?} {:?}",
            Credential::Password("hunter2".into()),
            Credential::PrivateKey {
                key: "-----BEGIN".into(),
                passphrase: Some("pp".into())
            }
        );
        assert!(!text.contains("hunter2") && !text.contains("BEGIN") && !text.contains("pp)"));
    }

    #[test]
    fn output_is_capped() {
        let mut buf = Vec::new();
        append_capped(&mut buf, b"abcdef", 4);
        append_capped(&mut buf, b"gh", 4);
        assert_eq!(buf, b"abcd");
    }

    #[tokio::test]
    async fn wrong_passphrase_fails_before_connecting() {
        // Port 9 on a TEST-NET address would hang; a bad key must fail first.
        let profile = HostProfile::new("x", "192.0.2.1", 9, "u").unwrap();
        let err = connect(
            &profile,
            &Credential::PrivateKey {
                key: "not a key".into(),
                passphrase: None,
            },
            &ConnectOptions::default(),
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(err, SshError::BadKey(_)), "{err}");
    }
}
