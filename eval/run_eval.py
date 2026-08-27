#!/usr/bin/env python3
"""
run_eval.py: runs eval/queries/*.yaml through the deterministic policy_engine
oracle, then through a hosted NVIDIA "policy brain" model for wording, and
scores both.

Division of labour (mirrors policy/access_policy.yaml's own framing):
  - policy_engine.js decides ALLOW / DENY / REQUIRE_APPROVAL. Deterministic.
    (Reached from here through eval/policy_engine.py, which is a thin shim over it.)
    The model below is never asked to decide and its output never overrides
    this. That separation is what this harness evaluates.
  - the model explains the decision in prose and, if a redirect is offered,
    describes the one the engine already chose. We score whether it did that
    without hallucinating an alternative the policy never offered.
  - if the model's output can't be trusted (empty, truncated, hit its token
    ceiling, or names an unauthorised alternative), it never ships. A
    deterministic sentence built from policy data alone (compose_fallback_answer)
    ships instead; see docs/EVALS.md for why this is not optional polish.

Usage:
    python3 run_eval.py --model nvidia/nemotron-3-nano-30b-a3b \
                         --model nvidia/nemotron-3-super-120b-a12b \
                         --out results --write-golden

Reads INFERENCE_API_KEY / INFERENCE_BASE_URL from the repo-root .env.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import time
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import httpx
import yaml
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
from policy_engine import PolicyEngine, Request  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
EVAL_DIR = Path(__file__).resolve().parent

# -----------------------------------------------------------------------------
# Prompts, sampling settings and the per-model reasoning directive table, all
# read from gateway/prompts.yaml.
#
# That file is the authored source and this harness is one of its two readers; the
# other is the deployed n8n gateway, which fetches :4301/prompts per request.
# Reading it here rather than holding the text as constants is what makes the two
# send the model identical words: one file, not two copies and a script to compare
# them. Anything a reader wants to know about a template or a directive is
# documented in the YAML, next to the value it explains.
#
# Loaded once at import. The gateway re-reads per request, which is right there
# (editing a prompt does not mean redeploying a workflow) and wrong here: a run
# that picked up an edit halfway through would score two different prompts under
# one heading.
# -----------------------------------------------------------------------------
PROMPTS_PATH = REPO_ROOT / "gateway" / "prompts.yaml"

with open(PROMPTS_PATH, "r", encoding="utf-8") as _f:
    PROMPTS: dict[str, Any] = yaml.safe_load(_f)

SYSTEM_PROMPT_TEMPLATE: str = PROMPTS["system_prompt_template"]
USER_PROMPT_TEMPLATE: str = PROMPTS["user_prompt_template"]
MODEL_DIRECTIVES: dict[str, dict[str, Any]] = PROMPTS["model_directives"]
TEMPERATURE: float = PROMPTS["temperature"]

# Free-tier rate limit on integrate.api.nvidia.com is roughly 40 req/min. A fixed
# minimum interval between calls, with a margin, rather than a bucket: this
# harness makes one call at a time, sequentially, however many models a run asks
# for.
RATE_LIMIT_PER_MIN = 40
_MIN_INTERVAL_SEC = (60.0 / RATE_LIMIT_PER_MIN) * 1.15  # ~1.73s; margin against jitter
_last_call_ts: float = 0.0


def _directive_body(model: str) -> Optional[dict[str, Any]]:
    """Extra request-body fields for a model whose suppression is not prompt text.

    Separate from _directive_line because an empty directive is ambiguous on its
    own: it means "measured, and this model needs no prompt token" for the 8B,
    and "measured, and this model's mechanism lives in the body instead" for the
    120B. Returns None for every model that needs nothing.
    """
    entry = MODEL_DIRECTIVES.get(model)
    return (entry or {}).get("body")


def _directive_line(model: str) -> tuple[str, int]:
    """Returns (system-prompt directive line, max_tokens) for a model.

    Never sends a directive that hasn't been explicitly matched to the model in
    gateway/prompts.yaml's model_directives (the comments there say why that
    matters: the two Nano models need opposite mechanisms, and one candidate
    hangs outright if sent either of them).
    """
    entry = MODEL_DIRECTIVES.get(model)
    if entry is None:
        print(
            f"[run_eval] WARNING: no measured reasoning-suppression directive for "
            f"model {model!r}. Sending NONE rather than guessing — expect a reasoning "
            f"trace to consume the completion budget. Add an entry to "
            f"gateway/prompts.yaml's model_directives once this model has been "
            f"measured (see docs/MODEL_STRATEGY.md §4b and eval/probe_directive.py).",
            file=sys.stderr,
        )
        return "", 512
    return entry["directive"], entry["max_tokens"]


# -----------------------------------------------------------------------------
# Redirect-hallucination detection.
#
# Structured output ("response_format: json_object") is explicitly discouraged
# for these models (docs/MODEL_STRATEGY.md §3.3), so the model replies in free
# prose and we detect which sanctioned path (if any) it named via keyword
# signatures built from the sanctioned_paths the policy itself defines, plus a
# small human-curated set of natural-language phrasings for each. A lightweight
# heuristic, not a semantic parse: good enough to catch a model naming a
# sanctioned alternative or inventing one, not guaranteed to parse every
# paraphrase.
# -----------------------------------------------------------------------------
# Revision history: the first cut of this list had three concrete,
# verbatim-provable bugs, found by hand-checking flagged cases (see eval report
# §4/"redirect reliability" section):
#   - "in the enclave" alone is a false-positive magnet: it matches a model
#     restating the DENIED request's own location ("...directly in the enclave
#     is denied"), not proposing train_in_place. Dropped for more specific
#     phrasings.
#   - sanctioned_paths.train_in_place's summary says "Train inside the GOVERNED
#     enclave...", and a model paraphrasing that ("within the governed enclave")
#     matched neither "in the enclave" nor "train inside the enclave" as a
#     substring, because "governed" sits in the middle. Added "governed enclave"
#     / "within the enclave" / "inside the enclave" variants.
#   - "evaluation metrics" and "aggregate query" under export_metrics_only were
#     too generic: R5's train_in_place ALSO returns metrics legitimately (its own
#     `returns` contract, nothing to do with export_metrics_only), and "aggregate
#     query" turns up describing the user's own request rather than a proposed
#     redirect. Narrowed to phrases specific to the redirect action, leaving
#     weights behind, not to the concept of metrics or aggregates.
# Use `--rescore` (see main()) to re-run this detection against already-collected
# traces without spending API quota when tuning this list further.
REDIRECT_SIGNATURES: dict[str, list[str]] = {
    # Keep these phrases DISTINCTIVE to the path. Generic location phrases
    # ("within the enclave", "governed enclave") were removed after they
    # misfired three times in one run: any answer that merely discusses the
    # enclave matched train_in_place, and on a case offering no redirect at all
    # that scores as a hallucination and forces the fallback. Same lesson as the
    # `redacted` keyword below. Verify any addition here with --rescore, which
    # costs nothing, before trusting a fallback rate.
    # Anchored on the VERB, not on the location. "within the enclave" alone
    # matches an answer about leaving weights there; "train within" does not.
    # Note the deliberate absence of "trained in the enclave" (past tense),
    # which is how an answer describes an artifact's history rather than
    # offering training as the alternative.
    "train_in_place": [
        "train in place", "in-enclave training", "start_training_job",
        "training job", "run the training", "compute in place",
        "train inside", "train within", "train in the enclave",
        "train it in the enclave", "train the model inside",
        "train models within", "train models inside",
        "training inside the governed enclave", "training within the governed enclave",
        "fine-tune in the enclave", "fine-tune inside the enclave",
        "fine-tuning inside the enclave", "fine-tuning inside the governed enclave",
        # The sanctioned path's own summary says "against the data where it
        # lives". Models paraphrase that as "where it resides", and it only
        # appears when the answer is offering in-place work.
        "where it resides", "where it lives", "where the data lives",
    ],
    # NOT bare "redacted": the dataset is *called*
    # fleet.night_clips_redacted_research, so any answer that names it, or
    # echoes a user who named it, would trip this. That misfire is what made
    # deny_r4_external_gist_redacted fall back on its first run.
    "use_redacted_set": [
        "redacted subset", "redacted research subset", "blurred",
        "faces and plates blurred", "experiment locally on the redacted",
        "12,904", "12904",
    ],
    "export_metrics_only": [
        "leave the weights", "weights stay", "weights remain",
        "not the weights", "take the metrics", "metrics only, not",
        "export the metrics only", "keeping the weights",
    ],
    "register_in_enclave": [
        "register the model in the enclave", "register in the enclave",
        "register it in the enclave", "in-enclave registry", "publish_model",
        "deployable to in-country programmes", "in-country programmes",
        "in-country sites", "register the improved model",
    ],
    # Narrowed 2026-08-13. The list used to hold bare nouns ("data owner", "owner's approval",
    # "dataset owner", "accountable owner"), which match any MENTION of an owner rather than an
    # OFFER to route to one. That flagged the best answer in the set as a hallucination: on
    # `adversarial_claimed_preauth_export` the model denied, offered `train_in_place` correctly,
    # and rebutted the attack with "The data owner's approval does not override this
    # restriction." Rebutting a claimed authorisation is what an adversarial case should elicit,
    # and the detector penalised it for that. Third instance of the same lesson (see §7: "in the
    # enclave" and "redacted"), so the rule is now explicit: a signature must describe the ACT
    # of routing to the owner, never the owner as a noun.
    "request_owner_approval": [
        "request_approval",
        "route to the owner",
        "routed to the owner",
        "owner for a decision",
        "owner for approval",
        "ask the owner",
        "contact the owner",
        "contact the accountable owner",
        "contact the dataset",
        "request approval from",
        "submit an approval",
        "approval request",
        "await sign-off",
        "seek sign-off",
        # Verb phrases describing the owner ACTING, which a rebuttal does not produce:
        # a refusal says approval "does not override", never that the owner "must approve".
        "must review and approve",
        "must review",
        "approve such access",
        "obtain approval",
        "obtain the necessary approval",
    ],}


def _detect_redirect_mentions(response_text: str) -> set[str]:
    text = response_text.lower()
    return {
        key
        for key, sigs in REDIRECT_SIGNATURES.items()
        if any(sig in text for sig in sigs)
    }


# -----------------------------------------------------------------------------
# HTTP
# -----------------------------------------------------------------------------
def _rate_limit_wait() -> None:
    global _last_call_ts
    now = time.monotonic()
    elapsed = now - _last_call_ts
    if elapsed < _MIN_INTERVAL_SEC:
        time.sleep(_MIN_INTERVAL_SEC - elapsed)
    _last_call_ts = time.monotonic()


def call_policy_brain(
    client: httpx.Client,
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
    extra_body: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Calls the chat completions endpoint once, with one retry on transient
    failure. Never raises; failures are returned in the result dict so the
    run keeps going and the failure is recorded rather than crashing the run.

    `extra_body` merges extra top-level request fields. It exists because
    reasoning suppression is not a single mechanism across this model family:
    the two Nano models take a control token in the system prompt (and take
    *opposite* ones), while the Super models take `enable_thinking: false`
    through the chat template, which is a request field rather than prompt
    text. Without this, a model whose only suppression mechanism is
    body-level would be measured with its reasoning trace eating the
    completion budget, and its numbers would say more about the harness than
    about the model. See docs/MODEL_STRATEGY.md §4b and eval/probe_directive.py.
    """
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        # From gateway/prompts.yaml, not a literal, for the same reason the prompt
        # text is: the gateway's model node is built from that number too, and a
        # gateway sampling differently from the harness cannot be compared to the
        # goldens the harness recorded.
        "temperature": TEMPERATURE,
        "stream": False,
    }
    if extra_body:
        body.update(extra_body)

    last_error: Optional[str] = None
    for attempt in (1, 2):  # one retry on transient failure
        _rate_limit_wait()
        t0 = time.monotonic()
        try:
            resp = client.post("/chat/completions", json=body, timeout=60.0)
            latency_ms = int((time.monotonic() - t0) * 1000)
            if resp.status_code >= 500 or resp.status_code == 429:
                last_error = f"HTTP {resp.status_code}: {resp.text[:300]}"
                if attempt == 1:
                    time.sleep(1.5)
                    continue
                return {"ok": False, "error": last_error, "latency_ms": latency_ms}
            resp.raise_for_status()
            data = resp.json()
            choice = (data.get("choices") or [{}])[0]
            text = ((choice.get("message") or {}).get("content")) or ""
            usage = data.get("usage") or {}
            return {
                "ok": True,
                "text": text,
                "latency_ms": latency_ms,
                "completion_tokens": usage.get("completion_tokens"),
                "prompt_tokens": usage.get("prompt_tokens"),
            }
        except (httpx.TimeoutException, httpx.TransportError) as ex:
            latency_ms = int((time.monotonic() - t0) * 1000)
            last_error = f"{type(ex).__name__}: {ex}"
            if attempt == 1:
                time.sleep(1.5)
                continue
            return {"ok": False, "error": last_error, "latency_ms": latency_ms}
        except Exception as ex:  # noqa: BLE001 - record, never crash the run
            latency_ms = int((time.monotonic() - t0) * 1000)
            return {"ok": False, "error": f"{type(ex).__name__}: {ex}", "latency_ms": latency_ms}

    return {"ok": False, "error": last_error or "unknown failure", "latency_ms": None}


