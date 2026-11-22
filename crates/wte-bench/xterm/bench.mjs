// node bench.mjs <workload dir> [runs] [json out]
// Feeds each <name>.vt to a headless xterm.js 5 terminal (120x40, 1000 lines
// of scrollback, like the app) in 32 KiB chunks, as the page receives them,
// and reports the best MiB/s of the runs. Rendering is not included: this is
// the parser and buffer, the part WTE2 replaces in Rust.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import xterm from "@xterm/headless";

const [dir, runsArg, jsonOut] = process.argv.slice(2);
if (!dir) {
  console.error("usage: node bench.mjs <workload dir> [runs] [json out]");
  process.exit(2);
}
const runs = Math.max(1, Number(runsArg ?? 3));
const CHUNK = 32 * 1024;

function once(data) {
  const term = new xterm.Terminal({ cols: 120, rows: 40, scrollback: 1000, allowProposedApi: true });
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < data.length; i += CHUNK) term.write(data.subarray(i, i + CHUNK));
    term.write("", () => {
      const secs = Number(process.hrtime.bigint() - start) / 1e9;
      term.dispose();
      resolve(secs);
    });
  });
}

const results = [];
console.log("workload    xterm.js MiB/s");
for (const file of readdirSync(dir).filter((f) => f.endsWith(".vt")).sort()) {
  const data = new Uint8Array(readFileSync(join(dir, file)));
  let best = Infinity;
  for (let r = 0; r < runs; r++) best = Math.min(best, await once(data));
  const mibps = data.length / 1048576 / best;
  const name = file.replace(/\.vt$/, "");
  results.push({ workload: name, bytes: data.length, xterm_mibps: mibps });
  console.log(`${name.padEnd(11)} ${mibps.toFixed(1).padStart(10)}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ tool: "wte-bench-xterm", xterm: "5.5.0", node: process.version, runs, results }, null, 2));
