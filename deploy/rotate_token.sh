#!/bin/bash
# mini-asana token rotation: generate a fresh 32-char hex token into data/auth_token.txt
# (mode 600) and restart the launchd service so the new token takes effect.
#
# EVERY existing session is invalidated by a rotation (browsers store the old token in
# localStorage): all devices must log in once with the new token afterwards.
#
# The launchd label defaults to local.miniasana; override with MINIASANA_LABEL.
# No real token is ever stored in this script — it is generated at run time.
set -euo pipefail

BASE="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$BASE/data"
TOKEN_FILE="$DATA_DIR/auth_token.txt"
LABEL="${MINIASANA_LABEL:-local.miniasana}"

mkdir -p "$DATA_DIR"
NEW_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
( umask 077; printf '%s\n' "$NEW_TOKEN" > "$TOKEN_FILE" )
chmod 600 "$TOKEN_FILE"
echo "[rotate] new token written to $TOKEN_FILE (mode 600)"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  echo "[rotate] service $LABEL restarted"
else
  echo "[rotate] launchd service $LABEL not found — restart mini-asana manually"
fi

echo "[rotate] new token (distribute to your devices, then log in again):"
echo "$NEW_TOKEN"
