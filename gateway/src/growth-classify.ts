// Growth analytics: pure helpers (no database, no network), so every rule is
// unit tested. Privacy rules for everything built on top of this file:
//   - no cookies, no client identifiers, no third-party scripts;
//   - never store an IP address, a full user agent or a full referrer URL;
//   - only daily aggregate counters (day, kind, key, count) are kept.
// Keys are therefore limited to known page paths, a referrer *host* bucket,
// sanitized utm values and fixed crawler / client names.

import { publicPages } from "./site-content.js";

export type ReferrerBucket = "ai" | "search" | "social" | "direct" | "other" | "internal";
export type ReferrerClass = { bucket: ReferrerBucket; source: string };

/** AI assistants that send visitors (referrer host or utm_source). */
const aiSources: Array<[RegExp, string]> = [
  [/(^|\.)chatgpt\.com$|^chat\.openai\.com$|(^|\.)openai\.com$|^chatgpt$/, "ChatGPT"],
  [/(^|\.)claude\.ai$|(^|\.)claude\.com$|^claude$|^anthropic$/, "Claude"],
  [/(^|\.)perplexity\.ai$|^perplexity$/, "Perplexity"],
  [/^gemini\.google\.com$|^bard\.google\.com$|^aistudio\.google\.com$|^gemini$/, "Gemini"],
  [/^copilot\.microsoft\.com$|(^|\.)copilot\.cloud\.microsoft$|^edgeservices\.bing\.com$|(^|\.)m365copilot\.com$|^copilot(\.com)?$/, "Copilot"],
  [/(^|\.)you\.com$/, "You.com"],
  [/(^|\.)phind\.com$|^phind$/, "Phind"],
  [/(^|\.)deepseek\.com$|^deepseek$/, "DeepSeek"],
  [/^grok\.com$|(^|\.)x\.ai$|^grok$/, "Grok"],
  [/(^|\.)meta\.ai$/, "Meta AI"],
  [/^chat\.mistral\.ai$|(^|\.)mistral\.ai$|^mistral$/, "Mistral"],
  [/(^|\.)poe\.com$/, "Poe"],
  [/^chat\.qwen\.ai$|(^|\.)qwen\.ai$/, "Qwen"],
  [/(^|\.)kimi\.(com|ai)$|^kimi\.moonshot\.cn$/, "Kimi"],
];
const searchSources: Array<[RegExp, string]> = [
  [/(^|\.)google\.[a-z.]{2,8}$/, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)yandex\.[a-z.]{2,8}$|(^|\.)ya\.ru$/, "Yandex"],
  [/(^|\.)baidu\.com$/, "Baidu"],
  [/(^|\.)yahoo\.com$/, "Yahoo"],
  [/(^|\.)ecosia\.org$/, "Ecosia"],
  [/^search\.brave\.com$/, "Brave Search"],
  [/(^|\.)startpage\.com$/, "Startpage"],
  [/(^|\.)qwant\.com$/, "Qwant"],
  [/(^|\.)kagi\.com$/, "Kagi"],
  [/(^|\.)naver\.com$/, "Naver"],
];
const socialSources: Array<[RegExp, string]> = [
  [/(^|\.)x\.com$|(^|\.)twitter\.com$|^t\.co$/, "X"],
  [/(^|\.)facebook\.com$|^fb\.com$|^l\.facebook\.com$/, "Facebook"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "LinkedIn"],
  [/(^|\.)reddit\.com$/, "Reddit"],
  [/^news\.ycombinator\.com$/, "Hacker News"],
  [/(^|\.)youtube\.com$|^youtu\.be$/, "YouTube"],
  [/^t\.me$|(^|\.)telegram\.org$/, "Telegram"],
  [/(^|\.)whatsapp\.com$/, "WhatsApp"],
  [/(^|\.)discord\.com$|(^|\.)discord\.gg$/, "Discord"],
  [/^bsky\.app$/, "Bluesky"],
  [/(^|\.)threads\.net$/, "Threads"],
  [/(^|\.)producthunt\.com$/, "Product Hunt"],
  [/(^|\.)mastodon\.social$/, "Mastodon"],
];

const match = (table: Array<[RegExp, string]>, value: string) => table.find(([re]) => re.test(value))?.[1] ?? null;

/** The host of an http(s) URL, lower case and without "www."; null otherwise. */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]{1,100}$/.test(host) ? host : null;
  } catch { return null; }
}

