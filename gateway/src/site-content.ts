// Public, crawlable description of WECOMMANDER: one source for the server-
// rendered HTML of public pages (search engines and AI crawlers read it
// without running JavaScript), the JSON-LD, /llms.txt, /llms-full.txt and the
// sitemap. Keep it factual: assistants quote it.

import { releaseNotes } from "./release-notes.gen.js";
import { docGroups, docPages, docsIndexBlocks } from "./docs-content.js";

export type Block =
  | { h2: string }
  | { h3: string }
  | { p: string }
  | { ul: string[] }
  | { ol: string[] }
  | { code: string }
  | { note: string }
  /** Links to other public pages (paths), shown with their heading and description. */
  | { see: string[] }
  | { table: { head: string[]; rows: string[][] } };

export type Faq = { q: string; a: string };

/** The English release notes, newest first: one heading and list per app update. */
function changelogBlocks(): Block[] {
  const app = (platforms: string[]) =>
    platforms.length === 0 || platforms.length === 2 ? "Windows and macOS" : platforms.includes("macos") ? "macOS" : "Windows";
  return releaseNotes.flatMap((note): Block[] => [{ h2: `${note.date} · ${app(note.platforms)}` }, { ul: note.items.en }]);
}

export type PublicPage = {
  path: string;
  title: string;
  description: string;
  heading: string;
  intro: string;
  blocks: Block[];
  faq?: Faq[];
  howTo?: { name: string; steps: string[] };
  /** Served by the React app as a content page (not a marketing page). */
  content?: boolean;
  /** Listed in /llms.txt under this section. */
  section: "Product" | "Docs" | "Guides" | "Legal";
  /** Documentation pages (/docs/<slug>): their sidebar group (docs-content.ts). */
  docGroup?: string;
};

export const productName = "WECOMMANDER";
export const productSummary =
  "WECOMMANDER is a desktop SSH client and server management app for Windows and macOS (SSH, SFTP, tunnels, snippets, disk cleanup, live monitoring, scheduled tasks, end-to-end encrypted sync) and a remote MCP (Model Context Protocol) server that lets AI assistants such as Claude, ChatGPT and Cursor use the terminals and files of your own Windows, macOS and Linux machines through one MCP URL, with human approval for risky actions, per-device limits and a full audit log.";

const facts: string[] = [
  "Current release: WECOMMANDER 1.0 (November 2026), the desktop app for Windows and macOS, the agent and the hosted remote MCP server.",
  "Desktop app for Windows 10/11 and macOS (Linux preview): saved hosts with groups, tabbed and split terminals, SFTP file manager, local/remote/SOCKS tunnels, jump hosts, Telnet, serial ports and Mosh, snippets, autocomplete, broadcast typing, session logs and themes.",
  "Server management without installing anything on the server: overview, what fills the disk, safe cleanup (old logs, package caches, Docker build cache and unused images, per Docker daemon including rootless Docker), processes and zombie fixes.",
  "Two app modes on Windows: Dock mode puts the WECOMMANDER Dock on a screen edge, looking like the Windows taskbar, with live CPU, memory and disk charts for a server; Task Manager, Tasks, Terminal, approvals and settings open as drop-down panels from it. Classic mode runs the app in its windows without a Dock.",
  "The Dock is dragged like the taskbar to a screen edge or left floating, can be locked in place, and its app icon opens a Start-like panel with server search, shortcuts, account and settings. The Windows notification area keeps only the Management Center icon. On macOS, live server monitoring is in the menu bar.",
  "After each update the desktop apps show a short what's-new note once; every note is also on https://wecommander.app/changelog.",
  "Scheduled tasks run by WECOMMANDER itself: a command on a device or a saved SSH server every night, every N minutes or once; due runs go to the device's agent even while your computer is off, with history, output and failure e-mails. AI clients can list them and create, edit, delete or run one; each change needs a human approval unless the device is on full trust (tasks on SSH servers always need one).",
  "Server timers (systemd, cron read-only) and Windows scheduled tasks can be viewed and managed from the app, each change showing the exact command first.",
  "The apps and the website are available in English, Turkish, German, Brazilian Portuguese, Spanish and French.",
  "End-to-end encrypted sync of hosts, keys and snippets across devices; team library and live shared terminals.",
  "One MCP URL for all your machines: https://wecommander.app/mcp (OAuth sign-in from Claude, ChatGPT and other MCP clients).",
  "A small agent runs on each machine (Windows, macOS, Linux) and keeps one outbound encrypted connection; no inbound ports, VPN or SSH keys are needed.",
  "Two ways to connect a server for AI: with the agent (installed on the machine; works while your own computer is off, root on Linux with two keys), or over SSH with nothing installed (Hybrid Access from the Windows, macOS and Linux apps; your computer and the app must be on, commands run with the SSH user's rights or as root through sudo when allowed). Both get the same AI permissions: trust level up to full, allowed commands and the safety net. Choose the agent for always-on work, SSH to try quickly or where nothing can be installed.",
  "Hybrid Access: SSH servers without an agent can be shared with AI from the WECOMMANDER app on Windows, macOS or Linux. Nothing is installed on the server; the connection runs through WECOMMANDER on your own computer, so SSH keys never leave it and that computer and the app must be on. You choose which servers are shared. Tools: commands, files (SFTP), overview, disk usage, processes, cleanup, process signals, systemd timers and cron, and the Docker tools. Reads run directly; changes follow that server's AI permissions (approval, allowed commands or full trust); servers shared read-only can never be changed. Root runs through sudo only if the computer's setting for that server allows sudo and an admin turns it on.",
  "AI permissions per device and per SSH server, set by an admin in the Windows or macOS app or the web dashboard, never by an AI client: trust level strict, standard or full, with full for a set time or with no limit.",
  "The agent runs as a normal user (not root/SYSTEM) by default and only inside the folders you allow. Running as root is possible on Linux only, with two keys: the machine's owner runs the installer with --allow-root on the machine, then an admin turns it on for that device with their password. Not available on Windows or macOS agents.",
  "A safety net, on by default, blocks irreversible commands (wiping disks, rm -rf /, shutdown and reboot, stopping the agent itself) on every trust level, even as root with full trust; turning it off needs the admin's password.",
  "High-risk actions (running commands, deleting files, killing processes, opening terminals, starting, stopping or restarting containers, changing scheduled tasks) wait for a human approval of that exact action, unless you allow a command pattern or put the device or SSH server on full trust (for a set time or with no limit).",
  "Approvals arrive in the web dashboard, by e-mail and in the Management Center desktop app as Windows notifications with Approve / Deny buttons.",
  "Secrets in command and terminal output (tokens, passwords, keys) are masked on the device before the result reaches the AI.",
  "Every action is recorded in an audit log; file edits keep undo snapshots.",
  "Tools: read, write, edit, search and move files; run commands; long-running background tasks; interactive terminals; process lists; device health snapshots; log search; PDF, Word and Excel reading; scheduled tasks; server systemd timers and cron (read-only); Docker containers and their logs (secrets masked) per Docker daemon including rootless, with start, stop and restart. Containers, images and volumes are never removed or pruned by these tools, and WECOMMANDER's own containers are never stopped.",
  "Local mode: the same agent can serve MCP over stdio to a local client (Claude Desktop, Cursor) with no account or server.",
];

