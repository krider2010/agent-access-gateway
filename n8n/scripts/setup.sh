#!/usr/bin/env bash
# One-shot n8n configuration, all via the REST API (no UI clicks):
#   1. wait for n8n           2. create owner account (or reuse if it exists)
#   3. enable instance MCP    4. mint the MCP Server API key (aud: mcp-server-api)
#   5. write N8N_MCP_TOKEN into the repo-root .env
#
# Assumes: n8n/scripts/up.sh already ran and the container is named
# "n8n-gtc" (override with N8N_CONTAINER, kept in sync with up.sh's default).
#
# Why step 3/4 exist as a dedicated key mint, not just "create an n8n API
# key": n8n's /mcp-server/http endpoint requires a *dedicated MCP Server API
# key* (JWT aud: mcp-server-api) AND the instance "MCP access" toggle on. A
# normal public API key returns 401 with "jwt audience invalid. expected:
# mcp-server-api", which is the signal that the wrong key type is in use.
#
# This script deliberately does NOT create the gateway workflows. It sets up the
# instance and mints the token; `make rebuild` authors and deploys the workflows
# from source in n8n/workflows/ rather than from a checked-in export.
#
# Env overrides (the defaults below are generic placeholders, not credentials):
#   N8N_URL        (default http://localhost:$N8N_PORT, N8N_PORT default 5678)
#   OWNER_EMAIL    (default admin@example.com;   override with your own)
#   OWNER_PASSWORD (default ChangeMe-Demo1;      CHANGE THIS)
#   OWNER_FIRST / OWNER_LAST (display name; default Demo / Admin)
#   N8N_CONTAINER  (default n8n-gtc; must match n8n/scripts/up.sh)
set -euo pipefail

N8N_URL="${N8N_URL:-http://localhost:${N8N_PORT:-5678}}"
OWNER_EMAIL="${OWNER_EMAIL:-admin@example.com}"
OWNER_PASSWORD="${OWNER_PASSWORD:-ChangeMe-Demo1}"
OWNER_FIRST="${OWNER_FIRST:-Demo}"
OWNER_LAST="${OWNER_LAST:-Admin}"
CONTAINER="${N8N_CONTAINER:-n8n-gtc}"
[ "$OWNER_PASSWORD" = "ChangeMe-Demo1" ] && echo "⚠ Using the default demo password — set OWNER_PASSWORD to override." >&2
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$(cd "$SCRIPT_DIR/../.." && pwd)/.env"
CK="$(mktemp)"
trap 'rm -f "$CK"' EXIT

echo "▸ Waiting for n8n at $N8N_URL ..."
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$N8N_URL/healthz" || echo 000)" = "200" ] && break
  sleep 2
done

# healthz goes green BEFORE the MCP module finishes registering its routes, so
# a script that trusts healthz alone can hit /mcp-server/http and get a 404
# that looks like "MCP is unsupported on this version" rather than "not ready
# yet". Wait for the route to exist: 401 (or anything but 404) means the
# endpoint is mounted; 404 means it still isn't. Observed on n8n 2.32.7:
# roughly 10s of daylight between the two on a cold start.
echo "▸ Waiting for the MCP route to be mounted ..."
for _ in $(seq 1 30); do
  mcp_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N8N_URL/mcp-server/http" \
    -H 'Content-Type: application/json' -d '{}' || echo 000)
  [ "$mcp_code" != "404" ] && [ "$mcp_code" != "000" ] && break
  sleep 2
done
[ "${mcp_code:-404}" = "404" ] && \
  echo "⚠ /mcp-server/http still 404 after ~60s — MCP may be unavailable on this n8n version." >&2

