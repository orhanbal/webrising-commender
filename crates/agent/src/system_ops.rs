use anyhow::Result;
use serde_json::{json, Value};
use sysinfo::System;

pub fn info() -> Result<Value> {
    let mut system = System::new_all();
    system.refresh_all();

    Ok(json!({
        "hostname": System::host_name(),
        "os": System::name(),
        "osVersion": System::os_version(),
        "kernelVersion": System::kernel_version(),
        "cpuCount": system.cpus().len(),
        "totalMemory": system.total_memory(),
        "usedMemory": system.used_memory(),
        "uptimeSeconds": System::uptime()
    }))
}

/// RFC 3339 UTC timestamp for `secs` since the Unix epoch.
pub fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant), valid for the proleptic Gregorian calendar.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn percent(used: u64, total: u64) -> Value {
    if total == 0 {
        Value::Null
    } else {
        json!(((used as f64 / total as f64) * 1000.0).round() / 10.0)
    }
}

/// One bounded health snapshot (v1.2, AD1-04): CPU, memory, disks, network
/// counters and the top processes, in the common observation envelope
/// (`observedAt`, `source`, `limitations`). Read-only and cheap: one CPU
/// sample of about a quarter second.
pub fn health_snapshot(top: Option<usize>) -> Result<Value> {
    use sysinfo::{Disks, Networks, ProcessesToUpdate};
    let top = top.unwrap_or(5).clamp(1, 20);
    let mut system = System::new();
    system.refresh_cpu_usage();
    system.refresh_memory();
    system.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(
        sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(std::time::Duration::from_millis(250)),
    );
    system.refresh_cpu_usage();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let observed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let load = System::load_average();
    let mut limitations = vec![
        "CPU usage is one sample of about 250 ms, not an average".to_string(),
        "network counters are totals since the interface came up".to_string(),
    ];
    let load_value = if cfg!(windows) {
        limitations.push("load average is not available on Windows".into());
        Value::Null
    } else {
        json!({ "one": load.one, "five": load.five, "fifteen": load.fifteen })
    };

    let disks = Disks::new_with_refreshed_list();
    let disk_items = group_disks(
        disks
            .list()
            .iter()
            .filter(|d| d.total_space() > 0)
            .map(|d| DiskRow {
                device: d.name().to_string_lossy().into_owned(),
                mount: d.mount_point().to_string_lossy().into_owned(),
                file_system: d.file_system().to_string_lossy().into_owned(),
                total: d.total_space(),
                available: d.available_space(),
            })
            .collect(),
    );

    let networks = Networks::new_with_refreshed_list();
    let net_items = group_networks(
        networks
            .iter()
            .map(|(name, data)| {
                (
                    name.clone(),
                    data.total_received(),
                    data.total_transmitted(),
                )
            })
            .collect(),
    );

    let cpus = system.cpus().len().max(1) as f32;
    let process_rows: Vec<ProcessRow> = system
        .processes()
        .iter()
        .map(|(pid, p)| ProcessRow {
            pid: pid.as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            cpu: p.cpu_usage() / cpus,
            memory: p.memory(),
        })
        .collect();
    let process_count = process_rows.len();
    let (by_cpu, by_memory) = top_process_groups(process_rows, top);

    let total = system.total_memory();
    let mut available = system.available_memory();
    if available == 0 && total > 0 {
        // Seen on macOS 26: the platform reports no "available" figure, which
        // would read as 100 % used. Fall back to total minus used and say so.
        available = total.saturating_sub(system.used_memory());
        limitations.push(
            "available memory estimated as total minus used (the OS reported none); caches may count as used"
                .into(),
        );
    }
    Ok(json!({
        "observedAt": rfc3339(observed),
        "source": "agent",
        "hostname": System::host_name(),
        "uptimeSeconds": System::uptime(),
        "cpu": {
            "count": system.cpus().len(),
            "usagePercent": (system.global_cpu_usage() * 10.0).round() / 10.0,
            "loadAverage": load_value,
        },
        "memory": {
            "totalBytes": total,
            "availableBytes": available,
            "usedPercent": percent(total.saturating_sub(available), total),
            "swapTotalBytes": system.total_swap(),
            "swapUsedBytes": system.used_swap(),
        },
        "disks": disk_items,
        "network": net_items,
        "topProcesses": { "byCpu": by_cpu, "byMemory": by_memory },
        "processCount": process_count,
        "limitations": limitations,
    }))
}

