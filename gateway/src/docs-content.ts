// The WECOMMANDER documentation, A to Z: one page per topic under /docs/<slug>.
// site-content.ts adds these pages to the public page list, so the same text
// feeds the server-rendered HTML (search engines and AI crawlers), the browser
// view (ui/src/pages/Content.tsx), JSON-LD, the sitemap, /llms.txt and
// /llms-full.txt. Every statement here was checked against the code and
// docs/*.md; keep it that way: assistants quote these pages.
//
// docs-content.test.ts fails when a page lacks a title or description, when a
// page is not a web route, or when an MCP tool is missing from /docs/mcp-tools.

import type { Block, PublicPage } from "./site-content.js";

/** Sidebar groups of the documentation, in reading order. */
export const docGroups = [
  "Getting started",
  "Desktop app",
  "Windows, macOS and Linux apps",
  "Server management",
  "AI and MCP",
  "Safety and control",
  "Workspace and billing",
  "Help and reference",
] as const;
export type DocGroup = (typeof docGroups)[number];

type DocInput = {
  slug: string;
  group: DocGroup;
  title: string;
  description: string;
  intro: string;
  blocks: Block[];
  howTo?: { name: string; steps: string[] };
};

const MCP_URL = "https://wecommander.app/mcp";

function doc(input: DocInput): PublicPage {
  return {
    path: `/docs/${input.slug}`,
    section: "Docs",
    content: true,
    docGroup: input.group,
    title: `${input.title} · WECOMMANDER Docs`,
    description: input.description,
    heading: input.title,
    intro: input.intro,
    blocks: input.blocks,
    ...(input.howTo ? { howTo: input.howTo } : {}),
  };
}

// ---------------------------------------------------------------------------
// Getting started
// ---------------------------------------------------------------------------

const gettingStarted = doc({
  slug: "getting-started",
  group: "Getting started",
  title: "Getting started",
  description: "Create an account, install WECOMMANDER, connect your first server and your first AI assistant, and approve the first risky action.",
  intro: "WECOMMANDER is three things that work together: a desktop SSH client with server management, an agent that connects your machines to your account, and one remote MCP URL that lets AI assistants such as Claude and ChatGPT work on those machines while you stay in charge. This page walks the whole path once; every step links to its detailed page.",
  blocks: [
    { h2: "What you need" },
    { ul: [
      "A computer with Windows 10 or 11 (x64), macOS 13 or newer, or a Linux server (Ubuntu or Debian, amd64) for the agent.",
      "For AI features: a WECOMMANDER account (free to create) and an AI client that supports remote MCP servers, such as Claude, ChatGPT, Cursor or VS Code.",
      "The SSH client in the Windows and macOS apps works without an account and without AI. An account adds sync, the team library, AI access, approvals and scheduled tasks.",
    ] },
    { h2: "1. Create your account" },
    { ol: [
      "Open https://wecommander.app/register and enter your e-mail address and a password of at least 12 characters.",
      "Open the verification link in the e-mail. Your account and its first workspace are created when you confirm.",
      "You land in the web dashboard. Every new workspace starts on the Free plan; see Plans and billing for limits and upgrades.",
    ] },
    { h2: "2. Install WECOMMANDER on your computer" },
    { p: "On Windows and macOS you install one app; the agent comes inside it and connects this computer to your account after you sign in through the browser. On a Linux server you install the agent alone with one command." },
    { code: "# Windows (PowerShell)\nirm https://wecommander.app/install.ps1 | iex\n\n# macOS (Terminal) and Linux servers\ncurl -fsSL https://wecommander.app/install.sh | sh" },
    { p: "Each installer downloads the package from the official release, checks its SHA-256 checksum and stops if it does not match. Details for every system, including the Microsoft Store copy and Windows servers without a desktop, are on Download and install." },
    { h2: "3. Connect a server" },
    { p: "There are two ways to bring a server under WECOMMANDER, and you can use both:" },
    { ul: [
      "With the agent: run the install command on the server and approve the device in your browser. The server keeps one outbound encrypted connection; no inbound port, VPN or SSH key is needed. It works while your own computer is off.",
      "Over SSH: add the server in the desktop app with its address and an SSH key or password. Nothing is installed on the server. You can later share it with AI through your own computer (Hybrid Access).",
    ] },
    { h2: "4. Connect your AI assistant" },
    { p: `Add ${MCP_URL} to your AI client as a remote MCP server and sign in with your WECOMMANDER account (OAuth). The AI then sees the devices and servers of your workspace through devices_list and targets_list.` },
    { h2: "5. Approve the first risky action" },
    { p: "Reading files and checking a server's status run directly. Running a command, deleting a file, killing a process, opening a terminal or restarting a container waits for a person's approval of that exact action, unless you allowed it in the device's AI permissions. Approve it in the web dashboard (Approvals), from the e-mail link, or from the notification of the desktop app." },
    { note: "Start strict: keep the device on standard trust, allow routine commands one by one, and only use full trust for a set time when you know what the AI will do." },
    { h2: "Next steps" },
    { see: ["/docs/install", "/docs/web-dashboard", "/docs/mcp", "/docs/ai-permissions", "/docs/approvals"] },
  ],
  howTo: {
    name: "Set up WECOMMANDER and connect an AI assistant to your machine",
    steps: [
      "Create an account at https://wecommander.app/register and verify your e-mail address.",
      "Install WECOMMANDER: irm https://wecommander.app/install.ps1 | iex on Windows, or curl -fsSL https://wecommander.app/install.sh | sh on macOS and Linux servers.",
      "Sign in through the browser page that opens and approve the device; choose the folder the AI may use.",
      `Add ${MCP_URL} to Claude, ChatGPT, Cursor or VS Code as a remote MCP server and sign in with OAuth.`,
      "Ask the AI to work on the machine and approve risky actions in the dashboard, by e-mail or from the desktop notification.",
    ],
  },
});

const install = doc({
  slug: "install",
  group: "Getting started",
  title: "Download and install",
  description: "Install the WECOMMANDER app on Windows (installer, PowerShell or Microsoft Store) and macOS, the agent on Linux and Windows servers, and the Management Center on Linux desktops.",
  intro: "Pick the line for your system. Every installer downloads from the official WECOMMANDER release, verifies the SHA-256 checksum against the published SHA256SUMS.txt, and refuses to install when it does not match.",
  blocks: [
    { h2: "Which package do I need?" },
    { table: {
      head: ["System", "What you install", "Command or source"],
      rows: [
        ["Windows 10/11 (x64), desktop", "The WECOMMANDER app with the agent inside (per user, no administrator rights)", "irm https://wecommander.app/install.ps1 | iex, or the download button on the Download page"],
        ["Windows, Microsoft Store", "The same app, packaged for the Store; updates come from the Store", "Microsoft Store product ID 9P66C88PSBP6"],
        ["macOS 13 or newer (Apple Silicon or Intel)", "WECOMMANDER Center.app with the agent inside (current user, no password)", "curl -fsSL https://wecommander.app/install.sh | sh"],
        ["Linux server (Ubuntu or Debian, amd64, systemd)", "The agent as a Debian package and systemd service", "curl -fsSL https://wecommander.app/install.sh | sh"],
        ["Windows server without a desktop", "The agent alone with the Windows setup (asks for administrator approval once)", "irm https://wecommander.app/install/agent.ps1 | iex"],
        ["Linux desktop (x86_64, WebKitGTK 4.1)", "The Linux Management Center: approvals, devices and SSH servers shared with AI", "curl -fsSL https://wecommander.app/install/center.sh | sh"],
      ],
    } },
    { h2: "Windows" },
    { ol: [
      "Open PowerShell (no administrator window needed) and run the command below, or download the installer from the Download page in the dashboard and double-click it. If Windows asks, choose \u201cRun anyway\u201d.",
      "The app starts and opens your browser to sign in. Sign in with your WECOMMANDER account and approve this computer.",
      "This computer connects by itself; the agent runs in the background inside the app. The shared folder for AI is C:\\Users\\<you>\\WECOMMANDER unless you choose another.",
    ] },
    { code: "irm https://wecommander.app/install.ps1 | iex" },
    { p: "The app installs for your Windows user only and starts with Windows. It keeps the agent running and restarts it if it stops; if it cannot, it tries again every 5 minutes. Quitting the app from the tray icon stops the agent too, so AI cannot reach this computer until the app runs again." },
    { h3: "Microsoft Store" },
    { p: "The Windows app is also packaged for the Microsoft Store (product ID 9P66C88PSBP6). The Store copy updates through the Store and starts with Windows through its startup task; otherwise it is the same app. Its settings say \u201cupdates come from the Microsoft Store\u201d instead of offering the in-app update." },
    { h2: "macOS" },
    { code: "curl -fsSL https://wecommander.app/install.sh | sh" },
    { p: "On a Mac the command installs WECOMMANDER Center.app into ~/Applications for the current user and opens it; no administrator password is asked. The app signs in through the browser, pairs this Mac by itself, runs the agent in the background and opens at login. The default folder shared with AI is ~/WECOMMANDER. To see what would be installed without installing, use the dry-run form:" },
    { code: "curl -fsSL https://wecommander.app/install/center.sh | sh -s -- --dry-run" },
    { h2: "Linux servers" },
    { code: "curl -fsSL https://wecommander.app/install.sh | sh" },
    { ul: [
      "The command asks for sudo itself. It installs the wecommander-agent package with apt, creates an unprivileged wecommander system user and starts the webrising-commender systemd service.",
      "It prints a link such as https://wecommander.app/connect-device?requestId=\u2026. Open it on your own computer, sign in, choose the workspace and approve the server. Never type your account password into the server's terminal.",
      "The default allowed folder is /var/lib/webrising-commender/workspace. The service runs as wecommander, without sudo, Docker group membership or root.",
      "To install the package without linking it yet, add --package-only and run sudo wecommander-setup later.",
    ] },
    { code: "# Install now, link later\ncurl -fsSL https://wecommander.app/install.sh | sh -s -- --package-only\nsudo wecommander-setup\n\n# Read the installer first (recommended on production servers)\ncurl -fsSLo /tmp/wecommander-install.sh https://wecommander.app/install/ubuntu.sh\nless /tmp/wecommander-install.sh\nsudo bash /tmp/wecommander-install.sh --control-url https://wecommander.app" },
    { p: "Flags for the allowed folder, read-only mode, no commands and running as root are described on Agent: install, update and options." },
    { h2: "Windows servers without a desktop" },
    { code: "irm https://wecommander.app/install/agent.ps1 | iex" },
    { p: "This installs the agent alone with the WECOMMANDER setup program; Windows asks for administrator approval for the setup (never for your Windows password). The agent then runs as the signed-in Windows user with that user's rights, through a per-user scheduled task. It runs only while that user is signed in; it does not start before Windows sign-in." },
    { h2: "Linux desktops" },
    { code: "curl -fsSL https://wecommander.app/install/center.sh | sh" },
    { p: "This installs the Linux Management Center for the current user into ~/.local/share/wecommander-center with a menu entry. It is not the full desktop SSH client (there are no terminal tabs or SFTP on Linux yet); see Linux Management Center for what it does." },
    { h2: "Updates" },
    { ul: [
      "Windows app: a notice appears when a new version is out; choose Update in the app. The package is checked against SHA256SUMS.txt before it replaces the app, and the app restarts. The Store copy updates through the Store.",
      "macOS app: when a new version is out, choose Update app in the panel; the app reinstalls itself and reopens in a few seconds. Running the install command again also installs the newest release.",
      "Linux agent: run the install command again. The existing device identity is kept, so the server stays the same device in your dashboard.",
      "After an update the desktop apps show a short what's-new note once. Every note is also on https://wecommander.app/changelog.",
    ] },
    { h2: "Uninstall" },
    { ul: [
      "Windows: remove WECOMMANDER in Settings \u2192 Apps \u2192 Installed apps. Revoke the device in the dashboard (Devices) when you retire the computer.",
      "Linux server: sudo bash /opt/wecommander/libexec/uninstall-linux.sh stops and removes the service and the run-as-root rule; the binary and the agent config are kept. Revoke the device in the dashboard.",
    ] },
    { see: ["/docs/agent", "/docs/desktop-app", "/docs/linux-management-center", "/docs/troubleshooting"] },
  ],
  howTo: {
    name: "Install WECOMMANDER on a Linux server",
    steps: [
      "On the server run: curl -fsSL https://wecommander.app/install.sh | sh",
      "Open the connect-device link the installer prints on your own computer and sign in.",
      "Choose the workspace and approve the server.",
      "Check that the device shows Online under Devices in the dashboard.",
    ],
  },
});

const webDashboard = doc({
  slug: "web-dashboard",
  group: "Getting started",
  title: "The web dashboard",
  description: "A tour of the wecommander.app dashboard: overview, devices, terminal, files, tasks, scheduled tasks, approvals, MCP tools, team, audit log, usage and billing.",
  intro: "The dashboard at https://wecommander.app/dashboard is where an admin sees and controls everything that happens in a workspace. The menu has five groups; this page explains each item.",
  blocks: [
    { h2: "Overview" },
    { p: "The workspace at a glance, and the starting point to the other pages." },
    { h2: "Devices" },
    { ul: [
      "My devices: every enrolled agent device with its system, host name, agent version and online state. Rename, reconnect or revoke a device here, and open its AI permissions (trust level, run as, safety net, allowed commands).",
      "SSH servers: saved SSH servers that someone shared with remote AI through their own computer (Hybrid Access), grouped by that computer, each with the same AI permissions as a device.",
      "Download the app: the installer or install command for Windows, macOS and Linux.",
    ] },
    { h2: "Workspace" },
    { ul: [
      "Terminal: a persistent terminal on an agent device, in the browser.",
      "Files: browse the allowed folders of an agent device and edit text files.",
      "Tasks: long-running background commands on a device and their output.",
      "Scheduled tasks: commands that WECOMMANDER runs on a schedule on a device or a saved SSH server, with run history. The menu item shows how many tasks' last run failed or was missed.",
    ] },
    { p: "Commands you start from the dashboard follow the same rules as AI commands: they are high-risk actions that need an approval unless the device's AI permissions allow them." },
    { h2: "AI" },
    { ul: [
      "Approvals: pending requests from AI clients with the exact command, file or container and the device; approve or deny each. This page also lists the Management Center apps connected to the workspace, which you can revoke.",
      `MCP tools: the MCP address (${MCP_URL}) and API access keys for MCP clients that use a bearer token instead of OAuth. A key is shown only once when it is created.`,
    ] },
    { h2: "Administration" },
    { ul: [
      "Team: members and their roles, invitations (a link valid for 72 hours) and the workspace's preferred region.",
      "Audit log: every tool call, approval and permission change, with who, what and when.",
      "Usage: this month's tool calls against the monthly quota, the most used tools and the monthly history.",
      "Plans & billing: the current plan and its period, the Paddle customer portal for receipts, invoices, payment method and cancellation, and a form for cancellation or refund requests.",
    ] },
    { h2: "Account" },
    { p: "Your profile, password (at least 12 characters; changing it signs out your other sessions), your workspaces (create a new one here) and e-mail preferences. Account and security e-mails always arrive; product news is optional." },
    { see: ["/docs/ai-permissions", "/docs/approvals", "/docs/teams-and-roles", "/docs/plans-and-billing"] },
  ],
});

// ---------------------------------------------------------------------------
// Desktop app
// ---------------------------------------------------------------------------

