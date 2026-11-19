import assert from "node:assert/strict";
import test from "node:test";

// mcp.ts loads modules that read configuration at import; nothing connects here.
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ??= "unit-test-control-key-0123456789-0123456789";
process.env.APPROVAL_SIGNING_SECRET ??= "unit-test-approval-secret-0123456789-01234";
const { actionFromTool, fullTrustSkipsApproval, handleMcp, redactDockerLogs, MAX_DOCKER_LOG_CHARS } = await import("./mcp.js");
const { actionRisk, parseAgentAction } = await import("./protocol.js");
const { toolAnnotations } = await import("./tool-annotations.js");
const { db } = await import("./db.js");

const DEVICE = "00000000-0000-4000-8000-0000000000d1";

test("docker tools map to strictly validated agent actions", () => {
  assert.deepEqual(actionFromTool("docker_containers_list", { device_id: DEVICE }), { kind: "docker_containers_list" });
  assert.deepEqual(
    parseAgentAction(actionFromTool("docker_container_logs", { device_id: DEVICE, daemon: "u1000", container: "web", tail: 50, since: "10m" })),
    { kind: "docker_container_logs", daemon: "u1000", container: "web", tail: 50, since: "10m" },
  );
  assert.deepEqual(
    parseAgentAction(actionFromTool("docker_container_action", { device_id: DEVICE, daemon: "system", container: "a".repeat(64), action: "restart" })),
    { kind: "docker_container_action", daemon: "system", container: "a".repeat(64), action: "restart" },
  );
  const logs = (extra: Record<string, unknown>) => ({ kind: "docker_container_logs", daemon: "system", container: "web", ...extra });
  for (const container of ["", "-f", "--all", "web;reboot", "$(id)", "`id`", "a b", "a/b", "../x", "_x", "web\n", "a".repeat(129)])
    assert.throws(() => parseAgentAction(logs({ container })), container);
  for (const daemon of ["", "root", "u", "uabc", "u1;x", "system "])
    assert.throws(() => parseAgentAction(logs({ daemon })), daemon);
  for (const since of ["", "1d", "-10m", "1h;id", "$(date)", "2026-11-19 10:00", "x".repeat(41)])
    assert.throws(() => parseAgentAction(logs({ since })), since);
  for (const since of ["10m", "1h30m", "1700000000", "1700000000.5", "2026-11-19", "2026-11-19T10:00:00Z", "2026-11-19T10:00:00.123+03:00"])
    assert.doesNotThrow(() => parseAgentAction(logs({ since })), since);
  assert.throws(() => parseAgentAction(logs({ tail: 0 })));
  assert.throws(() => parseAgentAction(logs({ tail: 2001 })));
  assert.doesNotThrow(() => parseAgentAction(logs({ tail: 2000 })));
  for (const action of ["rm", "kill", "pause", "prune", ""])
    assert.throws(() => parseAgentAction({ kind: "docker_container_action", daemon: "system", container: "web", action }), action);
});

test("listing and logs are read-only; actions are high risk and never skip approval", () => {
  assert.equal(actionRisk("docker_containers_list"), "low");
  assert.equal(actionRisk("docker_container_logs"), "low");
  assert.equal(actionRisk("docker_container_action"), "high");
  assert.equal(toolAnnotations("docker_containers_list").readOnlyHint, true);
  assert.equal(toolAnnotations("docker_container_logs").readOnlyHint, true);
  assert.equal(toolAnnotations("docker_container_action").destructiveHint, true);
  // Full trust replaces approval for other high-risk tools, never for container actions.
  assert.equal(fullTrustSkipsApproval("process_exec", "full"), true);
  assert.equal(fullTrustSkipsApproval("docker_container_action", "full"), false);
  assert.equal(fullTrustSkipsApproval("docker_container_action", "standard"), false);
});