struct DiskRow {
    device: String,
    mount: String,
    file_system: String,
    total: u64,
    available: u64,
}

/// One entry per file system: bind mounts and container overlays of the same
/// device (same device name and sizes) are listed once, with the other mount
/// points under `alsoMountedAt`. Shortest mount point first ("/" before
/// "/var/lib/docker/...").
fn group_disks(mut rows: Vec<DiskRow>) -> Vec<Value> {
    rows.sort_by(|a, b| {
        a.mount
            .len()
            .cmp(&b.mount.len())
            .then(a.mount.cmp(&b.mount))
    });
    let mut groups: Vec<(DiskRow, Vec<String>)> = Vec::new();
    for row in rows {
        match groups.iter_mut().find(|(g, _)| {
            g.device == row.device && g.total == row.total && g.available == row.available
        }) {
            Some((_, others)) => others.push(row.mount),
            None => groups.push((row, Vec::new())),
        }
    }
    groups
        .into_iter()
        .take(32)
        .map(|(d, others)| {
            let used = d.total.saturating_sub(d.available);
            let mut item = json!({
                "mount": d.mount,
                "fileSystem": d.file_system,
                "totalBytes": d.total,
                "availableBytes": d.available,
                "usedPercent": percent(used, d.total),
            });
            if !others.is_empty() {
                item["mountCount"] = json!(others.len() + 1);
                item["alsoMountedAt"] = json!(others.into_iter().take(5).collect::<Vec<_>>());
            }
            item
        })
        .collect()
}

/// Virtual interfaces made by container runtimes and hypervisors.
fn is_virtual_interface(name: &str) -> bool {
    [
        "veth", "br-", "docker", "cni", "flannel", "cali", "virbr", "vnet", "tap", "kube-",
    ]
    .iter()
    .any(|p| name.starts_with(p))
}

/// Real interfaces one by one; container and VM interfaces (veth*, br-*,
/// docker0, ...) as one summed entry, so a busy Docker host stays readable.
fn group_networks(mut rows: Vec<(String, u64, u64)>) -> Vec<Value> {
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    let (virtual_rows, real): (Vec<_>, Vec<_>) = rows
        .into_iter()
        .partition(|(name, _, _)| is_virtual_interface(name));
    let mut items: Vec<Value> = real
        .into_iter()
        .take(31)
        .map(|(name, rx, tx)| json!({ "name": name, "receivedBytes": rx, "transmittedBytes": tx }))
        .collect();
    if !virtual_rows.is_empty() {
        let rx: u64 = virtual_rows
            .iter()
            .map(|r| r.1)
            .fold(0, u64::saturating_add);
        let tx: u64 = virtual_rows
            .iter()
            .map(|r| r.2)
            .fold(0, u64::saturating_add);
        items.push(json!({
            "name": "container/virtual interfaces",
            "interfaceCount": virtual_rows.len(),
            "receivedBytes": rx,
            "transmittedBytes": tx,
        }));
    }
    items
}

struct ProcessRow {
    pid: u32,
    name: String,
    cpu: f32,
    memory: u64,
}