export const publicPages: PublicPage[] = [
  {
    path: "/",
    section: "Product",
    title: "WECOMMANDER · SSH client, server management and secure MCP for AI",
    description:
      "Your servers, your terminal and your AI in one app: an SSH client with SFTP and tunnels, server disk cleanup and live monitoring, and one remote MCP URL that lets Claude, ChatGPT or Cursor work on your Windows, macOS and Linux machines with human approvals, per-device AI permissions and a full audit trail.",
    heading: "Your servers, your terminal and your AI, in one app",
    intro: productSummary,
    blocks: [
      { h2: "What it does" },
      { ul: facts },
      { h2: "Who it is for" },
      {
        ul: [
          "Developers who want Claude or ChatGPT to work in the real project on their own PC or server.",
          "Small teams and agencies that run a few servers and want AI help with operations without handing out SSH access.",
          "Anyone who wants an AI assistant to read logs, check disk space or edit configuration safely, with a person approving each risky step.",
        ],
      },
      { h2: "How it works in three steps" },
      {
        ul: [
          "Install the agent on a machine with one command and approve the device in your browser.",
          "Add https://wecommander.app/mcp to your AI client as a remote MCP server.",
          "Ask the AI to work on that machine; approve risky actions when they appear.",
        ],
      },
    ],
  },
  {
    path: "/features",
    section: "Product",
    title: "Features · WECOMMANDER",
    description:
      "Terminals, files, background tasks, logs and health of your machines for AI assistants, with approvals, allowed folders, secret masking, undo and an audit log.",
    heading: "Features",
    intro: "Everything an AI assistant needs to work on a real machine, with the controls a person needs to stay in charge.",
    blocks: [
      { h2: "Desktop app (SSH client)" },
      {
        ul: [
          "Saved hosts with groups, import from ~/.ssh/config; tabbed and split terminals; SFTP file manager.",
          "Local, remote and SOCKS tunnels, jump hosts, SSH agent and FIDO2 keys; Telnet, serial ports and Mosh.",
          "Snippets, autocomplete from history, typing into every tab at once, session logs and terminal themes.",
          "End-to-end encrypted sync of hosts, keys and snippets; team library and live shared terminals.",
          "Windows: Dock mode (a taskbar-like Dock on a screen edge whose buttons open Task Manager, Tasks, Terminal, approvals and settings as drop-down panels) or Classic mode (windows, no Dock).",
        ],
      },
      { h2: "Server management" },
      {
        ul: [
          "Overview: CPU, memory, disks, uptime, pending updates and reboots.",
          "Disk: the largest folders, and which Docker daemon a storage folder belongs to.",
          "Safe cleanup with progress: old logs, package caches, crash dumps, and per Docker daemon (system and rootless) build cache and unused images through Docker's own prune; running containers and volumes are never touched.",
          "Processes and zombie fixes; live monitoring in the Dock (Windows) and the menu bar (macOS).",
        ],
      },
      { h2: "For the AI" },
      {
        ul: [
          "Files: read (also line ranges, PDF, Word, Excel), write, exact search-and-replace edits, search by name or content, move, create folders.",
          "Commands: one-off commands with timeouts, long-running background tasks that survive disconnects, interactive terminals.",
          "Operations: process list, device health snapshot (CPU, memory, disks, network, top processes), log search in the system journal or log files.",
          "Server management tools: overview, disk usage, cleanup scan and approved cleanup, processes, zombie fixes and service restarts.",
          "Scheduled tasks: list them, and create, edit, delete or run one with approval; read the server's systemd timers and cron.",
          "Docker: list containers and read their logs (secrets masked) per daemon, including rootless; start, stop or restart with approval. Never removes or prunes; WECOMMANDER's own containers cannot be stopped.",
          "Desktop Commander-compatible tool names, so existing prompts keep working.",
        ],
      },
      { h2: "For the person in charge" },
      {
        ul: [
          "Allowed folders per device; nothing outside them can be read or written.",
          "Approval of each high-risk action, from the dashboard, e-mail or the Management Center desktop app.",
          "Trust levels per device (strict, standard, full; full for a set time or with no limit), allowed command patterns, and autonomous mode with one-click stop.",
          "Run as root on Linux only with two keys (the machine owner's --allow-root, then an admin's password), and a safety net that blocks irreversible commands even as root.",
          "Secret masking in command output, undo snapshots for file edits, and a full audit log.",
          "Teams: owners, admins, operators and viewers; API tokens with roles.",
        ],
      },
    ],
  },
  {
    path: "/how-it-works",
    section: "Product",
    title: "How it works · WECOMMANDER",
    description:
      "An agent on each machine keeps an outbound encrypted connection to the WECOMMANDER gateway; AI clients connect to one MCP URL; risky actions wait for your approval.",
    heading: "How it works",
    intro: "Three parts: the agent on your machines, the gateway, and your AI client.",
    blocks: [
      { h2: "Agent" },
      { p: "A single binary on Windows, macOS or Linux. It runs as a normal user by default (root only if the machine's owner allows it on the machine and an admin turns it on), connects out to the gateway over TLS, and enforces the allowed folders, read-only and no-command switches and secret masking on the device itself." },
      { h2: "Gateway" },
      { p: "Signs in AI clients with OAuth, routes each tool call to the right machine, holds approval requests, records the audit log, and serves the dashboard. No inbound port is opened on your machines." },
      { h2: "AI client" },
      { p: "Claude, ChatGPT, Cursor or any client that supports remote MCP servers adds one URL and lists the machines it may use." },
    ],
  },
  {
    path: "/pricing",
    section: "Product",
    title: "Pricing · WECOMMANDER",
    description: "WECOMMANDER plans for individuals and teams. See the current prices and limits on this page.",
    heading: "Pricing",
    intro: "Plans differ by the number of devices, team members and API tokens. Current prices are shown on this page.",
    blocks: [{ p: "Free, Pro and Team plans for the hosted WECOMMANDER service; payments through Paddle, the Merchant of Record, with a 14-day refund window." }],
  },
  {
    path: "/install",
    section: "Docs",
    title: "Install · WECOMMANDER",
    description: "Install the WECOMMANDER agent on Windows, macOS or Linux with one command and connect it to your AI client.",
    heading: "Install",
    intro: "Each command downloads the agent from the official release, checks its SHA-256, installs it and opens the device approval in your browser.",
    blocks: [
      { h2: "Linux (Ubuntu, Debian) and macOS" },
      { code: "curl -fsSL https://wecommander.app/install.sh | sh" },
      { h2: "Windows (PowerShell): the WECOMMANDER app with the agent inside" },
      { code: "irm https://wecommander.app/install.ps1 | iex" },
      { h2: "Windows server without a desktop: the agent alone" },
      { code: "irm https://wecommander.app/install/agent.ps1 | iex" },
      { h2: "Management Center for macOS (menu bar app, macOS 13 or newer)" },
      { code: "curl -fsSL https://wecommander.app/install/center.sh | sh" },
    ],
    howTo: {
      name: "Connect an AI assistant to your machine with WECOMMANDER",
      steps: [
        "Run the install command for your operating system on the machine.",
        "Approve the device in the browser page that opens and choose its allowed folder.",
        "Add https://wecommander.app/mcp to Claude, ChatGPT or Cursor as a remote MCP server and sign in.",
        "Ask the AI to work on the machine and approve risky actions when asked.",
      ],
    },
  },
  {
    path: "/docs",
    section: "Docs",
    content: true,
    title: "Documentation · WECOMMANDER",
    description: "The complete WECOMMANDER guide, A to Z: install, the desktop SSH client, server management, scheduled tasks, connecting Claude, ChatGPT, Cursor and VS Code over MCP, every MCP tool, AI permissions, approvals, security and troubleshooting.",
    heading: "Documentation",
    intro: "Everything WECOMMANDER does, one topic per page. Start with Getting started, or jump to a section below.",
    blocks: docsIndexBlocks(),
  },
  ...docPages,
  {
    path: "/security",
    section: "Docs",
    content: true,
    title: "Security model · WECOMMANDER",
    description: "How WECOMMANDER keeps AI access to your machines under control: outbound-only agent, allowed folders, approvals, secret masking, audit log.",
    heading: "Security model",
    intro: "The AI never gets a shell account. It gets a set of tools whose limits are enforced on the device and whose risky calls a person approves.",
    blocks: [
      { ul: [
        "Outbound-only: the agent connects out over TLS; no listening port, no SSH key on the machine.",
        "Least privilege: the agent runs as a normal user by default, inside allowed folders only; writes and commands can be switched off per device, on the device. Root needs two keys: the machine owner allows it on the machine, then an admin turns it on with their password.",
        "Approvals: high-risk actions need a single-use approval bound to the exact action and device, unless an admin put the device or SSH server on full trust or allowed that command.",
        "Safety net: on by default, it blocks irreversible commands such as wiping disks, rm -rf / and shutdown on every trust level, even as root; turning it off needs a password.",
        "AI clients cannot change their own limits: trust levels, autonomous mode and allowed commands are changed only by an admin in a browser session or the Management Center.",
        "Secret masking: tokens, passwords and private keys in command output are masked before they leave the device.",
        "Audit: every tool call, approval and policy change is logged with who, what and when.",
      ] },
    ],
  },
  {
    path: "/faq",
    section: "Docs",
    content: true,
    title: "FAQ · WECOMMANDER",
    description: "Answers about connecting AI assistants to your computers and servers with WECOMMANDER: safety, supported systems, clients and local mode.",
    heading: "Frequently asked questions",
    intro: "Short answers to the questions people ask before connecting an AI assistant to their machines.",
    blocks: [],
    faq: [
      { q: "What is WECOMMANDER?", a: productSummary },
      { q: "Which AI assistants work with it?", a: "Any client that supports remote MCP servers: Claude (web, desktop, Claude Code), ChatGPT connectors, Cursor and others. Local mode also works with stdio-only clients." },
      { q: "Which operating systems are supported?", a: "Windows 10 and 11, macOS 13 or later, and Linux (Ubuntu and Debian packages; other distributions with the binary)." },
      { q: "Agent or SSH: which way should I connect a server?", a: "With the agent, a small program runs on the machine (Windows, macOS, Linux) and keeps one outbound connection: it works while your own computer is off, has the full tool set, and can be put on full trust or, on Linux, run as root with two keys. Over SSH (Hybrid Access, from the Windows, macOS or Linux app), nothing is installed on the server: WECOMMANDER on your computer connects with your SSH keys, which never leave it, so your computer and the app must be on. SSH servers get the same AI permissions as the agent: trust level up to full, allowed commands, root through sudo with two keys, and the safety net. Choose the agent for always-on or autonomous work, SSH to try quickly or where you cannot install anything." },
      { q: "Do I need to open a port or set up a VPN?", a: "No. The agent makes an outbound TLS connection to the gateway; nothing listens on your machine." },
      { q: "Can the AI run any command on my server?", a: "Only inside the folders you allow, as a normal user unless the machine's owner allowed root and an admin turned it on, and every command waits for your approval unless you allowed that command pattern or put the device on full trust. A safety net blocks commands like rm -rf / or reboot unless you switch it off." },
      { q: "How do I approve actions quickly?", a: "In the dashboard, from the approval e-mail, or with the Management Center desktop app on Windows, which shows each request as a notification with Approve and Deny buttons." },
      { q: "Does the AI see my passwords or API keys?", a: "Common secrets in command and terminal output are masked on the device before the result is sent. File reads are exact, so keep secret files outside the allowed folders." },
      { q: "Can I undo a change the AI made?", a: "File edits keep undo snapshots; the AI or you can restore the previous content if the file has not changed since." },
      { q: "Can I use it without an account?", a: "Yes, in local mode: the agent serves MCP over stdio to a local client, with writes and commands off unless you enable them." },
      { q: "Where does WECOMMANDER run?", a: "The desktop app and the agent run on your own computers and servers; the account, approvals and the MCP endpoint are a hosted service at wecommander.app. A self-hosted edition is not offered." },
    ],
  },
  {
    path: "/alternatives",
    section: "Docs",
    content: true,
    title: "Alternatives and comparison · WECOMMANDER",
    description: "Ways to give an AI assistant access to your computers and servers: local MCP file servers, SSH-based tools, remote management tools and WECOMMANDER, compared.",
    heading: "Ways to give an AI access to your machines",
    intro: "There are several ways to let an AI assistant work on real computers. They differ in where they run, how many machines they reach and how much control you keep.",
    blocks: [
      { table: {
        head: ["", "Local desktop MCP server", "SSH-based AI tools", "Remote management (RMM) tools", "WECOMMANDER"],
        rows: [
          ["Works with Claude, ChatGPT, Cursor over one URL", "Local client only", "Varies", "No", "Yes"],
          ["Machines reached", "The one it runs on", "Any with SSH access", "Managed fleet", "Any with the agent (Windows, macOS, Linux)"],
          ["Network setup", "None", "Open SSH port, keys, often VPN", "Vendor agent", "None: outbound connection only"],
          ["Human approval of each risky action", "Usually not", "Usually not", "Not for AI actions", "Yes, from web, e-mail or desktop notifications"],
          ["Limits enforced on the device", "Allowed folders", "Shell user rights", "Vendor policies", "Allowed folders, read-only and no-command switches, secret masking"],
          ["Audit log of AI actions", "Local logs", "Shell history", "Yes", "Yes, per tool call and approval"],
          ["Runs without an account", "Yes", "Yes", "No", "Yes, in local mode"],
        ],
      } },
      { h2: "When another option fits better" },
      { ul: [
        "One personal computer, no remote access needed: a local desktop MCP server is the simplest choice (WECOMMANDER's local mode covers this too).",
        "You already manage many servers with SSH and want no extra agent: an SSH-based tool may fit, at the cost of exposing SSH and giving the AI a shell account.",
        "Large fleets with patching and inventory needs: a remote management (RMM) tool; it is not designed for AI assistants.",
      ] },
    ],
  },
  {
    path: "/guides/claude-server-terminal",
    section: "Guides",
    content: true,
    title: "Give Claude secure access to your server's terminal · WECOMMANDER",
    description: "Step by step: let Claude run commands and edit files on your Linux, Windows or macOS server without opening SSH, with approval of each command.",
    heading: "Give Claude secure access to your server's terminal",
    intro: "Claude can work on a real server through a remote MCP server. With WECOMMANDER the server needs no open port, Claude gets no shell account, and you approve each command.",
    blocks: [
      { h2: "Steps" },
      { ul: [
        "On the server: curl -fsSL https://wecommander.app/install.sh | sh (Windows: irm https://wecommander.app/install.ps1 | iex).",
        "Approve the device in the browser and choose the folder Claude may use, for example /srv/app.",
        "In Claude: Settings → Connectors → Add custom connector → https://wecommander.app/mcp → Connect.",
        "Ask Claude, for example: “Check disk usage on my server and show the largest folders in /srv/app.”",
        "Approve the command when the request appears; Claude gets the output and continues.",
      ] },
      { h2: "Why not just give Claude SSH?" },
      { p: "SSH gives a full shell account and needs an open port and keys. Here the agent connects out, stays inside the allowed folder, masks secrets in output, and every command needs your approval for exactly that command." },
    ],
  },
  {
    path: "/guides/remote-mcp-server",
    section: "Guides",
    content: true,
    title: "What is a remote MCP server? · WECOMMANDER",
    description: "A remote MCP server lets AI assistants use tools over the internet with one URL and OAuth sign-in. When you need one and how WECOMMANDER uses it to reach your machines.",
    heading: "What is a remote MCP server?",
    intro: "The Model Context Protocol (MCP) lets AI assistants call tools. A local MCP server runs next to the AI client; a remote MCP server is reached over HTTPS with one URL and a sign-in, so web and mobile AI clients can use it too.",
    blocks: [
      { h2: "When you need a remote MCP server" },
      { ul: [
        "You use Claude or ChatGPT on the web or phone, which cannot start local programs.",
        "The machine the AI should work on is not the one you sit at, such as a server or an office PC.",
        "Several people or several machines share the same tools and policies.",
      ] },
      { h2: "How WECOMMANDER does it" },
      { p: "The remote MCP endpoint is https://wecommander.app/mcp. Behind it, an agent on each of your machines carries out the tool calls, with allowed folders, approvals and an audit log." },
    ],
  },
  {
    path: "/guides/chatgpt-windows-files",
    section: "Guides",
    content: true,
    title: "Let ChatGPT work with files on your Windows PC · WECOMMANDER",
    description: "Connect ChatGPT to a folder on your Windows computer to read, search and edit files, with your approval for anything risky.",
    heading: "Let ChatGPT work with files on your Windows PC",
    intro: "ChatGPT can read and edit files on your Windows PC through a custom MCP connector. Only the folder you choose is reachable.",
    blocks: [
      { ul: [
        "In PowerShell: irm https://wecommander.app/install.ps1 | iex. The WECOMMANDER app opens your browser to sign in and connects this PC by itself; the folder it shares is C:\\Users\\you\\WECOMMANDER.",
        "In ChatGPT: Settings → Connectors → create a custom connector with https://wecommander.app/mcp (OAuth).",
        "Ask ChatGPT to summarise, search or edit documents in that folder; Word, Excel and PDF files can be read too.",
        "Deleting files and running commands wait for your approval; writing, editing and moving files run directly and edits keep undo snapshots.",
      ] },
    ],
  },
  {
    path: "/guides/ai-approvals",
    section: "Guides",
    content: true,
    title: "Approve AI actions on your machines · WECOMMANDER",
    description: "Keep a human in the loop when an AI assistant works on your computers: single-use approvals, allowed commands, trust levels and autonomous mode with automatic expiry.",
    heading: "Keep a human in the loop: approving AI actions",
    intro: "Read-only actions run directly; actions that change things wait for a person. You choose how strict each device is.",
    blocks: [
      { ul: [
        "Single-use approvals: valid once, for exactly the command or file shown, on that device.",
        "Allowed command patterns: routine commands such as df -h run without asking.",
        "Trust levels per device and per SSH server: strict, standard or full; full can be time-limited or have no limit. SSH servers shared read-only can never be changed.",
        "Autonomous mode: switch approvals off for all or selected devices for 30 minutes to indefinitely, with automatic expiry and one-click stop; AI clients cannot turn it on.",
        "Approve from the dashboard, the e-mail, or Windows notifications of the Management Center app.",
      ] },
    ],
  },
  {
    path: "/changelog",
    section: "Product",
    title: "What's new · WECOMMANDER",
    description: "What changed in each WECOMMANDER desktop app update for Windows and macOS, in plain words.",
    heading: "What's new",
    intro: "The same notes the Windows and macOS apps show once after an update, newest first.",
    blocks: changelogBlocks(),
  },
  {
    path: "/privacy",
    section: "Legal",
    title: "Privacy · WECOMMANDER",
    description: "How WECOMMANDER handles account, device and audit data.",
    heading: "Privacy",
    intro: "The privacy policy of WECOMMANDER.",
    blocks: [
      { ul: [
        "We keep account, device, subscription and audit log data to run the service; card details are handled by Paddle and never reach us.",
        "SSH passwords, keys and host details stay in your computer's keychain; sync is end-to-end encrypted and terminal contents do not pass through our servers.",
        "Only necessary HttpOnly session cookies; no advertising or tracking cookies.",
        "Rights under KVKK and GDPR: access, correction, deletion, restriction, objection and portability.",
      ] },
    ],
  },
  {
    path: "/terms",
    section: "Legal",
    title: "Terms · WECOMMANDER",
    description: "Terms of service of WECOMMANDER.",
    heading: "Terms",
    intro: "The terms of service of WECOMMANDER.",
    blocks: [
      { ul: [
        "Use the service only on machines you own or are authorised to manage; you are responsible for actions you approve or allow in autonomous mode.",
        "Paid plans are monthly subscriptions sold by Paddle.com (Merchant of Record); cancel any time, full refund within 14 days of the first payment.",
        "Governed by the laws of the Republic of Türkiye; consumers keep their mandatory local rights.",
      ] },
    ],
  },
];

