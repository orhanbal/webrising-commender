// One-line device install (v1.1 item 2).
//   Linux/macOS: curl -fsSL https://<gateway>/install.sh | sh
//   Windows:     powershell ... "& ([scriptblock]::Create((irm https://<gateway>/install.ps1)))"
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
  "/install.ps1": "windows.ps1",
};

export function installCommands(origin: string) {
  return {
    unix: `curl -fsSL ${origin}/install.sh | sh`,
    windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${origin}/install.ps1)))"`,
  };
}

export function dispatcher(origin: string) {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(origin)) throw new Error("invalid_origin");
  return `#!/bin/sh
# WECOMMANDER one-line installer for Ubuntu/Debian (amd64) and macOS.
# Usage: curl -fsSL ${origin}/install.sh | sh
#        curl -fsSL ${origin}/install.sh | sh -s -- --package-only
# The platform installer verifies the package SHA-256 against the published
# SHA256SUMS.txt before installing, then links this device to ${origin}.
set -eu
BASE='${origin}'
case "$(uname -s)" in
  Linux) platform=ubuntu ;;
  Darwin) platform=macos ;;
  *) echo "Unsupported system. On Windows run: ${installCommands(origin).windows.replace(/"/g, '\\"')}" >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v bash >/dev/null 2>&1 || { echo "bash is required." >&2; exit 1; }
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT INT TERM
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-time 60 "$BASE/install/$platform.sh" -o "$tmp"
run() {
  if [ "$platform" = ubuntu ] && [ "$(id -u)" -ne 0 ]; then
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

/** Returns the body for an install route, or null when the path is not one. */
export async function installRoute(pathname: string, origin: string): Promise<Buffer | null | "missing"> {
  if (pathname === "/install.sh") return Buffer.from(dispatcher(origin), "utf8");
  const name = files[pathname];
  if (!name) return null;
  return (await packaged(name)) ?? "missing";
}
