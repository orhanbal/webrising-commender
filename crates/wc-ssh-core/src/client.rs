//! SSH client (V2 A02): connect, verify the host key, authenticate, run a
//! command, or open an interactive shell on a pseudo-terminal. Built on
//! russh; SFTP (A09) builds on the same [`Connection`].
//!
//! Host keys are never accepted silently. The caller passes the fingerprint
//! it trusts for this host (from its known-hosts store) or `None`. When the
//! server presents a key that is not that one, [`connect`] fails with
//! [`SshError::HostKeyUnknown`] or [`SshError::HostKeyChanged`] carrying the
//! presented key, so the app can ask the person and retry with it trusted.
use crate::HostProfile;
use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use std::collections::HashMap;
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
    /// Lets the server use this computer's SSH agent (like `ssh -A`). Off
    /// by default: anyone with root on the server could use the agent's
    /// keys while the connection is open.
    pub agent_forwarding: bool,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(15),
            trusted_fingerprint: None,
            agent_forwarding: false,
        }
    }
}

/// Remote forwards (`ssh -R`) of one connection: server port -> local target.
type RemoteRoutes = Arc<Mutex<HashMap<u32, (String, u16)>>>;

struct Handler {
    trusted: Option<String>,
    presented: Arc<Mutex<Option<HostKey>>>,
    routes: RemoteRoutes,
    agent_forwarding: bool,
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

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // Only ports this app asked the server to forward are accepted.
        let target = self
            .routes
            .lock()
            .ok()
            .and_then(|routes| routes.get(&connected_port).cloned());
        let Some((host, port)) = target else {
            drop(reply);
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            if let Ok(mut socket) = tokio::net::TcpStream::connect((host.as_str(), port)).await {
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            }
        });
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !self.agent_forwarding {
            drop(reply);
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = crate::agent::bridge(&mut stream).await;
        });
        Ok(())
    }
}

/// An authenticated SSH connection.
pub struct Connection {
    handle: client::Handle<Handler>,
    host_key: HostKey,
    routes: RemoteRoutes,
    agent_forwarding: bool,
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
    tokio::time::timeout(
        options.timeout,
        connect_inner(profile, credential, options, None),
    )
    .await
    .map_err(|_| SshError::Timeout)?
}

/// Like [`connect`], but reaches `profile` through `jump` (a bastion / jump
/// host, A10): the TCP connection is a direct-tcpip channel of the jump
/// connection, so the target only needs to be reachable from the jump host.
/// The target's host key is checked exactly as with a direct connection.
pub async fn connect_via(
    jump: &Connection,
    profile: &HostProfile,
    credential: &Credential,
    options: &ConnectOptions,
) -> Result<Connection, SshError> {
    profile
        .validate()
        .map_err(|e| SshError::Protocol(e.to_string()))?;
    tokio::time::timeout(
        options.timeout,
        connect_inner(profile, credential, options, Some(jump)),
    )
    .await
    .map_err(|_| SshError::Timeout)?
}

