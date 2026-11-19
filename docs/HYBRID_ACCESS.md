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
| H0 | **Done.** This document in docs/; README self-hosting wording aligned with the product policy |
| H1 | **Done.** Target model: `aiAccess` on hosts (core + Windows/mac models), `targets_list`, capability map |
| H2 | **Done.** Local MCP in wecommander-core: bridge, client allow-list, in-app approvals, SSH read tools + approved exec, audit; Windows UI (AI access section, explanations, setup helper) |
| H3 | **Done.** Remote MCP via “Bu bilgisayar” connector: target publish, gateway routing, approvals (see §8) |
| H4 | **Done** (no undo yet). SFTP write tools `fs_write`, `fs_mkdir`, `fs_move`, `fs_delete` with approvals, local and remote |
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


## 8. As built: H3 (remote through this computer) and H4 (SFTP writes)

- **Connector id.** Turning remote access on in the Windows app stores this computer's Management
  Center id as `aiAccess.connector` (an older `this-computer` value is served by any signed-in
  computer that has the host). `mcp.status.remoteSupported` is `true`.
- **Core RPC** (CORE_PROTOCOL.md): `mcp.remoteTargets {centerId}` → what to publish
  (`hostId, name, preset, sudo, capabilities`; no address, user or key); `mcp.remoteCall {callId,
  centerId, client, tool, args, approved}` → `{ok, result}` / `{ok:false, error, message}`. The
  core re-checks exposure (`remote` + connector), host key, readonly, sudo guard and limits,
  refuses changes without `approved` (`approval_required`) and runs each `callId` once. With
  `args.run_as: "root"` (process_exec, fs_write) it runs through `sudo -n` only when its own
  `sudo` for the host is `sudoers`, else `run_as_root_unavailable` (see §9).
- **Gateway** (`gateway/src/ssh-connector.ts`): `PUT /api/center/connector/targets`,
  `GET /api/center/connector/claim?waitMs≤15000` (long poll; marks the computer online),
  `POST /api/center/connector/calls/:id/result` (Center token only). MCP: `targets_list` lists
  agent devices (`kind: "agent"`, `path_policy: "enforced"`) and the caller's own SSH targets
  (`kind: "ssh"`, `target_id` `ssh-<24 hex>`, `online`, `preset`, `tools`); `fs_list`, `fs_read`,
  `fs_stat`, `server_overview`, `server_disk_usage`, `server_processes`, `process_exec`,
  `fs_write`, `fs_mkdir`, `fs_move`, `fs_delete` take `target` (or `device_id`); other tools answer
  `unsupported_for_target`.
- **Approvals.** A remote change needs the owner's one-time approval (5 min, single use,
  bound to client + target + exact arguments; a write by path, size and SHA-256) unless the
  target's AI permissions in the web panel say otherwise (§9: full trust, or standard trust with
  an allowlisted command). The computer's own timed autonomy is local only. The request appears in the app's approval notifications and on the web
  Approvals page with the server's name (`target_label`, `device_id` is `""`).
- **Offline.** No poll within 45 s, or no claim within 20 s: `connector_offline` with
  “Bu sunucuya erişen bilgisayar şu an kapalı…”; an approval consumed for an undelivered call is
  given back.
- **Limits.** Remote reads ≤ 1 MiB and writes ≤ 1 MiB (gateway body limit); local reads and writes
  ≤ 4 MiB. Writes refuse a symbolic link as the path, deletes never follow links, refuse `/` and the
  home folder and more than 10 000 entries.
- **Linux:** the Management Center (`tray/`) holds the app core (`wc-app-core`) in process, with its
  own host store in `<config dir>/core` (keyring service `app.wecommander`). The connector loop is
  `wc_app_core::mcp::connector` (same behaviour as the Windows `RemoteConnector`: publish on change
  and every minute, long-poll claim, `remote::call`, post with retries, never approves; backoff
  5 s doubling to 60 s, 30 s on a refused token; stops on sign-out). Its "SSH sunucuları" tab imports
  `~/.ssh/config` or adds a server, connects once to verify the login and trust the host key, shares
  a host with remote AI (preset read only / with approval, sudo never / sudoers) and shows the
  connector's status. Not on Linux yet: local MCP (H2) and the E2E library sync, so hosts saved on
  another computer are not listed there.
