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

/// Sends bounded cumulative results during a native search without holding up the scanner.
pub type SearchProgressReporter = dyn Fn(&[Value], usize, u64) + Send + Sync;

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
        Instant::now() + MAX_SEARCH_DURATION,
        cancelled,
        Some(report),
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
        deadline,
        cancelled,
        None,
    )
}

fn search_with_deadline_reporting(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    deadline: Instant,
    cancelled: &AtomicBool,
    report: Option<&SearchProgressReporter>,
) -> Result<Value> {
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
    let mut truncated = false;
    let mut timed_out = false;
    let mut next_progress = 32_usize;

    while let Some(path) = stack.pop() {
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
                        report(&results, scanned.min(MAX_SCAN_ENTRIES), 0);
                    }
                    next_progress = scanned.saturating_add(32);
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

/// Open only a regular file without following a final-component symlink.
/// A file may be swapped after the directory entry's metadata check; a plain
/// File::open would otherwise follow that replacement outside allowed roots.
/// Parent-directory rename races still require descriptor-relative traversal.
fn open_regular_read(path: &Path) -> Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0o400000); // O_NOFOLLOW
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100); // O_NOFOLLOW
    }
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

/// Limit bytes read from a changing file and check cancellation between
/// bounded chunks. Invalid UTF-8 and oversized files are safely skipped.
fn read_search_utf8<R: Read>(
    reader: &mut R,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<String>> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("search_cancelled"));
        }
        if Instant::now() >= deadline {
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
        Instant::now() + MAX_SEARCH_DURATION,
        cancelled,
        Some(report),
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
        deadline,
        cancelled,
        None,
    )
}

fn text_search_with_deadline_reporting(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
    deadline: Instant,
    cancelled: &AtomicBool,
    report: Option<&SearchProgressReporter>,
) -> Result<Value> {
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
    let mut truncated = false;
    let mut timed_out = false;
    let mut next_progress = 32_usize;

    while let Some(path) = stack.pop() {
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
                Ok(mut file) => match read_search_utf8(&mut file, cancelled, deadline)? {
                    Some(value) => value,
                    None => {
                        if Instant::now() >= deadline {
                            timed_out = true;
                            truncated = true;
                            break;
                        }
                        continue;
                    }
                },
                Err(_) => continue,
            };
            if scanned_bytes.saturating_add(text.len() as u64) > MAX_TEXT_SEARCH_BYTES {
                truncated = true;
                break;
            }
            scanned_bytes += text.len() as u64;

            for (index, line) in text.lines().enumerate() {
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

    if create_parents {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
    }
    atomic_write(&path, &bytes)?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy(), "size": bytes.len() }))
}

/// Append without truncating, up to the configured size limits.
pub fn append(policy: &PathPolicy, raw: &str, content_base64: &str) -> Result<Value> {
    let path = policy.resolve_for_create(raw)?;
    let bytes = STANDARD
        .decode(content_base64)
        .context("contentBase64 is not valid base64")?;
    if bytes.len() > HARD_WRITE_MAX {
        return Err(anyhow!(
            "append exceeds hard limit of {HARD_WRITE_MAX} bytes"
        ));
    }
    let existing_size = fs::metadata(&path).map(|item| item.len()).unwrap_or(0);
    if existing_size.saturating_add(bytes.len() as u64) > 128 * 1024 * 1024 {
        return Err(anyhow!("append exceeds total file limit of 128 MiB"));
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
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

    atomic_write(&path, updated.as_bytes())?;
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "replacements": if replace_all { matches } else { 1 },
        "previousSha256": previous_sha256,
        "sha256": format!("{:x}", Sha256::digest(updated.as_bytes())),
        "size": updated.len()
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
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn move_path(policy: &PathPolicy, source: &str, destination: &str) -> Result<Value> {
    let source_path = policy.resolve_existing(source)?;
    if policy.roots().iter().any(|root| root == &source_path) {
        return Err(anyhow!("refusing to move an allowed root"));
    }

    let destination_path = policy.resolve_for_create(destination)?;
    if destination_path.exists() {
        return Err(anyhow!("destination already exists"));
    }

    fs::rename(&source_path, &destination_path)?;
    Ok(json!({
        "ok": true,
        "source": source_path.to_string_lossy(),
        "destination": destination_path.to_string_lossy()
    }))
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
    use std::{env, fs, sync::atomic::AtomicUsize};

    #[test]
    fn native_filename_progress_streams_bounded_cumulative_snapshots() {
        let root = env::temp_dir().join(format!("wc-search-progress-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for i in 0..100 {
            fs::write(root.join(format!("needle-{i:03}.txt")), b"needle").unwrap();
        }
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let updates = AtomicUsize::new(0);
        let report = |items: &[Value], scanned: usize, bytes: u64| {
            assert!(scanned >= 32);
            assert_eq!(bytes, 0);
            assert!(items.len() <= 100);
            updates.fetch_add(1, Ordering::Relaxed);
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
        let updates = AtomicUsize::new(0);
        let report = |items: &[Value], scanned: usize, bytes: u64| {
            assert!(scanned >= 32 || items.len() >= 32);
            assert!(bytes <= MAX_TEXT_SEARCH_BYTES);
            assert!(items.len() <= 80);
            updates.fetch_add(1, Ordering::Relaxed);
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