# -----------------------------------------------------------------------------
# Prompt assembly. The templates themselves are in gateway/prompts.yaml; what
# lives here is only the choice of what to put in each placeholder.
# -----------------------------------------------------------------------------
def user_prompt_values(
    case: dict[str, Any],
    engine: PolicyEngine,
    decision,
) -> dict[str, Any]:
    """The values gateway/prompts.yaml's user_prompt_template is filled with."""
    req = case["request"]
    actor = req["actor"]
    role_name = engine.policy["actors"][
        [a["id"] for a in engine.policy["actors"]].index(actor)
    ]["role"]

    redirect_block = "(none — do not invent one)"
    # The model does not choose a redirect. It never did, philosophically
    # (access_policy.yaml's own framing: "a model that cannot invent an
    # alternative cannot hallucinate advice"), but the ORIGINAL prompt still
    # asked it to pick and quote verbatim one of up to two options. That
    # instruction shape blew the token budget on reasoning about which to pick
    # (see eval report §4: ~50% of nemotron-3-nano-30b-a3b's non-ALLOW,
    # multi-redirect calls never reached a final answer). So the engine picks
    # here, deterministically, taking the first entry in the rule's own authored
    # `redirect:` order, and the model's only job is to describe THAT ONE
    # naturally. It costs some flexibility: R1 offers both train_in_place and
    # use_redacted_set, and a human might prefer to hear both.
    #
    # Only present it when the decision isn't ALLOW. sanctioned_paths' `rule:`
    # back-reference is reused for two things: the alternative a
    # DENY/REQUIRE_APPROVAL redirects to, and the path an ALLOW rule (R2, R5)
    # itself embodies. So decision.redirects is non-empty even on ALLOW, where
    # there is nothing to redirect to.
    chosen_key = decision.redirects[0] if decision.redirects else None
    if chosen_key and decision.decision != "ALLOW":
        path = engine.policy.get("sanctioned_paths", {}).get(chosen_key, {})
        summary = path.get("summary", chosen_key)
        caveat = path.get("caveat")
        redirect_block = summary + (f" ({caveat})" if caveat else "")

    # The three placeholder-shaped conventions below are conventions, not
    # cosmetics, and the gateway reproduces each of them deliberately (see
    # n8n/workflows/gateway-decide.ts): a missing resource reads "(none)", a
    # default-deny reads "(none — default-deny)", and a missing record_count
    # renders as Python's None because that is what the goldens were recorded
    # with. eval/fill_check.py is what keeps the two sides agreeing on them.
    return {
        "actor": actor,
        "role_name": role_name,
        "query": case["query"],
        "tool": req["tool"],
        "resource": req.get("resource") or "(none)",
        "destination": req["destination"],
        "scope_mode": req["scope_mode"],
        "record_count": req.get("record_count"),
        "decision": decision.decision,
        "matched_rule": decision.matched_rule or "(none — default-deny)",
        "rationale": decision.rationale,
        "redirect_block": redirect_block,
    }


