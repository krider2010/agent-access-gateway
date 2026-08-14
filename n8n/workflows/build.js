#!/usr/bin/env node
/**
 * build.js: fill in the two workflow sources next to this file, and deploy them.
 *
 * The sources are the workflows. gateway-decide.ts and gateway-front-door.ts hold the node
 * graph, hand-editable and meant to be read. This script substitutes the handful of values that
 * live somewhere else, checks the result and hands it to n8n. It generates nothing.
 *
 *   node n8n/workflows/build.js decide [--create]        # the decision workflow
 *   node n8n/workflows/build.js front-door [--create]    # the MCP front door, after it
 *   node n8n/workflows/build.js bodies                   # the Code node bodies, as JSON
 *   node n8n/workflows/build.js call <tool> '<json>'     # one management MCP call
 *   node n8n/workflows/build.js tools | schema <tool>    # what that surface offers
 *
 * Order matters twice over: the front door needs an id that only exists once the decision
 * workflow has been created, and `bash n8n/workflows/isolate.sh` has to run last, because
 * `create_workflow_from_code` sets `availableInMCP: true` and no MCP tool can unset it.
 *
 * WHAT IS SUBSTITUTED, AND WHY THAT IS NOT OPTIONAL.
 *
 *   @@POLICY_ENGINE@@        gateway/policy_engine.js, inlined into the decision Code node
 *   @@POLICY_TEMPERATURE@@   the sampling settings recorded in gateway/prompts.yaml
 *   @@POLICY_MAX_TOKENS@@
 *   @@DECIDE_WORKFLOW_ID@@   the decision workflow's id, resolved by name from n8n
 *
 * The engine and the prompts are the files the eval harness tests. A second copy of either
 * inside a workflow drifts, and drifts invisibly: the workflow keeps working while quietly
 * disagreeing with the thing that was proved correct. So the coupling is mechanical.
 *
 * WHY `@@NAME@@`. A placeholder sits between two languages and must be impossible to confuse
 * with either. `@@` is not an operator, prefix or literal in TypeScript or JavaScript, so a token
 * can never be mistaken for code nor produced by accident, and it cannot collide with n8n's own
 * `{{ }}` expressions, which appear in both sources. A source still holding `@@` after
 * substitution is refused rather than deployed.
 *
 * MCP, NOT PYTHON. This talks to n8n's management MCP endpoint itself, over the streamable-HTTP
 * transport with SSE framing, using the credentials in the repo-root .env. It used to shell out
 * to a Python helper for that, which was the only reason the build needed Python at all.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const ENGINE_PATH = path.join(REPO_ROOT, 'gateway', 'policy_engine.js');
const PROMPTS_PATH = path.join(REPO_ROOT, 'gateway', 'prompts.yaml');

const SOURCES = {
  decide: path.join(__dirname, 'gateway-decide.ts'),
  'front-door': path.join(__dirname, 'gateway-front-door.ts'),
};

function die(message) {
  console.error(message);
  process.exit(1);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// n8n's management MCP surface
// ---------------------------------------------------------------------------------------------

function loadEnv() {
  const env = {};
  for (const line of read(ENV_PATH).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const at = trimmed.indexOf('=');
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * One JSON-RPC call against the management endpoint.
 *
 * It answers streamable-http with SSE framing, so a reply body looks like
 *
 *     event: message
 *     data: {"result": ...}
 *
 * which is why reading the last line of the body finds an empty one. The last `data:` line
 * carries the payload.
 */
