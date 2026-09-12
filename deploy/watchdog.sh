#!/bin/zsh
# mini-asana watchdog (origin app + cloudflared tunnel), invoked by LaunchAgent every 2 minutes.
#
# Two independent probes, each with its own consecutive-failure counter (2 strikes -> restart):
#  A) ORIGIN: http://127.0.0.1:8787/api/projects with the Bearer token — proves the app AND its
#     auth path are alive. 2 failures -> kickstart the app service.
#  B) EDGE: https://${DOMAIN}/ via DoH + --resolve (when the router DNS runs in fake-ip mode, the
#     real edge IP must be fetched over DoH first). Healthy = 200/401/302/303 — with Cloudflare
#     Access in front, an unauthenticated request is intercepted with a 302 to the edge login,
#     which still proves DNS + edge + Access config are alive. 2 failures -> kickstart the tunnel.
#     NOTE: with Access intercepting at the edge, this probe can no longer see origin/tunnel
#     failures (530s) — tunnel depth is covered by probe A. A CF Access service token
#     (CF-Access-Client-Id/Secret) could restore end-to-end probing if ever configured.
#
# Defaults can be overridden via environment variables (e.g. in the plist's EnvironmentVariables):
#   WATCHDOG_DOMAIN        domain to monitor (default your-domain.example.com; set your real domain)
#   WATCHDOG_APP_LABEL     launchd Label of the app service (default local.miniasana)
#   WATCHDOG_TUNNEL_LABEL  launchd Label of the tunnel service (default local.miniasana-tunnel)
#   WATCHDOG_ORIGIN        origin base URL (default http://127.0.0.1:8787)

set -u
LOG="$HOME/mini-asana/watchdog.log"
STATE_APP="$HOME/mini-asana/.watchdog_fails_app"
STATE_EDGE="$HOME/mini-asana/.watchdog_fails"
DOMAIN="${WATCHDOG_DOMAIN:-your-domain.example.com}"
APP_LABEL="${WATCHDOG_APP_LABEL:-local.miniasana}"
TUNNEL_LABEL="${WATCHDOG_TUNNEL_LABEL:-local.miniasana-tunnel}"
ORIGIN="${WATCHDOG_ORIGIN:-http://127.0.0.1:8787}"
TOKEN_FILE="$HOME/mini-asana/data/auth_token.txt"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# bump <state-file> -> increment and echo the new consecutive-failure count
bump() { echo $(( $(cat "$1" 2>/dev/null || echo 0) + 1 )) > "$1"; cat "$1"; }

# ---- A) origin app probe (Bearer) ----
TOK=$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')
ACODE="000"
if [ -n "$TOK" ]; then
  ACODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
          -H "Authorization: Bearer $TOK" "$ORIGIN/api/projects")
fi
if [ "$ACODE" = "200" ]; then
  PREV=$(cat "$STATE_APP" 2>/dev/null || echo 0)
  [ "$PREV" != "0" ] && echo "$(ts) OK origin 恢复（HTTP $ACODE），此前连续失败 $PREV 次" >> "$LOG"
  echo 0 > "$STATE_APP"
else
  FAILS=$(bump "$STATE_APP")
  echo "$(ts) FAIL origin#$FAILS HTTP $ACODE" >> "$LOG"
  if [ "$FAILS" -ge 2 ]; then
    echo "$(ts) ACTION kickstart ${APP_LABEL} (origin)" >> "$LOG"
    launchctl kickstart -k "gui/$(id -u)/${APP_LABEL}" >> "$LOG" 2>&1
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
  echo "$(ts) ACTION kickstart ${TUNNEL_LABEL} (edge)" >> "$LOG"
  launchctl kickstart -k "gui/$(id -u)/${TUNNEL_LABEL}" >> "$LOG" 2>&1
  echo 0 > "$STATE_EDGE"
fi
