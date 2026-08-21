#!/usr/bin/env node
/**
 * gateway_services.js: the gateway's own side channel, on a port the agent cannot reach.
 *
 * Everything here is off-limits to the agent:
 *
 *   GET  /policy         access_policy.yaml, converted to JSON
 *   GET  /catalog        seed/out/catalog.json
 *   GET  /prompts        gateway/prompts.yaml: the model prompts, shared with the eval harness
 *   POST /audit          append one decision record to audit/decisions.jsonl
 *   GET  /audit/tail     the most recent records. Written for a governance console that does
 *                        not exist yet (`console/` is empty), so it has no consumer
 *   GET  /health         liveness
 *   GET  /data/manifest  which datasets have generated rows, and how many
 *   POST /data/execute   THE DATA PLANE, stage 6 of docs/GATEWAY_CONTRACT.md
 *
 * WHY A SECOND PORT, AND WHY NOT 5678. 5678 is the front door, the only port
 * `policy/sandbox_policy.yaml` opens to the agent's sandbox. Serving the policy source and the
 * audit sink there too would let the agent fetch the policy governing it and, far worse, POST
 * forged audit records, making "governance is provable rather than asserted" untrue.
 *
 * That policy is now scoped to a path rather than a bare port, so a second path on 5678 would
 * be refused. This service still does not belong there. First, the refusal would rest on an L7
 * rule holding, and the `enforcement:` line that makes those rules bite failed silently once
 * already, passing the policy prover while enforcing nothing (see sandbox_policy.yaml's
 * warning). A port in no rule at all is refused by default-deny, which omission cannot get
 * wrong. Second, these endpoints are not the front door's neighbours: they are the policy the
 * decision reads, the sink it is recorded to, and the rows it governs. Three trust boundaries
 * on one listener.
 *
 * So: their own port, bound as narrowly as the n8n container allows, with 4301 deliberately
 * absent from the sandbox allowlist. The refusal rests on that omission rather than on the bind
 * address, so the agent's inability to write the audit log is structural rather than a matter
 * of trust. `install.sh` asserts it on every run.
 *
 * The data plane is here for the same reason, plus one more. `R2` admits aggregates over
 * restricted data, which only means something if the aggregate is computed where the caller
 * cannot reach: a GROUP BY in the agent's own process would have held every row first. So the
 * rows and the counting stay on this side, and only the counts cross back.
 *
 * BIND AS NARROWLY AS THE ONE CLIENT ALLOWS, which is not the same address everywhere. n8n
 * runs in a container and reaches the host through `host.docker.internal`. On Docker Desktop
 * and OrbStack that name NATs to the host's loopback, so 127.0.0.1 is enough. On Docker Engine
 * for Linux it is the docker bridge gateway, so loopback answers nothing and the container gets
 * ECONNREFUSED. `--host` therefore takes a list, and gateway/scripts/services.sh adds the
 * bridge gateway on Linux. Not the wildcard: 0.0.0.0 would put the audit sink and the data
 * plane on every interface the machine has, and on a shared box that is a route in.
 *
 * WHY THE POLICY IS SERVED AS JSON. An n8n Code node has no YAML library, so the conversion
 * happens here. access_policy.yaml stays the single source of truth; only the encoding in
 * transit changes.
 *
 * WHY THIS SERVICE IS THE ONE PLACE WITH A DEPENDENCY. Node ships no YAML parser, so this file
 * needs `js-yaml` (package.json exists for that and nothing else). It is not a run-time network
 * dependency: the sandbox is the thing with no egress, and this process runs on the host.
 * Generating an `access_policy.json` beside the authored YAML was rejected: a second
 * representation of the policy is a second thing that can go stale. One policy engine, not two;
 * one copy of the prompts, not three. A parser is cheaper than a duplicate.
 *
 * WHY THIS IS JAVASCRIPT. So it can `require('./policy_engine.js')` and run the identical
 * decision engine the gateway's Code node runs. See VERIFICATION below.
 *
 * ============================================================================================
 * VERIFICATION: why `decision: ALLOW` in the body is not enough
 * ============================================================================================
 *
 * docs/GATEWAY_CONTRACT.md invariant 2 says the data plane runs only on ALLOW. In the decision
 * workflow that is topology: the HTTP call sits on the true branch of one If node, with no
 * other path to it. This service refuses non-ALLOW anyway, so an edit that rewires the branch
 * fails loudly here rather than quietly serving rows.
 *
 * But that check reads the `decision` field; it does not establish the field is true. Before
 * this service could load the engine, a request posted straight at this port carrying
 * `decision: ALLOW`, `destination: host:workstation` and `fleet.night_clips_annotated` was
 * served in full, GPS and VehicleId included. Sound only because the port is unreachable from
 * the sandbox, the same boundary the audit log leans on; trust rather than verification.
 *
 * So `verifyVerdict` below re-derives the verdict from the ResolvedRequest in the body, using
 * the same policy_engine.js, access_policy.yaml and catalog the gateway decided with, and
 * refuses unless the re-derived decision is ALLOW. The two disagree only if the caller is not
 * the gateway or the gateway has a bug; neither is an authorisation, so neither gets rows.
 * Refusals log at REFUSED on stderr: a disagreement here is the most interesting event this
 * process can observe.
 *
 * Defence in depth, not the primary control; the network boundary still is. It costs one
 * policy evaluation per request, all of it in memory.
 *
 * Requires js-yaml: `npm install` at the repo root. Node 22.2 or later, for zlib.crc32.
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

const yaml = require('js-yaml');

// The one implementation of the access decision. Shared verbatim with the gateway's Code node
// and, through eval/policy_engine_bridge.js, with the eval harness.
const { evaluate, PolicyError } = require('./policy_engine.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const POLICY_PATH = path.join(REPO_ROOT, 'policy', 'access_policy.yaml');
const SEED_OUT = path.join(REPO_ROOT, 'seed', 'out');
const CATALOG_PATH = path.join(SEED_OUT, 'catalog.json');
const MANIFEST_PATH = path.join(SEED_OUT, 'MANIFEST.json');
const PROMPTS_PATH = path.join(REPO_ROOT, 'gateway', 'prompts.yaml');
const AUDIT_DIR = path.join(REPO_ROOT, 'audit');
const AUDIT_PATH = path.join(AUDIT_DIR, 'decisions.jsonl');
const CONSOLE_DIR = path.join(REPO_ROOT, 'console');
const E2E_DIR = path.join(REPO_ROOT, 'eval', 'results', 'e2e');
const E2E_SUMMARY_PATH = path.join(E2E_DIR, 'summary.json');
const E2E_TRACE_PATH = path.join(E2E_DIR, 'trace.jsonl');

// The console's three files, by request path. A map rather than a served directory: a key
// lookup has no traversal to get wrong.
const CONSOLE_FILES = {
  '/console/index.html': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/console/console.css': { name: 'console.css', type: 'text/css; charset=utf-8' },
  '/console/console.js': { name: 'console.js', type: 'text/javascript; charset=utf-8' },
};

// Loaded row sets, keyed by file path. A dataset is parsed on first use and kept; the
// alternative is re-parsing 20 MB of JSON on every aggregate, and the demo asks the same
// question more than once. The cost is resident memory: all six datasets loaded is a few
// hundred megabytes, which restarting the service gets back.
//
// Nothing invalidates this on a file change, so re-running seed/generate.py under a live
// service leaves it answering from the rows it parsed before. That matters when you regenerate
// with a different --seed. Restart before spending an afternoon on why a figure will not move.
//
// The Python service this replaced guarded the cache and the audit append with a mutex, because
// it served requests from a thread pool. Node has no pool: one turn of the event loop runs to
// completion before the next request, and every read and write here is synchronous. So two
// concurrent requests for one dataset cannot both miss the cache, and two audit appends cannot
// interleave, not because a lock says so but because neither can be preempted. Any future
// `await` in these paths gives that away and needs the lock back.
const ROWS_CACHE = new Map();

// How many rows a records read hands back, whatever it asked for. A TRANSPORT limit, not an
// access control: the policy already said yes, and the audit record carries the size of the
// read that was authorised. Returning 17,280 telemetry rows through MCP into an agent's context
// window would be a worse demo and no more governed. The response says what it truncated.
const DEFAULT_ROW_LIMIT = 25;
const MAX_ROW_LIMIT = 500;

// ---------------------------------------------------------------------------
// Reading the documents this service serves. Each re-reads its file rather than caching it,
// and the re-read is load-bearing: eval/e2e_check.py's prove_policy_fetch stops this process
// to show the gateway fetches the policy per request rather than remembering it. A service
// answering /policy from memory would pass a weaker version of that test.
// ---------------------------------------------------------------------------

function readPolicy() {
  return yaml.load(fs.readFileSync(POLICY_PATH, 'utf8'));
}

function readCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

/** The record's field list, read from the policy rather than duplicated here. */
function auditFields() {
  return [...readPolicy().audit.record];
}

