#!/usr/bin/env bash
# =============================================================================
# n8n + NemoClaw/OpenShell Sandbox + Access Gateway: Installer
#
# Stands up the host and sandbox sides: a NemoClaw sandbox, the network policy,
# and the access-gateway skill. Not the gateway workflows; `make rebuild` does those.
#
# Steps:
#   1.  Sync sandbox Dockerfile  -> ~/.nemoclaw/source (OpenClaw compatibility)
#   2.  Prerequisites            (python3, openshell, curl)
#   3.  Validate .env            (needed by onboarding and the front-door URLs)
#   4.  Detect / onboard sandbox
#   5.  Inference provider + model (OpenShell gateway)
#   6.  Patch openclaw.json model inside the sandbox
#   7.  OpenClaw gateway token + chat-UI URL
#   8.  Apply sandbox network policy (opens ONLY the gateway front door)
#   9.  Upload the access-gateway skill + HEARTBEAT.md
#   10. Write config.json into the skill root
#   11. Verification
#
# ONE ROUTE OUT OF THE SANDBOX. The agent's only permitted destination is the
# gateway's MCP front door, on n8n's own port (5678). Step 8's policy opens nothing
# else, not even the gateway's own policy and audit service on 4301. Step 11
# asserts that rather than assuming it.
#
# THERE IS NO INTERPRETER TO BOOTSTRAP. Until 2026-08-13 a step between 10 and 11
# built a Python virtualenv for the skill client. The client is now Node, which
# ships in the sandbox image.
#
# Nothing here installs packages, host or sandbox. Host helpers are stdlib-only or
# need PyYAML alone; the skill client is stdlib Node. No package index required.
#
# Idempotent: each step checks whether it is already done. Assumes the sandbox is
# onboarded, or that Step 4 may run `nemoclaw onboard` non-interactively.
#
# Usage:
#   bash install.sh [sandbox-name]
#
#   sandbox-name  Target sandbox (auto-detected when only one exists).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
# The front door is an n8n MCP Server Trigger, so it uses n8n's own port and path.
# The port comes off .env in Step 3.
GATEWAY_MCP_PATH="${GATEWAY_MCP_PATH:-/mcp/kerbline-access-gateway}"
# The gateway's policy and audit service. Named only so Step 11 can assert the
# sandbox cannot reach it; this script never starts it (`make services` does).
GATEWAY_SERVICES_PORT="${GATEWAY_SERVICES_PORT:-4301}"
SKILL_NAME="access-gateway"
SKILL_SRC="$SCRIPT_DIR/skill"
SANDBOX_SKILL_ROOT="/sandbox/.openclaw/workspace/skills/$SKILL_NAME"
SANDBOX_DIR="$SCRIPT_DIR/sandbox"
# Staging dir for helper-script uploads inside the sandbox. Overridable: the
# original scaffold hardcoded one /tmp path for every install on the box, so two
# skills staging at once would collide.
INSTALL_STAGE_DIR="${INSTALL_STAGE_DIR:-/tmp/${SKILL_NAME}-install-stage}"
# How the skill client is invoked inside the sandbox. The image sets
# NODE_USE_ENV_PROXY=1, so Node warns "EnvHttpProxyAgent is experimental" on every
# start. The client proxies itself (see skill/scripts/client.js), so the warning
# names a feature it does not use; `--no-warnings` keeps it out of every answer
# and log line.
SANDBOX_NODE="node --no-warnings"
SANDBOX_CLIENT="$SANDBOX_SKILL_ROOT/scripts/client.js"

