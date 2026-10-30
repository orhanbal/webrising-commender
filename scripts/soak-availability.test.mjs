import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const script = fileURLToPath(new URL("./soak-availability.mjs", import.meta.url));
async function run(url, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wc-soak-")), output = join(dir, "result.json");
  const env = { ...process.env, COMMANDER_CONTROL_URL: url, CONTROL_API_KEY: "test-secret-never-print",
    DEVICE_ID: "fixture", SOAK_CONFIRM_ISOLATED: "YES", SOAK_DURATION_MS: "1100",
    SOAK_INTERVAL_MS: "150", SOAK_REQUEST_TIMEOUT_MS: "500", SOAK_MIN_SAMPLES: "4",
    SOAK_OUTPUT: output, ...overrides };
  try {
    let code = 0, stdout = "", stderr = "";
    try { ({ stdout, stderr } = await exec(process.execPath, [script], { env, timeout: 8000 })); }
    catch (error) { code = error.code; stdout = error.stdout || ""; stderr = error.stderr || ""; }
    assert.ok(!stdout.includes(env.CONTROL_API_KEY) && !stderr.includes(env.CONTROL_API_KEY));
    let report = null;
    try { report = JSON.parse(await readFile(output, "utf8")); } catch {}
    return { code, report };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function serve(handler, fn) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await fn("http://127.0.0.1:" + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test("healthy isolated MCP probes pass and report metrics", async () => {
  await serve((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end('{"ok":true,"data":{"cpuCount":4}}'); },
    async url => { const r = await run(url); assert.equal(r.code, 0); assert.equal(r.report.passed, true);
      assert.equal(r.report.failures, 0); assert.ok(r.report.attempts >= 4); });
});
test("intermittent HTTP 503 fails zero-error SLO", async () => {
  let count = 0;
  await serve((_req, res) => { count++; res.setHeader("Content-Type", "application/json");
    if (count % 2 === 0) res.statusCode = 503;
    res.end(count % 2 === 0 ? '{}' : '{"ok":true,"data":{"cpuCount":4}}'); },
    async url => { const r = await run(url); assert.equal(r.code, 1); assert.equal(r.report.passed, false);
      assert.ok(r.report.errorCounts.HTTP_503 >= 1); });
});
test("HTTP 401 stops early without masking authorization failures", async () => {
  await serve((_req, res) => { res.statusCode = 401; res.end("{}"); },
    async url => { const r = await run(url); assert.equal(r.code, 1);
      assert.equal(r.report.fatal, "HTTP_401"); assert.equal(r.report.attempts, 1); });
});
test("non-isolated and remote HTTP targets are rejected", async () => {
  assert.equal((await run("http://example.com")).code, 1);
  assert.equal((await run("http://127.0.0.1:8787", { SOAK_CONFIRM_ISOLATED: "NO" })).code, 1);
});

test("HTTP 200 with explicit Gateway failure cannot produce false-green SLO", async () => {
  await serve((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":false,"data":{"cpuCount":4},"error":"agent_unavailable"}');
  }, async url => {
    const r = await run(url);
    assert.equal(r.code, 1);
    assert.equal(r.report.successes, 0);
    assert.ok(r.report.errorCounts.INVALID_RESPONSE >= 1);
  });
});
test("HTTP 200 without native Rust system_info is not a success", async () => {
  await serve((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true,"data":{"os":"not-agent-proof"}}');
  }, async url => {
    const r = await run(url);
    assert.equal(r.code, 1);
    assert.equal(r.report.successes, 0);
    assert.ok(r.report.errorCounts.INVALID_RESPONSE >= 1);
  });
});
test("bearer-authenticated probes never follow HTTP redirects", async () => {
  await serve((_req, res) => {
    res.writeHead(302, { Location: "http://127.0.0.1:1/redirect" });
    res.end();
  }, async url => {
    const r = await run(url);
    assert.equal(r.code, 1);
    assert.equal(r.report.successes, 0);
    assert.ok(r.report.errorCounts.NETWORK >= 1);
  });
});
test("oversized successful-looking responses are rejected before JSON parsing", async () => {
  await serve((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { cpuCount: 4, padding: "x".repeat(70000) } }));
  }, async url => {
    const r = await run(url);
    assert.equal(r.code, 1);
    assert.equal(r.report.successes, 0);
    assert.ok(r.report.errorCounts.RESPONSE_TOO_LARGE >= 1);
  });
});
test("HTTP 403 stops immediately and is not treated as transient downtime", async () => {
  await serve((_req, res) => { res.statusCode = 403; res.end("{}"); }, async url => {
    const r = await run(url);
    assert.equal(r.code, 1);
    assert.equal(r.report.fatal, "HTTP_403");
    assert.equal(r.report.attempts, 1);
  });
});

test("monotonic soak duration resists forward and backward wall-clock jumps", async () => {
  await serve((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true,"data":{"cpuCount":4}}');
  }, async url => {
    const dir = await mkdtemp(join(tmpdir(), "wc-soak-clock-"));
    try {
      for (const jump of [86400000, -86400000]) {
        // Preload runs in the CHILD process only. It simulates a system clock
        // correction after the probe starts; performance.now() remains steady.
        const preload = join(dir, jump > 0 ? "forward.cjs" : "backward.cjs");
        await writeFile(preload,
          "const real=Date.now.bind(Date); const start=performance.now();" +
          "Date.now=()=>real()+(performance.now()-start>=250?(" + jump + "):0);\n");
        const started = performance.now();
        const r = await run(url, { NODE_OPTIONS: "--require=" + preload });
        const realElapsedMs = performance.now() - started;
        assert.equal(r.code, 0, "clock jump must not cause a false failure");
        assert.equal(r.report.passed, true);
        assert.equal(r.report.durationClock, "monotonic");
        assert.ok(r.report.elapsedMs >= 1100, "monotonic duration was truncated");
        assert.ok(realElapsedMs >= 1000, "wall-clock jump ended soak early");
        assert.ok(realElapsedMs < 4000, "backward wall-clock jump prolonged soak");
        assert.ok(Math.abs(r.report.wallClockDriftMs) > 80000000,
          "clock drift should be visible in the audit report");
        assert.equal(Math.sign(r.report.wallClockDriftMs), Math.sign(jump));
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
