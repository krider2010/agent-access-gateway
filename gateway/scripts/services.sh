#!/usr/bin/env bash
# Start (or report) the gateway's policy + audit service on 127.0.0.1:4301.
#
# WHY A SCRIPT AND NOT A MAKE RECIPE. A daemon started inside a Make recipe inherits the
# recipe's stdout, so `make` waits for that stream to close and never returns; the same failure
# `install.sh` had with the port-forward. Backgrounding alone is not enough: stdin, stdout and
# stderr all have to be detached. Doing it here also keeps the Makefile a thin wrapper.
#
# Idempotent: if something is already listening on the port, this reports it and exits 0
# rather than starting a second copy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${GATEWAY_SERVICES_PORT:-4301}"
HOST="${GATEWAY_SERVICES_HOST:-127.0.0.1}"
LOG="${GATEWAY_SERVICES_LOG:-/tmp/gateway-services.log}"

if nc -z "$HOST" "$PORT" 2>/dev/null; then
  echo "▸ Gateway services already listening on ${HOST}:${PORT}"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "✗ No node found. The service needs Node 22.2 or later — it uses zlib.crc32." >&2
  exit 1
fi

# js-yaml is the service's one dependency, checked here rather than left to fail at require()
# time: a missing module surfaces as a stack trace in a log file nobody is reading, and
# `make services` would report a service that came up and then died.
if [ ! -d "$REPO_ROOT/node_modules/js-yaml" ]; then
  echo "✗ js-yaml is not installed. Run:" >&2
  echo "" >&2
  echo "      npm install" >&2
  echo "" >&2
  echo "  from $REPO_ROOT, then try again. It is the only dependency the repo has, and it" >&2
  echo "  is needed because Node ships no YAML parser and this service serves" >&2
  echo "  policy/access_policy.yaml and gateway/prompts.yaml to n8n as JSON." >&2
  exit 1
fi

# Fully detached: stdin from /dev/null so nothing waits on the terminal, stdout and stderr to
# the log so the caller's streams are not held open.
nohup "$NODE" "$REPO_ROOT/gateway/gateway_services.js" --host "$HOST" --port "$PORT" \
  </dev/null >"$LOG" 2>&1 &
disown

for _ in $(seq 1 20); do
  nc -z "$HOST" "$PORT" 2>/dev/null && break
  sleep 1
done

if nc -z "$HOST" "$PORT" 2>/dev/null; then
  echo "✓ Gateway services up: http://${HOST}:${PORT}  (log: $LOG)"
  echo "    Reachable from the n8n container as host.docker.internal:${PORT}."
  echo "    Not on the sandbox allowlist, by design — the agent must not reach it."
else
  echo "✗ Gateway services did not come up within 20s — see $LOG" >&2
  exit 1
fi
