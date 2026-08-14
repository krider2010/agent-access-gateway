# Model strategy: hosted now, sovereign later

Which models play which role, how we get from build.nvidia.com to a single DGX Spark, and
what has to be measured rather than assumed.

> Sourced from a research pass on 2026-08-03. Items marked **⚠ unverified** are
> plausible but unconfirmed and must be smoke-tested before they carry any weight on
> stage. Items marked **✅** have a cited source or our own prior measurement.

---

## 1. Two roles

| Role | Job | Constraint |
|---|---|---|
| **Policy brain** | Given identity + action + classification + destination, explain the decision and pick the sanctioned alternative | Must be small, fast, and self-hostable. This is the part the sovereignty claim rests on. |
| **Agent brain** | Drives Lena's NemoClaw/OpenClaw agent | Wants to be capable and impressive. |

The storyboard says *both* run on one DGX Spark. That's a hard 128GB budget for the pair,
and a bigger constraint on model choice than latency.

## 2. The catalog as of August 2026

The Nemotron 3 generation (Mamba2 + MoE, NVFP4-native) has superseded the Llama-3.x
Nemotron line. ✅

Model IDs below are **as enumerated by n8n's own `lmChatNvidia` node**, read out of
the live container, so these are the strings n8n actually supports rather than strings
from a web page. ✅

