//! Server management: an overview (CPU, memory, disks, uptime), what fills
//! the disk, safe cleanup, and processes with their zombies. The same fixed
//! scripts run over an SSH connection (the apps, wc-app-core) or on the
//! machine itself (the agent, for MCP): a [`Shell`] runs them.
//!
//! Nothing is installed on the server. Every command is fixed here: the app
//! only picks a cleanup category or a process, never sends command text.
//! Changes need root (or sudo without a password) and refuse to touch the
//! processes that keep the server reachable.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;

use serde::Serialize;

mod docker;
pub use docker::{
    environments as docker_environments, stores as docker_stores, DockerEnv, DockerStore,
};

pub const NEEDS_ROOT: &str = "Bu işlem için sunucuda root ya da parolasız sudo gerekir.";

/// Runs privileged commands as root: directly for root, else `sudo -n`.
/// `R` is set when that works (a read still runs as the user without it).
pub const PRELUDE: &str = r#"export LC_ALL=C
R=; if [ "$(id -u)" = 0 ]; then R=root; elif sudo -n true 2>/dev/null; then R=sudo; fi
r() { if [ "$R" = sudo ]; then sudo -n "$@"; else "$@"; fi; }
"#;

/// Runs a script with `sh` and returns its standard output: over SSH in
/// the apps, on this machine in the agent. The [`PRELUDE`] is already in
/// `script`.
pub trait Shell: Sync {
    fn run_script(
        &self,
        script: &str,
        secs: u64,
    ) -> impl Future<Output = Result<String, String>> + Send;
}

pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'\''"#))
}

pub(crate) async fn run<S: Shell>(sh: &S, script: &str, secs: u64) -> Result<String, String> {
    sh.run_script(&format!("{PRELUDE}{script}"), secs).await
}

/// Splits `@@name` sections of a script's output.
pub fn sections(text: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let mut current = String::new();
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            current = name.trim().to_owned();
            out.entry(current.clone()).or_default();
        } else if !current.is_empty() {
            out.entry(current.clone())
                .or_default()
                .push(line.to_owned());
        }
    }
    out
}

pub fn first<'a>(s: &'a HashMap<String, Vec<String>>, name: &str) -> &'a str {
    s.get(name)
        .and_then(|l| l.iter().find(|l| !l.trim().is_empty()))
        .map(|l| l.trim())
        .unwrap_or("")
}

// ---- overview -------------------------------------------------------------

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub device: String,
    pub fs_type: String,
    pub mount: String,
    pub size_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub uptime_secs: u64,
    pub load: [f64; 3],
    pub cpus: u32,
    /// Percent busy over half a second.
    pub cpu_percent: f64,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub disks: Vec<Disk>,
    pub reboot_required: bool,
    /// The login message's "N updates can be applied" line, when there is one.
    pub updates: String,
    pub processes: u32,
    pub zombies: u32,
    /// "root", "sudo" or "" (changes are not possible).
    pub privilege: String,
    pub docker: bool,
}

const OVERVIEW: &str = r#"echo @@host; hostname
echo @@os; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" )
echo @@kernel; uname -srm
echo @@uptime; cat /proc/uptime
echo @@load; cat /proc/loadavg
echo @@cpus; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo @@stat1; head -1 /proc/stat; sleep 0.5; echo @@stat2; head -1 /proc/stat
echo @@mem; cat /proc/meminfo
echo @@df; df -PkT -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null
echo @@reboot; [ -f /var/run/reboot-required ] && echo yes
echo @@updates; cat /var/lib/update-notifier/updates-available 2>/dev/null
echo @@procs; ps -eo stat= | awk '{n++} /^Z/{z++} END{print n+0, z+0}'
echo @@priv; echo "$R"
echo @@docker; command -v docker >/dev/null 2>&1 && echo yes
"#;

pub async fn overview<S: Shell>(sh: &S) -> Result<Overview, String> {
    Ok(parse_overview(&run(sh, OVERVIEW, 30).await?))
}

fn cpu_times(line: &str) -> Option<(u64, u64)> {
    let v: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|x| x.parse().ok())
        .collect();
    if v.len() < 4 {
        return None;
    }
    let idle = v[3] + v.get(4).copied().unwrap_or(0);
    Some((v.iter().sum(), idle))
}

fn parse_df(lines: &[String]) -> Vec<Disk> {
    let mut disks: Vec<Disk> = lines
        .iter()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 7 {
                return None;
            }
            Some(Disk {
                device: f[0].to_owned(),
                fs_type: f[1].to_owned(),
                size_kb: f[2].parse().ok()?,
                used_kb: f[3].parse().ok()?,
                avail_kb: f[4].parse().ok()?,
                mount: f[6..].join(" "),
            })
        })
        .filter(|d| d.size_kb > 0)
        .collect();
    // One line per device (bind mounts repeat it); the shortest mount wins.
    disks.sort_by_key(|d| d.mount.len());
    let mut seen = std::collections::HashSet::new();
    disks.retain(|d| seen.insert(d.device.clone()));
    disks.sort_by(|a, b| a.mount.cmp(&b.mount));
    disks
}