# The /rest API mounts after /mcp-server/http, so neither gate above covers it.
# This one reads the body rather than the status, because during startup /rest/*
# answers 200 with the plain text "n8n is starting up. Please wait". A status
# check passes on that, `POST /rest/owner/setup` returns 200 without creating an
# owner, and every authenticated call afterwards is a 401 that surfaces two steps
# later as a JSON parse error.
echo "▸ Waiting for the /rest API to answer with JSON ..."
rest_ready=no
for _ in $(seq 1 45); do
  if curl -s "$N8N_URL/rest/settings" \
     | python3 -c "import json,sys; json.load(sys.stdin)['data']['userManagement']" >/dev/null 2>&1; then
    rest_ready=yes
    break
  fi
  sleep 2
done
[ "$rest_ready" = yes ] || {
  echo "✗ $N8N_URL/rest/settings is not returning JSON after ~90s."
  echo "  Last body, first 120 bytes:"
  curl -s "$N8N_URL/rest/settings" | head -c 120; echo
  echo "  n8n answers 200 with a plain-text startup message, so this is a slow start"
  echo "  rather than a broken API. Give it longer, or check 'docker logs'."
  exit 1
}

echo "▸ Creating owner account ($OWNER_EMAIL) ..."
code=$(curl -s -c "$CK" -o /tmp/owner.json -w '%{http_code}' -X POST "$N8N_URL/rest/owner/setup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OWNER_EMAIL\",\"firstName\":\"$OWNER_FIRST\",\"lastName\":\"$OWNER_LAST\",\"password\":\"$OWNER_PASSWORD\"}")
if [ "$code" != "200" ]; then
  echo "  owner setup returned $code (likely already set up) — logging in instead"
  curl -s -c "$CK" -o /dev/null -X POST "$N8N_URL/rest/login" \
    -H 'Content-Type: application/json' \
    -d "{\"emailOrLdapLoginId\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}"
fi

echo "▸ Enabling instance MCP access ..."
curl -s -b "$CK" -o /dev/null -X PATCH "$N8N_URL/rest/mcp/settings" \
  -H 'Content-Type: application/json' -d '{"mcpAccessEnabled":true}'

echo "▸ Minting MCP Server API key (rotate) ..."
# Report what came back rather than raising. A traceback here reads like a bug in
# this script; the usual cause is an HTML error page from an unmounted route, or a
# session that did not authenticate.
MCPKEY=$(curl -s -b "$CK" -X POST "$N8N_URL/rest/mcp/api-key/rotate" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "
import sys, json
raw = sys.stdin.read()
try:
    print(json.loads(raw)['data']['apiKey'])
except Exception:
    sys.stderr.write('✗ /rest/mcp/api-key/rotate did not return a key. First 200 bytes:\n' + raw[:200] + '\n')
")
[ -n "$MCPKEY" ] || { echo "✗ failed to mint MCP key"; exit 1; }

echo "▸ Writing N8N_MCP_TOKEN into $ENV_FILE ..."
python3 - "$ENV_FILE" "$MCPKEY" <<'PY'
import sys, re, os
path, key = sys.argv[1], sys.argv[2]
if os.path.exists(path):
    s = open(path).read()
    if re.search(r'^N8N_MCP_TOKEN=', s, re.M):
        s = re.sub(r'^N8N_MCP_TOKEN=.*$', f'N8N_MCP_TOKEN={key}', s, flags=re.M)
    else:
        s += f'\nN8N_MCP_TOKEN={key}\n'
    open(path, 'w').write(s)
else:
    open(path, 'w').write(f'N8N_MCP_TOKEN={key}\n')
print('  done')
PY

echo
echo "✓ n8n configured."
echo "    UI:    $N8N_URL"
echo "    Login: $OWNER_EMAIL / $OWNER_PASSWORD"
echo "    MCP:   enabled; token written to .env (N8N_MCP_TOKEN)"
echo "    No gateway workflows yet — 'make rebuild' authors and deploys them. Then:"
echo "      bash install.sh    # sandbox, network policy, agent skill"
echo
echo "⚠ The MCP token just changed. Any shell still holding the old value gets"
echo "  401 from n8n's management API until it re-reads .env. The sandbox skill"
echo "  never carries this token, so it is unaffected."