/**
 * The seed seed/generate.py ran with, read from its manifest.
 *
 * The training simulator below must be deterministic, and this is what it is deterministic
 * from: the same seed the data came out of, so a metric and the rows behind it are never from
 * different runs.
 */
function generatorSeed() {
  if (!fs.existsSync(MANIFEST_PATH)) return 0;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return Math.trunc(Number(manifest.seed || 0));
}

// ---------------------------------------------------------------------------
// Small conversions that keep this service's output identical to the Python service it
// replaces, down to the digit. Every figure the demo shows comes out of the functions below,
// and a port that quietly moved one in the third decimal place would leave every write-up
// quoting this repository wrong.
// ---------------------------------------------------------------------------

/**
 * Round to `places` decimals the way Python's round() does.
 *
 * `toFixed` is already correctly rounded and differs from Python on exactly one case: an exact
 * halfway value, which Python breaks towards the even digit and JavaScript breaks away from
 * zero. Halfway is reachable only for a dyadic rational (a mean over a cohort whose size is a
 * power of two), so this matters rarely and silently. Hence handled rather than noted.
 */
function roundTo(value, places) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** places;
  const scaled = value * scale;
  if (Math.abs(scaled) < 2 ** 53 && Math.abs(scaled % 1) === 0.5) {
    const below = Math.floor(scaled);
    return (below % 2 === 0 ? below : below + 1) / scale;
  }
  return Number(value.toFixed(places));
}

/** `str()` of a Python float, for the log lines that interpolate one. `8174.0`, not `8174`. */
function floatStr(value) {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Python's `repr()` of one scalar, so a message naming a column or a tool reads unchanged. */
function repr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value !== 'string') return String(value);
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
}

/** Python's `repr()` of a list of scalars: `['GpsLatitude', 'RecordedAt']`. */
function reprList(values) {
  return `[${values.map(repr).join(', ')}]`;
}

/** UTC now, in the format Python's `datetime.isoformat()` produces. Milliseconds, not
 *  microseconds: that is Node's clock resolution, and three invented zeroes would claim
 *  precision this process does not have. */
function isoNow() {
  return new Date().toISOString().replace('Z', '+00:00');
}

/** A group key rendered for sorting. Grouping is by string order rather than by native type,
 *  so that a column mixing nulls and values still has one total order. */
