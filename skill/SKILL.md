---
name: access-gateway
description: >
  The only route to Kerbline's company data. Use for anything about fleet
  datasets, dashcam clips, annotations, model artifacts: listing what data
  exists, describing a dataset, running counts and distributions, reading
  rows, exporting data anywhere, starting a training job, publishing a
  trained model, or asking a data owner for sign-off. Also use it to find out
  who you are acting as and what you are entitled to reach. Trigger on:
  dataset, catalog, clips, annotations, fleet, export, download, copy out,
  aggregate, count, distribution, group by, train, fine-tune, publish, model
  registry, approval, permission, who am I, what can I access.
---

# Access Gateway Skill

Kerbline's data sits behind an access gateway. This skill is how you reach it,
and it is the only way you can: the sandbox network policy opens exactly one
path on one port, and the gateway's front door is what answers on it. Every
other path on that same port is refused, along with every other port. There is
no direct database and no file share. If a request cannot be expressed as one
of the nine tools below, it cannot be done from here.

Every call is evaluated against Kerbline's access policy before anything
happens. That means:

- **A `DENY` is a real answer, not an error.** The gateway decided. Show the
  user its wording and its `redirect_primary` if it offered one.
- **Do not route around a denial.** Rephrasing, shrinking the request, asking
  for the index instead of the rows, or trying a different tool will meet the
  same decision, because the control is on access rather than on volume or
  wording. The gateway's own alternative is the way forward.
- **Never invent a dataset id, a destination, or a record count.** Ask
  `list_datasets` and `describe_dataset` for real ones.

## Invocation

Always invoke the client by full path:

```bash
SKILL_DIR=/sandbox/.openclaw/workspace/skills/access-gateway
SKILL="node --no-warnings $SKILL_DIR/scripts/client.js"
```

The client uses nothing outside Node's standard library, so there is nothing to
install and no `node_modules` in the skill directory. Keep `--no-warnings`: the
sandbox sets `NODE_USE_ENV_PROXY=1`, and without the flag Node prints an
experimental-feature warning above every answer you read. The client does its own
proxy handling, so the warning is about something it does not use.

## The nine tools

Every tool takes `--query`: the user's own words for what they asked. The
gateway's decision is deterministic and does not depend on it, but the
explanation the user reads is written from it, and it is what lands in the
audit record. Pass what they actually said.

### `whoami`
Identity, role, and what that role is entitled to reach. **Call this first**
in a new conversation. It tells you what is possible before you try anything.
```bash
$SKILL whoami --query "who am I and what can I get to?"
```

### `list_datasets`
Every dataset available, with its classification and residency. Metadata only;
it never returns records.
```bash
$SKILL list_datasets --query "what data do we have?"
```

### `describe_dataset`
One dataset's schema, volume, and accountable owner.
```bash
$SKILL describe_dataset --query "what's in the night clips?" \
  --resource fleet.night_clips_annotated
```

### `query_aggregate`
Counts and distributions. `--columns` are the columns to group by; omit it for
an ungrouped total. `--record-count` is how many records the filter selects,
and `--min-cell-count` is how many are in the smallest resulting group. Both are
measured **before** the query runs.
```bash
# ungrouped
$SKILL query_aggregate --query "how many night clips are there?" \
  --resource fleet.night_clips_annotated --record-count 41200
# grouped
$SKILL query_aggregate --query "night clips by lighting and weather" \
  --resource fleet.night_clips_annotated \
  --columns LightingCondition WeatherCondition \
  --record-count 41200 --min-cell-count 180
```
Column names come from the catalog and are resolved strictly against it, so
`describe_dataset` first and use the names it gives you. A guessed or
lower-cased column is an error, not an approximation. Some columns are never
groupable however large the cohort, because grouping by where and when a clip
was recorded rebuilds a journey; the gateway will tell you which and offer a
grouping it does allow.

Supply `--min-cell-count` whenever you pass `--columns`. A grouping whose
smallest group was never measured has not been shown to be safe, and the
gateway treats it that way. For an ungrouped total you can leave it out: the
whole cohort is the one group, and the gateway knows that.

### `read_records`
Rows from a dataset. `--projection records` for full records, `index` for
index or metadata rows only.
```bash
$SKILL read_records --query "show me ten annotated clips" \
  --resource fleet.night_clips_annotated --record-count 10 \
  --projection records
```

### `request_export`
Moving data out of where it currently lives: a workstation, a laptop, an
external host. This is the request most likely to be denied, and a denial
here means the policy is working.
```bash
$SKILL request_export --query "copy the night clips to my laptop" \
  --resource fleet.night_clips_annotated --destination host:workstation \
  --record-count 5000 --projection records
```

### `start_training_job`
Train against a dataset at a named execution location. Returns evaluation
metrics, logs, and a model card, never the data itself.
```bash
$SKILL start_training_job --query "fine-tune on the night clips" \
  --resource fleet.night_clips_annotated --destination enclave:governed
```

