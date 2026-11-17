# Changelog

## 1.0.0 — release notes (tagged after device acceptance)

WECOMMANDER 1.0 is one desktop app (Windows, macOS) plus a non-root agent (Linux, Windows, macOS):

- **SSH client:** saved servers with groups and tags, tabs and split view, SFTP, local/remote/SOCKS tunnels, jump hosts, Telnet, serial and Mosh, SSH agent login (OpenSSH agent, Pageant, macOS, FIDO2), session logs, terminal themes, autocomplete from history and snippets, `~/.ssh/config` import, backup export/import.
- **Server management:** overview, disk analysis and safe cleanup with progress (logs, package caches, Docker per daemon including rootless Docker), processes and zombie fixes, Coolify support.
- **Live monitoring:** a server box on the desktop (bottom left) with live line charts for CPU, memory and disk, and a tray panel next to the app.
- **AI over MCP:** one MCP address for Claude, ChatGPT, Cursor and other clients, for every machine. Reads run without approval; commands, deletion, cleanup and restarts need a one-time server-side approval (web, app, e-mail), or autonomous mode for a set time.
- **Sync and teams:** end-to-end encrypted library sync, team library and shared terminals, audit log with versions and undo.
- **Plans:** Free, Pro and Team through Paddle (Merchant of Record), 14-day refund; Terms of Service and Privacy Policy on the site and at checkout.
- **Updates:** the apps update themselves with a progress window; GitHub keeps the newest 10 preview releases per channel (daily clean-up).

## Unreleased

- **Dock: reorder on the Dock itself (Windows):** press a module button (Task Manager, Timers, Scheduled tasks, Terminal, Approvals) and move it a few pixels to drag it along the Dock (row or column; fixed, auto-hide and floating); the other buttons step aside to show where it lands, release drops it and the order is saved (hidden parts keep their places) and the Dock is rebuilt. A plain click still clicks; Esc or a lost pointer cancels. Keyboard: Alt + Left/Right (Alt + Up/Down on a side Dock) on a focused module button moves it one place. The app icon, server picker and settings button do not move. The drop-slot computation is in `DockLayout.DropSlot` with tests; CI's Dock check drags a button with real mouse input on a top and a left Dock and checks the saved order.
- **Hybrid Access H0–H2 (core):** plan and contract in docs/HYBRID_ACCESS.md; the README no longer presents self-hosting as an offered edition. Saved SSH hosts gain `aiAccess` (local/remote, connector, preset readonly/approval/timed, sudo never/sudoers; absent = off, old files load unchanged, synced with the personal E2E library, never in the team library or backups) and `hosts.setAiAccess`, which refuses non-SSH hosts, untrusted host keys and hosts that cannot log in silently. `wecommander-core` now serves local MCP on a per-user endpoint (named pipe with a current-user DACL on Windows, 0600 Unix socket elsewhere); AI clients start `wecommander-core --mcp-stdio`, a bridge that answers `wecommander_not_running` while the app is closed. Tools on exposed hosts: `targets_list`, `fs_list`, `fs_read`, `fs_stat` (SFTP), `server_overview`, `server_disk_usage`, `server_processes`, and `process_exec` with a one-time in-app approval bound to the exact call, readonly/timed presets, a sudo guard and output redaction. Unknown AI clients wait for an in-app decision (`mcp-client-request`, `mcp.allowClient`); every call is written to `mcp-audit.jsonl` and sent as `mcp-activity`. `mcp.configFor` / `mcp.writeConfig` add WECOMMANDER to Claude Desktop, Claude Code, Cursor and Codex without touching their other settings (atomic write, `.bak`).

- **Landing page and AI-readable site facts:** the live-monitoring card now describes the Dock (Windows) and the menu bar (macOS) with the quick panel, Task Manager and schedulers, instead of the removed desktop corner box; a new "Scheduled tasks" card; snippets and session logs moved into the SSH card; /llms.txt facts list scheduled tasks, server timers and the six languages.
- **Growth (Büyüme) in the super admin console:** a new "Growth" group with Overview (visits, AI-referred visits, downloads, sign-ups, DAU/WAU/MAU, active devices, NPS with sparklines), Traffic & sources (incl. which AI assistant sent how many visits, utm values, pages), AI crawlers (GPTBot, ClaudeBot, PerplexityBot, … and what they read: llms.txt, sitemap, pages), AI connections (users and workspaces per AI client from the OAuth redirect host, MCP tool calls per client per day), Downloads (GitHub release download counts per platform, package and version, daily snapshots; install script fetches), Usage & retention (app check-ins per platform/version/language, devices per platform, weekly retention cohorts, visits → downloads → sign-ups → first device → paid funnel), Feedback (all CSAT/NPS answers with comments, NPS trend, app error reports grouped by message) and Directories (MCP Registry checked live, Claude, ChatGPT, Smithery, mcp.so, Glama, PulseMCP, LobeHub, Cursor, VS Code — status editable and audited). Privacy first: server-side and cookieless, no IP addresses, user agents or visitor ids are stored, only daily aggregate counters (`analytics_daily`), so no consent banner is needed; the web app sends a tiny first-party beacon (`POST /api/t`) on route changes. Details in `docs/GROWTH_ANALYTICS.md`.