SANDBOX_ARG="${1:-}"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()  { echo -e "${CYAN}  ▸ $*${NC}"; }
ok()    { echo -e "${GREEN}  ✓ $*${NC}"; }
warn()  { echo -e "${YELLOW}  ⚠ $*${NC}"; }
fail()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }
step()  { echo ""; echo -e "${CYAN}━━━ $* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# ── openshell call wrapper ────────────────────────────────────────────────────
# `openshell sandbox exec/upload` tunnel over ssh. Two consequences here:
#
#  1. STDIN. ssh reads stdin. A detached script, CI job, or backgrounded install
#     hands it a pipe that never reaches EOF, so the call waits on input that
#     never arrives. Closing stdin per call avoids it. Interactive runs are
#     unaffected, so it only bites once the install is automated.
#  2. TIMEOUTS. Nothing in the chain applies one, so a stalled call blocks the
#     install without saying which step is waiting.
#
# `osh` handles both. macOS ships no coreutils `timeout`, hence perl.
# Override per call:  OSH_TIMEOUT=600 osh sandbox upload ...
OSH_TIMEOUT="${OSH_TIMEOUT:-180}"

osh() {
  perl -e '
    my $t = shift @ARGV;
    my $pid = fork();
    if (!defined $pid) { die "fork failed\n" }
    if ($pid == 0) {
      open(STDIN, "<", "/dev/null");
      exec @ARGV;
      exit 127;
    }
    local $SIG{ALRM} = sub {
      kill "TERM", $pid;
      select(undef, undef, undef, 2);
      kill "KILL", $pid;
      exit 124;
    };
    alarm $t;
    waitpid($pid, 0);
    my $rc = $?;
    alarm 0;
    exit($rc >> 8);
  ' "$OSH_TIMEOUT" openshell "$@"
}


echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║  n8n + Sandbox + Access Gateway — Installer               ║${NC}"
echo -e "${CYAN}  ║  Sandbox policy  +  OpenShell skill                      ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Sandbox      : ${GREEN}${SANDBOX_ARG:-auto-detect}${NC}"
echo ""

# =============================================================================
# STEP 1: Sync sandbox Dockerfile into NemoClaw source
# =============================================================================
step "Step 1 — Sync NemoClaw Dockerfile"

DEMO_DOCKERFILE="$SANDBOX_DIR/Dockerfile"
NEMOCLAW_SOURCE_DIR="${NEMOCLAW_SOURCE:-$HOME/.nemoclaw/source}"
NEMOCLAW_DOCKERFILE="$NEMOCLAW_SOURCE_DIR/Dockerfile"

[ -f "$DEMO_DOCKERFILE" ] || fail "Sandbox Dockerfile not found at $DEMO_DOCKERFILE"
[ -d "$NEMOCLAW_SOURCE_DIR" ] || fail "NemoClaw source not found at $NEMOCLAW_SOURCE_DIR — install NemoClaw first."

if [ -f "$NEMOCLAW_DOCKERFILE" ] && cmp -s "$DEMO_DOCKERFILE" "$NEMOCLAW_DOCKERFILE"; then
  ok "Dockerfile already up to date ($NEMOCLAW_DOCKERFILE)"
else
  cp "$DEMO_DOCKERFILE" "$NEMOCLAW_DOCKERFILE"
  ok "Copied $DEMO_DOCKERFILE → $NEMOCLAW_DOCKERFILE"
fi

# =============================================================================
# STEP 2: Prerequisites
# =============================================================================
step "Step 2 — Prerequisites"

# `curl` is required because `nemoclaw onboard` probes the inference endpoint with
# it in Step 4, and the failure advice below is curl-based.
command -v python3   >/dev/null 2>&1 || fail "python3 not found. Install Python 3.10+."
command -v openshell >/dev/null 2>&1 || fail "openshell CLI not found. Is NemoClaw installed?"
command -v curl      >/dev/null 2>&1 || fail "curl not found."

ok "Python    : $(python3 --version)"
ok "openshell : $(openshell --version 2>/dev/null | head -1 || echo found)"

# =============================================================================
# STEP 3: Validate .env
# =============================================================================
step "Step 3 — Validate .env"

[ -f "$ENV_FILE" ] || fail ".env not found at $ENV_FILE. Copy .env.template to .env and fill it in."

# Load .env into the current shell without clobbering already-set vars.
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  key="${line%%=*}"
  val="${line#*=}"
  # strip surrounding single/double quotes
  val="${val#\"}" ; val="${val%\"}" ; val="${val#\'}" ; val="${val%\'}"
  [ -z "${!key+x}" ] && export "$key"="$val"
done < "$ENV_FILE"

# This script does not call n8n's management API; n8n/workflows/build.js does.
# Checked anyway: Step 11 asks the gateway for a decision, and a gateway exists
# only if n8n/scripts/setup.sh has run here. A missing token says it has not.
[ -n "${N8N_INSTANCE_URL:-}" ]   || fail "N8N_INSTANCE_URL not set in .env"
[ -n "${N8N_MCP_TOKEN:-}" ]      || fail "N8N_MCP_TOKEN not set in .env (run n8n/scripts/setup.sh first)"
[ -n "${INFERENCE_API_KEY:-}" ]  || fail "INFERENCE_API_KEY not set in .env (used by nemoclaw onboard + openshell provider)"
[ -n "${INFERENCE_BASE_URL:-}" ] || fail "INFERENCE_BASE_URL not set in .env (e.g. https://inference-api.nvidia.com/v1)"
[ -n "${INFERENCE_MODEL:-}" ]    || fail "INFERENCE_MODEL not set in .env"

INFERENCE_PROVIDER_TYPE="${INFERENCE_PROVIDER_TYPE:-nvidia}"
INFERENCE_PROVIDER_NAME="${INFERENCE_PROVIDER_NAME:-nvidia}"

# Now that .env is loaded, the front-door URLs can be derived from N8N_PORT.
GATEWAY_PORT="${N8N_PORT:-5678}"
GATEWAY_URL_SANDBOX="http://host.openshell.internal:${GATEWAY_PORT}${GATEWAY_MCP_PATH}"
GATEWAY_URL_HOST="http://127.0.0.1:${GATEWAY_PORT}${GATEWAY_MCP_PATH}"

ok "N8N_INSTANCE_URL    : $N8N_INSTANCE_URL"
ok "N8N_MCP_TOKEN       : ***${N8N_MCP_TOKEN: -8}"
ok "INFERENCE_API_KEY   : ***${INFERENCE_API_KEY: -8}"
ok "INFERENCE_BASE_URL  : $INFERENCE_BASE_URL"
ok "INFERENCE_MODEL     : $INFERENCE_MODEL"
ok "Provider            : $INFERENCE_PROVIDER_NAME ($INFERENCE_PROVIDER_TYPE)"

cd "$SCRIPT_DIR"

# =============================================================================
# STEP 4: Detect / onboard sandbox
# =============================================================================
step "Step 4 — Detect sandbox"

_live_sandboxes() {
  osh sandbox list 2>/dev/null \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -v "^No sandboxes" | grep -v "^NAME" \
    | awk '{print $1}' | grep -v '^$' || true
}

LIVE_NAMES=$(_live_sandboxes)
LIVE_COUNT=$(echo "$LIVE_NAMES" | grep -c . || true)

# No sandbox? Drive 'nemoclaw onboard' without prompts, from INFERENCE_* in .env.
#
# onboard probes the chosen model on a ~15s curl budget. Reasoning models exceed it
# and fail validation even with a good key and endpoint (see .env.template's
# NEMOCLAW_ONBOARD_MODEL). So probe with a fast catalog model; Step 5 applies
# INFERENCE_MODEL with --no-verify.
#
# integrate.api.nvidia.com uses the built-in "build" (NVIDIA Endpoints) provider:
# same URL, and it skips the Responses API probe. Other OpenAI-compatible URLs use
# "custom", which probes chat-completions only.
if [ "${LIVE_COUNT:-0}" -eq 0 ] && [ -z "$SANDBOX_ARG" ]; then
  info "No sandbox found — running 'nemoclaw onboard' (non-interactive)..."
  command -v nemoclaw >/dev/null 2>&1 || fail "nemoclaw CLI not found. Install NemoClaw and retry."

  [ -n "${NEMOCLAW_ONBOARD_MODEL:-}" ] || fail "NEMOCLAW_ONBOARD_MODEL not set in .env — pick a fast, non-reasoning model (see .env.template)."
  ONBOARD_MODEL="$NEMOCLAW_ONBOARD_MODEL"

  # Name the sandbox and pin the agent runtime. Left unset, `nemoclaw onboard`
  # picks its own: an unpredictable name in every command and doc, and no
  # guarantee of the runtime this demo is built around. `lena-agent` is the demo
  # persona's agent (docs/SCENARIO.md), so `openshell sandbox list` reads as the
  # scenario describes it.
  NEMOCLAW_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-lena-agent}"
  NEMOCLAW_AGENT="${NEMOCLAW_AGENT:-openclaw}"

  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
  export NVIDIA_API_KEY="${NVIDIA_API_KEY:-$INFERENCE_API_KEY}"

  case "${INFERENCE_BASE_URL}" in
    *integrate.api.nvidia.com*)
      export NEMOCLAW_PROVIDER=build
      export NEMOCLAW_MODEL="$ONBOARD_MODEL"
      ;;
    *)
      export NEMOCLAW_PROVIDER=custom
      export NEMOCLAW_ENDPOINT_URL="${INFERENCE_BASE_URL}"
      export NEMOCLAW_MODEL="$ONBOARD_MODEL"
      export COMPATIBLE_API_KEY="${INFERENCE_API_KEY}"
      export NEMOCLAW_PREFERRED_API=openai-completions
      ;;
  esac

  if [ "$ONBOARD_MODEL" != "$INFERENCE_MODEL" ]; then
    info "Onboard validation model: $ONBOARD_MODEL; runtime model in Step 5: $INFERENCE_MODEL"
  fi

  info "Sandbox name: $NEMOCLAW_SANDBOX_NAME   agent runtime: $NEMOCLAW_AGENT"

  # --fresh avoids resuming a stale session that still has the wrong provider/model.
  if ! nemoclaw onboard --fresh --non-interactive --yes-i-accept-third-party-software \
        --name "$NEMOCLAW_SANDBOX_NAME" --agent "$NEMOCLAW_AGENT"; then
    # Do NOT assert a cause here; onboard's own preflight output above names the
    # failure. Known causes, most frequent first:
    #
    #  * Port 8080 in use, usually by an OpenShell gateway ALREADY RUNNING.
    #    `nemoclaw onboard` starts its own at step 2/8, so do not run
    #    `openshell gateway start` beforehand. Stop the existing one and re-run,
    #    or set NEMOCLAW_GATEWAY_PORT to move it.
    #  * A host Kubernetes is running (OrbStack built-in, Docker Desktop,
    #    minikube). It collides with the gateway's embedded k8s and hangs at
    #    step 2/8. See `make k8s-off`.
    #  * The onboard inference probe timed out. Every current Nemotron emits a
    #    reasoning trace by default, against a ~15s budget with no max_tokens cap.
    #    Set NEMOCLAW_ONBOARD_MODEL to a model measured under that budget (see
    #    docs/MODEL_STRATEGY.md).
    #  * Credentials/endpoint wrong. Verify with:
    #      curl -H "Authorization: Bearer $INFERENCE_API_KEY" "$INFERENCE_BASE_URL/models"
    fail "nemoclaw onboard failed — see its preflight output above for the actual cause (this script does not guess). Common causes and fixes are listed in the comment beside this message in install.sh."
  fi
  ok "Onboarding complete"

  info "Waiting for sandbox to appear..."
  for _ in $(seq 1 20); do
    LIVE_NAMES=$(_live_sandboxes)
    LIVE_COUNT=$(echo "$LIVE_NAMES" | grep -c . || true)
    [ "${LIVE_COUNT:-0}" -gt 0 ] && break
    sleep 2
  done
  [ "${LIVE_COUNT:-0}" -eq 0 ] && fail "No sandbox appeared after onboarding."
  ok "Sandbox onboarded"
