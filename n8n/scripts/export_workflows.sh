#!/usr/bin/env bash
# Save the current n8n state out of the running container into n8n/workflows/.
#
# DEFAULT (safe to commit): workflows plus a SANITISED credentials template
#   (names, types and ids only, NO secret material). Anyone can redeploy the
#   workflows and plug in their own API keys.
#
# --with-secrets : ALSO write the encrypted credentials export and the instance
#   encryption key into ./private/ (gitignored), for a private backup. Never
#   commit those.
#
# Run from the HOST, not inside the container. Assumes the container is named
# "n8n-gtc" (override with N8N_CONTAINER) and n8n/scripts/up.sh already ran.
set -euo pipefail

CONTAINER="${N8N_CONTAINER:-n8n-gtc}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$(cd "$SCRIPT_DIR/../workflows" && pwd)"
WITH_SECRETS=0
[ "${1:-}" = "--with-secrets" ] && WITH_SECRETS=1

echo "▸ Exporting all workflows (incl. sub-workflows)..."
docker exec "$CONTAINER" n8n export:workflow --all \
  --output=/home/node/.n8n/workflows-export.json
docker cp "$CONTAINER":/home/node/.n8n/workflows-export.json "$OUT_DIR/workflows-export.json"

echo "▸ Exporting credentials + stripping secrets (template)..."
docker exec "$CONTAINER" n8n export:credentials --all \
  --output=/home/node/.n8n/credentials-export.json
docker cp "$CONTAINER":/home/node/.n8n/credentials-export.json "$OUT_DIR/.creds-raw.json"

# Build the sanitised template: keep id/name/type, blank the encrypted "data".
python3 - "$OUT_DIR/.creds-raw.json" "$OUT_DIR/credentials-export.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
creds = json.load(open(src))
for c in creds:
    c["data"] = ""   # remove encrypted secret material
json.dump(creds, open(dst, "w"), indent=2)
print(f"  template: {len(creds)} credential(s), data blanked")
PY

if [ "$WITH_SECRETS" -eq 1 ]; then
  echo "▸ --with-secrets: writing REAL encrypted backup into ./private/ (gitignored)..."
  mkdir -p "$OUT_DIR/private"
  cp "$OUT_DIR/.creds-raw.json" "$OUT_DIR/private/credentials-export.SECRET.json"
  docker exec "$CONTAINER" cat /home/node/.n8n/config \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['encryptionKey'])" \
    > "$OUT_DIR/private/encryption-key.SECRET.txt"
  chmod 600 "$OUT_DIR/private/"*.SECRET.* 2>/dev/null || true
  echo "  ⚠ ./private/ contains real keys + encryption key — NEVER commit it."
fi

rm -f "$OUT_DIR/.creds-raw.json"

echo "✓ Saved (safe to commit):"
echo "    n8n/workflows/workflows-export.json"
echo "    n8n/workflows/credentials-export.json   (sanitized template — no secrets)"
[ "$WITH_SECRETS" -eq 1 ] && echo "  Private (gitignored): n8n/workflows/private/*.SECRET.*"