const desktopApp = doc({
  slug: "desktop-app",
  group: "Desktop app",
  title: "The desktop app at a glance",
  description: "What the WECOMMANDER desktop app does on Windows and macOS, what the Linux Management Center covers, first-launch tutorial, languages and updates.",
  intro: "The WECOMMANDER app is a native desktop SSH client and server management tool. On Windows it is a WinUI 3 app, on macOS a SwiftUI app; both share the same core for saved servers, keys, SSH, SFTP and tunnels. The app also carries the agent that connects your computer to your account, and it receives approval requests as notifications.",
  blocks: [
    { h2: "What is in the app" },
    { ul: [
      "Servers: saved SSH servers with groups, import from ~/.ssh/config, quick connect, keys, identities and trusted host keys.",
      "Terminals in tabs, split side by side or stacked, with typing into every terminal of a tab at once, snippets, autocomplete, session logs and themes.",
      "An SFTP file manager, local, remote and SOCKS tunnels, jump hosts, the SSH agent and FIDO2 hardware keys, Telnet, serial ports and Mosh.",
      "Server management: overview, disk usage, safe cleanup, processes and zombie fixes, systemd timers and cron.",
      "Scheduled tasks, end-to-end encrypted sync between your computers, a backup file, the team library and live shared terminals.",
      "AI access: share saved SSH servers with AI clients (Hybrid Access) and approve their actions.",
    ] },
    { h2: "Platforms" },
    { table: {
      head: ["Feature", "Windows", "macOS", "Linux"],
      rows: [
        ["SSH client, SFTP, tunnels, server management", "Yes", "Yes", "Not yet (Management Center only)"],
        ["Live server status", "The Dock on a screen edge", "The menu bar icon", "No"],
        ["Approval notifications", "Windows notifications with Approve / Deny", "macOS notifications", "Management Center"],
        ["Share SSH servers with remote AI (Hybrid Access)", "Yes", "Yes", "Yes"],
        ["Local MCP for AI clients on the same computer", "Yes (Settings \u2192 AI)", "No settings page yet", "Not yet"],
        ["Agent inside the app", "Yes", "Yes", "Yes (Management Center)"],
      ],
    } },
    { h2: "No account needed for SSH" },
    { p: "You can use the SSH client without signing in. Signing in adds the agent for this computer, approvals, sync between computers, the team library, Hybrid Access and scheduled tasks." },
    { h2: "First-launch tutorial" },
    { p: "On first launch a short tutorial shows how to add your first server, connect, read the live status (the Dock on Windows, the menu bar on macOS) and connect your AI or answer approvals. The button to press pulses with a green ring. Right-click and choose \u201cTurn off the tutorial\u201d to stop it; turn it on again in Settings." },
    { h2: "Languages" },
    { p: "The apps and the website are available in English, Turkish, German, Brazilian Portuguese, Spanish and French. Change the language in Settings. On Windows the change applies at once and the window reopens where it was, at the same size and the same spot in Settings; open terminals are kept." },
    { h2: "Updates and what's new" },
    { p: "The Windows app offers Update when a new version is out (the Store copy updates through the Store). After each update both apps show a short what's-new note once; all notes are on https://wecommander.app/changelog. If the Windows app ever closes unexpectedly, Windows opens it again and the next start sends an error report." },
    { see: ["/docs/hosts", "/docs/terminals", "/docs/windows-dock", "/docs/macos-menu-bar", "/docs/linux-management-center"] },
  ],
});

const hosts = doc({
  slug: "hosts",
  group: "Desktop app",
  title: "Servers (hosts), groups and quick connect",
  description: "Add and organise SSH servers in the desktop app: groups, import from ~/.ssh/config, quick connect, startup commands, environment variables and agent forwarding.",
  intro: "Every server you connect to is a saved host: a name, an address, a user, a port and how to sign in. Hosts live on your computer (passwords and private keys in the system keychain) and can be synced end to end between your computers or shared with your team.",
  blocks: [
    { h2: "Add a server" },
    { ol: [
      "Choose New server. Pick the connection method: SSH (no agent needed), the WECOMMANDER agent, or another protocol (Mosh, Telnet, serial port).",
      "Enter a name, the address, port (22 by default) and user, and choose key or password sign-in.",
      "Optionally choose a group, a jump host, an identity (a shared user and credential) or a key from your key list.",
      "Connect once. The first time, the app shows the server's host key fingerprint; approve it only if it is the server you expect.",
    ] },
    { h2: "Import from ~/.ssh/config" },
    { p: "Import reads your ~/.ssh/config and adds the hosts it does not have yet; it reports how many were added and skipped." },
    { h2: "Groups" },
    { p: "Give a server a group (optional) to keep the list tidy; servers without one appear under Ungrouped. Groups are part of backups, sync and the team library." },
    { h2: "Quick connect and search" },
    { p: "Type in the server search box to filter by name or address. If nothing matches, press Enter to quick-connect to what you typed as an address." },
    { h2: "Signing in without a password next time" },
    { p: "After a password login the app can add this computer's own key to the server's ~/.ssh/authorized_keys (\u201cDon't ask for the password next time\u201d), and the host switches to that key. A key host with nothing saved also tries your ~/.ssh/id_ed25519, id_ecdsa and id_rsa and remembers the one that works, then the keys of your SSH agent." },
    { h2: "Per-server options" },
    { ul: [
      "Startup command: typed once when the terminal opens.",
      "Environment variables: one NAME=value per line; the server's AcceptEnv setting decides which it accepts.",
      "SSH agent forwarding (ssh -A): lets the server use the keys in this computer's SSH agent while connected. Turn it on only for servers you trust: anyone with admin rights on that server can use your agent's keys during the connection.",
      "Record session: writes what appears in the terminal to a text log file (see Terminals).",
      "AI access: share the server with AI clients (see Hybrid Access).",
    ] },
    { h2: "Host keys" },
    { p: "WECOMMANDER keeps the host keys you trusted (known hosts). If a server's key changes, you are warned before connecting and must approve the new key; AI clients are refused until you do. See Keys, identities and known hosts." },
    { see: ["/docs/keys-and-identities", "/docs/terminals", "/docs/sync-and-backup", "/docs/hybrid-access"] },
  ],
});

const terminals = doc({
  slug: "terminals",
  group: "Desktop app",
  title: "Terminals, tabs, split and broadcast typing",
  description: "Terminal tabs and split panes, typing into every terminal of a tab, snippets, autocomplete from history, session logs, themes and keyboard shortcuts.",
  intro: "Click a server to open its terminal in a new tab. Each tab can hold more than one terminal, and the toolbar of an open terminal gives you split, broadcast, snippets, tunnels, files and server management.",
  blocks: [
    { h2: "Tabs and split panes" },
    { ul: [
      "Every connection opens as a tab. Close the tab to end the connection.",
      "Split adds a second terminal to the current tab, side by side or stacked, so you can watch two servers or two shells together.",
      "On Windows the Dock's Terminal panel also opens several terminals as tabs: \u201c+\u201d adds a tab, and each tab can connect to a different server.",
    ] },
    { h2: "Broadcast typing" },
    { p: "Turn on typing into all terminals of a tab and everything you type goes to every terminal in that tab at once: useful for running the same check on several servers. Turn it off before typing anything meant for one server only." },
    { h2: "Snippets" },
    { p: "Snippets are saved commands with a name. Store the commands you use often on the Snippets page and send them into the open terminal with Snippet in its toolbar. Snippets are included in backups, sync and (if you share them) the team library." },
    { h2: "Autocomplete" },
    { p: "As you type, the terminal suggests completions: first this server's own recent commands (newest first), then your snippets, then commands from other servers. The app keeps the last 500 commands per server on this computer only; they are not in backups or sync. Lines typed after a password, passphrase or token prompt are never kept." },
    { h2: "Session logs" },
    { p: "With Record session on for a server, each terminal session is written to a text file named <server>-<UTC date>.log in the app's logs folder, with colours and cursor movements removed. Open the folder from Settings \u2192 Session logs." },
    { h2: "Themes and font" },
    { p: "Choose a terminal theme in Settings: light, dark, Solarized dark and light, Nord, Gruvbox, Monokai or Dracula. The terminal font size can be changed too. The app itself follows your system's light or dark theme." },
    { h2: "Keyboard shortcuts (Windows)" },
    { table: {
      head: ["Shortcut", "Action"],
      rows: [
        ["Ctrl+F", "Search in the terminal"],
        ["Ctrl+= / Ctrl+-", "Larger / smaller font"],
        ["Ctrl+0", "Default font size"],
        ["Ctrl+C", "Copy (when text is selected)"],
        ["Ctrl+V", "Paste"],
      ],
    } },
    { see: ["/docs/sftp", "/docs/tunnels", "/docs/team-library", "/docs/server-overview"] },
  ],
});

const sftp = doc({
  slug: "sftp",
  group: "Desktop app",
  title: "SFTP file manager",
  description: "Browse, upload, download, rename and delete files on a server over SFTP from the desktop app, with drag and drop and transfer progress.",
  intro: "Every SSH terminal has a file manager that works over SFTP on the same connection: no extra login and nothing installed on the server.",
  blocks: [
    { h2: "What you can do" },
    { ul: [
      "Browse folders, starting in your home folder, with name, size, modification time and permissions.",
      "Upload files from your computer and download files to it, by drag and drop, with progress shown while a transfer runs.",
      "Create folders, rename or move entries, and delete files and folders.",
    ] },
    { h2: "Requirements" },
    { ul: [
      "SFTP works on SSH connections only, not on Telnet, serial or Mosh terminals.",
      "The server must offer SFTP: if it does not, the app says that \u2018Subsystem sftp\u2019 must be enabled in sshd_config.",
      "You work with the rights of the user you signed in as.",
    ] },
    { h2: "SFTP for AI" },
    { p: "When you share a server with AI through Hybrid Access, the AI's file tools on that server (fs_list, fs_read, fs_stat, fs_write, fs_mkdir, fs_move, fs_delete) also run over SFTP from your computer. Changes need your approval unless the server's AI permissions say otherwise, a path that is a symbolic link is refused, and a delete never removes / or the SSH user's home folder." },
    { see: ["/docs/terminals", "/docs/hybrid-access"] },
  ],
});

const tunnels = doc({
  slug: "tunnels",
  group: "Desktop app",
  title: "Tunnels and jump hosts",
  description: "Local (ssh -L), remote (ssh -R) and SOCKS (ssh -D) tunnels, saved tunnels that run in the background, and connecting through a jump host.",
  intro: "Tunnels forward network ports through an SSH connection. Open one from Tunnels in a terminal, and save it to start it later from the Tunnels page or the tray or menu bar icon.",
  blocks: [
    { h2: "Tunnel types" },
    { table: {
      head: ["Type", "Same as", "What it does"],
      rows: [
        ["Local", "ssh -L", "A port on your computer (127.0.0.1) reaches a host and port seen from the server, for example a database that listens only on the server."],
        ["Remote", "ssh -R", "A port on the server reaches a host and port seen from your computer. The server must allow it (AllowTcpForwarding in sshd_config); port 0 lets the server pick one."],
        ["SOCKS (dynamic)", "ssh -D", "A SOCKS5 proxy on 127.0.0.1 of your computer; programs that use it send their traffic through the server."],
      ],
    } },
    { h2: "Saved tunnels" },
    { ul: [
      "Check \u201cSave this tunnel\u201d when you open it. Saved tunnels need fixed ports: a local port for local and SOCKS tunnels, a server port for remote ones.",
      "Two saved tunnels cannot use the same local port.",
      "Saved tunnels run in the background while the app is open; turn each on or off from the Tunnels page or the tray (Windows) or menu bar (macOS). The tray tooltip shows how many are open.",
      "Saved tunnels are part of backups and sync.",
    ] },
    { h2: "Jump hosts" },
    { p: "To reach a server that is only reachable through another one, edit the server and choose a saved host as its jump host. The app connects to the jump host first and opens the connection to the target through it. A host is never its own jump host and loops are refused. Mosh does not work through a jump host; use SSH for such a server." },
    { see: ["/docs/hosts", "/docs/protocols"] },
  ],
});

const protocols = doc({
  slug: "protocols",
  group: "Desktop app",
  title: "Telnet, serial ports and Mosh",
  description: "Connect to old devices over Telnet, to network equipment and boards over a serial port, and keep a terminal alive on unstable networks with Mosh.",
  intro: "Besides SSH, a saved server can use Telnet, a serial port or Mosh. Choose the protocol when you add or edit the server (Other protocols). Files, tunnels and AI access are available only on SSH.",
  blocks: [
    { h2: "Telnet" },
    { p: "For old devices that only speak Telnet. Enter the address and port; there is no login prompt handled by the app and no host key. Telnet sends everything unencrypted, so use it only on networks you trust." },
    { h2: "Serial port" },
    { ul: [
      "Select or type a port such as COM3 on Windows; the app lists the ports it finds.",
      "Set the speed (baud), data bits, parity (none, even, odd), stop bits and flow control (none, hardware RTS/CTS, software).",
      "If the port cannot be opened, check that the cable is plugged in and that no other program uses the port.",
    ] },
    { h2: "Mosh" },
    { ul: [
      "Mosh signs in with SSH (same credentials), starts mosh-server on the server, then runs the terminal over UDP so it survives network changes and sleep.",
      "mosh-server must be installed on the server (Ubuntu/Debian: sudo apt install mosh) and UDP ports 60000\u201361000 must be open in its firewall. If no UDP reply arrives for 8 seconds, the terminal shows a firewall hint.",
      "Closing the tab shuts mosh-server down; exit in the shell ends the terminal.",
      "Mosh does not work through a jump host.",
    ] },
    { see: ["/docs/hosts", "/docs/terminals"] },
  ],
});

const keys = doc({
  slug: "keys-and-identities",
  group: "Desktop app",
  title: "Keys, SSH agent, FIDO2, identities and known hosts",
  description: "Create or import SSH keys, sign in with the SSH agent and FIDO2 hardware keys, reuse credentials with identities, and manage trusted host keys.",
  intro: "WECOMMANDER keeps private keys and saved passwords in your operating system's keychain (Windows Credential Manager, macOS Keychain). Hosts, identities and the key list refer to them; the private key never appears in a backup file.",
  blocks: [
    { h2: "Keys" },
    { ul: [
      "New key creates an Ed25519 key pair. Copy its public key and add it to ~/.ssh/authorized_keys on the server, then edit the server and select the key.",
      "Import key adds an existing private key (with its passphrase if it has one); the key is checked before it is saved.",
      "Deleting a key makes the servers that used it forget it.",
    ] },
    { h2: "SSH agent and FIDO2 hardware keys" },
    { p: "When a key login is refused with the server's own key, the app also offers the keys of your computer's SSH agent in the same session (the Windows OpenSSH agent, or SSH_AUTH_SOCK on macOS). Hardware security keys (FIDO2, sk-ssh keys) sign there, so a key on a YubiKey or similar works through the agent. A key server with nothing saved and no ~/.ssh key file signs in with the agent alone." },
    { h2: "Identities" },
    { p: "An identity is a user name with a key or a password that you use on many servers, for example \u201cdeploy + team key\u201d. Create it once (Identities), select it when editing a server, and every server that uses it follows when you change it. Deleting an identity sends its servers back to their own credentials." },
    { h2: "Known hosts" },
    { ul: [
      "The Known hosts page lists the host keys you trusted, by host:port and fingerprint.",
      "If a server's key changes, the app warns you before connecting and shows the new fingerprint. Accept it only when you know why it changed (server reinstalled, key rotated).",
      "Forget removes a trusted key; the next connection asks again.",
      "AI access requires an already trusted host key and refuses a changed one: AI never trusts a server on first use.",
    ] },
    { see: ["/docs/hosts", "/docs/sync-and-backup", "/docs/hybrid-access"] },
  ],
});

