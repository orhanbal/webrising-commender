//! Docker containers for MCP: list them per daemon, read one container's
//! logs, and start, stop or restart one container.
//!
//! The daemons are found exactly as the cleanup finds them
//! ([`crate::docker`]): the system daemon (`system`) and every user's
//! rootless one (`u<uid>`, socket `/run/user/<uid>/docker.sock`, addressed
//! with `-H` as root when this machine allows it).
//!
//! Only the discovery is a fixed `sh` script. Every Docker call is an
//! argument vector run without a shell ([`Exec`]): the container reference,
//! the log window and the daemon's socket are separate arguments, and they
//! are validated before anything runs. Nothing here removes a container,
//! prunes, or touches volumes and images.

use std::future::Future;

use serde::Serialize;

use crate::docker::{self, Found};
use crate::{first, run, sections, Shell};

/// Runs a program with arguments directly (no shell between).
pub trait Exec: Sync {
    fn exec(
        &self,
        argv: &[String],
        secs: u64,
    ) -> impl Future<Output = Result<ExecOutput, String>> + Send;
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExecOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Default and largest number of log lines.
pub const DEFAULT_LOG_LINES: usize = 200;
pub const MAX_LOG_LINES: usize = 2000;
/// Largest log text returned (the newest lines are kept).
pub const MAX_LOG_BYTES: usize = 256 * 1024;
/// A single log line longer than this is cut.
pub const MAX_LOG_LINE_BYTES: usize = 8 * 1024;
/// Containers listed per daemon at most.
pub const MAX_CONTAINERS: usize = 500;

/// One container, from `docker ps -a --format '{{json .}}'`.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    /// running, exited, created, paused, restarting, removing, dead.
    pub state: String,
    /// Docker's own words: "Up 3 hours (healthy)", "Exited (0) 2 days ago".
    pub status: String,
    pub created: String,
    pub ports: String,
    /// From `docker inspect`; absent when it could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_count: Option<u32>,
}

