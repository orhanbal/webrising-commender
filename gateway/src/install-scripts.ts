// One-line device install (v1.1 item 2).
//   Linux/macOS: curl -fsSL https://<gateway>/install.sh | sh
//   Windows:     irm https://<gateway>/install.ps1 | iex
//                (or the panel's WECOMMANDER-Kur.cmd, which runs the same)
// On Windows this installs the one WECOMMANDER app for the current user; the
// app carries the agent, signs in through the browser and pairs itself.
// The agent alone (servers without a desktop) stays at /install/agent.ps1.
// /install.sh is a small dispatcher bound to this gateway's public origin. It
// downloads the platform installer from the same origin; that installer only
// accepts a GitHub release package whose SHA-256 matches the published
// SHA256SUMS.txt, then enrolls the device against this gateway.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files: Record<string, string> = {
  "/install/ubuntu.sh": "ubuntu.sh",
  "/install/macos.sh": "macos.sh",
  "/install.ps1": "center-windows.ps1",
  "/install/agent.ps1": "windows.ps1",
  "/install/center.ps1": "center-windows.ps1",
  "/install/center.sh": "center-macos.sh",
};

export function installCommands(origin: string) {
  return {
    unix: `curl -fsSL ${origin}/install.sh | sh`,
    windows: `irm ${origin}/install.ps1 | iex`,
    /** For Win+R or cmd.exe, where irm is not a command. */
    windowsRun: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${origin}/install.ps1 | iex"`,
    windowsAgent: `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${origin}/install/agent.ps1)))"`,
    centerWindows: `irm ${origin}/install/center.ps1 | iex`,
    centerMacos: `curl -fsSL ${origin}/install/center.sh | sh`,
  };
}

export function dispatcher(origin: string) {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(origin)) throw new Error("invalid_origin");
  return `#!/bin/sh
# WECOMMANDER one-line installer for Ubuntu/Debian (amd64) and macOS (the app).
# Usage: curl -fsSL ${origin}/install.sh | sh
#        curl -fsSL ${origin}/install.sh | sh -s -- --package-only
# The platform installer verifies the package SHA-256 against the published
# SHA256SUMS.txt before installing, then links this device to ${origin}.
set -eu
BASE='${origin}'
case "$(uname -s)" in
  Linux) platform=ubuntu ;;
  # A Mac gets the WECOMMANDER app, which carries the agent and pairs itself
  # (the agent alone stays at /install/macos.sh).
  Darwin) platform=center ;;
  *) echo "Unsupported system. On Windows run: ${installCommands(origin).windows.replace(/"/g, '\\"')}" >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v bash >/dev/null 2>&1 || { echo "bash is required." >&2; exit 1; }
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT INT TERM
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-time 60 "$BASE/install/$platform.sh" -o "$tmp"
run() {
  if [ "$platform" = center ]; then
    sh "$tmp" "$@"
  elif [ "$platform" = ubuntu ] && [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || { echo "Run as root or install sudo." >&2; exit 1; }
    sudo bash "$tmp" --control-url "$BASE" "$@"
  else
    bash "$tmp" --control-url "$BASE" "$@"
  fi
}
# The script itself arrives on stdin; give the installer the terminal instead.
if [ -t 1 ] && (exec </dev/tty) 2>/dev/null; then
  run "$@" </dev/tty
else
  run "$@"
fi
`;
}

const cache = new Map<string, Buffer>();
async function packaged(name: string) {
  const hit = cache.get(name);
  if (hit) return hit;
  for (const candidate of [path.resolve(here, "../public/install", name), path.resolve(here, "../../public/install", name)]) {
    try { const body = await fs.readFile(candidate); cache.set(name, body); return body; } catch { /* next */ }
  }
  return null;
}

export const windowsCmdPath = "/install/WECOMMANDER-Kur.cmd";

/**
 * The panel's download for Windows: a .cmd that runs the PowerShell one-line
 * installer. What it downloads (the app and its agent) arrives through
 * PowerShell, not the browser, so it carries no "downloaded from the
 * internet" mark and no SmartScreen warning; only this small file itself
 * may be asked about once. ASCII with CRLF, as cmd.exe expects.
 */
export function windowsCmd(origin: string) {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(origin)) throw new Error("invalid_origin");
  return [
    "@echo off",
    "rem WECOMMANDER installer: downloads the app from the official GitHub release,",
    "rem checks its SHA-256 and installs it for this Windows user (no administrator rights).",
    "title WECOMMANDER kurulumu",
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm '${origin}/install.ps1' | iex"`,
    "if errorlevel 1 (",
    "  echo.",
    "  echo Kurulum tamamlanamadi. Yukaridaki mesaja bak ve yeniden dene.",
    "  pause",
    "  exit /b 1",
    ")",
    "echo.",
    "echo WECOMMANDER kuruldu. Tarayicida hesabinla giris yap; bu pencere birazdan kapanir.",
    "timeout /t 8 >nul",
    "",
  ].join("\r\n");
}

/** Returns the body for an install route, or null when the path is not one. */
export async function installRoute(pathname: string, origin: string): Promise<Buffer | null | "missing"> {
  if (pathname === "/install.sh") return Buffer.from(dispatcher(origin), "utf8");
  if (pathname === windowsCmdPath) return Buffer.from(windowsCmd(origin), "ascii");
  const name = files[pathname];
  if (!name) return null;
  return (await packaged(name)) ?? "missing";
}
