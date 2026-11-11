//! The agent shipped inside the app (Linux desktop): `webrising-commender`
//! next to the app binary. The app pairs it with a one-time code from the
//! signed-in account and runs it as a child process: no root, no systemd
//! unit, no terminal. The agent exits with the app (WECOMMANDER_PARENT_PID);
//! the app starts at login. Computers with the systemd service
//! (scripts/install-linux.sh, servers) keep using that instead.
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const EXE_NAME: &str = "webrising-commender";
pub const PARENT_ENV: &str = "WECOMMANDER_PARENT_PID";
const BACKOFF: [Duration; 3] = [
    Duration::from_secs(0),
    Duration::from_secs(30),
    Duration::from_secs(120),
];

#[derive(Debug, PartialEq, Eq)]
pub enum Tick {
    None,
    Started,
    GaveUp,
}

pub struct Embedded {
    pub exe: PathBuf,
    pub config: PathBuf,
    child: Option<Child>,
    failures: usize,
    last_attempt: Option<Instant>,
    gave_up: bool,
    pub last_error: Option<String>,
}

impl Embedded {
    pub fn new(exe: PathBuf, config: PathBuf) -> Self {
        Self {
            exe,
            config,
            child: None,
            failures: 0,
            last_attempt: None,
            gave_up: false,
            last_error: None,
        }
    }

    /// The agent next to this app; the pairing where the agent keeps it.
    pub fn for_this_app() -> Option<Self> {
        let exe = std::env::current_exe().ok()?.parent()?.join(EXE_NAME);
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        Some(Self::new(
            exe,
            config_home.join("webrising-commender").join("agent.json"),
        ))
    }

    pub fn default_root() -> Option<PathBuf> {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("WECOMMANDER"))
    }

    pub fn available(&self) -> bool {
        is_executable(&self.exe)
    }

    pub fn paired(&self) -> bool {
        self.config.is_file()
    }

    pub fn running(&mut self) -> bool {
        match &mut self.child {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// "running", "stopped" or "notInstalled" (not paired yet).
    pub fn state(&mut self) -> &'static str {
        if self.running() {
            "running"
        } else if self.paired() {
            "stopped"
        } else {
            "notInstalled"
        }
    }

    pub fn run_args(&self) -> Vec<String> {
        vec![
            "--config".into(),
            self.config.display().to_string(),
            "run".into(),
        ]
    }

    pub fn enroll_args(&self, server: &str, code: &str, root: &Path) -> Vec<String> {
        vec![
            "--config".into(),
            self.config.display().to_string(),
            "enroll".into(),
            "--control-url".into(),
            server.trim_end_matches('/').into(),
            "--pairing-code".into(),
            code.into(),
            "--allowed-root".into(),
            root.display().to_string(),
        ]
    }

    /// Pairs this computer. An existing pairing is kept as agent.json.bak and
    /// put back when the new one fails. The code never appears in errors.
    pub fn pair(&mut self, server: &str, code: &str, root: &Path) -> Result<(), String> {
        let backup = self.config.with_extension("json.bak");
        let was_running = self.running();
        let fail = |this: &mut Self, why: String| {
            if !this.paired() && backup.is_file() {
                let _ = std::fs::rename(&backup, &this.config);
            }
            if was_running {
                this.start();
            }
            let message = format!("Bu bilgisayar hesaba bağlanamadı: {}", redact(&why, code));
            this.last_error = Some(message.clone());
            Err(message)
        };
        if let Err(e) = std::fs::create_dir_all(root) {
            return fail(self, e.to_string());
        }
        if let Some(dir) = self.config.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                return fail(self, e.to_string());
            }
        }
        self.stop();
        if self.paired() {
            if let Err(e) = std::fs::copy(&self.config, &backup)
                .and_then(|_| std::fs::remove_file(&self.config))
            {
                return fail(self, e.to_string());
            }
        }
        let output = Command::new(&self.exe)
            .args(self.enroll_args(server, code, root))
            .stdin(Stdio::null())
            .output();
        match output {
            Ok(out) if out.status.success() && self.paired() => {
                self.last_error = None;
                self.reset();
                Ok(())
            }
            Ok(out) => {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                fail(self, text)
            }
            Err(e) => fail(self, e.to_string()),
        }
    }

    /// Starts the paired agent in the background; true while it runs.
    pub fn start(&mut self) -> bool {
        if self.running() {
            return true;
        }
        self.child = None;
        if !self.available() {
            self.last_error =
                Some("Uygulamanın içindeki ajan bulunamadı; uygulamayı yeniden kur.".into());
            return false;
        }
        if !self.paired() {
            return false;
        }
        match Command::new(&self.exe)
            .args(self.run_args())
            .env(PARENT_ENV, std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                self.child = Some(child);
                self.last_error = None;
                true
            }
            Err(e) => {
                self.last_error = Some(format!("Ajan başlatılamadı: {e}"));
                false
            }
        }
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn reset(&mut self) {
        self.failures = 0;
        self.gave_up = false;
        self.last_attempt = None;
    }

    /// Every few seconds: while wanted and paired, starts it again after it
    /// stopped (0 s, 30 s, 2 min, then gives up once).
    pub fn tick(&mut self, keep_running: bool, now: Instant) -> Tick {
        if self.running() {
            self.reset();
            return Tick::None;
        }
        if !keep_running || !self.paired() {
            return Tick::None;
        }
        if self.failures >= BACKOFF.len() {
            if self.gave_up {
                return Tick::None;
            }
            self.gave_up = true;
            return Tick::GaveUp;
        }
        if self
            .last_attempt
            .is_some_and(|t| now.duration_since(t) < BACKOFF[self.failures])
        {
            return Tick::None;
        }
        self.last_attempt = Some(now);
        self.failures += 1;
        self.start();
        Tick::Started
    }

    /// `webrising-commender --version` of the bundled agent.
    pub fn version(&self) -> Option<String> {
        let out = Command::new(&self.exe).arg("--version").output().ok()?;
        out.status
            .success()
            .then(|| crate::agent::parse_version(&String::from_utf8_lossy(&out.stdout)))
            .flatten()
    }
}

