#!/bin/zsh
# mini-asana tunnel watchdog
# Invoked by LaunchAgent every 2 minutes: checks whether https://${DOMAIN} is properly served by Cloudflare edge.
# When the router DNS runs in fake-ip mode, the real edge IP must be resolved via DoH first and connected to with --resolve,
# otherwise the result is untrustworthy (fake IPs are forwarded by the router proxy).
# After 2 consecutive failures (000=unreachable, 530=edge does not know the tunnel), kickstart the tunnel service.
#
# Two defaults can be overridden via environment variables (e.g. in the calling script or the plist's EnvironmentVariables):
#   WATCHDOG_DOMAIN       domain to monitor (default your-domain.example.com; be sure to set your real domain)
#   WATCHDOG_TUNNEL_LABEL launchd Label of the tunnel service (default local.miniasana-tunnel)

set -u
LOG="$HOME/mini-asana/watchdog.log"
STATE="$HOME/mini-asana/.watchdog_fails"
DOMAIN="${WATCHDOG_DOMAIN:-your-domain.example.com}"
TUNNEL_LABEL="${WATCHDOG_TUNNEL_LABEL:-local.miniasana-tunnel}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 1) get the real edge IP (DoH, bypassing router fake-ip)
IP=$(curl -s --max-time 8 "https://1.1.1.1/dns-query?name=${DOMAIN}&type=A" \
     -H 'accept: application/dns-json' \
     | /usr/bin/python3 -c "import sys,json
try:
    print(next(a['data'] for a in json.load(sys.stdin).get('Answer', []) if a.get('type') == 1))
except Exception:
    pass" 2>/dev/null)

if [ -z "$IP" ]; then
    echo "$(ts) WARN DoH 解析失败，本轮跳过" >> "$LOG"
    exit 0
fi

# 2) direct edge check (root path should be 200/401; 530=tunnel lost, 000=unreachable)
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
       --resolve "${DOMAIN}:443:${IP}" "https://${DOMAIN}/")

if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then
    PREV=$(cat "$STATE" 2>/dev/null || echo 0)
    if [ "$PREV" != "0" ]; then
        echo "$(ts) OK 恢复（HTTP $CODE），此前连续失败 $PREV 次" >> "$LOG"
    fi
    echo 0 > "$STATE"
    exit 0
fi

FAILS=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$FAILS" > "$STATE"
echo "$(ts) FAIL#$FAILS HTTP $CODE" >> "$LOG"

if [ "$FAILS" -ge 2 ]; then
    echo "$(ts) ACTION kickstart ${TUNNEL_LABEL}" >> "$LOG"
    launchctl kickstart -k "gui/$(id -u)/${TUNNEL_LABEL}" >> "$LOG" 2>&1
    echo 0 > "$STATE"
fi
