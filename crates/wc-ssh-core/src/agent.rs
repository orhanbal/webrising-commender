//! SSH agent forwarding (`ssh -A`): connects a forwarded agent channel to
//! the agent on this computer. On Windows that is the OpenSSH agent's named
//! pipe (or `SSH_AUTH_SOCK` when set, e.g. by another agent); elsewhere the
//! Unix socket in `SSH_AUTH_SOCK`.
use tokio::io::{AsyncRead, AsyncWrite};

/// Where the local agent listens, if anywhere.
pub fn local_agent_path() -> Option<String> {
    if let Ok(path) = std::env::var("SSH_AUTH_SOCK") {
        if !path.trim().is_empty() {
            return Some(path);
        }
    }
    if cfg!(windows) {
        Some(r"\\.\pipe\openssh-ssh-agent".to_owned())
    } else {
        None
    }
}

/// Copies bytes between `channel` and the local agent until either closes.
pub async fn bridge<C: AsyncRead + AsyncWrite + Unpin>(channel: &mut C) -> std::io::Result<()> {
    let path = local_agent_path().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no SSH agent on this computer",
        )
    })?;
    #[cfg(unix)]
    {
        let mut agent = tokio::net::UnixStream::connect(&path).await?;
        tokio::io::copy_bidirectional(channel, &mut agent).await?;
    }
    #[cfg(windows)]
    {
        let mut agent = tokio::net::windows::named_pipe::ClientOptions::new().open(&path)?;
        tokio::io::copy_bidirectional(channel, &mut agent).await?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn bridges_to_the_unix_agent() {
        let dir = std::env::temp_dir().join(format!("wc-agent-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let sock = dir.join("agent.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 5];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(b"agent").await.unwrap();
        });
        std::env::set_var("SSH_AUTH_SOCK", &sock);
        let (mut near, mut far) = tokio::io::duplex(64);
        let task = tokio::spawn(async move { bridge(&mut far).await });
        near.write_all(b"hello").await.unwrap();
        let mut got = [0u8; 5];
        near.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"agent");
        drop(near);
        let _ = task.await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
