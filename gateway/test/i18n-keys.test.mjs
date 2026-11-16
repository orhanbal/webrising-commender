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
    if (fs.statSync(full).isDirectory()) { if (name !== "locales") sources(full, out); }
    else if (/\.(tsx?|ts)$/.test(name) && !tableFiles.includes(name)) out.push(full);
  }
  return out;
}

test("every translated literal has an English entry", () => {
  const english = table();
  const missing = [];
  for (const file of sources()) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:translate|t|copy)\(\s*("(?:[^"\\]|\\.)*")\s*\)/g)) {
      const key = JSON.parse(m[1]);
      if (!english.has(key) && !sameInBoth.has(key)) missing.push(`${path.relative(src, file)}: ${key}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "add these keys to ui/src/i18n-*.ts");
});

test("English entries are not left empty", () => {
  for (const [key, value] of table()) assert.ok(value.trim(), `empty English text for "${key}"`);
});

test("landing CMS catalog matches Landing.tsx and is fully translated", () => {
  const english = table();
  const catalog = fs.readFileSync(path.join(src, "landing-copy-sections.ts"), "utf8");
  const keys = new Set([...catalog.matchAll(/^\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)].map((m) => JSON.parse(m[1])));
  const landing = fs.readFileSync(path.join(src, "pages/Landing.tsx"), "utf8");
  const used = [...landing.matchAll(/\bcopy\(\s*("(?:[^"\\]|\\.)*")\s*\)/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(used.filter((k) => !keys.has(k)), [], "copy() keys missing from landing-copy-sections.ts");
  assert.deepEqual([...keys].filter((k) => !english.has(k) && !sameInBoth.has(k)), [], "catalog keys without English text");
});

test("every console ui() literal has a Turkish entry", () => {
  const console = fs.readFileSync(path.join(src, "console-text.ts"), "utf8");
  const turkish = new Set([...console.matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)].map((m) => JSON.parse(m[1])));
  const missing = [];
  for (const file of sources()) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("consoleText")) continue;
    for (const m of text.matchAll(/\bui\(\s*("(?:[^"\\]|\\.)*")\s*\)/g)) {
      const key = JSON.parse(m[1]);
      if (!turkish.has(key)) missing.push(`${path.relative(src, file)}: ${key}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "add these keys to ui/src/console-text.ts");
});

// The first-release languages besides English and Turkish: every key, never empty,
// with the same placeholders, URLs and commands as the English text.
const otherLocales = ["de", "pt-BR", "es", "fr"];
function localeTable(code) {
  const text = fs.readFileSync(path.join(src, "locales", code + ".ts"), "utf8");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return new Map(Object.entries(JSON.parse(json)));
}
const tokens = (value) => [...value.matchAll(/\$\{[^}]*\}|\{[a-zA-Z_]+\}|%[sd]|https?:\/\/\S+|`[^`]*`/g)].map((m) => m[0]).sort();

for (const code of otherLocales) {
  test(`${code}: every English key is translated, with the same placeholders`, () => {
    const english = table();
    const own = localeTable(code);
    const missing = [...english.keys()].filter((k) => !own.get(k)?.trim());
    assert.deepEqual(missing, [], `${code}: translations missing`);
    const broken = [...english].filter(([k, en]) => JSON.stringify(tokens(en)) !== JSON.stringify(tokens(own.get(k) ?? "")));
    assert.deepEqual(broken.map(([k]) => k), [], `${code}: placeholders, links or commands changed`);
  });
}
