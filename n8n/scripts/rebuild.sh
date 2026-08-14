#!/usr/bin/env bash
# Rebuild the whole n8n side of the gateway from an empty volume.
#
# DESTRUCTIVE. Removes the n8n container and its data volume, so every workflow,
# credential and the owner account go with it. Everything it destroys is
# reproducible from this repo plus .env: running this is how we know the setup
# instructions are still true.
#
# Requires an explicit confirmation. Pass --yes, or set CONFIRM=yes.
#
#   bash n8n/scripts/rebuild.sh --yes
#
# WHY REBUILD RATHER THAN PRUNE. Superseded workflows accumulate, and
# `archive_workflow` silently fails on a published one, so tidying up means
# unpublishing each first. Dropping the volume is shorter, and it means the
# instance a demo runs against is one this script produced.
#
# ORDER IS LOAD-BEARING. `isolate.sh` runs last, because `n8n import:workflow`
# clears the published state and un-archives, so isolating before publishing
# leaves the front door returning 404. Nothing here may be reordered without
# reading isolate.sh's header first.
#
# AFTER THIS RUNS, THE MCP TOKEN HAS ROTATED. setup.sh mints a new one, so any
# shell still holding the old value gets 401 from n8n's management API until it
# re-reads .env. The in-sandbox skill never carries this token, so it is
# unaffected, but it does need re-pointing at the rebuilt front door, which is
# what `install.sh` does. This script says so at the end rather than doing it,
# because install.sh needs a sandbox and this does not.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# .env carries the owner identity and the inference key. Loaded with shell
# semantics, the same way install.sh does it.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

CONTAINER="${N8N_CONTAINER:-n8n-gtc}"
VOLUME="${N8N_VOLUME:-n8n_gtc_data}"

CONFIRM="${CONFIRM:-}"
[ "${1:-}" = "--yes" ] && CONFIRM=yes

if [ "$CONFIRM" != "yes" ]; then
  cat >&2 <<EOF
This will DESTROY and rebuild:

  container   $CONTAINER
  volume      $VOLUME   (all workflows, credentials, owner account)

It will then recreate the owner account, mint a new MCP token into .env,
import the nvidiaApi credential, build both gateway workflows, and enforce
the isolation invariant.

Nothing outside Docker and .env is touched. The sandbox is not touched.

Re-run with --yes (or CONFIRM=yes) to proceed.
EOF
  exit 1
fi

step() { echo; echo "═══ $* ═══"; }

step "1/7  Removing container and volume"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# The volume cannot be removed while any container still references it, and a
# stale exited container is easy to miss, so report rather than swallow this.
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  docker volume rm "$VOLUME" >/dev/null
  echo "  removed volume $VOLUME"
else
  echo "  volume $VOLUME was not present"
fi

step "2/7  Starting a fresh container"
bash n8n/scripts/up.sh

step "3/7  Owner account, instance MCP, MCP token"
# OWNER_* come from .env so the owner on screen is reproducible. Without them
# setup.sh falls back to admin@example.com, which is the placeholder identity a
# recording must not show.
bash n8n/scripts/setup.sh

step "4/7  nvidiaApi credential"
bash n8n/scripts/create_credential.sh

step "5/7  Decision workflow"
node n8n/workflows/build.js decide --create

# Second, because its nine tools point at the id the step above just created.
step "6/7  Front door workflow"
node n8n/workflows/build.js front-door --create

step "7/7  Isolation invariant (must be last)"
bash n8n/workflows/isolate.sh

cat <<EOF

═══ Rebuilt ═══

The MCP token in .env is new. Anything still holding the old one returns 401.
Re-point the sandbox at the rebuilt front door:

  bash install.sh          # sandbox, network policy, skill, port-forward

The gateway services on :4301 are a separate process and are unaffected, but
they must be running before any decision can be made:

  make services

Then drive the front door as the agent would:

  python3 n8n/scripts/gateway_client.py tools
EOF
