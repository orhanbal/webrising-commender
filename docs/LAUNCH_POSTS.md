# Launch posts — WECOMMANDER 1.0 (2026-11-23)

Drafts for launch day. Nothing here is posted automatically. Facts follow
`gateway/src/site-content.ts`: Hybrid Access is Windows only, the Dock is
Windows only (macOS: menu bar), and the Windows getting-started tutorial is
not in 1.0.

Links: public posts point to **https://wecommander.app** (the home page has
the download buttons; `/download` asks for sign-in first, so it is used only in
the mail to existing sign-ups). Character counts below count a URL as 23
characters, as X does.

---

## X / Twitter

### English (≤ 280)

```text
WECOMMANDER 1.0 is out for Windows and macOS.

An SSH client with SFTP and tunnels, server disk cleanup and live monitoring, and one MCP URL that lets Claude, ChatGPT or Cursor work on your machines. Risky steps wait for your approval.

https://wecommander.app
```

### Türkçe (≤ 280)

```text
WECOMMANDER 1.0 Windows ve macOS için yayında.

SFTP ve tünelli SSH istemcisi, sunucu disk temizliği ve canlı izleme, Claude, ChatGPT ya da Cursor'ın makinelerinde çalışması için tek MCP adresi. Riskli adımlar onayını bekler.

https://wecommander.app
```

---

## LinkedIn

### English (~120 words)

```text
Today we are releasing WECOMMANDER 1.0 for Windows and macOS.

It started as a simple question: how do you let an AI assistant help with real servers without handing it an SSH account?

WECOMMANDER 1.0 is three things in one app:

• An SSH client: tabbed and split terminals, drag-and-drop SFTP, tunnels, jump hosts and end-to-end encrypted sync. It works without AI and without an account.
• Server management: see what fills a disk and clean it safely, processes, scheduled tasks and live monitoring (the Dock on Windows, the menu bar on macOS).
• AI with a human in charge: one MCP URL for Claude, ChatGPT and Cursor. Commands, deletions and restarts wait for a one-time approval, and every action is in the audit log.

Six languages. Free plan available.

https://wecommander.app
```

### Türkçe (~120 kelime)

```text
Bugün WECOMMANDER 1.0'ı Windows ve macOS için yayınlıyoruz.

Basit bir soruyla başladı: Bir yapay zekâ asistanına SSH hesabı vermeden gerçek sunucularda nasıl yardım ettirirsin?

WECOMMANDER 1.0 tek uygulamada üç şey:

• SSH istemcisi: sekmeli ve bölünmüş terminaller, sürükle-bırak SFTP, tüneller, jump host ve uçtan uca şifreli eşitleme. Yapay zekâ ve hesap olmadan da çalışır.
• Sunucu yönetimi: diski neyin doldurduğunu gör ve güvenle temizle; süreçler, zamanlanmış görevler ve canlı izleme (Windows'ta Dock, macOS'ta menü çubuğu).
• Kontrolü sende olan yapay zekâ: Claude, ChatGPT ve Cursor için tek MCP adresi. Komut, silme ve yeniden başlatma tek kullanımlık onayını bekler; her işlem denetim kaydında.

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

**First comment (~150 words):**

```text
Hi Product Hunt!

We built WECOMMANDER because we wanted AI help on our own servers without giving an assistant an SSH account and hoping for the best.

What is in 1.0:

• A full SSH client: tabbed and split terminals, drag-and-drop SFTP, local/remote/SOCKS tunnels, jump hosts, snippets and end-to-end encrypted sync. No account needed for the client.
• Server management: what fills the disk, safe cleanup of old logs, package caches and Docker leftovers, processes and scheduled tasks. On Windows, a taskbar-like Dock shows live server charts; on macOS it is in the menu bar.
• AI over MCP: add https://wecommander.app/mcp to Claude, ChatGPT or Cursor. A small agent connects out (no open ports), runs as a normal user in folders you allow, and masks secrets. Reads run directly; commands, deletions and restarts wait for your one-time approval.

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

The AI part: you add one MCP URL (https://wecommander.app/mcp, OAuth). A small agent on each machine keeps one outbound TLS connection, so there are no inbound ports or SSH keys for the AI. It runs as a normal user, only inside folders you allow, and masks common secrets in output before it leaves the machine. Reads run directly. Commands, deletes, moves and restarts wait for a single-use approval bound to that exact action (web dashboard, e-mail or a Windows notification from the desktop app), unless you allow a command pattern or turn on autonomous mode for a set time. Everything goes to an audit log, and file edits keep undo snapshots.

On Windows there is also an agentless path: you can share a saved SSH server through the desktop app, so the connection and keys stay on your computer.

Sync of hosts, keys and snippets is end-to-end encrypted. The account, approvals and MCP endpoint are a hosted service; there is a free plan, and a local stdio MCP mode that needs no account. No self-hosted edition right now.

Happy to answer questions about the approval model or anything else.
```