function sortKey(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

/** Element-wise comparison of two arrays of strings, i.e. tuple ordering. */
function compareKeys(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/** Recursively sort object keys, so the audit log's lines are ordered rather than incidental. */
function withSortedKeys(value) {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = withSortedKeys(value[key]);
  return out;
}

// =============================================================================
// The data plane: stage 6 of docs/GATEWAY_CONTRACT.md
//
// Reached only through POST /data/execute, which takes a `ResolvedRequest` and the `Verdict`
// that was reached about it.
//
// THE VERDICT IS RE-DERIVED HERE, not read. See VERIFICATION in the header comment.
//
// COLUMN METADATA IS NOT DEFINED HERE. Every column name this module recognises comes from the
// dataset's `columns` block in seed/out/catalog.json, so describe_dataset, the aggregate route
// and the records route cannot disagree about a schema. There is only one.
// =============================================================================

const DATA_PLANE_REQUEST_FIELDS = new Set([
  // The canonical eight of docs/GATEWAY_CONTRACT.md §2 ...
  'actor',
  'tool',
  'resource',
  'destination',
  'scope_mode',
  'record_count',
  'columns',
  'min_cell_count',
  // ... and the verdict that authorised it. Nothing else: a data plane that accepts a
  // field the resolver never produced is a data plane taking instructions from the caller.
  'decision',
  'matched_rule',
]);

/** A request the data plane cannot serve. Carries the status to answer with. */
class DataPlaneError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function findDataset(resource) {
  if (!resource) throw new DataPlaneError(422, 'this tool needs a resource');
  for (const d of readCatalog().datasets || []) {
    if (d.id === resource) return d;
  }
  throw new DataPlaneError(
    404,
    `${resource} is not in the catalog — regenerate seed/out/catalog.json`,
  );
}

/**
 * This dataset's rows, preferring the full set and falling back to the sample.
 *
 * Both paths come off the dataset's own `row_files` block, so the file layout lives in the
 * generator, not here. The fallback is why someone who clones the repo and runs
 * `seed/generate.py` without --full still gets a working gateway. The returned provenance says
 * which file answered, so a sample figure is never mistaken for a population one.
 */
function loadRows(dataset) {
  const files = dataset.row_files;
  if (!files) {
    throw new DataPlaneError(
      422,
      `${dataset.id} has no tabular rows — it is a single artifact, not a table`,
    );
  }

  for (const volume of ['full', 'sample']) {
    const file = path.join(SEED_OUT, files[volume]);
    if (!fs.existsSync(file)) continue;
    if (!ROWS_CACHE.has(file)) {
      ROWS_CACHE.set(file, JSON.parse(fs.readFileSync(file, 'utf8')).rows);
    }
    const rows = ROWS_CACHE.get(file);
    const provenance = {
      file: files[volume],
      volume,
      rows_available: rows.length,
      catalog_count: dataset.volume.count,
    };
    if (volume === 'sample') {
      provenance.caveat =
        'Computed over the sample file. The catalog states '
        + `${dataset.volume.count} ${dataset.volume.unit}; this is `
        + `${rows.length} display rows. Run \`seed/generate.py --full\` before quoting `
        + 'any figure from here as a figure about the dataset.';
    } else if (dataset.volume.generated_count !== undefined
      && dataset.volume.generated_count !== null) {
      provenance.caveat =
        `The catalog states ${dataset.volume.count} `
        + `${dataset.volume.unit} as the logical population; this file holds `
        + `${dataset.volume.generated_count}, deliberately. Any figure here is `
        + 'a figure over what is in the file.';
    }
    return { rows, provenance };
  }

  throw new DataPlaneError(
    404,
    `no generated rows for ${dataset.id} — run \`python3 seed/generate.py --full\``,
  );
}

/** The dataset's columns by name. A Map rather than an object because these names come out of
 *  a generated file, and a column called `constructor` should not resolve to one. */
function columnsOf(dataset) {
  const out = new Map();
  for (const c of dataset.columns || []) out.set(c.name, c);
  return out;
}

/**
 * The rows a request's cohort size selects, and a note about which ones.
 *
 * docs/GATEWAY_CONTRACT.md §2 defines `record_count` as the size of the cohort the request
 * selects; §4 has the gateway measure it before deciding. It carries the size, not the filter
 * that produced it, so this side cannot know *which* rows were meant. It takes that many rows
 * in generated order and says so, rather than implying a reconstruction it did not perform.
 * Anything that turns on which rows (a WHERE clause reaching the enclave) changes the
 * ResolvedRequest and so the contract; it is not to be smuggled in through this function.
 */
function cohort(rows, recordCount) {
  if (recordCount === null || recordCount === undefined || Math.trunc(recordCount) >= rows.length) {
    return { selected: rows, note: `all ${rows.length} rows in the file` };
  }
  const n = Math.max(0, Math.trunc(recordCount));
  return {
    selected: rows.slice(0, n),
    note:
      `the first ${n} rows in generated order. The ResolvedRequest carries a cohort size `
      + 'but not the filter that selected it, so the cohort is reproduced by size and not '
      + 'by predicate — see docs/GATEWAY_CONTRACT.md §4',
  };
}

/**
 * Stored numeric columns, taken off the catalog's column block.
 *
 * Generic rather than a per-dataset list: whatever the generator calls a number gets a mean
 * and a sum. Some are uninteresting (the mean of `gpu_memory_total_gb` is always 80), which
 * beats a hardcoded table of interesting columns going stale the first time a dataset gains one.
 *
 * The exception is `privacy.forbidden_aggregate_columns`. `R9` forbids grouping by those four;
 * this goes further and reports no statistic over them at all. A mean latitude across 26,434
 * clips discloses nothing, so the reason is not disclosure. It is that the argument on screen
 * makes position and time the sensitive axis, and printing `mean_GpsLatitude` invites the
 * obvious question. Read from the policy, not listed here, so the two cannot drift.
 */
function numericMeasureColumns(dataset) {
  const forbidden = new Set((readPolicy().privacy || {}).forbidden_aggregate_columns || []);
  return (dataset.columns || [])
    .filter((c) => c.kind === 'stored' && (c.type === 'number' || c.type === 'integer')
      && !forbidden.has(c.name))
    .map((c) => c.name);
}

/** Everything this module reports about a set of rows. */
function measuresFor(rows, dataset) {
  const out = { record_count: rows.length };
  if (!rows.length) return out;

  for (const name of numericMeasureColumns(dataset)) {
    const values = rows.filter((r) => typeof r[name] === 'number').map((r) => r[name]);
    if (!values.length) continue;
    const total = values.reduce((a, b) => a + b, 0);
    out[`sum_${name}`] = roundTo(total, 3);
    out[`mean_${name}`] = roundTo(total / values.length, 3);
  }

  if (columnsOf(dataset).has('labels')) {
    const totals = {};
    for (const r of rows) {
      for (const [cls, n] of Object.entries(r.labels || {})) {
        totals[cls] = (totals[cls] || 0) + Math.trunc(Number(n));
      }
    }
    out.label_instances = totals;
    out.mean_label_instances_per_record = Object.fromEntries(
      Object.entries(totals).map(([cls, n]) => [cls, roundTo(n / rows.length, 3)]),
    );
  }
  return out;
}

/**
 * Refuse an aggregate whose declared profile the enclave cannot corroborate.
 *
 * R8 tests `record_count` and R10 tests `min_cell_count`, and both reach the gateway from the
 * caller's own arguments, per docs/GATEWAY_CONTRACT.md §4. So the verdict can be reached on a
 * lie, and this stops the lie being paid out.
 *
 * One direction only. Overstating either figure clears a floor the data does not clear.
 * Understating can only make the decision stricter, so it is served and reported instead.
 *
 * One limit: `record_count` arrives without the filter that produced it, so the cells measured
 * here are those of *a* cohort of that size and not of the caller's. An honest caller can
 * therefore be refused, which is the direction this fails in.
 */
function verifyProfile(request, dataset, rowCount, measuredMin, groupBy) {
  const num = (v) => (v === null || v === undefined ? null : Math.trunc(v));
  const declaredCount = num(request.record_count);
  const declaredMin = num(request.min_cell_count);

  if (declaredCount !== null && declaredCount > rowCount) {
    warn(
      `REFUSED /data/execute: declared cohort ${declaredCount} exceeds the ${rowCount} rows `
      + `${dataset.id} holds. actor=${repr(request.actor)} tool=${repr(request.tool)}`,
    );
    throw new DataPlaneError(
      403,
      `this request declares a cohort of ${declaredCount} records, but ${dataset.id} holds `
      + `${rowCount}. R8 tests the declared figure against the k-anonymity floor, so a cohort `
      + 'claimed larger than the data can supply would clear a floor it does not clear. The '
      + 'verdict was reached on the declaration; the result is refused here. See '
      + 'docs/GATEWAY_CONTRACT.md §4.',
    );
  }

  if (declaredMin !== null && declaredMin > measuredMin) {
    const grouping = groupBy.length ? `by ${reprList(groupBy)}` : 'with no GROUP BY';
    warn(
      `REFUSED /data/execute: declared smallest cell ${declaredMin} exceeds the measured `
      + `${measuredMin} grouping ${grouping}. actor=${repr(request.actor)} `
      + `resource=${repr(request.resource)}`,
    );
    throw new DataPlaneError(
      403,
      `this request declares a smallest group of ${declaredMin}, but grouping the declared `
      + `cohort ${grouping} gives ${measuredMin}. R10 tests the declared figure, so a cell `
      + 'claimed larger than it is would clear the floor on a grouping that returns groups of '
      + `${measuredMin}. The verdict was reached on the declaration; the result is refused `
      + 'here. See docs/GATEWAY_CONTRACT.md §4.',
    );
  }
}

/**
 * A real GROUP BY over the generated rows, returning measured cell counts.
 *
 * Handles the two shapes a groupable column can have. `LightingCondition` is a stored key and
 * groups the obvious way. `label_class` is not stored at all: it is the per-label key inside
 * each row's `labels` object, so grouping by it unpivots. Every clip in the cohort contributes
 * to every class's group, which is why a `label_class` cell is the size of the cohort.
 * eval/queries/allow_r2_aggregate_k25_boundary.yaml groups by that column and declares a
 * smallest cell of 25 over a cohort of 25; this is why that is right.
 */
function runAggregate(request, dataset) {
  const { rows, provenance } = loadRows(dataset);
  const known = columnsOf(dataset);
  const groupBy = [...(request.columns || [])];

  const unknown = groupBy.filter((c) => !known.has(c));
  if (unknown.length) {
    throw new DataPlaneError(
      422,
      `${dataset.id} has no column(s) ${reprList(unknown)}. Call describe_dataset for the schema.`,
    );
  }
  const nested = groupBy.filter((c) => known.get(c).kind === 'nested');
  if (nested.length) {
    throw new DataPlaneError(
      422,
      `${reprList(nested)} is an object rather than a dimension. Group by label_class to break a `
      + 'measure down by object class.',
    );
  }

  const { selected, note: selectionNote } = cohort(rows, request.record_count);
  const pseudo = groupBy.filter((c) => known.get(c).kind === 'pseudo');
  const stored = groupBy.filter((c) => known.get(c).kind === 'stored');

  const groups = [];
  if (pseudo.length) {
    if (stored.length) {
      throw new DataPlaneError(
        422,
        'label_class cannot be combined with a stored column in one grouping: the '
        + 'unpivot would multiply the cohort rather than partition it, and a cell '
        + 'count that is not a partition is not a cell count.',
      );
    }
    const classes = new Set();
    for (const r of selected) for (const cls of Object.keys(r.labels || {})) classes.add(cls);
    for (const cls of [...classes].sort()) {
      let instances = 0;
      let withAny = 0;
      for (const r of selected) {
        const n = Math.trunc(Number((r.labels || {})[cls] || 0));
        instances += n;
        if (n > 0) withAny += 1;
      }
      groups.push({
        key: { label_class: cls },
        // Every row in the cohort carries a count for every class, so the cell is the
        // cohort, and that number is what R10 is enforced against.
        record_count: selected.length,
        instances,
        mean_instances_per_record: selected.length ? roundTo(instances / selected.length, 3) : 0,
        records_with_at_least_one: withAny,
      });
    }
  } else if (stored.length) {
    const buckets = new Map();
    for (const r of selected) {
      const key = stored.map((c) => (r[c] === undefined ? null : r[c]));
      const id = JSON.stringify(key);
      if (!buckets.has(id)) buckets.set(id, { key, rows: [] });
      buckets.get(id).rows.push(r);
    }
    const ordered = [...buckets.values()]
      .sort((a, b) => compareKeys(a.key.map(sortKey), b.key.map(sortKey)));
    for (const bucket of ordered) {
      const key = {};
      stored.forEach((c, i) => { key[c] = bucket.key[i]; });
      groups.push({ key, ...measuresFor(bucket.rows, dataset) });
    }
  } else {
    // No GROUP BY: one group, so the smallest cell is the cohort. access_policy.yaml's
    // R10 notes say so.
    groups.push({ key: {}, ...measuresFor(selected, dataset) });
  }

  const cells = groups.length ? groups.map((g) => Math.trunc(g.record_count)) : [0];
  const measuredMin = Math.min(...cells);

  verifyProfile(request, dataset, rows.length, measuredMin, groupBy);

  const declaredMin = request.min_cell_count;
  const declaredCount = request.record_count;
  return {
    tool: 'query_aggregate',
    resource: dataset.id,
    source: provenance,
    group_by: groupBy,
    cohort: {
      requested: declaredCount,
      used: selected.length,
      selection: selectionNote,
    },
    group_count: groups.length,
    min_cell_count: measuredMin,
    max_cell_count: Math.max(...cells),
    groups,
    // The gateway decided on numbers the caller supplied; these are the numbers the data holds.
    // Reaching here means verifyProfile found no overstatement, so what remains is an
    // under-declaration, which can only have made the verdict stricter. Both are printed
    // because the gap is still there: §4 wants the profile measured pre-decision, and this
    // build measures it post-decision and refuses rather than reconciling.
    profile_check: {
      declared_record_count: declaredCount,
      declared_min_cell_count: declaredMin,
      measured_min_cell_count: measuredMin,
      agrees: declaredMin !== null && declaredMin !== undefined
        && Math.trunc(declaredMin) === measuredMin,
      note:
        'The verdict was reached on the declared figures; these are the measured ones. '
        + 'An overstated profile is refused rather than served, so a difference here is '
        + 'the caller having claimed less than the data holds, which can only have made '
        + 'the decision stricter. docs/GATEWAY_CONTRACT.md §4 still wants the profile '
        + 'measured before the verdict rather than after it.',
    },
  };
}

/** Actual rows, projected to the requested columns. */
function runReadRecords(request, dataset) {
  const { rows, provenance } = loadRows(dataset);
  const known = columnsOf(dataset);
  const projection = (request.columns || []).filter((c) => (known.get(c) || {}).kind !== 'pseudo');

  const unknown = projection.filter((c) => !known.has(c));
  if (unknown.length) {
    throw new DataPlaneError(
      422,
      `${dataset.id} has no column(s) ${reprList(unknown)}. Call describe_dataset for the schema.`,
    );
  }

  const { selected, note: selectionNote } = cohort(rows, request.record_count);
  const limit = Math.min(DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
  const shown = selected.slice(0, limit);
  const projected = projection.length
    ? shown.map((r) => Object.fromEntries(
      projection.map((c) => [c, r[c] === undefined ? null : r[c]]),
    ))
    : shown;

  return {
    tool: 'read_records',
    resource: dataset.id,
    source: provenance,
    // With no projection the rows come back whole, so this lists the keys a row has.
    // `label_class` is excluded: it is a pseudo column the aggregate route synthesises and no
    // row carries it, so naming it would describe a shape other than the one returned.
    columns: projection.length
      ? projection
      : (dataset.columns || []).filter((c) => c.kind !== 'pseudo').map((c) => c.name),
    rows_authorised: selected.length,
    rows_returned: projected.length,
    cohort_selection: selectionNote,
    truncation: projected.length === selected.length
      ? null
      : `${selected.length} rows were authorised; ${projected.length} are returned. This is a `
        + 'transport limit, not an access decision — the policy already allowed the read '
        + 'and the audit record carries its full size.',
    rows: projected,
  };
}

/**
 * One dataset's schema, volume and owner.
 *
 * Nothing here treats classification specially, and that is now the policy's position too rather
 * than this function declining to have one. R11 allows catalog-scope reads at any classification
 * to a trusted destination; a restricted dataset's schema used to fall to bare default-deny. This
 * runs only on ALLOW, and what ALLOW means is the policy's business.
 */
function runDescribeDataset(request, dataset) {
  const files = dataset.row_files;
  let rowsPresent = null;
  if (files) {
    rowsPresent = {};
    for (const volume of ['sample', 'full']) {
      rowsPresent[volume] = fs.existsSync(path.join(SEED_OUT, files[volume]));
    }
  }
  return {
    tool: 'describe_dataset',
    resource: dataset.id,
    description: dataset.description,
    classification: dataset.classification,
    residency: dataset.residency,
    owner: dataset.owner,
    volume: dataset.volume,
    synthetic: true,
    columns: dataset.columns || [],
    column_count: (dataset.columns || []).length,
    rows_generated: rowsPresent,
    notes: dataset.notes || '',
    ...(dataset.derived_from ? { derived_from: dataset.derived_from } : {}),
  };
}

/** The catalog, without the column blocks, which are describe_dataset's job. */
function runListDatasets() {
  const catalog = readCatalog();
  return {
    tool: 'list_datasets',
    banner: catalog.banner,
    organisation: catalog.organisation,
    dataset_count: catalog.datasets.length,
    datasets: catalog.datasets.map((d) => ({
      id: d.id,
      description: d.description,
      classification: d.classification,
      residency: d.residency,
      owner: d.owner,
      volume: d.volume,
      synthetic: true,
      ...(d.derived_from ? { derived_from: d.derived_from } : {}),
    })),
  };
}

/**
 * The entitlement bundle, demo beat 2.
 *
 * Assembled from the policy rather than written out here, so what the agent is told it may
 * reach and what the engine will actually permit are the same document.
 */
function runWhoami(request) {
  const policy = readPolicy();
  const actorId = request.actor;
  const actor = (policy.actors || []).find((a) => a.id === actorId);
  if (!actor) throw new DataPlaneError(422, `${actorId} is not in policy.actors`);
  const role = (policy.roles || {})[actor.role] || {};
  return {
    tool: 'whoami',
    actor: actor.id,
    display_name: actor.display_name ?? null,
    role: actor.role,
    team: actor.team ?? null,
    agent: actor.agent ?? null,
    entitlements: {
      may_read_up_to: role.may_read_up_to ?? null,
      restricted_access: role.restricted_access || [],
      may_request_approval_for: role.may_request_approval_for || [],
      may_approve: Boolean(role.may_approve),
    },
    destinations: (policy.destinations || []).map((d) => ({
      name: d.name,
      trusted: d.trusted,
      on_premises: d.on_premises,
    })),
    egress_allowlist: policy.egress_allowlist || [],
    k_anonymity_min: (policy.privacy || {}).k_anonymity_min ?? null,
    note:
      'Capabilities are unchanged by connecting to this gateway; only reachability is. '
      + 'Nothing on the egress allowlist is not an oversight — adding a host to it is a '
      + 'deliberate, reviewable act.',
  };
}

// --- the training simulator ---------------------------------------------------------------
//
// NOTHING HERE TRAINS A MODEL. No GPU, no weights. Every metric below is computed by the
// documented curve in `recallCurve`, from counts taken out of the generated rows. The response
// says `simulated: true`, and says it in prose too, because a fabricated metric presented as a
// measurement is the kind of claim this repository exists to argue against.
//
// The numbers serve the argument docs/SCENARIO.md §5 and §5.1 make, which is not "our model is
// good" but two narrower claims, both checkable against the inputs the response returns:
//
//   1. Training in place gets Lena a usable model. Beat 5 is a redirect rather than a brochure
//      only if the metrics that come back are ones she could act on.
//   2. The redacted research set is for iteration, not a replacement. §5.1's answer to "just
//      blur the faces" is that redaction is least reliable on the small, distant, poorly-lit
//      figures that move night-time recall. So a run on the redacted set has to come back
//      visibly worse, and for that reason rather than for having fewer clips.
//
// So a run against the restricted set also reports the same run against the redacted one.
// Asserting the contrast while returning one number would repeat the stub this replaced.
const RECALL_FLOOR = 0.604;     // night-time pedestrian recall of the model already shipped
const RECALL_CEILING = 0.912;   // what this architecture saturates at, given unlimited examples
const RECALL_SCALE = 4200.0;    // examples at which most of the gap is closed
const PRECISION_FLOOR = 0.781;
const PRECISION_CEILING = 0.943;
const PRECISION_SCALE = 9000.0;
const TRAINING_EPOCHS = 12;

/** Saturating returns on training examples: floor at zero, ceiling in the limit. */
function recallCurve(examples, floor, ceiling, scale) {
  return ceiling - (ceiling - floor) * Math.exp(-Math.max(0, examples) / scale);
}

/**
 * Python's Mersenne Twister, enough of it to reproduce `random.Random(n).uniform(a, b)`.
 *
 * Reproduced rather than replaced because the figures it feeds are already quoted elsewhere.
 * This demo reports night-time recall 0.8703 against 0.699 on the redacted set, and the last
 * thousandths are jitter rather than curve. Any other generator would be an equally good source
 * of deterministic noise and would silently move every metric the demo shows: a poor trade for
 * forty lines.
 *
 * MT19937 with Python's `init_by_array` seeding and its 53-bit `random()`, verified digit for
 * digit against CPython across a spread of seeds. Nothing else here needs randomness; if the
 * jitter goes, this goes with it.
 */
function pythonRandom(seed) {
  const N = 624;
  const M = 397;
  const mt = new Uint32Array(N);

  mt[0] = 19650218;
  for (let i = 1; i < N; i += 1) {
    mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
  }
  // Python seeds from the absolute value of the integer, split into 32-bit words. Every seed
  // this service uses fits in one word.
  const key = [seed >>> 0];
  let i = 1;
  let j = 0;
  for (let k = Math.max(N, key.length); k; k -= 1) {
    mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
    i += 1;
    j += 1;
    if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    if (j >= key.length) j = 0;
  }
  for (let k = N - 1; k; k -= 1) {
    mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
    i += 1;
    if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
  }
  mt[0] = 0x80000000;

  let index = N;
  function nextWord() {
    if (index >= N) {
      for (let k = 0; k < N; k += 1) {
        const y = ((mt[k] & 0x80000000) | (mt[(k + 1) % N] & 0x7fffffff)) >>> 0;
        mt[k] = (mt[(k + M) % N] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0)) >>> 0;
      }
      index = 0;
    }
    let y = mt[index];
    index += 1;
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }

  return {
    /** Python's random(): 53 bits out of two words. */
    random() {
      const a = nextWord() >>> 5;
      const b = nextWord() >>> 6;
      return (a * 67108864 + b) * (1.0 / 9007199254740992.0);
    },
    uniform(low, high) {
      return low + (high - low) * this.random();
    },
  };
}

/**
 * The counts a run against this dataset would have to learn from.
 *
 * Night-time pedestrian instances, the metric Lena is trying to move. For the redacted set the
 * count is discounted by RedactionConfidence: an instance the redactor blurred over is one the
 * model cannot learn from. That discount is where §5.1's argument becomes a number.
 */
function trainingInputs(dataset) {
  const { rows, provenance } = loadRows(dataset);
  const night = rows.filter((r) => r.LightingCondition === 'night');
  const day = rows.filter((r) => r.LightingCondition === 'day');

  const pedestrians = (subset) => subset.reduce(
    (total, r) => total + Math.trunc(Number((r.labels || {}).pedestrian || 0)),
    0,
  );

  const nightInstances = pedestrians(night);
  const redacted = columnsOf(dataset).has('RedactionConfidence');
  const usableNight = redacted
    ? night.reduce(
      (total, r) => total
        + Math.trunc(Number((r.labels || {}).pedestrian || 0)) * Number(r.RedactionConfidence),
      0,
    )
    : nightInstances;

  return {
    source: provenance,
    clips: rows.length,
    night_clips: night.length,
    day_clips: day.length,
    night_pedestrian_instances: nightInstances,
    day_pedestrian_instances: pedestrians(day),
    usable_night_pedestrian_instances: roundTo(usableNight, 1),
    redaction_discount_applied: redacted,
    ...(redacted && night.length
      ? {
        mean_redaction_confidence_night: roundTo(
          night.reduce((total, r) => total + Number(r.RedactionConfidence), 0) / night.length,
          3,
        ),
      }
      : {}),
  };
}

function trainingMetrics(dataset, jitter) {
  const inputs = trainingInputs(dataset);
  const usable = Number(inputs.usable_night_pedestrian_instances);
  // A few thousandths of noise from a generator seeded off the data's own seed, so two runs of
  // the same job report the same figures without those figures looking formulaic.
  const wobble = () => jitter.uniform(-0.003, 0.003);
  const nightRecall = recallCurve(usable, RECALL_FLOOR, RECALL_CEILING, RECALL_SCALE) + wobble();
  const dayRecall = recallCurve(
    Number(inputs.day_pedestrian_instances), RECALL_FLOOR, RECALL_CEILING, RECALL_SCALE,
  ) + wobble();
  const precision = recallCurve(
    usable, PRECISION_FLOOR, PRECISION_CEILING, PRECISION_SCALE,
  ) + wobble();
  return {
    dataset: dataset.id,
    classification: dataset.classification,
    inputs,
    pedestrian_recall_night: roundTo(nightRecall, 4),
    pedestrian_recall_day: roundTo(dayRecall, 4),
    pedestrian_precision_night: roundTo(precision, 4),
    pedestrian_recall_night_baseline: RECALL_FLOOR,
    pedestrian_recall_night_delta: roundTo(nightRecall - RECALL_FLOOR, 4),
    epochs: TRAINING_EPOCHS,
  };
}

/**
 * R5's sanctioned path, executed. Metrics, logs and a model card, never data.
 *
 * policy/access_policy.yaml's R5 sets `returns: [metrics, logs, model_card]`, and that list is
 * the whole shape of this response. No training row appears in it, which is what "move the
 * computation to the data" has to mean.
 */
function runStartTrainingJob(request, dataset) {
  const seed = generatorSeed();
  const jitter = pythonRandom(seed ^ zlib.crc32(dataset.id));
  const metrics = trainingMetrics(dataset, jitter);

  let comparison = null;
  const redactedId = 'fleet.night_clips_redacted_research';
  if (dataset.id !== redactedId) {
    try {
      const other = findDataset(redactedId);
      comparison = trainingMetrics(other, pythonRandom(seed ^ zlib.crc32(redactedId)));
    } catch (err) {
      if (!(err instanceof DataPlaneError)) throw err;
      comparison = null;
    }
  }

  const jobId = `train-${String(seed).padStart(5, '0')}`
    + `-${String(zlib.crc32(dataset.id) % 100000).padStart(5, '0')}`;
  const inputs = metrics.inputs;
  const delta = metrics.pedestrian_recall_night_delta;
  const logs = [
    `[00:00:00] job ${jobId} accepted; execution location ${request.destination}`,
    `[00:00:01] dataset ${dataset.id} (${dataset.classification}, `
      + `residency ${dataset.residency}) mounted read-only in place; no copy made`,
    `[00:00:04] ${inputs.clips} clips indexed, ${inputs.night_clips} night, `
      + `${inputs.night_pedestrian_instances} night pedestrian instances`,
    ...(inputs.redaction_discount_applied
      ? [
        '[00:00:05] redaction discount applied: '
        + `${floatStr(inputs.usable_night_pedestrian_instances)} of `
        + `${inputs.night_pedestrian_instances} night pedestrian instances usable `
        + '(mean redactor confidence '
        + `${floatStr(inputs.mean_redaction_confidence_night)})`,
      ]
      : []),
    `[00:00:06] fine-tuning ${TRAINING_EPOCHS} epochs`,
    `[00:41:18] night pedestrian recall ${metrics.pedestrian_recall_night} `
      + `(baseline ${RECALL_FLOOR}, delta ${delta >= 0 ? '+' : '-'}${Math.abs(delta).toFixed(4)})`,
    '[00:41:19] artifact retained in-enclave; metrics, logs and model card released',
  ];

  const modelCard = {
    model: 'kerbline/pedestrian-night-finetune',
    version: `${jobId}`,
    trained_on: dataset.id,
    training_data_classification: dataset.classification,
    residency: dataset.residency,
    residency_note:
      'The artifact inherits the residency of its training data under policy rule R7. '
      + 'Weights trained on restricted footage can memorise it, so this build is bound '
      + `by ${dataset.residency} even though it contains no footage. Publishing it `
      + 'to registry:global is refused for that reason and no other.',
    metrics: {
      pedestrian_recall_night: metrics.pedestrian_recall_night,
      pedestrian_recall_day: metrics.pedestrian_recall_day,
      pedestrian_precision_night: metrics.pedestrian_precision_night,
    },
    intended_use: 'Night-time pedestrian detection in the Kerbline ADAS perception stack.',
    limitations:
      'Recall gains concentrate where training examples are densest. The redacted '
      + 'research subset is offered for iteration and debugging rather than as a '
      + 'training substitute: automated redaction is least reliable on small, distant '
      + 'and poorly-lit figures, which are exactly the examples that move this metric.',
    synthetic: true,
  };

  return {
    tool: 'start_training_job',
    resource: dataset.id,
    job_id: jobId,
    execution_location: request.destination,
    status: 'succeeded',
    returns: ['metrics', 'logs', 'model_card'],
    simulated: true,
    simulation_note:
      'No GPU ran and no weights exist. Every figure here is computed from the '
      + 'generated rows by the documented curve in gateway_services.recallCurve, '
      + `deterministically from generator seed ${seed}. The counts it was computed from `
      + 'are returned in metrics.inputs so the arithmetic is checkable rather than '
      + 'taken on trust.',
    metrics,
    ...(comparison ? { comparison } : {}),
    comparison_note: comparison
      ? 'The same job against fleet.night_clips_redacted_research, for the contrast '
        + 'docs/SCENARIO.md §5.1 draws: the redacted set is a real dataset and a worse '
        + 'one for this metric, because the instances redaction is least reliable on are '
        + 'the instances that move night-time recall.'
      : null,
    logs,
    model_card: modelCard,
    data_returned: null,
  };
}

/**
 * A registration receipt. No weights move and none are returned.
 *
 * Reachable only on ALLOW, which for this tool means the destination was trusted (the
 * `register_in_enclave` sanctioned path). Publishing the same artifact to registry:global
 * is refused by R7 before anything gets here.
 */
function runPublishModel(request, dataset) {
  const seed = generatorSeed();
  const crc = zlib.crc32(dataset.id + String(seed)).toString(16).padStart(8, '0');
  const digest = `sha256:${crc}${'0'.repeat(56)}`;
  return {
    tool: 'publish_model',
    resource: dataset.id,
    status: 'registered',
    registry_entry: {
      artifact: dataset.id,
      destination: request.destination,
      digest,
      size_mb: dataset.volume.size_mb ?? null,
      residency: dataset.residency,
      provenance: dataset.derived_from ?? null,
      registered_at: isoNow(),
    },
    deployable_to:
      'In-country programmes only. Sites outside DE need a separately-approved, '
      + 'provenance-checked build — see sanctioned_paths.register_in_enclave.',
    note:
      'A registration record, not a transfer. No weights left their residency zone '
      + 'and none are returned here.',
    synthetic: true,
  };
}

/**
 * An export that the policy allowed, necessarily to a trusted destination.
 *
 * Every export in the eval set is refused; the tool is R1's chokepoint. This exists so the one
 * allowable shape, moving data to a destination the company controls, does something rather
 * than falling off the end of a branch.
 */
function runRequestExport(request, dataset) {
  const { rows, provenance } = loadRows(dataset);
  const { selected, note: selectionNote } = cohort(rows, request.record_count);
  return {
    tool: 'request_export',
    resource: dataset.id,
    status: 'staged',
    destination: request.destination,
    source: provenance,
    records_staged: selected.length,
    cohort_selection: selectionNote,
    note:
      'Staged inside the destination named above, which the policy marks trusted and '
      + 'on-premises. No rows are returned through this channel.',
  };
}

/**
 * Register a request for a dataset owner's sign-off. It never grants one.
 *
 * docs/GATEWAY_CONTRACT.md §8: this build has no resume path, deliberately. The pending record
 * is written and audited, which keeps a later resume path additive rather than a retrofit.
 */
function runRequestApproval(request) {
  let owner = null;
  if (request.resource) owner = findDataset(request.resource).owner;
  return {
    tool: 'request_approval',
    resource: request.resource ?? null,
    status: 'pending',
    routed_to: owner,
    approver_role: 'data_owner',
    note:
      'Recorded and routed. This does not grant access and does not wait: an approved '
      + 'request is re-evaluated as a fresh request rather than executed from a cached '
      + 'verdict, so an approval cannot be replayed against a different one.',
  };
}

/**
 * Re-derive the verdict on this request and refuse unless it is ALLOW. See VERIFICATION in
 * the header comment for why this exists.
 *
 * The engine is handed the eight fields of the ResolvedRequest and nothing else (not the
 * `decision`, not the `matched_rule`), so there is no path by which the caller's claim can
 * influence the answer it is being checked against.
 */
function verifyVerdict(request) {
  // The engine resolves the resource against this same catalog and refuses to evaluate a
  // request naming a dataset it cannot find. Looking it up first is not belt and braces: it is
  // what gets a request for rows nobody has generated the answer "not in the catalog", rather
  // than the answer a forged request deserves.
  if (request.resource !== null && request.resource !== undefined) findDataset(request.resource);

  let verdict;
  try {
    verdict = evaluate({
      policy: readPolicy(),
      catalog: readCatalog(),
      request: {
        actor: request.actor,
        tool: request.tool,
        resource: request.resource,
        destination: request.destination,
        scope_mode: request.scope_mode,
        record_count: request.record_count,
        columns: request.columns,
        min_cell_count: request.min_cell_count,
      },
    });
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err;
    // Unknown actor, unknown destination, a rule the engine has no matcher for. The request
    // cannot be evaluated, and an unevaluable request has not been authorised.
    throw new DataPlaneError(
      422,
      `the data plane could not re-derive this request's verdict: ${err.message}. It will `
      + 'not serve rows on a verdict it cannot reproduce.',
    );
  }

  if (verdict.decision !== 'ALLOW') {
    warn(
      `REFUSED /data/execute: the request claims ALLOW (rule ${repr(request.matched_rule)}) but `
      + `re-deriving it against ${POLICY_PATH} gives ${verdict.decision} `
      + `(rule ${repr(verdict.matched_rule)}). actor=${repr(request.actor)} `
      + `tool=${repr(request.tool)} resource=${repr(request.resource)} `
      + `destination=${repr(request.destination)} scope_mode=${repr(request.scope_mode)}`,
    );
    throw new DataPlaneError(
      403,
      `this request carries decision ALLOW, but re-deriving it from policy/access_policy.yaml `
      + `gives ${verdict.decision} (matched rule ${verdict.matched_rule || 'none'}). The data `
      + 'plane serves rows only for a verdict it can reproduce itself, so a claimed '
      + 'authorisation that the policy does not support is refused whether it is a bug in the '
      + 'decision workflow or a request that never went through one — see '
      + 'docs/GATEWAY_CONTRACT.md §9.',
    );
  }

  // A different rule reaching the same ALLOW is not a refusal: the policy said yes either way,
  // and the audit record carries whichever rule the gateway matched. Still worth a log line;
  // the two are meant to be identical documents read by identical code, so a mismatch means one
  // of those assumptions has stopped holding.
  if (verdict.matched_rule !== request.matched_rule) {
    warn(
      `/data/execute: both sides say ALLOW but disagree on the rule — request claims `
      + `${repr(request.matched_rule)}, re-derivation gives ${repr(verdict.matched_rule)}. `
      + 'Serving, because the verdict agrees.',
    );
  }
}

/** Dispatch one authorised tool call. The only entry point to the data plane. */
function executeDataPlane(request) {
  if (request.decision !== 'ALLOW') {
    throw new DataPlaneError(
      403,
      'the data plane runs only on ALLOW; this request carries '
      + `${repr(request.decision)}. Reaching here with anything else means the `
      + "decision workflow's branch has been rewired — see docs/GATEWAY_CONTRACT.md "
      + 'invariant 2.',
    );
  }

  verifyVerdict(request);

  const tool = request.tool;
  if (tool === 'whoami') return runWhoami(request);
  if (tool === 'list_datasets') return runListDatasets();
  if (tool === 'request_approval') return runRequestApproval(request);

  const needsDataset = {
    describe_dataset: runDescribeDataset,
    query_aggregate: runAggregate,
    read_records: runReadRecords,
    start_training_job: runStartTrainingJob,
    publish_model: runPublishModel,
    request_export: runRequestExport,
  };
  const handler = Object.prototype.hasOwnProperty.call(needsDataset, tool)
    ? needsDataset[tool]
    : null;
  if (!handler) {
    throw new DataPlaneError(
      422,
      `no data plane for tool ${repr(tool)}. The nine tools are listed in `
      + 'docs/SCENARIO.md §6.',
    );
  }
  return handler(request, findDataset(request.resource));
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function auditCount() {
  if (!fs.existsSync(AUDIT_PATH)) return 0;
  return fs.readFileSync(AUDIT_PATH, 'utf8').split('\n').filter((line) => line.trim()).length;
}

/**
 * The per-case rows of the last Layer 3 run, narrowed to what the console renders.
 *
 * Narrowed rather than passed through: a trace row carries the model's full answer text for
 * every case, which is tens of kilobytes the console does not display and would then be holding
 * in a browser. An unreadable line is skipped rather than failing the whole view.
 */
function e2eCases() {
  if (!fs.existsSync(E2E_TRACE_PATH)) return [];
  const rows = [];
  for (const line of fs.readFileSync(E2E_TRACE_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    rows.push({
      case_id: row.case_id,
      tool: row.tool,
      oracle_decision: row.oracle_decision,
      gateway_decision: row.gateway_decision,
      gateway_rule: row.gateway_matched_rule,
      audit_records: row.audit_records_written,
      result: row.gateway_result_present,
      latency_ms: row.latency_ms,
      agrees: row.agrees,
    });
  }
  return rows;
}

function auditTail(limit) {
  if (!fs.existsSync(AUDIT_PATH)) return [];
  const lines = fs.readFileSync(AUDIT_PATH, 'utf8').split('\n').filter((line) => line.trim());
  // `slice(-limit)` rather than an arithmetic offset, so `?n=0` means what it has always
  // meant here: every record.
  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      // A malformed line is itself worth surfacing rather than hiding.
      return { _unparseable: line.replace(/\n$/, '') };
    }
  });
}

function appendAuditRecord(record) {
  // The gateway supplies the timestamp; accept it, but stamp arrival separately so
  // a wrong clock in the workflow cannot silently reorder the log.
  const line = `${JSON.stringify(withSortedKeys({ ...record, _received_at: isoNow() }))}\n`;

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  // Append only; nothing in this service opens this file for truncation or rewriting. `a` is
  // O_APPEND, so the write lands at the end even if something else is writing to it. The fsync
  // is what makes the record survive losing the host, not merely losing this process: an
  // evidentiary artifact still in a page cache has not been recorded.
  const fd = fs.openSync(AUDIT_PATH, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function dataManifest() {
  if (!fs.existsSync(CATALOG_PATH)) {
    return { error: `missing ${CATALOG_PATH} — run seed/generate.py first` };
  }
  const datasets = [];
  for (const d of readCatalog().datasets || []) {
    const files = d.row_files;
    const entry = {
      id: d.id,
      classification: d.classification,
      catalog_count: d.volume.count,
      generated_count: d.volume.generated_count ?? null,
      columns: (d.columns || []).length,
    };
    if (!files) {
      entry.rows = 'none — single artifact, not a table';
    } else {
      for (const volume of ['sample', 'full']) {
        const file = path.join(SEED_OUT, files[volume]);
        entry[volume] = fs.existsSync(file)
          ? { file: files[volume], bytes: fs.statSync(file).size }
          : null;
      }
      entry.serves_from = fs.existsSync(path.join(SEED_OUT, files.full)) ? 'full' : 'sample';
    }
    datasets.push(entry);
  }
  return {
    generator_seed: generatorSeed(),
    row_files_loaded: [...ROWS_CACHE.keys()].map((p) => path.basename(p)).sort(),
    row_limit_per_read: DEFAULT_ROW_LIMIT,
    datasets,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const SERVER_VERSION = 'KerblineGatewayServices/1.0';

function warn(message) {
  process.stderr.write(`[gateway-services] ${message}\n`);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    Server: SERVER_VERSION,
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/**
 * Strict in both directions, on both routes.
 *
 * A body missing fields is not the shape the contract specifies; one carrying extras is
 * drifting from a shape something downstream reads positionally. On the data plane the second
 * half matters more than it looks: an unexpected key is a caller supplying an input the
 * resolver never produced.
 */
function requireExactFields(res, body, expected, source) {
  const present = new Set(Object.keys(body));
  const missing = [...expected].filter((f) => !present.has(f)).sort();
  const unexpected = [...present].filter((f) => !expected.has(f)).sort();
  if (!missing.length && !unexpected.length) return true;
  sendError(res, 422, JSON.stringify({
    reason: `body does not match ${source}`,
    missing,
    unexpected,
  }));
  return false;
}

/** One JSON object from the request body, or null after answering with the error. */
function readJsonBody(res, raw, contentLength) {
  if (contentLength === null) {
    sendError(res, 400, 'bad Content-Length');
    return null;
  }
  if (contentLength <= 0) {
    sendError(res, 400, 'empty body');
    return null;
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    sendError(res, 400, `body is not JSON: ${err.message}`);
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, 'body must be a JSON object');
    return null;
  }
  return body;
}

/** Python's `int()`: whitespace and a sign are fine, anything else is not a number. */
function parseIntStrict(text) {
  return /^\s*[+-]?\d+\s*$/.test(text) ? Number.parseInt(text.trim(), 10) : null;
}

function handleGet(req, res, url) {
  const routePath = url.pathname.replace(/\/+$/, '') || '/';

  if (routePath === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      policy: fs.existsSync(POLICY_PATH),
      catalog: fs.existsSync(CATALOG_PATH),
      prompts: fs.existsSync(PROMPTS_PATH),
      audit_records: auditCount(),
      // Whether the data plane can answer at full volume at all. A gateway that
      // allows a request and then cannot serve it is the stub this replaced, so
      // liveness includes it.
      full_datasets: fs.existsSync(path.join(SEED_OUT, 'full'))
        && fs.statSync(path.join(SEED_OUT, 'full')).isDirectory(),
    });
    return;
  }

  if (routePath === '/policy') {
    if (!fs.existsSync(POLICY_PATH)) {
      sendError(res, 404, `missing ${POLICY_PATH}`);
      return;
    }
    sendJson(res, 200, readPolicy());
    return;
  }

  if (routePath === '/prompts') {
    // gateway/prompts.yaml is the authored source, read by both the gateway and
    // eval/run_eval.py. They send the model byte-identical prompts because there is one file,
    // not because anything checks two copies against each other.
    if (!fs.existsSync(PROMPTS_PATH)) {
      sendError(res, 404, `missing ${PROMPTS_PATH}`);
      return;
    }
    sendJson(res, 200, yaml.load(fs.readFileSync(PROMPTS_PATH, 'utf8')));
    return;
  }

  if (routePath === '/catalog') {
    if (!fs.existsSync(CATALOG_PATH)) {
      sendError(res, 404, `missing ${CATALOG_PATH} — run seed/generate.py first`);
      return;
    }
    sendJson(res, 200, readCatalog());
    return;
  }

  if (routePath === '/audit/tail') {
    // A blank `?n=` counts as absent rather than as a malformed number, which is what the
    // Python service did by way of parse_qs and is the friendlier of the two readings.
    const limit = parseIntStrict(url.searchParams.get('n') || '50');
    if (limit === null) {
      sendError(res, 400, 'n must be an integer');
      return;
    }
    sendJson(res, 200, { records: auditTail(limit) });
    return;
  }

  // The governance console. Served from this port rather than its own so it inherits the
  // property the port already has: the sandbox cannot reach it, so the agent cannot read which
  // of its own requests were refused. It also means no CORS and no second allowlist entry.
  //
  // An explicit map, not a directory served by joining the request path onto a root. There is no
  // traversal to get wrong when the request path is a key lookup.
  if (routePath === '/console' || routePath in CONSOLE_FILES) {
    const file = CONSOLE_FILES[routePath === '/console' ? '/console/index.html' : routePath];
    const full = path.join(CONSOLE_DIR, file.name);
    if (!fs.existsSync(full)) {
      sendError(res, 404, `missing ${full}`);
      return;
    }
    const body = fs.readFileSync(full);
    res.writeHead(200, {
      Server: SERVER_VERSION,
      'Content-Type': file.type,
      'Content-Length': String(body.length),
      // The page is three views over local JSON and loads nothing remote. Saying so means a
      // stray CDN reference fails visibly here rather than working on this machine and dying
      // on a box with no route out.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'",
    });
    res.end(body);
    return;
  }

  // The last Layer 3 run, for the console's evals view: the summary fields plus the per-case
  // rows, which live in the trace rather than the summary. Both are written by
  // eval/e2e_check.py into a gitignored directory, so absent is a normal state and says so.
  if (routePath === '/eval/summary') {
    if (!fs.existsSync(E2E_SUMMARY_PATH)) {
      sendError(res, 404, `no Layer 3 run on disk — expected ${E2E_SUMMARY_PATH}`);
      return;
    }
    const summary = JSON.parse(fs.readFileSync(E2E_SUMMARY_PATH, 'utf8'));
    summary.cases = e2eCases();
    sendJson(res, 200, summary);
    return;
  }

  if (routePath === '/data/manifest') {
    // Not needed by the gateway. Here so that "is there data behind this?" is one
    // curl rather than an inference from a failed tool call.
    sendJson(res, 200, dataManifest());
    return;
  }

  sendError(res, 404, `no route ${routePath}`);
}

function handlePost(req, res, url, raw, contentLength) {
  const routePath = url.pathname.replace(/\/+$/, '') || '/';

  if (routePath === '/audit') {
    const record = readJsonBody(res, raw, contentLength);
    if (record === null) return;
    if (!requireExactFields(
      res, record, new Set(auditFields()), 'audit.record in access_policy.yaml',
    )) return;
    appendAuditRecord(record);
    sendJson(res, 201, { appended: true });
    return;
  }

  if (routePath === '/data/execute') {
    const request = readJsonBody(res, raw, contentLength);
    if (request === null) return;
    if (!requireExactFields(
      res,
      request,
      DATA_PLANE_REQUEST_FIELDS,
      'the ResolvedRequest plus verdict of docs/GATEWAY_CONTRACT.md sections 2 and 5',
    )) return;

    try {
      sendJson(res, 200, executeDataPlane(request));
    } catch (err) {
      if (!(err instanceof DataPlaneError)) throw err;
      sendError(res, err.status, err.message);
    }
    return;
  }

  sendError(res, 404, `no route ${routePath}`);
}

function createGatewayServer() {
  return http.createServer((req, res) => {
    const requestLine = `"${req.method} ${req.url} HTTP/${req.httpVersion}"`;
    res.on('finish', () => {
      warn(`${req.socket.remoteAddress || '-'} ${requestLine} ${res.statusCode} -`);
    });

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendError(res, 400, 'unparseable request target');
      return;
    }

    const contentLength = req.headers['content-length'] === undefined
      ? 0
      : parseIntStrict(req.headers['content-length']);

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      // Every handler below is synchronous, so this try/catch is the whole error boundary.
      // Without it an unforeseen throw takes the process down and the gateway loses its policy
      // source mid-demo. With it, the caller gets a 500 saying what happened.
      try {
        if (req.method === 'GET') {
          handleGet(req, res, url);
        } else if (req.method === 'POST') {
          handlePost(req, res, url, Buffer.concat(chunks), contentLength);
        } else {
          sendError(res, 501, `unsupported method ${req.method}`);
        }
      } catch (err) {
        warn(`500 on ${requestLine}: ${err && err.stack ? err.stack : err}`);
        if (!res.headersSent) sendError(res, 500, `${err && err.message ? err.message : err}`);
        else res.end();
      }
    });
  });
}

