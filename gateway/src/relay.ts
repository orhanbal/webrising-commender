import crypto from "node:crypto";
import type WebSocket from "ws";
import { db } from "./db.js";
import type { AgentAction, AgentMessage, GatewayMessage } from "./protocol.js";

type Pending = {
  deviceId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class AgentHub {
  private sockets = new Map<string, WebSocket>();
  private pending = new Map<string, Pending>();
  private timeoutMs = Math.max(1_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS || 30_000));

  isOnline(deviceId: string) {
    return this.sockets.has(deviceId);
  }

  onlineIds() {
    return [...this.sockets.keys()];
  }

  async register(deviceId: string, socket: WebSocket) {
    const old = this.sockets.get(deviceId);
    if (old && old !== socket) old.close(4001, "replaced");
    this.sockets.set(deviceId, socket);
    await db.query("update devices set last_seen_at=now() where id=$1", [deviceId]);

    socket.on("message", (raw) => {
      let message: AgentMessage;
      try {
        message = JSON.parse(raw.toString()) as AgentMessage;
      } catch {
        socket.close(1003, "invalid-json");
        return;
      }
      void this.onMessage(deviceId, message);
    });

    socket.on("close", () => {
      if (this.sockets.get(deviceId) === socket) this.sockets.delete(deviceId);
      for (const [id, pending] of this.pending) {
        if (pending.deviceId !== deviceId) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error("device-disconnected"));
        this.pending.delete(id);
      }
    });
  }

  private async onMessage(deviceId: string, message: AgentMessage) {
    if (message.type === "heartbeat") {
      await db.query("update devices set last_seen_at=now() where id=$1", [deviceId]);
      return;
    }

    if (message.type === "hello") {
      await db.query(
        "update devices set hostname=$2,platform=$3,agent_version=$4,capabilities=$5::jsonb,last_seen_at=now() where id=$1",
        [deviceId, message.hostname, message.os, message.version, JSON.stringify(message.capabilities)],
      );
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
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== 1) {
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
