//! Docker containers for MCP: list them per daemon, read one container's
//! logs, and start, stop or restart one container.
//!
//! The daemons are found exactly as the cleanup finds them
//! ([`crate::docker`]): the system daemon (`system`) and every user's
//! rootless one (`u<uid>`, socket `/run/user/<uid>/docker.sock`, addressed
//! with `-H` as root when this machine allows it).
//!
//! Only the discovery is a fixed `sh` script. Every Docker call is an
//! argument vector ([`Exec`]): on the agent it runs without a shell; over
//! SSH (wc-app-core) every argument is quoted with [`crate::quote`]
//! ([`argv_command`]). The container reference, the log window and the
//! daemon's socket are separate arguments, validated before anything runs;
//! the socket is rebuilt from the daemon's uid, never taken from the caller.
//!
//! A container is named by `container` (an id or name, or `<ref>@u<uid>` for
//! a rootless daemon) and an optional `daemon` (`system` or `u<uid>`), see
//! [`container_target`]. Logs and actions first resolve the reference to the
//! full id Docker reports and then act on that id only. WECOMMANDER's own
//! containers (name starting with `wecommander`) are never stopped or
//! restarted from here. Nothing here removes a container, prunes, or touches
//! volumes and images.

use std::future::Future;

use serde::Serialize;

use crate::docker::{self, Found};
use crate::{first, run, sections, Shell};

/// Runs a program with arguments: directly on the agent (no shell between),
/// as an [`argv_command`] over SSH.
pub trait Exec: Sync {
    fn exec(
        &self,
        argv: &[String],
        secs: u64,
    ) -> impl Future<Output = Result<ExecOutput, String>> + Send;
}

