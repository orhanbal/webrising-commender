import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  await serve((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end('{"data":{"os":"fixture"}}'); },
    async url => { const r = await run(url); assert.equal(r.code, 0); assert.equal(r.report.passed, true);
      assert.equal(r.report.failures, 0); assert.ok(r.report.attempts >= 4); });
});
test("intermittent HTTP 503 fails zero-error SLO", async () => {
  let count = 0;
  await serve((_req, res) => { count++; res.setHeader("Content-Type", "application/json");
    if (count % 2 === 0) res.statusCode = 503;
    res.end(count % 2 === 0 ? '{}' : '{"data":{"os":"fixture"}}'); },
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