/// Top processes by CPU and by memory, with same-named processes (worker
/// pools, browser helpers, many dockerd/containerd-shim copies) summed into
/// one row that carries `count` and up to five `pids`.
fn top_process_groups(rows: Vec<ProcessRow>, top: usize) -> (Vec<Value>, Vec<Value>) {
    let mut groups: Vec<(String, f32, u64, Vec<u32>)> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for row in rows {
        match index.get(&row.name) {
            Some(&i) => {
                let g = &mut groups[i];
                g.1 += row.cpu;
                g.2 = g.2.saturating_add(row.memory);
                g.3.push(row.pid);
            }
            None => {
                index.insert(row.name.clone(), groups.len());
                groups.push((row.name, row.cpu, row.memory, vec![row.pid]));
            }
        }
    }
    let render = |(name, cpu, memory, pids): &(String, f32, u64, Vec<u32>)| {
        let mut sorted = pids.clone();
        sorted.sort_unstable();
        let mut item = json!({
            "pid": sorted[0],
            "name": name,
            "cpuPercent": (cpu * 10.0).round() / 10.0,
            "memoryBytes": memory,
        });
        if sorted.len() > 1 {
            item["count"] = json!(sorted.len());
            item["pids"] = json!(sorted.into_iter().take(5).collect::<Vec<_>>());
        }
        item
    };
    groups.sort_by(|a, b| b.1.total_cmp(&a.1));
    let by_cpu = groups.iter().take(top).map(render).collect();
    groups.sort_by_key(|g| std::cmp::Reverse(g.2));
    let by_memory = groups.iter().take(top).map(render).collect();
    (by_cpu, by_memory)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_mounts_of_one_disk_are_listed_once() {
        let disk = |device: &str, mount: &str, total: u64, available: u64| DiskRow {
            device: device.into(),
            mount: mount.into(),
            file_system: "ext4".into(),
            total,
            available,
        };
        let items = group_disks(vec![
            disk("/dev/vda1", "/etc/hosts", 100, 40),
            disk("/dev/vda1", "/", 100, 40),
            disk("/dev/vda1", "/etc/resolv.conf", 100, 40),
            disk("/dev/vdb", "/data", 500, 400),
        ]);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["mount"], "/");
        assert_eq!(items[0]["mountCount"], 3);
        assert_eq!(
            items[0]["alsoMountedAt"],
            json!(["/etc/hosts", "/etc/resolv.conf"])
        );
        assert_eq!(items[1]["mount"], "/data");
        assert!(items[1].get("alsoMountedAt").is_none());
    }

    #[test]
    fn container_interfaces_are_summed() {
        let items = group_networks(vec![
            ("vethabc".into(), 10, 1),
            ("eth0".into(), 1000, 500),
            ("docker0".into(), 5, 5),
            ("br-123".into(), 1, 1),
            ("lo".into(), 7, 7),
        ]);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["name"], "eth0");
        assert_eq!(items[1]["name"], "lo");
        assert_eq!(items[2]["interfaceCount"], 3);
        assert_eq!(items[2]["receivedBytes"], 16);
    }

    #[test]
    fn same_named_processes_are_one_row() {
        let p = |pid, name: &str, cpu, memory| ProcessRow {
            pid,
            name: name.into(),
            cpu,
            memory,
        };
        let (by_cpu, by_memory) = top_process_groups(
            vec![
                p(30, "dockerd", 1.0, 100),
                p(10, "dockerd", 2.0, 100),
                p(20, "node", 2.5, 500),
                p(40, "dockerd", 0.5, 100),
            ],
            5,
        );
        assert_eq!(by_cpu[0]["name"], "dockerd");
        assert_eq!(by_cpu[0]["cpuPercent"], 3.5);
        assert_eq!(by_cpu[0]["count"], 3);
        assert_eq!(by_cpu[0]["pid"], 10);
        assert_eq!(by_cpu[0]["pids"], json!([10, 30, 40]));
        assert_eq!(by_memory[0]["name"], "node");
        assert!(by_memory[0].get("count").is_none());
        assert_eq!(top_process_groups(vec![], 3).0.len(), 0);
    }

    #[test]
    fn formats_rfc3339() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_793_916_000), "2026-11-05T22:00:00Z");
    }

    #[test]
    fn snapshot_is_bounded_and_shaped() {
        let snap = health_snapshot(Some(3)).unwrap();
        assert!(snap["observedAt"].as_str().unwrap().ends_with('Z'));
        assert!(snap["cpu"]["count"].as_u64().unwrap() >= 1);
        assert!(snap["memory"]["totalBytes"].as_u64().unwrap() > 0);
        assert!(snap["topProcesses"]["byCpu"].as_array().unwrap().len() <= 3);
        assert!(snap["topProcesses"]["byMemory"].as_array().unwrap().len() <= 3);
        assert!(snap["disks"].as_array().unwrap().len() <= 32);
        assert!(!snap["limitations"].as_array().unwrap().is_empty());
        let wide = health_snapshot(Some(500)).unwrap();
        assert!(wide["topProcesses"]["byCpu"].as_array().unwrap().len() <= 20);
    }
}