async function rpc(method, params) {
  const env = loadEnv();
  if (!env.N8N_INSTANCE_URL || !env.N8N_MCP_TOKEN) {
    die('✗ .env must carry both N8N_INSTANCE_URL and N8N_MCP_TOKEN.');
  }
  const response = await fetch(env.N8N_INSTANCE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.N8N_MCP_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await response.text();
  if (!response.ok) {
    // A 403 here is almost always the management surface being switched off, which isolate.sh
    // does as the last step of every build. `make n8n-mcp-on` puts it back.
    die(`✗ ${method} → HTTP ${response.status} ${response.statusText}\n${raw.slice(0, 400)}`);
  }
  const framed = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  const parsed = JSON.parse(framed.length ? framed[framed.length - 1] : raw.trim());
  if (parsed.error) die(`✗ MCP error: ${JSON.stringify(parsed.error, null, 2)}`);
  return parsed.result || {};
}

/** tools/call wraps its output in content[].text, usually holding more JSON. */
function unwrap(result) {
  if (!result.content || !result.content.length) return result;
  const joined = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n');
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

async function mcp(tool, args) {
  return unwrap(await rpc('tools/call', { name: tool, arguments: args || {} }));
}

// ---------------------------------------------------------------------------------------------
// The values that get substituted
// ---------------------------------------------------------------------------------------------

/** The engine, minus its CommonJS export block, ready to inline in a Code node. */
function engineSource() {
  let src = read(ENGINE_PATH);
  const marker = "if (typeof module !== 'undefined' && module.exports) {";
  const at = src.indexOf(marker);
  if (at !== -1) src = src.slice(0, at);
  // 'use strict' inside the Code node's own wrapper is redundant and can trip its parser.
  src = src.replace("'use strict';\n", '');
  return `${src.replace(/\s+$/, '')}\n`;
}

/**
 * The two sampling numbers the model node needs, read out of gateway/prompts.yaml.
 *
 * Not a YAML parser: it reads two scalars off their own lines and fails if either is missing.
 * Read rather than hand-written as 0.2 and 300 because eval/run_eval.py reads the same two values
 * out of the same file and posts them on every call, so a gateway that samples differently
 * produces latency and truncation numbers the goldens cannot be compared with. The prompt-text
 * argument, applied to the two settings that travel with it.
 *
 * The scan stops at a comment line, so a `#` line at the indent of a model id ends that model's
 * entry; prompts.yaml is written that way, with each model's measurement notes above it.
 */
function samplingFor(model) {
  const text = read(PROMPTS_PATH);
  const temperature = /^temperature:\s*([0-9.]+)\s*$/m.exec(text);
  if (!temperature) die('✗ gateway/prompts.yaml has no top-level `temperature:` line.');

  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${model}:`);
  if (start === -1) {
    die(
      `✗ gateway/prompts.yaml has no model_directives entry for ${model}, so its reasoning-` +
      'suppression directive has not been measured. Measure it with eval/probe_directive.py ' +
      'and add the entry to gateway/prompts.yaml by hand; guessing one costs more than it saves.',
    );
  }
  const indent = lines[start].search(/\S/);
  let maxTokens = null;
  let hasDirective = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    if (lines[i].search(/\S/) <= indent) break;
    const found = /^\s*max_tokens:\s*(\d+)\s*$/.exec(lines[i]);
    if (found) maxTokens = found[1];
    if (/^\s*directive:/.test(lines[i])) hasDirective = true;
  }
  if (!hasDirective) die(`✗ ${model} has no \`directive:\` in gateway/prompts.yaml.`);
  if (maxTokens === null) die(`✗ ${model} has no \`max_tokens:\` in gateway/prompts.yaml.`);
  return { temperature: temperature[1], maxTokens };
}

/**
 * The policy model, read off the model node and cross-checked against the constant the decision
 * Code node carries. Two places name it: n8n's own parameter, and a value the audit record
 * reports, so the build checks they agree rather than trusting the next person to change both.
 * It also decides which prompts.yaml entry the sampling settings come from.
 */
function policyModel(source, label) {
  const declared = /^[ \t]*model: '([^']+)',$/m.exec(source);
  if (!declared) die(`✗ ${label}: no model node \`model:\` parameter found.`);
  const model = declared[1];
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`const POLICY_MODEL = '${escaped}';`).test(source)) {
    die(
      `✗ ${label}: the model node asks for ${model}, but the decision Code node's ` +
      'POLICY_MODEL names something else. The audit record would report a model that did not ' +
      'answer.',
    );
  }
  return model;
}

// ---------------------------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------------------------

const PLACEHOLDER = /@@([A-Z0-9_]+)@@/g;

function substitute(text, values, where) {
  return text.replace(PLACEHOLDER, (whole, name) => {
    if (!(name in values)) die(`✗ ${where} uses ${whole}, which this build has no value for.`);
    return values[name];
  });
}

const BODY_OPENS = 'jsCode: `';

/**
 * Turn every `jsCode: ` … ` ` region into the single-quoted string literal n8n stores.
 *
 * The body is written as a template literal so it reads as the JavaScript it is, but it is taken
 * as RAW TEXT rather than evaluated. Evaluating it would eat every backslash on the way past, so
 * the engine's regexes would arrive in n8n rewritten and still parsing: the expensive kind of
 * wrong. Escaping raw text instead makes the body n8n runs byte-for-byte the body in the file.
 *
 * One exception, and only one: `\`` is unescaped to a backtick, so a comment inside a body can
 * quote an identifier without ending the region or leaving the source unparseable as TypeScript.
 * An unescaped backtick inside a body is reported rather than guessed at.
 */
