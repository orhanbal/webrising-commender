# WECOMMANDER Hybrid Access — plan and contract

Status: approved by the owner (2026-11-17) for planning and implementation.
Principle: the connection method and the AI access are separate choices, and every
choice tells the person in plain words what it does, what it needs and what it does
not protect. Nothing changes for existing users: AI access on SSH hosts is off.

## 1. Target model

A **target** is one server/computer the person manages. It has one or more
**access methods** and one **AI access** setting.

```
Target (today: a saved SSH host in the E2E-encrypted library, or an agent device)
  access methods:
    - ssh   : the saved host (address, user, auth) — run by WECOMMANDER's SSH core
    - agent : a paired device (deviceId) — run by the native agent
  ai access (per SSH host, stored in the host record, synced E2E like the rest):
    local   : bool   — AI clients on this computer (local MCP)          default false
    remote  : bool   — AI clients through wecommander.app (remote MCP)   default false
    connector: "this-computer" | <connector device id>                  (remote only)
    preset  : "readonly" | "approval" | "timed"                          default "approval"
    sudo    : "never" | "sudoers"                                        default "never"
```

Agent devices keep their existing per-device policy (allowed roots, writes/commands
switches, allowlist, autonomous mode). Linking an SSH host and an agent device as the
same server is a later, explicit user action (suggested, never automatic).

## 2. What each choice means (UX copy — Turkish source texts, translated via L.T/L.t)

### Add server — connection method

| Option | Title | Explanation shown under it |
|---|---|---|
| SSH | **SSH ile bağlan (ajan gerekmez)** | Sunucuya hiçbir şey kurmadan, adres ve SSH anahtarı ya da parolayla bağlanırsın. Terminal, dosyalar, tüneller ve sunucu yönetimi hemen çalışır. **Sunucuya ajan kurmak istemiyorsan bu yöntemi seç.** |
| Agent | **WECOMMANDER ajanı kur** | Sunucuya küçük bir ajan kurulur; sunucu dışarıya tek bir şifreli bağlantı açar, sana gelen port gerekmez. NAT ve güvenlik duvarı arkasındaki makineler, kalıcı terminaller ve uzun görevler için en güçlü yöntem. **Yapay zekâ için klasör sınırları ve cihaz politikaları yalnızca ajanla tam uygulanır.** |
| Other | **Diğer protokoller** | Mosh (kopan bağlantıda devam eden terminal), Telnet (eski cihazlar) ve seri port (ağ cihazları, kartlar). Yapay zekâ erişimi bu protokollerde yoktur. |

After an SSH host is saved, its card shows **“Bu sunucuya WECOMMANDER ajanını kur”** with:
“Zaten SSH ile bağlısın; ajanı tek tıkla bu bağlantı üzerinden kurabilirsin. Kurulumdan önce
çalışacak komutları gösteririz.” (Phase H6.)

### AI access (SSH host editor → “Yapay zekâ erişimi”)

Header line: “Bağlantı yöntemi ile yapay zekâ erişimi ayrı ayarlardır. Bu sunucuya yapay zekâ
erişimini sen açmadıkça hiçbir yapay zekâ bu sunucuyu göremez.”

| Switch | Explanation |
|---|---|
| **Bu bilgisayardaki yapay zekâlar (yerel MCP)** | Claude Desktop, Claude Code, Codex, Cursor gibi bu bilgisayarda çalışan yapay zekâlar bu sunucuyu kullanabilir. Komutlar ve çıktılar bilgisayarından doğrudan sunucuya gider, WECOMMANDER bulutuna uğramaz. WECOMMANDER açık olmalıdır; onaylar bu uygulamada sorulur. |
| **Uzak yapay zekâlar (ChatGPT web ve mobil, Claude.ai)** | wecommander.app üzerinden bağlanan yapay zekâlar bu sunucuyu kullanabilir. Komut ve çıktı WECOMMANDER sunucusundan geçer (parola ve anahtarlar maskelenir); SSH anahtarın hiçbir zaman buluta gönderilmez, işi aşağıda seçtiğin bağlayıcı yapar. |
| Connector: **Bu bilgisayar** | Bağlantıyı bu bilgisayardaki WECOMMANDER kurar. Bilgisayarın kapalıysa ya da uygulama açık değilse uzak yapay zekâ bu sunucuya ulaşamaz. |
| Connector: **Sürekli açık bağlayıcı** (H5) | Bağlantıyı 7/24 açık bir makinedeki WECOMMANDER bağlayıcısı kurar; bilgisayarın kapalıyken de çalışır. Bağlayıcı yalnız ona verdiğin sunuculara erişebilir. |

