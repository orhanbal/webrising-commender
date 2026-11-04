// Desktop Commander-compatible tool surface (v1.1 item 3).
// Aliases translate to native WECOMMANDER tools so roles, approvals, device
// policy and audit apply unchanged. edit_block and url_fetch are composite
// gateway tools. Pure helpers are exported for tests.

import dns from "node:dns/promises";
import net from "node:net";

const str = () => ({ type: "string" });
const int = () => ({ type: "integer" });
const devId = { device_id: { type: "string", description: "Optional when exactly one device is online." } };

function def(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { ...devId, ...properties }, required, additionalProperties: false },
    ...(process.env.MCP_OAUTH_ENABLED === "true" ? { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] } : {}),
  };
}

export const DC_TOOLS = [
  def("read_file", "Desktop Commander compatible: read a text file. With offset/length, reads a line range (zero-based offset; negative counts from the end). For .pdf files, offset/length are pages (max 20).", { path: str(), offset: int(), length: int() }, ["path"]),
  def("read_multiple_files", "Desktop Commander compatible: read up to ten files.", { paths: { type: "array", items: str(), minItems: 1, maxItems: 10 } }, ["paths"]),
  def("write_file", "Desktop Commander compatible: write UTF-8 text. mode 'rewrite' (default) replaces the file, 'append' appends.", { path: str(), content: str(), mode: { type: "string", enum: ["rewrite", "append"] } }, ["path", "content"]),
  def("list_directory", "Desktop Commander compatible: list a directory.", { path: str() }, ["path"]),
  def("create_directory", "Desktop Commander compatible: create a directory (with parents).", { path: str() }, ["path"]),
  def("move_file", "Desktop Commander compatible: move or rename a file or directory.", { source: str(), destination: str() }, ["source", "destination"]),
  def("get_file_info", "Desktop Commander compatible: file or directory metadata.", { path: str() }, ["path"]),
  def("edit_block", "Desktop Commander compatible surgical edit: replace old_string with new_string. Exact match first; if absent, a whitespace-tolerant match is used only when it is unique. expected_replacements (default 1) must equal the number of matches. The write is guarded by the file's SHA-256, so a concurrent change is never overwritten.", { file_path: str(), old_string: str(), new_string: str(), expected_replacements: int() }, ["file_path", "old_string", "new_string"]),
  def("url_fetch", "Fetch an http(s) URL from the WECOMMANDER gateway and return its text (max 1 MiB, 15 s). Private, loopback and link-local addresses are refused. device_id is ignored.", { url: str() }, ["url"]),
];

export const DC_ALIAS_NAMES = new Set(DC_TOOLS.map((t) => t.name));

