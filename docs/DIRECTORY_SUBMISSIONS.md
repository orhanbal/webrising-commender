# AI directory listings: what is ready and what to send

WECOMMANDER is a remote MCP server (`https://wecommander.app/mcp`, OAuth
sign-in). This page has everything the directories ask for, so a submission
is copy and paste.

## Status

| Directory | How it is listed | Status |
|---|---|---|
| Official MCP Registry (feeds VS Code, Cursor and other client galleries) | The gateway publishes `app.wecommander/wecommander` itself after a deploy, proving the domain with `/.well-known/mcp-registry-auth` | automatic (see "MCP Registry" below) |
| Claude connectors directory (Anthropic) | Submitted by the owner from claude.ai (Directory submission portal) | ready to submit |
| ChatGPT apps (OpenAI) | Submitted by the owner from the OpenAI Developer Platform | ready to submit |
| Bing / Copilot / ChatGPT search | IndexNow announcement after each deploy (`/<key>.txt`) | automatic |
| Smithery, Glama, PulseMCP, mcp.so | Most read the official registry; the rest take a short form | after the registry listing |

## Shared facts

- **Name:** WECOMMANDER
- **MCP URL:** `https://wecommander.app/mcp` (Streamable HTTP)
- **Authentication:** OAuth 2.1 with dynamic client registration; discovery at
  `https://wecommander.app/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-authorization-server`. Scope: `mcp:tools`.
- **Website:** https://wecommander.app
- **Privacy policy:** https://wecommander.app/privacy
- **Terms:** https://wecommander.app/terms
- **Refunds:** https://wecommander.app/refund
- **Support:** destek@wecommander.app
- **Publisher:** WebRising (Türkiye)
- **Icon:** `gateway/public/assets/wecommander-favicon.svg` (export a 512×512 PNG for forms that want one)
- **Tool annotations:** every tool has `title`, `readOnlyHint`, `destructiveHint`,
  `idempotentHint` and `openWorldHint` (`gateway/src/tool-annotations.ts`,
  checked against the enforced risk classes by `tool-annotations.test.ts`).

## Short description (≤ 100 characters)

EN: SSH client, server management and one remote MCP URL for your machines, with human approvals.

TR: SSH istemcisi, sunucu yönetimi ve tüm makinelerin için tek MCP adresi; riskli adımlar onayla.

## Long description

EN:

> WECOMMANDER lets Claude work on your own Windows, macOS and Linux machines
> through one MCP URL. A small agent on each machine keeps one outbound
> encrypted connection (no open ports, VPN or SSH keys) and runs as a normal
> user, only inside the folders you allow. Reading files, logs, disk usage and
> server health needs no approval. Running a command, deleting or moving files,
> stopping a process, cleaning disk space or restarting a service waits for a
> person to approve that exact action in the web dashboard, the desktop app or
> by e-mail. Secrets in output are masked on the device, and every action is in
> an audit log with undo snapshots for file edits. The same account includes
> the WECOMMANDER desktop app: an SSH client with SFTP, tunnels, snippets and
> live server monitoring.

TR:

> WECOMMANDER, Claude'un kendi Windows, macOS ve Linux makinelerinde tek bir
> MCP adresiyle çalışmasını sağlar. Her makinedeki küçük agent tek bir giden,
> şifreli bağlantı kurar (port, VPN veya SSH anahtarı gerekmez) ve yalnızca
> izin verdiğin klasörlerde, normal bir kullanıcı olarak çalışır. Dosya, log,
> disk ve sunucu durumu okumak onaysızdır. Komut çalıştırmak, dosya silmek ya
> da taşımak, süreç durdurmak, disk temizlemek veya servis yeniden başlatmak,
> o işlemin tam hâli için bir kişinin web panelinden, masaüstü uygulamasından
> ya da e-postayla onay vermesini bekler. Çıktıdaki gizli bilgiler cihazda
> maskelenir; her işlem denetim kaydına yazılır, dosya düzenlemeleri geri
> alınabilir.

## Example prompts (for the listing and for reviewers)

1. "Which of my machines are online?" → `devices_list` (read-only)
2. "What is filling the disk on my Ubuntu server?" → `server_overview`, `server_disk_usage` (read-only)
3. "What can be cleaned safely on that server?" → `server_cleanup_scan` (read-only)
4. "Show the last errors of nginx." → `log_query` (read-only)
5. "Clean the apt cache and old journal logs." → `server_cleanup_run` (destructive: waits for approval)

## Reviewer test account (to prepare before submitting)

- A dedicated account `review@wecommander.app` on the Pro plan (no charge:
  plan set in the console), password shared only in the submission form.
- One enrolled demo Linux device with sample folders and logs, so every
  read-only tool returns data. Approval requests from the reviewer arrive at
  the account's e-mail and dashboard; the reviewer approves them in the web
  dashboard (https://wecommander.app/approvals) to test the destructive path.
- Step-by-step for reviewers:
  1. Add `https://wecommander.app/mcp` as a connector; sign in with the account.
  2. Ask the example prompts 1–4: answers come without approval.
  3. Ask prompt 5: the assistant reports that approval is needed; approve it at
     /approvals, then ask again: it runs and reports the freed space.

## Claude connectors directory: steps

1. claude.ai → Settings (organization admin) → Directory / submission portal.
2. Choose "Remote MCP server", fill in the shared facts, descriptions, prompts,
   icon, privacy policy, and the reviewer account above.
3. Before sending, run the pre-submission checklist from Anthropic's review
   criteria (tool annotations, OAuth, error handling): all are in place.

## ChatGPT apps: steps

1. platform.openai.com → Apps → New app (Apps SDK, MCP based).
2. MCP connection: the MCP URL and OAuth; test it in ChatGPT developer mode first.
3. Directory details: descriptions, icon, example prompts, privacy policy,
   countries, reviewer account and test steps above.

## MCP Registry

- The listing (`gateway/src/mcp-registry.ts`) is published by the production
  gateway about 45 s after it starts, once per `REGISTRY_LISTING_VERSION`
  (bump it when the listing changes). Result in the gateway log:
  `MCP Registry: listed 1.0.0 (...)`.
- The domain proof key is derived from the gateway's server secret; nothing to
  store or copy. `MCP_REGISTRY_DISABLED=true` turns it off.
- Check: `https://registry.modelcontextprotocol.io/v0/servers?search=app.wecommander`.
