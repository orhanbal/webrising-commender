import crypto from "node:crypto";
import type { AgentAction, SearchProgress } from "./protocol.js";
import type { AgentHub } from "./relay.js";
import {
  callRelay,
  callRelayStream,
  connectedRelayForDevice,
  relayOnlineDeviceIds,
  regionalRelayEnabled,
} from "./relay-cluster.js";

export class DeviceRouter {
  constructor(private readonly hub: AgentHub) {}

  async onlineStatuses(deviceIds: string[]) {
    const online = new Set<string>();
    for (const deviceId of deviceIds) {
      if (this.hub.isOnline(deviceId)) online.add(deviceId);
    }

    if (regionalRelayEnabled()) {
      const remote = await relayOnlineDeviceIds(
        deviceIds.filter((id) => !online.has(id)),
      );
      for (const id of remote) online.add(id);
    }
    return online;
  }

  async isOnline(deviceId: string) {
    if (this.hub.isOnline(deviceId)) return true;
    if (!regionalRelayEnabled()) return false;
    return (await relayOnlineDeviceIds([deviceId])).has(deviceId);
  }

  async request(
    deviceId: string,
    action: AgentAction,
    approvalToken?: string | null,
    signal?: AbortSignal,
    onProgress?: (progress: SearchProgress) => void,
    searchSessionId?: string,
    startPaused?: boolean,
  ) {
    if (signal?.aborted) throw new Error("request_cancelled");
    if (this.hub.isOnline(deviceId)) {
      return this.hub.request(deviceId, action, approvalToken, signal, onProgress, searchSessionId,
        startPaused);
    }
    if (!regionalRelayEnabled()) {
      throw new Error("device-offline");
    }

    const relay = await connectedRelayForDevice(deviceId);
    if (!relay) throw new Error("device-offline");

    if (signal?.aborted) throw new Error("request_cancelled");
    const requestId = crypto.randomUUID();
    // A separate signed cancellation request reaches the remote AgentHub.
    // Do not abort the original HTTP call: its native execution slot remains
    // occupied until the Agent acknowledges cancellation or times out.
    const onAbort = () => {
      void callRelay<{ ok: boolean }>(relay.internalBaseUrl, "/internal/relay/cancel", {
        deviceId, requestId,
      }).catch(() => {
        // Remote timeout/disconnection remains bounded by the original request.
      });
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) onAbort();
      const payload = {
        deviceId,
        requestId,
        action,
        ...(searchSessionId !== undefined ? { searchSessionId } : {}),
        ...(startPaused !== undefined ? { startPaused } : {}),
        ...(approvalToken !== undefined ? { approvalToken } : {}),
        ...(onProgress ? { streamProgress: true } : {}),
      };
      if (onProgress) {
        // Keep one signed HTTP request open while the remote Agent streams
        // progress. The final result is returned only after a complete frame.
        return callRelayStream<unknown>(
          relay.internalBaseUrl, "/internal/relay/request", payload, onProgress,
        );
      }
      const response = await callRelay<{
        ok: boolean;
        data?: unknown;
        error?: string;
      }>(relay.internalBaseUrl, "/internal/relay/request", payload);
      if (!response.ok) {
        throw new Error(response.error || "relay_request_failed");
      }
      return response.data;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async controlSearch(deviceId: string, searchSessionId: string, paused: boolean): Promise<boolean> {
    if (this.hub.isOnline(deviceId)) {
      return this.hub.controlSearch(deviceId, searchSessionId, paused);
    }
    if (!regionalRelayEnabled()) return false;
    const relay = await connectedRelayForDevice(deviceId);
    if (!relay) return false;
    const response = await callRelay<{ ok: boolean; accepted: boolean }>(
      relay.internalBaseUrl, "/internal/relay/search-control",
      { deviceId, searchSessionId, paused },
    );
    return response.ok && response.accepted;
  }

  async disconnect(deviceId: string) {
    if (this.hub.isOnline(deviceId)) {
      return this.hub.disconnect(deviceId);
    }
    if (!regionalRelayEnabled()) return false;

    const relay = await connectedRelayForDevice(deviceId);
    if (!relay) return false;

    const response = await callRelay<{
      ok: boolean;
      disconnected: boolean;
    }>(relay.internalBaseUrl, "/internal/relay/disconnect", { deviceId });
    return Boolean(response.ok && response.disconnected);
  }
}