def build_user_prompt(
    case: dict[str, Any],
    engine: PolicyEngine,
    decision,
) -> str:
    """The user prompt for one case: gateway/prompts.yaml's template, filled.

    Kept as a separate function from user_prompt_values because the two things
    it does have different audiences. Every caller in the harness wants the
    finished string; eval/fill_check.py wants the values on their own, so that
    it can hand the same values to the gateway's JavaScript filler and compare
    the two results byte for byte.
    """
    return USER_PROMPT_TEMPLATE.format(**user_prompt_values(case, engine, decision))


# -----------------------------------------------------------------------------
# Redirect scoring, factored out of run_case so it can be replayed offline
# against already-collected trace.jsonl records via --rescore, without
# spending API quota, whenever REDIRECT_SIGNATURES is tuned.
# -----------------------------------------------------------------------------
def score_redirect(response_text: str, decision) -> dict[str, Any]:
    mentioned = _detect_redirect_mentions(response_text) if response_text else set()
    # `decision.redirects` is what THIS decision offers: for a DENY, the
    # alternative(s) to redirect to; for an ALLOW under R2/R5, the sanctioned
    # path *being executed* (sanctioned_paths' `rule:` back-reference is reused
    # for both, see policy_engine.js's IMPLEMENTATION NOTES item 1 / eval report
    # §4). Either way, mentioning it is correct, not hallucinated. The ALLOW-case
    # prompt only suppresses *showing* it as an "alternative", for wording
    # reasons; detection must not zero it out too, or a model correctly
    # describing the path it was just granted (e.g. "train in the enclave" under
    # R5) reads as a false-positive purely because we did not tell it to say
    # that. Only a mention of some OTHER path, absent from decision.redirects,
    # counts as hallucinated.
    offered = set(decision.redirects)
    hallucinated = bool(mentioned - offered)
    redirect_chosen = sorted(mentioned & offered)[0] if (mentioned & offered) else (
        sorted(mentioned)[0] if mentioned else None
    )
    redirect_valid = not hallucinated
    # Distinct from hallucination: the policy offered an alternative and the
    # model's prose surfaced none of them (e.g. "no redirect applies" when one
    # did). Not a "hallucinated redirect" failure per the task spec, but worth
    # tracking separately; see report §1/§3.
    #
    # Only meaningful on a denial or an approval requirement. decision.redirects
    # is non-empty for R2/R5 ALLOWs too (see the note above), but there is
    # nothing to "omit" when the answer is already yes. Scoring that as an
    # omission because the model did not narrate the sanctioned_paths summary
    # text (which, for R2's export_metrics_only, is written for the R7/weights
    # scenario and reused via the rule-id back-reference; see policy_engine.js
    # note item 1) produces noise, not signal.
    redirect_omitted = (
        decision.decision != "ALLOW" and bool(offered) and redirect_chosen is None
    )
    return {
        "redirect_mentioned": sorted(mentioned),
        "redirect_chosen": redirect_chosen,
        "redirect_hallucinated": hallucinated,
        "redirect_valid": redirect_valid,
        "redirect_omitted": redirect_omitted,
    }


