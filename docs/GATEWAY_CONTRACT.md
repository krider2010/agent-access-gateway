# Gateway contract

The interface between the agent, the gateway workflows and the audit trail. Everything in
[../policy/access_policy.yaml](../policy/access_policy.yaml) says *what* the gateway
decides; this says *how a request and a decision are shaped* while that happens.

It exists because the decision engine in
[../gateway/policy_engine.js](../gateway/policy_engine.js), the n8n workflows that call it,
and the harness that scores them all have to agree on the same shape. Where they disagree,
this file is wrong or they are; never "it depends".

## 1. The six stages

A single tool call passes through these, in order, exactly once.

| Stage | Produced by | Mutable after? |
|---|---|---|
| 1. `ToolCall` | the agent | n/a |
| 2. `ResolvedRequest` | the gateway's resolver | no |
| 3. `Verdict` | the deterministic policy engine | **never** |
| 4. `Explanation` | the policy model | n/a: cannot alter stages 2–3 |
| 5. `AuditRecord` | the gateway | append-only |
| 6. `ToolResult` | the data plane, or the denial path | n/a |

### Invariants

Each of these is checkable, and the end-to-end harness asserts them rather than assuming
them.

1. **The verdict precedes the model.** `Verdict` is computed before the policy model is
   called and is immutable afterwards. The model receives it as input and cannot change
   `decision`, `matched_rule` or the set of offered redirects.
2. **The data plane runs only on ALLOW.** Stage 6 is reachable only when
   `Verdict.decision == "ALLOW"`. It is a branch inside the decision workflow rather than a
   separate workflow, so this is enforced by topology: there is no other path to it.
   `REQUIRE_APPROVAL` writes a pending approval record and stops. This build has no resume
   path; see §8.
3. **The data plane is not independently callable.** Only the front-door workflow is
   exposed over MCP; every other workflow carries `availableInMCP: false`, which is what
   stops a holder of a management token calling the decision workflow (and the data plane
   inside it) without passing the front door. `n8n/workflows/isolate.sh` sets that flag and
   then proves the refusal through the live management surface rather than trusting the flag.
   An agent that can reach the data plane directly has routed around the gateway, and a
   gateway that can be routed around is decorative.
4. **Exactly one audit record per tool call**, whatever the outcome: allow, deny, approval,
   model failure, or an internal error. A missing record is a governance failure even when
   the access decision was right.
5. **Fail closed.** If the policy model is unreachable or slow, the verdict still stands and
   the explanation degrades to deterministic text. `access_policy.yaml` sets
   `evaluation.fail_mode: closed`; an unexplained denial is acceptable, an unmade decision
   is not.

## 2. `ResolvedRequest`

The canonical form. Eight fields, mirroring `Request` in `policy_engine.py` exactly.

```json
{
  "actor":          "lena.fischer",
  "tool":           "request_export",
  "resource":       "fleet.night_clips_annotated",
  "destination":    "host:workstation",
  "scope_mode":     "records",
  "record_count":   48217,
  "columns":        [],
  "min_cell_count": null
}
```

- `actor`: resolved from the authenticated session, **never** from the tool arguments. A
  request that names its own actor is claiming an identity rather than proving one.
- `resource`: a dataset or artifact id from the catalog, or `null` for tools that address
  no single resource. An id absent from the catalog is an error, not a default-deny.
- `destination`: a `destinations[].name` from the policy, or any `external:<host>` string.
- `scope_mode`: one of `records`, `metadata`, `aggregate`, `compute`, `catalog`,
  `identity`.
- `record_count`: the size of the cohort the request selects. `null` unless the request
  has a determinate size. See §4.
- `columns`: the columns a group-by would expose. Empty for non-aggregate scopes.
- `min_cell_count`: the size of the *smallest group* the query would emit. A different
  number from `record_count`, and the one `R10` tests. `null` means not measured, which
  `R10` treats as a failure. For an aggregate with no `GROUP BY` there is one group, so this
  equals `record_count`. See §4.

## 3. Mapping the nine tools onto it

The resolver's whole job. Anything not listed here is not derivable from a tool call and
must not be inferred.

