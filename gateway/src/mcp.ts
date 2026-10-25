import { consumeApprovedRequest, ensureApprovalRequest } from "./approval-requests.js";
import { consumeApproval } from "./approvals.js";
import { roleAtLeast, type Principal } from "./auth.js";
import { db } from "./db.js";
import { actionRisk, type AgentAction } from "./protocol.js";
import type { DeviceRouter } from "./device-router.js";
import { issueApproval, redact } from "./security.js";
import { startSearch, searchPage, listSearches, stopSearch, controlSearch } from "./search-sessions.js";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const tools = [
  {
    name: "devices_list",
    description: "List enrolled WebRising Commender devices and online state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  tool("system_info", "Read system information from a device.", {}),
  tool("policy_info", "Read agent-enforced allowed directories and resource limits. Read-only.", {}),
  tool("get_recent_tool_calls", "Read paginated sanitized recent tool history for your actor and selected device.", { limit: integer(), offset: integer() }),
  tool("get_usage_stats", "Count this actor's tool executions by name over the past 30 days, scoped to the selected device.", {}),
  tool("fs_list", "List a directory inside an agent allowlisted root.", { path: str() }, ["path"]),
  tool("fs_stat", "Read file or directory metadata.", { path: str() }, ["path"]),
  tool("fs_read", "Read a file as UTF-8 text or base64 payload.", { path: str(), max_bytes: integer() }, ["path"]),
  tool(
    "fs_read_lines",
    "Read a page of UTF-8 lines. offset_lines is zero-based; negative offsets count back from end of file. Maximum 1000 lines and 256 KiB of output.",
    { path: str(), offset_lines: integer(), limit_lines: integer() },
    ["path"],
  ),
  tool("image_inspect", "Read PNG/JPEG/GIF or extended WebP dimensions and file metadata from headers only. Does not decode pixels or generate a preview. 32 MiB file limit; 256 KiB header scan.", { path: str() }, ["path"]),
  tool("docx_inspect", "Inspect DOCX paragraph/table counts without loading external resources or executing macros. Read-only, 16 MiB ZIP and 8 MiB document XML limits.", { path: str() }, ["path"]),
  tool("docx_read_paragraphs", "Read up to 100 DOCX paragraphs as structured, bounded text. Offset is zero-based; content in tables is included.", { path: str(), offset: integer(), limit: integer() }, ["path"]),
  tool("docx_read_table", "Read up to 50 rows of a DOCX table, max 20 cells per row; table_index and offset_rows are zero-based.", { path: str(), table_index: integer(), offset_rows: integer(), limit_rows: integer() }, ["path", "table_index"]),
  tool("xlsx_inspect", "List worksheets in an XLSX/XLSM workbook without running macros. Read-only; compressed limit 16 MiB, expanded ZIP limit 64 MiB.", { path: str() }, ["path"]),
  tool("xlsx_read_range", "Read up to 50 rows by 20 columns from one worksheet, using 1-based coordinates. Does not evaluate formulas or execute macros.",
    { path: str(), sheet: str(), start_row: integer(), start_column: integer(), row_count: integer(), column_count: integer() },
    ["path", "sheet", "start_row", "start_column", "row_count", "column_count"]),
  tool("xlsx_find", "Search cached cell values in XLSX/XLSM, without evaluating formulas. Bounded to 50,000 cells, 30 sheets, and 100 matches.",
    { path: str(), sheet: str(), query: str(), case_sensitive: bool(), max_results: integer() }, ["path", "query"]),
  tool("xlsx_write_cells", "Write up to 100 string/number/boolean cells to a NEW XLSX output file without overwriting the original. Existing XLSM files cannot be edited. Optional SHA-256 precondition prevents stale writes.",
    { path: str(), output_path: str(), sheet: str(), updates: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: { cell: str(), value: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } }, required: ["cell", "value"], additionalProperties: false } }, expected_sha256: str() },
    ["path", "output_path", "sheet", "updates"]),
  tool(
    "fs_read_multiple",
    "Read up to ten files in one call, retaining per-file errors. Each file is limited to 64 KiB.",
    { paths: { type: "array", items: { type: "string", minLength: 1, maxLength: 4096 }, minItems: 1, maxItems: 10 }, max_bytes: { type: "integer", minimum: 1, maximum: 65536 } },
    ["paths"],
  ),
  tool(
    "fs_write",
    "Write base64-encoded bytes to an allowlisted file. Optional expected_sha256 rejects stale content; with_undo snapshots an existing regular file (max 4 MiB) for guarded restoration.",
    { path: str(), content_base64: str(), create_parents: bool(), expected_sha256: str(), with_undo: bool() },
    ["path", "content_base64"],
  ),
  tool("fs_append", "Append base64-encoded bytes to an allowlisted file. Optional expected_sha256 guards stale appends; with_undo atomically appends to an existing regular file (max 4 MiB) and creates a guarded snapshot.", { path: str(), content_base64: str(), expected_sha256: str(), with_undo: bool() }, ["path", "content_base64"]),
  tool("fs_mkdir", "Create a directory.", { path: str(), recursive: bool() }, ["path"]),
  tool(
    "fs_delete",
    "Delete a file or directory. HIGH risk. Omit approval_token to create a human approval request, then retry after approval.",
    { path: str(), recursive: bool(), approval_token: str() },
    ["path"],
  ),
  tool(
    "fs_move",
    "Move or rename a file/directory inside the agent allowlisted roots. Destination must not already exist.",
    { source: str(), destination: str() },
    ["source", "destination"],
  ),
  tool(
    "fs_tree",
    "Recursively list a bounded directory tree without following symlinks.",
    { path: str(), max_depth: integer(), max_entries: integer() },
    ["path"],
  ),
  tool(
    "fs_search",
    "Search file and directory names recursively inside an allowlisted root.",
    { path: str(), query: str(), case_sensitive: bool(), max_results: integer() },
    ["path", "query"],
  ),
  tool(
    "text_search",
    "Search literal text recursively in bounded UTF-8 files inside an allowlisted root.",
    { path: str(), query: str(), case_sensitive: bool(), max_results: integer() },
    ["path", "query"],
  ),
  tool(
    "code_search",
    "Search literal code/text recursively in bounded UTF-8 files. Alias of text_search for coding clients.",
    { path: str(), query: str(), case_sensitive: bool(), max_results: integer() },
    ["path", "query"],
  ),
  tool(
    "start_search",
    "Start a bounded, asynchronous file-name or content search. Follow with get_more_search_results when completed; maximum 500 matches.",
    { path: str(), query: str(), search_type: { type: "string", enum: ["files", "content"] }, case_sensitive: bool(), start_paused: bool() },
    ["path", "query", "search_type"],
  ),
  tool(
    "get_more_search_results",
    "Read a paged snapshot of a search by id; result is pending until the native search completes.",
    { search_id: str(), offset: integer(), length: integer() },
    ["search_id"],
  ),
  tool("list_searches", "List active/completed recent search sessions for this actor and device.", {}),
  tool("stop_search", "Discard a search session's results and suppress further updates.", { search_id: str() }, ["search_id"]),
  tool("pause_search", "Cooperatively pause a running native search for at most 15 seconds; its concurrency slot remains occupied.", { search_id: str() }, ["search_id"]),
  tool("resume_search", "Resume an owned, still-running paused native search.", { search_id: str() }, ["search_id"]),
  tool(
    "fs_replace",
    "Perform a guarded UTF-8 search/replace edit. By default the search must match exactly once.",
    { path: str(), search: str(), replace: str(), replace_all: bool(), expected_sha256: str() },
    ["path", "search", "replace"],
  ),
  tool("fs_versions", "List at most eight persistent undo snapshots for an allowlisted file.", { path: str() }, ["path"]),
  tool("fs_undo", "Restore a prior fs_replace snapshot only when the current SHA-256 matches. Consumes the snapshot on success.", { path: str(), undo_id: str(), expected_sha256: str() }, ["path", "undo_id", "expected_sha256"]),
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
    "task_list",
    "List retained persistent background tasks so a reconnected AI client can recover task ids.",
    {},
  ),
  tool(
    "terminal_start",
    "Start a persistent PTY session. HIGH risk; omit approval_token to request human approval.",
    { shell: str(), cwd: str(), cols: integer(), rows: integer(), approval_token: str() },
    [],
  ),
  tool("terminal_input", "Write bytes to an existing PTY session.", { session_id: str(), data_base64: str() }, ["session_id", "data_base64"]),
  tool("terminal_read", "Read buffered PTY output.", { session_id: str(), max_bytes: integer() }, ["session_id"]),
  tool(
    "terminal_read_page",
    "Read non-consuming retained PTY history independently of terminal_read. Positive offset_bytes is an absolute output byte cursor; negative reads from the end. Results report retainedStartBytes and truncatedBeforeOffset when the 1 MiB history cap evicts data.",
    { session_id: str(), offset_bytes: integer(), max_bytes: integer() },
    ["session_id"],
  ),
  tool("terminal_resize", "Resize a PTY session.", { session_id: str(), cols: integer(), rows: integer() }, ["session_id", "cols", "rows"]),
  tool(
    "terminal_stop",
    "Stop a PTY session. HIGH risk; omit approval_token to request human approval.",
    { session_id: str(), approval_token: str() },
    ["session_id"],
  ),
  tool(
    "terminal_list",
    "List persistent PTY sessions, process ids and retained output sizes.",
    {},
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
    ...(process.env.MCP_OAUTH_ENABLED === "true" ? { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] } : {}),
  };
}

