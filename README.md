# Control access, not capabilities

A governed access gateway for autonomous agents, built with [n8n](https://n8n.io) and
NVIDIA NemoClaw.

You cannot durably limit what a capable agent is able to *do*. Capability is the point of
an agent, and a capable one will find another route. The control that holds is governing
what it is allowed to *touch*: who it is acting as, which data it may reach, what needs a
human, and what may never leave. The part that makes it sovereign is that the access
decision runs on hardware you own, beside the data.

![Architecture](assets/diagrams/architecture.svg)

The agent keeps every capability it had. Only what it can reach changes.

## Two enforcement layers

| Layer | Governs | Enforced by |
|---|---|---|
| The network | Which paths on which hosts, and which binaries may reach them | The NemoClaw sandbox policy |
| Data access | What the data is, who is asking, and where it may go | The n8n access gateway |

They are independent by design. An agent that stops asking permission and copies data out
directly meets the first layer and never reaches the second.

The audit trail sits behind the same kind of boundary. Decisions are appended by a host
service on a port the sandbox policy does not open, so the agent can neither read the policy
it is governed by nor write a record claiming it was allowed something. That is tested: an HTTP
request from inside the sandbox to that port is refused by the policy layer and never arrives at
the service.

## What decides, and what merely explains

The verdict is **deterministic**. Rules in [`policy/access_policy.yaml`](policy/access_policy.yaml)
are evaluated in a defined order, terminal denials win immediately, and anything
unmatched is denied, because an unanticipated request is not an authorised one.

A local Nemotron model explains the verdict in plain language and words the sanctioned
alternative. It cannot change the decision, and it does not choose the alternative either:
the engine picks from the matched rule's own list, so a model that cannot invent an
alternative cannot hallucinate advice. If the model fails to produce a usable answer, a
correct one is composed from the policy with no model involved.

So the guarantees hold under a model that is occasionally wrong. See
[docs/EVALS.md](docs/EVALS.md) for measurements of when it is.

## What works and what's still to be built

**Working and verified:** self-hosted n8n with its management API gated to a single path. A
NemoClaw sandbox running an OpenClaw agent whose only outbound route is the gateway's front
door. The access policy, one deterministic policy engine driving both the gateway and the
eval harness, and the policy and audit service. 37 eval cases laddered across four candidate
models, and a seeded synthetic data generator.

The gateway answers in both directions. A denial comes back with its matched rule, a
model-worded explanation and a sanctioned alternative. An ALLOW runs the data plane and comes
back with output rather than a placeholder. A `GROUP BY` computed where the rows live, records
projected to the columns that were asked for, or a training job's evaluation metrics and none
of its training set. Every call either way writes one audit record to a port the agent cannot reach. All 37
cases were replayed through the deployed front door on 2026-08-13; all thirteen ALLOWs
returned a result rather than a placeholder, and the figures are in
[docs/EVALS.md](docs/EVALS.md) §3.1.

**Not built yet: the governance console.** `console/` holds a `.gitkeep` and nothing else.
The evidence it would render already exists: the audit trail is written on every decision
and `GET /audit/tail` serves it, so what is missing is the screen, not the record behind it.
Until someone builds it, reading the trail means reading `audit/decisions.jsonl`.

**What the eval numbers can and cannot show.** The rules used to exist
twice, once in Python for the harness and once in JavaScript for n8n, and the harness checked
that the two agreed. That check has been retired, because agreement between two copies of the
same logic mostly proves the copying worked. There is now one engine, in JavaScript, and the
Python harness calls it. That makes drift impossible rather than detectable, which is the
stronger property, but it also means the eval numbers can no longer be read as "n8n agrees
with the policy file"; they cannot, since both sides are the same code. What still needs
proving separately is everything around the decision. Four things: that a tool call resolves
to the request the rules expect, that the policy is fetched rather than baked in, that exactly
one audit record is written per call, and that a sanctioned path actually executes.

## Getting started

**Follow [docs/SETUP.md](docs/SETUP.md) for a first run.** It names the failure each step
avoids so you can tell whether it applies to you, and a first run has two prerequisites this
page cannot fit: NemoClaw installed, and host Kubernetes off. The sequence below is the same
one, condensed, and it is the order that works:

```bash
cp .env.template .env       # then add your build.nvidia.com API key
make k8s-off                # only if a host Kubernetes is running; see SETUP §2
make rebuild CONFIRM=yes    # n8n from an empty volume: owner, credential, both
                            # gateway workflows, then the isolation invariant
make install                # sandbox, network policy, agent skill
.venv-seed/bin/python seed/generate.py --full   # SETUP §7 builds that venv first
make services               # policy, audit and data service on 4301
make verify SANDBOX=lena-agent
```

Two things about that order are easy to get wrong. **The gateway workflows are not part of
`make install`.** `install.sh` says so in its own header, and `make rebuild` is what creates
them. So a sequence built from `make n8n-up` and `make n8n-setup` alone leaves n8n running
with no front door mounted, and `make verify` ends in a 404. And **`make rebuild` is
destructive**: it drops the n8n volume, taking every workflow, credential and the owner
account with it. That is guarded behind `CONFIRM=yes`, and it is still the right first-run
command. On a clean machine there is nothing to drop. On any other machine, rebuilding from
this repo plus `.env` is how we find out whether these instructions are still true. Everything
after it has to come after it: a rebuild rotates the MCP token.

Day-to-day operation, restarts and diagnosis by failing hop are in
[docs/RUNBOOK.md](docs/RUNBOOK.md).

## Layout

| Path | What |
|---|---|
| `policy/access_policy.yaml` | The access decision, as data. Rules, classifications, residency, sanctioned paths. |
| `policy/sandbox_policy.yaml` | The sandbox network policy: the other enforcement layer. |
| `gateway/` | The decision engine the gateway runs, the model prompts it uses, and the host-side policy/audit service on a port the sandbox cannot reach. |
| `audit/` | Where decision records are appended at run time. Gitignored; created on first decision. |
| `skill/` | The skill installed inside the sandbox; the agent's only route out. |
| `sandbox/` | Sandbox image and gateway launch scripts. |
| `n8n/scripts/` | Bring-up, configuration and workflow export. |
| `eval/` | Policy engine, query set, runner, golden responses. |
| `seed/` | Synthetic data generator and the verified code tables behind it. |
| `docs/` | Architecture, scenario, gateway contract, setup, runbook, evals, model strategy. |

## The data is synthetic

[`seed/generate.py`](seed/generate.py) generates every dataset here from a fixed
seed. No recording of any real person exists anywhere in this repository. Clip
identifiers carry a `SYN-` prefix and the catalog carries a synthetic-data banner.

The scenario it models is fictional and documented in
[docs/SCENARIO.md](docs/SCENARIO.md). The data formats and identifier layouts are real,
with sources and verification status in [`seed/CODES.md`](seed/CODES.md), because a
made-up field name is the detail someone zooms in on.

## Built on

NVIDIA's [NemoClaw](https://github.com/NVIDIA/NemoClaw) and OpenShell, and the n8n
integration in [`Zenodia/nemoclaw-demos`](https://github.com/Zenodia/nemoclaw-demos),
whose installer and skill patterns this repository reuses. The workflow logic and access
policy here are new; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces
relate.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