| Tool | `scope_mode` | `resource` | `destination` | size inputs |
|---|---|---|---|---|
| `whoami` | `identity` | `null` | `enclave:governed` | `null` |
| `list_datasets` | `catalog` | `null` | `enclave:governed` | `null` |
| `describe_dataset` | `catalog` | the dataset | `enclave:governed` | `null` |
| `query_aggregate` | `aggregate` | the dataset | `enclave:governed` | **both, from the pre-flight profile; see §4** |
| `read_records` | `records`, or `metadata` if the projection is index-only | the dataset | `enclave:governed` | rows the query would return |
| `request_export` | `records`, or `metadata` for an index-only export | the dataset | **from the argument** | rows in the export |
| `start_training_job` | `compute` | the training dataset | the execution location | `null` |
| `publish_model` | `records` | the model artifact | the registry target | `null` |
| `request_approval` | as the request being approved | as that request | as that request | as that request |

Note that `request_approval` records a request for sign-off; it never grants one. See §8.

**Why the default destination is `enclave:governed`.** Five of the nine tools take no
destination argument, and the default is not "unknown": it is the agent's own sandbox,
which the policy defines as the governed enclave on company hardware. This is what makes
`read_records` on restricted data deny under `R6` (a role ceiling) rather than `R1` (an
egress rule): nothing left the building, the engineer simply is not entitled to records.
Getting this default wrong silently changes which rule fires, and therefore which rationale
the engineer is shown.

**`request_approval` carries no authority of its own.** It re-presents an earlier request
for a human to decide. It never widens scope, and the approved request is re-evaluated as a
fresh `ResolvedRequest` rather than executed from a cached verdict; otherwise an approval
becomes a token that can be replayed against a different request.

## 4. The pre-flight profile

`R2` admits aggregates over restricted data only above a k-anonymity floor, and `R8`/`R10`
enforce the floor on two different numbers. Both have to be known *before* the gateway
decides whether the query is allowed:

| Measure | Field | Tested by |
|---|---|---|
| How many records the filter selects | `record_count` | `R8` |
| How many records land in the smallest resulting group | `min_cell_count` | `R10` |

Three ways to get them:

- **Trust the numbers in the tool arguments.** No. They are the caller's own claim about the
  sensitivity of their own request, and the eval set already carries a case for an agent
  asserting its own authorisation.
- **Decide without them.** Fails closed, but silently and without a reason the engineer can
  act on, which is the wall behaviour §7 describes.
- **Measure inside the enclave, pre-decision.** The gateway runs a profiling query where the
  data lives (a count, and a `MIN(COUNT(*))` over the proposed grouping), uses the results
  as policy inputs, and discards them unless the verdict is ALLOW. Neither number crosses
  the boundary on a denial.

The third is the contract. Three consequences follow:

1. A profiling query touches restricted data before authorisation. That is defensible
   because it runs inside the enclave, returns two integers to the gateway and not to the
   caller, and `record_count` is itself recorded in the audit trail.
2. The profile must be computed from the *same* filter and grouping the request would use.
   A profile taken from a different query is not evidence about this one.
3. A caller who can tell "denied, cohort too small" apart from any other denial has learned
   one bit about a cohort they were refused. That is inherent to enforcing a floor at all,
   and it is part of why the floor is 25 rather than 2.

## 5. `Verdict`

```json
{
  "decision":     "DENY",
  "matched_rule": "R1",
  "rationale":    "This footage shows identifiable people who were filmed in public …",
  "redirects":    ["train_in_place", "use_redacted_set"]
}
```

- `decision`: `ALLOW` | `DENY` | `REQUIRE_APPROVAL`.
- `matched_rule`: a rule id, or `R0-IMPLICIT` for the implicit-allow fallback, or `null`
  when nothing matched and the default-deny applied. A `null` here means the engineer gets
  no rationale and no redirect; see §7.
- `rationale`: copied verbatim from the matched rule. The gateway never writes prose here.
- `redirects`: keys into `sanctioned_paths`. The model may name one of these and nothing
  else; a name outside this set is a hallucination and is scored as one.

## 6. `AuditRecord`

The nineteen fields in `access_policy.yaml`'s `audit.record`, appended as one JSON object
per line.

The audit of record is deliberately a file rather than a trace. n8n can export
OpenTelemetry spans, and doing so is worth it for per-node timing. But spans are telemetry
and this is evidence. The record has a fixed schema and a ten-year retention, and an auditor
reading it should not have to trust a reassembly from sampled data. Two specifics decide
it. n8n's OTel exporter defaults to production executions only, so an interactively-driven
run would produce nothing; and an OTLP exporter is egress, which must never sit on the path
that the no-external-calls claim depends on.

