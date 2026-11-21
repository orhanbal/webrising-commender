import test from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
const classify = await import("./growth-classify.js");
const growth = await import("./growth.js");
const { FixedWindowRateLimiter } = await import("./rate-limit.js");
const {
  classifyReferrer, classifyCrawler, isBotUserAgent, normalizePagePath, cleanUtm, pageViewIncrements, crawlerPathKey,
  installKey, clientKind, classifyAsset, releaseDownloadStats, dailyDeltas, cohortRetention, weekStart, CounterBuffer,
  counterUpsert, parseRegistryListing, dayRange, fillSeries,
} = classify;

const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const self = "wecommander.app";
type Captured = { text: string; values: unknown[] };
const fakeQuery = (captured: Captured[], rows: unknown[] = []) =>
  async (text: string, values: unknown[] = []) => { captured.push({ text, values }); return { rows: rows as any[], rowCount: rows.length }; };

test("referrers are classified into AI assistants, search, social, direct, internal and other", () => {
  const cases: Array<[string, string, string]> = [
    ["https://chatgpt.com/", "ai", "ChatGPT"],
    ["https://chat.openai.com/c/abc", "ai", "ChatGPT"],
    ["https://claude.ai/chat/1", "ai", "Claude"],
    ["https://www.perplexity.ai/search?q=x", "ai", "Perplexity"],
    ["https://gemini.google.com/app", "ai", "Gemini"],
    ["https://copilot.microsoft.com/", "ai", "Copilot"],
    ["https://you.com/search", "ai", "You.com"],
    ["https://www.phind.com/", "ai", "Phind"],
    ["https://chat.deepseek.com/", "ai", "DeepSeek"],
    ["https://grok.com/", "ai", "Grok"],
    ["https://www.meta.ai/", "ai", "Meta AI"],
    ["https://chat.mistral.ai/chat", "ai", "Mistral"],
    ["https://www.google.com.tr/", "search", "Google"],
    ["https://www.bing.com/", "search", "Bing"],
    ["https://duckduckgo.com/", "search", "DuckDuckGo"],
    ["https://yandex.com.tr/", "search", "Yandex"],
    ["https://t.co/xyz", "social", "X"],
    ["https://www.linkedin.com/feed", "social", "LinkedIn"],
    ["https://news.ycombinator.com/item?id=1", "social", "Hacker News"],
    ["https://github.com/orhanbal", "other", "github.com"],
    ["https://wecommander.app/pricing", "internal", "wecommander.app"],
    ["", "direct", "direct"],
    ["android-app://com.google.android.gm", "direct", "direct"],
    ["not a url", "direct", "direct"],
  ];
  for (const [ref, bucket, source] of cases) assert.deepEqual(classifyReferrer(ref, self), { bucket, source }, ref);
  // utm_source=chatgpt.com (added by ChatGPT search) wins over any referrer.
  assert.deepEqual(classifyReferrer("https://www.google.com/", self, "chatgpt.com"), { bucket: "ai", source: "ChatGPT" });
  assert.deepEqual(classifyReferrer(null, self, "perplexity"), { bucket: "ai", source: "Perplexity" });
  assert.deepEqual(classifyReferrer(null, self, "newsletter"), { bucket: "direct", source: "direct" });
});