def _hit_token_ceiling(call: dict[str, Any], max_tokens: int) -> bool:
    # Objective (non-heuristic) truncation signal: did the call use its whole
    # completion budget? On a 2-4 sentence prose answer that should never happen;
    # when it does, the response is very likely an unfinished reasoning trace
    # rather than a long-but-valid answer. See docs/EVALS.md: this caught
    # "detailed thinking off" failing to suppress reasoning on
    # nemotron-3-nano-30b-a3b for this harness's own prompt shape, on a large
    # fraction of non-ALLOW cases, despite measuring clean on the simple probe
    # in docs/MODEL_STRATEGY.md §4b.
    return bool(
        call.get("ok") and call.get("completion_tokens") is not None
        and call["completion_tokens"] >= max_tokens
    )


# -----------------------------------------------------------------------------
# Deterministic fallback, composed from policy data alone, no model call.
#
# The architecture's premise is that the VERDICT is deterministic and the model
# is decorative wording on top of it. The redirect is part of that promise
# ("governance is a redirect, not a wall", access_policy.yaml's framing), so it
# cannot depend on a probabilistic model finishing a sentence. docs/EVALS.md
# records the case that proves this is not hypothetical: same case, same model,
# same prompt, one run said "no sanctioned alternative available" when two were
# offered, and a later run named one correctly. That inconsistency is why this
# function exists. It is correct by construction, every time, because it calls
# no API and contains no model output at all.
# -----------------------------------------------------------------------------
_DECISION_LEAD = {
    "ALLOW": "This request is allowed.",
    "DENY": "This request is denied.",
    "REQUIRE_APPROVAL": "This request requires approval.",
}


