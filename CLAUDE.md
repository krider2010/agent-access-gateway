# Conventions for this repository

Rules that are not obvious from the code, and that have each been arrived at the hard way.
They apply to anything written here, including code comments.

## Language

**Python only in `eval/` and `seed/`.** Elsewhere prefer JS or TS, then shell, then Ruby or Go.
`eval/` earns it through the AI libraries; `seed/generate.py` earns it because its committed
sample output must stay byte-identical and that determinism comes from seeded numpy.

`n8n/scripts/gateway_client.py` is the one exception, because `eval/e2e_check.py` imports it.

**Interpolate into readable source; do not generate code.** The workflow builders used to be
Python assembling TypeScript strings, so no file showed you the nodes. Now
`n8n/workflows/gateway-decide.ts` and `gateway-front-door.ts` are the authored source and
`build.js` substitutes `@@PLACEHOLDER@@` tokens into them. Keep it that way. The substitution
exists so the deployed workflow cannot drift from the tested engine and prompts.

## One source, not two that agree

Three times a duplicate representation with a drift check has been collapsed into one file.
Each time the check turned out to be the thing worth deleting.

- the policy engine: two implementations plus a cross-check, now `gateway/policy_engine.js` alone
- the prompts: three copies plus two drift checks, now `gateway/prompts.yaml` alone
- the redirect keyword list: one list, still fitted to observed answers

If you find yourself writing a checker to prove two files agree, delete one of the files.

## Writing

Comments here are longer than usual because they carry the reasoning behind a decision and the
traps that cost days. Keep the reasoning. Cut the words.

- **Short sentences.** Aim 15 to 20 words, not 25 to 40. Split rather than compress.
- **No em dashes.** Semicolons, commas, full stops.
- **British spelling.** behaviour, authorised, recognise, licence.
- **State the thing; do not tell the reader it matters.** No "worth knowing", "which is the
  point", "stated plainly", "the honest line is". Delete any sentence whose only job is to tell
  the reader how to feel about the next one.
- **Do not restate a table or list that sits directly above.**
- **Avoid `real` and `exactly` as intensifiers.** Keep `real` only where it separates a
  measurement from a placeholder, and `exactly` only where the number is the point.
- **Name content in a heading**, not significance. "Two roles", not "Two roles, and why the
  split matters".

Run the `no-ai-slop` and `prose-mechanics` skills over any markdown or comment before sharing.
`prose-mechanics` is diagnostic: report its findings, do not apply its judgement calls.

## Numbers

Every figure comes from a file in `eval/results/`, never from memory. If a number cannot be
sourced, say so instead of quoting it.

Token counts and truncation rates hold still. End-to-end latency does not, so quote a range and
name the run it came from.

Quotations of model output are artefacts of a dated run. Never edit one to match current
behaviour; recapture it or annotate it as historical.

## Verification

Nothing is "done" because it looks right. The order, cheapest first:

```bash
.venv-eval/bin/python eval/oracle_check.py      # rules match the policy file, no model
.venv-eval/bin/python eval/cross_check.py       # the shim round-trips to the JS engine
.venv-eval/bin/python eval/fill_check.py        # both prompt fillers agree, braces included
node n8n/workflows/test_decide_code.js          # resolver, actor handling, prompt assembly
bash policy/prove_single_egress.sh              # the sandbox has one egress route
.venv-eval/bin/python eval/e2e_check.py         # the whole path; needs the stack up
```

`e2e_check.py` is the regression gate for any refactor. It must come back 38/38 agreeing, one
audit record per call, and every ALLOW returning a result. Read `gateway_answer_source` in the
trace as well: agreement alone cannot tell a working model from an absent one, because the
engine decides and the gateway composes the wording from policy data when the model gives
nothing usable.

**A green check is not proof the mechanism works.** A check can pass because it is reading the
wrong thing, or reading nothing. When you change where something comes from, perturb the source
and confirm the change reaches the consumer.

**Nothing scores whether the model's explanation is true.** The rules decide and the model words
the answer, so wording is its only job, and the harness checks that a named alternative exists
rather than that the stated reason is right. A confidently wrong explanation passes every metric.
After any change to the policy brain, read the "Review" section of `eval/results/<model>/report.md`,
which prints each answer beside the rationale it was given. There is deliberately no heuristic:
the one failure seen here inverted an aggregate's floor logic while using the correct number,
which no cheap textual check catches.

## Traps that will recur

- `n8n import:workflow` clears the published state and un-archives, so `isolate.sh` runs last.
- `ifElse` needs `{version, config: {name, parameters}}`. Given anything else it silently drops
  the name and the conditions, and every decision routes down one branch.
- Node versions come from `get_node_types`, not from the SDK reference's examples.
- An odd number of apostrophes in a `.ts` comment makes `validate_workflow` report
  `Unterminated string constant` inside an unrelated Code node. The build strips comments.
- `openshell sandbox exec` rejects any argument containing a literal newline.
- `openshell sandbox upload` creates a directory when the destination does not exist, which is
  why `install.sh` stages then copies.
- Node's `fetch` tunnels even plain HTTP, so an egress-proxy refusal arrives as `fetch failed`
  with no `policy_denied` string. Use `node:http` with absolute-form URIs.
- `make rebuild` is destructive and needs `CONFIRM=yes`. It rotates the MCP token, so
  `install.sh` must run afterwards.
- **The sandbox base is pinned by digest, and a `:latest` in the build chain floats more than it
  looks.** `sandbox/Dockerfile`'s `BASE_IMAGE` was `ghcr.io/nvidia/nemoclaw/sandbox-base:latest`,
  and that tag moved between 2026-08-06 and 2026-08-27. Because the runtime stage reads
  `min_openclaw_version` out of the base's own `blueprint.yaml`, the floating tag was also
  floating the OpenClaw pin. A rebuild before a recording would have swapped both. Re-resolve
  deliberately with `docker buildx imagetools inspect …:latest`, then re-run the verification
  order; the trade is that upstream fixes no longer arrive on their own.
- `isolate.sh` disables n8n's management API. Run `make n8n-mcp-on` before any build.
- **Changing `gateway/policy_engine.js` needs the `:4301` service restarted.** It `require`s the
  engine once at startup but re-reads `access_policy.yaml` on every request, so a policy edit is
  picked up live and an engine edit is not. Land both, restart the service, then redeploy the
  workflow. Measured cost of forgetting: a policy giving `classification` as a list against an
  engine still doing strict equality made R5 match nothing, so every training job was refused by
  the data plane's re-derivation. It failed closed, and it failed silently.

## What the code decides, and what it does not

Two boundaries a change here can quietly cross:

- Rules make the decision. The model words it and cannot change it. Anything that lets the
  model's output reach a verdict is a defect.
- The data plane re-derives the verdict from `gateway/policy_engine.js` and refuses on
  disagreement. The audit sink does not; `POST /audit` has no verdict to re-derive and rests
  on the port being unreachable from the sandbox.
