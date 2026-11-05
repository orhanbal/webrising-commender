//! `log_query` (v1.2, AD1-05): bounded, filtered reads of system and file
//! logs. Read-only. Sources:
//!
//! - `journal` (Linux): `journalctl -o json` with a time window, priority and
//!   unit, newest first. Needs the agent account to read the journal
//!   (`systemd-journal` or `adm` group); otherwise the result says so.
//!   Governed by the `systemLogs` device capability.
//! - `file`: the tail (last 8 MiB) of a log file inside the allowed roots.
//!   Files have no structured time, so `since_minutes` does not apply.
//!
//! Every source honours `level`, a case-insensitive `pattern` (regex), a
//! line `limit` and a byte budget, and groups repeated messages. Output
//! secrets are masked by the redaction layer in ops.rs.
use crate::policy::PathPolicy;
use anyhow::{anyhow, Result};
use regex::{Regex, RegexBuilder};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::time::Duration;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1000;
const MAX_MESSAGE_CHARS: usize = 2000;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const FILE_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const JOURNAL_SCAN_ENTRIES: usize = 20_000;
const JOURNAL_MAX_STDOUT: usize = 48 * 1024 * 1024;
const JOURNAL_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_SINCE_MINUTES: u64 = 7 * 24 * 60;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Level {
    Error = 0,
    Warning = 1,
    Info = 2,
    Debug = 3,
}

impl Level {
    fn parse(raw: Option<&str>) -> Result<Self> {
        Ok(match raw.unwrap_or("info") {
            "error" => Self::Error,
            "warning" => Self::Warning,
            "info" => Self::Info,
            "debug" => Self::Debug,
            other => {
                return Err(anyhow!(
                    "invalid level {other}: use error, warning, info or debug"
                ))
            }
        })
    }
    fn name(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Info => "info",
            Self::Debug => "debug",
        }
    }
    /// syslog priority 0-7 -> level.
    fn from_priority(p: u8) -> Self {
        match p {
            0..=3 => Self::Error,
            4 => Self::Warning,
            5 | 6 => Self::Info,
            _ => Self::Debug,
        }
    }
    /// Best-effort level of a plain text log line.
    fn from_text(line: &str) -> Self {
        static WORDS: std::sync::LazyLock<[Regex; 3]> = std::sync::LazyLock::new(|| {
            [
                Regex::new(r"(?i)\b(fatal|panic|crit(ical)?|emerg|alert|err(or)?|exception|fail(ed|ure)?)\b").unwrap(),
                Regex::new(r"(?i)\bwarn(ing)?\b").unwrap(),
                Regex::new(r"(?i)\b(debug|trace)\b").unwrap(),
            ]
        });
        if WORDS[0].is_match(line) {
            Self::Error
        } else if WORDS[1].is_match(line) {
            Self::Warning
        } else if WORDS[2].is_match(line) {
            Self::Debug
        } else {
            Self::Info
        }
    }
}

pub struct Query {
    pub source: String,
    pub path: Option<String>,
    pub unit: Option<String>,
    pub since_minutes: Option<u64>,
    pub level: Option<String>,
    pub pattern: Option<String>,
    pub limit: Option<usize>,
}

struct Entry {
    time: Option<String>,
    level: Level,
    unit: Option<String>,
    message: String,
}

fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_owned(),
    }
}

/// Message shape for grouping: digits, hex ids and quoted values vary.
fn shape(message: &str) -> String {
    static VARIABLE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r#"0x[0-9a-fA-F]+|\b[0-9a-fA-F]{8,}\b|\d+|"[^"]*"|'[^']*'"#).unwrap()
    });
    let shaped = VARIABLE.replace_all(message, "#");
    truncate_chars(&shaped, 200)
}