async fn connect_inner(
    profile: &HostProfile,
    credential: &Credential,
    options: &ConnectOptions,
    jump: Option<&Connection>,
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
    let routes: RemoteRoutes = Arc::default();
    let handler = Handler {
        trusted: options.trusted_fingerprint.clone(),
        presented: presented.clone(),
        routes: routes.clone(),
        agent_forwarding: options.agent_forwarding,
    };
    let config = Arc::new(client::Config {
        // Keepalives detect dead links; A08 makes this configurable.
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let connected = match jump {
        None => client::connect(config, (profile.host.as_str(), profile.port), handler).await,
        Some(jump) => match jump
            .handle
            .channel_open_direct_tcpip(
                profile.host.as_str(),
                u32::from(profile.port),
                "127.0.0.1",
                0,
            )
            .await
        {
            Ok(channel) => client::connect_stream(config, channel.into_stream(), handler).await,
            Err(e) => {
                return Err(SshError::Io(format!(
                    "jump host could not reach {}:{}: {e}",
                    profile.host, profile.port
                )))
            }
        },
    };
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
        russh::client::AuthResult::Success => Ok(Connection {
            handle,
            host_key,
            routes,
            agent_forwarding: options.agent_forwarding,
        }),
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

    /// Opens an interactive login shell on a pseudo-terminal of `cols` x
    /// `rows` with the given `TERM` (for example `xterm-256color`).
    /// `env` is sent as environment variables (the server's `AcceptEnv`
    /// decides which it keeps).
    pub async fn open_shell(
        &self,
        term: &str,
        cols: u32,
        rows: u32,
        env: &[(String, String)],
    ) -> Result<Shell, SshError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(map_error)?;
        if self.agent_forwarding {
            // Best effort: a server that refuses still gives a shell.
            let _ = channel.agent_forward(false).await;
        }
        for (name, value) in env {
            // Servers only accept names their AcceptEnv allows; others are
            // ignored, so this never blocks the shell.
            let _ = channel.set_env(false, name.as_str(), value.as_str()).await;
        }
        channel
            .request_pty(true, term, cols.max(1), rows.max(1), 0, 0, &[])
            .await
            .map_err(map_error)?;
        channel.request_shell(true).await.map_err(map_error)?;
        let (reader, writer) = channel.split();
        Ok(Shell {
            reader: ShellReader {
                half: reader,
                done: false,
                exit: None,
            },
            writer: ShellWriter { half: writer },
        })
    }

    /// Starts an SFTP session on this connection (A09).
    pub async fn sftp(&self) -> Result<crate::sftp::Sftp, SshError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(map_error)?;
        crate::sftp::Sftp::start(channel).await
    }

    /// Local port forwarding (A10, like `ssh -L`): listens on `bind` (for
    /// example `127.0.0.1:0` for a free port) and tunnels each accepted TCP
    /// connection to `remote_host:remote_port` as seen from the server. The
    /// forward stops when the returned value is dropped.
    pub async fn forward_local(
        self: &std::sync::Arc<Self>,
        bind: &str,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<LocalForward, SshError> {
        let listener = tokio::net::TcpListener::bind(bind)
            .await
            .map_err(|e| SshError::Io(format!("cannot listen on {bind}: {e}")))?;
        let local = listener
            .local_addr()
            .map_err(|e| SshError::Io(e.to_string()))?;
        let conn = self.clone();
        let host = remote_host.to_owned();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, peer)) = listener.accept().await {
                let conn = conn.clone();
                let host = host.clone();
                tokio::spawn(async move {
                    let Ok(channel) = conn
                        .handle
                        .channel_open_direct_tcpip(
                            host,
                            u32::from(remote_port),
                            peer.ip().to_string(),
                            u32::from(peer.port()),
                        )
                        .await
                    else {
                        return;
                    };
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                });
            }
        });
        Ok(LocalForward { local, task })
    }

    /// Dynamic forwarding (like `ssh -D`): a SOCKS5 proxy on `bind` that
    /// opens each requested connection from the server. No SOCKS
    /// authentication, so bind it to 127.0.0.1 only.
    pub async fn forward_dynamic(
        self: &std::sync::Arc<Self>,
        bind: &str,
    ) -> Result<LocalForward, SshError> {
        let listener = tokio::net::TcpListener::bind(bind)
            .await
            .map_err(|e| SshError::Io(format!("cannot listen on {bind}: {e}")))?;
        let local = listener
            .local_addr()
            .map_err(|e| SshError::Io(e.to_string()))?;
        let conn = self.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, peer)) = listener.accept().await {
                let conn = conn.clone();
                tokio::spawn(async move {
                    let _ = crate::socks::serve(socket, peer, |host, port| {
                        let conn = conn.clone();
                        async move {
                            conn.handle
                                .channel_open_direct_tcpip(
                                    host,
                                    u32::from(port),
                                    peer.ip().to_string(),
                                    u32::from(peer.port()),
                                )
                                .await
                                .map(|c| c.into_stream())
                                .map_err(|e| e.to_string())
                        }
                    })
                    .await;
                });
            }
        });
        Ok(LocalForward { local, task })
    }

    /// Remote forwarding (like `ssh -R`): the server listens on
    /// `remote_bind:remote_port` (0 = a free port it picks) and each
    /// connection there is tunnelled to `local_host:local_port` as seen from
    /// this computer. Dropping the returned value cancels it on the server.
    pub async fn forward_remote(
        self: &std::sync::Arc<Self>,
        remote_bind: &str,
        remote_port: u16,
        local_host: &str,
        local_port: u16,
    ) -> Result<RemoteForward, SshError> {
        let port = self
            .handle
            .tcpip_forward(remote_bind, u32::from(remote_port))
            .await
            .map_err(|e| SshError::Protocol(format!("server refused the remote forward: {e}")))?;
        let port = if port == 0 {
            u32::from(remote_port)
        } else {
            port
        };
        if let Ok(mut routes) = self.routes.lock() {
            routes.insert(port, (local_host.to_owned(), local_port));
        }
        Ok(RemoteForward {
            port,
            bind: remote_bind.to_owned(),
            conn: self.clone(),
        })
    }

    /// True once the server or the network closed the connection.
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn close(self) -> Result<(), SshError> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await
            .map_err(map_error)
    }
}