fi

if [ -n "$SANDBOX_ARG" ]; then
  SANDBOX_NAME="$SANDBOX_ARG"
elif [ "${LIVE_COUNT:-0}" -eq 0 ]; then
  fail "No sandbox found. Run 'nemoclaw onboard' first, then re-run this script."
elif [ "${LIVE_COUNT:-0}" -eq 1 ]; then
  SANDBOX_NAME=$(echo "$LIVE_NAMES" | head -1)
else
  JSON_DEFAULT=$(python3 -c "
import json
try:
    d = json.load(open('$HOME/.nemoclaw/sandboxes.json'))
    print(d.get('defaultSandbox') or '')
except Exception:
    pass
" 2>/dev/null || true)
  if [ -n "${JSON_DEFAULT:-}" ] && echo "$LIVE_NAMES" | grep -qx "$JSON_DEFAULT"; then
    SANDBOX_NAME="$JSON_DEFAULT"
  else
    echo ""
    echo -e "  ${YELLOW}Multiple sandboxes found:${NC}"
    echo "$LIVE_NAMES" | while read -r n; do echo "    - $n"; done
    echo -n "  Which sandbox to use? "
    read -r SANDBOX_NAME
  fi
fi

[ -z "${SANDBOX_NAME:-}" ] && fail "Could not determine sandbox. Re-run: bash install.sh <sandbox-name>"
_live_sandboxes | grep -qx "$SANDBOX_NAME" || fail "Sandbox '$SANDBOX_NAME' not found."
ok "Target sandbox: $SANDBOX_NAME"

# =============================================================================
# STEP 5: Inference provider + model (OpenShell gateway)
# =============================================================================
step "Step 5 — Inference provider + model"

if osh provider get "$INFERENCE_PROVIDER_NAME" >/dev/null 2>&1; then
  osh provider update "$INFERENCE_PROVIDER_NAME" \
    --credential INFERENCE_API_KEY \
    --config "NVIDIA_BASE_URL=$INFERENCE_BASE_URL" \
    2>/dev/null \
    && ok "Provider '$INFERENCE_PROVIDER_NAME' updated" \
    || warn "Provider '$INFERENCE_PROVIDER_NAME' update failed — continuing"
else
  osh provider create \
    --type  "$INFERENCE_PROVIDER_TYPE" \
    --name  "$INFERENCE_PROVIDER_NAME" \
    --credential INFERENCE_API_KEY \
    --config "NVIDIA_BASE_URL=$INFERENCE_BASE_URL" \
    && ok "Provider '$INFERENCE_PROVIDER_NAME' created" \
    || fail "Could not create inference provider."
fi

osh inference set \
  --provider "$INFERENCE_PROVIDER_NAME" \
  --model    "$INFERENCE_MODEL" \
  --no-verify \
  && ok "Inference: $INFERENCE_PROVIDER_NAME / $INFERENCE_MODEL" \
  || fail "Could not set inference model."

# =============================================================================
# STEP 6: Patch openclaw.json inside sandbox with the chosen model
# =============================================================================
step "Step 6 — Patch openclaw model inside sandbox"

# openclaw.json is root-owned (444) inside the sandbox, so the sandbox user cannot
# write it. Reached by kubectl exec (root) through the cluster container.
_CLUSTER_CONTAINER=$(docker ps --format "{{.Names}}" 2>/dev/null \
  | grep "^openshell-cluster-" | head -1 || true)

if [ -z "${_CLUSTER_CONTAINER:-}" ]; then
  warn "OpenShell cluster container not found — skipping openclaw model patch."
  warn "Connect to the sandbox and run: openclaw onboard (choose $INFERENCE_MODEL)"
else
  docker exec "$_CLUSTER_CONTAINER" \
    kubectl exec -n openshell "$SANDBOX_NAME" -c agent -- \
    sh -c "
      python3 -c \"
import json
with open('/sandbox/.openclaw/openclaw.json') as f:
    d = json.load(f)
model = '$INFERENCE_MODEL'
d['models']['providers']['inference']['models'] = [{
    'id': model,
    'name': 'inference/' + model,
    'reasoning': False,
    'input': ['text'],
    'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
    'contextWindow': 131072,
    'maxTokens': 4096
}]
d['agents']['defaults']['model']['primary'] = 'inference/' + model
with open('/sandbox/.openclaw/openclaw.json', 'w') as f:
    json.dump(d, f, indent=2)
\"
    " \
    && ok "openclaw patched: inference/$INFERENCE_MODEL" \
    || fail "Failed to patch openclaw.json inside sandbox."
fi

# =============================================================================
# STEP 7: OpenClaw gateway token + chat-UI URL
# =============================================================================
step "Step 7 — OpenClaw gateway token + chat-UI URL"

# Upload helper scripts (idempotent: overwrites whatever was there)
osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "mkdir -p ${INSTALL_STAGE_DIR}" 2>/dev/null || true

OSH_TIMEOUT=600 osh sandbox upload "$SANDBOX_NAME" \
  "$SANDBOX_DIR/scripts/set_oc_token.js" \
  "${INSTALL_STAGE_DIR}/" \
  >/dev/null 2>&1 \
  && ok "uploaded set_oc_token.js" \
  || warn "set_oc_token.js upload failed — skipping gateway token step"

OSH_TIMEOUT=600 osh sandbox upload "$SANDBOX_NAME" \
  "$SANDBOX_DIR/scripts/start_oc_gateway.sh" \
  "${INSTALL_STAGE_DIR}/" \
  >/dev/null 2>&1 \
  && ok "uploaded start_oc_gateway.sh" \
  || warn "start_oc_gateway.sh upload failed — skipping gateway token step"

# Run the launcher inside the sandbox. It:
#   - kills any old gateway
#   - persists a random token into /sandbox/.openclaw/openclaw.json
#   - starts gateway detached on 127.0.0.1:18789
#   - writes /tmp/oc-token.env containing TOKEN=<hex>
osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "cp -f ${INSTALL_STAGE_DIR}/set_oc_token.js /tmp/set_oc_token.js && cp -f ${INSTALL_STAGE_DIR}/start_oc_gateway.sh /tmp/start_oc_gateway.sh && chmod +x /tmp/set_oc_token.js /tmp/start_oc_gateway.sh && SET_TOKEN_JS=/tmp/set_oc_token.js sh /tmp/start_oc_gateway.sh" \
  2>&1 | sed 's/^/      /' \
  || warn "Gateway launcher reported errors — see output above"

# Read back the token from the sandbox
OC_GATEWAY_TOKEN=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "test -f /tmp/oc-token.env && . /tmp/oc-token.env && echo \"\$TOKEN\"" \
  2>/dev/null | tr -d '\r\n' || true)

