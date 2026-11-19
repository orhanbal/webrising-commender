import { z } from "zod";
import { isNativeContentCheckpoint, isNativeFilenameCheckpoint } from "./search-checkpoint.js";

export type Risk = "low" | "medium" | "high";

export type AgentAction =
  | { kind: "system_info" }
  | { kind: "health_snapshot"; top?: number }
  | { kind: "server_overview" }
  | { kind: "server_disk_usage"; path?: string }
  | { kind: "server_cleanup_scan" }
  | { kind: "server_cleanup_run"; ids: string[] }
  | { kind: "server_processes" }
  | { kind: "server_timers_list" }
  | { kind: "server_process_signal"; pid: number; name: string; action: "reap" | "term" | "kill"; confirmDatabase?: boolean }
  | { kind: "server_restart_owner"; ownerKind: "container" | "service"; id: string }
  | { kind: "docker_containers_list"; daemon?: string }
  | { kind: "docker_container_logs"; daemon: string; container: string; tail?: number; since?: string }
  | { kind: "docker_container_action"; daemon: string; container: string; action: "start" | "stop" | "restart" }
  | { kind: "log_query"; source: "journal" | "file"; path?: string; unit?: string; sinceMinutes?: number; level?: "error" | "warning" | "info" | "debug"; pattern?: string; limit?: number }
  | { kind: "policy_info" }
  | { kind: "fs_list"; path: string }
  | { kind: "fs_stat"; path: string }
  | { kind: "fs_read"; path: string; maxBytes?: number }
  | { kind: "fs_read_multiple"; paths: string[]; maxBytes?: number }
  | { kind: "fs_read_lines"; path: string; offsetLines?: number; limitLines?: number }
  | { kind: "image_inspect"; path: string }
  | { kind: "docx_inspect"; path: string }
  | { kind: "docx_read_paragraphs"; path: string; offset?: number; limit?: number }
  | { kind: "docx_read_table"; path: string; tableIndex: number; offsetRows?: number; limitRows?: number }
  | { kind: "pdf_read"; path: string; startPage?: number; pageCount?: number }
  | { kind: "xlsx_inspect"; path: string }
  | { kind: "xlsx_read_range"; path: string; sheet: string; startRow: number; startColumn: number; rowCount: number; columnCount: number }
  | { kind: "xlsx_write_cells"; path: string; outputPath: string; sheet: string; updates: Array<{ cell: string; value: string | number | boolean }>; expectedSha256?: string }
  | { kind: "xlsx_find"; path: string; sheet?: string; query: string; caseSensitive?: boolean; maxResults?: number }
  | { kind: "fs_write"; path: string; contentBase64: string; createParents?: boolean; expectedSha256?: string; withUndo?: boolean; runAs?: "root" }
  | { kind: "fs_append"; path: string; contentBase64: string; expectedSha256?: string; withUndo?: boolean }
  | { kind: "fs_mkdir"; path: string; recursive?: boolean }
  | { kind: "fs_delete"; path: string; recursive?: boolean; expectedSha256?: string }
  | { kind: "fs_move"; source: string; destination: string }
  | { kind: "fs_tree"; path: string; maxDepth?: number; maxEntries?: number }
  | { kind: "fs_search"; path: string; query: string; caseSensitive?: boolean; maxResults?: number; resumeCheckpoint?: unknown }
  | { kind: "text_search"; path: string; query: string; caseSensitive?: boolean; maxResults?: number; resumeCheckpoint?: unknown }
  | { kind: "fs_replace"; path: string; search: string; replace: string; replaceAll?: boolean; expectedSha256?: string }
  | { kind: "fs_versions"; path: string }
  | { kind: "fs_undo"; path: string; undoId: string; expectedSha256: string }
  | { kind: "process_exec"; command: string; cwd?: string; timeoutMs?: number; runAs?: "root" }
  | { kind: "process_list" }
  | { kind: "process_kill"; pid: number }
  | { kind: "task_start"; command: string; cwd?: string; timeoutMs?: number; runAs?: "root" }
  | { kind: "task_status"; taskId: string }
  | { kind: "task_cancel"; taskId: string }
  | { kind: "task_list" }
  | { kind: "terminal_start"; shell?: string; cwd?: string; cols?: number; rows?: number; runAs?: "root" }
  | { kind: "terminal_input"; sessionId: string; dataBase64: string }
  | { kind: "terminal_read"; sessionId: string; maxBytes?: number }
  | { kind: "terminal_read_page"; sessionId: string; offsetBytes?: number; maxBytes?: number }
  | { kind: "terminal_resize"; sessionId: string; cols: number; rows: number }
  | { kind: "terminal_stop"; sessionId: string }
  | { kind: "terminal_list" };