fn parse_overview(text: &str) -> Overview {
    let s = sections(text);
    let mut o = Overview {
        hostname: first(&s, "host").to_owned(),
        os: first(&s, "os").to_owned(),
        kernel: first(&s, "kernel").to_owned(),
        privilege: first(&s, "priv").to_owned(),
        docker: first(&s, "docker") == "yes",
        reboot_required: first(&s, "reboot") == "yes",
        ..Default::default()
    };
    o.uptime_secs = first(&s, "uptime")
        .split_whitespace()
        .next()
        .and_then(|x| x.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;
    for (i, v) in first(&s, "load").split_whitespace().take(3).enumerate() {
        o.load[i] = v.parse().unwrap_or(0.0);
    }
    o.cpus = first(&s, "cpus").parse().unwrap_or(1);
    if let (Some((t1, i1)), Some((t2, i2))) =
        (cpu_times(first(&s, "stat1")), cpu_times(first(&s, "stat2")))
    {
        let total = t2.saturating_sub(t1);
        if total > 0 {
            let busy = total.saturating_sub(i2.saturating_sub(i1));
            o.cpu_percent = (busy as f64 * 1000.0 / total as f64).round() / 10.0;
        }
    }
    for line in s.get("mem").into_iter().flatten() {
        let mut f = line.split_whitespace();
        let (Some(k), Some(v)) = (f.next(), f.next()) else {
            continue;
        };
        let v: u64 = v.parse().unwrap_or(0);
        match k {
            "MemTotal:" => o.mem_total_kb = v,
            "MemAvailable:" => o.mem_available_kb = v,
            "SwapTotal:" => o.swap_total_kb = v,
            "SwapFree:" => o.swap_free_kb = v,
            _ => {}
        }
    }
    o.disks = parse_df(s.get("df").map(|v| v.as_slice()).unwrap_or(&[]));
    o.updates = s
        .get("updates")
        .into_iter()
        .flatten()
        .map(|l| l.trim())
        .find(|l| l.contains("can be applied"))
        .unwrap_or("")
        .to_owned();
    let mut p = first(&s, "procs").split_whitespace();
    o.processes = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    o.zombies = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    o
}

// ---- disk usage -----------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub path: String,
    pub kb: u64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerUsage {
    pub kind: String,
    pub count: String,
    pub size_bytes: u64,
    pub reclaimable_bytes: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub path: String,
    pub total_kb: u64,
    /// Largest first; at most 40.
    pub entries: Vec<UsageEntry>,
    pub docker: Vec<DockerUsage>,
    /// False when some folders could not be read (no root).
    pub complete: bool,
    /// Every Docker daemon's storage folder: a folder here that is one (or
    /// holds one) is that daemon's data, cleaned from the Cleanup page.
    pub docker_stores: Vec<DockerStore>,
}

/// "12.3GB", "512kB", "0B" (Docker's sizes) in bytes.
pub(crate) fn docker_bytes(text: &str) -> u64 {
    let t = text.split_whitespace().next().unwrap_or("");
    let split = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(t.len());
    let (n, unit) = t.split_at(split);
    let n: f64 = n.parse().unwrap_or(0.0);
    let m = match unit.to_ascii_uppercase().as_str() {
        "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        _ => 1.0,
    };
    (n * m) as u64
}

fn parse_docker_df(lines: &[String]) -> Vec<DockerUsage> {
    lines
        .iter()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() < 4 {
                return None;
            }
            Some(DockerUsage {
                kind: f[0].trim().to_owned(),
                count: f[1].trim().to_owned(),
                size_bytes: docker_bytes(f[2]),
                reclaimable_bytes: docker_bytes(f[3]),
            })
        })
        .collect()
}

/// Folders measured per command: about 30 commands for any folder.
fn batches(dirs: &[String]) -> Vec<&[String]> {
    let size = dirs.len().div_ceil(30).max(1);
    dirs.chunks(size).collect()
}

/// The largest folders in `path` (never crossing into another disk).
/// `progress(done, total)` reports how far it got: in KB of the disk's
/// used space when `path` is the disk's root, else in folders.
pub async fn disk_usage<S: Shell>(
    sh: &S,
    path: Option<String>,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<DiskUsage, String> {
    let path = path
        .map(|p| p.trim().to_owned())
        .filter(|p| p.starts_with('/') && !p.contains('\n'))
        .unwrap_or_else(|| "/".to_owned());
    let p = quote(&path);
    let script = format!(
        r#"echo @@dev; stat -c %d -- {p} 2>/dev/null
echo @@kids; r find {p} -mindepth 1 -maxdepth 1 -type d -printf '%D\t%p\n' 2>/dev/null
echo @@files; r find {p} -mindepth 1 -maxdepth 1 ! -type d -printf '%k\n' 2>/dev/null | awk '{{s+=$1}} END{{print s+0}}'
echo @@df; df -Pk -- {p} 2>/dev/null | tail -1
echo @@docker; [ "$R" ] && [ {p} = / ] && command -v docker >/dev/null 2>&1 && r docker system df --format '{{{{.Type}}}}\t{{{{.TotalCount}}}}\t{{{{.Size}}}}\t{{{{.Reclaimable}}}}' 2>/dev/null
"#
    );
    let s = sections(&run(sh, &script, 60).await?);
    let device = first(&s, "dev").to_owned();
    let dirs: Vec<String> = s
        .get("kids")
        .into_iter()
        .flatten()
        .filter_map(|l| l.split_once('\t'))
        .filter(|(d, _)| device.is_empty() || *d == device)
        .map(|(_, p)| p.to_owned())
        .collect();
    let files_kb: u64 = first(&s, "files").parse().unwrap_or(0);
    // "used" of the disk when this folder is its root: progress in KB.
    let df: Vec<&str> = first(&s, "df").split_whitespace().collect();
    let disk_total = (df.len() >= 6 && df[5] == path)
        .then(|| df[2].parse::<u64>().ok())
        .flatten()
        .filter(|kb| *kb > 0);
    let (total, by_kb) = match disk_total {
        Some(kb) => (kb, true),
        None => (dirs.len().max(1) as u64, false),
    };
    let report = |done: u64| progress(done.min(total), total);
    report(0);
    let mut entries = Vec::new();
    let mut complete = true;
    let mut done_kb = files_kb;
    let mut done_dirs = 0u64;
    for batch in batches(&dirs) {
        let list: Vec<String> = batch.iter().map(|d| quote(d)).collect();
        let script = format!(
            "echo @@du; r timeout 300 du -xsk -- {} 2>&1\n",
            list.join(" ")
        );
        let out = sections(&run(sh, &script, 330).await?);
        let mut measured = 0;
        for line in out.get("du").into_iter().flatten() {
            if line.starts_with("du:") || line.starts_with("timeout:") {
                complete = false;
                continue;
            }
            if let Some((kb, p)) = line.split_once('\t') {
                if let Ok(kb) = kb.trim().parse::<u64>() {
                    measured += 1;
                    done_kb += kb;
                    entries.push(UsageEntry {
                        path: p.to_owned(),
                        kb,
                    });
                }
            }
        }
        if measured < batch.len() {
            complete = false;
        }
        done_dirs += batch.len() as u64;
        report(if by_kb { done_kb } else { done_dirs });
    }
    report(total);
    entries.sort_by_key(|e| std::cmp::Reverse(e.kb));
    let total_kb = files_kb + entries.iter().map(|e| e.kb).sum::<u64>();
    entries.truncate(40);
    Ok(DiskUsage {
        path,
        total_kb,
        entries,
        docker: parse_docker_df(s.get("docker").map(|v| v.as_slice()).unwrap_or(&[])),
        // Best effort: the folder sizes stand without it.
        docker_stores: docker::stores(sh).await.unwrap_or_default(),
        complete: complete && s.contains_key("kids"),
    })
}

// ---- live sample ----------------------------------------------------------

/// Raw counters; the app turns two samples into rates.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// Seconds since boot, for the time between two samples.
    pub uptime: f64,
    pub cpu_total: u64,
    pub cpu_idle: u64,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub load1: f64,
    /// Bytes through the network cards (not loopback, Docker bridges or veths).
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
    /// Bytes read and written by the disks (whole disks only).
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
    /// The root disk (`/`).
    pub root_used_kb: u64,
    pub root_avail_kb: u64,
    pub zombies: u32,
}

