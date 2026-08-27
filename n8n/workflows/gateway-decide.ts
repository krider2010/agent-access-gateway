/**
 * gateway-decide.ts: the gateway's decision workflow, node by node.
 *
 * This file IS the workflow: n8n Workflow SDK code, the only input
 * `create_workflow_from_code` accepts. Read it top to bottom. A request arrives on the trigger,
 * the policy and catalog are fetched, the engine decides, the model explains, the audit record
 * is written, and only then does one If node choose between running the action and refusing it.
 * Fourteen nodes in that order, with the reasoning beside each.
 *
 * WHAT THE BUILD FILLS IN. Three values live somewhere else, and each appears below as its name
 * between doubled at-signs, a form that is not valid TypeScript anywhere, so a placeholder can
 * never be mistaken for code:
 *
 *   POLICY_ENGINE       gateway/policy_engine.js, inlined into the decision Code node
 *   POLICY_TEMPERATURE  \ the sampling settings gateway/prompts.yaml records, which the eval
 *   POLICY_MAX_TOKENS   / harness posts on every call of its own
 *
 * The engine and the prompts are the files the eval harness tests, so a hand-written copy of
 * either here would drift, and drift invisibly: the workflow keeps working while quietly
 * disagreeing with the thing that was proved correct. `node n8n/workflows/build.js decide
 * --create` substitutes and deploys, and refuses a source that still holds a placeholder.
 *
 * CODE NODE BODIES ARE TEMPLATE LITERALS, AND THE BUILD TAKES THEM AS RAW TEXT. What sits
 * between the backticks is byte-for-byte what runs inside n8n. The build escapes it into the
 * string literal n8n stores rather than letting JavaScript evaluate it, because evaluating it
 * would eat every backslash in the engine's regexes on the way past. One exception: a backtick
 * inside a body is written \`, which keeps this file parseable as TypeScript and arrives as a
 * plain backtick. An unescaped one is reported rather than guessed at.
 *
 * The comments around the node graph are dropped before the source is sent. That costs nothing
 * (n8n stores nodes and connections, never source) and avoids an edge described in build.js.
 * Everything inside a Code node body, comments included, is deployed verbatim.
 *
 * NODE VERSIONS COME FROM `get_node_types`, not from the SDK reference's examples, which pin
 * older ones. Two notes:
 *
 *   - `ifElse` takes `{ version, config: { name, parameters } }`. A flatter
 *     `{ name, conditions }` object is accepted, and silently drops both: you get a node called
 *     "If" with no condition at all, routing every decision down the same branch. That If is
 *     the beat the whole demo turns on, so watch both branches on screen after any edit here.
 *   - the If node stays on 2.2. 2.3 exists, but 2.2 is the version both branches are proven on,
 *     and moving it earns its own verification pass rather than riding along.
 */

import { workflow, node, trigger, languageModel, ifElse } from '@n8n/workflow-sdk';

// The front door calls this workflow with two fields and no more: the tool name it stamps
// itself, and the caller's arguments as one JSON string. Both halves of that are deliberate;
// see the note at the top of gateway-front-door.ts.
const requestTrigger = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.2,
  config: {
    name: 'Receive Gateway Request',
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'tool', type: 'string' },
          { name: 'args', type: 'string' },
        ],
      },
    },
    output: [{
      tool: 'request_export',
      args: {
        query: 'Copy the annotated night clips to my laptop.',
        resource: 'fleet.night_clips_annotated',
        destination: 'host:workstation',
        projection: 'records',
        record_count: 48217,
      },
    }],
  },
});

// The policy, catalog and prompts are fetched per request rather than baked in, which is what
// makes editing policy/access_policy.yaml change the gateway's behaviour without a rebuild.
// eval/e2e_check.py --prove-policy-fetch asserts it.
//
// host.docker.internal because n8n runs in a container and the services run on the host;
// 4301 because that is the port policy/sandbox_policy.yaml does not open to the agent.
const fetchPolicy = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Access Policy',
    parameters: { method: 'GET', url: 'http://host.docker.internal:4301/policy' },
    output: [{ version: 1, rules: [], evaluation: { order: [] } }],
  },
});

const fetchCatalog = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Dataset Catalog',
    parameters: { method: 'GET', url: 'http://host.docker.internal:4301/catalog' },
    output: [{ datasets: [] }],
  },
});

const fetchPrompts = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Model Prompts',
    parameters: { method: 'GET', url: 'http://host.docker.internal:4301/prompts' },
    output: [{ system_prompt_template: '', user_prompt_template: '', model_directives: {} }],
  },
});