/// A running local port forward; dropping it stops listening.
pub struct LocalForward {
    pub local: std::net::SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for LocalForward {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A running remote forward; dropping it asks the server to stop listening.
pub struct RemoteForward {
    /// The port the server listens on.
    pub port: u32,
    bind: String,
    conn: std::sync::Arc<Connection>,
}

impl Drop for RemoteForward {
    fn drop(&mut self) {
        if let Ok(mut routes) = self.conn.routes.lock() {
            routes.remove(&self.port);
        }
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let conn = self.conn.clone();
            let (bind, port) = (std::mem::take(&mut self.bind), self.port);
            rt.spawn(async move {
                let _ = conn.handle.cancel_tcpip_forward(bind, port).await;
            });
        }
    }
}

/// An interactive shell. The reader and writer halves can live in different
/// tasks: one pumps output to the terminal view, the other forwards keys.
pub struct Shell {
    pub reader: ShellReader,
    pub writer: ShellWriter,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ShellEvent {
    /// Bytes for the terminal (stdout and stderr share the pty).
    Output(Vec<u8>),
    /// The shell exited; `None` when it ended without an exit status.
    Exit(Option<u32>),
}

pub struct ShellReader {
    half: russh::ChannelReadHalf,
    done: bool,
    exit: Option<u32>,
}

impl ShellReader {
    /// Next event. After [`ShellEvent::Exit`] it returns `None`.
    pub async fn next(&mut self) -> Option<ShellEvent> {
        if self.done {
            return None;
        }
        loop {
            match self.half.wait().await {
                Some(russh::ChannelMsg::Data { data })
                | Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                    return Some(ShellEvent::Output(data.to_vec()))
                }
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                    self.exit = Some(exit_status)
                }
                Some(russh::ChannelMsg::Close) | None => {
                    self.done = true;
                    return Some(ShellEvent::Exit(self.exit));
                }
                Some(_) => {}
            }
        }
    }
}

pub struct ShellWriter {
    half: russh::ChannelWriteHalf<client::Msg>,
}

impl ShellWriter {
    /// Sends keystrokes or pasted text.
    pub async fn write(&self, bytes: &[u8]) -> Result<(), SshError> {
        self.half
            .data_bytes(bytes.to_vec())
            .await
            .map_err(map_error)
    }

    /// Tells the server the terminal view changed size.
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), SshError> {
        self.half
            .window_change(cols.max(1), rows.max(1), 0, 0)
            .await
            .map_err(map_error)
    }

    pub async fn close(&self) -> Result<(), SshError> {
        let _ = self.half.eof().await;
        self.half.close().await.map_err(map_error)
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
