use crate::policy::PathPolicy;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use uuid::Uuid;

const DEFAULT_READ_MAX: usize = 1024 * 1024;
const MAX_PAGED_FILE: u64 = 32 * 1024 * 1024;
// Two bounded disk scans per unguarded atomic replacement; independent of paged reads.
const MAX_ATOMIC_UNGUARDED_SCAN: u64 = 128 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 256 * 1024;
const HARD_READ_MAX: usize = 4 * 1024 * 1024;
const HARD_WRITE_MAX: usize = 8 * 1024 * 1024;
const MAX_TREE_DEPTH: usize = 20;
const MAX_TREE_ENTRIES: usize = 5_000;
const MAX_SCAN_ENTRIES: usize = 100_000;
const MAX_SEARCH_RESULTS: usize = 500;
const MAX_TEXT_SEARCH_RESULTS: usize = 500;
const MAX_TEXT_SEARCH_FILE: u64 = 1024 * 1024;
const MAX_TEXT_SEARCH_BYTES: u64 = 64 * 1024 * 1024;
// Wall-clock budget is independent of the Gateway's transport timeout.
// Individual filesystem syscalls cannot be preempted by this synchronous scan.
const MAX_SEARCH_DURATION: Duration = Duration::from_secs(10);
// A paused search still occupies its quota and may never block native workers forever.
const MAX_SEARCH_PAUSE: Duration = Duration::from_secs(15);

/// Sends bounded cumulative results during a native search without holding up the scanner.
pub type SearchProgressReporter = dyn Fn(&[Value], usize, u64, Option<&Value>) + Send + Sync;
const MAX_CHECKPOINT_BYTES: usize = 128 * 1024;

// Serialize in-process mutations to the same resolved path. Weak entries
// prevent a long-lived Agent from retaining a lock for every edited file.
// External writers still require an OS-level compare-and-swap protocol.
type FileMutationLock = std::sync::Mutex<()>;
type FileMutationLocks =
    std::collections::HashMap<std::path::PathBuf, std::sync::Weak<FileMutationLock>>;
static MUTATION_LOCKS: std::sync::OnceLock<std::sync::Mutex<FileMutationLocks>> =
    std::sync::OnceLock::new();

fn mutation_lock(path: &Path) -> Result<std::sync::Arc<FileMutationLock>> {
    let registry = MUTATION_LOCKS.get_or_init(Default::default);
    let mut locks = registry
        .lock()
        .map_err(|_| anyhow!("file mutation registry poisoned"))?;
    locks.retain(|_, weak| weak.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(std::sync::Weak::upgrade) {
        return Ok(lock);
    }
    let lock = std::sync::Arc::new(std::sync::Mutex::new(()));
    locks.insert(path.to_path_buf(), std::sync::Arc::downgrade(&lock));
    Ok(lock)
}

/// Bundles the deadline, cancellation signal and optional progress sink so
/// both bounded native scanners share a small, explicit control surface.
struct SearchExecution<'a> {
    deadline: Instant,
    cancelled: &'a AtomicBool,
    paused: Option<&'a AtomicBool>,
    report: Option<&'a SearchProgressReporter>,
    resume: Option<&'a Value>,
}

fn await_search_resume(
    paused: Option<&AtomicBool>,
    cancelled: &AtomicBool,
    deadline: &mut Instant,
) -> Result<()> {
    let Some(paused) = paused else {
        return Ok(());
    };
    if !paused.load(Ordering::Relaxed) {
        return Ok(());
    }
    let started = Instant::now();
    while paused.load(Ordering::Relaxed) {
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("search_cancelled"));
        }
        if started.elapsed() >= MAX_SEARCH_PAUSE {
            return Err(anyhow!("search_pause_timeout"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Pause time does not exhaust the native scan's active execution budget.
    *deadline += started.elapsed();
    Ok(())
}

pub fn list(policy: &PathPolicy, raw: &str) -> Result<Value> {
    let path = policy.resolve_existing(raw)?;
    if !path.is_dir() {
        return Err(anyhow!("path is not a directory"));
    }

    let mut items = Vec::new();
    for entry in fs::read_dir(&path)?.take(1000) {
        let entry = entry?;
        let metadata = entry.metadata()?;
        items.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "type": if metadata.is_dir() { "directory" } else if metadata.is_file() { "file" } else { "other" },
            "size": metadata.len()
        }));
    }
    Ok(json!({ "path": path.to_string_lossy(), "items": items }))
}

pub fn tree(
    policy: &PathPolicy,
    raw: &str,
    max_depth: Option<usize>,
    max_entries: Option<usize>,
) -> Result<Value> {
    let root = policy.resolve_existing(raw)?;
    if !root.is_dir() {
        return Err(anyhow!("path is not a directory"));
    }

    let depth_limit = max_depth.unwrap_or(4).min(MAX_TREE_DEPTH);
    let entry_limit = max_entries.unwrap_or(1000).clamp(1, MAX_TREE_ENTRIES);
    let mut stack = vec![(root.clone(), 0_usize)];
    let mut items = Vec::new();
    let mut scanned = 0_usize;
    let mut truncated = false;

    while let Some((dir, depth)) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            scanned += 1;
            if scanned > MAX_SCAN_ENTRIES || items.len() >= entry_limit {
                truncated = true;
                break;
            }

            let file_type = entry.file_type()?;
            let metadata = fs::symlink_metadata(entry.path())?;
            items.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "path": entry.path().to_string_lossy(),
                "depth": depth + 1,
                "type": entry_type(&file_type),
                "size": metadata.len()
            }));

            if file_type.is_dir() && depth < depth_limit {
                stack.push((entry.path(), depth + 1));
            }
        }

        if truncated {
            break;
        }
    }

    Ok(json!({
        "path": root.to_string_lossy(),
        "items": items,
        "truncated": truncated,
        "scannedEntries": scanned.min(MAX_SCAN_ENTRIES)
    }))
}