/** Which kind of source sent a visit: an AI assistant, a search engine, social, direct, other or our own site. */
export function classifyReferrer(referrer: string | null | undefined, selfHost: string, utmSource?: string | null): ReferrerClass {
  const utm = (utmSource || "").toLowerCase().replace(/^www\./, "");
  const utmAi = utm ? match(aiSources, utm) : null;
  if (utmAi) return { bucket: "ai", source: utmAi };
  const host = referrerHost(referrer);
  if (!host) return { bucket: "direct", source: "direct" };
  if (host === selfHost.toLowerCase().replace(/^www\./, "")) return { bucket: "internal", source: host };
  const ai = match(aiSources, host);
  if (ai) return { bucket: "ai", source: ai };
  const search = match(searchSources, host);
  if (search) return { bucket: "search", source: search };
  const social = match(socialSources, host);
  if (social) return { bucket: "social", source: social };
  return { bucket: "other", source: host };
}

/** Crawlers that read the site for AI assistants and search engines (checked in order). */
const crawlers: Array<[RegExp, string]> = [
  [/OAI-SearchBot/i, "OAI-SearchBot"],
  [/ChatGPT-User/i, "ChatGPT-User"],
  [/GPTBot/i, "GPTBot"],
  [/Claude-SearchBot/i, "Claude-SearchBot"],
  [/Claude-User/i, "Claude-User"],
  [/ClaudeBot/i, "ClaudeBot"],
  [/Claude-Web/i, "Claude-Web"],
  [/anthropic-ai/i, "anthropic-ai"],
  [/Perplexity-User/i, "Perplexity-User"],
  [/PerplexityBot/i, "PerplexityBot"],
  [/Google-Extended/i, "Google-Extended"],
  [/Google-CloudVertexBot/i, "Google-CloudVertexBot"],
  [/GoogleOther/i, "GoogleOther"],
  [/Googlebot/i, "Googlebot"],
  [/bingbot/i, "Bingbot"],
  [/Applebot-Extended/i, "Applebot-Extended"],
  [/Applebot/i, "Applebot"],
  [/meta-externalagent/i, "Meta-ExternalAgent"],
  [/meta-externalfetcher/i, "Meta-ExternalFetcher"],
  [/FacebookBot/i, "FacebookBot"],
  [/Amazonbot/i, "Amazonbot"],
  [/CCBot/i, "CCBot"],
  [/Bytespider/i, "Bytespider"],
  [/DuckAssistBot/i, "DuckAssistBot"],
  [/DuckDuckBot/i, "DuckDuckBot"],
  [/MistralAI-User/i, "MistralAI-User"],
  [/cohere-ai|cohere-training-data-crawler/i, "cohere-ai"],
  [/YouBot/i, "YouBot"],
  [/PhindBot/i, "PhindBot"],
  [/AI2Bot/i, "AI2Bot"],
  [/Diffbot/i, "Diffbot"],
  [/YandexBot/i, "YandexBot"],
  [/Baiduspider/i, "Baiduspider"],
];

/** The crawler's public name, or null for anything else. */
export function classifyCrawler(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  return match(crawlers, userAgent.slice(0, 512));
}

const botPattern = /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|uptime|curl\/|wget\/|python|httpx|aiohttp|go-http-client|java\/|okhttp|node-fetch|undici|axios|libwww|phantomjs|selenium|puppeteer|playwright|scrapy|feedfetcher|validator/i;

/** True for crawlers, scripts and monitors (their page views are not counted as visits). */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  const ua = (userAgent || "").slice(0, 512);
  if (ua.length < 10) return true;
  return classifyCrawler(ua) !== null || botPattern.test(ua);
}

/** Public pages whose views are counted; private pages (console, dashboard) never are. */
export const countedPaths: ReadonlySet<string> = new Set([
  "/", "/features", "/how-it-works", "/pricing", "/install", "/login", "/register",
  "/privacy", "/terms", "/refund",
  ...publicPages.map((page) => page.path),
]);

/** A counted page path, or null. Trailing slashes are ignored. */
export function normalizePagePath(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) return null;
  const clean = path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
  return countedPaths.has(clean) ? clean : null;
}

/** Sanitized utm value (lower case, short, plain characters) or null. */
export function cleanUtm(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 64);
  return /^[a-z0-9][a-z0-9._+\-]*$/.test(v) ? v : null;
}