test("container logs are redacted and capped at the gateway", () => {
  const out = redactDockerLogs({
    daemon: "system", container: "web", lines: 2, truncated: false,
    text: "2026-11-19T10:00:00Z connecting with password=hunter2\n2026-11-19T10:00:01Z Authorization: Bearer abc.def",
  }) as { text: string; truncated: boolean };
  assert.ok(!out.text.includes("hunter2") && !out.text.includes("abc.def"), out.text);
  assert.match(out.text, /password=\[REDACTED\]/);
  assert.equal(out.truncated, false);
  const line = "2026-11-19T10:00:00Z " + "x".repeat(1000);
  const big = Array.from({ length: 600 }, () => line).join("\n") + "\n2026-11-19T10:00:09Z newest token=s3cret";
  const capped = redactDockerLogs({ text: big, truncated: false }) as { text: string; truncated: boolean };
  assert.ok(capped.text.length <= MAX_DOCKER_LOG_CHARS);
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.startsWith("2026-11-19T10:00:00Z x"), "starts at a whole line");
  assert.ok(capped.text.endsWith("newest token=[REDACTED]"), capped.text.slice(-60));
  // Anything else is passed through untouched.
  assert.deepEqual(redactDockerLogs({ error: "x" }), { error: "x" });
});

// handleMcp against an in-memory database: which queries ran, and whether
// anything reached the device.
function fakeDb(trust: "strict" | "standard" | "full") {
  const queries: string[] = [];
  const original = db.query;
  (db as any).query = async (sql: string) => {
    queries.push(sql);
    if (/from devices where id=\$1/.test(sql)) return { rows: [{ trust }], rowCount: 1 };
    if (/insert into approval_requests/.test(sql))
      return { rows: [{ id: "req-1", expires_at: new Date(Date.now() + 600_000) }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { queries, restore: () => { (db as any).query = original; } };
}

function fakeRouter(answer: unknown) {
  const sent: unknown[] = [];
  return { sent, router: { request: async (_device: string, action: unknown) => { sent.push(action); return answer; } } as any };
}

const principal = { organizationId: "org-1", actor: "user:1", role: "owner", global: false, authKind: "token" } as any;
const call = (name: string, args: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { device_id: DEVICE, ...args } } });
const payload = (response: any) => JSON.parse(response.result.content[0].text);

for (const trust of ["standard", "full"] as const) {
  test(`docker_container_action waits for a human approval on a ${trust} trust device`, async () => {
    const database = fakeDb(trust);
    const { sent, router } = fakeRouter({ ok: true });
    try {
      const response: any = await handleMcp(call("docker_container_action", { daemon: "system", container: "web", action: "stop" }), router, principal);
      assert.equal(response.result.isError, true);
      const body = payload(response);
      assert.equal(body.error, "approval_required");
      assert.equal(body.approval_request_id, "req-1");
      assert.deepEqual(sent, [], "nothing reaches the device before approval");
      assert.ok(database.queries.some((q) => /insert into approval_requests/.test(q)));
    } finally {
      database.restore();
    }
  });
}

test("docker tools refuse invalid ids before anything reaches the device", async () => {
  const database = fakeDb("full");
  const { sent, router } = fakeRouter({});
  try {
    for (const [name, args] of [
      ["docker_container_action", { daemon: "system", container: "web; reboot", action: "restart" }],
      ["docker_container_action", { daemon: "system", container: "web", action: "rm" }],
      ["docker_container_logs", { daemon: "../x", container: "web" }],
      ["docker_container_logs", { daemon: "system", container: "web", tail: 5000 }],
    ] as const) {
      const body = payload(await handleMcp(call(name, args), router, principal));
      assert.equal(body.error, "invalid_arguments", `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(sent, []);
  } finally {
    database.restore();
  }
});

test("docker_container_logs output is redacted on the way to the AI", async () => {
  const database = fakeDb("standard");
  const { sent, router } = fakeRouter({ daemon: "u1000", container: "web", lines: 1, truncated: false, text: "2026-11-19T10:00:00Z api_key=AKIA123" });
  try {
    const body = payload(await handleMcp(call("docker_container_logs", { daemon: "u1000", container: "web" }), router, principal));
    assert.equal(body.text, "2026-11-19T10:00:00Z api_key=[REDACTED]");
    assert.deepEqual(sent, [{ kind: "docker_container_logs", daemon: "u1000", container: "web" }]);
  } finally {
    database.restore();
  }
});
