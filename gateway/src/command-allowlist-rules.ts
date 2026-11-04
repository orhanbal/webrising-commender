// Per-device allowlist of routine shell commands that may run without a
// per-call human approval (owner/admin managed, browser session only).
//
// Safety rules (fail closed):
// - only process_exec is ever allowlisted; tasks, terminals, deletes, kills
//   always need approval;
// - a command with any shell metacharacter, quote, glob, newline or
//   expansion is never allowlisted, even if a pattern would match, so
//   "df -h; rm -rf /" or "docker ps $(evil)" cannot ride on "df -h";
// - a pattern matches when its whitespace-separated tokens are an exact
//   prefix of the command's tokens ("systemctl status" matches
//   "systemctl status nginx", not "systemctl stop nginx");
// - patterns obey the same character rules.

// Anything a POSIX shell treats specially, plus quotes/globs/escapes.
const UNSAFE = /[;&|`$<>(){}[\]\\*?!#~"'\n\r\t\0]/;
const TOKEN = /^[A-Za-z0-9._,:=@%+\/-]+$/;
export const MAX_PATTERN_TOKENS = 12;
// Programs that run other programs or change identity: allowlisting any of
// them would allowlist everything.
const NEVER_ALLOWLISTED = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "busybox",
  "sudo", "su", "doas", "pkexec", "runuser", "setpriv", "chroot", "nsenter", "unshare",
  "env", "xargs", "nohup", "timeout", "nice", "ionice", "stdbuf", "watch", "time", "exec", "eval", "command", "builtin",
  "find", "awk", "gawk", "mawk", "sed", "perl", "python", "python3", "node", "deno", "bun", "ruby", "php", "lua", "tclsh",
  "ssh", "scp", "rsync", "curl", "wget", "nc", "ncat", "socat", "telnet",
  "rm", "dd", "mkfs", "shred", "chmod", "chown", "mv", "cp", "tee", "install", "ln", "truncate",
  "psql", "mysql", "mariadb", "sqlite3", "redis-cli", "mongo", "mongosh",
  "crontab", "at", "systemd-run", "kill", "pkill", "killall", "reboot", "shutdown", "poweroff", "halt",
]);
// Multi-purpose tools: a pattern must name the subcommand too ("docker ps",
// "systemctl status"), so "docker" can never cover "docker exec" or "docker rm".
const REQUIRES_SUBCOMMAND = new Set([
  "docker", "docker-compose", "podman", "kubectl", "helm", "systemctl", "service", "git", "apt", "apt-get",
  "dpkg", "snap", "npm", "pnpm", "yarn", "pip", "pip3", "ip", "iptables", "ip6tables", "nft", "ufw",
  "mount", "umount", "journalctl", "coolify", "pm2", "supervisorctl",
]);
export const MAX_ALLOWLIST_ENTRIES = 50;

export function commandTokens(command: string): string[] | null {
  if (typeof command !== "string" || command.length === 0 || command.length > 512) return null;
  if (UNSAFE.test(command)) return null;
  const tokens = command.trim().split(/ +/).filter(Boolean);
  if (!tokens.length || !tokens.every((t) => TOKEN.test(t))) return null;
  // The program itself may not be an assignment or an option.
  if (tokens[0]!.includes("=") || tokens[0]!.startsWith("-")) return null;
  return tokens;
}

export function normalizePattern(pattern: unknown): string | null {
  if (typeof pattern !== "string") return null;
  const tokens = commandTokens(pattern);
  if (!tokens || tokens.length > MAX_PATTERN_TOKENS) return null;
  const program = tokens[0]!.split("/").pop()!.toLowerCase();
  if (NEVER_ALLOWLISTED.has(program) || /^(python|perl|ruby|php|node)[0-9.]*$/.test(program)) return null;
  if (REQUIRES_SUBCOMMAND.has(program) && tokens.length < 2) return null;
  return tokens.join(" ");
}

export function patternMatches(pattern: string, command: string) {
  // Re-validate stored patterns so a rule change also applies to old entries.
  const normalized = normalizePattern(pattern);
  const p = normalized ? normalized.split(" ") : null;
  const c = commandTokens(command);
  if (!p || !c || p.length > c.length) return false;
  return p.every((token, index) => c[index] === token);
}
