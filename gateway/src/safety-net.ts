// Safety net: a short hard-deny list of commands that are never run through
// MCP while the device's safety net is on, whatever its trust level, run_as
// (root) or a human approval says. It complements the allowlist
// (command-allowlist-rules.ts), which decides what may run WITHOUT approval;
// this decides what may not run at all.
//
// It is a guard against catastrophic slips, not a sandbox: a determined
// caller with root can always find another way, so it aims at the obvious
// one-liners and their usual spellings, and it must not block ordinary work
// (`rm -rf ./build`, `rm -rf /var/www/old`, `dd if=/dev/zero of=disk.img`).
//
// Blocked (per simple command, after unwrapping sudo/env/nohup/... and
// `sh -c "..."`, `eval`, `$(...)` and backticks):
// - rm with a recursive flag on `/`, `/*`, a top-level system directory
//   (`/etc`, `/usr`, `/var`, ... and their `/*`), the home directory, or with
//   --no-preserve-root;
// - chmod/chown/chgrp -R on `/`;
// - mkfs*, mke2fs, mkswap, wipefs, blkdiscard on a /dev/ device;
// - dd of=, shred or a shell redirection onto a whole disk (/dev/sda,
//   /dev/nvme0n1, /dev/vda, ...);
// - fork bombs (`:(){ :|:& };:` and renamed variants);
// - shutdown, reboot, poweroff, halt, `systemctl poweroff|reboot|halt|kexec`,
//   `init 0|6`, unless the device allows power commands;
// - stopping, disabling, masking or deleting the WECOMMANDER agent service
//   (or its binary), which would cut the device off.

export type SafetyNetOptions = {
  /** shutdown/reboot/poweroff allowed on this device. */
  allowPower?: boolean;
};
export type SafetyNetHit = { rule: string; reason: string };

type SimpleCommand = { words: string[]; redirects: string[] };

const MAX_DEPTH = 4;
const AGENT_SERVICE = /^(webrising-commender|wecommander-agent)(\.service)?$/;
const AGENT_FILES = new Set([
  "/etc/systemd/system/webrising-commender.service",
  "/lib/systemd/system/webrising-commender.service",
  "/usr/local/bin/webrising-commender",
  "/etc/sudoers.d/wecommander-agent",
]);
const WHOLE_DISK = /^\/dev\/(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|disk\d+|rdisk\d+)$/;
const CRITICAL_DIRS = new Set([
  "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/proc",
  "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/var", "/usr/bin", "/usr/lib", "/usr/lib64", "/usr/local",
  "/usr/sbin", "/usr/share", "/var/lib", "/Users", "/System", "/Applications", "/Library", "/private",
  "~",
]);
const POWER_PROGRAMS = new Set(["shutdown", "reboot", "poweroff", "halt"]);
const POWER_SYSTEMCTL = new Set(["poweroff", "reboot", "halt", "kexec", "soft-reboot"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh"]);
// Programs that only run the rest of their arguments as a command.
const WRAPPERS = new Set([
  "sudo", "doas", "nohup", "nice", "ionice", "time", "command", "exec", "builtin", "env", "stdbuf",
  "timeout", "setsid", "xargs", "chrt", "taskset", "unbuffer", "flock", "runuser", "pkexec",
]);
// Wrapper options that take a separate value.
const VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "-R"]),
  doas: new Set(["-u", "-C"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  env: new Set(["-u", "-C", "-S"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  xargs: new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"]),
  runuser: new Set(["-u", "-g", "-G"]),
  flock: new Set(["-w", "-E"]),
};

const base = (word: string) => word.split("/").pop() || word;

/** Splits shell text into simple commands (words with quotes removed), and
 *  calls `nested` for text that the shell itself would run: `$(...)` and
 *  backticks, also inside double quotes. Approximate by design. */
function splitCommands(text: string, nested: (inner: string) => void): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let word = "";
  let inWord = false;
  let redirectNext = false;
  const endWord = () => {
    if (!inWord) return;
    if (redirectNext) { redirects.push(word); redirectNext = false; } else words.push(word);
    word = ""; inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = []; redirects = [];
  };
  // Returns the index after the matching ")" of a "$(" that starts at i.
  const closeParen = (from: number) => {
    let depth = 1;
    let quote: string | null = null;
    for (let j = from; j < text.length; j++) {
      const c = text[j]!;
      if (quote) { if (c === quote) quote = null; else if (c === "\\" && quote === "\"") j++; continue; }
      if (c === "'" || c === "\"") quote = c;
      else if (c === "\\") j++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
    }
    return text.length;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      if (i + 1 < text.length && text[i + 1] !== "\n") { word += text[i + 1]; inWord = true; }
      i++;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? text.length : end;
      word += text.slice(i + 1, stop); inWord = true; i = stop;
      continue;
    }
    if (c === "\"") {
      inWord = true;
      let j = i + 1;
      for (; j < text.length && text[j] !== "\""; j++) {
        const d = text[j]!;
        if (d === "\\" && j + 1 < text.length) { word += text[j + 1]; j++; continue; }
        if (d === "$" && text[j + 1] === "(") {
          const close = closeParen(j + 2);
          nested(text.slice(j + 2, close)); word += text.slice(j, close + 1); j = close; continue;
        }
        if (d === "`") {
          const close = text.indexOf("`", j + 1);
          const stop = close < 0 ? text.length : close;
          nested(text.slice(j + 1, stop)); j = stop; continue;
        }
        word += d;
      }
      i = j;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const close = closeParen(i + 2);
      nested(text.slice(i + 2, close));
      word += "$(...)"; inWord = true; i = close;
      continue;
    }
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      const stop = close < 0 ? text.length : close;
      nested(text.slice(i + 1, stop));
      i = stop;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "\r" || c === "(" || c === ")") {
      endCommand();
      continue;
    }
    if (c === ">" || c === "<") {
      // "2>/dev/null", "&>file", ">>file", ">|file": the next word is a target.
      if (/^\d+$/.test(word)) { word = ""; inWord = false; }
      endWord();
      while (text[i + 1] === ">" || text[i + 1] === "|" || text[i + 1] === "&") i++;
      if (c === ">") redirectNext = true;
      else redirectNext = false;
      continue;
    }
    if (c === " " || c === "\t") { endWord(); continue; }
    if ((c === "{" || c === "}") && !inWord && (i + 1 >= text.length || /\s/.test(text[i + 1]!))) {
      endCommand();
      continue;
    }
    word += c; inWord = true;
  }
  endCommand();
  return commands;
}

