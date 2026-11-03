// Super Admin plan: every visible console label must be translatable, and
// every translatable label must have a Turkish entry.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const console = readFileSync(new URL("../ui/src/pages/Console.tsx", import.meta.url), "utf8");
const dictionary = readFileSync(new URL("../ui/src/console-text.ts", import.meta.url), "utf8");
const turkish = new Set([...dictionary.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map(m => m[1]));

test("every ui() label in the console has a Turkish translation", () => {
  const used = new Set([...console.matchAll(/\bui\("((?:[^"\\]|\\.)*)"\)/g)].map(m => m[1]));
  assert.ok(used.size > 100, `only ${used.size} labels found`);
  const missing = [...used].filter(label => !turkish.has(label));
  assert.deepEqual(missing, []);
});

test("no hard-coded English label is rendered next to a value", () => {
  // ">Label: {value}" or ">Label {value}" text nodes bypass ui().
  const raw = [...console.matchAll(/>([A-Z][A-Za-z ]{2,40}[:—]?) ?\{/g)].map(m => m[1]);
  assert.deepEqual(raw, []);
});

test("accessible names are translatable", () => {
  const raw = [...console.matchAll(/aria-label="([A-Z][^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(raw, []);
});