impl Drop for Embedded {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn redact(text: &str, secret: &str) -> String {
    let mut t = text.trim().to_owned();
    if !secret.is_empty() {
        t = t.replace(secret, "[REDACTED]");
    }
    if t.chars().count() > 300 {
        t = t.chars().take(300).collect::<String>() + "…";
    }
    if t.is_empty() {
        "bilinmeyen hata".into()
    } else {
        t
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fake agent: `enroll` writes the config (or fails with the code in its
    /// output when FAIL is set), `run` sleeps until killed.
    fn fake_agent(dir: &Path, fail: bool) -> PathBuf {
        let exe = dir.join(EXE_NAME);
        let script = format!(
            "#!/bin/sh\ncfg=\"$2\"\ncase \"$3\" in\n  enroll) {}\n    mkdir -p \"$(dirname \"$cfg\")\"; echo '{{}}' > \"$cfg\" ;;\n  run) echo \"$WECOMMANDER_PARENT_PID\" > \"$cfg.parent\"; exec sleep 30 ;;\nesac\nexit 0\n",
            if fail {
                "echo \"bad code $7\" >&2; exit 1"
            } else {
                ""
            }
        );
        std::fs::write(&exe, script).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        exe
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wc-embedded-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pairs_runs_in_the_background_and_stops() {
        let dir = temp();
        let exe = fake_agent(&dir, false);
        let config = dir.join("cfg/webrising-commender/agent.json");
        let mut agent = Embedded::new(exe, config.clone());
        assert!(agent.available());
        assert_eq!(agent.state(), "notInstalled");
        assert!(!agent.start(), "nothing to run before pairing");

        agent
            .pair("https://wecommander.app/", "CODE-1", &dir.join("root"))
            .unwrap();
        assert!(agent.paired());
        assert!(dir.join("root").is_dir());
        assert!(agent.start());
        assert_eq!(agent.state(), "running");
        // The agent is told which process to exit with.
        for _ in 0..50 {
            if config.with_extension("json.parent").is_file() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let parent = std::fs::read_to_string(config.with_extension("json.parent")).unwrap();
        assert_eq!(parent.trim(), std::process::id().to_string());
        agent.stop();
        assert_eq!(agent.state(), "stopped");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_pairing_keeps_the_old_one_and_hides_the_code() {
        let dir = temp();
        let exe = fake_agent(&dir, true);
        let config = dir.join("agent.json");
        std::fs::write(&config, "old").unwrap();
        let mut agent = Embedded::new(exe, config.clone());
        let err = agent
            .pair("https://wecommander.app", "SECRET-9", &dir.join("root"))
            .unwrap_err();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "old");
        assert!(!err.contains("SECRET-9"), "{err}");
        assert!(err.contains("[REDACTED]"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn watchdog_restarts_then_gives_up() {
        let dir = temp();
        // An agent that exits right away when run.
        let exe = dir.join(EXE_NAME);
        std::fs::write(&exe, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = dir.join("agent.json");
        std::fs::write(&config, "{}").unwrap();
        let mut agent = Embedded::new(exe, config);
        let now = Instant::now();
        let wait_exit = |a: &mut Embedded| {
            for _ in 0..100 {
                if !a.running() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        assert_eq!(agent.tick(true, now), Tick::Started);
        wait_exit(&mut agent);
        assert_eq!(agent.tick(true, now + Duration::from_secs(5)), Tick::None);
        assert_eq!(
            agent.tick(true, now + Duration::from_secs(31)),
            Tick::Started
        );
        wait_exit(&mut agent);
        assert_eq!(
            agent.tick(true, now + Duration::from_secs(200)),
            Tick::Started
        );
        wait_exit(&mut agent);
        assert_eq!(
            agent.tick(true, now + Duration::from_secs(400)),
            Tick::GaveUp
        );
        assert_eq!(agent.tick(true, now + Duration::from_secs(900)), Tick::None);
        agent.reset();
        assert_eq!(
            agent.tick(false, now + Duration::from_secs(1000)),
            Tick::None
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_agent_is_reported() {
        let dir = temp();
        let config = dir.join("agent.json");
        std::fs::write(&config, "{}").unwrap();
        let mut agent = Embedded::new(dir.join(EXE_NAME), config);
        assert!(!agent.available());
        assert!(!agent.start());
        assert!(agent.last_error.as_deref().unwrap().contains("yeniden kur"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
