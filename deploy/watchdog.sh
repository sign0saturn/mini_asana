#!/bin/zsh
# mini-asana watchdog (origin app + cloudflared tunnel), invoked by LaunchAgent every 2 minutes.
#
# Two independent probes, each with its own consecutive-failure counter (2 strikes -> restart):
#  A) ORIGIN: http://127.0.0.1:8787/api/projects with the Bearer token — proves the app AND its
#     auth path are alive. 2 failures -> kickstart com.minwu.miniasana.
#  B) EDGE: https://wudong.me/ via DoH + --resolve (router DNS runs fake-ip, so the real edge IP
#     must be fetched over DoH first). Healthy = 200/401/302/303 — with Cloudflare Access in front,
#     an unauthenticated request is intercepted with a 302 to the edge login, which still proves
#     DNS + edge + Access config are alive. 2 failures -> kickstart com.minwu.miniasana-tunnel.
#     NOTE: with Access intercepting at the edge, this probe can no longer see origin/tunnel
#     failures (530s) — tunnel depth is covered by probe A. A CF Access service token
#     (CF-Access-Client-Id/Secret) could restore end-to-end probing if ever configured.
#  C) ZOMBIE: `cloudflared tunnel info` asks Cloudflare's control plane whether the tunnel has
#     any active connections. cloudflared can believe its connections are alive while the control
#     plane reports zero (zombie state -> users see Error 1033 while the edge probe still gets 302
#     from Access). 2 consecutive zombie reports -> kickstart com.minwu.miniasana-tunnel.
#     (2026-09-20 incident: split-brain zombie state caused a 1033 outage that probes A/B missed.)

set -u
LOG="$HOME/mini-asana/watchdog.log"
STATE_APP="$HOME/mini-asana/.watchdog_fails_app"
STATE_EDGE="$HOME/mini-asana/.watchdog_fails"
STATE_ZOMBIE="$HOME/mini-asana/.watchdog_fails_zombie"
DOMAIN="wudong.me"
TOKEN_FILE="$HOME/mini-asana/data/auth_token.txt"
TUNNEL_ID="ba1d787c-3922-47f4-b7fd-9ed2e0d10b69"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# strike <state-file> <current-code> <ok?> -> echoes new fail count
bump() { echo $(( $(cat "$1" 2>/dev/null || echo 0) + 1 )) > "$1"; cat "$1"; }

# ---- C) tunnel zombie probe (control-plane truth) ----
TINFO=$("$HOME/bin/cloudflared" tunnel info "$TUNNEL_ID" 2>&1)
if [ $? -ne 0 ]; then
  echo "$(ts) WARN tunnel info 调用失败，zombie 探测本轮跳过" >> "$LOG"
elif echo "$TINFO" | /usr/bin/grep -q "does not have any active connection"; then
  FAILS=$(bump "$STATE_ZOMBIE")
  echo "$(ts) FAIL zombie#$FAILS 控制面报告无活动连接" >> "$LOG"
  if [ "$FAILS" -ge 2 ]; then
    echo "$(ts) ACTION kickstart com.minwu.miniasana-tunnel (zombie)" >> "$LOG"
    launchctl kickstart -k "gui/$(id -u)/com.minwu.miniasana-tunnel" >> "$LOG" 2>&1
    echo 0 > "$STATE_ZOMBIE"
  fi
else
  PREV=$(cat "$STATE_ZOMBIE" 2>/dev/null || echo 0)
  [ "$PREV" != "0" ] && echo "$(ts) OK zombie 探测恢复，此前连续 $PREV 次" >> "$LOG"
  echo 0 > "$STATE_ZOMBIE"
fi

# ---- A) origin app probe (Bearer) ----
TOK=$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')
ACODE="000"
if [ -n "$TOK" ]; then
  ACODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
          -H "Authorization: Bearer $TOK" "http://127.0.0.1:8787/api/projects")
fi
if [ "$ACODE" = "200" ]; then
  PREV=$(cat "$STATE_APP" 2>/dev/null || echo 0)
  [ "$PREV" != "0" ] && echo "$(ts) OK origin 恢复（HTTP $ACODE），此前连续失败 $PREV 次" >> "$LOG"
  echo 0 > "$STATE_APP"
else
  FAILS=$(bump "$STATE_APP")
  echo "$(ts) FAIL origin#$FAILS HTTP $ACODE" >> "$LOG"
  if [ "$FAILS" -ge 2 ]; then
    echo "$(ts) ACTION kickstart com.minwu.miniasana (origin)" >> "$LOG"
    launchctl kickstart -k "gui/$(id -u)/com.minwu.miniasana" >> "$LOG" 2>&1
    echo 0 > "$STATE_APP"
  fi
fi

# ---- B) edge probe (DoH + --resolve; 302/303 = Access intercept = healthy) ----
IP=$(curl -s --max-time 8 "https://1.1.1.1/dns-query?name=${DOMAIN}&type=A" \
     -H 'accept: application/dns-json' \
     | /usr/bin/python3 -c "import sys,json
try:
    print(next(a['data'] for a in json.load(sys.stdin).get('Answer', []) if a.get('type') == 1))
except Exception:
    pass" 2>/dev/null)

if [ -z "$IP" ]; then
  echo "$(ts) WARN DoH 解析失败，edge 探测本轮跳过" >> "$LOG"
  exit 0
fi

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
       --resolve "${DOMAIN}:443:${IP}" "https://${DOMAIN}/")

if [ "$CODE" = "200" ] || [ "$CODE" = "401" ] || [ "$CODE" = "302" ] || [ "$CODE" = "303" ]; then
  PREV=$(cat "$STATE_EDGE" 2>/dev/null || echo 0)
  [ "$PREV" != "0" ] && echo "$(ts) OK edge 恢复（HTTP $CODE），此前连续失败 $PREV 次" >> "$LOG"
  echo 0 > "$STATE_EDGE"
  exit 0
fi

FAILS=$(bump "$STATE_EDGE")
echo "$(ts) FAIL edge#$FAILS HTTP $CODE" >> "$LOG"
if [ "$FAILS" -ge 2 ]; then
  echo "$(ts) ACTION kickstart com.minwu.miniasana-tunnel (edge)" >> "$LOG"
  launchctl kickstart -k "gui/$(id -u)/com.minwu.miniasana-tunnel" >> "$LOG" 2>&1
  echo 0 > "$STATE_EDGE"
fi