// The decision itself. The placeholder on the body's first line is gateway/policy_engine.js,
// inlined by the build; everything after it is the resolver of docs/GATEWAY_CONTRACT.md
// section 3, the part that exists only inside this workflow, which is why
// n8n/workflows/test_decide_code.js drives it directly.
const evaluatePolicy = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Evaluate Access Policy',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `@@POLICY_ENGINE@@
const trigger = $('Receive Gateway Request').first().json;
// The nine tools are exposed by one MCP Server Trigger, and n8n hands a tool call's whole
// argument object to a single field rather than distributing it across named ones. So the
// caller's arguments arrive together in \`args\`, and \`tool\` is a constant the front door
// stamps, never something the caller supplies.
const rawArgs = trigger.args;
const args = (typeof rawArgs === 'string' && rawArgs.trim())
  ? JSON.parse(rawArgs)
  : (rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
const policy = $('Fetch Access Policy').first().json;
const catalog = $('Fetch Dataset Catalog').first().json;
const prompts = $('Fetch Model Prompts').first().json;

// The actor the gateway acts for, and the model that explains its verdicts. The actor is a
// constant here and NOT a trigger input: docs/GATEWAY_CONTRACT.md section 2 requires it to come
// from the session rather than tool arguments, because a request that names its own actor is
// claiming an identity instead of proving one. The model is gateway/prompts.yaml's
// \`policy_model\`, substituted here and into the model node below from that one key.
const GATEWAY_ACTOR = 'lena.fischer';
const POLICY_MODEL = '@@POLICY_MODEL@@';

const numberOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const textOrNull = (v) => (v === undefined || v === null || v === '' ? null : String(v));

// Resolver: docs/GATEWAY_CONTRACT.md section 3. Anything not derivable from a tool call is
// not inferred. Scope comes from the tool, and for the two tools that can address either
// rows or the index it comes from the projection the caller asked for.
const indexOnly = String(args.projection || '') === 'index';
const SCOPE_BY_TOOL = {
  whoami: 'identity',
  list_datasets: 'catalog',
  describe_dataset: 'catalog',
  query_aggregate: 'aggregate',
  read_records: indexOnly ? 'metadata' : 'records',
  request_export: indexOnly ? 'metadata' : 'records',
  start_training_job: 'compute',
  publish_model: 'records',
  request_approval: indexOnly ? 'metadata' : 'records',
};

const tool = String(trigger.tool || '');
const scopeMode = SCOPE_BY_TOOL[tool];
if (!scopeMode) {
  throw new Error('Unknown tool at the gateway: ' + JSON.stringify(tool));
}

// Five of the nine tools carry no destination. The default is the agent's own sandbox, which
// the policy defines as the governed enclave, not "unknown". That is what makes read_records
// on restricted data deny under R6 (a role ceiling) rather than R1 (egress).
const destination = textOrNull(args.destination) || 'enclave:governed';

const request = {
  actor: GATEWAY_ACTOR,
  tool: tool,
  resource: textOrNull(args.resource),
  destination: destination,
  scope_mode: scopeMode,
  record_count: numberOrNull(args.record_count),
  columns: Array.isArray(args.columns)
    ? args.columns
    : (textOrNull(args.columns) ? String(args.columns).split(',').map((c) => c.trim()) : []),
  min_cell_count: numberOrNull(args.min_cell_count),
};

const startedAt = Date.now();
const verdict = evaluate({ policy: policy, catalog: catalog, request: request });

// The engine picks the redirect, not the model, and only when the answer is not already
// yes. sanctioned_paths' rule back-reference is reused for the path an ALLOW rule embodies,
// so redirects is non-empty on ALLOW too and there is nothing to redirect to.
const chosenRedirect = verdict.redirects.length ? verdict.redirects[0] : null;
let redirectBlock = '(none — do not invent one)';
if (chosenRedirect && verdict.decision !== 'ALLOW') {
  const path = (policy.sanctioned_paths || {})[chosenRedirect] || {};
  const summary = path.summary || chosenRedirect;
  // Caveat interpolated raw, newline and all, because the harness does: a YAML folded block
  // ends with a newline and Python's f-string keeps it inside the parentheses. Trimming here
  // is tidier and wrong.
  redirectBlock = summary + (path.caveat ? ' (' + path.caveat + ')' : '');
}

const actorEntry = (policy.actors || []).find((a) => a.id === GATEWAY_ACTOR);
if (!actorEntry) {
  throw new Error('Gateway actor ' + GATEWAY_ACTOR + ' is not in policy.actors');
}

const directiveEntry = (prompts.model_directives || {})[POLICY_MODEL];
if (!directiveEntry) {
  throw new Error('No measured reasoning-suppression directive for ' + POLICY_MODEL);
}

// One pass over the template, not one per placeholder, because two of these values are prose
// written by somebody else: the request's own query text, quoted verbatim, and the rationale
// from policy/access_policy.yaml. A value containing something shaped like {rationale} must
// reach the model as those characters, not be substituted again on a later pass. Python's
// str.format works this way, and eval/fill_check.py holds the two fillers to the same output. A
// placeholder with no value throws rather than travelling to the model as literal braces,
// str.format's choice too: it turns a hand-edit to prompts.yaml that adds a placeholder into a
// failure on the first request instead of a strange answer.
const fill = (template, values) =>
  template.replace(/\{([a-z_]+)\}/g, (whole, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error('No value supplied for the prompts.yaml placeholder ' + whole);
    }
    return String(values[key]);
  });

