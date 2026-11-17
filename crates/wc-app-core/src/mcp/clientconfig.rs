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
//! replaces the file atomically. JSON keeps its key order and the text of
//! every other value; TOML keeps its formatting and comments.
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::value::RawValue;
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
    pub const ALL: [Client; 4] = [
        Client::ClaudeDesktop,
        Client::ClaudeCode,
        Client::Cursor,
        Client::Codex,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::ClaudeDesktop => "claude-desktop",
            Self::ClaudeCode => "claude-code",
            Self::Cursor => "cursor",
            Self::Codex => "codex",
        }
    }

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

/// A JSON value kept as it was written (`Raw`) or an object whose entries
/// keep their order (`Map`): only the objects on the way to our entry are
/// rebuilt, everything else is written back byte for byte.
#[derive(Serialize)]
#[serde(untagged)]
enum Node {
    Raw(Box<RawValue>),
    Map(IndexMap<String, Node>),
    List(Vec<Node>),
}

fn object(text: &str, what: &str) -> Result<IndexMap<String, Node>, String> {
    let map: IndexMap<String, Box<RawValue>> = serde_json::from_str(text)
        .map_err(|e| format!("config_invalid: {what} is not a JSON object ({e}); fix it first"))?;
    Ok(map.into_iter().map(|(k, v)| (k, Node::Raw(v))).collect())
}

fn raw(value: Value) -> Result<Node, String> {
    RawValue::from_string(value.to_string())
        .map(Node::Raw)
        .map_err(|e| e.to_string())
}

fn merge_json(client: Client, before: &str, command: &[String]) -> Result<String, String> {
    let mut root = if before.trim().is_empty() {
        IndexMap::new()
    } else {
        object(before, "the file")?
    };
    let mut servers = match root.shift_remove("mcpServers") {
        Some(Node::Raw(r)) => object(r.get(), "mcpServers")?,
        _ => IndexMap::new(),
    };
    let (exe, args) = command.split_first().ok_or("no bridge command")?;
    let mut entry = IndexMap::new();
    if client == Client::ClaudeCode {
        entry.insert("type".to_owned(), raw(json!("stdio"))?);
    }
    entry.insert("command".to_owned(), raw(json!(exe))?);
    let args = args
        .iter()
        .map(|a| raw(json!(a)))
        .collect::<Result<_, _>>()?;
    entry.insert("args".to_owned(), Node::List(args));
    if client == Client::ClaudeCode {
        entry.insert("env".to_owned(), raw(json!({}))?);
    }
    // An existing entry is replaced in place; a new one goes last.
    servers.insert(SERVER_NAME.to_owned(), Node::Map(entry));
    let had_servers = !before.trim().is_empty() && before.contains("\"mcpServers\"");
    let position = if had_servers {
        // Put mcpServers back where it was.
        let original: IndexMap<String, Box<RawValue>> =
            serde_json::from_str(before).map_err(|e| e.to_string())?;
        original.get_index_of("mcpServers")
    } else {
        None
    };
    root.insert("mcpServers".to_owned(), Node::Map(servers));
    if let Some(i) = position {
        let last = root.len() - 1;
        root.move_index(last, i.min(last));
    }
    let mut text = serde_json::to_string_pretty(&Node::Map(root)).map_err(|e| e.to_string())?;
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

/// A WECOMMANDER entry in a client's config whose program is gone (the app
/// moved or was reinstalled elsewhere): event `mcp-config-stale`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stale {
    pub client: &'static str,
    /// The config file.
    pub path: String,
    /// The program the entry starts, which no longer exists.
    pub command: String,
}

/// The `command` of our entry in `text` (the client's config), if any.
fn entry_command(client: Client, text: &str) -> Option<String> {
    if client == Client::Codex {
        let doc: toml_edit::DocumentMut = text.parse().ok()?;
        return doc
            .get("mcp_servers")?
            .get(SERVER_NAME)?
            .get("command")?
            .as_str()
            .map(str::to_owned);
    }
    let v: Value = serde_json::from_str(text).ok()?;
    v.get("mcpServers")?
        .get(SERVER_NAME)?
        .get("command")?
        .as_str()
        .map(str::to_owned)
}

