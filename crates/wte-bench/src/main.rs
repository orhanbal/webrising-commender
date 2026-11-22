//! `wte-bench [--mb N] [--runs N] [--json FILE] [--write-workloads DIR]`
//!
//! Prints MB/s per workload and stage. The best of `--runs` counts (the
//! least disturbed run), as usual for throughput benchmarks.

use std::time::Instant;
use wte_bench::{stages, workloads::Workload};

struct Args {
    mb: usize,
    runs: usize,
    json: Option<String>,
    write_workloads: Option<String>,
}

fn args() -> Args {
    let mut a = Args {
        mb: 16,
        runs: 5,
        json: None,
        write_workloads: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .unwrap_or_else(|| usage(&format!("{flag} needs a value")))
        };
        match flag.as_str() {
            "--mb" => {
                a.mb = value()
                    .parse()
                    .unwrap_or_else(|_| usage("--mb is a number"))
            }
            "--runs" => {
                a.runs = value()
                    .parse()
                    .unwrap_or_else(|_| usage("--runs is a number"))
            }
            "--json" => a.json = Some(value()),
            "--write-workloads" => a.write_workloads = Some(value()),
            "-h" | "--help" => usage(""),
            other => usage(&format!("unknown argument {other}")),
        }
    }
    a.runs = a.runs.max(1);
    a
}

fn usage(error: &str) -> ! {
    if !error.is_empty() {
        eprintln!("wte-bench: {error}");
    }
    eprintln!("usage: wte-bench [--mb N] [--runs N] [--json FILE] [--write-workloads DIR]");
    std::process::exit(if error.is_empty() { 0 } else { 2 });
}

fn best_mbps(bytes: usize, runs: usize, mut f: impl FnMut() -> usize) -> f64 {
    let mut best = f64::MAX;
    for _ in 0..runs {
        let start = Instant::now();
        let out = std::hint::black_box(f());
        let secs = start.elapsed().as_secs_f64();
        assert!(out > 0, "stage produced nothing");
        best = best.min(secs);
    }
    bytes as f64 / (1024.0 * 1024.0) / best
}

fn main() {
    let a = args();
    let size = a.mb * 1024 * 1024;
    let mut rows = Vec::new();
    println!(
        "{:<11} {:>10} {:>12} {:>11} {:>11} {:>11} {:>11} {:>8}",
        "workload", "MiB", "transport", "base64", "vte parse", "wte-core", "scan", "wire x"
    );
    for w in Workload::ALL {
        let input = w.generate(size);
        if let Some(dir) = &a.write_workloads {
            std::fs::create_dir_all(dir).expect("create workload dir");
            std::fs::write(format!("{dir}/{}.vt", w.name()), &input).expect("write workload");
        }
        let (_, wire) = stages::transport(&input);
        let transport = best_mbps(input.len(), a.runs, || stages::transport(&input).0);
        let base64 = best_mbps(input.len(), a.runs, || stages::base64_only(&input));
        let parse = best_mbps(input.len(), a.runs, || {
            let c = stages::parse(&input);
            (c.printed + c.executed + c.csi) as usize
        });
        let core = best_mbps(input.len(), a.runs, || stages::wte_core(&input));
        let scan = best_mbps(input.len(), a.runs, || stages::scan(&input) + 1);
        let inflation = wire as f64 / input.len() as f64;
        println!(
            "{:<11} {:>10.1} {:>10.0}/s {:>9.0}/s {:>9.0}/s {:>9.0}/s {:>9.0}/s {:>8.2}",
            w.name(),
            input.len() as f64 / 1048576.0,
            transport,
            base64,
            parse,
            core,
            scan,
            inflation
        );
        rows.push(serde_json::json!({
            "workload": w.name(), "bytes": input.len(),
            "transport_mibps": transport, "base64_mibps": base64,
            "vte_parse_mibps": parse, "wte_core_mibps": core, "scan_mibps": scan, "wire_inflation": inflation,
        }));
    }
    println!(
        "(MiB/s, best of {} runs; wire x = bytes on stdout per terminal byte)",
        a.runs
    );
    if let Some(path) = a.json {
        let report = serde_json::json!({
            "tool": "wte-bench", "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "mib_per_workload": a.mb, "runs": a.runs, "chunk": stages::CHUNK, "results": rows,
        });
        std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).expect("write json");
    }
}
