use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime},
};
use uuid::Uuid;

const MAGIC_V1: &[u8; 8] = b"WCTH0001";
const MAGIC_V2: &[u8; 8] = b"WCTH0002";
const HEADER_BYTES: usize = 20;
const CHECKSUM_BYTES: usize = 32;
const CAP: usize = 1024 * 1024;
const TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_ARCHIVES: usize = 64;
// A wedged second Agent must not block all terminal operations indefinitely.
const LOCK_WAIT: Duration = Duration::from_secs(5);

// Inspect the opened Windows file handle rather than pathname metadata: a
// replaced or hardlinked .history.lock must not split the cross-process quota.
#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct WindowsHistoryLockInfo {
    attributes: u32,
    created: [u32; 2],
    accessed: [u32; 2],
    modified: [u32; 2],
    volume_serial: u32,
    size_high: u32,
    size_low: u32,
    link_count: u32,
    index_high: u32,
    index_low: u32,
}

#[cfg(windows)]
fn windows_history_lock_info(file: &File) -> Result<WindowsHistoryLockInfo> {
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "GetFileInformationByHandle"]
        fn get_file_information_by_handle(
            handle: *mut std::ffi::c_void,
            info: *mut WindowsHistoryLockInfo,
        ) -> i32;
    }

    let mut info = WindowsHistoryLockInfo::default();
    // SAFETY: file owns the handle and info has the Windows ABI layout.
    if unsafe { get_file_information_by_handle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(info)
}

// One device namespace per enrollment; snapshots are read-only after restart.
pub struct HistoryStore {
    dir: PathBuf,
    mutex: Mutex<()>,
}

impl HistoryStore {
    pub fn for_device(device: &str) -> Result<Self> {
        let id = Uuid::parse_str(device).context("invalid device id")?;
        let root =
            dirs::data_local_dir().ok_or_else(|| anyhow!("local data directory unavailable"))?;
        let app_root = root.join("webrising-commender");
        let history_root = app_root.join("terminal-history");
        #[cfg(windows)]
        Self::reject_windows_reparse_ancestors(&history_root)?;
        fs::create_dir_all(&history_root)?;
        for owned in [&app_root, &history_root] {
            Self::secure_dir(owned)?;
        }
        Self::at(history_root.join(id.to_string()))
    }

