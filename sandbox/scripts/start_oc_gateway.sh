#!/bin/sh
# Start (or restart) the OpenClaw gateway inside the sandbox, with a token
# persisted in /sandbox/.openclaw/openclaw.json, so that:
#   - `openclaw tui` can authenticate via OPENCLAW_GATEWAY_TOKEN env
#   - the dashboard URL `http://127.0.0.1:18789/#token=<X>` works
#
# Usage (inside the sandbox):
#   sh /tmp/start_oc_gateway.sh [--rotate]
#
# Side effects:
#   - Writes /tmp/oc-token.env  (sourceable: TOKEN=<hex>)
#   - Writes /tmp/gateway.log   (gateway stdout/stderr)
#   - Leaves a detached gateway process listening on 127.0.0.1:18789
set -u

# Node, not Python: the sandbox image ships node 22, and this repo keeps Python
# to the eval harness and the data generator where the libraries earn it.
SET_TOKEN_JS="${SET_TOKEN_JS:-/tmp/set_oc_token.js}"
TOKEN_ENV_FILE="${TOKEN_ENV_FILE:-/tmp/oc-token.env}"
LOG_FILE="${LOG_FILE:-/tmp/gateway.log}"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
ROTATE_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --rotate) ROTATE_FLAG="--rotate" ;;
  esac
done

echo "=== killing any existing gateway ==="
openclaw gateway stop 2>/dev/null || true
pkill -9 -f "openclaw gateway" 2>/dev/null || true
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 2

echo "=== writing token into /sandbox/.openclaw/openclaw.json ==="
[ -f "$SET_TOKEN_JS" ] || { echo "ERROR: $SET_TOKEN_JS not found"; exit 1; }
TOKEN=$(node "$SET_TOKEN_JS" $ROTATE_FLAG)
[ -n "$TOKEN" ] || { echo "ERROR: token write failed"; exit 1; }
echo "TOKEN=$TOKEN" > "$TOKEN_ENV_FILE"
echo "TOKEN persisted: $TOKEN"

echo "=== starting gateway (detached) ==="
# Launch without `--force`. That flag relies on fuser/lsof, which this hardened
# sandbox image does not include. The port-clear above is best-effort for the
# same reason and is a harmless no-op when those tools are absent.
setsid nohup openclaw gateway run --bind loopback --port "$PORT" \
  > "$LOG_FILE" 2>&1 < /dev/null &
disown 2>/dev/null || true

echo "=== waiting up to 15s for port $PORT ==="
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  sleep 1
  if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${PORT}"; then
    echo "GATEWAY_UP after ${i}s"
    UP=yes
    break
  fi
done

if [ "${UP:-no}" != "yes" ]; then
  echo "GATEWAY_DOWN — see $LOG_FILE:"
  tail -30 "$LOG_FILE"
  exit 1
fi

echo "=== gateway state ==="
(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep "${PORT}" || true

echo ""
echo "OK — token persisted, gateway listening on 127.0.0.1:${PORT}"
echo "To use the TUI:"
echo "  export OPENCLAW_GATEWAY_TOKEN=$TOKEN"
echo "  openclaw tui"
echo ""
echo "Browser URL (after host port-forward 18789 → laptop):"
echo "  http://127.0.0.1:${PORT}/#token=$TOKEN"
