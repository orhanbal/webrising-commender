/** Signed regional-relay request cancellation state.
 * The control relay and the device relay may receive request/cancel out of order.
 * Bounded early-cancel tombstones prevent a cancelled native scan from starting.
 * All lookup keys are unguessable request UUIDs, paired with the target device.
 */
export class RelayCancellationRegistry {
  private readonly running = new Map<string, { deviceId: string; controller: AbortController }>();
  private readonly early = new Map<string, { deviceId: string; expiresAt: number }>();
  private readonly limit = 1024;
  private readonly ttlMs = 60_000;

  private purge(now = Date.now()) {
    for (const [id, entry] of this.early) {
      if (entry.expiresAt <= now) this.early.delete(id);
    }
  }

  register(requestId: string, deviceId: string): AbortController {
    this.purge();
    if (this.running.has(requestId)) throw new Error("duplicate_relay_request");
    if (this.running.size >= this.limit) throw new Error("relay_request_limit");
    const controller = new AbortController();
    const prior = this.early.get(requestId);
    if (prior?.deviceId === deviceId) controller.abort();
    this.early.delete(requestId);
    this.running.set(requestId, { deviceId, controller });
    return controller;
  }

  cancel(requestId: string, deviceId: string): boolean {
    this.purge();
    const active = this.running.get(requestId);
    if (active) {
      if (active.deviceId !== deviceId) return false;
      active.controller.abort();
      return true;
    }
    const prior = this.early.get(requestId);
    if (prior && prior.deviceId !== deviceId) return false;
    if (!prior && this.early.size >= this.limit) {
      const oldest = this.early.keys().next().value;
      if (oldest !== undefined) this.early.delete(oldest);
    }
    this.early.set(requestId, { deviceId, expiresAt: Date.now() + this.ttlMs });
    return true;
  }

  release(requestId: string, deviceId: string) {
    if (this.running.get(requestId)?.deviceId === deviceId) {
      this.running.delete(requestId);
    }
  }
}