const SAMPLE: &str = "echo @@up; cat /proc/uptime
echo @@stat; head -1 /proc/stat
echo @@load; cat /proc/loadavg
echo @@mem; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
echo @@net; tail -n +3 /proc/net/dev
echo @@io; cat /proc/diskstats
echo @@df; df -Pk / 2>/dev/null | tail -1
echo @@z; ps -eo stat= | grep -c '^Z'
";

fn real_nic(name: &str) -> bool {
    !(name == "lo"
        || name.starts_with("veth")
        || name.starts_with("docker")
        || name.starts_with("br-")
        || name.starts_with("virbr")
        || name.starts_with("cni")
        || name.starts_with("flannel"))
}

fn whole_disk(name: &str) -> bool {
    let tail_digit = name.chars().last().is_some_and(|c| c.is_ascii_digit());
    ((name.starts_with("sd")
        || name.starts_with("vd")
        || name.starts_with("xvd")
        || name.starts_with("hd"))
        && !tail_digit)
        || (name.starts_with("nvme") && !name.contains('p'))
        || (name.starts_with("mmcblk") && !name.contains('p'))
}

fn parse_sample(text: &str) -> Sample {
    let s = sections(text);
    let mut out = Sample {
        uptime: first(&s, "up")
            .split_whitespace()
            .next()
            .and_then(|x| x.parse().ok())
            .unwrap_or(0.0),
        load1: first(&s, "load")
            .split_whitespace()
            .next()
            .and_then(|x| x.parse().ok())
            .unwrap_or(0.0),
        ..Default::default()
    };
    if let Some((t, i)) = cpu_times(first(&s, "stat")) {
        out.cpu_total = t;
        out.cpu_idle = i;
    }
    for line in s.get("mem").into_iter().flatten() {
        let mut f = line.split_whitespace();
        let (Some(k), Some(v)) = (f.next(), f.next()) else {
            continue;
        };
        let v: u64 = v.parse().unwrap_or(0);
        match k {
            "MemTotal:" => out.mem_total_kb = v,
            "MemAvailable:" => out.mem_available_kb = v,
            "SwapTotal:" => out.swap_total_kb = v,
            "SwapFree:" => out.swap_free_kb = v,
            _ => {}
        }
    }
    for line in s.get("net").into_iter().flatten() {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        if !real_nic(name.trim()) {
            continue;
        }
        let f: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|x| x.parse().ok())
            .collect();
        if f.len() >= 9 {
            out.net_rx_bytes += f[0];
            out.net_tx_bytes += f[8];
        }
    }
    let df: Vec<&str> = first(&s, "df").split_whitespace().collect();
    if df.len() >= 4 {
        out.root_used_kb = df[2].parse().unwrap_or(0);
        out.root_avail_kb = df[3].parse().unwrap_or(0);
    }
    out.zombies = first(&s, "z").parse().unwrap_or(0);
    for line in s.get("io").into_iter().flatten() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() >= 10 && whole_disk(f[2]) {
            out.disk_read_bytes += f[5].parse::<u64>().unwrap_or(0) * 512;
            out.disk_write_bytes += f[9].parse::<u64>().unwrap_or(0) * 512;
        }
    }
    out
}

pub async fn sample<S: Shell>(sh: &S) -> Result<Sample, String> {
    Ok(parse_sample(&run(sh, SAMPLE, 15).await?))
}

// ---- cleanup --------------------------------------------------------------

struct Category {
    id: &'static str,
    title: &'static str,
    detail: &'static str,
    /// Prints the size in KB that the cleanup frees (a number, alone).
    measure: &'static str,
    /// The cleanup itself, run as root.
    clean: &'static str,
    /// Shown before running: what the user should know.
    warning: &'static str,
}

const OLD_LOGS: &str = r"find /var/log -xdev -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.[0-9].log' -o -name '*.old' \)";
const OLD_TMP: &str = "find /tmp /var/tmp -xdev -type f -atime +10";

const CATEGORIES: &[Category] = &[
    Category {
        id: "apt-cache",
        title: "Paket önbelleği (apt)",
        detail: "İndirilip kurulmuş paket dosyaları. Gerekirse yeniden indirilir.",
        measure: "r du -sk /var/cache/apt/archives 2>/dev/null | cut -f1",
        clean: "apt-get clean",
        warning: "",
    },
    Category {
        id: "journal",
        title: "Sistem günlükleri (7 günden eski)",
        detail: "journald'nin eski kayıtları. Son 7 gün tutulur.",
        measure: "r find /var/log/journal -xdev -name '*.journal' -mtime +7 -printf '%k\\n' 2>/dev/null | awk '{s+=$1} END{print s+0}'",
        clean: "journalctl --vacuum-time=7d",
        warning: "",
    },
    Category {
        id: "old-logs",
        title: "Eski log dosyaları",
        detail: "Döndürülmüş ve sıkıştırılmış loglar (/var/log içinde .gz, .1, .old). Güncel loglara dokunulmaz.",
        measure: "",
        clean: "",
        warning: "",
    },
    Category {
        id: "tmp",
        title: "Eski geçici dosyalar",
        detail: "/tmp ve /var/tmp içinde 10 günden uzun süredir açılmamış dosyalar.",
        measure: "",
        clean: "",
        warning: "",
    },
    Category {
        id: "crash",
        title: "Çökme raporları",
        detail: "/var/crash içindeki çökme dökümleri.",
        measure: "r du -sk /var/crash 2>/dev/null | cut -f1",
        clean: "find /var/crash -xdev -type f -name '*.crash' -delete",
        warning: "",
    },
];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub kb: u64,
    /// The exact command that runs (as root).
    pub command: String,
    pub warning: String,
    /// The Docker daemon this cleanup is for (`system`, `u1000`); empty for
    /// the rest.
    pub docker: String,
    /// Items of one group overlap (untagged images are part of the unused
    /// ones): choose one of them, never add them up.
    pub group: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScan {
    pub items: Vec<Cleanup>,
    pub privilege: String,
    /// The root disk, for "after cleanup" on the screen.
    pub disk: Option<Disk>,
    /// Every Docker daemon: the system one and each user's rootless one,
    /// with what it stores, protects and frees, or why it could not be read.
    pub dockers: Vec<DockerEnv>,
}

