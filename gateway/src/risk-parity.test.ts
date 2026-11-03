// The Gateway (actionRisk) and the Rust Agent (AgentAction::risk) classify
// every action independently. They must agree: if the Gateway rated an action
// lower than the Agent, a viewer could reach a mutating tool, or a HIGH-risk
// action could be sent without the human approval the Agent then demands.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { actionRisk } from "./protocol.js";

const rust = readFileSync(new URL("../../crates/agent/src/protocol.rs", import.meta.url), "utf8");

function body(fnName: string): string {
  const start = rust.indexOf(`pub fn ${fnName}(&self)`);
  assert.ok(start > 0, `${fnName} not found in protocol.rs`);
  const open = rust.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < rust.length; i++) {
    if (rust[i] === "{") depth++;
    if (rust[i] === "}" && --depth === 0) return rust.slice(open, i);
  }
  throw new Error("unbalanced");
}

// Variant -> wire kind, from kind_name().
const kinds = new Map<string, string>();
for (const m of body("kind_name").matchAll(/Self::(\w+)(?:\s*\{\s*\.\.\s*\})?\s*=>\s*"([a-z_]+)"/g)) kinds.set(m[1]!, m[2]!);

// Variant -> risk, from risk(): groups of `Self::X | Self::Y ... => Risk::Level`.
const risks = new Map<string, string>();
for (const m of body("risk").matchAll(/((?:\|?\s*Self::\w+(?:\s*\{\s*\.\.\s*\})?\s*)+)=>\s*Risk::(\w+)/g)) {
  for (const v of m[1]!.matchAll(/Self::(\w+)/g)) risks.set(v[1]!, m[2]!.toLowerCase());
}

test("every Agent action has a kind and a risk", () => {
  assert.ok(kinds.size >= 40, `only ${kinds.size} kinds parsed`);
  assert.deepEqual([...kinds.keys()].sort(), [...risks.keys()].sort());
});

test("Gateway and Agent agree on the risk of every action", () => {
  for (const [variant, kind] of kinds) {
    assert.equal(actionRisk(kind), risks.get(variant), `${kind}: gateway ${actionRisk(kind)} vs agent ${risks.get(variant)}`);
  }
});

test("unknown actions are rejected, never defaulted to low", () => {
  assert.throws(() => actionRisk("fs_format_disk"), /unknown agent action/);
});