/// `argv` as one `sh` command line, every argument single-quoted with
/// [`crate::quote`]: for runners that can only send a command line (SSH).
pub fn argv_command(argv: &[String]) -> String {
    argv.iter()
        .map(|a| crate::quote(a))
        .collect::<Vec<_>>()
        .join(" ")
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
    /// The full id Docker resolved the reference to.
    pub container: String,
    pub name: String,
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
    /// The full id the action ran on.
    pub container: String,
    pub name: String,
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

/// `system`, or `u<uid>` for a rootless daemon (a positive uid, no leading
/// zero; root's daemon is `system`).
pub fn valid_daemon_id(s: &str) -> bool {
    if s == "system" {
        return true;
    }
    s.strip_prefix('u').is_some_and(|n| {
        n.chars().all(|c| c.is_ascii_digit())
            && n.parse::<u32>()
                .is_ok_and(|uid| uid > 0 && uid.to_string() == n)
    })
}

/// Splits `container` (`ref` or `ref@u<uid>`, a leading `/` allowed) and an
/// optional separate `daemon` into `(daemon, ref)`: the system daemon when
/// neither names one. Both naming different daemons is refused.
pub fn container_target(container: &str, daemon: Option<&str>) -> Result<(String, String), String> {
    let c = container.trim();
    let c = c.strip_prefix('/').unwrap_or(c);
    let (r, suffix) = match c.split_once('@') {
        Some((r, d)) => (r, Some(d)),
        None => (c, None),
    };
    let daemon = daemon.map(str::trim).filter(|d| !d.is_empty());
    let chosen = match (suffix, daemon) {
        (Some(a), Some(b)) if a != b => {
            return Err(format!(
                "invalid daemon: container names {a}, daemon names {b}"
            ))
        }
        (Some(a), _) => a,
        (None, Some(b)) => b,
        (None, None) => "system",
    };
    if !valid_container_ref(r) {
        return Err(format!("invalid container id or name: {container}"));
    }
    if !valid_daemon_id(chosen) {
        return Err(format!("invalid daemon: {chosen} (system or u<uid>)"));
    }
    Ok((chosen.to_owned(), r.to_owned()))
}

/// WECOMMANDER's own containers: never stopped or restarted from MCP.
pub fn is_protected_container(name: &str) -> bool {
    name.trim_start_matches('/')
        .to_ascii_lowercase()
        .starts_with("wecommander")
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

/// Every daemon's containers, the system daemon first, or only the daemon
/// `only` names. A daemon that can not be read carries its error; the others
/// are still listed.
pub async fn containers<S: Shell + Exec>(
    sh: &S,
    only: Option<&str>,
) -> Result<ContainerList, String> {
    containers_in(sh, docker::RUN_USER, only).await
}

pub(crate) async fn containers_in<S: Shell + Exec>(
    sh: &S,
    run_user: &str,
    only: Option<&str>,
) -> Result<ContainerList, String> {
    let only = only.map(str::trim).filter(|d| !d.is_empty());
    if let Some(id) = only {
        if !valid_daemon_id(id) {
            return Err(format!("invalid daemon: {id} (system or u<uid>)"));
        }
    }
    let d = discover(sh, run_user).await?;
    let mut list = ContainerList {
        docker_installed: d.has_docker,
        daemons: Vec::new(),
    };
    if !d.has_docker {
        return Ok(list);
    }
    if let Some(id) = only {
        if !d.found.iter().any(|f| f.id == id) {
            return Err(format!(
                "No Docker daemon {id} on this machine (see docker_containers_list)."
            ));
        }
    }
    for f in d.found.iter().filter(|f| only.is_none_or(|id| f.id == id)) {
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

/// The full id and name of the container `r` on a daemon (`docker container
/// inspect`, so an image of that name is never matched).
async fn resolve<E: Exec>(
    ex: &E,
    privilege: &str,
    socket: &str,
    r: &str,
) -> Result<(String, String), String> {
    let out = ex
        .exec(
            &docker_argv(
                privilege,
                socket,
                30,
                &["container", "inspect", "--format", "{{.Id}}\t{{.Name}}", r],
            ),
            40,
        )
        .await?;
    if out.code != 0 {
        return Err(not_found_or(&out, r));
    }
    let line = out.stdout.lines().next().unwrap_or("").trim();
    let (id, name) = line.split_once('\t').unwrap_or((line, ""));
    if !is_full_id(id) {
        return Err(format!("No such container on this daemon: {r}"));
    }
    let name: String = name
        .trim()
        .trim_start_matches('/')
        .chars()
        .filter(|c| !c.is_control())
        .take(256)
        .collect();
    Ok((id.to_ascii_lowercase(), name))
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
/// `container` and `daemon` as [`container_target`] takes them.
pub async fn container_logs<S: Shell + Exec>(
    sh: &S,
    container: &str,
    daemon: Option<&str>,
    tail: Option<usize>,
    since: Option<&str>,
) -> Result<ContainerLogs, String> {
    container_logs_in(sh, docker::RUN_USER, container, daemon, tail, since).await
}

pub(crate) async fn container_logs_in<S: Shell + Exec>(
    sh: &S,
    run_user: &str,
    container: &str,
    daemon: Option<&str>,
    tail: Option<usize>,
    since: Option<&str>,
) -> Result<ContainerLogs, String> {
    let (daemon, container) = container_target(container, daemon)?;
    let (daemon, container) = (daemon.as_str(), container.as_str());
    if let Some(s) = since {
        if !valid_since(s) {
            return Err(format!(
                "invalid since: {s} (a duration like 10m, a Unix time or an RFC 3339 time)"
            ));
        }
    }
    let tail = tail.unwrap_or(DEFAULT_LOG_LINES).clamp(1, MAX_LOG_LINES);
    let (privilege, found) = find_daemon(sh, run_user, daemon).await?;
    let (id, name) = resolve(sh, &privilege, &found.socket, container).await?;
    let tail_text = tail.to_string();
    let mut args = vec!["logs", "--timestamps", "--tail", tail_text.as_str()];
    if let Some(s) = since {
        args.extend(["--since", s]);
    }
    args.push(id.as_str());
    let out = sh
        .exec(&docker_argv(&privilege, &found.socket, 60, &args), 70)
        .await?;
    if out.code != 0 {
        return Err(not_found_or(&out, container));
    }
    let (text, lines, truncated) = merge_logs(&out.stdout, &out.stderr, tail);
    Ok(ContainerLogs {
        daemon: daemon.to_owned(),
        container: id,
        name,
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

/// Starts, stops or restarts one container, on the full id its reference
/// resolves to. Nothing else: no `rm`, no prune, no volumes or images.
/// WECOMMANDER's own containers are not stopped or restarted.
pub async fn container_action<S: Shell + Exec>(
    sh: &S,
    container: &str,
    daemon: Option<&str>,
    action: &str,
) -> Result<ContainerActionResult, String> {
    container_action_in(sh, docker::RUN_USER, container, daemon, action).await
}

pub(crate) async fn container_action_in<S: Shell + Exec>(
    sh: &S,
    run_user: &str,
    container: &str,
    daemon: Option<&str>,
    action: &str,
) -> Result<ContainerActionResult, String> {
    let Some(action) = CONTAINER_ACTIONS.iter().copied().find(|a| *a == action) else {
        return Err(format!("invalid action: {action} (start, stop or restart)"));
    };
    let (daemon, container) = container_target(container, daemon)?;
    let (daemon, container) = (daemon.as_str(), container.as_str());
    let (privilege, found) = find_daemon(sh, run_user, daemon).await?;
    let (id, name) = resolve(sh, &privilege, &found.socket, container).await?;
    if action != "start" && is_protected_container(&name) {
        return Err(format!(
            "WECOMMANDER's own containers are not stopped or restarted from here: {name}"
        ));
    }
    // `stop` and `restart` wait 10 s for the container before killing it.
    let out = sh
        .exec(
            &docker_argv(&privilege, &found.socket, 180, &[action, id.as_str()]),
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
                &["inspect", "--format", "{{.State.Status}}", id.as_str()],
            ),
            40,
        )
        .await
        .map(|o| o.stdout.trim().to_owned())
        .unwrap_or_default();
    Ok(ContainerActionResult {
        ok: true,
        daemon: daemon.to_owned(),
        container: id,
        name,
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
        for good in ["system", "u1000", "u1", "u4294967295"] {
            assert!(valid_daemon_id(good), "{good}");
        }
        for bad in [
            "",
            "u",
            "u0",
            "u01",
            "u4294967296",
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
        let list = block_on(containers_in(&fake, "/run/user", None)).unwrap();
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
        let list = block_on(containers_in(&fake, "/run/user", None)).unwrap();
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

    /// `docker container inspect` answers: `web`, `relay` and the short id
    /// of ID_A are ID_A; `wecommander-agent` is ID_B; anything else is not
    /// there.
    fn inspect(argv: &[String]) -> Option<ExecOutput> {
        let at = argv.iter().position(|a| a == "container")?;
        if argv.get(at + 1).map(String::as_str) != Some("inspect") {
            return None;
        }
        Some(match argv.last().map(String::as_str) {
            Some("web" | "relay" | "aaaaaaaaaaaa") => ok(&format!("{ID_A}\t/web\n")),
            Some("wecommander-agent") => ok(&format!("{ID_B}\t/wecommander-agent\n")),
            Some(other) => ExecOutput {
                code: 1,
                stdout: String::new(),
                stderr: format!("Error response from daemon: No such container: {other}"),
            },
            None => ok(""),
        })
    }

    #[test]
    fn a_container_names_its_daemon_once() {
        let t = |c: &str, d: Option<&str>| container_target(c, d);
        assert_eq!(t("web", None).unwrap(), ("system".into(), "web".into()));
        assert_eq!(t("/web", None).unwrap(), ("system".into(), "web".into()));
        assert_eq!(
            t("0123456789ab@u1000", None).unwrap(),
            ("u1000".into(), "0123456789ab".into())
        );
        assert_eq!(
            t("web", Some("u1000")).unwrap(),
            ("u1000".into(), "web".into())
        );
        assert_eq!(
            t("web@u1000", Some("u1000")).unwrap(),
            ("u1000".into(), "web".into())
        );
        assert_eq!(
            t("web", Some(" ")).unwrap(),
            ("system".into(), "web".into())
        );
        let err = t("web@u1000", Some("system")).unwrap_err();
        assert!(err.contains("invalid daemon"), "{err}");
        for (c, d) in [
            ("web@u0", None),
            ("web@x@y", None),
            ("web", Some("../x")),
            ("web", Some("root")),
        ] {
            let err = t(c, d).unwrap_err();
            assert!(err.contains("invalid"), "{c} {d:?}: {err}");
        }
        for c in ["web;id", "", "-f", "@u1000"] {
            let err = t(c, None).unwrap_err();
            assert!(err.contains("invalid container"), "{c}: {err}");
        }
    }

    #[test]
    fn argv_commands_quote_every_argument() {
        let argv: Vec<String> = ["docker", "logs", "--since", "10m", "it's; id"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(
            argv_command(&argv),
            r#"'docker' 'logs' '--since' '10m' 'it'\''s; id'"#
        );
    }

    #[test]
    fn wecommander_containers_are_protected() {
        for name in ["wecommander", "/wecommander-agent", "WECOMMANDER_db"] {
            assert!(is_protected_container(name), "{name}");
        }
        for name in ["web", "my-wecommander", ""] {
            assert!(!is_protected_container(name), "{name}");
        }
    }

    #[test]
    fn one_daemon_can_be_listed_alone() {
        fn answer(argv: &[String]) -> ExecOutput {
            if argv.contains(&"ps".to_owned()) {
                return ok(&format!("{{\"ID\":\"{ID_A}\",\"Names\":\"relay\",\"State\":\"running\",\"Status\":\"Up\"}}\n"));
            }
            ok("")
        }
        let fake = Fake::new(TWO_DAEMONS, answer);
        let list = block_on(containers_in(&fake, "/run/user", Some("u1000"))).unwrap();
        assert_eq!(list.daemons.len(), 1);
        assert_eq!(list.daemons[0].daemon, "u1000");
        assert!(fake
            .calls()
            .iter()
            .filter(|c| c.contains(&"ps".to_owned()))
            .all(|c| c.contains(&"unix:///run/user/1000/docker.sock".to_owned())));
        let err = block_on(containers_in(&fake, "/run/user", Some("u2000"))).unwrap_err();
        assert!(err.contains("No Docker daemon u2000"), "{err}");
        let fake = Fake::new(TWO_DAEMONS, answer);
        let err = block_on(containers_in(&fake, "/run/user", Some("x;id"))).unwrap_err();
        assert!(err.contains("invalid daemon"), "{err}");
        assert!(fake.scripts.lock().unwrap().is_empty());
    }

    #[test]
    fn logs_run_on_the_resolved_id_of_the_named_daemon_with_a_bounded_tail() {
        fn answer(argv: &[String]) -> ExecOutput {
            if let Some(out) = inspect(argv) {
                return out;
            }
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
            "relay@u1000",
            None,
            Some(99_999),
            Some("10m"),
        ))
        .unwrap();
        assert_eq!(logs.lines, 2);
        assert_eq!(
            (logs.daemon.as_str(), logs.container.as_str()),
            ("u1000", ID_A)
        );
        assert_eq!(logs.name, "web");
        assert!(logs.text.contains("[stderr] oops"));
        let calls = fake.calls();
        assert_eq!(
            calls[0][4..],
            [
                "docker",
                "-H",
                "unix:///run/user/1000/docker.sock",
                "container",
                "inspect",
                "--format",
                "{{.Id}}\t{{.Name}}",
                "relay"
            ]
        );
        // The logs are read from the full id Docker resolved.
        assert_eq!(
            calls.last().unwrap()[4..],
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
                ID_A
            ]
        );
        // Bad input is refused before anything runs.
        let fake = Fake::new(TWO_DAEMONS, answer);
        for (container, daemon, since) in [
            ("web; reboot", None, None),
            ("-f", None, None),
            ("web", None, Some("1h; id")),
            ("web", Some("root"), None),
            ("web@u1000", Some("system"), None),
        ] {
            assert!(block_on(container_logs_in(
                &fake,
                "/run/user",
                container,
                daemon,
                None,
                since
            ))
            .is_err());
        }
        assert!(fake.calls().is_empty());
        assert!(fake.scripts.lock().unwrap().is_empty());
        // A daemon that is not there is refused.
        let err = block_on(container_logs_in(
            &fake,
            "/run/user",
            "web",
            Some("u2000"),
            None,
            None,
        ))
        .unwrap_err();
        assert!(err.contains("No Docker daemon u2000"), "{err}");
        assert!(fake.calls().is_empty());
        // A container that is not there.
        let err = block_on(container_logs_in(
            &fake,
            "/run/user",
            "ghost",
            None,
            None,
            None,
        ))
        .unwrap_err();
        assert!(err.contains("No such container"), "{err}");
        assert!(!fake.calls().iter().any(|c| c.contains(&"logs".to_owned())));
    }

    #[test]
    fn actions_are_start_stop_restart_only_on_the_resolved_id() {
        fn answer(argv: &[String]) -> ExecOutput {
            if let Some(out) = inspect(argv) {
                out
            } else if argv.contains(&"inspect".to_owned()) {
                ok("running\n")
            } else {
                ok("web\n")
            }
        }
        let fake = Fake::new(TWO_DAEMONS, answer);
        let r = block_on(container_action_in(
            &fake,
            "/run/user",
            "web",
            Some("system"),
            "restart",
        ))
        .unwrap();
        assert!(r.ok);
        assert_eq!(r.state, "running");
        assert_eq!((r.container.as_str(), r.name.as_str()), (ID_A, "web"));
        let calls = fake.calls();
        assert_eq!(
            calls[1],
            [
                "sudo",
                "-n",
                "timeout",
                "180",
                "docker",
                "-H",
                "unix:///var/run/docker.sock",
                "restart",
                ID_A
            ]
        );
        for bad in ["rm", "kill", "prune", "start web", "", "pause"] {
            assert!(
                block_on(container_action_in(&fake, "/run/user", "web", None, bad)).is_err(),
                "{bad}"
            );
        }
        let err = block_on(container_action_in(
            &fake,
            "/run/user",
            "ghost",
            None,
            "stop",
        ))
        .unwrap_err();
        assert!(err.contains("No such container"), "{err}");
        // WECOMMANDER's own containers: started, never stopped or restarted.
        for action in ["stop", "restart"] {
            let err = block_on(container_action_in(
                &fake,
                "/run/user",
                "wecommander-agent",
                None,
                action,
            ))
            .unwrap_err();
            assert!(err.contains("WECOMMANDER"), "{err}");
        }
        assert!(block_on(container_action_in(
            &fake,
            "/run/user",
            "wecommander-agent",
            None,
            "start",
        ))
        .is_ok());
        let calls = fake.calls();
        assert!(!calls.iter().any(|c| c.contains(&ID_B.to_owned())
            && (c.contains(&"stop".to_owned()) || c.contains(&"restart".to_owned()))));
        // Nothing but start/stop/restart and inspect ever reached Docker.
        for c in calls {
            let verb = &c[c.iter().position(|a| a == "docker").unwrap() + 3];
            assert!(
                ["start", "stop", "restart", "inspect", "container"].contains(&verb.as_str()),
                "{c:?}"
            );
        }
    }
}
