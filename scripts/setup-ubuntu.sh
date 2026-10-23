#!/usr/bin/env bash
# Headless Ubuntu onboarding. Approve from a browser on a separate computer.
set -euo pipefail
set +x
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="wecommander"
DATA_DIR="/var/lib/webrising-commender"
CONFIG="$DATA_DIR/agent.json"
WORKSPACE="$DATA_DIR/workspace"
CONTROL_URL="https://wecommander.webrising.tr"
BINARY=""
EXPECTED_SHA256=""
ALLOWED_ROOT=""
SKIP_ENROLL=0

usage() {
  cat <<'EOF'
Usage: sudo bash scripts/setup-ubuntu.sh --binary /path/to/webrising-commender --sha256 64_HEX
Options: --control-url https://wecommander.webrising.tr
         --allowed-root /path/to/specific/directory
         --skip-enroll (existing enrollment only)
The agent uses an unprivileged Linux system account. Device approval
happens in your ordinary browser, not on the Ubuntu server.
EOF
}
while (($#)); do
  case "$1" in
    --binary) BINARY="${2:-}"; shift 2 ;;
    --sha256) EXPECTED_SHA256="${2:-}"; shift 2 ;;
    --control-url) CONTROL_URL="${2:-}"; shift 2 ;;
    --allowed-root) ALLOWED_ROOT="${2:-}"; shift 2 ;;
    --skip-enroll) SKIP_ENROLL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ $EUID == 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ -n "$BINARY" && -f "$BINARY" && -x "$BINARY" ]] || { echo "Provide executable --binary." >&2; exit 1; }
[[ "$EXPECTED_SHA256" =~ ^[[:xdigit:]]{64}$ ]] || { echo "Provide artifact SHA256 using --sha256." >&2; exit 1; }
[[ "$CONTROL_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?/?$ ]] || { echo "HTTPS control URL required." >&2; exit 1; }
CONTROL_URL="${CONTROL_URL%/}"
for dependency in curl python3 runuser systemctl useradd id sha256sum install readlink; do
  command -v "$dependency" >/dev/null || { echo "Missing: $dependency" >&2; exit 1; }
done
test -d /run/systemd/system || { echo "systemd required." >&2; exit 1; }
BINARY="$(readlink -f -- "$BINARY")"
actual_sha="$(sha256sum -- "$BINARY" | awk '{print $1}')"
[[ "${actual_sha,,}" == "${EXPECTED_SHA256,,}" ]] || { echo "SHA256 mismatch, aborting." >&2; exit 1; }
"$BINARY" --version >/dev/null
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
[[ "$(id -u "$SERVICE_USER")" != 0 ]] || { echo "Agent must not run as root." >&2; exit 1; }
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$WORKSPACE"
ALLOWED_ROOT="${ALLOWED_ROOT:-$WORKSPACE}"
[[ -d "$ALLOWED_ROOT" ]] || { echo "Allowed root does not exist." >&2; exit 1; }
ALLOWED_ROOT="$(readlink -f -- "$ALLOWED_ROOT")"
case "$ALLOWED_ROOT" in
  /|/root|/etc|/var|/usr|/home|/var/lib|/var/lib/docker|/data|/srv)
    echo "Broad or sensitive filesystem root refused." >&2; exit 1 ;;
esac
runuser -u "$SERVICE_USER" -- test -r "$ALLOWED_ROOT" || { echo "Agent cannot read allowed directory." >&2; exit 1; }
runuser -u "$SERVICE_USER" -- test -x "$ALLOWED_ROOT" || { echo "Agent cannot traverse allowed directory." >&2; exit 1; }
if [[ -f "$CONFIG" ]]; then
  runuser -u "$SERVICE_USER" -- test -r "$CONFIG" || { echo "Existing config inaccessible, no re-pair." >&2; exit 1; }
  echo "Preserving existing device identity."
elif ((SKIP_ENROLL)); then
  echo "No enrollment exists to reuse." >&2; exit 1
else
  json_field() {
    python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1],""); print(v if isinstance(v,(int,str)) else "")' "$1"
  }
  json_post() {
    printf '%s' "$2" | curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
      --connect-timeout 7 --max-time 15 -H 'Content-Type: application/json' \
      --data-binary @- "$CONTROL_URL$1"
  }
  response="$(json_post "/api/device-link/start" '{}')"
  request_id="$(json_field requestId <<< "$response")"
  request_secret="$(json_field requestSecret <<< "$response")"
  ttl="$(json_field expiresInSeconds <<< "$response")"
  [[ "$request_id" =~ ^[a-fA-F0-9-]{36}$ && "${#request_secret}" -ge 20 ]] || { echo "Invalid device-link response." >&2; exit 1; }
  [[ "$ttl" =~ ^[0-9]+$ ]] || ttl=600
  (( ttl >= 1 && ttl <= 600 )) || ttl=600
  body="$(python3 -c 'import json,sys;print(json.dumps({"requestId":sys.argv[1],"requestSecret":sys.argv[2]}))' "$request_id" "$request_secret")"
  printf '\nOpen in your own browser and approve the Ubuntu server:\n%s/connect-device?requestId=%s\n\n' "$CONTROL_URL" "$request_id"
  echo "Waiting for authorization (no codes or credentials will be printed)..."
  deadline=$((SECONDS+ttl))
  pairing_code=""
  while ((SECONDS < deadline)); do
    if result="$(json_post "/api/device-link/poll" "$body")"; then
      status="$(json_field status <<< "$result")"
      case "$status" in
        approved) pairing_code="$(json_field pairingCode <<< "$result")"; break ;;
        pending) : ;;
        *) echo "Request expired/invalid; restart." >&2; exit 1 ;;
      esac
    else
      echo "Temporary connection error; retrying..." >&2
    fi
    sleep 3
  done
  unset body request_secret response result
  [[ "${#pairing_code}" -ge 20 ]] || { echo "Timed out without approval." >&2; exit 1; }
  echo "Approved. Enrolling as unprivileged service user..."
  runuser -u "$SERVICE_USER" -- "$BINARY" --config "$CONFIG" enroll \
    --control-url "$CONTROL_URL" --pairing-code "$pairing_code" --allowed-root "$ALLOWED_ROOT"
  unset pairing_code
fi
runuser -u "$SERVICE_USER" -- "$BINARY" --config "$CONFIG" doctor >/dev/null
bash "$SCRIPT_DIR/install-linux.sh" "$BINARY" "$CONFIG" "$SERVICE_USER"
echo "Installed. Check: sudo systemctl is-active webrising-commender"
echo "No inbound port required. Verify the new server in WECOMMANDER > Devices."
