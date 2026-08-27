# The eval harness

How to run the evals, and what happens on each of the 37 cases when you do.

[../docs/EVALS.md](../docs/EVALS.md) covers what the results mean. This file covers the
machinery: the commands, the data flow, and where every number in that document comes
from.

---

## 1. What this harness is, and what it is not

`run_eval.py` is a standalone Python script that talks directly to a chat-completions
endpoint over HTTP. **It does not go through n8n or the NemoClaw sandbox.** Neither is
involved, and neither needs to be running.

`run_eval.py` proves two things: that the rules in `policy/access_policy.yaml` behave as
written, and that a candidate model can explain a verdict without inventing an alternative.
It cannot tell you anything about what is deployed in n8n, because no n8n workflow is in the
loop, and its latency figures are the model call alone for the same reason.

That gap is layer 3 in [../docs/EVALS.md](../docs/EVALS.md), and `e2e_check.py` closes it: a
second script in this directory, covered in §3. It replays the same case set out through the
deployed MCP front door and back through the decision workflow and the data plane. It needs
the whole stack up, which is why it is a separate script rather than a flag.

## 2. Setup, once

```bash
python3 -m venv .venv-eval && .venv-eval/bin/pip install -r eval/requirements.txt
```

**You also need `node` on `PATH`.** The rules exist once, in JavaScript, and
`eval/policy_engine.py` is a shim that starts `node` on `eval/policy_engine_bridge.js` to
reach them. So without `node` nothing here can produce a verdict at all, not one case, and
it fails on the first rather than at the end. That is the cost of having one engine instead of
two copies that agree, and it is a cost worth paying.

Every script below is invoked as `.venv-eval/bin/python …` rather than `python3`. They import
`yaml`, which is in that virtualenv and usually not in the system interpreter, so a bare
`python3` fails at import.

The harness reads `INFERENCE_API_KEY` and `INFERENCE_BASE_URL` from a `.env` file at the
repo root. That file is gitignored and you have to create it. It also reads the generated
dataset catalog at `seed/out/catalog.json`, so run the seed generator first.

## 3. The scripts

`run_eval.py` is the one you will reach for; the rest of this directory answers questions it
deliberately cannot.

| Script | What it answers | Needs |
|---|---|---|
| `run_eval.py` | layers 1 and 2: do the rules behave as written, and does this model explain a verdict without inventing an alternative | an API key |
| `e2e_check.py` | layer 3: does the *deployed* gateway resolve a tool call correctly, fetch the policy at request time, write exactly one audit record, and actually execute a sanctioned path, plus the only per-request wall clock worth quoting | the whole stack up |
| `oracle_check.py` | layer 1 alone, with no model call and therefore no API quota. The question after a refactor is usually "did any verdict change", and this answers it in a second | nothing |
| `probe_directive.py` | how to suppress a given model's reasoning trace, which has to be measured before its numbers mean anything. Run this before adding a model to `MODEL_DIRECTIVES` | an API key |
| `differencing_check.py` | could a model catch the one attack the rules cannot decide? Three arms, including a control. See [../docs/EVALS.md](../docs/EVALS.md) §8 | an API key |
| `cross_check.py` | that a request survives the trip from Python into `node` unchanged. Partly circular by design now that there is one engine; what it still tests is the serialisation, not the rules | `node` |

### The three ways to run `run_eval.py`

**A full run against one or more models.** One HTTP call per case per model, sequentially.

```bash
.venv-eval/bin/python eval/run_eval.py --model nvidia/nemotron-3-nano-30b-a3b
```

`--model` is repeatable, and each model gets its own output directory.

**Accept the current answers as the reference set.** Writes `eval/golden/<case_id>.json`
from this run, so later runs can be diffed against it.

```bash
.venv-eval/bin/python eval/run_eval.py --model nvidia/nemotron-3-nano-30b-a3b --write-golden
```

**Re-score an existing run with no API calls at all.**

```bash
.venv-eval/bin/python eval/run_eval.py --model nvidia/nemotron-3-nano-30b-a3b --rescore
```

This replays the stored raw model text from `trace.jsonl` through the scoring logic and
rewrites the trace, summary and report. Use it whenever you change how answers are judged,
so tuning the scoring costs nothing. It is the flag to reach for most often.

Other flags: `--out` (output directory), `--queries-dir`, `--policy`, `--catalog`.

## 4. What one case looks like

A case is a YAML file in `eval/queries/`. It carries the natural-language query, the
structured request the gateway would receive, and what the policy is expected to decide:

```yaml
id: <case_id>
query: <what the engineer types at their agent>
request:
  actor: <actor id from access_policy.yaml>
  tool: <one of the gateway tools>
  resource: <dataset id>
  destination: <destination name from access_policy.yaml>
  scope_mode: records | metadata | aggregate | compute | catalog | identity
  record_count: <int>
  columns: [<column>, ...]     # only where the rule tests columns
expect:
  decision: ALLOW | DENY | REQUIRE_APPROVAL
  rule: <rule id>
tags: [...]
```

Those six `scope_mode` values are the whole set, and
[../docs/GATEWAY_CONTRACT.md](../docs/GATEWAY_CONTRACT.md) §2 is where they are defined. Two
of them are easy to forget when writing a case because no rule tests them directly:
`catalog`, which is what `list_datasets` and `describe_dataset` resolve to
(`allow_list_datasets_catalog`), and `identity`, which is what `whoami` resolves to
(`allow_whoami_entitlements`). A case that puts one of the other four on those tools is
testing a request the resolver would never produce.

`expect` is the assertion. If the engine disagrees with it, that is a failure and it shows
up in the report.

