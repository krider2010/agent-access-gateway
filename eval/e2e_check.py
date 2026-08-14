#!/usr/bin/env python3
"""Layer 3: replay the eval set through the deployed path, and diff it against the oracle.

Layers 1 and 2 both stop short of what a demo audience is being asked to believe. Layer 1
(`oracle_check.py`) proves the rules behave as `policy/access_policy.yaml` specifies, with no
n8n involved. Layer 2 (`run_eval.py`) proves the model explains a verdict without inventing an
alternative, by talking straight to the inference endpoint. Neither touches the gateway, so
neither can tell you that the thing running in n8n is the thing the rules describe.

This does. Every case goes out through the MCP Server Trigger (the same front door Lena's
agent talks to, over the same session protocol, with the same one-JSON-string argument
convention), and the answer that comes back is diffed against the layer-1 oracle.

WHAT THIS PROVES, AND WHAT IT DOES NOT.

Since `eval/policy_engine.py` became a shim over `gateway/policy_engine.js`, "the gateway
agrees with the oracle" is no longer the interesting claim: both sides run the same engine, so
agreement is structural rather than lucky, and checking it would mostly prove that code agrees
with itself. What is still unproven without this harness, and what each assertion below is for:

  1. the resolver maps a tool call onto the canonical ResolvedRequest correctly, including the
     fields the gateway *derives* rather than accepts
  2. the policy is fetched at request time rather than baked into the workflow
  3. exactly one audit record is written per call
  4. a sanctioned path actually executes, rather than being described
  5. the per-request wall clock, the only latency figure worth quoting for stage timing;
     layer 2's numbers are the model call alone and exclude n8n and MCP

Point 4 is the one the argument rests on. `access_policy.yaml` says of `train_in_place` that it
"must actually execute, not merely be described, or the redirect is a brochure", and until this
harness ran, nothing checked that.

Requires the stack up: `make n8n-up`, `make services`, and the two workflows deployed with
`isolate.sh` run last. See `docs/RUNBOOK.md` §2. Run it with the eval venv's interpreter, not
a bare `python3`; this module imports yaml, and `eval/policy_engine.py` needs `node` on PATH.

    .venv-eval/bin/python eval/e2e_check.py                  # the scored set
    .venv-eval/bin/python eval/e2e_check.py --case beat4a_full_export_laptop
    .venv-eval/bin/python eval/e2e_check.py --prove-policy-fetch   # negative control, below
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "eval"))
sys.path.insert(0, str(REPO_ROOT / "n8n" / "scripts"))

from policy_engine import PolicyEngine, Request  # noqa: E402

# Reused rather than reimplemented. `gateway_client` already handles the two things about
# this endpoint that are easy to get wrong: the MCP Server Trigger issues an `mcp-session-id`
# on initialize and requires it on every later request (without it the server answers 200
# with an empty body, which reads as a broken endpoint and is not one), and it frames replies
# as SSE rather than plain JSON.
import gateway_client  # noqa: E402

# `run_eval` owns the definition of what "matches the golden" means. Importing it keeps one
# definition rather than a second that drifts, the same reasoning that puts the prompts in one
# authored file rather than a copy per caller.
import run_eval  # noqa: E402

SERVICES = os.environ.get("GATEWAY_SERVICES_URL", "http://127.0.0.1:4301")
QUERIES_DIR = REPO_ROOT / "eval" / "queries"
POLICY_PATH = REPO_ROOT / "policy" / "access_policy.yaml"
CATALOG_PATH = REPO_ROOT / "seed" / "out" / "catalog.json"
OUT_DIR = REPO_ROOT / "eval" / "results" / "e2e"

# Each call to the front door triggers a model call inside n8n, so `run_eval.py`'s pacing
# applies here too. A round trip already takes a couple of seconds, so this rarely bites; it
# is here so a fast failure path, an immediate deterministic fallback on every case say,
# cannot turn into a burst.
MIN_INTERVAL_SEC = 1.75
_last_call_at = 0.0


def _pace() -> None:
    global _last_call_at
    wait = MIN_INTERVAL_SEC - (time.monotonic() - _last_call_at)
    if wait > 0:
        time.sleep(wait)
    _last_call_at = time.monotonic()


def load_cases() -> list[dict]:
    return [
        yaml.safe_load(Path(f).read_text(encoding="utf-8"))
        for f in sorted(glob.glob(str(QUERIES_DIR / "*.yaml")))
    ]


def audit_count() -> int:
    """Records currently in the audit log, read through the service's own route.

    Counted via `/health` rather than by reading `audit/decisions.jsonl` off disk: the point
    of the audit log is that a service the agent cannot reach writes it, and a check that
    bypasses the service would not be checking the same thing.
    """
    with urllib.request.urlopen(f"{SERVICES}/health", timeout=10) as r:
        return int(json.load(r)["audit_records"])


def tool_args(case: dict) -> dict:
    """Turn a case's `request` block into the arguments a tool call carries.

    Two fields on the canonical ResolvedRequest are deliberately NOT tool arguments, and
    leaving them out is what makes this a test of the resolver:

      `actor` comes from the session, never from the arguments. A caller-supplied actor is
      ignored, which is what stops an agent claiming to be someone else.

      `scope_mode` is derived by the gateway, not accepted. For most tools it follows from
      the tool name; for `read_records`, `request_export` and `request_approval` it depends
      on `projection`, because asking for an index is a different scope from asking for
      records even when the tool is the same. So `projection` is synthesised here as the
      inverse of the case's stated `scope_mode`, and the gateway's own derivation is then
      asserted against that statement rather than trusted.
    """
    r = dict(case["request"])
    args: dict = {"query": case["query"]}
    for k in ("resource", "destination", "record_count", "columns", "min_cell_count"):
        if r.get(k) not in (None, []):
            args[k] = r[k]
    if r["tool"] in ("read_records", "request_export", "request_approval"):
        args["projection"] = "index" if r["scope_mode"] == "metadata" else "records"
    return args


def call_gateway(session: str, tool: str, args: dict) -> tuple[dict | None, int, str | None]:
    """One tool call. Returns (parsed gateway answer, wall clock ms, error)."""
    _pace()
    started = time.monotonic()
    try:
        res, _ = gateway_client.post(
            {
                "jsonrpc": "2.0",
                "id": 99,
                "method": "tools/call",
                # `args` is a single JSON *string*, not an object, because under an MCP
                # Server Trigger n8n hands a tool call's whole argument set to one field.
                # That is also the reason there are two workflows here and not eleven.
                "params": {"name": tool, "arguments": {"args": json.dumps(args)}},
            },
            session,
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return None, int((time.monotonic() - started) * 1000), f"transport: {exc}"
    elapsed_ms = int((time.monotonic() - started) * 1000)

    if res is None:
        return None, elapsed_ms, "empty body — the session id was probably not accepted"
    if "error" in res:
        return None, elapsed_ms, f"mcp error: {json.dumps(res['error'])[:300]}"

    # The trigger wraps the workflow's last-node output as MCP text content, and the
    # workflow returns a single-item array.
    try:
        text = res["result"]["content"][0]["text"]
        payload = json.loads(text)
        return (payload[0] if isinstance(payload, list) else payload), elapsed_ms, None
    except (KeyError, IndexError, ValueError) as exc:
        return None, elapsed_ms, f"unparseable reply ({exc}): {json.dumps(res)[:300]}"


def run_case(case: dict, engine: PolicyEngine, session: str) -> dict:
    oracle = engine.evaluate(Request(**case["request"]))
    excluded = bool(case.get("enforced_by"))

    before = audit_count()
    got, elapsed_ms, error = call_gateway(session, case["request"]["tool"], tool_args(case))
    after = audit_count()

    rec: dict = {
        "case_id": case["id"],
        "tool": case["request"]["tool"],
        "excluded_from_gateway_count": excluded,
        "enforced_by": case.get("enforced_by"),
        "latency_ms": elapsed_ms,
        "error": error,
        "oracle_decision": oracle.decision,
        "oracle_matched_rule": oracle.matched_rule,
        "oracle_redirects": oracle.redirects,
        "audit_records_written": after - before,
        # Invariant 3. Exactly one, in both directions: a gateway that silently fails to
        # audit is unprovable, and one that double-writes makes the log a bad count.
        "audit_exactly_one": (after - before) == 1,
    }

    if got is None:
        rec.update(gateway_decision=None, agrees=False)
        return rec

    rec.update(
        gateway_decision=got.get("status"),
        gateway_matched_rule=got.get("matched_rule"),
        gateway_answer=got.get("answer"),
        gateway_answer_source=got.get("answer_source"),
        gateway_redirects_offered=got.get("redirects_offered"),
        # `redirect_primary`, not `redirect_chosen`; conflating the two would have produced
        # about ten spurious failures. `redirect_primary` is what the engine deterministically
        # picked. `redirect_chosen` is what the harness detects the *model* named, by
        # keyword-matching its prose, so it is null whenever the model worded the alternative
        # without tripping a signature. That is why ten of the twelve ALLOW goldens carry a
        # null one beside a populated `redirects_offered`. No gateway field can reproduce a
        # prose detector, so Layer 3 derives it the same way the harness does, below.
        gateway_redirect_primary=got.get("redirect_primary"),
        # Invariant 4. On an ALLOW the sanctioned path has to have produced something; a
        # null result here is the "redirect is a brochure" failure the policy warns about.
        gateway_result_present=got.get("result") is not None,
    )

    # Reuses the harness's own scorer over the answer the *gateway* produced. The one
    # model-quality question worth asking at layer 3 rather than layer 2: layer 2 proves the
    # model invents no unauthorised alternatives when called directly, and this proves that
    # survives the gateway's own prompt assembly, System row and fallback path. An invented
    # alternative here would be the gateway telling an engineer to do something policy never
    # sanctioned.
    scoring = run_eval.score_redirect(rec.get("gateway_answer") or "", oracle)
    rec["redirect_chosen_detected"] = scoring.get("redirect_chosen")
    rec["redirect_hallucinated"] = bool(scoring.get("redirect_hallucinated"))
    rec["decision_agrees"] = rec["gateway_decision"] == oracle.decision
    rec["rule_agrees"] = rec["gateway_matched_rule"] == oracle.matched_rule
    rec["redirects_agree"] = (rec["gateway_redirects_offered"] or []) == (oracle.redirects or [])
    rec["agrees"] = rec["decision_agrees"] and rec["rule_agrees"] and rec["redirects_agree"]

    # Reuses run_eval's golden comparison so "matches the golden" has one definition.
    rec["golden_diff"] = run_eval.diff_against_golden(
        {
            "case_id": case["id"],
            "engine_decision": rec["gateway_decision"],
            "engine_matched_rule": rec["gateway_matched_rule"],
            "response_text": rec.get("gateway_answer") or "",
        }
    )
    return rec


def prove_policy_fetch(session: str) -> dict:
    """Negative control: the gateway must be reading the policy at request time.

    A workflow with the policy inlined would keep answering correctly with the policy service
    stopped, and would look identical to this one on every other check here. So the proof is
    that it *stops* working: take `/policy` away and the decision must fail rather than fall
    back to a remembered answer.

    Deliberately not part of the main loop: it stops and restarts the service, a side effect
    on a shared process, so it is opt-in and puts things back.
    """
    import subprocess

    result: dict = {"ran": True}
    subprocess.run(["pkill", "-f", "gateway_services.js"], check=False, capture_output=True)
    for _ in range(20):
        try:
            audit_count()
            time.sleep(0.25)
        except Exception:
            break
    else:
        result.update(ok=False, note="service still answering after pkill; control invalid")
        return result

    got, _, error = call_gateway(session, "list_datasets", {"query": "list the datasets"})
    result["denied_without_policy"] = got is None
    result["error_seen"] = error
    result["ok"] = got is None

    subprocess.run(
        ["bash", str(REPO_ROOT / "gateway" / "scripts" / "services.sh")],
        check=False,
        capture_output=True,
    )
    for _ in range(40):
        try:
            audit_count()
            result["service_restored"] = True
            break
        except Exception:
            time.sleep(0.25)
    else:
        result["service_restored"] = False
    return result


def summarize(records: list[dict]) -> dict:
    scored = [r for r in records if not r["excluded_from_gateway_count"]]
    lat = [r["latency_ms"] for r in records if r.get("error") is None]
    allows = [r for r in scored if r["oracle_decision"] == "ALLOW"]
    return {
        "n_cases": len(records),
        "n_scored": len(scored),
        "n_agree": sum(1 for r in scored if r["agrees"]),
        "n_disagree": sum(1 for r in scored if not r["agrees"]),
        "n_transport_errors": sum(1 for r in records if r.get("error")),
        "audit_exactly_one_all": all(r["audit_exactly_one"] for r in records),
        "n_audit_wrong": sum(1 for r in records if not r["audit_exactly_one"]),
        "n_allow_with_result": sum(1 for r in allows if r.get("gateway_result_present")),
        "n_allow": len(allows),
        # Must be zero. A non-zero count means the gateway named an alternative the policy
        # never authorised, which is worse than a wrong verdict: it is advice.
        "n_redirect_hallucinated": sum(1 for r in records if r.get("redirect_hallucinated")),
        # The figure to quote for stage timing. Unlike layer 2's, this includes n8n
        # execution, the MCP round trip and the data plane.
        "latency_ms_p50": round(statistics.median(lat), 1) if lat else None,
        "latency_ms_p95": (
            round(statistics.quantiles(lat, n=20)[-1], 1) if len(lat) >= 2 else None
        ),
        "latency_ms_max": max(lat) if lat else None,
        "n_golden_mismatch_structural": sum(
            1
            for r in scored
            if r.get("golden_diff", {}).get("golden_exists")
            and not (
                r["golden_diff"].get("decision_matches_golden")
                and r["golden_diff"].get("rule_matches_golden")
            )
        ),
    }


def write_report(records: list[dict], summary: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with (OUT_DIR / "trace.jsonl").open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Layer 3: end to end through the gateway",
        "",
        "Every case below went out through the MCP Server Trigger and came back through the",
        "decision workflow. Latency is real per-request wall clock and includes n8n execution,",
        "the MCP round trip and the data plane, so it is not comparable to layer 2's figures.",
        "",
        f"- cases: {summary['n_cases']} ({summary['n_scored']} scored)",
        f"- agree with the oracle: {summary['n_agree']} / {summary['n_scored']}",
        f"- transport errors: {summary['n_transport_errors']}",
        f"- exactly one audit record per call: {summary['audit_exactly_one_all']}",
        f"- ALLOWs that produced a real result: "
        f"{summary['n_allow_with_result']} / {summary['n_allow']}",
        f"- latency p50 / p95 / max: {summary['latency_ms_p50']} / "
        f"{summary['latency_ms_p95']} / {summary['latency_ms_max']} ms",
        "",
        "| Case | Tool | Oracle | Gateway | Rule | Audit | Result | ms |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in records:
        mark = "" if r["agrees"] else " ⚠"
        lines.append(
            f"| `{r['case_id']}`{mark} | {r['tool']} | {r['oracle_decision']} "
            f"| {r.get('gateway_decision')} | {r.get('gateway_matched_rule')} "
            f"| {'1' if r['audit_exactly_one'] else r['audit_records_written']} "
            f"| {'yes' if r.get('gateway_result_present') else '-'} | {r['latency_ms']} |"
        )
    (OUT_DIR / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--case", help="run a single case by id")
    ap.add_argument(
        "--prove-policy-fetch",
        action="store_true",
        help="also run the negative control that stops the policy service (see docstring)",
    )
    args = ap.parse_args()

    if not CATALOG_PATH.exists():
        print(f"✗ no catalog at {CATALOG_PATH} — run seed/generate.py first", file=sys.stderr)
        return 2
    try:
        audit_count()
    except Exception as exc:
        print(f"✗ gateway services not reachable on {SERVICES} ({exc})", file=sys.stderr)
        print("  run: make services", file=sys.stderr)
        return 2

    engine = PolicyEngine.load(POLICY_PATH, CATALOG_PATH)
    cases = load_cases()
    if args.case:
        cases = [c for c in cases if c["id"] == args.case]
        if not cases:
            print(f"✗ no case with id {args.case!r}", file=sys.stderr)
            return 2

    session = gateway_client.session()
    print(f"▸ {len(cases)} case(s) through {gateway_client.URL}\n")

    records = []
    for i, case in enumerate(cases, 1):
        rec = run_case(case, engine, session)
        records.append(rec)
        flag = "✓" if rec["agrees"] else "✗"
        detail = rec["error"] or (
            f"{rec.get('gateway_decision')}/{rec.get('gateway_matched_rule')}"
        )
        print(f"  {flag} [{i}/{len(cases)}] {rec['case_id']:52s} {detail}  {rec['latency_ms']}ms")

    summary = summarize(records)
    if args.prove_policy_fetch:
        summary["policy_fetch_control"] = prove_policy_fetch(session)
    write_report(records, summary)

    print()
    print(f"agree      : {summary['n_agree']} / {summary['n_scored']}")
    print(f"audit 1:1  : {summary['audit_exactly_one_all']} ({summary['n_audit_wrong']} wrong)")
    print(f"ALLOW real : {summary['n_allow_with_result']} / {summary['n_allow']}")
    print(f"invented   : {summary['n_redirect_hallucinated']} unauthorised alternatives")
    print(f"p50 / p95  : {summary['latency_ms_p50']} / {summary['latency_ms_p95']} ms")
    print(f"report     : {OUT_DIR / 'report.md'}")

    ok = (
        summary["n_disagree"] == 0
        and summary["n_transport_errors"] == 0
        and summary["audit_exactly_one_all"]
        and summary["n_allow_with_result"] == summary["n_allow"]
        and summary["n_redirect_hallucinated"] == 0
    )
    if args.prove_policy_fetch and not summary["policy_fetch_control"].get("ok"):
        ok = False
    print("\n" + ("✓ layer 3 clean" if ok else "✗ layer 3 has failures — see the report"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
