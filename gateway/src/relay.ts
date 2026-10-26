import crypto from "node:crypto";
import type WebSocket from "ws";
import { isNativeContentCheckpoint, isNativeFilenameCheckpoint } from "./search-checkpoint.js";
import { db } from "./db.js";
import type { AgentAction, AgentMessage, GatewayMessage, SearchProgress, UndoScope } from "./protocol.js";

const MAX_PENDING_TOTAL = 1024;
const MAX_PENDING_PER_DEVICE = 64;

type Pending = {
  deviceId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
  onProgress?: ((progress: SearchProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
  isSearch: boolean;
  searchSessionId?: string | undefined;
  control?: { paused: boolean; resolve: (ok: boolean) => void; timer: NodeJS.Timeout } | undefined;
};

export class AgentHub {
  private sockets = new Map<string, WebSocket>();
  private ready = new Set<string>();
  private pending = new Map<string, Pending>();
  private timeoutMs = Math.max(1_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS || 30_000));

  constructor(private readonly relayNodeId: string | null = null) {}

  isOnline(deviceId: string) {
    return this.ready.has(deviceId);
  }

  onlineIds() {
    return [...this.ready];
  }

  private rejectPendingForDevice(deviceId: string, reason: string) {
    for (const [id, pending] of this.pending) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      if (pending.control) {
        clearTimeout(pending.control.timer);
        pending.control.resolve(false);
      }
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  disconnect(deviceId: string) {
    const socket = this.sockets.get(deviceId);
    if (!socket) return false;
    this.sockets.delete(deviceId);
    this.ready.delete(deviceId);
    this.rejectPendingForDevice(deviceId, "device-disconnected");
    void this.markDisconnected(deviceId);
    socket.close(4002, "operator-disconnect");
    return true;
  }

  private async markDisconnected(deviceId: string) {
    if (!this.relayNodeId) return;
    await db.query(
      `update devices
          set connected_relay_id=null
        where id=$1
          and connected_relay_id=$2`,
      [deviceId, this.relayNodeId],
    );
  }

  register(deviceId: string, socket: WebSocket) {
    const old = this.sockets.get(deviceId);
    if (old && old !== socket) {
      this.ready.delete(deviceId);
      this.rejectPendingForDevice(deviceId, "device-replaced");
      old.close(4001, "replaced");
    }

    this.sockets.set(deviceId, socket);
    this.ready.delete(deviceId);

    socket.on("message", (raw) => {
      let message: AgentMessage;
      try {
        message = JSON.parse(raw.toString()) as AgentMessage;
      } catch {
        socket.close(1003, "invalid-json");
        return;
      }

      void this.onMessage(deviceId, socket, message).catch(() => {
        if (this.sockets.get(deviceId) === socket) {
          this.sockets.delete(deviceId);
          this.ready.delete(deviceId);
          this.rejectPendingForDevice(deviceId, "device-state-error");
          void this.markDisconnected(deviceId).catch(() => {});
        }
        socket.close(1011, "state-update-failed");
      });
    });

    socket.on("close", () => {
      if (this.sockets.get(deviceId) !== socket) return;
      this.sockets.delete(deviceId);
      this.ready.delete(deviceId);
      this.rejectPendingForDevice(deviceId, "device-disconnected");
      void this.markDisconnected(deviceId).catch(() => {});
    });
  }

  private async onMessage(deviceId: string, socket: WebSocket, message: AgentMessage) {
    if (this.sockets.get(deviceId) !== socket) return;

    if (message.type === "heartbeat") {
      if (this.relayNodeId) {
        await db.query(
          `update devices
              set last_seen_at=now(),
                  relay_last_seen_at=now(),
                  connected_relay_id=$2
            where id=$1`,
          [deviceId, this.relayNodeId],
        );
      } else {
        await db.query("update devices set last_seen_at=now() where id=$1", [deviceId]);
      }
      return;
    }

    if (message.type === "hello") {
      if (this.relayNodeId) {
        await db.query(
          `update devices
              set hostname=$2,
                  platform=$3,
                  agent_version=$4,
                  capabilities=$5::jsonb,
                  last_seen_at=now(),
                  relay_last_seen_at=now(),
                  connected_relay_id=$6
            where id=$1`,
          [
            deviceId,
            message.hostname,
            message.os,
            message.version,
            JSON.stringify(message.capabilities),
            this.relayNodeId,
          ],
        );
      } else {
        await db.query(
          "update devices set hostname=$2,platform=$3,agent_version=$4,capabilities=$5::jsonb,last_seen_at=now() where id=$1",
          [deviceId, message.hostname, message.os, message.version, JSON.stringify(message.capabilities)],
        );
      }
      if (this.sockets.get(deviceId) === socket && socket.readyState === 1) {
        this.ready.add(deviceId);
      }
      return;
    }

    if (message.type === "search_control_ack") {
      const pending = this.pending.get(message.requestId);
      const control = pending?.control;
      if (!pending || pending.deviceId !== deviceId || !pending.isSearch ||
          !control || control.paused !== message.paused) return;
      clearTimeout(control.timer);
      pending.control = undefined;
      control.resolve(true);
      return;
    }

    if (message.type === "search_progress") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.deviceId !== deviceId || !pending.isSearch ||
          pending.signal?.aborted || !pending.onProgress) return;
      if (!Number.isSafeInteger(message.scannedEntries) || message.scannedEntries < 0 ||
          message.scannedEntries > 100_000 ||
          !Number.isSafeInteger(message.scannedBytes) || message.scannedBytes < 0 ||
          message.scannedBytes > 64 * 1024 * 1024 ||
          !Array.isArray(message.items) || message.items.length > 500 ||
          Buffer.byteLength(JSON.stringify(message.items), "utf8") > 1024 * 1024 ||
          (message.checkpoint !== undefined &&
            (!(isNativeFilenameCheckpoint(message.checkpoint) ||
                isNativeContentCheckpoint(message.checkpoint)) ||
             Buffer.byteLength(JSON.stringify(message), "utf8") > 1_100_000))) return;
      try { pending.onProgress(message); } catch { /* A progress observer cannot disrupt the native request. */ }
      return;
    }

    if (message.type === "result") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.deviceId !== deviceId) return;
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      if (pending.control) {
        clearTimeout(pending.control.timer);
        pending.control.resolve(false);
        pending.control = undefined;
      }
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    }
  }

  async controlSearch(deviceId: string, searchSessionId: string, paused: boolean): Promise<boolean> {
    const current = [...this.pending.entries()].find(([, req]) =>
      req.deviceId === deviceId && req.isSearch && req.searchSessionId === searchSessionId &&
      !req.signal?.aborted);
    if (!current) return false;
    const [requestId, pending] = current;
    const socket = this.sockets.get(deviceId);
    if (pending.control || !socket || socket.readyState !== 1 || !this.ready.has(deviceId)) {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.control?.timer === timer) pending.control = undefined;
        resolve(false);
      }, 2_000);
      pending.control = { paused, resolve, timer };
      const command: GatewayMessage = { type: "search_control", requestId, paused };
      socket.send(JSON.stringify(command), error => {
        if (error && pending.control?.timer === timer) {
          clearTimeout(timer);
          pending.control = undefined;
          resolve(false);
        }
      });
    });
  }

  request(deviceId: string, action: AgentAction, approvalToken?: string | null, signal?: AbortSignal,
    onProgress?: (progress: SearchProgress) => void, searchSessionId?: string,
    startPaused?: boolean, undoScope?: UndoScope) {
    if (signal?.aborted) return Promise.reject(new Error("request_cancelled"));
    if (this.pending.size >= MAX_PENDING_TOTAL) {
      return Promise.reject(new Error("gateway-overloaded"));
    }

    let devicePending = 0;
    for (const pending of this.pending.values()) {
      if (pending.deviceId === deviceId) devicePending += 1;
    }
    if (devicePending >= MAX_PENDING_PER_DEVICE) {
      return Promise.reject(new Error("device-request-limit"));
    }

    const socket = this.sockets.get(deviceId);
    if (!this.ready.has(deviceId) || !socket || socket.readyState !== 1) {
      return Promise.reject(new Error("device-offline"));
    }

    const requestId = crypto.randomUUID();
    const message: GatewayMessage = {
      type: "request",
      requestId,
      action,
      ...(startPaused !== undefined ? { startPaused } : {}),
      ...(approvalToken !== undefined ? { approvalToken } : {}),
      ...(undoScope !== undefined ? { undoScope } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        pending?.abortCleanup?.();
        if (pending?.control) {
          clearTimeout(pending.control.timer);
          pending.control.resolve(false);
        }
        this.pending.delete(requestId);
        try {
          const cancel: GatewayMessage = { type: "cancel", requestId };
          socket.send(JSON.stringify(cancel));
        } catch {}
        reject(new Error("device-request-timeout"));
      }, this.timeoutMs);

      // Cancellation sends a protocol message but retains the in-flight slot
      // until the Agent acknowledges cooperative exit (or transport timeout).
      const onAbort = () => {
        if (!this.pending.has(requestId)) return;
        try {
          const cancel: GatewayMessage = { type: "cancel", requestId };
          socket.send(JSON.stringify(cancel));
        } catch {}
      };
      const abortCleanup = () => signal?.removeEventListener("abort", onAbort);
      this.pending.set(requestId, { deviceId, resolve, reject, timer, abortCleanup,
        signal, onProgress, searchSessionId,
        isSearch: action.kind === "fs_search" || action.kind === "text_search" });
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        clearTimeout(timer);
        abortCleanup();
        const pending = this.pending.get(requestId);
        if (pending?.control) {
          clearTimeout(pending.control.timer);
          pending.control.resolve(false);
        }
        this.pending.delete(requestId);
        reject(error);
      });
      if (signal?.aborted) onAbort();
    });
  }
}
