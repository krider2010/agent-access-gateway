#!/usr/bin/env bash
# Start (or report) the gateway's policy + audit service on port 4301.
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
LOG="${GATEWAY_SERVICES_LOG:-/tmp/gateway-services.log}"

# WHICH ADDRESSES TO BIND. n8n reaches the host as host.docker.internal, and that is not the
# same address on every platform. Docker Desktop and OrbStack NAT it to the host's loopback;
# Docker Engine on Linux maps it to the docker bridge gateway, where a loopback-only service
# answers ECONNREFUSED. So on Linux, bind loopback plus that gateway. Not 0.0.0.0: this port
# carries the audit sink and the data plane, and the wildcard puts both on every interface.
#
# GATEWAY_SERVICES_HOST overrides, comma-separated, and is the escape hatch when the container
# is on a network other than the default bridge.
HOSTS="${GATEWAY_SERVICES_HOST:-}"
if [ -z "$HOSTS" ]; then
  HOSTS="127.0.0.1"
  if [ "$(uname -s)" = "Linux" ]; then
    BRIDGE="$(docker network inspect bridge \
      -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
    if [ -n "$BRIDGE" ]; then
      HOSTS="127.0.0.1,$BRIDGE"
    else
      echo "✗ Could not read the docker bridge gateway, which the n8n container needs to" >&2
      echo "  reach this service on Linux. Is docker running? Otherwise set the address" >&2
      echo "  explicitly, e.g.  GATEWAY_SERVICES_HOST=127.0.0.1,172.17.0.1 make services" >&2
      exit 1
    fi
  fi
fi

# Readiness is probed on the first address, which is loopback unless someone overrode it.
PROBE_HOST="${HOSTS%%,*}"

if nc -z "$PROBE_HOST" "$PORT" 2>/dev/null; then
  echo "▸ Gateway services already listening on ${PROBE_HOST}:${PORT}"
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
nohup "$NODE" "$REPO_ROOT/gateway/gateway_services.js" --host "$HOSTS" --port "$PORT" \
  </dev/null >"$LOG" 2>&1 &
disown

for _ in $(seq 1 20); do
  nc -z "$PROBE_HOST" "$PORT" 2>/dev/null && break
  sleep 1
done

if nc -z "$PROBE_HOST" "$PORT" 2>/dev/null; then
  echo "✓ Gateway services up: ${HOSTS} on port ${PORT}  (log: $LOG)"
  echo "    Reachable from the n8n container as host.docker.internal:${PORT}."
  echo "    Not on the sandbox allowlist, by design — the agent must not reach it."
else
  echo "✗ Gateway services did not come up within 20s — see $LOG" >&2
  exit 1
fi
