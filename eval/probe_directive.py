#!/usr/bin/env python3
"""Measure how to suppress a model's reasoning trace, before trusting its eval numbers.

`run_eval.py` will not guess. A model with no entry in `gateway/prompts.yaml`'s
`model_directives` gets no suppression directive at all, prints a warning, and runs with a
512-token budget, which means its reasoning trace eats the completion budget and every number
that comes out of the run describes the harness rather than the model. So a new model has to be
measured here first, and only then added to that table, which is the one the deployed gateway
reads as well.

The reason it cannot be guessed is on the record: **the two Nano models need opposite
mechanisms.** On `nano-9b-v2`, `/no_think` suppresses cleanly and `detailed thinking off`
produces a full reasoning trace. On `nano-30b-a3b` it is the other way round, and `/no_think`
leaks the scratchpad into the visible answer, opening with "We need to produce two
sentences:". Picking the wrong one does not fail loudly; it ships a model thinking out loud
to a user, on a demo whose whole argument is that the governed path is the trustworthy one.

A third mechanism exists and is not prompt text at all: the Super models take
`enable_thinking: false` through the chat template, i.e. a request body field. This probe
tests that too, because the alternative is discovering it during a scored run.

    .venv-eval/bin/python eval/probe_directive.py \
        --model nvidia/llama-3.1-nemotron-nano-8b-v1 \
        --model nvidia/nemotron-3-super-120b-a12b

**The leak flags below are heuristics and are not the measurement.** They exist to tell you
which answers to read first. The actual finding comes from reading the prose, which is why
this prints every answer in full rather than only a verdict. That is the same caution
`EVALS.md` records about the redirect keyword list: a detector fitted to the outputs it was
built against is a reading aid, not evidence.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "eval"))

import run_eval  # noqa: E402
from policy_engine import PolicyEngine, Request  # noqa: E402

# Candidate mechanisms, in the order MODEL_STRATEGY.md §4b tried them. `body` variants send
# no directive text at all.
VARIANTS: list[dict] = [
    {"name": "none", "directive": "", "body": None},
    {"name": "/no_think", "directive": "/no_think", "body": None},
    {"name": "detailed thinking off", "directive": "detailed thinking off", "body": None},
    {
        "name": "enable_thinking:false (chat template)",
        "directive": "",
        "body": {"chat_template_kwargs": {"enable_thinking": False}},
    },
]

# Openings seen on leaked scratchpads from this family, plus the obvious tag forms. Matched
# case-insensitively against the first stretch of the answer only, because a model legitimately
# writing "First, the request is denied..." mid-paragraph is not leaking.
LEAK_OPENINGS = (
    "we need to",
    "we should",
    "let me",
    "let's",
    "okay,",
    "ok,",
    "first, i",
    "the user is asking",
    "the user wants",
    "i need to",
    "thinking:",
)
LEAK_TAGS = ("<think>", "</think>", "<thinking>", "<scratchpad>", "[thinking]")

# Beat 4a: the demo's central beat, a DENY carrying a redirect. Chosen because it gives the
# model the most to reason about of any case that also has to stay short, the shape that
# provoked truncation on the 30B.
DEFAULT_CASE = "beat4a_full_export_laptop"


def looks_like_a_leak(text: str) -> list[str]:
    flags = []
    low = text.strip().lower()
    head = low[:120]
    for tag in LEAK_TAGS:
        if tag in low:
            flags.append(f"tag {tag!r}")
    for opening in LEAK_OPENINGS:
        if head.startswith(opening):
            flags.append(f"opens {opening!r}")
    return flags


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", action="append", required=True, dest="models")
    ap.add_argument("--case", default=DEFAULT_CASE, help=f"eval case id (default {DEFAULT_CASE})")
    ap.add_argument(
        "--max-tokens",
        type=int,
        default=300,
        help="completion budget; 300 is what the scored runs use",
    )
    args = ap.parse_args()

    load_dotenv(REPO_ROOT / ".env")
    import os

    api_key = os.environ.get("INFERENCE_API_KEY")
    base_url = os.environ.get("INFERENCE_BASE_URL")
    if not api_key or not base_url:
        print("✗ INFERENCE_API_KEY and INFERENCE_BASE_URL must be set in .env", file=sys.stderr)
        return 2

    import yaml

    case_path = REPO_ROOT / "eval" / "queries" / f"{args.case}.yaml"
    if not case_path.exists():
        print(f"✗ no case file at {case_path}", file=sys.stderr)
        return 2
    case = yaml.safe_load(case_path.read_text(encoding="utf-8"))

    engine = PolicyEngine.load(
        REPO_ROOT / "policy" / "access_policy.yaml",
        REPO_ROOT / "seed" / "out" / "catalog.json",
    )
    decision = engine.evaluate(Request(**case["request"]))
    user_prompt = run_eval.build_user_prompt(case, engine, decision)

    print(f"▸ case {args.case}: engine says {decision.decision} / {decision.matched_rule}")
    print(f"▸ budget {args.max_tokens} tokens, {len(args.models)} model(s)"
          f" × {len(VARIANTS)} variants\n")

    rows = []
    with httpx.Client(base_url=base_url, headers={"Authorization": f"Bearer {api_key}"}) as client:
        for model in args.models:
            for variant in VARIANTS:
                system_prompt = run_eval.SYSTEM_PROMPT_TEMPLATE.format(
                    directive_line=(f"\n{variant['directive']}" if variant["directive"] else "")
                )
                res = run_eval.call_policy_brain(
                    client,
                    model,
                    system_prompt,
                    user_prompt,
                    args.max_tokens,
                    extra_body=variant["body"],
                )
                text = res.get("text", "") or ""
                tokens = res.get("completion_tokens")
                row = {
                    "model": model,
                    "variant": variant["name"],
                    "ok": res.get("ok", False),
                    "error": res.get("error"),
                    "latency_ms": res.get("latency_ms"),
                    "completion_tokens": tokens,
                    "hit_ceiling": tokens is not None and tokens >= args.max_tokens,
                    "leak_flags": looks_like_a_leak(text),
                    "text": text,
                }
                rows.append(row)
                status = (
                    "ERROR"
                    if not row["ok"]
                    else (
                        "CEILING"
                        if row["hit_ceiling"]
                        else ("LEAK?" if row["leak_flags"] else "clean")
                    )
                )
                print(
                    f"  {model.split('/')[-1]:34s} {variant['name']:36s} "
                    f"{status:8s} {row['latency_ms']}ms {tokens} tok"
                )

    out = REPO_ROOT / "eval" / "results" / "directive_probe.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")

    print("\n" + "=" * 78)
    print("READ THESE. The flags above only say which to read first.")
    print("=" * 78)
    for row in rows:
        print(f"\n--- {row['model']}  |  {row['variant']} ---")
        if not row["ok"]:
            print(f"  ERROR: {row['error']}")
            continue
        print(f"  {row['completion_tokens']} tokens, {row['latency_ms']}ms"
              f"{'  CEILING HIT' if row['hit_ceiling'] else ''}"
              f"{'  flags: ' + ', '.join(row['leak_flags']) if row['leak_flags'] else ''}")
        print("  " + (row["text"].strip() or "(empty)").replace("\n", "\n  "))

    print(f"\n▸ raw results: {out}")
    print("▸ Add the winning variant to model_directives in gateway/prompts.yaml, with a")
    print("  comment recording what was measured. Both the harness and the gateway read that")
    print("  file, so one edit is the whole change — and an unmeasured model gets no directive.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