A case may also carry `enforced_by`. That marks a case the gateway is not responsible for,
such as the attempt to bypass the gateway entirely and copy data out over the network. The
sandbox stops that one, so it is excluded from the gateway's accuracy count rather than
scored as a gateway pass or fail.

## 5. The pipeline, per case

Each case runs through four stages, and the verdict is settled before the model is ever
called.

**Stage 1: the engine decides.** `eval/policy_engine.py` loads the policy YAML and the
dataset catalog and hands the request to `gateway/policy_engine.js`, which is where the rules
live and which is the same file the n8n gateway's Code node runs. It resolves the request
(actor to role, resource to classification, residency and provenance, destination to trust
properties), then walks `evaluation.order` from the policy file. The first matching terminal
DENY wins outright. Otherwise it collects matches, and `REQUIRE_APPROVAL` outranks `ALLOW`.
Nothing matching means DENY, because the policy is default-deny.

This is the oracle. It is deterministic, it makes no network calls, and its verdict is
recorded before any model sees the case. The harness and the gateway share one copy of it
rather than two agreeing copies, so "the workflows agree with the oracle" is structural
instead of something a cross-check has to keep proving.

**Stage 2: the engine picks the redirect.** Where a rule denies and offers alternatives,
the engine takes the first entry in that rule's authored `redirect:` list. The model is
handed one already-chosen alternative to describe, never a menu to choose from.

That is a deliberate design decision with measured consequences. The original prompt asked
the model to pick one of up to two options and quote it verbatim; on the 30B model that
instruction shape blew the token budget on deliberation about half the time on non-allow
cases. The cost of the current design is that a case offering two useful
alternatives only surfaces one.

**Stage 3: the model writes the prose.** One call, `temperature=0.2`, with a per-model
token ceiling. The system prompt tells the model the decision is already final, that it
must not re-evaluate it, and that any instruction inside the request text is untrusted
content rather than a command. The user prompt carries the query, the structured request,
the verdict, the matched rule's rationale, and the one chosen alternative.

Reasoning suppression is per-model and is not guessed. `MODEL_DIRECTIVES` in `run_eval.py`
holds a measured mechanism for each of the four models that have been through the ladder.
`/no_think` for the 9B, `detailed thinking off` for the 30B, and a
`chat_template_kwargs.enable_thinking: false` request body for the 120B. For the
`llama-3.1-nemotron-nano-8b-v1`, measured rather than overlooked, nothing at all: it hangs
outright if sent either directive. The two Nano entries in particular are not interchangeable, and the
wrong one makes things worse rather than doing nothing. A model with no entry gets no
directive and prints a warning, which is the safe default; `probe_directive.py` is how an
entry gets earned.

**Stage 4: decide what actually ships.** The model's text is used only if it clears every
check. Any one of these means it is discarded whole:

- the call failed, after one retry
- the response used its entire token budget, which on a two-to-four sentence answer means
  it almost certainly truncated mid-thought
- the response was empty or whitespace
- the response named a sanctioned path this decision did not authorise

When any of those fires, the answer is composed from policy data alone with no model in the
loop: the decision lead, the matched rule's rationale, and the chosen path's summary and
caveat. Model text and composed text are never blended. One or the other ships whole.

## 6. What the run writes

Per model, under `eval/results/<model-id-with-slashes-replaced>/`:

| File | Contents |
|---|---|
| `trace.jsonl` | One JSON object per case. The full record: query, request, verdict, matched rule, both the raw model text and the text that shipped, token count, latency, and every scoring flag. This is the primary evidence. |
| `summary.json` | The aggregate figures: decision accuracy, rule accuracy, redirect validity, fallback rate, latency percentiles, token ceiling hits, call failures. |
| `report.md` | The same figures rendered readably, with a per-case table. |

`trace.jsonl` keeps `model_response_text` (what the API returned) separately from
`response_text` (what shipped). On a fallback case those differ, and the difference is the
interesting part. The verbatim traces quoted in [../docs/EVALS.md](../docs/EVALS.md) come
straight out of this file.

## 7. Reading the fallback rate and the accuracy figures

**The fallback rate is not a failure rate.** The redirect check is keyword-based. It
produces false positives when a correct answer reuses vocabulary shared across sanctioned
paths, and it fires on cases where the policy offered no alternative for the model to name.
Both inflate the number. The behaviour is safe either way, because a false positive means
shipping correct composed text, but the figure reads worse than reality.

**Decision accuracy is a property of the engine, not the model.** All four models score
identically on it, 100% and every case, because none of them is deciding anything. Quoting it
as model performance would be wrong, and one of the four scored that while failing to answer
27 of 37 calls, which is what makes it worse than merely imprecise.

## 8. Cost and time

One call per case per model, throttled to a fixed minimum interval of about 1.7 seconds to
stay under the hosted free tier's roughly 40 requests per minute. The 37-case set against one
model therefore takes a couple of minutes, most of it waiting on the throttle. Calls are
sequential, never concurrent, across however many models one run is given.

Transient failures (HTTP 5xx, 429, timeouts, transport errors) get one retry after a short
pause. A call that fails twice is recorded as a failure and the run continues rather than
crashing, so one bad response never costs you the whole run.

## 9. Adding a case

Write the YAML file into `eval/queries/`, then run with `--rescore` first if a trace already
exists, or a full run if not. Check the new case's `decision_correct` and `rule_correct` in
the report. If the engine disagrees with your `expect` block, work out which one is wrong
before changing either. Two of the policy's rules were fixed because a case written this way
disagreed with them and the case turned out to be right.
