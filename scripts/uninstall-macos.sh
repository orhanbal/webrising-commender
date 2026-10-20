#!/usr/bin/env bash
set -euo pipefail

LABEL="tr.webrising.commender"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "LaunchAgent removed."
echo "Agent binary, config and logs were NOT deleted."