function actionFromTool(name: string, a: any): AgentAction {
  switch (name) {
    case "system_info": return { kind: "system_info" };
    case "policy_info": return { kind: "policy_info" };
    case "fs_list": return { kind: "fs_list", path: String(a.path) };
    case "fs_stat": return { kind: "fs_stat", path: String(a.path) };
    case "fs_read": return { kind: "fs_read", path: String(a.path), ...(a.max_bytes ? { maxBytes: Number(a.max_bytes) } : {}) };
    case "fs_read_lines": return { kind: "fs_read_lines", path: String(a.path), ...(a.offset_lines !== undefined ? { offsetLines: Number(a.offset_lines) } : {}), ...(a.limit_lines !== undefined ? { limitLines: Number(a.limit_lines) } : {}) };
    case "image_inspect": return { kind: "image_inspect", path: String(a.path) };
    case "docx_inspect": return { kind: "docx_inspect", path: String(a.path) };
    case "docx_read_paragraphs": return { kind: "docx_read_paragraphs", path: String(a.path), ...(a.offset !== undefined ? { offset: Number(a.offset) } : {}), ...(a.limit !== undefined ? { limit: Number(a.limit) } : {}) };
    case "docx_read_table": return { kind: "docx_read_table", path: String(a.path), tableIndex: Number(a.table_index), ...(a.offset_rows !== undefined ? { offsetRows: Number(a.offset_rows) } : {}), ...(a.limit_rows !== undefined ? { limitRows: Number(a.limit_rows) } : {}) };
    case "xlsx_inspect": return { kind: "xlsx_inspect", path: String(a.path) };
    case "xlsx_read_range": return { kind: "xlsx_read_range", path: String(a.path), sheet: String(a.sheet), startRow: Number(a.start_row), startColumn: Number(a.start_column), rowCount: Number(a.row_count), columnCount: Number(a.column_count) };
    case "xlsx_write_cells": return { kind: "xlsx_write_cells", path: String(a.path), outputPath: String(a.output_path), sheet: String(a.sheet), updates: a.updates, ...(a.expected_sha256 ? { expectedSha256: String(a.expected_sha256) } : {}) };
    case "xlsx_find": return { kind: "xlsx_find", path: String(a.path), query: String(a.query), ...(a.sheet ? { sheet: String(a.sheet) } : {}), ...(a.case_sensitive !== undefined ? { caseSensitive: Boolean(a.case_sensitive) } : {}), ...(a.max_results !== undefined ? { maxResults: Number(a.max_results) } : {}) };
    case "fs_write": return { kind: "fs_write", path: String(a.path), contentBase64: String(a.content_base64), createParents: Boolean(a.create_parents), ...(a.expected_sha256 !== undefined ? { expectedSha256: String(a.expected_sha256) } : {}), ...(a.with_undo !== undefined ? { withUndo: Boolean(a.with_undo) } : {}) };
    case "fs_append": return { kind: "fs_append", path: String(a.path), contentBase64: String(a.content_base64), ...(a.expected_sha256 !== undefined ? { expectedSha256: String(a.expected_sha256) } : {}), ...(a.with_undo !== undefined ? { withUndo: Boolean(a.with_undo) } : {}) };
    case "fs_mkdir": return { kind: "fs_mkdir", path: String(a.path), recursive: Boolean(a.recursive) };
    case "fs_delete": return { kind: "fs_delete", path: String(a.path), recursive: Boolean(a.recursive) };
    case "fs_move": return { kind: "fs_move", source: String(a.source), destination: String(a.destination) };
    case "fs_tree": return { kind: "fs_tree", path: String(a.path), ...(a.max_depth !== undefined ? { maxDepth: Number(a.max_depth) } : {}), ...(a.max_entries !== undefined ? { maxEntries: Number(a.max_entries) } : {}) };
    case "fs_search": return { kind: "fs_search", path: String(a.path), query: String(a.query), ...(a.case_sensitive !== undefined ? { caseSensitive: Boolean(a.case_sensitive) } : {}), ...(a.max_results !== undefined ? { maxResults: Number(a.max_results) } : {}) };
    case "text_search":
    case "code_search": return { kind: "text_search", path: String(a.path), query: String(a.query), ...(a.case_sensitive !== undefined ? { caseSensitive: Boolean(a.case_sensitive) } : {}), ...(a.max_results !== undefined ? { maxResults: Number(a.max_results) } : {}) };
    case "fs_replace": return { kind: "fs_replace", path: String(a.path), search: String(a.search), replace: String(a.replace), ...(a.replace_all !== undefined ? { replaceAll: Boolean(a.replace_all) } : {}), ...(a.expected_sha256 !== undefined ? { expectedSha256: String(a.expected_sha256) } : {}) };
    case "fs_versions": return { kind: "fs_versions", path: String(a.path) };
    case "fs_undo": return { kind: "fs_undo", path: String(a.path), undoId: String(a.undo_id), expectedSha256: String(a.expected_sha256) };
    case "process_exec": return { kind: "process_exec", command: String(a.command), ...(a.cwd ? { cwd: String(a.cwd) } : {}), ...(a.timeout_ms ? { timeoutMs: Number(a.timeout_ms) } : {}) };
    case "process_list": return { kind: "process_list" };
    case "process_kill": return { kind: "process_kill", pid: Number(a.pid) };
    case "task_start": return { kind: "task_start", command: String(a.command), ...(a.cwd ? { cwd: String(a.cwd) } : {}), ...(a.timeout_ms ? { timeoutMs: Number(a.timeout_ms) } : {}) };
    case "task_status": return { kind: "task_status", taskId: String(a.task_id) };
    case "task_cancel": return { kind: "task_cancel", taskId: String(a.task_id) };
    case "task_list": return { kind: "task_list" };
    case "terminal_start": return { kind: "terminal_start", ...(a.shell ? { shell: String(a.shell) } : {}), ...(a.cwd ? { cwd: String(a.cwd) } : {}), ...(a.cols ? { cols: Number(a.cols) } : {}), ...(a.rows ? { rows: Number(a.rows) } : {}) };
    case "terminal_input": return { kind: "terminal_input", sessionId: String(a.session_id), dataBase64: String(a.data_base64) };
    case "terminal_read": return { kind: "terminal_read", sessionId: String(a.session_id), ...(a.max_bytes ? { maxBytes: Number(a.max_bytes) } : {}) };
    case "terminal_read_page": return { kind: "terminal_read_page", sessionId: String(a.session_id), ...(a.offset_bytes !== undefined ? { offsetBytes: Number(a.offset_bytes) } : {}), ...(a.max_bytes !== undefined ? { maxBytes: Number(a.max_bytes) } : {}) };
    case "terminal_resize": return { kind: "terminal_resize", sessionId: String(a.session_id), cols: Number(a.cols), rows: Number(a.rows) };
    case "terminal_stop": return { kind: "terminal_stop", sessionId: String(a.session_id) };
    case "terminal_list": return { kind: "terminal_list" };
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

export async function handleMcp(request: JsonRpcRequest, router: DeviceRouter, principal: Principal) {
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
  // Reject unknown MCP tools before attempting device/tenant database access.
  // This also avoids reporting a misleading missing-device error for typos.
  if (!tools.some((entry) => entry.name === name)) {
    return ok(request.id, toolResult({ error: "unknown_tool" }, true));
  }
  const orgId = principal.organizationId;

  if (name === "devices_list") {
    const result = await db.query(
      "select id,name,hostname,platform,agent_version,last_seen_at,revoked_at from devices where organization_id=$1 order by created_at desc",
      [orgId],
    );
    const online = await router.onlineStatuses(result.rows.map((row) => row.id));
    return ok(
      request.id,
      toolResult(result.rows.map((row) => ({ ...row, online: online.has(row.id) }))),
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

  if (name === "get_recent_tool_calls" || name === "get_usage_stats") {
    if (!roleAtLeast(principal, "viewer")) {
      return ok(request.id, toolResult({ error: "forbidden" }, true));
    }
    const limit = args.limit === undefined ? 25 : args.limit;
    const offset = args.offset === undefined ? 0 : args.offset;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0 || offset > 10000) {
      return ok(request.id, toolResult({ error: "invalid_history_page" }, true));
    }
    if (name === "get_usage_stats") {
      const result = await db.query(
        `select tool, count(*)::integer as calls,
                count(*) filter (where outcome = 'error')::integer as errors
           from audit_logs
          where organization_id=$1 and device_id=$2 and actor=$3
            and created_at > now() - interval '30 days'
          group by tool order by calls desc,tool asc limit 100`,
        [orgId, deviceId, principal.actor],
      );
      return ok(request.id, toolResult({ periodDays: 30, tools: result.rows }));
    }
    const result = await db.query(
      `select id,tool,risk,outcome,created_at
         from audit_logs
        where organization_id=$1 and device_id=$2 and actor=$3
        order by id desc limit $4 offset $5`,
      [orgId, deviceId, principal.actor, limit, offset],
    );
    return ok(request.id, toolResult({ items: result.rows, limit, offset,
      hasMore: result.rows.length === limit }));
  }

  // A single native operation enforces the allowlist and per-file bounds.
  // Keep the batch's partial failures independent, with redacted error codes.
  if (name === "fs_read_multiple") {
    if (!roleAtLeast(principal, "viewer")) {
      return ok(request.id, toolResult({ error: "forbidden", required_role: "viewer" }, true));
    }
    const paths: unknown = args.paths;
    const maxBytes = args.max_bytes === undefined ? 64 * 1024 : args.max_bytes;
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 10 ||
        paths.some((path) => typeof path !== "string" || path.length < 1 || path.length > 4096) ||
        typeof maxBytes !== "number" || !Number.isInteger(maxBytes) ||
        maxBytes < 1 || maxBytes > 64 * 1024) {
      return ok(request.id, toolResult({ error: "invalid_batch_read_arguments" }, true));
    }
    try {
      const data = await router.request(deviceId, {
        kind: "fs_read_multiple", paths: paths as string[], maxBytes,
      });
      const result = data as { items: Array<{ ok: boolean }>; count: number };
      await audit(orgId, principal.actor, deviceId, name, "low", "completed",
        JSON.stringify({ count: result.count, failed: result.items.filter((item) => !item.ok).length }));
      return ok(request.id, toolResult(data));
    } catch {
      await audit(orgId, principal.actor, deviceId, name, "low", "error", "batch_read_failed");
      return ok(request.id, toolResult({ error: "batch_read_failed" }, true));
    }
  }

  if (["start_search", "get_more_search_results", "list_searches", "stop_search",
       "pause_search", "resume_search"].includes(name)) {
    if (!roleAtLeast(principal, "viewer")) {
      return ok(request.id, toolResult({ error: "forbidden" }, true));
    }
    try {
      let data: unknown;
      if (name === "start_search") {
        data = await startSearch(principal, deviceId, router, args);
      } else if (name === "get_more_search_results") {
        data = await searchPage(principal, deviceId, String(args.search_id || ""),
          args.offset === undefined ? 0 : Number(args.offset),
          args.length === undefined ? 50 : Number(args.length));
      } else if (name === "stop_search") {
        data = await stopSearch(principal, deviceId, String(args.search_id || ""));
      } else if (name === "pause_search" || name === "resume_search") {
        data = await controlSearch(principal, deviceId, String(args.search_id || ""),
          router, name === "pause_search");
      } else {
        data = await listSearches(principal, deviceId);
      }
      await audit(orgId, principal.actor, deviceId, name, "low", "success", "search_session");
      return ok(request.id, toolResult(data));
    } catch (error) {
      return ok(request.id, toolResult({
        error: error instanceof Error ? error.message : "search_failed",
      }, true));
    }
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
    const data = await router.request(deviceId, action, approvalToken);
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
