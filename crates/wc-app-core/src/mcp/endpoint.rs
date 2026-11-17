//! The per-user local endpoint the running core serves MCP on.
//!
//! * Windows: named pipe `\\.\pipe\wecommander-mcp-<user SID>` whose
//!   security descriptor grants access to the current user only (protected
//!   DACL), remote (SMB) clients rejected, created as the first instance so
//!   only one core owns the name.
//! * macOS: `~/Library/Application Support/app.wecommander/mcp.sock`;
//!   Linux: `$XDG_RUNTIME_DIR/wecommander-mcp.sock` (else
//!   `~/.wecommander/mcp.sock`). The socket is 0600 in a 0700 folder owned by
//!   the user, a lock file next to it makes one core the owner, and each
//!   connection's peer user id must be this user's.
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

use super::EndpointInfo;
use crate::AppState;

pub type Reader = Box<dyn AsyncRead + Unpin + Send>;
pub type Writer = Box<dyn AsyncWrite + Unpin + Send>;

/// This user's endpoint path (pipe name on Windows).
pub fn default_path() -> String {
    imp::default_path()
}

/// Connects to the endpoint (the bridge does this).
pub async fn connect(path: &str) -> std::io::Result<(Reader, Writer)> {
    imp::connect(path).await
}

/// Listens on `path` and serves MCP until the process ends. Reports what
/// happened in `mcp.status` (another core owning the endpoint is not an
/// error for the app: that core answers).
pub async fn serve(state: Arc<AppState>, path: String) {
    let result = imp::serve(state.clone(), path.clone()).await;
    if let Err(e) = result {
        state.mcp.set_endpoint(EndpointInfo {
            listening: false,
            path,
            error: Some(e),
        });
    }
}