if [ -n "${OC_GATEWAY_TOKEN:-}" ]; then
  ok "Gateway token persisted: ***${OC_GATEWAY_TOKEN: -8}"
else
  warn "Could not read /tmp/oc-token.env from sandbox — token unknown."
  warn "Inside sandbox: jq -r '.gateway.auth.token' /sandbox/.openclaw/openclaw.json"
fi

# Ensure the host port-forward is up, so :18789 is reachable from outside.
#
# `openshell forward start` does not run to completion. It leaves an `ssh -N -L`
# daemon that reparents to init and inherits whatever stdout it was launched with.
# Piped through `osh` (which times out only its direct child, the perl wrapper) or
# into `sed`, the pipe's read end never sees EOF: `sed` blocks forever and the
# install stalls with no output. So start it detached, outside any pipeline, and
# poll the forwarded port.
#
# `openshell forward list` reports a stale forward as `dead` rather than removing
# it, so the check below falls through to this branch and a fresh `forward start`
# on the same port supersedes it.
if osh forward list 2>/dev/null | grep -q "${SANDBOX_NAME}.*18789.*running"; then
  ok "Port-forward already running: 127.0.0.1:18789 → ${SANDBOX_NAME}:18789"
else
  FORWARD_LOG="/tmp/osh-forward-18789.log"
  nohup openshell forward start 18789 "$SANDBOX_NAME" >"$FORWARD_LOG" 2>&1 &
  disown

  info "Waiting for port-forward to come up..."
  FORWARD_UP=false
  for _ in $(seq 1 20); do
    nc -z 127.0.0.1 18789 2>/dev/null && { FORWARD_UP=true; break; }
    sleep 1
  done
  if $FORWARD_UP; then
    ok "Port-forward is up: 127.0.0.1:18789 → ${SANDBOX_NAME}:18789"
  else
    warn "Port-forward did not come up within 20s — check $FORWARD_LOG, or run manually: openshell forward start 18789 $SANDBOX_NAME"
  fi
