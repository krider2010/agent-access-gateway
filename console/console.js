/* console.js: the governance console.
 *
 * Read-only, and dependency-free on purpose. It renders four things this service already
 * serves: the audit trail (/audit/tail), the policy document (/policy), the dataset catalog
 * (/catalog) and the last Layer 3 run (/eval/summary). It creates no state and posts nothing.
 *
 * WHY IT IS SERVED FROM :4301 AND NOT ITS OWN PORT. It inherits the property the port already
 * has: the sandbox cannot reach it. So the agent cannot read which of its own requests were
 * refused, and it cannot read the policy governing it by asking the console instead.
 *
 * Everything from the server is treated as text, never as markup. Records are written by the
 * gateway but their fields carry a caller's resource and destination strings, so this uses
 * textContent throughout and builds no HTML from data.
 */

'use strict';

const POLL_MS = 4000;

const state = {
  view: 'decisions',
  records: [],
  policy: null,
  catalog: null,
  failures: 0,
};

// ------------------------------------------------------------------------------------------
// Small DOM helpers. el() takes text, never markup, which is what keeps the XSS surface at zero.
// ------------------------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function stat(container, key, value) {
  const box = el('div', 'stat');
  box.append(el('div', 'n', value), el('div', 'k', key));
  container.append(box);
}

async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

function clockTime(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return String(iso);
  return at.toLocaleTimeString('en-GB', { hour12: false });
}

// ------------------------------------------------------------------------------------------
// Decisions
// ------------------------------------------------------------------------------------------

/**
 * One audit record as a card.
 *
 * The badge is the point of this view. policy_model_location is what the gateway recorded at the
 * time of the decision, so a feed spanning a Phase 6 cutover shows both values rather than
 * relabelling history. It is deliberately not derived from anything on this page.
 */
function decisionCard(record) {
  const decision = record.decision || 'UNKNOWN';
  const card = el('div', `record ${decision}`);

  const top = el('div', 'top');
  top.append(el('span', 'verdict', decision.replace('_', ' ')));

  const rule = record.matched_rule;
  if (rule) {
    top.append(el('span', 'rule', rule));
  } else {
    // No matched rule means default-deny: the right verdict with no rationale and no
    // alternative. It is the shape every policy gap here has arrived in, so it is called out
    // rather than left as an empty cell.
    const none = el('span', 'rule none', 'no rule matched');
    none.title = 'Default-deny. The verdict is right, but the engineer gets no rationale and no '
      + 'sanctioned alternative. Every policy gap found in this repo looked like this.';
    top.append(none);
  }

  top.append(el('span', 'tool', record.tool || '—'));
  top.append(el('span', 'when', clockTime(record.timestamp)));
  card.append(top);

  const meta = el('div', 'meta');
  const pairs = [
    ['actor', `${record.actor_id || '—'} (${record.actor_role || '—'})`],
    ['resource', record.resource || '—'],
    ['classification', record.resource_classification || '—'],
    ['residency', record.resource_residency || '—'],
    ['destination', `${record.destination || '—'}${record.destination_trusted === false ? ' (untrusted)' : ''}`],
    ['scope', record.scope_mode || '—'],
    ['records', record.record_count === null || record.record_count === undefined ? '—' : record.record_count],
    ['latency', record.latency_ms === undefined ? '—' : `${record.latency_ms} ms`],
  ];
  for (const [key, value] of pairs) {
    const item = el('span');
    item.append(`${key} `, el('b', null, value));
    meta.append(item);
  }
  card.append(meta);

  const offered = record.redirect_offered || [];
  if (offered.length) {
    const line = el('div', 'redirects');
    line.append(el('span', 'k', 'sanctioned alternative offered: '));
    offered.forEach((name, i) => {
      if (i) line.append(', ');
      line.append(el('code', null, name));
    });
    card.append(line);
  }

  const where = record.policy_model_location || 'unrecorded';
  const badge = el('div', `badge ${where === 'on-prem' ? 'onprem' : 'hosted'}`);
  badge.append(
    el('span', null, 'worded by'),
    el('span', null, record.policy_model || 'unrecorded'),
    el('span', 'where', where),
  );
  badge.title = where === 'on-prem'
    ? 'The policy brain ran inside the boundary for this decision.'
    : 'The policy brain ran on a hosted endpoint for this decision. Sovereignty is not claimed.';
  card.append(badge);

  return card;
}

function renderDecisions() {
  const filter = document.getElementById('decisionFilter').value;
  const feed = document.getElementById('decisionFeed');
  const stats = document.getElementById('decisionStats');

  clear(stats);
  const counts = { ALLOW: 0, DENY: 0, REQUIRE_APPROVAL: 0, unmatched: 0 };
  for (const record of state.records) {
    if (counts[record.decision] !== undefined) counts[record.decision] += 1;
    if (!record.matched_rule) counts.unmatched += 1;
  }
  stat(stats, 'decisions', state.records.length);
  stat(stats, 'allowed', counts.ALLOW);
  stat(stats, 'denied', counts.DENY);
  stat(stats, 'awaiting sign-off', counts.REQUIRE_APPROVAL);
  stat(stats, 'no rule matched', counts.unmatched);

  const shown = state.records
    .filter((record) => filter === 'all' || record.decision === filter)
    .slice()
    .reverse();

  clear(feed);
  if (!shown.length) {
    feed.append(el('p', 'empty', 'No decisions yet. Every gateway call writes one record here.'));
    return;
  }
  for (const record of shown) feed.append(decisionCard(record));
}