const USAGE = 'usage: gateway_services.js [--host 127.0.0.1[,addr...]] [--port 4301]\n'
  + '  --host  bind addresses, comma-separated; keep them as narrow as the n8n container needs\n'
  + '  --port  default 4301, which policy/sandbox_policy.yaml deliberately does not open';

function parseArgs(argv) {
  const args = { hosts: ['127.0.0.1'], port: 4301 };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    const split = token.indexOf('=');
    const flag = split === -1 ? token : token.slice(0, split);
    let value;
    if (split !== -1) {
      value = token.slice(split + 1);
      i += 1;
    } else {
      value = argv[i + 1];
      i += 2;
    }
    if (flag !== '--host' && flag !== '--port') {
      warn(`unrecognised argument ${repr(token)}\n${USAGE}`);
      process.exit(2);
    }
    if (value === undefined) {
      warn(`${flag} needs a value\n${USAGE}`);
      process.exit(2);
    }
    if (flag === '--host') {
      args.hosts = value.split(',').map((h) => h.trim()).filter(Boolean);
      if (!args.hosts.length) {
        warn(`--host needs at least one address\n${USAGE}`);
        process.exit(2);
      }
    } else {
      args.port = parseIntStrict(value);
      if (args.port === null) {
        warn(`--port needs an integer, got ${repr(value)}\n${USAGE}`);
        process.exit(2);
      }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  for (const host of args.hosts) {
    if (['0.0.0.0', '::'].includes(host)) {
      warn(
        `WARNING: binding ${host} puts the audit sink and the data plane on every interface `
        + 'this machine has. The agent must not be able to reach this port — see the header '
        + 'comment. Bind the docker bridge gateway instead of the wildcard.',
      );
    } else if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      warn(`NOTE: ${host} is not loopback, so anything on that interface can reach this port.`);
    }
  }

  const missing = [POLICY_PATH, CATALOG_PATH, PROMPTS_PATH].filter((p) => !fs.existsSync(p));
  if (missing.length) warn(`NOTE: not present yet: ${missing.join(', ')}`);

  process.stdout.write(`[gateway-services] policy   : ${POLICY_PATH}\n`);
  process.stdout.write(`[gateway-services] catalog  : ${CATALOG_PATH}\n`);
  process.stdout.write(`[gateway-services] audit    : ${AUDIT_PATH}\n`);
  for (const host of args.hosts) {
    process.stdout.write(`[gateway-services] listening: http://${host}:${args.port}\n`);
  }
  process.stdout.write(
    '[gateway-services] reachable from the n8n container as host.docker.internal\n',
  );

  // One server per address rather than the wildcard, so the port stays off every interface
  // nothing asks for. Any one of them failing to bind is fatal: a service that came up on
  // loopback alone would serve the host checks and leave n8n with a connection error.
  for (const host of args.hosts) {
    const server = createGatewayServer();
    server.on('error', (err) => {
      warn(`could not listen on ${host}:${args.port} — ${err.message}`);
      process.exit(1);
    });
    server.listen(args.port, host);
  }
}

if (require.main === module) main();

module.exports = { createGatewayServer, executeDataPlane, verifyVerdict, DataPlaneError };
