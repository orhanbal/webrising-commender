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
        fs::create_dir_all(&history_root)?;
        for owned in [&app_root, &history_root] {
            Self::secure_dir(owned)?;
        }
        Self::at(history_root.join(id.to_string()))
    }

    fn at(dir: PathBuf) -> Result<Self> {
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

    fn secure_dir(path: &std::path::Path) -> Result<()> {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(anyhow!("unsafe terminal history directory"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
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
            // Unique generations avoid non-atomic overwrite on Windows.
            fs::rename(&temp, &target)?;
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
        Ok(())
    }

    pub fn load(&self, id: &str) -> Result<(u64, VecDeque<u8>)> {
        Self::valid_id(id)?;
        let _lock = self
            .mutex
            .lock()
            .map_err(|_| anyhow!("terminal history lock poisoned"))?;
        let (seq, path) = self
            .versions(id)?
            .pop()
            .ok_or_else(|| anyhow!("terminal session not found"))?;
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.len() > (CAP + HEADER_BYTES + CHECKSUM_BYTES) as u64
        {
            return Err(anyhow!("unsafe terminal history snapshot"));
        }
        // Pin the opened inode and reject a last-moment symlink swap on
        // Unix. Inspect the descriptor, not the earlier pathname metadata.
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let snapshot = options.open(&path)?;
        let opened_meta = snapshot.metadata()?;
        if !opened_meta.is_file()
            || opened_meta.len() > (CAP + HEADER_BYTES + CHECKSUM_BYTES) as u64
        {
            return Err(anyhow!("unsafe terminal history snapshot"));
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
        let mut newest: HashMap<String, (u64, PathBuf)> = HashMap::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && name.ends_with(".tmp") {
                if !Self::owned_staging_name(&name) {
                    continue;
                }
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
