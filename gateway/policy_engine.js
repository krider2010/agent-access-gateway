/**
 * policy_engine.js: the access decision.
 *
 * This is the only implementation of the decision. It resolves a request against
 * policy/access_policy.yaml and seed/out/catalog.json, and never hardcodes a rule's
 * conditions: every predicate below reads its threshold, list or classification out of the
 * loaded policy document. What IS in this file, and not in the policy document, is in the
 * IMPLEMENTATION NOTES below. Read them; they hold the reasoning behind three gaps in the
 * policy and two underspecified corners of its semantics.
 *
 * TWO CALLERS, ONE COPY OF THE RULES. The n8n gateway embeds this file in a Code node; the
 * eval harness reaches it from Python through eval/policy_engine_bridge.js.
 * eval/policy_engine.py used to be a second, independent implementation of the same rules,
 * kept honest by a case-by-case cross-check. It is now a thin shim over this file, so "the
 * gateway reaches the same verdict as the oracle" (Layer 3 of docs/EVALS.md) is true by
 * construction rather than a property some test keeps re-establishing.
 *
 * WHY THIS IS A FILE AND NOT A STRING INSIDE A WORKFLOW. n8n stores a Code node's body as a
 * string in the workflow record. Keeping the source here makes it reviewable in a diff,
 * testable outside n8n, and portable if the workflow is rebuilt. The authoring step embeds
 * it; this file stays the source of truth.
 *
 * NO I/O. This module neither reads files nor makes network calls, because an n8n Code node can
 * do neither. The policy document and the dataset catalog are fetched by an HTTP Request node
 * ahead of it and handed in.
 *
 * Usage, identical in n8n and in the test harness:
 *
 *   const { evaluate } = require('./policy_engine.js');
 *   const decision = evaluate({ policy, catalog, request });
 *
 * Usage from Python, via the shim:
 *
 *   from policy_engine import PolicyEngine, Request
 *
 * ============================================================================================
 * IMPLEMENTATION NOTES: read this before trusting the ALLOW column
 * ============================================================================================
 *
 * 1. THE R0-IMPLICIT FALLBACK, AND WHY IT EXISTS.
 *
 *    R1/R4/R6/R7 are DENY (R1/R4/R7 terminal, R6 not). R2/R5 are the only two ALLOW rules
 *    access_policy.yaml defines, and both apply only to RESTRICTED-classification requests
 *    (aggregate-over-k, and in-enclave compute). NO rule affirmatively ALLOWs an ordinary read
 *    of INTERNAL or CONFIDENTIAL data; none covers "read ops.gpu_cluster_metrics in the
 *    enclave" or "list the clip catalog". Taken literally, evaluation.semantics step 4 ("if no
 *    rule matches: DENY") would therefore DENY beat 3 of docs/SCENARIO.md, the allowed-work
 *    beat the whole demo narrative depends on.
 *
 *    That is a gap in the policy document, not a misreading of it. The reading is not in doubt;
 *    evaluation.semantics says what it says, and this engine implements it verbatim in the
 *    default-deny branch at the bottom of evaluate(). The gap is in what the document contains:
 *    every way to say no, no way to say yes to routine in-role work. So an engine that
 *    implements it refuses the scenario's own happy path. The repair belongs in
 *    access_policy.yaml, and the write-up handed back with the eval report asks for it there.
 *
 *    Until it lands, this engine adds exactly one fallback branch, implicitInRoleAllow(),
 *    which is not one of the policy's own rules and is never allowed to pass as one. Callers
 *    see it as matched_rule === 'R0-IMPLICIT', a shape no id in access_policy.yaml can take,
 *    so every consumer (the gateway's audit record, eval/run_eval.py, the JSONL trace,
 *    report.md) can count it separately; and its rationale says in words that it is a
 *    harness-side fallback rather than policy. It grants ALLOW only when:
 *      - the resource's classification is at or below the actor's role's may_read_up_to
 *        ceiling (data that IS in the policy file: roles.*.may_read_up_to and
 *        classifications[].level), and
 *      - the destination is trusted (data that IS in the policy file:
 *        destinations[].trusted), and
 *      - scope_mode is one the explicit rules do not already handle exhaustively
 *        (FALLBACK_ELIGIBLE_SCOPES).
 *    It never touches RESTRICTED data, because R6 owns that ceiling check, and never fires for
 *    an untrusted destination, because R1/R3/R4 do.
 *
 *    Given an explicit rule for this case in access_policy.yaml, delete implicitInRoleAllow()
 *    and nothing else here changes.
 *
 * 2. R5's `returns` AND `execution_location` PREDICATES.
 *
 *    R5's match.returns: [metrics, logs, model_card] describes the fixed contract of the
 *    start_training_job tool, not a variable field of the request: the tool returns metrics,
 *    logs and a model card by construction, never by the caller's choice. There is no `returns`
 *    key on the request object, so the predicate is treated as satisfied once
 *    tool === 'start_training_job'.
 *
 *    match.execution_location_trusted is resolved off request.destination against
 *    destinations[].trusted: for a compute tool, "destination" IS "where it executes". This key
 *    used to be the literal string execution_location: "enclave:governed", which silently
 *    excluded spark:local even though it is equally trusted and on-premises; see
 *    eval/queries/gap_training_job_spark_local.yaml. A trust check is what R5's own rationale
 *    always said ("the job runs where the data lives"). MATCHERS.R5 still accepts the old
 *    literal-string form, for policy documents that predate the change.
 *
 * 3. WHERE THE PROVENANCE FACT COMES FROM.
 *
 *    resource_derived_from_classification (R7) is resolved from the catalog's derived_from
 *    field: models.pedestrian_v4 declares it was trained on fleet.night_clips_annotated, and
 *    this engine looks up that dataset's classification (RESTRICTED) rather than storing a
 *    second copy. The catalog is the single source for the fact.
 *
 *    It used to be a hardcoded table in the Python oracle, wrong twice over. R7 cannot fire
 *    inside n8n against a table only the harness holds, and rung 4e of the scenario is the one
 *    beat no network control can catch. A second copy on the n8n side would be no better: the
 *    end-to-end harness would then compare two independent hardcodings of the same fact, which
 *    says nothing about whether either matches the policy. This is a fact lookup, not a rule;
 *    R7 itself is still evaluated generically off resource_derived_from_classification.
 *
 * 4. HOW A NON-TERMINAL DENY IS WEIGHED.
 *
 *    Rule R6 has no `terminal: true`. evaluation.semantics step 2 special-cases only a
 *    *terminal* DENY, and says nothing about weighing a non-terminal DENY against an ALLOW or
 *    REQUIRE_APPROVAL collected in step 3, which states only that "REQUIRE_APPROVAL outranks
 *    ALLOW". This engine treats DENY as outranking both, via PRECEDENCE: the only reading under
 *    which R6 does anything at all. The choice is moot for this rule set, since R6 and R2 are
 *    mutually exclusive on scope_mode, but the semantics as written leave the edge
 *    underspecified.
 *
 * 5. WHERE REDIRECTS COME FROM.
 *
 *    R1, R4 and R7 are `terminal: true` and short-circuit the walk as documented. R3 has no
 *    `redirect:` key of its own, but sanctioned_paths.request_owner_approval.rule: R3 names it
 *    from the other end. So redirects resolve by (a) an explicit `redirect:` list on the rule,
 *    else (b) any sanctioned_paths entries whose `rule:` field points back at this rule id. R4
 *    and R6 have neither and surface with redirects === []: for R6 the policy only gestures at
 *    "use R2 or R5 instead" in prose, inside its `rationale`, never as structured data.
 */

