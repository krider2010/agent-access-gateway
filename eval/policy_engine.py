#!/usr/bin/env python3
"""
policy_engine.py: Python access to the access decision. Not an implementation of it.

The decision lives in exactly one place: gateway/policy_engine.js, the same file the n8n
gateway's Code node runs. This module loads policy/access_policy.yaml and
seed/out/catalog.json, hands each request to that JavaScript through
eval/policy_engine_bridge.js, and returns the answer as a `Decision`. It contains no rules.

WHY THERE IS ONLY ONE IMPLEMENTATION NOW. This file used to be an independent Python port of the
same rules, held in agreement with the JavaScript by eval/cross_check.py, and the two did agree:
all 34 scored cases, rationale text included, byte for byte. A weaker result than it looks.
Layer 3 of docs/EVALS.md asks whether the n8n workflows reach the same verdict as the oracle, and
that is only interesting if the two could disagree. With one implementation behind both,
agreement stops being a property a test re-establishes after every edit, and Layer 3 goes back
to testing the workflows.

WHERE THE REASONING WENT. The rules, the three policy gaps this engine has to work around and
the two underspecified corners of `evaluation.semantics` it has to take a position on are all
documented in gateway/policy_engine.js's IMPLEMENTATION NOTES. That is the file to read to find
out what the engine does and why. Nothing was dropped in the move.

Given a request:

    {actor, tool, resource, destination, scope_mode, record_count, columns,
     min_cell_count}

`evaluate()` returns:

    {decision, matched_rule, rationale, redirects}

Usage as a library:

    from policy_engine import PolicyEngine, Request
    engine = PolicyEngine.load(policy_path, catalog_path)
    result = engine.evaluate(Request(actor="lena.fischer", tool="read_records",
                                      resource="fleet.night_clips_annotated",
                                      destination="host:workstation",
                                      scope_mode="records", record_count=48217))

Usage as a smoke test:

    python3 policy_engine.py

Requires `node` on PATH, which is the price of not keeping a second copy of the rules.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml

# Resolved from this file rather than from the working directory, because the harnesses are run
# from the repo root and the gateway's tests are not.
_BRIDGE = Path(__file__).resolve().parent / "policy_engine_bridge.js"


@dataclass
class Request:
    """A single access request, in the shape the task specifies.

    The field names are load-bearing beyond this file: eval/run_eval.py builds these straight
    out of the eval cases as `Request(**case["request"])`, so a rename here is a rename of the
    eval/queries/*.yaml format, and the defaults are what let a case omit a field.
    """

    actor: str
    tool: str
    resource: Optional[str]          # dataset/model id from the catalog, or None
    destination: str                 # a `destinations[].name` value, e.g. "host:workstation";
                                      # for the external:* pattern, any "external:<host>" string
    scope_mode: str                  # "records" | "metadata" | "aggregate" | "compute" | "catalog" | "identity"
    record_count: Optional[int] = None
    columns: Optional[list[str]] = field(default_factory=list)
    # Size of the smallest group the query would emit, which is a different
    # number from record_count and the one R10 tests. For an aggregate with no
    # GROUP BY there is a single group, so this equals record_count. None means
    # "not measured", which R10 treats as failing, the same way R8 treats an
    # unknown cohort size.
    min_cell_count: Optional[int] = None


@dataclass
class Decision:
    decision: str                    # ALLOW | DENY | REQUIRE_APPROVAL
    matched_rule: Optional[str]      # e.g. "R1", or "R0-IMPLICIT", or None
    rationale: str
    redirects: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "matched_rule": self.matched_rule,
            "rationale": self.rationale.strip(),
            "redirects": self.redirects,
        }


class PolicyEngine:
    """Loads access_policy.yaml (+ the dataset catalog) and evaluates requests.

    The evaluation happens in gateway/policy_engine.js. One node process is started on the
    first `evaluate()` and reused for every request after it; see policy_engine_bridge.js for
    why that rather than one process per decision. Nothing tears it down explicitly: when this
    interpreter exits its end of the pipe closes, the bridge sees EOF and leaves.
    """

    def __init__(self, policy: dict[str, Any], catalog: dict[str, Any]):
        self.policy = policy
        self.catalog = catalog
        self._node: Optional[subprocess.Popen] = None

    # -------------------------------------------------------------------
    # Construction
    # -------------------------------------------------------------------
    @classmethod
    def load(cls, policy_path: Path | str, catalog_path: Path | str) -> "PolicyEngine":
        with open(policy_path, "r", encoding="utf-8") as f:
            policy = yaml.safe_load(f)
        with open(catalog_path, "r", encoding="utf-8") as f:
            catalog = json.load(f)
        return cls(policy, catalog)

    # -------------------------------------------------------------------
    # The bridge to gateway/policy_engine.js
    # -------------------------------------------------------------------
    def _start(self) -> None:
        """Start the bridge and hand it the policy and catalog. Idempotent."""
        if self._node is not None:
            return
        try:
            self._node = subprocess.Popen(
                ["node", str(_BRIDGE)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
        except FileNotFoundError as ex:
            raise RuntimeError(
                "policy_engine.py needs `node` on PATH. The access decision itself is "
                "gateway/policy_engine.js; this module only forwards requests to it."
            ) from ex
        handshake = self._exchange({"policy": self.policy, "catalog": self.catalog})
        if not handshake.get("ready"):
            raise RuntimeError(f"{_BRIDGE.name} refused the policy: {handshake}")

    def _exchange(self, message: dict[str, Any]) -> dict[str, Any]:
        """Send one JSON line, read the one JSON line that answers it."""
        node = self._node
        assert node is not None and node.stdin is not None and node.stdout is not None
        node.stdin.write(json.dumps(message) + "\n")
        node.stdin.flush()
        line = node.stdout.readline()
        if not line:
            # The bridge exited instead of replying, so its stderr is the only evidence of
            # why. Draining it is safe now and only now: the process is already gone, so the
            # read cannot block waiting for more.
            stderr = node.stderr.read() if node.stderr else ""
            raise RuntimeError(
                f"{_BRIDGE.name} exited without replying (status {node.poll()}):\n"
                f"{stderr.strip()}"
            )
        return json.loads(line)

    def evaluate(self, req: Request) -> Decision:
        self._start()
        reply = self._exchange(asdict(req))
        if "error" in reply:
            # The JavaScript raises PolicyError for an unknown actor, resource or destination.
            # It arrives here as ValueError because that is what this module raised when it
            # held its own copy of the rules, and eval/oracle_check.py prints the exception's
            # type name in its failure lines.
            raise ValueError(reply["error"])
        d = reply["decision"]
        # Rebuilt field by field rather than splatted, so that an added field on the JS side
        # is a visible change here rather than a silent TypeError.
        return Decision(
            decision=d["decision"],
            matched_rule=d["matched_rule"],
            rationale=d["rationale"],
            redirects=d["redirects"],
        )


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    here = Path(__file__).resolve().parent.parent
    engine = PolicyEngine.load(
        here / "policy" / "access_policy.yaml", here / "seed" / "out" / "catalog.json"
    )

    smoke_cases = [
        Request(
            actor="lena.fischer",
            tool="request_export",
            resource="fleet.night_clips_annotated",
            destination="host:workstation",
            scope_mode="records",
            record_count=48217,
        ),
        # min_cell_count is not optional in practice for a grouped aggregate: R10
        # fails closed on an unmeasured grouping, so omitting it here turned this
        # case (the "governed access still does real work" beat) into a denial.
        # Any caller that groups must supply the measurement.
        Request(
            actor="lena.fischer",
            tool="query_aggregate",
            resource="fleet.night_clips_annotated",
            destination="enclave:governed",
            scope_mode="aggregate",
            record_count=30,
            columns=["LightingCondition"],
            min_cell_count=30,
        ),
        Request(
            actor="lena.fischer",
            tool="read_records",
            resource="ops.gpu_cluster_metrics",
            destination="enclave:governed",
            scope_mode="records",
            record_count=1000,
        ),
        Request(
            actor="lena.fischer",
            tool="publish_model",
            resource="models.pedestrian_v4",
            destination="registry:global",
            scope_mode="records",
        ),
        Request(
            actor="lena.fischer",
            tool="start_training_job",
            resource="fleet.night_clips_annotated",
            destination="enclave:governed",
            scope_mode="compute",
        ),
    ]
    for c in smoke_cases:
        d = engine.evaluate(c)
        print(f"{c.tool:20s} {c.resource or '-':35s} -> {d.decision:8s} ({d.matched_rule})")