| Model | API ID | Total / active | In n8n's list |
|---|---|---|---|
| Nemotron Nano 9B v2 | `nvidia/nvidia-nemotron-nano-9b-v2` | 9B dense | yes |
| Nemotron-3-Nano-30B-A3B | `nvidia/nemotron-3-nano-30b-a3b` | 30B / ~3B | yes ✅ *(confirms the ID research couldn't)* |
| Nemotron-3-Nano-Omni-30B-A3B-Reasoning | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 30B / ~3B | yes |
| Nemotron Nano 12B v2 VL | `nvidia/nemotron-nano-12b-v2-vl` | 12B, vision-language | yes |
| Llama-3.1-Nemotron-Nano-8B-v1 | `nvidia/llama-3.1-nemotron-nano-8b-v1` | 8B dense | yes |
| Llama-3.3-Nemotron-Super-49B-v1 / v1.5 | `nvidia/llama-3.3-nemotron-super-49b-v1{,.5}` | 49B dense | yes |
| Nemotron-3-Super-120B-A12B | `nvidia/nemotron-3-super-120b-a12b` | 120B / 12B | yes |
| Nemotron-3-Ultra-550B-A55B | `nvidia/nemotron-3-ultra-550b-a55b` | 550B / 55B | **no; absent** |

IDs use **dots, not underscores** (`llama-3.3-…-v1.5`), which is the opposite of the form
the research reported. **Ultra-550B is absent from n8n's list entirely.** The
`model` field accepts an expression so an arbitrary string could be forced through, but
its absence is a signal about what n8n tests. Given Ultra is already ruled out on Spark
grounds, that's convenient rather than a problem.

There's also a vision-language model in the list (`nemotron-nano-12b-v2-vl`), which is
tempting for a scenario built on camera footage. Out of scope: the demo governs access to
the clips and never needs to look inside one.

## 3. Three findings that change the build

### 3.1 Ultra-550B does not fit on a single Spark

It requires **4× DGX Spark with RoCE networking** and tensor parallelism. ✅ Together with
our own measurement of 5–10 minutes per query, that rules it out for a storyboard built
around one box, so the agent brain has to shrink.

### 3.2 Every current Nemotron emits a reasoning trace by default.

There is no "non-reasoning" model in the family. ✅ This explains the onboard-probe
timeouts we saw earlier against a 15s budget: the behaviour is family-wide, not a
quirk of one model, so it has to be handled on every call.

Suppression differs per model, which is itself a trap:

| Model | Mechanism |
|---|---|
| Nano 9B v2 | `/think` / `/no_think` control token in the system prompt; `max_thinking_tokens` budget ✅ |
| Super-49B-v1.5, Super-120B-A12B | `enable_thinking: false` via chat template ✅ |
| Nano-30B-A3B | likely inherits `/no_think` **⚠ unverified** |
| Ultra-550B | **⚠ unverified** |

Every call suppresses reasoning explicitly and sets `max_tokens` explicitly, because the
server's own default is small and a reasoning trace will consume the whole budget before
emitting a single useful token. ✅

### 3.3 Structured output is not something to lean on.

NVIDIA explicitly discourages `response_format: json_object`, which permits
valid-but-empty JSON, and recommends `nvext.guided_json` instead. ✅ Whether `nvext` is honoured through
the *public* `integrate.api.nvidia.com` gateway rather than only on self-run NIM
containers is **⚠ unverified**. Independently, reliability trackers flag Nano 9B v2's
instruction-following as below average for agentic use. ✅

This is why the architecture puts the verdict in deterministic rules. The model supplies
only the explanation and the redirect, so unreliable JSON degrades the prose and leaves
the verdict untouched. Where structured output is needed, use
`nvext.guided_json` with server-side validation and a retry rather than trusting raw
output.

## 4. Spark fit: 128GB for both models

Decode is bandwidth-bound: `tok/s ≈ 273 GB/s ÷ (active params × bytes/param)`. But GB10
(`sm_121`) has **no native FP4 tensor-core compute**, so NVFP4 runs through a `marlin`
fallback and throughput lands well below the arithmetic. ✅ Prefer measured numbers
over the formula wherever both exist.

| Model | Footprint | Fits alone? | Est. decode |
|---|---|---|---|
| Nano 9B v2 | ~9GB FP8 / ~4.5GB INT4 | yes, easily | ~30 tok/s FP8 (arithmetic) |
| Nano-30B-A3B | ~15–19GB NVFP4 | yes, comfortably | **~56 tok/s measured on real Spark** ✅ |
| Super-49B-v1.5 | ~49GB FP8 | yes, tight at BF16 | ~5.6 tok/s; **too slow, rule out** |
| Super-120B-A12B | ~60–67GB NVFP4 | yes, little headroom | ~15–20 tok/s realistic |
| Ultra-550B-A55B | ~330GB+ NVFP4 | **no** | needs 4× Spark |

**Pairing options within 128GB:**

| Pair | Total | Verdict |
|---|---|---|
| Nano-30B-A3B (agent) + Nano 9B v2 (policy) | ~28GB + KV | Safest. Lots of headroom. "One family, two tiers." |
| Super-120B-A12B (agent) + Nano 9B v2 (policy) | ~75GB + KV | Feasible, more impressive, tighter. NVIDIA publishes a single-Spark NVFP4 guide for the 120B ✅ |
| anything + Super-49B | n/a | ruled out on latency |

## 4b. Measured: reasoning suppression and probe latency

Measured 2026-08-03 against `integrate.api.nvidia.com` on the real policy-decision prompt
(~200 tokens of context, asking for a two-sentence denial plus a redirect choice). These
are our own numbers, not anyone's documentation.

| Model | Directive | Latency | Completion tokens | Output |
|---|---|---|---|---|
| `nemotron-3-nano-30b-a3b` | none | 3.19s | 272 | reasoning trace |
| `nemotron-3-nano-30b-a3b` | `/no_think` | 0.95s | 44 | **leaks scratchpad into the answer** |
| `nemotron-3-nano-30b-a3b` | `detailed thinking off` | 1.54s | 89 | clean |
| `nvidia-nemotron-nano-9b-v2` | none | 3.99s | 231 | reasoning trace |
| `nvidia-nemotron-nano-9b-v2` | **`/no_think`** | **1.17s** | **52** | **clean, no trace** |
| `nvidia-nemotron-nano-9b-v2` | `detailed thinking off` | 5.62s | 297 | reasoning trace |

**The directive is model-specific and the two Nano models disagree.** `/no_think` on the
30B leaks its scratchpad into user-visible content, opening with *"We need to produce two
sentences: first expl…"*. On the 9B, `/no_think` suppresses cleanly, while
`detailed thinking off` is 5× slower. Same family, same generation, opposite answers, and
no way to know which without measuring.

Bare probe latency (`"Say OK"`, no `max_tokens`, non-streaming: the shape `nemoclaw
onboard` sends against a 15s budget):

| Model | Latency | Verdict |
|---|---|---|
| `nvidia/nemotron-3-nano-30b-a3b` | **0.76s** | comfortably clears the cliff |
| `nvidia/nemotron-3-super-120b-a12b` | 1.90s | clears |
| `nvidia/nvidia-nemotron-nano-9b-v2` | 5.62s | clears, thin margin (299 tokens on "Say OK") |
| `nvidia/llama-3.1-nemotron-nano-8b-v1` | **timed out at 90s** | unusable |
| `meta/llama-3.1-8b-instruct` | 0.51s | *(baseline only — dropped, see below)* |

So the onboard probe model is now `nvidia/nemotron-3-nano-30b-a3b`, which makes the whole
path NVIDIA. **No Meta model remains anywhere in the stack.**

## 4c. Measured at eval scale: the metric that decides between models

§4b was one sample per cell, enough to pick a direction. The eval set supersedes it, and it
changed which metric we watch.

**Denominators in this section are 34, because that is how many scored cases existed when
these runs happened on 2026-08-05.** The set is 36 scored now. Figures below are left as
measured rather than rescaled; §4d has the current run.

**Decision and rule accuracy came out at 100% for both models. Neither model earned that.**
The deterministic engine decides; the model writes the explanation. Two very different
models scoring identically is the design working, and quoting it as model performance
would be misleading.

The genuine model-quality signal is whether the model finishes at all:

| | token-ceiling hits | p50 | p95 | mean completion tokens |
|---|---|---|---|---|
| `nvidia-nemotron-nano-9b-v2` + `/no_think` | **0 / 34** | ~1.2s | ~1.5–2.1s | ~57 |
| `nemotron-3-nano-30b-a3b` + `detailed thinking off` | **5 / 34** (15%, second run — 8 on the first) | ~2.0–2.4s | **6.58s** | ~248 |

A token-ceiling hit means the model spent its whole budget deliberating and truncated
mid-sentence. One trace ends at *"As a sanctioned alternative,"* and never names it.

Two findings:

**Prompt shape moved the leak rate more than the model did.** The 30B hit the ceiling on
**18 of 34 (53%)** when asked to pick one of N redirects verbatim, and 5 to 8 (depending on
the run) when handed a single already-chosen alternative to describe. Same model, same
suppression directive. Ask a reasoning model to choose and it reasons; give it something to
narrate and it narrates.

**Suppression on the 30B is inconsistent rather than absent.** §4b measured 89 completion
tokens on one sample with `detailed thinking off`; at scale the mean is ~248. Intermittent
suppression is worse than none, because it passes rehearsal and fails on stage.

There was also one clean model failure on the 9B: it stated *"There is no sanctioned
alternative available for this request"* when the policy offered two, then answered the
identical prompt correctly on a rerun. That is why redirect selection has been moved out of
the model entirely and given a deterministic fallback, rather than trusted and monitored.

## 4d. The ladder, four models, 2026-08-13

Run on the current 37-case set, each model with the suppression mechanism measured for it by
`eval/probe_directive.py`. From `eval/results/*/summary.json`.

**Why 36 scored and `/37` denominators.** One case is `enforced_by` the sandbox rather than the
gateway, so it is excluded from the accuracy counts, which leaves 36 scored. The fallback and
failure columns below are over all 37, because the harness divides those by every case it attempted:
a model that cannot answer has failed to answer whether or not the gateway was the thing under
test. Both denominators are correct and they are measuring different things.

| | ceiling hits | served from fallback | call failures | mean tokens | p50 | p95 |
|---|---|---|---|---|---|---|
| `llama-3.1-nemotron-nano-8b-v1` (none) | 0 | **27 / 37** | **27** | 84.3 | 1574 ms | 2244 ms |
| **`nvidia-nemotron-nano-9b-v2`** (`/no_think`) | **0** | **0** | **0** | **57.6** | **1108 ms** | **1937 ms** |
| `nemotron-3-nano-30b-a3b` (`detailed thinking off`) | 7 | 7 / 37 | 0 | 238.0 | 2852 ms | 6240 ms |
| `nemotron-3-super-120b-a12b` (`enable_thinking: false`) | 0 | 3 / 37 | 3 | 84.8 | 36308 ms | 51320 ms |

Decision accuracy and rule accuracy were 100% for all four, and that is the point of §4c
restated: the 8B scored 100% on both while failing to answer 73% of the time. Any gate written
on those two numbers would have passed a model that mostly cannot reply.

**The 9B wins on every measure that is stable, and it is the smallest of the four.** Zero
truncations, zero fallbacks, zero failures, and a quarter of the 30B's tokens. That is the
opposite of the expected shape, and it is the whole argument for a small sovereign policy brain:
the model is narrating a decision it did not make, so there is very little for capability to buy.

### Two caveats

**The 8B is unusable on this endpoint, and the repo had already found that once.** §4b recorded
it as timing out at 90s during the onboard-probe work. This run reproduces it at scale: 27 of 37
calls hit the 60s read timeout, each after a retry, so about 54 hung attempts. The 10 answers it
did return were fine. This is a statement about the model on `integrate.api.nvidia.com` today,
not about its weights; a self-hosted NIM might behave completely differently. Either way it
cannot be measured here, so it cannot be chosen here.

**Do not quote the 120B's latency. It is not a property of the model.** The same model, same
prompt, same suppression body returned in **5.97s** during the directive probe and **48-57s**
when re-tested a few hours later, with token counts unchanged at 85-87. So the p50 of 36s above
is hosted free-tier queueing, and it swung roughly tenfold within one day. Verified that the
suppression was genuinely applied throughout: with the chat-template body the answer costs 87
completion tokens, without it 162.

What that means in practice: **token counts, ceiling hits and fallback rates from this table are
trustworthy; absolute latencies for the large model are not.** The 9B's latency is stable across
runs (p95 1937 ms here against 1613 ms on 2026-08-05), which is its own small argument for
choosing a model whose numbers hold still.

## 5. Working choices

§4d is the evidence for the policy brain: four models across the current 37-case set, on one
day, with the suppression mechanism measured per model.

- **Policy brain: `nvidia/nvidia-nemotron-nano-9b-v2` with a `/no_think` system
  directive.** §4d is the case for it and §4c is where it started. Zero ceiling hits, zero
  fallbacks and zero call failures over 37 cases, against 7 fallbacks for the 30B and 27 for
  the 8B. The 9B did that on a quarter of the 30B's tokens, and with the only latency in the
  table that held still across two dated runs. Dense, so simpler to debug live than an MoE; documented
  tool-call parser; and NVIDIA ships a DGX-Spark-specific NIM container, albeit in
  `nvstaging`. The 30B remains the better raw Spark throughput number, which matters for the
  agent brain and not for this role.
- **Agent brain: `nvidia/nemotron-3-super-120b-a12b`**, hosted for Phase 1. Roughly 4–5×
  less bandwidth per token than Ultra-550B, same GTC-2026 family so the narrative stays
  coherent. If live timing gets tight, fall back to Nano-30B-A3B for both roles: a less
  impressive number and a much safer demo.

  **§4d's finding against the 120B does not touch this choice, though the two sections can look
  as though they disagree.** §4d disqualifies the 120B's *measured latency* (36s p50 on a hosted
  free tier that returned 5.97s for the same prompt hours earlier) and records 3 call failures
  out of 37. Both are statements about a queue, not about the weights. Neither is evidence
  about the agent brain, which is a different role on different hardware. The agent brain runs
  the conversation on the Spark, where there is no shared free-tier queue to sit behind. The
  policy brain has to answer inside every single gateway call. The reason the 120B is not
  the policy brain is §6.2 and not §4d anyway: its `enable_thinking: false` flag does not travel
  through n8n's `lmChatNvidia` node, so its reasoning trace cannot be switched off on the path
  the gateway uses. What §4d
  does add to the agent-brain decision is a caution rather than a veto: until the 120B has been
  measured somewhere without that queue in front of it, treat the fallback to Nano-30B-A3B as
  live rather than theoretical.