export type Utm = { source: string | null; medium: string | null; campaign: string | null };
export function utmFrom(search: string | URLSearchParams | null | undefined): Utm {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(typeof search === "string" ? search.slice(0, 1000) : "");
  return { source: cleanUtm(params.get("utm_source")), medium: cleanUtm(params.get("utm_medium")), campaign: cleanUtm(params.get("utm_campaign")) };
}

export type Increment = { kind: string; key: string };

/**
 * Counters for one page view: the page itself, and for a visit that arrived
 * from outside (not an internal navigation) its source and utm values.
 */
export function pageViewIncrements(input: { path: string; referrer?: string | null; search?: string | null; selfHost: string }): Increment[] {
  const path = normalizePagePath(input.path);
  if (!path) return [];
  const utm = utmFrom(input.search);
  const ref = classifyReferrer(input.referrer, input.selfHost, utm.source);
  const out: Increment[] = [{ kind: "pv", key: path }];
  if (ref.bucket === "internal" && !utm.source) return out;
  const bucket = ref.bucket === "internal" ? "other" : ref.bucket;
  out.push({ kind: "visit", key: bucket });
  out.push({ kind: "landing", key: path });
  if (bucket !== "direct") out.push({ kind: "source", key: `${bucket}:${ref.bucket === "internal" ? utm.source : ref.source}` });
  if (utm.source) out.push({ kind: "utm_source", key: utm.source });
  if (utm.medium) out.push({ kind: "utm_medium", key: utm.medium });
  if (utm.campaign) out.push({ kind: "utm_campaign", key: utm.campaign });
  return out;
}

/** The part of a crawler request that is counted: discovery files, public pages, MCP, or "other". */
export function crawlerPathKey(path: string): string {
  if (["/llms.txt", "/llms-full.txt", "/robots.txt", "/sitemap.xml", "/mcp"].includes(path)) return path;
  if (path.startsWith("/.well-known/")) return "/.well-known/*";
  if (path.startsWith("/assets/") || path.startsWith("/modern/assets/") || path.startsWith("/api/public/brand")) return "assets";
  return normalizePagePath(path) ?? "other";
}

/** Install-script fetches that are counted (the script name only). */
export function installKey(path: string): string | null {
  if (path === "/install.sh" || path === "/install.ps1") return path;
  const m = /^\/install\/([A-Za-z0-9._-]{1,60})$/.exec(path);
  return m ? `/install/${m[1]}` : null;
}

export type ClientKind = "claude" | "chatgpt" | "cursor" | "vscode" | "windsurf" | "other";

/** Which AI client registered an OAuth client, from its redirect URIs first and its name second. */
export function clientKind(name: string | null | undefined, redirectUris: unknown): ClientKind {
  const uris = Array.isArray(redirectUris) ? redirectUris.filter((u): u is string => typeof u === "string") : [];
  for (const uri of uris) {
    let host = "", scheme = "";
    try { const u = new URL(uri); host = u.hostname.toLowerCase(); scheme = u.protocol.replace(/:$/, "").toLowerCase(); } catch { continue; }
    if (/(^|\.)claude\.ai$|(^|\.)claude\.com$|(^|\.)anthropic\.com$/.test(host)) return "claude";
    if (/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/.test(host)) return "chatgpt";
    if (scheme === "cursor" || /(^|\.)cursor\.(com|sh)$/.test(host)) return "cursor";
    if (scheme === "vscode" || scheme === "vscode-insiders" || /(^|\.)vscode\.dev$/.test(host)) return "vscode";
    if (scheme === "windsurf" || /(^|\.)codeium\.com$|(^|\.)windsurf\.com$/.test(host)) return "windsurf";
  }
  const n = (name || "").toLowerCase();
  if (/claude|anthropic/.test(n)) return "claude";
  if (/chatgpt|openai/.test(n)) return "chatgpt";
  if (/cursor/.test(n)) return "cursor";
  if (/visual studio code|vs ?code|copilot/.test(n)) return "vscode";
  if (/windsurf|codeium/.test(n)) return "windsurf";
  return "other";
}

export type AssetClass = { platform: "windows" | "macos" | "linux"; format: string };

