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
