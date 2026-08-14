#!/usr/bin/env bash
# Enforce the gateway's isolation invariant, then verify it.
#
# THE INVARIANT: exactly one workflow, the front door, is reachable from n8n's management MCP
# surface. That surface exposes `execute_workflow`, so an agent holding a management token could
# otherwise call the decision workflow, or the data plane inside it, without passing the front
# door. A gateway that can be routed around is decorative.
#
# WHY A SCRIPT AND NOT A UI TOGGLE. `create_workflow_from_code` sets `availableInMCP: true` on
# everything it creates and offers no way to suppress it, and `update_workflow` deliberately
# cannot unset it, so an agent cannot revoke its own access. That leaves the editor's toggle or a
# session-authenticated REST call, neither of which belongs in a reproducible build. Export, edit
# the setting, re-import: the same CLI route the credential uses, no session and no API key.
#
# RUN THIS AFTER EVERY REBUILD. A regenerated workflow comes back MCP-available, so skipping this
# step silently reopens the bypass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="${N8N_CONTAINER:-n8n-gtc}"
FRONT_DOOR_NAME="${FRONT_DOOR_NAME:-Kerbline Access Gateway — Front Door}"

echo "▸ Exporting all workflows"
docker exec "$CONTAINER" n8n export:workflow --all --output=/tmp/isolate.json >/dev/null

echo "▸ Clearing availableInMCP on everything except the front door"
docker exec -e FRONT_DOOR_NAME="$FRONT_DOOR_NAME" "$CONTAINER" node -e '
const fs = require("fs");
const p = "/tmp/isolate.json";
const all = JSON.parse(fs.readFileSync(p, "utf8"));
const front = process.env.FRONT_DOOR_NAME;
// Only live workflows are written back. Importing an archived workflow un-archives it, so
// exporting everything and importing everything resurrects every superseded copy, which is
// what happened the first time this ran, turning 2 workflows into 30.
const live = all.filter((w) => !w.isArchived);
let exposed = 0, hidden = 0;
for (const w of live) {
  const shouldExpose = w.name === front;
  w.settings = Object.assign({}, w.settings, { availableInMCP: shouldExpose });
  if (shouldExpose) { exposed++; console.log("    exposed: " + w.name); }
  else { hidden++; }
}
console.log("    left archived, untouched: " + (all.length - live.length));
fs.writeFileSync(p, JSON.stringify(live));
console.log("    hidden : " + hidden + " workflow(s)");
if (exposed !== 1) {
  console.error("✗ Expected exactly one front door, found " + exposed);
  process.exit(1);
}
'
docker exec "$CONTAINER" n8n import:workflow --input=/tmp/isolate.json >/dev/null
echo "▸ Re-imported"

# Re-importing resets a workflow's published state, so publishing has to happen after isolation,
# never before. Otherwise this step silently deactivates the gateway and the front door starts
# answering 404.
echo "▸ Re-publishing every live workflow (import cleared it)"
docker exec "$CONTAINER" sh -c '
  n8n export:workflow --all --output=/tmp/ids.json >/dev/null 2>&1
  node -e "
    const a=require(\"/tmp/ids.json\");
    for (const w of a) if (!w.isArchived) console.log(w.id);
  "
' | while read -r wid; do
  docker exec "$CONTAINER" sh -c "n8n publish:workflow --id=$wid >/dev/null 2>&1" || true
done
echo "    published"

echo "▸ Restarting n8n so webhook registrations are rebuilt"
docker restart "$CONTAINER" >/dev/null
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:5678/rest/login 2>/dev/null || true)
  [ "$code" != "000" ] && break
  sleep 1
done
sleep 4
echo "    n8n back up"

# Through the same MCP client the build uses, rather than a second implementation of the SSE
# framing that endpoint answers with.
echo "▸ Verifying against the live MCP surface"
FRONT_DOOR_NAME="$FRONT_DOOR_NAME" BUILD_JS="$REPO_ROOT/n8n/workflows/build.js" node -e '
const { mcp } = require(process.env.BUILD_JS);
const front = process.env.FRONT_DOOR_NAME;

(async () => {
  const found = await mcp("search_workflows", {});
  const live = (found.data || []).filter((w) => !w.isArchived);
  const exposed = live.filter((w) => w.availableInMCP);
  const hidden = live.filter((w) => !w.availableInMCP);

  console.log(`    ${live.length} live workflow(s): ${exposed.length} exposed, ${hidden.length} hidden`);
  for (const w of exposed) console.log(`      exposed: ${w.name}`);

  const problems = [];
  if (exposed.length !== 1) {
    problems.push(`expected exactly 1 MCP-exposed workflow, found ${exposed.length}`);
  } else if (exposed[0].name !== front) {
    problems.push(`the exposed workflow is ${exposed[0].name}, not the front door`);
  }

  // Prove the refusal rather than trusting the flag: ask the management surface for a hidden
  // workflow and require it to say no.
  if (hidden.length) {
    const target = hidden[0];
    const said = await mcp("get_workflow_details", { workflowId: target.id });
    const text = typeof said === "string" ? said : JSON.stringify(said);
    if (text.includes("not available in MCP")) {
      console.log(`      refusal confirmed on ${target.name}`);
    } else {
      problems.push(`${target.name} is flagged hidden but the management surface still served it`);
    }
  }

  if (problems.length) {
    console.log();
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log();
  console.log("✓ Invariant holds: one front door exposed, everything else refused.");
})();
'

# Last, and only after the verification above, because that verification runs THROUGH the
# management surface this switches off.
#
# The invariant above is about which workflows the management surface serves, not about the
# surface existing. And the surface shares a port with the front door: n8n serves
# /mcp/kerbline-access-gateway and /mcp-server/http together.
#
# The sandbox's network policy now scopes its grant to the front-door path, so from inside the
# sandbox the management endpoint answers `403 denied by L7 policy` and never reaches n8n. So this
# step is no longer the only thing in the way, and it still does what the policy does not: the
# policy governs one sandbox, this closes the surface to everything on the host, including
# anything else that can reach 5678.
#
# Verified independent, both ways: with the toggle off the front door still lists all nine tools,
# and the management endpoint answers 403 even with a valid token.
echo
echo "▸ Disabling n8n's instance MCP management access (build-time only)"
bash "$REPO_ROOT/n8n/scripts/mcp_access.sh" off | sed 's/^/    /'