const syncBackup = doc({
  slug: "sync-and-backup",
  group: "Desktop app",
  title: "Sync between computers and backup files",
  description: "End-to-end encrypted sync of servers, keys, snippets and saved passwords between your computers, and exporting or importing a backup file.",
  intro: "Two ways to move your library: sync keeps it the same on every computer where you sign in, encrypted with a password only you know; a backup file is a one-off export you can import anywhere.",
  blocks: [
    { h2: "End-to-end encrypted sync" },
    { ul: [
      "What syncs: servers, groups, tunnels, snippets, identities, keys, trusted host keys and saved passwords.",
      "Turn it on in Settings \u2192 Sync with a sync password of at least 8 characters. On your second computer, enter the same password.",
      "Everything is encrypted on your computer (AES-256-GCM, key derived from the password with Argon2id). The WECOMMANDER server stores only the encrypted copy and cannot read it.",
      "If you forget the sync password, the synced copy cannot be opened. Turning sync off on one computer keeps its servers; they just stop syncing.",
      "Changes merge item by item, so edits on two computers do not overwrite each other's other items.",
      "Sync is available in the Windows and macOS apps; the Linux Management Center does not sync the library yet.",
    ] },
    { h2: "Backup file" },
    { ul: [
      "Settings \u2192 Backup \u2192 Export writes servers, groups, tunnels, snippets, identities and trusted host keys to one file.",
      "Passwords and private keys are not included. On a new computer you are asked for them once on the first connection.",
      "Import only adds what is new; existing items are kept. A backup made by a newer version asks you to update the app first.",
      "AI access settings are never part of a backup: imported servers arrive with AI access off.",
    ] },
    { see: ["/docs/team-library", "/docs/keys-and-identities"] },
  ],
});

const teamLibrary = doc({
  slug: "team-library",
  group: "Desktop app",
  title: "Team library and shared terminals",
  description: "Share servers and snippets with everyone in your workspace, end-to-end encrypted, and show a live terminal to a teammate, view-only or with typing.",
  intro: "Teams that work on the same servers can share them through the team library, and one person can show a live terminal to the others. Both are end-to-end encrypted with a team key that only team members' apps hold.",
  blocks: [
    { h2: "Team library" },
    { ul: [
      "Right-click a server or snippet and choose \u201cShare with team\u201d. It appears in the app of everyone in the workspace within seconds, with its saved password, encrypted.",
      "\u201cRemove from team (keep it just for me)\u201d takes it back; it disappears from the others' apps.",
      "Key files, the app's own keys, identities and personal jump hosts stay on each computer.",
      "Members with the viewer role can use shared servers but cannot change them. Add members and change roles in the dashboard (Team).",
    ] },
    { h2: "The team key" },
    { p: "The first app of a team creates the team key. A new member's app receives it, sealed with that app's public key, when someone on the team with the operator role or higher opens their app; until then sharing waits for the key. Leaving the team removes the key and the shared items from that computer." },
    { h2: "Shared terminals" },
    { ul: [
      "In an open terminal choose Share with team, then view only or let them type too.",
      "Team members join from Servers \u2192 Shared terminals.",
      "Frames are encrypted with the team key; the relay in between sees only sealed data.",
      "Server management is not available inside a shared terminal.",
    ] },
    { see: ["/docs/teams-and-roles", "/docs/sync-and-backup"] },
  ],
});

// ---------------------------------------------------------------------------
// Windows, macOS and Linux apps
// ---------------------------------------------------------------------------

const windowsDock = doc({
  slug: "windows-dock",
  group: "Windows, macOS and Linux apps",
  title: "Windows: the Dock, Classic mode, Task Manager and Tasks",
  description: "The WECOMMANDER Dock on a screen edge with live server meters, Classic mode with windows, the Start-like quick panel, Task Manager, Tasks and multi-monitor behaviour.",
  intro: "On Windows WECOMMANDER runs in one of two modes. Dock mode puts a bar that looks like the Windows taskbar on a screen edge, with live charts for a server and buttons that open panels. Classic mode turns the Dock off and the app works in windows. Switch in Settings, the tray menu or the Dock's right-click menu.",
  blocks: [
    { h2: "The Dock" },
    { ul: [
      "Looks like the Windows taskbar and follows your light or dark theme and accent colour.",
      "Shows live CPU, memory and disk meters for the servers you monitor; click the meters to switch between line and bar charts.",
      "Its buttons open Task Manager, Tasks, Terminal, notifications and approvals, and settings as drop-down panels.",
      "Drag a button, or use Alt + arrow keys, to change its place on the Dock.",
      "Add a server to monitor from the My servers panel; Stop monitoring removes it.",
    ] },
    { h2: "Edges, floating and locking" },
    { ul: [
      "Drag the Dock by an empty spot or the WECOMMANDER icon, like the taskbar, to the top, bottom, left or right edge; it docks there and takes its strip of the screen so windows do not go under it.",
      "Drop it anywhere else and it floats; floating, it can stay always on top.",
      "Auto-hide: the Dock opens when the mouse reaches the edge, after the show delay you set.",
      "Lock the Dock keeps it in place and its buttons in order. Unlock it to move it.",
      "Hide in full-screen apps and games, or let it move to the back.",
      "Closing the Dock gives its screen space back. Reopen it from Settings \u2192 Dock.",
    ] },
    { h2: "Several monitors" },
    { p: "The Dock docks to an edge of the monitor you drag it to. When it takes its strip of the screen, desktop icons stay on their own monitor; with two monitors they do not slide onto the other screen." },
    { h2: "The quick panel" },
    { p: "Clicking the WECOMMANDER icon on the Dock opens a panel like Start: search your servers, shortcuts to the app's pages, your account and settings. The logo shrinks slightly while pressed, like the Start button." },
    { h2: "Task Manager" },
    { ul: [
      "Lists the servers you monitor first: choose one to see its processes live in the same panel; \u201cThis computer\u201d is last.",
      "Select a process for details and actions. WECOMMANDER warns before ending a database, refuses Windows system processes that cannot be ended, and says when a PID now belongs to another process.",
      "Windows Task Manager is one click away for anything else.",
    ] },
    { h2: "Tasks" },
    { p: "The Tasks button (it replaced the earlier Timers and clock icons) brings together WECOMMANDER's scheduled tasks, a server's systemd timers and cron, and this computer's Windows Task Scheduler. \u201cShow Windows tasks\u201d adds Windows' own tasks; New task creates one. Windows keeps no task history unless \u201cEnable All Tasks History\u201d is on in Task Scheduler." },
    { h2: "Classic mode" },
    { p: "No Dock; the Dock's buttons open separate windows. The tray icon stays, and so do approvals, the agent and tunnels." },
    { h2: "The tray icon" },
    { p: "The Windows notification area keeps only the Management Center icon. From it you open the app, switch modes, see pending approvals and autonomous mode, turn saved tunnels on or off, and quit. Quitting stops the agent too." },
    { see: ["/docs/server-overview", "/docs/scheduled-tasks", "/docs/approvals"] },
  ],
});

const macosMenuBar = doc({
  slug: "macos-menu-bar",
  group: "Windows, macOS and Linux apps",
  title: "macOS: the app and the menu bar",
  description: "WECOMMANDER on the Mac: live server status in the menu bar, approval notifications, Task Manager, the agent inside the app, Keychain storage and Hybrid Access.",
  intro: "On macOS WECOMMANDER is a native SwiftUI app whose windows look like macOS's own apps: the sidebar runs to the top of the window and the page title is in the toolbar. It has the same SSH client, server management and library features as the Windows app.",
  blocks: [
    { h2: "The menu bar icon" },
    { ul: [
      "Shows a server's CPU, memory and disk live; click it for details.",
      "Saved tunnels can be opened from the menu bar, and \u201cKeep agent running\u201d is there if the agent ever stops.",
      "If you sign out, click the menu bar icon to sign in again.",
    ] },
    { h2: "Agent and approvals" },
    { ul: [
      "The app carries the agent and runs it in the background; if it stops, the app restarts it. Choosing Quit stops the agent too.",
      "Approval requests arrive as macOS notifications (top right) with Approve and Deny; the app's panel lists them too and can open by itself for new requests. To keep them on screen, set the notification style to Alerts in System Settings \u2192 Notifications.",
      "Turn on \u201cOpen at login\u201d so the agent and approvals are there after a restart.",
    ] },
    { h2: "Keychain" },
    { p: "Saved passwords, private keys and the app's sign-in token are stored in the macOS Keychain." },
    { h2: "AI access (Hybrid Access)" },
    { p: "Main window \u2192 AI access lists your saved servers. Share a server with remote AI, choose read only or with approval, choose the sudo setting, and see what blocks sharing (an untrusted host key, a missing saved credential) with a fix for each, plus the connector's status. A local MCP setup page like the Windows one is not in the Mac app yet." },
    { h2: "Also on the Mac" },
    { ul: [
      "Task Manager, server timers and the Scheduled tasks page.",
      "Terminal themes, snippets, tunnels, identities, sync, backup and the team library.",
      "The first-launch tutorial, which you can restart from Settings.",
    ] },
    { see: ["/docs/hybrid-access", "/docs/approvals", "/docs/install"] },
  ],
});

const linuxCenter = doc({
  slug: "linux-management-center",
  group: "Windows, macOS and Linux apps",
  title: "Linux Management Center",
  description: "The WECOMMANDER Management Center for Linux desktops: approvals, autonomous mode, devices, sharing SSH servers with remote AI, and what it does not do yet.",
  intro: "On a Linux desktop WECOMMANDER is the Management Center: a small app with a tray icon for approvals and AI access. It is not the full desktop SSH client of Windows and macOS.",
  blocks: [
    { h2: "Install" },
    { code: "curl -fsSL https://wecommander.app/install/center.sh | sh" },
    { p: "For the current user, on x86_64 with WebKitGTK 4.1. It signs in through the browser: approve \u201cConnect this Management Center\u201d with an admin or owner account; no password reaches the app." },
    { h2: "Tabs" },
    { ul: [
      "Approvals: pending AI requests with Approve and Deny, and a notification for each new one.",
      "Autonomous mode: turn off approvals for all or selected devices for a time (needs your password).",
      "Devices: the workspace's devices and the agent on this computer.",
      "SSH: import ~/.ssh/config or add a server, connect once to verify the login and trust the host key, and share it with remote AI (read only or with approval; sudo never or sudoers). Shows the connector's status.",
      "Settings: notifications, open the panel when notifications are off, start at login.",
    ] },
    { h2: "Not on Linux yet" },
    { ul: [
      "Terminal tabs, SFTP, tunnels and the server management screens.",
      "Local MCP for AI clients on the same computer.",
      "Sync of the personal library: servers saved on another computer are not listed here.",
    ] },
    { p: "Its sign-in token is stored in a file only your user can read (mode 0600)." },
    { see: ["/docs/hybrid-access", "/docs/approvals"] },
  ],
});

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

const serverOverview = doc({
  slug: "server-overview",
  group: "Server management",
  title: "Server overview and live monitoring",
  description: "See a Linux server's CPU, memory, disks, uptime, pending updates, reboot status and zombie count over SSH, and watch it live on the Dock or the menu bar.",
  intro: "Server management in the desktop app works over the same SSH connection as your terminal: nothing is installed on the server. Open it from a terminal's toolbar (the disk, memory, process and cleanup screen for this server). It is built for Linux servers.",
  blocks: [
    { h2: "Overview" },
    { ul: [
      "Host name, operating system, kernel and uptime.",
      "Load, CPU usage, memory and swap.",
      "Every disk with its file system, size, used and free space.",
      "Whether a reboot is required and how many updates are pending.",
      "Process count and zombie processes, with a link to fix them.",
      "Whether changes are possible: as root, with passwordless sudo, or read-only. A user that is neither root nor has passwordless sudo can see everything but cannot clean up or act on processes.",
    ] },
    { h2: "Live monitoring" },
    { p: "Monitored servers send small samples (CPU, memory, swap, load, network and disk traffic, root disk space, zombies) that the app turns into live charts: on the Dock on Windows and in the menu bar on macOS. Monitoring uses the saved credential or this computer's SSH keys and never asks for a password." },
    { h2: "The same for AI" },
    { p: "AI clients get the same data with server_overview and health_snapshot (agent devices) or server_overview on SSH servers shared through Hybrid Access." },
    { see: ["/docs/disk-cleanup", "/docs/processes", "/docs/server-timers", "/docs/mcp-tools"] },
  ],
});

const diskCleanup = doc({
  slug: "disk-cleanup",
  group: "Server management",
  title: "Disk usage and safe cleanup (including rootless Docker)",
  description: "Find what fills a Linux server's disk and free space safely: old logs, package caches, crash dumps, and Docker build cache and unused images per Docker daemon, including rootless Docker.",
  intro: "Two screens: Disk only measures, Cleanup only deletes. Cleanup lists fixed, known categories of files that can be re-created, shows the size and the exact command for each, and runs nothing until you confirm.",
  blocks: [
    { h2: "Disk usage" },
    { ul: [
      "Lists the 40 largest folders inside a path (default /), never crossing into another disk; click a folder to open it.",
      "Shows Docker's own usage: images, containers and volumes with what could be reclaimed.",
      "Marks a folder that is a Docker daemon's storage (system Docker or a user's rootless Docker) and points you to Cleanup for it instead of deleting files by hand.",
      "Large disks can take a minute or two to measure; progress is shown.",
    ] },
    { h2: "Cleanup categories" },
    { table: {
      head: ["Category", "What is removed"],
      rows: [
        ["Package cache", "apt's downloaded package files"],
        ["System journal", "journal entries older than 7 days"],
        ["Rotated logs", "old, already rotated log files"],
        ["Temporary files", "old files in temporary folders"],
        ["Crash dumps", "saved crash reports"],
        ["Docker build cache", "per Docker daemon, through Docker's own prune"],
        ["Docker unused images", "per Docker daemon, images no container uses, through Docker's own prune"],
      ],
    } },
    { h2: "Docker and rootless Docker" },
    { p: "Each Docker daemon is handled separately: the system daemon and every user's rootless daemon are listed with their storage folder, running containers and any error. A rootless daemon's category ids end in @u<uid>. Cleanup goes to the daemon it names, through Docker itself. Running containers, the images of stopped containers and all volumes are never touched. If a daemon's sizes cannot be read, cleanup is not recommended for it." },
    { h2: "What is never removed" },
    { p: "Application data, databases, containers and Docker volumes. Only known files that can be re-created are listed." },
    { h2: "Rights" },
    { p: "Cleanup needs root or passwordless sudo on the server. Without them sizes may be incomplete and cleanup is not offered." },
    { h2: "For AI" },
    { p: "server_disk_usage and server_cleanup_scan are read-only. server_cleanup_run runs the cleanup commands of the categories you approve, as root, and needs a human approval for that exact call unless the device or SSH server is on full trust." },
    { see: ["/docs/server-overview", "/docs/docker", "/docs/mcp-tools"] },
  ],
});

