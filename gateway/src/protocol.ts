import { z } from "zod";

export type Risk = "low" | "medium" | "high";

export type AgentAction =
  | { kind: "system_info" }
  | { kind: "fs_list"; path: string }
  | { kind: "fs_stat"; path: string }
  | { kind: "fs_read"; path: string; maxBytes?: number }
  | { kind: "fs_write"; path: string; contentBase64: string; createParents?: boolean }
  | { kind: "fs_mkdir"; path: string; recursive?: boolean }
  | { kind: "fs_delete"; path: string; recursive?: boolean }
  | { kind: "process_exec"; command: string; cwd?: string; timeoutMs?: number }
  | { kind: "process_list" }
  | { kind: "process_kill"; pid: number }
  | { kind: "task_start"; command: string; cwd?: string; timeoutMs?: number }
  | { kind: "task_status"; taskId: string }
  | { kind: "task_cancel"; taskId: string }
  | { kind: "terminal_start"; shell?: string; cwd?: string; cols?: number; rows?: number }
  | { kind: "terminal_input"; sessionId: string; dataBase64: string }
  | { kind: "terminal_read"; sessionId: string; maxBytes?: number }
  | { kind: "terminal_resize"; sessionId: string; cols: number; rows: number }
  | { kind: "terminal_stop"; sessionId: string };

const pathSchema = z.string().min(1).max(4096);
const sessionIdSchema = z.string().uuid();
const timeoutSchema = z.number().int().min(100).max(24 * 60 * 60 * 1000);

export const agentActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system_info") }).strict(),
  z.object({ kind: z.literal("fs_list"), path: pathSchema }).strict(),
  z.object({ kind: z.literal("fs_stat"), path: pathSchema }).strict(),
  z.object({
    kind: z.literal("fs_read"),
    path: pathSchema,
    maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("fs_write"),
    path: pathSchema,
    contentBase64: z.string().max(12 * 1024 * 1024),
    createParents: z.boolean().optional(),
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
    kind: z.literal("terminal_resize"),
    sessionId: sessionIdSchema,
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(5).max(300),
  }).strict(),
  z.object({
    kind: z.literal("terminal_stop"),
    sessionId: sessionIdSchema,
  }).strict(),
]);

export function parseAgentAction(value: unknown): AgentAction {
  return agentActionSchema.parse(value) as AgentAction;
}

export type GatewayMessage =
  | { type: "request"; requestId: string; action: AgentAction; approvalToken?: string | null }
  | { type: "cancel"; requestId: string }
  | { type: "ping"; timestamp: string };

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
  | { type: "result"; requestId: string; ok: true; data: unknown }
  | { type: "result"; requestId: string; ok: false; error: { code: string; message: string } };

export function actionRisk(kind: AgentAction["kind"] | string): Risk {
  switch (kind) {
    case "system_info":
    case "fs_list":
    case "fs_stat":
    case "fs_read":
    case "process_list":
    case "task_status":
    case "terminal_read":
      return "low";
    case "fs_write":
    case "fs_mkdir":
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
