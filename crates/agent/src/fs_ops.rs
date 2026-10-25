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
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = options.open(path)?;
        if !file.metadata()?.is_file() {
            return Err(anyhow!("path is not a regular file"));
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
        Ok(file)
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
    if create_parents {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
    }
    // Opt-in undo never silently overwrites a missing, oversized or symlink
    // target. The existing unguarded API remains backward compatible.
    let previous = if with_undo || expected_sha256.is_some() {
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
    } else {
        None
    };
    let next_sha = format!("{:x}", Sha256::digest(&bytes));
    let snapshot = if with_undo {
        let (original, previous_sha) = previous
            .as_ref()
            .ok_or_else(|| anyhow!("undo_requires_existing_file"))?;
        let (id, snapshot_path) = save_undo_snapshot(&path, original, previous_sha, &next_sha)?;
        Some((id, snapshot_path, previous_sha.clone()))
    } else {
        None
    };
    if let Err(error) = atomic_write(&path, &bytes) {
        if let Some((_, snapshot_path, _)) = &snapshot {
            let _ = fs::remove_file(snapshot_path);
        }
        return Err(error);
    }
    let mut response = json!({
        "ok": true, "path": path.to_string_lossy(), "size": bytes.len()
    });
    if let Some((id, _, previous_sha)) = snapshot {
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
            )?)
        } else {
            None
        };
        if let Err(error) = atomic_write(&path, &updated) {
            if let Some((_, snapshot_path)) = &snapshot {
                let _ = fs::remove_file(snapshot_path);
            }
            return Err(error);
        }
        let mut response = json!({
            "ok": true, "path": path.to_string_lossy(), "appendedBytes": bytes.len(),
            "previousSha256": previous_sha, "sha256": next_sha
        });
        if let Some((id, _)) = snapshot {
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

pub fn replace_text(
    policy: &PathPolicy,
    raw: &str,
    search: &str,
    replacement: &str,
    replace_all: bool,
    expected_sha256: Option<&str>,
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
    let (undo_id, snapshot) =
        save_undo_snapshot(&path, original.as_bytes(), &previous_sha256, &next_sha256)?;
    if let Err(error) = atomic_write(&path, updated.as_bytes()) {
        let _ = fs::remove_file(&snapshot);
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

// Protect the shared snapshot directory budget and pruning from concurrent
// writes/restores to different files in the same Agent process.
static UNDO_DIRECTORY_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

fn undo_directory_lock() -> Result<std::sync::MutexGuard<'static, ()>> {
    UNDO_DIRECTORY_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .map_err(|_| anyhow!("undo_directory_lock_poisoned"))
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

fn undo_storage_usage(dir: &Path) -> Result<(usize, u64)> {
    let mut count = 0_usize;
    let mut total_bytes = 0_u64;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(anyhow!("unsafe_undo_storage_entry"));
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let expired = undo_snapshot_name(&name)
            && metadata
                .modified()
                .ok()
                .and_then(|modified| std::time::SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age >= UNDO_RETENTION);
        if expired {
            fs::remove_file(entry.path())?;
            continue;
        }
        count += 1;
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| anyhow!("undo_snapshot_quota_exceeded"))?;
    }
    Ok((count, total_bytes))
}

fn ensure_undo_capacity(dir: &Path, path: &Path, incoming: u64, max_total: u64) -> Result<()> {
    let (count, used_bytes) = undo_storage_usage(dir)?;
    if undo_entries(path, dir)?.len() >= MAX_UNDO_PER_FILE
        || count >= MAX_UNDO_PER_DIRECTORY
        || used_bytes
            .checked_add(incoming)
            .is_none_or(|bytes| bytes > max_total)
    {
        return Err(anyhow!("undo_snapshot_quota_exceeded"));
    }
    Ok(())
}

fn undo_prefix(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()))
}

fn undo_dir(_path: &Path, create: bool) -> Result<Option<std::path::PathBuf>> {
    // Never place plaintext undo snapshots beside source files: allowlisted
    // workspaces may also be publicly served web roots.
    let data_root =
        dirs::data_local_dir().ok_or_else(|| anyhow!("local data directory unavailable"))?;
    if create {
        fs::create_dir_all(&data_root)?;
    }
    let app_root = data_root.join("webrising-commender");
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
    Ok(Some(dir))
}

fn undo_entries(path: &Path, dir: &Path) -> Result<Vec<(String, u64)>> {
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
        result.push((id.to_owned(), meta.len()));
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}

