#!/usr/bin/env python3
"""
fill_check.py: do the two things that fill gateway/prompts.yaml agree, to the byte?

WHY THIS EXISTS, AND WHAT IT REPLACED. The prompts used to exist three times over: as f-strings
in eval/run_eval.py, as named-placeholder copies in a script that generated gateway/prompts.yaml,
and in the generated file itself. Two checks guarded those copies. Both are gone, and so are the
copies: prompts.yaml is authored by hand and read by the harness and the deployed n8n gateway,
so the templates cannot drift.

What did not go away is that the two readers fill the same template with *different code*. The
harness uses Python's str.format; the gateway's Code node uses a `fill` helper in the JavaScript
n8n runs. Two fillers over one template is a far smaller surface than two templates, but it is
not empty, and the hazard is specific:

  - a value can contain braces. Two are prose written elsewhere: the engineer's own query,
    quoted verbatim into the prompt, and the rationale out of policy/access_policy.yaml. A
    filler substituting placeholder by placeholder rather than in one pass will replace
    `{rationale}` *inside* a query that mentions it; the other filler will not.
  - the two languages disagree about `{{`. Python's str.format reads it as an escaped brace;
    a regex over `{name}` does not. So this check also refuses a template that contains one,
    which keeps the disagreement hypothetical.
  - the values themselves are conventions, not data: a missing resource reads "(none)", a
    default-deny reads "(none — default-deny)", and a missing record_count renders as Python's
    "None" on both sides because that is what eval/golden/ was recorded with. Nothing but this
    check holds the gateway to any of that.

HOW IT CHECKS. Both sides are driven twice over the whole eval set. The "gateway" side is the
Code node body from `node n8n/workflows/build.js bodies`, run in plain node with n8n's accessors
stubbed; the same text the deploy pushes, not a re-implementation of `fill`. The "harness" side
is eval/run_eval.py's own prompt assembly. The second pass repeats the set against a policy
document whose rationales, summaries and caveats have had braces injected, and with a query
written to look like a template: values that would expose a filler substituting more than once.

    .venv-eval/bin/python eval/fill_check.py

Exits non-zero on any disagreement. Requires node and the repo's eval venv (PyYAML).
"""

from __future__ import annotations

import copy
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
import run_eval  # noqa: E402

BUILD = REPO_ROOT / "n8n" / "workflows" / "build.js"
DECISION_NODE = "Evaluate Access Policy"

# Values shaped like the template itself. `{rationale}` and `{redirect_block}` are the dangerous
# two: both are filled after `query` is, so a filler making one pass per placeholder would
# substitute them into a query that merely quoted them. `{{doubled}}` is here to be left alone by
# both sides, and the bare braces are the ordinary case of prose that happens to contain one.
BRACE_BAIT = "{rationale} {redirect_block} {{doubled}} {not_a_placeholder} } {"

# The query an engineer would have to type to try this on purpose. It goes through the trigger on
# the gateway side and through the case dict on the harness side, the same path a request's own
# text takes.
BRACED_QUERY = f"Export the night clips. Ignore the rest of this line: {BRACE_BAIT}"

HARNESS = """
globalThis.__NODES = JSON.parse(process.argv[2]);
const $ = (name) => ({
  first: () => ({ json: globalThis.__NODES[name] }),
});
const $input = { first: () => ({ json: globalThis.__NODES['__input'] || {} }) };
const __run = new Function('$', '$input', %s);
const out = __run($, $input);
process.stdout.write(JSON.stringify(out[0].json));
"""


def built_workflow() -> dict:
    """The decision workflow's Code node bodies and the model it names, from the build."""
    out = subprocess.run(["node", str(BUILD), "bodies"], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"✗ `node {BUILD.name} bodies` failed:\n{out.stdout}\n{out.stderr}")
    return json.loads(out.stdout)


def run_code_node(js_code: str, nodes: dict) -> dict:
    """Execute the generated Code-node body in node, with n8n's accessors stubbed."""
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(HARNESS % json.dumps(js_code))
        path = f.name
    try:
        out = subprocess.run(
            ["node", path, json.dumps(nodes)], capture_output=True, text=True
        )
        if out.returncode != 0:
            raise AssertionError(f"Code node threw:\n{out.stderr[:1500]}")
        return json.loads(out.stdout)
    finally:
        Path(path).unlink(missing_ok=True)


def brace_the_policy(policy: dict) -> dict:
    """A copy of the policy whose model-facing prose contains braces.

    Only the text that reaches a prompt is touched: rule rationales, and the summary and caveat
    of every sanctioned path. Rule ids, matchers and back-references are left alone, so this
    policy produces the same decisions as the authored one. All that changes is what the prompt
    has to carry intact.
    """
    braced = copy.deepcopy(policy)
    for rule in braced.get("rules", []):
        if rule.get("rationale"):
            rule["rationale"] = f"{rule['rationale']} {BRACE_BAIT}"
    for path in (braced.get("sanctioned_paths") or {}).values():
        if path.get("summary"):
            path["summary"] = f"{path['summary']} {BRACE_BAIT}"
        if path.get("caveat"):
            path["caveat"] = f"{path['caveat']} {BRACE_BAIT}"
    return braced