/** Platform and package format of a release asset; null for checksums, signatures and unknown files. */
export function classifyAsset(name: string): AssetClass | null {
  const n = name.toLowerCase();
  if (/\.(sha256|sha512|sig|asc|txt|json|yml|yaml|blockmap)$/.test(n)) return null;
  if (/\.msix(bundle)?$/.test(n)) return { platform: "windows", format: "msix" };
  if (/\.(exe|msi)$/.test(n)) return { platform: "windows", format: n.endsWith(".msi") ? "msi" : "exe" };
  if (/\.pkg$/.test(n)) return { platform: "macos", format: "pkg" };
  if (/\.dmg$/.test(n)) return { platform: "macos", format: "dmg" };
  if (/\.deb$/.test(n)) return { platform: "linux", format: "deb" };
  if (/\.rpm$/.test(n)) return { platform: "linux", format: "rpm" };
  if (/\.appimage$/.test(n)) return { platform: "linux", format: "appimage" };
  if (/\.(zip|tar\.gz|tgz)$/.test(n)) {
    const format = n.endsWith(".zip") ? "zip" : "tar.gz";
    if (/windows|win64|win-x64|-win\b/.test(n)) return { platform: "windows", format };
    if (/macos|darwin|mac-|osx/.test(n)) return { platform: "macos", format };
    if (/linux/.test(n)) return { platform: "linux", format };
  }
  return null;
}

export type DownloadStats = {
  total: number;
  byPlatform: Record<string, number>;
  byFormat: Record<string, number>;
  byVersion: Array<{ tag: string; total: number; publishedAt: string | null }>;
};

/** Download counts from the GitHub releases API response (cumulative, as GitHub reports them). */
export function releaseDownloadStats(releases: unknown): DownloadStats {
  const out: DownloadStats = { total: 0, byPlatform: {}, byFormat: {}, byVersion: [] };
  for (const release of Array.isArray(releases) ? releases as Array<Record<string, unknown>> : []) {
    if (release.draft === true || typeof release.tag_name !== "string") continue;
    let sum = 0;
    for (const asset of Array.isArray(release.assets) ? release.assets as Array<Record<string, unknown>> : []) {
      if (typeof asset.name !== "string") continue;
      const kind = classifyAsset(asset.name);
      const n = typeof asset.download_count === "number" && Number.isFinite(asset.download_count) ? Math.max(0, Math.trunc(asset.download_count)) : 0;
      if (!kind || n === 0) continue;
      sum += n;
      out.byPlatform[kind.platform] = (out.byPlatform[kind.platform] ?? 0) + n;
      const fk = `${kind.platform}:${kind.format}`;
      out.byFormat[fk] = (out.byFormat[fk] ?? 0) + n;
    }
    out.total += sum;
    out.byVersion.push({ tag: release.tag_name.slice(0, 64), total: sum, publishedAt: typeof release.published_at === "string" ? release.published_at : null });
  }
  out.byVersion.sort((a, b) => b.total - a.total);
  return out;
}

export type DayCount = { day: string; key: string; count: number };

/**
 * Daily downloads from cumulative daily snapshots: today's count minus the
 * previous snapshot of the same key (never negative; the first snapshot of a
 * key has no previous value and yields nothing).
 */
export function dailyDeltas(points: DayCount[]): DayCount[] {
  const byKey = new Map<string, DayCount[]>();
  for (const p of points) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  const out: DayCount[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.day.localeCompare(b.day));
    for (let i = 1; i < list.length; i++) out.push({ day: list[i]!.day, key, count: Math.max(0, list[i]!.count - list[i - 1]!.count) });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key));
}

/** YYYY-MM-DD in UTC. */
export function utcDay(date = new Date()): string { return date.toISOString().slice(0, 10); }

/** The last `days` UTC days ending today, oldest first. */
export function dayRange(days: number, end = new Date()): string[] {
  const out: string[] = [];
  const base = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(utcDay(new Date(base - i * 86_400_000)));
  return out;
}

/** Zero-filled daily series for the given days. */
export function fillSeries(days: string[], rows: Array<{ day: string; count: number }>): number[] {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.day, (map.get(r.day) ?? 0) + r.count);
  return days.map((d) => map.get(d) ?? 0);
}

export type CohortUser = { createdAt: Date; lastActiveAt: Date | null };
export type CohortRow = { week: string; signups: number; d7Eligible: number; d7: number; d7Rate: number | null; d30Eligible: number; d30: number; d30Rate: number | null };

/** Monday (UTC) of the week a date falls in. */
export function weekStart(date: Date): string {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return utcDay(new Date(day - weekday * 86_400_000));
}

/**
 * Retention by sign-up week: of the people who signed up that week and are at
 * least 7 (30) days old, the share that was active 7 (30) or more days after
 * signing up. Activity is the latest sign-in, web session or app contact.
 */
