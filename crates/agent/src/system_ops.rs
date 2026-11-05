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
    let disk_items: Vec<Value> = disks
        .list()
        .iter()
        .filter(|d| d.total_space() > 0)
        .take(32)
        .map(|d| {
            let used = d.total_space().saturating_sub(d.available_space());
            json!({
                "mount": d.mount_point().to_string_lossy(),
                "fileSystem": d.file_system().to_string_lossy(),
                "totalBytes": d.total_space(),
                "availableBytes": d.available_space(),
                "usedPercent": percent(used, d.total_space()),
            })
        })
        .collect();

    let networks = Networks::new_with_refreshed_list();
    let mut net_items: Vec<Value> = networks
        .iter()
        .map(|(name, data)| {
            json!({
                "name": name,
                "receivedBytes": data.total_received(),
                "transmittedBytes": data.total_transmitted(),
            })
        })
        .collect();
    net_items.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    net_items.truncate(32);

    let cpus = system.cpus().len().max(1) as f32;
    let mut processes: Vec<_> = system.processes().iter().collect();
    let row = |(pid, p): &(&sysinfo::Pid, &sysinfo::Process)| {
        json!({
            "pid": pid.as_u32(),
            "name": p.name().to_string_lossy(),
            "cpuPercent": (p.cpu_usage() / cpus * 10.0).round() / 10.0,
            "memoryBytes": p.memory(),
        })
    };
    processes.sort_by(|a, b| b.1.cpu_usage().total_cmp(&a.1.cpu_usage()));
    let by_cpu: Vec<Value> = processes.iter().take(top).map(row).collect();
    processes.sort_by_key(|p| std::cmp::Reverse(p.1.memory()));
    let by_memory: Vec<Value> = processes.iter().take(top).map(row).collect();

    let total = system.total_memory();
    let available = system.available_memory();
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
        "processCount": processes.len(),
        "limitations": limitations,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