// ------------------------------------------------------------------------------------------
// Awaiting sign-off
// ------------------------------------------------------------------------------------------

/**
 * The pending queue, read out of the audit trail rather than out of a store of its own.
 *
 * request_approval writes a pending record and returns the owner it routed to, but the owner is
 * not one of the nineteen audit fields, so it is looked up from the catalog here. Deriving it
 * beats widening the audit schema for a view.
 */
function renderPending() {
  const feed = document.getElementById('pendingFeed');
  const badge = document.getElementById('pendingBadge');
  const waiting = state.records.filter((r) => r.decision === 'REQUIRE_APPROVAL').reverse();

  badge.textContent = waiting.length ? String(waiting.length) : '';

  clear(feed);
  if (!waiting.length) {
    feed.append(el('p', 'empty', 'Nothing waiting on a dataset owner.'));
    return;
  }
  for (const record of waiting) {
    const card = decisionCard(record);
    const dataset = (state.catalog?.datasets || []).find((d) => d.id === record.resource);
    const line = el('div', 'redirects');
    line.append(el('span', 'k', 'routed to '));
    line.append(el('code', null, dataset ? dataset.owner : 'the dataset owner'));
    line.append(el('span', 'k', ', pending. This build has no resume path.'));
    card.append(line);
    feed.append(card);
  }
}

// ------------------------------------------------------------------------------------------
// Policy
// ------------------------------------------------------------------------------------------

function renderPolicy() {
  const policy = state.policy;
  if (!policy) return;

  const stats = document.getElementById('policyStats');
  clear(stats);
  stat(stats, 'rules', (policy.rules || []).length);
  stat(stats, 'sanctioned paths', Object.keys(policy.sanctioned_paths || {}).length);
  stat(stats, 'classifications', (policy.classifications || []).length);
  stat(stats, 'k-anonymity floor', (policy.privacy || {}).k_anonymity_min ?? '—');
  stat(stats, 'default', (policy.evaluation || {}).default || '—');

  const order = document.getElementById('policyOrder');
  clear(order);
  ((policy.evaluation || {}).order || []).forEach((id, i) => {
    if (i) order.append(el('span', 'arrow', '→'));
    order.append(el('span', 'step', id));
  });

  const rules = document.getElementById('policyRules');
  clear(rules);
  const byId = {};
  for (const rule of policy.rules || []) byId[rule.id] = rule;
  for (const id of ((policy.evaluation || {}).order || [])) {
    const rule = byId[id];
    if (!rule) continue;
    const card = el('div', 'ruleCard');
    const head = el('div', 'head');
    head.append(el('span', 'rule', rule.id));
    head.append(el('span', `effect ${rule.effect}`, String(rule.effect).replace('_', ' ')));
    head.append(el('span', 'name', rule.name || ''));
    if (rule.terminal === true) {
      const flag = el('span', 'terminal', 'terminal');
      flag.title = 'Decides immediately. Nothing downstream can overturn it.';
      head.append(flag);
    }
    card.append(head);
    card.append(el('div', 'rationale', String(rule.rationale || '').trim()));
    card.append(el('div', 'match', `match: ${JSON.stringify(rule.match || {})}`));
    rules.append(card);
  }

  const classifications = document.getElementById('policyClassifications');
  clear(classifications);
  for (const c of policy.classifications || []) {
    const chip = el('div', 'chip');
    chip.append(el('div', 't', `${c.name} (level ${c.level})`));
    if (c.description) chip.append(el('div', null, String(c.description).trim()));
    classifications.append(chip);
  }

  const destinations = document.getElementById('policyDestinations');
  clear(destinations);
  for (const d of policy.destinations || []) {
    const chip = el('div', 'chip');
    chip.append(el('div', 't', d.name));
    chip.append(el('div', d.trusted ? 'trusted' : 'untrusted', d.trusted ? 'trusted' : 'untrusted'));
    destinations.append(chip);
  }

  const paths = document.getElementById('policyPaths');
  clear(paths);
  for (const [name, path] of Object.entries(policy.sanctioned_paths || {})) {
    const card = el('div', 'ruleCard');
    const head = el('div', 'head');
    head.append(el('span', 'rule', name));
    if (path.rule) head.append(el('span', 'terminal', `offered by ${path.rule}`));
    if (path.tool) head.append(el('span', 'tool', path.tool));
    card.append(head);
    card.append(el('div', 'rationale', String(path.summary || '').trim()));
    if (path.caveat) card.append(el('div', 'match', String(path.caveat).trim()));
    paths.append(card);
  }
}