const processes = doc({
  slug: "processes",
  group: "Server management",
  title: "Processes and zombie fixes",
  description: "See every process on a Linux server, the top CPU and memory users, and fix zombie processes by reminding the parent, stopping it, or restarting its container or service.",
  intro: "The Processes screen refreshes every 2 seconds and lists each process with its PID, parent, user, state, CPU, memory, run time and command, plus the top 10 by CPU and by memory.",
  blocks: [
    { h2: "Signals" },
    { table: {
      head: ["Action", "Signal", "Effect"],
      rows: [
        ["Ask it to collect zombies", "SIGCHLD", "Harmless reminder to a parent process to collect its finished children. Does not stop anything."],
        ["End", "SIGTERM", "Asks the process to shut down; it finishes open work and exits. A service may restart it."],
        ["Kill", "SIGKILL", "Stops it at once; unsaved work is lost. Try ending it gracefully first."],
      ],
    } },
    { p: "Before any signal WECOMMANDER checks that the process name still matches (a PID reused by another program is refused). Processes that keep the server reachable are refused, and a database needs an extra confirmation because stopping it can lose data being written." },
    { h2: "Zombie processes" },
    { p: "A zombie has already finished and uses no CPU or memory, but it stays in the process table until its parent collects it; it cannot be killed directly. The Zombie processes view groups them by parent and shows the Docker container or systemd service that owns the parent." },
    { ol: [
      "First send the parent the harmless reminder (SIGCHLD).",
      "If the program does not collect them, restart its service or container. It is down for a few seconds; the zombies go with the old process.",
      "For a permanent fix, run the container with a small init process (--init) that collects finished processes. For apps deployed with Coolify, \u201cApply suggestion\u201d adds --init to the app's custom Docker options through Coolify's API and redeploys it; a Coolify API key with write and deploy permissions is asked once and kept in this computer's keychain.",
    ] },
    { p: "SSH, Docker, containerd, journald, logind, D-Bus and WECOMMANDER itself are never restarted." },
    { h2: "For AI" },
    { p: "server_processes is read-only. server_process_signal (reap, term, kill) and server_restart_owner need a human approval for that exact call unless the device or SSH server is on full trust; the same protections apply." },
    { see: ["/docs/server-overview", "/docs/mcp-tools"] },
  ],
});

const serverTimers = doc({
  slug: "server-timers",
  group: "Server management",
  title: "Server timers, cron and Windows tasks",
  description: "View and manage a Linux server's systemd timers, read its cron jobs, and manage this computer's Windows Task Scheduler from WECOMMANDER, with the exact command shown first.",
  intro: "WECOMMANDER shows the jobs a server already runs on its own schedule. Every change shows the exact command that will run on the server before it runs.",
  blocks: [
    { h2: "systemd timers" },
    { ul: [
      "Lists system timers and the signed-in user's own timers, including inactive and disabled ones, with schedule, next and last run, the service and command they start, and its last result.",
      "Actions: enable (starts now and at boot), disable (stops it and it no longer starts at boot; a running job is not interrupted), start now (runs the job once; the schedule does not change), stop (stops the running job; the timer stays) and view its log (journalctl of the service).",
      "New timer writes a .service and a .timer file marked as WECOMMANDER's to /etc/systemd/system, reloads systemd and enables it. The calendar is checked with systemd-analyze calendar first.",
      "Only timers WECOMMANDER created can be edited or deleted. Deleting stops, disables and removes both unit files and cannot be undone.",
      "Changes need root or passwordless sudo; otherwise timers are visible only.",
    ] },
    { h2: "Cron (read only)" },
    { p: "The user's crontab, /etc/crontab, /etc/cron.d and /etc/cron.hourly to monthly are listed. Cron jobs are shown, never changed from here. Other users' crontabs are not read." },
    { h2: "Windows Task Scheduler" },
    { p: "On Windows, the Tasks panel also shows this computer's Task Scheduler: WECOMMANDER's tasks, and Windows' own tasks when \u201cShow Windows tasks\u201d is on. A task whose format cannot be edited here opens in Windows Task Scheduler." },
    { h2: "For AI" },
    { p: "server_timers_list reads timers and cron without root. AI cannot change server timers; for jobs created by AI use WECOMMANDER's scheduled tasks." },
    { see: ["/docs/scheduled-tasks", "/docs/windows-dock"] },
  ],
});

const docker = doc({
  slug: "docker",
  group: "Server management",
  title: "Docker containers",
  description: "List Docker containers per daemon (system and rootless), read their logs with secrets masked, and start, stop or restart a container with approval. Nothing is ever removed or pruned by these tools.",
  intro: "WECOMMANDER understands that a Linux server can run more than one Docker daemon: the system one and a rootless one per user. Every Docker feature names the daemon it works on.",
  blocks: [
    { h2: "In the desktop app" },
    { ul: [
      "Disk shows Docker's usage (images, containers, volumes) and marks the storage folder of each daemon.",
      "Cleanup frees each daemon's build cache and unused images through Docker's own prune; running containers and volumes are never touched.",
      "Processes shows which container owns a process, and can restart that container to clear its zombies.",
    ] },
    { h2: "For AI" },
    { table: {
      head: ["Tool", "What it does", "Approval"],
      rows: [
        ["docker_containers_list", "Containers per daemon (system, or u<uid> for a rootless one): id, name, image, state, status, created, ports and restart count. A daemon that cannot be read shows its error.", "Read-only"],
        ["docker_container_logs", "The last lines of one container's logs (stdout and stderr, timestamped). tail 1\u20132000 (default 200), since such as 10m or 1h30m, at most 256 KiB; secrets are masked.", "Read-only"],
        ["docker_container_action", "start, stop or restart one container (stop and restart wait 10 seconds before killing).", "Every call needs an approval unless the device or SSH server is on full trust; never allowlisted; refused on read-only SSH servers"],
      ],
    } },
    { h2: "Guarantees" },
    { ul: [
      "Containers, images and volumes are never removed or pruned by these tools.",
      "WECOMMANDER's own containers are never stopped or restarted.",
      "Container references are checked strictly before anything reaches the server, and the action runs on the full id Docker resolves.",
      "Available on Linux agent devices and on SSH servers shared through Hybrid Access.",
    ] },
    { see: ["/docs/disk-cleanup", "/docs/mcp-tools", "/docs/ai-permissions"] },
  ],
});

const scheduledTasks = doc({
  slug: "scheduled-tasks",
  group: "Server management",
  title: "Scheduled tasks",
  description: "Commands WECOMMANDER runs for you on a device or a saved SSH server every night, every N minutes or once, with history, output, failure e-mails and AI access with approval.",
  intro: "Scheduled tasks are stored on the WECOMMANDER service, not in the operating system's scheduler. Tasks on an agent device run through its agent, even while your own computer is off; tasks on a saved SSH server run from your desktop app, which holds the SSH credentials.",
  blocks: [
    { h2: "Create a task" },
    { ol: [
      "Open Scheduled tasks in the dashboard (Workspace \u2192 Scheduled tasks) or in the desktop app.",
      "Name it, choose the target (an agent device; SSH servers are chosen in the desktop app) and enter the exact command.",
      "Choose the schedule, the time zone, the time limit and when to e-mail you. The next five run times are shown before you save.",
      "Confirm. Creating the task is the approval for its runs: it runs at each due time without asking again. Check the command before saving.",
    ] },
    { h2: "Schedules" },
    { table: {
      head: ["Kind", "Example", "Notes"],
      rows: [
        ["Every N minutes", "every 30 minutes", "5 minutes to 7 days; the first run is one interval after saving."],
        ["Cron (advanced)", "0 3 * * * (03:00 every day)", "Standard five fields: minute hour day month weekday; ranges, steps, lists and month/weekday names. A day matches if either day field matches."],
        ["Once", "2026-12-01T09:00+03:00", "A time in the past is refused."],
      ],
    } },
    { p: "Times are wall-clock times in the task's IANA time zone (default Europe/Istanbul). A time skipped by a daylight-saving change runs right after it (02:30 becomes 03:30); a time that occurs twice runs once." },
    { h2: "Options" },
    { ul: [
      "Time limit: 10 seconds to 1 hour (default 10 minutes); a run that takes longer is stopped and marked failed.",
      "Notification: e-mail on failure (default), always, or never. Failed and missed runs are e-mailed to the task's creator, or to the owners and admins when an API token created it.",
      "Enabled: turn a task off without deleting it.",
    ] },
    { h2: "Runs and history" },
    { ul: [
      "Exit code 0 is succeeded; any other is failed. Output (stdout, then stderr) is kept up to the last 64 KiB with secrets masked.",
      "A device that is offline at the due time gives a missed run. If the previous run is still running, the new one is skipped.",
      "No catch-up storm: after an outage a task runs once, then continues on its schedule.",
      "SSH tasks need the desktop app to be open and signed in; a run not picked up within 15 minutes is missed.",
      "Run now runs a task once outside its schedule. Finished runs are kept for 90 days.",
    ] },
    { h2: "Who can do what" },
    { p: "Anyone in the workspace can read tasks; creating, changing, deleting and running them needs the owner or admin role. Every change is in the audit log with the exact command. The agent's own limits still apply: a device with commands switched off refuses the run." },
    { h2: "Limits" },
    { p: "The Free plan keeps up to 10 scheduled tasks; no workspace can have more than 100." },
    { h2: "For AI" },
    { p: "scheduled_tasks_list is read-only. scheduled_task_create (agent devices only), scheduled_task_update, scheduled_task_delete and scheduled_task_run_now need a human approval of that exact change, unless the task's device is on full trust. Tasks on SSH servers always need an approval, command allowlists do not apply, and the device's safety net refuses catastrophic commands." },
    { see: ["/docs/server-timers", "/docs/mcp-tools", "/docs/ai-permissions"] },
  ],
});

// ---------------------------------------------------------------------------
// AI and MCP
// ---------------------------------------------------------------------------

const mcp = doc({
  slug: "mcp",
  group: "AI and MCP",
  title: "AI access with MCP: how it works",
  description: `What MCP (Model Context Protocol) is, the one WECOMMANDER MCP URL (${MCP_URL}), how a tool call reaches your machine, and the two ways to connect a server: the agent or SSH.`,
  intro: "The Model Context Protocol (MCP) is an open standard that lets AI assistants call tools. WECOMMANDER is a remote MCP server: your AI client adds one URL, signs in with your account, and gets tools to read files, run commands and manage servers on the machines of your workspace, with your limits and approvals applied to every call.",
  blocks: [
    { h2: "One URL for all your machines" },
    { code: MCP_URL },
    { p: "Every AI client that supports remote MCP servers over HTTPS can use it: Claude (web, desktop and Claude Code), ChatGPT, Cursor, VS Code and others. Sign-in uses OAuth with your WECOMMANDER account; clients that only take a bearer token can use an API access key instead." },
    { h2: "What happens on a tool call" },
    { ol: [
      "The AI calls a tool, for example process_exec with a command and a device.",
      "The gateway checks the caller's role, the arguments, the device's AI permissions and the safety net.",
      "A read runs directly. A high-risk action waits for a person's approval of that exact action, unless the device allows it (an allowed command or full trust).",
      "The gateway sends the action to the device's agent over its outbound encrypted connection. The agent checks it again: allowed folders, its own switches and, for high-risk actions, the signed approval.",
      "The result comes back with secrets masked, and the call is written to the audit log.",
    ] },
    { h2: "Two ways to connect a server" },
    { table: {
      head: ["", "Agent", "SSH (Hybrid Access)"],
      rows: [
        ["What is installed on the server", "The WECOMMANDER agent (Windows, macOS, Linux)", "Nothing"],
        ["Path", "Server \u2192 outbound connection \u2192 wecommander.app", "wecommander.app \u2192 the app on your computer \u2192 SSH to the server"],
        ["Works while your computer is off", "Yes", "No: your computer and the app must be on"],
        ["Folder limit", "Allowed folders enforced on the device", "None: a command reaches everything the SSH user can"],
        ["Run as root", "Linux only, with two keys", "Through sudo -n when the computer allows sudo for that server and an admin turns it on"],
        ["Tools", "The full set", "Commands, files over SFTP, overview, disk, processes, cleanup, process signals, timers and cron, Docker"],
        ["AI permissions", "Trust level, allowed commands, safety net", "The same, plus read-only sharing that refuses every change"],
      ],
    } },
    { p: "Choose the agent for always-on or autonomous work and tight folder limits; choose SSH to try quickly or where nothing can be installed. Hybrid Access is available from the Windows, macOS and Linux apps." },
    { h2: "What the AI sees" },
    { p: "devices_list lists agent devices; targets_list lists every place the AI can act on (agent devices and shared SSH servers) with each one's trust level, run as, safety net and supported tools, so the AI knows whether it is root and whether an action will need approval." },
    { h2: "Limits that always apply" },
    { ul: [
      "AI clients cannot change their own permissions, trust levels, allowed commands or autonomous mode; those need an admin in a browser session.",
      "Approvals are single-use and bound to the exact action and device.",
      "On the Free plan, a monthly number of tool calls is included; when it is used up the AI is told when it resets and where to upgrade.",
    ] },
    { see: ["/docs/connect-claude", "/docs/connect-chatgpt", "/docs/connect-other-clients", "/docs/mcp-tools", "/docs/hybrid-access"] },
  ],
});

const connectClaude = doc({
  slug: "connect-claude",
  group: "AI and MCP",
  title: "Connect Claude (web, desktop and Claude Code)",
  description: `Add WECOMMANDER to Claude as a custom connector with ${MCP_URL} and OAuth, or to Claude Code from the command line.`,
  intro: "Claude reaches WECOMMANDER as a custom connector (a remote MCP server). The connector added on claude.ai is also available in the Claude desktop app.",
  blocks: [
    { h2: "Claude on the web and the desktop app" },
    { ol: [
      "Install WECOMMANDER on the machine first and approve the device.",
      "In Claude open Settings \u2192 Connectors \u2192 Add custom connector. On organisation plans an admin may have to allow custom connectors first.",
      `Name: WECOMMANDER. URL: ${MCP_URL}. Choose Connect.`,
      "Sign in with your WECOMMANDER account and allow access. No API key is pasted.",
      "In a chat, turn the connector on and ask, for example: \u201cList my WECOMMANDER devices and check free disk space on my server.\u201d",
    ] },
    { h2: "Claude Code" },
    { p: "Add WECOMMANDER as a remote HTTP MCP server; Claude Code opens the browser for the OAuth sign-in when you first use it (/mcp shows the status):" },
    { code: `claude mcp add --transport http wecommander ${MCP_URL}` },
    { h2: "Claude Desktop with local servers only" },
    { p: "If you want Claude Desktop to work on this computer without an account, use local mode instead (see Local MCP); on Windows the WECOMMANDER app can also add its local endpoint to Claude Desktop and Claude Code for you." },
    { h2: "Remove access" },
    { p: "Remove the connector in Claude. OAuth access tokens last one hour and refresh tokens 30 days; access also ends at once when the user is disabled or removed from the workspace." },
    { note: "Client menus change over time. If a step looks different, follow Claude's own help for custom connectors with a remote MCP server; the URL and OAuth sign-in stay the same." },
    { see: ["/docs/mcp", "/docs/approvals", "/docs/local-mcp"] },
  ],
  howTo: {
    name: "Connect Claude to WECOMMANDER",
    steps: [
      "Install WECOMMANDER on the machine and approve the device.",
      "In Claude open Settings \u2192 Connectors \u2192 Add custom connector.",
      `Enter the name WECOMMANDER and the URL ${MCP_URL}, then Connect.`,
      "Sign in with your WECOMMANDER account and allow access.",
    ],
  },
});