- **Onboard probe model: `nvidia/nemotron-3-nano-30b-a3b`** (0.76s vs the 15s cliff).
  Replaces the Meta model that was there before; the stack is now all-NVIDIA.

Weighting note: §6.2 strengthens the Nano case considerably. Through n8n's node, reasoning
is suppressed with a prompt control token, and that mechanism is documented for Nano but
not for Super. Being able to switch the thinking trace off reliably is a hard requirement
for a model running live, which is what tips the choice to Nano.

## 6. n8n wiring: settled against the live instance

All verified by reading n8n 2.32.7 in the running container rather than from documentation.

**Use `@n8n/n8n-nodes-langchain.lmChatNvidia` (v1).** It exists, it's first-party, and it
takes a dedicated **`nvidiaApi`** credential, so we can drop the old demo's hand-rolled
`create_nvidia_credential.js` AES encryption script entirely.

### 6.1 The credential *is* the Phase 6 migration

```
Base URL  (required)  default: https://integrate.api.nvidia.com/v1
                      "…or change it to point at a self-hosted NIM
                       container (e.g. http://localhost:8000/v1)"
API Key   (optional)  "Leave blank for a self-hosted NIM that does
                       not require authentication"
```

That is the whole cloud-to-sovereign migration: **change one field in one credential and
blank the key.** No workflow edits, no code change, no redeploy. The governance logic
neither knows nor cares where the model runs.

