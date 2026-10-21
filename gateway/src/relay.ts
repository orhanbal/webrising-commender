import crypto from "node:crypto";
import type WebSocket from "ws";
import { db } from "./db.js";
import type { AgentAction, AgentMessage, GatewayMessage } from "./protocol.js";

const MAX_PENDING_TOTAL = 1024;
const MAX_PENDING_PER_DEVICE = 64;

export type AgentLifecycleHooks = {
  onReady?: (deviceId: string) => Promise<void> | void;
  onClosed?: (deviceId: string) => Promise<void> | void;
};

type Pending = {
  deviceId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class AgentHub {
  private sockets = new Map<string, WebSocket>();
  private ready = new Set<string>();
  private pending = new Map<string, Pending>();
  private timeoutMs = Math.max(1_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS || 30_000));

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
    socket.close(4002, "operator-disconnect");
    return true;
  }

  register(deviceId: string, socket: WebSocket, hooks: AgentLifecycleHooks = {}) {
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

      void this.onMessage(deviceId, socket, message, hooks).catch(() => {
        if (this.sockets.get(deviceId) === socket) {
          this.sockets.delete(deviceId);
          this.ready.delete(deviceId);
          this.rejectPendingForDevice(deviceId, "device-state-error");
        }
        socket.close(1011, "state-update-failed");
      });
    });

    socket.on("close", () => {
      if (this.sockets.get(deviceId) !== socket) return;
      this.sockets.delete(deviceId);
      this.ready.delete(deviceId);
      this.rejectPendingForDevice(deviceId, "device-disconnected");
      void Promise.resolve(hooks.onClosed?.(deviceId)).catch(() => {});
    });
  }

  private async onMessage(
    deviceId: string,
    socket: WebSocket,
    message: AgentMessage,
    hooks: AgentLifecycleHooks,
  ) {
    if (this.sockets.get(deviceId) !== socket) return;

    if (message.type === "heartbeat") {
      await db.query("update devices set last_seen_at=now() where id=$1", [deviceId]);
      return;
    }

    if (message.type === "hello") {
      await db.query(
        "update devices set hostname=$2,platform=$3,agent_version=$4,capabilities=$5::jsonb,last_seen_at=now() where id=$1",
        [deviceId, message.hostname, message.os, message.version, JSON.stringify(message.capabilities)],
      );
      if (this.sockets.get(deviceId) === socket && socket.readyState === 1) {
        await hooks.onReady?.(deviceId);
        if (this.sockets.get(deviceId) === socket && socket.readyState === 1) {
          this.ready.add(deviceId);
        }
      }
      return;
    }

    if (message.type === "result") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.deviceId !== deviceId) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    }
  }

  request(deviceId: string, action: AgentAction, approvalToken?: string | null) {
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
      ...(approvalToken !== undefined ? { approvalToken } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        try {
          const cancel: GatewayMessage = { type: "cancel", requestId };
          socket.send(JSON.stringify(cancel));
        } catch {}
        reject(new Error("device-request-timeout"));
      }, this.timeoutMs);

      this.pending.set(requestId, { deviceId, resolve, reject, timer });
      socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }
}