fn save_undo_snapshot(
    path: &Path,
    previous: &[u8],
    previous_sha: &str,
    next_sha: &str,
) -> Result<(String, std::path::PathBuf)> {
    let _directory_guard = undo_directory_lock()?;
    let dir = undo_dir(path, true)?.ok_or_else(|| anyhow!("undo_directory_unavailable"))?;
    let id = Uuid::new_v4().to_string();
    let filename = format!("{}-{}.undo", undo_prefix(path), id);
    let destination = dir.join(filename);
    let temporary = dir.join(format!(".{}.tmp", Uuid::new_v4()));
    let payload = serde_json::to_vec(&json!({
        "version": 1,
        "path": path.to_string_lossy(),
        "previousSha256": previous_sha,
        "nextSha256": next_sha,
        "contentBase64": STANDARD.encode(previous)
    }))?;
    if payload.len() as u64 > MAX_UNDO_FILE_BYTES {
        return Err(anyhow!("undo_snapshot_too_large"));
    }
    ensure_undo_capacity(&dir, path, payload.len() as u64, MAX_UNDO_TOTAL_BYTES)?;
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&payload)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &destination)?;
        #[cfg(unix)]
        fs::File::open(&dir)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        let _ = fs::remove_file(&destination);
    }
    result?;
    Ok((id, destination))
}

/// List bounded, disk-persisted undo snapshots for an allowlisted regular file.
pub fn versions(policy: &PathPolicy, raw: &str) -> Result<Value> {
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
            undo_storage_usage(&dir)?;
            undo_entries(&path, &dir)?
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
pub fn undo(policy: &PathPolicy, raw: &str, undo_id: &str, expected_sha256: &str) -> Result<Value> {
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
    undo_storage_usage(&dir)?;
    let snapshot = dir.join(format!("{}-{}.undo", undo_prefix(&path), id));
    let mut reader = open_regular_read(&snapshot)?;
    let mut encoded = Vec::new();
    std::io::Read::by_ref(&mut reader)
        .take(MAX_UNDO_FILE_BYTES + 1)
        .read_to_end(&mut encoded)?;
    if encoded.len() as u64 > MAX_UNDO_FILE_BYTES {
        return Err(anyhow!("undo_snapshot_too_large"));
    }
    let record: Value = serde_json::from_slice(&encoded).context("invalid_undo_snapshot")?;
    if record["version"] != 1 || record["path"].as_str() != Some(path.to_string_lossy().as_ref()) {
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
    atomic_write(&path, &previous)?;
    let consumed = fs::remove_file(&snapshot).is_ok();
    Ok(json!({
        "ok": true, "path": path.to_string_lossy(),
        "sha256": format!("{:x}", Sha256::digest(&previous)),
        "previousSha256": current_sha, "undoConsumed": consumed
    }))
}

/// Stage writes beside their target so incomplete writes never truncate
/// an existing file. Keep the original intact if rename cannot replace it.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("missing parent directory"))?;
    let temporary = parent.join(format!(".wecommander-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        if let Ok(existing) = fs::metadata(path) {
            file.set_permissions(existing.permissions())?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path).context("atomic replace failed")?;
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
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Move without ever replacing a destination created by another process.
/// Checking destination.exists() before fs::rename is not an atomic guard:
/// Unix rename replaces existing files and Windows MoveFileEx can also replace.
/// Pin each parent directory before an atomic rename. PathPolicy canonicalization
/// alone is insufficient when another process swaps an ancestor to a symlink
/// between authorization and renameat2/renameatx_np.
#[cfg(unix)]
fn rename_parent_handle(path: &Path) -> Result<(fs::File, std::ffi::CString)> {
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

pub fn mkdir(policy: &PathPolicy, raw: &str, recursive: bool) -> Result<Value> {
    let path = policy.resolve_for_create(raw)?;
    if recursive {
        fs::create_dir_all(&path)?;
    } else {
        fs::create_dir(&path)?;
    }
    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
}

pub fn delete(policy: &PathPolicy, raw: &str, recursive: bool) -> Result<Value> {
    let path = policy.resolve_existing(raw)?;
    if policy.roots().iter().any(|root| root == &path) {
        return Err(anyhow!("refusing to delete an allowed root"));
    }

    let metadata = fs::symlink_metadata(&path)?;
    if metadata.is_dir() {
        if recursive {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_dir(&path)?;
        }
    } else {
        fs::remove_file(&path)?;
    }

    Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
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
    fn undo_global_byte_quota_rejects_without_erasing_existing_snapshot() {
        let root = env::temp_dir().join(format!("wc-undo-budget-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("edit.txt");
        let snapshot = root.join(format!("{}-{}.undo", undo_prefix(&path), Uuid::new_v4()));
        fs::write(&snapshot, b"123456").unwrap();
        assert!(ensure_undo_capacity(&root, &path, 5, 10).is_err());
        assert!(ensure_undo_capacity(&root, &path, 4, 10).is_ok());
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
