import { consumeApprovedRequest, ensureApprovalRequest } from "./approval-requests.js";
import { consumeApproval } from "./approvals.js";
import { roleAtLeast, type Principal } from "./auth.js";
import { db } from "./db.js";
import { actionRisk, type AgentAction } from "./protocol.js";
import type { AgentHub } from "./relay.js";
import { issueApproval, redact } from "./security.js";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const tools = [
  {
    name: "devices_list",
    description: "List enrolled WebRising Commender devices and online state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  tool("system_info", "Read system information from a device.", {}),
  tool("fs_list", "List a directory inside an agent allowlisted root.", { path: str() }, ["path"]),
  tool("fs_stat", "Read file or directory metadata.", { path: str() }, ["path"]),
  tool("fs_read", "Read a file as UTF-8 text or base64 payload.", { path: str(), max_bytes: integer() }, ["path"]),
  tool(
    "fs_write",
    "Write base64-encoded bytes to a file inside an allowlisted root.",
    { path: str(), content_base64: str(), create_parents: bool() },
    ["path", "content_base64"],
  ),
  tool("fs_mkdir", "Create a directory.", { path: str(), recursive: bool() }, ["path"]),
  tool(
    "fs_delete",
    "Delete a file or directory. HIGH risk. Omit approval_token to create a human approval request, then retry after approval.",
    { path: str(), recursive: bool(), approval_token: str() },
    ["path"],
  ),
  tool(
    "process_exec",
    "Execute a shell command. HIGH risk. Omit approval_token to create a human approval request, then retry after approval.",
    { command: str(), cwd: str(), timeout_ms: integer(), approval_token: str() },
    ["command"],
  ),
  tool("process_list", "List visible processes.", {}),
  tool(
    "process_kill",
    "Terminate a process. HIGH risk. Omit approval_token to create a human approval request, then retry after approval.",
    { pid: integer(), approval_token: str() },
    ["pid"],
  ),
  tool(
    "task_start",
    "Start a persistent background command task. The task survives AI/gateway disconnects while the agent process remains alive. HIGH risk; omit approval_token to request human approval.",
    { command: str(), cwd: str(), timeout_ms: integer(), approval_token: str() },
    ["command"],
  ),
  tool(
    "task_status",
    "Read status and retained output of a persistent background task.",
    { task_id: str() },
    ["task_id"],
  ),
  tool(
    "task_cancel",
    "Cancel a persistent background task. HIGH risk; omit approval_token to request human approval.",
    { task_id: str(), approval_token: str() },
    ["task_id"],
  ),
  tool(
    "terminal_start",
    "Start a persistent PTY session. HIGH risk; omit approval_token to request human approval.",
    { shell: str(), cwd: str(), cols: integer(), rows: integer(), approval_token: str() },
    [],
  ),
  tool("terminal_input", "Write bytes to an existing PTY session.", { session_id: str(), data_base64: str() }, ["session_id", "data_base64"]),
  tool("terminal_read", "Read buffered PTY output.", { session_id: str(), max_bytes: integer() }, ["session_id"]),
  tool("terminal_resize", "Resize a PTY session.", { session_id: str(), cols: integer(), rows: integer() }, ["session_id", "cols", "rows"]),
  tool(
    "terminal_stop",
    "Stop a PTY session. HIGH risk; omit approval_token to request human approval.",
    { session_id: str(), approval_token: str() },
    ["session_id"],
  ),
].map((entry) => {
  if (entry.name === "devices_list") return entry;
  return {
    ...entry,
    inputSchema: {
      ...entry.inputSchema,
      properties: { device_id: str(), ...(entry.inputSchema as any).properties },
      required: ["device_id", ...((entry.inputSchema as any).required || [])],
    },
  };
});

function str() {
  return { type: "string" };
}
function integer() {
  return { type: "integer" };
}
function bool() {
  return { type: "boolean" };
}
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}

function actionFromTool(name: string, a: any): AgentAction {
  switch (name) {
    case "system_info": return { kind: "system_info" };
    case "fs_list": return { kind: "fs_list", path: String(a.path) };
    case "fs_stat": return { kind: "fs_stat", path: String(a.path) };
    case "fs_read": return { kind: "fs_read", path: String(a.path), ...(a.max_bytes ? { maxBytes: Number(a.max_bytes) } : {}) };
    case "fs_write": return { kind: "fs_write", path: String(a.path), contentBase64: String(a.content_base64), createParents: Boolean(a.create_parents) };
    case "fs_mkdir": return { kind: "fs_mkdir", path: String(a.path), recursive: Boolean(a.recursive) };
    case "fs_delete": return { kind: "fs_delete", path: String(a.path), recursive: Boolean(a.recursive) };
    case "process_exec": return { kind: "process_exec", command: String(a.command), ...(a.cwd ? { cwd: String(a.cwd) } : {}), ...(a.timeout_ms ? { timeoutMs: Number(a.timeout_ms) } : {}) };
    case "process_list": return { kind: "process_list" };
    case "process_kill": return { kind: "process_kill", pid: Number(a.pid) };
    case "task_start": return { kind: "task_start", command: String(a.command), ...(a.cwd ? { cwd: String(a.cwd) } : {}), ...(a.timeout_ms ? { timeoutMs: Number(a.timeout_ms) } : {}) };
    case "task_status": return { kind: "task_status", taskId: String(a.task_id) };
    case "task_cancel": return { kind: "task_cancel", taskId: String(a.task_id) };
    case "terminal_start": return { kind: "terminal_start", ...(a.shell ? { shell: String(a.shell) } : {}), ...(a.cwd ? { cwd: String(a.cwd) } : {}), ...(a.cols ? { cols: Number(a.cols) } : {}), ...(a.rows ? { rows: Number(a.rows) } : {}) };
    case "terminal_input": return { kind: "terminal_input", sessionId: String(a.session_id), dataBase64: String(a.data_base64) };
    case "terminal_read": return { kind: "terminal_read", sessionId: String(a.session_id), ...(a.max_bytes ? { maxBytes: Number(a.max_bytes) } : {}) };
    case "terminal_resize": return { kind: "terminal_resize", sessionId: String(a.session_id), cols: Number(a.cols), rows: Number(a.rows) };
    case "terminal_stop": return { kind: "terminal_stop", sessionId: String(a.session_id) };
    default: throw Object.assign(new Error("unknown-tool"), { code: "unknown_tool" });
  }
}