const connectChatgpt = doc({
  slug: "connect-chatgpt",
  group: "AI and MCP",
  title: "Connect ChatGPT",
  description: `Add WECOMMANDER to ChatGPT as a custom MCP connector with ${MCP_URL} and OAuth sign-in.`,
  intro: "ChatGPT can use WECOMMANDER through a custom MCP connector. Whether custom connectors are available depends on your ChatGPT plan and workspace policy; developer mode may be required.",
  blocks: [
    { h2: "Steps" },
    { ol: [
      "Install WECOMMANDER on the machine first and approve the device.",
      "In ChatGPT open Settings \u2192 Connectors and create a custom MCP connector (turn on developer mode if your plan requires it).",
      `Enter ${MCP_URL} as the server URL and choose OAuth as the authentication.`,
      "Connect, sign in with your WECOMMANDER account and allow access. The tools appear in the chat.",
    ] },
    { h2: "Good first requests" },
    { ul: [
      "\u201cList my WECOMMANDER devices.\u201d",
      "\u201cSummarise the Word documents in my WECOMMANDER folder.\u201d",
      "\u201cShow the 20 largest folders on my server and what can be cleaned safely.\u201d",
    ] },
    { p: "Commands, deletes and other high-risk actions return \u201capproval required\u201d first. Approve in the dashboard, from the e-mail or the desktop notification, then ask ChatGPT to try again." },
    { note: "ChatGPT's menus change over time; if a step looks different, follow OpenAI's help for connecting custom MCP servers. The URL and OAuth sign-in stay the same." },
    { see: ["/docs/mcp", "/docs/approvals", "/docs/mcp-tools"] },
  ],
  howTo: {
    name: "Connect ChatGPT to WECOMMANDER",
    steps: [
      "Install WECOMMANDER on the machine and approve the device.",
      "In ChatGPT open Settings \u2192 Connectors and create a custom MCP connector.",
      `Enter ${MCP_URL} and choose OAuth.`,
      "Sign in with your WECOMMANDER account and allow access.",
    ],
  },
});

const connectOther = doc({
  slug: "connect-other-clients",
  group: "AI and MCP",
  title: "Connect Cursor, VS Code (Copilot) and other MCP clients",
  description: `Use ${MCP_URL} from Cursor, VS Code with GitHub Copilot and any MCP client: OAuth sign-in, or an API access key as a bearer token.`,
  intro: "Any client that supports remote (HTTP) MCP servers can connect. It signs in with OAuth if it supports it; otherwise create an API access key and send it as a bearer token.",
  blocks: [
    { h2: "Two ways to authenticate" },
    { table: {
      head: ["Method", "When to use it", "How"],
      rows: [
        ["OAuth 2.1 with PKCE", "Clients with built-in MCP sign-in", "Add the URL; the client registers itself and opens the browser for you to sign in and allow access."],
        ["API access key", "Clients that take a header, scripts, or clients whose sign-in returns through a custom app link", "Dashboard \u2192 MCP tools \u2192 create an access key with the lowest role that works (it is shown once), then send Authorization: Bearer <key>."],
      ],
    } },
    { note: "WECOMMANDER accepts OAuth callbacks on https:// addresses and on http://localhost or 127.0.0.1. A client that returns from sign-in through a custom app link (a scheme such as cursor://) cannot finish OAuth here; use an API access key with that client." },
    { h2: "Cursor" },
    { p: "Add the server to ~/.cursor/mcp.json (or the project's .cursor/mcp.json):" },
    { code: `{\n  "mcpServers": {\n    "wecommander": {\n      "url": "${MCP_URL}",\n      "headers": { "Authorization": "Bearer <your API access key>" }\n    }\n  }\n}` },
    { h2: "VS Code with GitHub Copilot" },
    { p: "Add an HTTP server in .vscode/mcp.json (or with the MCP: Add Server command). VS Code signs in with OAuth when the server asks for it; to use an API access key instead, add \"headers\": { \"Authorization\": \"Bearer <your API access key>\" } next to the url." },
    { code: `{\n  "servers": {\n    "wecommander": {\n      "type": "http",\n      "url": "${MCP_URL}"\n    }\n  }\n}` },
    { h2: "Any other client or a script" },
    { p: "The endpoint speaks MCP JSON-RPC over HTTP POST (protocol versions 2025-06-18 and 2025-03-26): initialize, notifications/initialized, ping, tools/list and tools/call." },
    { code: `curl -s ${MCP_URL} \\\n  -H "Authorization: Bearer $WECOMMANDER_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` },
    { h2: "Keep keys safe" },
    { ul: [
      "A key acts with the role you gave it: viewer reads, operator runs tools (high-risk ones still need approval), admin and owner manage more. Use the lowest that works.",
      "Never commit a key to a repository or a shared file. Revoke it on the MCP tools page when it is no longer needed.",
      "An AI client or API key can never approve its own requests or change AI permissions.",
    ] },
    { see: ["/docs/mcp", "/docs/local-mcp", "/docs/teams-and-roles"] },
  ],
});

const localMcp = doc({
  slug: "local-mcp",
  group: "AI and MCP",
  title: "Local MCP: without an account or through the desktop app",
  description: "Run WECOMMANDER as a local MCP server over stdio for Claude Desktop, Cursor, VS Code or Codex: the agent's mcp-stdio mode with no account, or the Windows app's local endpoint for saved SSH servers.",
  intro: "AI clients that start MCP servers as a local program can use WECOMMANDER without the cloud. There are two local modes: the agent alone, limited to folders you name, and the desktop app's local endpoint, which gives local AI clients your saved SSH servers.",
  blocks: [
    { h2: "1. The agent in local mode (no account)" },
    { code: "webrising-commender mcp-stdio --allowed-root \"$HOME/projects\"" },
    { table: {
      head: ["Option", "Default", "Meaning"],
      rows: [
        ["--allowed-root <folder>", "required, repeatable", "The only folders the tools may touch; everything else is refused, including through symbolic links."],
        ["--allow-writes", "off", "File writes: write, append, create folders, move, replace, delete, undo."],
        ["--allow-commands", "off", "Commands, background tasks and terminals."],
        ["--audit-log <file>", "none", "One JSON line per call: time, tool, risk, outcome. File contents are never written."],
        ["--no-redact", "off", "Turns off masking of secrets in command, task, terminal and process output."],
      ],
    } },
    { p: "Without --allow-writes and --allow-commands the AI can only read and search. With both it works like Desktop Commander inside the allowed folders and still keeps undo snapshots of every write. Example for Claude Desktop (Settings \u2192 Developer \u2192 Edit Config):" },
    { code: "{\n  \"mcpServers\": {\n    \"wecommander\": {\n      \"command\": \"/opt/wecommander/bin/webrising-commender\",\n      \"args\": [\"mcp-stdio\", \"--allowed-root\", \"/home/you/projects\", \"--allow-writes\", \"--audit-log\", \"/home/you/.wecommander-local.log\"]\n    }\n  }\n}" },
    { p: "On Windows use C:\\Program Files\\WECOMMANDER\\webrising-commender.exe and Windows folders; on macOS the binary is /usr/local/bin/webrising-commender. The command waits silently for a client on stdin; that is expected." },
    { h2: "2. The desktop app's local endpoint (Windows)" },
    { ul: [
      "Settings \u2192 AI in the Windows app can add WECOMMANDER to Claude Desktop, Claude Code, Cursor and Codex. It shows the exact change to the client's config file first, keeps every other entry, and saves a .bak copy.",
      "The client starts wecommander-core --mcp-stdio, a thin bridge to the running app. If the app is closed, the bridge answers that WECOMMANDER must be opened.",
      "Each new AI client is shown once and must be allowed; you can revoke it later.",
      "Only servers whose AI access has \u201cAI on this computer\u201d turned on are visible. Commands go straight from your computer to the server and never pass through wecommander.app.",
      "Commands need your approval in the app (single use, 5 minutes, bound to the exact command and server), unless the server is read-only (no commands) or on timed autonomy (up to 8 hours).",
      "A local audit file records time, client, tool, server, risk and outcome; never command text, output or file contents.",
    ] },
    { p: "The macOS app does not have this settings page yet, and the Linux Management Center does not offer local MCP." },
    { h2: "Local or remote?" },
    { table: {
      head: ["", "Local mode", "Remote (wecommander.app/mcp)"],
      rows: [
        ["AI clients", "Desktop clients that start a local program", "Any MCP client, including claude.ai, ChatGPT and mobile"],
        ["Machines", "This computer (agent) or your saved SSH servers (app)", "Every device and shared SSH server, one URL"],
        ["High-risk approval", "The flags you started it with, or the app's approval", "Single-use approval per call, trust levels, allowed commands"],
        ["Audit", "Local file", "Central audit log in the dashboard"],
      ],
    } },
    { see: ["/docs/mcp", "/docs/hybrid-access", "/docs/mcp-tools"] },
  ],
});

const agent = doc({
  slug: "agent",
  group: "AI and MCP",
  title: "Agent: install, update and options",
  description: "The WECOMMANDER agent on Windows, macOS and Linux: how it is installed and updated, the user it runs as, allowed folders, read-only and no-command switches, --allow-root, and checking its status.",
  intro: "The agent is a single program on each machine. It opens one outbound TLS connection to wecommander.app, never listens on a port, and enforces the device's limits itself: allowed folders, read-only and no-command switches, secret masking and signed approvals for high-risk actions.",
  blocks: [
    { h2: "How it runs on each system" },
    { table: {
      head: ["System", "Installed by", "Runs as", "Default allowed folder"],
      rows: [
        ["Windows desktop", "The WECOMMANDER app (agent inside)", "Your Windows user, as a hidden child of the app", "C:\\Users\\<you>\\WECOMMANDER"],
        ["Windows server", "install/agent.ps1 (setup)", "The signed-in user, through a per-user scheduled task", "Chosen during setup"],
        ["macOS", "The WECOMMANDER app (agent inside)", "Your macOS user", "~/WECOMMANDER"],
        ["Linux server", "install.sh (Debian package)", "The unprivileged wecommander system user (systemd service webrising-commender)", "/var/lib/webrising-commender/workspace"],
      ],
    } },
    { p: "Pairing uses a one-time request approved in your browser; the device credential is stored on the device and never printed. Re-running an installer keeps the existing device identity." },
    { h2: "Linux options" },
    { code: "# Change the allowed folder or switches on an installed server\nsudo wecommander-setup --allowed-root /srv/app\nsudo wecommander-setup --read-only      # refuse all file writes\nsudo wecommander-setup --no-commands    # refuse commands, tasks and terminals" },
    { p: "Choose a narrow folder the wecommander user can actually access; do not start with /, /root, /etc or a whole data disk. Commands run with the wecommander user's Unix rights, so grant it access only to what the AI should use." },
    { h2: "Device switches the gateway cannot change" },
    { table: {
      head: ["Switch", "Refuses"],
      rows: [
        ["Commands off (--no-commands)", "process_exec, process_kill, task_start, terminal_start, terminal_input"],
        ["File writes off (--read-only)", "fs_write, fs_append, fs_mkdir, fs_delete, fs_move, fs_replace, fs_undo, xlsx_write_cells"],
        ["Root not allowed (default)", "any action the gateway sends to run as root"],
        ["Output redaction (on by default)", "turn off with capabilities --redact-output off"],
        ["System logs (on)", "turn off journal reading with capabilities --system-logs off"],
      ],
    } },
    { p: "These live only in the agent's local config. Even a valid human approval cannot override them. To change them later run webrising-commender --config <path> capabilities --commands on|off --file-writes on|off and restart the service. policy_info shows what is on." },
    { h2: "Allowing root (Linux only)" },
    { p: "Running as root needs two keys. The first is the machine owner's, on the machine:" },
    { code: "sudo bash /opt/wecommander/libexec/install-linux.sh --allow-root      # allow\nsudo bash /opt/wecommander/libexec/install-linux.sh --disallow-root   # undo" },
    { p: "This adds a sudoers rule for the agent's service user, removes the systemd hardening that blocks sudo and records the ceiling in the agent's config. The second key is an admin turning \u201crun as root\u201d on for that device in the dashboard, with their password. Root is not available on Windows or macOS agents. See AI permissions." },
    { h2: "Check and update" },
    { code: "sudo systemctl status webrising-commender --no-pager\nsudo journalctl -u webrising-commender -n 30 --no-pager" },
    { ul: [
      "Linux: run the install command again to update; the device stays the same.",
      "Windows and macOS: the agent comes inside the app and is updated with it (Update in the Windows app, Update app on the Mac).",
      "The dashboard shows each device's agent version under Devices.",
    ] },
    { see: ["/docs/install", "/docs/ai-permissions", "/docs/troubleshooting"] },
  ],
});

const hybrid = doc({
  slug: "hybrid-access",
  group: "AI and MCP",
  title: "Hybrid Access: AI on SSH servers without an agent",
  description: "Share saved SSH servers with AI clients through WECOMMANDER on your own computer (Windows, macOS, Linux): nothing installed on the server, keys never leave your computer, approvals and AI permissions apply.",
  intro: "With Hybrid Access an SSH server you already use in WECOMMANDER can be used by AI without installing anything on it. The connection is made by WECOMMANDER on your own computer, so your SSH keys and passwords never leave it. Connection method and AI access are separate choices: no AI sees a server until you turn AI access on for it.",
  blocks: [
    { h2: "Where it is available" },
    { table: {
      head: ["", "Windows app", "macOS app", "Linux Management Center"],
      rows: [
        ["Remote AI (ChatGPT, Claude.ai through wecommander.app)", "Yes", "Yes", "Yes"],
        ["AI on this computer (local MCP)", "Yes", "No settings page yet", "Not yet"],
      ],
    } },
    { h2: "Turn it on for a server" },
    { ol: [
      "The server must use SSH (not Telnet, serial or Mosh).",
      "Connect once and approve its host key. AI never trusts a server on first use, and a changed key is refused.",
      "It must sign in without asking: a saved password, a key that opens without a typed passphrase, or this computer's own keys or SSH agent. The AI can never type a password.",
      "Edit the server \u2192 AI access, and turn on \u201cRemote AI\u201d (and on Windows, \u201cAI on this computer\u201d if you use local AI clients).",
      "Choose the permission preset and the sudo setting.",
    ] },
    { h2: "Presets and sudo" },
    { table: {
      head: ["Setting", "Meaning"],
      rows: [
        ["Read only", "The AI can read files, list folders and look at the server's state. It cannot run commands or change anything, whatever its trust level."],
        ["With approval (recommended)", "Reading is free; commands, writes, deletes and server changes need a single-use approval showing the exact command and server, unless the server's AI permissions allow it."],
        ["Timed autonomous (local only)", "For local AI clients only: no approvals until the time ends (at most 8 hours), then back to With approval. Never applies to remote AI."],
        ["Sudo: never (default)", "Commands containing sudo, su, doas, pkexec or run0 are refused. A sudo password is never stored or given to AI."],
        ["Sudo: sudoers", "Only what the server's sudoers already allows without a password can run with sudo; you decide on the server."],
      ],
    } },
    { h2: "How a remote call works" },
    { ol: [
      "Your app publishes only a name, the preset and the sudo setting for each shared server; never the address, user or credentials. The AI sees a target id such as ssh-<24 hex characters>.",
      "The AI calls a tool with that target. The gateway checks the role, the read-only preset, the safety net, run as root, and whether an approval is needed.",
      "Your app picks the call up, checks everything again, runs it over SSH or SFTP, and sends back the result with secrets masked.",
      "If your computer or the app is off, the call fails at once with connector_offline (after 20 seconds without pickup, or 45 seconds without contact); nothing waits to run later.",
    ] },
    { h2: "Tools on SSH servers" },
    { p: "process_exec, fs_list, fs_read, fs_stat, fs_write, fs_mkdir, fs_move, fs_delete, server_overview, server_disk_usage, server_processes, server_cleanup_scan, server_cleanup_run, server_process_signal, server_timers_list, docker_containers_list, docker_container_logs and docker_container_action. Other tools answer unsupported_for_target. Remote reads and writes are limited to 1 MiB each (4 MiB for local AI clients)." },
    { h2: "AI permissions of SSH servers" },
    { p: "Each shared server has the same AI permissions as an agent device, on the web Devices page under SSH servers: trust level (strict, standard, full), run as user or root, the safety net and an allowlist of routine commands. Only the owner of the computer the server goes through can see and change them. Root needs both the computer's sudo setting (sudoers) and the owner's choice in the dashboard; then process_exec and fs_write run through sudo -n." },
    { h2: "What it does not protect" },
    { ul: [
      "There is no folder limit over SSH: a command, and the file tools, reach everything the SSH user can. For a tighter limit install the agent, or use a separate SSH user with only the rights needed.",
      "The sudo guard is a guard, not a sandbox; the real limit is the SSH user's rights and the server's sudoers.",
      "Secret masking is best effort.",
    ] },
    { h2: "Always on" },
    { ul: [
      "The approval screen always shows the exact command.",
      "Passwords, keys and tokens in output are masked.",
      "Every call is in the audit log (tool, server, decision); never command text, file contents or output on the gateway.",
      "The AI can never change AI access, presets or sudo settings: no tool for that exists.",
    ] },
    { see: ["/docs/ai-permissions", "/docs/mcp", "/docs/local-mcp", "/docs/mcp-tools"] },
  ],
});

