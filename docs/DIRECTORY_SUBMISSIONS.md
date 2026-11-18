# AI directory listings: v1.0 launch kit (23 November 2026)

WECOMMANDER is a remote MCP server (`https://wecommander.app/mcp`, OAuth
sign-in). This page has everything the directories ask for, so each
submission is copy and paste. Nothing here has been submitted yet unless the
console says so (Growth → Directories, `/console/growth/directories`).

## Özet (Türkçe): sırayla ne yapacaksın

1. **Yayına al (deploy).** Bu değişiklik `/server.json` adresini ve
   güncellenmiş `llms.txt`'i ekliyor. Deploy'dan ~45 sn sonra gateway kendini
   resmi MCP Registry'ye `app.wecommander/wecommander` adıyla 1.0.0 olarak
   kaydediyor. Log'da `MCP Registry: listed 1.0.0` satırını gör. Kontrol:
   https://registry.modelcontextprotocol.io/v0/servers?search=app.wecommander
   (Liste görünmezse aşağıdaki "Official MCP Registry → elle yayın" adımları.)
2. **İnceleme hesabını hazırla** (bir kez, ~15 dk): `review@wecommander.app`,
   Pro plan (konsoldan, ücretsiz), bir Linux demo cihazı. Ayrıntı:
   "Reviewer test account" bölümü. Claude ve ChatGPT başvuruları bunu istiyor.
3. **Ekran görüntülerini çek** (~10 dk): "Screenshots" bölümündeki 5 görüntü.
   Repodaki eski `gateway/test-artifacts/*.png` dosyaları eski arayüzden;
   yenilerini çek.
4. **Claude connectors directory** başvurusu (en önemli; inceleme sürer, erken gönder).
5. **ChatGPT apps** başvurusu (önce ChatGPT geliştirici modunda bağlanıp dene).
6. **Kısa formlar** (her biri ~5 dk): Smithery, mcp.so, Glama, PulseMCP,
   MCP Market, Cursor directory, LobeHub. Çoğu resmi registry'den de
   okuyor; yine de form doldurmak listelemeyi hızlandırıyor.
7. Her gönderimden sonra konsolda Growth → Directories sayfasında durumu
   "submitted" + tarih yap; yayına girince "listed" + adresi yaz.

Her dizin için yapıştırılacak metinler aşağıda İngilizce. Adresi "check"
olarak işaretlenenlerin tam gönderim sayfasından emin değilim: sitenin ana
sayfasındaki "Submit" / "Add server" düğmesini kullan.

## Shared facts (paste into any form)