function convertCodeBodies(source, values, label) {
  const bodies = [];
  let out = '';
  let pos = 0;
  for (;;) {
    const start = source.indexOf(BODY_OPENS, pos);
    if (start === -1) {
      out += source.slice(pos);
      return { source: out, bodies };
    }
    const from = start + BODY_OPENS.length;
    let i = from;
    while (i < source.length && source[i] !== '`') {
      i += source[i] === '\\' ? 2 : 1;
    }
    if (i >= source.length) die(`✗ ${label}: a jsCode body is never closed.`);
    if (source[i + 1] !== ',') {
      die(
        `✗ ${label}: the jsCode body for ${nodeNameBefore(source, start)} appears to end at a ` +
        'backtick that is not followed by a comma. A body that contains an unescaped backtick ' +
        'gives the build no way to tell where it ends — write it as \\` instead.',
      );
    }
    const name = nodeNameBefore(source, start);
    const raw = source.slice(from, i).replace(/\\`/g, '`');
    const body = substitute(raw, values, `${label} (${name})`);
    bodies.push({ name, body });
    out += source.slice(pos, start) + `jsCode: ${jsStringLiteral(body)}`;
    pos = i + 1;
  }
}

/** The `name:` of the node a body belongs to, so failures name the node rather than an index. */
function nodeNameBefore(source, offset) {
  const named = [...source.slice(0, offset).matchAll(/name: '([^']*)'/g)];
  return named.length ? named[named.length - 1][1] : '(unnamed node)';
}

/**
 * Drop the comment lines before the source goes to n8n.
 *
 * They reach nothing either way: n8n stores a workflow as nodes and connections, so the
 * reasoning around the node graph is for whoever reads the file. Dropping it before the SDK
 * compiler sees it also keeps a sharp edge out of the way, measured 2026-08-13: an odd number of
 * apostrophes across a source's comments makes `validate_workflow` report `Unterminated string
 * constant` inside an unrelated Code node body, and a second apostrophe anywhere else in the file
 * makes the report go away again. One possessive in a comment can fail a build, and two of them
 * hide it.
 *
 * Whole comment lines only, and only after the Code node bodies have become single-line string
 * literals, so nothing here reaches inside a body: every comment explaining the decision logic is
 * deployed intact. Keep comments on their own lines rather than trailing a line of code, since a
 * trailing one survives this and takes the sharp edge with it.
 */
function dropCommentLines(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/** A JS single-quoted literal: the form n8n stores a Code node body in. */
function jsStringLiteral(value) {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n');
  return `'${escaped}'`;
}

// ---------------------------------------------------------------------------------------------
// `node --check` over every Code node body
// ---------------------------------------------------------------------------------------------

/** Every `jsCode:` literal in the built source, still escaped as it sits in the text. */
function extractJsCodeLiterals(built) {
  const marker = "jsCode: '";
  const literals = [];
  let pos = 0;
  for (;;) {
    const start = built.indexOf(marker, pos);
    if (start === -1) return literals;
    let i = start + marker.length;
    const from = i;
    while (i < built.length) {
      if (built[i] === '\\') {
        i += 2;
        continue;
      }
      if (built[i] === "'") break;
      i += 1;
    }
    if (i >= built.length) die('✗ Unterminated jsCode literal in the built source.');
    literals.push(built.slice(from, i));
    pos = i + 1;
  }
}

/**
 * `node --check` every Code node body the built source carries.
 *
 * Unescaped quotes once left the DENY branch holding invalid JavaScript, which n8n accepts at
 * import and fails at run time. The DENY branch is the one the demo's central beat takes, so the
 * first sign of it was on screen. The literals are re-extracted from the built text and unescaped
 * by node's own parser, the same unescaping n8n does when it reads back what
 * create_workflow_from_code stored: that puts the escaping on trial as much as the JavaScript.
 */
function checkCodeBodies(built, names, label, atLeast) {
  const literals = extractJsCodeLiterals(built);
  if (literals.length < atLeast) {
    die(
      `✗ ${label}: found ${literals.length} Code node bodies where at least ${atLeast} were ` +
      'expected — the extractor has drifted from the source.',
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-build-'));
  const failures = [];
  literals.forEach((literal, index) => {
    const where = names[index] ? `'${names[index]}'` : `body ${index}`;
    let body;
    try {
      body = new Function(`return '${literal}';`)();
    } catch (error) {
      // node could not even parse the literal, which is the escaping bug itself.
      failures.push(`  ${where}: the literal is not a parseable JS string — ${error.message}`);
      return;
    }
    // A Code node body is a function body: it ends in `return`, which is a syntax error at the
    // top level of a script and would fail a bare check on every valid body.
    const file = path.join(dir, `body-${index}.js`);
    fs.writeFileSync(file, `function __codeNode($, $input) {\n${body}\n}\n`);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      // node's stderr ends with its own version banner, so the last line is never the
      // interesting one. The SyntaxError and the offending source line are.
      const lines = String(error.stderr || '').split('\n').filter((line) => line.trim());
      const reason = lines.find((line) => line.includes('Error')) || lines[0] || '?';
      const context = lines.slice(0, 3).filter((line) => !line.includes('Error')).map((l) => l.trim());
      failures.push(`  ${where}: ${reason.trim()}\n      near: ${context.join(' | ')}`);
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures.length) {
    die(['✗ Invalid JavaScript in a Code node:'].concat(failures).join('\n'));
  }
  return literals.length;
}

// ---------------------------------------------------------------------------------------------
// Deploying
// ---------------------------------------------------------------------------------------------

/** The id and name the source declares, so this script holds neither. */
function workflowIdentity(source, label) {
  const found = /export default workflow\('([^']+)', '([^']+)'\)/.exec(source);
  if (!found) die(`✗ ${label}: no \`export default workflow('id', 'Name')\` line found.`);
  return { id: found[1], name: found[2] };
}

/** Live workflows of this name, newest first. Never hardcoded: recreating changes the id. */
async function liveWorkflows(name) {
  const found = await mcp('search_workflows', {});
  return (found.data || [])
    .filter((w) => w.name === name && !w.isArchived)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Whatever the management surface says when it declines, in either shape it says it in. */
function refusal(result) {
  if (typeof result === 'string') return result.trim().split('\n')[0];
  if (result && result.error) {
    return typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
  }
  return null;
}

/**
 * Archive the copy this build supersedes. `create_workflow_from_code` always makes a new
 * workflow with a new id, so without this every rebuild leaves another live copy behind, and the
 * front door resolves the decision workflow by name and takes the newest match. Archived rather
 * than deleted: isolate.sh leaves archived workflows alone, and an old copy is occasionally worth
 * looking at.
 *
 * THIS CAN ONLY SUCCEED ON A COPY isolate.sh HAS NOT ALREADY HIDDEN. That is the isolation
 * invariant working, not a problem to route around: the management surface refuses every
 * operation on a workflow carrying `availableInMCP: false`, archiving included. So a copy from
 * the previous full deploy cannot be archived from here, and the refusal is reported rather than
 * papered over; the failure this replaces printed "Archived" on top of "Workflow is not available
 * in MCP". Tidying one up means the same export/expose/import cycle isolate.sh runs, and it is
 * cosmetic: a hidden workflow nothing references decides nothing.
 */
async function archiveSuperseded(name) {
  for (const workflow of await liveWorkflows(name)) {
    const said = refusal(await mcp('archive_workflow', { workflowId: workflow.id }));
    if (said) console.log(`▸ Left the superseded copy ${workflow.id} in place: ${said}`);
    else console.log(`▸ Archived the superseded copy: ${workflow.id}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The two builds
// ---------------------------------------------------------------------------------------------

/** Everything gateway-decide.ts needs, none of which requires n8n to be reachable. */
function decideValues(source, label) {
  const model = policyModel(source, label);
  const sampling = samplingFor(model);
  return {
    model,
    values: {
      POLICY_ENGINE: engineSource(),
      POLICY_TEMPERATURE: sampling.temperature,
      POLICY_MAX_TOKENS: sampling.maxTokens,
    },
  };
}

async function frontDoorValues() {
  const decide = workflowIdentity(read(SOURCES.decide), 'gateway-decide.ts');
  const live = await liveWorkflows(decide.name);
  if (!live.length) {
    die(
      `✗ No live workflow named '${decide.name}'. Build the decision workflow first:\n` +
      '    node n8n/workflows/build.js decide --create',
    );
  }
  console.log(`▸ Decision workflow: ${live[0].id}`);
  return { DECIDE_WORKFLOW_ID: live[0].id };
}

async function build(kind, options) {
  const file = SOURCES[kind];
  const label = path.basename(file);
  const source = read(file);

  let values;
  let minimumBodies;
  if (kind === 'decide') {
    ({ values } = decideValues(source, label));
    minimumBodies = 1;
  } else {
    values = await frontDoorValues();
    minimumBodies = 0;
  }

  const converted = convertCodeBodies(source, values, label);
  const built = dropCommentLines(substitute(converted.source, values, label));
  if (built.includes('@@')) {
    die(`✗ ${label}: a placeholder survived substitution. Nothing was deployed.`);
  }
  // What n8n was sent, byte for byte, for when a validation error names a line number.
  if (options.emit) fs.writeFileSync(options.emit, built);

  const names = converted.bodies.map((body) => body.name);
  console.log(`▸ ${label}: ${built.length} chars after substitution`);
  const checked = checkCodeBodies(built, names, label, minimumBodies);
  console.log(`▸ node --check: ${checked} Code node body/bodies are valid JavaScript`);

  const validated = await mcp('validate_workflow', { code: built });
  console.log(`▸ validate_workflow: ${JSON.stringify(validated)}`);
  if (!validated.valid) die('✗ Validation failed — fix the source before creating anything.');

  const { name } = workflowIdentity(source, label);
  if (!options.create) {
    console.log(`✓ Valid. Re-run with --create to create '${name}' in n8n.`);
    return;
  }

  await archiveSuperseded(name);
  const created = await mcp('create_workflow_from_code', { code: built, name });
  console.log(`✓ Created: ${JSON.stringify(created, null, 2)}`);
  if (kind === 'front-door') {
    console.log();
    console.log('  Now run: bash n8n/workflows/isolate.sh');
    console.log('  It clears availableInMCP on everything but the front door, republishes, and');
    console.log('  restarts n8n. Nothing is isolated until it does.');
  }
}

/**
 * The decision workflow's Code node bodies, as they will run inside n8n, keyed by node name.
 * n8n/workflows/test_decide_code.js drives them through plain node with n8n's accessors stubbed,
 * and reads them from here so what it tests is what gets deployed. Needs only the files on disk.
 */
function printBodies() {
  const label = 'gateway-decide.ts';
  const source = read(SOURCES.decide);
  const { model, values } = decideValues(source, label);
  const { bodies } = convertCodeBodies(source, values, label);
  const out = { policy_model: model, bodies: {} };
  for (const body of bodies) out.bodies[body.name] = body.body;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------

const USAGE = [
  'usage:',
  '  node n8n/workflows/build.js decide [--create] [--emit <path>]',
  '  node n8n/workflows/build.js front-door [--create] [--emit <path>]',
  '  node n8n/workflows/build.js bodies',
  "  node n8n/workflows/build.js call <tool> '<json args>'",
  '  node n8n/workflows/build.js tools | schema <tool>',
  '',
  'The header of this file explains what each of those does and why.',
].join('\n');

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const options = {
    create: argv.includes('--create'),
    emit: argv.includes('--emit') ? argv[argv.indexOf('--emit') + 1] : null,
  };

  if (command === 'decide' || command === 'front-door') {
    await build(command, options);
  } else if (command === 'bodies') {
    printBodies();
  } else if (command === 'call') {
    if (!argv[1]) die(USAGE);
    const result = await mcp(argv[1], argv[2] ? JSON.parse(argv[2]) : {});
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } else if (command === 'tools') {
    const tools = (await rpc('tools/list', {})).tools || [];
    console.log(`${tools.length} tools`);
    for (const tool of tools.map((t) => t.name).sort()) console.log(`  ${tool}`);
  } else if (command === 'schema') {
    const tools = (await rpc('tools/list', {})).tools || [];
    const found = tools.find((t) => t.name === argv[1]);
    if (!found) die(`✗ no such tool: ${argv[1]}`);
    console.log(JSON.stringify(found, null, 2));
  } else {
    die(USAGE);
  }
}

if (require.main === module) {
  main();
}

// isolate.sh verifies the isolation invariant through this same surface, and shares the client
// rather than reimplementing the SSE framing a second time.
module.exports = { mcp, rpc };
