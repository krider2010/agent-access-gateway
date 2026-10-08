#!/usr/bin/env bash
# Create (or update) the `nvidiaApi` credential inside the running n8n container.
#
# WHY THE CLI AND NOT AN API: n8n's MCP surface has no credential-create tool, only the
# read-only `list_credentials`. And the public REST API's `POST /api/v1/credentials` cannot
# be reached with the MCP token this repo holds: that token is a JWT with
# `aud: mcp-server-api`, and the public API accepts only keys minted for `public-api`.
# Rather than ask every reader to click through Settings and mint a second key, this imports
# through the container's own CLI, which needs no extra secret and works from a clean clone.
#
# `n8n import:credentials` encrypts any credential whose `data` is a plain object using
# the instance's own encryption key, so the JSON below is written in the clear and is
# encrypted at rest on arrival.
#
# SECRET HYGIENE: the key is passed to python3 through the environment and piped straight
# into the container. It is never written to a file on the host, never appears in a
# command line (where `ps` would show it), and the container-side copy is removed by the
# EXIT trap even if the import fails.
#
# Idempotent: the credential carries a fixed id, and the importer upserts on id, so
# re-running updates the existing record rather than creating a duplicate.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

fail() { echo "✗ $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || fail "No .env at $ENV_FILE — run 'make n8n-setup' first."
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

N8N_CONTAINER="${N8N_CONTAINER:-n8n-gtc}"

# Fixed id so the import upserts and so workflow code can reference the credential by a
# known handle instead of discovering it at build time.
CRED_ID="${NVIDIA_CRED_ID:-KerblineNvidia01}"
CRED_NAME="${NVIDIA_CRED_NAME:-Hypernova (local)}"

[ -n "${INFERENCE_API_KEY:-}"  ] || fail "INFERENCE_API_KEY not set in .env"
[ -n "${INFERENCE_BASE_URL:-}" ] || fail "INFERENCE_BASE_URL not set in .env"

docker container inspect "$N8N_CONTAINER" >/dev/null 2>&1 \
  || fail "Container '$N8N_CONTAINER' does not exist — run 'make n8n-up' first."
[ "$(docker container inspect -f '{{.State.Running}}' "$N8N_CONTAINER")" = "true" ] \
  || fail "Container '$N8N_CONTAINER' is not running — run 'make n8n-up' first."

CONTAINER_TMP="/tmp/nvidia-credential.$$.json"
cleanup() { docker exec "$N8N_CONTAINER" rm -f "$CONTAINER_TMP" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▸ Writing credential payload into $N8N_CONTAINER ..."
# The credential is read inside the n8n container. 127.0.0.1 there is the container
# itself, not the host where vLLM is published. host.docker.internal is the name
# up.sh maps to the host. The eval harness and OpenShell run on the host, so .env
# keeps the loopback URL and only this import rewrites it.
CRED_URL="$(INFERENCE_BASE_URL="$INFERENCE_BASE_URL" python3 -c '
import os
from urllib.parse import urlparse, urlunparse
url = os.environ["INFERENCE_BASE_URL"]
parts = urlparse(url)
if parts.hostname in ("127.0.0.1", "localhost"):
    host = "host.docker.internal"
    netloc = f"{host}:{parts.port}" if parts.port else host
    url = urlunparse(parts._replace(netloc=netloc))
print(url)
')"
echo "    Credential base URL: $CRED_URL"

CRED_ID="$CRED_ID" CRED_NAME="$CRED_NAME" CRED_URL="$CRED_URL" python3 -c '
import json, os
print(json.dumps([{
    "id":   os.environ["CRED_ID"],
    "name": os.environ["CRED_NAME"],
    "type": "nvidiaApi",
    "data": {
        "url":    os.environ["CRED_URL"],
        "apiKey": os.environ["INFERENCE_API_KEY"],
    },
}]))
' | docker exec -i "$N8N_CONTAINER" sh -c "umask 077 && cat > $CONTAINER_TMP"

echo "▸ Importing ..."
# The importer logs to stderr as well as stdout; keep both so a failure is visible.
docker exec "$N8N_CONTAINER" n8n import:credentials --input="$CONTAINER_TMP" 2>&1 \
  | sed 's/^/      /'

echo
echo "✓ Credential '$CRED_NAME' (id: $CRED_ID, type: nvidiaApi) imported."
echo "    Base URL comes from INFERENCE_BASE_URL in .env."
echo "    A loopback address is rewritten to host.docker.internal for the container."
