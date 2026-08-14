#!/usr/bin/env python3
"""
cross_check.py: does the bundle survive the trip from Python into node?

WHAT THIS USED TO CHECK, AND WHAT IT CHECKS NOW. This file was written when there were two
independent implementations of the decision (gateway/policy_engine.js for the n8n Code node
and a Python port in eval/policy_engine.py), and its job was to catch them drifting apart.
That job is gone: there is one implementation, and eval/policy_engine.py is a shim over it.

So this check is now partly circular on purpose. Both sides of the comparison end up in the
same JavaScript. What differs is how the inputs get there:

  - the "expected" side goes through eval/policy_engine.py, which serialises one request at a
    time over eval/policy_engine_bridge.js after PyYAML has parsed the policy;
  - the "got" side goes through a single JSON bundle written to a temp file and read by
    eval/cross_check.js, much closer to how the gateway receives the document; the :4301
    service serves this same JSON to an HTTP Request node.

A disagreement here therefore no longer means "one of the two engines is wrong". It means the
policy or the request did not survive one of those routes intact: a YAML scalar that
round-trips differently, a `None` that arrived as something other than `null`, a rationale
whose trailing newline was eaten. Those failure modes are why rationale text is compared byte
for byte. The name is now a slight misnomer; the check stays, because deleting it would remove
the only thing that exercises the bundle-shaped path outside a live gateway.

Rationale text is compared with trailing whitespace stripped on both sides, but only for
this check. The engine deliberately returns it *untrimmed*, because the harness interpolates
it into the model prompt untrimmed, and a one-newline difference there would change the
prompt the model sees. See gateway/policy_engine.js.

    python3 eval/cross_check.py

Exits non-zero on any disagreement. Requires node and the repo's eval venv (PyYAML).
"""

from __future__ import annotations

import glob
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "eval"))

import yaml  # noqa: E402

from policy_engine import PolicyEngine, Request  # noqa: E402


def main() -> None:
    policy_path = REPO_ROOT / "policy" / "access_policy.yaml"
    catalog_path = REPO_ROOT / "seed" / "out" / "catalog.json"
    if not catalog_path.exists():
        raise SystemExit(
            f"✗ {catalog_path} is missing — run `python3 seed/generate.py` first."
        )

    policy = yaml.safe_load(policy_path.read_text(encoding="utf-8"))
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    engine = PolicyEngine.load(policy_path, catalog_path)

    cases, expected = [], {}
    for path in sorted(glob.glob(str(REPO_ROOT / "eval" / "queries" / "*.yaml"))):
        case = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        if (case.get("expect") or {}).get("decision") is None:
            continue  # excluded by design, e.g. the sandbox-enforced case
        r = case["request"]
        cases.append({"id": case["id"], "request": r})
        decision = engine.evaluate(Request(
            actor=r["actor"], tool=r["tool"], resource=r.get("resource"),
            destination=r["destination"], scope_mode=r["scope_mode"],
            record_count=r.get("record_count"), columns=r.get("columns") or [],
            min_cell_count=r.get("min_cell_count"),
        ))
        expected[case["id"]] = decision.to_dict()

    # The policy reaches the JS engine as JSON, in the shape the :4301 service serves it.
    bundle = {"policy": policy, "catalog": catalog, "cases": cases, "python": expected}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(bundle, f)
        bundle_path = f.name

    try:
        result = subprocess.run(
            ["node", str(REPO_ROOT / "eval" / "cross_check.js"), bundle_path],
            capture_output=True,
            text=True,
        )
    finally:
        Path(bundle_path).unlink(missing_ok=True)

    print(result.stdout.strip() or result.stderr.strip())
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