test("AI crawler and search engine user agents are named; browsers are not", () => {
  const cases: Array<[string, string]> = [
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "GPTBot"],
    ["Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)", "OAI-SearchBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "ChatGPT-User"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot"],
    ["Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)", "Claude-User"],
    ["Mozilla/5.0 (compatible; Claude-SearchBot/1.0)", "Claude-SearchBot"],
    ["anthropic-ai", "anthropic-ai"],
    ["Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "PerplexityBot"],
    ["Mozilla/5.0 (compatible; Perplexity-User/1.0)", "Perplexity-User"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot"],
    ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Bingbot"],
    ["Mozilla/5.0 (Macintosh) AppleWebKit (KHTML, like Gecko) Version/17 Safari (Applebot/0.1)", "Applebot"],
    ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "Meta-ExternalAgent"],
    ["Mozilla/5.0 (compatible; Amazonbot/0.1)", "Amazonbot"],
    ["CCBot/2.0 (https://commoncrawl.org/faq/)", "CCBot"],
    ["Mozilla/5.0 (Linux; Android 5.0) (compatible; Bytespider; spider-feedback@bytedance.com)", "Bytespider"],
    ["DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)", "DuckAssistBot"],
    ["Mozilla/5.0 (compatible; MistralAI-User/1.0)", "MistralAI-User"],
    ["cohere-ai", "cohere-ai"],
  ];
  for (const [ua, name] of cases) {
    assert.equal(classifyCrawler(ua), name, ua);
    assert.equal(isBotUserAgent(ua), true, ua);
  }
  assert.equal(classifyCrawler(chrome), null);
  assert.equal(isBotUserAgent(chrome), false);
  for (const ua of ["", "x", "curl/8.4.0", "python-requests/2.31", "Mozilla/5.0 HeadlessChrome/120", "Go-http-client/1.1", "UptimeRobot/2.0"])
    assert.equal(isBotUserAgent(ua), true, ua);
});

test("only public page paths and clean utm values become counter keys", () => {
  assert.equal(normalizePagePath("/"), "/");
  assert.equal(normalizePagePath("/pricing/"), "/pricing");
  for (const p of ["/console", "/console/users", "/dashboard", "/api/me", "/pricing?x=1", "", 42, "/" + "a".repeat(300)])
    assert.equal(normalizePagePath(p), null, String(p));
  assert.equal(cleanUtm(" ChatGPT.com "), "chatgpt.com");
  assert.equal(cleanUtm("spring launch"), "spring_launch");
  assert.equal(cleanUtm("<script>"), null);
  assert.equal(cleanUtm("a".repeat(100))?.length, 64);
  assert.equal(crawlerPathKey("/llms.txt"), "/llms.txt");
  assert.equal(crawlerPathKey("/sitemap.xml"), "/sitemap.xml");
  assert.equal(crawlerPathKey("/server.json"), "/server.json");
  assert.equal(crawlerPathKey("/.well-known/oauth-authorization-server"), "/.well-known/*");
  assert.equal(crawlerPathKey("/pricing"), "/pricing");
  assert.equal(crawlerPathKey("/dashboard"), "other");
  assert.equal(installKey("/install.sh"), "/install.sh");
  assert.equal(installKey("/install/agent.cmd"), "/install/agent.cmd");
  assert.equal(installKey("/install/../etc/passwd"), null);
});

test("a page view from outside counts the page, the visit, its source and utm values", () => {
  assert.deepEqual(pageViewIncrements({ path: "/pricing", referrer: "https://claude.ai/chat/9", search: "?utm_source=newsletter&utm_medium=email&utm_campaign=Launch", selfHost: self }), [
    { kind: "pv", key: "/pricing" },
    { kind: "visit", key: "ai" },
    { kind: "landing", key: "/pricing" },
    { kind: "source", key: "ai:Claude" },
    { kind: "utm_source", key: "newsletter" },
    { kind: "utm_medium", key: "email" },
    { kind: "utm_campaign", key: "launch" },
  ]);
  // Internal navigation: the page only.
  assert.deepEqual(pageViewIncrements({ path: "/features", referrer: "https://wecommander.app/", selfHost: self }), [{ kind: "pv", key: "/features" }]);
  // Direct visit: no source key.
  assert.deepEqual(pageViewIncrements({ path: "/", selfHost: self }).map((i) => i.kind), ["pv", "visit", "landing"]);
  assert.deepEqual(pageViewIncrements({ path: "/console", referrer: "https://chatgpt.com/", selfHost: self }), []);
});