| Field | Value |
|---|---|
| Name | WECOMMANDER |
| Server URL | `https://wecommander.app/mcp` |
| Transport | Streamable HTTP |
| Authentication | OAuth 2.1 with dynamic client registration (no API key). Discovery: `https://wecommander.app/.well-known/oauth-protected-resource`, `https://wecommander.app/.well-known/oauth-authorization-server`. Scope: `mcp:tools` |
| MCP Registry name | `app.wecommander/wecommander` |
| server.json | `https://wecommander.app/server.json` (same file: `server.json` at the repository root) |
| Version | 1.0.0 (v1.0 launch: 23 November 2026) |
| Website | https://wecommander.app |
| Documentation | https://wecommander.app/docs |
| Install the agent | https://wecommander.app/install |
| Security model | https://wecommander.app/security |
| Pricing | https://wecommander.app/pricing (Free, Pro and Team plans) |
| Privacy policy | https://wecommander.app/privacy |
| Terms | https://wecommander.app/terms |
| Refunds | https://wecommander.app/refund |
| Support | destek@wecommander.app |
| Publisher | WebRising (Türkiye) |
| Source code | Closed source (hosted service). Leave "GitHub repository" empty where it is optional |
| Logo (SVG) | `gateway/public/assets/wecommander-favicon.svg` (also served at https://wecommander.app/assets/wecommander-favicon.svg) |
| Logo (PNG 512×512) | `desktop/icons/icon.png` |
| Wordmark | `gateway/public/assets/wecommander-black.svg` (light backgrounds), `gateway/public/assets/wecommander-white.svg` (dark backgrounds) |
| Category | Developer tools. Secondary where offered: DevOps / System administration / Remote access / File system |
| Tags | ssh, server-management, devops, remote-access, terminal, file-system, approvals, audit-log, windows, macos, linux |
| Tool annotations | Every tool has `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (`gateway/src/tool-annotations.ts`, checked by `tool-annotations.test.ts`) |

## Texts

### Name

WECOMMANDER

### Tagline (≤ 80 characters)

Let Claude, ChatGPT and Cursor work on your own machines, with human approvals.

Alternative (77): One MCP URL for your Windows, macOS and Linux machines, with human approvals.

### Short description (≤ 100 characters)

SSH client, server management and one remote MCP URL for your machines, with human approvals.

(This is also the `description` in `server.json`.)

### Medium description (about 300 characters)

WECOMMANDER gives AI assistants one remote MCP URL for your own Windows,
macOS and Linux machines. A small agent on each machine connects out over TLS
(no open ports or VPN), works only in the folders you allow, masks secrets in
output, and waits for your approval before risky actions.

### Long description

> WECOMMANDER lets Claude, ChatGPT, Cursor and other MCP clients work on your
> own Windows, macOS and Linux machines through one MCP URL:
> https://wecommander.app/mcp, with OAuth sign-in.
>
> A small agent on each machine keeps one outbound encrypted connection, so no
> inbound port, VPN or SSH key is needed. It runs as a normal user (not
> root/SYSTEM) and only inside the folders you allow.
>
> Tools: read, write, edit, search and move files (PDF, Word and Excel can be
> read too); run commands; long-running background tasks; interactive
> terminals; process lists; device health snapshots; log search; and server
> management: overview, what fills the disk, a safe cleanup scan, processes
> and service restarts.
>
> Reading needs no approval. High-risk actions (running commands, deleting or
> moving files, stopping processes, opening terminals, cleaning disk space)
> wait for a person to approve that exact action in the web dashboard, by
> e-mail, or as a Windows notification from the Management Center app, unless
> you allow a command pattern or switch a device to autonomous mode for a set
> time. AI clients cannot change these limits themselves. Secrets in command
> and terminal output are masked on the device, every action is in an audit
> log, and file edits keep undo snapshots.
>
> The same account includes the WECOMMANDER desktop app for Windows and macOS:
> an SSH client with SFTP, tunnels, snippets, server disk cleanup and live
> monitoring. On Windows, Hybrid Access can also share SSH servers that have no
> agent with the AI through the desktop app, keeping SSH keys on your computer.
>
> Free, Pro and Team plans. Local mode (stdio, no account) is also available.

Accuracy notes (keep when editing): Hybrid Access is Windows only (not macOS
yet). Approval notifications in the desktop are from the Management Center on
Windows. The desktop SSH app is Windows and macOS (Linux preview); the agent is
Windows, macOS and Linux. No self-hosted edition is offered.

### Example prompts (for listings and reviewers)

1. "Which of my machines are online?" → `devices_list` (read-only)
2. "What is filling the disk on my Ubuntu server?" → `server_overview`, `server_disk_usage` (read-only)
3. "What can be cleaned safely on that server?" → `server_cleanup_scan` (read-only)
4. "Show the last errors of nginx." → `log_query` (read-only)
5. "Clean the apt cache and old journal logs." → `server_cleanup_run` (destructive: waits for approval)

### Setup instructions (for listings that ask "how to connect")

1. Install the agent on a machine: `curl -fsSL https://wecommander.app/install.sh | sh`
   (Windows: `irm https://wecommander.app/install.ps1 | iex`) and approve the
   device in the browser page that opens.
2. Add `https://wecommander.app/mcp` to your AI client as a remote MCP server
   and sign in with your WECOMMANDER account.
3. Ask the AI to work on the machine; approve risky actions when asked.

Client snippets:

- Claude (web, desktop): Settings → Connectors → Add custom connector → `https://wecommander.app/mcp`.
- Claude Code: `claude mcp add --transport http wecommander https://wecommander.app/mcp`
- VS Code: `code --add-mcp '{"name":"wecommander","type":"http","url":"https://wecommander.app/mcp"}'`
- Cursor (`~/.cursor/mcp.json`):

  ```json
  { "mcpServers": { "wecommander": { "url": "https://wecommander.app/mcp" } } }
  ```

- Cursor one-click link (config is base64 of `{"url":"https://wecommander.app/mcp"}`; test it in Cursor before publishing it):
  `cursor://anysphere.cursor-deeplink/mcp/install?name=wecommander&config=eyJ1cmwiOiJodHRwczovL3dlY29tbWFuZGVyLmFwcC9tY3AifQ==`

## Screenshots

Capture fresh ones before submitting (PNG, 1280×800 or larger, light theme,
no personal data, demo account). The files in `gateway/test-artifacts/` are
from an older UI build; use them only as a guide to framing.

1. **AI at work:** a Claude (or ChatGPT) chat answering "What is filling the
   disk on my Ubuntu server?" with the tool results. (guide: none in repo)
2. **Approval:** the approval request for prompt 5 at https://wecommander.app/approvals
   (guide: `gateway/test-artifacts/modern-approvals.png`).
3. **Devices:** the devices page with the demo machine online
   (guide: `gateway/test-artifacts/modern-devices.png`).
4. **Connect page:** the MCP connection page showing the URL
   (guide: `gateway/test-artifacts/modern-mcp.png`).
5. **Audit log** (guide: `gateway/test-artifacts/modern-audit.png`) or the
   desktop app with a terminal and the Dock.

Store them outside the repository or under `docs/listing/` if you want them
versioned. Forms that want a single cover image: use number 1.

## Reviewer test account (prepare before submitting)

- A dedicated account `review@wecommander.app` on the Pro plan (no charge:
  plan set in the console), password shared only in the submission form.
- One enrolled demo Linux device with sample folders and logs, so every
  read-only tool returns data. Approval requests from the reviewer arrive at
  the account's e-mail and dashboard; the reviewer approves them in the web
  dashboard (https://wecommander.app/approvals) to test the destructive path.
- Steps for reviewers (paste into the form):
  1. Add `https://wecommander.app/mcp` as a connector; sign in with the account.
  2. Ask the example prompts 1–4: answers come without approval.
  3. Ask prompt 5: the assistant reports that approval is needed; approve it at
     https://wecommander.app/approvals, then ask again: it runs and reports the
     freed space.

## Directories

Status values to record in the console: not_submitted → submitted (date) →
listed (URL) or rejected (note).

### 1. Official MCP Registry (feeds VS Code, GitHub, PulseMCP and other galleries)

- **Where:** https://registry.modelcontextprotocol.io (no web form; API / `mcp-publisher` CLI)
- **How it is done here:** automatic. About 45 s after the production gateway
  starts it logs in with HTTP domain proof (`/.well-known/mcp-registry-auth`,
  Ed25519 key derived from the gateway's server secret, nothing to store) and
  publishes `registryServerJson()` from `gateway/src/mcp-registry.ts`, once per
  `REGISTRY_LISTING_VERSION` (now `1.0.0`). Gateway log line:
  `MCP Registry: listed 1.0.0 (...)`. `MCP_REGISTRY_DISABLED=true` turns it off.
- **What is published:** `server.json` at the repository root, also served at
  https://wecommander.app/server.json:

  ```json
  {
    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    "name": "app.wecommander/wecommander",
    "title": "WECOMMANDER",
    "description": "SSH client, server management and one remote MCP URL for your machines, with human approvals.",
    "version": "1.0.0",
    "websiteUrl": "https://wecommander.app/",
    "remotes": [{ "type": "streamable-http", "url": "https://wecommander.app/mcp" }]
  }
  ```

- **Check:** https://registry.modelcontextprotocol.io/v0/servers?search=app.wecommander
- **Changing the listing:** edit `registryServerJson()`, bump
  `REGISTRY_LISTING_VERSION` (the registry refuses the same version twice),
  regenerate the root `server.json` (the test `mcp-registry.test.ts` fails
  until it matches), deploy.
- **Manual publish (only if the automatic one fails, e.g. the log shows
  `login refused`).** The registry's DNS proof works without the gateway
  secret. On a computer with OpenSSL and the `mcp-publisher` CLI (releases at
  https://github.com/modelcontextprotocol/registry):
  1. `openssl genpkey -algorithm Ed25519 -out wecommander-registry.pem` (keep this file private, outside the repo).
  2. Print the DNS record:
     `echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in wecommander-registry.pem -pubout -outform DER | tail -c 32 | base64)"`
  3. Add it as a TXT record on `wecommander.app` (Cloudflare / DNS provider), wait for it to resolve.
  4. From the repository root:
     `mcp-publisher login dns --domain wecommander.app --private-key $(openssl pkey -in wecommander-registry.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')`
  5. `mcp-publisher publish` (reads `./server.json`).
  6. Check the URL above. If the registry says the version exists already,
     the automatic publish has worked: nothing to do.

### 2. Claude connectors directory (Anthropic, claude.ai)

- **Where:** check. Start from Anthropic's help center (support.claude.com,
  search "remote MCP server submission" / "connectors directory"); it links
  the current submission form and the review criteria.
- **Paste:** Name, tagline, short and long description, server URL, auth:
  OAuth (dynamic client registration), logo SVG/PNG, screenshots 1–4, example
  prompts 1–5, privacy policy, terms, support e-mail, reviewer account and
  steps, category Developer tools.
- **Steps:**
  1. Connect it yourself first: claude.ai → Settings → Connectors → Add custom
     connector → `https://wecommander.app/mcp`; run prompts 1–5.
  2. Go through Anthropic's pre-submission checklist (tool annotations,
     OAuth, error messages, privacy policy): all are in place.
  3. Fill in the form and submit; record "submitted" in the console.

### 3. ChatGPT apps / connectors (OpenAI)

- **Where:** https://platform.openai.com (Apps / app submission page: check;
  docs at https://developers.openai.com/apps-sdk).
- **Paste:** Name, tagline, short and long description, MCP server URL, auth:
  OAuth, logo PNG 512×512, screenshots 1–4, example prompts, privacy policy,
  terms, support e-mail, countries (your choice), reviewer account
  and steps.
- **Steps:**
  1. In ChatGPT, turn on developer mode (Settings → Apps & Connectors →
     Advanced) and create a connector with `https://wecommander.app/mcp`
     (OAuth); run prompts 1–5.
  2. On the OpenAI platform, verify the organization if asked, create the
     app with the same URL, fill in the directory details and submit.

### 4. Smithery

- **Where:** https://smithery.ai/new (check)
- **Paste:** choose the option for an existing remote / hosted server (URL),
  server URL, name, short description, long description, logo, tags. Auth:
  OAuth (no API key field).
- **Steps:** sign in with GitHub, add the server by URL, check that Smithery's
  scan lists the tools (sign-in may be needed for the tool list), publish.

### 5. mcp.so

- **Where:** https://mcp.so/submit (check)
- **Paste:** name, website https://wecommander.app, server URL, short and long
  description, category Developer tools, tags, logo URL
  https://wecommander.app/assets/wecommander-favicon.svg.
- **Steps:** sign in, fill in the form, submit.

### 6. Glama

- **Where:** https://glama.ai/mcp/servers ("Add server": check; Glama lists
  mainly GitHub repositories, a remote-only server may need the connector /
  remote option or a message to their support).
- **Paste:** name, server URL, auth OAuth, short and long description, logo,
  website.

### 7. PulseMCP

- **Where:** https://www.pulsemcp.com/submit (check). PulseMCP also imports
  the official MCP Registry, so the listing may appear by itself.
- **Paste:** name, website, server URL, short description, remote: yes, auth: OAuth.

### 8. MCP Market

- **Where:** https://mcpmarket.com (submit page: check)
- **Paste:** name, website, server URL, tagline, long description, category
  Developer tools, logo, tags.

### 9. Cursor directory

- **Where:** https://cursor.directory/mcp (submit button: check)
- **Paste:** name, short description, the Cursor `mcp.json` snippet above,
  website, logo.
- **Steps:** test the one-click link in Cursor first; include it only if it
  opens the install prompt.

### 10. LobeHub MCP market

- **Where:** https://lobehub.com/mcp (submit button: check)
- **Paste:** name, server URL, description, tags, logo, website.

### 11. VS Code / GitHub MCP gallery

- **Where:** https://github.com/mcp (check). Fed by the official MCP Registry;
  no separate form expected. Record "listed" once WECOMMANDER appears there.

### Search and AI crawlers

Bing / Copilot / ChatGPT search: IndexNow announcement after each deploy
(`/<key>.txt`), automatic. `https://wecommander.app/llms.txt` names the MCP
URL, the registry name and the 1.0 release.
