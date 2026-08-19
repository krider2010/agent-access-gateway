# Runbook

Day-to-day operation once [SETUP.md](SETUP.md) has been through once: what runs where,
how to bring it back after a reboot, how to stop it cleanly, and how to diagnose a broken
hop.

---

## 1. What runs where

| Component | Where | Notes |
|---|---|---|
| n8n | container `n8n-gtc`, `http://localhost:5678` | Data in volume `n8n_gtc_data`. Survives container replacement. |
| Gateway front door | `http://localhost:5678/mcp/kerbline-access-gateway` | The n8n MCP Server Trigger the agent talks to. **The one port the sandbox may reach.** |
| OpenShell gateway | `https://127.0.0.1:8080` | Runs its own embedded Kubernetes. |
| NemoClaw sandbox | `lena-agent` | Holds the agent and the installed skill. |
| n8n management MCP | `http://localhost:5678/mcp-server/http` | n8n's own admin surface, and the only thing besides the front door on this port. Build-time only: `n8n/workflows/isolate.sh` switches it off at the end of every build, because it can run any workflow, the one that makes access decisions included. `make n8n-mcp-on` / `make n8n-mcp-status`. |
| Gateway services | port `4301`, loopback plus the docker bridge gateway on Linux ([SETUP.md](SETUP.md) §7) | Host process, `gateway/gateway_services.js`. Serves the policy and catalog to n8n, receives audit records, and holds the data plane: `POST /data/execute` runs an authorised tool call where the rows live. Log `/tmp/gateway-services.log`. **Deliberately not reachable from the sandbox**; see §4, and [GATEWAY_CONTRACT.md](GATEWAY_CONTRACT.md) §9 for why the data plane is on this port. |
| OpenClaw chat UI | `http://127.0.0.1:18789` | Needs a token, see §5. Requires the port-forward. |
| Skill (in sandbox) | `/sandbox/.openclaw/workspace/skills/access-gateway` | Node client against the standard library, using the runtime the sandbox already ships. No venv and no packages, which is what let the `pypi` egress grant be removed; the sandbox policy now opens the front door and nothing else. |
| Governance console | `http://127.0.0.1:4301/console`, or `make console` | Static files in `console/`, served by the gateway services. Read-only, no dependencies. On the same port as the audit sink on purpose, so the agent cannot reach it either. |
| Routing table | `/sandbox/.openclaw-data/workspace/HEARTBEAT.md` | Workspace root, not the skill directory. OpenClaw loads it at session start. |

Secrets live in `.env` at the repo root, which is gitignored. Nothing else holds
credentials.

Always put the CLIs on `PATH` first:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 2. After a reboot

Docker comes back with the machine; the OpenShell gateway and the host services do not.

```bash
export PATH="$HOME/.local/bin:$PATH"

# 1. Host Kubernetes must still be off. Check before anything else.
orb config get k8s.enable          # expect: false

# 2. n8n
docker start n8n-gtc

# 3. Gateway, then sandbox
openshell gateway start            # takes ~60s; brings up its embedded k8s
nemoclaw lena-agent recover        # restarts the sandbox gateway + port-forward

# 4. Gateway services: the policy source and audit sink n8n reads
make services

# 5. Policy, skill, config, forward: idempotent, re-establishes everything
bash install.sh
```

Step 5 is the reliable way back. It re-checks every hop and only acts where something is
missing.

There is no `nemoclaw <name> start`. The valid `nemoclaw <name>` actions are `connect`,
`status`, `doctor`, `logs`, `policy-add`, `policy-remove`, `policy-list`, `skill`,
`snapshot`, `share`, `rebuild`, `recover`, `shields`, `config`, `channels`,
`gateway-token` and `destroy`. Use `openshell gateway start` for the gateway and
`nemoclaw <name> recover` for a sandbox that has lost its gateway or forward.

## 3. Check it works

```bash
make verify SANDBOX=lena-agent
```

Or hop by hop, which is what to do when something is wrong:

```bash
# 1. n8n itself
curl -s http://localhost:5678/healthz                     # {"status":"ok"}

# 2. n8n's management API is not answering. Off is correct here: isolate.sh
#    switches it off at the end of every build, and it answers 403 even to a
#    valid token in that state, so this is a check that it is closed rather
#    than a check that it works.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:5678/mcp-server/http -d '{}'           # 404 or 403 = off, which
                                                          # is its resting state; see §4

# 3. Gateway services are up, and can see the policy and catalog
curl -s http://127.0.0.1:4301/health   # {"status":"ok","policy":true,"catalog":true,...}

# 4. Sandbox is Ready
openshell sandbox list

# 5. Front door reachable from inside the sandbox, through the skill
SK=/sandbox/.openclaw/workspace/skills/access-gateway
openshell sandbox exec -n lena-agent -- \
  sh -c "node --no-warnings $SK/scripts/client.js gateway_health" </dev/null

# 6. One real decision end to end. Unlike step 5 this writes an audit record.
openshell sandbox exec -n lena-agent -- \
  sh -c "node --no-warnings $SK/scripts/client.js whoami --query 'who am I?'" </dev/null
```