fi

# =============================================================================
# STEP 8: Apply sandbox network policy
# =============================================================================
step "Step 8 — Sandbox network policy"

POLICY_FILE="$SCRIPT_DIR/policy/sandbox_policy.yaml"
[ -f "$POLICY_FILE" ] || fail "Policy file not found: $POLICY_FILE"

OSH_TIMEOUT=600 osh policy set "$SANDBOX_NAME" \
  --policy "$POLICY_FILE" \
  --wait \
  && ok "Policy applied (only the gateway front door on $GATEWAY_PORT is open)" \
  || fail "Failed to apply sandbox policy."

# =============================================================================
# STEP 9: Upload skill to sandbox
# =============================================================================
step "Step 9 — Upload skill ($SKILL_NAME)"

[ -f "$SKILL_SRC/SKILL.md" ] || fail "SKILL.md missing at $SKILL_SRC"

# The skill client is Node, which comes from the sandbox image. Checked before the
# upload, so a base image without it fails with the reason rather than a puzzling
# "command not found" during verification.
#
# The resolved path is printed because it must match a `binaries:` entry in
# policy/sandbox_policy.yaml. The match is on the resolved path, so a base image
# that puts node elsewhere, or symlinks it, is refused at the egress proxy with
# 403 policy_denied even though node is present.
SANDBOX_NODE_PATH=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c 'command -v node >/dev/null 2>&1 && readlink -f "$(command -v node)"' \
  2>/dev/null | tr -d '\r\n' || true)
