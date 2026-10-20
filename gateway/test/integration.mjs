import assert from "node:assert/strict";
import WebSocket from "ws";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const apiKey = process.env.CONTROL_API_KEY;
if (!apiKey) throw new Error("CONTROL_API_KEY is required");

const authHeaders = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

async function jsonFetch(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function rpc(id, method, params = undefined) {
  return jsonFetch("/mcp", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
}

function toolText(response) {
  const text = response?.result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

const health = await jsonFetch("/health");
assert.equal(health.status, "ok");

const pairing = await jsonFetch("/api/pairing", {
  method: "POST",
  headers: authHeaders,
  body: "{}",
});
assert.equal(typeof pairing.pairingCode, "string");

const enrolled = await jsonFetch("/api/agent/enroll", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pairingCode: pairing.pairingCode,
    name: "CI mock device",
    hostname: "ci-host",
    platform: "linux",
  }),
});
assert.match(enrolled.deviceId, /^[0-9a-f-]{36}$/i);
assert.equal(typeof enrolled.deviceToken, "string");

const wsUrl = base.replace(/^http/, "ws") + "/agent";
const socket = new WebSocket(wsUrl, {
  headers: {
    "x-device-id": enrolled.deviceId,
    Authorization: `Bearer ${enrolled.deviceToken}`,
  },
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("websocket open timeout")), 5000);
  socket.once("open", () => {
    clearTimeout(timer);
    resolve();
  });
  socket.once("error", reject);
});

socket.send(JSON.stringify({
  type: "hello",
  deviceId: enrolled.deviceId,
  hostname: "ci-host",
  os: "linux",
  version: "ci",
  capabilities: ["system", "process"],
}));

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type !== "request") return;

  if (message.action.kind === "system_info") {
    socket.send(JSON.stringify({
      type: "result",
      requestId: message.requestId,
      ok: true,
      data: { hostname: "ci-host", os: "linux", mock: true },
    }));
    return;
  }

  if (message.action.kind === "process_exec") {
    socket.send(JSON.stringify({
      type: "result",
      requestId: message.requestId,
      ok: true,
      data: { exitCode: 0, success: true, stdout: "approved", stderr: "" },
    }));
    return;
  }

  socket.send(JSON.stringify({
    type: "result",
    requestId: message.requestId,
    ok: false,
    error: { code: "unsupported_test_action", message: message.action.kind },
  }));
});

await new Promise((resolve) => setTimeout(resolve, 100));

const devices = await jsonFetch("/api/devices", { headers: authHeaders });
const device = devices.items.find((item) => item.id === enrolled.deviceId);
assert.ok(device);
assert.equal(device.online, true);

const initialized = await rpc(1, "initialize", {});
assert.equal(initialized.result.serverInfo.name, "webrising-commender");

const listed = await rpc(2, "tools/list", {});
assert.ok(listed.result.tools.some((tool) => tool.name === "system_info"));
assert.ok(listed.result.tools.some((tool) => tool.name === "process_exec"));

const info = await rpc(3, "tools/call", {
  name: "system_info",
  arguments: { device_id: enrolled.deviceId },
});
assert.deepEqual(toolText(info), { hostname: "ci-host", os: "linux", mock: true });

const denied = await rpc(4, "tools/call", {
  name: "process_exec",
  arguments: { device_id: enrolled.deviceId, command: "echo denied" },
});
assert.equal(denied.result.isError, true);
assert.equal(toolText(denied).error, "approval_required");

const approvedAction = {
  kind: "process_exec",
  command: "echo approved",
};

const defaultOperator = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Default Operator",
    role: "operator",
  }),
});
const operatorApprovalResponse = await fetch(base + "/api/approvals", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${defaultOperator.token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    deviceId: enrolled.deviceId,
    action: approvedAction,
    ttlSeconds: 60,
  }),
});
assert.equal(operatorApprovalResponse.status, 403);

const tamperApproval = await jsonFetch("/api/approvals", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    deviceId: enrolled.deviceId,
    action: approvedAction,
    ttlSeconds: 60,
  }),
});
assert.equal(typeof tamperApproval.approvalToken, "string");

