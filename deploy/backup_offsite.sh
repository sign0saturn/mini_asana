#!/bin/bash
# mini-asana offsite encrypted backup:
#   tar data/projects.json + projects/ -> AES-256-CBC (PBKDF2, 600k iterations, openssl enc)
#   with the key in data/backup_key.txt -> iCloud Drive mini-asana-backups/, keep the latest 30.
# The key never leaves this machine, so the iCloud copy is useless to anyone without it;
# keep a copy of the key in a password manager for the machine-loss scenario.
# Logs to ~/mini-asana/backup_offsite.log; exits non-zero with a clear message on failure.
set -u
LOG="$HOME/mini-asana/backup_offsite.log"
DATA="$HOME/mini-asana/data"
KEY_FILE="$DATA/backup_key.txt"
ICLOUD_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/mini-asana-backups"
KEEP=30

ts() { date '+%Y-%m-%d %H:%M:%S'; }
fail() { echo "$(ts) ERROR $*" >> "$LOG"; echo "ERROR: $*" >&2; exit 1; }

[ -f "$KEY_FILE" ] || fail "backup key missing: $KEY_FILE (generate with: openssl rand -hex 24)"
KEYLEN=$(tr -d '[:space:]' < "$KEY_FILE" | wc -c | tr -d ' ')
[ "$KEYLEN" = "48" ] || fail "backup key must be 48 hex chars (got $KEYLEN)"
[ -d "$DATA/projects" ] || fail "no project data at $DATA/projects"

mkdir -p "$ICLOUD_DIR" || fail "cannot create iCloud backup dir: $ICLOUD_DIR"

TS=$(date +%Y%m%d-%H%M%S)
TMP="$DATA/.offsite-$TS.tar.gz"
trap 'rm -f "$TMP"' EXIT
tar -czf "$TMP" -C "$DATA" projects.json projects || fail "tar failed"
OUT="$ICLOUD_DIR/mini-asana-$TS.tar.gz.enc"
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass file:"$KEY_FILE" \
  -in "$TMP" -out "$OUT" || fail "openssl encrypt failed"
rm -f "$TMP"
trap - EXIT

# prune: keep the newest $KEEP encrypted backups
ls -1t "$ICLOUD_DIR"/mini-asana-*.tar.gz.enc 2>/dev/null | tail -n +$((KEEP + 1)) | xargs rm -f
SIZE=$(ls -lh "$OUT" | awk '{print $5}')
KEPT=$(ls -1 "$ICLOUD_DIR"/mini-asana-*.tar.gz.enc 2>/dev/null | wc -l | tr -d ' ')
echo "$(ts) offsite backup ok: $(basename "$OUT") ($SIZE, $KEPT/$KEEP kept)" >> "$LOG"
echo "ok: $OUT ($SIZE)"
