import { z } from "zod";

export type Risk = "low" | "medium" | "high";

export type AgentAction =
  | { kind: "system_info" }
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
  | { kind: "xlsx_inspect"; path: string }
  | { kind: "xlsx_read_range"; path: string; sheet: string; startRow: number; startColumn: number; rowCount: number; columnCount: number }
  | { kind: "xlsx_write_cells"; path: string; outputPath: string; sheet: string; updates: Array<{ cell: string; value: string | number | boolean }>; expectedSha256?: string }
  | { kind: "xlsx_find"; path: string; sheet?: string; query: string; caseSensitive?: boolean; maxResults?: number }
  | { kind: "fs_write"; path: string; contentBase64: string; createParents?: boolean }
  | { kind: "fs_append"; path: string; contentBase64: string }
  | { kind: "fs_mkdir"; path: string; recursive?: boolean }
  | { kind: "fs_delete"; path: string; recursive?: boolean }
  | { kind: "fs_move"; source: string; destination: string }
  | { kind: "fs_tree"; path: string; maxDepth?: number; maxEntries?: number }
  | { kind: "fs_search"; path: string; query: string; caseSensitive?: boolean; maxResults?: number; resumeCheckpoint?: unknown }
  | { kind: "text_search"; path: string; query: string; caseSensitive?: boolean; maxResults?: number }
  | { kind: "fs_replace"; path: string; search: string; replace: string; replaceAll?: boolean; expectedSha256?: string }
  | { kind: "process_exec"; command: string; cwd?: string; timeoutMs?: number }
  | { kind: "process_list" }
  | { kind: "process_kill"; pid: number }
  | { kind: "task_start"; command: string; cwd?: string; timeoutMs?: number }
  | { kind: "task_status"; taskId: string }
  | { kind: "task_cancel"; taskId: string }
  | { kind: "task_list" }
  | { kind: "terminal_start"; shell?: string; cwd?: string; cols?: number; rows?: number }
  | { kind: "terminal_input"; sessionId: string; dataBase64: string }
  | { kind: "terminal_read"; sessionId: string; maxBytes?: number }
  | { kind: "terminal_read_page"; sessionId: string; offsetBytes?: number; maxBytes?: number }
  | { kind: "terminal_resize"; sessionId: string; cols: number; rows: number }
  | { kind: "terminal_stop"; sessionId: string }
  | { kind: "terminal_list" };

const pathSchema = z.string().min(1).max(4096);
const sessionIdSchema = z.string().uuid();
const timeoutSchema = z.number().int().min(100).max(24 * 60 * 60 * 1000);

export const agentActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system_info") }).strict(),
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
  }).strict(),
  z.object({
    kind: z.literal("fs_append"),
    path: pathSchema,
    contentBase64: z.string().max(12 * 1024 * 1024),
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
    query: z.string().min(1).max(1024),
    caseSensitive: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(500).optional(),
  }).strict(),
  z.object({
    kind: z.literal("text_search"),
    path: pathSchema,
    query: z.string().min(1).max(4096),
    caseSensitive: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(500).optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_replace"),
    path: pathSchema,
    search: z.string().min(1).max(256 * 1024),
    replace: z.string().max(1024 * 1024),
    replaceAll: z.boolean().optional(),
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  }).strict(),
  z.object({
    kind: z.literal("process_exec"),
    command: z.string().min(1).max(32_000),
    cwd: pathSchema.optional(),
    timeoutMs: timeoutSchema.optional(),
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

export type GatewayMessage =
  | { type: "request"; requestId: string; action: AgentAction; approvalToken?: string | null; startPaused?: boolean }
  | { type: "cancel"; requestId: string }
  | { type: "search_control"; requestId: string; paused: boolean }
  | { type: "ping"; timestamp: string };

export type SearchProgress = {
  items: unknown[];
  scannedEntries: number;
  scannedBytes: number;
};

export type AgentMessage =
  | {
      type: "hello";
      deviceId: string;
      hostname: string;
      os: string;
      version: string;
      capabilities: string[];
    }
  | { type: "heartbeat"; timestamp: string }
  | { type: "search_control_ack"; requestId: string; paused: boolean }
  | { type: "search_progress"; requestId: string; items: unknown[]; scannedEntries: number; scannedBytes: number; checkpoint?: unknown }
  | { type: "result"; requestId: string; ok: true; data: unknown }
  | { type: "result"; requestId: string; ok: false; error: { code: string; message: string } };

export function actionRisk(kind: AgentAction["kind"] | string): Risk {
  switch (kind) {
    case "system_info":
    case "policy_info":
    case "fs_list":
    case "fs_stat":
    case "fs_read":
    case "fs_read_multiple":
    case "fs_read_lines":
    case "image_inspect":
    case "docx_inspect":
    case "docx_read_paragraphs":
    case "docx_read_table":
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
    case "terminal_input":
    case "terminal_resize":
      return "medium";
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