// --- MCP tool reference ------------------------------------------------------

type ToolRow = [name: string, does: string, risk: string, where: string, args: string];
const READ = "Read-only: runs directly";
const MEDIUM = "Change inside allowed folders: runs without approval (operator role); refused by read-only devices";
const HIGH = "High risk: needs a single-use human approval unless allowlisted (process_exec only, standard trust) or the device is on full trust";
const ANY = "Agent devices (Windows, macOS, Linux)";
const ANY_SSH = "Agent devices and SSH servers (Hybrid Access)";
const LINUX = "Linux agent devices and SSH servers";

const toolGroups: { title: string; intro: string; rows: ToolRow[] }[] = [
  { title: "Discovery and workspace", intro: "Start here: what the AI can reach and with which permissions.", rows: [
    ["devices_list", "Enrolled agent devices with online state and each device's trust level, run as, root capability and safety net.", READ, "Workspace", "none"],
    ["targets_list", "Every place the AI can act on: agent devices and shared SSH servers, with target_id, kind, online, capabilities, preset, sudo, trust, run as and safety net. Pass target_id as target to other tools.", READ, "Workspace", "none"],
    ["app_errors", "Recent errors reported by the WECOMMANDER apps of this workspace, newest first, with platform, build, message and stack; user folder names removed.", READ, "Workspace", "limit (1\u2013100)"],
    ["get_recent_tool_calls", "Paginated, sanitised history of your own recent tool calls on the selected device.", READ, ANY, "device_id, limit, offset"],
    ["get_usage_stats", "Your tool calls by name over the past 30 days on the selected device.", READ, ANY, "device_id"],
    ["policy_info", "The agent-enforced allowed folders, limits and switches (commands, file writes, output redaction, system logs).", READ, ANY, "device_id"],
  ] },
  { title: "System, health and logs", intro: "Read the state of a machine.", rows: [
    ["system_info", "Operating system, host name and basic system information.", READ, ANY, "device_id"],
    ["health_snapshot", "CPU usage and load, memory and swap, disks, network counters and the top processes by CPU and memory.", READ, ANY, "device_id, top (1\u201320)"],
    ["log_query", "Bounded log search, newest first: the systemd journal (Linux; window, unit, level) or the tail of a log file inside the allowed folders. Repeated messages grouped; secrets masked.", READ, "Agent devices; journal on Linux only", "device_id, source (journal|file), path, unit, since_minutes, level, pattern, limit"],
  ] },
  { title: "Files: reading", intro: "All file tools stay inside the device's allowed folders on agents; on SSH servers they run over SFTP with the SSH user's rights.", rows: [
    ["fs_list", "List a folder.", READ, ANY_SSH, "path"],
    ["fs_stat", "File or folder metadata.", READ, ANY_SSH, "path"],
    ["fs_read", "Read a file as UTF-8 text or base64.", READ, ANY_SSH, "path, max_bytes"],
    ["fs_read_lines", "A page of lines (zero-based offset; negative counts from the end); up to 1000 lines and 256 KiB.", READ, ANY, "path, offset_lines, limit_lines"],
    ["fs_read_multiple", "Up to ten files in one call (64 KiB each, 256 KiB total), with per-file errors.", READ, ANY, "paths, max_bytes"],
    ["fs_tree", "A bounded recursive folder tree, without following symbolic links.", READ, ANY, "path, max_depth, max_entries"],
    ["image_inspect", "PNG, JPEG, GIF or WebP dimensions and metadata from the headers only.", READ, ANY, "path"],
  ] },
  { title: "Office documents and PDF", intro: "Read Word, Excel and PDF files without running macros or loading external resources.", rows: [
    ["pdf_read", "The text layer of up to 20 PDF pages (start_page 1-based; negative counts from the end).", READ, ANY, "path, start_page, page_count"],
    ["docx_inspect", "Paragraph and table counts of a Word document.", READ, ANY, "path"],
    ["docx_read_paragraphs", "Up to 100 paragraphs as text, including text in tables.", READ, ANY, "path, offset, limit"],
    ["docx_read_table", "Up to 50 rows of one table (20 cells per row).", READ, ANY, "path, table_index, offset_rows, limit_rows"],
    ["xlsx_inspect", "The worksheets of an XLSX or XLSM workbook.", READ, ANY, "path"],
    ["xlsx_read_range", "Up to 50 rows by 20 columns of one sheet; formulas are not evaluated.", READ, ANY, "path, sheet, start_row, start_column, row_count, column_count"],
    ["xlsx_find", "Search cached cell values (up to 50,000 cells, 30 sheets, 100 matches).", READ, ANY, "path, query, sheet, case_sensitive, max_results"],
    ["xlsx_write_cells", "Write up to 100 cells to a new XLSX file; the original is never overwritten.", MEDIUM, ANY, "path, output_path, sheet, updates, expected_sha256"],
  ] },
  { title: "Files: changing", intro: "Writes can carry expected_sha256 so a file changed in the meantime is never overwritten.", rows: [
    ["fs_write", "Write a file (base64 content); with_undo keeps a snapshot of the previous content (up to 4 MiB). As root, a file the service user cannot write is written as root (no snapshot then).", `${MEDIUM}. On SSH servers: needs approval`, ANY_SSH, "path, content_base64, create_parents, expected_sha256, with_undo"],
    ["fs_append", "Append to a file; with_undo keeps a snapshot.", MEDIUM, ANY, "path, content_base64, expected_sha256, with_undo"],
    ["fs_mkdir", "Create a folder.", `${MEDIUM}. On SSH servers: needs approval`, ANY_SSH, "path, recursive"],
    ["fs_move", "Move or rename; the destination must not exist.", `${MEDIUM}. On SSH servers: needs approval`, ANY_SSH, "source, destination"],
    ["fs_replace", "Exact search-and-replace edit; by default the text must match exactly once. Keeps an undo snapshot.", MEDIUM, ANY, "path, search, replace, replace_all, expected_sha256"],
    ["fs_delete", "Delete a file or folder; expected_sha256 deletes a file only if unchanged.", HIGH, ANY_SSH, "path, recursive, expected_sha256, approval_token"],
    ["fs_versions", "Up to eight undo snapshots of a file.", READ, ANY, "path"],
    ["fs_undo", "Restore a snapshot, only if the file's current SHA-256 matches; the snapshot is used up.", MEDIUM, ANY, "path, undo_id, expected_sha256"],
  ] },
  { title: "Search", intro: "Bounded searches inside the allowed folders.", rows: [
    ["fs_search", "Search file and folder names recursively.", READ, ANY, "path, query, case_sensitive, max_results"],
    ["text_search", "Search literal text in UTF-8 files recursively.", READ, ANY, "path, query, case_sensitive, max_results"],
    ["code_search", "The same as text_search, named for coding clients.", READ, ANY, "path, query, case_sensitive, max_results"],
    ["start_search", "Start an asynchronous file-name or content search (up to 500 matches).", READ, ANY, "path, query, search_type (files|content), case_sensitive, start_paused"],
    ["get_more_search_results", "A page of a search's results; pending until it completes.", READ, ANY, "search_id, offset, length"],
    ["list_searches", "Your active and recent searches on the device.", READ, ANY, "device_id"],
    ["pause_search", "Pause a running search for up to 15 seconds.", "Session control: runs directly", ANY, "search_id"],
    ["resume_search", "Resume a paused search.", "Session control: runs directly", ANY, "search_id"],
    ["stop_search", "Discard a search and its results.", "Session control: runs directly", ANY, "search_id"],
  ] },
  { title: "Commands and processes", intro: "Commands run as the agent's service user, or as root when the device's run as is root (Linux only). The safety net refuses catastrophic commands even with an approval.", rows: [
    ["process_exec", "Run a shell command with an optional working folder and time limit. On SSH servers it runs as the SSH user, or through sudo -n as root when allowed.", `${HIGH}. Safety net applies`, ANY_SSH, "command, cwd, timeout_ms, approval_token"],
    ["process_list", "Visible processes (secrets in command lines masked).", READ, ANY, "device_id"],
    ["process_kill", "Terminate a process by PID.", HIGH, ANY, "pid, approval_token"],
  ] },
  { title: "Background tasks", intro: "Long-running commands that survive AI and gateway disconnects while the agent runs.", rows: [
    ["task_start", "Start a persistent background command.", `${HIGH}. Safety net applies`, ANY, "command, cwd, timeout_ms, approval_token"],
    ["task_status", "Status and retained output of a task.", READ, ANY, "task_id"],
    ["task_list", "Retained tasks, so a reconnected client can find its task ids.", READ, ANY, "device_id"],
    ["task_cancel", "Cancel a task.", HIGH, ANY, "task_id, approval_token"],
  ] },
  { title: "Interactive terminals", intro: "Persistent PTY sessions with up to 1 MiB of retained history.", rows: [
    ["terminal_start", "Open a terminal session with a shell, folder and size.", HIGH, ANY, "shell, cwd, cols, rows, approval_token"],
    ["terminal_input", "Type up to 256 KiB into a terminal. Each exact input needs approval, because it runs in the shell.", `${HIGH}. Safety net applies`, ANY, "session_id, data_base64, approval_token"],
    ["terminal_read", "Read buffered output.", READ, ANY, "session_id, max_bytes"],
    ["terminal_read_page", "Read retained history without consuming it, by byte offset.", READ, ANY, "session_id, offset_bytes, max_bytes"],
    ["terminal_resize", "Resize a terminal.", "Session control: runs directly", ANY, "session_id, cols, rows"],
    ["terminal_stop", "Close a terminal session.", HIGH, ANY, "session_id, approval_token"],
    ["terminal_list", "Open sessions with process ids and retained output sizes.", READ, ANY, "device_id"],
  ] },
  { title: "Server management (Linux)", intro: "The same fixed scripts as the desktop app's server management screens.", rows: [
    ["server_overview", "Host name, OS, kernel, uptime, load, CPU, memory, swap, disks, reboot required, pending updates, process and zombie counts, and whether root is available.", READ, LINUX, "target or device_id"],
    ["server_disk_usage", "The 40 largest folders inside a path (default /) on one disk, plus Docker's usage.", READ, LINUX, "path"],
    ["server_cleanup_scan", "What can be freed safely, by category and per Docker daemon, with sizes and the exact command each runs.", READ, LINUX, "target or device_id"],
    ["server_cleanup_run", "Run the cleanup of the given category ids as root (Docker through its own prune). Never touches application data, databases, containers or volumes.", "High risk: needs approval of this exact call unless full trust", LINUX, "ids"],
    ["server_processes", "Every process and the zombies grouped by parent, with the owning container or service and whether it is protected.", READ, LINUX, "target or device_id"],
    ["server_process_signal", "Send reap (SIGCHLD), term or kill to one process; the name must still match; protected processes refused; databases need confirm_database.", "High risk: needs approval of this exact call unless full trust", LINUX, "pid, name, action, confirm_database"],
    ["server_restart_owner", "Restart the container or systemd service a process runs in. SSH, Docker, containerd, journald, logind, D-Bus and WECOMMANDER are refused.", "High risk: needs approval of this exact call unless full trust", "Linux agent devices", "owner_kind (container|service), id"],
    ["server_timers_list", "systemd timers and cron entries, read without root.", READ, LINUX, "target or device_id"],
  ] },
  { title: "Docker", intro: "Per daemon: system, or u<uid> for a user's rootless Docker. Never removes or prunes; WECOMMANDER's own containers are never stopped.", rows: [
    ["docker_containers_list", "Containers per daemon with id, name, image, state, status, ports and restart count.", READ, LINUX, "daemon"],
    ["docker_container_logs", "The last lines of a container's logs (tail 1\u20132000, since, at most 256 KiB), secrets masked.", READ, LINUX, "container, daemon, tail, since"],
    ["docker_container_action", "start, stop or restart one container.", "High risk: approval every call unless full trust; never allowlisted; refused on read-only SSH servers", LINUX, "container, action, daemon"],
  ] },
  { title: "Scheduled tasks", intro: "WECOMMANDER's own scheduled tasks for the workspace. Changes need the admin role.", rows: [
    ["scheduled_tasks_list", "Tasks with target, command (secrets masked), schedule, time zone, enabled, next run and the last run's status.", READ, "Workspace", "none"],
    ["scheduled_task_create", "Create a task on an agent device with a cron, interval or one-time schedule.", "High risk: approval of the exact change unless the device is on full trust; safety net applies", "Agent devices", "device_id, name, command, schedule, timezone, enabled, timeout_sec, notify"],
    ["scheduled_task_update", "Change the given fields of a task, or move it to another agent device.", "High risk: approval unless full trust; SSH tasks always need approval", "Workspace", "task_id and any task field"],
    ["scheduled_task_delete", "Delete a task and its run history.", "High risk: approval unless full trust; SSH tasks always need approval", "Workspace", "task_id"],
    ["scheduled_task_run_now", "Run a task once now, outside its schedule.", "High risk: approval unless full trust; SSH tasks always need approval", "Workspace", "task_id"],
  ] },
  { title: "Desktop Commander-compatible names", intro: "Aliases so prompts written for Desktop Commander keep working. They map to the tools above, so roles, approvals, device limits and the audit log apply unchanged. device_id is optional when exactly one device is online.", rows: [
    ["read_file", "Read a text file; with offset and length a line range; for PDF files, pages (up to 20). Maps to fs_read, fs_read_lines or pdf_read.", READ, ANY, "path, offset, length"],
    ["read_multiple_files", "Read up to ten files (fs_read_multiple).", READ, ANY, "paths"],
    ["write_file", "Write UTF-8 text; mode rewrite (default) or append (fs_write or fs_append).", MEDIUM, ANY, "path, content, mode"],
    ["list_directory", "List a folder (fs_list).", READ, ANY, "path"],
    ["create_directory", "Create a folder with its parents (fs_mkdir).", MEDIUM, ANY, "path"],
    ["move_file", "Move or rename (fs_move).", MEDIUM, ANY, "source, destination"],
    ["get_file_info", "File or folder metadata (fs_stat).", READ, ANY, "path"],
    ["edit_block", "Replace old_string with new_string: exact match first, then a unique whitespace-tolerant match; expected_replacements must equal the matches. Guarded by the file's SHA-256.", MEDIUM, ANY, "file_path, old_string, new_string, expected_replacements"],
  ] },
  { title: "Web", intro: "The only tool that reaches outside your own machines.", rows: [
    ["url_fetch", "Fetch an http(s) URL from the WECOMMANDER gateway and return its text (up to 1 MiB, 15 seconds). Private, loopback and link-local addresses are refused.", READ, "Gateway (no device)", "url"],
  ] },
];

