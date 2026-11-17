// Growth (Büyüme) section of the platform console: cookieless page-view
// counters, AI crawler and AI client counters, release download snapshots,
// usage and retention, feedback and the AI directory listings.
//
// Privacy: see growth-classify.ts. Nothing here stores an IP address, a full
// user agent, a cookie or a per-visitor identifier; the beacon's rate limit
// keeps its key in memory only.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { db } from "./db.js";
import { githubReleasesApi } from "./downloads.js";
import { REGISTRY_URL, namespaceFor } from "./mcp-registry.js";
import { npsScore } from "./marketing.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import {
  CounterBuffer, classifyCrawler, clientKind, cohortRetention, counterUpsert, crawlerPathKey, dailyDeltas, dayRange,
  fillSeries, installKey, isBotUserAgent, pageViewIncrements, parseRegistryListing, releaseDownloadStats, utcDay,
  type DownloadStats, type RegistryListing,
} from "./growth-classify.js";

type Query = (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
const defaultQuery: Query = (text, values) => db.query(text, values as unknown[]);

// ---------------------------------------------------------------- counters

export const counters = new CounterBuffer();

function addAll(increments: Array<{ kind: string; key: string }>) {
  for (const i of increments) counters.add(i.kind, i.key);
}

export async function flushCounters(query: Query = defaultQuery) {
  const rows = counters.drain();
  // Keep statements a reasonable size.
  for (let i = 0; i < rows.length; i += 500) {
    const statement = counterUpsert(rows.slice(i, i + 500), "add");
    if (statement) await query(statement.text, statement.values);
  }
  return rows.length;
}

type Headers = Record<string, string | string[] | undefined>;
const header = (headers: Headers, name: string) => { const v = headers[name]; return (Array.isArray(v) ? v[0] : v) ?? ""; };

/**
 * Called for every request before routing: counts AI crawler and search
 * engine reads (name and path bucket) and install-script fetches.
 */
export function recordRequest(method: string, pathname: string, headers: Headers) {
  if (method !== "GET" && method !== "HEAD") return;
  const crawler = classifyCrawler(header(headers, "user-agent"));
  if (crawler) {
    counters.add("crawler", crawler);
    counters.add("crawler_path", `${crawler} ${crawlerPathKey(pathname)}`);
  }
}

export function recordInstallFetch(pathname: string) {
  const key = installKey(pathname);
  if (key) counters.add("install", key);
}

/**
 * The server-rendered first hit of a public page. Prefetches, sub-resource
 * requests and bots are not counted; the SPA beacon counts later navigations.
 */
export function recordServerPageView(pathname: string, search: string, headers: Headers, selfHost: string) {
  const purpose = header(headers, "sec-purpose") || header(headers, "purpose") || header(headers, "x-moz");
  if (/prefetch|prerender|preview/i.test(purpose)) return;
  const dest = header(headers, "sec-fetch-dest");
  if (dest && dest !== "document") return;
  if (isBotUserAgent(header(headers, "user-agent"))) return;
  addAll(pageViewIncrements({ path: pathname, referrer: header(headers, "referer") || null, search, selfHost }));
}

/** POST /api/t body: path, referrer and the page's query string (for utm values). Nothing else. */
export const beaconSchema = z.object({
  p: z.string().min(1).max(200),
  r: z.string().max(1000).optional(),
  q: z.string().max(1000).optional(),
}).strict();

const beaconLimiter = new FixedWindowRateLimiter();

export type BeaconOutcome = "counted" | "ignored" | "rate_limited" | "invalid";

/**
 * Validates one beacon and counts it. `rateKey` is the caller's network
 * address, used only as an in-memory rate-limit key and never stored.
 */
export function handleBeacon(raw: string, headers: Headers, rateKey: string, selfHost: string, limiter = beaconLimiter): BeaconOutcome {
  if (!limiter.hit(rateKey, 60, 10 * 60_000).allowed) return "rate_limited";
  if (isBotUserAgent(header(headers, "user-agent"))) return "ignored";
  let parsed: z.infer<typeof beaconSchema>;
  try { parsed = beaconSchema.parse(JSON.parse(raw)); } catch { return "invalid"; }
  const increments = pageViewIncrements({ path: parsed.p, referrer: parsed.r ?? null, search: parsed.q ?? null, selfHost });
  if (increments.length === 0) return "ignored";
  addAll(increments);
  return "counted";
}

/** An MCP tool call, counted per AI client (OAuth) or access kind. */
export function recordMcpCall(principal: { authKind: string; oauthClientKind?: string }) {
  const key = principal.authKind === "oauth" ? (principal.oauthClientKind || "other")
    : principal.authKind === "token" ? "api_token"
    : principal.authKind === "session" ? "web"
    : principal.authKind === "center" ? "app" : principal.authKind;
  counters.add("mcp_call", key);
}

/** A desktop app's daily check-in (/api/center/me): one row per center and day. */
export async function recordCenterSeen(centerId: string, platform: string | null, version: string | null, language: string | null, query: Query = defaultQuery) {
  const clean = (v: string | null, re: RegExp) => (v && re.test(v) ? v : null);
  await query(
    `insert into center_daily(day,center_id,platform,app_version,language) values($1::date,$2,$3,$4,$5)
     on conflict (day,center_id) do update set platform=coalesce(excluded.platform,center_daily.platform),
       app_version=coalesce(excluded.app_version,center_daily.app_version),language=coalesce(excluded.language,center_daily.language)`,
    [utcDay(), centerId, clean(platform, /^(windows|macos|linux)$/), clean(version, /^[0-9A-Za-z.+_-]{1,40}$/), clean(language, /^[a-z]{2}(-[A-Za-z]{2})?$/)],
  );
}

// ---------------------------------------------------------------- downloads

let downloadCache: { value: DownloadStats | null; at: number } | null = null;

/** Cumulative download counts of every release asset (GitHub API, up to 5 pages). */
export async function fetchDownloadStats(fetcher: typeof fetch = fetch): Promise<DownloadStats | null> {
  const releases: unknown[] = [];
  for (let page = 1; page <= 5; page++) {
    const response = await fetcher(`${githubReleasesApi}?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "WECOMMANDER-Gateway" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return page === 1 ? null : releaseDownloadStats(releases);
    const data = await response.json() as unknown;
    if (!Array.isArray(data)) break;
    releases.push(...data);
    if (data.length < 100) break;
  }
  return releaseDownloadStats(releases);
}

/** Live counts for the console, cached for an hour (GitHub allows 60 anonymous calls an hour). */
export async function cachedDownloadStats(fetcher: typeof fetch = fetch) {
  if (downloadCache && Date.now() - downloadCache.at < 60 * 60_000) return downloadCache.value;
  try { downloadCache = { value: await fetchDownloadStats(fetcher), at: Date.now() }; }
  catch { downloadCache = { value: null, at: Date.now() - 50 * 60_000 }; }
  return downloadCache.value;
}

/** Today's cumulative totals into analytics_daily, so the console can chart daily downloads. */
export async function snapshotDownloads(fetcher: typeof fetch = fetch, query: Query = defaultQuery) {
  const stats = await fetchDownloadStats(fetcher);
  if (!stats) return false;
  downloadCache = { value: stats, at: Date.now() };
  const day = utcDay();
  const rows = [
    { day, kind: "dl_total", key: "all", count: stats.total },
    ...Object.entries(stats.byPlatform).map(([key, count]) => ({ day, kind: "dl_platform", key, count })),
    ...Object.entries(stats.byFormat).map(([key, count]) => ({ day, kind: "dl_format", key, count })),
    ...stats.byVersion.slice(0, 40).map((v) => ({ day, kind: "dl_version", key: v.tag, count: v.total })),
  ];
  const statement = counterUpsert(rows, "max");
  if (statement) await query(statement.text, statement.values);
  return true;
}

// ---------------------------------------------------------------- directories

export const directoryStatuses = ["not_submitted", "submitted", "listed", "rejected"] as const;
export const directoryCatalog = [
  { key: "mcp_registry", name: "Official MCP Registry", url: "https://registry.modelcontextprotocol.io" },
  { key: "claude_connectors", name: "Claude connectors directory", url: "https://claude.ai/directory" },
  { key: "chatgpt_apps", name: "ChatGPT apps directory", url: "https://chatgpt.com/apps" },
  { key: "smithery", name: "Smithery", url: "https://smithery.ai" },
  { key: "mcp_so", name: "mcp.so", url: "https://mcp.so" },
  { key: "glama", name: "Glama", url: "https://glama.ai/mcp/servers" },
  { key: "pulsemcp", name: "PulseMCP", url: "https://www.pulsemcp.com/servers" },
  { key: "lobehub", name: "LobeHub MCP market", url: "https://lobehub.com/mcp" },
  { key: "cursor_directory", name: "Cursor directory", url: "https://cursor.directory/mcp" },
  { key: "vscode_gallery", name: "VS Code / GitHub Copilot MCP gallery", url: "https://github.com/mcp" },
] as const;
export const directoryKeys = directoryCatalog.map((d) => d.key) as [string, ...string[]];

export const directoryUpdateSchema = z.object({
  key: z.enum(directoryKeys),
  status: z.enum(directoryStatuses),
  submittedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  listingUrl: z.string().url().max(500).refine((u) => u.startsWith("https://"), "https_required").nullable().optional(),
  note: z.string().max(500).optional(),
}).strict();

export async function listDirectories(query: Query = defaultQuery) {
  const rows = await query("select key,status,submitted_at::text as submitted_at,listing_url,note,updated_at from growth_directories");
  const byKey = new Map(rows.rows.map((r) => [r.key, r]));
  return directoryCatalog.map((d) => {
    const r = byKey.get(d.key);
    return { key: d.key, name: d.name, url: d.url, status: r?.status ?? "not_submitted", submittedAt: r?.submitted_at ?? null,
      listingUrl: r?.listing_url ?? null, note: r?.note ?? "", updatedAt: r?.updated_at ?? null };
  });
}

export async function updateDirectory(input: unknown, actorUserId: string, query: Query = defaultQuery) {
  const body = directoryUpdateSchema.parse(input);
  const submittedAt = body.status === "not_submitted" ? null : (body.submittedAt ?? null);
  const listingUrl = body.status === "listed" ? (body.listingUrl ?? null) : null;
  await query(
    `insert into growth_directories(key,status,submitted_at,listing_url,note,updated_at,updated_by) values($1,$2,$3::date,$4,$5,now(),$6)
     on conflict (key) do update set status=excluded.status,submitted_at=excluded.submitted_at,listing_url=excluded.listing_url,
       note=excluded.note,updated_at=now(),updated_by=excluded.updated_by`,
    [body.key, body.status, submittedAt, listingUrl, (body.note ?? "").trim(), actorUserId],
  );
  await query("insert into platform_admin_audit(actor_user_id,action,detail) values($1,'growth.directory_status',$2)",
    [actorUserId, `${body.key}: ${body.status}`]);
  return body;
}

let registryCache: { value: RegistryListing & { checkedAt: string; error: string | null }; at: number } | null = null;

/** Our listing in the official MCP Registry, checked live and cached for an hour. */
export async function registryStatus(origin: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (registryCache && now - registryCache.at < 60 * 60_000) return registryCache.value;
  const name = `${namespaceFor(origin)}/wecommander`;
  let value: RegistryListing & { checkedAt: string; error: string | null };
  try {
    const response = await fetcher(`${REGISTRY_URL}/v0/servers?search=${encodeURIComponent(name)}`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    value = { ...parseRegistryListing(await response.json(), name), checkedAt: new Date(now).toISOString(), error: null };
  } catch (error) {
    value = { listed: false, version: null, status: null, publishedAt: null, updatedAt: null, checkedAt: new Date(now).toISOString(),
      error: error instanceof Error ? error.message.slice(0, 200) : "unavailable" };
  }
  registryCache = { value, at: now };
  return value;
}
export function resetGrowthCaches() { registryCache = null; downloadCache = null; }

export const submissionKitUrl = "https://github.com/orhanbal/webrising-commender/blob/main/docs/DIRECTORY_SUBMISSIONS.md";
async function submissionKit(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, "../../docs/DIRECTORY_SUBMISSIONS.md"), path.resolve(here, "../docs/DIRECTORY_SUBMISSIONS.md")]) {
    try { return (await fs.readFile(candidate, "utf8")).slice(0, 40_000); } catch { /* not packaged */ }
  }
  return null;
}

// ---------------------------------------------------------------- console reports

export const rangeDays = (value: string | null) => (value === "30" ? 30 : value === "90" ? 90 : 7);

type Row = { day: string; kind: string; key: string; count: number };
async function analytics(kinds: string[], days: number, query: Query): Promise<Row[]> {
  const r = await query(
    "select day::text as day,kind,key,count::float8 as count from analytics_daily where kind = any($1) and day > current_date - $2::int",
    [kinds, days],
  );
  return r.rows.map((x) => ({ day: x.day, kind: x.kind, key: x.key, count: Number(x.count) }));
}
const sumBy = (rows: Row[], pick: (r: Row) => string) => {
  const map = new Map<string, number>();
  for (const r of rows) map.set(pick(r), (map.get(pick(r)) ?? 0) + r.count);
  return [...map].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
};
const total = (rows: Array<{ count: number }>) => rows.reduce((s, r) => s + r.count, 0);

async function downloadSeries(days: number, query: Query) {
  // One extra day so the first day of the range has a previous snapshot.
  const rows = await analytics(["dl_total", "dl_platform"], days + 1, query);
  const deltas = dailyDeltas(rows.map((r) => ({ day: r.day, key: `${r.kind}|${r.key}`, count: r.count })));
  const range = dayRange(days);
  const all = deltas.filter((d) => d.key === "dl_total|all");
  const byPlatform = sumBy(deltas.filter((d) => d.key.startsWith("dl_platform|") && range.includes(d.day))
    .map((d) => ({ day: d.day, kind: "", key: d.key.slice("dl_platform|".length), count: d.count })), (r) => r.key);
  return { series: fillSeries(range, all), total: total(all.filter((d) => range.includes(d.day))), byPlatform };
}

async function activity(query: Query) {
  const r = await query(`
    with act as (
      select u.id, u.created_at, greatest(u.last_login_at,
        (select max(b.last_seen_at) from browser_sessions b where b.user_id=u.id),
        (select max(m.last_seen_at) from management_centers m where m.user_id=u.id)) as last_active
      from users u where u.disabled_at is null)
    select count(*) filter (where last_active > now()-interval '1 day')::int as dau,
           count(*) filter (where last_active > now()-interval '7 days')::int as wau,
           count(*) filter (where last_active > now()-interval '30 days')::int as mau
      from act`);
  return { dau: Number(r.rows[0]?.dau ?? 0), wau: Number(r.rows[0]?.wau ?? 0), mau: Number(r.rows[0]?.mau ?? 0) };
}

async function signupSeries(days: number, query: Query) {
  const r = await query("select created_at::date::text as day,count(*)::int as count from users where created_at::date > current_date - $1::int group by 1", [days]);
  const rows = r.rows.map((x) => ({ day: x.day, count: Number(x.count) }));
  return { series: fillSeries(dayRange(days), rows), total: total(rows) };
}

async function npsSummary(days: number, query: Query) {
  const r = await query(
    `select r.score::int as score,count(*)::int as n from marketing_responses r join marketing_campaigns c on c.id=r.campaign_id
      where c.kind='nps' and r.action='answered' and r.score is not null and r.updated_at > now() - ($1::int * interval '1 day') group by 1`, [days]);
  const dist = r.rows.map((x) => ({ score: Number(x.score), n: Number(x.n) }));
  return { score: npsScore(dist), responses: dist.reduce((s, d) => s + d.n, 0) };
}

export async function growthOverview(days: number, query: Query = defaultQuery) {
  const range = dayRange(days);
  const traffic = await analytics(["visit", "source", "pv"], days, query);
  const visits = traffic.filter((r) => r.kind === "visit");
  const ai = traffic.filter((r) => r.kind === "source" && r.key.startsWith("ai:"));
  const devices = await query(`select count(*) filter (where last_seen_at > now()-interval '5 minutes')::int as online,
    count(*) filter (where last_seen_at > now()-interval '7 days')::int as active7 from devices where revoked_at is null`);
  const totalDownloads = await query("select count::float8 as count from analytics_daily where kind='dl_total' and key='all' order by day desc limit 1");
  return {
    days, range,
    visits: { total: total(visits), series: fillSeries(range, visits) },
    pageViews: total(traffic.filter((r) => r.kind === "pv")),
    aiVisits: { total: total(ai), series: fillSeries(range, ai) },
    downloads: { ...(await downloadSeries(days, query)), allTime: Number(totalDownloads.rows[0]?.count ?? 0) },
    signups: await signupSeries(days, query),
    active: await activity(query),
    devices: { online: Number(devices.rows[0]?.online ?? 0), active7d: Number(devices.rows[0]?.active7 ?? 0) },
    nps: await npsSummary(days, query),
  };
}

export async function growthTraffic(days: number, query: Query = defaultQuery) {
  const range = dayRange(days);
  const rows = await analytics(["visit", "source", "pv", "landing", "utm_source", "utm_medium", "utm_campaign"], days, query);
  const of = (kind: string) => rows.filter((r) => r.kind === kind);
  const sources = sumBy(of("source"), (r) => r.key).map((s) => ({ bucket: s.key.split(":")[0], source: s.key.slice(s.key.indexOf(":") + 1), count: s.count }));
  return {
    days, range,
    visits: { total: total(of("visit")), series: fillSeries(range, of("visit")) },
    pageViews: { total: total(of("pv")), series: fillSeries(range, of("pv")) },
    buckets: sumBy(of("visit"), (r) => r.key),
    ai: sources.filter((s) => s.bucket === "ai").map((s) => ({ key: s.source, count: s.count })),
    aiSeries: fillSeries(range, of("source").filter((r) => r.key.startsWith("ai:"))),
    sources: sources.slice(0, 50),
    pages: sumBy(of("pv"), (r) => r.key).slice(0, 50),
    landings: sumBy(of("landing"), (r) => r.key).slice(0, 50),
    utmSource: sumBy(of("utm_source"), (r) => r.key).slice(0, 30),
    utmMedium: sumBy(of("utm_medium"), (r) => r.key).slice(0, 30),
    utmCampaign: sumBy(of("utm_campaign"), (r) => r.key).slice(0, 30),
  };
}

export async function growthCrawlers(days: number, query: Query = defaultQuery) {
  const range = dayRange(days);
  const rows = await analytics(["crawler", "crawler_path"], days, query);
  const bots = sumBy(rows.filter((r) => r.kind === "crawler"), (r) => r.key);
  const paths = sumBy(rows.filter((r) => r.kind === "crawler_path"), (r) => r.key).map((p) => {
    const i = p.key.indexOf(" ");
    return { crawler: p.key.slice(0, i), path: p.key.slice(i + 1), count: p.count };
  });
  return {
    days, range,
    total: total(bots), series: fillSeries(range, rows.filter((r) => r.kind === "crawler")),
    crawlers: bots.map((b) => ({ ...b, series: fillSeries(range, rows.filter((r) => r.kind === "crawler" && r.key === b.key)) })),
    paths: sumBy(paths.map((p) => ({ day: "", kind: "", key: p.path, count: p.count })), (r) => r.key),
    detail: paths.slice(0, 100),
  };
}

/** Fills the stored client kind for OAuth clients registered before the column existed. */
async function backfillClientKinds(query: Query) {
  const r = await query("select client_id,client_name,redirect_uris from oauth_clients where client_kind is null limit 2000");
  for (const row of r.rows)
    await query("update oauth_clients set client_kind=$2 where client_id=$1", [row.client_id, clientKind(row.client_name, row.redirect_uris)]);
}

export async function growthConnections(days: number, query: Query = defaultQuery) {
  await backfillClientKinds(query);
  const range = dayRange(days);
  const clients = await query(`
    select coalesce(c.client_kind,'other') as kind,
      count(distinct s.user_id) filter (where s.revoked_at is null and s.refresh_expires_at > now())::int as users,
      count(distinct s.organization_id) filter (where s.revoked_at is null and s.refresh_expires_at > now())::int as workspaces,
      count(distinct s.user_id) filter (where s.created_at > now() - ($1::int * interval '1 day'))::int as new_users,
      max(s.created_at) as last_connected
    from oauth_sessions s join oauth_clients c on c.client_id=s.client_id group by 1 order by 2 desc`, [days]);
  const calls = await analytics(["mcp_call"], days, query);
  return {
    days, range,
    clients: clients.rows.map((r) => ({ kind: r.kind, users: Number(r.users), workspaces: Number(r.workspaces), newUsers: Number(r.new_users), lastConnected: r.last_connected })),
    calls: sumBy(calls, (r) => r.key).map((c) => ({ ...c, series: fillSeries(range, calls.filter((r) => r.key === c.key)) })),
    callSeries: fillSeries(range, calls),
  };
}

export async function growthDownloads(days: number, query: Query = defaultQuery, fetcher: typeof fetch = fetch) {
  const range = dayRange(days);
  const series = await downloadSeries(days, query);
  const installs = await analytics(["install"], days, query);
  return {
    days, range,
    live: await cachedDownloadStats(fetcher),
    daily: series,
    installs: { total: total(installs), series: fillSeries(range, installs), byScript: sumBy(installs, (r) => r.key) },
  };
}

export async function growthUsage(days: number, query: Query = defaultQuery) {
  const range = dayRange(days);
  // Apps seen in the range, each counted once with its latest platform, version and language.
  const centers = await query(
    `select coalesce(platform,'unknown') as platform,coalesce(app_version,'unknown') as version,coalesce(language,'unknown') as language,count(*)::int as n
       from (select distinct on (center_id) platform,app_version,language from center_daily
              where day > current_date - $1::int order by center_id,day desc) latest group by 1,2,3`, [days]);
  const centerRows = centers.rows.map((r) => ({ platform: r.platform as string, version: r.version as string, language: r.language as string, count: Number(r.n) }));
  const distinctDaily = await query("select day::text as day,count(distinct center_id)::int as count from center_daily where day > current_date - $1::int group by 1", [days]);
  const devices = await query(`select coalesce(nullif(platform,''),'unknown') as platform, count(*)::int as total,
      count(*) filter (where last_seen_at > now()-interval '5 minutes')::int as online,
      count(*) filter (where last_seen_at > now()-interval '7 days')::int as active7d
    from devices where revoked_at is null group by 1 order by 2 desc`);
  const cohortUsers = await query(`
    select u.created_at, greatest(u.last_login_at,
      (select max(b.last_seen_at) from browser_sessions b where b.user_id=u.id),
      (select max(m.last_seen_at) from management_centers m where m.user_id=u.id)) as last_active
    from users u where u.created_at > now() - interval '120 days'`);
  const funnel = await query(`
    with s as (select id from users where created_at > now() - ($1::int * interval '1 day')),
         o as (select distinct m.user_id, m.organization_id from organization_members m join s on s.id=m.user_id)
    select (select count(*) from s)::int as signups,
      (select count(distinct o.user_id) from o where exists(select 1 from devices d where d.organization_id=o.organization_id))::int as with_device,
      (select count(distinct o.user_id) from o join organization_subscriptions sub on sub.organization_id=o.organization_id
         where sub.status='active' and sub.plan_key<>'free')::int as paid`, [days]);
  const traffic = await analytics(["visit"], days, query);
  const downloads = await downloadSeries(days, query);
  const installs = await analytics(["install"], days, query);
  const signups = await signupSeries(days, query);
  const f = funnel.rows[0] ?? {};
  const group = (pick: (r: typeof centerRows[number]) => string) =>
    sumBy(centerRows.map((r) => ({ day: "", kind: "", key: pick(r), count: r.count })), (r) => r.key);
  return {
    days, range,
    active: await activity(query),
    signups,
    appsDaily: fillSeries(range, distinctDaily.rows.map((r) => ({ day: r.day, count: Number(r.count) }))),
    appsByPlatform: group((r) => r.platform), appsByVersion: group((r) => `${r.platform} ${r.version}`), appsByLanguage: group((r) => r.language),
    devices: devices.rows.map((r) => ({ platform: r.platform, total: Number(r.total), online: Number(r.online), active7d: Number(r.active7d) })),
    retention: cohortRetention(cohortUsers.rows.map((r) => ({ createdAt: new Date(r.created_at), lastActiveAt: r.last_active ? new Date(r.last_active) : null }))).slice(0, 16),
    funnel: [
      { step: "visits", count: total(traffic) },
      { step: "downloads", count: downloads.total + total(installs) },
      { step: "signups", count: Number(f.signups ?? signups.total) },
      { step: "first_device", count: Number(f.with_device ?? 0) },
      { step: "paid", count: Number(f.paid ?? 0) },
    ],
  };
}

export async function growthFeedback(days: number, query: Query = defaultQuery) {
  const responses = await query(
    `select c.kind,c.title,r.score,r.comment,r.platform,r.updated_at from marketing_responses r join marketing_campaigns c on c.id=r.campaign_id
      where r.action='answered' and c.kind in ('csat','nps') and r.updated_at > now() - ($1::int * interval '1 day')
      order by r.updated_at desc limit 300`, [days]);
  const rows = responses.rows.map((r) => ({ kind: r.kind as string, title: r.title as string, score: r.score === null ? null : Number(r.score),
    comment: (r.comment ?? "") as string, platform: r.platform as string, updatedAt: r.updated_at }));
  const nps = rows.filter((r) => r.kind === "nps" && r.score !== null);
  const dist = (list: typeof rows) => { const m = new Map<number, number>(); for (const r of list) m.set(r.score!, (m.get(r.score!) ?? 0) + 1); return [...m].map(([score, n]) => ({ score, n })); };
  const weeks = new Map<string, typeof rows>();
  for (const r of nps) { const w = new Date(r.updatedAt); const key = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() - ((w.getUTCDay() + 6) % 7))).toISOString().slice(0, 10); weeks.set(key, [...(weeks.get(key) ?? []), r]); }
  const csat = rows.filter((r) => r.kind === "csat" && r.score !== null);
  const errors = await query(
    `select message,platform,build,count(*)::int as n,max(created_at) as last_at from app_error_reports
      where created_at > now() - ($1::int * interval '1 day') group by 1,2,3 order by n desc limit 300`, [days]);
  type ErrorGroup = { message: string; total: number; lastAt: string; breakdown: Array<{ platform: string; build: string; count: number }> };
  const byMessage = new Map<string, ErrorGroup>();
  for (const e of errors.rows) {
    const item: ErrorGroup = byMessage.get(e.message) ?? { message: String(e.message), total: 0, lastAt: "", breakdown: [] };
    item.total += Number(e.n);
    const last = new Date(e.last_at).toISOString();
    if (last > item.lastAt) item.lastAt = last;
    item.breakdown.push({ platform: e.platform, build: e.build, count: Number(e.n) });
    byMessage.set(e.message, item);
  }
  return {
    days,
    nps: { score: npsScore(dist(nps)), responses: nps.length, distribution: dist(nps).sort((a, b) => a.score - b.score),
      trend: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, list]) => ({ week, score: npsScore(dist(list)), responses: list.length })) },
    csat: { average: csat.length ? Math.round((csat.reduce((s, r) => s + r.score!, 0) / csat.length) * 100) / 100 : null, responses: csat.length },
    comments: rows.filter((r) => r.comment.trim().length > 0).slice(0, 100),
    errors: [...byMessage.values()].sort((a, b) => b.total - a.total).slice(0, 50),
  };
}

/**
 * Routes under /api/console/growth/ (the caller has already checked the
 * platform administrator session and the mutation rate limit).
 */
export async function growthConsoleRoute(method: string, url: URL, readBody: () => Promise<unknown>, actorUserId: string, origin: string):
  Promise<{ status: number; body: unknown } | null> {
  const days = rangeDays(url.searchParams.get("days"));
  const route = url.pathname.slice("/api/console/growth/".length);
  if (method === "GET") {
    if (route === "overview") return { status: 200, body: await growthOverview(days) };
    if (route === "traffic") return { status: 200, body: await growthTraffic(days) };
    if (route === "crawlers") return { status: 200, body: await growthCrawlers(days) };
    if (route === "connections") return { status: 200, body: await growthConnections(days) };
    if (route === "downloads") return { status: 200, body: await growthDownloads(days) };
    if (route === "usage") return { status: 200, body: await growthUsage(days) };
    if (route === "feedback") return { status: 200, body: await growthFeedback(days) };
    if (route === "directories")
      return { status: 200, body: { items: await listDirectories(), registry: await registryStatus(origin), kitUrl: submissionKitUrl, kit: await submissionKit() } };
  }
  if (method === "POST" && route === "directories") {
    const parsed = directoryUpdateSchema.safeParse(await readBody());
    if (!parsed.success) return { status: 400, body: { error: "invalid_directory_status" } };
    await updateDirectory(parsed.data, actorUserId);
    return { status: 200, body: { ok: true, items: await listDirectories() } };
  }
  return null;
}

// ---------------------------------------------------------------- timers

/** Flushes counters every 30 s and snapshots release downloads every 6 h. */
export function startGrowthTimers(log: (line: string) => void) {
  const flush = setInterval(() => { void flushCounters().catch((e) => log(`growth counters: ${e instanceof Error ? e.message : String(e)}`)); }, 30_000);
  flush.unref();
  if (process.env.GROWTH_DOWNLOAD_SNAPSHOT_DISABLED === "true") return () => clearInterval(flush);
  const snapshot = () => { void snapshotDownloads().catch((e) => log(`growth downloads: ${e instanceof Error ? e.message : String(e)}`)); };
  const first = setTimeout(snapshot, 90_000); first.unref();
  const every = setInterval(snapshot, 6 * 60 * 60_000); every.unref();
  return () => { clearInterval(flush); clearTimeout(first); clearInterval(every); };
}