/** Translate a Desktop Commander tool call to a native one; null for composite tools. */
export function translateAlias(name: string, a: Record<string, unknown>): { name: string; args: Record<string, unknown> } | null {
  const device = a.device_id === undefined ? {} : { device_id: a.device_id };
  const b64 = (text: unknown) => Buffer.from(String(text ?? ""), "utf8").toString("base64");
  switch (name) {
    case "read_file":
      // Desktop Commander reads PDFs through read_file; offset/length are pages here.
      if (/\.pdf$/i.test(String(a.path ?? ""))) {
        const offset = a.offset === undefined ? undefined : Number(a.offset);
        return { name: "pdf_read", args: { ...device, path: a.path, ...(offset !== undefined ? { start_page: offset < 0 ? offset : offset + 1 } : {}), ...(a.length !== undefined ? { page_count: a.length } : {}) } };
      }
      return a.offset !== undefined || a.length !== undefined
        ? { name: "fs_read_lines", args: { ...device, path: a.path, ...(a.offset !== undefined ? { offset_lines: a.offset } : {}), ...(a.length !== undefined ? { limit_lines: a.length } : {}) } }
        : { name: "fs_read", args: { ...device, path: a.path } };
    case "read_multiple_files": return { name: "fs_read_multiple", args: { ...device, paths: a.paths } };
    case "write_file":
      return a.mode === "append"
        ? { name: "fs_append", args: { ...device, path: a.path, content_base64: b64(a.content) } }
        : { name: "fs_write", args: { ...device, path: a.path, content_base64: b64(a.content), create_parents: true } };
    case "list_directory": return { name: "fs_list", args: { ...device, path: a.path } };
    case "create_directory": return { name: "fs_mkdir", args: { ...device, path: a.path, recursive: true } };
    case "move_file": return { name: "fs_move", args: { ...device, source: a.source, destination: a.destination } };
    case "get_file_info": return { name: "fs_stat", args: { ...device, path: a.path } };
    default: return null;
  }
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

// Regex for old_string where any run of spaces/tabs matches any run, and
// line endings match \n or \r\n. Leading/trailing whitespace of the whole
// block is trimmed so indentation differences of the first line still match.
function whitespaceTolerant(old: string) {
  const parts = old.trim().split(/(\r?\n|[ \t]+)/).filter((p) => p !== "");
  const source = parts.map((p) => /^\r?\n$/.test(p) ? "[ \\t]*\\r?\\n[ \\t]*" : /^[ \t]+$/.test(p) ? "[ \\t]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(source, "g");
}

export type EditPlan =
  | { ok: true; content: string; replacements: number; mode: "exact" | "whitespace" }
  | { ok: false; error: string; matches?: number; closest_line?: number; closest_text?: string };

export function planEdit(content: string, oldString: string, newString: string, expected = 1): EditPlan {
  if (!oldString) return { ok: false, error: "old_string_empty" };
  if (!Number.isInteger(expected) || expected < 1 || expected > 1000) return { ok: false, error: "invalid_expected_replacements" };
  const exact = countOccurrences(content, oldString);
  if (exact > 0) {
    if (exact !== expected) return { ok: false, error: "match_count_mismatch", matches: exact };
    return { ok: true, content: content.split(oldString).join(newString), replacements: exact, mode: "exact" };
  }
  if (oldString.trim()) {
    const pattern = whitespaceTolerant(oldString);
    const found = [...content.matchAll(pattern)];
    if (found.length === expected) {
      let out = ""; let last = 0;
      for (const m of found) { out += content.slice(last, m.index) + newString.trim(); last = m.index! + m[0].length; }
      return { ok: true, content: out + content.slice(last), replacements: found.length, mode: "whitespace" };
    }
    if (found.length > 0) return { ok: false, error: "match_count_mismatch", matches: found.length };
  }
  // No match: report the most similar line so the caller can correct itself.
  const first = oldString.trim().split(/\r?\n/)[0]!.trim();
  const lines = content.split(/\r?\n/);
  let best = -1; let bestScore = 0;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 2) }, (_, i) => s.slice(i, i + 3)));
  const target = grams(first);
  lines.forEach((line, index) => {
    const g = grams(line.trim());
    if (!g.size || !target.size) return;
    let shared = 0; for (const x of g) if (target.has(x)) shared++;
    const score = (2 * shared) / (g.size + target.size);
    if (score > bestScore) { bestScore = score; best = index; }
  });
  return best >= 0 && bestScore >= 0.5
    ? { ok: false, error: "no_match", closest_line: best + 1, closest_text: lines[best]!.slice(0, 300) }
    : { ok: false, error: "no_match" };
}

// ---------------------------------------------------------------- url_fetch

const MAX_FETCH_BYTES = 1024 * 1024;

export function isPublicAddress(address: string) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(address)) {
    const x = address.toLowerCase();
    if (x === "::" || x === "::1") return false;
    if (x.startsWith("::ffff:")) return isPublicAddress(x.slice(7));
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff")) return false;
    return true;
  }
  return false;
}

export async function assertPublicUrl(raw: string, lookup = dns.lookup) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid_url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("url_not_allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new Error("dns_failed"); });
  if (!addresses.length || !addresses.every((r) => isPublicAddress(r.address))) throw new Error("private_address_refused");
  return url;
}

export async function fetchUrl(raw: string, fetchImpl: typeof fetch = fetch, lookup = dns.lookup) {
  let url = await assertPublicUrl(raw, lookup);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "WECOMMANDER url_fetch" } });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (hop === 3) throw new Error("too_many_redirects");
      url = await assertPublicUrl(new URL(response.headers.get("location")!, url).href, lookup);
      continue;
    }
    const type = response.headers.get("content-type") || "";
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0; let truncated = false;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FETCH_BYTES) { truncated = true; chunks.push(value.slice(0, value.byteLength - (size - MAX_FETCH_BYTES))); await reader.cancel().catch(() => undefined); break; }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    const textual = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i.test(type) || !type;
    return {
      url: url.href, status: response.status, content_type: type, truncated,
      ...(textual ? { text: body.toString("utf8") } : { error: "binary_content_not_returned", bytes: body.length }),
    };
  }
  throw new Error("too_many_redirects");
}