/** Drops sudo, env, nohup, timeout, ... and assignments in front of the command. */
function unwrap(words: string[]): string[] {
  let rest = words;
  for (let guard = 0; guard < 16 && rest.length; guard++) {
    const first = rest[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) { rest = rest.slice(1); continue; }
    const program = base(first);
    if (!WRAPPERS.has(program)) break;
    const takesValue = VALUE_OPTIONS[program] ?? new Set<string>();
    let i = 1;
    while (i < rest.length) {
      const w = rest[i]!;
      if (w === "--") { i++; break; }
      if (program === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
      if (!w.startsWith("-") || w === "-") break;
      i += takesValue.has(w) ? 2 : 1;
    }
    if (program === "timeout" && i < rest.length) i++; // the duration
    if (program === "flock" && i < rest.length) i++; // the lock file
    if ((program === "chrt" || program === "taskset") && i < rest.length) i++; // priority / mask
    rest = rest.slice(i);
  }
  return rest;
}

/** An absolute (or home) path with ".", "..", repeated slashes and a trailing
 *  "/" or "/*" removed: "/etc/*" -> "/etc", "/tmp/../" -> "/", "~/" -> "~". */
function normalizeTarget(raw: string): string | null {
  let path = raw.trim();
  if (path === "$HOME" || path === "${HOME}" || path.startsWith("$HOME/") || path.startsWith("${HOME}/")) {
    path = "~" + path.slice(path.indexOf("}") >= 0 && path.startsWith("${") ? 7 : 5);
  }
  if (path === "~" || path.startsWith("~/")) {
    const rest = normalizeTarget("/" + path.slice(1));
    return rest === "/" ? "~" : rest === null ? null : "~" + rest;
  }
  if (!path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { parts.pop(); continue; }
    parts.push(segment);
  }
  // A trailing "*" / ".*" / "{*,.*}" means "everything in the directory".
  while (parts.length && /^(\*|\.\*|\.\[!.\]\*|\{\*,\.\*\}|\.\?\*)$/.test(parts[parts.length - 1]!)) parts.pop();
  return "/" + parts.join("/");
}

function isCritical(target: string) {
  const normalized = normalizeTarget(target);
  return normalized !== null && CRITICAL_DIRS.has(normalized);
}

function checkSimple(words: string[], redirects: string[], options: SafetyNetOptions,
  recurse: (text: string) => SafetyNetHit | null): SafetyNetHit | null {
  for (const target of redirects) {
    if (WHOLE_DISK.test(target)) return { rule: "disk_overwrite", reason: `writes over the whole disk ${target}` };
  }
  const cmd = unwrap(words);
  if (!cmd.length) return null;
  const program = base(cmd[0]!);
  const args = cmd.slice(1);

  if (SHELLS.has(program) || (program === "busybox" && SHELLS.has(base(args[0] ?? "")))) {
    const shellArgs = program === "busybox" ? args.slice(1) : args;
    const c = shellArgs.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (c >= 0 && shellArgs[c + 1] !== undefined) return recurse(shellArgs[c + 1]!);
    return null;
  }
  if (program === "eval") return recurse(args.join(" "));
  if (program === "su") {
    const c = args.findIndex((a) => a === "-c" || a === "--command");
    if (c >= 0 && args[c + 1] !== undefined) return recurse(args[c + 1]!);
    return null;
  }

  if (program === "rm") {
    let recursive = false;
    let noPreserve = false;
    const targets: string[] = [];
    let optionsDone = false;
    for (const a of args) {
      if (!optionsDone && a === "--") { optionsDone = true; continue; }
      if (!optionsDone && a.startsWith("--")) {
        if (a === "--recursive") recursive = true;
        if (a === "--no-preserve-root") noPreserve = true;
        continue;
      }
      if (!optionsDone && a.startsWith("-") && a.length > 1) {
        if (/[rR]/.test(a)) recursive = true;
        continue;
      }
      targets.push(a);
    }
    if (noPreserve) return { rule: "rm_root", reason: "rm --no-preserve-root" };
    const own = targets.find((t) => AGENT_FILES.has(normalizeTarget(t) ?? ""));
    if (own) return { rule: "agent_service", reason: `deletes the WECOMMANDER agent (${own})` };
    if (recursive) {
      const hit = targets.find(isCritical);
      if (hit) return { rule: "rm_root", reason: `recursive delete of ${hit}` };
    }
    return null;
  }

  if (program === "chmod" || program === "chown" || program === "chgrp") {
    const recursive = args.some((a) => a === "--recursive" || /^-[A-Za-z]*R/.test(a));
    if (recursive && args.some((a) => !a.startsWith("-") && normalizeTarget(a) === "/")) {
      return { rule: "chmod_root", reason: `${program} -R on /` };
    }
    return null;
  }

  if (/^mkfs(\..+)?$/.test(program) || program === "mke2fs" || program === "mkswap" ||
      program === "wipefs" || program === "blkdiscard") {
    const device = args.find((a) => a.startsWith("/dev/"));
    if (device) return { rule: "disk_format", reason: `${program} on ${device}` };
    return null;
  }

  if (program === "dd") {
    const out = args.find((a) => a.startsWith("of="));
    if (out && WHOLE_DISK.test(out.slice(3))) return { rule: "disk_overwrite", reason: `dd onto the whole disk ${out.slice(3)}` };
    return null;
  }
  if (program === "shred") {
    const disk = args.find((a) => WHOLE_DISK.test(a));
    if (disk) return { rule: "disk_overwrite", reason: `shred of the whole disk ${disk}` };
    return null;
  }

  if (!options.allowPower) {
    if (POWER_PROGRAMS.has(program)) {
      // "shutdown -c" cancels a pending shutdown.
      if (program === "shutdown" && args.includes("-c")) return null;
      if (args.includes("--help") || args.includes("--version")) return null;
      return { rule: "power", reason: `${program} turns the machine off or restarts it` };
    }
    if ((program === "init" || program === "telinit") && (args[0] === "0" || args[0] === "6")) {
      return { rule: "power", reason: `${program} ${args[0]}` };
    }
  }

  if (program === "systemctl") {
    const positional = args.filter((a) => !a.startsWith("-"));
    const verb = positional[0];
    if (!options.allowPower && verb && POWER_SYSTEMCTL.has(verb)) {
      return { rule: "power", reason: `systemctl ${verb}` };
    }
    if (verb && ["stop", "disable", "mask", "kill"].includes(verb) &&
        positional.slice(1).some((unit) => AGENT_SERVICE.test(unit))) {
      return { rule: "agent_service", reason: `systemctl ${verb} of the WECOMMANDER agent service` };
    }
    return null;
  }
  if (program === "service" && args.length >= 2 && AGENT_SERVICE.test(args[0]!) && args[1] === "stop") {
    return { rule: "agent_service", reason: "stops the WECOMMANDER agent service" };
  }
  if ((program === "pkill" || program === "killall") &&
      args.some((a) => !a.startsWith("-") && /^webrising-commender/.test(a))) {
    return { rule: "agent_service", reason: `${program} of the WECOMMANDER agent` };
  }
  return null;
}

function checkText(text: string, options: SafetyNetOptions, depth: number): SafetyNetHit | null {
  if (depth > MAX_DEPTH) return null;
  // :(){ :|:& };:  and renamed variants (bomb(){ bomb|bomb& };bomb).
  const compact = text.replace(/\s+/g, "");
  if (/([A-Za-z0-9_:.]+)\(\)\{\1\|\1&;?\}/.test(compact) || /function([A-Za-z0-9_:.]+)\{\1\|\1&;?\}/.test(compact)) {
    return { rule: "fork_bomb", reason: "fork bomb" };
  }
  let found: SafetyNetHit | null = null;
  const commands = splitCommands(text, (inner) => { found ??= checkText(inner, options, depth + 1); });
  if (found) return found;
  for (const command of commands) {
    const hit = checkSimple(command.words, command.redirects, options, (inner) => checkText(inner, options, depth + 1));
    if (hit) return hit;
  }
  return null;
}

/** The first hard-deny rule a command (shell text) hits, or null. */
export function safetyNetCheck(command: string, options: SafetyNetOptions = {}): SafetyNetHit | null {
  if (typeof command !== "string" || !command.trim()) return null;
  return checkText(command.slice(0, 64 * 1024), options, 0);
}