export const pageByPath = new Map(publicPages.map((page) => [page.path, page]));
export const contentPagePaths = publicPages.filter((page) => page.content).map((page) => page.path);

/** Heading anchor id, the same in the pre-rendered HTML and the React view (Content.tsx). */
export function anchorId(text: string) {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "section";
}

/** Title and summary of every public page, for links (`see` blocks) and the docs sidebar. */
export function pageNav() {
  return publicPages.map((p) => ({ path: p.path, heading: p.heading, description: p.description, ...(p.docGroup ? { group: p.docGroup } : {}) }));
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const isDocPage = (page: PublicPage) => page.path === "/docs" || !!page.docGroup;

/** Plain HTML of a page for crawlers; React replaces it when the app starts. */
export function renderPageHtml(page: PublicPage) {
  const parts = [`<main class="prerender">`];
  if (isDocPage(page)) {
    const crumbs = [`<a href="/">${productName}</a>`, page.path === "/docs" ? "Documentation" : `<a href="/docs">Documentation</a>`];
    if (page.docGroup) crumbs.push(escapeHtml(page.docGroup), escapeHtml(page.heading));
    parts.push(`<nav aria-label="Breadcrumb">${crumbs.join(" › ")}</nav>`);
  }
  parts.push(`<h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.intro)}</p>`);
  for (const block of page.blocks) {
    if ("h2" in block) parts.push(`<h2 id="${anchorId(block.h2)}">${escapeHtml(block.h2)}</h2>`);
    else if ("h3" in block) parts.push(`<h3 id="${anchorId(block.h3)}">${escapeHtml(block.h3)}</h3>`);
    else if ("p" in block) parts.push(`<p>${escapeHtml(block.p)}</p>`);
    else if ("note" in block) parts.push(`<aside><p><strong>Note:</strong> ${escapeHtml(block.note)}</p></aside>`);
    else if ("ul" in block) parts.push(`<ul>${block.ul.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    else if ("ol" in block) parts.push(`<ol>${block.ol.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`);
    else if ("see" in block) {
      parts.push(`<ul>${block.see.map((path) => {
        const target = pageByPath.get(path);
        return target ? `<li><a href="${path}">${escapeHtml(target.heading)}</a>: ${escapeHtml(target.description)}</li>` : "";
      }).join("")}</ul>`);
    }
    else if ("code" in block) parts.push(`<pre><code>${escapeHtml(block.code)}</code></pre>`);
    else if ("table" in block) {
      parts.push(`<table><thead><tr>${block.table.head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${
        block.table.rows.map((row) => `<tr>${row.map((cell, i) => i === 0 ? `<th>${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    }
  }
  if (page.faq) {
    for (const item of page.faq) parts.push(`<h2>${escapeHtml(item.q)}</h2><p>${escapeHtml(item.a)}</p>`);
  }
  if (page.howTo && page.docGroup) {
    parts.push(`<h2>${escapeHtml(page.howTo.name)}</h2><ol>${page.howTo.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`);
  }
  if (page.docGroup) {
    // Documentation pages carry the documentation's table of contents.
    parts.push(`<nav aria-label="Documentation">${docGroups.map((group) =>
      `<h2>${escapeHtml(group)}</h2><ul>${docPages.filter((p) => p.docGroup === group)
        .map((p) => `<li><a href="${p.path}">${escapeHtml(p.heading)}</a></li>`).join("")}</ul>`).join("")}</nav>`);
  }
  const links = publicPages.filter((p) => p.section !== "Legal" && !p.docGroup && p.path !== page.path)
    .map((p) => `<a href="${p.path}">${escapeHtml(p.heading)}</a>`).join(" · ");
  parts.push(`<nav>${links}</nav></main>`);
  return parts.join("");
}

/** JSON-LD for a page: the product everywhere, plus FAQ or HowTo where present. */
export function pageJsonLd(page: PublicPage, origin: string) {
  const graph: Record<string, unknown>[] = [
    {
      "@type": "Organization",
      "@id": `${origin}/#organization`,
      name: "WebRising",
      url: origin,
      logo: `${origin}/assets/wecommander-favicon.svg`,
      brand: { "@type": "Brand", name: productName },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${origin}/#software`,
      name: productName,
      description: productSummary,
      url: origin,
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "Remote MCP server",
      operatingSystem: "Windows, macOS, Linux",
      publisher: { "@id": `${origin}/#organization` },
      offers: { "@type": "Offer", url: `${origin}/pricing`, availability: "https://schema.org/InStock" },
      featureList: facts,
    },
    {
      "@type": "WebPage",
      "@id": `${origin}${page.path}`,
      url: `${origin}${page.path}`,
      name: page.title,
      description: page.description,
      isPartOf: { "@type": "WebSite", name: productName, url: origin },
      about: { "@id": `${origin}/#software` },
    },
  ];
  if (page.faq) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: page.faq.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    });
  }
  if (isDocPage(page)) {
    const crumbs = [
      { name: productName, item: `${origin}/` },
      { name: "Documentation", item: `${origin}/docs` },
      ...(page.docGroup ? [{ name: page.heading, item: `${origin}${page.path}` }] : []),
    ];
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map((c, index) => ({ "@type": "ListItem", position: index + 1, name: c.name, item: c.item })),
    });
    if (page.docGroup) {
      graph.push({
        "@type": "TechArticle",
        "@id": `${origin}${page.path}#article`,
        headline: page.heading,
        description: page.description,
        url: `${origin}${page.path}`,
        inLanguage: "en",
        articleSection: page.docGroup,
        isPartOf: { "@id": `${origin}/docs` },
        about: { "@id": `${origin}/#software` },
        publisher: { "@id": `${origin}/#organization` },
        mainEntityOfPage: { "@id": `${origin}${page.path}` },
      });
    } else {
      graph.push({
        "@type": "ItemList",
        name: "WECOMMANDER documentation",
        itemListElement: docPages.map((p, index) => ({ "@type": "ListItem", position: index + 1, url: `${origin}${p.path}`, name: p.heading })),
      });
    }
  }
  if (page.howTo) {
    graph.push({
      "@type": "HowTo",
      name: page.howTo.name,
      step: page.howTo.steps.map((text, index) => ({ "@type": "HowToStep", position: index + 1, text })),
    });
  }
  // "<" is escaped so the JSON cannot close the script element.
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

/** Paths that must never be indexed (account and admin areas, API, MCP transport). */
export const privatePrefixes = [
  "/api/", "/mcp", "/console", "/dashboard", "/account", "/billing", "/devices", "/terminal", "/files", "/tasks", "/scheduled-tasks",
  "/usage", "/approvals", "/team", "/audit", "/invite", "/checkout", "/connect-device", "/connect-center",
  "/login", "/register", "/forgot-password", "/reset-password", "/verify", "/oauth/", "/authorize", "/token",
];

const aiCrawlers = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
  "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot", "Meta-ExternalAgent", "Amazonbot", "Bingbot", "Googlebot",
];

export function robotsTxt(origin: string) {
  const disallow = privatePrefixes.map((p) => `Disallow: ${p}`).join("\n");
  const named = aiCrawlers.map((bot) => `User-agent: ${bot}\nAllow: /\n${disallow}\n`).join("\n");
  return `# ${productName}: public pages may be read and cited by search engines and AI assistants.\n# Summary for language models: ${origin}/llms.txt\n\n${named}\nUser-agent: *\nAllow: /\n${disallow}\n\nSitemap: ${origin}/sitemap.xml\n`;
}

export function sitemapXml(origin: string, lastModified: string) {
  const urls = publicPages.map((page) =>
    `  <url><loc>${origin}${page.path}</loc><lastmod>${lastModified}</lastmod><changefreq>${page.section === "Legal" ? "yearly" : "weekly"}</changefreq><priority>${page.path === "/" ? "1.0" : page.section === "Legal" ? "0.2" : "0.8"}</priority></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** app.wecommander/wecommander for https://wecommander.app (same rule as the MCP Registry listing). */
const registryName = (origin: string) => `${new URL(origin).hostname.split(".").reverse().join(".")}/wecommander`;

/** https://llmstxt.org: a short Markdown map of the site for language models. */
export function llmsTxt(origin: string) {
  const sections = (["Product", "Docs", "Guides"] as const).map((section) =>
    `## ${section}\n\n` + publicPages.filter((p) => p.section === section && !p.docGroup)
      .map((p) => `- [${p.heading}](${origin}${p.path}): ${p.description}`).join("\n"));
  const connect = `Remote MCP server: ${origin}/mcp (Streamable HTTP, OAuth 2.1 sign-in). MCP Registry name: ${registryName(origin)} (listing: ${origin}/server.json).`;
  const documentation = `## Documentation (A to Z)\n\nOne page per topic; the index is ${origin}/docs.\n\n` + docGroups.map((group) =>
    `### ${group}\n\n` + docPages.filter((p) => p.docGroup === group)
      .map((p) => `- [${p.heading}](${origin}${p.path}): ${p.description}`).join("\n")).join("\n\n");
  return `# ${productName}\n\n> ${productSummary}\n\n${connect}\n\nKey facts:\n\n${facts.map((f) => `- ${f}`).join("\n")}\n\n${sections.join("\n\n")}\n\n${documentation}\n\n## Optional\n\n- [Full text of the public pages and the documentation](${origin}/llms-full.txt)\n- [Privacy](${origin}/privacy)\n- [Terms](${origin}/terms)\n`;
}

function blockToMarkdown(block: Block, origin: string) {
  if ("h2" in block) return `### ${block.h2}`;
  if ("h3" in block) return `#### ${block.h3}`;
  if ("p" in block) return block.p;
  if ("note" in block) return `> Note: ${block.note}`;
  if ("ul" in block) return block.ul.map((item) => `- ${item}`).join("\n");
  if ("ol" in block) return block.ol.map((item, i) => `${i + 1}. ${item}`).join("\n");
  if ("see" in block) return block.see.map((path) => pageByPath.get(path))
    .filter((p): p is PublicPage => !!p).map((p) => `- [${p.heading}](${origin}${p.path}): ${p.description}`).join("\n");
  if ("code" in block) return "```\n" + block.code + "\n```";
  return [
    `| ${block.table.head.join(" | ")} |`,
    `| ${block.table.head.map(() => "---").join(" | ")} |`,
    ...block.table.rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

export function llmsFullTxt(origin: string) {
  const pages = publicPages.filter((p) => p.section !== "Legal").map((page) => [
    `## ${page.heading}`,
    `URL: ${origin}${page.path}`,
    page.intro,
    ...page.blocks.map((block) => blockToMarkdown(block, origin)),
    ...(page.faq ?? []).map((item) => `### ${item.q}\n${item.a}`),
    ...(page.howTo ? [`### ${page.howTo.name}\n${page.howTo.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`] : []),
  ].join("\n\n"));
  return `# ${productName}\n\n> ${productSummary}\n\n${pages.join("\n\n---\n\n")}\n`;
}
