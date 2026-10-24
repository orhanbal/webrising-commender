import assert from "node:assert/strict";
import test from "node:test";
import { readRelayStream } from "./relay-cluster.js";
import type { SearchProgress } from "./protocol.js";

function streamed(chunks: string[], contentType = "application/x-ndjson; charset=utf-8") {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": contentType } });
}

const progress: SearchProgress = {
  type: "search_progress",
  requestId: "native-request",
  items: [{ path: "/safe/first" }],
  scannedEntries: 32,
  scannedBytes: 1024,
};

test("relay NDJSON search progress handles split frames and preserves final result", async () => {
  const events: SearchProgress[] = [];
  const first = JSON.stringify({ type: "progress", data: progress }) + "\n";
  const last = JSON.stringify({ type: "result", ok: true, data: { items: ["done"] } }) + "\n";
  const result = await readRelayStream<{ items: string[] }>(
    streamed([first.slice(0, 7), first.slice(7) + last.slice(0, 3), last.slice(3)]),
    value => events.push(value),
  );
  assert.deepEqual(events, [progress]);
  assert.deepEqual(result, { items: ["done"] });
});

test("relay NDJSON rejects missing final result, invalid counters and forged trailing frames", async () => {
  await assert.rejects(readRelayStream(streamed([
    JSON.stringify({ type: "progress", data: progress }) + "\n",
  ]), () => {}), /relay_stream_incomplete/);
  await assert.rejects(readRelayStream(streamed([
    JSON.stringify({ type: "progress", data: { ...progress, scannedEntries: -1 } }) + "\n",
    JSON.stringify({ type: "result", ok: true, data: {} }) + "\n",
  ]), () => {}), /relay_stream_invalid_progress/);
  await assert.rejects(readRelayStream(streamed([
    JSON.stringify({ type: "result", ok: true, data: {} }) + "\n",
    JSON.stringify({ type: "progress", data: progress }) + "\n",
  ]), () => {}), /relay_stream_invalid_frame/);
});

test("relay NDJSON bounds each frame and refuses unexpected content type", async () => {
  await assert.rejects(readRelayStream(streamed(["x".repeat(1_100_001) + "\n"]), () => {}),
    /relay_stream_frame_too_large/);
  await assert.rejects(readRelayStream(streamed(["{}\n"], "application/json"), () => {}),
    /relay_stream_invalid_content_type/);
  await assert.rejects(readRelayStream(streamed([
    JSON.stringify({ type: "result", ok: false, error: "relay_request_failed" }) + "\n",
  ]), () => {}), /relay_request_failed/);
});
