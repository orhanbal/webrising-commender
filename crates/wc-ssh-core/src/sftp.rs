//! SFTP on an authenticated [`Connection`](crate::client::Connection)
//! (A09): list, download, upload, create folders, rename and delete.
//! Transfers stream in 256 KiB chunks and report progress.
use crate::client::SshError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CHUNK: usize = 256 * 1024;

/// One directory entry as the file manager shows it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    /// "dir", "file", "link" or "other".
    pub kind: &'static str,
    pub size: u64,
    /// Seconds since the Unix epoch, if the server sent it.
    pub modified: Option<u64>,
    /// `rwxr-xr-x` style.
    pub permissions: String,
}

pub struct Sftp {
    session: SftpSession,
}

fn sftp_err(err: russh_sftp::client::error::Error) -> SshError {
    SshError::Protocol(format!("sftp: {err}"))
}

fn no_sftp() -> SshError {
    SshError::Protocol(
        "sftp: the server did not start SFTP (is the sftp subsystem enabled?)".into(),
    )
}

fn io_err(err: std::io::Error) -> SshError {
    SshError::Io(err.to_string())
}

/// Joins a remote directory and a name with `/` (SFTP paths are POSIX).
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Parent of a remote path; `/` stays `/`.
pub fn parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => trimmed[..i].into(),
    }
}

fn mode_string(mode: u32) -> String {
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    bits.iter()
        .map(|(bit, c)| if mode & bit != 0 { *c } else { '-' })
        .collect()
}

impl Sftp {
    pub(crate) async fn start(
        channel: russh::Channel<russh::client::Msg>,
    ) -> Result<Self, SshError> {
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| SshError::Protocol(e.to_string()))?;
        // A server without the sftp subsystem may never answer the SFTP
        // version handshake; fail instead of waiting forever.
        let session = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            SftpSession::new(channel.into_stream()),
        )
        .await
        .map_err(|_| no_sftp())?
        .map_err(|e| match e {
            russh_sftp::client::error::Error::Timeout => no_sftp(),
            other => sftp_err(other),
        })?;
        Ok(Self { session })
    }

    /// The login directory (absolute).
    pub async fn home(&self) -> Result<String, SshError> {
        self.session.canonicalize(".").await.map_err(sftp_err)
    }

    /// Entries of `dir`, folders first, then by name; `.` and `..` omitted.
    pub async fn list(&self, dir: &str) -> Result<Vec<Entry>, SshError> {
        let mut entries: Vec<Entry> = self
            .session
            .read_dir(dir)
            .await
            .map_err(sftp_err)?
            .filter(|e| e.file_name() != "." && e.file_name() != "..")
            .map(|e| {
                let meta = e.metadata();
                let kind = match e.file_type() {
                    t if t.is_dir() => "dir",
                    t if t.is_symlink() => "link",
                    t if t.is_file() => "file",
                    _ => "other",
                };
                Entry {
                    path: join(dir, &e.file_name()),
                    name: e.file_name(),
                    kind,
                    size: meta.len(),
                    modified: meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs()),
                    permissions: mode_string(meta.permissions.unwrap_or(0)),
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            (a.kind != "dir")
                .cmp(&(b.kind != "dir"))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    /// Streams `remote` into the local file `local` (created or replaced).
    /// `progress(done, total)` is called after each chunk.
    pub async fn download(
        &self,
        remote: &str,
        local: &Path,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<u64, SshError> {
        let total = self.session.metadata(remote).await.map_err(sftp_err)?.len();
        let mut source = self.session.open(remote).await.map_err(sftp_err)?;
        // Write to a temp name, then rename: a failed transfer never leaves
        // a truncated file under the real name.
        let partial = local.with_extension("wc-partial");
        let mut target = tokio::fs::File::create(&partial).await.map_err(io_err)?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        loop {
            let n = source.read(&mut buf).await.map_err(io_err)?;
            if n == 0 {
                break;
            }
            target.write_all(&buf[..n]).await.map_err(io_err)?;
            done += n as u64;
            progress(done, total);
        }
        target.flush().await.map_err(io_err)?;
        drop(target);
        tokio::fs::rename(&partial, local).await.map_err(io_err)?;
        Ok(done)
    }

    /// Streams the local file `local` to `remote` (created or replaced).
    pub async fn upload(
        &self,
        local: &Path,
        remote: &str,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<u64, SshError> {
        let mut source = tokio::fs::File::open(local).await.map_err(io_err)?;
        let total = source.metadata().await.map_err(io_err)?.len();
        let mut target = self
            .session
            .open_with_flags(
                remote,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(sftp_err)?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        loop {
            let n = source.read(&mut buf).await.map_err(io_err)?;
            if n == 0 {
                break;
            }
            target.write_all(&buf[..n]).await.map_err(io_err)?;
            done += n as u64;
            progress(done, total);
        }
        target.shutdown().await.map_err(io_err)?;
        Ok(done)
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), SshError> {
        self.session.create_dir(path).await.map_err(sftp_err)
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), SshError> {
        self.session.rename(from, to).await.map_err(sftp_err)
    }

    /// Deletes a file, link or empty folder.
    pub async fn remove(&self, path: &str) -> Result<(), SshError> {
        let meta = self
            .session
            .symlink_metadata(path)
            .await
            .map_err(sftp_err)?;
        if meta.file_type().is_dir() {
            self.session.remove_dir(path).await.map_err(sftp_err)
        } else {
            self.session.remove_file(path).await.map_err(sftp_err)
        }
    }

    pub async fn close(&self) -> Result<(), SshError> {
        self.session.close().await.map_err(sftp_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_modes() {
        assert_eq!(join("/home/u", "a.txt"), "/home/u/a.txt");
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(parent("/home/u/docs"), "/home/u");
        assert_eq!(parent("/home"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(mode_string(0o100755), "rwxr-xr-x");
        assert_eq!(mode_string(0o640), "rw-r-----");
    }
}