fn measure_script(c: &Category) -> String {
    match c.id {
        "old-logs" => {
            format!("r {OLD_LOGS} -printf '%k\\n' 2>/dev/null | awk '{{s+=$1}} END{{print s+0}}'")
        }
        "tmp" => {
            format!("r {OLD_TMP} -printf '%k\\n' 2>/dev/null | awk '{{s+=$1}} END{{print s+0}}'")
        }
        _ => c.measure.to_owned(),
    }
}

fn clean_command(c: &Category) -> String {
    match c.id {
        "old-logs" => format!("{OLD_LOGS} -delete"),
        "tmp" => format!("{OLD_TMP} -delete"),
        _ => c.clean.to_owned(),
    }
}

pub async fn cleanup_scan<S: Shell>(sh: &S) -> Result<CleanupScan, String> {
    cleanup_scan_in(sh, docker::RUN_USER).await
}

pub(crate) async fn cleanup_scan_in<S: Shell>(
    sh: &S,
    run_user: &str,
) -> Result<CleanupScan, String> {
    let mut script = String::from("echo @@priv; echo \"$R\"\necho @@df; df -PkT / 2>/dev/null\n");
    for c in CATEGORIES {
        let m = measure_script(c);
        if !m.is_empty() {
            script.push_str(&format!("echo @@{}; {m}\n", c.id));
        }
    }
    let s = sections(&run(sh, &script, 120).await?);
    let mut items = Vec::new();
    for c in CATEGORIES {
        items.push(Cleanup {
            id: c.id.to_owned(),
            title: c.title.to_owned(),
            detail: c.detail.to_owned(),
            kb: first(&s, c.id).parse().unwrap_or(0),
            command: clean_command(c),
            warning: c.warning.to_owned(),
            docker: String::new(),
            group: String::new(),
        });
    }
    // Each Docker daemon on its own: its build cache and images, as that
    // daemon counts them. A daemon that could not be read offers nothing
    // (its sizes are unknown, not zero); the reason is in `dockers`.
    let dockers = docker::environments_in(sh, run_user).await?;
    for env in dockers.iter().filter(|e| e.error.is_empty()) {
        items.extend(docker_items(env));
    }
    Ok(CleanupScan {
        items,
        privilege: first(&s, "priv").to_owned(),
        disk: parse_df(s.get("df").map(|v| v.as_slice()).unwrap_or(&[]))
            .into_iter()
            .next(),
        dockers,
    })
}

/// The cleanups one Docker daemon offers. The system daemon keeps the ids
/// it always had (`docker-build`); a rootless one adds `@u<uid>`.
fn docker_items(env: &DockerEnv) -> Vec<Cleanup> {
    docker::DOCKER_KINDS
        .iter()
        .map(|k| {
            let id = if env.id == "system" {
                k.kind.to_owned()
            } else {
                format!("{}@{}", k.kind, env.id)
            };
            let bytes = match k.kind {
                "docker-build" => env.build_cache_reclaimable_bytes,
                "docker-dangling" => env.dangling_bytes,
                _ => env.images_reclaimable_bytes,
            };
            let title = if env.id == "system" {
                k.title.to_owned()
            } else {
                format!(
                    "{} — {}",
                    env.label,
                    k.title
                        .trim_start_matches("Docker: ")
                        .trim_start_matches("Docker ")
                )
            };
            Cleanup {
                id,
                title,
                detail: k.detail.to_owned(),
                kb: bytes / 1024,
                command: docker::docker_clean_command(k, &env.socket),
                warning: k.warning.to_owned(),
                docker: env.id.clone(),
                group: if k.kind == "docker-build" {
                    String::new()
                } else {
                    format!("images@{}", env.id)
                },
            }
        })
        .collect()
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub id: String,
    pub ok: bool,
    pub message: String,
}

pub async fn cleanup_run<S: Shell>(sh: &S, ids: Vec<String>) -> Result<Vec<CleanupResult>, String> {
    cleanup_run_in(sh, ids, docker::RUN_USER).await
}

pub(crate) async fn cleanup_run_in<S: Shell>(
    sh: &S,
    ids: Vec<String>,
    run_user: &str,
) -> Result<Vec<CleanupResult>, String> {
    // Docker cleanups go to the daemon their id names; it is found again
    // here (the same discovery as the scan), so the preview and the run
    // always address the same daemon, and an id for a daemon that is not
    // there any more is refused.
    let mut dockers: Option<Vec<docker::Found>> = None;
    let mut results = Vec::new();
    for id in ids {
        let (kind, env) = docker::split_id(&id);
        if let Some(k) = docker::DOCKER_KINDS.iter().find(|k| k.kind == kind) {
            if dockers.is_none() {
                let text = run(sh, &docker::discover_script(run_user), 30).await?;
                dockers = Some(docker::parse_found(&text, run_user).2);
            }
            let env_id = env.unwrap_or("system");
            let Some(found) = dockers.as_ref().unwrap().iter().find(|f| f.id == env_id) else {
                return Err(format!(
                    "Bu Docker ortamı artık bulunamadı: {env_id}. Taramayı yenileyin."
                ));
            };
            let command = docker::docker_clean_command(k, &found.socket);
            // The cleanup itself may take long (tens of GB of build cache).
            let script = format!(
                "if [ \"$R\" ]; then out=$(r timeout 840 {command} 2>&1); else out=$(timeout 840 {command} 2>&1); fi; c=$?\necho @@out; printf '%s\\n' \"$out\" | tail -3; echo @@code; echo $c\n"
            );
            let s = sections(&run(sh, &script, 900).await?);
            results.push(CleanupResult {
                id,
                ok: first(&s, "code") == "0",
                message: s
                    .get("out")
                    .map(|l| l.join("\n"))
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
            });
            continue;
        }
        if env.is_some() {
            return Err(format!("unknown cleanup: {id}"));
        }
        let Some(c) = CATEGORIES.iter().find(|c| c.id == id) else {
            return Err(format!("unknown cleanup: {id}"));
        };
        let script = format!(
            "[ \"$R\" ] || {{ echo @@noroot; exit 0; }}\nout=$(r {} 2>&1); c=$?\necho @@out; printf '%s\\n' \"$out\" | tail -3; echo @@code; echo $c\n",
            clean_command(c)
        );
        let s = sections(&run(sh, &script, 900).await?);
        if s.contains_key("noroot") {
            return Err(NEEDS_ROOT.to_owned());
        }
        let out = s.get("out").map(|l| l.join("\n")).unwrap_or_default();
        results.push(CleanupResult {
            id,
            ok: first(&s, "code") == "0",
            message: out.trim().to_owned(),
        });
    }
    Ok(results)
}

