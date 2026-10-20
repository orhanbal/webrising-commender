use crate::policy::PathPolicy;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};

const DEFAULT_READ_MAX: usize = 1024 * 1024;
const HARD_READ_MAX: usize = 4 * 1024 * 1024;
const HARD_WRITE_MAX: usize = 8 * 1024 * 1024;
const MAX_TREE_DEPTH: usize = 20;
const MAX_TREE_ENTRIES: usize = 5_000;
const MAX_SCAN_ENTRIES: usize = 100_000;
const MAX_SEARCH_RESULTS: usize = 500;
const MAX_TEXT_SEARCH_RESULTS: usize = 500;
const MAX_TEXT_SEARCH_FILE: u64 = 1024 * 1024;
const MAX_TEXT_SEARCH_BYTES: u64 = 64 * 1024 * 1024;

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

pub fn search(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    max_results: Option<usize>,
) -> Result<Value> {
    if query.trim().is_empty() {
        return Err(anyhow!("search query cannot be empty"));
    }
    if query.len() > 1024 {
        return Err(anyhow!("search query is too long"));
    }

    let root = policy.resolve_existing(raw)?;
    let result_limit = max_results.unwrap_or(100).clamp(1, MAX_SEARCH_RESULTS);
    let needle = query.to_lowercase();
    let mut results = Vec::new();
    let mut scanned = 0_usize;
    let mut stack = vec![root.clone()];
    let mut truncated = false;

    while let Some(path) = stack.pop() {
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_file() {
            scanned += 1;
            if file_name_matches(&path, &needle) {
                results.push(search_item(&path, &metadata));
            }
        } else if metadata.is_dir() {
            for entry in fs::read_dir(&path)? {
                let entry = entry?;
                scanned += 1;
                if scanned > MAX_SCAN_ENTRIES {
                    truncated = true;
                    break;
                }

                let file_type = entry.file_type()?;
                if file_name_matches(&entry.path(), &needle) {
                    let metadata = fs::symlink_metadata(entry.path())?;
                    results.push(search_item(&entry.path(), &metadata));
                    if results.len() >= result_limit {
                        truncated = true;
                        break;
                    }
                }
                if file_type.is_dir() {
                    stack.push(entry.path());
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
        "items": results,
        "truncated": truncated,
        "scannedEntries": scanned.min(MAX_SCAN_ENTRIES)
    }))
}

pub fn text_search(
    policy: &PathPolicy,
    raw: &str,
    query: &str,
    case_sensitive: bool,
    max_results: Option<usize>,
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

    while let Some(path) = stack.pop() {
        let metadata = fs::symlink_metadata(&path)?;

        if metadata.is_dir() {
            for entry in fs::read_dir(&path)? {
                let entry = entry?;
                scanned_entries += 1;
                if scanned_entries > MAX_SCAN_ENTRIES {
                    truncated = true;
                    break;
                }

                let file_type = entry.file_type()?;
                if file_type.is_dir() || file_type.is_file() {
                    stack.push(entry.path());
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
            scanned_bytes += metadata.len();

            let text = match fs::read_to_string(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };

            for (index, line) in text.lines().enumerate() {
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
    let mut file = fs::File::open(&path)?;
    file.by_ref()
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
    fs::write(&path, &bytes)?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy(), "size": bytes.len() }))
}

pub fn replace_text(
    policy: &PathPolicy,
    raw: &str,
    search: &str,
    replacement: &str,
    replace_all: bool,
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

    let original = fs::read_to_string(&path).context("file is not valid UTF-8 text")?;
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

    fs::write(&path, updated.as_bytes())?;
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "replacements": if replace_all { matches } else { 1 },
        "size": updated.len()
    }))
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

fn file_name_matches(path: &Path, needle: &str) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().to_lowercase().contains(needle))
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