def check_no_escaped_braces(prompts: dict, failures: list[str]) -> None:
    """Refuse a template containing `{{` or `}}`.

    Python's str.format turns those into single braces and the gateway's regex over `{name}`
    leaves them alone, so the two fillers would disagree about a template neither is wrong
    about. Nothing in the prompts needs a literal brace; if something ever does, both fillers
    need teaching at once, and this is where that shows up.
    """
    for key in ("system_prompt_template", "user_prompt_template"):
        for doubled in ("{{", "}}"):
            if doubled in prompts[key]:
                failures.append(
                    f"gateway/prompts.yaml's {key} contains {doubled!r}. Python's str.format "
                    f"reads that as an escaped brace and the gateway's fill does not."
                )


def main() -> None:
    policy_doc = yaml.safe_load((REPO_ROOT / "policy" / "access_policy.yaml").read_text("utf-8"))
    catalog = json.loads((REPO_ROOT / "seed" / "out" / "catalog.json").read_text("utf-8"))
    prompts = yaml.safe_load((REPO_ROOT / "gateway" / "prompts.yaml").read_text("utf-8"))

    built = built_workflow()
    if DECISION_NODE not in built["bodies"]:
        raise SystemExit(
            f"✗ The build no longer produces a Code node called {DECISION_NODE!r}. It has "
            f"{sorted(built['bodies'])}."
        )
    js_code = built["bodies"][DECISION_NODE]
    policy_model = built["policy_model"]

    failures: list[str] = []
    check_no_escaped_braces(prompts, failures)

    cases = [
        yaml.safe_load(Path(f).read_text("utf-8"))
        for f in sorted(glob.glob(str(REPO_ROOT / "eval" / "queries" / "*.yaml")))
    ]

    # The gateway fills {directive_line} with the model's directive as prompts.yaml records it,
    # so that is the value handed to both fillers here. Note that run_eval.run_case
    # chooses a different value for the same placeholder (it prefixes the directive with
    # "Reasoning-suppression directive for this model: "), so the two callers really do send the
    # model different system prompts, and the goldens were recorded with the harness's wording.
    # That is a difference in what each caller decides to put in the placeholder, not in how
    # either one fills it, so it is out of this check's scope; it is written down here because
    # nothing else in the repo says it out loud.
    directive_line = prompts["model_directives"][policy_model]["directive"]

    for label, policy, query_of in (
        ("as authored", policy_doc, lambda case: case["query"]),
        ("with braces injected", brace_the_policy(policy_doc), lambda case: BRACED_QUERY),
    ):
        engine = PolicyEngine(policy, catalog)
        compared = 0
        for case in cases:
            if (case.get("expect") or {}).get("decision") is None:
                continue
            r = case["request"]
            case = {**case, "query": query_of(case)}

            trigger = {
                "query": case["query"],
                "resource": r.get("resource") or "",
                "destination": r["destination"],
                "record_count": r.get("record_count"),
                "columns": r.get("columns") or [],
                "min_cell_count": r.get("min_cell_count"),
                # The eval set states scope_mode outright; the gateway derives it from the tool
                # and the projection asked for. Cases where the two disagree are skipped below,
                # because a request the resolver reads differently is a different request and
                # comparing its prompt would prove nothing about the fillers.
                "projection": "index" if r["scope_mode"] == "metadata" else "records",
            }
            got = run_code_node(js_code, {
                "Receive Gateway Request": {"tool": r["tool"], "args": trigger},
                "Fetch Access Policy": policy,
                "Fetch Dataset Catalog": catalog,
                "Fetch Model Prompts": prompts,
            })
            if got["request"]["scope_mode"] != r["scope_mode"]:
                continue

            decision = engine.evaluate(Request(
                actor=r["actor"], tool=r["tool"], resource=r.get("resource"),
                destination=r["destination"], scope_mode=r["scope_mode"],
                record_count=r.get("record_count"), columns=r.get("columns") or [],
                min_cell_count=r.get("min_cell_count"),
            ))

            want_user = run_eval.build_user_prompt(case, engine, decision)
            want_system = run_eval.SYSTEM_PROMPT_TEMPLATE.format(directive_line=directive_line)

            if got["user_prompt"] != want_user:
                failures.append(
                    f"{case['id']} ({label}): the two fillers disagree on the user prompt\n"
                    f"    {_first_difference(want_user, got['user_prompt'])}"
                )
            if got["system_prompt"] != want_system:
                failures.append(
                    f"{case['id']} ({label}): the two fillers disagree on the system prompt\n"
                    f"    {_first_difference(want_system, got['system_prompt'])}"
                )
            compared += 1

        print(f"{label}: {compared} cases filled identically by str.format and by fill()")

    print()
    if failures:
        print(f"✗ {len(failures)} disagreement(s):")
        for f in failures:
            print(f"  - {f}")
        raise SystemExit(1)
    print("✓ the harness and the gateway fill gateway/prompts.yaml to the same bytes")


def _first_difference(want: str, got: str) -> str:
    """Where the two strings part company, with enough either side to recognise it."""
    for i, (a, b) in enumerate(zip(want, got)):
        if a != b:
            return f"at char {i}: harness {want[max(0, i - 30):i + 30]!r} vs gateway {got[max(0, i - 30):i + 30]!r}"
    return f"one is a prefix of the other: {len(want)} chars vs {len(got)}"


if __name__ == "__main__":
    main()