`policy_model_location` is the field that carries the sovereignty claim per decision, and
it must report what actually happened rather than what was configured. Until the policy
model runs on-box it reads `hosted`.

## 7. Denials that carry no rule

`R2` is an ALLOW rule, so for a while any aggregate that failed its conditions matched
nothing at all and fell through to bare default-deny: a correct verdict with no rationale
and no sanctioned path. That is the wall behaviour `R1` and `R5` were each amended to avoid.

**Closed.** `R8` (cohort below the k-anonymity floor) and `R9` (grouped by position, time or
vehicle) now cover those cases explicitly, each with its own rationale and redirect:
`widen_aggregate_cohort` and `group_by_non_identifying_columns`. They are separate rules
because they teach different things: one is "widen the cohort", the other is rung 4c's
argument that position plus time reconstructs a journey. Both sit ahead of `R2` in
`evaluation.order`, and a request that fails both is reported as a cohort failure first.

An aggregate whose size is unknown fires `R8` rather than falling through. An aggregate that
cannot be shown to clear the floor has not cleared it, and this way the refusal still
carries a reason.

`R10` closes the related cell-size gap, which was the more serious one. `R8` measures the
cohort; `R10` measures the smallest group the query would emit, which is what
`privacy.suppress_small_cells` always described and nothing previously enforced. Grouping by
`ClipId` over the full set passes `R8`, since the cohort is 48,217, and returns 48,217 rows of
one clip each. That is the clip index rather than a statistic, and the clip index is what rung
4c argues must not leave.

`R9` and `R10` are not redundant:

| Group by | Smallest cell | Denied by | Because |
|---|---|---|---|
| `VehicleId` | ~2,009 clips | `R9` | large groups, but each is about one car |
| `DurationMs` | ~1 clip | `R10` | on no blocklist, and near-unique |

`R9` governs what the grouping is *about*; `R10` governs how *fine* it is. Neither catches
the other's case.

**Still open:**

| Gap | Status |
|---|---|
| `deny_describe_dataset_restricted_schema` | Still `matched_rule: null`. Whether a restricted dataset's *schema* is itself sensitive is a policy judgement, not a plumbing fix, so it is untouched. Tagged `policy_gap`. |
| The differencing attack | Two aggregates that each clear every floor can be subtracted to isolate one clip. No per-request predicate can catch it; it needs reasoning over query history. Both halves are in the eval set as `adversarial_differencing_attack_part{1,2}`, expecting ALLOW, as documentation of the limit rather than as a test that can fail. A three-arm study of whether a model could catch it is in [EVALS.md](EVALS.md) §8. |


## 8. `REQUIRE_APPROVAL` has no resume path, deliberately

`R3` returns `REQUIRE_APPROVAL`, and the gateway's response to that is to write a pending
approval record, audit it, and tell the engineer which dataset owner it went to. The request
does not proceed, and nothing in this build resumes it.

That is a scope decision rather than an omission. The claim this gateway exists to
demonstrate is that *policy* governs access; a person clicking approve demonstrates
escalation, which is a property of a mature system and not evidence for the argument. Keeping
`R3` as a decision outcome is what carries the weight, because it shows the policy has three
answers rather than two, which is the reply to "a gateway like this will block
legitimate work".

The mechanism also argued against itself. Every n8n node offering `sendAndWait` routes
through Slack, email, Gmail, Discord, Google Chat or Outlook. So a live approval would put an
external call on the path that the no-external-calls claim depends on. And it would add a
workspace or SMTP dependency to a repository whose point is that a stranger can reproduce it.
The sandbox cannot host it either: NemoClaw's controls are declarative allow/deny lists with
no interactive prompt, and routing a data owner's sign-off through the engineer's own sandbox
would have her approving her own request.

Because the pending record is audited, a resume path stays additive. Adding one
later means acting on a record that already exists rather than retrofitting the concept.

## 9. Stage 6 on the wire

`POST /data/execute` on port `4301`, served by
[../gateway/gateway_services.js](../gateway/gateway_services.js). The body is the
`ResolvedRequest` of §2 plus `decision` and `matched_rule` from the `Verdict` of §5:
those ten keys, validated strictly in both directions. A missing key means the body is not
the shape this section describes; an extra key means a caller is supplying an input the
resolver never produced.

