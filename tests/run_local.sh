#!/bin/bash
# One-command local regression: spins up a throwaway mini-asana instance from THIS repo
# checkout (temp dir, own data/, auth on, a test Access allowlist), runs all suites in
# tests/ against it, then tears everything down. Nothing touches your real data.
#
# Usage:  tests/run_local.sh [port]     (default port 8816)
set -u
PORT="${1:-8816}"
CF_EMAIL="owner@example.com"   # test fixture value, must match what the suites expect
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SBX="$(mktemp -d /tmp/mini-asana-test-XXXXXX)"
SRV_PID=""

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$SBX"
}
trap cleanup EXIT

mkdir -p "$SBX/data"
cp "$REPO/server.py" "$SBX/"
cp -r "$REPO/static" "$SBX/"
echo "$CF_EMAIL" > "$SBX/data/access_email.txt"   # enable CF-header auth for the opt-in tests

(cd "$SBX" && python3 server.py --port "$PORT" > server.log 2>&1) &
SRV_PID=$!

# wait for readiness (up to ~5s)
i=0
while [ $i -lt 50 ]; do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.1; i=$((i + 1))
done
[ $i -lt 50 ] || { echo "server did not start"; exit 1; }
TOKEN="$(cat "$SBX/data/auth_token.txt")"

echo "== sandbox: $SBX (port $PORT) =="
rc=0
for t in test_security_api.py test_security_raw_socket.py; do
  echo; echo "===== $t ====="
  python3 "$REPO/tests/$t" "$PORT" "$TOKEN" "$CF_EMAIL" || rc=1
done
echo; echo "===== test_render_grouping.js ====="
node "$REPO/tests/test_render_grouping.js" "$PORT" "$TOKEN" || rc=1

echo
[ $rc -eq 0 ] && echo "ALL SUITES PASS" || echo "SOME SUITES FAILED"
exit $rc
