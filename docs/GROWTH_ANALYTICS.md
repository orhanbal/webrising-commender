# Growth (Büyüme) in the platform console

The super admin console (`/console/growth…`) has a **Growth** group with eight
pages: Overview, Traffic & sources, AI crawlers, AI connections, Downloads,
Usage & retention, Feedback and Directories. Each page has a 7 / 30 / 90 day
range. Code: `gateway/src/growth.ts` (database, routes, timers),
`gateway/src/growth-classify.ts` (pure rules, unit tested in
`growth.test.ts`) and `gateway/ui/src/pages/Growth.tsx`.

## Privacy rules (KVKK / GDPR)

- No cookies, no local storage, no third-party scripts, no fingerprinting.
- Nothing per visitor is stored: no IP address, no full user agent, no full
  referrer URL, no visitor or session id. The beacon's rate limit uses the
  caller's address as an **in-memory** key only (never written anywhere).
- Only daily aggregate counters are stored: `analytics_daily(day, kind, key,
  count)`. Keys are limited to known public page paths, a referrer *host*
  (classified into AI assistant / search / social / direct / other), sanitized
  `utm_source` / `utm_medium` / `utm_campaign` values, fixed crawler names and
  fixed AI client names.
- Private pages (console, dashboard, account pages) are never counted.
- Days are UTC. Counters are kept about two years, app check-ins 400 days
  (`housekeeping()`).

Because no personal data is processed for the web analytics, no consent banner
is needed. The privacy policy may still mention "aggregate, cookieless page
counts" for transparency (legal CMS, not changed by this feature).

## What is counted, and where

| Kind (`analytics_daily.kind`) | Key | Source |
|---|---|---|
| `pv` | page path | server-rendered first hit of a public page + `POST /api/t` beacon on in-app navigation |
| `visit`, `landing`, `source` | bucket, landing path, `bucket:source` | arrivals from outside the site (referrer host or `utm_source`, e.g. `utm_source=chatgpt.com` counts as ChatGPT) |
| `utm_source`, `utm_medium`, `utm_campaign` | sanitized value | page URL |
| `crawler`, `crawler_path` | crawler name, `name path` | every GET/HEAD by a known AI or search crawler user agent (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, anthropic-ai, PerplexityBot, Perplexity-User, Google-Extended, Googlebot, Bingbot, Applebot(-Extended), Meta-ExternalAgent, Amazonbot, CCBot, Bytespider, DuckAssistBot, MistralAI-User, cohere-ai, …); path is `/llms.txt`, `/sitemap.xml`, `/robots.txt`, `/.well-known/*`, `/mcp`, a public page, `assets` or `other` |
| `install` | `/install.sh`, `/install.ps1`, `/install/<file>` | install script fetches (GET) |
| `mcp_call` | `claude`, `chatgpt`, `cursor`, `vscode`, `windsurf`, `other`, `api_token`, `web`, `app` | every MCP `tools/call` |
| `dl_total`, `dl_platform`, `dl_format`, `dl_version` | cumulative GitHub download counts | snapshot of the releases API every 6 h (`max` upsert); daily downloads are the difference between consecutive days |

Counters are buffered in memory and written every 30 s (and on shutdown) with
one multi-row upsert.

The beacon (`POST /api/t`, always `204`) accepts exactly
`{"p": path, "r": referrer, "q": query string}` (≤ 2 KB; extra fields are
refused), ignores bot user agents and unknown paths, and is limited to 60
requests per 10 minutes per address. The web app sends it with
`navigator.sendBeacon` on route changes only; the first page is counted by the
server when it renders the HTML (prefetches, non-document requests and bots
are skipped).

## Other tables

- `center_daily(day, center_id, platform, app_version, language)`: one row per
  desktop app and day it calls `GET /api/center/me`. `platform` is the existing
  query parameter; apps may also send `version` and `lang` (optional).
- `oauth_clients.client_kind`: which AI client registered an OAuth client,
  derived from its redirect URI host (claude.ai / claude.com, chatgpt.com,
  `cursor://`, `vscode://` …) and then its name. Set at registration; older
  rows are filled in when the AI connections page is opened.
- `growth_directories`: status of each AI app / MCP directory
  (`not_submitted`, `submitted` + date, `listed` + https URL, `rejected` +
  note), edited on the Directories page (`POST /api/console/growth/directories`,
  audited in `platform_admin_audit`). The official MCP Registry is seeded as
  listed; its live status is read from
  `registry.modelcontextprotocol.io/v0/servers?search=app.wecommander/wecommander`
  and cached for an hour.

## Usage definitions

- **DAU / WAU / MAU:** enabled users whose latest activity (sign-in, web
  session last seen, desktop app last seen) is within 1 / 7 / 30 days.
- **Retention:** sign-ups grouped by week (Monday, UTC); day 7 (30) is the
  share of accounts at least 7 (30) days old whose latest activity is 7 (30)
  or more days after sign-up. Only the latest activity is known, so this is
  "still active after day N", not a daily return curve.
- **Funnel:** visits and downloads (+ install script fetches) in the period;
  sign-ups in the period, of those how many belong to a workspace with a
  device, and how many to a workspace on an active paid plan.

## Settings

- `GROWTH_DOWNLOAD_SNAPSHOT_DISABLED=true` turns off the GitHub snapshot
  (self-hosted or air-gapped gateways).

## Console API (platform administrators only)

`GET /api/console/growth/{overview,traffic,crawlers,connections,downloads,usage,feedback}?days=7|30|90`,
`GET /api/console/growth/directories`, `POST /api/console/growth/directories`.