[ -n "${SANDBOX_NODE_PATH:-}" ] \
  || fail "node not found inside sandbox '$SANDBOX_NAME'. The skill client needs it and this script does not install it — rebuild the sandbox from sandbox/Dockerfile."
if grep -qE "path:[[:space:]]*${SANDBOX_NODE_PATH}[[:space:]]*\}?[[:space:]]*\$" \
     "$SCRIPT_DIR/policy/sandbox_policy.yaml"; then
  ok "node in sandbox: $SANDBOX_NODE_PATH ($(osh sandbox exec -n "$SANDBOX_NAME" -- node --version 2>/dev/null | tr -d '\r\n'))"
else
  warn "node resolves to $SANDBOX_NODE_PATH, which is not in policy/sandbox_policy.yaml's binaries list"
  warn "The front door will answer 403 policy_denied until it is. Add: - { path: $SANDBOX_NODE_PATH }"
fi

# Clear the destination first, so the sandbox copy MIRRORS skill/ rather than
# accumulating. `openshell sandbox upload` overwrites the files it carries and
# leaves the rest alone, so a file deleted from the repo lingers in the sandbox.
# That is how a superseded client once survived next to its replacement, still
# runnable, leaving an agent that listed the directory to find two of them.
#
# config.json is not preserved; Step 10 writes it immediately after.
osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "rm -rf ${SANDBOX_SKILL_ROOT}" >/dev/null 2>&1 || true

OSH_TIMEOUT=600 osh sandbox upload "$SANDBOX_NAME" \
  "$SKILL_SRC" \
  "$SANDBOX_SKILL_ROOT" \
  && ok "Skill uploaded to $SANDBOX_SKILL_ROOT (destination cleared first, so it mirrors skill/)" \
  || fail "Skill upload failed."

SKILL_CONFIRM=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "test -f ${SANDBOX_SKILL_ROOT}/SKILL.md && echo ok" 2>/dev/null || true)
[ "$SKILL_CONFIRM" = "ok" ] \
  || fail "SKILL.md not found in sandbox after upload."
ok "Upload confirmed"