const systemPrompt = fill(prompts.system_prompt_template, {
  directive_line: directiveEntry.directive,
});

const userPrompt = fill(prompts.user_prompt_template, {
  actor: request.actor,
  role_name: actorEntry.role,
  query: textOrNull(args.query) || '(no query text supplied)',
  tool: request.tool,
  resource: request.resource || '(none)',
  destination: request.destination,
  scope_mode: request.scope_mode,
  // Rendered the way Python renders it. The harness interpolates record_count with an f-string,
  // so a missing count appears as "None"; String(null) gives "null", and the prompt would differ
  // from the golden's by four characters on every tool that carries no count. Parity with the
  // harness beats looking idiomatic.
  record_count: request.record_count === null ? 'None' : request.record_count,
  decision: verdict.decision,
  matched_rule: verdict.matched_rule || '(none — default-deny)',
  rationale: verdict.rationale,
  redirect_block: redirectBlock,
});

return [{
  json: {
    request: request,
    verdict: verdict,
    chosen_redirect: chosenRedirect,
    resource_classification: request.resource
      ? (catalog.datasets.find((d) => d.id === request.resource) || {}).classification || null
      : null,
    resource_residency: request.resource
      ? (catalog.datasets.find((d) => d.id === request.resource) || {}).residency || null
      : null,
    destination_trusted: !!(policy.destinations.find((d) => d.name === request.destination)
      || (request.destination.indexOf('external:') === 0
        ? policy.destinations.find((d) => d.name === 'external:*')
        : null)
      || {}).trusted,
    actor_role: actorEntry.role,
    agent_identity: actorEntry.agent || 'unknown',
    policy_model: POLICY_MODEL,
    system_prompt: systemPrompt,
    user_prompt: userPrompt,
    max_tokens: directiveEntry.max_tokens,
    started_at: startedAt,
  },
}];
`,
    },
    output: [{
      verdict: { decision: 'DENY', matched_rule: 'R1', rationale: '...', redirects: ['train_in_place'] },
      request: { actor: 'lena.fischer', tool: 'request_export', scope_mode: 'records' },
      policy_model: 'nvidia/nvidia-nemotron-nano-9b-v2',
      system_prompt: '...',
      user_prompt: '...',
      started_at: 0,
    }],
  },
});

// The verdict is already made by the time this node exists. The model writes prose about it and
// cannot alter it; invariant 1 of docs/GATEWAY_CONTRACT.md. The temperature and token ceiling
// are the ones gateway/prompts.yaml records, because the eval harness posts those on every call,
// and a gateway that samples differently is not producing comparable answers.
const policyBrain = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatNvidia',
  version: 1,
  config: {
    name: 'Policy Brain (Nemotron)',
    parameters: {
      model: '@@POLICY_MODEL@@',
      options: { temperature: @@POLICY_TEMPERATURE@@, maxTokens: @@POLICY_MAX_TOKENS@@ },
    },
    credentials: { nvidiaApi: { id: 'KerblineNvidia01', name: 'NVIDIA Nemotron (Kerbline)' } },
  },
});

const explainVerdict = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.9,
  config: {
    name: 'Explain The Verdict',
    parameters: {
      promptType: 'define',
      text: '={{ $json.user_prompt }}',
      messages: {
        messageValues: [
          {
            type: 'SystemMessagePromptTemplate',
            message: '={{ $json.system_prompt }}',
          },
        ],
      },
    },
    subnodes: { model: policyBrain },
    output: [{ text: 'That request is denied because ...' }],
  },
});

// Assemble the audit record: the fields access_policy.yaml's audit.record names, and nothing
// else.
const assembleAudit = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Assemble Audit Record',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const decided = $('Evaluate Access Policy').first().json;
const explanation = $input.first().json;

const answer = (explanation && (explanation.text || explanation.output || explanation.response))
  || null;

// Fail closed on the wording, never on the verdict. access_policy.yaml sets
// evaluation.fail_mode: closed. An unexplained denial is acceptable, an unmade decision is
// not. If the model produced nothing usable, compose the answer from the policy itself.
const usable = typeof answer === 'string' && answer.trim().length > 0;
const finalAnswer = usable
  ? answer.trim()
  : String(decided.verdict.rationale).trim();

const redirects = decided.verdict.redirects || [];
// The redirect the gateway put in front of the engineer. Null on ALLOW, for the reason given
// at \`chosenRedirect\` in the decision node. Deterministic, and therefore NOT the same quantity
// as the eval harness's \`redirect_chosen\`, which is scored out of the model's prose; see the
// note on the terminal nodes at the foot of this file.
const redirectPrimary = (decided.verdict.decision !== 'ALLOW' && redirects.length)
  ? redirects[0]
  : null;

const record = {
  timestamp: new Date(decided.started_at).toISOString(),
  actor_id: decided.request.actor,
  actor_role: decided.actor_role,
  agent_identity: decided.agent_identity,
  tool: decided.request.tool,
  resource: decided.request.resource,
  resource_classification: decided.resource_classification,
  resource_residency: decided.resource_residency,
  destination: decided.request.destination,
  destination_trusted: decided.destination_trusted,
  scope_mode: decided.request.scope_mode,
  record_count: decided.request.record_count,
  decision: decided.verdict.decision,
  matched_rule: decided.verdict.matched_rule,
  redirect_offered: decided.verdict.redirects,
  redirect_accepted: null,
  policy_model: decided.policy_model,
  // gateway/prompts.yaml's \`policy_model_location\`. Declared rather than derived, because a
  // Code node cannot read the credential that holds the base URL; build.js checks the
  // declaration against .env's INFERENCE_BASE_URL instead.
  policy_model_location: '@@POLICY_MODEL_LOCATION@@',
  latency_ms: Date.now() - decided.started_at,
};

return [{
  json: {
    audit: record,
    answer: finalAnswer,
    // 'model' or 'fallback': the same two words eval/run_eval.py and every golden use. The
    // gateway and the harness must name the same thing the same way, or comparing a gateway
    // answer to a golden compares two different questions. The prompts dodge that by living in
    // one authored file, gateway/prompts.yaml, that both sides read; these two words are still
    // a convention held in two places by hand.
    answer_source: usable ? 'model' : 'fallback',
    decision: decided.verdict.decision,
    matched_rule: decided.verdict.matched_rule,
    request: decided.request,
    verdict: decided.verdict,
    redirects_offered: redirects,
    redirect_primary: redirectPrimary,
  },
}];
`,
    },
    output: [{
      audit: { decision: 'DENY', matched_rule: 'R1', latency_ms: 1142 },
      answer: 'That request is denied because ...',
      answer_source: 'model',
      decision: 'DENY',
      redirects_offered: ['train_in_place', 'use_redacted_set'],
      redirect_primary: 'train_in_place',
    }],
  },
});