// ---- processes ------------------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub state: String,
    pub cpu: f64,
    pub mem: f64,
    pub rss_kb: u64,
    pub elapsed_secs: u64,
    pub name: String,
    pub command: String,
}

/// What runs a process: a Docker container or a systemd service.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    /// "container", "service" or "" (unknown).
    pub kind: String,
    /// Container id or unit name: what a restart acts on.
    pub id: String,
    /// What the user reads (the container name, the unit).
    pub name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZombieGroup {
    pub parent: Process,
    pub count: u32,
    pub owner: Owner,
    /// Why the parent may not be stopped here, when it may not.
    pub protected: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcessList {
    pub processes: Vec<Process>,
    pub zombies: Vec<ZombieGroup>,
    pub privilege: String,
}

/// Processes that keep the server up or reachable: never stopped here.
const PROTECTED: &[&str] = &[
    "systemd",
    "init",
    "kthreadd",
    "sshd",
    "sshd-session",
    "dockerd",
    "containerd",
    "containerd-shim",
    "containerd-shim-runc-v2",
    "wecommander-agent",
    "wecommander-age",
    "systemd-journal",
    "systemd-logind",
    "systemd-udevd",
    "dbus-daemon",
];
/// Databases: stopping one can lose data in flight; asked twice.
const DATABASES: &[&str] = &[
    "postgres",
    "mysqld",
    "mariadbd",
    "mongod",
    "redis-server",
    "clickhouse-serv",
];

fn protection(p: &Process) -> &'static str {
    if p.pid <= 2 || p.ppid == 2 {
        "Sistem süreci; durdurulamaz."
    } else if PROTECTED.contains(&p.name.as_str()) {
        "Sunucunun çalışması ya da bağlantın için gerekli; durdurulamaz."
    } else {
        ""
    }
}

fn parse_processes(main: &[String], names: &[String]) -> Vec<Process> {
    let names: HashMap<u32, String> = names
        .iter()
        .filter_map(|l| {
            let l = l.trim_start();
            let (pid, name) = l.split_once(' ')?;
            Some((pid.parse().ok()?, name.trim().to_owned()))
        })
        .collect();
    main.iter()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let pid: u32 = f.next()?.parse().ok()?;
            let ppid: u32 = f.next()?.parse().ok()?;
            let user = f.next()?.to_owned();
            let state = f.next()?.to_owned();
            let cpu = f.next()?.parse().unwrap_or(0.0);
            let mem = f.next()?.parse().unwrap_or(0.0);
            let rss_kb = f.next()?.parse().unwrap_or(0);
            let elapsed_secs = f.next()?.parse().unwrap_or(0);
            let mut command: String = f.collect::<Vec<_>>().join(" ");
            if command.len() > 400 {
                let mut cut = 400;
                while !command.is_char_boundary(cut) {
                    cut -= 1;
                }
                command.truncate(cut);
            }
            Some(Process {
                pid,
                ppid,
                user,
                state,
                cpu,
                mem,
                rss_kb,
                elapsed_secs,
                // Gone between the two `ps` runs: the program's file name.
                name: names.get(&pid).cloned().unwrap_or_else(|| {
                    let program = command.split_whitespace().next().unwrap_or("");
                    program
                        .rsplit('/')
                        .next()
                        .unwrap_or(program)
                        .chars()
                        .take(15)
                        .collect()
                }),
                command,
            })
        })
        .collect()
}

/// The container or service from a `/proc/<pid>/cgroup` file.
fn parse_owner(cgroup: &[String]) -> Owner {
    for line in cgroup {
        let path = line.splitn(3, ':').nth(2).unwrap_or("");
        for part in path.split('/').rev() {
            let id = part
                .strip_prefix("docker-")
                .and_then(|p| p.strip_suffix(".scope"))
                .or_else(|| (path.contains("/docker/") && part.len() == 64).then_some(part));
            if let Some(id) =
                id.filter(|i| i.len() >= 12 && i.chars().all(|c| c.is_ascii_hexdigit()))
            {
                return Owner {
                    kind: "container".into(),
                    id: id.to_owned(),
                    name: id[..12].to_owned(),
                };
            }
        }
        if let Some(unit) = path.split('/').find(|p| p.ends_with(".service")) {
            return Owner {
                kind: "service".into(),
                id: unit.to_owned(),
                name: unit.to_owned(),
            };
        }
    }
    Owner::default()
}

const PS: &str = "echo @@priv; echo \"$R\"
echo @@ps; ps -eo pid=,ppid=,user:32=,stat=,pcpu=,pmem=,rss=,etimes=,args=
echo @@names; ps -eo pid=,comm=
";

pub async fn processes<S: Shell>(sh: &S) -> Result<ProcessList, String> {
    let s = sections(&run(sh, PS, 30).await?);
    let empty = Vec::new();
    let list = parse_processes(
        s.get("ps").unwrap_or(&empty),
        s.get("names").unwrap_or(&empty),
    );
    let by_pid: HashMap<u32, &Process> = list.iter().map(|p| (p.pid, p)).collect();
    let mut counts: BTreeMap<u32, u32> = BTreeMap::new();
    for p in list.iter().filter(|p| p.state.starts_with('Z')) {
        *counts.entry(p.ppid).or_default() += 1;
    }
    let mut zombies = Vec::new();
    if !counts.is_empty() {
        let mut script = String::new();
        for ppid in counts.keys() {
            script.push_str(&format!(
                "echo @@cg{ppid}; cat /proc/{ppid}/cgroup 2>/dev/null\n"
            ));
        }
        script.push_str("if [ \"$R\" ] && command -v docker >/dev/null 2>&1; then echo @@names; r docker ps -a --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null; fi\n");
        let cg = sections(&run(sh, &script, 30).await?);
        let names: HashMap<&str, &str> = cg
            .get("names")
            .into_iter()
            .flatten()
            .filter_map(|l| l.split_once(' '))
            .collect();
        for (ppid, count) in counts {
            let Some(parent) = by_pid.get(&ppid) else {
                continue;
            };
            let mut owner = parse_owner(cg.get(&format!("cg{ppid}")).unwrap_or(&empty));
            if let Some(name) = names.get(owner.id.as_str()) {
                owner.name = (*name).to_owned();
            }
            zombies.push(ZombieGroup {
                protected: protection(parent).to_owned(),
                parent: (*parent).clone(),
                count,
                owner,
            });
        }
        zombies.sort_by_key(|z| std::cmp::Reverse(z.count));
    }
    Ok(ProcessList {
        processes: list,
        zombies,
        privilege: first(&s, "priv").to_owned(),
    })
}