'use strict';

// Lower number wins when more than one non-terminal rule matches a single request.
// See IMPLEMENTATION NOTES item 4 for why DENY outranks the other two at all.
const PRECEDENCE = { DENY: 0, REQUIRE_APPROVAL: 1, ALLOW: 2 };

// The matched_rule value for the fallback branch described in IMPLEMENTATION NOTES item 1.
// Not of the form "R<n>", so it can never collide with, or be mistaken for, an id from
// access_policy.yaml.
const IMPLICIT_RULE_ID = 'R0-IMPLICIT';

// scope_modes the explicit rules do not exhaustively handle. Decides only whether the fallback
// may look at a request; it still requires classification-below-ceiling and a trusted
// destination on top.
const FALLBACK_ELIGIBLE_SCOPES = new Set([
  'records', 'metadata', 'aggregate', 'catalog', 'identity',
]);

class PolicyError extends Error {}

/** Resolve a dotted reference into the policy document, or pass a literal through. */
function resolvePolicyRef(policy, value) {
  if (typeof value !== 'string' || !value.includes('.')) return value;
  let node = policy;
  for (const part of value.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) {
      throw new PolicyError(
        `Rule references ${JSON.stringify(value)}, which is not a path in access_policy.yaml`,
      );
    }
    node = node[part];
  }
  return node;
}