test("beacon: validated, bots ignored, private pages ignored, rate limited per address", () => {
  growth.counters.drain();
  const limiter = new FixedWindowRateLimiter();
  const headers = { "user-agent": chrome };
  assert.equal(growth.handleBeacon(JSON.stringify({ p: "/pricing", r: "https://wecommander.app/", q: "" }), headers, "a", self, limiter), "counted");
  assert.deepEqual(growth.counters.drain().map((r) => [r.kind, r.key, r.count]), [["pv", "/pricing", 1]]);
  assert.equal(growth.handleBeacon(JSON.stringify({ p: "/pricing" }), { "user-agent": "GPTBot/1.0" }, "a", self, limiter), "ignored");
  assert.equal(growth.handleBeacon(JSON.stringify({ p: "/dashboard" }), headers, "a", self, limiter), "ignored");
  assert.equal(growth.handleBeacon("{not json", headers, "a", self, limiter), "invalid");
  assert.equal(growth.handleBeacon(JSON.stringify({ p: "/", id: "visitor-123" }), headers, "a", self, limiter), "invalid", "extra fields (identifiers) are refused");
  assert.equal(growth.handleBeacon(JSON.stringify({ p: "x".repeat(201) }), headers, "a", self, limiter), "invalid");
  assert.equal(growth.counters.size, 0);
  for (let i = 0; i < 60 - 6; i++) growth.handleBeacon(JSON.stringify({ p: "/" }), headers, "a", self, limiter);
  assert.equal(growth.handleBeacon(JSON.stringify({ p: "/" }), headers, "a", self, limiter), "rate_limited");
  assert.equal(growth.handleBeacon(JSON.stringify({ p: "/" }), headers, "b", self, limiter), "counted", "other addresses are not affected");
  growth.counters.drain();
});

test("server-rendered first hits skip prefetches, sub-resources and bots", () => {
  growth.counters.drain();
  growth.recordServerPageView("/", "?utm_source=chatgpt.com", { "user-agent": chrome, "sec-fetch-dest": "document" }, self);
  growth.recordServerPageView("/", "", { "user-agent": chrome, "sec-purpose": "prefetch" }, self);
  growth.recordServerPageView("/", "", { "user-agent": chrome, "sec-fetch-dest": "iframe" }, self);
  growth.recordServerPageView("/", "", { "user-agent": "ClaudeBot/1.0" }, self);
  growth.recordRequest("GET", "/llms.txt", { "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)" });
  growth.recordRequest("POST", "/llms.txt", { "user-agent": "ClaudeBot/1.0" });
  growth.recordInstallFetch("/install.sh");
  growth.recordMcpCall({ authKind: "oauth", oauthClientKind: "claude" });
  growth.recordMcpCall({ authKind: "token" });
  const rows = growth.counters.drain().map((r) => `${r.kind}=${r.key}:${r.count}`).sort();
  assert.deepEqual(rows, [
    "crawler=ClaudeBot:1", "crawler_path=ClaudeBot /llms.txt:1", "install=/install.sh:1", "landing=/:1",
    "mcp_call=api_token:1", "mcp_call=claude:1", "pv=/:1", "source=ai:ChatGPT:1", "utm_source=chatgpt.com:1", "visit=ai:1",
  ]);
});

