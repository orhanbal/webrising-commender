use crate::policy::PathPolicy;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{fs, io::Read};

const DEFAULT_READ_MAX: usize = 1024 * 1024;
const HARD_READ_MAX: usize = 4 * 1024 * 1024;
const HARD_WRITE_MAX: usize = 8 * 1024 * 1024;

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