A healthy result from step 5 looks like:

```json
{
  "status": "ok",
  "url": "http://host.openshell.internal:5678/mcp/kerbline-access-gateway",
  "tool_count": 9,
  "tools": ["describe_dataset", "list_datasets", "publish_model", "..."]
}
```

Nine tools, not eight: `publish_model` is the ninth and it is what rung 4e runs through.

## 4. Diagnose by hop

Work outward from the sandbox. The error text tells you which hop failed.

| What you see | Failing hop | Do this |
|---|---|---|
| `Connection refused` from `host.openshell.internal:5678` | skill to front door | n8n is not running. `docker start n8n-gtc`, then `bash install.sh`. |
| `EAI_AGAIN`, `ENOTFOUND` or `ECONNREFUSED` for `host.docker.internal:4301` | n8n container to the host service | The hop that fetches the policy, and it fails in two different ways. A resolution error means the container has no mapping for the name, which Docker Engine on Linux does not supply: recreate it with `make rebuild CONFIRM=yes`, since `n8n/scripts/up.sh` adds `--add-host` only at create time. `ECONNREFUSED` means the name resolved and the service is not bound on that address; `make services` handles this, and the `listening:` lines in `/tmp/gateway-services.log` say what it chose. See [SETUP.md](SETUP.md) §7. |
| `403 policy_denied` on port 5678 | sandbox policy | The policy did not apply, or applied an older version. Re-run `bash install.sh` and check `openshell policy list lena-agent`. |
| `403 ssrf_denied` | skill to front door, blocked by policy | `host.openshell.internal` resolves to an address not in `policy/sandbox_policy.yaml`. Resolve it inside the sandbox and add it. |
| `404` from `/mcp/kerbline-access-gateway` | front door not active | The workflow exists but is not published, so its MCP trigger is not registered. Non-destructive fix, and it is the one to reach for: `make n8n-mcp-on && bash n8n/workflows/isolate.sh`. That re-publishes every live workflow, restarts n8n so webhook registrations are rebuilt, re-asserts the isolation invariant and switches the management API back off. The `n8n-mcp-on` is needed first because `isolate.sh` verifies itself *through* the management surface it disables at the end. Only if the workflow is genuinely absent do you need to build it: `node n8n/workflows/build.js decide --create`, then `front-door --create`, then `isolate.sh` last. See §7 before considering `make rebuild`, which destroys the volume. |
| `initialize` answered without an `mcp-session-id` | wrong URL | The URL reaches n8n but not the MCP Server Trigger's production endpoint. Check `config.json`'s `server_url` in the sandbox. |
| `404` or `403` from `/mcp-server/http` | build helper to n8n's management API | The management API is off, which is its resting state: `isolate.sh` disables it after each build, and once off it answers **403 even to a valid token**, so a 403 here is not an auth problem. A 404 more often means n8n is still starting. `make n8n-mcp-status` tells them apart, `make n8n-mcp-on` re-enables it for a build. Never leave it on for a demo. |
| `401` from `/mcp-server/http` | build helper to n8n, auth | The `N8N_MCP_TOKEN` in `.env` is stale; `make rebuild` rotates it. `make n8n-setup` mints a fresh one. The skill never carries this token, so this cannot surface as a skill failure. |
| An `openshell` command never returns | anywhere, in a script | ssh is waiting on stdin. Append `</dev/null`. |
| `status: InvalidArgument` from `openshell sandbox exec` | not a hop, the argument itself | `sandbox exec` rejects any command argument containing a newline; the error names the argument, not the cause. Keep `sh -c '...'` payloads on one line, or upload the script and exec that instead. |
| `403 Forbidden` reaching a host port from the sandbox | sandbox policy, before the host | The sandbox policy denied the egress and **the request never reached the host service**; check the host process's own log to confirm it saw nothing. This is the expected answer for every host port except 5678, `4301` included, *and* for every path on 5678 except the front door, since the grant is scoped to one path rather than the whole port. A `403` here means enforcement is working. |
| A raw socket probe says *every* host port is unreachable | your test, not the system | Sandbox egress is enforced by an HTTP-aware proxy, so `socket.connect()` bypasses it and finds nothing listening, reporting `ConnectionRefusedError` even for allowlisted ports. Probe with an actual HTTP request instead. A socket-level test will tell you 5678 is dead while the skill is using it happily. |
| An allow-listed *venv* Python is still refused | sandbox policy, binary matching | The enforcement point matches the interpreter's resolved path, and a venv's `bin/python3` is a symlink to the system interpreter. `policy/sandbox_policy.yaml` therefore has to list `/usr/bin/python3` itself; a venv-only allowlist grants nothing. |
| Gateway will not start | host | Check host Kubernetes is off, then `openshell doctor`. |