# Upload HEARTBEAT.md to the workspace root; OpenClaw reads it there at session
# start, which is how the agent picks up routing rules.
#
# The destination is the PARENT DIRECTORY, not the file path. `openshell sandbox
# upload` places the source inside the destination directory, creating that
# directory when it does not exist, so a full file path yields
# `.../workspace/HEARTBEAT.md/HEARTBEAT.md`. Hence the trailing slash.
HEARTBEAT_SRC="$SKILL_SRC/HEARTBEAT.md"
HEARTBEAT_DIR="/sandbox/.openclaw-data/workspace"
HEARTBEAT_DEST="$HEARTBEAT_DIR/HEARTBEAT.md"
if [ -f "$HEARTBEAT_SRC" ]; then
  # If an earlier run left a HEARTBEAT.md *directory* here, remove it first,
  # otherwise the upload lands inside it.
  osh sandbox exec -n "$SANDBOX_NAME" -- \
    sh -c "[ -d '$HEARTBEAT_DEST' ] && rm -rf '$HEARTBEAT_DEST' || true" >/dev/null 2>&1 || true

  OSH_TIMEOUT=600 osh sandbox upload "$SANDBOX_NAME" \
    "$HEARTBEAT_SRC" \
    "$HEARTBEAT_DIR/" \
    && ok "HEARTBEAT.md uploaded to $HEARTBEAT_DEST" \
    || warn "HEARTBEAT.md upload failed — agent may not invoke skill tools correctly"
fi

# =============================================================================
# STEP 10: Write config.json into sandbox skill root
# =============================================================================
step "Step 10 — Write config.json"

# The gateway consults a policy model on every decision, so the client's wait is
# bounded by that model, not by n8n.
GATEWAY_TIMEOUT="${GATEWAY_TIMEOUT_SEC:-180}"

CONFIG_JSON="{\"server_url\":\"${GATEWAY_URL_SANDBOX}\",\"timeout_sec\":${GATEWAY_TIMEOUT}}"

osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "echo '${CONFIG_JSON}' > ${SANDBOX_SKILL_ROOT}/config.json" \
  && ok "config.json written to ${SANDBOX_SKILL_ROOT}/config.json" \
  || warn "Could not write config.json — run setup_config.js inside the sandbox manually"

# =============================================================================
# STEP 11: Verification
# =============================================================================
step "Step 11 — Verification"

_check() {
  local label="$1" result="$2"
  [ "$result" = "ok" ] \
    && ok "$label" \
    || warn "$label — FAILED (check logs)"
}

# Skill files present in sandbox
SKILL_V=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "test -f ${SANDBOX_SKILL_ROOT}/SKILL.md && echo ok" 2>/dev/null || true)
_check "Skill upload: $SANDBOX_SKILL_ROOT"  "$SKILL_V"

CFG_V=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "test -f ${SANDBOX_SKILL_ROOT}/config.json && echo ok" 2>/dev/null || true)
_check "config.json : $SANDBOX_SKILL_ROOT"  "$CFG_V"

HB_V=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "test -f /sandbox/.openclaw-data/workspace/HEARTBEAT.md && echo ok" 2>/dev/null || true)
_check "HEARTBEAT   : /sandbox/.openclaw-data/workspace/HEARTBEAT.md"  "$HB_V"

CLIENT_V=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "test -f ${SANDBOX_CLIENT} && echo ok" 2>/dev/null || true)
_check "client.js   : $SANDBOX_CLIENT"  "$CLIENT_V"

# Nothing should have built an interpreter or a dependency tree here. Checked,
# not assumed: the sandbox has no package-index egress.
NO_DEPS_V=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c "test -d ${SANDBOX_SKILL_ROOT}/venv -o -d ${SANDBOX_SKILL_ROOT}/node_modules || echo ok" \
  2>/dev/null || true)
_check "No venv or node_modules in the skill directory"  "$NO_DEPS_V"

# How many tools the front door should expose. Read from the workflow source, not
# written here as a number: `gateway-front-door.ts` attaches the tools to the MCP
# trigger, so its `subnodes.tools` array IS the definition of what exists. A literal
# here would keep passing after a tool was added, and start failing after one was
# removed, in both cases describing the installer rather than the gateway.
FRONT_DOOR_SRC="$SCRIPT_DIR/n8n/workflows/gateway-front-door.ts"
EXPECTED_TOOLS=$(grep -oE 'subnodes:[[:space:]]*\{[[:space:]]*tools:[[:space:]]*\[[^]]*\]' \
  "$FRONT_DOOR_SRC" 2>/dev/null \
  | grep -oE '\[[^]]*\]' | tr ',' '\n' | grep -c 'Tool' || true)

# A derivation that silently yields nothing would make the check below vacuous, so
# it stops here instead. This is the failure mode the repo has hit twice: a prover
# reporting PASS over rules that enforced nothing.
[ "${EXPECTED_TOOLS:-0}" -gt 0 ] \
  || fail "Could not read the tool list from $FRONT_DOOR_SRC — refusing to verify against an unknown count."