function buildIndex(policy, catalog) {
  const classificationLevel = {};
  for (const c of policy.classifications) classificationLevel[c.name] = c.level;

  const destinations = {};
  for (const d of policy.destinations) destinations[d.name] = d;

  const actors = {};
  for (const a of policy.actors) actors[a.id] = a;

  const rulesById = {};
  for (const r of policy.rules) rulesById[r.id] = r;

  const datasets = {};
  for (const d of (catalog.datasets || [])) datasets[d.id] = d;

  return {
    classificationLevel,
    destinations,
    actors,
    rulesById,
    datasets,
    roles: policy.roles,
    sanctionedPaths: policy.sanctioned_paths || {},
    order: policy.evaluation.order,
    egressAllowlist: policy.egress_allowlist || [],
    privacy: policy.privacy || {},
  };
}

function resolveRole(ix, actorId) {
  const actor = ix.actors[actorId];
  if (!actor) throw new PolicyError(`Unknown actor: ${JSON.stringify(actorId)} (not in policy.actors)`);
  const role = ix.roles[actor.role];
  if (!role) throw new PolicyError(`Actor ${JSON.stringify(actorId)} has unknown role ${JSON.stringify(actor.role)}`);
  return role;
}

function resolveResource(ix, resourceId) {
  if (resourceId === null || resourceId === undefined) {
    return { classification: null, residency: null, derived_from_classification: null };
  }
  const ds = ix.datasets[resourceId];
  if (!ds) {
    throw new PolicyError(
      `Unknown resource: ${JSON.stringify(resourceId)} (not in seed/out/catalog.json)`,
    );
  }
  // Provenance comes off the catalog's derived_from; see IMPLEMENTATION NOTES item 3. A
  // derived_from naming a dataset the catalog lacks is a generator bug: fail loudly rather than
  // return null and let R7 silently stop matching.
  let derivedFromClassification = null;
  if (ds.derived_from !== undefined && ds.derived_from !== null) {
    const source = ix.datasets[ds.derived_from];
    if (!source) {
      throw new PolicyError(
        `Resource ${JSON.stringify(resourceId)} declares derived_from=` +
        `${JSON.stringify(ds.derived_from)}, which is not in the catalog`,
      );
    }
    derivedFromClassification = source.classification;
  }
  return {
    classification: ds.classification,
    residency: ds.residency,
    derived_from_classification: derivedFromClassification,
  };
}

function resolveDestination(ix, destination) {
  if (destination in ix.destinations) return ix.destinations[destination];
  if (destination.startsWith('external:') && 'external:*' in ix.destinations) {
    return ix.destinations['external:*'];
  }
  throw new PolicyError(
    `Unknown destination: ${JSON.stringify(destination)} (not in policy.destinations, ` +
    'and does not match the external:* pattern)',
  );
}

function levelOf(ix, name) {
  if (name === null || name === undefined) return null;
  return ix.classificationLevel[name];
}

