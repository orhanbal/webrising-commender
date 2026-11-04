// Every literal passed to translate()/t() in the React app must have an
// English entry, so no screen falls back to Turkish in the default locale.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui/src");
const tableFiles = ["i18n-common.ts", "i18n-marketing.ts", "i18n-product.ts"];
// Literals that are the same in both languages (brand, product or protocol names).
const sameInBoth = new Set(["WECOMMANDER", "MCP", "Terminal", "ChatGPT", "Claude", "API", "GitHub", "SSH"]);

function table() {
  const entries = new Map();
  for (const file of tableFiles) {
    const text = fs.readFileSync(path.join(src, file), "utf8");
    for (const m of text.matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/gm)) {
      const key = JSON.parse(m[1]);
      assert.ok(!entries.has(key) || entries.get(key) === JSON.parse(m[2]), `conflicting English text for "${key}"`);
      entries.set(key, JSON.parse(m[2]));
    }
  }
  return entries;
}

function sources(dir = src, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) sources(full, out);
    else if (/\.(tsx?|ts)$/.test(name) && !tableFiles.includes(name)) out.push(full);
  }
  return out;
}

test("every translated literal has an English entry", () => {
  const english = table();
  const missing = [];
  for (const file of sources()) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:translate|t)\(\s*("(?:[^"\\]|\\.)*")\s*\)/g)) {
      const key = JSON.parse(m[1]);
      if (!english.has(key) && !sameInBoth.has(key)) missing.push(`${path.relative(src, file)}: ${key}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "add these keys to ui/src/i18n-*.ts");
});

test("English entries are not left empty", () => {
  for (const [key, value] of table()) assert.ok(value.trim(), `empty English text for "${key}"`);
});
