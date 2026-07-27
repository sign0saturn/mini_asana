#!/bin/zsh
# mini-asana tunnel watchdog
# 每 2 分钟由 LaunchAgent 调用：检测 https://${DOMAIN} 是否被 Cloudflare 边缘正常服务。
# 路由器 DNS 为 fake-ip 模式时，必须先用 DoH 取真实边缘 IP 再 --resolve 直连，
# 否则检测结果不可信（假 IP 由路由器代理转发）。
# 连续 2 次失败（000=连不上，530=边缘认不到隧道）则 kickstart 隧道服务。
#
# 可通过环境变量覆盖两个默认值（例如在调用脚本或 plist 的 EnvironmentVariables 中设置）：
#   WATCHDOG_DOMAIN       监控的域名（默认 your-domain.example.com，务必改成你的真实域名）
#   WATCHDOG_TUNNEL_LABEL 隧道 launchd 服务的 Label（默认 local.miniasana-tunnel）

set -u
LOG="$HOME/mini-asana/watchdog.log"
STATE="$HOME/mini-asana/.watchdog_fails"
DOMAIN="${WATCHDOG_DOMAIN:-your-domain.example.com}"
TUNNEL_LABEL="${WATCHDOG_TUNNEL_LABEL:-local.miniasana-tunnel}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 1) 取真实边缘 IP（DoH，绕过路由器 fake-ip）
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

# 2) 直连边缘检测（根路径应 200/401；530=隧道失联，000=不通）
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