// ---------------------------------------------------------------------------
// Per-rule matchers. Each reads its thresholds out of the rule's own `match` block, so a change
// to access_policy.yaml changes behaviour with no change here.
// ---------------------------------------------------------------------------
const MATCHERS = {
  R1(ix, rule, req, resource, destination) {
    const m = rule.match;
    return resource.classification === m.classification
      && m.scope_mode.includes(req.scope_mode)
      && destination.trusted === false;
  },

  R2(ix, rule, req, resource, destination) {
    const m = rule.match;
    if (resource.classification !== m.classification) return false;
    if (!m.scope_mode.includes(req.scope_mode)) return false;
    const minRecords = m.min_records !== undefined ? m.min_records : (ix.privacy.k_anonymity_min || 0);
    if (req.record_count === null || req.record_count === undefined) return false;
    if (req.record_count < minRecords) return false;
    const forbidden = ix.privacy.forbidden_aggregate_columns || [];
    return !(req.columns || []).some((c) => forbidden.includes(c));
  },

  R3(ix, rule, req, resource, destination) {
    const m = rule.match;
    return resource.classification === m.classification && req.destination === m.destination;
  },

  R4(ix, rule, req, resource, destination) {
    const m = rule.match;
    // Translate the one wildcard form the policy uses ("external:*") into a regex, rather
    // than special-casing that literal string.
    const escaped = m.destination_pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('^' + escaped.replace(/\\\*/g, '.*') + '$');
    if (!regex.test(req.destination)) return false;
    const allowlist = resolvePolicyRef(ix.policyDoc, m.destination_not_in)
      || ix.egressAllowlist;
    return !allowlist.includes(req.destination);
  },

  R5(ix, rule, req, resource, destination) {
    const m = rule.match;
    // `classification` may be one value or a list, as `scope_mode` already is elsewhere. R5
    // covers more than one because it grants compute rather than reads; see the rule's own
    // comment in access_policy.yaml for why a role-ceiling test would be wrong here.
    const allowed = Array.isArray(m.classification) ? m.classification : [m.classification];
    if (!allowed.includes(resource.classification)) return false;
    if (req.tool !== m.tool) return false;
    // A trust check rather than a named location, and `returns` treated as always satisfied:
    // both are IMPLEMENTATION NOTES item 2.
    if ('execution_location_trusted' in m) {
      if (destination.trusted !== m.execution_location_trusted) return false;
    } else if ('execution_location' in m) {
      if (req.destination !== m.execution_location) return false;
    } else {
      throw new PolicyError('R5.match has neither execution_location_trusted nor execution_location');
    }
    return true;
  },

  R6(ix, rule, req, resource, destination) {
    const m = rule.match;
    const role = resolveRole(ix, req.actor);
    const ceilingLevel = levelOf(ix, role.may_read_up_to);
    const resLevel = levelOf(ix, resource.classification);
    if (resLevel === null) return false;
    if (resLevel <= ceilingLevel) return false;
    return m.scope_mode.includes(req.scope_mode);
  },

  R7(ix, rule, req, resource, destination) {
    const m = rule.match;
    return resource.derived_from_classification === m.resource_derived_from_classification
      && destination.trusted === false;
  },

  R8(ix, rule, req, resource, destination) {
    const m = rule.match;
    if (resource.classification !== m.classification) return false;
    if (!m.scope_mode.includes(req.scope_mode)) return false;
    const floor = resolvePolicyRef(ix.policyDoc, m.records_below);
    // An aggregate of unknown size has not been shown to clear the floor.
    if (req.record_count === null || req.record_count === undefined) return true;
    return req.record_count < floor;
  },

  R9(ix, rule, req, resource, destination) {
    const m = rule.match;
    if (resource.classification !== m.classification) return false;
    if (!m.scope_mode.includes(req.scope_mode)) return false;
    const forbidden = resolvePolicyRef(ix.policyDoc, m.columns_in);
    return (req.columns || []).some((c) => forbidden.includes(c));
  },

  R10(ix, rule, req, resource, destination) {
    const m = rule.match;
    if (resource.classification !== m.classification) return false;
    if (!m.scope_mode.includes(req.scope_mode)) return false;
    const floor = resolvePolicyRef(ix.policyDoc, m.min_cell_below);
    let cells = req.min_cell_count;
    // An ungrouped aggregate has exactly one group: the cohort itself.
    if ((cells === null || cells === undefined) && (req.columns || []).length === 0) {
      cells = req.record_count;
    }
    // Still unknown: a grouping that has not been measured has not been shown safe.
    if (cells === null || cells === undefined) return true;
    return cells < floor;
  },
};

/** An explicit `redirect:` list, else sanctioned_paths pointing back (NOTES item 5). */
function redirectsFor(ix, ruleId, rule) {
  if (rule.redirect && rule.redirect.length) return [...rule.redirect];
  return Object.entries(ix.sanctionedPaths)
    .filter(([, path]) => path.rule === ruleId)
    .map(([key]) => key);
}

/** The one branch that is not a policy rule. See IMPLEMENTATION NOTES item 1. */
function implicitInRoleAllow(ix, req, role, resource, destination) {
  if (!FALLBACK_ELIGIBLE_SCOPES.has(req.scope_mode)) return false;
  if (destination.trusted !== true) return false;
  const ceilingLevel = levelOf(ix, role.may_read_up_to);
  const resLevel = levelOf(ix, resource.classification);
  // No classified resource in scope (whoami, catalog listing): no explicit rule gates it
  // either.
  if (resLevel === null) return true;
  return resLevel <= ceilingLevel;
}

