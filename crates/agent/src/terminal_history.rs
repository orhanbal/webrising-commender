use anyhow::{anyhow, Context, Result};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime},
};
use uuid::Uuid;

const MAGIC: &[u8; 8] = b"WCTH0001";
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
            f.write_all(MAGIC)?;
            f.write_all(&total.to_le_bytes())?;
            f.write_all(&(bytes.len() as u32).to_le_bytes())?;
            let (a, b) = bytes.as_slices();
            f.write_all(a)?;
            f.write_all(b)?;
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
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > (CAP + 20) as u64 {
            return Err(anyhow!("unsafe terminal history snapshot"));
        }
        if SystemTime::now()
            .duration_since(meta.modified()?)
            .unwrap_or_default()
            > TTL
        {
            return Err(anyhow!("terminal history expired"));
        }
        let mut raw = Vec::new();
        File::open(path)?
            .take((CAP + 21) as u64)
            .read_to_end(&mut raw)?;
        if raw.len() < 20 || &raw[..8] != MAGIC {
            return Err(anyhow!("corrupt terminal history"));
        }
        let total = u64::from_le_bytes(raw[8..16].try_into()?);
        let count = u32::from_le_bytes(raw[16..20].try_into()?) as usize;
        if total != seq || count > CAP || raw.len() != count + 20 || total < count as u64 {
            return Err(anyhow!("corrupt terminal history bounds"));
        }
        Ok((total, raw[20..].iter().copied().collect()))
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
}
