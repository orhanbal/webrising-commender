//! Scheduled tasks: systemd timers and cron.
//!
//! Timers are listed with everything systemd knows about them, disabled and
//! not-loaded ones included (`list-timers` shows loaded timers only, so the
//! unit files are listed too and every timer is read with `systemctl show`).
//! They can be enabled, disabled, run now and stopped; WECOMMANDER creates
//! its own timers in /etc/systemd/system, marked with [`MANAGED_MARK`], and
//! edits or deletes only those. Cron is read only.
//!
//! Every change needs root (or sudo without a password), names only units
//! that systemd lists, and returns the exact commands it ran.

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use crate::{first, quote, run, sections, Shell, NEEDS_ROOT};

/// The first line of every unit file WECOMMANDER writes.
pub const MANAGED_MARK: &str = "# Managed by WECOMMANDER";
const UNIT_DIR: &str = "/etc/systemd/system";

const TIMER_PROPS: &str = "Id,Description,UnitFileState,ActiveState,SubState,Unit,TimersCalendar,TimersMonotonic,NextElapseUSecRealtime,LastTriggerUSec,Persistent,FragmentPath";
const SERVICE_PROPS: &str =
    "Id,Description,ExecStart,User,Result,ExecMainStatus,ExecMainExitTimestamp,ActiveState";

/// What WECOMMANDER wrote into a timer it created: the form's fields, for
/// editing.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTimer {
    pub name: String,
    pub description: String,
    pub command: String,
    pub user: String,
    pub calendar: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    /// `name.timer`.
    pub unit: String,
    /// `system`, or `user` (the login user's own `systemctl --user` timers).
    pub scope: String,
    pub description: String,
    /// `enabled`, `disabled`, `static`, `masked`, `indirect`, `generated`…
    pub unit_file_state: String,
    /// `active`, `inactive`, `failed`…
    pub active_state: String,
    pub sub_state: String,
    /// `OnCalendar=` expressions as systemd prints them (`*-*-* 00:00:00`).
    pub calendar: Vec<String>,
    /// Monotonic triggers as systemd prints them (`OnBootUSec=3min`).
    pub monotonic: Vec<String>,
    /// Both, for one line: `OnUnitInactiveUSec=15min ; OnBootUSec=3min`.
    pub schedule: String,
    /// Unix seconds; `None` when not scheduled / never run.
    pub next_run: Option<u64>,
    pub last_run: Option<u64>,
    /// The service it starts.
    pub service: String,
    pub service_description: String,
    /// The service's command line(s), joined by ` ; `.
    pub command: String,
    /// Who the service runs as (`root` when systemd's `User=` is empty).
    pub user: String,
    /// The service's last result (`success`, `exit-code`…) and exit status.
    pub result: String,
    pub exit_status: Option<i32>,
    pub last_exit: Option<u64>,
    pub service_state: String,
    pub fragment_path: String,
    pub persistent: bool,
    /// Set when WECOMMANDER created it: only these can be edited or deleted.
    pub managed: Option<ManagedTimer>,
}

/// One cron line (or a script in /etc/cron.daily and the like).
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CronEntry {
    /// `crontab -l`, `/etc/crontab`, `/etc/cron.d/certbot`, `/etc/cron.daily`.
    pub source: String,
    /// `0 3 * * *`, `@reboot`, `daily`.
    pub schedule: String,
    /// The user it runs as (the login user for `crontab -l`).
    pub user: String,
    pub command: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timers {
    /// "root", "sudo" or "" (only reading is possible).
    pub privilege: String,
    pub login_user: String,
    /// False when the server has no systemctl (then only cron is listed).
    pub systemd: bool,
    pub timers: Vec<Timer>,
    pub cron: Vec<CronEntry>,
    /// The login user's crontab: `ok`, `empty`, `not-readable` or `missing`
    /// (no crontab command).
    pub crontab: String,
    pub crontab_message: String,
}

/// What a change did.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimerResult {
    /// The exact commands that ran (as root), one per line.
    pub command: String,
    pub ok: bool,
    /// The last lines they printed.
    pub output: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimerLogs {
    pub command: String,
    pub lines: Vec<String>,
    /// Why some or all lines may be missing (no right to read the journal).
    pub note: String,
}

/// The fields of the create / edit form.
#[derive(Debug, Clone, Default)]
pub struct TimerSpec {
    pub name: String,
    pub description: String,
    pub command: String,
    pub user: String,
    pub calendar: String,
}

// ---- validation -------------------------------------------------------------

/// A unit name as systemd lists it (`\x2d` escapes allowed); never a template.
pub fn valid_unit(unit: &str, suffix: &str) -> bool {
    unit.len() <= 255
        && unit.len() > suffix.len()
        && unit.ends_with(suffix)
        && !unit.ends_with(&format!("@{suffix}"))
        && !unit.starts_with('-')
        && unit
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._:-\\".contains(c))
}

/// The name of a timer WECOMMANDER creates: `^[a-z0-9][a-z0-9_.-]{0,63}$`,
/// without a `.timer` / `.service` suffix.
pub fn valid_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_.-".contains(c))
        && !name.ends_with(".timer")
        && !name.ends_with(".service")
        && !name.ends_with('.');
    if ok {
        Ok(())
    } else {
        Err("Ad geçersiz: küçük harf, rakam, nokta, alt çizgi ve tire kullanılabilir; harf ya da rakamla başlar, en çok 64 karakter.".into())
    }
}

/// A calendar expression's characters (systemd-analyze checks the meaning).
pub fn valid_calendar(calendar: &str) -> Result<(), String> {
    let c = calendar.trim();
    let ok = !c.is_empty()
        && c.len() <= 200
        && !c.starts_with('-')
        && c.chars()
            .all(|ch| ch.is_ascii_alphanumeric() || " *-:,./~+_".contains(ch));
    if ok {
        Ok(())
    } else {
        Err(
            "Takvim ifadesi geçersiz (örnek: daily, hourly, Mon *-*-* 03:00, *-*-* 04:30:00)."
                .into(),
        )
    }
}

pub fn valid_user(user: &str) -> Result<(), String> {
    let ok = !user.is_empty()
        && user.len() <= 32
        && user
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && user
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_-".contains(c));
    if ok {
        Ok(())
    } else {
        Err("Kullanıcı adı geçersiz.".into())
    }
}

pub fn valid_command(command: &str) -> Result<(), String> {
    let c = command.trim();
    if c.is_empty() || c.len() > 2000 || c.chars().any(|ch| ch.is_control()) {
        return Err("Komut boş olamaz ve tek satır olmalı (en çok 2000 karakter).".into());
    }
    Ok(())
}

pub fn valid_description(description: &str) -> Result<(), String> {
    let d = description.trim();
    if d.len() > 200 || d.chars().any(|ch| ch.is_control()) || d.ends_with('\\') {
        return Err("Açıklama tek satır olmalı (en çok 200 karakter).".into());
    }
    Ok(())
}

fn validate(spec: &TimerSpec) -> Result<TimerSpec, String> {
    let s = TimerSpec {
        name: spec.name.trim().to_owned(),
        description: spec.description.trim().to_owned(),
        command: spec.command.trim().to_owned(),
        user: spec.user.trim().to_owned(),
        calendar: spec.calendar.trim().to_owned(),
    };
    valid_name(&s.name)?;
    valid_description(&s.description)?;
    valid_command(&s.command)?;
    valid_user(&s.user)?;
    valid_calendar(&s.calendar)?;
    Ok(s)
}

/// A unit name as one shell word: plain when it is safe, else quoted.
fn word(unit: &str) -> String {
    if unit
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "@._:-".contains(c))
    {
        unit.to_owned()
    } else {
        quote(unit)
    }
}

// ---- unit files -------------------------------------------------------------

/// The command for `ExecStart=`: run by `/bin/sh -c`, so pipes and `&&` work;
/// escaped for systemd's own quoting, `$` and `%` specifiers.
pub fn exec_start(command: &str) -> String {
    let mut out = String::from("/bin/sh -c \"");
    for c in command.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '$' => out.push_str("$$"),
            '%' => out.push_str("%%"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The command back from an `ExecStart=` that [`exec_start`] wrote.
pub fn command_from_exec_start(value: &str) -> Option<String> {
    let inner = value.strip_prefix("/bin/sh -c \"")?.strip_suffix('"')?;
    let mut out = String::new();
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push(chars.next()?),
            '$' | '%' if chars.peek() == Some(&c) => {
                chars.next();
                out.push(c);
            }
            c => out.push(c),
        }
    }
    Some(out)
}

