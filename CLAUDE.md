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
- the redirect keyword list: still fitted to observed answers, still the weakest link

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

Two figures are known unstable and must not be quoted as single values: the end-to-end p95
(seven runs gave 2596, 3105, 4748, 9382, 2082, 5106 and 5830 ms) and any latency for the 120B, which moved
tenfold within a day on a shared endpoint. Token counts and truncation rates are stable.

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

`e2e_check.py` is the regression gate for any refactor. It must come back 36/36 agreeing, one
audit record per call, and every ALLOW returning a result.

**A green check is not proof the mechanism works.** Three silent successes have been found here: a
policy prover reporting PASS over rules that enforced nothing because `enforcement: enforce` was
missing, a harness reading a hardcoded constant that happened to match the YAML it was supposed to
be reading, and a full-marks eval over prose nobody had read. When you change where something
comes from, perturb the source and confirm the change reaches the consumer.

**Nothing scores whether the model's explanation is true.** The rules decide and the model words
the answer, so wording is its only job, and the harness checks that a named alternative exists
rather than that the stated reason is right. A confidently wrong explanation passes every metric.
After any change to the policy brain, read the "Review" section of `eval/results/<model>/report.md`,
which prints each answer beside the rationale it was given. There is deliberately no heuristic:
the one failure seen here inverted an aggregate's floor logic while using the correct number,
which no cheap textual check catches.

**Two prose-mechanics metrics pull against each other.** Splitting a long sentence raises the
sticky-sentence ratio, because short sentences are proportionally more function words, and it
lowers paragraph variance, because the remaining sentences are more uniform in length. Measured
here: splitting 56 long sentences moved the sticky percentage from 31.9 to 32.0 and raised
low-variance flags from 50 to 65. Fix the named long sentences and the named sticky ones; do not
chase either percentage file-wide, because that means rewriting ordinary technical English.

**Never run `git stash` while another agent is working.** It stashes their in-flight edits too.
Snapshot files into a scratchpad directory instead if you need a baseline to diff against.

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
- `isolate.sh` disables n8n's management API. Run `make n8n-mcp-on` before any build.
- **Changing `gateway/policy_engine.js` needs the `:4301` service restarted.** It `require`s the
  engine once at startup but re-reads `access_policy.yaml` on every request, so a policy edit is
  picked up live and an engine edit is not. Land both, restart the service, then redeploy the
  workflow. Measured cost of forgetting: a policy giving `classification` as a list against an
  engine still doing strict equality made R5 match nothing, so every training job was refused by
  the data plane's re-derivation. It failed closed, and it failed silently.

## Claims that must not be overclaimed

The ones most likely to slip:

- The law does not forbid the footage leaving. Consent from a filmed stranger is unobtainable,
  so the company sets its own floor.
- Rules make the decision. The model words it and cannot change it.
- Sovereignty is true only once the policy model runs on the box, which is Phase 6.
- The sandbox has one egress route, and the binary allow-list cannot separate two paths that
  resolve to one executable. Do not claim the narrower version.
- The data plane re-derives the verdict; the audit sink does not, and rests on the port alone.