- **macOS (H3 parity with Windows):** the Mac app runs the same connector loop
  (`center-macos/Sources/CenterCore/RemoteConnector.swift`, an actor; started while signed in,
  cancelled on sign-out or when the account/server changes): it publishes `mcp.remoteTargets`
  (again when changed or after 60 s), long-polls the claim (12 s), runs each call once through
  `mcp.remoteCall` and posts the result (network errors: two more tries). It never approves:
  `approved` is passed through as the gateway sent it. Errors back off 5, 10, 20, 40, then 60 s;
  a refused token waits 30 s (the app signs out). Main window → **Yapay zekâ erişimi** lists the
  saved hosts: share with remote AI (stored with this Mac's Center id as `connector`), preset
  (Salt okunur / Onaylı; a timed preset set elsewhere is kept and shown as local-only), sudo,
  the blockers with their fix, the guarantees and the SSH limit (same texts as Windows), and the
  connector's status (connected / last contact / last call / last error). Host cards show the
  “Uzak YZ” badge. Approval notifications and the panel name SSH approvals “web-1 · SSH” and show
  a move as `a → b` and a write by path, size and SHA-256. Local MCP (H2) has no Mac UI yet: the
  Mac keeps a host's `local` flag as it is.

## 9. AI permissions of SSH targets (web panel)

Each shared SSH target has the same AI permissions as an agent device (docs/AI_PERMISSIONS.md),
set on the web **Devices** page under *SSH servers* (grouped by the computer they go through):

- **Stored** on `connector_targets` per (organization, computer, host id): `trust_level`
  (`strict|standard|full`), `trust_full_until`, `run_as` (`user|root`), `safety_net`,
  `safety_net_allow_power`; the allowlist in `connector_target_command_allowlist`. Unsharing a
  host on the computer deletes them; sharing it again starts at standard / user / safety net on.
- **Who:** only the owner of that computer (SSH targets are personal), with the admin role, from
  a browser session (CSRF); widening (full, root, safety net off, power allowed) needs the current
  password. Audited (`ssh_target.trust_level|run_as|safety_net`, `ssh_command_allowlist.add|
  remove`) and widening is e-mailed to admins and owners. REST: `GET /api/ssh-targets`,
  `PUT /api/ssh-targets/:target/trust|run-as|safety-net`, `GET|POST /api/ssh-targets/:target/
  command-allowlist`, `DELETE …/command-allowlist/:id`.
- **Order of a call** (gateway): role → arguments → **readonly preset (always wins)** → safety net
  (process_exec) → run as root (needs the computer's `sudo: sudoers`) → offline → full trust (no
  approval, audit `trusted_full`) / standard + allowlisted command (`allowlisted`) / approval.
  The call goes to the computer with `approved: true` and, for root, `run_as: "root"`; the
  approval request shows `runAs: "root"`.
- **Two keys for root:** the computer reports `sudo` per host when it publishes; root is accepted
  only while that is `sudoers`, a republish with `never` sets the target back to user (audit
  `ssh_target.run_as` / `fallback`), and the core refuses `run_as: "root"` on its own unless its
  setting allows it. As root, `process_exec` runs `sudo -n -- sh -c <command>` and `fs_write`
  writes through one `sudo -n sh` (no link, regular file, `expected_sha256`, folders; an existing
  file keeps its owner and mode). `fs_mkdir`, `fs_move`, `fs_delete` and reads stay the SSH user;
  the server tools keep using sudo as before when `sudo: sudoers`.
- **Safety net:** `safety-net.ts` is applied by the gateway to SSH `process_exec`. The core has no
  copy (the setting lives in the gateway); the core's sudo guard and readonly checks still apply.
- `targets_list` shows `trust`, `trust_full_until` (full), `run_as`, `root_capable` (= `sudo`
  is `sudoers`) and `safety_net` for SSH targets.