# Front door reachable from inside the sandbox. Costs no access decision and
# writes no audit record, so it is safe to run on every install.
HEALTH_OUT=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  $SANDBOX_NODE "$SANDBOX_CLIENT" \
  gateway_health 2>&1 || true)
if echo "$HEALTH_OUT" | grep -q "\"tool_count\": ${EXPECTED_TOOLS}\b"; then
  ok "Gateway front door: $EXPECTED_TOOLS tools reachable from the sandbox"
else
  warn "Gateway front door: expected $EXPECTED_TOOLS tools (per $(basename "$FRONT_DOOR_SRC")), got a different answer"
  echo "$HEALTH_OUT" | sed 's/^/      /'
fi

# The end-to-end gate: one whoami through the gateway from inside the sandbox. It
# exercises every hop including the access decision; a reachability probe does not.
WHOAMI_OUT=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  $SANDBOX_NODE "$SANDBOX_CLIENT" \
  whoami --query "installer verification: who am I acting as?" 2>&1 || true)
if echo "$WHOAMI_OUT" | grep -q '"matched_rule"'; then
  ok "Skill end-to-end: whoami answered by the gateway"
  echo "$WHOAMI_OUT" | sed 's/^/      /'
else
  warn "Skill end-to-end: whoami did not return a gateway decision"
  echo "$WHOAMI_OUT" | sed 's/^/      /'
fi

# The sandbox must NOT reach the gateway's own policy and audit service on 4301.
# That would route around the access decision both ways: the service serves the
# policy the decision reads, and it accepts audit records, so an agent able to POST
# there could claim it was allowed something. `403 policy_denied` is the network
# policy working, and the architecture rests on it, so this runs every install.
#
# ONE PORT, NOT A LIST. The policy is default-deny, so every unlisted port is
# refused by the same mechanism; a second would test nothing new. 4301 is the one
# with something behind it worth refusing.
#
# Probed with the skill's own client: same code path the agent uses, and no
# multi-line `node -e` payload, which `openshell sandbox exec` would reject,
# because it rejects any argument containing a newline.
#
# The reason survives only because the client sends absolute-form requests instead
# of a CONNECT tunnel; `policy_denied` is the proxy's own answer. See `proxyFor` in
# skill/scripts/client.js. A client that tunnelled would fail with nothing to grep.
CLOSED_OUT=$(osh sandbox exec -n "$SANDBOX_NAME" -- \
  $SANDBOX_NODE "$SANDBOX_CLIENT" \
  --server-url "http://host.openshell.internal:${GATEWAY_SERVICES_PORT}/mcp" \
  gateway_health 2>&1 || true)
if echo "$CLOSED_OUT" | grep -q 'policy_denied'; then
  ok "Port $GATEWAY_SERVICES_PORT correctly refused to the sandbox (403 policy_denied)"
else
  warn "Port $GATEWAY_SERVICES_PORT was NOT refused to the sandbox — check the policy applied"
  echo "$CLOSED_OUT" | tail -2 | sed 's/^/      /'
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}  ╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}  ║  Installation complete!                                  ║${NC}"
echo -e "${GREEN}  ╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Gateway front door (what the agent talks to):"
echo "    from the sandbox : ${GATEWAY_URL_SANDBOX}"
echo "    from this host   : ${GATEWAY_URL_HOST}"
echo ""

if [ -n "${OC_GATEWAY_TOKEN:-}" ]; then
  echo -e "${CYAN}  ── OpenClaw chat UI ──────────────────────────────────────${NC}"
  echo "  Browser URL  : http://127.0.0.1:18789/#token=${OC_GATEWAY_TOKEN}"
  echo "  TUI env      : export OPENCLAW_GATEWAY_TOKEN=${OC_GATEWAY_TOKEN}"
  echo "                 openclaw tui      (inside sandbox)"
  echo ""
  echo "  If you're on a remote host, forward port 18789 to your laptop:"
  echo "    ssh -L 18789:127.0.0.1:18789 <user>@<remote-host>"
  echo "    # then open the Browser URL above"
  echo ""
fi

echo "  Next steps — talk to the agent and walk the scenario (docs/SCENARIO.md):"
echo "    1. Connect : nemoclaw $SANDBOX_NAME connect"
echo "    2. Ask     : \"who am I and what can I access?\"       (-> whoami)"
echo "    3. Ask     : \"what datasets do we have?\"             (-> list_datasets)"
echo "    4. Ask     : \"copy the night clips to my laptop\"     (-> request_export, expect DENY R1)"
echo ""
echo "  Update config.json (server_url / timeout):"
echo "    openshell sandbox exec -n $SANDBOX_NAME -- \\"
echo "      $SANDBOX_NODE ${SANDBOX_SKILL_ROOT}/scripts/setup_config.js --non-interactive \\"
echo "      --server-url <url> --timeout <secs>"
echo ""
