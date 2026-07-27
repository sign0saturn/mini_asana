#!/bin/bash
# mini-asana 数据备份：打包 projects.json + projects/ 到 data/backups/，保留最新 8 份
# （多项目版：2026-07-27 起数据为分项目文件布局；兼容旧版单文件 tasks.json）
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
