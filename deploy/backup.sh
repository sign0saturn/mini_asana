#!/bin/bash
# mini-asana 数据备份：复制 tasks.json 到 data/backups/，保留最新 8 份
set -e
SRC="$HOME/mini-asana/data/tasks.json"
DIR="$HOME/mini-asana/data/backups"
mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
cp "$SRC" "$DIR/tasks-$TS.json"
ls -1t "$DIR"/tasks-*.json 2>/dev/null | tail -n +9 | xargs rm -f
echo "$(date '+%Y-%m-%d %H:%M:%S') backup ok: tasks-$TS.json ($(ls -1 "$DIR" | wc -l | tr -d ' ') files kept)"