// Written before the branch below, so invariant 4, exactly one audit record per tool call,
// holds whatever the outcome is, including a refusal from the data plane.
const writeAudit = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Append Audit Record',
    parameters: {
      method: 'POST',
      url: 'http://host.docker.internal:4301/audit',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.audit) }}',
    },
    output: [{ appended: true }],
  },
});

// The demo's central beat. See the note on `ifElse` in this file's header before editing the
// shape of this node: given a flatter object it becomes an If with no condition, and every
// decision then leaves by the same branch.
const allowedOrNot = ifElse({
  version: 2.3,
  config: {
    name: 'Allowed?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, version: 2, typeValidation: 'strict' },
        combinator: 'and',
        conditions: [
          {
            id: 'decision-is-allow',
            leftValue: '={{ $("Assemble Audit Record").first().json.decision }}',
            rightValue: 'ALLOW',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
      },
    },
  },
});

// Its own node rather than an expression on the HTTP node, for two reasons. An n8n Code node
// cannot make an HTTP call and an HTTP node cannot compute a body, so something has to sit
// between them; and on a demo screen "here is what the gateway asked the enclave to do" is
// worth being able to click on.
//
// The body is the eight-field ResolvedRequest of docs/GATEWAY_CONTRACT.md section 2 plus the
// Verdict's decision and matched rule, and nothing else. The data plane validates that key set
// strictly in both directions, so a field invented here is a failed call rather than an input
// the resolver never produced quietly reaching the rows.
const shapeEnclaveCall = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Shape The Enclave Call',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const decided = $('Evaluate Access Policy').first().json;
const request = decided.request;

