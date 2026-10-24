import assert from "node:assert/strict";
import test from "node:test";
import { RelayCancellationRegistry } from "./relay-cancellation.js";

test("regional relay cancellation is cooperative and scoped to request and device", () => {
  const registry = new RelayCancellationRegistry();
  const task = registry.register("request-a", "device-a");
  assert.equal(task.signal.aborted, false);
  assert.equal(registry.cancel("request-a", "device-b"), false);
  assert.equal(task.signal.aborted, false);
  assert.equal(registry.cancel("request-a", "device-a"), true);
  assert.equal(task.signal.aborted, true);
  assert.throws(() => registry.register("request-a", "device-a"), /duplicate_relay_request/);
  registry.release("request-a", "device-b");
  assert.throws(() => registry.register("request-a", "device-a"), /duplicate_relay_request/);
  registry.release("request-a", "device-a");
  assert.equal(registry.register("request-a", "device-a").signal.aborted, false);
});

test("cancel can arrive before remote request and never applies to another device", () => {
  const registry = new RelayCancellationRegistry();
  assert.equal(registry.cancel("request-early", "device-original"), true);
  const wrong = registry.register("request-early", "device-other");
  assert.equal(wrong.signal.aborted, false);
  registry.release("request-early", "device-other");
  assert.equal(registry.register("request-early", "device-original").signal.aborted, false);
  registry.release("request-early", "device-original");
  assert.equal(registry.cancel("request-cancelled", "device-original"), true);
  assert.equal(registry.register("request-cancelled", "device-original").signal.aborted, true);
});

test("relay cancellation states are isolated between registry instances", () => {
  const first = new RelayCancellationRegistry();
  const second = new RelayCancellationRegistry();
  first.cancel("same-request", "device-a");
  assert.equal(second.register("same-request", "device-a").signal.aborted, false);
  assert.equal(first.register("same-request", "device-a").signal.aborted, true);
});
