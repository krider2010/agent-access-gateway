#!/usr/bin/env bash
# Turn n8n's instance-wide MCP *management* access on or off.
#
#   bash n8n/scripts/mcp_access.sh off
#   bash n8n/scripts/mcp_access.sh on
#   bash n8n/scripts/mcp_access.sh status
#
# WHY THIS EXISTS. n8n serves two different things on the same port:
#
#   /mcp/kerbline-access-gateway   the gateway's front door. An MCP Server Trigger, and
#                                  the only thing the agent is supposed to reach.
#   /mcp-server/http               n8n's own management API. It can list, edit, create and
#                                  execute workflows.
#
# Both live on port 5678, so a network grant of that bare port hands over both. That was the
# situation until 2026-08-13, when the management endpoint answered `401 Unauthorized` rather
# than a policy denial: a bearer token, not the network, stood in the way.
# `policy/sandbox_policy.yaml` now scopes its grant to the front-door path with
# `protocol: rest` and `enforcement: enforce`, so from inside the sandbox the management
# endpoint answers `403 denied by L7 policy` and never reaches n8n.
#
# Four independent things now keep that surface away from the agent, independent rather than
# one control described four ways: the network policy refuses the path; the token lives only
# in the repo-root .env and appears nowhere in the sandbox; `isolate.sh` hides every workflow
# but the front door from MCP, so even a token-holder cannot execute the decision workflow;
# and this script turns the endpoint off entirely.
#
# This script is the one that reaches beyond the sandbox. The other three are scoped to the
# agent; disabling the endpoint closes it to everything on the host.
#
# TURNING IT OFF IS FREE, BECAUSE THE MANAGEMENT SURFACE IS A BUILD-TIME NEED. The build
# scripts use it to author and deploy workflows; nothing at demo time touches it. Verified
# both ways on 2026-08-13: with `mcpAccessEnabled: false` the front door still lists all nine
# tools, and the management endpoint answers 403 *even with a valid token*.
#
# So the running demo has one live endpoint on that port, which is what the architecture
# claims, rather than one live endpoint and one guarded by a secret.
#
# Re-enable before rebuilding: `make n8n-mcp-on`. A build against a disabled instance fails
# with 403, which reads as an auth problem and is not one.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

N8N_URL="${N8N_URL:-http://localhost:${N8N_PORT:-5678}}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
OWNER_PASSWORD="${OWNER_PASSWORD:-}"

ACTION="${1:-}"
case "$ACTION" in
  on|off|status) ;;
  *) echo "usage: $(basename "$0") on|off|status" >&2; exit 2 ;;
esac

if [ -z "$OWNER_EMAIL" ] || [ -z "$OWNER_PASSWORD" ]; then
  echo "✗ OWNER_EMAIL / OWNER_PASSWORD not set in .env." >&2
  echo "  This toggle is a session-authenticated REST call, so it needs the owner login" >&2
  echo "  rather than the MCP token. See .env.template." >&2
  exit 1
fi

COOKIE=$(mktemp)
trap 'rm -f "$COOKIE"' EXIT

curl -sf -c "$COOKIE" -o /dev/null -X POST "$N8N_URL/rest/login" \
  -H 'Content-Type: application/json' \
  -d "{\"emailOrLdapLoginId\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" \
  || { echo "✗ Could not log in to n8n at $N8N_URL as $OWNER_EMAIL" >&2; exit 1; }

# Probing rather than reading a setting, because n8n exposes no GET for this. A POST with a
# valid token asks the question the agent would ask.
probe() {
  if [ -z "${N8N_MCP_TOKEN:-}" ]; then
    echo "unknown (no N8N_MCP_TOKEN in .env to probe with)"
    return
  fi
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$N8N_URL/mcp-server/http" \
    -H "Authorization: Bearer $N8N_MCP_TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  case "$code" in
    200) echo "ENABLED (management API answers 200 with the token)" ;;
    403) echo "disabled (management API answers 403 even with a valid token)" ;;
    401) echo "disabled or token stale (401)" ;;
    *)   echo "unclear (HTTP $code)" ;;
  esac
}

if [ "$ACTION" = "status" ]; then
  echo "▸ management API: $(probe)"
  printf '▸ front door    : '
  if python3 n8n/scripts/gateway_client.py tools >/dev/null 2>&1; then
    echo "reachable"
  else
    echo "NOT reachable"
  fi
  exit 0
fi

WANT=false
[ "$ACTION" = "on" ] && WANT=true

curl -sf -b "$COOKIE" -o /dev/null -X PATCH "$N8N_URL/rest/mcp/settings" \
  -H 'Content-Type: application/json' \
  -d "{\"mcpAccessEnabled\":$WANT}" \
  || { echo "✗ PATCH /rest/mcp/settings failed" >&2; exit 1; }

echo "▸ mcpAccessEnabled=$WANT"
echo "▸ management API: $(probe)"

if [ "$ACTION" = "off" ]; then
  echo "  The gateway front door is unaffected; the build scripts are not."
  echo "  Re-enable with 'make n8n-mcp-on' before authoring or deploying workflows."
fi