fn finish(
    source: &str,
    entries: Vec<Entry>,
    scanned: usize,
    scan_truncated: bool,
    limit: usize,
    mut limitations: Vec<String>,
) -> Value {
    let matched = entries.len();
    let mut groups: HashMap<String, (usize, String)> = HashMap::new();
    for entry in &entries {
        let slot = groups
            .entry(shape(&entry.message))
            .or_insert((0, entry.message.clone()));
        slot.0 += 1;
    }
    let mut groups: Vec<_> = groups
        .into_values()
        .filter(|(count, _)| *count > 1)
        .collect();
    groups.sort_by_key(|g| std::cmp::Reverse(g.0));
    groups.truncate(10);

    let mut items = Vec::new();
    let mut bytes = 0;
    let mut budget_hit = false;
    for entry in entries.into_iter().take(limit) {
        let item = json!({
            "time": entry.time,
            "level": entry.level.name(),
            "unit": entry.unit,
            "message": truncate_chars(&entry.message, MAX_MESSAGE_CHARS),
        });
        bytes += item.to_string().len();
        if bytes > MAX_OUTPUT_BYTES {
            budget_hit = true;
            break;
        }
        items.push(item);
    }
    if scan_truncated {
        limitations.push("scan stopped at its bound; older entries were not searched".into());
    }
    if budget_hit {
        limitations.push(format!("output stopped at {} KiB", MAX_OUTPUT_BYTES / 1024));
    }
    let observed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    json!({
        "observedAt": crate::system_ops::rfc3339(observed),
        "source": source,
        "order": "newest_first",
        "scanned": scanned,
        "matched": matched,
        "returned": items.len(),
        "truncated": matched > items.len() || scan_truncated,
        "entries": items,
        "repeated": groups.into_iter().map(|(count, sample)| json!({ "count": count, "sample": truncate_chars(&sample, 300) })).collect::<Vec<_>>(),
        "limitations": limitations,
    })
}

fn compile(pattern: Option<&str>) -> Result<Option<Regex>> {
    let Some(pattern) = pattern.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    if pattern.len() > 512 {
        return Err(anyhow!("pattern is longer than 512 characters"));
    }
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(1 << 20)
        .dfa_size_limit(1 << 20)
        .build()
        .map(Some)
        .map_err(|error| anyhow!("invalid pattern: {error}"))
}

/// One `journalctl -o json` line -> entry.
fn journal_entry(line: &str) -> Option<Entry> {
    let value: Value = serde_json::from_str(line).ok()?;
    let message = match value.get("MESSAGE")? {
        Value::String(text) => text.clone(),
        // Binary messages come as byte arrays.
        Value::Array(bytes) => {
            let raw: Vec<u8> = bytes
                .iter()
                .filter_map(|b| b.as_u64().map(|b| b as u8))
                .collect();
            String::from_utf8_lossy(&raw).into_owned()
        }
        _ => return None,
    };
    let priority = value
        .get("PRIORITY")
        .and_then(Value::as_str)
        .and_then(|p| p.parse::<u8>().ok())
        .unwrap_or(6);
    let time = value
        .get("__REALTIME_TIMESTAMP")
        .and_then(Value::as_str)
        .and_then(|us| us.parse::<u64>().ok())
        .map(|us| crate::system_ops::rfc3339(us / 1_000_000));
    let unit = ["_SYSTEMD_UNIT", "SYSLOG_IDENTIFIER", "_COMM"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_owned));
    Some(Entry {
        time,
        level: Level::from_priority(priority),
        unit,
        message,
    })
}

fn valid_unit(unit: &str) -> bool {
    !unit.is_empty()
        && unit.len() <= 256
        && !unit.starts_with('-')
        && unit
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._:-\\".contains(c))
}