function ok(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function fail(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleMcp(request: JsonRpcRequest, hub: AgentHub, principal: Principal) {
  if (request.method === "initialize") {
    return ok(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "webrising-commender", version: "0.1.0" },
    });
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "ping") return ok(request.id, {});
  if (request.method === "tools/list") return ok(request.id, { tools });
  if (request.method !== "tools/call") return fail(request.id, -32601, "Method not found");

  const name = String(request.params?.name || "");
  const args = request.params?.arguments || {};
  const orgId = principal.organizationId;

  if (name === "devices_list") {
    const result = await db.query(
      "select id,name,hostname,platform,agent_version,last_seen_at,revoked_at from devices where organization_id=$1 order by created_at desc",
      [orgId],
    );
    return ok(
      request.id,
      toolResult(result.rows.map((row) => ({ ...row, online: hub.isOnline(row.id) }))),
    );
  }

  const deviceId = String(args.device_id || "");
  if (!deviceId) return ok(request.id, toolResult({ error: "device_id_required" }, true));

  const device = await db.query(
    "select 1 from devices where id=$1 and organization_id=$2 and revoked_at is null",
    [deviceId, orgId],
  );
  if (!device.rowCount) {
    return ok(request.id, toolResult({ error: "device_not_found" }, true));
  }

  let action: AgentAction;
  try {
    action = actionFromTool(name, args);
  } catch {
    return ok(request.id, toolResult({ error: "unknown_tool" }, true));
  }

  const risk = actionRisk(action.kind);
  const requiredRole = risk === "low" ? "viewer" : "operator";
  if (!roleAtLeast(principal, requiredRole)) {
    return ok(request.id, toolResult({ error: "forbidden", required_role: requiredRole }, true));
  }

  let approvalToken = typeof args.approval_token === "string" ? args.approval_token : undefined;
  if (risk === "high") {
    if (approvalToken) {
      if (!(await consumeApproval(approvalToken, deviceId, action))) {
        await audit(
          orgId,
          principal.actor,
          deviceId,
          name,
          risk,
          "denied",
          "missing_or_invalid_approval",
        );
        return ok(request.id, toolResult({ error: "approval_required", action: action.kind }, true));
      }
    } else {
      const approvedRequestId = await consumeApprovedRequest(
        orgId,
        principal.actor,
        deviceId,
        action,
      );

      if (approvedRequestId) {
        approvalToken = issueApproval(deviceId, action, 60).token;
        await audit(
          orgId,
          principal.actor,
          deviceId,
          name,
          risk,
          "approval_consumed",
          JSON.stringify({ approvalRequestId: approvedRequestId }),
        );
      } else {
        const pending = await ensureApprovalRequest(
          orgId,
          principal.actor,
          deviceId,
          action,
        );
        await audit(
          orgId,
          principal.actor,
          deviceId,
          name,
          risk,
          "approval_pending",
          JSON.stringify({ approvalRequestId: pending.id }),
        );
        return ok(
          request.id,
          toolResult(
            {
              error: "approval_required",
              action: action.kind,
              approval_request_id: pending.id,
              approval_expires_at: pending.expires_at,
              message: "An admin or owner must approve this exact operation before retrying.",
            },
            true,
          ),
        );
      }
    }
  }

  try {
    const data = await hub.request(deviceId, action, approvalToken);
    await audit(orgId, principal.actor, deviceId, name, risk, "success", redact({ kind: action.kind }));
    return ok(request.id, toolResult(data));
  } catch (error) {
    await audit(orgId, principal.actor, deviceId, name, risk, "error", redact(error instanceof Error ? error.message : error));
    return ok(request.id, toolResult({ error: error instanceof Error ? error.message : "request_failed" }, true));
  }
}

async function audit(
  orgId: string,
  actor: string,
  deviceId: string,
  toolName: string,
  risk: string,
  outcome: string,
  detail: string,
) {
  await db.query(
    "insert into audit_logs(organization_id,actor,device_id,tool,risk,outcome,detail) values($1,$2,$3,$4,$5,$6,$7)",
    [orgId, actor, deviceId, toolName, risk, outcome, detail],
  );
}
