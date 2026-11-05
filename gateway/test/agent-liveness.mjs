// Agent liveness: the gateway pings agents and closes connections that stay
// silent past the stale window, so a dead path (e.g. behind a proxy that keeps
// the gateway side open) shows the device offline instead of "online" with
// timing-out calls. Starts its own gateway on a spare port with short timings.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 8797;
const base = `http://127.0.0.1:${port}`;
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gateway = spawn(process.execPath, [path.join(here, "../dist/index.js")], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PUBLIC_BASE_URL: base, AGENT_PING_INTERVAL_MS: "1000", AGENT_STALE_MS: "3000" },
  stdio: ["ignore", "ignore", "inherit"],
});
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + "/health/live")).ok) break; } catch {} await sleep(250); }
  await db.connect();
  const suffix = crypto.randomBytes(4).toString("hex");
  const org = (await db.query("insert into organizations(name) values($1) returning id", ["liveness " + suffix])).rows[0].id;
  const apiToken = "wrc_" + crypto.randomBytes(30).toString("base64url");
  await db.query("insert into api_tokens(organization_id,name,role,token_hash,created_by) values($1,'liveness','owner',$2,'test')", [org, sha256(apiToken)]);
  const device = async (name) => {
    const id = crypto.randomUUID(); const token = crypto.randomBytes(32).toString("base64url");
    await db.query("insert into devices(id,organization_id,name,token_hash) values($1,$2,$3,$4)", [id, org, name, sha256(token)]);
    return { id, token };
  };
  const connect = async ({ id, token }, autoPong) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/agent", { headers: { "x-device-id": id, Authorization: `Bearer ${token}` }, autoPong });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "hello", deviceId: id, hostname: "liveness", os: "linux", version: "ci", capabilities: ["system"] }));
    return ws;
  };
  const online = async (id) => (await (await fetch(base + "/api/devices", { headers: { authorization: "Bearer " + apiToken } })).json()).items.find((d) => d.id === id)?.online;

  const healthy = await device("healthy"); const silent = await device("silent");
  const healthySocket = await connect(healthy, true);
  const silentSocket = await connect(silent, false);
  let silentClosed = false; silentSocket.on("close", () => { silentClosed = true; });
  let pings = 0; silentSocket.on("ping", () => { pings++; });
  await sleep(500);
  assert.equal(await online(healthy.id), true);
  assert.equal(await online(silent.id), true);
  await sleep(5000);
  assert.ok(pings >= 2, "gateway pings agents");
  assert.equal(silentClosed, true, "a silent agent connection is closed after the stale window");
  assert.equal(await online(silent.id), false, "a silent agent shows offline");
  assert.equal(await online(healthy.id), true, "an agent that answers pings stays online");
  healthySocket.close();
  console.log("agent liveness acceptance passed");
} finally {
  await db.end().catch(() => {});
  gateway.kill();
}