return [{
  json: {
    enclave_request: {
      actor: request.actor,
      tool: request.tool,
      resource: request.resource,
      destination: request.destination,
      scope_mode: request.scope_mode,
      record_count: request.record_count,
      columns: request.columns,
      min_cell_count: request.min_cell_count,
      decision: decided.verdict.decision,
      matched_rule: decided.verdict.matched_rule,
    },
  },
}];
`,
    },
    output: [{ enclave_request: { tool: 'query_aggregate', decision: 'ALLOW' } }],
  },
});

const executeInEnclave = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Execute In The Enclave',
    parameters: {
      method: 'POST',
      url: 'http://host.docker.internal:4301/data/execute',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.enclave_request) }}',
      // fullResponse so the node downstream can see a status code, and neverError so a refusal
      // from the data plane is a reply rather than a dead execution. The audit record is already
      // written by the time this runs, so failing the execution here would cost the engineer
      // their reason and gain nothing.
      options: { response: { response: { fullResponse: true, neverError: true } } },
    },
    output: [{ statusCode: 200, body: { tool: 'query_aggregate', min_cell_count: 7233 } }],
  },
});

// Shape the ALLOW reply around whatever the data plane returned. Because the HTTP node above
// runs with neverError, a refusal arrives here as a status code rather than a failed execution.
const executeAllowed = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Run The Sanctioned Action',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const d = $('Assemble Audit Record').first().json;
const response = $input.first().json;

const status = Number(response.statusCode);
const served = status >= 200 && status < 300;
const body = response.body;

// A data plane that answered 4xx did so for a stated reason; carry it rather than an empty
// result. The access decision stands either way: made, audited, and not revisited here.
const failure = served
  ? null
  : {
      status: status,
      error: (body && body.error) || response.statusMessage || 'the enclave did not serve this request',
    };

return [{
  json: {
    status: d.decision,
    matched_rule: d.matched_rule,
    answer: d.answer,
    answer_source: d.answer_source,
    redirects_offered: d.redirects_offered,
    redirect_primary: d.redirect_primary,
    result: served ? body : null,
    data_plane: served ? 'served' : 'refused',
    data_plane_error: failure,
  },
}];
`,
    },
    output: [{
      status: 'ALLOW',
      matched_rule: 'R2',
      answer: '...',
      answer_source: 'model',
      redirects_offered: ['export_metrics_only'],
      redirect_primary: null,
      result: { tool: 'query_aggregate' },
    }],
  },
});

// The DENY / REQUIRE_APPROVAL terminal. It emits the same field names as the ALLOW terminal
// above, so a replay harness can diff either branch against a golden without knowing which
// branch it took. `result` is null here and only here.
const refuse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Return The Refusal',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const d = $('Assemble Audit Record').first().json;

return [{
  json: {
    status: d.decision,
    matched_rule: d.matched_rule,
    answer: d.answer,
    answer_source: d.answer_source,
    redirects_offered: d.redirects_offered,
    redirect_primary: d.redirect_primary,
    result: null,
    data_plane: 'not reached',
    data_plane_error: null,
  },
}];
`,
    },
    output: [{
      status: 'DENY',
      matched_rule: 'R1',
      answer: '...',
      answer_source: 'model',
      redirects_offered: ['train_in_place', 'use_redacted_set'],
      redirect_primary: 'train_in_place',
      result: null,
    }],
  },
});

// The data plane is three nodes deep on the true branch and unreachable from anywhere else.
// That is how docs/GATEWAY_CONTRACT.md's invariant 2 is enforced: not by a check inside the data
// plane but by there being no other path to it. The data plane rechecks the verdict anyway, so
// rewiring this line fails loudly instead of quietly serving rows.
export default workflow('gateway-decide', 'Kerbline Access Gateway — Decide')
  .add(requestTrigger)
  .to(fetchPolicy)
  .to(fetchCatalog)
  .to(fetchPrompts)
  .to(evaluatePolicy)
  .to(explainVerdict)
  .to(assembleAudit)
  .to(writeAudit)
  .to(allowedOrNot
    .onTrue(shapeEnclaveCall.to(executeInEnclave.to(executeAllowed)))
    .onFalse(refuse));
