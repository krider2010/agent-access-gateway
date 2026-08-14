#!/usr/bin/env bash
#
# Check the sandbox policy's single-egress claim with NVIDIA's own policy prover.
#
# The demo's central claim is that the agent has exactly one route to company
# data: the access gateway's front door on :5678. That claim used to rest on
# probing the running sandbox by hand. This checks it statically, against the
# policy file, with `openshell policy prove`, a Z3-backed analysis enumerating the
# (readable file -> binary -> reachable endpoint) triples a policy permits.
#
# The prover has no "exactly one egress route" theorem, so this script builds the
# claim from what it does have: an exfiltration query enumerating every endpoint a
# file-reading process could push bytes to, plus assertions of our own over the
# policy file. A second route would surface in one or the other.
#
# WHAT THIS CHECKS
#   0. Every endpoint sets `protocol: rest`, `enforcement: enforce`, no `access:`
#      preset, and allows only the front-door path. This is the most important
#      check and the least obvious; see the warning below.
#   1. The policy grants exactly the two spellings of the front door and nothing
#      else. A new host or port breaks the build.
#   1b. The prover reports no critical or high findings.
#   2. No permitted binary can bypass L7 framing (no git/ssh/nc-style wire
#      protocol path). Adding one breaks the build.
#   3. The prover reports no findings at all, of any severity.
#
# ⚠ THE FAILURE MODE THIS SCRIPT EXISTS FOR, found on 2026-08-13. With
# `protocol: rest` and correct path rules but the `enforcement:` line missing,
# every unlisted path on the permitted port still reached the server (measured
# from inside the sandbox, not assumed) and **the prover reported PASS anyway**,
# because it analyses the rules as written rather than the mode they run in. A
# policy can look hardened, prove clean, and enforce nothing. Hence check 0 reads
# the file directly instead of trusting the prover, and the only safe confirmation
# of an L7 change is a denial observed from inside the sandbox.
#
# Until the same day, this script expected one CRITICAL finding and argued the
# L4-only endpoint was acceptable because the gateway's data policy governs
# content. Sound, but the gap was fixable: n8n's management API shares port 5678
# with the front door, so an L4 grant handed over both. It is now scoped to one
# path.
#
# `--accepted-risks` is deliberately unused. It can accept the `data_exfiltration`
# finding, but not per endpoint, so a file accepting it would go on reporting PASS
# even if someone later opened arbitrary external egress. A green light that
# cannot go red is not worth having.
#
# WHAT THIS DOES NOT CHECK
#   * Whether the running sandbox has this policy loaded. This is a statement
#     about a file. Confirm the active revision with `openshell policy get`, and
#     confirm enforcement by attempting a denied path from inside the sandbox.
#   * Anything about the gateway's data policy, the other enforcement layer.
#   * n8n's management API is closed here at the network layer, and also switched
#     off by `n8n/workflows/isolate.sh` after every build. Two independent
#     mechanisms, deliberately: this file governs one sandbox, the toggle closes
#     the surface to everything on the host.
#
# This is a read-only static analysis. It contacts no gateway and touches no
# running sandbox; verified by running it against a nonexistent gateway.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY="$REPO_ROOT/policy/sandbox_policy.yaml"
CREDENTIALS="$REPO_ROOT/policy/prover_credentials.yaml"

# The one permitted route, in both the spellings the policy uses. Sorted, because
# we compare against a sorted list.
EXPECTED_ENDPOINTS="127.0.0.1:5678 host.openshell.internal:5678"

# No findings at all is now correct. Until 2026-08-13 this expected one ("Data
# exfiltration possible", the L4-only endpoint). `protocol: rest` with explicit
# path rules fixed the gap, so any title appearing here is something new.
EXPECTED_FINDING=""

command -v openshell >/dev/null 2>&1 || {
  echo "prove_single_egress: openshell not found on PATH" >&2
  exit 2
}
for f in "$POLICY" "$CREDENTIALS"; do
  [ -r "$f" ] || { echo "prove_single_egress: cannot read $f" >&2; exit 2; }
done

strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }

# `prove` exits non-zero when it reports FAIL. We want its text either way, so the
# exit status is captured rather than allowed to kill the script.
full_output="$(openshell policy prove \
  --policy "$POLICY" --credentials "$CREDENTIALS" 2>&1 | strip_ansi || true)"
compact_output="$(openshell policy prove --policy "$POLICY" \
  --credentials "$CREDENTIALS" --compact 2>&1 | strip_ansi || true)"

echo "=============================================================="
echo " openshell policy prove — verbatim output"
echo "=============================================================="
printf '%s\n' "$full_output"
echo "=============================================================="
echo " Assertions on the above"
echo "=============================================================="

if [ -z "$compact_output" ]; then
  echo "FAIL: the prover produced no output at all." >&2
  exit 1
fi

failed=0
note_failure() { echo "FAIL: $1" >&2; failed=1; }

# --- 0. The policy is L7-scoped and actually enforcing --------------------
# The most important assertion here; the ⚠ note in the header has the silent
# failure it exists for. Asserted against the file rather than the prover's
# output, because the prover is the thing that cannot see `enforcement`.
python_bin="$(command -v python3 || true)"
for candidate in "$REPO_ROOT/.venv-eval/bin/python3" "$python_bin"; do
  [ -x "$candidate" ] && { PY="$candidate"; break; }
done
if [ -z "${PY:-}" ]; then
  note_failure "no python3 available to inspect the policy file"