Permission preset:

| Preset | Explanation |
|---|---|
| **Salt okunur** | Yapay zekâ dosyaları okuyabilir, klasörleri listeleyebilir, sunucunun durumuna (disk, süreçler, servisler) bakabilir. **Komut çalıştıramaz, dosya yazamaz.** SSH'ta gerçek “salt okunur” ancak komut çalıştırma kapalıyken mümkündür. |
| **Onaylı (önerilen)** | Okuma serbest; komut çalıştırma, dosya yazma, silme ve servis yeniden başlatma her seferinde **tam komutu ve sunucuyu gösteren tek kullanımlık onayla** yapılır. |
| **Süreli otonom** | Seçtiğin süre boyunca (en fazla 8 saat) onay sorulmaz; süre bitince kendiliğinden Onaylı'ya döner. Her işlem yine kaydedilir. |

Sudo: **Asla** (default) — “Yapay zekâ sudo kullanamaz; sudo parolası hiçbir zaman saklanmaz ya da yapay zekâya verilmez.” / **Sunucudaki sudoers izinleri** — “Yalnız sunucuda parolasız izin verdiğin komutlar sudo ile çalışabilir (sudoers). İzinleri sunucuda sen belirlersin.”

Always-on guarantees (shown with a lock, not switchable): “Onay ekranı her zaman tam komutu
gösterir · Çıktıdaki parola, anahtar ve token'lar maskelenir · Her işlem denetim kaydına yazılır
· Sunucunun kimliği (host key) doğrulanmadan yapay zekâ bağlanamaz.”

Honest limit (always shown for SSH): “SSH ile çalıştırılan komutlarda klasör sınırı
uygulanamaz: bir komut, bağlandığın kullanıcının erişebildiği her yere ulaşabilir. Daha sıkı
sınır için bu sunucuya ajan kur ya da yalnız gereken izinlere sahip ayrı bir SSH kullanıcısı
kullan.”

Pre-conditions before AI access can be switched on (blocking, with a fix button each):
host key trusted (“Önce bir kez bağlanıp sunucunun kimliğini onayla”), credential usable
without prompting (saved password/key in the keychain or SSH agent), SSH protocol (not Telnet/
serial/Mosh).

### Server list

Each row: name, address, method badges (“SSH”, “Ajan”), AI badges (“Yerel YZ”, “Uzak YZ via
<connector>”, or “Yalnız elle”), reachability dot (connector online/offline). Hover/tap
explains: “Yapay zekâ bu sunucuya SSH ile, <connector> üzerinden erişir; klasör sınırı yok,
komutlar onaylı.”

## 3. MCP surface

One surface, not `ssh_*` copies.

- New tool **`targets_list`**: AI-visible targets only: `{target_id, name, kind: "agent"|"ssh",
  online, capabilities:{exec, read, write, terminal, persistent_tasks, path_policy:
  "enforced"|"none"}, preset}`.
- Existing tools gain an optional **`target`** argument (agent devices keep `device_id` as an
  alias). Tools a target does not support return `unsupported_for_target` with the reason.
- SSH targets support in phase 1: `targets_list`, `process_exec` (HIGH, approval unless timed),
  `fs_list` / `fs_read` / `fs_stat` (via SFTP, read-only preset OK), `server_overview`,
  `server_disk_usage`, `server_processes` (existing fixed scripts). Writes (`fs_write`,
  `fs_delete`, `fs_move`) via SFTP in phase H4. Terminals later.
- The AI can never change AI access, presets or connector assignments (no such tool exists).

## 4. Local MCP (phase H2) — where it runs

- The desktop app's core (`wecommander-core`) already holds hosts, the keychain vault,
  known_hosts and the SSH engine. The **running app** opens a per-user local endpoint
  (Windows named pipe with an ACL for the current user; Unix socket 0600 in the user's
  runtime dir) and accepts MCP requests there.
- AI clients start **`wecommander-core --mcp-stdio`** (a thin bridge: stdio ↔ the local
  endpoint). If the app is not running, the bridge answers `wecommander_not_running` with the
  text “WECOMMANDER'ı aç; yerel yapay zekâ erişimi uygulama açıkken çalışır.”