// Files can disappear between read_dir(), file_type() and metadata() when
// editors or build tools rewrite a directory during a scan. A vanished entry
// is not a policy failure; do not fail the entire bounded search.
fn search_metadata_if_present(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn search_cancellable(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    cancelled: &AtomicBool,
) -> Result<Value> {
    search_with_deadline(
        policy,
        raw,
        query,
        case_sensitive,
        max_results,
        Instant::now() + MAX_SEARCH_DURATION,
        cancelled,
    )
}

pub fn search_cancellable_controlled(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    controls: (&AtomicBool, &AtomicBool, Option<&Value>),
    report: &SearchProgressReporter,
) -> Result<Value> {
    search_with_deadline_reporting(
        policy,
        raw,
        query,
        case_sensitive,
        max_results,
        SearchExecution {
            deadline: Instant::now() + MAX_SEARCH_DURATION,
            cancelled: controls.0,
            paused: Some(controls.1),
            report: Some(report),
            resume: controls.2,
        },
    )
}

#[cfg(test)]
pub fn search_cancellable_reporting(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    cancelled: &AtomicBool,
    report: &SearchProgressReporter,
) -> Result<Value> {
    search_with_deadline_reporting(
        policy,
        raw,
        query,
        case_sensitive,
        max_results,
        SearchExecution {
            deadline: Instant::now() + MAX_SEARCH_DURATION,
            cancelled,
            paused: None,
            report: Some(report),
            resume: None,
        },
    )
}

fn search_with_deadline(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<Value> {
    search_with_deadline_reporting(
        policy,
        raw,
        query,
        case_sensitive,
        max_results,
        SearchExecution {
            deadline,
            cancelled,
            paused: None,
            report: None,
            resume: None,
        },
    )
}

fn search_with_deadline_reporting(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    execution: SearchExecution<'_>,
) -> Result<Value> {
    let SearchExecution {
        mut deadline,
        cancelled,
        paused,
        report,
        resume,
    } = execution;
    if query.trim().is_empty() {
        return Err(anyhow!("search query cannot be empty"));
    }
    if query.len() > 1024 {
        return Err(anyhow!("search query is too long"));
    }

    let root = policy.resolve_existing(raw)?;
    let result_limit = max_results.unwrap_or(100).clamp(1, MAX_SEARCH_RESULTS);
    let needle = if case_sensitive {
        query.to_owned()
    } else {
        query.to_lowercase()
    };
    let mut results = Vec::new();
    let mut scanned = 0_usize;
    let mut stack = vec![root.clone()];
    if let Some(resume) = resume {
        if serde_json::to_vec(resume)?.len() > MAX_CHECKPOINT_BYTES
            || resume["version"] != 1
            || resume["root"] != root.to_string_lossy().as_ref()
            || resume["query"] != query
            || resume["caseSensitive"] != case_sensitive
        {
            return Err(anyhow!("invalid_search_checkpoint"));
        }
        let pending = resume["pending"]
            .as_array()
            .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
        let prior = resume["items"]
            .as_array()
            .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
        let counted = resume["scannedEntries"]
            .as_u64()
            .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
        if pending.is_empty()
            || pending.len() > 4096
            || prior.len() > result_limit
            || counted > MAX_SCAN_ENTRIES as u64
        {
            return Err(anyhow!("invalid_search_checkpoint"));
        }
        stack.clear();
        let mut seen_pending = std::collections::HashSet::new();
        for dir in pending {
            let value = dir
                .as_str()
                .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
            if value.len() > 4096 {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            let path = std::path::PathBuf::from(value);
            if !path.starts_with(&root)
                || !seen_pending.insert(value)
                || !path.is_dir()
                || fs::symlink_metadata(&path)?.file_type().is_symlink()
                || policy.resolve_existing(value)? != path
            {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            stack.push(path);
        }
        // A checkpoint is an untrusted resume hint, not authority to inject
        // arbitrary previous matches into a new native scan. Revalidate each
        // saved item against the current allowlist and filesystem metadata.
        let mut seen = std::collections::HashSet::new();
        for item in prior {
            let value = item["path"]
                .as_str()
                .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
            let path = Path::new(value);
            if !path.starts_with(&root)
                || !seen.insert(value)
                || !file_name_matches(path, &needle, case_sensitive)
                || fs::symlink_metadata(path)?.file_type().is_symlink()
                || policy.resolve_existing(value)? != path
            {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            let metadata = fs::symlink_metadata(path)?;
            if item != &search_item(path, &metadata) {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
        }
        results = prior.clone();
        scanned = counted as usize;
    }
    let mut truncated = false;
    let mut timed_out = false;
    let mut next_progress = 32_usize;

    while let Some(path) = stack.pop() {
        await_search_resume(paused, cancelled, &mut deadline)?;
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("search_cancelled"));
        }
        if Instant::now() >= deadline {
            timed_out = true;
            truncated = true;
            break;
        }
        let Some(metadata) = search_metadata_if_present(&path)? else {
            continue;
        };
        if metadata.is_file() {
            scanned += 1;
            if file_name_matches(&path, &needle, case_sensitive) {
                results.push(search_item(&path, &metadata));
            }
        } else if metadata.is_dir() {
            let entries = match fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                await_search_resume(paused, cancelled, &mut deadline)?;
                if cancelled.load(Ordering::Relaxed) {
                    return Err(anyhow!("search_cancelled"));
                }
                if Instant::now() >= deadline {
                    timed_out = true;
                    truncated = true;
                    break;
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                scanned += 1;
                if scanned > MAX_SCAN_ENTRIES {
                    truncated = true;
                    break;
                }

                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                if file_name_matches(&entry.path(), &needle, case_sensitive) {
                    let Some(metadata) = search_metadata_if_present(&entry.path())? else {
                        continue;
                    };
                    results.push(search_item(&entry.path(), &metadata));
                    if results.len() >= result_limit {
                        truncated = true;
                        break;
                    }
                }
                if file_type.is_dir() {
                    stack.push(entry.path());
                }
                if scanned >= next_progress {
                    if let Some(report) = report {
                        report(&results, scanned.min(MAX_SCAN_ENTRIES), 0, None);
                    }
                    next_progress = scanned.saturating_add(32);
                }
            }
        }

        // Directory boundaries are durable: every entry in this directory
        // was handled, so 'pending' contains only still-unvisited directories.
        // Never checkpoint midway through a directory iterator.
        if !truncated && results.len() < result_limit && !stack.is_empty() {
            if let Some(report) = report {
                let checkpoint = json!({
                    "version": 1,
                    "root": root.to_string_lossy(),
                    "query": query,
                    "caseSensitive": case_sensitive,
                    "pending": stack.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
                    "items": results,
                    "scannedEntries": scanned.min(MAX_SCAN_ENTRIES),
                });
                if serde_json::to_vec(&checkpoint)?.len() <= MAX_CHECKPOINT_BYTES {
                    report(
                        &results,
                        scanned.min(MAX_SCAN_ENTRIES),
                        0,
                        Some(&checkpoint),
                    );
                }
            }
        }
        if truncated || results.len() >= result_limit {
            break;
        }
    }

    Ok(json!({
        "path": root.to_string_lossy(),
        "query": query,
        "caseSensitive": case_sensitive,
        "items": results,
        "truncated": truncated,
        "timedOut": timed_out,
        "scannedEntries": scanned.min(MAX_SCAN_ENTRIES)
    }))
}

/// Open an allowlisted canonical path without following a symlink in ANY
/// component. A final-component O_NOFOLLOW alone is insufficient: another
/// process can rename an ancestor and replace it with an outside-root link
/// after PathPolicy resolves the path. openat() pins each parent directory
/// descriptor before the next component is resolved.
#[cfg(unix)]
fn open_regular_unix(path: &Path, append: bool) -> Result<fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;

    if !path.is_absolute() {
        return Err(anyhow!("absolute_path_required"));
    }
    let mut components = path
        .components()
        .filter(|part| !matches!(part, Component::RootDir))
        .peekable();
    let mut directory = fs::File::open("/")?;
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(anyhow!("unsafe_path_component"));
        };
        let name = CString::new(name.as_bytes()).map_err(|_| anyhow!("unsafe_path_component"))?;
        let last = components.peek().is_none();
        let flags = if last {
            if append {
                libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT
            } else {
                libc::O_RDONLY
            }
        } else {
            libc::O_RDONLY | libc::O_DIRECTORY
        };
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // Ownership transfers to File immediately, including on error paths.
        let opened = unsafe { fs::File::from_raw_fd(fd) };
        if last {
            if !opened.metadata()?.is_file() {
                return Err(anyhow!("path is not a regular file"));
            }
            return Ok(opened);
        }
        directory = opened;
    }
    Err(anyhow!("path is not a regular file"))
}

/// Open only a regular file. Unix also pins every ancestor directory using
/// openat(O_DIRECTORY | O_NOFOLLOW), closing parent-symlink substitution races
/// for descriptor-based reads. Atomic rename operations remain a separate gate.
fn open_regular_read(path: &Path) -> Result<fs::File> {
    #[cfg(unix)]
    {
        open_regular_unix(path, false)
    }
    #[cfg(not(unix))]
    {
        #[cfg(windows)]
        reject_windows_undo_reparse_ancestors(path)?;
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(anyhow!("path is not a regular file"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(anyhow!("unsafe_file_reparse_target"));
            }
            // Narrow the ancestor-swap window after opening the handle.
            // This is not a substitute for handle-relative Windows traversal.
            reject_windows_undo_reparse_ancestors(path)?;
        }
        Ok(file)
    }
}

/// Append through a pinned parent-directory chain on Unix. On Windows, the
/// existing final-component reparse-point guard remains in effect; a full
/// Windows parent-handle traversal is still an outstanding acceptance gate.
fn open_regular_append(path: &Path) -> Result<fs::File> {
    #[cfg(unix)]
    {
        open_regular_unix(path, true)
    }
    #[cfg(not(unix))]
    {
        #[cfg(windows)]
        reject_windows_undo_reparse_ancestors(path)?;
        let mut options = fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(anyhow!("path is not a regular append target"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(anyhow!("unsafe_file_reparse_target"));
            }
            reject_windows_undo_reparse_ancestors(path)?;
        }
        Ok(file)
    }
}

#[cfg(all(test, windows))]
mod windows_file_reparse_tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn junction_parent_cannot_redirect_direct_read_or_append() {
        let root = std::env::temp_dir().join(format!("wc-file-junction-{}", Uuid::new_v4()));
        let outside = root.join("outside");
        let alias = root.join("alias");
        fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("private.txt");
        fs::write(&outside_file, b"outside-private").unwrap();
        let output = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&alias)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let redirected = alias.join("private.txt");
        assert!(open_regular_read(&redirected).is_err());
        assert!(open_regular_append(&redirected).is_err());
        assert_eq!(fs::read(&outside_file).unwrap(), b"outside-private");
        assert!(open_regular_read(&outside_file).is_ok());
        fs::remove_dir(&alias).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn junction_parent_cannot_redirect_atomic_write_staging() {
        let base = std::env::temp_dir().join(format!("wc-write-junction-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        let alias = allowed.join("redirect");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("private.txt");
        fs::write(&secret, b"outside-private").unwrap();
        let output = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&alias)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // Neither a replacement nor a new file may stage bytes outside the
        // allowlisted directory, even for an unguarded write.
        assert!(atomic_write(&alias.join("private.txt"), b"overwrite", None).is_err());
        assert!(atomic_write(&alias.join("created.txt"), b"create", None).is_err());
        assert_eq!(fs::read(&secret).unwrap(), b"outside-private");
        assert!(!outside.join("created.txt").exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);

        // The same protection must apply to the public fs_write entrypoint.
        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        assert!(write(
            &policy,
            alias.join("nested/file.txt").to_str().unwrap(),
            &STANDARD.encode(b"unsafe"),
            true,
            None,
            false,
        )
        .is_err());
        assert!(!outside.join("nested").exists());

        // Ordinary writes into a non-reparse parent still work.
        atomic_write(&allowed.join("safe.txt"), b"safe", None).unwrap();
        assert_eq!(fs::read(allowed.join("safe.txt")).unwrap(), b"safe");
        fs::remove_dir(&alias).unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn guarded_write_rejects_hardlinked_target_and_preserves_both_aliases() {
        let root = std::env::temp_dir().join(format!("wc-write-hardlink-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let original = root.join("original.txt");
        let alias = root.join("alias.txt");
        fs::write(&original, b"before").unwrap();
        fs::hard_link(&original, &alias).unwrap();
        let sha = format!("{:x}", Sha256::digest(b"before"));
        let error = atomic_write(&original, b"after", Some(&sha)).unwrap_err();
        assert!(error.to_string().contains("file_changed_since_read"));
        assert_eq!(fs::read(&original).unwrap(), b"before");
        assert_eq!(fs::read(&alias).unwrap(), b"before");
        fs::remove_file(&alias).unwrap();
        atomic_write(&original, b"after", Some(&sha)).unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"after");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_atomic_staging_inplace_worker() {
        let Ok(raw) = std::env::var("WCF_WIN_STAGE_INPLACE_TARGET") else {
            return;
        };
        let error = atomic_write(Path::new(&raw), b"agent-update", None).unwrap_err();
        assert!(
            error.to_string().contains("atomic_staging_changed"),
            "unexpected staging error: {error}"
        );
    }

    #[test]
    fn windows_atomic_staging_inplace_tamper_is_rejected() {
        use std::process::Stdio;
        let base = std::env::temp_dir().join(format!("wc-win-stage-edit-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let target = base.join("target.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::windows_file_reparse_tests::windows_atomic_staging_inplace_worker")
            .arg("--nocapture")
            .env("WCF_WIN_STAGE_INPLACE_TARGET", &target)
            .env("WCF_WIN_CAS_MARKER", &marker)
            .env("WCF_WIN_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("Windows staging worker exited before barrier: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("Windows staging worker never reached barrier");
        }
        let stage = fs::read_dir(&base)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(".wecommander-"))
            })
            .expect("missing staging leaf");
        fs::write(&stage, b"attacker-stage").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Windows staging worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"seed");
        assert!(!stage.exists(), "owned staging file should be cleaned");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn windows_atomic_staging_swap_worker() {
        let Ok(raw) = std::env::var("WCF_WIN_STAGE_SWAP_TARGET") else {
            return;
        };
        let error = atomic_write(Path::new(&raw), b"agent-update", None).unwrap_err();
        assert!(
            error.to_string().contains("atomic_staging_changed"),
            "unexpected staging error: {error}"
        );
    }

    #[test]
    fn windows_atomic_staging_swap_rejects_untrusted_publication_and_cleanup() {
        use std::process::Stdio;
        let base = std::env::temp_dir().join(format!("wc-win-stage-swap-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let target = base.join("target.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        let parked = base.join("parked-stage.txt");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::windows_file_reparse_tests::windows_atomic_staging_swap_worker")
            .arg("--nocapture")
            .env("WCF_WIN_STAGE_SWAP_TARGET", &target)
            .env("WCF_WIN_CAS_MARKER", &marker)
            .env("WCF_WIN_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("Windows staging worker exited before barrier: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("Windows staging worker never reached barrier");
        }
        let stage = fs::read_dir(&base)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(".wecommander-"))
            })
            .expect("missing staging leaf");
        fs::rename(&stage, &parked).unwrap();
        fs::write(&stage, b"attacker-stage").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Windows staging worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"seed");
        assert_eq!(fs::read(&stage).unwrap(), b"attacker-stage");
        assert_eq!(fs::read(&parked).unwrap(), b"agent-update");
        fs::remove_file(&stage).unwrap();
        atomic_write(&target, b"recovered", None).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"recovered");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn windows_atomic_create_worker() {
        let Ok(raw) = std::env::var("WCF_WIN_CREATE_TARGET") else {
            return;
        };
        assert!(
            atomic_write(Path::new(&raw), b"agent-create", None).is_err(),
            "external creator's file was overwritten"
        );
    }

    #[test]
    fn windows_atomic_create_rejects_external_creation_during_stage() {
        use std::process::Stdio;
        let root = std::env::temp_dir().join(format!("wc-win-create-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("new.txt");
        let marker = root.join("staged.marker");
        let release = root.join("release.marker");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::windows_file_reparse_tests::windows_atomic_create_worker")
            .arg("--nocapture")
            .env("WCF_WIN_CREATE_TARGET", &target)
            .env("WCF_WIN_CAS_MARKER", &marker)
            .env("WCF_WIN_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("Windows create worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("Windows create worker never reached staging barrier");
        }
        fs::write(&target, b"external-create").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Windows create worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"external-create");
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wecommander-"))
                .count(),
            0
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_atomic_replace_no_sha_worker() {
        let Ok(raw) = std::env::var("WCF_WIN_NO_SHA_TARGET") else {
            return;
        };
        let error = atomic_write(Path::new(&raw), b"agent-update", None).unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "unexpected unguarded replacement error: {error}"
        );
    }

    #[test]
    fn windows_atomic_replace_no_sha_swap_during_stage_is_rejected() {
        use std::process::Stdio;
        let base = std::env::temp_dir().join(format!("wc-win-no-sha-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let target = base.join("target.txt");
        let retired = base.join("retired.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::windows_file_reparse_tests::windows_atomic_replace_no_sha_worker")
            .arg("--nocapture")
            .env("WCF_WIN_NO_SHA_TARGET", &target)
            .env("WCF_WIN_CAS_MARKER", &marker)
            .env("WCF_WIN_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("Windows no-SHA worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("Windows no-SHA worker never reached staging barrier");
        }
        fs::rename(&target, &retired).unwrap();
        fs::write(&target, b"external-file").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Windows no-SHA worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"external-file");
        assert_eq!(fs::read(&retired).unwrap(), b"seed");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn windows_atomic_replace_no_sha_inplace_edit_is_rejected() {
        use std::process::Stdio;
        let base = std::env::temp_dir().join(format!("wc-win-inplace-no-sha-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let target = base.join("target.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::windows_file_reparse_tests::windows_atomic_replace_no_sha_worker")
            .arg("--nocapture")
            .env("WCF_WIN_NO_SHA_TARGET", &target)
            .env("WCF_WIN_CAS_MARKER", &marker)
            .env("WCF_WIN_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("Windows in-place worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("Windows in-place worker never reached staging barrier");
        }
        fs::write(&target, b"evil").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Windows in-place worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"evil");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn windows_same_content_swap_worker() {
        let Ok(raw) = std::env::var("WCF_WIN_CAS_TARGET") else {
            return;
        };
        let expected = format!("{:x}", Sha256::digest(b"seed"));
        let error = atomic_write(Path::new(&raw), b"agent-update", Some(&expected)).unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "unexpected guard error: {error}"
        );
    }

    #[test]
    fn windows_same_content_swap_during_stage_is_rejected() {
        use std::process::Stdio;
        let base = std::env::temp_dir().join(format!("wc-win-aba-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let target = base.join("target.txt");
        let retired = base.join("retired.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::windows_file_reparse_tests::windows_same_content_swap_worker")
            .arg("--nocapture")
            .env("WCF_WIN_CAS_TARGET", &target)
            .env("WCF_WIN_CAS_MARKER", &marker)
            .env("WCF_WIN_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("guard worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("guard worker never reached the staging barrier");
        }
        // A distinct file identity with the same SHA must not be overwritten.
        fs::rename(&target, &retired).unwrap();
        fs::write(&target, b"seed").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "guard worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"seed");
        assert_eq!(fs::read(&retired).unwrap(), b"seed");
        let staged_files: Vec<_> = fs::read_dir(&base)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().starts_with(".wecommander-"))
            .collect();
        assert!(staged_files.is_empty());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn parent_swap_after_resolution_cannot_redirect_atomic_write() {
        let base = std::env::temp_dir().join(format!("wc-write-swap-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let working = allowed.join("working");
        let outside = base.join("outside");
        fs::create_dir_all(&working).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        let resolved = policy
            .resolve_for_create(working.join("created.txt").to_str().unwrap())
            .unwrap();
        fs::rename(&working, allowed.join("relocated")).unwrap();
        let output = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&working)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction swap fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(atomic_write(&resolved, b"redirected", None).is_err());
        assert!(!outside.join("created.txt").exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir(&working).unwrap();
        fs::remove_dir_all(base).unwrap();
    }
}

#[cfg(test)]
mod append_security_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn append_handle_rejects_final_symlink_swap_after_policy_resolution() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("commender-append-race-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = allowed.join("file.txt");
        let secret = outside.join("secret.txt");
        fs::write(&target, b"inside").unwrap();
        fs::write(&secret, b"outside").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        let resolved = policy.resolve_for_create(target.to_str().unwrap()).unwrap();
        fs::remove_file(&target).unwrap();
        symlink(&secret, &target).unwrap();
        assert!(open_regular_append(&resolved).is_err());
        assert_eq!(fs::read(&secret).unwrap(), b"outside");
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn read_and_append_handles_reject_parent_symlink_swap_after_policy_resolution() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!("commender-parent-race-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let nested = allowed.join("nested");
        let outside = base.join("outside");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = nested.join("file.txt");
        let secret = outside.join("file.txt");
        fs::write(&target, b"inside").unwrap();
        fs::write(&secret, b"outside-private").unwrap();

        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        let resolved = policy.resolve_for_create(target.to_str().unwrap()).unwrap();
        fs::rename(&nested, allowed.join("renamed")).unwrap();
        symlink(&outside, &nested).unwrap();

        // The stale canonical pathname now resolves outside the allowed root.
        // Neither a read nor an append may follow the swapped parent link.
        assert!(open_regular_read(&resolved).is_err());
        assert!(open_regular_append(&resolved).is_err());
        assert_eq!(fs::read(&secret).unwrap(), b"outside-private");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn unguarded_append_uses_open_handle_for_size_limit() {
        let base = std::env::temp_dir().join(format!("commender-append-size-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("large.bin");
        fs::File::create(&path)
            .unwrap()
            .set_len(128 * 1024 * 1024)
            .unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&base)).unwrap();
        let result = append(&policy, path.to_str().unwrap(), "YQ==", None, false);
        assert!(result.is_err());
        assert_eq!(fs::metadata(&path).unwrap().len(), 128 * 1024 * 1024);
        fs::remove_dir_all(base).unwrap();
    }
}

/// Limit bytes read from a changing file and check cancellation between
/// bounded chunks. Invalid UTF-8 and oversized files are safely skipped.
#[cfg(test)]
fn read_search_utf8<R: Read>(
    reader: &mut R,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<String>> {
    let mut deadline = deadline;
    read_search_utf8_controlled(reader, cancelled, &mut deadline, None)
}

fn read_search_utf8_controlled<R: Read>(
    reader: &mut R,
    cancelled: &AtomicBool,
    deadline: &mut Instant,
    paused: Option<&AtomicBool>,
) -> Result<Option<String>> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        await_search_resume(paused, cancelled, deadline)?;
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("search_cancelled"));
        }
        if Instant::now() >= *deadline {
            return Ok(None);
        }
        let size = match reader.read(&mut chunk) {
            Ok(size) => size,
            Err(_) => return Ok(None),
        };
        if size == 0 {
            break;
        }
        if bytes.len().saturating_add(size) > MAX_TEXT_SEARCH_FILE as usize {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk[..size]);
    }
    Ok(String::from_utf8(bytes).ok())
}

pub fn text_search_cancellable(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    cancelled: &AtomicBool,
) -> Result<Value> {
    text_search_with_deadline(
        policy,
        raw,
        query,
        case_sensitive,
        max_results,
        Instant::now() + MAX_SEARCH_DURATION,
        cancelled,
    )
}

pub fn text_search_cancellable_controlled(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    controls: (&AtomicBool, &AtomicBool, Option<&Value>),
    report: &SearchProgressReporter,
) -> Result<Value> {
    text_search_with_deadline_reporting(
        policy,
        raw,
        query,
        case_sensitive,
        max_results,
        SearchExecution {
            deadline: Instant::now() + MAX_SEARCH_DURATION,
            cancelled: controls.0,
            paused: Some(controls.1),
            report: Some(report),
            resume: controls.2,
        },
    )
}

#[cfg(test)]
pub fn text_search_cancellable_reporting(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    cancelled: &AtomicBool,
    report: &SearchProgressReporter,
) -> Result<Value> {
    text_search_with_deadline_reporting(
        policy,
        raw,
        query,
        case_sensitive,
        max_results,
        SearchExecution {
            deadline: Instant::now() + MAX_SEARCH_DURATION,
            cancelled,
            paused: None,
            report: Some(report),
            resume: None,
        },
    )
}

fn text_search_with_deadline(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<Value> {
    text_search_with_deadline_reporting(
        policy,
        raw,
        query,
        case_sensitive,
        max_results,
        SearchExecution {
            deadline,
            cancelled,
            paused: None,
            report: None,
            resume: None,
        },
    )
}

fn text_search_with_deadline_reporting(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    execution: SearchExecution<'_>,
) -> Result<Value> {
    let SearchExecution {
        mut deadline,
        cancelled,
        paused,
        report,
        resume,
    } = execution;
    if query.is_empty() {
        return Err(anyhow!("text search query cannot be empty"));
    }
    if query.len() > 4096 {
        return Err(anyhow!("text search query is too long"));
    }

    let root = policy.resolve_existing(raw)?;
    let result_limit = max_results.unwrap_or(100).clamp(1, MAX_TEXT_SEARCH_RESULTS);
    let needle = if case_sensitive {
        query.to_owned()
    } else {
        query.to_lowercase()
    };

    let mut results = Vec::new();
    let mut stack = vec![root.clone()];
    let mut scanned_entries = 0_usize;
    let mut scanned_bytes = 0_u64;
    if let Some(checkpoint) = resume {
        // Prior matches are untrusted. Every line preview is recomputed from
        // a bounded, allowlisted regular file before accepting a checkpoint.
        if serde_json::to_vec(checkpoint)?.len() > MAX_CHECKPOINT_BYTES
            || checkpoint["version"] != 1
            || checkpoint["searchType"] != "content"
            || checkpoint["root"] != root.to_string_lossy().as_ref()
            || checkpoint["query"] != query
            || checkpoint["caseSensitive"] != case_sensitive
        {
            return Err(anyhow!("invalid_search_checkpoint"));
        }
        let pending = checkpoint["pending"]
            .as_array()
            .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
        let prior = checkpoint["items"]
            .as_array()
            .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
        let entries = checkpoint["scannedEntries"]
            .as_u64()
            .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
        let bytes = checkpoint["scannedBytes"]
            .as_u64()
            .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
        if prior.len() > result_limit
            || pending.is_empty()
            || pending.len() > 4096
            || entries > MAX_SCAN_ENTRIES as u64
            || bytes > MAX_TEXT_SEARCH_BYTES
        {
            return Err(anyhow!("invalid_search_checkpoint"));
        }
        stack.clear();
        let mut seen = std::collections::HashSet::new();
        for entry in pending {
            let value = entry
                .as_str()
                .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
            if value.len() > 4096 || !seen.insert(value) {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            let pending_path = Path::new(value);
            if !pending_path.starts_with(&root)
                || fs::symlink_metadata(pending_path)?.file_type().is_symlink()
                || policy.resolve_existing(value)? != pending_path
            {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            let metadata = fs::symlink_metadata(pending_path)?;
            if !metadata.is_dir() && !metadata.is_file() {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            stack.push(pending_path.to_path_buf());
        }
        // Revalidate complete prior file matches against current contents.
        // A stale preview or newly added matching line invalidates the whole
        // checkpoint; never present copied JSON as a fresh scan result.
        let mut prior_by_file = std::collections::BTreeMap::<String, Vec<Value>>::new();
        for item in prior {
            let name = item["path"]
                .as_str()
                .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
            if item.as_object().map(|obj| obj.len()) != Some(3)
                || item["line"].as_u64().is_none_or(|line| line == 0)
                || item["preview"].as_str().is_none()
                || name.len() > 4096
            {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            let path = Path::new(name);
            if !path.starts_with(&root)
                || stack.iter().any(|pending| path.starts_with(pending))
                || fs::symlink_metadata(path)?.file_type().is_symlink()
                || policy.resolve_existing(name)? != path
            {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            prior_by_file
                .entry(name.to_owned())
                .or_default()
                .push(item.clone());
        }
        let mut validation_bytes = 0_u64;
        for (name, expected) in prior_by_file {
            let path = Path::new(&name);
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_file()
                || metadata.len() > MAX_TEXT_SEARCH_FILE
                || validation_bytes.saturating_add(metadata.len()) > MAX_TEXT_SEARCH_BYTES
            {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            let mut file = open_regular_read(path)?;
            let text = read_search_utf8_controlled(&mut file, cancelled, &mut deadline, paused)?
                .ok_or_else(|| anyhow!("invalid_search_checkpoint"))?;
            validation_bytes = validation_bytes.saturating_add(text.len() as u64);
            if validation_bytes > MAX_TEXT_SEARCH_BYTES {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
            let mut actual = Vec::new();
            for (index, line) in text.lines().enumerate() {
                await_search_resume(paused, cancelled, &mut deadline)?;
                if cancelled.load(Ordering::Relaxed) {
                    return Err(anyhow!("search_cancelled"));
                }
                let matches = if case_sensitive {
                    line.contains(query)
                } else {
                    line.to_lowercase().contains(&needle)
                };
                if matches {
                    actual.push(json!({
                        "path": name, "line": index + 1,
                        "preview": preview_line(line)
                    }));
                }
            }
            if actual != expected {
                return Err(anyhow!("invalid_search_checkpoint"));
            }
        }
        results = prior.clone();
        scanned_entries = entries as usize;
        scanned_bytes = bytes;
    }
    let mut truncated = false;
    let mut timed_out = false;
    let mut next_progress = 32_usize;

    while let Some(path) = stack.pop() {
        await_search_resume(paused, cancelled, &mut deadline)?;
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("search_cancelled"));
        }
        if Instant::now() >= deadline {
            timed_out = true;
            truncated = true;
            break;
        }
        let Some(metadata) = search_metadata_if_present(&path)? else {
            continue;
        };

        if metadata.is_dir() {
            let entries = match fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                await_search_resume(paused, cancelled, &mut deadline)?;
                if cancelled.load(Ordering::Relaxed) {
                    return Err(anyhow!("search_cancelled"));
                }
                if Instant::now() >= deadline {
                    timed_out = true;
                    truncated = true;
                    break;
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                scanned_entries += 1;
                if scanned_entries > MAX_SCAN_ENTRIES {
                    truncated = true;
                    break;
                }

                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                if file_type.is_dir() || file_type.is_file() {
                    stack.push(entry.path());
                }
                if scanned_entries >= next_progress {
                    if let Some(report) = report {
                        report(
                            &results,
                            scanned_entries.min(MAX_SCAN_ENTRIES),
                            scanned_bytes,
                            None,
                        );
                    }
                    next_progress = scanned_entries.saturating_add(32);
                }
            }
        } else if metadata.is_file() {
            if metadata.len() > MAX_TEXT_SEARCH_FILE {
                continue;
            }
            if scanned_bytes.saturating_add(metadata.len()) > MAX_TEXT_SEARCH_BYTES {
                truncated = true;
                break;
            }
            // Read in cancellable, bounded chunks. File size can change after
            // metadata(), so a one-shot read_to_string is not a memory bound.
            let text = match open_regular_read(&path) {
                Ok(mut file) => {
                    match read_search_utf8_controlled(&mut file, cancelled, &mut deadline, paused)?
                    {
                        Some(value) => value,
                        None => {
                            if Instant::now() >= deadline {
                                timed_out = true;
                                truncated = true;
                                break;
                            }
                            continue;
                        }
                    }
                }
                Err(_) => continue,
            };
            if scanned_bytes.saturating_add(text.len() as u64) > MAX_TEXT_SEARCH_BYTES {
                truncated = true;
                break;
            }
            scanned_bytes += text.len() as u64;

            for (index, line) in text.lines().enumerate() {
                await_search_resume(paused, cancelled, &mut deadline)?;
                if cancelled.load(Ordering::Relaxed) {
                    return Err(anyhow!("search_cancelled"));
                }
                if Instant::now() >= deadline {
                    timed_out = true;
                    truncated = true;
                    break;
                }
                let haystack = if case_sensitive {
                    line.to_owned()
                } else {
                    line.to_lowercase()
                };
                if haystack.contains(&needle) {
                    results.push(json!({
                        "path": path.to_string_lossy(),
                        "line": index + 1,
                        "preview": preview_line(line)
                    }));
                    if results.len() % 32 == 0 {
                        if let Some(report) = report {
                            report(
                                &results,
                                scanned_entries.min(MAX_SCAN_ENTRIES),
                                scanned_bytes,
                                None,
                            );
                        }
                    }
                    if results.len() >= result_limit {
                        truncated = true;
                        break;
                    }
                }
            }
        }

        // A completed path is a safe replay boundary. Any saved matching
        // lines are fully revalidated on the next process before reuse.
        if !truncated && !stack.is_empty() {
            if let Some(report) = report {
                let checkpoint = json!({
                    "version": 1,
                    "searchType": "content",
                    "root": root.to_string_lossy(),
                    "query": query,
                    "caseSensitive": case_sensitive,
                    "pending": stack.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
                    "items": results,
                    "scannedEntries": scanned_entries.min(MAX_SCAN_ENTRIES),
                    "scannedBytes": scanned_bytes
                });
                if serde_json::to_vec(&checkpoint)?.len() <= MAX_CHECKPOINT_BYTES {
                    report(
                        &results,
                        scanned_entries.min(MAX_SCAN_ENTRIES),
                        scanned_bytes,
                        Some(&checkpoint),
                    );
                }
            }
        }
        if truncated {
            break;
        }
    }

    Ok(json!({
        "path": root.to_string_lossy(),
        "query": query,
        "caseSensitive": case_sensitive,
        "items": results,
        "truncated": truncated,
        "timedOut": timed_out,
        "scannedEntries": scanned_entries.min(MAX_SCAN_ENTRIES),
        "scannedBytes": scanned_bytes
    }))
}

pub fn stat(policy: &PathPolicy, raw: &str) -> Result<Value> {
    let path = policy.resolve_existing(raw)?;
    let metadata = fs::metadata(&path)?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "isFile": metadata.is_file(),
        "isDirectory": metadata.is_dir(),
        "size": metadata.len(),
        "readonly": metadata.permissions().readonly()
    }))
}

pub fn read(policy: &PathPolicy, raw: &str, max_bytes: Option<usize>) -> Result<Value> {
    let path = policy.resolve_existing(raw)?;
    if !path.is_file() {
        return Err(anyhow!("path is not a file"));
    }

    let limit = max_bytes
        .unwrap_or(DEFAULT_READ_MAX)
        .clamp(1, HARD_READ_MAX);
    let metadata = fs::metadata(&path)?;
    if metadata.len() > limit as u64 {
        return Err(anyhow!("file exceeds read limit of {limit} bytes"));
    }

    let mut bytes = Vec::with_capacity((metadata.len() as usize).min(limit));
    let mut file = open_regular_read(&path)?;
    std::io::Read::by_ref(&mut file)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(anyhow!("file exceeds read limit of {limit} bytes"));
    }

    if let Ok(text) = std::str::from_utf8(&bytes) {
        Ok(json!({ "encoding": "utf8", "content": text, "size": bytes.len() }))
    } else {
        Ok(json!({ "encoding": "base64", "content": STANDARD.encode(&bytes), "size": bytes.len() }))
    }
}

/// One bounded native operation, preserving per-file failures without exposing
/// filesystem or policy error details in a multi-file response.
pub fn read_multiple(
    policy: &PathPolicy,
    paths: &[String],
    max_bytes: Option<usize>,
) -> Result<Value> {
    if paths.is_empty() || paths.len() > 10 {
        return Err(anyhow!("invalid_batch_read_arguments"));
    }
    let limit = max_bytes.unwrap_or(64 * 1024);
    if !(1..=64 * 1024).contains(&limit) || paths.iter().any(|p| p.is_empty() || p.len() > 4096) {
        return Err(anyhow!("invalid_batch_read_arguments"));
    }
    let mut items = Vec::with_capacity(paths.len());
    for path in paths {
        match read(policy, path, Some(limit)) {
            Ok(data) => items.push(json!({ "path": path, "ok": true, "data": data })),
            Err(_) => items.push(json!({ "path": path, "ok": false, "error": "read_failed" })),
        }
    }
    Ok(json!({ "count": items.len(), "items": items }))
}

/// Read a bounded page of UTF-8 lines, with negative offsets counting from EOF.
pub fn read_lines(
    policy: &PathPolicy,
    raw: &str,
    offset_lines: Option<i64>,
    limit_lines: Option<usize>,
) -> Result<Value> {
    let path = policy.resolve_existing(raw)?;
    if !path.is_file() {
        return Err(anyhow!("path is not a file"));
    }
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_PAGED_FILE {
        return Err(anyhow!(
            "file exceeds paginated read scan limit of {MAX_PAGED_FILE} bytes"
        ));
    }
    // Bound the actual read, not only the metadata check: a concurrent writer
    // can grow a file after stat() and otherwise exhaust the Agent's memory.
    let mut file = open_regular_read(&path)?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(MAX_PAGED_FILE + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PAGED_FILE {
        return Err(anyhow!(
            "file exceeds paginated read scan limit of {MAX_PAGED_FILE} bytes"
        ));
    }
    let content = String::from_utf8(bytes).context("paginated read requires UTF-8 text")?;
    let total = content.lines().count();
    let offset = offset_lines.unwrap_or(0);
    let start = if offset < 0 {
        total.saturating_sub(offset.unsigned_abs().min(total as u64) as usize)
    } else {
        (offset as u64).min(total as u64) as usize
    };
    let page_size = limit_lines.unwrap_or(100).clamp(1, 1000);
    let mut page = Vec::<String>::new();
    let mut bytes = 0usize;
    for line in content.lines().skip(start).take(page_size) {
        let needed = line.len().saturating_add(1);
        if bytes.saturating_add(needed) > MAX_PAGE_BYTES {
            if page.is_empty() {
                return Err(anyhow!(
                    "individual line exceeds paginated output limit of {MAX_PAGE_BYTES} bytes"
                ));
            }
            break;
        }
        bytes += needed;
        page.push(line.to_string());
    }
    let end = start + page.len();
    Ok(json!({
        "path": path.to_string_lossy(),
        "content": page.join("\n"),
        "lines": page,
        "startLine": if end > start { start + 1 } else { 0 },
        "endLine": if end > start { end } else { 0 },
        "totalLines": total,
        "truncated": end < total,
        "maxPageBytes": MAX_PAGE_BYTES
    }))
}

pub fn write(
    policy: &PathPolicy,
    raw: &str,
    content_base64: &str,
    create_parents: bool,
    expected_sha256: Option<&str>,
    with_undo: bool,
) -> Result<Value> {
    write_impl(
        policy,
        raw,
        content_base64,
        create_parents,
        expected_sha256,
        with_undo,
        None,
    )
}

pub fn write_scoped(
    policy: &PathPolicy,
    raw: &str,
    content_base64: &str,
    create_parents: bool,
    expected_sha256: Option<&str>,
    with_undo: bool,
    undo_scope: &str,
) -> Result<Value> {
    write_impl(
        policy,
        raw,
        content_base64,
        create_parents,
        expected_sha256,
        with_undo,
        Some(undo_scope),
    )
}

fn write_impl(
    policy: &PathPolicy,
    raw: &str,
    content_base64: &str,
    create_parents: bool,
    expected_sha256: Option<&str>,
    with_undo: bool,
    undo_scope: Option<&str>,
) -> Result<Value> {
    let path = policy.resolve_for_create(raw)?;
    let bytes = STANDARD
        .decode(content_base64)
        .context("contentBase64 is not valid base64")?;
    if bytes.len() > HARD_WRITE_MAX {
        return Err(anyhow!(
            "write exceeds hard limit of {HARD_WRITE_MAX} bytes"
        ));
    }
    // fs_undo reads at most 4 MiB of current content. Never issue an undoId
    // for a replacement that the restore path cannot read back.
    if with_undo && bytes.len() > HARD_READ_MAX {
        return Err(anyhow!("guarded_write_exceeds_4mib_limit"));
    }

    let lock = mutation_lock(&path)?;
    let _guard = lock
        .lock()
        .map_err(|_| anyhow!("file mutation lock poisoned"))?;
    // A guarded replacement requires an existing file. Do not create empty
    // directories as a side effect of a rejected expected-SHA/undo request.
    if create_parents && !with_undo && expected_sha256.is_none() {
        if let Some(parent) = path.parent() {
            // On Unix a path-based create_dir_all can follow an ancestor that
            // another process swaps to a symlink after allowlist resolution.
            // Reuse the no-follow mkdirat/openat traversal used by fs_mkdir.
            #[cfg(unix)]
            mkdir_pinned_unix(parent, true)?;
            #[cfg(not(unix))]
            {
                #[cfg(windows)]
                reject_windows_undo_reparse_ancestors(parent)?;
                fs::create_dir_all(parent)?;
                #[cfg(windows)]
                reject_windows_undo_reparse_ancestors(parent)?;
            }
        }
    }
    // Opt-in undo never silently overwrites a missing, oversized or symlink
    // target. The existing unguarded API remains backward compatible.
    let previous = if with_undo {
        // Undo snapshots remain bounded by the 4 MiB restore contract.
        let mut original = Vec::new();
        open_regular_read(&path)?
            .take(HARD_READ_MAX as u64 + 1)
            .read_to_end(&mut original)?;
        if original.len() > HARD_READ_MAX {
            return Err(anyhow!("guarded_write_exceeds_4mib_limit"));
        }
        let sha = format!("{:x}", Sha256::digest(&original));
        if expected_sha256.is_some_and(|expected| !sha.eq_ignore_ascii_case(expected)) {
            return Err(anyhow!("file_changed_since_read"));
        }
        Some((original, sha))
    } else if let Some(expected) = expected_sha256 {
        // A SHA-guarded write without undo needs only a digest, not a 4 MiB
        // in-memory snapshot. Stream through the hardlink-aware conflict scan.
        let original = open_regular_read(&path)?;
        let sha = atomic_unconditional_original_digest(&original)?
            .ok_or_else(|| anyhow!("file_changed_since_read"))?;
        if !sha.eq_ignore_ascii_case(expected) {
            return Err(anyhow!("file_changed_since_read"));
        }
        Some((Vec::new(), sha))
    } else {
        None
    };
    let next_sha = format!("{:x}", Sha256::digest(&bytes));
    let snapshot = if with_undo {
        let (original, previous_sha) = previous
            .as_ref()
            .ok_or_else(|| anyhow!("undo_requires_existing_file"))?;
        let (id, snapshot_path, pinned) =
            save_undo_snapshot(&path, original, previous_sha, &next_sha, undo_scope)?;
        Some((id, snapshot_path, pinned, previous_sha.clone()))
    } else {
        None
    };
    if let Err(error) = atomic_write(
        &path,
        &bytes,
        previous.as_ref().map(|(_, sha)| sha.as_str()),
    ) {
        if let Some((_, snapshot_path, pinned, _)) = &snapshot {
            let _ = remove_undo_snapshot_checked(snapshot_path, pinned);
        }
        return Err(error);
    }
    let mut response = json!({
        "ok": true, "path": path.to_string_lossy(), "size": bytes.len()
    });
    if let Some((id, _, _, previous_sha)) = snapshot {
        response["undoId"] = json!(id);
        response["previousSha256"] = json!(previous_sha);
        response["sha256"] = json!(next_sha);
    }
    Ok(response)
}

/// Append without truncating, up to the configured size limits.
pub fn append(
    policy: &PathPolicy,
    raw: &str,
    content_base64: &str,
    expected_sha256: Option<&str>,
    with_undo: bool,
) -> Result<Value> {
    append_impl(
        policy,
        raw,
        content_base64,
        expected_sha256,
        with_undo,
        None,
    )
}

pub fn append_scoped(
    policy: &PathPolicy,
    raw: &str,
    content_base64: &str,
    expected_sha256: Option<&str>,
    with_undo: bool,
    undo_scope: &str,
) -> Result<Value> {
    append_impl(
        policy,
        raw,
        content_base64,
        expected_sha256,
        with_undo,
        Some(undo_scope),
    )
}

fn append_impl(
    policy: &PathPolicy,
    raw: &str,
    content_base64: &str,
    expected_sha256: Option<&str>,
    with_undo: bool,
    undo_scope: Option<&str>,
) -> Result<Value> {
    let path = policy.resolve_for_create(raw)?;
    let bytes = STANDARD
        .decode(content_base64)
        .context("contentBase64 is not valid base64")?;
    if bytes.len() > HARD_WRITE_MAX {
        return Err(anyhow!(
            "append exceeds hard limit of {HARD_WRITE_MAX} bytes"
        ));
    }
    let lock = mutation_lock(&path)?;
    let _guard = lock
        .lock()
        .map_err(|_| anyhow!("file mutation lock poisoned"))?;
    // An undoable append must be an atomic replacement of the full bounded
    // result: a partially written append would invalidate its snapshot SHA.
    if with_undo || expected_sha256.is_some() {
        let mut original = Vec::new();
        open_regular_read(&path)?
            .take(HARD_READ_MAX as u64 + 1)
            .read_to_end(&mut original)?;
        if original.len() > HARD_READ_MAX {
            return Err(anyhow!("guarded_append_exceeds_4mib_limit"));
        }
        let previous_sha = format!("{:x}", Sha256::digest(&original));
        if expected_sha256.is_some_and(|expected| !previous_sha.eq_ignore_ascii_case(expected)) {
            return Err(anyhow!("file_changed_since_read"));
        }
        let mut updated = original.clone();
        updated.extend_from_slice(&bytes);
        if updated.len() > HARD_READ_MAX {
            return Err(anyhow!("guarded_append_exceeds_4mib_limit"));
        }
        let next_sha = format!("{:x}", Sha256::digest(&updated));
        let snapshot = if with_undo {
            Some(save_undo_snapshot(
                &path,
                &original,
                &previous_sha,
                &next_sha,
                undo_scope,
            )?)
        } else {
            None
        };
        if let Err(error) = atomic_write(&path, &updated, Some(&previous_sha)) {
            if let Some((_, snapshot_path, pinned)) = &snapshot {
                let _ = remove_undo_snapshot_checked(snapshot_path, pinned);
            }
            return Err(error);
        }
        let mut response = json!({
            "ok": true, "path": path.to_string_lossy(), "appendedBytes": bytes.len(),
            "previousSha256": previous_sha, "sha256": next_sha
        });
        if let Some((id, _, _)) = snapshot {
            response["undoId"] = json!(id);
        }
        return Ok(response);
    }

    let mut file = open_regular_append(&path)?;
    // The descriptor, not a path-based stat performed before open, is the
    // authority for the size limit. A concurrent writer may still append
    // after this check; cross-process locking remains an open acceptance gate.
    if file.metadata()?.len().saturating_add(bytes.len() as u64) > 128 * 1024 * 1024 {
        return Err(anyhow!("append exceeds total file limit of 128 MiB"));
    }
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy(), "appendedBytes": bytes.len() }))
}

#[cfg(test)]
pub fn replace_text(
    policy: &PathPolicy,
    raw: &str,
    search: &str,
    replacement: &str,
    replace_all: bool,
    expected_sha256: Option<&str>,
) -> Result<Value> {
    replace_text_impl(
        policy,
        raw,
        search,
        replacement,
        replace_all,
        expected_sha256,
        None,
    )
}

pub fn replace_text_scoped(
    policy: &PathPolicy,
    raw: &str,
    search: &str,
    replacement: &str,
    replace_all: bool,
    expected_sha256: Option<&str>,
    undo_scope: &str,
) -> Result<Value> {
    replace_text_impl(
        policy,
        raw,
        search,
        replacement,
        replace_all,
        expected_sha256,
        Some(undo_scope),
    )
}

fn replace_text_impl(
    policy: &PathPolicy,
    raw: &str,
    search: &str,
    replacement: &str,
    replace_all: bool,
    expected_sha256: Option<&str>,
    undo_scope: Option<&str>,
) -> Result<Value> {
    if search.is_empty() {
        return Err(anyhow!("search text cannot be empty"));
    }
    if search.len() > 256 * 1024 || replacement.len() > 1024 * 1024 {
        return Err(anyhow!("replacement payload is too large"));
    }

    let path = policy.resolve_existing(raw)?;
    if !path.is_file() {
        return Err(anyhow!("path is not a file"));
    }

    let lock = mutation_lock(&path)?;
    let _guard = lock
        .lock()
        .map_err(|_| anyhow!("file mutation lock poisoned"))?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > HARD_READ_MAX as u64 {
        return Err(anyhow!("file exceeds edit limit of {HARD_READ_MAX} bytes"));
    }

    // Bound the actual read and reject final-component symlink replacement,
    // even if the file changed after the earlier metadata check.
    let mut file = open_regular_read(&path)?;
    let mut original_bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(HARD_READ_MAX as u64 + 1)
        .read_to_end(&mut original_bytes)?;
    if original_bytes.len() > HARD_READ_MAX {
        return Err(anyhow!("file exceeds edit limit of {HARD_READ_MAX} bytes"));
    }
    let original = String::from_utf8(original_bytes).context("file is not valid UTF-8 text")?;
    let previous_sha256 = format!("{:x}", Sha256::digest(original.as_bytes()));
    if let Some(expected) = expected_sha256 {
        if !previous_sha256.eq_ignore_ascii_case(expected) {
            return Err(anyhow!("file_changed_since_read"));
        }
    }
    let matches = original.match_indices(search).count();
    if matches == 0 {
        return Err(anyhow!("search text was not found"));
    }
    if !replace_all && matches != 1 {
        return Err(anyhow!(
            "search text matched {matches} times; set replaceAll=true to replace multiple matches"
        ));
    }

    let updated = if replace_all {
        original.replace(search, replacement)
    } else {
        original.replacen(search, replacement, 1)
    };
    if updated.len() > HARD_WRITE_MAX {
        return Err(anyhow!(
            "edited file exceeds write limit of {HARD_WRITE_MAX} bytes"
        ));
    }

    let next_sha256 = format!("{:x}", Sha256::digest(updated.as_bytes()));
    let (undo_id, snapshot, pinned) = save_undo_snapshot(
        &path,
        original.as_bytes(),
        &previous_sha256,
        &next_sha256,
        undo_scope,
    )?;
    if let Err(error) = atomic_write(&path, updated.as_bytes(), Some(&previous_sha256)) {
        let _ = remove_undo_snapshot_checked(&snapshot, &pinned);
        return Err(error);
    }
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "replacements": if replace_all { matches } else { 1 },
        "previousSha256": previous_sha256,
        "sha256": next_sha256,
        "undoId": undo_id,
        "size": updated.len()
    }))
}

const MAX_UNDO_FILE_BYTES: u64 = 6 * 1024 * 1024;
const MAX_UNDO_PER_FILE: usize = 8;
const MAX_UNDO_PER_DIRECTORY: usize = 64;
const MAX_UNDO_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const UNDO_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
// A killed Agent can leave a private, uncommitted snapshot staging file.
// Give an active writer a generous grace period before reclaiming its quota.
const UNDO_TEMP_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

// Protect the shared snapshot directory budget and pruning from concurrent
// writes/restores to different files in the same Agent process.
static UNDO_DIRECTORY_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

fn undo_directory_lock() -> Result<std::sync::MutexGuard<'static, ()>> {
    UNDO_DIRECTORY_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .map_err(|_| anyhow!("undo_directory_lock_poisoned"))
}

// The process-local mutex cannot protect the shared undo quota when two
// enrolled Agent processes use the same data directory. Keep a persistent
// lock inode: deleting it would let processes lock different files.
// Windows junctions are not always reported as symlinks. Reject reparse
// points in every existing ancestor before creating, locking, reading or
// pruning the private undo store. This is fail-closed path validation, not a
// substitute for a Windows handle-relative traversal under hostile swaps.
// Stable Rust has no Windows MetadataExt::number_of_links. Inspect the
// already-open handle, not a replaceable pathname. A shared inode cannot be
// treated as private undo evidence or a conflict-guarded write target.
#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct ByHandleFileInformation {
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
fn windows_file_information(file: &fs::File) -> Result<ByHandleFileInformation> {
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "GetFileInformationByHandle"]
        fn get_file_information_by_handle(
            handle: *mut std::ffi::c_void,
            info: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut info = ByHandleFileInformation::default();
    // SAFETY: file owns a live handle and info matches BY_HANDLE_FILE_INFORMATION.
    if unsafe { get_file_information_by_handle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(info)
}

#[cfg(windows)]
fn windows_file_identity(file: &fs::File) -> Result<(u32, u32, u32)> {
    let info = windows_file_information(file)?;
    Ok((info.volume_serial, info.index_high, info.index_low))
}

#[cfg(windows)]
fn reject_windows_hardlinked_file(file: &fs::File) -> Result<()> {
    let info = windows_file_information(file)?;
    if info.attributes & 0x400 != 0 {
        return Err(anyhow!("unsafe_undo_storage_entry"));
    }
    if info.link_count != 1 {
        return Err(anyhow!("unsafe_undo_storage_hardlink"));
    }
    Ok(())
}

fn reject_windows_undo_reparse_ancestors(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        for ancestor in path.ancestors() {
            match fs::symlink_metadata(ancestor) {
                Ok(meta) if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
                    return Err(anyhow!("unsafe_undo_reparse_ancestor"));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    Ok(())
}

fn undo_cross_process_lock(dir: &Path) -> Result<fs::File> {
    undo_cross_process_lock_with_timeout(dir, Duration::from_secs(5))
}

fn undo_cross_process_lock_with_timeout(dir: &Path, timeout: Duration) -> Result<fs::File> {
    reject_windows_undo_reparse_ancestors(dir)?;
    let path = dir.join(".undo.lock");
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let lock = options.open(&path)?;
    if !lock.metadata()?.is_file() {
        return Err(anyhow!("unsafe_undo_lock"));
    }
    let start = Instant::now();
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) => {
                if start.elapsed() >= timeout {
                    return Err(anyhow!("undo_storage_lock_timeout"));
                }
                std::thread::sleep(
                    Duration::from_millis(25).min(timeout.saturating_sub(start.elapsed())),
                );
            }
            Err(error) => return Err(anyhow!("undo_storage_lock_failed: {error}")),
        }
    }
    reject_windows_undo_reparse_ancestors(dir)?;
    let path_meta = fs::symlink_metadata(&path)?;
    if !path_meta.is_file() || path_meta.file_type().is_symlink() {
        return Err(anyhow!("unsafe_undo_lock"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if path_meta.file_attributes() & 0x400 != 0 {
            return Err(anyhow!("unsafe_undo_lock_reparse_point"));
        }
        reject_windows_hardlinked_file(&lock)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let held_meta = lock.metadata()?;
        if held_meta.dev() != path_meta.dev()
            || held_meta.ino() != path_meta.ino()
            || held_meta.nlink() != 1
        {
            return Err(anyhow!("undo_storage_lock_replaced_or_linked"));
        }
    }
    Ok(lock)
}

// Only validated snapshot filenames are eligible for retention deletion.
// Unknown regular files still count toward the quota; unsafe entries fail closed.
fn undo_snapshot_name(name: &str) -> bool {
    let Some((prefix, id)) = name.strip_suffix(".undo").and_then(|v| v.split_once('-')) else {
        return false;
    };
    prefix.len() == 64
        && prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
        && Uuid::parse_str(id).is_ok()
}

// Only our UUID-named staging files are eligible for crash recovery cleanup.
// Unknown files must not be deleted, even when they are old.
fn undo_temporary_name(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|value| value.strip_suffix(".tmp"))
        .is_some_and(|id| Uuid::parse_str(id).is_ok())
}

// Retention and quota decisions must use the file we actually opened, not
// stale path metadata collected before another process changed the entry.
fn checked_undo_storage_metadata(
    path: &Path,
    observed: &fs::Metadata,
    observed_handle: &fs::File,
) -> Result<fs::Metadata> {
    let reader = open_regular_read(path).map_err(|_| anyhow!("unsafe_undo_storage_entry"))?;
    reject_undo_hardlinked_handle(&reader)?;
    let current = reader.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // The directory scan and the first open are distinct observations.
        // A -> B -> A path swap can make lstat and the final reader agree
        // while the first opened handle still points at B. Bind all three.
        let first = observed_handle.metadata()?;
        if observed.dev() != current.dev()
            || observed.ino() != current.ino()
            || first.dev() != current.dev()
            || first.ino() != current.ino()
        {
            return Err(anyhow!("undo_storage_entry_changed"));
        }
    }
    #[cfg(windows)]
    {
        // A same-content replacement can preserve size and timestamps. Pin
        // the first opened file identity and compare it to the quota reader.
        if windows_file_identity(observed_handle)? != windows_file_identity(&reader)? {
            return Err(anyhow!("undo_storage_entry_changed"));
        }
        let _ = observed;
    }
    #[cfg(not(windows))]
    let _ = observed_handle;
    Ok(current)
}

// Keep undo cleanup inside a pinned directory on Unix. A path-based
// remove_file can follow a parent swapped to an outside-root symlink after
// the snapshot was validated. This does not make final-leaf unlink an atomic
// compare-and-delete operation against a hostile concurrent writer.
fn unlink_undo_snapshot(path: &Path, verified: &fs::File, digest: &str) -> Result<()> {
    #[cfg(unix)]
    unlink_undo_snapshot_unix_with_hook(path, verified, digest, || Ok(()))?;
    #[cfg(windows)]
    unlink_undo_snapshot_windows_with_hook(path, verified, digest, || Ok(()))?;
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, verified, digest);
        return Err(anyhow!("undo_snapshot_unlink_unsupported"));
    }
    Ok(())
}

// Re-open the leaf relative to the same pinned parent that unlinkat uses.
// This closes the gap between a pathname-based final check and the directory
// handle used for deletion. It does NOT make the last comparison and unlinkat
// a kernel-atomic content CAS against a hostile writer.
#[cfg(unix)]
fn unlink_undo_snapshot_unix_with_hook(
    path: &Path,
    verified: &fs::File,
    digest: &str,
    before_unlink: impl FnOnce() -> Result<()>,
) -> Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};

    let (parent, name) = rename_parent_handle(path)?;
    before_unlink()?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(anyhow!("undo_snapshot_changed_before_unlink"));
    }
    // SAFETY: openat returned a new owned descriptor, transferred to File.
    let named = unsafe { fs::File::from_raw_fd(fd) };
    if !named.metadata()?.is_file() {
        return Err(anyhow!("undo_snapshot_changed_before_unlink"));
    }
    reject_undo_hardlinked_handle(&named)?;
    if !undo_snapshot_identity_matches(verified, &named)?
        || undo_quarantine_digest(&named)? != digest
    {
        return Err(anyhow!("undo_snapshot_changed_before_unlink"));
    }
    let status = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) };
    if status != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

