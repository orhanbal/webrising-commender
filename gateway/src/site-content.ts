// Public, crawlable description of WECOMMANDER: one source for the server-
// rendered HTML of public pages (search engines and AI crawlers read it
// without running JavaScript), the JSON-LD, /llms.txt, /llms-full.txt and the
// sitemap. Keep it factual: assistants quote it.

export type Block =
  | { h2: string }
  | { p: string }
  | { ul: string[] }
  | { code: string }
  | { table: { head: string[]; rows: string[][] } };

export type Faq = { q: string; a: string };

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
};

export const productName = "WECOMMANDER";
export const productSummary =
  "WECOMMANDER is a remote MCP (Model Context Protocol) server that lets AI assistants such as Claude, ChatGPT and Cursor use the terminals and files of your own Windows, macOS and Linux machines through one MCP URL, with human approval for risky actions, per-device limits and a full audit log.";

const facts: string[] = [
  "One MCP URL for all your machines: https://wecommander.app/mcp (OAuth sign-in from Claude, ChatGPT and other MCP clients).",
  "A small agent runs on each machine (Windows, macOS, Linux) and keeps one outbound encrypted connection; no inbound ports, VPN or SSH keys are needed.",
  "The agent runs as a normal user (not root/SYSTEM) and only inside the folders you allow.",
  "High-risk actions (running commands, deleting or moving files, killing processes, opening terminals) wait for a human approval of that exact action, unless you allow a command pattern or switch a device to autonomous mode for a set time.",
  "Approvals arrive in the web dashboard, by e-mail and in the Management Center desktop app as Windows notifications with Approve / Deny buttons.",
  "Secrets in command and terminal output (tokens, passwords, keys) are masked on the device before the result reaches the AI.",
  "Every action is recorded in an audit log; file edits keep undo snapshots.",
  "Tools: read, write, edit, search and move files; run commands; long-running background tasks; interactive terminals; process lists; device health snapshots; log search; PDF, Word and Excel reading.",
  "Local mode: the same agent can serve MCP over stdio to a local client (Claude Desktop, Cursor) with no account or server.",
];

export const publicPages: PublicPage[] = [
  {
    path: "/",
    section: "Product",
    title: "WECOMMANDER · Your AI, on every machine",
    description:
      "Connect Claude, ChatGPT or any MCP client to the terminals and files of your Windows, macOS and Linux machines through one MCP URL, with human approvals, a non-root agent and a full audit trail.",
    heading: "Your AI, on every machine",
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
      { h2: "For the AI" },
      {
        ul: [
          "Files: read (also line ranges, PDF, Word, Excel), write, exact search-and-replace edits, search by name or content, move, create folders.",
          "Commands: one-off commands with timeouts, long-running background tasks that survive disconnects, interactive terminals.",
          "Operations: process list, device health snapshot (CPU, memory, disks, network, top processes), log search in the system journal or log files.",
          "Desktop Commander-compatible tool names, so existing prompts keep working.",
        ],
      },
      { h2: "For the person in charge" },
      {
        ul: [
          "Allowed folders per device; nothing outside them can be read or written.",
          "Approval of each high-risk action, from the dashboard, e-mail or the Management Center desktop app.",
          "Trust levels per device (strict, standard, full), allowed command patterns, and autonomous mode for a set time with one-click stop.",
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
      { p: "A single binary on Windows, macOS or Linux. It runs as a normal user, connects out to the gateway over TLS, and enforces the allowed folders, read-only and no-command switches and secret masking on the device itself." },
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
    blocks: [{ p: "Self-hosting is possible: the gateway runs with Docker Compose and PostgreSQL." }],
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
      { h2: "Windows (PowerShell)" },
      { code: "irm https://wecommander.app/install.ps1 | iex" },
      { h2: "Management Center for Windows (approvals on your desktop)" },
      { code: "irm https://wecommander.app/install/center.ps1 | iex" },
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
    description: "Set up WECOMMANDER with Claude, ChatGPT, Cursor and other MCP clients, run the agent in local mode, and manage approvals.",
    heading: "Documentation",
    intro: "Connect your AI client to your machines in a few minutes.",
    blocks: [
      { h2: "1. Install the agent" },
      { p: "Run the one-line installer on each machine (see Install). The device appears in your dashboard after you approve it in the browser." },
      { h2: "2. Add the MCP server to your AI client" },
      { ul: [
        "Claude (web and desktop): Settings → Connectors → Add custom connector → URL https://wecommander.app/mcp → Connect, then allow access with your WECOMMANDER account.",
        "ChatGPT: Settings → Connectors → create a custom MCP connector with the same URL and OAuth authentication (developer mode may be required depending on the plan).",
        "Cursor and other clients: add a remote (HTTP) MCP server with the URL https://wecommander.app/mcp.",
      ] },
      { h2: "3. Approve risky actions" },
      { p: "Commands and destructive file operations wait for your approval. Approve them in the dashboard (Approvals), from the e-mail, or from the Management Center on Windows. Each approval is valid once, for exactly the action shown." },
      { h2: "Local mode (no account, no server)" },
      { p: "The agent can serve MCP over stdio to a local client. Example for Claude Desktop:" },
      { code: '{\n  "mcpServers": {\n    "wecommander": {\n      "command": "webrising-commender",\n      "args": ["mcp-stdio", "--allowed-root", "/home/me/projects"]\n    }\n  }\n}' },
      { p: "Writes and commands are off unless you add --allow-writes or --allow-commands." },
    ],
  },
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
        "Least privilege: the agent runs as a normal user, inside allowed folders only; writes and commands can be switched off per device, on the device.",
        "Approvals: high-risk actions need a single-use approval bound to the exact action and device.",
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
      { q: "Do I need to open a port or set up a VPN?", a: "No. The agent makes an outbound TLS connection to the gateway; nothing listens on your machine." },
      { q: "Can the AI run any command on my server?", a: "Only inside the folders you allow, as a normal user, and every command waits for your approval unless you allowed that command pattern or turned on autonomous mode for the device." },
      { q: "How do I approve actions quickly?", a: "In the dashboard, from the approval e-mail, or with the Management Center desktop app on Windows, which shows each request as a notification with Approve and Deny buttons." },
      { q: "Does the AI see my passwords or API keys?", a: "Common secrets in command and terminal output are masked on the device before the result is sent. File reads are exact, so keep secret files outside the allowed folders." },
      { q: "Can I undo a change the AI made?", a: "File edits keep undo snapshots; the AI or you can restore the previous content if the file has not changed since." },
      { q: "Can I use it without an account?", a: "Yes, in local mode: the agent serves MCP over stdio to a local client, with writes and commands off unless you enable them." },
      { q: "Can I host it myself?", a: "Yes. The gateway runs with Docker Compose and PostgreSQL; the agent is the same." },
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
        "In PowerShell: irm https://wecommander.app/install.ps1 | iex, then approve the device and choose a folder such as C:\\Users\\you\\WECOMMANDER.",
        "In ChatGPT: Settings → Connectors → create a custom connector with https://wecommander.app/mcp (OAuth).",
        "Ask ChatGPT to summarise, search or edit documents in that folder; Word, Excel and PDF files can be read too.",
        "Deleting or moving files and running commands wait for your approval; edits keep undo snapshots.",
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
        "Trust levels per device: strict, standard or full.",
        "Autonomous mode: switch approvals off for all or selected devices for 30 minutes to indefinitely, with automatic expiry and one-click stop; AI clients cannot turn it on.",
        "Approve from the dashboard, the e-mail, or Windows notifications of the Management Center app.",
      ] },
    ],
  },
  {
    path: "/privacy",
    section: "Legal",
    title: "Privacy · WECOMMANDER",
    description: "How WECOMMANDER handles account, device and audit data.",
    heading: "Privacy",
    intro: "The privacy policy of WECOMMANDER.",
    blocks: [],
  },
  {
    path: "/terms",
    section: "Legal",
    title: "Terms · WECOMMANDER",
    description: "Terms of service of WECOMMANDER.",
    heading: "Terms",
    intro: "The terms of service of WECOMMANDER.",
    blocks: [],
  },
];