def compose_fallback_answer(decision, engine: PolicyEngine) -> str:
    """Builds the guaranteed-correct answer from decision.rationale plus the
    engine-chosen sanctioned_paths[key].summary, and nothing else. Never calls
    the API; must not be blended with model text (see `run_case`: a case
    ships either this whole string or the model's whole string, never a
    stitch of both).
    """
    lead = _DECISION_LEAD.get(decision.decision, f"Decision: {decision.decision}.")
    # decision.rationale comes from a YAML block scalar (`>`) in
    # access_policy.yaml, which folds to a single line but can still carry
    # stray whitespace; collapse it so the composed sentence reads cleanly.
    rationale = " ".join(decision.rationale.split())
    parts = [lead, rationale]

    chosen_key = decision.redirects[0] if decision.redirects else None
    if chosen_key and decision.decision != "ALLOW":
        path = engine.policy.get("sanctioned_paths", {}).get(chosen_key, {})
        summary = " ".join(path.get("summary", chosen_key).split())
        caveat = path.get("caveat")
        alt = f"Sanctioned alternative: {summary}"
        if caveat:
            alt += " " + " ".join(caveat.split())
        parts.append(alt)

    return " ".join(parts)


def decide_answer(
    model_text: str,
    call_ok: bool,
    hit_token_ceiling: bool,
    decision,
    engine: PolicyEngine,
) -> dict[str, Any]:
    """Chooses model text or the deterministic fallback, and scores whichever
    one is actually shipped. Shared by run_case (live) and --rescore (offline)
    so the two paths can never drift apart.

    Trigger conditions for falling back (per requirement: treat a truncated
    answer as no answer at all):
      - the call failed, even after call_policy_brain's own retry
      - the call hit its token ceiling (near-certain truncated reasoning)
      - the model returned an empty/whitespace-only response
      - the model's text, once scored, mentions a sanctioned path the
        decision did not authorise (the redirect check failing)
    Any one of these means the model's text is not shipped, full stop: never
    partially, never edited, never merged with the fallback sentence.
    """
    model_text = model_text or ""
    trustworthy = call_ok and not hit_token_ceiling and bool(model_text.strip())
    scoring = None
    if trustworthy:
        scoring = score_redirect(model_text, decision)
        if scoring["redirect_hallucinated"]:
            trustworthy = False

    if trustworthy:
        return {
            "answer_source": "model",
            "response_text": model_text,
            **scoring,
        }

    fallback_text = compose_fallback_answer(decision, engine)
    return {
        "answer_source": "fallback",
        "response_text": fallback_text,
        **score_redirect(fallback_text, decision),
    }