const pathSchema = z.string().min(1).max(4096);
// Set only by the gateway from the device's run_as setting (never from tool
// arguments); the agent also needs its local root ceiling and a signed
// approval for it.
const runAsSchema = z.literal("root");
/** Actions that run as root when the device's run_as is root. */
export const ROOT_CAPABLE_ACTIONS: ReadonlySet<string> = new Set(["process_exec", "task_start", "terminal_start", "fs_write"]);
// Rust search budgets are measured in UTF-8 bytes (String::len), not JS
// UTF-16 code units. Reject multi-byte over-budget queries at the wire boundary.
const searchQuerySchema = (maxBytes: number) =>
  z.string().min(1).max(maxBytes).refine(
    query => Buffer.byteLength(query, "utf8") <= maxBytes,
    "search query exceeds UTF-8 byte budget",
  );
const sessionIdSchema = z.string().uuid();
// Docker daemons and containers, as crates/wc-server/src/containers.rs
// validates them: `system` or `u<uid>`; a container id or name that can never
// be read as an option or shell text.
export const dockerDaemonSchema = z.string().regex(/^(system|u[1-9][0-9]{0,9})$/);
export const dockerContainerSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
// docker logs --since: a duration (10m, 1h30m), a Unix time or an RFC 3339 date/time.
export const dockerSinceSchema = z.string().min(1).max(40).regex(
  /^(?:(?:[0-9]{1,6}(?:ns|us|ms|h|m|s)){1,4}|[0-9]{1,10}(?:\.[0-9]{1,9})?|[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?)$/,
);
export const DOCKER_LOG_LINES_MAX = 2000;
const timeoutSchema = z.number().int().min(100).max(24 * 60 * 60 * 1000);

export const agentActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system_info") }).strict(),
  z.object({ kind: z.literal("health_snapshot"), top: z.number().int().min(1).max(20).optional() }).strict(),
  z.object({ kind: z.literal("server_overview") }).strict(),
  z.object({ kind: z.literal("server_disk_usage"), path: z.string().min(1).max(4096).regex(/^\/[^\n\0]*$/).optional() }).strict(),
  z.object({ kind: z.literal("server_cleanup_scan") }).strict(),
  z.object({ kind: z.literal("server_cleanup_run"), ids: z.array(z.string().regex(/^[a-z-]{2,40}(@u[0-9]{1,10})?$/)).min(1).max(20) }).strict(),
  z.object({ kind: z.literal("server_processes") }).strict(),
  z.object({ kind: z.literal("server_timers_list") }).strict(),
  z.object({
    kind: z.literal("server_process_signal"), pid: z.number().int().min(2).max(4194304),
    name: z.string().min(1).max(64).regex(/^[^\n\0]+$/), action: z.enum(["reap", "term", "kill"]), confirmDatabase: z.boolean().optional(),
  }).strict(),
  z.object({ kind: z.literal("server_restart_owner"), ownerKind: z.enum(["container", "service"]), id: z.string().min(1).max(256).regex(/^[A-Za-z0-9@._-]+$/) }).strict(),
  z.object({ kind: z.literal("docker_containers_list"), daemon: dockerDaemonSchema.optional() }).strict(),
  z.object({
    kind: z.literal("docker_container_logs"), daemon: dockerDaemonSchema, container: dockerContainerSchema,
    tail: z.number().int().min(1).max(DOCKER_LOG_LINES_MAX).optional(), since: dockerSinceSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("docker_container_action"), daemon: dockerDaemonSchema, container: dockerContainerSchema,
    action: z.enum(["start", "stop", "restart"]),
  }).strict(),
  z.object({
    kind: z.literal("log_query"), source: z.enum(["journal", "file"]), path: pathSchema.optional(),
    unit: z.string().min(1).max(256).regex(/^[A-Za-z0-9@._:\\-]+$/).optional(),
    sinceMinutes: z.number().int().min(1).max(10080).optional(),
    level: z.enum(["error", "warning", "info", "debug"]).optional(),
    pattern: z.string().max(512).optional(), limit: z.number().int().min(1).max(1000).optional(),
  }).strict(),
  z.object({ kind: z.literal("policy_info") }).strict(),
  z.object({ kind: z.literal("fs_list"), path: pathSchema }).strict(),
  z.object({ kind: z.literal("fs_stat"), path: pathSchema }).strict(),
  z.object({
    kind: z.literal("fs_read"),
    path: pathSchema,
    maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_read_multiple"),
    paths: z.array(pathSchema).min(1).max(10),
    maxBytes: z.number().int().min(1).max(64 * 1024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_read_lines"),
    path: pathSchema,
    offsetLines: z.number().int().safe().min(-2_147_483_648).max(2_147_483_647).optional(),
    limitLines: z.number().int().min(1).max(1000).optional(),
  }).strict(),
  z.object({ kind: z.literal("image_inspect"), path: pathSchema }).strict(),
  z.object({ kind: z.literal("docx_inspect"), path: pathSchema }).strict(),
  z.object({
    kind: z.literal("docx_read_paragraphs"),
    path: pathSchema,
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  z.object({
    kind: z.literal("docx_read_table"),
    path: pathSchema,
    tableIndex: z.number().int().min(0).max(10_000),
    offsetRows: z.number().int().min(0).max(1_000_000).optional(),
    limitRows: z.number().int().min(1).max(50).optional(),
  }).strict(),
  z.object({
    kind: z.literal("pdf_read"),
    path: pathSchema,
    startPage: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, "startPage is 1-based or negative").optional(),
    pageCount: z.number().int().min(1).max(20).optional(),
  }).strict(),
  z.object({ kind: z.literal("xlsx_inspect"), path: pathSchema }).strict(),
  z.object({
    kind: z.literal("xlsx_read_range"),
    path: pathSchema,
    sheet: z.string().min(1).max(255),
    startRow: z.number().int().min(1).max(1_048_576),
    startColumn: z.number().int().min(1).max(16_384),
    rowCount: z.number().int().min(1).max(50),
    columnCount: z.number().int().min(1).max(20),
  }).strict(),
  z.object({
    kind: z.literal("xlsx_find"),
    path: pathSchema,
    sheet: z.string().min(1).max(255).optional(),
    query: z.string().min(1).max(1024),
    caseSensitive: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
  }).strict(),
  z.object({
    kind: z.literal("xlsx_write_cells"),
    path: pathSchema,
    outputPath: pathSchema,
    sheet: z.string().min(1).max(255),
    updates: z.array(z.object({
      cell: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
      value: z.union([z.string().max(8192), z.number().finite(), z.boolean()]),
    }).strict()).min(1).max(100),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_write"),
    path: pathSchema,
    contentBase64: z.string().max(12 * 1024 * 1024),
    createParents: z.boolean().optional(),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    withUndo: z.boolean().optional(),
    runAs: runAsSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_append"),
    path: pathSchema,
    contentBase64: z.string().max(12 * 1024 * 1024),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    withUndo: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_mkdir"),
    path: pathSchema,
    recursive: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_delete"),
    path: pathSchema,
    recursive: z.boolean().optional(),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_move"),
    source: pathSchema,
    destination: pathSchema,
  }).strict(),
  z.object({
    kind: z.literal("fs_tree"),
    path: pathSchema,
    maxDepth: z.number().int().min(0).max(20).optional(),
    maxEntries: z.number().int().min(1).max(5000).optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_search"),
    path: pathSchema,
    query: searchQuerySchema(1024),
    caseSensitive: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(500).optional(),
    resumeCheckpoint: z.unknown().refine(isNativeFilenameCheckpoint).optional(),
  }).strict(),
  z.object({
    kind: z.literal("text_search"),
    path: pathSchema,
    query: searchQuerySchema(4096),
    caseSensitive: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(500).optional(),
    resumeCheckpoint: z.unknown().refine(isNativeContentCheckpoint).optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_replace"),
    path: pathSchema,
    search: z.string().min(1).max(256 * 1024),
    replace: z.string().max(1024 * 1024),
    replaceAll: z.boolean().optional(),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  }).strict(),
  z.object({ kind: z.literal("fs_versions"), path: pathSchema }).strict(),
  z.object({
    kind: z.literal("fs_undo"),
    path: pathSchema,
    undoId: z.string().uuid(),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }).strict(),
  z.object({
    kind: z.literal("process_exec"),
    command: z.string().min(1).max(32_000),
    cwd: pathSchema.optional(),
    timeoutMs: timeoutSchema.optional(),
    runAs: runAsSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("process_list") }).strict(),
  z.object({
    kind: z.literal("process_kill"),
    pid: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("task_start"),
    command: z.string().min(1).max(32_000),
    cwd: pathSchema.optional(),
    timeoutMs: timeoutSchema.optional(),
    runAs: runAsSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("task_status"),
    taskId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("task_cancel"),
    taskId: z.string().uuid(),
  }).strict(),
  z.object({ kind: z.literal("task_list") }).strict(),
  z.object({
    kind: z.literal("terminal_start"),
    shell: z.string().min(1).max(1024).optional(),
    cwd: pathSchema.optional(),
    cols: z.number().int().min(10).max(500).optional(),
    rows: z.number().int().min(5).max(300).optional(),
    runAs: runAsSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("terminal_input"),
    sessionId: sessionIdSchema,
    dataBase64: z.string().max(512 * 1024),
  }).strict(),
  z.object({
    kind: z.literal("terminal_read"),
    sessionId: sessionIdSchema,
    maxBytes: z.number().int().min(1).max(256 * 1024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("terminal_read_page"),
    sessionId: sessionIdSchema,
    offsetBytes: z.number().int().safe().min(-1_048_576).optional(),
    maxBytes: z.number().int().min(1).max(256 * 1024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("terminal_resize"),
    sessionId: sessionIdSchema,
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(5).max(300),
  }).strict(),
  z.object({
    kind: z.literal("terminal_stop"),
    sessionId: sessionIdSchema,
  }).strict(),
  z.object({ kind: z.literal("terminal_list") }).strict(),
]);

export function parseAgentAction(value: unknown): AgentAction {
  return agentActionSchema.parse(value) as AgentAction;
}

export type UndoScope = { organizationId: string; actor: string };

export type GatewayMessage =
  | { type: "request"; requestId: string; action: AgentAction; approvalToken?: string | null; startPaused?: boolean; undoScope?: UndoScope }
  | { type: "cancel"; requestId: string }
  | { type: "search_control"; requestId: string; paused: boolean }
  | { type: "ping"; timestamp: string };

export type SearchProgress = {
  items: unknown[];
  scannedEntries: number;
  scannedBytes: number;
  /** Untrusted until isNativeFilenameCheckpoint validates the payload. */
  checkpoint?: unknown;
};

export type AgentMessage =
  | {
      type: "hello";
      deviceId: string;
      hostname: string;
      os: string;
      version: string;
      capabilities: string[];
      /** Agent 2026.11+: the machine allows root (sudoers drop-in) and sudo works. */
      rootCapable?: boolean;
      /** The agent process itself runs as root/SYSTEM. */
      agentRoot?: boolean;
    }
  | { type: "heartbeat"; timestamp: string }
  | { type: "search_control_ack"; requestId: string; paused: boolean }
  | { type: "search_progress"; requestId: string; items: unknown[]; scannedEntries: number; scannedBytes: number; checkpoint?: unknown }
  | { type: "result"; requestId: string; ok: true; data: unknown }
  | { type: "result"; requestId: string; ok: false; error: { code: string; message: string } };

export function actionRisk(kind: AgentAction["kind"] | string): Risk {
  switch (kind) {
    case "system_info":
    case "health_snapshot":
    case "server_overview":
    case "server_disk_usage":
    case "server_cleanup_scan":
    case "server_processes":
    case "server_timers_list":
    case "docker_containers_list":
    case "docker_container_logs":
    case "log_query":
    case "policy_info":
    case "fs_list":
    case "fs_stat":
    case "fs_read":
    case "fs_read_multiple":
    case "fs_read_lines":
    case "fs_versions":
    case "image_inspect":
    case "docx_inspect":
    case "docx_read_paragraphs":
    case "docx_read_table":
    case "pdf_read":
    case "xlsx_inspect":
    case "xlsx_read_range":
    case "xlsx_find":
    case "fs_tree":
    case "fs_search":
    case "text_search":
    case "process_list":
    case "task_status":
    case "task_list":
    case "terminal_read":
    case "terminal_read_page":
    case "terminal_list":
      return "low";
    case "fs_write":
    case "xlsx_write_cells":
    case "fs_append":
    case "fs_mkdir":
    case "fs_move":
    case "fs_replace":
    case "fs_undo":
    case "terminal_resize":
      return "medium";
    // Typing into a live shell runs whatever is typed: an AI writing to a PTY
    // needs the same exact-payload human approval as process_exec.
    case "terminal_input":
    // Server management changes run fixed commands as root (cleanup, a
    // signal, a restart): the same human approval as process_exec.
    case "server_cleanup_run":
    case "server_process_signal":
    case "server_restart_owner":
    // Starting, stopping or restarting a container: approval every time
    // (mcp.ts ALWAYS_APPROVE skips the full-trust shortcut for it).
    case "docker_container_action":
    case "fs_delete":
    case "process_exec":
    case "process_kill":
    case "task_start":
    case "task_cancel":
    case "terminal_start":
    case "terminal_stop":
      return "high";
    default:
      throw new Error(`unknown agent action: ${kind}`);
  }
}
