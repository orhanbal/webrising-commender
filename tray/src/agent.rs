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