### 6.2 Two constraints the node imposes

**Structured output.** `responseFormat` offers `text` and `json_object`. The node does not
carry `nvext.guided_json`, so guided decoding is not available on this path. That settles the
third bullet in §9's resolved list at the client rather than at the gateway.

This suits the design: the policy brain returns prose and the rules return the verdict, so
nothing depends on schema-guaranteed JSON. A workflow that did need it would use an HTTP
Request node rather than the LLM node.

**No reasoning toggle.** The node exposes `frequencyPenalty`, `maxTokens`,
`responseFormat`, `presencePenalty`, `temperature`, `timeout`, `maxRetries` and `topP`,
and nothing else. There is no `enable_thinking` and no `chat_template_kwargs`.

This is the finding that should drive model choice. Reasoning can only be suppressed from
inside the prompt, via a control token. That works for the **Nano** family (`/no_think` is
documented) but the `enable_thinking: false` chat-template flag used by the **Super**
models is not reachable from this node at all. So a Nano model isn't merely the fast
choice for the policy brain: it is the one whose reasoning we can actually turn off
through the tooling we're using.

Also: `maxTokens` defaults to `-1` (model default), `timeout` to 360000ms, `maxRetries`
to 2. Set `maxTokens` explicitly, always.

### 6.3 One report we sidestep