// Windows can mark the *opened file* for deletion rather than removing a
// pathname that an uncooperative writer may replace after verification.
// The DELETE-capable handle is revalidated against the pinned snapshot and
// the currently named leaf. POSIX disposition unlinks that opened file, not
// an attacker-controlled replacement of the name. This is NOT an atomic
// content-CAS: a writer with a separate writable handle may still mutate
// the original inode after the final digest.
#[cfg(windows)]
fn unlink_undo_snapshot_windows_with_hook(
    path: &Path,
    verified: &fs::File,
    digest: &str,
    before_delete: impl FnOnce() -> Result<()>,
) -> Result<()> {
    unlink_undo_snapshot_windows_with_hooks(path, verified, digest, before_delete, || Ok(()))
}

// A test-only second hook exercises changes after the named-leaf digest.
// Production supplies a no-op; it still performs the final handle checks.
#[cfg(windows)]
fn unlink_undo_snapshot_windows_with_hooks(
    path: &Path,
    verified: &fs::File,
    digest: &str,
    before_delete: impl FnOnce() -> Result<()>,
    before_disposition: impl FnOnce() -> Result<()>,
) -> Result<()> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};

    #[repr(C)]
    struct FileDispositionInfoEx {
        flags: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "SetFileInformationByHandle"]
        fn set_file_information_by_handle(
            handle: *mut std::ffi::c_void,
            info_class: i32,
            info: *const FileDispositionInfoEx,
            info_size: u32,
        ) -> i32;
    }

    const GENERIC_READ: u32 = 0x8000_0000;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_DISPOSITION_INFO_EX_CLASS: i32 = 21;
    const FILE_DISPOSITION_FLAG_DELETE: u32 = 0x0000_0001;
    const FILE_DISPOSITION_FLAG_POSIX_SEMANTICS: u32 = 0x0000_0002;

    reject_windows_undo_reparse_ancestors(path)?;
    let mut options = fs::OpenOptions::new();
    options
        .read(true)
        .access_mode(GENERIC_READ | DELETE_ACCESS)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let delete_handle = options
        .open(path)
        .map_err(|_| anyhow!("undo_snapshot_changed_before_unlink"))?;
    reject_windows_hardlinked_file(&delete_handle)?;
    if !undo_snapshot_identity_matches(verified, &delete_handle)?
        || undo_quarantine_digest(&delete_handle)? != digest
    {
        return Err(anyhow!("undo_snapshot_changed_before_unlink"));
    }

    before_delete()?;
    reject_windows_undo_reparse_ancestors(path)?;
    let named =
        open_regular_read(path).map_err(|_| anyhow!("undo_snapshot_changed_before_unlink"))?;
    reject_undo_hardlinked_handle(&named)?;
    if !undo_snapshot_identity_matches(&delete_handle, &named)?
        || undo_quarantine_digest(&named)? != digest
    {
        return Err(anyhow!("undo_snapshot_changed_before_unlink"));
    }

    before_disposition()?;
    // The named-leaf digest may take time. Recheck the DELETE handle's
    // current link count and bytes, and the named leaf's identity, just
    // before disposition. This narrows, but does not eliminate, a hostile
    // writer's final check-to-disposition race.
    reject_windows_undo_reparse_ancestors(path)?;
    reject_windows_hardlinked_file(&delete_handle)?;
    if undo_quarantine_digest(&delete_handle)? != digest {
        return Err(anyhow!("undo_snapshot_changed_before_unlink"));
    }
    let final_named =
        open_regular_read(path).map_err(|_| anyhow!("undo_snapshot_changed_before_unlink"))?;
    reject_undo_hardlinked_handle(&final_named)?;
    if !undo_snapshot_identity_matches(&delete_handle, &final_named)?
        || undo_quarantine_digest(&final_named)? != digest
    {
        return Err(anyhow!("undo_snapshot_changed_before_unlink"));
    }

    let disposition = FileDispositionInfoEx {
        flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    // SAFETY: delete_handle is live and the class/structure layout matches
    // FILE_DISPOSITION_INFO_EX; no caller-provided pointer is retained.
    if unsafe {
        set_file_information_by_handle(
            delete_handle.as_raw_handle(),
            FILE_DISPOSITION_INFO_EX_CLASS,
            &disposition,
            std::mem::size_of::<FileDispositionInfoEx>() as u32,
        )
    } == 0
    {
        return Err(anyhow!(
            "undo_snapshot_handle_unlink_failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

// Identity is checked both before and AFTER moving the leaf into a private
// quarantine name. A hostile writer can replace the source leaf between
// validation and rename; only the inode actually moved may be deleted.
fn undo_snapshot_identity_matches(expected: &fs::File, actual: &fs::File) -> Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let before = expected.metadata()?;
        let now = actual.metadata()?;
        Ok(before.dev() == now.dev() && before.ino() == now.ino())
    }
    #[cfg(windows)]
    {
        Ok(windows_file_identity(expected)? == windows_file_identity(actual)?)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (expected, actual);
        Err(anyhow!("undo_snapshot_unlink_unsupported"))
    }
}

// Compare bounded bytes on both sides of the quarantine rename. File identity
// alone cannot detect an in-place rewrite of the same inode during cleanup.
// This is a race reduction, not a kernel-level atomic compare-and-unlink.
fn undo_quarantine_digest(mut file: &fs::File) -> Result<String> {
    let mut digest = Sha256::new();
    let mut chunk = [0_u8; 16 * 1024];
    let mut total = 0_u64;
    loop {
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| anyhow!("undo_snapshot_too_large"))?;
        if total > HARD_WRITE_MAX as u64 {
            return Err(anyhow!("undo_snapshot_too_large"));
        }
        digest.update(&chunk[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

// Opt-in debug-only interprocess pause after a real undo snapshot has been
// quarantined. Production/release binaries never contain this fixture.
#[cfg(all(unix, feature = "ci-race-fixtures", debug_assertions))]
fn pause_for_mcp_undo_quarantine_fixture(path: &Path) -> Result<()> {
    let Ok(target) = std::env::var("WCF_MCP_UNDO_TARGET") else {
        return Ok(());
    };
    let prefix = format!("{}-", undo_prefix(Path::new(&target)));
    if !path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with(&prefix))
    {
        return Ok(());
    }
    let marker = std::env::var("WCF_MCP_UNDO_MARKER")?;
    let release = std::env::var("WCF_MCP_UNDO_RELEASE")?;
    fs::write(marker, b"quarantined")?;
    let started = Instant::now();
    while !Path::new(&release).exists() {
        if started.elapsed() > Duration::from_secs(20) {
            return Err(anyhow!("mcp_undo_quarantine_fixture_timeout"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

// Opt-in second barrier after the first quarantine digest, before the final
// pathname re-open. It tests post-digest hostile edits through real MCP, not
// an atomic compare-and-unlink guarantee. Absent from release binaries.
#[cfg(all(unix, feature = "ci-race-fixtures", debug_assertions))]
fn pause_for_mcp_undo_postdigest_fixture(path: &Path) -> Result<()> {
    let Ok(target) = std::env::var("WCF_MCP_UNDO_POSTDIGEST_TARGET") else {
        return Ok(());
    };
    let prefix = format!("{}-", undo_prefix(Path::new(&target)));
    if !path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with(&prefix))
    {
        return Ok(());
    }
    let marker = std::env::var("WCF_MCP_UNDO_POSTDIGEST_MARKER")?;
    let release = std::env::var("WCF_MCP_UNDO_POSTDIGEST_RELEASE")?;
    fs::write(marker, b"postdigest")?;
    let started = Instant::now();
    while !Path::new(&release).exists() {
        if started.elapsed() > Duration::from_secs(20) {
            return Err(anyhow!("mcp_undo_postdigest_fixture_timeout"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn remove_undo_snapshot_checked(path: &Path, expected: &fs::File) -> Result<()> {
    remove_undo_snapshot_checked_with_hook(path, expected, || Ok(()))
}

// The hook is a no-op in production; tests inject a leaf replacement at the
// exact pre-rename boundary without timing-dependent sleeps.
fn remove_undo_snapshot_checked_with_hook(
    path: &Path,
    expected: &fs::File,
    before_move: impl FnOnce() -> Result<()>,
) -> Result<()> {
    remove_undo_snapshot_checked_with_hooks(path, expected, before_move, |_| Ok(()))
}

// The second hook is test-only fault injection at the post-move boundary.
// Production always supplies a no-op. Never trust a quarantine leaf merely
// because its name was generated by us: another process may replace it.
fn remove_undo_snapshot_checked_with_hooks(
    path: &Path,
    expected: &fs::File,
    before_move: impl FnOnce() -> Result<()>,
    after_move: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    remove_undo_snapshot_checked_with_all_hooks(path, expected, before_move, after_move, |_| Ok(()))
}

// Test-only post-digest injection exercises the last pathname recheck.
// This remains a race reduction, not an atomic unlink-by-handle guarantee.
fn remove_undo_snapshot_checked_with_all_hooks(
    path: &Path,
    expected: &fs::File,
    before_move: impl FnOnce() -> Result<()>,
    after_move: impl FnOnce(&Path) -> Result<()>,
    before_unlink: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let current =
        open_regular_read(path).map_err(|_| anyhow!("undo_snapshot_changed_before_unlink"))?;
    reject_undo_hardlinked_handle(&current)?;
    if !undo_snapshot_identity_matches(expected, &current)? {
        return Err(anyhow!("undo_snapshot_changed_before_unlink"));
    }
    let original_digest = undo_quarantine_digest(&current)?;
    drop(current);
    before_move()?;

    // This unknown .hold name is deliberately NOT eligible for automatic
    // retention pruning. If an attacker occupies the original leaf before
    // recovery, preserve the quarantined file rather than deleting evidence.
    let quarantine = path.with_file_name(format!(".undo-quarantine-{}.hold", Uuid::new_v4()));
    reject_windows_undo_reparse_ancestors(path)?;
    reject_windows_undo_reparse_ancestors(&quarantine)?;
    rename_noreplace(path, &quarantine)?;
    let result = (|| -> Result<()> {
        after_move(&quarantine)?;
        #[cfg(all(unix, feature = "ci-race-fixtures", debug_assertions))]
        pause_for_mcp_undo_quarantine_fixture(path)?;
        reject_windows_undo_reparse_ancestors(&quarantine)?;
        let moved = open_regular_read(&quarantine)
            .map_err(|_| anyhow!("undo_snapshot_changed_before_unlink"))?;
        reject_undo_hardlinked_handle(&moved)?;
        if !undo_snapshot_identity_matches(expected, &moved)?
            || undo_quarantine_digest(&moved)? != original_digest
        {
            return Err(anyhow!("undo_snapshot_changed_before_unlink"));
        }
        // The first digest reads through a pinned handle. A hostile writer
        // could replace the .hold pathname while that digest is in progress;
        // deleting by pathname would then target a different inode. Re-open
        // and recheck identity, link count and bounded content before unlink.
        before_unlink(&quarantine)?;
        #[cfg(all(unix, feature = "ci-race-fixtures", debug_assertions))]
        pause_for_mcp_undo_postdigest_fixture(path)?;
        let final_leaf = open_regular_read(&quarantine)
            .map_err(|_| anyhow!("undo_snapshot_changed_before_unlink"))?;
        reject_undo_hardlinked_handle(&final_leaf)?;
        if !undo_snapshot_identity_matches(expected, &final_leaf)?
            || undo_quarantine_digest(&final_leaf)? != original_digest
        {
            return Err(anyhow!("undo_snapshot_changed_before_unlink"));
        }
        unlink_undo_snapshot(&quarantine, &final_leaf, &original_digest)
    })();
    if result.is_err() {
        // A failed post-move check must not restore a different file that
        // replaced the quarantine leaf. Keep untrusted .hold entries for
        // explicit inspection instead of moving them to a valid .undo name.
        // This is fail-closed recovery, not an atomic compare-and-rename
        // against an adversary swapping the leaf after this last check.
        if reject_windows_undo_reparse_ancestors(&quarantine).is_ok() {
            if let Ok(held) = open_regular_read(&quarantine) {
                if reject_undo_hardlinked_handle(&held).is_ok()
                    && undo_snapshot_identity_matches(expected, &held).unwrap_or(false)
                    && undo_quarantine_digest(&held).is_ok_and(|digest| digest == original_digest)
                {
                    let _ = rename_noreplace(&quarantine, path);
                }
            }
        }
    }
    result
}

// Re-open immediately before retention unlink: a path can be replaced after
// the quota scan. This is fail-closed identity/age validation, not atomic
// unlink-by-handle; hostile concurrent renames remain a known limitation.
fn prune_expired_undo_entry(
    path: &Path,
    observed: &fs::Metadata,
    observed_handle: &fs::File,
    retention: Duration,
) -> Result<Option<fs::Metadata>> {
    reject_windows_undo_reparse_ancestors(path)?;
    let current = checked_undo_storage_metadata(path, observed, observed_handle)?;
    let expired = current
        .modified()
        .ok()
        .and_then(|modified| std::time::SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age >= retention);
    if !expired {
        return Ok(Some(current));
    }
    remove_undo_snapshot_checked(path, observed_handle)?;
    Ok(None)
}

fn undo_storage_usage(dir: &Path) -> Result<(usize, u64)> {
    reject_windows_undo_reparse_ancestors(dir)?;
    let mut count = 0_usize;
    let mut total_bytes = 0_u64;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        reject_windows_undo_reparse_ancestors(&entry.path())?;
        let observed = fs::symlink_metadata(entry.path())?;
        if !observed.is_file() || observed.file_type().is_symlink() {
            return Err(anyhow!("unsafe_undo_storage_entry"));
        }
        // Capture the first opened identity before the quota reader opens
        // the path again; Windows cannot compare Unix dev/ino metadata.
        let observed_handle =
            open_regular_read(&entry.path()).map_err(|_| anyhow!("unsafe_undo_storage_entry"))?;
        reject_undo_hardlinked_handle(&observed_handle)?;
        // The quota reader's handle supplies size and retention age.
        let metadata = checked_undo_storage_metadata(&entry.path(), &observed, &observed_handle)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        // The persistent coordination inode is not an undo snapshot and must
        // not consume a version slot or be deleted by retention pruning.
        if name == ".undo.lock" {
            continue;
        }
        let retention = if undo_snapshot_name(&name) {
            Some(UNDO_RETENTION)
        } else if undo_temporary_name(&name) {
            Some(UNDO_TEMP_RETENTION)
        } else {
            None
        };
        let expired = retention.is_some_and(|retention| {
            metadata
                .modified()
                .ok()
                .and_then(|modified| std::time::SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age >= retention)
        });
        let metadata = if expired {
            // The first scan is only a candidate: check identity and age again
            // before unlink, and use refreshed metadata if the file was renewed.
            match prune_expired_undo_entry(
                &entry.path(),
                &observed,
                &observed_handle,
                retention.ok_or_else(|| anyhow!("invalid_undo_retention"))?,
            )? {
                Some(current) => current,
                None => continue,
            }
        } else {
            metadata
        };
        count += 1;
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| anyhow!("undo_snapshot_quota_exceeded"))?;
    }
    Ok((count, total_bytes))
}

#[cfg(test)]
mod undo_scan_handle_tests {
    use super::*;

    #[test]
    fn undo_read_rejects_same_content_leaf_replacement() {
        let root = std::env::temp_dir().join(format!("wc-undo-read-swap-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let snapshot = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let original = root.join("original");
        fs::write(&snapshot, b"snapshot-data").unwrap();
        let pinned = open_regular_read(&snapshot).unwrap();
        let read_bytes = fs::read(&snapshot).unwrap();
        fs::rename(&snapshot, &original).unwrap();
        fs::write(&snapshot, b"snapshot-data").unwrap();
        let error = verify_undo_snapshot_read(&snapshot, &pinned, &read_bytes).unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_during_read"));
        assert_eq!(fs::read(&snapshot).unwrap(), b"snapshot-data");
        assert_eq!(fs::read(&original).unwrap(), b"snapshot-data");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_read_rejects_same_inode_content_tampering() {
        let root = std::env::temp_dir().join(format!("wc-undo-read-tamper-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let snapshot = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        fs::write(&snapshot, b"snapshot-data").unwrap();
        let pinned = open_regular_read(&snapshot).unwrap();
        let read_bytes = fs::read(&snapshot).unwrap();
        fs::write(&snapshot, b"tampered-data").unwrap();
        let error = verify_undo_snapshot_read(&snapshot, &pinned, &read_bytes).unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_during_read"));
        assert_eq!(fs::read(&snapshot).unwrap(), b"tampered-data");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_read_accepts_unchanged_snapshot() {
        let root = std::env::temp_dir().join(format!("wc-undo-read-ok-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let snapshot = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        fs::write(&snapshot, b"snapshot-data").unwrap();
        let pinned = open_regular_read(&snapshot).unwrap();
        let read_bytes = fs::read(&snapshot).unwrap();
        verify_undo_snapshot_read(&snapshot, &pinned, &read_bytes).unwrap();
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_rejects_same_content_replacement() {
        let root = std::env::temp_dir().join(format!("wc-undo-consume-aba-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let preserved = root.join("preserved");
        fs::write(&entry, b"same-bytes").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        fs::rename(&entry, &preserved).unwrap();
        fs::write(&entry, b"same-bytes").unwrap();
        let error = remove_undo_snapshot_checked(&entry, &pinned).unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        assert_eq!(fs::read(&entry).unwrap(), b"same-bytes");
        assert_eq!(fs::read(&preserved).unwrap(), b"same-bytes");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_quarantine_rejects_final_leaf_swap() {
        let root = std::env::temp_dir().join(format!("wc-undo-quarantine-aba-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let original = root.join("original");
        fs::write(&entry, b"same-bytes").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let error = remove_undo_snapshot_checked_with_hook(&entry, &pinned, || {
            fs::rename(&entry, &original)?;
            fs::write(&entry, b"same-bytes")?;
            Ok(())
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        // The replacement is untrusted: preserve it under .hold rather
        // than restoring it to a valid snapshot filename.
        assert!(!entry.exists());
        assert_eq!(fs::read(&original).unwrap(), b"same-bytes");
        let holds: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|item| item.ok())
            .filter(|item| {
                item.file_name()
                    .to_string_lossy()
                    .starts_with(".undo-quarantine-")
            })
            .collect();
        assert_eq!(holds.len(), 1);
        assert_eq!(fs::read(holds[0].path()).unwrap(), b"same-bytes");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_quarantine_rejects_late_hardlink() {
        let root = std::env::temp_dir().join(format!("wc-undo-quarantine-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let alias = root.join("alias");
        fs::write(&entry, b"private-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let error = remove_undo_snapshot_checked_with_hook(&entry, &pinned, || {
            fs::hard_link(&entry, &alias)?;
            Ok(())
        })
        .unwrap_err();
        assert!(error.to_string().contains("unsafe_undo_storage_hardlink"));
        assert!(!entry.exists(), "hardlinked hold must not be restored");
        assert_eq!(fs::read(&alias).unwrap(), b"private-snapshot");
        let holds: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|item| item.ok())
            .filter(|item| {
                item.file_name()
                    .to_string_lossy()
                    .starts_with(".undo-quarantine-")
            })
            .collect();
        assert_eq!(holds.len(), 1);
        assert_eq!(fs::read(holds[0].path()).unwrap(), b"private-snapshot");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_quarantine_recovery_refuses_replaced_hold() {
        let root = std::env::temp_dir().join(format!("wc-undo-hold-swap-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let parked = root.join("parked-original");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let error = remove_undo_snapshot_checked_with_hooks(
            &entry,
            &pinned,
            || Ok(()),
            |hold| {
                fs::rename(hold, &parked)?;
                fs::write(hold, b"untrusted-quarantine")?;
                Err(anyhow!("injected_post_move_failure"))
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("injected_post_move_failure"));
        assert!(
            !entry.exists(),
            "untrusted hold must not become a valid undo"
        );
        assert_eq!(fs::read(&parked).unwrap(), b"verified-snapshot");
        let holds: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|item| item.ok())
            .map(|item| item.path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(".undo-quarantine-"))
            })
            .collect();
        assert_eq!(holds.len(), 1);
        assert_eq!(fs::read(&holds[0]).unwrap(), b"untrusted-quarantine");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_quarantine_rejects_inplace_tamper_after_move() {
        let root = std::env::temp_dir().join(format!("wc-undo-hold-inplace-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let error = remove_undo_snapshot_checked_with_hooks(
            &entry,
            &pinned,
            || Ok(()),
            |hold| {
                fs::write(hold, b"modified-snapshot")?;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        assert!(!entry.exists(), "tampered hold must not be restored");
        let holds: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|item| item.ok())
            .filter(|item| {
                item.file_name()
                    .to_string_lossy()
                    .starts_with(".undo-quarantine-")
            })
            .collect();
        assert_eq!(holds.len(), 1);
        assert_eq!(fs::read(holds[0].path()).unwrap(), b"modified-snapshot");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_quarantine_recovery_rejects_inplace_tamper() {
        let root = std::env::temp_dir().join(format!("wc-undo-hold-recovery-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let error = remove_undo_snapshot_checked_with_hooks(
            &entry,
            &pinned,
            || Ok(()),
            |hold| {
                fs::write(hold, b"modified-snapshot")?;
                Err(anyhow!("injected_post_move_failure"))
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("injected_post_move_failure"));
        assert!(!entry.exists(), "tampered hold must not be restored");
        let holds: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|item| item.ok())
            .filter(|item| {
                item.file_name()
                    .to_string_lossy()
                    .starts_with(".undo-quarantine-")
            })
            .collect();
        assert_eq!(holds.len(), 1);
        assert_eq!(fs::read(holds[0].path()).unwrap(), b"modified-snapshot");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_quarantine_rejects_leaf_swap_after_digest() {
        let root = std::env::temp_dir().join(format!("wc-undo-postdigest-swap-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let parked = root.join("parked-original");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let error = remove_undo_snapshot_checked_with_all_hooks(
            &entry,
            &pinned,
            || Ok(()),
            |_| Ok(()),
            |hold| {
                fs::rename(hold, &parked)?;
                fs::write(hold, b"untrusted-snapshot")?;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        assert!(!entry.exists(), "untrusted hold must not be restored");
        assert_eq!(fs::read(&parked).unwrap(), b"verified-snapshot");
        let holds: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|item| item.ok())
            .filter(|item| {
                item.file_name()
                    .to_string_lossy()
                    .starts_with(".undo-quarantine-")
            })
            .collect();
        assert_eq!(holds.len(), 1);
        assert_eq!(fs::read(holds[0].path()).unwrap(), b"untrusted-snapshot");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_quarantine_rejects_hardlink_after_digest() {
        let root = std::env::temp_dir().join(format!("wc-undo-postdigest-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let alias = root.join("external-alias");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let error = remove_undo_snapshot_checked_with_all_hooks(
            &entry,
            &pinned,
            || Ok(()),
            |_| Ok(()),
            |hold| {
                fs::hard_link(hold, &alias)?;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("unsafe_undo_storage_hardlink"));
        assert!(!entry.exists(), "shared hold must not be restored");
        assert_eq!(fs::read(&alias).unwrap(), b"verified-snapshot");
        let holds: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|item| item.ok())
            .filter(|item| {
                item.file_name()
                    .to_string_lossy()
                    .starts_with(".undo-quarantine-")
            })
            .collect();
        assert_eq!(holds.len(), 1);
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_quarantine_recovery_restores_verified_hold() {
        let root = std::env::temp_dir().join(format!("wc-undo-hold-recover-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let error = remove_undo_snapshot_checked_with_hooks(
            &entry,
            &pinned,
            || Ok(()),
            |_| Err(anyhow!("injected_post_move_failure")),
        )
        .unwrap_err();
        assert!(error.to_string().contains("injected_post_move_failure"));
        assert_eq!(fs::read(&entry).unwrap(), b"verified-snapshot");
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(|item| item.ok())
                .filter(|item| item
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".undo-quarantine-"))
                .count(),
            0
        );
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_consumption_removes_unchanged_snapshot() {
        let root = std::env::temp_dir().join(format!("wc-undo-consume-ok-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        fs::write(&entry, b"private-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        remove_undo_snapshot_checked(&entry, &pinned).unwrap();
        assert!(!entry.exists());
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_rejects_late_leaf_swap() {
        let root = std::env::temp_dir().join(format!("wc-undo-handle-swap-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("verified.hold");
        let parked = root.join("parked.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        let error = unlink_undo_snapshot_windows_with_hook(&entry, &pinned, &digest, || {
            fs::rename(&entry, &parked)?;
            fs::write(&entry, b"untrusted-replacement")?;
            Ok(())
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        assert_eq!(fs::read(&entry).unwrap(), b"untrusted-replacement");
        assert_eq!(fs::read(&parked).unwrap(), b"verified-snapshot");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_deletes_verified_leaf() {
        let root = std::env::temp_dir().join(format!("wc-undo-handle-delete-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("verified.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        unlink_undo_snapshot(&entry, &pinned, &digest).unwrap();
        drop(pinned);
        assert!(!entry.exists(), "the verified leaf must be unlinked");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_rejects_junction_parent() {
        use std::process::Command;

        let root = std::env::temp_dir().join(format!("wc-undo-handle-junction-{}", Uuid::new_v4()));
        let outside = root.join("outside");
        let alias = root.join("alias");
        fs::create_dir_all(&outside).unwrap();
        let entry = outside.join("verified.hold");
        fs::write(&entry, b"outside-private").unwrap();
        let output = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&alias)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        assert!(unlink_undo_snapshot(&alias.join("verified.hold"), &pinned, &digest).is_err());
        assert_eq!(fs::read(&entry).unwrap(), b"outside-private");
        drop(pinned);
        fs::remove_dir(&alias).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_rejects_hardlinked_leaf() {
        let root = std::env::temp_dir().join(format!("wc-undo-handle-hardlink-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let entry = root.join("verified.hold");
        let alias = root.join("other.hold");
        fs::write(&entry, b"shared-private").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        fs::hard_link(&entry, &alias).unwrap();
        assert!(unlink_undo_snapshot(&entry, &pinned, &digest).is_err());
        assert_eq!(fs::read(&entry).unwrap(), b"shared-private");
        assert_eq!(fs::read(&alias).unwrap(), b"shared-private");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_rejects_inplace_tamper_after_first_digest() {
        let root = std::env::temp_dir().join(format!("wc-undo-handle-tamper-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("verified.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        let error = unlink_undo_snapshot_windows_with_hook(&entry, &pinned, &digest, || {
            fs::write(&entry, b"untrusted-tamper")?;
            Ok(())
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        assert_eq!(fs::read(&entry).unwrap(), b"untrusted-tamper");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_rejects_late_hardlink_after_first_digest() {
        let root =
            std::env::temp_dir().join(format!("wc-undo-handle-late-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("verified.hold");
        let alias = root.join("alias.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        let error = unlink_undo_snapshot_windows_with_hook(&entry, &pinned, &digest, || {
            fs::hard_link(&entry, &alias)?;
            Ok(())
        })
        .unwrap_err();
        assert!(error.to_string().contains("unsafe_undo_storage_hardlink"));
        assert_eq!(fs::read(&entry).unwrap(), b"verified-snapshot");
        assert_eq!(fs::read(&alias).unwrap(), b"verified-snapshot");
        fs::remove_file(&alias).unwrap();
        unlink_undo_snapshot(&entry, &pinned, &digest).unwrap();
        assert!(
            !entry.exists(),
            "safe retry must consume only the verified leaf"
        );
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    // A hardlink created after the final named-leaf digest must not allow
    // disposition of an inode that has gained an external alias.
    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_rejects_hardlink_after_final_digest() {
        let root = std::env::temp_dir().join(format!("wc-undo-final-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("verified.hold");
        let alias = root.join("external-alias.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        let error = unlink_undo_snapshot_windows_with_hooks(
            &entry,
            &pinned,
            &digest,
            || Ok(()),
            || {
                fs::hard_link(&entry, &alias)?;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("unsafe_undo_storage_hardlink"));
        assert_eq!(fs::read(&entry).unwrap(), b"verified-snapshot");
        assert_eq!(fs::read(&alias).unwrap(), b"verified-snapshot");
        fs::remove_file(&alias).unwrap();
        unlink_undo_snapshot(&entry, &pinned, &digest).unwrap();
        assert!(!entry.exists(), "retry must consume only the verified leaf");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    // An in-place writer may change the inode after the named-leaf digest.
    // Rechecking the DELETE-capable handle must reject its changed bytes.
    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_rejects_tamper_after_final_digest() {
        let root = std::env::temp_dir().join(format!("wc-undo-final-tamper-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("verified.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        let error = unlink_undo_snapshot_windows_with_hooks(
            &entry,
            &pinned,
            &digest,
            || Ok(()),
            || {
                fs::write(&entry, b"untrusted-tamper")?;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        assert_eq!(fs::read(&entry).unwrap(), b"untrusted-tamper");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    // A same-byte replacement after the DELETE-capable handle is opened
    // must not be mistaken for the original inode merely because SHA matches.
    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_rejects_late_same_byte_inode_swap() {
        let root = std::env::temp_dir().join(format!("wc-undo-late-aba-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("verified.hold");
        let parked = root.join("parked.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        let error = unlink_undo_snapshot_windows_with_hook(&entry, &pinned, &digest, || {
            fs::rename(&entry, &parked)?;
            fs::write(&entry, b"verified-snapshot")?;
            Ok(())
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        assert_eq!(fs::read(&entry).unwrap(), b"verified-snapshot");
        assert_eq!(fs::read(&parked).unwrap(), b"verified-snapshot");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    // A Windows DELETE-capable open handle may prevent renaming its parent
    // (ERROR_ACCESS_DENIED). If the OS permits the rename, inject a junction
    // and require the reparse guard to reject the redirected outside leaf.
    // Both outcomes must preserve the outside bytes; neither is an MCP E2E.
    #[cfg(windows)]
    #[test]
    fn windows_undo_handle_unlink_preserves_outside_when_late_junction_swap_attempted() {
        use std::process::Command;

        let root = std::env::temp_dir().join(format!("wc-undo-late-junction-{}", Uuid::new_v4()));
        let live = root.join("live");
        let parked = root.join("parked");
        let outside = root.join("outside");
        fs::create_dir_all(&live).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let entry = live.join("verified.hold");
        let outside_entry = outside.join("verified.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        fs::write(&outside_entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        let mut swapped = false;
        let error = unlink_undo_snapshot_windows_with_hook(&entry, &pinned, &digest, || {
            match fs::rename(&live, &parked) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    return Err(anyhow!("windows_ancestor_rename_denied: {error}"));
                }
                Err(error) => return Err(error.into()),
            }
            let output = Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(&live)
                .arg(&outside)
                .output()?;
            if !output.status.success() {
                return Err(anyhow!(
                    "junction_fixture_failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            swapped = true;
            Ok(())
        })
        .unwrap_err();
        if swapped {
            assert!(
                error.to_string().contains("unsafe_undo_reparse_ancestor"),
                "late junction must be rejected by ancestor guard: {error}"
            );
            assert_eq!(
                fs::read(parked.join("verified.hold")).unwrap(),
                b"verified-snapshot"
            );
            fs::remove_dir(&live).unwrap();
            fs::rename(&parked, &live).unwrap();
        } else {
            assert!(
                error.to_string().contains("windows_ancestor_rename_denied"),
                "Windows must block the ancestor swap: {error}"
            );
            assert_eq!(fs::read(&entry).unwrap(), b"verified-snapshot");
        }
        assert_eq!(fs::read(&outside_entry).unwrap(), b"verified-snapshot");
        unlink_undo_snapshot(&entry, &pinned, &digest).unwrap();
        assert!(!entry.exists(), "safe retry must delete only original leaf");
        assert_eq!(fs::read(&outside_entry).unwrap(), b"verified-snapshot");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_undo_unlink_rejects_late_leaf_swap_at_pinned_parent() {
        let root = std::env::temp_dir().join(format!("wc-undo-final-leaf-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("verified.hold");
        let parked = root.join("parked.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        let error = unlink_undo_snapshot_unix_with_hook(&entry, &pinned, &digest, || {
            fs::rename(&entry, &parked)?;
            fs::write(&entry, b"untrusted-replacement")?;
            Ok(())
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        assert_eq!(fs::read(&entry).unwrap(), b"untrusted-replacement");
        assert_eq!(fs::read(&parked).unwrap(), b"verified-snapshot");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_undo_unlink_rejects_late_inplace_tamper_at_pinned_parent() {
        let root = std::env::temp_dir().join(format!("wc-undo-final-tamper-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("verified.hold");
        fs::write(&entry, b"verified-snapshot").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let digest = undo_quarantine_digest(&pinned).unwrap();
        let error = unlink_undo_snapshot_unix_with_hook(&entry, &pinned, &digest, || {
            fs::write(&entry, b"tampered-snapshot")?;
            Ok(())
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_before_unlink"));
        assert_eq!(fs::read(&entry).unwrap(), b"tampered-snapshot");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn undo_unlink_rejects_symlinked_parent_without_touching_outside_file() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("wc-undo-unlink-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        let name = format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4());
        fs::write(outside.join(&name), b"outside-private").unwrap();
        symlink(&outside, root.join("swapped-parent")).unwrap();
        let verified = open_regular_read(&outside.join(&name)).unwrap();
        let digest = undo_quarantine_digest(&verified).unwrap();
        assert!(
            unlink_undo_snapshot(&root.join("swapped-parent").join(&name), &verified, &digest)
                .is_err()
        );
        drop(verified);
        assert_eq!(fs::read(outside.join(&name)).unwrap(), b"outside-private");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn quota_rejects_intermediate_aba_even_when_path_metadata_matches() {
        let root = std::env::temp_dir().join(format!("wc-undo-scan-aba-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join("private-snapshot");
        let original = root.join("original");
        let replacement = root.join("replacement");
        fs::write(&entry, b"same-bytes").unwrap();
        let observed = fs::symlink_metadata(&entry).unwrap();
        fs::rename(&entry, &original).unwrap();
        fs::write(&entry, b"same-bytes").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        fs::rename(&entry, &replacement).unwrap();
        fs::rename(&original, &entry).unwrap();
        // The initial path metadata and final reader see A, but the
        // intermediate opened handle sees B. Quota must fail closed.
        let error = checked_undo_storage_metadata(&entry, &observed, &pinned).unwrap_err();
        assert!(error.to_string().contains("undo_storage_entry_changed"));
        assert_eq!(fs::read(&entry).unwrap(), b"same-bytes");
        assert_eq!(fs::read(&replacement).unwrap(), b"same-bytes");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quota_uses_open_handle_size_after_metadata_becomes_stale() {
        let root = std::env::temp_dir().join(format!("wc-undo-scan-size-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let entry = root.join("unrecognized-private-data");
        fs::write(&entry, b"old").unwrap();
        let observed = fs::symlink_metadata(&entry).unwrap();
        fs::write(&entry, b"new-longer-content").unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let current = checked_undo_storage_metadata(&entry, &observed, &pinned).unwrap();
        assert_eq!(current.len(), b"new-longer-content".len() as u64);
        assert_eq!(undo_storage_usage(&root).unwrap(), (1, current.len()));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_quota_rejects_same_content_file_identity_swap() {
        let root = std::env::temp_dir().join(format!("wc-undo-win-aba-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let entry = root.join("private-snapshot");
        let replacement = root.join("replacement");
        let original = root.join("original");
        fs::write(&entry, b"same-bytes").unwrap();
        fs::write(&replacement, b"same-bytes").unwrap();
        let observed = fs::symlink_metadata(&entry).unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        fs::rename(&entry, &original).unwrap();
        fs::rename(&replacement, &entry).unwrap();
        let error = checked_undo_storage_metadata(&entry, &observed, &pinned).unwrap_err();
        assert!(error.to_string().contains("undo_storage_entry_changed"));
        assert_eq!(fs::read(&entry).unwrap(), b"same-bytes");
        assert_eq!(fs::read(&original).unwrap(), b"same-bytes");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_prune_rejects_same_content_replacement() {
        let root = std::env::temp_dir().join(format!("wc-undo-prune-swap-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        // macOS temp_dir() may traverse /var -> /private/var.
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!(".{}.tmp", Uuid::new_v4()));
        let preserved = root.join("preserved");
        fs::write(&entry, b"same-bytes").unwrap();
        let observed = fs::symlink_metadata(&entry).unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        fs::rename(&entry, &preserved).unwrap();
        fs::write(&entry, b"same-bytes").unwrap();
        let error =
            prune_expired_undo_entry(&entry, &observed, &pinned, Duration::ZERO).unwrap_err();
        assert!(error.to_string().contains("undo_storage_entry_changed"));
        assert_eq!(fs::read(&entry).unwrap(), b"same-bytes");
        assert_eq!(fs::read(&preserved).unwrap(), b"same-bytes");
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_prune_keeps_nonexpired_entry_and_removes_expired_entry() {
        let root = std::env::temp_dir().join(format!("wc-undo-prune-age-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        // macOS temp_dir() may traverse /var -> /private/var.
        let root = fs::canonicalize(root).unwrap();
        let entry = root.join(format!(".{}.tmp", Uuid::new_v4()));
        fs::write(&entry, b"private-staging").unwrap();
        let observed = fs::symlink_metadata(&entry).unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        assert!(prune_expired_undo_entry(
            &entry,
            &observed,
            &pinned,
            Duration::from_secs(24 * 60 * 60),
        )
        .unwrap()
        .is_some());
        assert_eq!(fs::read(&entry).unwrap(), b"private-staging");
        assert!(
            prune_expired_undo_entry(&entry, &observed, &pinned, Duration::ZERO)
                .unwrap()
                .is_none()
        );
        assert!(!entry.exists());
        drop(pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn quota_rejects_same_content_inode_swap_after_metadata_scan() {
        let root = std::env::temp_dir().join(format!("wc-undo-scan-aba-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let entry = root.join("unrecognized-private-data");
        let replacement = root.join("replacement");
        fs::write(&entry, b"same-bytes").unwrap();
        fs::write(&replacement, b"same-bytes").unwrap();
        let observed = fs::symlink_metadata(&entry).unwrap();
        fs::rename(&replacement, &entry).unwrap();
        let pinned = open_regular_read(&entry).unwrap();
        let error = checked_undo_storage_metadata(&entry, &observed, &pinned).unwrap_err();
        assert!(error.to_string().contains("undo_storage_entry_changed"));
        assert_eq!(fs::read(&entry).unwrap(), b"same-bytes");
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod undo_crash_cleanup_tests {
    use super::*;

    #[test]
    fn process_undo_lock_worker() {
        let Ok(root) = std::env::var("WCF_UNDO_LOCK_ROOT") else {
            return;
        };
        let result =
            undo_cross_process_lock_with_timeout(Path::new(&root), Duration::from_millis(120));
        if std::env::var("WCF_UNDO_LOCK_EXPECT_BLOCKED").is_ok() {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("undo_storage_lock_timeout"));
        } else {
            assert!(result.is_ok(), "undo lock did not recover: {result:?}");
        }
    }

    #[test]
    fn undo_quota_lock_is_cross_process_bounded_and_recovers() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("commender-undo-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let held = undo_cross_process_lock(&dir).unwrap();
        let run_worker = |blocked: bool| {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .arg("--exact")
                .arg("fs_ops::undo_crash_cleanup_tests::process_undo_lock_worker")
                .env("WCF_UNDO_LOCK_ROOT", &dir);
            if blocked {
                command.env("WCF_UNDO_LOCK_EXPECT_BLOCKED", "1");
            }
            command.output().unwrap()
        };
        let blocked = run_worker(true);
        assert!(
            blocked.status.success(),
            "cross-process timeout failed: {}",
            String::from_utf8_lossy(&blocked.stderr)
        );
        drop(held);
        let recovered = run_worker(false);
        assert!(
            recovered.status.success(),
            "cross-process lock recovery failed: {}",
            String::from_utf8_lossy(&recovered.stderr)
        );
        assert_eq!(undo_storage_usage(&dir).unwrap(), (0, 0));
        assert!(dir.join(".undo.lock").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn old_orphan_staging_files_are_pruned_but_unknown_and_fresh_files_survive() {
        let dir = std::env::temp_dir().join(format!("commender-undo-crash-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let stale = dir.join(format!(".{}.tmp", Uuid::new_v4()));
        let fresh = dir.join(format!(".{}.tmp", Uuid::new_v4()));
        let unknown = dir.join("unrelated-user-data");
        let malformed = dir.join(".not-a-uuid.tmp");
        for path in [&stale, &fresh, &unknown, &malformed] {
            fs::write(path, b"safe").unwrap();
        }
        let old = std::time::SystemTime::now()
            .checked_sub(UNDO_TEMP_RETENTION + Duration::from_secs(3600))
            .unwrap();
        for path in [&stale, &unknown, &malformed] {
            fs::File::open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(old))
                .unwrap();
        }
        let (count, bytes) = undo_storage_usage(&dir).unwrap();
        assert!(!stale.exists(), "orphaned staging file must be reclaimed");
        assert!(fresh.exists(), "recent staging file must not be touched");
        assert!(unknown.exists(), "unknown file must not be pruned");
        assert!(
            malformed.exists(),
            "invalid staging name must not be pruned"
        );
        assert_eq!((count, bytes), (3, 12));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_undo_junction_parent_cannot_redirect_lock_creation() {
        use std::process::Command;
        let root = std::env::temp_dir().join(format!("wc-undo-junction-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("wc-undo-outside-{}", Uuid::new_v4()));
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
        assert!(undo_cross_process_lock(&junction).is_err());
        assert!(!outside.join(".undo.lock").exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_undo_junction_swap_cannot_prune_external_snapshot() {
        use std::process::Command;
        let root = std::env::temp_dir().join(format!("wc-undo-swap-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("wc-undo-target-{}", Uuid::new_v4()));
        let undo = root.join("file-versions");
        fs::create_dir_all(&undo).unwrap();
        fs::create_dir_all(&outside).unwrap();
        drop(undo_cross_process_lock(&undo).unwrap());
        fs::remove_file(undo.join(".undo.lock")).unwrap();
        fs::remove_dir(&undo).unwrap();
        let staged = outside.join(format!(".{}.tmp", Uuid::new_v4()));
        fs::write(&staged, b"outside-private").unwrap();
        let old = std::time::SystemTime::now()
            .checked_sub(UNDO_TEMP_RETENTION + Duration::from_secs(3600))
            .unwrap();
        // Windows requires FILE_WRITE_ATTRIBUTES to change timestamps. A
        // read-only File::open handle makes this fixture fail with OS error 5
        // before the junction protection under test is exercised.
        fs::OpenOptions::new()
            .write(true)
            .open(&staged)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();
        let output = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&undo)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(undo_cross_process_lock(&undo).is_err());
        assert!(undo_storage_usage(&undo).is_err());
        assert_eq!(fs::read(&staged).unwrap(), b"outside-private");
        assert!(!outside.join(".undo.lock").exists());
        fs::remove_dir(&undo).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[cfg(any(unix, windows))]
    #[test]
    fn undo_hardlink_snapshot_fails_closed_before_pruning_or_reading() {
        let dir = std::env::temp_dir().join(format!("commender-undo-hardlink-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let outside = dir.with_extension("outside");
        fs::write(&outside, b"outside-private").unwrap();
        let alias = dir.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        fs::hard_link(&outside, &alias).unwrap();
        let error = undo_storage_usage(&dir).unwrap_err();
        assert!(error.to_string().contains("unsafe_undo_storage_hardlink"));
        assert_eq!(fs::read(&outside).unwrap(), b"outside-private");
        fs::remove_file(&alias).unwrap();
        assert_eq!(undo_storage_usage(&dir).unwrap(), (0, 0));
        fs::remove_dir_all(dir).unwrap();
        fs::remove_file(outside).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_undo_hardlink_lock_rejected_without_touching_external_file() {
        let dir = std::env::temp_dir().join(format!("wc-undo-lock-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let outside = dir.with_extension("outside");
        fs::write(&outside, b"external-lock-content").unwrap();
        let alias = dir.join(".undo.lock");
        fs::hard_link(&outside, &alias).unwrap();
        let error = undo_cross_process_lock(&dir).unwrap_err();
        assert!(error.to_string().contains("unsafe_undo_storage_hardlink"));
        assert_eq!(fs::read(&outside).unwrap(), b"external-lock-content");
        fs::remove_file(&alias).unwrap();
        drop(undo_cross_process_lock(&dir).unwrap());
        fs::remove_dir_all(dir).unwrap();
        fs::remove_file(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_in_staging_directory_fails_closed_without_following_target() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("commender-undo-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let outside = dir.with_extension("outside");
        fs::write(&outside, b"private").unwrap();
        symlink(&outside, dir.join(format!(".{}.tmp", Uuid::new_v4()))).unwrap();
        assert!(undo_storage_usage(&dir).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"private");
        fs::remove_dir_all(dir).unwrap();
        fs::remove_file(outside).unwrap();
    }
}

fn ensure_undo_capacity(
    dir: &Path,
    path: &Path,
    incoming: u64,
    max_total: u64,
    scope: Option<&str>,
) -> Result<()> {
    let (count, used_bytes) = undo_storage_usage(dir)?;
    if undo_entries(path, dir, scope)?.len() >= MAX_UNDO_PER_FILE
        || count >= MAX_UNDO_PER_DIRECTORY
        || used_bytes
            .checked_add(incoming)
            .is_none_or(|bytes| bytes > max_total)
    {
        return Err(anyhow!("undo_snapshot_quota_exceeded"));
    }
    Ok(())
}

pub fn undo_scope_fingerprint(
    organization_id: &str,
    actor: &str,
    device_id: &str,
) -> Result<String> {
    let parts = [organization_id, actor, device_id];
    if parts
        .iter()
        .any(|part| part.is_empty() || part.len() > 256 || part.contains('\0'))
    {
        return Err(anyhow!("invalid_undo_scope"));
    }
    let mut digest = Sha256::new();
    for part in ["wecommander-undo-v2", organization_id, actor, device_id] {
        digest.update((part.len() as u32).to_be_bytes());
        digest.update(part.as_bytes());
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn undo_prefix(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()))
}

fn undo_dir(_path: &Path, create: bool) -> Result<Option<std::path::PathBuf>> {
    // Never place plaintext undo snapshots beside source files: allowlisted
    // workspaces may also be publicly served web roots.
    let data_root =
        dirs::data_local_dir().ok_or_else(|| anyhow!("local data directory unavailable"))?;
    reject_windows_undo_reparse_ancestors(&data_root)?;
    if create {
        fs::create_dir_all(&data_root)?;
    }
    let app_root = data_root.join("webrising-commender");
    reject_windows_undo_reparse_ancestors(&app_root)?;
    if create {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        if let Err(error) = builder.create(&app_root) {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(error.into());
            }
        }
    }
    let app_meta = match fs::symlink_metadata(&app_root) {
        Ok(meta) => meta,
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !app_meta.is_dir() || app_meta.file_type().is_symlink() {
        return Err(anyhow!("unsafe_undo_app_directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if create {
            fs::set_permissions(&app_root, fs::Permissions::from_mode(0o700))?;
        } else if app_meta.permissions().mode() & 0o077 != 0 {
            return Err(anyhow!("unsafe_undo_app_permissions"));
        }
    }
    let dir = app_root.join("file-versions");
    reject_windows_undo_reparse_ancestors(&dir)?;
    if create {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        if let Err(error) = builder.create(&dir) {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(error.into());
            }
        }
    }
    let meta = match fs::symlink_metadata(&dir) {
        Ok(meta) => meta,
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(anyhow!("unsafe_undo_directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(anyhow!("unsafe_undo_directory_permissions"));
        }
    }
    reject_windows_undo_reparse_ancestors(&dir)?;
    Ok(Some(dir))
}

// Quota scanning and opening a snapshot are separate filesystem operations.
// Recheck the opened inode: an external process can replace a safe directory
// entry with a hardlink between those operations.
fn reject_undo_hardlinked_handle(file: &fs::File) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata()?.nlink() != 1 {
            return Err(anyhow!("unsafe_undo_storage_hardlink"));
        }
    }
    #[cfg(windows)]
    reject_windows_hardlinked_file(file)?;
    Ok(())
}

// A snapshot's path may be swapped after its handle was opened, or its
// contents changed in-place while a bounded read was in progress. Before
// advertising or restoring it, bind the exact bytes read to the still-named
// regular file and its pinned identity. This narrows read-time races; a
// hostile writer after this final check still requires handle-relative CAS.
fn verify_undo_snapshot_read(path: &Path, pinned: &fs::File, bytes: &[u8]) -> Result<()> {
    let current =
        open_regular_read(path).map_err(|_| anyhow!("undo_snapshot_changed_during_read"))?;
    reject_undo_hardlinked_handle(&current)
        .map_err(|_| anyhow!("undo_snapshot_changed_during_read"))?;
    if !undo_snapshot_identity_matches(pinned, &current)?
        || !atomic_staged_bytes_match(&current, bytes)?
    {
        return Err(anyhow!("undo_snapshot_changed_during_read"));
    }
    Ok(())
}

fn undo_entries(path: &Path, dir: &Path, scope: Option<&str>) -> Result<Vec<(String, u64)>> {
    reject_windows_undo_reparse_ancestors(dir)?;
    let prefix = format!("{}-", undo_prefix(path));
    let mut result = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name
            .strip_prefix(&prefix)
            .and_then(|v| v.strip_suffix(".undo"))
        else {
            continue;
        };
        if Uuid::parse_str(id).is_err() {
            continue;
        }
        let meta = fs::symlink_metadata(entry.path())?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(anyhow!("unsafe_undo_snapshot"));
        }
        // Legacy v1 snapshots have no owner; authenticated requests cannot
        // list them. v2 snapshots are bound to org/actor/enrolled device.
        let mut payload = Vec::new();
        let mut reader = open_regular_read(&entry.path())?;
        reject_undo_hardlinked_handle(&reader)?;
        // Report the size of the inode we actually validated and read, not
        // the possibly stale path metadata from before opening the file.
        let snapshot_bytes = reader.metadata()?.len();
        std::io::Read::by_ref(&mut reader)
            .take(MAX_UNDO_FILE_BYTES + 1)
            .read_to_end(&mut payload)?;
        if payload.len() as u64 > MAX_UNDO_FILE_BYTES {
            return Err(anyhow!("undo_snapshot_too_large"));
        }
        verify_undo_snapshot_read(&entry.path(), &reader, &payload)?;
        let record: Value = serde_json::from_slice(&payload).context("invalid_undo_snapshot")?;
        let version = if scope.is_some() { 2 } else { 1 };
        if record["version"] != version || record["ownerScope"].as_str() != scope {
            continue;
        }
        // A parseable snapshot with a forged previous digest must never be
        // advertised as restorable. Verify the bounded payload at listing
        // time as well as immediately before the actual rollback.
        if record["path"].as_str() != Some(path.to_string_lossy().as_ref()) {
            return Err(anyhow!("undo_snapshot_path_mismatch"));
        }
        let previous = STANDARD.decode(
            record["contentBase64"]
                .as_str()
                .ok_or_else(|| anyhow!("invalid_undo_snapshot"))?,
        )?;
        if previous.len() > HARD_READ_MAX
            || record["previousSha256"].as_str()
                != Some(format!("{:x}", Sha256::digest(&previous)).as_str())
        {
            return Err(anyhow!("undo_snapshot_checksum_mismatch"));
        }
        result.push((id.to_owned(), snapshot_bytes));
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}

// Verify the actual staged inode and payload on both sides of publication.
// The UUID staging pathname is not trusted: a local writer can replace its
// leaf or alter the same inode while the Agent still holds its original handle.
// This narrows the staging race, but is not a kernel-level compare-and-rename
// against a hostile writer acting after the final check.
fn publish_undo_snapshot_checked(
    temporary: &Path,
    destination: &Path,
    dir: &Path,
    staged: &fs::File,
    payload: &[u8],
) -> Result<()> {
    let candidate = open_regular_read(temporary)
        .map_err(|_| anyhow!("undo_snapshot_changed_during_publication"))?;
    reject_undo_hardlinked_handle(&candidate)?;
    if !undo_snapshot_identity_matches(staged, &candidate)?
        || !atomic_staged_bytes_match(&candidate, payload)?
    {
        return Err(anyhow!("undo_snapshot_changed_during_publication"));
    }
    drop(candidate);
    publish_undo_snapshot(temporary, destination, dir)?;
    let published = open_regular_read(destination)
        .map_err(|_| anyhow!("undo_snapshot_changed_during_publication"))?;
    reject_undo_hardlinked_handle(&published)?;
    if !undo_snapshot_identity_matches(staged, &published)?
        || !atomic_staged_bytes_match(&published, payload)?
    {
        return Err(anyhow!("undo_snapshot_changed_during_publication"));
    }
    Ok(())
}

// Publishing a snapshot must never replace a pre-existing destination,
// even if an external process races the UUID-named file into place. A failed
// publication must not delete that other file during cleanup.
fn publish_undo_snapshot(temporary: &Path, destination: &Path, dir: &Path) -> Result<()> {
    // MoveFileW uses pathnames rather than pinned directory handles. Reject
    // static junction/reparse ancestors at the final publication boundary,
    // not only when the private undo directory was first resolved. This
    // narrows the Windows swap window; hostile concurrent swaps still need
    // handle-relative publication for full isolation.
    #[cfg(windows)]
    {
        reject_windows_undo_reparse_ancestors(temporary)?;
        reject_windows_undo_reparse_ancestors(destination)?;
        reject_windows_undo_reparse_ancestors(dir)?;
    }
    rename_noreplace(temporary, destination)?;
    // The snapshot is now visible. A directory sync failure must not turn
    // a successful publication into an error that could discard its undo ID.
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(dir) {
        let _ = directory.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn save_undo_snapshot(
    path: &Path,
    previous: &[u8],
    previous_sha: &str,
    next_sha: &str,
    undo_scope: Option<&str>,
) -> Result<(String, std::path::PathBuf, fs::File)> {
    let _directory_guard = undo_directory_lock()?;
    let dir = undo_dir(path, true)?.ok_or_else(|| anyhow!("undo_directory_unavailable"))?;
    let _filesystem_guard = undo_cross_process_lock(&dir)?;
    let id = Uuid::new_v4().to_string();
    let filename = format!("{}-{}.undo", undo_prefix(path), id);
    let destination = dir.join(filename);
    let temporary = dir.join(format!(".{}.tmp", Uuid::new_v4()));
    let payload = serde_json::to_vec(&json!({
        "version": if undo_scope.is_some() { 2 } else { 1 },
        "ownerScope": undo_scope,
        "path": path.to_string_lossy(),
        "previousSha256": previous_sha,
        "nextSha256": next_sha,
        "contentBase64": STANDARD.encode(previous)
    }))?;
    if payload.len() as u64 > MAX_UNDO_FILE_BYTES {
        return Err(anyhow!("undo_snapshot_too_large"));
    }
    ensure_undo_capacity(
        &dir,
        path,
        payload.len() as u64,
        MAX_UNDO_TOTAL_BYTES,
        undo_scope,
    )?;
    // Pin the staging inode before publication. An external process may swap
    // the staging or final pathname; never clean up a different inode.
    let mut staged: Option<fs::File> = None;
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        staged = Some(options.open(&temporary)?);
        let file = staged
            .as_mut()
            .ok_or_else(|| anyhow!("undo_staging_unavailable"))?;
        file.write_all(&payload)?;
        file.sync_all()?;
        publish_undo_snapshot_checked(&temporary, &destination, &dir, file, &payload)?;
        Ok(())
    })();
    if result.is_err() {
        // A failed publication may leave an attacker-controlled entry at
        // either name. Only delete a leaf matching our pinned staging handle.
        if let Some(pinned) = staged.as_ref() {
            let _ = remove_undo_snapshot_checked(&temporary, pinned);
            let _ = remove_undo_snapshot_checked(&destination, pinned);
        }
    }
    result?;
    Ok((
        id,
        destination,
        staged.ok_or_else(|| anyhow!("undo_staging_unavailable"))?,
    ))
}

/// List bounded, disk-persisted undo snapshots for an allowlisted regular file.
#[cfg(test)]
pub fn versions(policy: &PathPolicy, raw: &str) -> Result<Value> {
    versions_impl(policy, raw, None)
}

pub fn versions_scoped(policy: &PathPolicy, raw: &str, undo_scope: &str) -> Result<Value> {
    versions_impl(policy, raw, Some(undo_scope))
}

fn versions_impl(policy: &PathPolicy, raw: &str, undo_scope: Option<&str>) -> Result<Value> {
    let path = policy.resolve_existing(raw)?;
    if !path.is_file() {
        return Err(anyhow!("path is not a file"));
    }
    let lock = mutation_lock(&path)?;
    let _guard = lock
        .lock()
        .map_err(|_| anyhow!("file mutation lock poisoned"))?;
    let _directory_guard = undo_directory_lock()?;
    let entries = match undo_dir(&path, false)? {
        Some(dir) => {
            let _filesystem_guard = undo_cross_process_lock(&dir)?;
            undo_storage_usage(&dir)?;
            undo_entries(&path, &dir, undo_scope)?
        }
        None => Vec::new(),
    };
    Ok(json!({
        "path": path.to_string_lossy(),
        "versions": entries.iter().map(|(id, bytes)| json!({"undoId": id, "snapshotBytes": bytes})).collect::<Vec<_>>(),
        "maxVersions": MAX_UNDO_PER_FILE
    }))
}

/// Undo a guarded text replacement only if the current bytes still match its
/// post-edit digest. Snapshot files are read-only evidence, never executable.
#[cfg(test)]
pub fn undo(policy: &PathPolicy, raw: &str, undo_id: &str, expected_sha256: &str) -> Result<Value> {
    undo_impl(policy, raw, undo_id, expected_sha256, None)
}

pub fn undo_scoped(
    policy: &PathPolicy,
    raw: &str,
    undo_id: &str,
    expected_sha256: &str,
    undo_scope: &str,
) -> Result<Value> {
    undo_impl(policy, raw, undo_id, expected_sha256, Some(undo_scope))
}

fn undo_impl(
    policy: &PathPolicy,
    raw: &str,
    undo_id: &str,
    expected_sha256: &str,
    undo_scope: Option<&str>,
) -> Result<Value> {
    let id = Uuid::parse_str(undo_id).map_err(|_| anyhow!("invalid_undo_id"))?;
    let path = policy.resolve_existing(raw)?;
    if !path.is_file() {
        return Err(anyhow!("path is not a file"));
    }
    let lock = mutation_lock(&path)?;
    let _guard = lock
        .lock()
        .map_err(|_| anyhow!("file mutation lock poisoned"))?;
    let _directory_guard = undo_directory_lock()?;
    let dir = undo_dir(&path, false)?.ok_or_else(|| anyhow!("undo_snapshot_not_found"))?;
    let _filesystem_guard = undo_cross_process_lock(&dir)?;
    undo_storage_usage(&dir)?;
    let snapshot = dir.join(format!("{}-{}.undo", undo_prefix(&path), id));
    let mut reader = open_regular_read(&snapshot)?;
    reject_undo_hardlinked_handle(&reader)?;
    let mut encoded = Vec::new();
    std::io::Read::by_ref(&mut reader)
        .take(MAX_UNDO_FILE_BYTES + 1)
        .read_to_end(&mut encoded)?;
    if encoded.len() as u64 > MAX_UNDO_FILE_BYTES {
        return Err(anyhow!("undo_snapshot_too_large"));
    }
    verify_undo_snapshot_read(&snapshot, &reader, &encoded)?;
    let record: Value = serde_json::from_slice(&encoded).context("invalid_undo_snapshot")?;
    let expected_version = if undo_scope.is_some() { 2 } else { 1 };
    if record["version"] != expected_version || record["ownerScope"].as_str() != undo_scope {
        return Err(anyhow!("undo_snapshot_not_found"));
    }
    if record["path"].as_str() != Some(path.to_string_lossy().as_ref()) {
        return Err(anyhow!("undo_snapshot_path_mismatch"));
    }
    let previous = STANDARD.decode(
        record["contentBase64"]
            .as_str()
            .ok_or_else(|| anyhow!("invalid_undo_snapshot"))?,
    )?;
    if previous.len() > HARD_READ_MAX
        || record["previousSha256"].as_str()
            != Some(format!("{:x}", Sha256::digest(&previous)).as_str())
    {
        return Err(anyhow!("undo_snapshot_checksum_mismatch"));
    }
    let mut current = Vec::new();
    open_regular_read(&path)?
        .take(HARD_READ_MAX as u64 + 1)
        .read_to_end(&mut current)?;
    if current.len() > HARD_READ_MAX {
        return Err(anyhow!("file exceeds edit limit"));
    }
    let current_sha = format!("{:x}", Sha256::digest(&current));
    if !current_sha.eq_ignore_ascii_case(expected_sha256)
        || record["nextSha256"].as_str() != Some(current_sha.as_str())
    {
        return Err(anyhow!("file_changed_since_edit"));
    }
    atomic_write(&path, &previous, Some(&current_sha))?;
    let consumed = remove_undo_snapshot_checked(&snapshot, &reader).is_ok();
    Ok(json!({
        "ok": true, "path": path.to_string_lossy(),
        "sha256": format!("{:x}", Sha256::digest(&previous)),
        "previousSha256": current_sha, "undoConsumed": consumed
    }))
}

#[cfg(test)]
mod undo_publication_tests {
    use super::*;

    #[test]
    fn competing_snapshot_destination_is_not_overwritten() {
        let root = std::env::temp_dir().join(format!("commender-undo-publish-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        // macOS temp_dir() may start with /var, a symlink to /private/var.
        // The no-follow publication deliberately rejects symlink ancestors.
        let root = fs::canonicalize(root).unwrap();
        let temporary = root.join(format!(".{}.tmp", Uuid::new_v4()));
        let destination = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        fs::write(&temporary, b"staged-snapshot").unwrap();
        fs::write(&destination, b"competing-snapshot").unwrap();

        // A collision must not replace or remove the other writer's data.
        assert!(publish_undo_snapshot(&temporary, &destination, &root).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"competing-snapshot");
        assert_eq!(fs::read(&temporary).unwrap(), b"staged-snapshot");

        // Publishing without a collision still atomically moves our staging
        // file into place and leaves no staging file behind.
        fs::remove_file(&destination).unwrap();
        publish_undo_snapshot(&temporary, &destination, &root).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"staged-snapshot");
        assert!(!temporary.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn published_snapshot_preserves_pinned_staging_identity() {
        let root = std::env::temp_dir().join(format!("wc-undo-pinned-publish-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let temporary = root.join(format!(".{}.tmp", Uuid::new_v4()));
        let destination = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let mut staged = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .unwrap();
        staged.write_all(b"private-snapshot").unwrap();
        staged.sync_all().unwrap();
        // Publication must work with the staging handle still open on all OSes.
        publish_undo_snapshot(&temporary, &destination, &root).unwrap();
        let published = open_regular_read(&destination).unwrap();
        assert!(undo_snapshot_identity_matches(&staged, &published).unwrap());
        drop(published);
        remove_undo_snapshot_checked(&destination, &staged).unwrap();
        assert!(!destination.exists());
        drop(staged);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_edit_cleanup_preserves_replaced_published_snapshot() {
        let root = std::env::temp_dir().join(format!("wc-undo-failed-cleanup-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let temporary = root.join(format!(".{}.tmp", Uuid::new_v4()));
        let destination = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let displaced = root.join("original-snapshot");
        let mut staged = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .unwrap();
        staged.write_all(b"our-snapshot").unwrap();
        staged.sync_all().unwrap();
        publish_undo_snapshot(&temporary, &destination, &root).unwrap();
        // Simulate an uncooperative writer replacing the undo leaf before a
        // failed atomic edit attempts cleanup. Never unlink that writer's file.
        fs::rename(&destination, &displaced).unwrap();
        fs::write(&destination, b"external-snapshot").unwrap();
        assert!(remove_undo_snapshot_checked(&destination, &staged).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"external-snapshot");
        assert_eq!(fs::read(&displaced).unwrap(), b"our-snapshot");
        drop(staged);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_staging_leaf_swap_is_rejected_before_publication() {
        let root = std::env::temp_dir().join(format!("wc-undo-stage-swap-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let temporary = root.join(format!(".{}.tmp", Uuid::new_v4()));
        let displaced = root.join("displaced-original");
        let destination = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let payload = b"private-snapshot";
        let mut staged = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .unwrap();
        staged.write_all(payload).unwrap();
        staged.sync_all().unwrap();

        // An independent actor now owns the UUID leaf. The pinned handle
        // still points at the displaced original, so a path-only read fails.
        fs::rename(&temporary, &displaced).unwrap();
        fs::write(&temporary, b"foreign-snapshot").unwrap();
        let error =
            publish_undo_snapshot_checked(&temporary, &destination, &root, &staged, payload)
                .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_during_publication"));
        assert!(!destination.exists());
        assert_eq!(fs::read(&temporary).unwrap(), b"foreign-snapshot");
        assert_eq!(fs::read(&displaced).unwrap(), payload);
        drop(staged);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_staging_inplace_tamper_is_rejected_before_publication() {
        let root = std::env::temp_dir().join(format!("wc-undo-stage-inplace-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let temporary = root.join(format!(".{}.tmp", Uuid::new_v4()));
        let destination = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let payload = b"private-snapshot";
        let mut staged = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .unwrap();
        staged.write_all(payload).unwrap();
        staged.sync_all().unwrap();

        // Identity and length remain unchanged, but the bytes are hostile.
        fs::write(&temporary, b"foreign-snapshot").unwrap();
        let observed = open_regular_read(&temporary).unwrap();
        assert!(undo_snapshot_identity_matches(&staged, &observed).unwrap());
        drop(observed);
        let error =
            publish_undo_snapshot_checked(&temporary, &destination, &root, &staged, payload)
                .unwrap_err();
        assert!(error
            .to_string()
            .contains("undo_snapshot_changed_during_publication"));
        assert!(!destination.exists());
        assert_eq!(fs::read(&temporary).unwrap(), b"foreign-snapshot");
        drop(staged);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verified_snapshot_staging_publishes_expected_payload() {
        let root = std::env::temp_dir().join(format!("wc-undo-stage-valid-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let temporary = root.join(format!(".{}.tmp", Uuid::new_v4()));
        let destination = root.join(format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4()));
        let payload = b"private-snapshot";
        let mut staged = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .unwrap();
        staged.write_all(payload).unwrap();
        staged.sync_all().unwrap();
        publish_undo_snapshot_checked(&temporary, &destination, &root, &staged, payload).unwrap();
        assert!(!temporary.exists());
        assert_eq!(fs::read(&destination).unwrap(), payload);
        remove_undo_snapshot_checked(&destination, &staged).unwrap();
        drop(staged);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_parent_cannot_redirect_snapshot_publication() {
        use std::process::Command;
        let root =
            std::env::temp_dir().join(format!("wc-undo-publish-junction-{}", Uuid::new_v4()));
        let outside = root.join("outside");
        let alias = root.join("redirect");
        fs::create_dir_all(&outside).unwrap();
        let staged_name = format!(".{}.tmp", Uuid::new_v4());
        let destination_name = format!("{}-{}.undo", "a".repeat(64), Uuid::new_v4());
        let external_staged = outside.join(&staged_name);
        let external_destination = outside.join(&destination_name);
        fs::write(&external_staged, b"external-staging").unwrap();
        let output = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&alias)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // Even if a previous directory check succeeded before a junction
        // swap, the final Windows publication boundary must fail closed.
        assert!(publish_undo_snapshot(
            &alias.join(&staged_name),
            &alias.join(&destination_name),
            &alias
        )
        .is_err());
        assert_eq!(fs::read(&external_staged).unwrap(), b"external-staging");
        assert!(!external_destination.exists());

        // A safe source must not be moved into a redirected destination.
        let safe_staged = root.join(format!(".{}.tmp", Uuid::new_v4()));
        fs::write(&safe_staged, b"private-staging").unwrap();
        assert!(
            publish_undo_snapshot(&safe_staged, &alias.join(&destination_name), &root).is_err()
        );
        assert_eq!(fs::read(&safe_staged).unwrap(), b"private-staging");
        assert!(!external_destination.exists());

        // A normal private directory still publishes without data loss.
        let safe_destination = root.join(&destination_name);
        publish_undo_snapshot(&safe_staged, &safe_destination, &root).unwrap();
        assert_eq!(fs::read(&safe_destination).unwrap(), b"private-staging");
        assert!(!safe_staged.exists());
        fs::remove_dir(&alias).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, unix))]
mod undo_open_handle_tests {
    use super::*;

    #[test]
    fn hardlink_inserted_after_quota_scan_is_rejected_by_snapshot_reader() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let dir = root.join("private");
        fs::create_dir_all(&dir).unwrap();
        let target = root.join("file.txt");
        fs::write(&target, b"current").unwrap();
        let outside = root.join("external");
        fs::write(&outside, b"outside").unwrap();

        assert_eq!(undo_storage_usage(&dir).unwrap(), (0, 0));
        // Simulate an uncooperative writer inserting a hardlink after the
        // quota scan, but before fs_versions opens the snapshot.
        let prefix = undo_prefix(&target);
        let alias = dir.join(format!("{prefix}-{}.undo", Uuid::new_v4()));
        fs::hard_link(&outside, &alias).unwrap();
        let error = undo_entries(&target, &dir, None).unwrap_err();
        assert!(error.to_string().contains("unsafe_undo_storage_hardlink"));
        // The same opened-handle guard also protects fs_undo after its scan.
        let file = open_regular_read(&alias).unwrap();
        assert!(reject_undo_hardlinked_handle(&file).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        fs::remove_dir_all(&root).unwrap();
    }
}

#[cfg(test)]
mod undo_scope_tests {
    use super::*;

    #[test]
    fn tenant_actor_and_device_undo_boundaries_fail_closed() {
        let root = std::env::temp_dir().join(format!("commender-undo-scope-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let target = root.join("scope.txt");
        fs::write(&target, b"before").unwrap();
        let path = target.to_str().unwrap();
        let owner = undo_scope_fingerprint("org-a", "actor-a", "device-a").unwrap();
        let foreign_actor = undo_scope_fingerprint("org-a", "actor-b", "device-a").unwrap();
        let foreign_org = undo_scope_fingerprint("org-b", "actor-a", "device-a").unwrap();
        let foreign_device = undo_scope_fingerprint("org-a", "actor-a", "device-b").unwrap();
        let changed =
            replace_text_scoped(&policy, path, "before", "after", false, None, &owner).unwrap();
        let id = changed["undoId"].as_str().unwrap();
        let sha = changed["sha256"].as_str().unwrap();
        for foreign in [&foreign_actor, &foreign_org, &foreign_device] {
            assert!(versions_scoped(&policy, path, foreign).unwrap()["versions"]
                .as_array()
                .unwrap()
                .is_empty());
            assert!(undo_scoped(&policy, path, id, sha, foreign).is_err());
            assert_eq!(fs::read(&target).unwrap(), b"after");
        }
        assert!(versions(&policy, path).unwrap()["versions"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(undo(&policy, path, id, sha).is_err());
        assert_eq!(
            versions_scoped(&policy, path, &owner).unwrap()["versions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(undo_scoped(&policy, path, id, sha, &owner).unwrap()["ok"]
            .as_bool()
            .unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"before");
        fs::remove_dir_all(root).unwrap();
    }
}

/// Stage writes beside their target so incomplete writes never truncate
/// an existing file. Keep the original intact if rename cannot replace it.
/// Unix uses one pinned parent directory for staging, rename and cleanup:
/// a swapped ancestor symlink cannot redirect the final rename.
// Recheck a guarded edit against the actual opened file immediately before
// committing the staged replacement. This narrows the external-writer window;
// it is not a transactional CAS against uncooperative processes.
fn verify_atomic_write_guard(existing: fs::File, expected: &str) -> Result<()> {
    // Match the preflight scan budget and hardlink policy. Never allocate
    // the original file in memory or silently skip conflict protection.
    let current = atomic_unconditional_original_digest(&existing)?
        .ok_or_else(|| anyhow!("file_changed_since_read"))?;
    if !current.eq_ignore_ascii_case(expected) {
        return Err(anyhow!("file_changed_since_read"));
    }
    Ok(())
}

// Shared inodes can be modified through another pathname while an unguarded
// replacement is staged. Match the guarded-write hardlink policy, including
// links added after the initial metadata check. This narrows, but cannot
// eliminate, the final validation-to-rename race with uncooperative writers.
fn atomic_unconditional_reject_shared_inode(file: &fs::File) -> Result<()> {
    #[cfg(windows)]
    if reject_windows_hardlinked_file(file).is_err() {
        return Err(anyhow!("file_changed_since_read"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(anyhow!("file_changed_since_read"));
        }
    }
    Ok(())
}

// An unguarded replacement must not silently skip conflict detection for
// existing files larger than the single-read limit. Stream up to the separate
// atomic conflict-scan budget and fail closed above it. This is still not a kernel-level CAS against
// an uncooperative writer between the final digest and rename.
fn atomic_unconditional_original_digest(file: &fs::File) -> Result<Option<String>> {
    atomic_unconditional_original_digest_with_hook(file, || Ok(()))
}

// The hook makes metadata-to-read races deterministic in native regression
// tests; production passes a no-op. An initially bounded file must never
// silently lose its conflict guard if another writer grows or truncates it.
fn atomic_unconditional_original_digest_with_hook(
    file: &fs::File,
    after_size_check: impl FnOnce() -> Result<()>,
) -> Result<Option<String>> {
    let initial_metadata = file.metadata()?;
    if !initial_metadata.is_file() || initial_metadata.len() > MAX_ATOMIC_UNGUARDED_SCAN {
        return Err(anyhow!("file_changed_since_read"));
    }
    atomic_unconditional_reject_shared_inode(file)?;
    let initial_len = initial_metadata.len();
    after_size_check()?;
    atomic_unconditional_reject_shared_inode(file)?;
    let mut reader = file.try_clone()?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 16 * 1024];
    let mut total = 0_u64;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| anyhow!("file_changed_since_read"))?;
        if total > MAX_ATOMIC_UNGUARDED_SCAN {
            return Err(anyhow!("file_changed_since_read"));
        }
        digest.update(&buffer[..count]);
    }
    if total != initial_len || file.metadata()?.len() != initial_len {
        return Err(anyhow!("file_changed_since_read"));
    }
    atomic_unconditional_reject_shared_inode(file)?;
    Ok(Some(format!("{:x}", digest.finalize())))
}

// Compare the staged file's actual bytes with the intended payload without
// allocating another payload-sized buffer. A same-inode in-place modification
// is not detected by file-ID checks alone.
fn atomic_staged_bytes_match(mut staged: &fs::File, expected: &[u8]) -> Result<bool> {
    let mut checked = 0_usize;
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let count = staged.read(&mut chunk)?;
        if count == 0 {
            return Ok(checked == expected.len());
        }
        let Some(end) = checked.checked_add(count) else {
            return Ok(false);
        };
        if end > expected.len() || chunk[..count] != expected[checked..end] {
            return Ok(false);
        }
        checked = end;
    }
}

// Test-only interprocess barrier, excluded from production Agent binaries.
#[cfg(all(test, unix))]
fn pause_for_external_edit_fixture() -> Result<()> {
    if let Ok(marker) = std::env::var("WCF_CAS_MARKER") {
        let release = std::env::var("WCF_CAS_RELEASE")?;
        fs::write(marker, b"staged")?;
        let started = Instant::now();
        while !Path::new(&release).exists() {
            if started.elapsed() > Duration::from_secs(10) {
                return Err(anyhow!("external_edit_fixture_timeout"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(())
}

// This barrier is compiled only into opt-in debug CI Agents, never release
// packages. It exercises a real MCP request while an independent OS process
// changes the original target after staging and before final conflict checks.
#[cfg(all(unix, feature = "ci-race-fixtures", debug_assertions))]
fn pause_for_mcp_external_edit_fixture(path: &Path) -> Result<()> {
    let Ok(target) = std::env::var("WCF_MCP_CAS_TARGET") else {
        return Ok(());
    };
    if path != Path::new(&target) {
        return Ok(());
    }
    let marker = std::env::var("WCF_MCP_CAS_MARKER")?;
    let release = std::env::var("WCF_MCP_CAS_RELEASE")?;
    fs::write(marker, b"staged")?;
    let started = Instant::now();
    while !Path::new(&release).exists() {
        if started.elapsed() > Duration::from_secs(20) {
            return Err(anyhow!("mcp_external_edit_fixture_timeout"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

// An initially absent target must not overwrite a file created by an
// independent process while the Agent stages its contents. Use the same
// pinned directory handle for the kernel's no-replace publication.
#[cfg(target_os = "linux")]
fn publish_atomic_create_noreplace(
    parent: &fs::File,
    temporary: &std::ffi::CStr,
    target: &std::ffi::CStr,
) -> Result<()> {
    use std::os::fd::AsRawFd;
    let status = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            parent.as_raw_fd(),
            temporary.as_ptr(),
            parent.as_raw_fd(),
            target.as_ptr(),
            1u32, // RENAME_NOREPLACE
        )
    };
    if status != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn publish_atomic_create_noreplace(
    parent: &fs::File,
    temporary: &std::ffi::CStr,
    target: &std::ffi::CStr,
) -> Result<()> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn renameatx_np(
            fromfd: libc::c_int,
            from: *const libc::c_char,
            tofd: libc::c_int,
            to: *const libc::c_char,
            flags: libc::c_uint,
        ) -> libc::c_int;
    }
    let status = unsafe {
        renameatx_np(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            parent.as_raw_fd(),
            target.as_ptr(),
            0x4, // RENAME_EXCL
        )
    };
    if status != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn publish_atomic_create_noreplace(
    _parent: &fs::File,
    _temporary: &std::ffi::CStr,
    _target: &std::ffi::CStr,
) -> Result<()> {
    Err(anyhow!("atomic_create_noreplace_unsupported"))
}

#[cfg(unix)]
fn atomic_write(path: &Path, bytes: &[u8], expected_sha256: Option<&str>) -> Result<()> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};

    let (parent, target) = rename_parent_handle(path)?;
    let temporary_name = format!(".wecommander-{}.tmp", Uuid::new_v4());
    let temporary = CString::new(temporary_name.as_str())?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut file = unsafe { fs::File::from_raw_fd(fd) };
    // Keep the original inode alive until publication. A different inode with
    // identical bytes is still an external replacement (ABA), not our edit.
    let mut original_guard_file: Option<fs::File> = None;
    let mut original_unguarded_digest: Option<String> = None;
    let mut target_was_missing = false;
    let result = (|| -> Result<()> {
        // Do not follow a replaced target symlink while copying permissions.
        // O_NONBLOCK prevents an attacker-controlled FIFO from hanging the agent.
        let existing_fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                target.as_ptr(),
                libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if existing_fd >= 0 {
            let existing = unsafe { fs::File::from_raw_fd(existing_fd) };
            let metadata = existing.metadata()?;
            if !metadata.is_file() {
                return Err(anyhow!("atomic_replace_requires_regular_file"));
            }
            file.set_permissions(metadata.permissions())?;
            if expected_sha256.is_none() {
                original_unguarded_digest = atomic_unconditional_original_digest(&existing)?;
            }
            // Pin the initial file identity even when the caller did not
            // request a SHA guard. An external replacement must not be lost.
            original_guard_file = Some(existing);
        } else {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.into());
            }
            target_was_missing = true;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(all(unix, feature = "ci-race-fixtures", debug_assertions))]
        pause_for_mcp_external_edit_fixture(path)?;
        #[cfg(test)]
        pause_for_external_edit_fixture()?;
        // A competing local process can replace the UUID staging leaf while
        // the original staging handle remains open. Never publish a different
        // inode, even if the target itself still passes its SHA/identity guard.
        let staged_fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if staged_fd < 0 {
            return Err(anyhow!("atomic_staging_changed"));
        }
        let staged_now = unsafe { fs::File::from_raw_fd(staged_fd) };
        use std::os::unix::fs::MetadataExt;
        let staged_before = file.metadata()?;
        let staged_after = staged_now.metadata()?;
        if !staged_after.is_file()
            || staged_before.dev() != staged_after.dev()
            || staged_before.ino() != staged_after.ino()
            || staged_after.nlink() != 1
            || !atomic_staged_bytes_match(&staged_now, bytes)?
        {
            return Err(anyhow!("atomic_staging_changed"));
        }
        if !target_was_missing {
            // Re-open relative to the pinned parent; never trust a path stat.
            // Reject a swapped inode even for an unconditional edit. This is
            // not a kernel-level CAS against a last-instant external writer.
            let current_fd = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    target.as_ptr(),
                    libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if current_fd < 0 {
                return Err(anyhow!("file_changed_since_read"));
            }
            let current = unsafe { fs::File::from_raw_fd(current_fd) };
            use std::os::unix::fs::MetadataExt;
            let original = original_guard_file
                .as_ref()
                .ok_or_else(|| anyhow!("file_changed_since_read"))?;
            let before = original.metadata()?;
            let after = current.metadata()?;
            if before.dev() != after.dev() || before.ino() != after.ino() {
                return Err(anyhow!("file_changed_since_read"));
            }
            if let Some(expected) = expected_sha256 {
                verify_atomic_write_guard(current, expected)?;
            } else if let Some(before) = original_unguarded_digest.as_deref() {
                if atomic_unconditional_original_digest(&current)?.as_deref() != Some(before) {
                    return Err(anyhow!("file_changed_since_read"));
                }
            }
        } else if expected_sha256.is_some() {
            return Err(anyhow!("file_changed_since_read"));
        }
        if target_was_missing {
            // A competing creator owns the target; never clobber it.
            publish_atomic_create_noreplace(&parent, &temporary, &target)?;
        } else {
            let status = unsafe {
                libc::renameat(
                    parent.as_raw_fd(),
                    temporary.as_ptr(),
                    parent.as_raw_fd(),
                    target.as_ptr(),
                )
            };
            if status != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        // Never report a post-rename sync failure as a failed edit: undo
        // callers would otherwise discard a snapshot for a visible write.
        let _ = parent.sync_all();
        Ok(())
    })();
    if result.is_err() {
        // The staging pathname may now belong to a different process. Use
        // identity-checked quarantine cleanup instead of unlinking by name.
        let _ = remove_undo_snapshot_checked(&path.with_file_name(&temporary_name), &file);
    }
    result
}

// The Windows runner uses a separate test process to replace a target with
// a new file ID containing identical bytes during the staging window.
#[cfg(all(test, windows))]
fn pause_for_windows_external_edit_fixture() -> Result<()> {
    if let Ok(marker) = std::env::var("WCF_WIN_CAS_MARKER") {
        let release = std::env::var("WCF_WIN_CAS_RELEASE")?;
        fs::write(marker, b"staged")?;
        let started = Instant::now();
        while !Path::new(&release).exists() {
            if started.elapsed() > Duration::from_secs(10) {
                return Err(anyhow!("windows_external_edit_fixture_timeout"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn atomic_write(path: &Path, bytes: &[u8], expected_sha256: Option<&str>) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("missing parent directory"))?;
    // Windows junctions can redirect an otherwise allowlisted pathname.
    // Validate before creating a staging file and again before publishing it.
    // These path checks are fail-closed for static reparse points; hostile
    // concurrent swaps still require handle-relative Windows traversal.
    #[cfg(windows)]
    reject_windows_undo_reparse_ancestors(path)?;
    let temporary = parent.join(format!(".wecommander-{}.tmp", Uuid::new_v4()));
    #[cfg(windows)]
    let mut staged_identity: Option<(u32, u32, u32)> = None;
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        #[cfg(windows)]
        {
            staged_identity = Some(windows_file_identity(&file)?);
            reject_windows_undo_reparse_ancestors(path)?;
        }
        let mut target_was_missing = false;
        match fs::symlink_metadata(path) {
            Ok(existing) => {
                if !existing.is_file() {
                    return Err(anyhow!("atomic_replace_requires_regular_file"));
                }
                file.set_permissions(existing.permissions())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                target_was_missing = true;
            }
            Err(error) => return Err(error.into()),
        }
        // Pin the original Windows file identity before staging. A competing
        // writer can replace a file with the same bytes but a new file ID.
        // The final SHA alone cannot detect that ABA replacement.
        #[cfg(windows)]
        let original_guard_file = if !target_was_missing {
            // Also pin unconditional replacements: a competing file swap
            // must not silently overwrite a different Windows file ID.
            Some(open_regular_read(path).map_err(|_| anyhow!("file_changed_since_read"))?)
        } else {
            None
        };
        #[cfg(windows)]
        let original_unguarded_digest = if expected_sha256.is_none() {
            original_guard_file
                .as_ref()
                .map(atomic_unconditional_original_digest)
                .transpose()?
                .flatten()
        } else {
            None
        };
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(all(test, windows))]
        pause_for_windows_external_edit_fixture()?;
        #[cfg(windows)]
        {
            // The staged leaf is a separate security boundary from the target.
            // Detect a same-name replacement before MoveFileW/fs::rename.
            let staged_now =
                open_regular_read(&temporary).map_err(|_| anyhow!("atomic_staging_changed"))?;
            if Some(windows_file_identity(&staged_now)?) != staged_identity
                || reject_windows_hardlinked_file(&staged_now).is_err()
                || !atomic_staged_bytes_match(&staged_now, bytes)?
            {
                return Err(anyhow!("atomic_staging_changed"));
            }
        }
        if !target_was_missing {
            let existing =
                open_regular_read(path).map_err(|_| anyhow!("file_changed_since_read"))?;
            #[cfg(windows)]
            {
                let original = original_guard_file
                    .as_ref()
                    .ok_or_else(|| anyhow!("file_changed_since_read"))?;
                if windows_file_identity(original)
                    .map_err(|_| anyhow!("file_changed_since_read"))?
                    != windows_file_identity(&existing)
                        .map_err(|_| anyhow!("file_changed_since_read"))?
                {
                    return Err(anyhow!("file_changed_since_read"));
                }
            }
            if let Some(expected) = expected_sha256 {
                verify_atomic_write_guard(existing.try_clone()?, expected)?;
            }
            #[cfg(windows)]
            if let Some(before) = original_unguarded_digest.as_deref() {
                if atomic_unconditional_original_digest(&existing)?.as_deref() != Some(before) {
                    return Err(anyhow!("file_changed_since_read"));
                }
            }
        } else if expected_sha256.is_some() {
            return Err(anyhow!("file_changed_since_read"));
        }
        #[cfg(windows)]
        reject_windows_undo_reparse_ancestors(path)?;
        if target_was_missing {
            // MoveFileW rejects a destination created during staging.
            rename_noreplace(&temporary, path).context("atomic create collision")?;
        } else {
            fs::rename(&temporary, path).context("atomic replace failed")?;
        }
        // A synced temporary file does not make its directory entry durable.
        // Best-effort directory sync improves crash recovery on Unix. Never
        // fail *after* rename: callers would otherwise delete their undo
        // snapshot despite the replacement already being visible.
        #[cfg(unix)]
        {
            if let Ok(directory) = fs::File::open(parent) {
                let _ = directory.sync_all();
            }
        }
        Ok(())
    })();
    if result.is_err() {
        #[cfg(windows)]
        if let Some(identity) = staged_identity {
            if let Ok(current) = open_regular_read(&temporary) {
                if windows_file_identity(&current).ok() == Some(identity) {
                    let _ = remove_undo_snapshot_checked(&temporary, &current);
                }
            }
        }
        #[cfg(not(windows))]
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod atomic_digest_race_tests {
    use super::*;

    #[test]
    fn unguarded_digest_rejects_growth_after_initial_size_check() {
        let dir = std::env::temp_dir().join(format!("wc-digest-grow-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("target.txt");
        fs::write(&path, b"seed").unwrap();
        let file = fs::File::open(&path).unwrap();
        let error = atomic_unconditional_original_digest_with_hook(&file, || {
            fs::write(&path, vec![b'x'; HARD_READ_MAX + 1])?;
            Ok(())
        })
        .unwrap_err();
        assert!(error.to_string().contains("file_changed_since_read"));
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            (HARD_READ_MAX + 1) as u64
        );
        drop(file);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_digest_rejects_truncation_after_initial_size_check() {
        let dir = std::env::temp_dir().join(format!("wc-digest-shrink-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("target.txt");
        fs::write(&path, b"original").unwrap();
        let file = fs::File::open(&path).unwrap();
        let error = atomic_unconditional_original_digest_with_hook(&file, || {
            fs::write(&path, b"x")?;
            Ok(())
        })
        .unwrap_err();
        assert!(error.to_string().contains("file_changed_since_read"));
        assert_eq!(fs::read(&path).unwrap(), b"x");
        drop(file);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_atomic_write_rejects_existing_hardlink_without_touching_alias() {
        let dir = std::env::temp_dir().join(format!("wc-digest-hardlink-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let path = dir.join("target.txt");
        let alias = dir.join("alias.txt");
        fs::write(&path, b"original").unwrap();
        fs::hard_link(&path, &alias).unwrap();
        let error = atomic_write(&path, b"agent-update", None).unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "{error}"
        );
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read(&alias).unwrap(), b"original");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_digest_rejects_hardlink_added_after_initial_check() {
        let dir = std::env::temp_dir().join(format!("wc-digest-link-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let path = dir.join("target.txt");
        let alias = dir.join("late-alias.txt");
        fs::write(&path, b"original").unwrap();
        let file = fs::File::open(&path).unwrap();
        let error = atomic_unconditional_original_digest_with_hook(&file, || {
            fs::hard_link(&path, &alias)?;
            Ok(())
        })
        .unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "{error}"
        );
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read(&alias).unwrap(), b"original");
        drop(file);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_late_hardlink_worker() {
        let Ok(raw) = std::env::var("WCF_LATE_LINK_TARGET") else {
            return;
        };
        let error = atomic_write(Path::new(&raw), b"agent-update", None).unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "{error}"
        );
    }

    #[test]
    fn unguarded_late_hardlink_from_other_process_is_rejected() {
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("wc-late-link-process-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let target = dir.join("target.txt");
        let alias = dir.join("alias.txt");
        let marker = dir.join("staged.marker");
        let release = dir.join("release.marker");
        fs::write(&target, b"original").unwrap();
        let marker_var = if cfg!(windows) {
            "WCF_WIN_CAS_MARKER"
        } else {
            "WCF_CAS_MARKER"
        };
        let release_var = if cfg!(windows) {
            "WCF_WIN_CAS_RELEASE"
        } else {
            "WCF_CAS_RELEASE"
        };
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::atomic_digest_race_tests::unguarded_late_hardlink_worker")
            .arg("--nocapture")
            .env("WCF_LATE_LINK_TARGET", &target)
            .env(marker_var, &marker)
            .env(release_var, &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("late hardlink worker exited before barrier: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("late hardlink worker never reached barrier");
        }
        fs::hard_link(&target, &alias).unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "late hardlink worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fs::read(&alias).unwrap(), b"original");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_digest_protects_existing_file_above_single_read_limit() {
        let dir = std::env::temp_dir().join(format!("wc-digest-large-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let path = dir.join("target.bin");
        let original = vec![b'x'; HARD_READ_MAX + 4096];
        fs::write(&path, &original).unwrap();
        let file = fs::File::open(&path).unwrap();
        assert_eq!(
            atomic_unconditional_original_digest(&file).unwrap(),
            Some(format!("{:x}", Sha256::digest(&original)))
        );
        drop(file);
        atomic_write(&path, b"updated", None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"updated");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_digest_accepts_file_above_paged_read_limit() {
        let dir = std::env::temp_dir().join(format!("wc-digest-paged-plus-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let path = dir.join("target.bin");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"seed").unwrap();
        file.set_len(MAX_PAGED_FILE + 1).unwrap();
        drop(file);
        atomic_write(&path, b"updated", None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"updated");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn guarded_sha_without_undo_streams_existing_file_above_paged_limit() {
        let dir = std::env::temp_dir().join(format!("wc-guarded-large-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let path = dir.join("target.bin");
        let mut original = fs::File::create(&path).unwrap();
        original.write_all(b"guarded-seed").unwrap();
        original.set_len(MAX_PAGED_FILE + 1).unwrap();
        drop(original);
        let expected = atomic_unconditional_original_digest(&fs::File::open(&path).unwrap())
            .unwrap()
            .unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&dir)).unwrap();
        let response = write(
            &policy,
            path.to_str().unwrap(),
            &STANDARD.encode(b"guarded-large-updated"),
            false,
            Some(&expected),
            false,
        )
        .unwrap();
        assert_eq!(response["ok"], true);
        assert_eq!(fs::read(&path).unwrap(), b"guarded-large-updated");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn guarded_sha_without_undo_rejects_oversized_source_without_data_loss() {
        let dir = std::env::temp_dir().join(format!("wc-guarded-overlimit-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let path = dir.join("target.bin");
        fs::write(&path, b"preserve").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_ATOMIC_UNGUARDED_SCAN + 1)
            .unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&dir)).unwrap();
        let error = write(
            &policy,
            path.to_str().unwrap(),
            &STANDARD.encode(b"must-not-overwrite"),
            false,
            Some(&"0".repeat(64)),
            false,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "{error}"
        );
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            MAX_ATOMIC_UNGUARDED_SCAN + 1
        );
        let mut first = [0_u8; 8];
        fs::File::open(&path)
            .unwrap()
            .read_exact(&mut first)
            .unwrap();
        assert_eq!(&first, b"preserve");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_digest_rejects_existing_file_above_streaming_budget() {
        let dir = std::env::temp_dir().join(format!("wc-digest-oversize-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let path = dir.join("target.bin");
        fs::write(&path, b"x").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_ATOMIC_UNGUARDED_SCAN + 1)
            .unwrap();
        let error = atomic_write(&path, b"must-not-overwrite", None).unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "{error}"
        );
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            MAX_ATOMIC_UNGUARDED_SCAN + 1
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_digest_rejects_growth_past_streaming_budget() {
        let dir = std::env::temp_dir().join(format!("wc-digest-overgrow-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("target.bin");
        fs::write(&path, b"seed").unwrap();
        let file = fs::File::open(&path).unwrap();
        let error = atomic_unconditional_original_digest_with_hook(&file, || {
            fs::OpenOptions::new()
                .write(true)
                .open(&path)?
                .set_len(MAX_ATOMIC_UNGUARDED_SCAN + 1)?;
            Ok(())
        })
        .unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "{error}"
        );
        drop(file);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_large_file_external_inplace_edit_worker() {
        let Ok(raw) = std::env::var("WCF_LARGE_INPLACE_TARGET") else {
            return;
        };
        let error = atomic_write(Path::new(&raw), b"agent-update", None).unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "{error}"
        );
    }

    #[test]
    fn unguarded_large_file_external_inplace_edit_is_rejected() {
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("wc-digest-large-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let target = dir.join("target.bin");
        let marker = dir.join("staged.marker");
        let release = dir.join("release.marker");
        let original = vec![b'x'; HARD_READ_MAX + 4096];
        fs::write(&target, &original).unwrap();
        let marker_var = if cfg!(windows) {
            "WCF_WIN_CAS_MARKER"
        } else {
            "WCF_CAS_MARKER"
        };
        let release_var = if cfg!(windows) {
            "WCF_WIN_CAS_RELEASE"
        } else {
            "WCF_CAS_RELEASE"
        };
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::atomic_digest_race_tests::unguarded_large_file_external_inplace_edit_worker")
            .arg("--nocapture")
            .env("WCF_LARGE_INPLACE_TARGET", &target)
            .env(marker_var, &marker)
            .env(release_var, &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let start = Instant::now();
        while !marker.exists() && start.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("large-file worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("large-file worker never reached staging");
        }
        let mut external = fs::OpenOptions::new().write(true).open(&target).unwrap();
        external.write_all(b"attacker").unwrap();
        external.sync_all().unwrap();
        drop(external);
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "large-file worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let preserved = fs::read(&target).unwrap();
        assert_eq!(preserved.len(), original.len());
        assert_eq!(&preserved[..8], b"attacker");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unguarded_digest_keeps_bounded_unchanged_file() {
        let dir = std::env::temp_dir().join(format!("wc-digest-ok-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("target.txt");
        fs::write(&path, b"unchanged").unwrap();
        let file = fs::File::open(&path).unwrap();
        let digest = atomic_unconditional_original_digest(&file).unwrap();
        assert_eq!(digest, Some(format!("{:x}", Sha256::digest(b"unchanged"))));
        drop(file);
        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(all(test, unix))]
mod atomic_write_parent_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    // The competing writer is a separate OS process, not another thread
    // sharing the Agent's in-memory mutation lock.
    #[test]
    fn process_atomic_staging_inplace_worker() {
        let Ok(raw) = std::env::var("WCF_STAGE_INPLACE_TARGET") else {
            return;
        };
        let error = atomic_write(Path::new(&raw), b"agent-update", None).unwrap_err();
        assert!(
            error.to_string().contains("atomic_staging_changed"),
            "unexpected staging error: {error}"
        );
    }

    #[test]
    fn atomic_staging_inplace_tamper_is_rejected() {
        use std::process::{Command, Stdio};
        let base = std::env::temp_dir().join(format!("wc-stage-edit-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let target = base.join("target.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::atomic_write_parent_tests::process_atomic_staging_inplace_worker")
            .arg("--nocapture")
            .env("WCF_STAGE_INPLACE_TARGET", &target)
            .env("WCF_CAS_MARKER", &marker)
            .env("WCF_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("Unix staging worker exited before barrier: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("Unix staging worker never reached barrier");
        }
        let stage = fs::read_dir(&base)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(".wecommander-"))
            })
            .expect("missing staging leaf");
        fs::write(&stage, b"attacker-stage").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Unix staging worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"seed");
        assert!(!stage.exists(), "owned staging file should be cleaned");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn process_atomic_staging_swap_worker() {
        let Ok(raw) = std::env::var("WCF_STAGE_SWAP_TARGET") else {
            return;
        };
        let error = atomic_write(Path::new(&raw), b"agent-update", None).unwrap_err();
        assert!(
            error.to_string().contains("atomic_staging_changed"),
            "unexpected staging error: {error}"
        );
    }

    #[test]
    fn atomic_staging_swap_rejects_untrusted_publication_and_cleanup() {
        use std::process::{Command, Stdio};
        let base = std::env::temp_dir().join(format!("wc-stage-swap-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let target = base.join("target.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        let parked = base.join("parked-stage.txt");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::atomic_write_parent_tests::process_atomic_staging_swap_worker")
            .arg("--nocapture")
            .env("WCF_STAGE_SWAP_TARGET", &target)
            .env("WCF_CAS_MARKER", &marker)
            .env("WCF_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("Unix staging worker exited before barrier: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("Unix staging worker never reached barrier");
        }
        let stage = fs::read_dir(&base)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(".wecommander-"))
            })
            .expect("missing staging leaf");
        fs::rename(&stage, &parked).unwrap();
        fs::write(&stage, b"attacker-stage").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Unix staging worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"seed");
        assert_eq!(fs::read(&stage).unwrap(), b"attacker-stage");
        assert_eq!(fs::read(&parked).unwrap(), b"agent-update");
        fs::remove_file(&stage).unwrap();
        atomic_write(&target, b"recovered", None).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"recovered");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn process_atomic_guard_worker() {
        let Ok(raw) = std::env::var("WCF_CAS_TARGET") else {
            return;
        };
        let expected = format!("{:x}", Sha256::digest(b"seed"));
        let error = atomic_write(Path::new(&raw), b"agent-update", Some(&expected)).unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "unexpected guard error: {error}"
        );
    }

    #[test]
    fn process_atomic_replace_no_sha_worker() {
        let Ok(raw) = std::env::var("WCF_REPLACE_NO_SHA_TARGET") else {
            return;
        };
        let error = atomic_write(Path::new(&raw), b"agent-update", None).unwrap_err();
        assert!(
            error.to_string().contains("file_changed_since_read"),
            "unexpected replacement guard error: {error}"
        );
    }

    #[test]
    fn process_atomic_create_worker() {
        let Ok(raw) = std::env::var("WCF_CREATE_TARGET") else {
            return;
        };
        let result = atomic_write(Path::new(&raw), b"agent-create", None);
        assert!(result.is_err(), "competing create was overwritten");
    }

    #[test]
    fn atomic_create_succeeds_when_target_remains_absent() {
        let base = std::env::temp_dir().join(format!("commender-create-ok-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let target = base.join("new.txt");
        atomic_write(&target, b"agent-create", None).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"agent-create");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn atomic_create_rejects_external_process_creation_during_stage() {
        use std::process::{Command, Stdio};
        let base = std::env::temp_dir().join(format!("commender-create-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let target = base.join("new.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::atomic_write_parent_tests::process_atomic_create_worker")
            .arg("--nocapture")
            .env("WCF_CREATE_TARGET", &target)
            .env("WCF_CAS_MARKER", &marker)
            .env("WCF_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("create worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("create worker never reached staging barrier");
        }
        fs::write(&target, b"external-create").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "create worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"external-create");
        assert_eq!(
            fs::read_dir(&base)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wecommander-"))
                .count(),
            0
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn atomic_replace_no_sha_rejects_external_file_swap() {
        use std::process::{Command, Stdio};
        let base = std::env::temp_dir().join(format!("commender-no-sha-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let target = base.join("target.txt");
        let displaced = base.join("displaced.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::atomic_write_parent_tests::process_atomic_replace_no_sha_worker")
            .arg("--nocapture")
            .env("WCF_REPLACE_NO_SHA_TARGET", &target)
            .env("WCF_CAS_MARKER", &marker)
            .env("WCF_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("unguarded replace worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("unguarded replace worker never reached staging barrier");
        }
        fs::rename(&target, &displaced).unwrap();
        fs::write(&target, b"external-file").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "unguarded replace worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"external-file");
        assert_eq!(fs::read(&displaced).unwrap(), b"seed");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn atomic_replace_no_sha_rejects_external_inplace_edit() {
        use std::process::{Command, Stdio};
        let base = std::env::temp_dir().join(format!("wc-inplace-no-sha-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let target = base.join("target.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::atomic_write_parent_tests::process_atomic_replace_no_sha_worker")
            .arg("--nocapture")
            .env("WCF_REPLACE_NO_SHA_TARGET", &target)
            .env("WCF_CAS_MARKER", &marker)
            .env("WCF_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("in-place worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("in-place worker never reached staging barrier");
        }
        // Same inode and same length: file-ID and size alone cannot detect it.
        fs::write(&target, b"evil").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "in-place worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"evil");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn external_process_edit_during_atomic_stage_is_rejected() {
        use std::process::{Command, Stdio};
        let base = std::env::temp_dir().join(format!("commender-external-cas-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let target = base.join("target.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::atomic_write_parent_tests::process_atomic_guard_worker")
            .arg("--nocapture")
            .env("WCF_CAS_TARGET", &target)
            .env("WCF_CAS_MARKER", &marker)
            .env("WCF_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("guard worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("guard worker never reached the staging barrier");
        }
        fs::write(&target, b"external-update").unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "guard worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"external-update");
        assert_eq!(
            fs::read_dir(&base)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wecommander-"))
                .count(),
            0
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn guarded_atomic_write_rejects_hardlinked_target_without_changing_alias() {
        let dir = std::env::temp_dir().join(format!("commender-cas-hardlink-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target.txt");
        let alias = dir.join("alias.txt");
        fs::write(&target, b"seed").unwrap();
        fs::hard_link(&target, &alias).unwrap();
        let expected = format!("{:x}", Sha256::digest(b"seed"));
        let error = atomic_write(&target, b"agent-update", Some(&expected)).unwrap_err();
        assert!(error.to_string().contains("file_changed_since_read"));
        assert_eq!(fs::read(&target).unwrap(), b"seed");
        assert_eq!(fs::read(&alias).unwrap(), b"seed");
        assert_eq!(
            fs::read_dir(&dir)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wecommander-"))
                .count(),
            0
        );
        fs::remove_file(&alias).unwrap();
        atomic_write(&target, b"agent-update", Some(&expected)).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"agent-update");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn external_same_content_inode_replacement_during_stage_is_rejected() {
        use std::process::{Command, Stdio};
        let base = std::env::temp_dir().join(format!("commender-external-aba-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let target = base.join("target.txt");
        let marker = base.join("staged.marker");
        let release = base.join("release.marker");
        fs::write(&target, b"seed").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("fs_ops::atomic_write_parent_tests::process_atomic_guard_worker")
            .arg("--nocapture")
            .env("WCF_CAS_TARGET", &target)
            .env("WCF_CAS_MARKER", &marker)
            .env("WCF_CAS_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("guard worker exited before staging: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            let _ = child.kill();
            panic!("guard worker never reached the staging barrier");
        }
        let replacement = base.join("replacement.txt");
        fs::write(&replacement, b"seed").unwrap();
        fs::rename(&replacement, &target).unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "guard worker accepted an ABA replacement: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&target).unwrap(), b"seed");
        assert_eq!(
            fs::read_dir(&base)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wecommander-"))
                .count(),
            0
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn atomic_replace_refuses_swapped_parent_symlink_and_preserves_outside_file() {
        let base = std::env::temp_dir().join(format!("commender-atomic-parent-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let parent = allowed.join("working");
        let outside = base.join("outside");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = parent.join("target.txt");
        let outside_target = outside.join("target.txt");
        fs::write(&target, b"inside").unwrap();
        fs::write(&outside_target, b"outside-private").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        let resolved = policy.resolve_existing(target.to_str().unwrap()).unwrap();
        fs::rename(&parent, allowed.join("relocated")).unwrap();
        symlink(&outside, &parent).unwrap();
        assert!(atomic_write(&resolved, b"replacement", None).is_err());
        assert_eq!(fs::read(&outside_target).unwrap(), b"outside-private");
        assert_eq!(
            fs::read(allowed.join("relocated/target.txt")).unwrap(),
            b"inside"
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn atomic_replace_rejects_symlink_target_without_touching_destination() {
        let base = std::env::temp_dir().join(format!("commender-atomic-target-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let outside = base.join("outside.txt");
        let link = base.join("link.txt");
        fs::write(&outside, b"original").unwrap();
        symlink(&outside, &link).unwrap();
        assert!(atomic_write(&link, b"replacement", None).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"original");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_dir_all(base).unwrap();
    }
}

/// Move without ever replacing a destination created by another process.
/// Checking destination.exists() before fs::rename is not an atomic guard:
/// Unix rename replaces existing files and Windows MoveFileEx can also replace.
/// Pin each parent directory before an atomic rename. PathPolicy canonicalization
/// alone is insufficient when another process swaps an ancestor to a symlink
/// between authorization and renameat2/renameatx_np.
#[cfg(unix)]
pub(crate) fn rename_parent_handle(path: &Path) -> Result<(fs::File, std::ffi::CString)> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;

    if !path.is_absolute() {
        return Err(anyhow!("absolute_path_required"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("unsafe_path_component"))?;
    let leaf = path
        .file_name()
        .ok_or_else(|| anyhow!("unsafe_path_component"))?;
    let leaf = CString::new(leaf.as_bytes())?;
    let mut directory = fs::File::open("/")?;
    for component in parent.components() {
        let name = match component {
            Component::RootDir => continue,
            Component::Normal(name) => name,
            _ => return Err(anyhow!("unsafe_path_component")),
        };
        let name = CString::new(name.as_bytes())?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        directory = unsafe { fs::File::from_raw_fd(fd) };
    }
    Ok((directory, leaf))
}

/// Atomic no-overwrite rename using pinned source and destination parent FDs.
#[cfg(target_os = "linux")]
fn rename_noreplace(source: &Path, destination: &Path) -> Result<()> {
    use std::os::fd::AsRawFd;
    let (source_dir, source_name) = rename_parent_handle(source)?;
    let (destination_dir, destination_name) = rename_parent_handle(destination)?;
    let status = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_dir.as_raw_fd(),
            source_name.as_ptr(),
            destination_dir.as_raw_fd(),
            destination_name.as_ptr(),
            1u32,
        )
    };
    if status != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn rename_noreplace(source: &Path, destination: &Path) -> Result<()> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn renameatx_np(
            fromfd: libc::c_int,
            from: *const libc::c_char,
            tofd: libc::c_int,
            to: *const libc::c_char,
            flags: libc::c_uint,
        ) -> libc::c_int;
    }
    let (source_dir, source_name) = rename_parent_handle(source)?;
    let (destination_dir, destination_name) = rename_parent_handle(destination)?;
    // Darwin RENAME_EXCL (0x4) rejects an existing destination atomically.
    let status = unsafe {
        renameatx_np(
            source_dir.as_raw_fd(),
            source_name.as_ptr(),
            destination_dir.as_raw_fd(),
            destination_name.as_ptr(),
            0x4,
        )
    };
    if status != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(windows)]
fn rename_noreplace(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
    }
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // Unlike MoveFileEx with REPLACE_EXISTING, MoveFileW refuses collisions.
    if unsafe { MoveFileW(source.as_ptr(), destination.as_ptr()) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn rename_noreplace(_source: &Path, _destination: &Path) -> Result<()> {
    Err(anyhow!("atomic_noreplace_move_unsupported"))
}

pub fn move_path(policy: &PathPolicy, source: &str, destination: &str) -> Result<Value> {
    let source_path = policy.resolve_existing(source)?;
    if policy.roots().iter().any(|root| root == &source_path) {
        return Err(anyhow!("refusing to move an allowed root"));
    }

    let destination_path = policy.resolve_for_create(destination)?;
    // symlink_metadata detects dangling links as occupied too.
    match fs::symlink_metadata(&destination_path) {
        Ok(_) => return Err(anyhow!("destination already exists")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    rename_noreplace(&source_path, &destination_path)?;
    Ok(json!({
        "ok": true,
        "source": source_path.to_string_lossy(),
        "destination": destination_path.to_string_lossy()
    }))
}

#[cfg(test)]
mod move_collision_tests {
    use super::*;

    #[test]
    fn move_does_not_overwrite_an_existing_file() {
        let root =
            std::env::temp_dir().join(format!("commender-move-collision-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.txt");
        let destination = root.join("destination.txt");
        fs::write(&source, b"source").unwrap();
        fs::write(&destination, b"keep-me").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        assert!(move_path(
            &policy,
            source.to_str().unwrap(),
            destination.to_str().unwrap()
        )
        .is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&destination).unwrap(), b"keep-me");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn simultaneous_moves_to_one_destination_have_one_winner() {
        use std::sync::{Arc, Barrier};
        let root = std::env::temp_dir().join(format!("commender-move-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let policy = Arc::new(PathPolicy::new(std::slice::from_ref(&root)).unwrap());
        let destination = root.join("destination.txt");
        let barrier = Arc::new(Barrier::new(16));
        let handles = (0..16)
            .map(|index| {
                let source = root.join(format!("source-{index}.txt"));
                fs::write(&source, format!("candidate-{index}")).unwrap();
                let destination = destination.clone();
                let policy = Arc::clone(&policy);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    move_path(
                        &policy,
                        source.to_str().unwrap(),
                        destination.to_str().unwrap(),
                    )
                    .is_ok()
                })
            })
            .collect::<Vec<_>>();
        let wins = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(wins, 1);
        let winner = fs::read_to_string(&destination).unwrap();
        assert!(winner.starts_with("candidate-"));
        assert_eq!(
            (0..16)
                .filter(|index| root.join(format!("source-{index}.txt")).exists())
                .count(),
            15
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn move_rejects_swapped_source_and_destination_parent_symlinks() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!("commender-move-parent-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let source_dir = allowed.join("source-dir");
        let destination_dir = allowed.join("destination-dir");
        let outside = base.join("outside");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&destination_dir).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let source = source_dir.join("source.txt");
        let destination = destination_dir.join("target.txt");
        fs::write(&source, b"inside-source").unwrap();
        fs::write(outside.join("source.txt"), b"outside-source").unwrap();

        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        let resolved_source = policy.resolve_existing(source.to_str().unwrap()).unwrap();
        let resolved_destination = policy
            .resolve_for_create(destination.to_str().unwrap())
            .unwrap();

        fs::rename(&source_dir, allowed.join("relocated-source")).unwrap();
        symlink(&outside, &source_dir).unwrap();
        assert!(rename_noreplace(&resolved_source, &resolved_destination).is_err());
        assert_eq!(
            fs::read(outside.join("source.txt")).unwrap(),
            b"outside-source"
        );
        assert!(!destination.exists());

        let stable_source = allowed.join("stable-source.txt");
        fs::write(&stable_source, b"stable-source").unwrap();
        fs::rename(&destination_dir, allowed.join("relocated-destination")).unwrap();
        symlink(&outside, &destination_dir).unwrap();
        assert!(rename_noreplace(&stable_source, &resolved_destination).is_err());
        assert_eq!(fs::read(&stable_source).unwrap(), b"stable-source");
        assert!(!outside.join("target.txt").exists());
        fs::remove_dir_all(base).unwrap();
    }
}

/// Create directories relative to no-follow directory descriptors. Resolving an
/// allowlisted path alone does not protect mkdir against a later parent-symlink
/// swap; mkdirat/openat keep each step pinned to the directory we inspected.
#[cfg(unix)]
pub(crate) fn mkdir_pinned_unix(path: &Path, recursive: bool) -> Result<()> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;

    if !recursive {
        let (parent, name) = rename_parent_handle(path)?;
        let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o777) };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        return Ok(());
    }

    if !path.is_absolute() {
        return Err(anyhow!("absolute_path_required"));
    }
    let mut directory = fs::File::open("/")?;
    for component in path.components() {
        let name = match component {
            Component::RootDir => continue,
            Component::Normal(name) => name,
            _ => return Err(anyhow!("unsafe_path_component")),
        };
        let name = CString::new(name.as_bytes())?;
        let mut fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.into());
            }
            let created = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o777) };
            if created != 0 {
                let error = std::io::Error::last_os_error();
                // Another creator may have won; re-open without following links.
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(error.into());
                }
            }
            fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        directory = unsafe { fs::File::from_raw_fd(fd) };
    }
    Ok(())
}

pub fn mkdir(policy: &PathPolicy, raw: &str, recursive: bool) -> Result<Value> {
    let path = policy.resolve_for_create(raw)?;
    #[cfg(unix)]
    mkdir_pinned_unix(&path, recursive)?;
    #[cfg(not(unix))]
    if recursive {
        fs::create_dir_all(&path)?;
    } else {
        fs::create_dir(&path)?;
    }
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

#[cfg(all(test, unix))]
mod write_parent_creation_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn fs_write_creates_nested_parents_without_following_links() {
        let root = std::env::temp_dir().join(format!("wc-write-parents-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("nested/deeper/file.txt");
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let result = write(
            &policy,
            target.to_str().unwrap(),
            &STANDARD.encode(b"safe-content"),
            true,
            None,
            false,
        )
        .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(fs::read(&target).unwrap(), b"safe-content");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fs_write_create_parents_rejects_outside_symlink() {
        let base = std::env::temp_dir().join(format!("wc-write-parent-link-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, allowed.join("redirect")).unwrap();
        let target = allowed.join("redirect/new/file.txt");
        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        assert!(write(
            &policy,
            target.to_str().unwrap(),
            &STANDARD.encode(b"not-outside"),
            true,
            None,
            false,
        )
        .is_err());
        assert!(!outside.join("new").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn fs_write_pinned_mkdir_rejects_parent_swap_after_resolution() {
        let base = std::env::temp_dir().join(format!("wc-write-parent-swap-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let working = allowed.join("working");
        let outside = base.join("outside");
        fs::create_dir_all(&working).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        let resolved = policy
            .resolve_for_create(working.join("nested/file.txt").to_str().unwrap())
            .unwrap();
        fs::rename(&working, allowed.join("relocated")).unwrap();
        symlink(&outside, &working).unwrap();
        assert!(mkdir_pinned_unix(resolved.parent().unwrap(), true).is_err());
        assert!(!outside.join("nested").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejected_guarded_write_does_not_create_parent_directories() {
        let root = std::env::temp_dir().join(format!("wc-guarded-no-mkdir-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("missing/child/file.txt");
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        assert!(write(
            &policy,
            target.to_str().unwrap(),
            &STANDARD.encode(b"should-not-appear"),
            true,
            None,
            true,
        )
        .is_err());
        assert!(!root.join("missing").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, unix))]
mod mkdir_parent_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn mkdir_rejects_swapped_parent_without_creating_outside() {
        let base = std::env::temp_dir().join(format!("commender-mkdir-parent-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let parent = allowed.join("working");
        let outside = base.join("outside");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        let shallow = policy
            .resolve_for_create(parent.join("new-shallow").to_str().unwrap())
            .unwrap();
        let nested = policy
            .resolve_for_create(parent.join("new/nested").to_str().unwrap())
            .unwrap();

        fs::rename(&parent, allowed.join("relocated")).unwrap();
        symlink(&outside, &parent).unwrap();
        assert!(mkdir_pinned_unix(&shallow, false).is_err());
        assert!(mkdir_pinned_unix(&nested, true).is_err());
        assert!(!outside.join("new-shallow").exists());
        assert!(!outside.join("new").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn mkdir_pinned_creates_shallow_and_nested_directories() {
        let root = std::env::temp_dir().join(format!("commender-mkdir-normal-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        assert!(mkdir(&policy, root.join("shallow").to_str().unwrap(), false).is_ok());
        assert!(mkdir(&policy, root.join("deep/nested").to_str().unwrap(), true).is_ok());
        assert!(root.join("shallow").is_dir());
        assert!(root.join("deep/nested").is_dir());
        assert!(mkdir(&policy, root.join("shallow").to_str().unwrap(), false).is_err());
        assert!(mkdir(&policy, root.join("deep/nested").to_str().unwrap(), true).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}

/// Traverse recursive deletion with directory descriptors, never path strings.
/// Directory entries are opened with O_NOFOLLOW; symlinks are unlinked rather
/// than traversed. A bounded walk prevents a single request from monopolizing
/// the Agent. External renames of already-open inodes remain a separate gate.
#[cfg(unix)]
struct RecursiveDeleteDir(*mut libc::DIR);

#[cfg(unix)]
impl Drop for RecursiveDeleteDir {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

#[cfg(unix)]
fn delete_children_pinned_unix(
    directory: &fs::File,
    depth: usize,
    remaining: &mut usize,
) -> Result<()> {
    use std::ffi::{CStr, CString};
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};

    if depth > 64 {
        return Err(anyhow!("recursive_delete_depth_limit"));
    }
    let fd = directory.try_clone()?.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::close(fd);
        }
        return Err(error.into());
    }
    let stream = RecursiveDeleteDir(stream);
    loop {
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        *remaining = remaining
            .checked_sub(1)
            .ok_or_else(|| anyhow!("recursive_delete_entry_limit"))?;
        let name = CString::new(name.to_bytes())?;
        let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                &mut metadata,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        if metadata.st_mode & libc::S_IFMT == libc::S_IFDIR {
            let child_fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if child_fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let child = unsafe { fs::File::from_raw_fd(child_fd) };
            delete_children_pinned_unix(&child, depth + 1, remaining)?;
            // Detect a swapped child before unlinking its directory entry.
            let mut current: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    &mut current,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            let original = child.metadata()?;
            use std::os::unix::fs::MetadataExt;
            if current.st_ino != original.ino()
                || i128::from(current.st_dev) != i128::from(original.dev())
            {
                return Err(anyhow!("recursive_delete_inode_changed"));
            }
            if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
                != 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        } else if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn delete_tree_pinned_unix(path: &Path) -> Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};

    let (parent, name) = rename_parent_handle(path)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let directory = unsafe { fs::File::from_raw_fd(fd) };
    let mut remaining = 100_000usize;
    delete_children_pinned_unix(&directory, 0, &mut remaining)?;
    // The directory may have been renamed by an external writer. Refuse to
    // unlink a different inode at the original path.
    let mut current: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            &mut current,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    use std::os::unix::fs::MetadataExt;
    let original = directory.metadata()?;
    if current.st_ino != original.ino() || i128::from(current.st_dev) != i128::from(original.dev())
    {
        return Err(anyhow!("recursive_delete_inode_changed"));
    }
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

/// Remove a file or empty directory relative to a pinned, no-follow parent.
#[cfg(unix)]
fn unlink_pinned(path: &Path, directory: bool) -> Result<()> {
    use std::os::fd::AsRawFd;
    let (parent, name) = rename_parent_handle(path)?;
    let flags = if directory { libc::AT_REMOVEDIR } else { 0 };
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub fn delete(policy: &PathPolicy, raw: &str, recursive: bool) -> Result<Value> {
    let path = policy.resolve_existing(raw)?;
    if policy.roots().iter().any(|root| root == &path) {
        return Err(anyhow!("refusing to delete an allowed root"));
    }

    let metadata = fs::symlink_metadata(&path)?;
    if metadata.is_dir() {
        if recursive {
            #[cfg(unix)]
            delete_tree_pinned_unix(&path)?;
            #[cfg(not(unix))]
            fs::remove_dir_all(&path)?;
        } else {
            #[cfg(unix)]
            unlink_pinned(&path, true)?;
            #[cfg(not(unix))]
            fs::remove_dir(&path)?;
        }
    } else {
        #[cfg(unix)]
        unlink_pinned(&path, false)?;
        #[cfg(not(unix))]
        fs::remove_file(&path)?;
    }

    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

#[cfg(all(test, unix))]
mod delete_parent_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn nonrecursive_delete_rejects_swapped_parent_without_touching_outside() {
        let base = std::env::temp_dir().join(format!("commender-delete-parent-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let parent = allowed.join("working");
        let outside = base.join("outside");
        fs::create_dir_all(parent.join("empty")).unwrap();
        fs::create_dir_all(outside.join("empty")).unwrap();
        fs::write(parent.join("target.txt"), b"inside").unwrap();
        fs::write(outside.join("target.txt"), b"outside-private").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        let resolved_file = policy
            .resolve_existing(parent.join("target.txt").to_str().unwrap())
            .unwrap();
        let resolved_dir = policy
            .resolve_existing(parent.join("empty").to_str().unwrap())
            .unwrap();
        fs::rename(&parent, allowed.join("relocated")).unwrap();
        symlink(&outside, &parent).unwrap();
        assert!(unlink_pinned(&resolved_file, false).is_err());
        assert!(unlink_pinned(&resolved_dir, true).is_err());
        assert_eq!(
            fs::read(outside.join("target.txt")).unwrap(),
            b"outside-private"
        );
        assert!(outside.join("empty").is_dir());
        assert!(allowed.join("relocated/target.txt").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn recursive_delete_unlinks_symlink_without_following_external_target() {
        let base = std::env::temp_dir().join(format!("commender-recursive-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        let target = allowed.join("nested");
        fs::create_dir_all(target.join("child")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(target.join("child/data.txt"), b"inside").unwrap();
        fs::write(outside.join("keep.txt"), b"outside-private").unwrap();
        symlink(&outside, target.join("external-link")).unwrap();

        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        assert!(delete(&policy, target.to_str().unwrap(), true).is_ok());
        assert!(!target.exists());
        assert_eq!(
            fs::read(outside.join("keep.txt")).unwrap(),
            b"outside-private"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn recursive_delete_rejects_swapped_parent_symlink() {
        let base =
            std::env::temp_dir().join(format!("commender-recursive-parent-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let parent = allowed.join("working");
        let outside = base.join("outside");
        fs::create_dir_all(parent.join("nested/child")).unwrap();
        fs::create_dir_all(outside.join("nested/child")).unwrap();
        fs::write(outside.join("nested/child/keep.txt"), b"outside-private").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        let resolved = policy
            .resolve_existing(parent.join("nested").to_str().unwrap())
            .unwrap();

        fs::rename(&parent, allowed.join("relocated")).unwrap();
        symlink(&outside, &parent).unwrap();
        assert!(delete_tree_pinned_unix(&resolved).is_err());
        assert_eq!(
            fs::read(outside.join("nested/child/keep.txt")).unwrap(),
            b"outside-private"
        );
        assert!(allowed.join("relocated/nested").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn nonrecursive_delete_removes_file_and_empty_directory() {
        let root = std::env::temp_dir().join(format!("commender-delete-normal-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("empty")).unwrap();
        let file = root.join("target.txt");
        fs::write(&file, b"content").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        assert!(delete(&policy, file.to_str().unwrap(), false).is_ok());
        assert!(delete(&policy, root.join("empty").to_str().unwrap(), false).is_ok());
        assert!(!file.exists());
        assert!(!root.join("empty").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

fn entry_type(file_type: &fs::FileType) -> &'static str {
    if file_type.is_dir() {
        "directory"
    } else if file_type.is_file() {
        "file"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    }
}

fn file_name_matches(path: &Path, needle: &str, case_sensitive: bool) -> bool {
    path.file_name()
        .map(|name| {
            let name = name.to_string_lossy();
            if case_sensitive {
                name.contains(needle)
            } else {
                name.to_lowercase().contains(needle)
            }
        })
        .unwrap_or(false)
}

fn search_item(path: &Path, metadata: &fs::Metadata) -> Value {
    json!({
        "name": path.file_name().map(|value| value.to_string_lossy()).unwrap_or_default(),
        "path": path.to_string_lossy(),
        "type": if metadata.is_dir() { "directory" } else if metadata.is_file() { "file" } else { "other" },
        "size": metadata.len()
    })
}

fn preview_line(line: &str) -> String {
    line.chars().take(500).collect()
}

#[cfg(test)]
mod search_budget_tests {
    use super::*;
    use std::{
        env, fs,
        sync::{atomic::AtomicUsize, Arc},
    };

    #[test]
    fn paused_scanner_blocks_until_resumed_and_preserves_active_deadline() {
        use std::sync::Arc;
        let paused = Arc::new(AtomicBool::new(true));
        let cancelled = Arc::new(AtomicBool::new(false));
        let resume = Arc::clone(&paused);
        let worker = std::thread::spawn(move || {
            let start = Instant::now();
            let mut deadline = start + Duration::from_millis(30);
            await_search_resume(Some(&paused), &cancelled, &mut deadline).unwrap();
            assert!(start.elapsed() >= Duration::from_millis(60));
            assert!(deadline > Instant::now());
        });
        std::thread::sleep(Duration::from_millis(80));
        resume.store(false, Ordering::Relaxed);
        worker.join().unwrap();
    }

    #[test]
    fn paused_native_search_remains_cancellable() {
        use std::sync::Arc;
        let paused = Arc::new(AtomicBool::new(true));
        let cancelled = Arc::new(AtomicBool::new(false));
        let (p, c) = (Arc::clone(&paused), Arc::clone(&cancelled));
        let worker = std::thread::spawn(move || {
            let mut deadline = Instant::now() + Duration::from_secs(2);
            await_search_resume(Some(&p), &c, &mut deadline)
        });
        std::thread::sleep(Duration::from_millis(30));
        cancelled.store(true, Ordering::Relaxed);
        assert!(worker
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("search_cancelled"));
        assert!(paused.load(Ordering::Relaxed));
    }

    #[test]
    fn native_content_checkpoint_resumes_empty_result_scan_at_safe_path_boundary() {
        let root = env::temp_dir().join(format!("wc-content-resume-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("first")).unwrap();
        fs::create_dir_all(root.join("second")).unwrap();
        fs::write(root.join("first/one.txt"), b"needle in first").unwrap();
        fs::write(root.join("second/two.txt"), b"needle in second").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let checkpoints = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let sink = Arc::clone(&checkpoints);
        let report = move |_: &[Value], _: usize, _: u64, candidate: Option<&Value>| {
            if let Some(candidate) = candidate {
                sink.lock().unwrap().push(candidate.clone());
            }
        };
        let original = text_search_cancellable_controlled(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(100),
            (&AtomicBool::new(false), &AtomicBool::new(false), None),
            &report,
        )
        .unwrap();
        let candidate = checkpoints.lock().unwrap()[0].clone();
        assert_eq!(candidate["searchType"], "content");
        assert_eq!(candidate["items"], json!([]));
        let replay = text_search_cancellable_controlled(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(100),
            (
                &AtomicBool::new(false),
                &AtomicBool::new(false),
                Some(&candidate),
            ),
            &report,
        )
        .unwrap();
        assert_eq!(original["items"], replay["items"]);
        assert_eq!(original["scannedBytes"], replay["scannedBytes"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn matched_content_checkpoint_revalidates_lines_and_rejects_changed_files() {
        let root = env::temp_dir().join(format!("wc-content-matches-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("first")).unwrap();
        fs::create_dir_all(root.join("second")).unwrap();
        fs::write(root.join("first/one.txt"), b"needle original").unwrap();
        fs::write(root.join("second/two.txt"), b"needle second").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let checkpoints = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let sink = Arc::clone(&checkpoints);
        let report = move |_: &[Value], _: usize, _: u64, cp: Option<&Value>| {
            if let Some(cp) = cp {
                sink.lock().unwrap().push(cp.clone());
            }
        };
        let first = text_search_cancellable_controlled(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(100),
            (&AtomicBool::new(false), &AtomicBool::new(false), None),
            &report,
        )
        .unwrap();
        let cp = checkpoints
            .lock()
            .unwrap()
            .iter()
            .find(|cp| !cp["items"].as_array().unwrap().is_empty())
            .cloned()
            .unwrap();
        let resumed = text_search_cancellable_controlled(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(100),
            (&AtomicBool::new(false), &AtomicBool::new(false), Some(&cp)),
            &report,
        )
        .unwrap();
        assert_eq!(resumed["items"], first["items"]);
        let previous_file = cp["items"][0]["path"].as_str().unwrap();
        fs::write(previous_file, b"needle changed").unwrap();
        let rejected = text_search_cancellable_controlled(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(100),
            (&AtomicBool::new(false), &AtomicBool::new(false), Some(&cp)),
            &report,
        );
        assert!(rejected
            .unwrap_err()
            .to_string()
            .contains("invalid_search_checkpoint"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_content_checkpoint_rejects_forged_matches_and_foreign_paths() {
        let root = env::temp_dir().join(format!("wc-content-policy-{}", Uuid::new_v4()));
        let outside = env::temp_dir().join(format!("wc-content-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let mut candidate = json!({
            "version": 1, "searchType": "content",
            "root": root.to_string_lossy(), "query": "needle",
            "caseSensitive": false, "pending": [outside.to_string_lossy()],
            "items": [], "scannedEntries": 1, "scannedBytes": 0
        });
        let report = |_: &[Value], _: usize, _: u64, _: Option<&Value>| {};
        let check = |checkpoint: &Value| {
            text_search_cancellable_controlled(
                &policy,
                root.to_str().unwrap(),
                "needle",
                false,
                Some(100),
                (
                    &AtomicBool::new(false),
                    &AtomicBool::new(false),
                    Some(checkpoint),
                ),
                &report,
            )
        };
        assert!(check(&candidate).is_err());
        candidate["pending"] = json!([root.to_string_lossy()]);
        candidate["items"] = json!([{"path": "fabricated"}]);
        assert!(check(&candidate).is_err());
        candidate["items"] = json!([]);
        candidate["scannedBytes"] = json!(MAX_TEXT_SEARCH_BYTES + 1);
        assert!(check(&candidate).is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn native_filename_checkpoint_resumes_pending_directories_without_duplicate_matches() {
        let root = env::temp_dir().join(format!("wc-checkpoint-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/needle-one.txt"), b"hello").unwrap();
        fs::write(root.join("b/needle-two.txt"), b"hello").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let checkpoints = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let checkpoint_sink = Arc::clone(&checkpoints);
        let emit = move |_: &[Value], _: usize, _: u64, checkpoint: Option<&Value>| {
            if let Some(checkpoint) = checkpoint {
                checkpoint_sink.lock().unwrap().push(checkpoint.clone());
            }
        };
        let first = search_cancellable_controlled(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(100),
            (&AtomicBool::new(false), &AtomicBool::new(false), None),
            &emit,
        )
        .unwrap();
        let snapshot = {
            let saved = checkpoints.lock().unwrap();
            saved
                .iter()
                .find(|value| !value["items"].as_array().unwrap().is_empty())
                .cloned()
                .unwrap_or_else(|| saved[0].clone())
        };
        let resumed = search_cancellable_controlled(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(100),
            (
                &AtomicBool::new(false),
                &AtomicBool::new(false),
                Some(&snapshot),
            ),
            &emit,
        )
        .unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 2);
        assert_eq!(
            resumed["items"].as_array().unwrap(),
            first["items"].as_array().unwrap()
        );
        assert!(
            resumed["scannedEntries"].as_u64().unwrap()
                >= snapshot["scannedEntries"].as_u64().unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn filename_checkpoint_rejects_injected_directory_and_modified_query() {
        let root = env::temp_dir().join(format!("wc-checkpoint-policy-{}", Uuid::new_v4()));
        let outside = env::temp_dir().join(format!("wc-checkpoint-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let forged = json!({
            "version": 1, "root": root.to_string_lossy(), "query": "needle",
            "caseSensitive": false, "pending": [outside.to_string_lossy()],
            "items": [], "scannedEntries": 1
        });
        let noop = |_: &[Value], _: usize, _: u64, _: Option<&Value>| {};
        let invoke = |checkpoint: &Value| {
            search_cancellable_controlled(
                &policy,
                root.to_str().unwrap(),
                "needle",
                false,
                Some(100),
                (
                    &AtomicBool::new(false),
                    &AtomicBool::new(false),
                    Some(checkpoint),
                ),
                &noop,
            )
        };
        assert!(invoke(&forged)
            .unwrap_err()
            .to_string()
            .contains("invalid_search_checkpoint"));
        let mut altered = forged.clone();
        altered["query"] = json!("other");
        assert!(invoke(&altered)
            .unwrap_err()
            .to_string()
            .contains("invalid_search_checkpoint"));

        // A forged checkpoint can claim a safe pending directory while
        // smuggling arbitrary old matches. Reject both foreign paths and
        // fabricated metadata even when the directory cursor is valid.
        fs::write(outside.join("needle-foreign.txt"), b"outside").unwrap();
        fs::write(root.join("needle-real.txt"), b"inside").unwrap();
        let mut injected = forged.clone();
        injected["pending"] = json!([root.to_string_lossy()]);
        injected["items"] = json!([{
            "name": "needle-foreign.txt",
            "path": outside.join("needle-foreign.txt").to_string_lossy(),
            "type": "file",
            "size": 7
        }]);
        assert!(invoke(&injected)
            .unwrap_err()
            .to_string()
            .contains("invalid_search_checkpoint"));
        injected["items"] = json!([{
            "name": "needle-real.txt",
            "path": root.join("needle-real.txt").to_string_lossy(),
            "type": "file",
            "size": 999
        }]);
        assert!(invoke(&injected)
            .unwrap_err()
            .to_string()
            .contains("invalid_search_checkpoint"));
        // Replaying a directory twice can duplicate matches and bypass the
        // intended bounded progress accounting after a Gateway takeover.
        injected["items"] = json!([]);
        injected["pending"] = json!([root.to_string_lossy(), root.to_string_lossy()]);
        assert!(invoke(&injected)
            .unwrap_err()
            .to_string()
            .contains("invalid_search_checkpoint"));
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn native_filename_progress_streams_bounded_cumulative_snapshots() {
        let root = env::temp_dir().join(format!("wc-search-progress-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for i in 0..100 {
            fs::write(root.join(format!("needle-{i:03}.txt")), b"needle").unwrap();
        }
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let updates = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&updates);
        let report =
            move |items: &[Value], scanned: usize, bytes: u64, _checkpoint: Option<&Value>| {
                assert!(scanned >= 32);
                assert_eq!(bytes, 0);
                assert!(items.len() <= 100);
                observed.fetch_add(1, Ordering::Relaxed);
            };
        let found = search_cancellable_reporting(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(100),
            &AtomicBool::new(false),
            &report,
        )
        .unwrap();
        assert_eq!(found["items"].as_array().unwrap().len(), 100);
        assert!(updates.load(Ordering::Relaxed) > 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_content_progress_emits_before_final_result() {
        let root = env::temp_dir().join(format!("wc-content-progress-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for i in 0..80 {
            fs::write(root.join(format!("text-{i:03}.txt")), b"needle\n").unwrap();
        }
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let updates = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&updates);
        let report =
            move |items: &[Value], scanned: usize, bytes: u64, _checkpoint: Option<&Value>| {
                assert!(scanned >= 32 || items.len() >= 32);
                assert!(bytes <= MAX_TEXT_SEARCH_BYTES);
                assert!(items.len() <= 80);
                observed.fetch_add(1, Ordering::Relaxed);
            };
        let found = text_search_cancellable_reporting(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(100),
            &AtomicBool::new(false),
            &report,
        )
        .unwrap();
        assert_eq!(found["items"].as_array().unwrap().len(), 80);
        assert!(updates.load(Ordering::Relaxed) > 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_search_budget_returns_partial_result_marker_without_scanning() {
        let root = env::temp_dir().join(format!("wecommander-search-budget-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("needle.txt"), "needle in content").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let raw = root.to_str().unwrap();
        let past = Instant::now() - Duration::from_millis(1);
        let names = search_with_deadline(
            &policy,
            raw,
            "needle",
            false,
            Some(10),
            past,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(names["timedOut"], true);
        assert_eq!(names["truncated"], true);
        assert_eq!(names["scannedEntries"], 0);
        assert_eq!(names["items"].as_array().unwrap().len(), 0);
        let content = text_search_with_deadline(
            &policy,
            raw,
            "needle",
            false,
            Some(10),
            past,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(content["timedOut"], true);
        assert_eq!(content["truncated"], true);
        assert_eq!(content["scannedEntries"], 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_content_scan_bounds_reads_and_interrupts_between_chunks() {
        use std::io::{self, Cursor};

        let flag = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut oversized = Cursor::new(vec![b'x'; MAX_TEXT_SEARCH_FILE as usize + 1]);
        assert!(read_search_utf8(&mut oversized, &flag, deadline)
            .unwrap()
            .is_none());

        struct InterruptingReader<'a> {
            cancelled: &'a AtomicBool,
            emitted: bool,
        }
        impl Read for InterruptingReader<'_> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.emitted {
                    return Ok(0);
                }
                self.emitted = true;
                self.cancelled.store(true, Ordering::Relaxed);
                buf[0] = b'x';
                Ok(1)
            }
        }
        let mut reader = InterruptingReader {
            cancelled: &flag,
            emitted: false,
        };
        assert!(read_search_utf8(&mut reader, &flag, deadline)
            .unwrap_err()
            .to_string()
            .contains("search_cancelled"));

        flag.store(false, Ordering::Relaxed);
        let mut valid = Cursor::new("Türkçe içerik".as_bytes());
        assert_eq!(
            read_search_utf8(&mut valid, &flag, deadline)
                .unwrap()
                .as_deref(),
            Some("Türkçe içerik")
        );
        let mut invalid = Cursor::new([0xff, 0xfe]);
        assert!(read_search_utf8(&mut invalid, &flag, deadline)
            .unwrap()
            .is_none());
    }

    #[test]
    fn vanished_search_entries_are_ignored_without_following_symlinks() {
        let root = env::temp_dir().join(format!("wc-search-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let disappearing = root.join("disappearing.txt");
        fs::write(&disappearing, "needle").unwrap();
        assert!(search_metadata_if_present(&disappearing).unwrap().is_some());
        fs::remove_file(&disappearing).unwrap();
        assert!(search_metadata_if_present(&disappearing).unwrap().is_none());

        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let raw = root.to_str().unwrap();
        let cancelled = AtomicBool::new(false);
        let filenames =
            search_cancellable(&policy, raw, "disappearing", false, Some(10), &cancelled).unwrap();
        assert!(filenames["items"].as_array().unwrap().is_empty());
        let content =
            text_search_cancellable(&policy, raw, "needle", false, Some(10), &cancelled).unwrap();
        assert!(content["items"].as_array().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn bounded_native_reads_reject_symlink_swapped_after_metadata() {
        let root = env::temp_dir().join(format!("wc-open-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("original.txt");
        let outside = env::temp_dir().join(format!("wc-open-secret-{}", Uuid::new_v4()));
        fs::write(&target, "allowed").unwrap();
        fs::write(&outside, "private-secret").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        // Simulate the file replacement after the caller's metadata() check.
        assert!(search_metadata_if_present(&target)
            .unwrap()
            .unwrap()
            .is_file());
        fs::remove_file(&target).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &target).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &target).unwrap();
        assert!(open_regular_read(&target).is_err());
        // Ordinary tools must not read the replacement's contents either.
        // PathPolicy rejects the symlink destination before opening it.
        assert!(read(&policy, target.to_str().unwrap(), None).is_err());
        fs::remove_file(target).unwrap();
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_native_filename_search_reports_truncation_without_results() {
        let root = std::env::temp_dir().join(format!("wc-search-deadline-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("match.txt"), b"needle").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let cancelled = AtomicBool::new(false);
        let result = search_with_deadline(
            &policy,
            root.to_str().unwrap(),
            "match",
            false,
            Some(10),
            Instant::now() - Duration::from_secs(1),
            &cancelled,
        )
        .unwrap();
        assert_eq!(result["timedOut"], true);
        assert_eq!(result["truncated"], true);
        assert!(result["items"].as_array().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_native_content_search_reports_truncation_without_results() {
        let root = std::env::temp_dir().join(format!("wc-text-deadline-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("match.txt"), b"needle").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let cancelled = AtomicBool::new(false);
        let result = text_search_with_deadline(
            &policy,
            root.to_str().unwrap(),
            "needle",
            false,
            Some(10),
            Instant::now() - Duration::from_secs(1),
            &cancelled,
        )
        .unwrap();
        assert_eq!(result["timedOut"], true);
        assert_eq!(result["truncated"], true);
        assert!(result["items"].as_array().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_search_respects_pre_cancelled_requests() {
        let root = std::env::temp_dir().join(format!("wc-search-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("sample.txt"), b"needle").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let cancelled = AtomicBool::new(true);
        let raw = root.to_str().unwrap();
        assert!(
            search_cancellable(&policy, raw, "sample", false, Some(10), &cancelled)
                .unwrap_err()
                .to_string()
                .contains("search_cancelled")
        );
        assert!(
            text_search_cancellable(&policy, raw, "needle", false, Some(10), &cancelled)
                .unwrap_err()
                .to_string()
                .contains("search_cancelled")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod batch_read_tests {
    use super::*;
    use std::{env, fs};

    #[test]
    fn native_batch_read_isolates_errors_and_enforces_bounds() {
        let root = env::temp_dir().join(format!("wc-batch-{}", Uuid::new_v4()));
        let outside = env::temp_dir().join(format!("wc-batch-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("one.txt"), "hello").unwrap();
        fs::write(root.join("binary.dat"), [0xff, 0x00]).unwrap();
        fs::write(&outside, "secret outside allowed roots").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let paths = vec![
            root.join("one.txt").to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            root.join("binary.dat").to_string_lossy().into_owned(),
        ];
        let page = read_multiple(&policy, &paths, None).unwrap();
        assert_eq!(page["count"], 3);
        assert_eq!(page["items"][0]["data"]["content"], "hello");
        assert_eq!(page["items"][1]["ok"], false);
        assert_eq!(page["items"][1]["error"], "read_failed");
        assert_eq!(page["items"][2]["data"]["encoding"], "base64");
        assert!(read_multiple(&policy, &[], None).is_err());
        assert!(read_multiple(&policy, &vec![paths[0].clone(); 11], None).is_err());
        assert!(read_multiple(&policy, &paths, Some(65_537)).is_err());
        assert_eq!(
            read_multiple(&policy, &paths, Some(1)).unwrap()["items"][0]["ok"],
            false
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_file(outside).unwrap();
    }
}

#[cfg(test)]
mod mutation_concurrency_tests {
    use super::*;
    use std::{
        env, fs,
        sync::{Arc, Barrier},
    };

    #[test]
    fn concurrent_expected_sha_replacements_have_one_winner() {
        let root = env::temp_dir().join(format!("wc-edit-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("edit.txt");
        fs::write(&path, b"race-seed").unwrap();
        let policy = Arc::new(PathPolicy::new(std::slice::from_ref(&root)).unwrap());
        let expected = format!("{:x}", Sha256::digest(b"race-seed"));
        let barrier = Arc::new(Barrier::new(24));
        let mut workers = Vec::new();
        for index in 0..24 {
            let policy = Arc::clone(&policy);
            let barrier = Arc::clone(&barrier);
            let expected = expected.clone();
            let raw = path.to_string_lossy().into_owned();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                replace_text(
                    &policy,
                    &raw,
                    "race-seed",
                    &format!("winner-{index}"),
                    false,
                    Some(&expected),
                )
            }));
        }
        let mut success = 0;
        for worker in workers {
            match worker.join().unwrap() {
                Ok(_) => success += 1,
                Err(error) => assert_eq!(error.to_string(), "file_changed_since_read"),
            }
        }
        assert_eq!(success, 1);
        assert!(fs::read_to_string(&path).unwrap().starts_with("winner-"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_appends_obey_total_size_and_preserve_every_chunk() {
        let root = env::temp_dir().join(format!("wc-append-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("append.txt");
        let policy = Arc::new(PathPolicy::new(std::slice::from_ref(&root)).unwrap());
        let barrier = Arc::new(Barrier::new(16));
        let mut workers = Vec::new();
        for index in 0..16 {
            let policy = Arc::clone(&policy);
            let barrier = Arc::clone(&barrier);
            let raw = path.to_string_lossy().into_owned();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                append(
                    &policy,
                    &raw,
                    &STANDARD.encode(format!("{index:02}\n").as_bytes()),
                    None,
                    false,
                )
            }));
        }
        for worker in workers {
            assert_eq!(worker.join().unwrap().unwrap()["ok"], true);
        }
        let content = fs::read_to_string(&path).unwrap();
        let lines: std::collections::HashSet<_> = content.lines().collect();
        assert_eq!(lines.len(), 16);
        for index in 0..16 {
            assert!(lines.contains(format!("{index:02}").as_str()));
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod undo_version_tests {
    use super::*;
    use std::{env, fs};

    #[test]
    fn guarded_binary_append_undo_and_stale_sha() {
        let root = env::temp_dir().join(format!("wc-undo-append-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("binary.dat");
        let seed = [0_u8, 255, 42, 13];
        fs::write(&path, seed).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let seed_sha = format!("{:x}", Sha256::digest(seed));
        let appended = append(
            &policy,
            path.to_str().unwrap(),
            &STANDARD.encode([7_u8, 8]),
            Some(&seed_sha),
            true,
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), [0_u8, 255, 42, 13, 7, 8]);
        assert!(append(
            &policy,
            path.to_str().unwrap(),
            &STANDARD.encode([9_u8]),
            Some(&seed_sha),
            true,
        )
        .is_err());
        undo(
            &policy,
            path.to_str().unwrap(),
            appended["undoId"].as_str().unwrap(),
            appended["sha256"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), seed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_binary_write_undo_and_stale_sha() {
        let root = env::temp_dir().join(format!("wc-undo-write-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("binary.dat");
        let seed = [0_u8, 255, 42, 13];
        fs::write(&path, seed).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let seed_sha = format!("{:x}", Sha256::digest(seed));
        let written = write(
            &policy,
            path.to_str().unwrap(),
            &STANDARD.encode([5_u8, 4, 3]),
            false,
            Some(&seed_sha),
            true,
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), [5_u8, 4, 3]);
        assert!(write(
            &policy,
            path.to_str().unwrap(),
            &STANDARD.encode(b"stale"),
            false,
            Some(&seed_sha),
            true,
        )
        .is_err());
        undo(
            &policy,
            path.to_str().unwrap(),
            written["undoId"].as_str().unwrap(),
            written["sha256"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), seed);
        let missing = root.join("missing.txt");
        assert!(write(
            &policy,
            missing.to_str().unwrap(),
            &STANDARD.encode(b"new"),
            false,
            None,
            true,
        )
        .is_err());
        assert!(!missing.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persisted_undo_restores_only_matching_post_edit_bytes() {
        let root = env::temp_dir().join(format!("wc-undo-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("edit.txt");
        fs::write(&path, b"original").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let edited = replace_text(
            &policy,
            path.to_str().unwrap(),
            "original",
            "edited",
            false,
            None,
        )
        .unwrap();
        let id = edited["undoId"].as_str().unwrap();
        assert_eq!(
            versions(&policy, path.to_str().unwrap()).unwrap()["versions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(undo(&policy, path.to_str().unwrap(), id, &"0".repeat(64)).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"edited");
        // A new PathPolicy simulates recovery after an Agent restart.
        let restarted = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let restored = undo(
            &restarted,
            path.to_str().unwrap(),
            id,
            edited["sha256"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(restored["ok"], true);
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert!(undo(
            &restarted,
            path.to_str().unwrap(),
            id,
            edited["sha256"].as_str().unwrap()
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_undo_is_pruned_and_cannot_restore_stale_content() {
        let root = env::temp_dir().join(format!("wc-undo-expiry-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("edit.txt");
        fs::write(&path, b"original").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let edited = replace_text(
            &policy,
            path.to_str().unwrap(),
            "original",
            "edited",
            false,
            None,
        )
        .unwrap();
        let id = edited["undoId"].as_str().unwrap();
        let snapshot = undo_dir(&path, false).unwrap().unwrap().join(format!(
            "{}-{}.undo",
            undo_prefix(&path),
            id
        ));
        let file = fs::OpenOptions::new().write(true).open(&snapshot).unwrap();
        file.set_times(
            fs::FileTimes::new().set_modified(
                std::time::SystemTime::now() - UNDO_RETENTION - Duration::from_secs(60),
            ),
        )
        .unwrap();
        assert!(
            versions(&policy, path.to_str().unwrap()).unwrap()["versions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(!snapshot.exists());
        assert!(undo(
            &policy,
            path.to_str().unwrap(),
            id,
            edited["sha256"].as_str().unwrap()
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"edited");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_global_byte_quota_rejects_without_erasing_unknown_data() {
        let root = env::temp_dir().join(format!("wc-undo-budget-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("edit.txt");
        let snapshot = root.join("unknown-private-data");
        fs::write(&snapshot, b"123456").unwrap();
        assert!(ensure_undo_capacity(&root, &path, 5, 10, None).is_err());
        assert!(ensure_undo_capacity(&root, &path, 4, 10, None).is_ok());
        assert_eq!(fs::read(&snapshot).unwrap(), b"123456");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_write_and_append_undo_survive_policy_restart() {
        let root = env::temp_dir().join(format!("wc-undo-restart-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("restart.dat");
        fs::write(&path, b"before").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let written = write(
            &policy,
            path.to_str().unwrap(),
            &STANDARD.encode(b"middle"),
            false,
            None,
            true,
        )
        .unwrap();
        let restarted = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        assert_eq!(
            versions(&restarted, path.to_str().unwrap()).unwrap()["versions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let appended = append(
            &restarted,
            path.to_str().unwrap(),
            &STANDARD.encode(b"-after"),
            None,
            true,
        )
        .unwrap();
        let second_restart = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        undo(
            &second_restart,
            path.to_str().unwrap(),
            appended["undoId"].as_str().unwrap(),
            appended["sha256"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"middle");
        undo(
            &second_restart,
            path.to_str().unwrap(),
            written["undoId"].as_str().unwrap(),
            written["sha256"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"before");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupted_snapshot_and_wrong_path_do_not_overwrite_current_file() {
        let root = env::temp_dir().join(format!("wc-undo-negative-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("edit.txt");
        let other = root.join("other.txt");
        fs::write(&path, b"original").unwrap();
        fs::write(&other, b"edited").unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let edited = replace_text(
            &policy,
            path.to_str().unwrap(),
            "original",
            "edited",
            false,
            None,
        )
        .unwrap();
        let id = edited["undoId"].as_str().unwrap();
        assert!(undo(
            &policy,
            other.to_str().unwrap(),
            id,
            edited["sha256"].as_str().unwrap()
        )
        .is_err());
        let snapshot = undo_dir(&path, false).unwrap().unwrap().join(format!(
            "{}-{}.undo",
            undo_prefix(&path),
            id
        ));
        fs::write(&snapshot, b"{\"version\":1,\"contentBase64\":\"tampered\"}").unwrap();
        assert!(undo(
            &policy,
            path.to_str().unwrap(),
            id,
            edited["sha256"].as_str().unwrap()
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"edited");
        fs::remove_dir_all(root).unwrap();
    }
}