const tampered = await rpc(5, "tools/call", {
  name: "process_exec",
  arguments: {
    device_id: enrolled.deviceId,
    command: "echo tampered",
    approval_token: tamperApproval.approvalToken,
  },
});
assert.equal(tampered.result.isError, true);
assert.equal(toolText(tampered).error, "approval_required");

const approval = await jsonFetch("/api/approvals", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    deviceId: enrolled.deviceId,
    action: approvedAction,
    ttlSeconds: 60,
  }),
});
assert.equal(typeof approval.approvalToken, "string");

const approved = await rpc(6, "tools/call", {
  name: "process_exec",
  arguments: {
    device_id: enrolled.deviceId,
    command: "echo approved",
    approval_token: approval.approvalToken,
  },
});
const approvedData = toolText(approved);
assert.equal(approvedData.success, true);
assert.equal(approvedData.stdout, "approved");

const replayed = await rpc(7, "tools/call", {
  name: "process_exec",
  arguments: {
    device_id: enrolled.deviceId,
    command: "echo approved",
    approval_token: approval.approvalToken,
  },
});
assert.equal(replayed.result.isError, true);
assert.equal(toolText(replayed).error, "approval_required");

const audit = await jsonFetch("/api/audit?limit=20", { headers: authHeaders });
assert.ok(audit.items.some((item) => item.tool === "process_exec" && item.outcome === "denied"));
assert.ok(audit.items.some((item) => item.tool === "process_exec" && item.outcome === "success"));

const tenantOrg = await jsonFetch("/api/organizations", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "CI Tenant" }),
});
assert.match(tenantOrg.item.id, /^[0-9a-f-]{36}$/i);

const tenantToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Tenant Operator",
    role: "operator",
    organizationId: tenantOrg.item.id,
  }),
});
assert.match(tenantToken.token, /^wrc_/);

const tenantHeaders = {
  Authorization: `Bearer ${tenantToken.token}`,
  "Content-Type": "application/json",
};
const tenantMeResponse = await fetch(base + "/api/auth/me", { headers: tenantHeaders });
assert.equal(tenantMeResponse.status, 200);
const tenantMe = await tenantMeResponse.json();
assert.equal(tenantMe.organizationId, tenantOrg.item.id);
assert.equal(tenantMe.role, "operator");
assert.equal(tenantMe.global, false);

const tenantDevicesResponse = await fetch(base + "/api/devices", { headers: tenantHeaders });
assert.equal(tenantDevicesResponse.status, 200);
const tenantDevices = await tenantDevicesResponse.json();
assert.deepEqual(tenantDevices.items, []);

const tenantPairingResponse = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: tenantHeaders,
  body: "{}",
});
assert.equal(tenantPairingResponse.status, 201);

const viewerToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Tenant Viewer",
    role: "viewer",
    organizationId: tenantOrg.item.id,
  }),
});
const viewerPairingResponse = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${viewerToken.token}`,
    "Content-Type": "application/json",
  },
  body: "{}",
});
assert.equal(viewerPairingResponse.status, 403);

const tenantAdminToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Tenant Admin",
    role: "admin",
    organizationId: tenantOrg.item.id,
  }),
});
const tenantAdminHeaders = {
  Authorization: `Bearer ${tenantAdminToken.token}`,
  "Content-Type": "application/json",
};

const forbiddenOwnerGrant = await fetch(base + "/api/tokens", {
  method: "POST",
  headers: tenantAdminHeaders,
  body: JSON.stringify({
    name: "Forbidden Owner",
    role: "owner",
  }),
});
assert.equal(forbiddenOwnerGrant.status, 403);

const allowedOperatorGrant = await fetch(base + "/api/tokens", {
  method: "POST",
  headers: tenantAdminHeaders,
  body: JSON.stringify({
    name: "Allowed Operator",
    role: "operator",
  }),
});
assert.equal(allowedOperatorGrant.status, 201);

const tenantOwnerToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Tenant Owner",
    role: "owner",
    organizationId: tenantOrg.item.id,
  }),
});

const forbiddenOwnerRevoke = await fetch(
  base + `/api/tokens/${tenantOwnerToken.item.id}/revoke`,
  {
    method: "POST",
    headers: tenantAdminHeaders,
    body: "{}",
  },
);
assert.equal(forbiddenOwnerRevoke.status, 403);

socket.close();
console.log("integration: ok");
