#!/usr/bin/env node
/**
 * test_decide_code.js: run the decision Code node's body outside n8n.
 *
 * That script is where the *new* logic lives: the resolver that turns a tool call into a
 * `ResolvedRequest`, and the prompt assembly. The engine underneath is already covered by the
 * Python-vs-JS cross-check; this covers the part that exists only inside the workflow.
 *
 * The body comes from `node build.js bodies`, the same substitution the deploy runs
 * (gateway-decide.ts with gateway/policy_engine.js inlined), so what this drives is what n8n is
 * given rather than a second assembly of it.
 *
 * Testing it here rather than through n8n is forced by the trigger. The workflow starts with an
 * Execute Sub-workflow Trigger, which takes its input from a calling workflow: n8n's MCP
 * `execute_workflow` accepts only chat/form/webhook inputs, `n8n execute --id` accepts no input,
 * and CLI execution does not honour pinned data. So driving the node in isolation means stubbing
 * n8n's `$()` accessor and running the same script text in plain node. The end-to-end path is
 * exercised separately, through the front door.
 *
 * WHY THIS IS JAVASCRIPT. It used to be Python for one reason: it compared the gateway's
 * assembled prompt against the prompt eval/run_eval.py builds, and importing the harness was the
 * only way to be sure both sides meant the same thing by "the prompt". The templates now live in
 * gateway/prompts.yaml and both sides read them, so there is no second prompt to compare
 * against. The one comparison that still crosses languages is narrower: Python's str.format and
 * this node's `fill` helper must agree, given the same template and the same values. That lives
 * in eval/fill_check.py, the file to look at if a prompt comes out wrong.
 *
 * Four things are asserted:
 *
 *   1. The resolver maps each tool to the scope, resource and destination that
 *      docs/GATEWAY_CONTRACT.md section 3 specifies.
 *   2. A caller-supplied `actor` field is ignored: identity comes from the session.
 *   3. An unknown tool throws rather than resolving to something.
 *   4. Every placeholder in both templates gets a value, on every case in the eval set, and the
 *      verdict's own text reaches the prompt. That is the failure a hand-edit to prompts.yaml
 *      causes: a new `{placeholder}` nothing fills, which the model would receive literally.
 *      Cheap to catch here, because this node is the only thing that fills them.
 *
 *   node n8n/workflows/test_decide_code.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILD = path.join(__dirname, 'build.js');
const QUERIES_DIR = path.join(REPO_ROOT, 'eval', 'queries');

const DECISION_NODE = 'Evaluate Access Policy';

const failures = [];

/**
 * The repo's YAML documents, as objects.
 *
 * Node has no YAML parser in its standard library, so the one interpreter this repo already
 * depends on does the parsing. That is a call to a parser, not a second definition of anything;
 * every assertion below is JavaScript. It also mirrors production, where n8n never sees YAML
 * either: gateway_services.js parses these same files and serves the workflow the JSON.
 *
 * One process converts every document at once; thirty-nine interpreter starts would cost more
 * than the rest of this test put together.
 */