### `publish_model`
Publish a trained artifact to a registry or deployment target. A model carries
the residency of the data it was trained on, so the policy governs where it may
be published.
```bash
$SKILL publish_model --query "push the new detector to the global registry" \
  --resource models.pedestrian_v4 --destination registry:global
```

### `request_approval`
Record a request for a dataset owner's sign-off. It registers the request and
returns immediately. It does **not** grant access and does **not** wait for an
answer, so do not tell the user their access is pending approval and then poll.
```bash
$SKILL request_approval --query "ask the owner if I can have this on my laptop" \
  --resource fleet.clip_catalog --destination host:workstation
```

## Reading a result

Every call returns one JSON object, synchronously. There is nothing to poll.

```json
{
  "status": "DENY",
  "matched_rule": "R1",
  "answer": "The request ... is denied because ...",
  "answer_source": "model",
  "redirects_offered": ["train_in_place", "use_redacted_set"],
  "redirect_primary": "train_in_place"
}
```

- `status`: the decision. Allowed, denied, or approval required.
- `matched_rule`: which policy rule decided, e.g. `R1`. `R0-IMPLICIT` means
  no explicit rule governs the request and it resolved to allow by fallback.
- `answer`: the explanation to show the user. Show it as written; do not
  soften a denial or paraphrase a rationale.
- `answer_source`: `model` when the policy brain wrote it, `fallback` when it
  did not and the text was composed from the policy instead. Either is safe to
  show; the distinction exists so a reader can tell prose from a template, not
  because one is less true than the other.
- `redirects_offered`: every route the matched rule sanctions, in the order the
  policy authored them. Empty on a rule that offers none.
- `redirect_primary`: the one the engine chose, and the one to offer. The model
  never picks this; a model that cannot choose an alternative cannot invent one.
  `null` where the rule offers nothing.
- `result`: the data, on an allowed request that returns any.
- `data_plane`: `served` when the enclave computed a result, `not reached` on a
  denial. Useful when an allow comes back with a thin `result`: it distinguishes
  "the gateway allowed it and the enclave returned little" from "the enclave was
  never asked".
- `data_plane_error`: populated only when the enclave was asked and failed.
  A non-null value here with `status: ALLOW` is worth reporting rather than
  retrying, because the decision was fine and the data path was not.

The client exits 0 for any answer the gateway gave, including a denial. A
non-zero exit means the gateway never answered, which is a transport problem
rather than a decision.

## Diagnostics

### `gateway_health`
Confirms the front door is reachable and lists its tools. Makes no access
request and writes no audit record, so it is safe to run any time. This is the
first thing to try when a call fails with a connection error.
```bash
$SKILL gateway_health
```

## Configuration (`config.json`)

```json
{
  "server_url": "http://host.openshell.internal:5678/mcp/kerbline-access-gateway",
  "timeout_sec": 180
}
```

Override per call with `--server-url` / `--timeout`, or with the
`GATEWAY_MCP_URL` / `GATEWAY_TIMEOUT_SEC` environment variables. `install.sh`
writes this file during setup; `scripts/setup_config.js` regenerates it.

## Why there is only one route

```
sandbox skill client  ──►  host:5678 /mcp/kerbline-access-gateway  ──►  the gateway's decision
```

The sandbox network policy (`policy/sandbox_policy.yaml`) opens that one path
and nothing else. Two other things on the host are refused, in two different
ways, and the error text tells you which:

- **n8n's own management API, which can edit and run any workflow, is on the
  same port 5678** at a different path. The grant is scoped to the front-door
  path, not to the port, so that path and every other path on 5678 answers
  `403 denied by L7 policy`.
- **The gateway's policy and audit service is on another port entirely.** That
  is where the policy document lives and where audit records are written, and
  no rule mentions it, so it answers `403 policy_denied`.

Either way the request is refused inside the sandbox and never reaches the
host, so there is no route from here to reading the policy that governs you,
editing the decision workflow, or writing the audit record about you.

## Troubleshooting

1. `$SKILL gateway_health`. If this works, the path is fine and the problem is
   in the call's arguments.
2. `403 policy_denied` in the error text: the sandbox network policy refused
   the egress, and the request never reached the host. The URL is pointing at a
   host port other than 5678. `403 denied by L7 policy` means the port was
   right and the *path* was not. Either way, check `config.json`'s
   `server_url` is the front-door path on 5678.
3. `Could not reach ...` / connection refused: n8n is not running on the host,
   or the gateway workflow is not active. Ask the user to run `bash install.sh`
   from the host, which re-checks every hop.
4. HTTP 200 with an empty body: the session id was lost. This client sends it;
   a hand-rolled `curl` will not. Use the client.
5. `Unknown resource` or `Unknown destination` in the answer: the id is not in
   the catalog. Call `list_datasets` and use a real one rather than guessing.