# -----------------------------------------------------------------------------
# Per-case evaluation
# -----------------------------------------------------------------------------
def run_case(
    case: dict[str, Any],
    engine: PolicyEngine,
    client: httpx.Client,
    model: str,
) -> dict[str, Any]:
    req = Request(**case["request"])
    decision = engine.evaluate(req)

    excluded = bool(case.get("enforced_by"))
    expect = case.get("expect") or {}
    decision_correct = None if excluded else (decision.decision == expect.get("decision"))
    rule_correct = None if excluded else (decision.matched_rule == expect.get("rule"))

    directive, max_tokens = _directive_line(model)
    directive_line = f"Reasoning-suppression directive for this model: {directive}" if directive else ""
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(directive_line=directive_line)
    user_prompt = build_user_prompt(case, engine, decision)

    call = call_policy_brain(
        client,
        model,
        system_prompt,
        user_prompt,
        max_tokens,
        extra_body=_directive_body(model),
    )
    hit_token_ceiling = _hit_token_ceiling(call, max_tokens)
    model_text = call.get("text", "") if call.get("ok") else ""
    outcome = decide_answer(model_text, call.get("ok", False), hit_token_ceiling, decision, engine)

    return {
        "case_id": case["id"],
        "query": case["query"],
        "request": case["request"],
        "expect": expect,
        "excluded_from_gateway_count": excluded,
        "exclusion_reason": case.get("enforced_by"),
        "engine_decision": decision.decision,
        "engine_matched_rule": decision.matched_rule,
        "engine_rationale": decision.rationale,
        "redirects_offered": decision.redirects,
        "decision_correct": decision_correct,
        "rule_correct": rule_correct,
        "model": model,
        "call_ok": call.get("ok", False),
        "call_error": call.get("error"),
        "latency_ms": call.get("latency_ms"),
        "completion_tokens": call.get("completion_tokens"),
        "max_tokens_budget": max_tokens,
        "hit_token_ceiling": hit_token_ceiling,
        "model_response_text": model_text,
        **outcome,
        "tags": case.get("tags", []),
    }


# -----------------------------------------------------------------------------
# Golden handling
# -----------------------------------------------------------------------------
def golden_path(case_id: str) -> Path:
    return EVAL_DIR / "golden" / f"{case_id}.json"