There's a report of `400 (no body)` from NVIDIA endpoints under n8n's **Agent** node. ✅
Our gateway calls the model from a plain LLM node inside a decision sub-workflow, not an
Agent node, so we likely never meet it. Recognise it if it appears.

## 7. Self-hosting path (Phase 6)

- Nano 9B v2: `nvcr.io/nvstaging/nim/nvidia-nemotron-nano-9b-v2-dgx-spark:1.0.0-variant` ✅
  (`nvstaging` = preview; budget validation time)
- Super-120B-A12B: `nvcr.io/nim/nvidia/nemotron-3-super-120b-a12b-turbo:1.0.0`, ARM64
  supported, with an official single-Spark NVFP4 deployment guide ✅
- General path: `nvcr.io/nvidia/vllm:26.04-py3` or `vllm/vllm-openai:nightly`. Stable
  PyPI vLLM lacks GB10 support. NVFP4 MoE needs `--moe-backend marlin`. ✅
- Ollama has an open regression against Nano 9B v2; least mature path. ✅
- Access: NVIDIA Developer Program + a **Personal** NGC API key (legacy keys are
  rejected), plus per-model click-through terms. ✅

## 8. Operational gotchas

- **Free tier is ~40 req/min per model** (community-sourced, not an SLA) ⚠. The 37-case set
  across the 4 models in §4d is 148 calls, which is fine (the harness throttles itself to
  roughly one call every 1.7s and runs sequentially), but don't hammer it during rehearsal on
  show day. Cache eval results; never re-run for a slide.
- Always set `max_tokens` explicitly. ✅
- Always suppress reasoning explicitly. ✅
- Personal NGC key, not legacy. ✅

## 9. Verification status

Resolved against the live n8n 2.32.7 container:

- ✅ Nano-30B-A3B ID is `nvidia/nemotron-3-nano-30b-a3b`.
- ✅ `lmChatNvidia` exists, v1, credential type `nvidiaApi` with a Base URL field
  explicitly intended for self-hosted NIM.
- ✅ `nvext.guided_json` does not travel through the node. Moot; see §6.2.
- ✅ Reasoning can only be suppressed via prompt control token → favours Nano.

Also resolved by measurement (§4b):

- ✅ `/no_think` cleanly suppresses on Nano 9B v2; on Nano-30B-A3B it leaks scratchpad
  into content, and that model wants `detailed thinking off` instead.
- ✅ Single-sample latency for both policy-brain candidates on the real prompt.
- ✅ An all-NVIDIA path exists for the onboard probe.

Since answered by the deployed gateway and by §4c/§4d:

- ✅ `/no_think` does survive `lmChatNvidia`'s system-prompt plumbing. The deployed decision
  workflow passes the directive through, and the end-to-end run agrees with the oracle on 36 of
  36 scored cases with zero invented redirects ([EVALS.md](EVALS.md) §3.1). A directive being
  swallowed would have shown up as the reasoning trace eating the budget and the fallback rate
  climbing, and it did not.
- ✅ p50/p95 across the whole set, and decision and rule accuracy, for four models rather than
  one sample per cell. §4c and §4d. Read §4d's caveat before quoting the large model's latency.

Still open:

1. Whether the `nvstaging` Nano 9B v2 Spark container is usable (Phase 6).