- **Dock quick panel and Zamanlayıcılar (Windows):** the Dock's WECOMMANDER icon opens a quick panel next to it (away from the Dock's edge, closes when it loses the focus) with My servers, Terminals, File manager, Task Manager, Timers, Server timers, Disk and cleanup, Notifications / pending approvals, Settings and "Open WECOMMANDER". It only opens screens; nothing risky runs from it.
  - **Timers (this computer's Windows Task Scheduler):** name, folder, state, next and last run, last result (hex and meaning), author, triggers and actions; Windows' own tasks are hidden unless "Show Windows tasks" is on; history when Windows keeps it. Run now, enable/disable, new task (once, daily, weekly, at sign-in) and edit, each after a confirmation showing the exact `schtasks` command. Tasks are created in `\WECOMMANDER\` for the signed-in user and keep running when WECOMMANDER is closed; only those can be deleted. Names, programs and arguments are checked strictly and passed one by one (no shell); tasks that need administrator rights say so. CI runs `--task-scheduler-selftest` (create, find, run, disable/enable, edit, delete, refuse deleting a Windows task).
  - **Dock order:** the Dock's sections are reordered by drag and drop in Settings → Dock (or with the arrows) and shown or hidden there; the Dock is rebuilt at once. A new "Timers" shortcut opens the Timers window.

- **Scheduled tasks (server):** WECOMMANDER's own scheduled tasks, stored on the server and run when due: cron (5 fields, time zone and daylight saving aware), every N minutes, or once. Device tasks run on the device's agent even while your computer is off; tasks for saved SSH hosts are queued for the desktop app, which runs them with its own credentials. Creating a task (after a confirmation that shows the exact command and target) is the approval for its runs; every run is audited, output is scrubbed and the last 64 KiB kept, an offline device means one missed run (no catch-up), and failures are e-mailed. Web panel page "Scheduled tasks" in six languages with a live next-five-runs preview, run now and run history. API and app contract: `docs/SCHEDULED_TASKS.md`.
- **Scheduled tasks (Windows app):** a new "Zamanlanmış görevler" page in the main window and a "tasks" Dock button for WECOMMANDER's own scheduled tasks (stored on the server, not the Windows Task Scheduler).
  - **Page:** each task shows its target, the schedule in words, the next run in local time and the last result (Başarılı / Başarısız / Kaçırıldı / Çalışıyor); on/off switch, run now, run history with the full output, edit and delete (with a confirmation).
  - **Editor:** targets are agent devices and this computer's saved SSH hosts; schedules are daily, weekly, every N minutes, once or a cron expression, with the next five runs from the server as you type; timeout and notification. Before saving, a confirmation shows the exact command and target. Viewers see the tasks read-only.
  - **SSH runner:** while signed in, the app claims runs queued for its saved SSH hosts every 30 seconds, runs each in the background with the saved login (never asking for a password; a host that needs one fails with a clear message), and reports the exit code and the last 64 KiB of output.
  - **Core:** new `hosts.exec` method in wecommander-core: one command over an SSH exec channel (no terminal, no startup command, no history entry, no session log), stdout and stderr interleaved, the last 64 KiB kept, and a timeout that stops the command; errors carry a code such as `needs_credential` or `host_key_unknown`.
- **Windows tray icon always visible:** Windows 11 hides a new notification icon in the overflow (^). The first time Windows lists the Management Center icon, the app marks it shown next to the clock (the same switch as Settings › Personalization › Taskbar); after that the person's own choice wins.
- **Task Scheduler (server management, Windows):** a "Zamanlayıcılar" page lists the server's systemd timers, disabled and not-loaded ones included (shown as "Pasif"), with schedule, next and last run in local time, the service's user and command, last result and its journal; the login user's own timers and cron (crontab, /etc/crontab, /etc/cron.d, cron.hourly/daily/weekly/monthly) are listed read only. Timers can be enabled, disabled, run now and stopped; WECOMMANDER creates its own timers in /etc/systemd/system (marked `# Managed by WECOMMANDER`, calendar checked with `systemd-analyze` first) and edits or deletes only those. Every change needs root or passwordless sudo and shows the exact command first. New core calls: `server.timers`, `server.timerAction`, `server.timerLogs`, `server.timerCreate`, `server.timerEdit`, `server.timerDelete`; the Dock can open the page with `GoTo("timers")`.

- **Windows notification area:** only the Management Center icon stays there. The second live-server icon next to the clock and the server box at the bottom left are removed; the live servers and their panel are in the Dock.
- **macOS UI snapshots:** `--snapshot` opens every page of the main window and the panel, saves a PNG of each as the app draws it (no Screen Recording permission needed) and lists the texts each page shows. The macOS CI runs it in Turkish and English and fails when a page does not open or draw.
- **macOS fix:** the main window's sidebar (Servers, Keys, Identities, Tunnels, Settings…) and the server management sidebar did not react to clicks on macOS 26: their rows were tagged with an optional value the list no longer matches. Rows now carry the plain value.
- **Dock Task Manager (Windows):** the Dock's processes button opens a Task Manager for this computer.
  - **What it shows:** live CPU, memory and disk per process (every 2 s), search, sorting, a process tree and details (parent, threads, private memory, start time, path).
  - **Ending a process:** only after a confirmation that names the process and its child count. Windows system processes, databases and WECOMMANDER's own processes are protected and cannot be ended. A PID that now belongs to another process is refused, and missing admin rights are said plainly.
  - **Servers:** a server chosen in the device list opens in its own process screen, so local and remote processes are never one list. "Windows Task Manager" opens Windows' own.
  - **CI:** on a real Windows runner the app starts a child process, finds it under itself, refuses lsass and itself, refuses a stale PID, ends the child, and shows the window listing its own PID.
- **macOS menu bar server monitor:** watched servers show live next to the clock (the worst of CPU, memory and disk, coloured). The panel lists CPU, memory, disk, network, a CPU history line and zombie processes; servers are added from its + menu. Until one is chosen, the first three servers that connect without asking are watched, as on Windows.
- **macOS in-app messages and surveys:** the console's messages, tips, announcements and surveys (faces 1–5, 0–10) appear bottom left of the main window, once per app run; links open only over https.
- **macOS server management:** the "Sunucu yönetimi" button on an SSH terminal opens its own window, as on Windows.
  - **Pages:** overview with live CPU, memory, network and disk charts; disk drill-down by folder with each Docker daemon's storage marked; safe cleanup per Docker daemon (rootless too) with the disk before and after; processes with zombie groups, their owner and the Coolify `--init` fix.
  - **Safety:** every change shows the exact command and asks first; changes are off when the login is neither root nor passwordless sudo; the core alone decides what can be cleaned.
  - **Closing the window** stops the live sampling; closing the terminal closes its window.
  - **Tests:** `ServerManagementTests` cover the core's JSON, the cleanup sections, groups, the space freed and sizes.
- **macOS app in six languages:** the same six languages as Windows, with the same translations for shared texts.
  - **Choosing the language:** the system language by default, English when it is not supported. Change it in the panel's settings or in the main window's Settings → Language.
  - **No restart:** the menu, the panel and the main window switch at once. If terminals are open, the main window waits until they are closed so no scrollback is lost.
  - **What stays as is:** terminal output, paths, commands and the Keychain item label.
  - **Tests:** `LocalizationTests` fail on a missing text, a changed placeholder or spacing, or Turkish text left outside `L.t`/`L.f`.
- **Windows app in six languages:** English, Türkçe, Deutsch, Português (Brasil), Español and Français.
  - **Choosing the language:** the first start follows the Windows display language, falling back to English. You can change it under Settings → Language ("Same as Windows" or one of the six).
  - **No restart:** a change applies at once to the tray menu, the panel, the Dock and the server panel. The main window is rebuilt as well; if terminal tabs are open, the app asks first.
  - **What stays as is:** terminal output, server output, paths and commands are never translated.
  - **Tests:** the Core tests fail when Turkish text is left outside `L.T`/`L.F`, when a language is missing a text, or when a translation changes a placeholder or the spacing.

- Website and web app in six languages: English, Türkçe, Deutsch, Português (Brasil), Español, Français.
  - **Language choice:** `?lang=`, then the saved choice, then the browser language (de-AT → de, pt-PT → pt-BR); English for anything else. Switching takes effect immediately, without reloading.
  - **Loading:** the large tables load only for the chosen language.
  - **Formats:** dates and numbers follow the language, and Paddle checkout opens in it.
  - **Legal pages:** shown in English with a "the English version is binding" note in the other languages.
  - **Other pages:** the unsubscribe page and the survey card are translated. The platform console stays Turkish or English.
  - **Search engines:** public pages carry hreflang alternates.
  - **CI:** a test fails when a language misses a text, or when a placeholder, link or command changes in a translation.

- Landing page redesign:
  - the original logos of the AI clients (Claude, ChatGPT, Cursor, GitHub Copilot, Gemini, Windsurf; LobeHub Icons, MIT);
  - a new "Inside the app" showcase with three tabs: server management with the cleanup list, live monitoring with the Dock and flowing charts, and the terminal;
  - feature icons each in their own colour, and a hero with a soft grid;
  - plan cards with their features and a "Most popular" Pro card;
  - a second "Download the app" button at the end;
  - a five-column footer;
  - the masked-secrets point in the security list instead of self-hosting, and the Dock in the live-monitoring text.

- AI discoverability: every MCP tool carries MCP annotations (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), derived from and tested against the enforced risk classes (also in the local stdio tool list); `serverInfo.title` is WECOMMANDER. The gateway lists itself in the official MCP Registry as `app.wecommander/wecommander` (domain proof at `/.well-known/mcp-registry-auth`, key derived from the server secret, once per listing version) and announces the public pages to Bing & co. through IndexNow after a deploy. The site title and description use the new positioning. `docs/DIRECTORY_SUBMISSIONS.md`: the Claude connectors directory and ChatGPT apps submission kit.

- Windows: **WECOMMANDER Dock** (off by default; Settings → Dock or the Dock's right-click menu). Our own bar on a screen edge, not the Windows taskbar: **fixed** (a Windows AppBar through `SHAppBarMessage`; windows do not cover it, the strip goes back when the Dock closes or the app quits, and it registers again after Explorer restarts), **auto-hide** (slides out at the edge, with show/hide delays) or **floating** (dragged anywhere, remembers its place and monitor, offers to fix itself to an edge it is left near). Top, bottom, left or right, on any monitor (per-monitor DPI); steps aside for full-screen apps and games. It shows the watched server's live CPU / RAM / Disk with the server box's line charts (same data, no second connection), opens Sunucularım from the WECOMMANDER icon next to the button, and goes straight to Süreçler, disk analysis or (disk ≥ 90 %) cleanup, the terminal and pending approvals. Nothing risky runs from a single click. Settings: mode, edge, monitor, size, delays, on top (floating), full screen, theme, parts and their order, start with Windows. The server box steps aside while the Dock is on (it carries the same meters). `WecommanderCenter.exe --quit` closes the running app properly.

- Releases: the `release-retention` workflow deletes preview releases (and their tags) beyond the newest 10 per channel once a day (and on demand); `center-linux-latest` and `macos-center-latest` stay.

- Installer banner: always the WECOMMANDER icon with the name and what is being installed; the wide block-letter wordmark is gone (it rendered too coarse).

- Windows agent update: when this Windows user is already paired, the Setup's post-install step restarts the background agent with the new version and keeps the pairing without showing the "Cihaz Bağlantısı" dialog (one confirmation message instead). The Start menu "WECOMMANDER Cihaz Bağlantısı" shortcut still opens the dialog to pair again.

- Management Center (Windows, macOS, Linux): the agent card shows the installed agent version and has an **Ajanı güncelle** (or **Ajanı kur**) button. It opens the official one-line agent installer for the center's server in a PowerShell window (Windows, asks for UAC) or Terminal (macOS / Linux, asks for the administrator password); the device keeps its enrollment.

- Windows Management Center installer: a running copy that cannot be closed (typically one an earlier install started from an administrator PowerShell) is reported with what to do instead of a locked-file error, and the installer now always starts the app as the signed-in user (through Explorer when run as administrator), so later updates from a normal PowerShell can close it.

- Windows Management Center installer: upgrading over a running copy no longer stops with "access denied" on a locked DLL (`clrjit.dll`). It closes every running copy (also ones whose path it cannot read), waits until they have exited, and retries the removal for up to 10 s; if the files are still in use it says to quit the app from the tray and run the command again.

- Installers show the WECOMMANDER logo in the terminal: the wordmark (block characters) when the window is at least 100 columns wide, otherwise the icon with the name and what is being installed. All five one-line installers (`center.ps1`, `center.sh`, `install.ps1`, `ubuntu.sh`, `macos.sh`); the PowerShell scripts stay ASCII and build the block characters at run time.

- Management Center (Windows, macOS, Linux): "Bu bilgisayardaki ajan" card with the agent's state (çalışıyor / durdu / kapalı / kurulu değil) and an **Ajan çalışsın** switch, also in the tray / menu bar menu, plus a warning bar with "Ajanı başlat" while the agent is not running. Switched on, the Windows and macOS centers keep the agent running: when it stops they start it again (after 0 s, 30 s, 2 min) and say so in a notification, or say once that it could not be started. Switched off (after a confirmation), the agent stops and stays off at the next sign-in. Windows: the per-user scheduled task (no admin), or the legacy service through a UAC prompt; macOS: the LaunchAgent `tr.webrising.commender` via launchctl; Linux: `webrising-commender.service` via `pkexec systemctl` (systemd restarts crashes itself, the center reports a stop).

- `health_snapshot` is quieter on Docker hosts (B12): bind mounts and container mounts of one disk are listed once (`mountCount`, `alsoMountedAt`), container/VM interfaces (`veth*`, `br-*`, `docker*`, `cni*`, `virbr*`, ...) are one summed entry with `interfaceCount`, and same-named processes are one row in the top lists with `count` and up to five `pids`.

- Management Center for Linux desktops (x86_64, WebKitGTK 4.1): the tray app (`tray/`) is built and published as `WECOMMANDER-Center-linux-x86_64.tar.gz` (in each `ubuntu-preview-N` and the fixed `center-linux-latest` release). Each approval request is a desktop notification with **Onayla / Reddet / Aç** actions (freedesktop, works on GNOME, KDE and most desktops) and its deadline. A request decided on another computer or in the web panel replaces its notification in place ("macOS'tan onaylandı · cihaz"), and one answered here is not announced again. The center reports its platform (`linux`). The one-line installer `curl -fsSL https://wecommander.app/install/center.sh | sh` now also installs it on Linux, for the current user under `~/.local`, with a menu entry, and starts it. It verifies the SHA-256 checksum and asks for `libwebkit2gtk-4.1-0` if it is missing.

- Approvals (B03, second part): when an approved operation cannot be delivered because the device is offline (or the gateway is overloaded), the approval is no longer used up. The request goes back to approved with its operation, the AI client gets the request id and "retry when the device is online", and the audit log records `approval_restored`. A timeout after sending still counts as used, since the operation may have run.

- Security (B03, first part): the Agent keeps a journal of used approval nonces on disk (`webrising-commender/approval-nonces/` in the local data directory, expired entries dropped at start). An approval runs one operation also on the Agent side: a replayed token is refused ("approval token was already used"), even after an Agent restart. Nonces must be 16–128 URL-safe characters.

- Security (B01): an AI typing into a live terminal (`terminal_input`) now needs human approval for that exact input, like `process_exec`. Before, once a terminal was open, the AI could type any command without approval. The Agent enforces it too, so a request that skips the gateway is refused. Autonomous mode (`full` trust) still allows it without asking. Approval screens (web panel, Management Center for Windows and macOS, e-mail) show the text that would be typed, as one line (⏎ for Enter).

- Management Center (Windows and macOS): when a request shown on several computers is decided on one of them, the others drop its notification and show a short one saying where it was decided ("macOS'tan onaylandı · cihaz", "Windows'tan reddedildi", "Web panelinden onaylandı"). Gateway: `GET /api/approval-requests/{id}` (also for center tokens) returns the outcome and `decided_via`; decisions record the deciding center; centers report their platform (`macos`/`windows`) when they link and on `/api/center/me`.

- Discoverability for search engines and AI assistants: public pages arrive as readable HTML (no JavaScript needed) with their own title, description, canonical URL and JSON-LD (SoftwareApplication, Organization, FAQPage, HowTo); `/robots.txt` (AI crawlers explicitly allowed, account areas excluded), `/sitemap.xml`, `/llms.txt` and `/llms-full.txt`; new pages Docs, FAQ, Alternatives (by category, no product names), Security and four guides, linked from the header and footer.

- Web: faster page changes (the current page stays until the next is ready, page code is preloaded in the background, built assets are cached for a year and sent brotli/gzip compressed); account pages send a signed-out visitor, or an expired session, to the login page and back afterwards instead of showing a sign-in card inside the panel; quieter, product-style site header.

- Management Center for Windows is now a native WinUI 3 app (`center-windows/`): Windows notifications with Onayla / Reddet that disappear when a request is decided elsewhere, an acrylic panel on the right edge, native controls and confirmation dialogs, tray icon and menu, sign in through the browser, token encrypted with DPAPI, start with Windows. The one-line installer installs it (a self-contained .zip, no runtime needed); `-Tauri` keeps the earlier tray app.

- Management Center: sign in and out are visible: "Oturumu kapat" next to the account in the panel header (with confirmation) and "Oturum aç… / Oturumu kapat (e-posta)" in the tray menu. Signing out revokes the center token on the server.

- Management Center: the window is now a side panel like the Windows notification center: full height on the right edge above the taskbar, no title bar, not on the taskbar, closes when you click elsewhere, with Esc or ×; the tray icon opens and closes it. Windows 11 look (acrylic background, Fluent controls, system light/dark theme). On Windows each approval request is a Windows notification with **Onayla / Reddet** buttons that stays on screen until answered; the panel no longer jumps up for each request while notifications are on. Fixed: a red "0" badge when nothing waited. The original WECOMMANDER logo in the panel header and the favicon as the tray, app and notification icon (red dot: approvals waiting, orange dot: autonomous mode on).

- Management Center (tray app, `tray/`, Windows first): browser sign-in, every pending approval with Approve/Deny and a countdown, a desktop notification and the window to the front for each new request, autonomous mode (scope, 30 min … indefinite, Stop all, also from the tray menu), the device list, start with Windows, and a tray icon that turns orange while autonomous mode is on. Install: `irm https://wecommander.app/install/center.ps1 | iex` (current user, no administrator rights, SHA-256 checked). Gateway: center link flow, `wmc_` tokens limited to approvals/autonomy/devices, Management Centers list with revoke on the Approvals page.

- Windows onboarding: the allowed folder defaults to `%USERPROFILE%\WECOMMANDER` (created if missing; the profile or a drive root is refused), and a pairing for another server is backed up instead of reused. Expired approval requests leave the pending list and answer `approval_request_expired`.

- Autonomous mode: switch approvals off for all or selected devices for 30 min / 1 h / 4 h / until 09:00 / indefinitely, with one-click "Stop all", a banner on every dashboard page, password to enable, admin e-mails, and automatic expiry that is audited. AI clients cannot turn it on.

- `health_snapshot`: when the OS reports no available memory (seen on macOS 26, shown as 100 % used), estimate it as total minus used and say so in `limitations`.

- macOS: the default allowed folder is now `~/WECOMMANDER`. In `~/Documents` macOS asked for permission on every command and held the command until answered. Commands now change directory inside the shell, so such a wait ends in a timeout that says what to do. The online installer takes the highest `macos-preview` build instead of the API order. Mac acceptance results in docs/MACOS_DEVICE_ACCEPTANCE.md.

- macOS one-line install: the online installer looked for the PKG only in `ubuntu-preview-*` releases, but it is published as `macos-preview-*`, so `curl … | sh` on a Mac stopped with "No complete macOS installer release yet". It now accepts both, and takes `--allowed-root`. New docs/MACOS_DEVICE_ACCEPTANCE.md.

- `log_query` (v1.2): bounded, read-only log search, newest first: Linux journal (time window, unit, level) or a log file inside the allowed roots (tail), with level and regex filters, grouping of repeated messages and redaction. Journal access can be turned off with `capabilities --system-logs off`.

- `health_snapshot` (v1.2): one read-only call returns CPU usage and load, memory and swap, disks, network counters and the top processes by CPU and memory, with `observedAt`, `source` and `limitations`. Works remotely and in local mode.

- Output redaction (v1.2): the agent masks secrets (private keys, Authorization values, URL credentials, common token formats, password/secret/token/API-key assignments) in command, task, terminal and process-list output before it leaves the device. On by default; `capabilities --redact-output off` or `mcp-stdio --no-redact` turns it off. `policy_info` reports `outputRedaction`.

- Local mode (`mcp-stdio`) now accepts the Desktop Commander tool names (`read_file`, `list_directory`, `write_file`, `edit_block`, …); before, they returned `unknown_tool`.

- Local mode (v1.1 item 4): `webrising-commender mcp-stdio --allowed-root <folder> [--allow-writes] [--allow-commands] [--audit-log <file>]` serves MCP over stdio to local AI clients (Claude Desktop, Cursor) with no gateway or account. Allowed roots, read-only and no-commands defaults, undo snapshots and a local audit log (no contents) apply. The 40 tools are generated from the gateway definitions; a test keeps them and the argument mapping in sync. See `docs/LOCAL_MODE.md`.
- Files page fix: the browser starts in the device's first allowed root (from `policy_info`) instead of `.`, which every device refused. Dashboard device calls (`POST /api/device/request`) now return 422 with the agent's reason instead of 502, because proxies such as Cloudflare replace 502 bodies and the page showed only "HTTP 502". Real-agent E2E covers the REST path (refusal reason, `policy_info`, allowed listing).
- The agent reports its package version (`0.1.<CI run>`) to the console and in `--version` instead of the crate version `0.1.0`; release builds set `WECOMMANDER_VERSION`.
- The legacy `/advanced` console is retired (v1.1 item 5e, part 3): `/advanced` redirects to `/dashboard`, and `?view=` links go to the page that replaced them (approvals, devices, audit, team, billing, usage, MCP tokens, terminal, files, tasks). Relay-node administration stays a control-API task (`/api/admin/relays`, see `docs/QUICKSTART.md`). The production acceptance probe accepts both behaviours while the release rolls out.
- Workspace tools in the React dashboard (v1.1 item 5e, part 2): Files is a browser and editor (navigate, open, edit and save text files, new folder, move, delete with a single-use approval, file-name and content search); Tasks starts background tasks (approval), lists them with status, shows output and cancels; Terminal keeps the single command and adds an interactive shell session (open/close with approval, input, Ctrl+C, live output). The "Advanced console" button is gone; every call goes through the same role, device policy and audit as before.
- Approval and trust-change e-mails link to the React `/approvals` page instead of the legacy `/advanced?view=approvals`.
- Team, audit and invitations in the React dashboard (v1.1 item 5e, part 1): `/team` (members with role changes and removal behind a confirmation, invitation links with copy and revoke, the owner's relay region), `/audit` (workspace audit log with search, risk filter, paging and device names; cards on phones), delete for revoked devices on Devices. **Fix:** invitation links pointed to `/app#invite=…`, which only the legacy console handled, so invitations could not be accepted from the React app; new links use `/invite#token=…`, a new page accepts them, and old `/app#invite=` links are forwarded to it.
- Platform console (v1.1 item 5d): each section explains what it does (translated) instead of one generic line; the "read-only records" note only appears on read-only sections; record IDs are shortened with the full value on hover so all actions fit on one row; console tables collapse to labelled cards on phones. A test now fails on console text without a Turkish entry.
- Agent liveness: the gateway pings each Agent every 20 s and closes a connection with no message, heartbeat or pong for 65 s, so a dead path behind a proxy (found in the Ubuntu reconnect test through Cloudflare) shows the device offline instead of online with timing-out calls. The Agent drops a connection after 90 s without gateway pings and reconnects (only once the gateway has shown it pings, so older gateways are unaffected). `edit_block` audit outcomes corrected: no match is `error`, a device-policy refusal is `denied`.
- Approvals inbox and device policy in the React dashboard (v1.1 item 5c): `/approvals` lists pending AI operations with the device name, the exact command or path, the full JSON and the time left; Approve/Deny ask again in a dialog that repeats the operation. The same page sets each device's trust level (Strict/Standard/Full; Full asks for the password and a duration) and manages allowed commands. Sidebar entry with a pending-count badge, the bell opens the inbox instead of `/advanced`, and the Devices list shows each device's trust level.
- Landing page (v1.1 item 5b): new positioning ("Your AI, on every machine"), the one-line install command in the hero, an illustrated MCP session with an allowed command and an approval, supported clients, six real capabilities, a three-step setup, a comparison with local desktop MCP tools (cards on mobile), updated security list and FAQ, a footer without mixed labels, SEO and Open Graph/Twitter defaults for `wecommander.app`. The CMS catalog is regenerated and a test keeps it in sync with the page and fully translated. The theme is applied before the first render, so pages no longer flash in the dark theme and fade; 360 px header and hero overflow fixed.
- UI design system (v1.1 item 5a): one token file (`gateway/ui/src/tokens.css`: colour with status tints, type, spacing, radius, elevation, motion, layers; reduced motion respected), shared `Alert`/`EmptyState`/`Skeleton`/`Spinner`/`PageHeader` components, route-level code splitting (main chunk 561 KB → 375 KB, about 120 KB gzip), and shell accessibility: skip links, one `main` landmark, `aria-current`, Escape closes the mobile drawer, 360 px top bar fix. A new test fails on untranslated UI strings; 21 missing English texts were added. See `docs/DESIGN_SYSTEM.md`.
- One-line install: the gateway serves `/install.sh` (`curl -fsSL https://wecommander.app/install.sh | sh` for Ubuntu and macOS) and `/install.ps1` (Windows). The dispatcher is bound to the serving gateway's origin and runs the existing checksum-verifying installers, which now accept `--control-url`. After approval the device page shows the ready MCP URL and Claude/ChatGPT connection steps; the Install page shows the one-line commands instead of a source build.
- `pdf_read`: native, read-only PDF text extraction in the Rust agent (pure Rust `lopdf`, no external renderer): up to 20 pages per call, negative start counts from the end, 32 MiB file / 32 MiB decompressed / 256 KiB response bounds, password-protected PDFs refused. `read_file` on a `.pdf` path reads pages (Desktop Commander behaviour). Needs agent package with this change.
- Desktop Commander-compatible tools: `read_file`, `read_multiple_files`, `write_file`, `list_directory`, `create_directory`, `move_file`, `get_file_info` (aliases with optional `device_id`), `edit_block` (exact, then unique whitespace-tolerant match; SHA-256-guarded write with undo snapshot; closest-line hint on no match) and `url_fetch` (gateway-side, SSRF-guarded, 1 MiB / 15 s).
- Per-device trust level (Strict / Standard / Full): owner-chosen in the console (admin browser session; Full needs the password, can be time-limited, e-mails all admins/owners, audited as `trusted_full`). Strict ignores the command allowlist; Full runs HIGH-risk operations without per-call approval while device-local capabilities still apply.
- Domain: defaults move to `https://wecommander.app` (old domain keeps serving during the transition); new agent command `set-control-url` moves an enrolled device to a new gateway origin without re-enrolling. See `docs/DOMAIN_MIGRATION.md`.
- CI: macOS checks moved from `ci` to a separate `macos` workflow; the production release gate now requires the 14 Linux/Windows `ci` jobs, so GitHub macOS runner capacity cannot block a Linux release. The macOS PKG is published separately (`macos-preview-*`) by `macos-distribution` only after `macos` passes.
- Command allowlist: owner/admin-managed per-device list of routine `process_exec` commands that run without per-call approval (token-prefix match, shell metacharacters always refused, interpreters/privilege/destructive tools never allowed, browser-session-only management, audited). New approval requests e-mail admins/owners with a link to the Approvals view. See `docs/SECURITY.md`.
- Production release boundary (Issue #30): `production` branch moved only by the owner-approved `promote-production` workflow through a dedicated release GitHub App; exact-SHA 17-job CI/distribution gate, annotated `production-release/*` ledger, unauthorized-update detection (`production-guard`), one-time `mode=bootstrap` in the same workflow, newest-run-only CI/distribution evaluation, `/health` `build.commit` verified after each release, read-only `bootstrap-locks`. See `docs/RELEASE_POLICY.md`.
- MCP Streamable HTTP: event-stream `GET /mcp` and `DELETE /mcp` now return 405 (`Allow: POST`) instead of the dashboard page or 404. Added `gateway/test/mcp-client-acceptance.mjs` (OAuth operator AI client, admin approver, real Rust Agent, tenant isolation, audit) to CI; see `docs/MCP_CLIENT_ACCEPTANCE.md`.
- Added a dependency-free external production acceptance probe and an isolated Coolify Compose deployment model.
- Hardened PUBLIC_BASE_URL validation, relay RPC redirect behavior, SMTP plaintext transport defaults and query-limit parsing.
- Backup/restore and restart-soak tooling can now target an explicit production Compose file/project.
- Added optional native HTTPS/WSS gateway termination using operator-supplied certificate/key files with TLS 1.2+ enforcement.
- Added CA-verified HTTPS health + WSS upgrade CI acceptance and fail-closed TLS configuration checks.
- Added first-party regional relay registry, preferred-region placement, capacity-aware transactional assignment and relay health/drain controls.
- Added HMAC-authenticated control-to-relay RPC and DeviceRouter routing for REST/MCP operations.
- Added native agent route refresh so disconnected agents can fail over to another healthy region without re-enrollment.
- Added real-agent two-relay CI acceptance covering preferred-region placement, unsigned internal-RPC rejection, drain and cross-region failover.
- Added verified PostgreSQL Compose backup/restore tooling with custom-format archive validation, SHA-256 sidecars, retention and fail-closed restore behavior.
- Added a dependency-free gateway restart/manual-network soak runner that verifies device reconnect, low-risk requests and optional persistent-task rediscovery.
- Added CI backup → mutation → destructive restore → API verification acceptance.
- Added SaaS-only verified public signup with pending activation and password-confirmed email verification.
- Added password-reset request/confirm flows with one-time hash-only tokens and full browser-session revocation.
- Added a dependency-free SMTP/STARTTLS client and AES-256-GCM encrypted persistent mail outbox with bounded retries/dead-letter handling.
- Added safe mail-outbox operational status/retry APIs and console signup/reset/verification UX.
- Added organization-scoped browser users and memberships.
- Added scrypt password verification, hashed HttpOnly browser sessions, CSRF protection and login throttling.
- Added browser login/logout to the web console while preserving API-token and self-hosted control-key access.
- Added browser-auth integration acceptance including CSRF denial and session revocation.
- Added workspace creation, switching and owner-only rename controls.
- Added expiring, revocable, hash-only invitation tokens with new/existing-user acceptance flows.
- Added member role updates/removal with serialized last-owner protection and scoped session revocation.
- Added web-console management for members, invitations and tenant API tokens.
- Device presence now becomes online only after the current agent socket completes its hello handshake, eliminating first-command readiness races.
- Added self-hosted vs SaaS deployment modes with self-hosted unlimited core allocations.
- Added provider-neutral billing plans, organization subscriptions, usage snapshots and Access-console plan visibility.
- Added transaction-serialized quotas for device enrollment, member seats/pending invitations and tenant API tokens.
- Added idempotent normalized billing events with payload-collision rejection and provider-bound subscription state.
- Added provider event occurrence ordering, stale-event suppression, wrong-provider rejection, same-time order-conflict detection and provider subscription identity collision protection.
- Restricted provider/customer/subscription identity binding to the normalized verified-event path; manual plan assignments remain provider-neutral.
- Added SaaS CI coverage for billing-required, quota-exceeded and past-due allocation gates.

## 0.1.0 - Unreleased

- Native Rust agent with outbound WebSocket reconnect loop.
- One-time device enrollment with hashed credentials.
- PostgreSQL control plane and organization-scoped tenancy foundation.
- Viewer/operator/admin/owner API-token RBAC.
- Device presence and heartbeat.
- Allowed-root filesystem list/stat/read/write/mkdir/delete/move.
- Bounded recursive tree and filename search.
- Bounded literal text/code search and guarded surgical replacement.
- Task and PTY session discovery after AI reconnect.
- Bounded filesystem reads and payload limits.
- Process execute/list/kill with streamed capped output.
- Persistent PTY sessions with bounded retained output.
- Persistent background tasks across AI/gateway reconnects, up to 24-hour task timeout.
- MCP JSON-RPC endpoint.
- Human-in-the-loop MCP approval request queue.
- HIGH-risk approvals bound to the exact device and operation parameters.
- Independent native-agent approval signature verification.
- Single-use approval consumption and replay/tamper rejection.
- Audit log redaction and retention housekeeping.
- Self-hosted device/terminal/filesystem/task/approval/audit console.
- Docker Compose deployment with hardened gateway container settings.
- Native Windows SCM service host plus install/remove scripts.
- Linux systemd and macOS LaunchAgent install/remove scripts.
- CI for Rust, TypeScript, Compose boot, real-agent E2E, RBAC/approval integration and Windows service lifecycle.
- Release workflow for Linux x64, Windows x64 and universal macOS binaries with SHA-256 checksums.
