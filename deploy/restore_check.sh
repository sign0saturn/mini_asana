#!/bin/bash
# mini-asana offsite restore drill: fetch the newest encrypted backup from iCloud Drive,
# decrypt with data/backup_key.txt into a mktemp dir, untar, validate every JSON parses,
# print project/task counts and latest-activity evidence, then clean up.
# Non-zero exit = drill FAILED. Run it by hand whenever you want proof the backups are real.
set -u
BASE="$HOME/mini-asana"
KEY_FILE="$BASE/data/backup_key.txt"
ICLOUD_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/mini-asana-backups"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
fail() { echo "$(ts) RESTORE-DRILL FAIL: $*" >&2; exit 1; }

[ -f "$KEY_FILE" ] || fail "key missing: $KEY_FILE"
LATEST=$(ls -1t "$ICLOUD_DIR"/mini-asana-*.tar.gz.enc 2>/dev/null | head -1)
[ -n "$LATEST" ] || fail "no encrypted backups found in $ICLOUD_DIR"
echo "== drill target: $(basename "$LATEST") ($(ls -lh "$LATEST" | awk '{print $5}'))"

TMPD=$(mktemp -d /tmp/miniasana-restore.XXXXXX) || fail "mktemp failed"
trap 'rm -rf "$TMPD"' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:"$KEY_FILE" \
  -in "$LATEST" -out "$TMPD/data.tar.gz" || fail "decrypt failed (wrong key or corrupt file)"
tar -xzf "$TMPD/data.tar.gz" -C "$TMPD" || fail "untar failed"

python3 - "$TMPD" <<'PYEOF' || fail "JSON validation failed"
import json, os, sys
root = sys.argv[1]
idx = json.load(open(os.path.join(root, "projects.json"), encoding="utf-8"))
projects = idx.get("projects") or []
total = 0
latest = None  # (due_on, name) — activity evidence
for p in projects:
    db = json.load(open(os.path.join(root, "projects", p["id"] + ".json"), encoding="utf-8"))
    tasks = db.get("tasks") or []
    total += len(tasks)
    print(f"  - {db.get('project')}: {len(tasks)} tasks, sections={len(db.get('sections') or [])}")
    for t in tasks:
        key = (t.get("due_on") or "", t.get("name") or "")
        if latest is None or key > latest[0]:
            latest = (key, db.get("project"))
print(f"projects: {len(projects)}, tasks: {total}")
if latest:
    print(f"latest due_on evidence: {latest[0][0] or '-'} · task「{latest[0][1]}」 @ {latest[1]}")
print("all JSON parsed OK")
PYEOF

echo "$(ts) RESTORE-DRILL OK: $(basename "$LATEST") decrypted, untarred and validated"