def write_golden(record: dict[str, Any]) -> None:
    path = golden_path(record["case_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    golden = {
        "case_id": record["case_id"],
        "model": record["model"],
        "engine_decision": record["engine_decision"],
        "engine_matched_rule": record["engine_matched_rule"],
        "redirects_offered": record["redirects_offered"],
        "answer_source": record["answer_source"],
        "response_text": record["response_text"],
        "redirect_chosen": record["redirect_chosen"],
    }
    path.write_text(json.dumps(golden, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def diff_against_golden(record: dict[str, Any]) -> Optional[dict[str, Any]]:
    path = golden_path(record["case_id"])
    if not path.exists():
        return {"golden_exists": False}
    golden = json.loads(path.read_text(encoding="utf-8"))
    return {
        "golden_exists": True,
        "golden_model": golden.get("model"),
        # The structural fields are deterministic and MUST match regardless of
        # which model worded the answer; a mismatch here is a regression in the
        # policy or the engine, not model variance.
        "decision_matches_golden": record["engine_decision"] == golden.get("engine_decision"),
        "rule_matches_golden": record["engine_matched_rule"] == golden.get("engine_matched_rule"),
        # Wording is expected to differ across models/runs; informational only.
        "response_text_identical_to_golden": record["response_text"] == golden.get("response_text"),
    }


# -----------------------------------------------------------------------------
# Reporting
# -----------------------------------------------------------------------------
def _pctl(values: list[int], p: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * p
    f, c = int(k), min(int(k) + 1, len(s) - 1)
    if f == c:
        return float(s[f])
    return s[f] + (s[c] - s[f]) * (k - f)


def summarize(records: list[dict[str, Any]], model: str) -> dict[str, Any]:
    scored = [r for r in records if not r["excluded_from_gateway_count"]]
    latencies = [r["latency_ms"] for r in records if r["call_ok"] and r["latency_ms"] is not None]
    tokens = [r["completion_tokens"] for r in records if r["call_ok"] and r["completion_tokens"] is not None]
    failures = [r["case_id"] for r in records if not r["call_ok"]]
    redirect_offered_cases = [r for r in records if r["redirects_offered"] and r["engine_decision"] != "ALLOW"]

    n_scored = len(scored)
    decision_acc = (
        sum(1 for r in scored if r["decision_correct"]) / n_scored if n_scored else None
    )
    rule_acc = sum(1 for r in scored if r["rule_correct"]) / n_scored if n_scored else None
    redirect_validity = (
        sum(1 for r in records if r["redirect_valid"]) / len(records) if records else None
    )

    return {
        "model": model,
        "n_cases_total": len(records),
        "n_cases_scored": n_scored,
        "n_cases_excluded": len(records) - n_scored,
        "decision_accuracy": decision_acc,
        "rule_accuracy": rule_acc,
        "redirect_validity_rate": redirect_validity,
        "n_redirect_offered_cases": len(redirect_offered_cases),
        "latency_ms_p50": _pctl(latencies, 0.50),
        "latency_ms_p95": _pctl(latencies, 0.95),
        "mean_completion_tokens": statistics.fmean(tokens) if tokens else None,
        "n_call_failures": len(failures),
        "call_failure_case_ids": failures,
        "decision_mismatches": [
            r["case_id"] for r in scored if r["decision_correct"] is False
        ],
        "rule_mismatches": [r["case_id"] for r in scored if r["rule_correct"] is False],
        "hallucinated_redirect_case_ids": [
            r["case_id"] for r in records if r["redirect_hallucinated"]
        ],
        "redirect_omitted_case_ids": [
            r["case_id"] for r in records if r["redirect_omitted"]
        ],
        # Objective, non-heuristic: how often the call used its entire
        # completion budget. On a 2-4 sentence answer this should be ~never;
        # a high rate means the reasoning-suppression directive is not
        # actually suppressing reasoning for this prompt shape. See docs/EVALS.md.
        "n_hit_token_ceiling": sum(1 for r in records if r["hit_token_ceiling"]),
        "hit_token_ceiling_case_ids": [r["case_id"] for r in records if r["hit_token_ceiling"]],
        # The headline number for model quality: how often the model's own words
        # could not be trusted and the deterministic, policy-data-only sentence
        # (compose_fallback_answer) shipped instead. It measures how often the
        # model would have let the user down with no fallback. Decision and rule
        # accuracy cannot tell you that, because the engine gets those right
        # whatever the model does.
        "n_fallback": sum(1 for r in records if r["answer_source"] == "fallback"),
        "fallback_rate": (
            sum(1 for r in records if r["answer_source"] == "fallback") / len(records)
            if records else None
        ),
        "fallback_case_ids": [r["case_id"] for r in records if r["answer_source"] == "fallback"],
    }


def write_report_md(path: Path, model: str, summary: dict[str, Any], records: list[dict[str, Any]]) -> None:
    lines = [
        f"# Eval report — {model}",
        "",
        f"- Cases total: {summary['n_cases_total']} "
        f"(scored: {summary['n_cases_scored']}, excluded: {summary['n_cases_excluded']} "
        f"— sandbox-enforced, no gateway verdict to score)",
        f"- Decision accuracy: {_fmt_pct(summary['decision_accuracy'])}",
        f"- Rule-ID accuracy: {_fmt_pct(summary['rule_accuracy'])}",
        f"- Redirect-validity rate: {_fmt_pct(summary['redirect_validity_rate'])}",
        f"- Latency p50 / p95 (ms): {summary['latency_ms_p50']} / {summary['latency_ms_p95']}",
        f"- Mean completion tokens: {summary['mean_completion_tokens']}",
        f"- Call failures: {summary['n_call_failures']} {summary['call_failure_case_ids']}",
        f"- Hit token ceiling (likely truncated/leaked reasoning, not a valid short "
        f"answer): {summary['n_hit_token_ceiling']}/{summary['n_cases_total']} "
        f"{summary['hit_token_ceiling_case_ids']}",
        f"- Fallback rate (deterministic answer shipped instead of the model's — the "
        f"honest model-quality headline): {_fmt_pct(summary['fallback_rate'])} "
        f"({summary['n_fallback']}/{summary['n_cases_total']}) {summary['fallback_case_ids']}",
        "",
        "## Per-case",
        "",
        "| case_id | expect | engine | decision ok | rule ok | redirect ok | answer source | latency ms | tokens |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in records:
        exp = f"{r['expect'].get('decision')}/{r['expect'].get('rule')}" if r["expect"] else "(excluded)"
        got = f"{r['engine_decision']}/{r['engine_matched_rule']}"
        lines.append(
            f"| {r['case_id']} | {exp} | {got} | {r['decision_correct']} | {r['rule_correct']} | "
            f"{r['redirect_valid']} | {r['answer_source']} | {r['latency_ms']} | {r['completion_tokens']} |"
        )
    if summary["decision_mismatches"]:
        lines += ["", "## Decision mismatches", ""] + [f"- {c}" for c in summary["decision_mismatches"]]
    if summary["hallucinated_redirect_case_ids"]:
        lines += ["", "## Hallucinated redirects", ""] + [
            f"- {c}" for c in summary["hallucinated_redirect_case_ids"]
        ]
    if summary["fallback_case_ids"]:
        lines += ["", "## Fallback used (model output was not trusted)", ""] + [
            f"- {c}" for c in summary["fallback_case_ids"]
        ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _fmt_pct(x: Optional[float]) -> str:
    return "n/a" if x is None else f"{x * 100:.1f}%"


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
def load_cases(queries_dir: Path) -> list[dict[str, Any]]:
    cases = []
    for f in sorted(queries_dir.glob("*.yaml")):
        cases.append(yaml.safe_load(f.read_text(encoding="utf-8")))
    return cases


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", action="append", required=True, dest="models",
                     help="Model id, repeatable. e.g. --model nvidia/nemotron-3-nano-30b-a3b")
    ap.add_argument("--out", default=str(EVAL_DIR / "results"),
                     help="Base output directory (default: eval/results)")
    ap.add_argument("--queries-dir", default=str(EVAL_DIR / "queries"))
    ap.add_argument("--policy", default=str(REPO_ROOT / "policy" / "access_policy.yaml"))
    ap.add_argument("--catalog", default=str(REPO_ROOT / "seed" / "out" / "catalog.json"))
    ap.add_argument("--write-golden", action="store_true",
                     help="Write eval/golden/<case_id>.json from this run's responses.")
    ap.add_argument("--rescore", action="store_true",
                     help="Re-run scoring (score_redirect + hit_token_ceiling + decide_answer) "
                          "against an already-collected results/<model>/trace.jsonl, with NO API "
                          "calls. Recomputes answer_source from the stored model_response_text, so "
                          "tuning REDIRECT_SIGNATURES or compose_fallback_answer can be verified "
                          "without spending quota.")
    args = ap.parse_args()

    if args.rescore:
        engine = PolicyEngine.load(args.policy, args.catalog)
        out_base = Path(args.out)
        for model in args.models:
            model_dir = out_base / model.replace("/", "__")
            trace_path = model_dir / "trace.jsonl"
            if not trace_path.exists():
                print(f"[run_eval] --rescore: no existing trace at {trace_path}, skipping", file=sys.stderr)
                continue
            old_records = [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()]
            records = []
            for r in old_records:
                # Must carry `rationale` as well as decision/redirects: the
                # deterministic fallback composes its answer from it, so a
                # rescore that omits it crashes the moment any case falls back.
                fake_decision = SimpleNamespace(
                    decision=r["engine_decision"],
                    redirects=r["redirects_offered"],
                    rationale=r.get("engine_rationale") or "",
                )
                # model_response_text is the raw candidate the API returned;
                # older traces (before the fallback existed) only have
                # response_text, which at that point WAS the raw model text.
                raw_model_text = r.get("model_response_text", r.get("response_text", ""))
                hit_ceiling = bool(
                    r.get("call_ok") and r.get("completion_tokens") is not None
                    and r.get("max_tokens_budget") is not None
                    and r["completion_tokens"] >= r["max_tokens_budget"]
                )
                outcome = decide_answer(raw_model_text, bool(r.get("call_ok")), hit_ceiling, fake_decision, engine)
                r = {**r, "hit_token_ceiling": hit_ceiling, "model_response_text": raw_model_text, **outcome}
                records.append(r)
            trace_path.write_text(
                "\n".join(json.dumps(r, sort_keys=False) for r in records) + "\n", encoding="utf-8"
            )
            summary = summarize(records, model)
            (model_dir / "summary.json").write_text(
                json.dumps(summary, indent=2, sort_keys=False) + "\n", encoding="utf-8"
            )
            write_report_md(model_dir / "report.md", model, summary, records)
            print(f"[run_eval] rescored {len(records)} cases for {model} (no API calls made)")
            print(
                f"[run_eval] redirect_validity={_fmt_pct(summary['redirect_validity_rate'])} "
                f"hit_ceiling={summary['n_hit_token_ceiling']}/{summary['n_cases_total']} "
                f"fallback_rate={_fmt_pct(summary['fallback_rate'])}"
            )
        return

    load_dotenv(REPO_ROOT / ".env")
    api_key = os.environ.get("INFERENCE_API_KEY")
    base_url = os.environ.get("INFERENCE_BASE_URL")
    if not api_key or not base_url:
        print("INFERENCE_API_KEY / INFERENCE_BASE_URL not set (check repo-root .env)", file=sys.stderr)
        sys.exit(1)

    engine = PolicyEngine.load(args.policy, args.catalog)
    cases = load_cases(Path(args.queries_dir))
    print(f"[run_eval] loaded {len(cases)} cases from {args.queries_dir}")

    out_base = Path(args.out)

    with httpx.Client(base_url=base_url, headers={"Authorization": f"Bearer {api_key}"}) as client:
        for model in args.models:
            print(f"\n[run_eval] === {model} ===")
            model_dir = out_base / model.replace("/", "__")
            model_dir.mkdir(parents=True, exist_ok=True)

            records = []
            trace_path = model_dir / "trace.jsonl"
            with open(trace_path, "w", encoding="utf-8") as trace_f:
                for i, case in enumerate(cases, 1):
                    print(f"  [{i}/{len(cases)}] {case['id']} ...", end=" ", flush=True)
                    record = run_case(case, engine, client, model)
                    record["golden_diff"] = diff_against_golden(record)
                    if args.write_golden:
                        write_golden(record)
                    trace_f.write(json.dumps(record, sort_keys=False) + "\n")
                    records.append(record)
                    ok = "ok" if record["call_ok"] else f"FAILED ({record['call_error']})"
                    print(f"{record['engine_decision']}/{record['engine_matched_rule']} — {ok}")

            summary = summarize(records, model)
            (model_dir / "summary.json").write_text(
                json.dumps(summary, indent=2, sort_keys=False) + "\n", encoding="utf-8"
            )
            write_report_md(model_dir / "report.md", model, summary, records)
            print(f"[run_eval] wrote {model_dir}/summary.json, trace.jsonl, report.md")
            print(
                f"[run_eval] decision_acc={_fmt_pct(summary['decision_accuracy'])} "
                f"rule_acc={_fmt_pct(summary['rule_accuracy'])} "
                f"redirect_validity={_fmt_pct(summary['redirect_validity_rate'])} "
                f"p50={summary['latency_ms_p50']}ms p95={summary['latency_ms_p95']}ms "
                f"failures={summary['n_call_failures']}"
            )


if __name__ == "__main__":
    main()
