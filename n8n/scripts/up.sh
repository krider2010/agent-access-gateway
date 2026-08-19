#!/usr/bin/env bash
# Bring up the self-hosted n8n container.
#
# Assumes Docker is running and reachable from this shell. Creates a persistent
# named volume so workflows, credentials and the owner account survive container
# restarts; `n8n/scripts/setup.sh` runs against this container next.
#
# Container and volume are named `n8n-gtc` / `n8n_gtc_data` rather than the
# generic `n8n` / `n8n_data`: plenty of people, and other demos on the same
# host, already run a container called `n8n`, and this must not collide with one
# or inherit its state. Override with N8N_CONTAINER / N8N_VOLUME.
#
# Idempotent: re-running starts the existing container instead of failing on a
# duplicate --name.
set -euo pipefail

N8N_CONTAINER="${N8N_CONTAINER:-n8n-gtc}"
N8N_VOLUME="${N8N_VOLUME:-n8n_gtc_data}"
N8N_PORT="${N8N_PORT:-5678}"

# Pin an explicit version rather than using the untagged "n8nio/n8n" image.
# An untagged pull resolves to whatever ":latest" is already cached locally,
# which on a long-lived machine can be well behind current stable. These
# scripts use the publish/draft workflow model introduced in n8n 2.22, so the
# pin also documents the minimum this repo expects. Bump as new stables ship:
# https://hub.docker.com/r/n8nio/n8n/tags
N8N_VERSION="${N8N_VERSION:-2.32.7}"
N8N_IMAGE="docker.n8n.io/n8nio/n8n:${N8N_VERSION}"

# Already have this container? Make sure it is running and stop here;
# recreating it would be a no-op at best and confusing at worst.
if docker container inspect "$N8N_CONTAINER" >/dev/null 2>&1; then
  echo "▸ Container '$N8N_CONTAINER' already exists — starting it if stopped."
  docker start "$N8N_CONTAINER" >/dev/null
  echo "n8n running — http://localhost:${N8N_PORT}"
  echo "Next: bash n8n/scripts/setup.sh"
  exit 0
fi

# Create persistent volume (no-op if it already exists)
docker volume create "$N8N_VOLUME"

# Pull the pinned image (no-op if already present at this exact tag)
docker pull "$N8N_IMAGE"

# Start n8n.
#
# Fresh instance: n8n generates its own encryption key on first start, so no
# action is needed. Pass N8N_ENCRYPTION_KEY only when restoring a
# previously-exported *encrypted* credentials backup onto a new instance, to
# match the key that encrypted it.
#
# NOTE: N8N_BASIC_AUTH_* was removed in n8n 1.x+ and is ignored on 2.x. The UI
# login is the owner account created on first run; see n8n/scripts/setup.sh.
#
# --add-host: the gateway workflows fetch the policy, the prompts and the data plane from
# host.docker.internal:4301. Docker Desktop and OrbStack resolve that name themselves; Docker
# Engine on Linux does not resolve it at all. host-gateway reaches the host on all three, so
# the mapping is unconditional rather than per-platform. It applies to a container being
# created, so an instance that predates this line needs `make rebuild CONFIRM=yes`.
docker run -d --name "$N8N_CONTAINER" \
  -p "${N8N_PORT}:5678" \
  --add-host=host.docker.internal:host-gateway \
  -v "$N8N_VOLUME":/home/node/.n8n \
  `# -e N8N_ENCRYPTION_KEY="$(cat /path/to/your/encryption-key)"  # only for restoring an encrypted export` \
  "$N8N_IMAGE"

echo "n8n starting — http://localhost:${N8N_PORT} (may take a few seconds to become reachable)"
echo "Next: bash n8n/scripts/setup.sh"