fn mark_listening(state: &AppState, path: &str) {
    state.mcp.set_endpoint(EndpointInfo {
        listening: true,
        path: path.to_owned(),
        error: None,
    });
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    fn home() -> PathBuf {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }

    pub fn default_path() -> String {
        let path = if cfg!(target_os = "macos") {
            home()
                .join("Library")
                .join("Application Support")
                .join("app.wecommander")
                .join("mcp.sock")
        } else {
            match std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
                Some(dir) => PathBuf::from(dir).join("wecommander-mcp.sock"),
                None => home().join(".wecommander").join("mcp.sock"),
            }
        };
        path.to_string_lossy().into_owned()
    }

    pub async fn connect(path: &str) -> std::io::Result<(Reader, Writer)> {
        let stream = tokio::net::UnixStream::connect(path).await?;
        let (r, w) = stream.into_split();
        Ok((Box::new(r), Box::new(w)))
    }

    fn euid() -> u32 {
        // SAFETY: geteuid has no preconditions and cannot fail.
        unsafe { libc::geteuid() }
    }

    /// The socket's folder: created 0700 when missing; an existing one
    /// must be this user's (it is then made 0700). A shared folder such as
    /// /tmp is refused.
    fn private_dir(dir: &Path) -> Result<(), String> {
        if !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let meta = std::fs::metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        if meta.uid() != euid() {
            return Err(format!("{} belongs to another user", dir.display()));
        }
        if meta.mode() & 0o077 != 0 {
            if meta.mode() & 0o1000 != 0 {
                return Err(format!("{} is a shared folder", dir.display()));
            }
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        Ok(())
    }

    pub async fn serve(state: Arc<AppState>, path: String) -> Result<(), String> {
        let sock = PathBuf::from(&path);
        let dir = sock.parent().ok_or("invalid endpoint path")?.to_owned();
        private_dir(&dir)?;
        // One owner: the core holding the lock. The lock goes with the
        // process, so a crashed core leaves nothing that blocks the next one.
        let lock_path = sock.with_extension("lock");
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .map_err(|e| format!("{}: {e}", lock_path.display()))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err("another WECOMMANDER core owns the local MCP endpoint".into())
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(format!("lock: {e}")),
        }
        let _ = std::fs::remove_file(&sock);
        let listener = tokio::net::UnixListener::bind(&sock).map_err(|e| format!("{path}: {e}"))?;
        std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("{path}: {e}"))?;
        mark_listening(&state, &path);
        let me = euid();
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            // The folder already keeps other users out; check anyway.
            match stream.peer_cred() {
                Ok(cred) if cred.uid() == me => {}
                _ => continue,
            }
            let (r, w) = stream.into_split();
            tokio::spawn(crate::mcp::session::serve(state.clone(), r, w));
            // Held for as long as this core serves.
            let _ = &lock;
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const ERROR_PIPE_BUSY: i32 = 231;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn from_wide(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        // SAFETY: `p` is a NUL-terminated UTF-16 string from Windows.
        unsafe {
            let mut len = 0;
            while *p.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        }
    }

    /// The current user's SID as `S-1-5-21-…`.
    pub fn user_sid() -> Option<String> {
        // SAFETY: plain Win32 calls with buffers sized as Windows asks; every
        // handle and allocation is released before returning.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            let mut size = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
            let mut buf = vec![0u8; size as usize];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr() as *mut c_void,
                size,
                &mut size,
            );
            CloseHandle(token);
            if ok == 0 {
                return None;
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut text: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
                return None;
            }
            let sid = from_wide(text);
            LocalFree(text as *mut c_void);
            Some(sid)
        }
    }

    fn sanitized_user() -> String {
        std::env::var("USERNAME")
            .unwrap_or_default()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    }

    pub fn default_path() -> String {
        let who = user_sid().unwrap_or_else(sanitized_user);
        format!(r"\\.\pipe\wecommander-mcp-{who}")
    }

    pub async fn connect(path: &str) -> std::io::Result<(Reader, Writer)> {
        let mut tries = 0;
        let client = loop {
            match ClientOptions::new().open(path) {
                Ok(c) => break c,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tries < 50 => {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Err(e) => return Err(e),
            }
        };
        let (r, w) = tokio::io::split(client);
        Ok((Box::new(r), Box::new(w)))
    }

    /// A security descriptor that lets only `sid` open the pipe.
    struct Descriptor(PSECURITY_DESCRIPTOR);

    impl Descriptor {
        fn for_user(sid: &str) -> Result<Self, String> {
            // Protected DACL with one entry: GENERIC_ALL for this user. No
            // inherited entries, so Everyone/Administrators/other users get
            // nothing.
            let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            // SAFETY: `sddl` is NUL-terminated; Windows allocates `sd`,
            // which `Drop` frees with LocalFree.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(format!(
                    "security descriptor: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self(sd))
        }

        fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0,
                bInheritHandle: 0,
            }
        }
    }

    impl Drop for Descriptor {
        fn drop(&mut self) {
            // SAFETY: allocated by ConvertStringSecurityDescriptor…W.
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    // The descriptor is only read by Windows after creation.
    unsafe impl Send for Descriptor {}
    unsafe impl Sync for Descriptor {}

    fn create(
        path: &str,
        descriptor: &Descriptor,
        first: bool,
    ) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
        let mut attributes = descriptor.attributes();
        // SAFETY: `attributes` and the descriptor it points to live until
        // the call returns; Windows copies the security information.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    path,
                    &mut attributes as *mut SECURITY_ATTRIBUTES as *mut c_void,
                )
        }
    }

    pub async fn serve(state: Arc<AppState>, path: String) -> Result<(), String> {
        let sid = user_sid().ok_or("cannot read the current user's SID")?;
        let descriptor = Descriptor::for_user(&sid)?;
        // first_pipe_instance: fails when another core already owns the name.
        let mut server = create(&path, &descriptor, true).map_err(|e| {
            if e.raw_os_error() == Some(5) {
                "another WECOMMANDER core owns the local MCP endpoint".to_string()
            } else {
                format!("{path}: {e}")
            }
        })?;
        mark_listening(&state, &path);
        loop {
            if server.connect().await.is_err() {
                server = match create(&path, &descriptor, false) {
                    Ok(s) => s,
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        continue;
                    }
                };
                continue;
            }
            let next = match create(&path, &descriptor, false) {
                Ok(s) => s,
                Err(e) => return Err(format!("{path}: {e}")),
            };
            let connected = std::mem::replace(&mut server, next);
            let (r, w) = tokio::io::split(connected);
            tokio::spawn(crate::mcp::session::serve(state.clone(), r, w));
        }
    }
}