pub fn service_file(spec: &TimerSpec) -> String {
    format!(
        "{MANAGED_MARK}\n[Unit]\nDescription={}\n\n[Service]\nType=oneshot\nUser={}\nExecStart={}\n",
        spec.description.replace('%', "%%"),
        spec.user,
        exec_start(&spec.command)
    )
}

pub fn timer_file(spec: &TimerSpec) -> String {
    format!(
        "{MANAGED_MARK}\n[Unit]\nDescription={}\n\n[Timer]\nOnCalendar={}\nPersistent=true\nUnit={}.service\n\n[Install]\nWantedBy=timers.target\n",
        spec.description.replace('%', "%%"),
        spec.calendar,
        spec.name
    )
}

/// Reads the form's fields back from the two files WECOMMANDER wrote.
fn parse_managed(name: &str, timer: &[String], service: &[String]) -> Option<ManagedTimer> {
    let has_mark = |lines: &[String]| lines.iter().any(|l| l.trim_end() == MANAGED_MARK);
    if !has_mark(timer) || !has_mark(service) {
        return None;
    }
    let value = |lines: &[String], key: &str| {
        lines
            .iter()
            .find_map(|l| l.strip_prefix(key).map(|v| v.trim_end().to_owned()))
            .unwrap_or_default()
    };
    let exec = value(service, "ExecStart=");
    Some(ManagedTimer {
        name: name.to_owned(),
        description: value(service, "Description=").replace("%%", "%"),
        command: command_from_exec_start(&exec).unwrap_or(exec),
        user: value(service, "User="),
        calendar: value(timer, "OnCalendar="),
    })
}

// ---- reading ----------------------------------------------------------------