else
  shape="$("$PY" - "$POLICY" <<'PYEOF' 2>&1 || true
import sys, yaml
FRONT_DOOR = "/mcp/kerbline-access-gateway"
d = yaml.safe_load(open(sys.argv[1]))
blocks = d.get("network_policies") or {}
problems = []
if list(blocks) != ["access_gateway_front_door"]:
    problems.append(f"expected exactly one network block, found {list(blocks)}")
for name, block in blocks.items():
    for ep in block.get("endpoints") or []:
        where = f"{name} {ep.get('host')}:{ep.get('port')}"
        if ep.get("protocol") != "rest":
            problems.append(f"{where}: protocol is {ep.get('protocol')!r}, not 'rest' — the port is open at L4, so every path on it is reachable")
        if ep.get("enforcement") != "enforce":
            problems.append(f"{where}: enforcement is {ep.get('enforcement')!r}, not 'enforce' — L7 rules are NOT applied and the prover cannot tell")
        if ep.get("access"):
            problems.append(f"{where}: has access preset {ep['access']!r}, which expands to blanket '**' rules and re-opens every path")
        paths = {r.get("allow", {}).get("path") for r in (ep.get("rules") or [])}
        if paths != {FRONT_DOOR}:
            problems.append(f"{where}: allowed paths are {sorted(p for p in paths if p)}, expected only {FRONT_DOOR}")
print("\n".join(problems) if problems else "OK")
PYEOF
)"
  if [ "$shape" = "OK" ]; then
    echo "PASS: one network block, every endpoint L7-scoped to the front-door path, enforcement on."
  else
    note_failure "the policy's shape is not what the single-route claim requires:
$(printf '%s\n' "$shape" | sed 's/^/        - /')"
  fi
fi

# --- 1. The endpoint set, read off the policy ------------------------------
# This used to be extracted from the prover's exfiltration finding, which worked
# only while that finding existed. L7-scoped endpoints leave the prover reporting
# nothing, so the old check read "no endpoints reachable": a false alarm that at
# least failed safe. Reading the file is direct and immune to output shape.
actual_endpoints="$(printf '%s\n' "$("$PY" - "$POLICY" <<'PYEOF' 2>/dev/null || true
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
eps = []
for block in (d.get("network_policies") or {}).values():
    for ep in block.get("endpoints") or []:
        eps.append(f"{ep.get('host')}:{ep.get('port')}")
print(" ".join(sorted(set(eps))))
PYEOF
)")"

expected_sorted="$(printf '%s\n' $EXPECTED_ENDPOINTS | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
actual_sorted="$(printf '%s\n' "$actual_endpoints" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ *$//')"

if [ "$actual_sorted" = "$expected_sorted" ]; then
  echo "PASS: the policy grants exactly the front door — $actual_sorted"
else
  note_failure "the set of granted endpoints changed.
        expected: $expected_sorted
        actual:   $actual_sorted
      An extra entry means the sandbox has gained a second egress route, which
      is the one thing this policy exists to prevent. A missing entry means the
      agent can no longer reach the gateway and the demo will not run. Either
      way, fix the policy rather than widening EXPECTED_ENDPOINTS — change that
      list only when the architecture itself has genuinely changed."
fi

# --- 1b. And the prover agrees there is nothing to report ------------------
if printf '%s\n' "$compact_output" | grep -qiE '(CRITICAL|HIGH)'; then
  note_failure "the prover reports a critical or high finding. Read the verbatim
      output above; every finding here was clean as of 2026-08-13, so this is new."
else
  echo "PASS: the prover reports no critical or high findings."
fi

# --- 2. No L7 bypass ------------------------------------------------------
if printf '%s\n' "$compact_output" | grep -qi 'wire protocol bypass'; then
  note_failure "a binary that bypasses L7 framing is now permitted (git, ssh
      and nc are the usual causes). Even against the permitted port this
      defeats HTTP-level inspection anywhere downstream."
else
  echo "PASS: no permitted binary bypasses L7 framing."
fi

# --- 3. No unexpected finding kinds ---------------------------------------
unexpected="$(printf '%s\n' "$compact_output" \
  | grep -oE '(CRITICAL|HIGH|MEDIUM|LOW|ACCEPTED) +[A-Z][^:]*$' \
  | sed -E 's/^(CRITICAL|HIGH|MEDIUM|LOW|ACCEPTED) +//' \
  | sed 's/ *$//' \
  | { [ -n "$EXPECTED_FINDING" ] && grep -vxF "$EXPECTED_FINDING" || cat; } || true)"

if [ -z "$unexpected" ]; then
  echo "PASS: the prover reports no findings of any severity."
else
  note_failure "the prover reported a finding kind this script has not been
      reasoned about:
$(printf '%s\n' "$unexpected" | sed 's/^/        - /')
      Read it, decide whether it matters, then update this script."
fi

echo "--------------------------------------------------------------"
if [ "$failed" -eq 0 ]; then
  echo "Single-egress property holds: one host:port is granted, it is scoped at"
  echo "L7 to the single path the gateway's front door answers on, and"
  echo "enforcement is on. Every other path on that port, n8n's management API"
  echo "included, is refused before the request leaves the sandbox."
  echo
  echo "This is a statement about the file. Confirm the sandbox is running it with"
  echo "'openshell policy get', and confirm enforcement by attempting a denied"
  echo "path from inside the sandbox — the prover cannot see enforcement mode."
  exit 0
fi
echo "Single-egress property NOT confirmed. See the failures above."
exit 1