test("counter buffer merges increments and builds one upsert per flush", async () => {
  const buffer = new CounterBuffer(3);
  buffer.add("pv", "/", 1, "2026-11-01");
  buffer.add("pv", "/", 2, "2026-11-01");
  buffer.add("pv", "/pricing", 1, "2026-11-01");
  buffer.add("pv", "/", 1, "2026-11-02");
  assert.equal(buffer.add("pv", "/features", 1, "2026-11-02"), false, "key cap");
  assert.equal(buffer.add("pv", "/", 1, "2026-11-02"), true, "existing keys still count");
  const rows = buffer.drain();
  assert.deepEqual(rows, [
    { day: "2026-11-01", kind: "pv", key: "/", count: 3 },
    { day: "2026-11-01", kind: "pv", key: "/pricing", count: 1 },
    { day: "2026-11-02", kind: "pv", key: "/", count: 2 },
  ]);
  assert.equal(buffer.size, 0);
  const add = counterUpsert(rows)!;
  assert.match(add.text, /^insert into analytics_daily\(day,kind,key,count\) values \(\$1::date,\$2,\$3,\$4::bigint\),\(\$5/);
  assert.match(add.text, /on conflict \(day,kind,key\) do update set count=analytics_daily\.count\+excluded\.count$/);
  assert.deepEqual(add.values, ["2026-11-01", "pv", "/", 3, "2026-11-01", "pv", "/pricing", 1, "2026-11-02", "pv", "/", 2]);
  assert.match(counterUpsert(rows, "max")!.text, /greatest\(analytics_daily\.count,excluded\.count\)/);
  assert.equal(counterUpsert([]), null);

  growth.counters.drain();
  growth.counters.add("pv", "/");
  const captured: Captured[] = [];
  assert.equal(await growth.flushCounters(fakeQuery(captured)), 1);
  assert.equal(captured.length, 1);
  assert.equal(await growth.flushCounters(fakeQuery(captured)), 0);
  assert.equal(captured.length, 1, "nothing to write, no query");
});

test("daily downloads come from cumulative snapshots", () => {
  assert.deepEqual(dailyDeltas([
    { day: "2026-11-03", key: "all", count: 130 },
    { day: "2026-11-01", key: "all", count: 100 },
    { day: "2026-11-02", key: "all", count: 110 },
    { day: "2026-11-02", key: "windows", count: 5 },
    { day: "2026-11-04", key: "all", count: 120 }, // an asset was deleted: never negative
  ]), [
    { day: "2026-11-02", key: "all", count: 10 },
    { day: "2026-11-03", key: "all", count: 20 },
    { day: "2026-11-04", key: "all", count: 0 },
  ]);
  const days = dayRange(3, new Date("2026-11-17T12:00:00Z"));
  assert.deepEqual(days, ["2026-11-15", "2026-11-16", "2026-11-17"]);
  assert.deepEqual(fillSeries(days, [{ day: "2026-11-17", count: 2 }, { day: "2026-11-17", count: 1 }, { day: "2026-10-01", count: 9 }]), [0, 0, 3]);
});

test("release assets are grouped by platform, format and version", () => {
  assert.deepEqual(classifyAsset("WECOMMANDER-Center-windows-x64.zip"), { platform: "windows", format: "zip" });
  assert.deepEqual(classifyAsset("WECOMMANDER.msix"), { platform: "windows", format: "msix" });
  assert.deepEqual(classifyAsset("WECOMMANDER-Center-macos.zip"), { platform: "macos", format: "zip" });
  assert.deepEqual(classifyAsset("WECOMMANDER-Center.pkg"), { platform: "macos", format: "pkg" });
  assert.deepEqual(classifyAsset("wecommander-agent_0.1.1835_amd64.deb"), { platform: "linux", format: "deb" });
  assert.equal(classifyAsset("SHA256SUMS.txt"), null);
  assert.equal(classifyAsset("WECOMMANDER-Center-windows-x64.zip.sha256"), null);
  const stats = releaseDownloadStats([
    { tag_name: "ubuntu-preview-2", assets: [
      { name: "WECOMMANDER-Center-windows-x64.zip", download_count: 40 },
      { name: "wecommander-agent_0.1.2_amd64.deb", download_count: 7 },
      { name: "checksums.txt", download_count: 99 }] },
    { tag_name: "macos-preview-3", published_at: "2026-11-01T00:00:00Z", assets: [{ name: "WECOMMANDER-Center.pkg", download_count: 12 }] },
    { tag_name: "draft", draft: true, assets: [{ name: "x.msix", download_count: 1000 }] },
  ]);
  assert.equal(stats.total, 59);
  assert.deepEqual(stats.byPlatform, { windows: 40, linux: 7, macos: 12 });
  assert.deepEqual(stats.byFormat, { "windows:zip": 40, "linux:deb": 7, "macos:pkg": 12 });
  assert.deepEqual(stats.byVersion.map((v) => [v.tag, v.total]), [["ubuntu-preview-2", 47], ["macos-preview-3", 12]]);
  assert.deepEqual(releaseDownloadStats("nope"), { total: 0, byPlatform: {}, byFormat: {}, byVersion: [] });
});

test("download snapshot stores cumulative totals with keep-the-larger upserts (no real GitHub call)", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify([{ tag_name: "ubuntu-preview-9", assets: [{ name: "WECOMMANDER-Center-windows-x64.zip", download_count: 5 }] }]), { status: 200 });
  }) as unknown as typeof fetch;
  const captured: Captured[] = [];
  assert.equal(await growth.snapshotDownloads(fetcher, fakeQuery(captured)), true);
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /^https:\/\/api\.github\.com\/repos\/orhanbal\/webrising-commender\/releases\?per_page=100&page=1$/);
  assert.match(captured[0]!.text, /greatest/);
  assert.ok(captured[0]!.values.includes("dl_total") && captured[0]!.values.includes("windows:zip"));
  const failing = (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch;
  assert.equal(await growth.snapshotDownloads(failing, fakeQuery(captured)), false);
  assert.equal(captured.length, 1);
});