export const toolReferenceNames: string[] = toolGroups.flatMap((g) => g.rows.map((r) => r[0]));

const mcpTools = doc({
  slug: "mcp-tools",
  group: "AI and MCP",
  title: "MCP tool reference",
  description: "Every WECOMMANDER MCP tool, grouped: what it does, its risk and approval rule, where it works (agent devices, SSH servers, Linux only) and its key arguments.",
  intro: `This is the complete list of tools an AI client gets from ${MCP_URL}. Tools that act on a machine take device_id (agent devices) or target (a target_id from targets_list, which can also be a shared SSH server). Every tool carries standard MCP annotations (read-only, destructive, idempotent, open-world) so clients can show them.`,
  blocks: [
    { h2: "How to read the risk column" },
    { ul: [
      "Read-only: runs directly for any member role (viewer and up).",
      "Change inside allowed folders: runs without a per-call approval for operators and up; the agent's allowed folders and read-only switch still apply. On SSH servers every change needs an approval unless the server's trust says otherwise.",
      "High risk: the first call returns approval_required with an approval_request_id. A person approves that exact action; the AI then repeats the same call. Exceptions: process_exec commands on the device's allowlist (standard trust), and devices on full trust.",
      "The safety net refuses catastrophic commands in process_exec, task_start, terminal_input and scheduled task commands on every trust level.",
    ] },
    ...toolGroups.flatMap((group): Block[] => [
      { h2: group.title },
      { p: group.intro },
      { table: { head: ["Tool", "What it does", "Risk and approval", "Where", "Key arguments"], rows: group.rows.map((r) => [...r]) } },
    ]),
    { h2: "Errors the AI may see" },
    { table: {
      head: ["Error", "Meaning"],
      rows: [
        ["approval_required", "A person must approve this exact action; retry the same call after approval."],
        ["safety_net_blocked", "The command is on the safety net's list; it is refused even with an approval."],
        ["run_as_root_unavailable", "Root was requested but the device or server no longer allows it; nothing ran as the user instead."],
        ["unsupported_for_target", "The tool does not work on this kind of target (for example an SSH server)."],
        ["connector_offline", "The computer that reaches this SSH server is off or the app is closed."],
        ["monthly_tool_call_limit", "The Free plan's monthly tool calls are used up; the message says when they reset."],
        ["browser_session_required", "The action (such as changing AI permissions) needs an admin in a browser, never an AI client."],
      ],
    } },
    { see: ["/docs/ai-permissions", "/docs/approvals", "/docs/hybrid-access", "/docs/troubleshooting"] },
  ],
});

// ---------------------------------------------------------------------------
// Safety and control
// ---------------------------------------------------------------------------

const aiPermissions = doc({
  slug: "ai-permissions",
  group: "Safety and control",
  title: "AI permissions: trust levels, allowed commands, root and the safety net",
  description: "Set per device and per SSH server what AI may do without asking: strict, standard or full trust (time-limited or not), allowed command patterns, run as root with two keys, the safety net and autonomous mode.",
  intro: "What an AI client may do on a device is set per device by an admin in the web dashboard (Devices \u2192 AI permissions), never by the AI. The Windows and macOS apps show the current state and open that page. Every change is audited, and every widening is e-mailed to all admins and owners.",
  blocks: [
    { h2: "Overview" },
    { table: {
      head: ["Setting", "Values", "Default", "Widening needs"],
      rows: [
        ["Trust", "strict, standard, full", "standard", "full: your current password"],
        ["Time limit for full", "1 hour, 4 hours, 24 hours, 7 days, or no limit", "1 hour", "(part of full)"],
        ["Run as", "user, root", "user", "your password and the machine owner's consent (Linux only)"],
        ["Safety net", "on, off", "on", "off: your password"],
        ["Safety net allows shutdown/reboot", "on, off", "off", "on: your password"],
      ],
    } },
    { p: "Narrowing (back to standard, back to user, safety net on) needs no password." },
    { h2: "Trust levels" },
    { ul: [
      "Strict: every high-risk call waits for a human approval; the allowed command list is not used.",
      "Standard: process_exec commands on the device's allowed list run without approval; every other high-risk call waits for an approval.",
      "Full: no per-call approval for any high-risk tool on the device, including Docker container actions and changes to scheduled tasks that run on it. WECOMMANDER's own containers are still never stopped, scheduled tasks on SSH servers still need an approval, and the safety net still applies. When a time-limited full trust expires, the device returns to standard.",
    ] },
    { h2: "Allowed commands" },
    { p: "Under standard trust, routine commands can run without asking. Add patterns in the device's AI permissions (admin, browser session only). The rules are strict and fail closed:" },
    { ul: [
      "Only process_exec is ever allowed this way; tasks, terminals, deletes and kills always need approval.",
      "A pattern matches when its words are an exact prefix of the command's words: systemctl status matches systemctl status nginx but not systemctl stop nginx.",
      "A command containing ; & | $ ` < > ( ) { } [ ] \\ * ? ! # ~, quotes, tabs or newlines is never allowed by a pattern, so df -h; rm -rf / cannot ride on df -h.",
      "Patterns cannot start with shells, sudo, su, env, xargs, interpreters, network or copy tools, database clients or destructive tools; multi-purpose tools such as docker, systemctl, git and apt need a subcommand.",
      "Each allowed run is audited as allowlisted with the pattern used.",
    ] },
    { h2: "Run as root: two keys (Linux)" },
    { ol: [
      "The machine owner allows it once on the machine: sudo bash /opt/wecommander/libexec/install-linux.sh --allow-root (undo with --disallow-root). The agent then reports that it can act as root.",
      "An admin turns run as root on for that device in the dashboard, with their password. Until the agent reports it can, the dashboard refuses and shows the command to run.",
    ] },
    { p: "A web click alone can never give root on a server, and the agent enforces its half too: it refuses a root action without its own ceiling and a signed approval of that root action. As root, commands, background tasks and terminals run through sudo -n, and a file the service user cannot write is written as root (file tools still stay inside the allowed folders). Scheduled task runs stay the service user. Not available on Windows or macOS." },
    { h2: "The safety net" },
    { p: "On by default. It refuses a short list of catastrophic commands on every trust level and as root, even with a human approval:" },
    { ul: [
      "Recursive rm of /, /*, top-level system folders or the home folder, or with --no-preserve-root; recursive chmod, chown or chgrp of /.",
      "mkfs, mke2fs, mkswap, wipefs and blkdiscard on a /dev device; dd, shred or a redirection onto a whole disk.",
      "Fork bombs.",
      "shutdown, reboot, poweroff, halt, systemctl reboot or poweroff, init 0 or 6, unless \u201callow shutdown and reboot\u201d is on.",
      "Stopping, disabling, masking or deleting the agent's own service, binary or sudoers rule.",
    ] },
    { p: "It sees through sudo, env, nohup, timeout, sh -c, eval, $(\u2026) and backticks, and lets ordinary work through (rm -rf ./build, systemctl restart). It is a guard against slips, not a sandbox." },
    { h2: "Autonomous mode" },
    { p: "Autonomous mode puts all devices, or the ones you select, on full trust for a time (5 minutes to 30 days) or until you stop it. It is started by an admin in the browser or the Management Center with their password; AI clients and API keys cannot start it. Every admin and owner is e-mailed, the dashboard shows a banner on every page while it is on, it stops automatically when the time ends, and stopping it needs no password. The device's own limits (allowed folders, read-only, no commands, secret masking) still apply." },
    { h2: "SSH servers" },
    { p: "Servers shared through Hybrid Access have the same settings on the Devices page under SSH servers: trust, time limit, run as, safety net and allowed commands. Only the owner of the computer they go through can change them. A server shared read-only refuses every change whatever its trust. Root needs the computer's sudo setting for that server to be sudoers as well." },
    { see: ["/docs/approvals", "/docs/agent", "/docs/hybrid-access", "/docs/security-model"] },
  ],
});

const approvals = doc({
  slug: "approvals",
  group: "Safety and control",
  title: "Approvals: web, e-mail and desktop notifications",
  description: "How a high-risk AI action waits for a person, where approval requests arrive (dashboard, e-mail, Windows and macOS notifications, Linux Management Center) and what one approval allows.",
  intro: "When an AI calls a high-risk tool that the device's AI permissions do not allow on their own, WECOMMANDER does not run it. It stores the exact requested action as an approval request and tells the AI to try again once a person decides.",
  blocks: [
    { h2: "The flow" },
    { ol: [
      "The AI calls, for example, process_exec with a command. It gets approval_required and an approval_request_id.",
      "Admins and owners are notified. The request shows the device or server, the exact command, file, process or container, and whether it would run as root.",
      "A person approves or denies it.",
      "The AI repeats the same call. The gateway uses the approval once, signs it for that device, and the agent checks the signature before running.",
    ] },
    { h2: "What one approval allows" },
    { ul: [
      "Exactly the action shown, on that device, once. Changing one byte of the command, path, PID or terminal input needs a new approval, and a replay is refused.",
      "Requests for agent devices expire after 10 minutes; requests for SSH servers after 5 minutes.",
      "If the device did not receive an approved action (it went offline), the approval is kept for the identical retry.",
      "Only admins and owners can approve, and only from a browser session or a connected Management Center. Requests for an SSH server shared through someone's computer are decided only by that person.",
    ] },
    { h2: "Where requests arrive" },
    { table: {
      head: ["Place", "How"],
      rows: [
        ["Web dashboard", "AI \u2192 Approvals lists pending requests with Approve and Deny."],
        ["E-mail", "Admins and owners get one e-mail per new request with a link to Approvals. The e-mail itself grants nothing; approving still needs your browser session."],
        ["Windows", "The Management Center shows each request as a Windows notification with Approve and Deny buttons, and can open its panel automatically. A test notification checks that Windows lets them through."],
        ["macOS", "macOS notifications from the WECOMMANDER app, and the app's panel."],
        ["Linux desktop", "The Linux Management Center's Approvals tab and notifications."],
      ],
    } },
    { h2: "Connecting a Management Center" },
    { p: "The desktop app signs in through the browser: you approve \u201cConnect this Management Center\u201d with an admin or owner account, and the app receives its own token; your password never enters it. That token can only list and decide approvals, read devices, manage autonomous mode and scheduled tasks; it cannot run device tools. Revoke a Management Center under Approvals, or sign out in the app." },
    { h2: "Fewer approvals, safely" },
    { ul: [
      "Allow routine commands (standard trust) instead of approving df -h every time.",
      "Use full trust for a set time on a device you are actively working on.",
      "Autonomous mode for several devices at once, with automatic expiry.",
    ] },
    { see: ["/docs/ai-permissions", "/docs/audit-log", "/docs/troubleshooting"] },
  ],
});

const auditLog = doc({
  slug: "audit-log",
  group: "Safety and control",
  title: "Audit log and undo snapshots",
  description: "What the WECOMMANDER audit log records for every AI tool call, approval and permission change, and how undo snapshots let you restore a file the AI changed.",
  intro: "Every action through WECOMMANDER leaves a record, and file edits keep the previous content so they can be undone.",
  blocks: [
    { h2: "What the audit log records" },
    { ul: [
      "Every tool call: who (the user behind the AI client or API key), which device or server, the tool, its risk, and the outcome: success, error, denied, approval pending, approval used, allowlisted or run under full trust.",
      "Every approval and denial, by whom.",
      "Every change to AI permissions, allowed commands, autonomous mode and scheduled tasks, with the old and new values where relevant.",
      "Scheduled task runs, as actor scheduled-task:<id>, with who approved the task.",
      "Root actions are marked with runAs.",
    ] },
    { p: "Secrets are masked before anything is stored. For SSH servers the gateway records the tool, server and decision but never command text, file contents or output. Open the log in the dashboard under Administration \u2192 Audit log." },
    { h2: "Undo snapshots" },
    { ul: [
      "fs_replace and edit_block keep the previous content of the file; fs_write and fs_append do so with with_undo (files up to 4 MiB).",
      "fs_versions lists up to eight snapshots of a file.",
      "fs_undo restores one only if the file has not changed since (its SHA-256 must match), so a newer change is never lost. The snapshot is used up.",
      "A file written as root because the service user could not write it has no snapshot.",
      "You can ask the AI to undo its change, or do it yourself through an MCP client.",
    ] },
    { h2: "Local logs" },
    { p: "Local MCP keeps its own audit file on your computer (time, client, tool, server, risk, outcome; never content). The agent's local mode writes one with --audit-log." },
    { see: ["/docs/approvals", "/docs/secret-masking", "/docs/mcp-tools"] },
  ],
});

const secretMasking = doc({
  slug: "secret-masking",
  group: "Safety and control",
  title: "Secret masking",
  description: "How WECOMMANDER masks passwords, tokens and keys in command, terminal and log output on the device before the result reaches the AI, and what is not masked.",
  intro: "Command output often contains secrets: a token in an environment dump, a password in a config line. WECOMMANDER masks them on the device, before the result leaves it, so the AI does not see them.",
  blocks: [
    { h2: "What is masked" },
    { ul: [
      "Private key blocks.",
      "Authorization header values and credentials inside URLs.",
      "Well-known token formats: GitHub, GitLab, Slack, AWS access key ids, sk- keys and JWTs.",
      "The values of NAME=value and \"name\": \"value\" pairs whose name mentions a password, secret, token, API key or credential. The name stays visible; the value becomes [REDACTED], and the result says how many values were masked.",
    ] },
    { h2: "Where" },
    { p: "Output of process_exec, process_list, task_status, terminal_read and terminal_read_page on agents; log_query and docker_container_logs; command output and process lists on SSH servers (in your app, then again on the gateway); scheduled task output; and audit text." },
    { h2: "What is not masked" },
    { ul: [
      "File reads. Editing tools need the exact content, and you chose which folders the AI may read: keep secret files outside the allowed folders.",
      "Secrets in a form the patterns do not recognise. Masking is best effort, not a guarantee.",
    ] },
    { h2: "Turning it off" },
    { p: "On by default. On an agent run webrising-commender --config <path> capabilities --redact-output off and restart the service; in local mode start with --no-redact. policy_info reports whether it is on." },
    { see: ["/docs/security-model", "/docs/agent"] },
  ],
});

