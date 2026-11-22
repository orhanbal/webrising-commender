# WTE2: the WECOMMANDER terminal engine

Goal: the fastest terminal on Windows and macOS. To get there, every step is
judged by numbers from the same tools on the same workloads, not by
impressions.

## Steps

| # | Step | What changes | Done when |
|---|---|---|---|
| 0 | **Measurement** (this PR) | `crates/wte-bench`: fixed workloads; today's path measured stage by stage, with xterm.js as the baseline | Linux, Windows and macOS numbers recorded below |
| 1 | **Rust core** (`wte-core`) | VT parser, grid and scrollback in Rust, shared by all apps (replaces the xterm.js and SwiftTerm parsers) | Passes vttest/esctest conformance; at least 10× xterm.js on every workload |
| 2 | **SIMD parser** | Printable runs and UTF-8 checks with SIMD (SSE2/AVX2, NEON); the state machine runs only at control bytes | ascii ≥ 1 GiB/s and sgr/tui ≥ 400 MiB/s on the test machines |
| 3 | **GPU rendering** | wgpu (D3D12 / Metal), glyph atlas, only changed rows redrawn, frames paced to the display | A full frame on a 4K, 120 Hz display within one refresh; idle uses no GPU |
| 4 | **Short input path** | Keys go straight to the core; no JSON or WebView hops | Keypress-to-screen latency measured on real hardware and below today's |
| 5 | **SSH speedups** | Predictive local echo (as mosh does) and shared SSH connections | Typing on a 150 ms link looks immediate; wrong predictions are corrected |
| 6 | **Native embedding** | WinUI `SwapChainPanel` and macOS `CAMetalLayer`, with no WebView2 | Tabs, split panes and the Dock panel run on WTE2; xterm.js is removed |

CRE is not a dependency. WTE2 stands on its own.

## Today's path

```
SSH bytes ─▶ wecommander-core: base64 + JSON event line on stdout
          ─▶ app (C#/Swift): parse JSON, wrap base64 in a second JSON message
          ─▶ WebView2 page: parse JSON, decode base64
          ─▶ xterm.js: parse, update the buffer, render
```

## Measure

```bash
cargo run --release -p wte-bench -- --mb 16 --runs 5 --json wte.json --write-workloads wl
```

```bash
cd crates/wte-bench/xterm && npm ci && node bench.mjs ../../../wl 3 xterm.json
```

**Workloads** (deterministic, so results from different machines compare):

- `ascii`: log lines
- `sgr`: coloured output (16, 256 and true colour)
- `unicode`: Turkish, CJK, emoji and combining marks
- `tui-redraw`: full 120×40 frames with 256-colour cells (htop, vim)
- `scroll`: `yes`, one tiny line at a time

**Stages:**

- `transport`: today's base64/JSON round trip
- `base64`: the base64 round trip alone
- `vte parse`: the Alacritty parser (a reference for a Rust parser)
- `scan`: one plain pass over the bytes, without hand-written SIMD
- xterm.js 5.5.0 headless: today's parser and buffer, without rendering

## Baseline: Linux

The machine is a 4-vCPU Intel Xeon at 2.1 GHz (cloud container), measured on 22 Nov 2026. The table shows MiB/s, best of 5 runs (3 for xterm.js), with 16 MiB per workload.

| workload | transport | base64 only | vte parse | scan | **xterm.js** |
|---|---:|---:|---:|---:|---:|
| ascii | 370 | 1075 | 961 | 1201 | **68.9** |
| sgr | 391 | 1036 | 209 | 1149 | **51.2** |
| unicode | 408 | 1018 | 247 | 1206 | **38.6** |
| tui-redraw | 369 | 1022 | 221 | 1188 | **73.2** |
| scroll | 406 | 1037 | 1072 | 1216 | **8.8** |

The transport sends 1.34 bytes on stdout for every terminal byte.

**What this says:**

1. **The bottleneck is xterm.js, not the transport.** Its parser and buffer
   run at 9–73 MiB/s, while the base64/JSON transport runs at 370–410 MiB/s.
   That makes the xterm.js stage 5× to 45× slower, and rendering comes on top.
2. **Scrolling is the worst case.** Short lines run at 8.8 MiB/s
   (`yes`, `tail -f` of a busy log), so step 1 has to make scrolling a ring
   buffer pointer move, not a copy.
3. **A Rust parser alone is 3–14× faster than xterm.js.** vte runs at
   209–1072 MiB/s, and step 2 must beat it on coloured output (sgr and tui
   at about 210–250 MiB/s).
4. **The transport is waste, not a limit.** Base64 inflates the data by a
   third and costs CPU. Once the core renders in-process (steps 1 and 6),
   terminal bytes never leave Rust.

## Baseline: Windows and macOS

To be recorded with the same two commands on the test machines (VENTURE for
Windows, the Mac for macOS), together with rendering and input latency once
step 4's harness exists.