test("retention: share of each sign-up week active 7 and 30 days later, only for old-enough accounts", () => {
  const now = new Date("2026-11-17T00:00:00Z");
  const day = (d: string) => new Date(d + "T10:00:00Z");
  const rows = cohortRetention([
    { createdAt: day("2026-10-05"), lastActiveAt: day("2026-11-10") }, // active after 36 days
    { createdAt: day("2026-10-06"), lastActiveAt: day("2026-10-15") }, // after 9 days
    { createdAt: day("2026-10-07"), lastActiveAt: day("2026-10-08") }, // after 1 day
    { createdAt: day("2026-10-08"), lastActiveAt: null },
    { createdAt: day("2026-11-12"), lastActiveAt: day("2026-11-16") }, // too new for day 7
  ], now);
  assert.equal(weekStart(day("2026-10-08")), "2026-10-05");
  assert.deepEqual(rows, [
    { week: "2026-11-09", signups: 1, d7Eligible: 0, d7: 0, d7Rate: null, d30Eligible: 0, d30: 0, d30Rate: null },
    { week: "2026-10-05", signups: 4, d7Eligible: 4, d7: 2, d7Rate: 50, d30Eligible: 4, d30: 1, d30Rate: 25 },
  ]);
});

test("OAuth clients are attributed to the AI client from the redirect URI host, then the name", () => {
  assert.equal(clientKind("MCP client", ["https://claude.ai/api/mcp/auth_callback"]), "claude");
  assert.equal(clientKind("x", ["https://claude.com/api/mcp/auth_callback"]), "claude");
  assert.equal(clientKind("ChatGPT", ["https://chatgpt.com/connector_platform_oauth_redirect"]), "chatgpt");
  assert.equal(clientKind("x", ["cursor://anysphere.cursor-retrieval/oauth/callback"]), "cursor");
  assert.equal(clientKind("Visual Studio Code", ["http://127.0.0.1:33418/", "https://vscode.dev/redirect"]), "vscode");
  assert.equal(clientKind("Claude Code", ["http://localhost:5555/callback"]), "claude");
  assert.equal(clientKind("Some tool", ["http://localhost:1/cb"]), "other");
  assert.equal(clientKind(null, "not-an-array"), "other");
});

test("MCP Registry listing is read from the registry response and cached for an hour (no real registry call)", async () => {
  const name = "app.wecommander/wecommander";
  const body = { servers: [
    { server: { name, version: "0.9.0" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: false, publishedAt: "2026-10-01T00:00:00Z" } } },
    { server: { name, version: "1.0.0" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true, publishedAt: "2026-11-01T00:00:00Z" } } },
    { server: { name: "other/thing", version: "9.9.9" } },
  ] };
  assert.deepEqual(parseRegistryListing(body, name), { listed: true, version: "1.0.0", status: "active", publishedAt: "2026-11-01T00:00:00Z", updatedAt: null });
  assert.equal(parseRegistryListing({ servers: [] }, name).listed, false);
  assert.equal(parseRegistryListing(null, name).listed, false);

  growth.resetGrowthCaches();
  let calls = 0;
  const fetcher = (async (url: string) => { calls++; assert.match(String(url), /\/v0\/servers\?search=app\.wecommander%2Fwecommander$/); return new Response(JSON.stringify(body), { status: 200 }); }) as unknown as typeof fetch;
  const first = await growth.registryStatus("https://wecommander.app", fetcher, 1_000_000);
  assert.equal(first.version, "1.0.0");
  await growth.registryStatus("https://wecommander.app", fetcher, 1_000_000 + 30 * 60_000);
  assert.equal(calls, 1, "cached");
  await growth.registryStatus("https://wecommander.app", fetcher, 1_000_000 + 61 * 60_000);
  assert.equal(calls, 2, "refreshed after an hour");
  growth.resetGrowthCaches();
  const down = await growth.registryStatus("https://wecommander.app", (async () => { throw new Error("offline"); }) as unknown as typeof fetch, 5);
  assert.deepEqual([down.listed, down.error], [false, "offline"]);
  growth.resetGrowthCaches();
});

