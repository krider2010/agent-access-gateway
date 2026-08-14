#!/usr/bin/env python3
"""Layer-1 only: run every eval case through the policy oracle, no model calls.

Exists because run_eval.py requires --model and therefore spends API quota, while
the question here is narrower: did refactoring provenance onto the catalog change
any verdict? Compares decision and matched rule against each case's `expect`.
"""

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "eval"))

import yaml  # noqa: E402

from policy_engine import PolicyEngine, Request  # noqa: E402

engine = PolicyEngine.load(
    REPO / "policy" / "access_policy.yaml",
    REPO / "seed" / "out" / "catalog.json",
)

cases = sorted((REPO / "eval" / "queries").glob("*.yaml"))
passed, failed, skipped = [], [], []

for path in cases:
    case = yaml.safe_load(path.read_text(encoding="utf-8"))
    exp = case.get("expect") or {}
    if exp.get("decision") in (None, "N/A") or "sandbox" in case["id"]:
        skipped.append((case["id"], "excluded by design (sandbox-enforced)"))
        continue

    req = case["request"]
    try:
        decision = engine.evaluate(
            Request(
                actor=req["actor"],
                tool=req["tool"],
                resource=req.get("resource"),
                destination=req["destination"],
                scope_mode=req["scope_mode"],
                record_count=req.get("record_count"),
                columns=req.get("columns") or [],
                min_cell_count=req.get("min_cell_count"),
            )
        )
    except Exception as ex:  # noqa: BLE001 - a raise is a failure, report it
        failed.append((case["id"], f"raised {type(ex).__name__}: {ex}"))
        continue

    got = (decision.decision, decision.matched_rule)
    want = (exp["decision"], exp.get("rule"))
    if got == want:
        passed.append(case["id"])
    else:
        failed.append((case["id"], f"want {want}, got {got}"))

print(f"cases: {len(cases)}   passed: {len(passed)}   failed: {len(failed)}   skipped: {len(skipped)}")
for cid, why in skipped:
    print(f"  - skipped {cid}: {why}")
for cid, why in failed:
    print(f"  ✗ {cid}: {why}")

# Print the R7 case's full decision, since that is the one this refactor touched.
r7 = engine.evaluate(
    Request(
        actor="lena.fischer",
        tool="publish_model",
        resource="models.pedestrian_v4",
        destination="registry:global",
        scope_mode="records",
    )
)
print("\nR7 / rung 4e decision, resolved from catalog provenance:")
print(f"  decision  : {r7.decision}")
print(f"  rule      : {r7.matched_rule}")
print(f"  redirects : {r7.redirects}")

sys.exit(1 if failed else 0)
