#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";

const baseUrl = process.env.COMMANDER_BASE_URL || process.argv[2];
const apiKey = process.env.CONTROL_API_KEY || process.env.COMMANDER_CONTROL_API_KEY || "";

if (!baseUrl) {
  console.error("Usage: COMMANDER_BASE_URL=https://commender.example.com CONTROL_API_KEY=... node scripts/accept-production.mjs");
  process.exit(2);
}

const base = new URL(baseUrl);
if (!["http:", "https:"].includes(base.protocol)) {
  throw new Error("COMMANDER_BASE_URL must use http:// or https://");
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  process.stdout.write(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    redirect: "manual",
    ...options,
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}`);
  }
  return { response, body, text };
}

async function checkHealth() {
  const { response, body } = await fetchJson("/health");
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  record("HTTPS health", true, `HTTP ${response.status}`);
  if (base.protocol === "https:") {
    const hsts = response.headers.get("strict-transport-security") || "";
    assert.match(hsts, /max-age=\d+/i);
    record("HSTS", true, hsts);
  } else {
    record("HSTS", true, "skipped because base URL is HTTP");
  }
}

async function checkConsole() {
  const response = await fetch(new URL("/", base), { redirect: "manual" });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /WebRising Commender/i);
  record("Web console", true, "console HTML served");
}

async function checkPublicConfig() {
  const { response, body } = await fetchJson("/api/public/config");
  assert.equal(response.status, 200);
  assert.equal(typeof body.deploymentMode, "string");
  assert.equal(typeof body.signupEnabled, "boolean");
  assert.equal(typeof body.passwordResetEnabled, "boolean");
  record(
    "Public config",
    true,
    `mode=${body.deploymentMode}, signup=${body.signupEnabled}, reset=${body.passwordResetEnabled}`,
  );
}

async function checkMcp() {
  if (!apiKey) {
    record("MCP initialize/ping", false, "CONTROL_API_KEY is required");
    return;
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const initialize = await fetchJson("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "commender-production-acceptance", version: "1" },
      },
    }),
  });
  assert.equal(initialize.response.status, 200);
  assert.equal(initialize.body.jsonrpc, "2.0");
  assert.equal(initialize.body.id, 1);
  assert.ok(initialize.body.result);

  const ping = await fetchJson("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  assert.equal(ping.response.status, 200);
  assert.equal(ping.body.jsonrpc, "2.0");
  assert.equal(ping.body.id, 2);
  assert.ok(ping.body.result);
  record("MCP initialize/ping", true, "authenticated MCP responded");
}

async function checkUnauthenticatedWsUpgrade() {
  const wsProtocol = base.protocol === "https:" ? "https:" : "http:";
  const transport = wsProtocol === "https:" ? https : http;
  const port = base.port ? Number(base.port) : wsProtocol === "https:" ? 443 : 80;
  const options = {
    protocol: wsProtocol,
    hostname: base.hostname,
    port,
    path: "/agent",
    method: "GET",
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": Buffer.from("commender-acceptance").toString("base64"),
      "Sec-WebSocket-Version": "13",
      Host: base.host,
    },
    timeout: 10_000,
  };

  const status = await new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      resolve(res.statusCode || 0);
      res.resume();
    });
    req.on("upgrade", () => reject(new Error("unauthenticated WSS unexpectedly upgraded")));
    req.on("timeout", () => req.destroy(new Error("WSS upgrade timeout")));
    req.on("error", reject);
    req.end();
  });

  assert.equal(status, 401);
  record("Unauthenticated WSS rejection", true, "HTTP 401");
}

try {
  await checkHealth();
  await checkConsole();
  await checkPublicConfig();
  await checkMcp();
  await checkUnauthenticatedWsUpgrade();

  const failed = results.filter((item) => !item.ok);
  if (failed.length) process.exitCode = 1;
  else process.stdout.write("\nproduction acceptance: PASS\n");
} catch (error) {
  record("Acceptance run", false, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