/**
 * Evaluate one request. Returns { decision, matched_rule, rationale, redirects }.
 *
 * Deterministic and order-dependent, per evaluation.semantics in the policy document.
 * The policy model is handed this result afterwards and cannot change it.
 */
function evaluate({ policy, catalog, request }) {
  const ix = buildIndex(policy, catalog);
  ix.policyDoc = policy;

  const req = {
    actor: request.actor,
    tool: request.tool,
    resource: request.resource === undefined ? null : request.resource,
    destination: request.destination,
    scope_mode: request.scope_mode,
    record_count: request.record_count === undefined ? null : request.record_count,
    columns: request.columns || [],
    min_cell_count: request.min_cell_count === undefined ? null : request.min_cell_count,
  };

  const role = resolveRole(ix, req.actor);
  const resource = resolveResource(ix, req.resource);
  const destination = resolveDestination(ix, req.destination);

  const collected = [];

  for (const ruleId of ix.order) {
    const rule = ix.rulesById[ruleId];
    if (!rule) throw new PolicyError(`evaluation.order names unknown rule ${ruleId}`);
    const matcher = MATCHERS[ruleId];
    if (!matcher) throw new PolicyError(`No matcher implemented for rule ${ruleId}`);
    if (!matcher(ix, rule, req, resource, destination)) continue;

    // The first matching terminal DENY decides immediately.
    if (rule.effect === 'DENY' && rule.terminal === true) {
      return {
        decision: 'DENY',
        matched_rule: ruleId,
        // NOT trimmed. This is the rule's `rationale` as YAML block folding produced it,
        // trailing newline and all, and build_user_prompt() interpolates it untrimmed.
        // Trimming here would change the prompt the model sees by one newline, enough to
        // invalidate any comparison against a golden. Trim at the point of use instead.
        rationale: rule.rationale,
        redirects: redirectsFor(ix, ruleId, rule),
      };
    }
    collected.push([ruleId, rule]);
  }

  if (collected.length) {
    // DENY (non-terminal) > REQUIRE_APPROVAL > ALLOW, ties broken by evaluation.order,
    // which is already the iteration order above.
    collected.sort((a, b) => PRECEDENCE[a[1].effect] - PRECEDENCE[b[1].effect]);
    const [ruleId, rule] = collected[0];
    return {
      decision: rule.effect,
      matched_rule: ruleId,
      rationale: rule.rationale,
      redirects: redirectsFor(ix, ruleId, rule),
    };
  }

  if (implicitInRoleAllow(ix, req, role, resource, destination)) {
    const ruleIds = Object.keys(ix.rulesById);
    const numbers = ruleIds
      .map((r) => /^R(\d+)$/.exec(r))
      .filter(Boolean)
      .map((mm) => Number(mm[1]))
      .sort((a, b) => a - b);
    const contiguous = numbers.length > 1
      && numbers.every((n, i) => n === numbers[0] + i);
    const span = contiguous
      ? `R${numbers[0]}-R${numbers[numbers.length - 1]}`
      : numbers.map((n) => `R${n}`).join(', ');
    return {
      decision: 'ALLOW',
      matched_rule: IMPLICIT_RULE_ID,
      rationale:
        `No rule in access_policy.yaml's ${span} governs this request. It resolves to ` +
        `ALLOW only because the resource's classification (${resource.classification || 'none'}) ` +
        "is at or below the actor's role ceiling and the destination " +
        `(${req.destination}) is trusted. This is a harness-side fallback, not a policy ` +
        // Single quotes around the rule id, not JSON.stringify. This rationale goes into the
        // model's prompt and is stored verbatim in eval/golden/*.json, so its punctuation is
        // contract: changing any of it invalidates goldens.
        `rule - see matched_rule='${IMPLICIT_RULE_ID}' and policy_engine.js's ` +
        'IMPLEMENTATION NOTES item 1.',
      redirects: [],
    };
  }

  return {
    decision: 'DENY',
    matched_rule: null,
    rationale:
      'No rule matched. Default-deny (evaluation.default = DENY): an unanticipated ' +
      'request is not an authorised one.',
    redirects: [],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { evaluate, PolicyError, IMPLICIT_RULE_ID };
}