/// One daemon's containers, or why it could not be read.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DaemonContainers {
    /// `system` or `u<uid>`: what the other Docker tools take as `daemon`.
    pub daemon: String,
    pub kind: String,
    pub label: String,
    pub user: String,
    pub socket: String,
    pub containers: Vec<Container>,
    /// More containers than [`MAX_CONTAINERS`] were there.
    pub truncated: bool,
    /// Empty when the daemon answered.
    pub error: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContainerList {
    pub docker_installed: bool,
    pub daemons: Vec<DaemonContainers>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContainerLogs {
    pub daemon: String,
    pub container: String,
    /// Oldest first; each line starts with Docker's timestamp, and lines the
    /// container wrote to stderr carry `[stderr]` after it.
    pub text: String,
    pub lines: usize,
    /// Older lines were left out to stay within the size limit.
    pub truncated: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContainerActionResult {
    pub ok: bool,
    pub daemon: String,
    pub container: String,
    pub action: String,
    pub state: String,
}

/// A container id or name as Docker accepts it: `[A-Za-z0-9][A-Za-z0-9_.-]*`,
/// at most 128 characters (a full id is 64 hex). Never starts with `-`, so it
/// can not be read as an option.
pub fn valid_container_ref(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && s.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

/// `system`, or `u<uid>` for a rootless daemon.
pub fn valid_daemon_id(s: &str) -> bool {
    s == "system"
        || s.strip_prefix('u').is_some_and(|n| {
            !n.is_empty() && n.len() <= 10 && n.chars().all(|c| c.is_ascii_digit())
        })
}

/// A `docker logs --since` value: a duration (`10m`, `1h30m`), a Unix time
/// (`1700000000`, `1700000000.5`) or an RFC 3339 date or time.
pub fn valid_since(s: &str) -> bool {
    if s.is_empty() || s.len() > 40 {
        return false;
    }
    let digits = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit());
    // Unix time.
    let unix = match s.split_once('.') {
        Some((a, b)) => digits(a) && a.len() <= 10 && digits(b) && b.len() <= 9,
        None => digits(s) && s.len() <= 10,
    };
    if unix {
        return true;
    }
    // Duration: number+unit, repeated.
    let mut rest = s;
    let mut parts = 0;
    let duration = loop {
        if rest.is_empty() {
            break parts > 0;
        }
        let n = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 || n > 6 {
            break false;
        }
        rest = &rest[n..];
        let Some(unit) = ["ns", "us", "ms", "h", "m", "s"]
            .into_iter()
            .find(|u| rest.starts_with(u))
        else {
            break false;
        };
        rest = &rest[unit.len()..];
        parts += 1;
        if parts > 4 {
            break false;
        }
    };
    if duration {
        return true;
    }
    // RFC 3339: date, optional time, fraction and zone.
    let b = s.as_bytes();
    let d = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let date = b.len() >= 10
        && (0..4).all(d)
        && b[4] == b'-'
        && d(5)
        && d(6)
        && b[7] == b'-'
        && d(8)
        && d(9);
    if !date {
        return false;
    }
    let time = &s[10..];
    if time.is_empty() {
        return true;
    }
    let Some(time) = time.strip_prefix('T') else {
        return false;
    };
    let (clock, zone) = match time.find(['Z', '+', '-']) {
        Some(i) => time.split_at(i),
        None => (time, ""),
    };
    let zone_ok = zone.is_empty()
        || zone == "Z"
        || (zone.len() == 6
            && zone[1..3].chars().all(|c| c.is_ascii_digit())
            && &zone[3..4] == ":"
            && zone[4..].chars().all(|c| c.is_ascii_digit()));
    let (hms, frac) = match clock.split_once('.') {
        Some((a, f)) => (a, Some(f)),
        None => (clock, None),
    };
    let fields: Vec<&str> = hms.split(':').collect();
    zone_ok
        && (2..=3).contains(&fields.len())
        && fields.iter().all(|f| f.len() == 2 && digits(f))
        && frac.is_none_or(|f| digits(f) && f.len() <= 9 && fields.len() == 3)
}

/// The privilege the discovery found: `root`, `sudo` or `` (the connected user).
#[derive(Debug, Clone, PartialEq)]
struct Daemons {
    has_docker: bool,
    privilege: String,
    found: Vec<Found>,
}

async fn discover<S: Shell>(sh: &S, run_user: &str) -> Result<Daemons, String> {
    let script = format!(
        "{}echo @@priv; echo \"$R\"\n",
        docker::discover_script(run_user)
    );
    let text = run(sh, &script, 30).await?;
    let (has_docker, _, found) = docker::parse_found(&text, run_user);
    let privilege = match first(&sections(&text), "priv") {
        p @ ("root" | "sudo") => p.to_owned(),
        _ => String::new(),
    };
    Ok(Daemons {
        has_docker,
        privilege,
        found,
    })
}

/// The Docker CLI against one daemon, as an argument vector: as root when
/// this machine can be root (`sudo -n` when needed), with a time limit.
pub(crate) fn docker_argv(privilege: &str, socket: &str, secs: u64, args: &[&str]) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    if privilege == "sudo" {
        argv.extend(["sudo".into(), "-n".into()]);
    }
    argv.extend(["timeout".into(), secs.to_string(), "docker".into()]);
    if !socket.is_empty() {
        argv.extend(["-H".into(), format!("unix://{socket}")]);
    }
    argv.extend(args.iter().map(|a| (*a).to_owned()));
    argv
}

/// What `docker ps --format '{{json .}}'` printed, one object per line.
/// Lines that are not JSON objects are skipped; only the fields listed in
/// [`Container`] are kept (not the command or labels, which can carry
/// secrets).
pub fn parse_ps_json(text: &str) -> Vec<Container> {
    let field = |v: &serde_json::Value, k: &str| -> String {
        v.get(k)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_owned()
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .filter(|v| v.is_object())
        .map(|v| {
            let status = field(&v, "Status");
            let mut state = field(&v, "State").to_ascii_lowercase();
            if state.is_empty() {
                state = state_from_status(&status).to_owned();
            }
            Container {
                id: field(&v, "ID"),
                name: field(&v, "Names"),
                image: field(&v, "Image"),
                state,
                status,
                created: field(&v, "CreatedAt"),
                ports: field(&v, "Ports"),
                restart_count: None,
            }
        })
        .filter(|c| !c.id.is_empty())
        .collect()
}

/// Older Docker versions have no `State` in `ps`: read it from `Status`.
fn state_from_status(status: &str) -> &'static str {
    let s = status.to_ascii_lowercase();
    if s.contains("(paused)") {
        "paused"
    } else if s.starts_with("up") {
        "running"
    } else if s.starts_with("restarting") {
        "restarting"
    } else if s.starts_with("exited") {
        "exited"
    } else if s.starts_with("created") {
        "created"
    } else if s.starts_with("removal") {
        "removing"
    } else if s.starts_with("dead") {
        "dead"
    } else {
        ""
    }
}

/// `<id> <restart count>` lines from `docker inspect`.
fn parse_restart_counts(text: &str) -> Vec<(String, u32)> {
    text.lines()
        .filter_map(|l| {
            let (id, n) = l.trim().split_once(' ')?;
            Some((id.to_owned(), n.trim().parse().ok()?))
        })
        .collect()
}

fn error_text(out: &ExecOutput) -> String {
    let text = if out.stderr.trim().is_empty() {
        &out.stdout
    } else {
        &out.stderr
    };
    docker::explain(text, &out.code.to_string())
}

fn is_full_id(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Labels and user names, the same as the cleanup's environments.
async fn daemon_view<E: Exec>(ex: &E, f: &Found) -> DaemonContainers {
    let mut found_user = String::new();
    if f.uid != 0 {
        if let Ok(out) = ex
            .exec(&["getent".into(), "passwd".into(), f.uid.to_string()], 10)
            .await
        {
            found_user = out.stdout.split(':').next().unwrap_or("").trim().to_owned();
        }
    }
    let answer = if found_user.is_empty() {
        String::new()
    } else {
        format!("@@user.{}\n{found_user}\n", f.id)
    };
    let env = docker::parse_envs(&answer, std::slice::from_ref(f))
        .into_iter()
        .next()
        .unwrap_or_default();
    DaemonContainers {
        daemon: f.id.clone(),
        kind: env.kind,
        label: env.label,
        user: env.user,
        socket: f.socket.clone(),
        ..Default::default()
    }
}

/// Every daemon's containers, the system daemon first. A daemon that can not
/// be read carries its error; the others are still listed.
pub async fn containers<S: Shell + Exec>(sh: &S) -> Result<ContainerList, String> {
    containers_in(sh, docker::RUN_USER).await
}

pub(crate) async fn containers_in<S: Shell + Exec>(
    sh: &S,
    run_user: &str,
) -> Result<ContainerList, String> {
    let d = discover(sh, run_user).await?;
    let mut list = ContainerList {
        docker_installed: d.has_docker,
        daemons: Vec::new(),
    };
    if !d.has_docker {
        return Ok(list);
    }
    for f in &d.found {
        let mut view = daemon_view(sh, f).await;
        let ps = sh
            .exec(
                &docker_argv(
                    &d.privilege,
                    &f.socket,
                    60,
                    &["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
                ),
                70,
            )
            .await;
        let out = match ps {
            Ok(out) if out.code == 0 => out,
            Ok(out) => {
                view.error = error_text(&out);
                list.daemons.push(view);
                continue;
            }
            Err(e) => {
                view.error = docker::explain(&e, "");
                list.daemons.push(view);
                continue;
            }
        };
        let mut all = parse_ps_json(&out.stdout);
        view.truncated = all.len() > MAX_CONTAINERS;
        all.truncate(MAX_CONTAINERS);
        // Restart counts: one more call for the whole daemon, best effort.
        let ids: Vec<&str> = all
            .iter()
            .map(|c| c.id.as_str())
            .filter(|id| is_full_id(id))
            .collect();
        if !ids.is_empty() {
            let mut args = vec!["inspect", "--format", "{{.Id}} {{.RestartCount}}"];
            args.extend(ids.iter().copied());
            if let Ok(out) = sh
                .exec(&docker_argv(&d.privilege, &f.socket, 60, &args), 70)
                .await
            {
                for (id, n) in parse_restart_counts(&out.stdout) {
                    if let Some(c) = all.iter_mut().find(|c| c.id == id) {
                        c.restart_count = Some(n);
                    }
                }
            }
        }
        view.containers = all;
        list.daemons.push(view);
    }
    Ok(list)
}

/// The daemon `id` names, found again now; an id for a daemon that is not
/// there is refused.
async fn find_daemon<S: Shell>(
    sh: &S,
    run_user: &str,
    id: &str,
) -> Result<(String, Found), String> {
    if !valid_daemon_id(id) {
        return Err(format!("invalid daemon: {id} (system or u<uid>)"));
    }
    let d = discover(sh, run_user).await?;
    if !d.has_docker {
        return Err("Docker is not installed on this machine.".into());
    }
    let found = d.found.into_iter().find(|f| f.id == id).ok_or_else(|| {
        format!("No Docker daemon {id} on this machine (see docker_containers_list).")
    })?;
    Ok((d.privilege, found))
}

/// One timestamped log line from either stream.
struct LogLine {
    key: String,
    text: String,
}

/// Docker's RFC 3339 timestamps drop trailing zeros of the fraction: pad it
/// so the text sorts in time order.
fn sort_key(ts: &str) -> String {
    let Some(dot) = ts.find('.') else {
        return ts.trim_end_matches('Z').to_owned() + ".000000000";
    };
    let (head, rest) = ts.split_at(dot);
    let frac: String = rest[1..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    format!("{head}.{frac:0<9}")
}

fn cut_line(line: &str) -> String {
    if line.len() <= MAX_LOG_LINE_BYTES {
        return line.to_owned();
    }
    let mut end = MAX_LOG_LINE_BYTES;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… [line cut]", &line[..end])
}

/// `docker logs --timestamps` output of both streams, merged in time order,
/// the newest `tail` lines, at most [`MAX_LOG_BYTES`] (newest kept).
pub fn merge_logs(stdout: &str, stderr: &str, tail: usize) -> (String, usize, bool) {
    let mut lines: Vec<LogLine> = Vec::new();
    for (text, err) in [(stdout, false), (stderr, true)] {
        for raw in text.lines() {
            let (ts, msg) = raw.split_once(' ').unwrap_or((raw, ""));
            let msg = cut_line(msg);
            lines.push(LogLine {
                key: sort_key(ts),
                text: if err {
                    format!("{ts} [stderr] {msg}")
                } else {
                    format!("{ts} {msg}")
                },
            });
        }
    }
    // Stable: lines with the same time keep their stream's order.
    lines.sort_by(|a, b| a.key.cmp(&b.key));
    let tail = tail.clamp(1, MAX_LOG_LINES);
    let mut truncated = false;
    if lines.len() > tail {
        lines.drain(..lines.len() - tail);
    }
    let mut kept = 0;
    let mut bytes = 0;
    for l in lines.iter().rev() {
        if bytes + l.text.len() + 1 > MAX_LOG_BYTES {
            truncated = true;
            break;
        }
        bytes += l.text.len() + 1;
        kept += 1;
    }
    let start = lines.len() - kept;
    let text = lines[start..]
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    (text, kept, truncated)
}

/// The last `tail` lines (default 200, at most 2000) of one container's logs.
pub async fn container_logs<S: Shell + Exec>(
    sh: &S,
    daemon: &str,
    container: &str,
    tail: Option<usize>,
    since: Option<&str>,
) -> Result<ContainerLogs, String> {
    container_logs_in(sh, docker::RUN_USER, daemon, container, tail, since).await
}

pub(crate) async fn container_logs_in<S: Shell + Exec>(
    sh: &S,
    run_user: &str,
    daemon: &str,
    container: &str,
    tail: Option<usize>,
    since: Option<&str>,
) -> Result<ContainerLogs, String> {
    if !valid_container_ref(container) {
        return Err(format!("invalid container id or name: {container}"));
    }
    if let Some(s) = since {
        if !valid_since(s) {
            return Err(format!(
                "invalid since: {s} (a duration like 10m, a Unix time or an RFC 3339 time)"
            ));
        }
    }
    let tail = tail.unwrap_or(DEFAULT_LOG_LINES).clamp(1, MAX_LOG_LINES);
    let (privilege, found) = find_daemon(sh, run_user, daemon).await?;
    let tail_text = tail.to_string();
    let mut args = vec!["logs", "--timestamps", "--tail", tail_text.as_str()];
    if let Some(s) = since {
        args.extend(["--since", s]);
    }
    args.push(container);
    let out = sh
        .exec(&docker_argv(&privilege, &found.socket, 60, &args), 70)
        .await?;
    if out.code != 0 {
        return Err(not_found_or(&out, container));
    }
    let (text, lines, truncated) = merge_logs(&out.stdout, &out.stderr, tail);
    Ok(ContainerLogs {
        daemon: daemon.to_owned(),
        container: container.to_owned(),
        text,
        lines,
        truncated,
    })
}

fn not_found_or(out: &ExecOutput, container: &str) -> String {
    if out
        .stderr
        .to_ascii_lowercase()
        .contains("no such container")
    {
        format!("No such container on this daemon: {container}")
    } else {
        error_text(out)
    }
}

pub const CONTAINER_ACTIONS: &[&str] = &["start", "stop", "restart"];

/// Starts, stops or restarts one container. Nothing else: no `rm`, no
/// prune, no volumes or images.
pub async fn container_action<S: Shell + Exec>(
    sh: &S,
    daemon: &str,
    container: &str,
    action: &str,
) -> Result<ContainerActionResult, String> {
    container_action_in(sh, docker::RUN_USER, daemon, container, action).await
}

pub(crate) async fn container_action_in<S: Shell + Exec>(
    sh: &S,
    run_user: &str,
    daemon: &str,
    container: &str,
    action: &str,
) -> Result<ContainerActionResult, String> {
    let Some(action) = CONTAINER_ACTIONS.iter().copied().find(|a| *a == action) else {
        return Err(format!("invalid action: {action} (start, stop or restart)"));
    };
    if !valid_container_ref(container) {
        return Err(format!("invalid container id or name: {container}"));
    }
    let (privilege, found) = find_daemon(sh, run_user, daemon).await?;
    // `stop` and `restart` wait 10 s for the container before killing it.
    let out = sh
        .exec(
            &docker_argv(&privilege, &found.socket, 180, &[action, container]),
            200,
        )
        .await?;
    if out.code != 0 {
        return Err(not_found_or(&out, container));
    }
    let state = sh
        .exec(
            &docker_argv(
                &privilege,
                &found.socket,
                30,
                &["inspect", "--format", "{{.State.Status}}", container],
            ),
            40,
        )
        .await
        .map(|o| o.stdout.trim().to_owned())
        .unwrap_or_default();
    Ok(ContainerActionResult {
        ok: true,
        daemon: daemon.to_owned(),
        container: container.to_owned(),
        action: action.to_owned(),
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        loop {
            if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    /// Discovery answers a fixed text; every Docker call is recorded and
    /// answered by `answer`.
    struct Fake {
        discovery: String,
        calls: Mutex<Vec<Vec<String>>>,
        scripts: Mutex<Vec<String>>,
        answer: fn(&[String]) -> ExecOutput,
    }

    impl Fake {
        fn new(discovery: &str, answer: fn(&[String]) -> ExecOutput) -> Self {
            Self {
                discovery: discovery.into(),
                calls: Mutex::new(Vec::new()),
                scripts: Mutex::new(Vec::new()),
                answer,
            }
        }
        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Shell for Fake {
        async fn run_script(&self, script: &str, _secs: u64) -> Result<String, String> {
            self.scripts.lock().unwrap().push(script.to_owned());
            Ok(self.discovery.clone())
        }
    }

    impl Exec for Fake {
        async fn exec(&self, argv: &[String], _secs: u64) -> Result<ExecOutput, String> {
            self.calls.lock().unwrap().push(argv.to_vec());
            Ok((self.answer)(argv))
        }
    }

    const TWO_DAEMONS: &str = "@@me\n0\n@@hasdocker\nyes\n@@system\n/var/run/docker.sock\n@@rootless\n/run/user/1000\t1000\n@@priv\nsudo\n";

    const ID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn ok(stdout: &str) -> ExecOutput {
        ExecOutput {
            code: 0,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    #[test]
    fn ps_json_lines_become_containers() {
        let text = format!(
            "{{\"Command\":\"\\\"nginx -g PASSWORD=x\\\"\",\"CreatedAt\":\"2026-11-01 10:00:00 +0000 UTC\",\"ID\":\"{ID_A}\",\"Image\":\"nginx:1.27\",\"Labels\":\"secret=1\",\"Names\":\"web\",\"Ports\":\"0.0.0.0:80->80/tcp\",\"State\":\"running\",\"Status\":\"Up 3 hours (healthy)\"}}\n\
             not json\n\
             {{\"ID\":\"{ID_B}\",\"Image\":\"redis\",\"Names\":\"cache\",\"Status\":\"Exited (0) 2 days ago\",\"CreatedAt\":\"2026-10-01\",\"Ports\":\"\"}}\n\
             {{\"Image\":\"no-id\"}}\n\
             {{\"ID\":\"c1\",\"Names\":\"p\",\"Status\":\"Up 1 second (Paused)\"}}\n"
        );
        let c = parse_ps_json(&text);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].id, ID_A);
        assert_eq!(c[0].name, "web");
        assert_eq!(c[0].image, "nginx:1.27");
        assert_eq!(c[0].state, "running");
        assert_eq!(c[0].status, "Up 3 hours (healthy)");
        assert_eq!(c[0].ports, "0.0.0.0:80->80/tcp");
        assert_eq!(c[0].created, "2026-11-01 10:00:00 +0000 UTC");
        // No State field (older Docker): read from Status.
        assert_eq!(c[1].state, "exited");
        assert_eq!(c[2].state, "paused");
        // The command and labels are never passed on.
        let json = serde_json::to_string(&c).unwrap();
        assert!(
            !json.contains("PASSWORD") && !json.contains("secret"),
            "{json}"
        );
    }

    #[test]
    fn container_refs_are_validated_strictly() {
        for good in ["web", ID_A, "a1b2c3d4e5f6", "my_app.v2-1", "A"] {
            assert!(valid_container_ref(good), "{good}");
        }
        let long = "a".repeat(129);
        for bad in [
            "",
            "-rm",
            "--all",
            "web;rm -rf /",
            "a b",
            "$(id)",
            "`id`",
            "a|b",
            "a/b",
            "../x",
            "_x",
            ".x",
            "web\n",
            "wéb",
            long.as_str(),
        ] {
            assert!(!valid_container_ref(bad), "{bad:?}");
        }
        for good in ["system", "u1000", "u0"] {
            assert!(valid_daemon_id(good), "{good}");
        }
        for bad in [
            "",
            "u",
            "uabc",
            "u1000;x",
            "root",
            "u12345678901",
            "system ",
        ] {
            assert!(!valid_daemon_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn since_accepts_durations_unix_and_rfc3339_only() {
        for good in [
            "10m",
            "1h30m",
            "45s",
            "1700000000",
            "1700000000.5",
            "2026-11-19",
            "2026-11-19T10:00",
            "2026-11-19T10:00:00Z",
            "2026-11-19T10:00:00.123456789+03:00",
        ] {
            assert!(valid_since(good), "{good}");
        }
        for bad in [
            "",
            "10x",
            "-10m",
            "m",
            "1h;id",
            "2026-11-19 10:00",
            "2026-11-19T10",
            "2026-11-19T10:00:00+0300",
            "$(date)",
            "1d",
            "12345678901",
        ] {
            assert!(!valid_since(bad), "{bad:?}");
        }
        // A bare number is a Unix time.
        assert!(valid_since("10"));
    }

    #[test]
    fn docker_calls_are_argument_vectors_for_the_daemon_socket() {
        assert_eq!(
            docker_argv("sudo", "/run/user/1000/docker.sock", 60, &["logs", "web"]),
            [
                "sudo",
                "-n",
                "timeout",
                "60",
                "docker",
                "-H",
                "unix:///run/user/1000/docker.sock",
                "logs",
                "web"
            ]
        );
        assert_eq!(
            docker_argv("root", "", 30, &["ps"]),
            ["timeout", "30", "docker", "ps"]
        );
    }

    #[test]
    fn every_daemon_is_listed_and_a_failing_one_carries_its_error() {
        fn answer(argv: &[String]) -> ExecOutput {
            let rootless = argv.iter().any(|a| a.contains("/run/user/1000"));
            if argv[0] == "getent" {
                return ok("devagent-ci:x:1000:1000::/home/devagent-ci:/bin/sh\n");
            }
            if rootless {
                return ExecOutput {
                    code: 1,
                    stdout: String::new(),
                    stderr: "permission denied while trying to connect to the Docker daemon socket"
                        .into(),
                };
            }
            if argv.contains(&"ps".to_owned()) {
                return ok(&format!(
                    "{{\"ID\":\"{ID_A}\",\"Names\":\"web\",\"Image\":\"nginx\",\"State\":\"running\",\"Status\":\"Up\"}}\n{{\"ID\":\"{ID_B}\",\"Names\":\"db\",\"Image\":\"pg\",\"State\":\"exited\",\"Status\":\"Exited (1)\"}}\n"
                ));
            }
            if argv.contains(&"inspect".to_owned()) {
                return ok(&format!("{ID_A} 3\n{ID_B} 0\n"));
            }
            ok("")
        }
        let fake = Fake::new(TWO_DAEMONS, answer);
        let list = block_on(containers_in(&fake, "/run/user")).unwrap();
        assert!(list.docker_installed);
        assert_eq!(list.daemons.len(), 2);
        let system = &list.daemons[0];
        assert_eq!(system.daemon, "system");
        assert_eq!(system.label, "Sistem Docker");
        assert!(system.error.is_empty());
        assert_eq!(system.containers.len(), 2);
        assert_eq!(system.containers[0].restart_count, Some(3));
        assert_eq!(system.containers[1].restart_count, Some(0));
        let rootless = &list.daemons[1];
        assert_eq!(rootless.daemon, "u1000");
        assert_eq!(rootless.user, "devagent-ci");
        assert_eq!(rootless.label, "DEVAGENT-CI — Rootless Docker");
        assert!(
            rootless.error.contains("erişim izni yok"),
            "{}",
            rootless.error
        );
        assert!(rootless.containers.is_empty());
        // Root through sudo, the rootless daemon through its own socket.
        let calls = fake.calls();
        assert!(calls.iter().any(|c| c[..2] == ["sudo", "-n"]
            && c.contains(&"unix:///run/user/1000/docker.sock".to_owned())
            && c.contains(&"ps".to_owned())));
        // Only the discovery is a script, and it holds no request text.
        assert_eq!(fake.scripts.lock().unwrap().len(), 1);
    }

    #[test]
    fn no_docker_lists_nothing() {
        let fake = Fake::new("@@hasdocker\n\n@@system\n\n@@rootless\n", |_| ok(""));
        let list = block_on(containers_in(&fake, "/run/user")).unwrap();
        assert!(!list.docker_installed && list.daemons.is_empty());
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn logs_merge_both_streams_in_time_order_and_are_capped() {
        let out = "2026-11-19T10:00:00.1Z first\n2026-11-19T10:00:02Z third\n";
        let err = "2026-11-19T10:00:00.12Z second\n";
        let (text, n, cut) = merge_logs(out, err, 200);
        assert_eq!(
            text,
            "2026-11-19T10:00:00.1Z first\n2026-11-19T10:00:00.12Z [stderr] second\n2026-11-19T10:00:02Z third"
        );
        assert_eq!((n, cut), (3, false));
        // The newest lines are kept.
        let (text, n, _) = merge_logs(out, err, 1);
        assert_eq!((text.as_str(), n), ("2026-11-19T10:00:02Z third", 1));
        // Size cap: many long lines stay within MAX_LOG_BYTES, newest kept.
        let long = "x".repeat(MAX_LOG_LINE_BYTES * 2);
        let big: String = (0..MAX_LOG_LINES)
            .map(|i| format!("2026-11-19T10:00:00.{i:09}Z {long}\n"))
            .collect();
        let (text, n, cut) = merge_logs(&big, "", 5000);
        assert!(cut);
        assert!(text.len() <= MAX_LOG_BYTES, "{}", text.len());
        assert!(n < MAX_LOG_LINES);
        assert!(text.ends_with("[line cut]"));
        assert!(text.contains(&format!(".{:09}Z", MAX_LOG_LINES - 1)));
        // Never more than MAX_LOG_LINES lines.
        let many: String = (0..3000)
            .map(|i| format!("2026-11-19T10:00:00.{i:09}Z l\n"))
            .collect();
        assert_eq!(merge_logs(&many, "", 9999).1, MAX_LOG_LINES);
    }

    #[test]
    fn logs_run_on_the_named_daemon_with_a_bounded_tail() {
        fn answer(argv: &[String]) -> ExecOutput {
            if argv.contains(&"logs".to_owned()) {
                ExecOutput {
                    code: 0,
                    stdout: "2026-11-19T10:00:00Z hello\n".into(),
                    stderr: "2026-11-19T10:00:01Z oops\n".into(),
                }
            } else {
                ok("")
            }
        }
        let fake = Fake::new(TWO_DAEMONS, answer);
        let logs = block_on(container_logs_in(
            &fake,
            "/run/user",
            "u1000",
            "relay",
            Some(99_999),
            Some("10m"),
        ))
        .unwrap();
        assert_eq!(logs.lines, 2);
        assert!(logs.text.contains("[stderr] oops"));
        let call = fake.calls().pop().unwrap();
        assert_eq!(
            call[4..],
            [
                "docker",
                "-H",
                "unix:///run/user/1000/docker.sock",
                "logs",
                "--timestamps",
                "--tail",
                "2000",
                "--since",
                "10m",
                "relay"
            ]
        );
        // Bad input is refused before anything runs.
        let fake = Fake::new(TWO_DAEMONS, answer);
        for (daemon, container, since) in [
            ("system", "web; reboot", None),
            ("system", "-f", None),
            ("system", "web", Some("1h; id")),
            ("root", "web", None),
        ] {
            assert!(block_on(container_logs_in(
                &fake,
                "/run/user",
                daemon,
                container,
                None,
                since
            ))
            .is_err());
        }
        assert!(fake.calls().is_empty());
        // A daemon that is not there is refused.
        let err = block_on(container_logs_in(
            &fake,
            "/run/user",
            "u2000",
            "web",
            None,
            None,
        ))
        .unwrap_err();
        assert!(err.contains("No Docker daemon u2000"), "{err}");
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn actions_are_start_stop_restart_only() {
        fn answer(argv: &[String]) -> ExecOutput {
            if argv.contains(&"inspect".to_owned()) {
                ok("running\n")
            } else if argv.contains(&"ghost".to_owned()) {
                ExecOutput {
                    code: 1,
                    stdout: String::new(),
                    stderr: "Error response from daemon: No such container: ghost".into(),
                }
            } else {
                ok("web\n")
            }
        }
        let fake = Fake::new(TWO_DAEMONS, answer);
        let r = block_on(container_action_in(
            &fake,
            "/run/user",
            "system",
            "web",
            "restart",
        ))
        .unwrap();
        assert!(r.ok);
        assert_eq!(r.state, "running");
        let calls = fake.calls();
        assert_eq!(
            calls[0],
            [
                "sudo",
                "-n",
                "timeout",
                "180",
                "docker",
                "-H",
                "unix:///var/run/docker.sock",
                "restart",
                "web"
            ]
        );
        for bad in ["rm", "kill", "prune", "start web", "", "pause"] {
            assert!(
                block_on(container_action_in(
                    &fake,
                    "/run/user",
                    "system",
                    "web",
                    bad
                ))
                .is_err(),
                "{bad}"
            );
        }
        let err = block_on(container_action_in(
            &fake,
            "/run/user",
            "system",
            "ghost",
            "stop",
        ))
        .unwrap_err();
        assert!(err.contains("No such container"), "{err}");
        // Nothing but start/stop/restart and inspect ever reached Docker.
        for c in fake.calls() {
            let verb = &c[c.iter().position(|a| a == "docker").unwrap() + 3];
            assert!(
                ["start", "stop", "restart", "inspect"].contains(&verb.as_str()),
                "{c:?}"
            );
        }
    }
}
