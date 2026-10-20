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