/// `action`: "reap" (asks the parent to collect its zombies, harmless),
/// "term" (asks the process to stop), "kill" (stops it at once).
/// `name` must still match: a PID reused by another program is refused.
pub async fn process_signal<S: Shell>(
    sh: &S,
    pid: u32,
    name: String,
    action: String,
    confirm_database: bool,
) -> Result<String, String> {
    let signal = match action.as_str() {
        "reap" => "CHLD",
        "term" => "TERM",
        "kill" => "KILL",
        _ => return Err("unknown action".into()),
    };
    let probe = format!(
        "echo @@priv; echo \"$R\"\necho @@name; cat /proc/{pid}/comm 2>/dev/null\necho @@ppid; awk '{{print $4}}' /proc/{pid}/stat 2>/dev/null\n"
    );
    let s = sections(&run(sh, &probe, 20).await?);
    let current = first(&s, "name");
    if current.is_empty() {
        return Err("Süreç artık çalışmıyor.".into());
    }
    if current != name.trim() {
        return Err("Bu numaradaki süreç değişmiş; listeyi yenile.".into());
    }
    let p = Process {
        pid,
        ppid: first(&s, "ppid").parse().unwrap_or(0),
        user: String::new(),
        state: String::new(),
        cpu: 0.0,
        mem: 0.0,
        rss_kb: 0,
        elapsed_secs: 0,
        name: current.to_owned(),
        command: String::new(),
    };
    if signal != "CHLD" {
        let why = protection(&p);
        if !why.is_empty() {
            return Err(why.into());
        }
        if DATABASES.contains(&current) && !confirm_database {
            return Err("database".into());
        }
    }
    if first(&s, "priv").is_empty() {
        let run_as_user = run(sh, &format!("kill -{signal} {pid} 2>&1 && echo @@ok"), 20).await?;
        return if run_as_user.contains("@@ok") {
            Ok(String::new())
        } else {
            Err(NEEDS_ROOT.into())
        };
    }
    let out = run(
        sh,
        &format!("echo @@out; r kill -{signal} {pid} 2>&1; echo @@code; echo $?"),
        20,
    )
    .await?;
    let s = sections(&out);
    if first(&s, "code") == "0" {
        Ok(String::new())
    } else {
        Err(s.get("out").map(|l| l.join(" ")).unwrap_or_default())
    }
}

pub fn valid_owner(kind: &str, id: &str) -> Result<(), String> {
    let ok = match kind {
        "container" => id.len() >= 12 && id.chars().all(|c| c.is_ascii_hexdigit()),
        "service" => {
            id.ends_with(".service")
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "@._-".contains(c))
                && ![
                    "ssh.service",
                    "sshd.service",
                    "docker.service",
                    "containerd.service",
                    "dbus.service",
                    "systemd-journald.service",
                    "systemd-logind.service",
                ]
                .contains(&id)
                && !id.starts_with("wecommander")
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err("Bu servis buradan yeniden başlatılamaz.".into())
    }
}