Deeper diagnostics:

```bash
nemoclaw lena-agent status
nemoclaw lena-agent doctor
nemoclaw lena-agent logs --tail 100
openshell status
tail -f /tmp/gateway-services.log
```

Do not reach for `curl --noproxy`, `NO_PROXY` or direct-IP routes from inside the sandbox.
The network policy blocks them deliberately; consult
[../policy/sandbox_policy.yaml](../policy/sandbox_policy.yaml) for what is actually open.

## 5. Talk to the agent

Get the gateway token and open the UI in your own browser:

```bash
nemoclaw lena-agent gateway-token
# then: http://127.0.0.1:18789/#token=<token>
```

If the URL is dead, the port-forward is down:

```bash
openshell forward list
openshell forward start 18789 lena-agent
```

Interactive shell into the sandbox:

```bash
nemoclaw lena-agent connect
```

A headless `openclaw agent` invoked through `sandbox exec` cannot reach the gateway,
because the exec gets its own network namespace. Use the browser UI, the TUI, or the skill
CLI directly.

## 6. Stop cleanly

Nothing here deletes data.

```bash
make down SANDBOX=lena-agent    # stops n8n and the in-sandbox OpenClaw gateway
pkill -f gateway_services.js              # stops the gateway services on 4301
openshell gateway stop                    # stops the gateway, keeps its state
```

Then give Kubernetes back to whatever else needs it:

```bash
make k8s-on
```

## 7. Reset levels

Escalate only as far as you need to.

**Re-run the installer.** Fixes most things. Idempotent.

```bash
bash install.sh
```

**Clear the install staging dir and re-run.** For when an upload landed half-written.
Touches nothing else.

```bash
make clean && bash install.sh
```

**Replace the n8n container, keep the data.** Also how you upgrade n8n: bump
`N8N_VERSION`, then

```bash
docker rm -f n8n-gtc && make n8n-up
```

The volume persists, and n8n migrates its database forward on start. The owner account and
MCP token survive.

**Clear the audit log.** `audit/decisions.jsonl` is append-only by design and nothing in
the gateway ever truncates it, so resetting it is a deliberate manual act.

```bash
rm -f audit/decisions.jsonl    # the service recreates it on the next decision
```

**Do this before recording or presenting.** The log accumulates every decision from every
test run, including deliberately malformed records from validating the endpoint, and anything
reading it shows all of it: `tail -f`, `GET /audit/tail`, or whatever eventually renders it,
since nothing does today. A screen showing five hundred decisions from three days of
debugging undercuts the point the trail is there to make. The file is gitignored, so it never
reaches the repo either way; this is about what is on screen.

**Rebuild the sandbox.** Slow; re-runs the image build.

```bash
nemoclaw lena-agent rebuild
```

**`make rebuild CONFIRM=yes` is the one live destructive target, and it is destructive on
purpose.** It removes the n8n container *and the `n8n_gtc_data` volume*, taking every workflow,
every credential and the owner account, then rebuilds all of it from this repo plus `.env`:
fresh container, owner, `nvidiaApi` credential, both gateway workflows, isolation invariant.
Everything it destroys is reproducible, which is why it is wired up rather than commented out:
running it routinely is how we find out whether the setup instructions are still true. It
refuses without `CONFIRM=yes`, nothing depends on it, and no other target calls it. Two
consequences to plan for: it rotates the MCP token, so run `bash install.sh` afterwards to
re-point the sandbox, and it is the wrong tool for an inactive front door, where §4's row gives
the non-destructive fix.

**Everything else destructive is deliberately not wired up.** `make clean` removes only the
install staging dir, and never the volume or the sandbox. Commented-out stanzas sit at the
bottom of the `Makefile` if you want them; read them before uncommenting. `docker volume rm
n8n_gtc_data` on its own loses every workflow and credential and rebuilds nothing, and
`nemoclaw lena-agent destroy` loses the sandbox.

## 8. Snapshot the live instance

```bash
bash n8n/scripts/export_workflows.sh
```

Writes a sanitised `workflows-export.json` into `n8n/workflows/`, plus a credentials template
with every piece of secret material stripped. Check the diff before committing; n8n exports
can carry more than you expect.

**This is a backup, not the source of truth.** The authored sources
are `n8n/workflows/gateway-decide.ts` and `gateway-front-door.ts`, hand-editable node graphs
meant to be read, and `n8n/workflows/build.js` substitutes the few values that live elsewhere
(the policy engine, the prompt settings, the decision workflow's id) and deploys the result.
Edits belong in the `.ts` files, where the next build will pick them up. An export goes the
other way and is useful for exactly two things: seeing what n8n made of what you deployed, and
recovering an edit made in the editor before it gets lost. Nothing reads the export back in.