- Each connecting client is shown once in the app (“Claude Desktop bu bilgisayardan
  WECOMMANDER'a bağlanmak istiyor”) and must be allowed; the decision is remembered per client
  name and can be revoked in Settings → Yapay zekâ.
- Approvals for HIGH actions are shown by the app (dialog / notification with Onayla/Reddet),
  bound to (client, target, exact command/arguments), single use, 5-minute expiry.
- Audit: appended locally (no file contents) and, when signed in, synced to the workspace audit
  log with origin `local-mcp`.
- Setup helper in Settings → Yapay zekâ: “Claude Desktop'a ekle”, “Claude Code'a ekle”,
  “Cursor'a ekle”, “Codex'e ekle”: writes/merges the client's MCP config (shows the exact
  change first) and explains each client in one line.

## 5. Remote MCP via connector (phase H3: this computer; H5: always-on connector)

- The connector publishes only AI-exposed targets to the gateway: `{target_id (random, stable),
  name, capabilities, preset}` — never address, user or credentials.
- Remote MCP tool calls with an SSH `target` are routed by the gateway to that connector over
  the existing authenticated channel (Center: WebSocket/claim, H5: agent relay), with the same
  server-side approval system (approval bound to target + exact args, single use).
- Connector offline → `connector_offline` (fail closed, no queueing for interactive calls).
- Always-on connector (H5) = the native agent with `--ssh-connector`: same pairing, WSS,
  revocation and policy chain; headless vault (systemd-creds / TPM-sealed file, else 0600 root
  file with a warning).

## 6. Phases (each with its own security + regression tests)

| ID | Scope |
|---|---|
| H0 | This document in docs/; README self-hosting wording aligned with the product policy |
| H1 | Target model: `aiAccess` on hosts (core + Windows/mac models), `targets_list`, capability map |
| H2 | Local MCP in wecommander-core: bridge, client allow-list, in-app approvals, SSH read tools + approved exec, audit; Windows UI (AI access section, explanations, setup helper) |
| H3 | Remote MCP via “Bu bilgisayar” connector: target publish, gateway routing, approvals |
| H4 | SFTP write tools with approvals and undo where possible |
| H5 | Always-on connector (agent `--ssh-connector`), headless vault |
| H6 | Unified server inventory + “Ajanı SSH ile kur” |
| H7 | Central signed audit sync, session recording |
| later | SSH certificates, AWS SSM, WinRM |

Security tests from H1 on: TOFU refused for AI, target outside the exposed set refused,
approval replay refused, approval bound to args (changing one byte invalidates it), AI cannot
reach settings, `terminal_input` cannot bypass approvals, bridge refuses when app closed,
unknown local client refused until allowed.

## 7. Core ↔ app contract for H1/H2 (wecommander-core JSON-lines RPC, docs/CORE_PROTOCOL.md style)

- Host records gain `aiAccess: { local: bool, remote: bool, connector: "this-computer" | string,
  preset: "readonly" | "approval" | "timed", timedUntil: string|null (RFC 3339), sudo: "never" | "sudoers" }`
  (absent = all off). Synced with the E2E library like other host fields (merge = last writer wins
  per host, as for other host options).
- `hosts.setAiAccess { id, aiAccess }` → host list. Refuses `local`/`remote` true unless: protocol is
  ssh, host key is trusted (known_hosts entry), and a silent login is possible (saved secret, key
  without passphrase prompt, or SSH agent). Error codes: `host_key_untrusted`, `needs_credential`,
  `not_ssh`. `timed` requires `timedUntil` ≤ now + 8 h.
- `mcp.status` → `{ enabled, endpoint, bridgeCommand: [exe, "--mcp-stdio"], clients: [...] }`.
- `mcp.clients` → `[{ id, name, version, allowed, firstSeen, lastSeen }]`; `mcp.allowClient { id, allow }`;
  `mcp.forgetClient { id }`.
- `mcp.configFor { client: "claude-desktop" | "claude-code" | "cursor" | "codex" }` →
  `{ path, before, after }` (the app shows the diff, then calls `mcp.writeConfig { client }`).
- Events (core → app): `mcp-client-request { id, name, version }` (an unknown client connected;
  its requests wait up to 2 min for allow/deny), `mcp-approval { approvalId, clientName, targetId,
  targetLabel, tool, summary, command, expiresAt }`, `mcp-activity { clientName, targetLabel, tool,
  outcome }` (for an in-app activity list).
- `mcp.decide { approvalId, approve }`.
- Local audit: `<data-dir>/mcp-audit.jsonl` (tool, target, risk, outcome, client, time; never file
  contents or command output).
