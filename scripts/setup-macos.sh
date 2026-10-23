#!/bin/bash
# Per-user WECOMMANDER macOS setup. Requires macOS 12+ and a GUI login session.
set -euo pipefail
set +x
umask 077
CONTROL_URL="https://wecommander.webrising.tr"
ALLOWED_ROOT="$HOME/Documents/WECOMMANDER"
while (($#)); do
  case "$1" in
    --control-url) CONTROL_URL="${2:-}"; shift 2 ;;
    --allowed-root) ALLOWED_ROOT="${2:-}"; shift 2 ;;
    --help|-h)
      echo "Usage: wecommander-setup [--allowed-root EXISTING_DIRECTORY] [--control-url HTTPS_URL]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || { echo "macOS required." >&2; exit 1; }
(( EUID != 0 )) || { echo "Run as your Mac user (without sudo)." >&2; exit 1; }
[[ "$CONTROL_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?/?$ ]] || { echo "Use an HTTPS control URL." >&2; exit 1; }
CONTROL_URL="${CONTROL_URL%/}"
BIN="/usr/local/bin/webrising-commender"
INSTALL_SCRIPT="/usr/local/libexec/wecommander/install-macos.sh"
[[ -x "$BIN" && -f "$INSTALL_SCRIPT" ]] || { echo "WECOMMANDER macOS package not installed." >&2; exit 1; }
[[ "$ALLOWED_ROOT" != / && "$ALLOWED_ROOT" != "$HOME" ]] || { echo "Select a narrow allowed directory." >&2; exit 1; }
mkdir -p -- "$ALLOWED_ROOT"
CONFIG="$HOME/Library/Application Support/webrising-commender/agent.json"
mkdir -p "$(dirname "$CONFIG")"
chmod 700 "$(dirname "$CONFIG")"
json_field() {
  # JavaScript for Automation is built into macOS; no Homebrew/Python needed.
  printf '%s' "$2" | /usr/bin/osascript -l JavaScript -e '
function run(argv) {
 ObjC.import("Foundation");
 var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
 var body = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
 var value = JSON.parse(body)[argv[0]];
 return (typeof value === "string" || typeof value === "number") ? String(value) : "";
}' "$1"
}
json_post() {
  printf '%s' "$2" | curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --connect-timeout 7 --max-time 15 -H 'Content-Type: application/json' \
    --data-binary @- "$CONTROL_URL$1"
}
if [[ ! -f "$CONFIG" ]]; then
  response="$(json_post '/api/device-link/start' '{}')"
  id="$(json_field requestId "$response")"
  secret="$(json_field requestSecret "$response")"
  ttl="$(json_field expiresInSeconds "$response")"
  [[ "$id" =~ ^[A-Fa-f0-9-]{36}$ && "${#secret}" -ge 20 ]] || { echo "Unexpected authorization reply." >&2; exit 1; }
  [[ "$ttl" =~ ^[0-9]+$ ]] || ttl=600
  ((ttl > 0 && ttl <= 600)) || ttl=600
  request="$(printf '{"requestId":"%s","requestSecret":"%s"}' "$id" "$secret")"
  url="$CONTROL_URL/connect-device?requestId=$id"
  echo "Open the following URL in your regular browser, sign in, and approve the Mac:"
  echo "$url"
  open "$url" || true
  code=""
  deadline=$((SECONDS+ttl))
  while (( SECONDS < deadline )); do
    if response="$(json_post '/api/device-link/poll' "$request")"; then
      state="$(json_field status "$response")"
      case "$state" in
        approved) code="$(json_field pairingCode "$response")"; break ;;
        pending) : ;;
        *) echo "Approval expired or invalid." >&2; exit 1 ;;
      esac
    else
      echo "Connection unavailable. Retrying..."
    fi
    sleep 3
  done
  unset response request secret
  [[ "${#code}" -ge 20 ]] || { echo "Approval timed out." >&2; exit 1; }
  "$BIN" --config "$CONFIG" enroll --control-url "$CONTROL_URL" \
    --pairing-code "$code" --allowed-root "$ALLOWED_ROOT"
  unset code
else
  echo "Existing device enrollment found. Keeping its identity."
fi
"$BIN" --config "$CONFIG" doctor >/dev/null
bash "$INSTALL_SCRIPT" "$BIN" "$CONFIG"
echo "WECOMMANDER LaunchAgent installed; verify your Mac is Online in Devices."