test("directory status API validates input, stores it and audits the change", async () => {
  const schema = growth.directoryUpdateSchema;
  assert.equal(schema.safeParse({ key: "smithery", status: "submitted", submittedAt: "2026-11-17" }).success, true);
  assert.equal(schema.safeParse({ key: "unknown", status: "listed" }).success, false);
  assert.equal(schema.safeParse({ key: "smithery", status: "approved" }).success, false);
  assert.equal(schema.safeParse({ key: "smithery", status: "listed", listingUrl: "http://smithery.ai/x" }).success, false, "https only");
  assert.equal(schema.safeParse({ key: "smithery", status: "listed", listingUrl: "javascript:alert(1)" }).success, false);
  assert.equal(schema.safeParse({ key: "smithery", status: "submitted", submittedAt: "17.11.2026" }).success, false);
  assert.equal(schema.safeParse({ key: "smithery", status: "rejected", note: "x".repeat(501) }).success, false);
  assert.equal(schema.safeParse({ key: "smithery", status: "listed", extra: 1 }).success, false);

  const captured: Captured[] = [];
  await growth.updateDirectory({ key: "glama", status: "submitted", submittedAt: "2026-11-10", listingUrl: "https://glama.ai/x", note: "  sent form  " }, "admin-id", fakeQuery(captured));
  assert.equal(captured.length, 2);
  assert.match(captured[0]!.text, /insert into growth_directories/);
  assert.deepEqual(captured[0]!.values, ["glama", "submitted", "2026-11-10", null, "sent form", "admin-id"], "listing URL only kept when listed");
  assert.match(captured[1]!.text, /platform_admin_audit/);
  assert.deepEqual(captured[1]!.values, ["admin-id", "glama: submitted"]);
  captured.length = 0;
  await growth.updateDirectory({ key: "glama", status: "not_submitted", submittedAt: "2026-11-10" }, "admin-id", fakeQuery(captured));
  assert.equal(captured[0]!.values[2], null, "not submitted clears the date");
  await assert.rejects(growth.updateDirectory({ key: "glama", status: "nope" }, "admin-id", fakeQuery([])));

  const listed = await growth.listDirectories(fakeQuery([], [{ key: "mcp_registry", status: "listed", submitted_at: null, listing_url: "https://registry.modelcontextprotocol.io/v0/servers?search=app.wecommander/wecommander", note: "", updated_at: null }]));
  assert.equal(listed.length, growth.directoryCatalog.length);
  assert.equal(listed.find((d) => d.key === "mcp_registry")!.status, "listed");
  assert.equal(listed.find((d) => d.key === "claude_connectors")!.status, "not_submitted");

  const url = new URL("https://wecommander.app/api/console/growth/directories");
  const bad = await growth.growthConsoleRoute("POST", url, async () => ({ key: "glama", status: "bogus" }), "admin-id", "https://wecommander.app");
  assert.deepEqual(bad, { status: 400, body: { error: "invalid_directory_status" } });
  assert.equal(await growth.growthConsoleRoute("GET", new URL("https://wecommander.app/api/console/growth/unknown"), async () => ({}), "a", "https://wecommander.app"), null);
  assert.equal(growth.rangeDays("30"), 30);
  assert.equal(growth.rangeDays("365"), 7);
});