const securityModel = doc({
  slug: "security-model",
  group: "Safety and control",
  title: "Security model in depth",
  description: "The layers that keep AI access under control: outbound-only agent, allowed folders checked on the device, signed single-use approvals, safety net, secret masking, encrypted sync, OAuth and browser sessions.",
  intro: "The AI never gets a shell account. It gets tools whose limits are enforced on the device and whose risky calls a person approves. This page collects the layers in one place; the short version is on the Security page.",
  blocks: [
    { h2: "On the device" },
    { ul: [
      "No listening port: the agent connects out over TLS. No SSH key on the machine is needed for it.",
      "Least privilege: a normal user by default (wecommander on Linux, your own user on Windows and macOS); root only with two keys, Linux only.",
      "Allowed folders: paths are resolved before they are checked, and symbolic links leading outside are refused.",
      "Local switches (commands off, file writes off, root ceiling, redaction, system logs) live only in the agent's config; the gateway and the AI cannot change them.",
      "High-risk actions run only with an approval signed for that device and that exact action; the master signing secret never leaves the gateway, each device gets its own derived key.",
    ] },
    { h2: "On the gateway" },
    { ul: [
      "Role checks: viewers read, operators run tools, admins and owners approve and manage.",
      "Approvals bound to the exact action, single use, with expiry.",
      "The safety net and the allowed-command rules, re-checked on every match.",
      "AI clients and API keys cannot change permissions, allowed commands or autonomous mode, and cannot approve.",
      "Audit log with secrets masked; request and response sizes capped; rate limits on sign-in, pairing and invitations.",
    ] },
    { h2: "Accounts and sign-in" },
    { ul: [
      "Passwords are stored as salted scrypt hashes; session cookies are HttpOnly, SameSite=Strict and Secure, with CSRF protection.",
      "MCP clients use OAuth 2.1 with PKCE: one-time codes valid 5 minutes, access tokens for 1 hour, rotating refresh tokens for 30 days. OAuth tokens work only on /mcp.",
      "Disabling a user or removing them from the workspace ends their access at the next request.",
      "Device credentials and pairing codes are random and stored only as hashes; pairing codes are single use and expire.",
    ] },
    { h2: "Your data" },
    { ul: [
      "SSH passwords and keys stay in your computer's keychain; sync and the team library are end-to-end encrypted, and terminal contents do not pass through WECOMMANDER's servers.",
      "With Hybrid Access the server's address, user and credentials never leave your computer.",
      "Card details are handled by Paddle and never reach WECOMMANDER.",
    ] },
    { h2: "Honest limits" },
    { ul: [
      "Commands run with the rights of the user they run as; a command can read whatever that user can, even outside the allowed folders. Grant the agent's user access only to what the AI should use.",
      "Over SSH there is no folder limit.",
      "Secret masking and the safety net are guards, not guarantees.",
    ] },
    { see: ["/security", "/docs/ai-permissions", "/docs/secret-masking", "/docs/hybrid-access"] },
  ],
});

// ---------------------------------------------------------------------------
// Workspace and billing
// ---------------------------------------------------------------------------

const teams = doc({
  slug: "teams-and-roles",
  group: "Workspace and billing",
  title: "Workspaces, teams, roles and API keys",
  description: "Workspaces, the owner, admin, operator and viewer roles, inviting members, API access keys for MCP clients, and the workspace region.",
  intro: "Everything in WECOMMANDER belongs to a workspace: devices, approvals, scheduled tasks, the audit log and the plan. You can belong to several workspaces and switch between them; create a new one from Account.",
  blocks: [
    { h2: "Roles" },
    { table: {
      head: ["Role", "Can"],
      rows: [
        ["Viewer", "See devices and read with read-only tools; use servers shared in the team library without changing them."],
        ["Operator", "Run tools on devices; high-risk actions still need an approval. Gives the team key to new members' apps."],
        ["Admin", "Approve and deny, manage members, devices, AI permissions, allowed commands, autonomous mode and scheduled tasks."],
        ["Owner", "Everything, including billing and the region. A workspace always keeps at least one owner."],
      ],
    } },
    { p: "Admins cannot grant a role above their own. Changing a role or removing a member takes effect at once; a removed member's browser sessions for that workspace end." },
    { h2: "Inviting members" },
    { ol: [
      "Administration \u2192 Team \u2192 Invite: enter the e-mail address and choose the role.",
      "Copy the invitation link and send it through a channel you trust. It is valid for 72 hours and only once.",
      "The person creates an account with the link or joins with their existing account (they confirm with their current password).",
    ] },
    { p: "Pending invitations count toward the plan's member limit; you can revoke one before it is used." },
    { h2: "API access keys" },
    { p: "For MCP clients and scripts that use a bearer token instead of OAuth: AI \u2192 MCP tools \u2192 create an access key with a name and a role. The key is shown only once; store it safely and revoke it when no longer needed. Use the lowest role that works. Keys cannot approve actions or change AI permissions." },
    { h2: "Region" },
    { p: "Owners can choose a preferred region for the workspace on the Team page, or leave it on automatic. Devices move to the new region on their next connection; if the region is unavailable, WECOMMANDER falls back to another healthy one without re-pairing." },
    { see: ["/docs/team-library", "/docs/plans-and-billing", "/docs/connect-other-clients"] },
  ],
});

const billing = doc({
  slug: "plans-and-billing",
  group: "Workspace and billing",
  title: "Plans, billing and refunds",
  description: "WECOMMANDER Free, Pro and Team plans, what the limits cover, payment through Paddle, cancelling, the 14-day refund and what happens at a limit.",
  intro: "WECOMMANDER is a hosted service with Free, Pro and Team plans. Plans differ by the number of devices, team members, API keys, monthly tool calls and scheduled tasks. Current prices and limits are always on the Pricing page.",
  blocks: [
    { h2: "What the plans limit" },
    { ul: [
      "Devices, members (pending invitations count) and API access keys.",
      "Tool calls per month on the Free plan; when they are used up the AI is told when they reset and where to upgrade.",
      "Scheduled tasks: up to 10 on the Free plan, never more than 100 per workspace.",
    ] },
    { p: "When a limit is reached, new devices, members or keys are refused with a clear reason; existing ones keep working. The desktop SSH client itself works without an account or a plan." },
    { h2: "Paying" },
    { ul: [
      "Plans are monthly subscriptions sold by Paddle.com, the Merchant of Record: Paddle charges, issues the invoice and handles taxes. Card details never reach WECOMMANDER.",
      "Choose a plan on the Pricing page; checkout runs on Paddle, which shows the price, taxes and payment details. The subscription becomes active after Paddle confirms the payment.",
      "Under Plans & billing, the Paddle customer portal shows receipts and invoices and lets you change the payment method or cancel. Cancel any time; a subscription set to cancel stays active until the end of the period.",
      "You can also send a cancellation or refund request from Plans & billing. Sending a request does not cancel or refund by itself; it is reviewed and answered.",
      "Full refund within 14 days of the first payment. See the Refund policy for details.",
    ] },
    { h2: "Legal pages" },
    { p: "The refund policy is at https://wecommander.app/refund; the terms, privacy policy and prices are linked below." },
    { see: ["/pricing", "/terms", "/privacy"] },
  ],
});

// ---------------------------------------------------------------------------
// Help and reference
// ---------------------------------------------------------------------------

const troubleshooting = doc({
  slug: "troubleshooting",
  group: "Help and reference",
  title: "Troubleshooting",
  description: "Fixes for common problems: agent offline, host key changed, approval not arriving, SSH server unreachable for AI, root not available, commands refused, updates and plan limits.",
  intro: "Find the symptom, then follow the steps. Error codes in brackets are what the AI client or app shows.",
  blocks: [
    { h2: "The device shows offline" },
    { ul: [
      "Linux: sudo systemctl status webrising-commender --no-pager and sudo journalctl -u webrising-commender -n 30 --no-pager. The service must be active; network access to wecommander.app over HTTPS must be allowed outbound.",
      "Windows and macOS: the app must be running; the agent runs inside it and stops when you quit. The Windows app restarts a stopped agent and keeps trying every 5 minutes; \u201cKeep agent running\u201d in the panel turns this on.",
      "Windows server (agent alone): the agent runs only while its user is signed in.",
      "A revoked device does not come back: install again and approve it as a new device.",
    ] },
    { h2: "Host key changed" },
    { p: "The app warns before connecting when a server's key differs from the one you trusted. If the server was reinstalled or its key rotated, check the new fingerprint with the server's provider and accept it, or remove the old entry in Known hosts and connect again. Until then AI access to that server is refused (host_key_untrusted)." },
    { h2: "Approval requests do not arrive" },
    { ul: [
      "Check the dashboard's Approvals page: requests always appear there.",
      "Windows: send a test notification from the Management Center. If it does not appear, allow notifications for WECOMMANDER in Windows settings and make sure banners are on; an organisation policy can block them, and then the panel opens on new requests instead.",
      "E-mail: requests are e-mailed to admins and owners; check spam. Only admins and owners can approve.",
      "A request expires after 10 minutes (5 for SSH servers); the AI must try again to create a new one.",
      "A request for an SSH server is shown only to the person whose computer shares it.",
    ] },
    { h2: "The AI cannot reach an SSH server" },
    { ul: [
      "connector_offline: the computer sharing the server is off, asleep, or the app is closed or signed out.",
      "host_key_untrusted or needs_credential: connect once in the app, trust the host key and save the password or a key without a passphrase.",
      "unsupported_for_target: that tool is only for agent devices.",
      "A read-only shared server refuses every change.",
    ] },
    { h2: "Commands are refused" },
    { ul: [
      "approval_required: approve the request, then let the AI repeat the call.",
      "safety_net_blocked: the command is on the safety net list. Run it yourself, or turn the safety net off for that device with your password if you really mean it.",
      "Outside the allowed folders: the path is outside the device's allowed folders; change them with sudo wecommander-setup --allowed-root on Linux.",
      "Refused by the device: commands or file writes are switched off on that device (--no-commands, --read-only).",
      "run_as_root_unavailable or device_not_root_capable: run the --allow-root command on the machine first, then turn root on in the dashboard.",
      "browser_session_required: changing permissions is done by an admin in the browser, never by an AI or API key.",
    ] },
    { h2: "Local AI client cannot connect (Windows)" },
    { ul: [
      "wecommander_not_running: open the WECOMMANDER app; local AI access works while it runs.",
      "client_not_allowed or client_denied: allow the client in the app (Settings \u2192 AI); a denied client is refused until you forget it.",
      "After moving or updating the app, Settings \u2192 AI offers to fix a client config that points to an old path.",
    ] },
    { h2: "Updates" },
    { ul: [
      "If an update stops with a checksum message, nothing was changed; try again later.",
      "Linux agent: run the install command again; the device identity is kept.",
      "Store copy: updates come from the Microsoft Store.",
    ] },
    { h2: "Limits" },
    { ul: [
      "monthly_tool_call_limit: the Free plan's monthly tool calls are used up; upgrade or wait for the reset.",
      "quota_exceeded or billing_required: a device, member or key limit was reached, or the plan needs attention; see Plans & billing.",
      "scheduled_task_limit: the plan's scheduled task limit was reached.",
    ] },
    { see: ["/faq", "/docs/agent", "/docs/approvals", "/docs/hybrid-access"] },
  ],
});

const glossary = doc({
  slug: "glossary",
  group: "Help and reference",
  title: "Glossary",
  description: "Short definitions of the terms used in WECOMMANDER: agent, gateway, MCP, target, Hybrid Access, connector, trust level, approval, safety net, allowed folder and more.",
  intro: "The words used across the apps, the dashboard and these docs, in alphabetical order.",
  blocks: [
    { table: {
      head: ["Term", "Meaning"],
      rows: [
        ["Agent", "The WECOMMANDER program on a machine that carries out tool calls. It connects out to the gateway and enforces the device's limits."],
        ["Allowed folders", "The only folders an agent's file tools may touch (also called allowed roots)."],
        ["Allowed commands (allowlist)", "Command patterns that run without approval under standard trust; process_exec only."],
        ["API access key", "A secret for MCP clients and scripts that use a bearer token; it acts with the role it was given."],
        ["Approval", "A person's decision that one exact high-risk action may run once."],
        ["Audit log", "The record of every tool call, approval and permission change."],
        ["Autonomous mode", "Full trust for many devices for a time, with automatic expiry."],
        ["Classic mode", "The Windows app without the Dock, working in windows."],
        ["Connector", "The WECOMMANDER app on your computer when it carries AI calls to SSH servers (Hybrid Access)."],
        ["Device", "A machine with the agent, enrolled in a workspace."],
        ["Dock", "The taskbar-like bar of the Windows app on a screen edge, with live server meters and panels."],
        ["Gateway", "The WECOMMANDER service at wecommander.app: MCP endpoint, sign-in, approvals, audit and the dashboard."],
        ["Host / server", "A saved connection in the desktop app (SSH, Telnet, serial or Mosh)."],
        ["Hybrid Access", "Sharing SSH servers with AI through your own computer, with nothing installed on the server."],
        ["Identity", "A reusable user name with a key or password for many servers."],
        ["Known hosts", "The servers' host keys you trusted."],
        ["Management Center", "The part of the desktop app that handles sign-in, approvals, autonomous mode and the agent; on Linux, the app itself."],
        ["MCP", "Model Context Protocol, the open standard AI assistants use to call tools."],
        ["Preset", "How a shared SSH server may be used by AI: read only, with approval, or timed autonomous (local only)."],
        ["Run as", "Whether an agent's commands run as its normal user or as root."],
        ["Safety net", "A list of catastrophic commands refused on every trust level."],
        ["Scheduled task", "A command WECOMMANDER runs for you on a schedule."],
        ["Secret masking", "Replacing passwords, tokens and keys in output with [REDACTED] before the AI sees it."],
        ["Snippet", "A saved command you send into a terminal."],
        ["Target", "A place AI tools can act on: an agent device or a shared SSH server (targets_list)."],
        ["Team library", "Servers and snippets shared with the workspace, end-to-end encrypted."],
        ["Trust level", "strict, standard or full: how many high-risk actions need an approval on a device or SSH server."],
        ["Workspace", "The account unit that owns devices, members, approvals, audit and the plan."],
      ],
    } },
    { see: ["/docs", "/faq"] },
  ],
});

/** Every documentation page under /docs/<slug>, in sidebar order. */
export const docPages: PublicPage[] = [
  gettingStarted, install, webDashboard,
  desktopApp, hosts, terminals, sftp, tunnels, protocols, keys, syncBackup, teamLibrary,
  windowsDock, macosMenuBar, linuxCenter,
  serverOverview, diskCleanup, processes, serverTimers, docker, scheduledTasks,
  mcp, connectClaude, connectChatgpt, connectOther, localMcp, agent, hybrid, mcpTools,
  aiPermissions, approvals, auditLog, secretMasking, securityModel,
  teams, billing,
  troubleshooting, glossary,
];

/** The /docs index: every section with its pages and one-line summaries. */
export function docsIndexBlocks(): Block[] {
  return docGroups.flatMap((group): Block[] => [
    { h2: group },
    { see: docPages.filter((p) => p.docGroup === group).map((p) => p.path) },
  ]);
}
