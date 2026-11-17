//! Setup helper: adds WECOMMANDER (`<core exe> --mcp-stdio`) to an AI
//! client's MCP configuration, keeping everything else in the file.
//!
//! | client | file | entry |
//! |---|---|---|
//! | `claude-desktop` | `%APPDATA%\Claude\claude_desktop_config.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`, `~/.config/Claude/claude_desktop_config.json` | `mcpServers.wecommander = {command, args}` |
//! | `claude-code` | `~/.claude.json` (user scope) | `mcpServers.wecommander = {type: "stdio", command, args, env: {}}` |
//! | `cursor` | `~/.cursor/mcp.json` | `mcpServers.wecommander = {command, args}` |
//! | `codex` | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `[mcp_servers.wecommander] command, args` |
//!
//! A file that is not valid JSON/TOML is never overwritten
//! (`config_invalid`). Writing keeps a `.bak` copy of the old file and
//! replaces the file atomically. JSON keys come back sorted (serde_json);
//! TOML keeps its formatting and comments.
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

pub const SERVER_NAME: &str = "wecommander";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Client {
    ClaudeDesktop,
    ClaudeCode,
    Cursor,
    Codex,
}

impl Client {
    pub fn parse(name: &str) -> Result<Self, String> {
        Ok(match name {
            "claude-desktop" => Self::ClaudeDesktop,
            "claude-code" => Self::ClaudeCode,
            "cursor" => Self::Cursor,
            "codex" => Self::Codex,
            other => return Err(format!("unknown_client: {other}")),
        })
    }
}

/// Where the clients keep their files on this computer.
#[derive(Clone, Debug)]
pub struct Dirs {
    pub home: PathBuf,
    /// `%APPDATA%` (Windows).
    pub appdata: Option<PathBuf>,
    /// `$CODEX_HOME`.
    pub codex_home: Option<PathBuf>,
    pub os: &'static str,
}

impl Dirs {
    pub fn current() -> Self {
        let var = |n: &str| {
            std::env::var_os(n)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Self {
            home: var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .unwrap_or_else(|| PathBuf::from(".")),
            appdata: var("APPDATA"),
            codex_home: var("CODEX_HOME"),
            os: std::env::consts::OS,
        }
    }
}

pub fn config_path(client: Client, dirs: &Dirs) -> PathBuf {
    match client {
        Client::ClaudeDesktop => match dirs.os {
            "windows" => dirs
                .appdata
                .clone()
                .unwrap_or_else(|| dirs.home.join("AppData").join("Roaming"))
                .join("Claude"),
            "macos" => dirs
                .home
                .join("Library")
                .join("Application Support")
                .join("Claude"),
            _ => dirs.home.join(".config").join("Claude"),
        }
        .join("claude_desktop_config.json"),
        Client::ClaudeCode => dirs.home.join(".claude.json"),
        Client::Cursor => dirs.home.join(".cursor").join("mcp.json"),
        Client::Codex => dirs
            .codex_home
            .clone()
            .unwrap_or_else(|| dirs.home.join(".codex"))
            .join("config.toml"),
    }
}

/// What `mcp.configFor` returns: the file and its text before and after.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub path: String,
    pub before: String,
    pub after: String,
    pub changed: bool,
}

fn merge_json(client: Client, before: &str, command: &[String]) -> Result<String, String> {
    let mut root: Value = if before.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(before).map_err(|e| {
            format!("config_invalid: the file is not valid JSON ({e}); fix it first")
        })?
    };
    let obj = root
        .as_object_mut()
        .ok_or("config_invalid: the file is not a JSON object")?;
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("config_invalid: mcpServers is not an object")?;
    let (exe, args) = command.split_first().ok_or("no bridge command")?;
    let entry = if client == Client::ClaudeCode {
        json!({ "type": "stdio", "command": exe, "args": args, "env": {} })
    } else {
        json!({ "command": exe, "args": args })
    };
    servers.insert(SERVER_NAME.into(), entry);
    let mut text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    text.push('\n');
    Ok(text)
}

fn merge_toml(before: &str, command: &[String]) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut = before
        .parse()
        .map_err(|e| format!("config_invalid: the file is not valid TOML ({e}); fix it first"))?;
    let (exe, args) = command.split_first().ok_or("no bridge command")?;
    if !doc.contains_key("mcp_servers") {
        let mut t = toml_edit::Table::new();
        t.set_implicit(true);
        doc.insert("mcp_servers", toml_edit::Item::Table(t));
    }
    let servers = doc["mcp_servers"]
        .as_table_mut()
        .ok_or("config_invalid: mcp_servers is not a table")?;
    let mut entry = toml_edit::Table::new();
    entry.insert("command", toml_edit::value(exe.as_str()));
    let mut list = toml_edit::Array::new();
    for a in args {
        list.push(a.as_str());
    }
    entry.insert("args", toml_edit::value(list));
    servers.insert(SERVER_NAME, toml_edit::Item::Table(entry));
    Ok(doc.to_string())
}