function readYamlDocuments(paths) {
  const interpreters = [
    path.join(REPO_ROOT, '.venv-eval', 'bin', 'python'),
    'python3',
  ].filter((p) => !p.includes('/') || fs.existsSync(p));

  const script = [
    'import json, sys',
    'import yaml',
    'print(json.dumps({p: yaml.safe_load(open(p, encoding="utf-8")) for p in sys.argv[1:]}))',
  ].join('\n');

  let lastError = null;
  for (const interpreter of interpreters) {
    try {
      return JSON.parse(execFileSync(interpreter, ['-c', script, ...paths], {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (e) {
      lastError = e;
    }
  }
  console.error(
    '✗ could not parse the repo\'s YAML: no interpreter with PyYAML available.\n' +
    `  Tried: ${interpreters.join(', ')}\n` +
    `  Last error: ${lastError && (lastError.stderr || lastError.message)}`,
  );
  process.exit(1);
}

/** The decision workflow's Code node bodies and the model it names, from the build. */
function builtWorkflow() {
  let out;
  try {
    out = execFileSync(process.execPath, [BUILD, 'bodies'], { encoding: 'utf-8' });
  } catch (e) {
    console.error(`✗ \`node build.js bodies\` failed:\n${e.stdout || ''}\n${e.stderr || ''}`);
    process.exit(1);
  }
  return JSON.parse(out);
}

/**
 * Execute the generated Code-node body, with n8n's accessors stubbed.
 *
 * `new Function` rather than a subprocess: the body is a self-contained script that reads its
 * inputs through `$()` and returns its output, so it has no need of a fresh process, and a
 * thrown error arrives here as an exception instead of as an exit code and a stderr blob.
 */
function runCodeNode(jsCode, nodes) {
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
  const $input = { first: () => ({ json: nodes.__input || {} }) };
  const run = new Function('$', '$input', jsCode);
  const out = run($, $input);
  return out[0].json;
}

function main() {
  const queryFiles = fs.readdirSync(QUERIES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => path.join(QUERIES_DIR, f));

  const POLICY_PATH = path.join(REPO_ROOT, 'policy', 'access_policy.yaml');
  const PROMPTS_PATH = path.join(REPO_ROOT, 'gateway', 'prompts.yaml');
  const documents = readYamlDocuments([POLICY_PATH, PROMPTS_PATH, ...queryFiles]);

  const policy = documents[POLICY_PATH];
  const prompts = documents[PROMPTS_PATH];
  const catalog = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'seed', 'out', 'catalog.json'), 'utf-8'),
  );

  const built = builtWorkflow();
  if (!(DECISION_NODE in built.bodies)) {
    console.error(
      `✗ The build no longer produces a Code node called '${DECISION_NODE}'. It has ` +
      `${JSON.stringify(Object.keys(built.bodies).sort())}.`,
    );
    process.exit(1);
  }
  const jsCode = built.bodies[DECISION_NODE];
  const policyModel = built.policy_model;

  const call = (trigger) => {
    const args = Object.assign({}, trigger);
    const tool = args.tool;
    delete args.tool;
    return runCodeNode(jsCode, {
      'Receive Gateway Request': { tool: tool, args: args },
      'Fetch Access Policy': policy,
      'Fetch Dataset Catalog': catalog,
      'Fetch Model Prompts': prompts,
    });
  };

  // ------------------------------------------------------------------------------- resolver
  // (tool, extra trigger fields) -> (scope_mode, destination)
  const expected = [
    ['whoami', {}, 'identity', 'enclave:governed'],
    ['list_datasets', {}, 'catalog', 'enclave:governed'],
    ['describe_dataset', { resource: 'fleet.clip_catalog' }, 'catalog', 'enclave:governed'],
    ['query_aggregate', {
      resource: 'fleet.night_clips_annotated', record_count: 48217,
      columns: ['LightingCondition'], min_cell_count: 7714,
    }, 'aggregate', 'enclave:governed'],
    ['read_records', { resource: 'ops.gpu_cluster_metrics', record_count: 100 },
      'records', 'enclave:governed'],
    ['read_records', { resource: 'fleet.night_clips_annotated', projection: 'index' },
      'metadata', 'enclave:governed'],
    ['request_export', {
      resource: 'fleet.night_clips_annotated', destination: 'host:workstation',
      record_count: 48217,
    }, 'records', 'host:workstation'],
    ['request_export', {
      resource: 'fleet.night_clips_annotated', projection: 'index',
      destination: 'host:workstation',
    }, 'metadata', 'host:workstation'],
    ['start_training_job', {
      resource: 'fleet.night_clips_annotated', destination: 'enclave:governed',
    }, 'compute', 'enclave:governed'],
    ['publish_model', { resource: 'models.pedestrian_v4', destination: 'registry:global' },
      'records', 'registry:global'],
  ];
  for (const [tool, extra, wantScope, wantDest] of expected) {
    const got = call(Object.assign({ tool: tool, query: 'test' }, extra));
    const req = got.request;
    const label = `${tool}${JSON.stringify(extra)}`;
    if (req.scope_mode !== wantScope) {
      failures.push(`${label}: scope_mode ${wantScope} -> ${req.scope_mode}`);
    }
    if (req.destination !== wantDest) {
      failures.push(`${label}: destination ${wantDest} -> ${req.destination}`);
    }
    if (req.actor !== 'lena.fischer') {
      failures.push(`${tool}: actor was ${req.actor}`);
    }
  }
  console.log(
    `resolver: ${expected.length - failures.length} of ${expected.length} mappings clean`,
  );

  // A caller must not be able to name its own actor.
  const smuggled = call({ tool: 'whoami', query: 'test', actor: 'data.owner' });
  if (smuggled.request.actor !== 'lena.fischer') {
    failures.push("a trigger field named 'actor' overrode the gateway's actor");
  } else {
    console.log("actor: a caller-supplied 'actor' field is ignored, as the contract requires");
  }

  // An unknown tool must fail loudly rather than resolve to something.
  let threw = false;
  try {
    call({ tool: 'exfiltrate_everything', query: 'x' });
  } catch (e) {
    threw = true;
  }
  if (threw) {
    console.log('unknown tool: rejected, as it should be');
  } else {
    failures.push('an unknown tool did not raise');
  }

  // ------------------------------------------------------------------------ prompt assembly
  // Both templates, filled, over every case the resolver can reproduce. Looking for a
  // placeholder with no value behind it: `fill` throws on one it was given no value for, and
  // the scan below catches the reverse, a value that itself arrives looking like a placeholder.
  // Then a check that the verdict's own words reached the prompt, which catches a placeholder
  // wired to the wrong value rather than to none.
  let assembled = 0;
  for (const file of queryFiles) {
    const testCase = documents[file];
    // A case with no expected decision is one the gateway never answers; it is enforced
    // somewhere else, in the sandbox. So there is no prompt for it to assemble.
    if (!testCase.expect || testCase.expect.decision === undefined
        || testCase.expect.decision === null) continue;
    const r = testCase.request;
    // Only the cases whose scope the resolver can reproduce from a tool call. The eval set
    // states scope_mode directly; the gateway derives it, so a case whose stated scope
    // disagrees with the derivation is exercising a different request.
    const got = call({
      tool: r.tool,
      query: testCase.query,
      resource: r.resource || '',
      destination: r.destination,
      record_count: r.record_count,
      columns: r.columns || [],
      min_cell_count: r.min_cell_count,
      projection: r.scope_mode === 'metadata' ? 'index' : 'records',
    });
    if (got.request.scope_mode !== r.scope_mode) continue;

    for (const [which, text] of [['user', got.user_prompt], ['system', got.system_prompt]]) {
      const leftover = /\{[a-z_]+\}/.exec(text);
      if (leftover) {
        failures.push(`${testCase.id}: ${which} prompt still holds ${leftover[0]}`);
      }
    }
    for (const [what, value] of [
      ['decision', got.verdict.decision],
      ['rationale', got.verdict.rationale],
      ['matched rule', got.verdict.matched_rule || '(none — default-deny)'],
    ]) {
      if (!got.user_prompt.includes(String(value))) {
        failures.push(`${testCase.id}: the ${what} never reached the user prompt`);
      }
    }
    if (!got.system_prompt.endsWith(prompts.model_directives[policyModel].directive)) {
      failures.push(`${testCase.id}: the system prompt does not end with the model's directive`);
    }
    assembled += 1;
  }
  console.log(
    `prompts: ${assembled} cases assembled from gateway/prompts.yaml with every ` +
    'placeholder filled',
  );

  console.log('');
  if (failures.length) {
    console.log(`✗ ${failures.length} failure(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('✓ resolver, actor handling and prompt assembly all clean');
}

try {
  main();
} catch (e) {
  // A throw from inside the Code node is a failure of the thing under test, so it is reported
  // as one rather than as a stack trace through this file. The likeliest cause is in the message
  // itself: a placeholder in gateway/prompts.yaml that the node supplies no value for.
  console.error(`\n✗ the decision Code node threw: ${e.message}`);
  process.exit(1);
}