export function cohortRetention(users: CohortUser[], now = new Date()): CohortRow[] {
  const weeks = new Map<string, CohortRow>();
  for (const u of users) {
    const week = weekStart(u.createdAt);
    const row = weeks.get(week) ?? { week, signups: 0, d7Eligible: 0, d7: 0, d7Rate: null, d30Eligible: 0, d30: 0, d30Rate: null };
    row.signups++;
    const age = now.getTime() - u.createdAt.getTime();
    const activeAfter = u.lastActiveAt ? u.lastActiveAt.getTime() - u.createdAt.getTime() : -1;
    if (age >= 7 * 86_400_000) { row.d7Eligible++; if (activeAfter >= 7 * 86_400_000) row.d7++; }
    if (age >= 30 * 86_400_000) { row.d30Eligible++; if (activeAfter >= 30 * 86_400_000) row.d30++; }
    weeks.set(week, row);
  }
  return [...weeks.values()].map((r) => ({
    ...r,
    d7Rate: r.d7Eligible ? Math.round((r.d7 * 1000) / r.d7Eligible) / 10 : null,
    d30Rate: r.d30Eligible ? Math.round((r.d30 * 1000) / r.d30Eligible) / 10 : null,
  })).sort((a, b) => b.week.localeCompare(a.week));
}

/** Accumulates counter increments in memory between database flushes. */
export class CounterBuffer {
  private counts = new Map<string, number>();
  constructor(private readonly maxKeys = 5000) {}
  add(kind: string, key: string, n = 1, day = utcDay()) {
    const k = `${day}\u0000${kind.slice(0, 32)}\u0000${key.slice(0, 120)}`;
    if (!this.counts.has(k) && this.counts.size >= this.maxKeys) return false;
    this.counts.set(k, (this.counts.get(k) ?? 0) + n);
    return true;
  }
  get size() { return this.counts.size; }
  drain(): Array<{ day: string; kind: string; key: string; count: number }> {
    const rows = [...this.counts].map(([k, count]) => { const [day, kind, key] = k.split("\u0000") as [string, string, string]; return { day, kind, key, count }; });
    this.counts.clear();
    return rows;
  }
}

/**
 * One multi-row upsert into analytics_daily. "add" sums into the stored
 * count (page views, calls); "max" keeps the larger value (cumulative
 * snapshots such as GitHub download totals).
 */
export function counterUpsert(rows: Array<{ day: string; kind: string; key: string; count: number }>, mode: "add" | "max" = "add"): { text: string; values: unknown[] } | null {
  if (rows.length === 0) return null;
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(r.day, r.kind, r.key, Math.max(0, Math.trunc(r.count)));
    return `($${i * 4 + 1}::date,$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4}::bigint)`;
  });
  const update = mode === "add" ? "analytics_daily.count+excluded.count" : "greatest(analytics_daily.count,excluded.count)";
  return {
    text: `insert into analytics_daily(day,kind,key,count) values ${tuples.join(",")} on conflict (day,kind,key) do update set count=${update}`,
    values,
  };
}

export type RegistryListing = { listed: boolean; version: string | null; status: string | null; publishedAt: string | null; updatedAt: string | null };

/** Our entry in an MCP Registry /v0/servers response (newest version first). */
export function parseRegistryListing(body: unknown, name: string): RegistryListing {
  const none: RegistryListing = { listed: false, version: null, status: null, publishedAt: null, updatedAt: null };
  const servers = body && typeof body === "object" && Array.isArray((body as { servers?: unknown }).servers) ? (body as { servers: unknown[] }).servers : [];
  const entries = servers.map((item) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const server = (o.server && typeof o.server === "object" ? o.server : o) as Record<string, unknown>;
    const metaRoot = (o._meta ?? server._meta ?? {}) as Record<string, unknown>;
    const meta = (metaRoot["io.modelcontextprotocol.registry/official"] ?? {}) as Record<string, unknown>;
    return {
      name: String(server.name ?? ""), version: typeof server.version === "string" ? server.version : null,
      status: typeof meta.status === "string" ? meta.status : null, isLatest: meta.isLatest === true,
      publishedAt: typeof meta.publishedAt === "string" ? meta.publishedAt : null,
      updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : null,
    };
  }).filter((e) => e.name === name);
  if (entries.length === 0) return none;
  const best = entries.find((e) => e.isLatest) ?? entries.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))[0]!;
  return { listed: best.status !== "deleted", version: best.version, status: best.status ?? "active", publishedAt: best.publishedAt, updatedAt: best.updatedAt };
}