    // Persist authenticated principals in disjoint on-disk namespaces.
    // The key is the Gateway-verified tenant/actor/device SHA-256 fingerprint.
    // Legacy unscoped snapshots remain inaccessible (fail closed).
    pub fn scoped(&self, scope: &str) -> Result<Self> {
        if scope.len() != 64
            || !scope
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(anyhow!("invalid terminal history scope"));
        }
        Self::at(self.dir.join(scope))
    }

    fn at(dir: PathBuf) -> Result<Self> {
        #[cfg(windows)]
        Self::reject_windows_reparse_ancestors(&dir)?;
        #[cfg(unix)]
        Self::reject_unix_linked_history_path(&dir)?;
        fs::create_dir_all(&dir)?;
        // Never chmod arbitrary parents (e.g. /tmp in isolated tests).
        Self::secure_dir(&dir)?;
        let store = Self {
            dir,
            mutex: Mutex::new(()),
        };
        store.prune()?;
        Ok(store)
    }

    // Windows junctions and other reparse points are not necessarily reported
    // as symbolic links. Reject them in every existing ancestor, including
    // before create_dir_all, so a linked parent cannot redirect new archives.
    #[cfg(windows)]
    fn reject_windows_reparse_ancestors(path: &std::path::Path) -> Result<()> {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        for ancestor in path.ancestors() {
            match fs::symlink_metadata(ancestor) {
                Ok(meta) if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
                    return Err(anyhow!("unsafe terminal history reparse point"));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    // Protect the history leaf and its immediate parent (the scoped device
    // directory). Do not walk every Unix ancestor: macOS /var can legitimately
    // be a symlink to /private/var. This is a fail-closed path check, not an
    // atomic dirfd-relative traversal guarantee.
    #[cfg(unix)]
    fn reject_unix_linked_history_path(path: &std::path::Path) -> Result<()> {
        for candidate in [path, path.parent().unwrap_or(path)] {
            match fs::symlink_metadata(candidate) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(anyhow!("unsafe terminal history symlink ancestor"));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn secure_dir(path: &std::path::Path) -> Result<()> {
        #[cfg(windows)]
        Self::reject_windows_reparse_ancestors(path)?;
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(anyhow!("unsafe terminal history directory"));
        }
        #[cfg(unix)]
        Self::chmod_pinned_unix_dir(path, &meta, || Ok(()))?;
        Ok(())
    }

    // A pathname chmod follows a substituted symlink between lstat and
    // chmod, potentially changing an unrelated directory's permissions.
    // Pin the directory with O_NOFOLLOW and chmod the verified descriptor.
    // This protects the leaf, not every ancestor (full dirfd traversal is
    // still an independent acceptance gate).
    #[cfg(unix)]
    fn chmod_pinned_unix_dir(
        path: &std::path::Path,
        expected: &fs::Metadata,
        before_open: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

        before_open()?;
        let mut options = OpenOptions::new();
        options
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let pinned = options.open(path)?;
        let actual = pinned.metadata()?;
        if !actual.is_dir() || actual.dev() != expected.dev() || actual.ino() != expected.ino() {
            return Err(anyhow!("terminal history directory changed before chmod"));
        }
        // SAFETY: pinned owns a live directory descriptor; fchmod does not
        // re-resolve the pathname and cannot follow a swapped leaf symlink.
        if unsafe { libc::fchmod(pinned.as_raw_fd(), 0o700) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    // Keep this file forever: deleting a lock file allows different processes
    // to lock different inodes and bypass the archive quota.
    fn lock_directory(&self) -> Result<File> {
        self.lock_directory_with_timeout(LOCK_WAIT)
    }

    fn lock_directory_with_timeout(&self, timeout: Duration) -> Result<File> {
        self.lock_directory_with_timeout_and_hook(timeout, || Ok(()))
    }

    // The hook is a no-op in production. Native tests inject a deterministic
    // directory-entry change after the OS lock has been acquired.
    fn lock_directory_with_timeout_and_hook(
        &self,
        timeout: Duration,
        after_lock: impl FnOnce() -> Result<()>,
    ) -> Result<File> {
        #[cfg(windows)]
        Self::secure_dir(&self.dir)?;
        #[cfg(unix)]
        Self::reject_unix_linked_history_path(&self.dir)?;
        let path = self.dir.join(".history.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            // A substituted FIFO must not stall the Agent before the
            // descriptor is checked for a regular file.
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
        }
        let lock = options.open(&path)?;
        if !lock.metadata()?.is_file() {
            return Err(anyhow!("unsafe terminal history lock"));
        }
        #[cfg(windows)]
        {
            let info = windows_history_lock_info(&lock)?;
            if info.attributes & 0x400 != 0 || info.link_count != 1 {
                return Err(anyhow!("unsafe terminal history lock reparse or hardlink"));
            }
        }
        // try_lock uses the same cross-process OS lock as File::lock (Rust >=
        // 1.89). A wedged process cannot stall terminal reads/writes forever.
        // Never read, save, or prune after a timeout: fail closed instead.
        let start = std::time::Instant::now();
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) => {
                    if start.elapsed() >= timeout {
                        return Err(anyhow!("terminal history filesystem lock timeout"));
                    }
                    std::thread::sleep(
                        Duration::from_millis(25).min(timeout.saturating_sub(start.elapsed())),
                    );
                }
                Err(error) => {
                    return Err(anyhow!("terminal history filesystem lock failed: {error}"));
                }
            }
        }
        after_lock()?;
        #[cfg(unix)]
        Self::reject_unix_linked_history_path(&self.dir)?;
        #[cfg(windows)]
        {
            Self::secure_dir(&self.dir)?;
            Self::reject_windows_reparse_ancestors(&path)?;
        }
        let path_meta = fs::symlink_metadata(&path)?;
        if !path_meta.is_file() || path_meta.file_type().is_symlink() {
            return Err(anyhow!("unsafe terminal history lock"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let mut named_options = OpenOptions::new();
            named_options.read(true).custom_flags(0x0020_0000);
            let named = named_options
                .open(&path)
                .map_err(|_| anyhow!("terminal history lock was replaced"))?;
            let held = windows_history_lock_info(&lock)?;
            let current = windows_history_lock_info(&named)?;
            if held.attributes & 0x400 != 0 || current.attributes & 0x400 != 0 {
                return Err(anyhow!("unsafe terminal history lock reparse point"));
            }
            if held.link_count != 1 || current.link_count != 1 {
                return Err(anyhow!("unsafe terminal history lock hardlink"));
            }
            if held.volume_serial != current.volume_serial
                || held.index_high != current.index_high
                || held.index_low != current.index_low
            {
                return Err(anyhow!("terminal history lock was replaced"));
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let held_meta = lock.metadata()?;
            if held_meta.dev() != path_meta.dev()
                || held_meta.ino() != path_meta.ino()
                || held_meta.nlink() != 1
            {
                return Err(anyhow!("terminal history lock was replaced or hardlinked"));
            }
        }
        Ok(lock)
    }

    // Test-only fault barrier: deterministic SIGKILL after fsync or rename.
    // Not compiled into release builds; no runtime fault-injection surface.
    #[cfg(test)]
    fn pause_for_crash_fixture(phase: &str) -> Result<()> {
        if std::env::var("WCTH_CRASH_PHASE").as_deref() == Ok(phase) {
            let marker = std::env::var("WCTH_CRASH_MARKER")?;
            fs::write(marker, phase.as_bytes())?;
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        Ok(())
    }

    fn valid_id(id: &str) -> Result<()> {
        if Uuid::parse_str(id).map(|u| u.to_string()).ok().as_deref() != Some(id) {
            return Err(anyhow!("invalid terminal session id"));
        }
        Ok(())
    }

    // Only our canonical UUID staging names are eligible for cleanup.
    // Other dotfiles belong to the administrator and must remain untouched.
    fn owned_staging_name(name: &str) -> bool {
        name.strip_prefix('.')
            .and_then(|stem| stem.strip_suffix(".tmp"))
            .is_some_and(|id| Self::valid_id(id).is_ok())
    }

    fn versions(&self, id: &str) -> Result<Vec<(u64, PathBuf)>> {
        let prefix = format!("{id}-");
        let mut versions = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(n) = name
                .strip_prefix(&prefix)
                .and_then(|x| x.strip_suffix(".hist"))
            {
                if let Ok(seq) = n.parse::<u64>() {
                    #[cfg(windows)]
                    Self::reject_windows_reparse_ancestors(&entry.path())?;
                    let kind = entry.file_type()?;
                    if !kind.is_file() || kind.is_symlink() {
                        return Err(anyhow!("unsafe terminal history file"));
                    }
                    versions.push((seq, entry.path()));
                }
            }
        }
        versions.sort_by_key(|x| x.0);
        Ok(versions)
    }

    pub fn save(&self, id: &str, total: u64, bytes: &VecDeque<u8>) -> Result<()> {
        Self::valid_id(id)?;
        if bytes.len() > CAP || total < bytes.len() as u64 {
            return Err(anyhow!("terminal history exceeds bounds"));
        }
        let _lock = self
            .mutex
            .lock()
            .map_err(|_| anyhow!("terminal history lock poisoned"))?;
        let _file_lock = self.lock_directory()?;
        // Another Agent process can have persisted a newer generation while
        // this writer waited for the filesystem lock. Never replace it with
        // older output, or overwrite a generation with the same byte offset.
        if let Some((latest, _)) = self.versions(id)?.last() {
            if *latest >= total {
                return Err(anyhow!("stale or duplicate terminal history snapshot"));
            }
        }
        let target = self.dir.join(format!("{id}-{total}.hist"));
        let temp = self.dir.join(format!(".{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| -> Result<()> {
            let mut f = options.open(&temp)?;
            f.write_all(MAGIC_V2)?;
            let total_bytes = total.to_le_bytes();
            let count_bytes = (bytes.len() as u32).to_le_bytes();
            f.write_all(&total_bytes)?;
            f.write_all(&count_bytes)?;
            let (a, b) = bytes.as_slices();
            f.write_all(a)?;
            f.write_all(b)?;
            // Version 2 protects the durable output against silent same-size
            // corruption. The checksum covers the sequence, length and data.
            let mut checksum = Sha256::new();
            checksum.update(total_bytes);
            checksum.update(count_bytes);
            checksum.update(a);
            checksum.update(b);
            f.write_all(&checksum.finalize())?;
            f.sync_all()?;
            #[cfg(test)]
            Self::pause_for_crash_fixture("before_rename")?;
            // Unique generations avoid non-atomic overwrite on Windows.
            fs::rename(&temp, &target)?;
            #[cfg(test)]
            Self::pause_for_crash_fixture("after_rename")?;
            #[cfg(unix)]
            File::open(&self.dir)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
        for (_, old) in self.versions(id)? {
            if old != target {
                fs::remove_file(old)?;
            }
        }
        // Bound disk usage while the Agent remains online. Startup-only
        // pruning lets sequential sessions accumulate indefinitely.
        // The save mutex is already held; do not lock it a second time.
        self.prune_locked()?;
        Ok(())
    }

    pub fn load(&self, id: &str) -> Result<(u64, VecDeque<u8>)> {
        self.load_with_hook(id, || Ok(()))
    }

    // Production uses a no-op hook; native tests replace the snapshot leaf
    // between pathname validation and opening the pinned descriptor.
    fn load_with_hook(
        &self,
        id: &str,
        before_open: impl FnOnce() -> Result<()>,
    ) -> Result<(u64, VecDeque<u8>)> {
        Self::valid_id(id)?;
        let _lock = self
            .mutex
            .lock()
            .map_err(|_| anyhow!("terminal history lock poisoned"))?;
        let _file_lock = self.lock_directory()?;
        let (seq, path) = self
            .versions(id)?
            .pop()
            .ok_or_else(|| anyhow!("terminal session not found"))?;
        #[cfg(windows)]
        Self::reject_windows_reparse_ancestors(&path)?;
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.len() > (CAP + HEADER_BYTES + CHECKSUM_BYTES) as u64
        {
            return Err(anyhow!("unsafe terminal history snapshot"));
        }
        // Capture the original Windows leaf identity before the test-only
        // open-race hook. A same-byte replacement must not be accepted merely
        // because its checksum and generation are unchanged.
        #[cfg(windows)]
        let before_info = {
            use std::os::windows::fs::OpenOptionsExt;
            let mut original_options = OpenOptions::new();
            original_options.read(true).custom_flags(0x0020_0000); // OPEN_REPARSE_POINT
            let original = original_options.open(&path)?;
            let info = windows_history_lock_info(&original)?;
            if info.attributes & 0x400 != 0 || info.link_count != 1 {
                return Err(anyhow!("terminal history snapshot changed or hardlinked"));
            }
            info
        };
        // A hostile FIFO substituted after lstat must not block the Agent
        // before fstat can reject its non-regular file type.
        before_open()?;
        // Pin the opened inode and reject a last-moment symlink swap on
        // Unix. Inspect the descriptor, not the earlier pathname metadata.
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Do not follow a substituted Windows file symlink/reparse leaf.
            options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let snapshot = options.open(&path)?;
        let opened_meta = snapshot.metadata()?;
        if !opened_meta.is_file()
            || opened_meta.len() > (CAP + HEADER_BYTES + CHECKSUM_BYTES) as u64
        {
            return Err(anyhow!("unsafe terminal history snapshot"));
        }
        #[cfg(windows)]
        {
            let opened = windows_history_lock_info(&snapshot)?;
            if opened.attributes & 0x400 != 0
                || opened.link_count != 1
                || opened.volume_serial != before_info.volume_serial
                || opened.index_high != before_info.index_high
                || opened.index_low != before_info.index_low
            {
                return Err(anyhow!("terminal history snapshot changed or hardlinked"));
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // Reject a same-content inode swap or late hardlink to an
            // external path, even when the archive header is still valid.
            if opened_meta.dev() != meta.dev()
                || opened_meta.ino() != meta.ino()
                || opened_meta.nlink() != 1
            {
                return Err(anyhow!("terminal history snapshot changed or hardlinked"));
            }
        }
        if SystemTime::now()
            .duration_since(opened_meta.modified()?)
            .unwrap_or_default()
            > TTL
        {
            return Err(anyhow!("terminal history expired"));
        }
        let mut raw = Vec::new();
        snapshot
            .take((CAP + HEADER_BYTES + CHECKSUM_BYTES + 1) as u64)
            .read_to_end(&mut raw)?;
        if raw.len() < HEADER_BYTES {
            return Err(anyhow!("corrupt terminal history"));
        }
        let is_v2 = if &raw[..8] == MAGIC_V2 {
            true
        } else if &raw[..8] == MAGIC_V1 {
            false
        } else {
            return Err(anyhow!("corrupt terminal history"));
        };
        let total = u64::from_le_bytes(raw[8..16].try_into()?);
        let count = u32::from_le_bytes(raw[16..20].try_into()?) as usize;
        let payload_end = HEADER_BYTES + count;
        let expected_len = payload_end + if is_v2 { CHECKSUM_BYTES } else { 0 };
        if total != seq || count > CAP || raw.len() != expected_len || total < count as u64 {
            return Err(anyhow!("corrupt terminal history bounds"));
        }
        if is_v2 {
            let checksum = Sha256::digest(&raw[8..payload_end]);
            if checksum[..] != raw[payload_end..] {
                return Err(anyhow!("corrupt terminal history checksum"));
            }
        }
        Ok((
            total,
            raw[HEADER_BYTES..payload_end].iter().copied().collect(),
        ))
    }

    pub fn prune(&self) -> Result<()> {
        let _lock = self
            .mutex
            .lock()
            .map_err(|_| anyhow!("terminal history lock poisoned"))?;
        let _file_lock = self.lock_directory()?;
        self.prune_locked()
    }

    // Call only while holding both self.mutex and the filesystem lock.
    fn prune_locked(&self) -> Result<()> {
        let mut newest: HashMap<String, (u64, PathBuf)> = HashMap::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && name.ends_with(".tmp") {
                if !Self::owned_staging_name(&name) {
                    continue;
                }
                #[cfg(windows)]
                Self::reject_windows_reparse_ancestors(&entry.path())?;
                let meta = fs::symlink_metadata(entry.path())?;
                if !meta.is_file() || meta.file_type().is_symlink() {
                    return Err(anyhow!("unsafe terminal history temporary file"));
                }
                if SystemTime::now()
                    .duration_since(meta.modified()?)
                    .unwrap_or_default()
                    > Duration::from_secs(3600)
                {
                    fs::remove_file(entry.path())?;
                }
                continue;
            }
            let Some(stem) = name.strip_suffix(".hist") else {
                continue;
            };
            let Some((id, suffix)) = stem.rsplit_once('-') else {
                continue;
            };
            if Self::valid_id(id).is_err() {
                continue;
            }
            let Ok(seq) = suffix.parse::<u64>() else {
                continue;
            };
            #[cfg(windows)]
            Self::reject_windows_reparse_ancestors(&entry.path())?;
            let meta = fs::symlink_metadata(entry.path())?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(anyhow!("unsafe terminal history snapshot"));
            }
            if SystemTime::now()
                .duration_since(meta.modified()?)
                .unwrap_or_default()
                > TTL
            {
                fs::remove_file(entry.path())?;
                continue;
            }
            if let Some((previous, old)) = newest.get(id) {
                if *previous >= seq {
                    fs::remove_file(entry.path())?;
                    continue;
                }
                fs::remove_file(old)?;
            }
            newest.insert(id.to_owned(), (seq, entry.path()));
        }
        let mut paths = newest
            .into_values()
            .map(|(_, path)| path)
            .collect::<Vec<_>>();
        paths.sort_by_key(|p| {
            fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        });
        let excess = paths.len().saturating_sub(MAX_ARCHIVES);
        for path in paths.into_iter().take(excess) {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn pinned_history_directory_chmod_rejects_symlink_swap_without_touching_outside() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let base = std::env::temp_dir().join(format!("wcth-chmod-link-{}", Uuid::new_v4()));
        let owned = base.join("owned");
        let parked = base.join("parked");
        let outside = base.join("outside");
        fs::create_dir_all(&owned).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o755)).unwrap();
        let original = fs::symlink_metadata(&owned).unwrap();

        let result = HistoryStore::chmod_pinned_unix_dir(&owned, &original, || {
            fs::rename(&owned, &parked)?;
            symlink(&outside, &owned)?;
            Ok(())
        });
        assert!(result.is_err(), "symlink replacement must fail closed");
        assert_eq!(
            fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o755,
            "an outside directory must never be chmodded"
        );
        fs::remove_file(&owned).unwrap();
        fs::rename(&parked, &owned).unwrap();
        HistoryStore::secure_dir(&owned).unwrap();
        assert_eq!(
            fs::metadata(&owned).unwrap().permissions().mode() & 0o777,
            0o700
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pinned_history_directory_chmod_rejects_same_path_inode_replacement() {
        use std::os::unix::fs::PermissionsExt;

        let base = std::env::temp_dir().join(format!("wcth-chmod-inode-{}", Uuid::new_v4()));
        let owned = base.join("owned");
        let parked = base.join("parked");
        fs::create_dir_all(&owned).unwrap();
        let original = fs::symlink_metadata(&owned).unwrap();

        let result = HistoryStore::chmod_pinned_unix_dir(&owned, &original, || {
            fs::rename(&owned, &parked)?;
            fs::create_dir(&owned)?;
            fs::set_permissions(&owned, fs::Permissions::from_mode(0o755))?;
            Ok(())
        });
        assert!(
            result.unwrap_err().to_string().contains("directory changed"),
            "same pathname with another inode must be rejected"
        );
        assert_eq!(
            fs::metadata(&owned).unwrap().permissions().mode() & 0o777,
            0o755,
            "replacement directory permissions must remain unchanged"
        );
        fs::remove_dir(&owned).unwrap();
        fs::rename(&parked, &owned).unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    // Executed only when launched as a child test process. The parent sends
    // SIGKILL at the deterministic barrier rather than trusting timing.
    #[cfg(unix)]
    #[test]
    fn process_crash_snapshot_worker() {
        let Ok(root) = std::env::var("WCTH_CRASH_WORKER_ROOT") else {
            return;
        };
        let id = std::env::var("WCTH_CRASH_WORKER_ID").unwrap();
        let phase = std::env::var("WCTH_CRASH_PHASE").unwrap();
        let total = if phase == "before_rename" { 6 } else { 9 };
        let store = HistoryStore::at(PathBuf::from(root)).unwrap();
        store
            .save(&id, total, &VecDeque::from(b"newer".to_vec()))
            .unwrap();
        panic!("crash worker escaped the fault barrier");
    }

    #[cfg(unix)]
    #[test]
    fn sigkill_during_snapshot_write_preserves_last_complete_generation() {
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("wcth-crash-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let id = Uuid::new_v4().to_string();
        store
            .save(&id, 3, &VecDeque::from(b"old".to_vec()))
            .unwrap();
        let marker = dir.join("crash-ready");
        for (phase, expected_total) in [("before_rename", 3_u64), ("after_rename", 9_u64)] {
            let _ = fs::remove_file(&marker);
            let mut child = Command::new(std::env::current_exe().unwrap())
                .arg("--exact")
                .arg("terminal_history::tests::process_crash_snapshot_worker")
                .arg("--nocapture")
                .env("WCTH_CRASH_WORKER_ROOT", &dir)
                .env("WCTH_CRASH_WORKER_ID", &id)
                .env("WCTH_CRASH_PHASE", phase)
                .env("WCTH_CRASH_MARKER", &marker)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let start = std::time::Instant::now();
            while !marker.exists() && start.elapsed() < Duration::from_secs(10) {
                if let Some(status) = child.try_wait().unwrap() {
                    panic!("crash worker exited before barrier: {status}");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            // Never leave a blocked worker alive on assertion failure.
            let ready = marker.exists();
            unsafe {
                libc::kill(child.id() as i32, libc::SIGKILL);
            }
            let status = child.wait().unwrap();
            assert!(ready, "worker did not reach {phase} barrier");
            assert!(!status.success(), "SIGKILL worker unexpectedly succeeded");
            // Before rename, only the old committed snapshot is visible.
            // After rename, the new generation wins and startup prune removes
            // the old generation. This is process-crash, not power-loss proof.
            assert_eq!(store.load(&id).unwrap().0, expected_total);
            let restarted = HistoryStore::at(dir.clone()).unwrap();
            assert_eq!(restarted.load(&id).unwrap().0, expected_total);
            assert_eq!(restarted.versions(&id).unwrap().len(), 1);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lock_contention_times_out_without_pruning_or_writing() {
        let dir = std::env::temp_dir().join(format!("wcth-timeout-{}", Uuid::new_v4()));
        let a = HistoryStore::at(dir.clone()).unwrap();
        let b = HistoryStore::at(dir.clone()).unwrap();
        let stale = dir.join(format!(".{}.tmp", Uuid::new_v4()));
        fs::write(&stale, b"must-survive-timeout").unwrap();
        let old = SystemTime::now() - Duration::from_secs(7200);
        File::open(&stale)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();

        let held = a.lock_directory().unwrap();
        let start = std::time::Instant::now();
        let error = b
            .lock_directory_with_timeout(Duration::from_millis(100))
            .unwrap_err();
        assert!(error.to_string().contains("lock timeout"));
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(fs::read(&stale).unwrap(), b"must-survive-timeout");
        drop(held);

        // Once the owner releases the lock, ordinary maintenance resumes.
        b.prune().unwrap();
        assert!(!stale.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expired_archive_is_removed_while_current_and_foreign_files_survive() {
        let dir = std::env::temp_dir().join(format!("wcth-ttl-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let expired_id = Uuid::new_v4().to_string();
        let current_id = Uuid::new_v4().to_string();
        let bytes = VecDeque::from(b"bounded".to_vec());
        store.save(&expired_id, bytes.len() as u64, &bytes).unwrap();
        let expired_path = store.versions(&expired_id).unwrap().pop().unwrap().1;
        File::open(&expired_path)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(SystemTime::now() - TTL - Duration::from_secs(60)),
            )
            .unwrap();
        let foreign = dir.join("foreign-admin-file");
        fs::write(&foreign, b"keep").unwrap();
        store.save(&current_id, bytes.len() as u64, &bytes).unwrap();
        assert!(store.versions(&expired_id).unwrap().is_empty());
        assert_eq!(store.load(&current_id).unwrap().1, bytes);
        assert_eq!(fs::read(&foreign).unwrap(), b"keep");
        fs::remove_dir_all(dir).unwrap();
    }

    // The child is a separate OS process, not a second HistoryStore sharing
    // a mutex. A delayed writer must not regress the durable output offset.
    #[test]
    fn process_stale_snapshot_worker() {
        let Ok(root) = std::env::var("WCTH_STALE_WORKER_ROOT") else {
            return;
        };
        let id = std::env::var("WCTH_STALE_WORKER_ID").unwrap();
        let store = HistoryStore::at(PathBuf::from(root)).unwrap();
        let stale = VecDeque::from(b"old".to_vec());
        let error = store.save(&id, 3, &stale).unwrap_err();
        assert!(
            error.to_string().contains("stale or duplicate"),
            "unexpected stale write error: {error}"
        );
    }

    #[test]
    fn stale_cross_process_history_cannot_replace_newer_generation() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("wcth-stale-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let id = Uuid::new_v4().to_string();
        let newer = VecDeque::from(b"newer-output".to_vec());
        store.save(&id, newer.len() as u64, &newer).unwrap();

        let output = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("terminal_history::tests::process_stale_snapshot_worker")
            .arg("--nocapture")
            .env("WCTH_STALE_WORKER_ROOT", &dir)
            .env("WCTH_STALE_WORKER_ID", &id)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "stale writer accepted: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            store.load(&id).unwrap(),
            (newer.len() as u64, newer.clone())
        );
        assert_eq!(store.versions(&id).unwrap().len(), 1);
        // Equal offsets with different payloads must also be rejected.
        let duplicate = VecDeque::from(b"other-output".to_vec());
        assert_eq!(duplicate.len(), newer.len());
        assert!(store.save(&id, newer.len() as u64, &duplicate).is_err());
        assert_eq!(store.load(&id).unwrap().1, newer);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_open_rejects_fifo_substitution_without_blocking() {
        use std::os::unix::fs::FileTypeExt;
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("wcth-snapshot-fifo-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let id = Uuid::new_v4().to_string();
        let data = VecDeque::from(b"safe".to_vec());
        store.save(&id, 4, &data).unwrap();
        let snapshot = store.versions(&id).unwrap().pop().unwrap().1;
        let parked = dir.join("parked-snapshot");
        let start = std::time::Instant::now();
        let result = store.load_with_hook(&id, || {
            fs::rename(&snapshot, &parked)?;
            let status = Command::new("mkfifo").arg(&snapshot).status()?;
            if !status.success() {
                return Err(anyhow!("mkfifo fixture failed"));
            }
            Ok(())
        });
        let error = result.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsafe terminal history snapshot"),
            "{error}"
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "FIFO open blocked"
        );
        assert!(fs::symlink_metadata(&snapshot)
            .unwrap()
            .file_type()
            .is_fifo());
        fs::remove_file(&snapshot).unwrap();
        fs::rename(&parked, &snapshot).unwrap();
        assert_eq!(store.load(&id).unwrap(), (4, data));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn snapshot_open_rejects_same_content_inode_swap() {
        let dir = std::env::temp_dir().join(format!("wcth-snapshot-aba-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let id = Uuid::new_v4().to_string();
        let data = VecDeque::from(b"safe".to_vec());
        store.save(&id, 4, &data).unwrap();
        let snapshot = store.versions(&id).unwrap().pop().unwrap().1;
        let parked = dir.join("parked-snapshot");
        let result = store.load_with_hook(&id, || {
            fs::rename(&snapshot, &parked)?;
            fs::copy(&parked, &snapshot)?;
            Ok(())
        });
        let error = result.unwrap_err();
        assert!(
            error.to_string().contains("snapshot changed or hardlinked"),
            "{error}"
        );
        assert_eq!(fs::read(&snapshot).unwrap(), fs::read(&parked).unwrap());
        fs::remove_file(&parked).unwrap();
        assert_eq!(store.load(&id).unwrap(), (4, data));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn snapshot_open_rejects_late_hardlink() {
        let dir = std::env::temp_dir().join(format!("wcth-snapshot-link-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let id = Uuid::new_v4().to_string();
        let data = VecDeque::from(b"safe".to_vec());
        store.save(&id, 4, &data).unwrap();
        let snapshot = store.versions(&id).unwrap().pop().unwrap().1;
        let alias = dir.join("outside-snapshot-alias");
        let result = store.load_with_hook(&id, || {
            fs::hard_link(&snapshot, &alias)?;
            Ok(())
        });
        let error = result.unwrap_err();
        assert!(
            error.to_string().contains("snapshot changed or hardlinked"),
            "{error}"
        );
        assert_eq!(fs::read(&snapshot).unwrap(), fs::read(&alias).unwrap());
        fs::remove_file(&alias).unwrap();
        assert_eq!(store.load(&id).unwrap(), (4, data));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lock_rejects_post_acquire_inode_swap_or_os_denial() {
        let dir = std::env::temp_dir().join(format!("wcth-lock-aba-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let path = dir.join(".history.lock");
        let parked = dir.join("parked-lock");
        let mut swapped = false;
        let result = store.lock_directory_with_timeout_and_hook(Duration::from_secs(1), || {
            match fs::rename(&path, &parked) {
                Ok(()) => {}
                #[cfg(windows)]
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    return Err(anyhow!("windows_history_lock_rename_denied: {error}"));
                }
                Err(error) => return Err(error.into()),
            }
            swapped = true;
            fs::write(&path, b"replacement-lock")?;
            Ok(())
        });
        let error = result.unwrap_err();
        if swapped {
            assert!(
                error
                    .to_string()
                    .contains("terminal history lock was replaced"),
                "post-acquisition history lock swap must fail closed: {error}"
            );
            assert_eq!(fs::read(&path).unwrap(), b"replacement-lock");
            assert!(parked.exists());
        } else {
            #[cfg(windows)]
            assert!(
                error
                    .to_string()
                    .contains("windows_history_lock_rename_denied"),
                "unexpected Windows history lock outcome: {error}"
            );
            #[cfg(not(windows))]
            panic!("Unix must permit renaming an open advisory-locked inode: {error}");
        }
        drop(store.lock_directory().unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lock_rejects_post_acquire_hardlink_or_os_denial() {
        let dir = std::env::temp_dir().join(format!("wcth-lock-link-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let path = dir.join(".history.lock");
        let alias = dir.join("outside-alias");
        let mut linked = false;
        let result = store.lock_directory_with_timeout_and_hook(Duration::from_secs(1), || {
            match fs::hard_link(&path, &alias) {
                Ok(()) => linked = true,
                Err(error)
                    if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied =>
                {
                    return Err(anyhow!("windows_history_lock_hardlink_denied: {error}"));
                }
                Err(error) => return Err(error.into()),
            }
            Ok(())
        });
        let error = result.unwrap_err();
        if linked {
            assert!(
                error.to_string().contains("hardlink") || error.to_string().contains("hardlinked"),
                "post-acquisition history lock hardlink must fail closed: {error}"
            );
            assert_eq!(fs::read(&alias).unwrap(), fs::read(&path).unwrap());
            fs::remove_file(&alias).unwrap();
        } else {
            assert!(
                error
                    .to_string()
                    .contains("windows_history_lock_hardlink_denied"),
                "unexpected history lock hardlink outcome: {error}"
            );
        }
        drop(store.lock_directory().unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn independent_stores_wait_for_same_directory_lock() {
        use std::sync::mpsc;
        let dir = std::env::temp_dir().join(format!("wcth-lock-{}", Uuid::new_v4()));
        let a = HistoryStore::at(dir.clone()).unwrap();
        let b = HistoryStore::at(dir.clone()).unwrap();
        let held = a.lock_directory().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            done_tx.send(b.prune()).unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
        drop(held);
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        worker.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    // The test executable is deliberately launched as a second OS process,
    // not just a thread sharing the HistoryStore mutex.
    #[test]
    fn process_archive_worker() {
        let Ok(root) = std::env::var("WCTH_PROCESS_WORKER_ROOT") else {
            return;
        };
        let store = HistoryStore::at(PathBuf::from(root)).unwrap();
        let bytes = VecDeque::from(b"cross-process-output".to_vec());
        for _ in 0..(MAX_ARCHIVES + 12) {
            store
                .save(&Uuid::new_v4().to_string(), bytes.len() as u64, &bytes)
                .unwrap();
        }
    }

    #[test]
    fn independent_processes_enforce_archive_quota() {
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("wcth-process-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let executable = std::env::current_exe().unwrap();
        let mut children = Vec::new();
        for _ in 0..3 {
            children.push(
                Command::new(&executable)
                    .arg("--exact")
                    .arg("terminal_history::tests::process_archive_worker")
                    .arg("--nocapture")
                    .env("WCTH_PROCESS_WORKER_ROOT", &dir)
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
        }
        for child in children {
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "history subprocess failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let snapshots = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let name = entry.file_name().to_string_lossy().into_owned();
                name.ends_with(".hist").then_some(name)
            })
            .collect::<Vec<_>>();
        assert_eq!(snapshots.len(), MAX_ARCHIVES);
        for name in snapshots.iter().take(5) {
            let (id, _) = name
                .strip_suffix(".hist")
                .unwrap()
                .rsplit_once('-')
                .unwrap();
            assert_eq!(
                store.load(id).unwrap().1,
                VecDeque::from(b"cross-process-output".to_vec())
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_lock_file_is_rejected_without_touching_target() {
        let dir = std::env::temp_dir().join(format!("wcth-bad-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let outside = std::env::temp_dir().join(format!("wcth-outside-{}", Uuid::new_v4()));
        fs::write(&outside, b"do-not-touch").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(".history.lock")).unwrap();
        assert!(HistoryStore::at(dir.clone()).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"do-not-touch");
        fs::remove_dir_all(dir).unwrap();
        fs::remove_file(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_symlinked_scope_parent_cannot_redirect_history_creation() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("wcth-parent-{}", Uuid::new_v4()));
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let alias = root.join("linked");
        symlink(&outside, &alias).unwrap();
        assert!(HistoryStore::at(alias.join("scoped")).is_err());
        assert!(!outside.join("scoped").exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_history_directory_swap_after_open_fails_closed() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("wcth-dir-swap-{}", Uuid::new_v4()));
        let history = root.join("history");
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let store = HistoryStore::at(history.clone()).unwrap();
        fs::remove_file(history.join(".history.lock")).unwrap();
        fs::remove_dir(&history).unwrap();
        symlink(&outside, &history).unwrap();
        let id = Uuid::new_v4().to_string();
        let error = store
            .save(&id, 1, &VecDeque::from(b"x".to_vec()))
            .unwrap_err();
        assert!(error.to_string().contains("symlink ancestor"), "{error}");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_parent_cannot_redirect_history_creation() {
        use std::process::Command;
        let root = std::env::temp_dir().join(format!("wcth-junction-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("wcth-junction-target-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let junction = root.join("linked");
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
        assert!(HistoryStore::at(junction.join("scoped")).is_err());
        assert!(!outside.join("scoped").exists());
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_swap_after_store_open_is_rejected() {
        use std::process::Command;
        let root = std::env::temp_dir().join(format!("wcth-swap-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("wcth-swap-target-{}", Uuid::new_v4()));
        let history = root.join("history");
        fs::create_dir_all(&outside).unwrap();
        let store = HistoryStore::at(history.clone()).unwrap();
        // Simulate a local process replacing the history directory between
        // operations. The next save must reject it before opening a lock file.
        fs::remove_file(history.join(".history.lock")).unwrap();
        fs::remove_dir(&history).unwrap();
        let output = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&history)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let id = Uuid::new_v4().to_string();
        assert!(store.save(&id, 1, &VecDeque::from(b"x".to_vec())).is_err());
        assert!(!outside.join(".history.lock").exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir(&history).unwrap();
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn restart_snapshot_roundtrip_eviction_and_corruption() {
        let dir = std::env::temp_dir().join(format!("wcth-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let id = Uuid::new_v4().to_string();
        let mut bytes = VecDeque::new();
        bytes.extend(b"abc".iter().copied());
        store.save(&id, 3, &bytes).unwrap();
        bytes.extend(vec![b'x'; CAP]);
        bytes.drain(..3);
        store.save(&id, (CAP + 3) as u64, &bytes).unwrap();
        let (total, recovered) = store.load(&id).unwrap();
        assert_eq!(total, (CAP + 3) as u64);
        assert_eq!(recovered.len(), CAP);
        assert_eq!(store.versions(&id).unwrap().len(), 1);
        assert!(store.load("../outside").is_err());
        let path = store.versions(&id).unwrap().pop().unwrap().1;
        fs::write(path, b"corrupt").unwrap();
        assert!(store.load(&id).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn device_namespace_isolated_and_archive_count_bounded() {
        let root = std::env::temp_dir().join(format!("wcth-scope-{}", Uuid::new_v4()));
        let a = HistoryStore::at(root.join("a")).unwrap();
        let b = HistoryStore::at(root.join("b")).unwrap();
        let id = Uuid::new_v4().to_string();
        let bytes = VecDeque::from(vec![b'x']);
        a.save(&id, 1, &bytes).unwrap();
        assert!(b.load(&id).is_err());
        for _ in 0..(MAX_ARCHIVES + 8) {
            a.save(&Uuid::new_v4().to_string(), 1, &bytes).unwrap();
        }
        a.prune().unwrap();
        let count = fs::read_dir(&a.dir)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".hist")
            })
            .count();
        assert_eq!(count, MAX_ARCHIVES);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn save_enforces_archive_quota_without_restart_or_explicit_prune() {
        let dir = std::env::temp_dir().join(format!("wcth-live-quota-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let bytes = VecDeque::from(b"active".to_vec());
        let mut newest_id = String::new();
        for _ in 0..(MAX_ARCHIVES + 9) {
            newest_id = Uuid::new_v4().to_string();
            store.save(&newest_id, bytes.len() as u64, &bytes).unwrap();
        }
        let archives = fs::read_dir(&dir)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".hist")
            })
            .count();
        assert_eq!(archives, MAX_ARCHIVES);
        assert_eq!(store.load(&newest_id).unwrap().1, bytes);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn authenticated_history_scopes_are_isolated_and_legacy_is_unavailable() {
        let root = std::env::temp_dir().join(format!("wcth-actor-scope-{}", Uuid::new_v4()));
        let device = HistoryStore::at(root.clone()).unwrap();
        let owner_a = "a".repeat(64);
        let owner_b = "b".repeat(64);
        let a = device.scoped(&owner_a).unwrap();
        let b = device.scoped(&owner_b).unwrap();
        let id = Uuid::new_v4().to_string();
        let bytes = VecDeque::from(b"private-output".to_vec());
        a.save(&id, bytes.len() as u64, &bytes).unwrap();
        assert_eq!(a.load(&id).unwrap().1, bytes);
        assert!(b.load(&id).is_err());
        device.save(&id, bytes.len() as u64, &bytes).unwrap();
        assert!(b.load(&id).is_err());
        assert!(device.scoped("../escape").is_err());
        assert!(device.scoped(&"A".repeat(64)).is_err());
        assert!(device.scoped(&"f".repeat(64)).unwrap().load(&id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn symlink_snapshot_is_rejected() {
        #[cfg(unix)]
        {
            let dir = std::env::temp_dir().join(format!("wcth-{}", Uuid::new_v4()));
            let store = HistoryStore::at(dir.clone()).unwrap();
            let id = Uuid::new_v4().to_string();
            let outside = std::env::temp_dir().join(format!("wcth-secret-{}", Uuid::new_v4()));
            fs::write(&outside, b"secret").unwrap();
            std::os::unix::fs::symlink(&outside, dir.join(format!("{id}-1.hist"))).unwrap();
            assert!(store.load(&id).is_err());
            fs::remove_dir_all(dir).unwrap();
            fs::remove_file(outside).unwrap();
        }
    }
    #[test]
    fn v2_snapshot_rejects_same_length_payload_corruption() {
        let dir = std::env::temp_dir().join(format!("wcth-integrity-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let id = Uuid::new_v4().to_string();
        store
            .save(&id, 3, &VecDeque::from(b"abc".to_vec()))
            .unwrap();
        let path = store.versions(&id).unwrap().pop().unwrap().1;
        let mut raw = fs::read(&path).unwrap();
        assert_eq!(&raw[..8], MAGIC_V2);
        raw[HEADER_BYTES] ^= 1;
        fs::write(&path, raw).unwrap();
        assert!(store
            .load(&id)
            .unwrap_err()
            .to_string()
            .contains("corrupt terminal history checksum"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_v1_snapshot_remains_readable() {
        let dir = std::env::temp_dir().join(format!("wcth-legacy-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let id = Uuid::new_v4().to_string();
        let mut raw = MAGIC_V1.to_vec();
        raw.extend_from_slice(&3_u64.to_le_bytes());
        raw.extend_from_slice(&3_u32.to_le_bytes());
        raw.extend_from_slice(b"abc");
        fs::write(dir.join(format!("{id}-3.hist")), raw).unwrap();
        let (total, bytes) = store.load(&id).unwrap();
        assert_eq!(total, 3);
        assert_eq!(bytes, VecDeque::from(b"abc".to_vec()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_v1_append_migrates_to_checksumming_v2() {
        let dir = std::env::temp_dir().join(format!("wcth-v1-upgrade-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let id = Uuid::new_v4().to_string();
        let legacy = dir.join(format!("{id}-3.hist"));
        let mut raw = MAGIC_V1.to_vec();
        raw.extend_from_slice(&3_u64.to_le_bytes());
        raw.extend_from_slice(&3_u32.to_le_bytes());
        raw.extend_from_slice(b"abc");
        fs::write(&legacy, raw).unwrap();

        let (old_total, old_bytes) = store.load(&id).unwrap();
        assert_eq!(old_total, 3);
        assert_eq!(old_bytes, VecDeque::from(b"abc".to_vec()));
        let upgraded = VecDeque::from(b"abcdefgh".to_vec());
        store.save(&id, 8, &upgraded).unwrap();
        assert!(
            !legacy.exists(),
            "legacy generation must be retired after commit"
        );
        let versions = store.versions(&id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].0, 8);
        assert_eq!(&fs::read(&versions[0].1).unwrap()[..8], MAGIC_V2);
        let restarted = HistoryStore::at(dir.clone()).unwrap();
        assert_eq!(restarted.load(&id).unwrap(), (8, upgraded));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rolling_history_survives_repeated_restart_and_rejects_regression() {
        let dir = std::env::temp_dir().join(format!("wcth-rolling-{}", Uuid::new_v4()));
        let id = Uuid::new_v4().to_string();
        let mut expected = VecDeque::new();
        let mut total = 0_u64;
        // Exercise hundreds of durable generations, including repeated
        // reopens. This is a bounded CI stress test, not a 24-hour soak.
        for cycle in 0..6_u8 {
            let store = HistoryStore::at(dir.clone()).unwrap();
            for _ in 0..40 {
                total += 1;
                expected.push_back(cycle);
                if expected.len() > 64 {
                    expected.pop_front();
                }
                store.save(&id, total, &expected).unwrap();
            }
            assert_eq!(store.load(&id).unwrap(), (total, expected.clone()));
            assert_eq!(store.versions(&id).unwrap().len(), 1);
            assert!(store
                .save(&id, total - 1, &VecDeque::from(vec![cycle]))
                .is_err());
        }
        let reopened = HistoryStore::at(dir.clone()).unwrap();
        assert_eq!(reopened.load(&id).unwrap(), (total, expected));
        assert_eq!(reopened.versions(&id).unwrap().len(), 1);
        let staging = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().to_string_lossy().into_owned();
                name.ends_with(".tmp").then_some(name)
            })
            .collect::<Vec<_>>();
        assert!(staging.is_empty(), "successful commits left staging files");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prune_removes_only_owned_old_staging_and_preserves_unknown_files() {
        let dir = std::env::temp_dir().join(format!("wcth-prune-{}", Uuid::new_v4()));
        let store = HistoryStore::at(dir.clone()).unwrap();
        let stale = dir.join(format!(".{}.tmp", Uuid::new_v4()));
        let unknown = dir.join(".foreign-maintenance.tmp");
        let malformed = dir.join(".not-a-uuid.tmp");
        for path in [&stale, &unknown, &malformed] {
            fs::write(path, b"keep-unless-owned").unwrap();
        }
        let old = SystemTime::now() - Duration::from_secs(7200);
        for path in [&stale, &unknown, &malformed] {
            File::open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(old))
                .unwrap();
        }
        store.prune().unwrap();
        assert!(!stale.exists(), "only expired UUID staging may be removed");
        assert_eq!(fs::read(&unknown).unwrap(), b"keep-unless-owned");
        assert_eq!(fs::read(&malformed).unwrap(), b"keep-unless-owned");
        fs::remove_dir_all(dir).unwrap();
    }
}