fn discover_script() -> String {
    format!(
        r#"echo @@priv; echo "$R"
echo @@me; id -un
echo @@systemd; command -v systemctl >/dev/null 2>&1 && echo yes
echo @@files; systemctl list-unit-files --type=timer --no-legend --no-pager 2>/dev/null
echo @@json; systemctl list-timers --all --output=json --no-pager 2>/dev/null; echo
grep -lsx '{MANAGED_MARK}' {UNIT_DIR}/*.timer 2>/dev/null | while read -r f; do s="${{f%.timer}}.service"; echo "@@mf $f"; cat "$f"; echo; echo "@@mf $s"; cat "$s" 2>/dev/null; echo; done
if [ "$(id -u)" != 0 ]; then
echo @@ufiles; systemctl --user list-unit-files --type=timer --no-legend --no-pager 2>/dev/null
echo @@ujson; systemctl --user list-timers --all --output=json --no-pager 2>/dev/null; echo
fi
echo @@crontab; if command -v crontab >/dev/null 2>&1; then crontab -l 2>&1; rc=$?; echo; echo @@crontabrc; echo $rc; else echo @@nocrontab; fi
echo @@etccrontab; cat /etc/crontab 2>/dev/null; echo
for f in /etc/cron.d/*; do [ -f "$f" ] || continue; if [ -r "$f" ]; then echo "@@crond $f"; cat "$f"; echo; else echo "@@crondx $f"; fi; done
for d in hourly daily weekly monthly; do echo "@@crondir $d"; ls -1 "/etc/cron.$d" 2>/dev/null; done
"#
    )
}

/// `list-unit-files` lines: unit and state.
fn parse_unit_files(lines: &[String]) -> Vec<(String, String)> {
    lines
        .iter()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let unit = f.next()?;
            valid_unit(unit, ".timer").then(|| (unit.to_owned(), f.next().unwrap_or("").to_owned()))
        })
        .collect()
}

/// Microseconds since the epoch (0 or null: never) in seconds.
fn usec(v: &serde_json::Value) -> Option<u64> {
    v.as_u64().filter(|u| *u > 0).map(|u| u / 1_000_000)
}

/// `list-timers --output=json`: unit → (next, last, activates).
pub fn parse_list_timers(text: &str) -> HashMap<String, (Option<u64>, Option<u64>, String)> {
    let start = text.find('[').unwrap_or(text.len());
    let items: Vec<serde_json::Value> =
        serde_json::from_str(text[start..].trim()).unwrap_or_default();
    items
        .iter()
        .filter_map(|t| {
            let unit = t["unit"].as_str()?;
            valid_unit(unit, ".timer").then(|| {
                (
                    unit.to_owned(),
                    (
                        usec(&t["next"]),
                        usec(&t["last"]),
                        t["activates"].as_str().unwrap_or("").to_owned(),
                    ),
                )
            })
        })
        .collect()
}

/// `systemctl show` of several units: one block per unit, blank lines
/// between. A key may repeat (`TimersMonotonic`).
pub fn show_blocks(lines: &[String]) -> Vec<Vec<(String, String)>> {
    let mut blocks = Vec::new();
    let mut current: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            current.push((k.to_owned(), v.to_owned()));
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
}

fn get<'a>(block: &'a [(String, String)], key: &str) -> &'a str {
    block
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .unwrap_or("")
}

/// `{ OnCalendar=*-*-* 00:00:00 ; next_elapse=… }` → `OnCalendar=*-*-* 00:00:00`.
fn trigger(value: &str) -> Option<String> {
    let inner = value
        .trim()
        .trim_start_matches('{')
        .trim_end_matches('}')
        .trim();
    let first = inner.split(" ; ").next()?.trim();
    (!first.is_empty()).then(|| first.to_owned())
}

/// Days since 1970-01-01 of a date (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// A timestamp from `TZ=UTC systemctl show`: `Wed 2026-11-18 00:00:00 UTC`
/// or `@1794911133`; empty or `n/a` is `None`.
pub fn parse_timestamp(text: &str) -> Option<u64> {
    let t = text.trim();
    if let Some(n) = t.strip_prefix('@') {
        return n.split('.').next()?.parse().ok().filter(|n| *n > 0);
    }
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.last().is_some_and(|z| *z != "UTC" && *z != "GMT") {
        return None;
    }
    let date = words
        .iter()
        .find(|w| w.len() == 10 && w.as_bytes()[4] == b'-')?;
    let time = words
        .iter()
        .find(|w| w.len() >= 8 && w.as_bytes()[2] == b':')?;
    let d: Vec<i64> = date.split('-').filter_map(|x| x.parse().ok()).collect();
    let h: Vec<i64> = time
        .split(':')
        .filter_map(|x| x.split('.').next()?.parse().ok())
        .collect();
    if d.len() != 3 || h.len() != 3 {
        return None;
    }
    let secs = days_from_civil(d[0], d[1], d[2]) * 86400 + h[0] * 3600 + h[1] * 60 + h[2];
    u64::try_from(secs).ok().filter(|s| *s > 0)
}

/// A timer from its `systemctl show` block.
pub fn timer_from_show(block: &[(String, String)], scope: &str) -> Timer {
    let mut t = Timer {
        unit: get(block, "Id").to_owned(),
        scope: scope.to_owned(),
        description: get(block, "Description").to_owned(),
        unit_file_state: get(block, "UnitFileState").to_owned(),
        active_state: get(block, "ActiveState").to_owned(),
        sub_state: get(block, "SubState").to_owned(),
        service: get(block, "Unit").to_owned(),
        next_run: parse_timestamp(get(block, "NextElapseUSecRealtime")),
        last_run: parse_timestamp(get(block, "LastTriggerUSec")),
        persistent: get(block, "Persistent") == "yes",
        fragment_path: get(block, "FragmentPath").to_owned(),
        ..Default::default()
    };
    for (k, v) in block {
        match k.as_str() {
            "TimersCalendar" => {
                if let Some(c) = trigger(v) {
                    t.calendar
                        .push(c.strip_prefix("OnCalendar=").unwrap_or(&c).to_owned());
                }
            }
            "TimersMonotonic" => t.monotonic.extend(trigger(v)),
            _ => {}
        }
    }
    t.schedule = t
        .calendar
        .iter()
        .map(|c| format!("OnCalendar={c}"))
        .chain(t.monotonic.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ; ");
    t
}

/// `{ path=… ; argv[]=/usr/bin/foo --bar ; ignore_errors=no ; … }` → the argv.
fn exec_command(value: &str) -> Option<String> {
    let start = value.find("argv[]=")? + "argv[]=".len();
    let rest = &value[start..];
    let end = rest.find(" ; ").unwrap_or(rest.len());
    Some(rest[..end].trim().trim_end_matches('}').trim().to_owned())
}

/// Adds the service's fields from its `systemctl show` block.
pub fn apply_service(t: &mut Timer, block: &[(String, String)]) {
    t.service_description = get(block, "Description").to_owned();
    t.command = block
        .iter()
        .filter(|(k, _)| k == "ExecStart")
        .filter_map(|(_, v)| exec_command(v))
        .collect::<Vec<_>>()
        .join(" ; ");
    t.user = get(block, "User").to_owned();
    if t.user.is_empty() && t.scope == "system" {
        t.user = "root".into();
    }
    t.result = get(block, "Result").to_owned();
    t.exit_status = get(block, "ExecMainStatus").parse().ok();
    t.last_exit = parse_timestamp(get(block, "ExecMainExitTimestamp"));
    t.service_state = get(block, "ActiveState").to_owned();
}

/// Turns one cron line into an entry; `None` for comments, blanks and
/// `NAME=value` lines. `system`: the line has a user field (/etc/crontab,
/// /etc/cron.d).
pub fn parse_cron_line(line: &str, system: bool, source: &str, login: &str) -> Option<CronEntry> {
    let l = line.trim();
    if l.is_empty() || l.starts_with('#') {
        return None;
    }
    // An environment line: NAME=value (the name before any space).
    if let Some(eq) = l.find('=') {
        let name = &l[..eq];
        if !name.is_empty()
            && name
                .trim_end()
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !name.trim_end().contains(' ')
        {
            return None;
        }
    }
    let fields: Vec<&str> = l.split_whitespace().collect();
    let schedule_len = if fields[0].starts_with('@') { 1 } else { 5 };
    let needed = schedule_len + usize::from(system) + 1;
    if fields.len() < needed {
        return None;
    }
    let schedule = fields[..schedule_len].join(" ");
    let user = if system {
        fields[schedule_len].to_owned()
    } else {
        login.to_owned()
    };
    // The command keeps its own spacing: everything after the fields before it.
    let mut rest = l;
    for _ in 0..needed - 1 {
        rest = rest.trim_start();
        rest = &rest[rest.find(char::is_whitespace).unwrap_or(rest.len())..];
    }
    Some(CronEntry {
        source: source.to_owned(),
        schedule,
        user,
        command: rest.trim().to_owned(),
    })
}

fn parse_cron(s: &HashMap<String, Vec<String>>, login: &str) -> (Vec<CronEntry>, String, String) {
    let empty = Vec::new();
    let mut cron = Vec::new();
    let (status, message) = if s.contains_key("nocrontab") {
        ("missing", String::new())
    } else {
        let out = s.get("crontab").unwrap_or(&empty);
        let text = out.join("\n");
        let rc = first(s, "crontabrc");
        if rc == "0" {
            cron.extend(
                out.iter()
                    .filter_map(|l| parse_cron_line(l, false, "crontab -l", login)),
            );
            ("ok", String::new())
        } else if text.contains("no crontab for") {
            ("empty", String::new())
        } else {
            // "fopen: Permission denied" and the like: not readable, not an error.
            ("not-readable", text.trim().to_owned())
        }
    };
    cron.extend(
        s.get("etccrontab")
            .unwrap_or(&empty)
            .iter()
            .filter_map(|l| parse_cron_line(l, true, "/etc/crontab", login)),
    );
    let mut keys: Vec<&String> = s.keys().collect();
    keys.sort();
    for key in &keys {
        if let Some(path) = key.strip_prefix("crond ") {
            cron.extend(
                s[*key]
                    .iter()
                    .filter_map(|l| parse_cron_line(l, true, path, login)),
            );
        } else if let Some(path) = key.strip_prefix("crondx ") {
            cron.push(CronEntry {
                source: path.to_owned(),
                schedule: String::new(),
                user: String::new(),
                command: String::new(),
            });
        }
    }
    for period in ["hourly", "daily", "weekly", "monthly"] {
        let dir = format!("/etc/cron.{period}");
        for name in s.get(&format!("crondir {period}")).unwrap_or(&empty) {
            let name = name.trim();
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            cron.push(CronEntry {
                source: dir.clone(),
                schedule: period.to_owned(),
                user: "root".into(),
                command: format!("{dir}/{name}"),
            });
        }
    }
    (cron, status.to_owned(), message)
}

/// Timers (system, then the login user's), read in up to three runs:
/// discovery, the timers, their services.
pub async fn timers<S: Shell>(sh: &S) -> Result<Timers, String> {
    let s = sections(&run(sh, &discover_script(), 60).await?);
    let login = first(&s, "me").to_owned();
    let empty = Vec::new();
    let (cron, crontab, crontab_message) = parse_cron(&s, &login);
    let mut out = Timers {
        privilege: first(&s, "priv").to_owned(),
        login_user: login.clone(),
        systemd: first(&s, "systemd") == "yes",
        cron,
        crontab,
        crontab_message,
        ..Default::default()
    };
    if !out.systemd {
        return Ok(out);
    }
    let mut scopes = Vec::new();
    for (scope, files, json) in [("system", "files", "json"), ("user", "ufiles", "ujson")] {
        let listed = parse_unit_files(s.get(files).unwrap_or(&empty));
        let loaded = parse_list_timers(&s.get(json).map(|l| l.join("\n")).unwrap_or_default());
        let mut units: BTreeSet<String> = listed.iter().map(|(u, _)| u.clone()).collect();
        units.extend(loaded.keys().cloned());
        if !units.is_empty() {
            scopes.push((scope, units, listed, loaded));
        }
    }
    if scopes.is_empty() {
        return Ok(out);
    }
    let flag = |scope: &str| if scope == "user" { " --user" } else { "" };
    let mut script = String::new();
    for (scope, units, _, _) in &scopes {
        let list: Vec<String> = units.iter().map(|u| quote(u)).collect();
        script.push_str(&format!(
            "echo @@show{scope}; TZ=UTC systemctl{} show {} -p {TIMER_PROPS} --no-pager 2>/dev/null\n",
            flag(scope),
            list.join(" ")
        ));
    }
    let shown = sections(&run(sh, &script, 60).await?);
    let mut services_script = String::new();
    let mut by_scope = Vec::new();
    for (scope, _, listed, loaded) in &scopes {
        let states: HashMap<&str, &str> = listed
            .iter()
            .map(|(u, st)| (u.as_str(), st.as_str()))
            .collect();
        let mut timers: Vec<Timer> =
            show_blocks(shown.get(&format!("show{scope}")).unwrap_or(&empty))
                .iter()
                .map(|b| timer_from_show(b, scope))
                .filter(|t| valid_unit(&t.unit, ".timer"))
                .collect();
        for t in &mut timers {
            if t.unit_file_state.is_empty() {
                t.unit_file_state = states
                    .get(t.unit.as_str())
                    .copied()
                    .unwrap_or("")
                    .to_owned();
            }
            if let Some((next, last, activates)) = loaded.get(&t.unit) {
                t.next_run = next.or(t.next_run);
                t.last_run = last.or(t.last_run);
                if t.service.is_empty() {
                    t.service = activates.clone();
                }
            }
            if t.service.is_empty() {
                t.service = format!("{}.service", t.unit.trim_end_matches(".timer"));
            }
            if *scope == "system" {
                if let Some(name) = t
                    .fragment_path
                    .strip_prefix(&format!("{UNIT_DIR}/"))
                    .and_then(|f| f.strip_suffix(".timer"))
                {
                    let timer_file = s.get(&format!("mf {UNIT_DIR}/{name}.timer"));
                    let service_file = s.get(&format!("mf {UNIT_DIR}/{name}.service"));
                    if let (Some(tf), Some(sf)) = (timer_file, service_file) {
                        if t.service == format!("{name}.service") {
                            t.managed = parse_managed(name, tf, sf);
                        }
                    }
                }
            }
        }
        let services: BTreeSet<String> = timers
            .iter()
            .map(|t| t.service.clone())
            .filter(|u| valid_unit(u, ".service"))
            .collect();
        if !services.is_empty() {
            let list: Vec<String> = services.iter().map(|u| quote(u)).collect();
            services_script.push_str(&format!(
                "echo @@svc{scope}; TZ=UTC systemctl{} show {} -p {SERVICE_PROPS} --no-pager 2>/dev/null\n",
                flag(scope),
                list.join(" ")
            ));
        }
        by_scope.push((*scope, timers));
    }
    let svc = if services_script.is_empty() {
        HashMap::new()
    } else {
        sections(&run(sh, &services_script, 60).await?)
    };
    for (scope, mut timers) in by_scope {
        let blocks = show_blocks(svc.get(&format!("svc{scope}")).unwrap_or(&empty));
        for t in &mut timers {
            if let Some(b) = blocks.iter().find(|b| get(b, "Id") == t.service) {
                apply_service(t, b);
            } else if t.user.is_empty() && scope == "system" {
                t.user = "root".into();
            }
        }
        timers.sort_by(|a, b| a.unit.cmp(&b.unit));
        out.timers.extend(timers);
    }
    Ok(out)
}

/// Something [`timers`] could not read or does not read, so a short list is
/// not taken for a complete one.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Unreadable {
    /// `crontab -l`, `/etc/cron.d/backup`, `systemd`, `other users`.
    pub source: String,
    pub reason: String,
}

/// A file in /etc/cron.d the login user may not read: [`timers`] lists it
/// with its path only.
pub fn cron_unreadable(entry: &CronEntry) -> bool {
    entry.schedule.is_empty() && entry.command.is_empty()
}

/// What [`timers`] left out: no systemd, the login user's crontab when it
/// cannot be read, unreadable cron files, and the scopes it never reads.
pub fn unreadable(t: &Timers) -> Vec<Unreadable> {
    let item = |source: &str, reason: String| Unreadable {
        source: source.to_owned(),
        reason,
    };
    let mut out = Vec::new();
    if !t.systemd {
        out.push(item(
            "systemd",
            "systemctl is not available: no systemd timers are listed".into(),
        ));
    }
    match t.crontab.as_str() {
        "missing" => out.push(item(
            "crontab -l",
            "the crontab command is not installed".into(),
        )),
        "not-readable" => out.push(item(
            "crontab -l",
            if t.crontab_message.is_empty() {
                "not readable".into()
            } else {
                t.crontab_message.clone()
            },
        )),
        _ => {}
    }
    for entry in t.cron.iter().filter(|e| cron_unreadable(e)) {
        out.push(item(
            &entry.source,
            format!("not readable by {}", t.login_user),
        ));
    }
    if t.systemd && t.login_user == "root" {
        out.push(item(
            "systemctl --user",
            "user timers are not read when running as root".into(),
        ));
    }
    out.push(item(
        "other users",
        "other users' crontabs (/var/spool/cron) and systemctl --user timers are not read".into(),
    ));
    out
}

// ---- changes ----------------------------------------------------------------

/// One step of a change: what is shown and what runs (as root).
struct Step {
    shown: String,
    run: String,
}

fn root(command: String) -> Step {
    Step {
        run: format!("r {command}"),
        shown: command,
    }
}

/// Writes `content` to `path` as root.
fn write(path: &str, content: &str) -> Step {
    let data = quote(content);
    Step {
        shown: format!("printf '%s' {data} | tee {path} >/dev/null"),
        run: format!("printf '%s' {data} | r tee {path} >/dev/null"),
    }
}

async fn run_steps<S: Shell>(sh: &S, steps: &[Step], secs: u64) -> Result<TimerResult, String> {
    let chain: Vec<&str> = steps.iter().map(|s| s.run.as_str()).collect();
    let script = format!(
        "[ \"$R\" ] || {{ echo @@noroot; exit 0; }}\nout=$( {{ {}; }} 2>&1 ); c=$?\necho @@out; printf '%s\\n' \"$out\" | tail -20; echo @@code; echo $c\n",
        chain.join(" && ")
    );
    let s = sections(&run(sh, &script, secs).await?);
    if s.contains_key("noroot") {
        return Err(NEEDS_ROOT.into());
    }
    Ok(TimerResult {
        command: steps
            .iter()
            .map(|s| s.shown.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        ok: first(&s, "code") == "0",
        output: s
            .get("out")
            .map(|l| l.join("\n"))
            .unwrap_or_default()
            .trim()
            .to_owned(),
    })
}

/// A system timer that systemd lists, with its service.
struct Known {
    privilege: String,
    service: String,
}

async fn known<S: Shell>(sh: &S, unit: &str) -> Result<Known, String> {
    let unit = unit.trim();
    if !valid_unit(unit, ".timer") {
        return Err("Bu zamanlayıcı bulunamadı.".into());
    }
    let script = format!(
        "echo @@priv; echo \"$R\"\necho @@files; systemctl list-unit-files --type=timer --no-legend --no-pager 2>/dev/null\necho @@json; systemctl list-timers --all --output=json --no-pager 2>/dev/null; echo\necho @@show; systemctl show {} -p Id,Unit,LoadState,FragmentPath --no-pager 2>/dev/null\n",
        quote(unit)
    );
    let s = sections(&run(sh, &script, 30).await?);
    let empty = Vec::new();
    let listed = parse_unit_files(s.get("files").unwrap_or(&empty))
        .iter()
        .any(|(u, _)| u == unit)
        || parse_list_timers(&s.get("json").map(|l| l.join("\n")).unwrap_or_default())
            .contains_key(unit);
    let blocks = show_blocks(s.get("show").unwrap_or(&empty));
    let block = blocks.first().map(|b| b.as_slice()).unwrap_or(&[]);
    if !listed || get(block, "Id") != unit || get(block, "LoadState") == "not-found" {
        return Err("Bu zamanlayıcı bulunamadı.".into());
    }
    let mut service = get(block, "Unit").to_owned();
    if service.is_empty() {
        service = format!("{}.service", unit.trim_end_matches(".timer"));
    }
    if !valid_unit(&service, ".service") {
        return Err("Bu zamanlayıcının servisi okunamadı.".into());
    }
    Ok(Known {
        privilege: first(&s, "priv").to_owned(),
        service,
    })
}

/// The command for one action on a timer and its service.
pub fn action_command(unit: &str, service: &str, action: &str) -> Result<String, String> {
    Ok(match action {
        "enable" => format!("systemctl enable --now {}", word(unit)),
        "disable" => format!("systemctl disable --now {}", word(unit)),
        // Runs the job now without waiting for it to finish.
        "start-now" => format!("systemctl start --no-block {}", word(service)),
        // Stops the job if it is running (the timer stays as it is).
        "stop" => format!("systemctl stop {}", word(service)),
        _ => return Err("unknown action".into()),
    })
}

/// `action`: enable, disable, start-now (runs the service now), stop (stops
/// the running service).
pub async fn timer_action<S: Shell>(
    sh: &S,
    unit: String,
    action: String,
) -> Result<TimerResult, String> {
    action_command("x.timer", "x.service", &action)?;
    let k = known(sh, &unit).await?;
    if k.privilege.is_empty() {
        return Err(NEEDS_ROOT.into());
    }
    let command = action_command(unit.trim(), &k.service, &action)?;
    run_steps(sh, &[root(format!("timeout 120 {command}"))], 150)
        .await
        .map(|mut r| {
            r.command = command;
            r
        })
}

const JOURNAL_DENIED: &str = "Bu kullanıcı sistem günlüğünü okuyamıyor; kayıtların tamamı için root, sudo ya da systemd-journal / adm grubu gerekir.";

/// The service's last journal lines (read only; root is used when there is
/// one, else the login user reads what it may).
pub async fn timer_logs<S: Shell>(sh: &S, unit: String, lines: u32) -> Result<TimerLogs, String> {
    let k = known(sh, &unit).await?;
    let n = lines.clamp(1, 2000);
    let command = format!(
        "journalctl -u {} -n {n} --no-pager -o short-iso",
        word(&k.service)
    );
    let script = format!(
        "command -v journalctl >/dev/null 2>&1 || {{ echo @@nojournal; exit 0; }}\necho @@log; if [ \"$R\" ]; then r timeout 60 {command} 2>&1; else timeout 60 {command} 2>&1; fi\n"
    );
    let s = sections(&run(sh, &script, 90).await?);
    if s.contains_key("nojournal") {
        return Err("Sunucuda journalctl yok.".into());
    }
    let mut note = String::new();
    let mut out = Vec::new();
    for line in s.get("log").into_iter().flatten() {
        if line.contains("insufficient permissions")
            || line.contains("not seeing messages from other users")
            || line.contains("Users in groups")
            || line.starts_with("Hint:")
            || line.contains("Permission denied")
        {
            note = JOURNAL_DENIED.into();
            continue;
        }
        if line.trim() == "-- No entries --" {
            continue;
        }
        out.push(line.clone());
    }
    if out.is_empty() && note.is_empty() {
        note = "Bu servis için günlük kaydı yok.".into();
    }
    Ok(TimerLogs {
        command,
        lines: out,
        note,
    })
}

/// The steps that write a timer's two files and load them.
fn write_steps(spec: &TimerSpec, edit: bool) -> Vec<Step> {
    let name = &spec.name;
    let mut steps = vec![
        write(&format!("{UNIT_DIR}/{name}.service"), &service_file(spec)),
        write(&format!("{UNIT_DIR}/{name}.timer"), &timer_file(spec)),
        root("systemctl daemon-reload".into()),
    ];
    if edit {
        // A running timer picks up the new schedule; a stopped one stays stopped.
        steps.push(root(format!("systemctl try-restart {name}.timer")));
    } else {
        steps.push(root(format!("systemctl enable --now {name}.timer")));
    }
    steps
}

/// What a create or edit will run, for the confirmation (the same text the
/// result carries).
pub fn write_command(spec: &TimerSpec, edit: bool) -> String {
    write_steps(spec, edit)
        .iter()
        .map(|s| s.shown.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Checks the calendar with `systemd-analyze` and the user with `id`; for an
/// edit or delete, that the timer is WECOMMANDER's.
async fn precheck<S: Shell>(
    sh: &S,
    name: &str,
    calendar: Option<&str>,
    user: Option<&str>,
    must_be_managed: bool,
) -> Result<(), String> {
    let timer = format!("{UNIT_DIR}/{name}.timer");
    let service = format!("{UNIT_DIR}/{name}.service");
    let mut script = String::from("[ \"$R\" ] || { echo @@noroot; exit 0; }\n");
    if must_be_managed {
        script.push_str(&format!(
            "echo @@managed; grep -qsx '{MANAGED_MARK}' {timer} && grep -qsx '{MANAGED_MARK}' {service} && echo yes\necho @@fragment; systemctl show {name}.timer -p FragmentPath --value --no-pager 2>/dev/null\n"
        ));
    } else {
        script.push_str(&format!(
            "echo @@exists; for u in {name}.timer {name}.service; do if [ -e {UNIT_DIR}/$u ] || systemctl cat $u >/dev/null 2>&1; then echo $u; fi; done\n"
        ));
    }
    if let Some(c) = calendar {
        script.push_str(&format!(
            "echo @@cal; if command -v systemd-analyze >/dev/null 2>&1; then systemd-analyze calendar {} 2>&1; echo @@calrc; echo $?; else echo @@calrc; echo 0; fi\n",
            quote(c)
        ));
    }
    if let Some(u) = user {
        script.push_str(&format!(
            "echo @@user; id -u {} >/dev/null 2>&1 && echo yes\n",
            quote(u)
        ));
    }
    let s = sections(&run(sh, &script, 30).await?);
    if s.contains_key("noroot") {
        return Err(NEEDS_ROOT.into());
    }
    if must_be_managed {
        if first(&s, "managed") != "yes" || first(&s, "fragment") != timer {
            return Err("Bu zamanlayıcıyı WECOMMANDER oluşturmadı; yalnız WECOMMANDER'ın oluşturdukları düzenlenip silinebilir.".into());
        }
    } else if !first(&s, "exists").is_empty() {
        return Err(format!(
            "Bu adla bir birim zaten var: {}. Başka bir ad seçin.",
            first(&s, "exists")
        ));
    }
    if calendar.is_some() && first(&s, "calrc") != "0" {
        let why = s
            .get("cal")
            .into_iter()
            .flatten()
            .map(|l| l.trim())
            .find(|l| l.contains("Failed") || l.contains("Invalid") || l.contains("invalid"))
            .unwrap_or("")
            .to_owned();
        return Err(format!("Takvim ifadesi geçersiz: {why}").trim().to_owned());
    }
    if user.is_some() && first(&s, "user") != "yes" {
        return Err("Sunucuda bu kullanıcı yok.".into());
    }
    Ok(())
}

/// Writes `/etc/systemd/system/<name>.timer` and `.service` (marked as
/// WECOMMANDER's), reloads systemd and starts the timer.
pub async fn timer_create<S: Shell>(sh: &S, spec: TimerSpec) -> Result<TimerResult, String> {
    let spec = validate(&spec)?;
    precheck(
        sh,
        &spec.name,
        Some(&spec.calendar),
        Some(&spec.user),
        false,
    )
    .await?;
    run_steps(sh, &write_steps(&spec, false), 120).await
}

/// Rewrites both files of a timer WECOMMANDER created.
pub async fn timer_edit<S: Shell>(sh: &S, spec: TimerSpec) -> Result<TimerResult, String> {
    let spec = validate(&spec)?;
    precheck(sh, &spec.name, Some(&spec.calendar), Some(&spec.user), true).await?;
    run_steps(sh, &write_steps(&spec, true), 120).await
}

/// The commands that delete a WECOMMANDER timer.
pub fn delete_command(name: &str) -> String {
    delete_steps(name)
        .iter()
        .map(|s| s.shown.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn delete_steps(name: &str) -> Vec<Step> {
    vec![
        root(format!("systemctl disable --now {name}.timer")),
        root(format!(
            "rm -f {UNIT_DIR}/{name}.timer {UNIT_DIR}/{name}.service"
        )),
        root("systemctl daemon-reload".into()),
    ]
}

/// Stops, disables and removes a timer WECOMMANDER created (both files).
pub async fn timer_delete<S: Shell>(sh: &S, unit: String) -> Result<TimerResult, String> {
    let name = unit.trim().trim_end_matches(".timer").to_owned();
    valid_name(&name)?;
    precheck(sh, &name, None, None, true).await?;
    run_steps(sh, &delete_steps(&name), 120).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(str::to_owned).collect()
    }

    // Real output from an Ubuntu 24.04 server (systemd 255).
    const DEVAGENT_SHOW: &str = "Unit=devagent-local-ci.service
TimersMonotonic={ OnUnitInactiveUSec=15min ; next_elapse=0 }
TimersMonotonic={ OnBootUSec=3min ; next_elapse=0 }
NextElapseUSecRealtime=
LastTriggerUSec=
Persistent=yes
Id=devagent-local-ci.timer
Description=Check DEVAGENT branch for new commits every 15 minutes
ActiveState=inactive
SubState=dead
FragmentPath=/etc/systemd/system/devagent-local-ci.timer
UnitFileState=disabled";

    const DEVAGENT_SERVICE: &str = "Result=success
ExecMainExitTimestamp=
ExecMainStatus=0
ExecStart={ path=/usr/local/libexec/devagent-ci-poll ; argv[]=/usr/local/libexec/devagent-ci-poll ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }
User=devagent-ci
Id=devagent-local-ci.service
Description=DEVAGENT offline-safe local CI acceptance (no GitHub Actions)
ActiveState=inactive
FragmentPath=/etc/systemd/system/devagent-local-ci.service";

    const LIST_TIMERS: &str = r#"[{"next":1794911133473556,"left":1794911133473556,"last":1794911069735597,"passed":3978057701512,"unit":"maxiom-api-alias-sync.timer","activates":"maxiom-api-alias-sync.service"},{"next":1794911400000000,"left":1794911400000000,"last":1794910801508124,"passed":3977789474040,"unit":"sysstat-collect.timer","activates":"sysstat-collect.service"},{"next":1794960000000000,"left":1794960000000000,"last":1794873601532663,"passed":3940589498578,"unit":"logrotate.timer","activates":"logrotate.service"},{"next":null,"left":null,"last":0,"passed":0,"unit":"apport-autoreport.timer","activates":"apport-autoreport.service"}]"#;

    #[test]
    fn a_disabled_timer_is_read_from_systemctl_show() {
        let blocks = show_blocks(&lines(DEVAGENT_SHOW));
        assert_eq!(blocks.len(), 1);
        let mut t = timer_from_show(&blocks[0], "system");
        assert_eq!(t.unit, "devagent-local-ci.timer");
        assert_eq!(t.unit_file_state, "disabled");
        assert_eq!(t.active_state, "inactive");
        assert_eq!(t.sub_state, "dead");
        assert!(t.calendar.is_empty());
        assert_eq!(t.monotonic, ["OnUnitInactiveUSec=15min", "OnBootUSec=3min"]);
        assert_eq!(t.schedule, "OnUnitInactiveUSec=15min ; OnBootUSec=3min");
        assert_eq!((t.next_run, t.last_run), (None, None));
        assert!(t.persistent);
        assert_eq!(t.service, "devagent-local-ci.service");
        assert_eq!(
            t.fragment_path,
            "/etc/systemd/system/devagent-local-ci.timer"
        );
        apply_service(&mut t, &show_blocks(&lines(DEVAGENT_SERVICE))[0]);
        assert_eq!(t.user, "devagent-ci");
        assert_eq!(t.command, "/usr/local/libexec/devagent-ci-poll");
        assert_eq!(t.result, "success");
        assert_eq!(t.exit_status, Some(0));
        assert_eq!(t.last_exit, None);
        assert_eq!(t.service_state, "inactive");
        assert!(t.managed.is_none());
    }

    #[test]
    fn several_units_in_one_show_are_split_by_blank_lines() {
        let text = format!(
            "{DEVAGENT_SHOW}\n\nId=logrotate.timer\nUnit=logrotate.service\nTimersCalendar={{ OnCalendar=*-*-* 00:00:00 ; next_elapse=Wed 2026-11-18 00:00:00 UTC }}\nNextElapseUSecRealtime=Wed 2026-11-18 00:00:00 UTC\nLastTriggerUSec=Tue 2026-11-17 00:00:01 UTC\nUnitFileState=enabled\nActiveState=active\n"
        );
        let blocks = show_blocks(&lines(&text));
        assert_eq!(blocks.len(), 2);
        let t = timer_from_show(&blocks[1], "system");
        assert_eq!(t.calendar, ["*-*-* 00:00:00"]);
        assert_eq!(t.schedule, "OnCalendar=*-*-* 00:00:00");
        assert_eq!(t.next_run, Some(1794960000));
        assert_eq!(t.last_run, Some(1794873601));
    }

    #[test]
    fn list_timers_json_has_null_and_zero_for_never() {
        let m = parse_list_timers(LIST_TIMERS);
        assert_eq!(m.len(), 4);
        assert_eq!(
            m["logrotate.timer"],
            (
                Some(1794960000),
                Some(1794873601),
                "logrotate.service".into()
            )
        );
        assert_eq!(m["apport-autoreport.timer"].0, None);
        assert_eq!(m["apport-autoreport.timer"].1, None);
        // The disabled timer is not loaded, so not in this list at all.
        assert!(!m.contains_key("devagent-local-ci.timer"));
        assert!(parse_list_timers("").is_empty());
        assert!(parse_list_timers("garbage").is_empty());
    }

    #[test]
    fn unit_files_list_disabled_timers_too() {
        let l = parse_unit_files(&lines(
            "apport-autoreport.timer        enabled  enabled\ndevagent-local-ci.timer        disabled enabled\nsnapd.snap-repair.timer enabled enabled\ngetty@.timer static -\nbad name.timer x",
        ));
        let units: Vec<&str> = l.iter().map(|(u, _)| u.as_str()).collect();
        assert_eq!(
            units,
            [
                "apport-autoreport.timer",
                "devagent-local-ci.timer",
                "snapd.snap-repair.timer"
            ]
        );
        assert_eq!(l[1].1, "disabled");
    }

    #[test]
    fn timestamps_from_systemctl_show() {
        assert_eq!(
            parse_timestamp("Wed 2026-11-18 00:00:00 UTC"),
            Some(1794960000)
        );
        assert_eq!(parse_timestamp("@1794960000"), Some(1794960000));
        assert_eq!(parse_timestamp(""), None);
        assert_eq!(parse_timestamp("n/a"), None);
        assert_eq!(parse_timestamp("Wed 2026-11-18 03:00:00 +03"), None);
        assert_eq!(parse_timestamp("Thu 1970-01-01 00:00:00 UTC"), None);
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
    }

    #[test]
    fn cron_lines_become_schedule_and_command() {
        let e = parse_cron_line(
            "0 3 * * *   /usr/local/bin/backup.sh --full  >/dev/null 2>&1",
            false,
            "crontab -l",
            "wecommander",
        )
        .unwrap();
        assert_eq!(e.schedule, "0 3 * * *");
        assert_eq!(e.user, "wecommander");
        assert_eq!(
            e.command,
            "/usr/local/bin/backup.sh --full  >/dev/null 2>&1"
        );
        let e = parse_cron_line("0 */12 * * * root test -x /usr/bin/certbot -a \\! -d /run/systemd/system && perl -e 'sleep int(rand(43200))' && certbot -q renew", true, "/etc/cron.d/certbot", "x").unwrap();
        assert_eq!(e.schedule, "0 */12 * * *");
        assert_eq!(e.user, "root");
        assert!(e.command.starts_with("test -x /usr/bin/certbot"));
        let e = parse_cron_line(
            "@reboot root /usr/local/bin/start",
            true,
            "/etc/cron.d/x",
            "x",
        )
        .unwrap();
        assert_eq!(
            (e.schedule.as_str(), e.user.as_str(), e.command.as_str()),
            ("@reboot", "root", "/usr/local/bin/start")
        );
        assert!(parse_cron_line("# m h dom mon dow command", true, "", "").is_none());
        assert!(parse_cron_line("SHELL=/bin/sh", true, "", "").is_none());
        assert!(parse_cron_line("PATH = /usr/bin:/bin", true, "", "").is_none());
        assert!(parse_cron_line("MAILTO=\"\"", false, "", "").is_none());
        assert!(parse_cron_line("   ", false, "", "").is_none());
        assert!(parse_cron_line("0 3 * *", false, "", "").is_none());
        // An `=` inside the command is not an environment line.
        let e = parse_cron_line("*/5 * * * * root cd /x && A=1 run", true, "s", "").unwrap();
        assert_eq!(e.command, "cd /x && A=1 run");
    }

    #[test]
    fn crontab_permission_denied_is_not_readable_not_an_error() {
        let s = sections("@@me\nwecommander\n@@crontab\nfopen: Permission denied\n\n@@crontabrc\n1\n@@etccrontab\nSHELL=/bin/sh\n17 * * * * root cd / && run-parts --report /etc/cron.hourly\n\n@@crond /etc/cron.d/certbot\n0 */12 * * * root certbot -q renew\n\n@@crondx /etc/cron.d/secret\n@@crondir hourly\n@@crondir daily\napt-compat\nlogrotate\n.placeholder\n@@crondir weekly\n@@crondir monthly\n");
        let (cron, status, message) = parse_cron(&s, "wecommander");
        assert_eq!(status, "not-readable");
        assert!(message.contains("Permission denied"));
        let sources: Vec<&str> = cron.iter().map(|c| c.source.as_str()).collect();
        assert_eq!(
            sources,
            [
                "/etc/crontab",
                "/etc/cron.d/certbot",
                "/etc/cron.d/secret",
                "/etc/cron.daily",
                "/etc/cron.daily"
            ]
        );
        assert_eq!(cron[4].command, "/etc/cron.daily/logrotate");
        assert_eq!(cron[4].schedule, "daily");
        let s = sections("@@crontab\nno crontab for bob\n\n@@crontabrc\n1\n");
        assert_eq!(parse_cron(&s, "bob").1, "empty");
        let s = sections("@@crontab\n# hi\n15 4 * * 1 /home/bob/weekly\n\n@@crontabrc\n0\n");
        let (cron, status, _) = parse_cron(&s, "bob");
        assert_eq!(status, "ok");
        assert_eq!(cron[0].source, "crontab -l");
        assert_eq!(cron[0].user, "bob");
        let s = sections("@@crontab\n@@nocrontab\n");
        assert_eq!(parse_cron(&s, "bob").1, "missing");
    }

    #[test]
    fn names_users_and_calendars_are_checked() {
        assert!(valid_name("backup").is_ok());
        assert!(valid_name("db-dump_2.nightly").is_ok());
        assert!(valid_name(&"a".repeat(64)).is_ok());
        assert!(valid_name(&"a".repeat(65)).is_err());
        for bad in [
            "",
            "-x",
            ".x",
            "_x",
            "Backup",
            "a b",
            "a;rm",
            "a/b",
            "x.timer",
            "x.service",
            "a$",
            "é",
        ] {
            assert!(valid_name(bad).is_err(), "{bad}");
        }
        assert!(valid_calendar("daily").is_ok());
        assert!(valid_calendar("Mon..Fri *-*-* 03:00:00").is_ok());
        assert!(valid_calendar("*-*-* 04:30:00 Europe/Istanbul").is_ok());
        assert!(valid_calendar("*:0/15").is_ok());
        for bad in ["", "daily; rm -rf /", "$(id)", "a'b", "-1", "x\ny"] {
            assert!(valid_calendar(bad).is_err(), "{bad}");
        }
        assert!(valid_user("root").is_ok());
        assert!(valid_user("devagent-ci").is_ok());
        for bad in ["", "Root", "a b", "a;b", "-x", "1x"] {
            assert!(valid_user(bad).is_err(), "{bad}");
        }
        assert!(valid_command("echo hi | logger").is_ok());
        assert!(valid_command("a\nb").is_err());
        assert!(valid_command("  ").is_err());
        assert!(valid_description("Nightly backup").is_ok());
        assert!(valid_description("a\nb").is_err());
        assert!(valid_unit("devagent-local-ci.timer", ".timer"));
        assert!(valid_unit("systemd-tmpfiles-clean.timer", ".timer"));
        assert!(valid_unit("dev-disk-by\\x2duuid.timer", ".timer"));
        assert!(!valid_unit("getty@.timer", ".timer"));
        assert!(!valid_unit("x.timer; reboot", ".timer"));
        assert!(!valid_unit(".timer", ".timer"));
        assert!(!valid_unit("x.service", ".timer"));
    }

    #[test]
    fn exec_start_quotes_for_systemd_and_reads_back() {
        let cmd = r#"cd /srv && pg_dump "$DB" | gzip > /backup/db-$(date +%F).gz \ end"#;
        let exec = exec_start(cmd);
        assert_eq!(
            exec,
            r#"/bin/sh -c "cd /srv && pg_dump \"$$DB\" | gzip > /backup/db-$$(date +%%F).gz \\ end""#
        );
        assert_eq!(command_from_exec_start(&exec).as_deref(), Some(cmd));
        assert_eq!(command_from_exec_start("/usr/bin/x"), None);
    }

    fn spec() -> TimerSpec {
        TimerSpec {
            name: "nightly-backup".into(),
            description: "Nightly backup 100%".into(),
            command: "echo 'it''s' > /tmp/x".into(),
            user: "backup".into(),
            calendar: "*-*-* 03:00:00".into(),
        }
    }

    #[test]
    fn unit_files_are_marked_and_read_back() {
        let s = spec();
        let service = service_file(&s);
        let timer = timer_file(&s);
        assert!(service.starts_with("# Managed by WECOMMANDER\n"));
        assert!(timer.starts_with("# Managed by WECOMMANDER\n"));
        assert!(service.contains("\nUser=backup\n"));
        assert!(service.contains("\nType=oneshot\n"));
        assert!(service.contains("Description=Nightly backup 100%%\n"));
        assert!(timer.contains("\nOnCalendar=*-*-* 03:00:00\n"));
        assert!(timer.contains("\nUnit=nightly-backup.service\n"));
        assert!(timer.contains("\nWantedBy=timers.target\n"));
        let m = parse_managed("nightly-backup", &lines(&timer), &lines(&service)).unwrap();
        assert_eq!(m.description, s.description);
        assert_eq!(m.command, s.command);
        assert_eq!(m.user, s.user);
        assert_eq!(m.calendar, s.calendar);
        // A file without the mark is not ours.
        assert!(
            parse_managed("x", &lines("[Timer]\nOnCalendar=daily"), &lines(&service)).is_none()
        );
    }

    #[test]
    fn commands_are_fixed_and_quoted() {
        assert_eq!(
            action_command(
                "devagent-local-ci.timer",
                "devagent-local-ci.service",
                "enable"
            )
            .unwrap(),
            "systemctl enable --now devagent-local-ci.timer"
        );
        assert_eq!(
            action_command("a.timer", "a.service", "disable").unwrap(),
            "systemctl disable --now a.timer"
        );
        assert_eq!(
            action_command("a.timer", "a.service", "start-now").unwrap(),
            "systemctl start --no-block a.service"
        );
        assert_eq!(
            action_command("a.timer", "a.service", "stop").unwrap(),
            "systemctl stop a.service"
        );
        assert_eq!(
            action_command("dev-x\\x2dy.timer", "a.service", "enable").unwrap(),
            "systemctl enable --now 'dev-x\\x2dy.timer'"
        );
        assert!(action_command("a.timer", "a.service", "rm").is_err());
        let c = write_command(&spec(), false);
        let lines: Vec<&str> = c.lines().collect();
        assert!(lines[0].starts_with("printf '%s' '# Managed by WECOMMANDER"));
        assert!(c.contains("echo '\\''it'\\'''\\''s'\\'' > /tmp/x"), "{c}");
        assert!(c.contains("| tee /etc/systemd/system/nightly-backup.service >/dev/null"));
        assert!(c.contains("| tee /etc/systemd/system/nightly-backup.timer >/dev/null"));
        assert!(c.ends_with("systemctl daemon-reload\nsystemctl enable --now nightly-backup.timer"));
        assert!(
            write_command(&spec(), true).ends_with("systemctl try-restart nightly-backup.timer")
        );
        assert_eq!(
            delete_command("nightly-backup"),
            "systemctl disable --now nightly-backup.timer\nrm -f /etc/systemd/system/nightly-backup.timer /etc/systemd/system/nightly-backup.service\nsystemctl daemon-reload"
        );
    }

    /// Answers each script with the next canned output and keeps the scripts.
    struct Canned {
        answers: Mutex<Vec<String>>,
        scripts: Mutex<Vec<String>>,
    }

    impl Canned {
        fn new(answers: &[&str]) -> Self {
            Canned {
                answers: Mutex::new(answers.iter().rev().map(|s| s.to_string()).collect()),
                scripts: Mutex::new(Vec::new()),
            }
        }
        fn scripts(&self) -> Vec<String> {
            self.scripts.lock().unwrap().clone()
        }
    }

    impl Shell for Canned {
        async fn run_script(&self, script: &str, _secs: u64) -> Result<String, String> {
            self.scripts.lock().unwrap().push(script.to_owned());
            Ok(self.answers.lock().unwrap().pop().unwrap_or_default())
        }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        loop {
            if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    fn known_answer(priv_: &str) -> String {
        format!(
            "@@priv\n{priv_}\n@@files\ndevagent-local-ci.timer disabled enabled\nlogrotate.timer enabled enabled\n@@json\n{LIST_TIMERS}\n@@show\nId=devagent-local-ci.timer\nUnit=devagent-local-ci.service\nLoadState=loaded\nFragmentPath=/etc/systemd/system/devagent-local-ci.timer\n"
        )
    }

    #[test]
    fn the_whole_list_combines_unit_files_list_timers_and_show() {
        let discover = format!(
            "@@priv\n\n@@me\nwecommander\n@@systemd\nyes\n@@files\ndevagent-local-ci.timer disabled enabled\nlogrotate.timer enabled enabled\nnightly.timer enabled enabled\n@@json\n{LIST_TIMERS}\n@@mf /etc/systemd/system/nightly.timer\n{}\n@@mf /etc/systemd/system/nightly.service\n{}\n@@crontab\nfopen: Permission denied\n@@crontabrc\n1\n",
            timer_file(&TimerSpec { name: "nightly".into(), ..spec() }),
            service_file(&TimerSpec { name: "nightly".into(), ..spec() }),
        );
        let show = format!(
            "@@showsystem\n{DEVAGENT_SHOW}\n\nId=logrotate.timer\nUnit=logrotate.service\nUnitFileState=enabled\nActiveState=active\n\nId=nightly.timer\nUnit=nightly.service\nUnitFileState=enabled\nActiveState=active\nFragmentPath=/etc/systemd/system/nightly.timer\nTimersCalendar={{ OnCalendar=*-*-* 03:00:00 ; next_elapse=n/a }}\n"
        );
        let svc = format!(
            "@@svcsystem\n{DEVAGENT_SERVICE}\n\nId=logrotate.service\nUser=\nResult=success\n"
        );
        let sh = Canned::new(&[&discover, &show, &svc]);
        let t = block_on(timers(&sh)).unwrap();
        assert!(t.systemd);
        assert_eq!(t.crontab, "not-readable");
        assert_eq!(t.privilege, "");
        let units: Vec<&str> = t.timers.iter().map(|t| t.unit.as_str()).collect();
        assert_eq!(
            units,
            [
                "devagent-local-ci.timer",
                "logrotate.timer",
                "nightly.timer"
            ]
        );
        let d = &t.timers[0];
        assert_eq!(
            (d.unit_file_state.as_str(), d.active_state.as_str()),
            ("disabled", "inactive")
        );
        assert_eq!(d.user, "devagent-ci");
        assert_eq!(d.command, "/usr/local/libexec/devagent-ci-poll");
        let l = &t.timers[1];
        assert_eq!(l.next_run, Some(1794960000));
        assert_eq!(l.user, "root");
        assert!(l.managed.is_none());
        let n = &t.timers[2];
        assert_eq!(n.managed.as_ref().unwrap().calendar, "*-*-* 03:00:00");
        assert_eq!(n.managed.as_ref().unwrap().command, spec().command);
        let scripts = sh.scripts();
        assert!(scripts[1].contains("TZ=UTC systemctl show 'apport-autoreport.timer' 'devagent-local-ci.timer' 'logrotate.timer' 'maxiom-api-alias-sync.timer' 'nightly.timer' 'sysstat-collect.timer' -p Id,Description,UnitFileState"), "{}", scripts[1]);
        assert!(scripts[2].contains("systemctl show 'devagent-local-ci.service' 'logrotate.service' 'nightly.service' -p Id,Description,ExecStart"));
    }

    #[test]
    fn unreadable_lists_what_the_reader_could_not_see() {
        let discover = "@@priv\n\n@@me\nwecommander\n@@systemd\n\n@@crontab\nfopen: Permission denied\n@@crontabrc\n1\n@@crondx /etc/cron.d/secret\n@@crond /etc/cron.d/ok\n5 * * * * root /bin/true\n";
        let sh = Canned::new(&[discover]);
        let t = block_on(timers(&sh)).unwrap();
        let u = unreadable(&t);
        let sources: Vec<&str> = u.iter().map(|u| u.source.as_str()).collect();
        assert_eq!(
            sources,
            ["systemd", "crontab -l", "/etc/cron.d/secret", "other users"]
        );
        assert_eq!(u[1].reason, "fopen: Permission denied");
        assert_eq!(u[2].reason, "not readable by wecommander");
        let readable: Vec<&CronEntry> = t.cron.iter().filter(|e| !cron_unreadable(e)).collect();
        assert_eq!(readable.len(), 1);
        assert_eq!(readable[0].command, "/bin/true");

        let root = Timers {
            systemd: true,
            login_user: "root".into(),
            crontab: "ok".into(),
            ..Default::default()
        };
        let sources: Vec<String> = unreadable(&root).into_iter().map(|u| u.source).collect();
        assert_eq!(sources, ["systemctl --user", "other users"]);
    }

    #[test]
    fn actions_need_root_and_a_listed_timer() {
        let sh = Canned::new(&[&known_answer("")]);
        let e = block_on(timer_action(
            &sh,
            "devagent-local-ci.timer".into(),
            "enable".into(),
        ));
        assert_eq!(e.unwrap_err(), NEEDS_ROOT);
        let sh = Canned::new(&[&known_answer("sudo")]);
        let e = block_on(timer_action(&sh, "other.timer".into(), "enable".into()));
        assert!(e.is_err());
        let sh = Canned::new(&[]);
        assert!(block_on(timer_action(&sh, "x.timer; reboot".into(), "enable".into())).is_err());
        assert!(block_on(timer_action(&sh, "x.timer".into(), "rm".into())).is_err());
        assert!(sh.scripts().is_empty(), "nothing ran");

        let sh = Canned::new(&[&known_answer("sudo"), "@@out\n\n@@code\n0\n"]);
        let r = block_on(timer_action(
            &sh,
            "devagent-local-ci.timer".into(),
            "start-now".into(),
        ))
        .unwrap();
        assert!(r.ok);
        assert_eq!(
            r.command,
            "systemctl start --no-block devagent-local-ci.service"
        );
        assert!(sh.scripts()[1]
            .contains("r timeout 120 systemctl start --no-block devagent-local-ci.service"));
    }

    #[test]
    fn logs_read_the_service_journal() {
        let sh = Canned::new(&[&known_answer(""), "@@log\nHint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n-- No entries --\n"]);
        let l = block_on(timer_logs(&sh, "devagent-local-ci.timer".into(), 50)).unwrap();
        assert_eq!(
            l.command,
            "journalctl -u devagent-local-ci.service -n 50 --no-pager -o short-iso"
        );
        assert!(l.lines.is_empty());
        assert_eq!(l.note, JOURNAL_DENIED);
        let sh = Canned::new(&[
            &known_answer("root"),
            "@@log\n2026-11-17T10:00:00+0000 host systemd[1]: Started x.\n",
        ]);
        let l = block_on(timer_logs(&sh, "devagent-local-ci.timer".into(), 99999)).unwrap();
        assert!(l.command.contains("-n 2000"));
        assert_eq!(l.lines.len(), 1);
        assert_eq!(l.note, "");
    }

    #[test]
    fn create_checks_first_then_writes_marked_files() {
        let sh = Canned::new(&[
            "@@exists\n@@cal\n  Original form: *-*-* 03:00:00\n@@calrc\n0\n@@user\nyes\n",
            "@@out\nCreated symlink.\n@@code\n0\n",
        ]);
        let r = block_on(timer_create(&sh, spec())).unwrap();
        assert!(r.ok);
        assert_eq!(r.command, write_command(&spec(), false));
        let scripts = sh.scripts();
        assert!(scripts[0].contains("systemd-analyze calendar '*-*-* 03:00:00'"));
        assert!(scripts[0].contains("id -u 'backup'"));
        assert!(
            scripts[1].contains("| r tee /etc/systemd/system/nightly-backup.service >/dev/null")
        );
        assert!(scripts[1].contains("r systemctl enable --now nightly-backup.timer"));

        let sh =
            Canned::new(&["@@exists\nnightly-backup.service\n@@cal\n@@calrc\n0\n@@user\nyes\n"]);
        assert!(block_on(timer_create(&sh, spec()))
            .unwrap_err()
            .contains("zaten var"));
        let sh = Canned::new(&["@@exists\n@@cal\nFailed to parse calendar specification 'x': Invalid argument\n@@calrc\n1\n@@user\nyes\n"]);
        assert!(block_on(timer_create(&sh, spec()))
            .unwrap_err()
            .contains("Failed to parse"));
        let sh = Canned::new(&["@@exists\n@@cal\n@@calrc\n0\n@@user\n"]);
        assert!(block_on(timer_create(&sh, spec())).is_err());
        let sh = Canned::new(&["@@noroot\n"]);
        assert_eq!(block_on(timer_create(&sh, spec())).unwrap_err(), NEEDS_ROOT);
        let sh = Canned::new(&[]);
        assert!(block_on(timer_create(
            &sh,
            TimerSpec {
                name: "Bad Name".into(),
                ..spec()
            }
        ))
        .is_err());
        assert!(sh.scripts().is_empty());
    }

    #[test]
    fn edit_and_delete_only_touch_wecommander_timers() {
        let ours = "@@managed\nyes\n@@fragment\n/etc/systemd/system/nightly-backup.timer\n@@cal\n@@calrc\n0\n@@user\nyes\n";
        let sh = Canned::new(&[ours, "@@out\n@@code\n0\n"]);
        let r = block_on(timer_edit(&sh, spec())).unwrap();
        assert!(r
            .command
            .ends_with("systemctl try-restart nightly-backup.timer"));
        let sh = Canned::new(&["@@managed\n@@fragment\n/etc/systemd/system/nightly-backup.timer\n@@cal\n@@calrc\n0\n@@user\nyes\n"]);
        assert!(block_on(timer_edit(&sh, spec()))
            .unwrap_err()
            .contains("WECOMMANDER oluşturmadı"));
        // Our file, overridden by one elsewhere: not ours to edit.
        let sh = Canned::new(&[
            "@@managed\nyes\n@@fragment\n/run/systemd/system/nightly-backup.timer\n",
        ]);
        assert!(block_on(timer_delete(&sh, "nightly-backup.timer".into())).is_err());
        let sh = Canned::new(&[
            "@@managed\nyes\n@@fragment\n/etc/systemd/system/nightly-backup.timer\n",
            "@@out\n@@code\n0\n",
        ]);
        let r = block_on(timer_delete(&sh, "nightly-backup.timer".into())).unwrap();
        assert_eq!(r.command, delete_command("nightly-backup"));
        assert!(sh.scripts()[1].contains("r rm -f /etc/systemd/system/nightly-backup.timer /etc/systemd/system/nightly-backup.service"));
        let sh = Canned::new(&[]);
        assert!(block_on(timer_delete(&sh, "devagent-local-ci.timer; rm".into())).is_err());
    }

    /// The discovery script runs on a real shell (Linux CI) and parses.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_discovery_script_runs_on_a_real_shell() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("{}{}", crate::PRELUDE, discover_script()))
            .output()
            .unwrap();
        let s = sections(&String::from_utf8_lossy(&out.stdout));
        assert!(!first(&s, "me").is_empty());
        let (_, status, _) = parse_cron(&s, first(&s, "me"));
        assert!(
            ["ok", "empty", "not-readable", "missing"].contains(&status.as_str()),
            "{status}"
        );
    }
}
