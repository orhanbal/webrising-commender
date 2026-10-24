import type { SearchProgress } from "./protocol.js";
import { isNativeFilenameCheckpoint } from "./search-checkpoint.js";

/** Pure relay stream decoder: must not import database or cluster configuration. */
const MAX_RELAY_STREAM_FRAME_BYTES = 1_100_000;
const MAX_RELAY_STREAM_TOTAL_BYTES = 64 * 1024 * 1024;
export async function readRelayStream<T>(
  response: Response,
  onProgress: (progress: SearchProgress) => void,
): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error?.error === "string" ? error.error : `relay_http_${response.status}`);
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/x-ndjson")) {
    throw new Error("relay_stream_invalid_content_type");
  }
  if (!response.body) throw new Error("relay_stream_missing_body");
  const reader = response.body.getReader();
  let pending = Buffer.alloc(0);
  let final: T | undefined;
  let completed = false;
  let frames = 0;
  let totalBytes = 0;
  let successfullyCompleted = false;
  const frame = (bytes: Buffer) => {
    if (++frames > 4096 || bytes.length === 0) throw new Error("relay_stream_invalid_frame");
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("relay_stream_invalid_frame");
    }
    if (!item || typeof item !== "object" || Array.isArray(item) || completed) {
      throw new Error("relay_stream_invalid_frame");
    }
    if (item.type === "progress") {
      const p = item.data as SearchProgress | undefined;
      if (!p || !Array.isArray(p.items) || p.items.length > 500 ||
          !Number.isSafeInteger(p.scannedEntries) || p.scannedEntries < 0 ||
          p.scannedEntries > 100_000 ||
          !Number.isSafeInteger(p.scannedBytes) || p.scannedBytes < 0 ||
          p.scannedBytes > 64 * 1024 * 1024 ||
          (p.checkpoint !== undefined && !isNativeFilenameCheckpoint(p.checkpoint))) {
        throw new Error("relay_stream_invalid_progress");
      }
      try { onProgress(p); } catch { /* A subscriber cannot interrupt a native scan. */ }
      return;
    }
    if (item.type === "result" && typeof item.ok === "boolean") {
      completed = true;
      if (!item.ok) {
        throw new Error(typeof item.error === "string" ? item.error : "relay_request_failed");
      }
      final = item.data as T;
      return;
    }
    throw new Error("relay_stream_invalid_frame");
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > MAX_RELAY_STREAM_TOTAL_BYTES) {
        throw new Error("relay_stream_total_too_large");
      }
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const piece = chunk.subarray(offset, end);
        if (pending.length + piece.length > MAX_RELAY_STREAM_FRAME_BYTES) {
          throw new Error("relay_stream_frame_too_large");
        }
        pending = Buffer.concat([pending, piece]);
        if (newline < 0) break;
        frame(pending);
        pending = Buffer.alloc(0);
        offset = newline + 1;
      }
    }
    if (pending.length !== 0 || !completed) throw new Error("relay_stream_incomplete");
    successfullyCompleted = true;
    return final as T;
  } finally {
    // Malformed or truncated relay streams must not keep downloading in the
    // background after the caller has already rejected their contents.
    if (!successfullyCompleted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