/// Known clients whose WECOMMANDER entry points at a program that is gone.
/// Only reported: the person decides whether to rewrite the entry. A bare
/// program name (found through PATH) is not checked.
pub fn stale_entries(dirs: &Dirs) -> Vec<Stale> {
    Client::ALL
        .iter()
        .filter_map(|&client| {
            let path = config_path(client, dirs);
            let text = std::fs::read_to_string(&path).ok()?;
            let command = entry_command(client, &text)?;
            let is_path = command.contains('/') || command.contains('\\');
            (is_path && !Path::new(&command).exists()).then(|| Stale {
                client: client.name(),
                path: path.to_string_lossy().into_owned(),
                command,
            })
        })
        .collect()
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
    fn json_merge_keeps_order_and_other_text() {
        let d = dirs("order", "linux");
        let before = "{\n  \"zeta\": 1,\n  \"mcpServers\": {\n    \"zz\": {\n      \"command\": \"z\"\n    },\n    \"aa\": {\n      \"command\": \"a\"\n    }\n  },\n  \"alpha\": [\n    1,\n    2\n  ]\n}\n";
        let path = config_path(Client::Cursor, &d);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, before).unwrap();
        let after = plan(Client::Cursor, &d, &cmd()).unwrap().after;
        let expected = format!(
            "{{\n  \"zeta\": 1,\n  \"mcpServers\": {{\n    \"zz\": {{\n      \"command\": \"z\"\n    }},\n    \"aa\": {{\n      \"command\": \"a\"\n    }},\n    \"wecommander\": {{\n      \"command\": {},\n      \"args\": [\n        \"--mcp-stdio\"\n      ]\n    }}\n  }},\n  \"alpha\": [\n    1,\n    2\n  ]\n}}\n",
            serde_json::to_string(&cmd()[0]).unwrap()
        );
        assert_eq!(after, expected);
        // Writing it again changes nothing; an existing entry stays in place.
        std::fs::write(&path, &after).unwrap();
        assert!(!plan(Client::Cursor, &d, &cmd()).unwrap().changed);
        let _ = std::fs::remove_dir_all(&d.home);
    }

    #[test]
    fn stale_entries_are_reported_not_rewritten() {
        let d = dirs("stale", "linux");
        let exe = d.home.join("wecommander-core");
        std::fs::write(&exe, "").unwrap();
        let here = vec![exe.to_string_lossy().into_owned(), "--mcp-stdio".into()];
        let gone = vec![
            d.home
                .join("old")
                .join("wecommander-core")
                .to_string_lossy()
                .into_owned(),
            "--mcp-stdio".into(),
        ];
        write(Client::Cursor, &d, &here, None).unwrap();
        write(Client::Codex, &d, &gone, None).unwrap();
        write(Client::ClaudeCode, &d, &gone, None).unwrap();
        let desktop = config_path(Client::ClaudeDesktop, &d);
        std::fs::create_dir_all(desktop.parent().unwrap()).unwrap();
        // Found through PATH: not checked.
        std::fs::write(
            &desktop,
            r#"{"mcpServers":{"wecommander":{"command":"wecommander-core"}}}"#,
        )
        .unwrap();
        let before = std::fs::read_to_string(config_path(Client::Codex, &d)).unwrap();
        let stale = stale_entries(&d);
        let names: Vec<_> = stale.iter().map(|s| s.client).collect();
        assert_eq!(names, ["claude-code", "codex"]);
        assert_eq!(stale[1].command, gone[0]);
        assert!(stale[1].path.ends_with("config.toml"));
        assert_eq!(
            std::fs::read_to_string(config_path(Client::Codex, &d)).unwrap(),
            before
        );
        let _ = std::fs::remove_dir_all(&d.home);
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