/// The change `write` would make (nothing is written).
pub fn plan(client: Client, dirs: &Dirs, command: &[String]) -> Result<Plan, String> {
    let path = config_path(client, dirs);
    let before = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("config_unreadable: {}: {e}", path.display())),
    };
    let after = match client {
        Client::Codex => merge_toml(&before, command)?,
        _ => merge_json(client, &before, command)?,
    };
    Ok(Plan {
        path: path.to_string_lossy().into_owned(),
        changed: after != before,
        before,
        after,
    })
}

/// Result of `mcp.writeConfig`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub path: String,
    /// The previous file, when there was one.
    pub backup: Option<String>,
    pub changed: bool,
}

/// Writes the merged file: old file copied to `<file>.bak`, new content
/// written to a temp file and renamed over it. With `expected_before` (the
/// `before` the person saw from [`plan`]), a file changed meanwhile is
/// refused with `config_changed`.
pub fn write(
    client: Client,
    dirs: &Dirs,
    command: &[String],
    expected_before: Option<&str>,
) -> Result<Written, String> {
    let p = plan(client, dirs, command)?;
    if expected_before.is_some_and(|b| b != p.before) {
        return Err(format!(
            "config_changed: {} changed since it was shown; look at the change again",
            p.path
        ));
    }
    let path = PathBuf::from(&p.path);
    if !p.changed {
        return Ok(Written {
            path: p.path,
            backup: None,
            changed: false,
        });
    }
    let fail = |e: std::io::Error| format!("config_write_failed: {}: {e}", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
    }
    let backup = if path.exists() {
        let bak = backup_path(&path);
        std::fs::copy(&path, &bak).map_err(fail)?;
        Some(bak.to_string_lossy().into_owned())
    } else {
        None
    };
    let tmp = path.with_extension("wc-tmp");
    std::fs::write(&tmp, p.after.as_bytes()).map_err(fail)?;
    if let Ok(meta) = std::fs::metadata(&path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
    }
    std::fs::rename(&tmp, &path).map_err(fail)?;
    Ok(Written {
        path: p.path,
        backup,
        changed: true,
    })
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(tag: &str, os: &'static str) -> Dirs {
        let home = std::env::temp_dir().join(format!("wc-mcp-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        Dirs {
            appdata: Some(home.join("AppData").join("Roaming")),
            codex_home: None,
            home,
            os,
        }
    }

    fn cmd() -> Vec<String> {
        vec![
            r"C:\Program Files\WECOMMANDER\wecommander-core.exe".into(),
            "--mcp-stdio".into(),
        ]
    }

    #[test]
    fn paths_per_client_and_os() {
        let d = dirs("paths", "windows");
        assert!(config_path(Client::ClaudeDesktop, &d)
            .ends_with("AppData/Roaming/Claude/claude_desktop_config.json"));
        let mac = Dirs {
            os: "macos",
            ..d.clone()
        };
        assert!(config_path(Client::ClaudeDesktop, &mac)
            .ends_with("Library/Application Support/Claude/claude_desktop_config.json"));
        assert!(config_path(Client::ClaudeCode, &d).ends_with(".claude.json"));
        assert!(config_path(Client::Cursor, &d).ends_with(".cursor/mcp.json"));
        assert!(config_path(Client::Codex, &d).ends_with(".codex/config.toml"));
        let codex = Dirs {
            codex_home: Some(d.home.join("ch")),
            ..d.clone()
        };
        assert!(config_path(Client::Codex, &codex).ends_with("ch/config.toml"));
        assert!(Client::parse("vim")
            .unwrap_err()
            .starts_with("unknown_client"));
        let _ = std::fs::remove_dir_all(&d.home);
    }

    #[test]
    fn json_clients_merge_without_losing_entries() {
        for (client, tag) in [
            (Client::ClaudeDesktop, "desktop"),
            (Client::ClaudeCode, "code"),
            (Client::Cursor, "cursor"),
        ] {
            let d = dirs(tag, "windows");
            let path = config_path(client, &d);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let before = r#"{"theme":"dark","mcpServers":{"github":{"command":"gh-mcp","args":["serve"]},"wecommander":{"command":"old.exe"}},"projects":{"a":{"x":1}}}"#;
            std::fs::write(&path, before).unwrap();
            let plan = plan(client, &d, &cmd()).unwrap();
            assert_eq!(plan.before, before);
            let after: Value = serde_json::from_str(&plan.after).unwrap();
            assert_eq!(after["theme"], "dark");
            assert_eq!(after["projects"]["a"]["x"], 1);
            assert_eq!(after["mcpServers"]["github"]["command"], "gh-mcp");
            let entry = &after["mcpServers"]["wecommander"];
            assert_eq!(entry["command"], cmd()[0].as_str());
            assert_eq!(entry["args"], json!(["--mcp-stdio"]));
            assert_eq!(entry.get("type").is_some(), client == Client::ClaudeCode);
            // Nothing written by plan.
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
            let w = write(client, &d, &cmd(), None).unwrap();
            assert!(w.changed);
            assert_eq!(std::fs::read_to_string(w.backup.unwrap()).unwrap(), before);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), plan.after);
            // Second time: nothing to do.
            assert!(!write(client, &d, &cmd(), None).unwrap().changed);
            let _ = std::fs::remove_dir_all(&d.home);
        }
    }

    #[test]
    fn missing_file_is_created_and_invalid_one_kept() {
        let d = dirs("new", "linux");
        let w = write(Client::Cursor, &d, &cmd(), None).unwrap();
        assert!(w.changed && w.backup.is_none());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&w.path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["wecommander"]["args"][0], "--mcp-stdio");
        std::fs::write(&w.path, "{ broken").unwrap();
        assert!(write(Client::Cursor, &d, &cmd(), None)
            .unwrap_err()
            .starts_with("config_invalid"));
        assert_eq!(std::fs::read_to_string(&w.path).unwrap(), "{ broken");
        std::fs::write(&w.path, r#"{"mcpServers": []}"#).unwrap();
        assert!(plan(Client::Cursor, &d, &cmd())
            .unwrap_err()
            .starts_with("config_invalid"));
        let _ = std::fs::remove_dir_all(&d.home);
    }

    #[test]
    fn codex_toml_keeps_comments_and_other_servers() {
        let d = dirs("codex", "linux");
        let path = config_path(Client::Codex, &d);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let before = "# my settings\nmodel = \"gpt-5\"\n\n[mcp_servers.github]\ncommand = \"gh-mcp\" # keep me\nargs = [\"serve\"]\n\n[mcp_servers.wecommander]\ncommand = \"old\"\n";
        std::fs::write(&path, before).unwrap();
        let p = plan(Client::Codex, &d, &cmd()).unwrap();
        assert!(p.after.starts_with("# my settings\nmodel = \"gpt-5\"\n"));
        assert!(p.after.contains("command = \"gh-mcp\" # keep me"));
        let doc: toml_edit::DocumentMut = p.after.parse().unwrap();
        assert_eq!(
            doc["mcp_servers"]["wecommander"]["command"].as_str(),
            Some(cmd()[0].as_str())
        );
        assert_eq!(
            doc["mcp_servers"]["wecommander"]["args"]
                .as_array()
                .unwrap()
                .get(0)
                .and_then(|v| v.as_str()),
            Some("--mcp-stdio")
        );
        assert!(!p.after.contains("\"old\""));
        assert!(write(Client::Codex, &d, &cmd(), Some("other"))
            .unwrap_err()
            .starts_with("config_changed"));
        let w = write(Client::Codex, &d, &cmd(), Some(before)).unwrap();
        assert!(w.backup.is_some());
        // A new file gets a [mcp_servers.wecommander] table.
        let fresh = dirs("codex-new", "linux");
        let p = plan(Client::Codex, &fresh, &cmd()).unwrap();
        assert!(p.after.contains("[mcp_servers.wecommander]"), "{}", p.after);
        std::fs::create_dir_all(config_path(Client::Codex, &fresh).parent().unwrap()).unwrap();
        std::fs::write(config_path(Client::Codex, &fresh), "mcp_servers = 3\n").unwrap();
        assert!(plan(Client::Codex, &fresh, &cmd())
            .unwrap_err()
            .starts_with("config_invalid"));
        std::fs::write(config_path(Client::Codex, &fresh), "[[[").unwrap();
        assert!(plan(Client::Codex, &fresh, &cmd())
            .unwrap_err()
            .starts_with("config_invalid"));
        let _ = std::fs::remove_dir_all(&d.home);
        let _ = std::fs::remove_dir_all(&fresh.home);
    }
}