// ------------------------------------------------------------------------------------------
// Evals
// ------------------------------------------------------------------------------------------

/**
 * The last Layer 3 run.
 *
 * eval/results/ is gitignored and each run overwrites the last, so this view is empty on a fresh
 * clone until the harness runs. That is stated on the page rather than left as a blank panel,
 * because an empty evidence tab reads as "no evidence".
 */
async function renderEvals() {
  const body = document.getElementById('evalBody');
  clear(body);

  let summary;
  try {
    summary = await getJson('/eval/summary');
  } catch {
    body.append(el('p', 'empty',
      'No Layer 3 run on disk. eval/results/ is gitignored and each run overwrites the last, '
      + 'so this is empty until you run: .venv-eval/bin/python eval/e2e_check.py'));
    return;
  }

  const stats = el('div', 'stats');
  stat(stats, 'cases', summary.n_cases ?? '—');
  stat(stats, 'agree with the oracle', `${summary.n_agree ?? '—'} / ${summary.n_scored ?? '—'}`);
  stat(stats, 'allows with a result', `${summary.n_allow_with_result ?? '—'} / ${summary.n_allow ?? '—'}`);
  stat(stats, 'transport errors', summary.n_transport_errors ?? '—');
  stat(stats, 'wall clock p50', `${Math.round(summary.latency_ms_p50 ?? 0)} ms`);
  stat(stats, 'wall clock p95', `${Math.round(summary.latency_ms_p95 ?? 0)} ms`);
  body.append(stats);

  body.append(el('p', 'warn',
    'Do not quote the p95 as a single number. Repeat runs against an unchanged gateway have '
    + 'spanned 2596 to 9382 ms while the p50 barely moved. The model call dominates each '
    + 'request and the endpoint is a shared hosted tier. Quote the p50 and say the tail is '
    + 'variable.'));

  const cases = summary.cases || [];
  if (!cases.length) return;

  const table = el('table');
  const head = el('tr');
  for (const column of ['Case', 'Tool', 'Oracle', 'Gateway', 'Rule', 'Audit', 'Result', 'ms']) {
    head.append(el('th', null, column));
  }
  table.append(head);
  for (const c of cases) {
    const row = el('tr');
    row.append(el('td', null, c.case_id));
    row.append(el('td', null, c.tool || '—'));
    row.append(el('td', null, c.oracle_decision || '—'));
    row.append(el('td', null, c.gateway_decision || '—'));
    row.append(el('td', null, c.gateway_rule || 'none'));
    row.append(el('td', 'n', c.audit_records ?? '—'));
    row.append(el('td', null, c.result === true ? 'yes' : '—'));
    row.append(el('td', 'n', c.latency_ms ?? '—'));
    table.append(row);
  }
  body.append(table);
}

// ------------------------------------------------------------------------------------------
// Polling and wiring
// ------------------------------------------------------------------------------------------

function setLive(ok, text) {
  const dot = document.getElementById('liveDot');
  dot.className = `dot ${ok ? 'ok' : 'bad'}`;
  document.getElementById('liveText').textContent = text;
}

async function poll() {
  const limit = document.getElementById('decisionLimit').value;
  try {
    const [audit, policy, catalog] = await Promise.all([
      getJson(`/audit/tail?n=${encodeURIComponent(limit)}`),
      state.policy ? Promise.resolve(state.policy) : getJson('/policy'),
      state.catalog ? Promise.resolve(state.catalog) : getJson('/catalog'),
    ]);
    state.records = audit.records || [];
    state.policy = policy;
    state.catalog = catalog;
    state.failures = 0;
    setLive(true, `live · ${state.records.length} records`);
  } catch (err) {
    state.failures += 1;
    // Naming the port matters: the usual cause is the service being down, and the usual next
    // question is which one.
    setLive(false, `no answer from :4301 (${state.failures})`);
    return;
  }

  renderDecisions();
  renderPending();
  if (state.view === 'policy') renderPolicy();
}

const VIEWS = ['decisions', 'pending', 'policy', 'evals'];

function show(view) {
  if (!VIEWS.includes(view)) view = 'decisions';
  state.view = view;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === view);
  }
  for (const section of document.querySelectorAll('.view')) {
    section.classList.toggle('hidden', section.id !== `view-${view}`);
  }
  if (view === 'policy') renderPolicy();
  if (view === 'evals') renderEvals();
}

// The tab is in the URL so a view can be opened directly. That makes any tab a bookmark rather
// than a click, and it survives a reload.
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => { window.location.hash = tab.dataset.view; });
}
window.addEventListener('hashchange', () => show(window.location.hash.slice(1)));
document.getElementById('decisionFilter').addEventListener('change', renderDecisions);
document.getElementById('decisionLimit').addEventListener('change', poll);

document.getElementById('footerNote').textContent =
  'Read-only. Served from the gateway services on :4301, a port the agent sandbox cannot reach, '
  + `so the agent cannot read which of its requests were refused. Refreshes every ${POLL_MS / 1000}s.`;

show(window.location.hash.slice(1));
poll();
setInterval(poll, POLL_MS);