export const pageByPath = new Map(publicPages.map((page) => [page.path, page]));
export const contentPagePaths = publicPages.filter((page) => page.content).map((page) => page.path);

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain HTML of a page for crawlers; React replaces it when the app starts. */
export function renderPageHtml(page: PublicPage) {
  const parts = [`<main class="prerender"><h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.intro)}</p>`];
  for (const block of page.blocks) {
    if ("h2" in block) parts.push(`<h2>${escapeHtml(block.h2)}</h2>`);
    else if ("p" in block) parts.push(`<p>${escapeHtml(block.p)}</p>`);
    else if ("ul" in block) parts.push(`<ul>${block.ul.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    else if ("code" in block) parts.push(`<pre><code>${escapeHtml(block.code)}</code></pre>`);
    else if ("table" in block) {
      parts.push(`<table><thead><tr>${block.table.head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${
        block.table.rows.map((row) => `<tr>${row.map((cell, i) => i === 0 ? `<th>${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    }
  }
  if (page.faq) {
    for (const item of page.faq) parts.push(`<h2>${escapeHtml(item.q)}</h2><p>${escapeHtml(item.a)}</p>`);
  }
  const links = publicPages.filter((p) => p.section !== "Legal" && p.path !== page.path)
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
  "/api/", "/mcp", "/console", "/dashboard", "/account", "/billing", "/devices", "/terminal", "/files", "/tasks",
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

/** https://llmstxt.org: a short Markdown map of the site for language models. */
export function llmsTxt(origin: string) {
  const sections = (["Product", "Docs", "Guides"] as const).map((section) =>
    `## ${section}\n\n` + publicPages.filter((p) => p.section === section)
      .map((p) => `- [${p.heading}](${origin}${p.path}): ${p.description}`).join("\n"));
  return `# ${productName}\n\n> ${productSummary}\n\nKey facts:\n\n${facts.map((f) => `- ${f}`).join("\n")}\n\n${sections.join("\n\n")}\n\n## Optional\n\n- [Full text of the public pages](${origin}/llms-full.txt)\n- [Privacy](${origin}/privacy)\n- [Terms](${origin}/terms)\n`;
}

function blockToMarkdown(block: Block) {
  if ("h2" in block) return `### ${block.h2}`;
  if ("p" in block) return block.p;
  if ("ul" in block) return block.ul.map((item) => `- ${item}`).join("\n");
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
    ...page.blocks.map(blockToMarkdown),
    ...(page.faq ?? []).map((item) => `### ${item.q}\n${item.a}`),
    ...(page.howTo ? [`### ${page.howTo.name}\n${page.howTo.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`] : []),
  ].join("\n\n"));
  return `# ${productName}\n\n> ${productSummary}\n\n${pages.join("\n\n---\n\n")}\n`;
}
