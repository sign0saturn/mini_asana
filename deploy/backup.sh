#!/bin/bash
# mini-asana data backup: archive projects.json + projects/ into data/backups/, keep the latest 8
# (multi-project: since 2026-07-27 data uses per-project files; falls back to legacy single-file tasks.json)
set -e
DATA="$HOME/mini-asana/data"
DIR="$DATA/backups"
mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/tasks-$TS.tar.gz"
if [ -d "$DATA/projects" ]; then
  tar -czf "$OUT" -C "$DATA" projects.json projects
elif [ -f "$DATA/tasks.json" ]; then
  cp "$DATA/tasks.json" "$DIR/tasks-$TS.json" && OUT="$DIR/tasks-$TS.json"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') backup skipped: no data found" >&2
  exit 1
fi
ls -1t "$DIR"/tasks-*.tar.gz "$DIR"/tasks-*.json 2>/dev/null | tail -n +9 | xargs rm -f
echo "$(date '+%Y-%m-%d %H:%M:%S') backup ok: $(basename "$OUT") ($(ls -1 "$DIR" | wc -l | tr -d ' ') files kept)"
