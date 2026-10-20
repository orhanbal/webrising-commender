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

async function rpcAs(headers, id, method, params = undefined) {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`POST /mcp -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function toolText(response) {
  const text = response?.result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

const health = await jsonFetch("/health");
assert.equal(health.status, "ok");

const browserUser = await jsonFetch("/api/users", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    email: "owner@example.test",
    password: "correct-horse-battery-staple",
    role: "owner",
  }),
});
assert.equal(browserUser.item.email, "owner@example.test");
assert.equal(browserUser.item.role, "owner");

const badLoginResponse = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "owner@example.test",
    password: "wrong-password-value",
  }),
});
assert.equal(badLoginResponse.status, 401);

const browserLoginResponse = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "owner@example.test",
    password: "correct-horse-battery-staple",
  }),
});
assert.equal(browserLoginResponse.status, 200);
const browserLogin = await browserLoginResponse.json();
assert.equal(browserLogin.authKind, "session");
assert.match(browserLogin.csrfToken, /^wrcc_/);
const browserCookies = browserLoginResponse.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
assert.match(browserCookies, /commender_session=wrcs_/);

const browserMeResponse = await fetch(base + "/api/auth/me", {
  headers: { Cookie: browserCookies },
});
assert.equal(browserMeResponse.status, 200);
const browserMe = await browserMeResponse.json();
assert.equal(browserMe.email, "owner@example.test");
assert.equal(browserMe.role, "owner");
assert.equal(browserMe.authKind, "session");

const browserCsrfDenied = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: { Cookie: browserCookies, "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(browserCsrfDenied.status, 403);
assert.equal((await browserCsrfDenied.json()).error, "csrf_required");

const browserPairing = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: "{}",
});
assert.equal(browserPairing.status, 201);

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
assert.ok(listed.result.tools.some((tool) => tool.name === "fs_tree"));
assert.ok(listed.result.tools.some((tool) => tool.name === "fs_search"));
assert.ok(listed.result.tools.some((tool) => tool.name === "code_search"));
assert.ok(listed.result.tools.some((tool) => tool.name === "fs_replace"));
assert.ok(listed.result.tools.some((tool) => tool.name === "task_list"));
assert.ok(listed.result.tools.some((tool) => tool.name === "terminal_list"));

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

const operatorHeaders = {
  Authorization: `Bearer ${defaultOperator.token}`,
  "Content-Type": "application/json",
};
const humanActionArgs = {
  device_id: enrolled.deviceId,
  command: "echo human-approved",
};
const pendingForHuman = await rpcAs(operatorHeaders, 50, "tools/call", {
  name: "process_exec",
  arguments: humanActionArgs,
});
assert.equal(pendingForHuman.result.isError, true);
const pendingPayload = toolText(pendingForHuman);
assert.equal(pendingPayload.error, "approval_required");
assert.match(pendingPayload.approval_request_id, /^[0-9a-f-]{36}$/i);

const pendingList = await jsonFetch("/api/approval-requests?status=pending", {
  headers: authHeaders,
});
assert.ok(pendingList.items.some((item) => item.id === pendingPayload.approval_request_id));

const approvedRequest = await jsonFetch(
  `/api/approval-requests/${pendingPayload.approval_request_id}/approve`,
  {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  },
);
assert.equal(approvedRequest.item.status, "approved");

const humanApproved = await rpcAs(operatorHeaders, 51, "tools/call", {
  name: "process_exec",
  arguments: humanActionArgs,
});
const humanApprovedData = toolText(humanApproved);
assert.equal(humanApprovedData.success, true);
assert.equal(humanApprovedData.stdout, "approved");

const humanGrantConsumed = await rpcAs(operatorHeaders, 52, "tools/call", {
  name: "process_exec",
  arguments: humanActionArgs,
});
assert.equal(humanGrantConsumed.result.isError, true);
assert.equal(toolText(humanGrantConsumed).error, "approval_required");

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

const tenantMembership = await jsonFetch("/api/members", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    email: "owner@example.test",
    role: "owner",
    organizationId: tenantOrg.item.id,
  }),
});
assert.equal(tenantMembership.item.organization_id, tenantOrg.item.id);
assert.equal(tenantMembership.item.role, "owner");

const switchedOrganizationResponse = await fetch(base + "/api/auth/switch-organization", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({ organizationId: tenantOrg.item.id }),
});
assert.equal(switchedOrganizationResponse.status, 200);
const switchedOrganization = await switchedOrganizationResponse.json();
assert.equal(switchedOrganization.organizationId, tenantOrg.item.id);
assert.equal(switchedOrganization.role, "owner");

const switchedMeResponse = await fetch(base + "/api/auth/me", {
  headers: { Cookie: browserCookies },
});
assert.equal(switchedMeResponse.status, 200);
const switchedMe = await switchedMeResponse.json();
assert.equal(switchedMe.organizationId, tenantOrg.item.id);
assert.equal(switchedMe.role, "owner");

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

const forbiddenOwnerMembershipChange = await fetch(base + "/api/members", {
  method: "POST",
  headers: tenantAdminHeaders,
  body: JSON.stringify({
    email: "owner@example.test",
    role: "operator",
  }),
});
assert.equal(forbiddenOwnerMembershipChange.status, 403);
assert.equal((await forbiddenOwnerMembershipChange.json()).error, "cannot_manage_higher_role");

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

const browserLogoutResponse = await fetch(base + "/api/auth/logout", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: "{}",
});
assert.equal(browserLogoutResponse.status, 200);
const revokedBrowserSession = await fetch(base + "/api/auth/me", {
  headers: { Cookie: browserCookies },
});
assert.equal(revokedBrowserSession.status, 401);

socket.close();
console.log("integration: ok");
