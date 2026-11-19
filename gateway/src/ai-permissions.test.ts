// AI permissions on the MCP path (docs/AI_PERMISSIONS.md): run as root,
// full trust and the safety net, against an in-memory database and router.
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ??= "unit-test-control-key-0123456789-0123456789";
process.env.APPROVAL_SIGNING_SECRET ??= "unit-test-approval-secret-0123456789-01234";
const { applyRunAs, handleMcp, safetyNetRefusal, scheduledTaskPolicy } = await import("./mcp.js");
const { verifyApprovalClaim } = await import("./security.js");
const { db } = await import("./db.js");

const DEVICE = "00000000-0000-4000-8000-0000000000d2";
type Perms = { trust: string; run_as: string; root_capable: boolean; safety_net: boolean; safety_net_allow_power: boolean };
const perms = (over: Partial<Perms> = {}): Perms =>
  ({ trust: "standard", run_as: "user", root_capable: false, safety_net: true, safety_net_allow_power: false, ...over });

function fakeDb(row: Perms) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const original = db.query;
  (db as any).query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/from devices where id=\$1/.test(sql)) return { rows: [row], rowCount: 1 };
    if (/insert into approval_requests/.test(sql))
      return { rows: [{ id: "req-1", expires_at: new Date(Date.now() + 600_000) }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return {
    queries,
    audits: () => queries.filter((q) => /insert into audit_logs/.test(q.sql)).map((q) => ({ outcome: q.params[5], detail: String(q.params[6]) })),
    restore: () => { (db as any).query = original; },
  };
}
function fakeRouter() {
  const sent: Array<{ action: any; token: string | null | undefined }> = [];
  return { sent, router: { request: async (_d: string, action: unknown, token?: string | null) => { sent.push({ action, token }); return { ok: true }; } } as any };
}
const principal = { organizationId: "org-1", actor: "user:1", role: "owner", global: false, authKind: "token" } as any;
const call = (name: string, args: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { device_id: DEVICE, ...args } } });
const body = (response: any) => JSON.parse(response.result.content[0].text);

async function run(row: Perms, name: string, args: Record<string, unknown>) {
  const database = fakeDb(row);
  const { sent, router } = fakeRouter();
  try {
    const response: any = await handleMcp(call(name, args), router, principal);
    return { response, sent, audits: database.audits(), queries: database.queries };
  } finally {
    database.restore();
  }
}

test("run as root: refused when the agent is not root capable, never silently as user", async () => {
  const { response, sent, audits } = await run(perms({ trust: "full", run_as: "root", root_capable: false }), "process_exec", { command: "id" });
  assert.equal(response.result.isError, true);
  assert.equal(body(response).error, "run_as_root_unavailable");
  assert.deepEqual(sent, []);
  assert.ok(audits.some((a) => a.outcome === "denied" && a.detail.includes("run_as_root_unavailable")));
  assert.throws(() => applyRunAs({ kind: "process_exec", command: "id" }, { run_as: "root", root_capable: false }), /run_as_root_unavailable/);
});

test("run as root: the signed action carries runAs root, and the audit records it", async () => {
  const { response, sent, audits } = await run(perms({ trust: "full", run_as: "root", root_capable: true }), "process_exec", { command: "apt-get update" });
  assert.ok(!response.result.isError, JSON.stringify(response.result));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.action, { kind: "process_exec", command: "apt-get update", runAs: "root" });
  // The approval token the agent verifies binds runAs.
  assert.ok(verifyApprovalClaim(sent[0]!.token, DEVICE, sent[0]!.action));
  assert.equal(verifyApprovalClaim(sent[0]!.token, DEVICE, { kind: "process_exec", command: "apt-get update" }), null);
  assert.ok(audits.some((a) => a.outcome === "trusted_full" && a.detail.includes("\"runAs\":\"root\"")));
});

