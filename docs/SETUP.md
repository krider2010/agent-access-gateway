# Setup

From a clean machine to a working demo: self-hosted n8n, a NemoClaw sandbox, and an agent
inside that sandbox whose one permitted destination is the gateway's front door.

This describes the sequence that was actually run and verified, in the order that worked.
Where a step exists to avoid a specific failure, the failure is named so you can tell
whether it applies to you.

Verified on macOS 15 (Apple M4 Pro) with OrbStack, against build.nvidia.com hosted models, and
on a DGX Spark running Docker Engine for Linux. Docker Engine differs in one way, handled in §7:
it does not resolve `host.docker.internal` for you, and that name does not point at the host's
loopback.

---

## 1. What you need first

| Requirement | Notes |
|---|---|
| Docker | OrbStack, Docker Desktop or Docker Engine for Linux. `docker version` must answer. |
| **No host Kubernetes running** | See §2. This is the one that will cost you an afternoon. |
| `git`, `curl`, `python3` ≥ 3.10 | Host tooling. Python 3.14 is fine. |
| Node.js ≥ 22 | Required by NemoClaw's installer. |
| **NemoClaw already installed** | This repo does not install it. See §3. |
| An NVIDIA API key | From [build.nvidia.com](https://build.nvidia.com). Starts `nvapi-`. |
| `perl` | Used for a portable timeout in `install.sh`. Present by default on macOS and most Linux. |

### On Apple Silicon and other non-NVIDIA hosts

NemoClaw will report `Local NIM unavailable — requires NVIDIA GPU`. That is expected and
blocks nothing: everything here runs against hosted models over
`https://integrate.api.nvidia.com/v1`. Self-hosting a NIM needs NVIDIA hardware and is a
separate exercise. See [MODEL_STRATEGY.md](MODEL_STRATEGY.md).

## 2. Turn off host Kubernetes first

OpenShell's gateway runs its own embedded Kubernetes. When a host Kubernetes is also
running, the two control planes contend over host cgroups and `nemoclaw onboard` does not
get past `[2/8] Starting OpenShell gateway`. There is no error message; it simply waits.

```bash
make k8s-off
```

This is a **host-wide** change. If you use OrbStack's Kubernetes for other work, that work
stops until you run `make k8s-on`. Docker itself keeps running; only Kubernetes is
disabled, and no Kubernetes state is deleted.

Docker Desktop: Settings, Kubernetes, uncheck *Enable Kubernetes*, Apply and Restart.
minikube or kind: stop the cluster.

## 3. Install NemoClaw

Follow NVIDIA's current NemoClaw installation instructions. Two settings matter for this
repo:

- Install the **OpenClaw** agent runtime (`NEMOCLAW_AGENT=openclaw`). The demo is built
  around it.
- Pin a version rather than tracking latest, so a rebuild is reproducible.

Afterwards, the CLIs live in `~/.local/bin`, which is not on `PATH` by default:

```bash
export PATH="$HOME/.local/bin:$PATH"
nemoclaw --version    # v0.0.36 here
openshell --version   # 0.0.36 here
```

`install.sh` expects `~/.nemoclaw/source` to exist and fails early with a clear message if
NemoClaw is not installed.

## 4. Configure the environment

```bash
cp .env.template .env
```

Then edit `.env`. Every variable is documented in place; three need your attention:

| Variable | Set it to |
|---|---|
| `INFERENCE_API_KEY` | Your `nvapi-…` key. |
| `INFERENCE_MODEL` | The model the sandbox agent reasons with, e.g. `nvidia/nemotron-3-nano-30b-a3b`. |
| `NEMOCLAW_ONBOARD_MODEL` | A model that answers **well inside 15 seconds** (see below). |

`N8N_MCP_TOKEN` is written for you in §5. Leave it blank.

### Why the onboard model is a separate variable

`nemoclaw onboard` validates your inference configuration by sending one chat completion
with a roughly 15-second budget and no `max_tokens` cap. Every current Nemotron emits a
reasoning trace by default, and a large one can spend the whole budget thinking before it
emits a usable token, so validation fails even though the key and endpoint are correct.

Pick a model measured comfortably inside that budget for this variable only. Your
runtime model stays `INFERENCE_MODEL` and is applied separately without the probe.
Measured candidates are in [MODEL_STRATEGY.md](MODEL_STRATEGY.md) §4b;
`nvidia/nemotron-3-nano-30b-a3b` clears it at about 0.8s.

Check your key before going further:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $INFERENCE_API_KEY" \
  https://integrate.api.nvidia.com/v1/models      # expect 200
```

## 5. Bring up n8n and build the gateway workflows

On a first run, one command does all of this:

```bash
make rebuild CONFIRM=yes
```

It starts the container, creates the owner account, mints the MCP token into `.env`, imports
the `nvidiaApi` credential, deploys both gateway workflows and then enforces the isolation
invariant. **It is destructive**: it removes the container and the `n8n_gtc_data` volume
first, which is why it refuses to run without `CONFIRM=yes`. On a clean machine there is
nothing there to remove. On a machine that has run this demo before, rebuilding from the
repo plus `.env` is what you want: it is how we find out whether these instructions
are still true. Skip to §6 once it finishes.

The individual steps, for when you are not starting from empty and do not want to lose an
instance:

```bash
make n8n-up      # pulls and starts the pinned n8n on :5678
make n8n-setup   # owner account, MCP access, MCP Server API key -> .env
make n8n-cred    # the nvidiaApi credential the decision workflow's model node uses
node n8n/workflows/build.js decide --create       # the decision workflow
node n8n/workflows/build.js front-door --create   # the MCP front door, after it
bash n8n/workflows/isolate.sh                     # must run last
```

**Neither `make n8n-up` nor `make install` creates the gateway workflows.** `install.sh`
says so in its own header, and it is the mistake that costs the most time here, because
everything looks healthy right up to a 404 from a front door that was never deployed. The
order in that block is load-bearing three times over. The front door's nine tools point at an
id that only exists once the decision workflow has been created, so it goes second.
`create_workflow_from_code` sets `availableInMCP: true` on everything it creates and no MCP
tool can unset it, so `isolate.sh` has to come after both. And `isolate.sh` clears the
published state on import and re-publishes afterwards, so running it before the build leaves
the front door answering 404, the very symptom you would then go looking for elsewhere.

Set your own credentials rather than taking the placeholders:

```bash
OWNER_EMAIL=you@example.com OWNER_PASSWORD='<something-strong>' bash n8n/scripts/setup.sh
```

The container is `n8n-gtc` and the volume is `n8n_gtc_data`, deliberately not the generic
`n8n` / `n8n_data`. Many machines already run a container called `n8n`, and this must
neither collide with one nor inherit its state. Override with `N8N_CONTAINER` and
`N8N_VOLUME`.

`setup.sh` mints an **MCP Server API key**, which is a different credential from a normal
n8n API key. The `/mcp-server/http` endpoint only accepts the former, and a normal API key
returns `401 jwt audience invalid. expected: mcp-server-api`. Instance MCP access also has
to be enabled, which the script does.

The script waits twice: once for `/healthz`, then again for `/mcp-server/http` to be
mounted. `/healthz` turns green roughly ten seconds before the MCP routes register, so a
script that trusts health alone gets a `404` that reads like "MCP is not supported on this
version".

Confirm:

```bash
curl -s http://localhost:5678/healthz                                  # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:5678/mcp-server/http -d '{}'                        # 401 or 403
```

Both answers are good, and which you get says where in the build you are. `401` means the
management API is up and asking for the token, which is what you want mid-build. `403` means
`isolate.sh` has already switched it off, so it is what `make rebuild` leaves behind, and it
is the resting state the running demo should be in. It answers 403 in that state even to a
valid token, so never read a 403 here as an auth problem. `make n8n-mcp-status` says which of
the two you are looking at without you having to guess.

## 6. Install the sandbox and the skill

**Do not start the OpenShell gateway yourself.** `nemoclaw onboard` starts it at step
`[2/8]`. If a gateway is already listening on port 8080, onboard's preflight reports the
port as unavailable and attributes it to whichever process holds the forwarded port, which
is usually your container runtime. If you hit that, run `openshell gateway stop` and try
again, or move the port with `NEMOCLAW_GATEWAY_PORT`.

```bash
export PATH="$HOME/.local/bin:$PATH"
make install
```

On a first run this takes a while: it builds the sandbox image (62 steps) and uploads
roughly 2.5GB into the gateway. It is idempotent, so re-running is cheap and safe.

The script works through twelve steps: Dockerfile sync, prerequisites, `.env` validation,
sandbox onboard, provider and model configuration, in-sandbox `openclaw.json` patch, gateway
token, sandbox network policy, skill upload, `config.json`, and
verification.

It installs no Python packages on the host. Every host-side helper here is either
stdlib-only or needs PyYAML alone, so nothing in setup depends on a package index being
reachable, and there is no host virtualenv to keep in step with the repo.

One route out of the sandbox. The agent's only permitted destination is the gateway's MCP
front door, on n8n's own port `:5678`. The network policy opens that and nothing else, not
even the gateway's own policy and audit service on `:4301`, which runs on this host.

The sandbox is named `lena-agent` after the demo persona, and the agent runtime is pinned
to `openclaw`. Override with `NEMOCLAW_SANDBOX_NAME` and `NEMOCLAW_AGENT`.

`install.sh` finishes with a block of checks, and on a first pass the last two of them will
warn. That is expected here and not a failure of this step: they call the gateway, which needs
the services and the generated catalog from §7. §8 re-runs them once those exist.

## 7. Generate the synthetic data, then start the services

```bash
python3 -m venv .venv-seed && .venv-seed/bin/pip install -r seed/requirements.txt
.venv-seed/bin/python seed/generate.py --full

make services
```

Writes to `seed/out/`, which is gitignored. The generator is committed and the data is
not, so any clone reproduces the same files from the same fixed seed. Nothing in it is
real: every `ClipId` is prefixed `SYN-` and the catalog carries a synthetic-data banner.
See [SCENARIO.md](SCENARIO.md) §3 and [../seed/CODES.md](../seed/CODES.md).

Pass `--full` unless you have a reason not to. Without it you get the `*.sample.json` files,
a few hundred readable rows each. The gateway serves those quite happily and labels every
figure as coming from them, which is accurate and not very interesting. `--full` adds
`seed/out/full/` at the volumes §3 states: six files, about 65 MB, three seconds. That is
what makes beat 3's lighting breakdown a figure over 48,217 clips rather than over 300
display rows. One dataset is deliberately generated smaller than the catalog claims;
`seed/out/MANIFEST.json` names it and says by how much.

`make services` starts `gateway/gateway_services.js` on port 4301. **This has to come
before any verification, because it is where the gateway reads its inputs from** (the access
policy, the catalog just generated, and the model prompts) and where it writes every audit
record and runs the data plane. Without it the workflow has nothing to decide against and
answers with a connection error rather than a verdict. That is deliberate and is checked as a
negative control in [EVALS.md](EVALS.md) §3.1: a gateway with the policy baked in would keep
answering, and this one must not. Confirm it is up and can see both files:

```bash
curl -s http://127.0.0.1:4301/health   # {"status":"ok","policy":true,"catalog":true,...}
```

### Which address the service binds

n8n runs in a container and reaches this service as `host.docker.internal:4301`, so the bind
address has to be one the container can route to. That address is platform-specific.

| Platform | `host.docker.internal` is | Bound by `make services` |
|---|---|---|
| OrbStack, Docker Desktop | NAT'd to the host's loopback | `127.0.0.1` |
| Docker Engine for Linux | the docker bridge gateway, via `--add-host` | `127.0.0.1` and that gateway |

The script reads the gateway address from `docker network inspect bridge` and passes both to
`--host`, which takes a comma-separated list. It binds two listeners rather than `0.0.0.0`: this
port carries the audit sink and the data plane, and the wildcard would put both on every
interface the machine has.

Override with `GATEWAY_SERVICES_HOST`, comma-separated, if the n8n container is on a network
other than the default bridge:

```bash
GATEWAY_SERVICES_HOST=127.0.0.1,172.17.0.1 make services
```

## 8. Verify

`install.sh` ends with seven checks, and re-running it now beats reading back over the output
from §6. The last two of these can only pass once §5 has deployed the workflows and §7 has
started the services. On a first pass through this document, that had not happened yet:

```bash
bash install.sh
```

```text
✓ Skill upload: /sandbox/.openclaw/workspace/skills/access-gateway
✓ config.json : /sandbox/.openclaw/workspace/skills/access-gateway
✓ HEARTBEAT   : /sandbox/.openclaw-data/workspace/HEARTBEAT.md
✓ client.js   : /sandbox/.openclaw/workspace/skills/access-gateway/scripts/client.js
✓ Gateway front door: 9 tools reachable from the sandbox
✓ Skill end-to-end: whoami answered by the gateway
✓ Port 4301 correctly refused to the sandbox (403 policy_denied)
```

`install.sh` is idempotent, so this costs a re-check of every hop and nothing else.

The last three fail in informative ways. **The front door
check** wants nine tools; a 404 here means the workflows are not deployed or not published, so
go back to §5. **`whoami`** is an access decision made by the gateway and returned to the
sandbox, so it exercises every hop including the model call and the audit write. A connection
error rather than a decision points at `:4301` and therefore at §7. **The `403`** asserts the
other half of the architecture's claim: the sandbox cannot reach the service that serves the
policy governing it and accepts the audit records about it. That one passes whether or not the
service is running, because the refusal happens inside the sandbox.
Asserting one port is enough, because the policy is default-deny and a second unlisted port
would be refused by the same mechanism without adding a claim.

Re-run just the round trip at any time:

```bash
make verify SANDBOX=lena-agent
```

## 9. If something fails

Symptom-first, in rough order of likelihood.

**`nemoclaw onboard` hangs at `[2/8] Starting OpenShell gateway`.** A host Kubernetes is
running. See §2.

**Preflight says port 8080 is unavailable and names your container runtime.** A gateway is
already running. `openshell gateway stop`, then re-run. See §6.

**Onboard fails validating inference, but your key works with `curl`.** The onboard model
is spending the probe budget on a reasoning trace. See §4.

**The gateway answers with a connection error instead of a verdict, on Linux.** The decision
workflow could not reach `host.docker.internal:4301`. Two causes, and the message
tells them apart. `EAI_AGAIN` or `ENOTFOUND` means the container cannot resolve the name, so it
predates the `--add-host` line in `n8n/scripts/up.sh`; recreate it with
`make rebuild CONFIRM=yes`. `ECONNREFUSED` means the name resolved and nothing was listening on
that address, so `make services` bound loopback only; see §7 and check the `listening:` lines in
`/tmp/gateway-services.log`.

**Skill calls return `403 ssrf_denied`.** `host.openshell.internal` resolves to a
different address on your host than the ones allowlisted in
[../policy/sandbox_policy.yaml](../policy/sandbox_policy.yaml). Find the real value and add
it:

```bash
openshell sandbox exec -n lena-agent -- getent hosts host.openshell.internal
```

This list is environment-specific. It is not portable between hosts or OpenShell builds.

**`/mcp-server/http` returns 404 or 403.** That is n8n's management API, and off is its
resting state: `n8n/workflows/isolate.sh` disables it at the end of every build so that the
front door is the only thing answering on `:5678`. `make n8n-mcp-status` confirms it,
`make n8n-mcp-on` re-enables it for a build, and nothing but a build should need it. If it is
already on, n8n is probably still starting.

**`n8n/workflows/build.js` returns 401 or 403 from n8n.** These are two different problems and
the codes tell them apart. `401` means the MCP token in `.env` is stale: `make rebuild`
rotates it, and `make n8n-setup` mints a fresh one. `403` means the management API is switched
off, which is the case above and not an auth problem at all: it answers 403 even to a valid
token, so run `make n8n-mcp-on` first. Either way the skill does not carry this token, so
neither ever shows up as a skill failure.

**An `openshell` command appears to hang.** In a script, close stdin: openshell tunnels
over ssh, and ssh waits on an open stdin that never reaches EOF. `install.sh` handles this
for its own calls.

Day-to-day operation, restarts and teardown are in [RUNBOOK.md](RUNBOOK.md).
