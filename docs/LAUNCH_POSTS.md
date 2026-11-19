# Launch posts — WECOMMANDER 1.0 (2026-11-23)

Drafts for launch day. Nothing here is posted automatically. Facts follow
`gateway/src/site-content.ts` and `docs/AI_PERMISSIONS.md`: Hybrid Access
(AI over SSH with nothing installed on the server) is in the Windows app only
and has no trust levels (every change approved every time); the Dock and its
terminal tabs are Windows only (macOS: menu bar); root is Linux only, with two
keys; the getting-started tutorial is in both apps.

Links: public posts point to **https://wecommander.app** (the home page has
the download buttons; `/download` asks for sign-in first, so it is used only in
the mail to existing sign-ups). Character counts below count a URL as 23
characters, as X does.

---

## X / Twitter

### English (≤ 280)

```text
WECOMMANDER 1.0 is out for Windows and macOS.

An SSH client with SFTP and tunnels, server cleanup and live monitoring, and one MCP URL for Claude, ChatGPT or Cursor on your machines. You set what AI may do per device; risky steps wait for your approval.

https://wecommander.app
```

### Türkçe (≤ 280)

```text
WECOMMANDER 1.0 Windows ve macOS için yayında.

SFTP ve tünelli SSH istemcisi, sunucu temizliği ve canlı izleme, Claude, ChatGPT ya da Cursor için tek MCP adresi. Yapay zekânın yetkisini cihaz başına sen belirlersin; riskli adımlar onayını bekler.

https://wecommander.app
```

---

## LinkedIn

### English (~160 words)

```text
Today we are releasing WECOMMANDER 1.0 for Windows and macOS.

It started as a simple question: how do you let an AI assistant help with real servers without handing it an SSH account?

WECOMMANDER 1.0 is three things in one app:

• An SSH client: tabbed and split terminals, drag-and-drop SFTP, tunnels, jump hosts and end-to-end encrypted sync. It works without AI and without an account.
• Server management: see what fills a disk and clean it safely, processes, scheduled tasks and live monitoring (the Dock on Windows, the menu bar on macOS).
• AI with a human in charge: one MCP URL for Claude, ChatGPT and Cursor, through a small agent or, on Windows, over SSH with nothing installed. You set per device how far AI may go; commands, deletions and restarts wait for a one-time approval, a safety net blocks irreversible commands, and every action is in the audit log.

Six languages. Free plan available.

https://wecommander.app
```

### Türkçe (~140 kelime)

```text
Bugün WECOMMANDER 1.0'ı Windows ve macOS için yayınlıyoruz.

Basit bir soruyla başladı: Bir yapay zekâ asistanına SSH hesabı vermeden gerçek sunucularda nasıl yardım ettirirsin?

WECOMMANDER 1.0 tek uygulamada üç şey:

• SSH istemcisi: sekmeli ve bölünmüş terminaller, sürükle-bırak SFTP, tüneller, jump host ve uçtan uca şifreli eşitleme. Yapay zekâ ve hesap olmadan da çalışır.
• Sunucu yönetimi: diski neyin doldurduğunu gör ve güvenle temizle; süreçler, zamanlanmış görevler ve canlı izleme (Windows'ta Dock, macOS'ta menü çubuğu).
• Kontrolü sende olan yapay zekâ: Claude, ChatGPT ve Cursor için tek MCP adresi; küçük bir ajanla ya da Windows'ta sunucuya hiçbir şey kurmadan SSH ile. Yapay zekânın nereye kadar gidebileceğini cihaz başına sen belirlersin; komut, silme ve yeniden başlatma tek kullanımlık onayını bekler, güvenlik ağı geri dönüşü olmayan komutları engeller, her işlem denetim kaydında.

Altı dil. Ücretsiz plan var.

https://wecommander.app
```

---

## Product Hunt (English)

**Name:** WECOMMANDER

**Tagline (≤ 60):**
`SSH client, server management and AI that asks first` (52 characters)

**Description (≤ 260):**

```text
A desktop SSH client and server manager for Windows and macOS: tabs, SFTP, tunnels, safe disk cleanup and live monitoring. One MCP URL lets Claude, ChatGPT and Cursor work on your machines; commands and deletions wait for your approval.
```

**First comment (~180 words):**

```text
Hi Product Hunt!

We built WECOMMANDER because we wanted AI help on our own servers without giving an assistant an SSH account and hoping for the best.

What is in 1.0:

• A full SSH client: tabbed and split terminals, drag-and-drop SFTP, local/remote/SOCKS tunnels, jump hosts, snippets and end-to-end encrypted sync. No account needed for the client.
• Server management: what fills the disk, safe cleanup of old logs, package caches and Docker leftovers, processes and scheduled tasks. On Windows, a taskbar-like Dock shows live server charts and holds terminal tabs; on macOS it is in the menu bar.
• AI over MCP: add https://wecommander.app/mcp to Claude, ChatGPT or Cursor. A small agent connects out (no open ports), runs as a normal user in folders you allow, and masks secrets; on Windows you can also connect a server over SSH with nothing installed. Reads run directly; commands, deletions and restarts wait for your one-time approval. You choose per device how much to trust the AI, and a safety net blocks irreversible commands.

Six languages, free plan. We would love your feedback!
```

---

## Hacker News

**Title:**
`Show HN: WECOMMANDER – SSH client and MCP server where AI actions need approval`

**First comment:**

```text
Hi HN. WECOMMANDER is a desktop SSH client and server management app for Windows and macOS, plus a remote MCP server so AI clients (Claude, ChatGPT, Cursor) can work on your own machines.

The SSH client stands on its own: tabs and split view, SFTP, local/remote/SOCKS tunnels, jump hosts, SSH agent and FIDO2 keys, Mosh, Telnet and serial. Server management covers disk usage and cleanup (logs, package caches, Docker build cache and unused images through Docker's own prune; running containers and volumes are not touched), processes and systemd timers. Every change shows the exact command before it runs.

The AI part: you add one MCP URL (https://wecommander.app/mcp, OAuth). A small agent on each machine keeps one outbound TLS connection, so there are no inbound ports or SSH keys for the AI. By default it runs as a normal user, only inside folders you allow, and masks common secrets in output before it leaves the machine. Besides files, commands and terminals, the AI can work with scheduled tasks and Docker containers (start, stop, restart, logs; never remove or prune). Reads run directly. Commands, deletes, moves, restarts and container actions wait for a single-use approval bound to that exact action (web dashboard, e-mail or a desktop app notification).

How far the AI may go is set per device in the web panel, never by the AI: strict, standard (allowed command patterns run directly) or full trust, for a set time or without a limit. Root is Linux only and needs two keys: the machine's owner runs the installer with --allow-root on the machine, then an admin turns it on with their password; the agent refuses root actions without both. A safety net, on by default, blocks things like rm -rf /, wiping a disk, reboot or stopping the agent on every level, even as root with full trust. Everything goes to an audit log, and file edits keep undo snapshots.

On Windows there is also an agentless path: you can share a saved SSH server through the desktop app, so the connection and keys stay on your computer. Over SSH every command and change needs an approval each time, and commands run with the SSH user's rights.

Sync of hosts, keys and snippets is end-to-end encrypted. The account, approvals and MCP endpoint are a hosted service; there is a free plan, and a local stdio MCP mode that needs no account. No self-hosted edition right now.

Happy to answer questions about the approval model or anything else.
```