async fn journal(
    query: &Query,
    level: Level,
    pattern: Option<Regex>,
    limit: usize,
) -> Result<Value> {
    if !cfg!(target_os = "linux") {
        return Err(anyhow!(
            "unavailable: the journal source exists only on Linux"
        ));
    }
    let since = query
        .since_minutes
        .unwrap_or(60)
        .clamp(1, MAX_SINCE_MINUTES);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let max_priority = match level {
        Level::Error => 3,
        Level::Warning => 4,
        Level::Info => 6,
        Level::Debug => 7,
    };
    let mut command = tokio::process::Command::new("journalctl");
    command
        .args(["--no-pager", "--quiet", "-o", "json", "-r"])
        .arg(format!("--since=@{}", now.saturating_sub(since * 60)))
        .arg(format!("--priority=0..{max_priority}"))
        .arg(format!("--lines={JOURNAL_SCAN_ENTRIES}"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(unit) = query.unit.as_deref().filter(|u| !u.is_empty()) {
        if !valid_unit(unit) {
            return Err(anyhow!("invalid unit name"));
        }
        command.arg(format!("--unit={unit}"));
    }
    let mut child = command
        .spawn()
        .map_err(|error| anyhow!("unavailable: journalctl could not start: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("journalctl stdout missing"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("journalctl stderr missing"))?;
    let read = async {
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        (&mut stdout)
            .take(JOURNAL_MAX_STDOUT as u64)
            .read_to_end(&mut out)
            .await?;
        let mut err = Vec::new();
        (&mut stderr).take(64 * 1024).read_to_end(&mut err).await?;
        let status = child.wait().await?;
        Ok::<_, anyhow::Error>((out, err, status))
    };
    let (out, err, status) =
        tokio::time::timeout(JOURNAL_TIMEOUT, read)
            .await
            .map_err(|_| {
                anyhow!(
                    "journalctl did not finish within {} s",
                    JOURNAL_TIMEOUT.as_secs()
                )
            })??;
    let err = String::from_utf8_lossy(&err);
    let mut limitations = vec![format!("time window: last {since} minutes")];
    if !status.success() && out.is_empty() {
        return Err(anyhow!(
            "journalctl failed: {}",
            truncate_chars(err.trim(), 300)
        ));
    }
    if err.contains("not seeing messages from other users")
        || err.contains("No journal files were opened due to insufficient permissions")
    {
        limitations.push("the agent account cannot read the whole journal; add it to the systemd-journal group to see all units".into());
    }
    let text = String::from_utf8_lossy(&out);
    let mut scanned = 0;
    let mut entries = Vec::new();
    for line in text.lines() {
        scanned += 1;
        let Some(entry) = journal_entry(line) else {
            continue;
        };
        if entry.level > level {
            continue;
        }
        if pattern
            .as_ref()
            .is_some_and(|re| !re.is_match(&entry.message))
        {
            continue;
        }
        entries.push(entry);
    }
    Ok(finish(
        "journal",
        entries,
        scanned,
        scanned >= JOURNAL_SCAN_ENTRIES || out.len() >= JOURNAL_MAX_STDOUT,
        limit,
        limitations,
    ))
}

fn file(
    policy: &PathPolicy,
    query: &Query,
    level: Level,
    pattern: Option<Regex>,
    limit: usize,
) -> Result<Value> {
    let raw = query
        .path
        .as_deref()
        .ok_or_else(|| anyhow!("path is required for the file source"))?;
    let path = policy.resolve_existing(raw)?;
    if !path.is_file() {
        return Err(anyhow!("path is not a file"));
    }
    let mut handle = crate::fs_ops::open_regular_read(&path)?;
    let size = handle.metadata()?.len();
    let start = size.saturating_sub(FILE_TAIL_BYTES);
    handle.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    handle.take(FILE_TAIL_BYTES).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // partial first line
    }
    let mut limitations = vec![
        "levels of plain text lines are guessed from words such as ERROR and WARN".to_string(),
    ];
    if query.since_minutes.is_some() {
        limitations.push("since_minutes does not apply to files (no structured time)".into());
    }
    if start > 0 {
        limitations.push(format!(
            "only the last {} MiB of the file were read",
            FILE_TAIL_BYTES / 1024 / 1024
        ));
    }
    let scanned = lines.len();
    let entries: Vec<Entry> = lines
        .into_iter()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .map(|line| Entry {
            time: None,
            level: Level::from_text(line),
            unit: None,
            message: line.to_owned(),
        })
        .filter(|entry| entry.level <= level)
        .filter(|entry| {
            pattern
                .as_ref()
                .is_none_or(|re| re.is_match(&entry.message))
        })
        .collect();
    Ok(finish(
        "file",
        entries,
        scanned,
        start > 0,
        limit,
        limitations,
    ))
}

pub async fn query(policy: &PathPolicy, query: Query) -> Result<Value> {
    let level = Level::parse(query.level.as_deref())?;
    let pattern = compile(query.pattern.as_deref())?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    match query.source.as_str() {
        "journal" => journal(&query, level, pattern, limit).await,
        "file" => file(policy, &query, level, pattern, limit),
        other => Err(anyhow!("unsupported log source {other}: use journal or file (Windows Event Log and macOS unified log are planned)")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_journal_lines() {
        let entry = journal_entry(r#"{"MESSAGE":"Failed password for root","PRIORITY":"3","__REALTIME_TIMESTAMP":"1793916000000000","_SYSTEMD_UNIT":"ssh.service"}"#).unwrap();
        assert_eq!(entry.level, Level::Error);
        assert_eq!(entry.unit.as_deref(), Some("ssh.service"));
        assert_eq!(entry.time.as_deref(), Some("2026-11-05T22:00:00Z"));
        let binary = journal_entry(r#"{"MESSAGE":[104,105],"SYSLOG_IDENTIFIER":"x"}"#).unwrap();
        assert_eq!((binary.message.as_str(), binary.level), ("hi", Level::Info));
        assert!(journal_entry("not json").is_none());
        assert!(journal_entry(r#"{"PRIORITY":"3"}"#).is_none());
    }

    #[test]
    fn guesses_text_levels_and_validates_input() {
        assert_eq!(Level::from_text("2026 ERROR db down"), Level::Error);
        assert_eq!(Level::from_text("connection failed"), Level::Error);
        assert_eq!(Level::from_text("[warn] slow"), Level::Warning);
        assert_eq!(Level::from_text("started"), Level::Info);
        assert!(Level::parse(Some("loud")).is_err());
        assert!(compile(Some("(")).is_err());
        assert!(compile(Some(&"a".repeat(600))).is_err());
        assert!(valid_unit("ssh.service") && valid_unit("user@1000.service"));
        assert!(!valid_unit("--all") && !valid_unit("a b") && !valid_unit(""));
    }

    #[test]
    fn groups_repeated_messages() {
        assert_eq!(
            shape("user 42 from 10.0.0.7 port 51234"),
            shape("user 7 from 10.0.0.9 port 2")
        );
        let entries = (0..5)
            .map(|i| Entry {
                time: None,
                level: Level::Error,
                unit: None,
                message: format!("Failed password for root from 10.0.0.{i}"),
            })
            .chain(std::iter::once(Entry {
                time: None,
                level: Level::Info,
                unit: None,
                message: "ok".into(),
            }))
            .collect();
        let out = finish("file", entries, 6, false, 2, vec![]);
        assert_eq!(out["matched"], 6);
        assert_eq!(out["returned"], 2);
        assert_eq!(out["truncated"], true);
        assert_eq!(out["repeated"][0]["count"], 5);
    }

    #[tokio::test]
    async fn reads_file_tail_with_filters() {
        let root = std::env::temp_dir().join(format!("wc-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let log = root.join("app.log");
        std::fs::write(
            &log,
            "start\nWARN slow disk\nERROR db timeout id=1\ninfo ok\nERROR db timeout id=2\n",
        )
        .unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let q = |level: &str, pattern: Option<&str>| Query {
            source: "file".into(),
            path: Some(log.to_string_lossy().into_owned()),
            unit: None,
            since_minutes: None,
            level: Some(level.into()),
            pattern: pattern.map(str::to_owned),
            limit: None,
        };
        let errors = query(&policy, q("error", None)).await.unwrap();
        assert_eq!(errors["matched"], 2);
        assert_eq!(
            errors["entries"][0]["message"], "ERROR db timeout id=2",
            "newest first"
        );
        assert_eq!(errors["repeated"][0]["count"], 2);
        assert_eq!(
            query(&policy, q("warning", None)).await.unwrap()["matched"],
            3
        );
        assert_eq!(
            query(&policy, q("info", Some("DISK"))).await.unwrap()["matched"],
            1
        );
        let mut outside = q("info", None);
        outside.path = Some("/etc/hostname".into());
        assert!(query(&policy, outside).await.is_err());
        let mut bad = q("info", None);
        bad.source = "syslog".into();
        assert!(query(&policy, bad).await.is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
