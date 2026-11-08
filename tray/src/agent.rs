//! The WECOMMANDER agent on this computer. On Linux it is the systemd
//! service webrising-commender.service (scripts/install-linux.sh): reading
//! its state needs no privileges, switching it on or off goes through
//! `pkexec systemctl` (the desktop asks for an administrator password).
//! systemd already restarts it when it crashes (Restart=always), so the
//! Management Center only reports a stop and never prompts on its own.
use serde::Serialize;

pub const UNIT: &str = "webrising-commender.service";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    /// "running", "stopped" or "notInstalled".
    pub state: &'static str,
    /// Starts with the computer (systemd "enabled").
    pub enabled: bool,
    pub label: &'static str,
}

impl AgentView {
    pub fn running(&self) -> bool {
        self.state == "running"
    }
}

/// From `systemctl show -p LoadState -p ActiveState -p UnitFileState <unit>`.
pub fn parse_show(output: &str) -> AgentView {
    let value = |key: &str| {
        output
            .lines()
            .find_map(|l| l.strip_prefix(key).and_then(|v| v.strip_prefix('=')))
            .unwrap_or("")
            .trim()
            .to_owned()
    };
    let load = value("LoadState");
    let active = value("ActiveState");
    let file = value("UnitFileState");
    let enabled = file == "enabled" || file == "enabled-runtime";
    let state = if load != "loaded" {
        "notInstalled"
    } else if active == "active" || active == "activating" || active == "reloading" {
        "running"
    } else {
        "stopped"
    };
    AgentView {
        state,
        enabled,
        label: label(state, enabled),
    }
}

pub fn label(state: &str, enabled: bool) -> &'static str {
    match (state, enabled) {
        ("running", _) => "Ajan çalışıyor",
        ("notInstalled", _) => "Ajan kurulu değil",
        (_, false) => "Ajan kapalı",
        _ => "Ajan durdu",
    }
}

/// "0.1.1676" from `webrising-commender --version`.
pub fn parse_version(output: &str) -> Option<String> {
    let last = output.split_whitespace().last()?;
    last.chars()
        .next()
        .filter(char::is_ascii_digit)
        .map(|_| last.to_owned())
}

/// The installed agent's version (Debian package path first, then the
/// manual install path).
#[cfg(target_os = "linux")]
pub fn installed_version() -> Option<String> {
    [
        "/opt/wecommander/bin/webrising-commender",
        "/usr/local/bin/webrising-commender",
    ]
    .iter()
    .find_map(|bin| {
        let out = std::process::Command::new(bin)
            .arg("--version")
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| parse_version(&String::from_utf8_lossy(&out.stdout)))
            .flatten()
    })
}

#[cfg(not(target_os = "linux"))]
pub fn installed_version() -> Option<String> {
    None
}

/// The official one-line installer for this server (it asks for sudo).
pub fn update_command(server: &str) -> String {
    format!(
        "curl -fsSL {}/install.sh | sh",
        server.trim_end_matches('/')
    )
}

/// Opens a terminal window running the installer and waiting for Enter.
#[cfg(target_os = "linux")]
pub fn open_update_terminal(server: &str) -> Result<(), String> {
    let script = format!(
        "{}; echo; printf 'Kapatmak için Enter tuşuna bas. '; read _",
        update_command(server)
    );
    for (term, args) in [
        ("x-terminal-emulator", vec!["-e", "sh", "-c"]),
        ("gnome-terminal", vec!["--", "sh", "-c"]),
        ("konsole", vec!["-e", "sh", "-c"]),
        ("xfce4-terminal", vec!["-x", "sh", "-c"]),
        ("xterm", vec!["-e", "sh", "-c"]),
    ] {
        let spawned = std::process::Command::new(term)
            .args(&args)
            .arg(&script)
            .spawn();
        if spawned.is_ok() {
            return Ok(());
        }
    }
    Err(format!(
        "Terminal açılamadı. Bir terminalde çalıştır: {}",
        update_command(server)
    ))
}

#[cfg(not(target_os = "linux"))]
pub fn open_update_terminal(server: &str) -> Result<(), String> {
    Err(format!(
        "Bir terminalde çalıştır: {}",
        update_command(server)
    ))
}

pub const STOPPED_NOTICE: &str =
    "Bu bilgisayardaki ajan durdu. Yapay zekâ bu bilgisayara erişemez. Paneldeki \"Ajan çalışsın\" ile yeniden başlatabilirsin.";

#[cfg(target_os = "linux")]
pub fn status() -> Option<AgentView> {
    let out = std::process::Command::new("systemctl")
        .args([
            "show",
            "-p",
            "LoadState",
            "-p",
            "ActiveState",
            "-p",
            "UnitFileState",
            UNIT,
        ])
        .output()
        .ok()?;
    Some(parse_show(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(target_os = "linux"))]
pub fn status() -> Option<AgentView> {
    None
}

/// On: enable and start; off: stop and disable (stays off after a reboot).
#[cfg(target_os = "linux")]
pub fn set_enabled(on: bool) -> Result<(), String> {
    let verb = if on { "enable" } else { "disable" };
    let status = std::process::Command::new("pkexec")
        .args(["systemctl", verb, "--now", UNIT])
        .status()
        .map_err(|_| {
            "pkexec bulunamadı; terminalde: sudo systemctl ".to_owned() + verb + " --now " + UNIT
        })?;
    match status.code() {
        Some(0) => Ok(()),
        Some(126) | Some(127) => Err("Yönetici onayı verilmedi.".into()),
        _ => Err(format!(
            "Ajan {} (systemctl {verb}).",
            if on {
                "başlatılamadı"
            } else {
                "durdurulamadı"
            }
        )),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn set_enabled(_on: bool) -> Result<(), String> {
    Err("Bu sistemde ajan buradan yönetilmiyor.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_and_update_command() {
        assert_eq!(
            parse_version("webrising-commender 0.1.1676\n").as_deref(),
            Some("0.1.1676")
        );
        assert_eq!(parse_version("error: nope"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(
            update_command("https://wecommander.app/"),
            "curl -fsSL https://wecommander.app/install.sh | sh"
        );
    }

    #[test]
    fn parses_systemctl_show() {
        let running = parse_show("LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n");
        assert_eq!(running.state, "running");
        assert!(running.enabled);
        assert_eq!(running.label, "Ajan çalışıyor");
        let off = parse_show("ActiveState=inactive\nUnitFileState=disabled\nLoadState=loaded\n");
        assert_eq!(
            (off.state, off.enabled, off.label),
            ("stopped", false, "Ajan kapalı")
        );
        let failed = parse_show("LoadState=loaded\nActiveState=failed\nUnitFileState=enabled\n");
        assert_eq!(failed.label, "Ajan durdu");
        let missing = parse_show("LoadState=not-found\nActiveState=inactive\nUnitFileState=\n");
        assert_eq!(missing.state, "notInstalled");
        assert!(!missing.running());
    }
}