/// Restarts the container or service a process runs in (its zombies go
/// with the old process).
pub async fn restart_owner<S: Shell>(sh: &S, kind: String, id: String) -> Result<String, String> {
    valid_owner(&kind, &id)?;
    let command = if kind == "container" {
        format!("docker restart {id}")
    } else {
        format!("systemctl restart {id}")
    };
    let s = sections(
        &run(
            sh,
            &format!("[ \"$R\" ] || {{ echo @@noroot; exit 0; }}\nout=$(r timeout 180 {command} 2>&1); c=$?\necho @@out; printf '%s\\n' \"$out\" | tail -3; echo @@code; echo $c\n"),
            200,
        )
        .await?,
    );
    if s.contains_key("noroot") {
        return Err(NEEDS_ROOT.into());
    }
    if first(&s, "code") == "0" {
        Ok(String::new())
    } else {
        Err(s.get("out").map(|l| l.join(" ")).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(str::to_owned).collect()
    }

    #[test]
    fn overview_is_read_from_the_script_output() {
        let text = "@@host\nweb1\n@@os\nUbuntu 24.04.3 LTS\n@@kernel\nLinux 6.8.0 x86_64\n@@uptime\n3672000.12 100.0\n@@load\n0.81 0.68 0.75 2/900 1234\n@@cpus\n8\n@@stat1\ncpu  100 0 100 800 0 0 0 0 0 0\n@@stat2\ncpu  150 0 150 900 0 0 0 0 0 0\n@@mem\nMemTotal:       16000000 kB\nMemAvailable:    9700000 kB\nSwapTotal:       3200000 kB\nSwapFree:        1000000 kB\n@@df\nFilesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda2 ext4 144000000 124000000 14000000 91% /\n/dev/sda2 ext4 144000000 124000000 14000000 91% /var/lib/docker/x\n/dev/sda1 vfat 1000 10 990 1% /boot/efi\n@@reboot\nyes\n@@updates\n\n31 updates can be applied immediately.\n@@procs\n819 173\n@@priv\nroot\n@@docker\nyes\n";
        let o = parse_overview(text);
        assert_eq!(o.hostname, "web1");
        assert_eq!(o.cpus, 8);
        assert_eq!(o.cpu_percent, 50.0);
        assert_eq!(o.mem_available_kb, 9_700_000);
        assert_eq!(o.disks.len(), 2);
        assert_eq!(o.disks[0].mount, "/");
        assert_eq!(o.disks[0].used_kb, 124_000_000);
        assert!(o.reboot_required);
        assert_eq!(o.updates, "31 updates can be applied immediately.");
        assert_eq!((o.processes, o.zombies), (819, 173));
        assert_eq!(o.uptime_secs, 3_672_000);
        assert!(o.docker);
        assert_eq!(o.privilege, "root");
    }

    #[test]
    fn docker_sizes_become_bytes() {
        assert_eq!(docker_bytes("12.5GB (40%)"), 12_500_000_000);
        assert_eq!(docker_bytes("512kB"), 512_000);
        assert_eq!(docker_bytes("0B"), 0);
        let d = parse_docker_df(&lines(
            "Images\t40\t30.1GB\t21.2GB (70%)\nBuild Cache\t200\t5GB\t5GB",
        ));
        assert_eq!(d[0].reclaimable_bytes, 21_200_000_000);
        assert_eq!(d[1].kind, "Build Cache");
    }

    #[test]
    fn processes_keep_names_with_spaces() {
        let ps = lines("      1       0 root     Ss    0.0  0.1 12000 3600000 /sbin/init splash\n 2849530       1 1000   Sl    3.2  4.0 650000 86400 next-server (v15.1.0)\n 2849600 2849530 1000   Z     0.0  0.0     0   100 [node] <defunct>");
        let names = lines("      1 systemd\n2849530 next-server (v\n2849600 node");
        let p = parse_processes(&ps, &names);
        assert_eq!(p.len(), 3);
        assert_eq!(p[1].name, "next-server (v");
        assert_eq!(p[1].command, "next-server (v15.1.0)");
        assert_eq!(p[2].state, "Z");
        assert_eq!(p[2].ppid, 2849530);
        assert_eq!(protection(&p[0]), "Sistem süreci; durdurulamaz.");
        assert_eq!(protection(&p[1]), "");
    }

    #[test]
    fn owners_come_from_the_cgroup() {
        let id = "a".repeat(64);
        let o = parse_owner(&lines(&format!("0::/system.slice/docker-{id}.scope")));
        assert_eq!((o.kind.as_str(), o.id.as_str()), ("container", id.as_str()));
        let o = parse_owner(&lines(&format!("12:pids:/docker/{id}")));
        assert_eq!(o.kind, "container");
        let o = parse_owner(&lines("0::/system.slice/nginx.service"));
        assert_eq!(
            (o.kind.as_str(), o.id.as_str()),
            ("service", "nginx.service")
        );
        assert_eq!(
            parse_owner(&lines("0::/user.slice/user-0.slice/session-3.scope")).kind,
            ""
        );
    }

    #[test]
    fn only_safe_owners_can_be_restarted() {
        assert!(valid_owner("container", &"b".repeat(64)).is_ok());
        assert!(valid_owner("container", "web; rm -rf /").is_err());
        assert!(valid_owner("service", "nginx.service").is_ok());
        assert!(valid_owner("service", "ssh.service").is_err());
        assert!(valid_owner("service", "wecommander-agent.service").is_err());
        assert!(valid_owner("service", "a b.service").is_err());
    }

    #[test]
    fn cleanup_commands_are_fixed_and_known() {
        for c in CATEGORIES {
            assert!(!clean_command(c).is_empty(), "{}", c.id);
        }
        assert!(
            clean_command(CATEGORIES.iter().find(|c| c.id == "old-logs").unwrap())
                .ends_with("-delete")
        );
    }

    /// The scripts themselves, run by this machine's `sh` (Linux CI).
    #[cfg(target_os = "linux")]
    fn local(script: &str) -> String {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("{PRELUDE}{script}"))
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn scripts_run_on_a_real_linux_shell() {
        let sm = parse_sample(&local(SAMPLE));
        assert!(
            sm.cpu_total > 0 && sm.mem_total_kb > 0 && sm.root_used_kb > 0,
            "{sm:?}"
        );
        let o = parse_overview(&local(OVERVIEW));
        assert!(
            o.cpus >= 1 && o.mem_total_kb > 0 && o.uptime_secs > 0,
            "{o:?}"
        );
        assert!(!o.disks.is_empty(), "{o:?}");
        assert!(o.processes > 0);
        let s = sections(&local(PS));
        let p = parse_processes(&s["ps"], &s["names"]);
        assert!(p.iter().any(|p| p.pid == std::process::id()));
        assert!(p.iter().all(|p| !p.name.is_empty()));
        let mut scan = String::new();
        for c in CATEGORIES {
            let m = measure_script(c);
            if !m.is_empty() {
                scan.push_str(&format!("echo @@{}; {m}\n", c.id));
            }
        }
        let s = sections(&local(&scan));
        for id in ["apt-cache", "journal", "old-logs", "tmp", "crash"] {
            let v = first(&s, id);
            assert!(v.is_empty() || v.parse::<u64>().is_ok(), "{id}: {v:?}");
        }
    }

    #[test]
    fn samples_count_real_cards_and_whole_disks() {
        let text = "@@up\n100.5 300\n@@stat\ncpu  100 0 100 800 0 0 0 0 0 0\n@@load\n0.5 0.4 0.3 1/2 3\n@@mem\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n@@net\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\nveth1: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n@@io\n   8       0 sda 10 0 100 0 20 0 200 0 0 0 0\n   8       1 sda1 10 0 100 0 20 0 200 0 0 0 0\n 259 0 nvme0n1 1 0 8 0 1 0 8 0 0 0 0\n 259 1 nvme0n1p1 1 0 8 0 1 0 8 0 0 0 0\n";
        let s = parse_sample(text);
        assert_eq!((s.net_rx_bytes, s.net_tx_bytes), (1000, 2000));
        assert_eq!(s.disk_read_bytes, (100 + 8) * 512);
        assert_eq!(s.disk_write_bytes, (200 + 8) * 512);
        assert_eq!(s.cpu_total, 1000);
        assert_eq!(s.mem_available_kb, 400);
        assert_eq!(s.uptime, 100.5);
    }

    #[test]
    fn quoting_survives_single_quotes() {
        assert_eq!(quote("it's"), r#"'it'\''s'"#);
    }
    /// Runs the scripts with this machine's `sh` as "root" (no sudo), with a
    /// fake `docker` first on PATH: it answers per daemon and logs every call.
    #[cfg(target_os = "linux")]
    struct FakeDocker {
        dir: std::path::PathBuf,
        mode: &'static str,
    }

    #[cfg(target_os = "linux")]
    impl Shell for FakeDocker {
        async fn run_script(&self, script: &str, _secs: u64) -> Result<String, String> {
            let script = script.replacen(PRELUDE, "export LC_ALL=C\nR=root\nr() { \"$@\"; }\n", 1);
            let path = format!(
                "{}/bin:{}",
                self.dir.display(),
                std::env::var("PATH").unwrap_or_default()
            );
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .env("PATH", path)
                .env("FAKE_LOG", self.dir.join("calls.log"))
                .env("FAKE_MODE", self.mode)
                .output()
                .map_err(|e| e.to_string())?;
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
    }

    #[cfg(target_os = "linux")]
    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        loop {
            if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    #[cfg(target_os = "linux")]
    const FAKE_DOCKER: &str = r#"#!/bin/sh
h=default
if [ "$1" = -H ]; then h=${2#unix://}; shift 2; fi
echo "$h|$*" >> "$FAKE_LOG"
case "$h" in */run/user/*) rootless=1 ;; *) rootless= ;; esac
if [ "$rootless" ] && [ "$FAKE_MODE" = denied ]; then echo "permission denied while trying to connect to the Docker daemon socket at unix://$h" >&2; exit 1; fi
case "$1" in
system) if [ "$rootless" ]; then printf 'Images\t31\t1\t61.2GB\t13.9GB (22%%)\nContainers\t2\t1\t2MB\t0B (0%%)\nLocal Volumes\t3\t1\t328MB\t0B (0%%)\nBuild Cache\t512\t0\t33.77GB\t33.77GB\n'; else printf 'Images\t2\t1\t1GB\t500MB (50%%)\nContainers\t1\t1\t1MB\t0B\nLocal Volumes\t0\t0\t0B\t0B\nBuild Cache\t0\t0\t0B\t0B\n'; fi ;;
info) if [ "$rootless" ]; then echo /var/lib/devagent-ci/.local/share/docker; else echo /var/lib/docker; fi ;;
ps) if [ "$2" = -aq ]; then [ "$rootless" ] && printf 'a1\na2\n'; elif [ "$rootless" ]; then printf 'devagent-stage2-gpu-relay\tdevagent/relay:42\n'; fi ;;
images) [ "$rootless" ] && printf '1.2GB\n800MB\n' ;;
builder|image) echo "Total reclaimed space: 1GB" ;;
*) echo "unexpected: $*" >&2; exit 9 ;;
esac
"#;

    /// A temporary /run/user with real sockets: this user's (a rootless
    /// daemon), and one in another uid's folder that this user owns (not a
    /// daemon of that uid: ignored).
    #[cfg(target_os = "linux")]
    fn fake_server(
        name: &str,
    ) -> (
        std::path::PathBuf,
        String,
        Vec<std::os::unix::net::UnixListener>,
    ) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("wc-docker-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let docker = dir.join("bin/docker");
        std::fs::write(&docker, FAKE_DOCKER).unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let me = String::from_utf8(
            std::process::Command::new("id")
                .arg("-u")
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let me = me.trim().to_owned();
        let run_user = dir.join("run/user");
        let mut listeners = Vec::new();
        for uid in [me.as_str(), "4242"] {
            std::fs::create_dir_all(run_user.join(uid)).unwrap();
            listeners.push(
                std::os::unix::net::UnixListener::bind(run_user.join(uid).join("docker.sock"))
                    .unwrap(),
            );
        }
        (dir, me, listeners)
    }

    // 2, 5, 9, 12: found, offered separately, and the run goes to the very
    // daemon the preview showed (with Docker's own prune only).
    #[cfg(target_os = "linux")]
    #[test]
    fn rootless_cleanup_preview_and_run_use_the_same_daemon() {
        let (dir, me, _sockets) = fake_server("same");
        if me == "0" {
            return; // as root every folder is root's: the ownership check is covered by parse tests
        }
        let run_user = dir.join("run/user").display().to_string();
        let sh = FakeDocker {
            dir: dir.clone(),
            mode: "",
        };
        let scan = block_on(cleanup_scan_in(&sh, &run_user)).unwrap();
        let ids: Vec<&str> = scan.dockers.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            ids,
            ["system".to_owned(), format!("u{me}")],
            "{:?}",
            scan.dockers
        );
        let rootless = &scan.dockers[1];
        assert_eq!(rootless.build_cache_reclaimable_bytes, 33_770_000_000);
        assert_eq!(
            rootless.root_dir,
            "/var/lib/devagent-ci/.local/share/docker"
        );
        assert_eq!(
            rootless.running,
            ["devagent-stage2-gpu-relay (devagent/relay:42)"]
        );
        assert_eq!(rootless.containers_total, 2);
        // The 4242 folder's socket belongs to this user, not to 4242: no daemon.
        assert!(!scan.dockers.iter().any(|d| d.id == "u4242"));

        let socket = format!("{run_user}/{me}/docker.sock");
        let build = scan
            .items
            .iter()
            .find(|i| i.id == format!("docker-build@u{me}"))
            .unwrap();
        assert_eq!(
            build.command,
            format!("docker -H unix://{socket} builder prune -af")
        );
        assert_eq!(build.kb, 33_770_000_000 / 1024);
        assert_eq!(build.docker, format!("u{me}"));
        let unused = scan
            .items
            .iter()
            .find(|i| i.id == format!("docker-unused@u{me}"))
            .unwrap();
        let dangling = scan
            .items
            .iter()
            .find(|i| i.id == format!("docker-dangling@u{me}"))
            .unwrap();
        assert_eq!(unused.group, dangling.group);
        assert!(!unused.warning.is_empty());
        // The system daemon keeps its old ids.
        assert!(scan
            .items
            .iter()
            .any(|i| i.id == "docker-build" && i.docker == "system"));

        std::fs::write(dir.join("calls.log"), "").unwrap();
        let done = block_on(cleanup_run_in(
            &sh,
            vec![build.id.clone(), unused.id.clone()],
            &run_user,
        ))
        .unwrap();
        assert!(done.iter().all(|r| r.ok), "{done:?}");
        let calls = std::fs::read_to_string(dir.join("calls.log")).unwrap();
        let prunes: Vec<&str> = calls.lines().filter(|l| l.contains("prune")).collect();
        assert_eq!(
            prunes,
            [
                format!("{socket}|builder prune -af"),
                format!("{socket}|image prune -af")
            ],
            "{calls}"
        );

        // An id for a daemon that is not there, or not an id at all: refused, nothing runs.
        std::fs::write(dir.join("calls.log"), "").unwrap();
        assert!(block_on(cleanup_run_in(
            &sh,
            vec!["docker-build@u4242".into()],
            &run_user
        ))
        .is_err());
        assert!(block_on(cleanup_run_in(
            &sh,
            vec!["docker-build@u1;rm -rf /".into()],
            &run_user
        ))
        .is_err());
        assert!(block_on(cleanup_run_in(&sh, vec!["journal@u1000".into()], &run_user)).is_err());
        let calls = std::fs::read_to_string(dir.join("calls.log")).unwrap();
        assert!(!calls.contains("prune"), "{calls}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 4 and 10: a daemon that refuses (no access) is reported, offers no
    // cleanup, and the others are unaffected.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_daemon_without_access_is_reported_alone() {
        let (dir, me, _sockets) = fake_server("denied");
        if me == "0" {
            return;
        }
        let run_user = dir.join("run/user").display().to_string();
        let scan = block_on(cleanup_scan_in(
            &FakeDocker {
                dir: dir.clone(),
                mode: "denied",
            },
            &run_user,
        ))
        .unwrap();
        let rootless = scan
            .dockers
            .iter()
            .find(|d| d.id == format!("u{me}"))
            .unwrap();
        assert!(
            rootless.error.contains("erişim izni yok"),
            "{}",
            rootless.error
        );
        assert!(!scan.items.iter().any(|i| i.docker == rootless.id));
        assert!(
            scan.items.iter().any(|i| i.id == "docker-build"),
            "the system daemon still offers its cleanup"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