**Why 4301 and not the workflow.** `R2` lets statistics leave a dataset whose recordings
may not, which is only a permission worth having if the counting happens somewhere the
caller cannot reach into. A `GROUP BY` that ran in the agent's own process would have
held every row first. So the rows sit behind the port `policy/sandbox_policy.yaml` does
not open, and what crosses back is the counts. This is the same argument that puts the
audit sink there, applied to reads.

**Invariant 2 is enforced once and checked twice.** The enforcement is topological: in
the workflow the data plane sits three nodes deep on the true branch of one If node, and
there is no other path to it. The service then refuses any body whose `decision` is not
`ALLOW`. That check enforces nothing on its own, since the only caller is the workflow.
It costs four lines and it means a future rewiring of that branch fails loudly here
rather than serving rows.

**The service re-derives the verdict rather than believing it.** Three gates run before any
handler, in this order:

1. `decision` is not `ALLOW` → **403**, with the message above. First because it is cheapest, and
   because that message is the one a rewired branch should produce.
2. The named resource is not in `seed/out/catalog.json` → **404**. Ahead of re-derivation
   deliberately: the engine would also refuse a resource it cannot resolve, but "not in the
   catalog" is the more useful of the two answers.
3. The verdict is re-derived by loading
   [`../gateway/policy_engine.js`](../gateway/policy_engine.js), the same file the gateway's Code
   node runs, from `access_policy.yaml` and the catalog, both re-read per request. The engine is
   handed the eight `ResolvedRequest` fields and **not** `decision` or `matched_rule`, so the
   caller's claim cannot influence the answer it is checked against.

   - re-derived `ALLOW` → serve.
   - re-derived anything else → **403** naming both verdicts and both rules, plus a `REFUSED` line
     on stderr carrying actor, tool, resource, destination and scope. A claimed authorisation the
     policy does not support is refused whether it is a bug in the decision workflow or a request
     that never went through one.
   - the engine throws, on an unknown actor or destination → **422**. An unevaluable request has
     not been authorised, and the service will not serve rows on a verdict it cannot reproduce.
   - both say `ALLOW` but name different rules → **serve, with a warning logged**. The policy said
     yes either way and the audit record carries whichever rule the gateway matched, so refusing
     would be a false negative.

**This is defence in depth, not the primary control.** The network boundary still is. It costs one
in-memory policy evaluation per request.

Until 2026-08-13 the service checked only the *value* of `decision`, and a request posted directly
with `decision: ALLOW`, `destination: host:workstation` and `fleet.night_clips_annotated` returned
the restricted rows, `VehicleId` and GPS included. Two further shapes did the same:
`request_approval` against restricted records, and `start_training_job` against the redacted set.
All three are now refused with the rule that actually governs them.

**One thing this does not cover.** `POST /audit` has no verdict to re-derive, so the audit sink
still rests entirely on the port being unreachable. Before this change the data plane and the
audit log leaned on that single boundary together; now only the audit log does. That is a
smaller surface, not an absent one.

**What comes back, per tool.** `query_aggregate` returns cell counts from a real
`GROUP BY`. `read_records` returns rows projected to the requested columns.
`start_training_job` returns `R5`'s `returns: [metrics, logs, model_card]` and no row of
its training set. `publish_model` returns a registration receipt. Every reply also names
the file it was computed from and how many rows that file holds, so nobody can attribute
a figure to a population it did not come from.

**Two limits the replies state.** A records read is truncated for transport: the policy
already said yes and the audit record carries the authorised size, so the cap is a display
decision and the reply says what it cut. And `record_count` reaches the data plane as a size
without the filter that produced it, so
the data plane reproduces a cohort by size rather than by predicate. Both follow from §2
carrying eight fields; changing either means changing the `ResolvedRequest`, not working
around it here.

**The pre-flight profile is still open.** §4 requires `record_count` and
`min_cell_count` to be measured inside the enclave before the verdict. This build
resolves them from the tool arguments, so an aggregate reply carries a `profile_check`
block holding the declared figures, the measured ones and whether they agree. Reporting
both is not a fix for that gap; it is how the gap stays legible until someone closes it.