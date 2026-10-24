import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentAction } from "./protocol.js";

test("validates a bounded process action", () => {
  const parsed = parseAgentAction({
    kind: "process_exec",
    command: "git status",
    cwd: "/tmp/project",
    timeoutMs: 30_000,
  });

  assert.equal(parsed.kind, "process_exec");
});

test("rejects unknown action fields", () => {
  assert.throws(() =>
    parseAgentAction({
      kind: "process_exec",
      command: "git status",
      unexpected: true,
    }),
  );
});

test("rejects oversized terminal input", () => {
  assert.throws(() =>
    parseAgentAction({
      kind: "terminal_input",
      sessionId: "00000000-0000-4000-8000-000000000001",
      dataBase64: "A".repeat(512 * 1024 + 1),
    }),
  );
});

test("validates bounded paginated file read with negative tail offset", () => {
  assert.deepEqual(parseAgentAction({
    kind: "fs_read_lines",
    path: "/safe/log.txt",
    offsetLines: -20,
    limitLines: 10,
  }), {
    kind: "fs_read_lines",
    path: "/safe/log.txt",
    offsetLines: -20,
    limitLines: 10,
  });
  assert.throws(() => parseAgentAction({
    kind: "fs_read_lines",
    path: "/safe/log.txt",
    limitLines: 1001,
  }));
  assert.throws(() => parseAgentAction({
    kind: "fs_read_lines",
    path: "/safe/log.txt",
    offsetLines: 2.5,
  }));
});

test("supports large absolute PTY history cursors without unsafe numbers", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const action = parseAgentAction({
    kind: "terminal_read_page", sessionId: id, offsetBytes: 2_000_000, maxBytes: 4096,
  });
  assert.equal(action.kind, "terminal_read_page");
  assert.throws(() => parseAgentAction({
    kind: "terminal_read_page", sessionId: id, offsetBytes: Number.MAX_SAFE_INTEGER + 1,
  }));
});

test("rejects malformed persistent task ids", () => {
  assert.throws(() =>
    parseAgentAction({
      kind: "task_cancel",
      taskId: "not-a-uuid",
    }),
  );
});