test("run as root: a root file write gets a signed approval even though fs_write is medium risk", async () => {
  const { sent } = await run(perms({ run_as: "root", root_capable: true }), "fs_write", { path: "/etc/app.conf", content_base64: "eA==" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.action.runAs, "root");
  assert.ok(verifyApprovalClaim(sent[0]!.token, DEVICE, sent[0]!.action));
});

test("run as user: actions carry no runAs, and read tools are never escalated", async () => {
  const user = await run(perms({ trust: "full" }), "process_exec", { command: "id" });
  assert.deepEqual(user.sent[0]!.action, { kind: "process_exec", command: "id" });
  const read = await run(perms({ run_as: "root", root_capable: true }), "fs_read", { path: "/etc/hosts" });
  assert.equal(read.sent[0]!.action.runAs, undefined);
});

test("run as root below full trust still waits for an approval of the root action", async () => {
  const { response, sent, queries } = await run(perms({ trust: "standard", run_as: "root", root_capable: true }), "process_exec", { command: "id" });
  assert.equal(body(response).error, "approval_required");
  assert.deepEqual(sent, []);
  const insert = queries.find((q) => /insert into approval_requests/.test(q.sql))!;
  assert.ok(JSON.stringify(insert.params).includes("\\\"runAs\\\":\\\"root\\\""), "the approver sees root");
});

test("safety net blocks catastrophic commands under root and full trust, and passes normal ones", async () => {
  const root = perms({ trust: "full", run_as: "root", root_capable: true });
  for (const command of ["rm -rf /", "sudo mkfs.ext4 /dev/sdb", ":(){ :|:& };:", "reboot", "systemctl stop webrising-commender"]) {
    const { response, sent, audits } = await run(root, "process_exec", { command });
    assert.equal(body(response).error, "safety_net_blocked", command);
    assert.deepEqual(sent, [], command);
    assert.ok(audits.some((a) => a.outcome === "denied" && a.detail.includes("safety_net")), command);
  }
  const task = await run(root, "task_start", { command: "dd if=/dev/zero of=/dev/nvme0n1" });
  assert.equal(body(task.response).error, "safety_net_blocked");
  const typed = await run(root, "terminal_input", { session_id: "00000000-0000-4000-8000-00000000000a", data_base64: Buffer.from("rm -rf /*\n").toString("base64") });
  assert.equal(body(typed.response).error, "safety_net_blocked");
  for (const command of ["rm -rf ./build", "df -h", "systemctl restart nginx"]) {
    const { response, sent } = await run(root, "process_exec", { command });
    assert.ok(!response.result.isError, command);
    assert.equal(sent.length, 1, command);
  }
});

test("safety net off, or power commands allowed, lets those commands through", async () => {
  const off = await run(perms({ trust: "full", safety_net: false }), "process_exec", { command: "reboot" });
  assert.ok(!off.response.result.isError);
  const power = await run(perms({ trust: "full", safety_net_allow_power: true }), "process_exec", { command: "reboot" });
  assert.ok(!power.response.result.isError);
  const stillBlocked = await run(perms({ trust: "full", safety_net_allow_power: true }), "process_exec", { command: "rm -rf /" });
  assert.equal(body(stillBlocked.response).error, "safety_net_blocked");
  assert.equal(safetyNetRefusal({ kind: "fs_read", path: "/" } as any, perms()), null);
});

test("scheduled-task policy: full trust is automatic, the safety net refuses, otherwise approval", async () => {
  for (const [row, command, expected] of [
    [perms({ trust: "full" }), "backup.sh", "auto"],
    [perms({ trust: "standard" }), "backup.sh", "approve"],
    [perms({ trust: "strict" }), "backup.sh", "approve"],
    [perms({ trust: "full", safety_net: false }), "reboot", "auto"],
  ] as const) {
    const database = fakeDb(row);
    try { assert.equal(await scheduledTaskPolicy("org-1", DEVICE, command), expected); } finally { database.restore(); }
  }
  const database = fakeDb(perms({ trust: "full" }));
  try {
    const refused = await scheduledTaskPolicy("org-1", DEVICE, "reboot");
    assert.equal(typeof refused, "object");
    assert.equal((refused as any).rule, "power");
  } finally { database.restore(); }
});
