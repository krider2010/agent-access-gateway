// The node half of eval/cross_check.py. Runs the engine over the same policy JSON the :4301
// service serves, delivered as one bundle in a file, so the input shape matches what the
// gateway's Code node sees. Both sides of the comparison reach the same
// gateway/policy_engine.js, so what is under test is whether the policy, the request and the
// rationale text survive that delivery route unchanged. See cross_check.py's header.
const fs = require('fs');
const { evaluate } = require(require('path').join(__dirname, '..', 'gateway', 'policy_engine.js'));

const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let pass = 0;
const diffs = [];

for (const c of b.cases) {
  let got;
  try {
    got = evaluate({ policy: b.policy, catalog: b.catalog, request: c.request });
  } catch (e) {
    diffs.push({ id: c.id, why: `threw ${e.constructor.name}: ${e.message}` });
    continue;
  }
  const want = b.python[c.id];
  const same = got.decision === want.decision
    && got.matched_rule === want.matched_rule
    && got.rationale.trim() === want.rationale.trim()
    && JSON.stringify(got.redirects) === JSON.stringify(want.redirects);
  if (same) { pass++; continue; }
  const fields = [];
  if (got.decision !== want.decision) fields.push(`decision ${want.decision} -> ${got.decision}`);
  if (got.matched_rule !== want.matched_rule) fields.push(`rule ${want.matched_rule} -> ${got.matched_rule}`);
  if (JSON.stringify(got.redirects) !== JSON.stringify(want.redirects)) {
    fields.push(`redirects ${JSON.stringify(want.redirects)} -> ${JSON.stringify(got.redirects)}`);
  }
  if (got.rationale.trim() !== want.rationale.trim()) fields.push('rationale text differs');
  diffs.push({ id: c.id, why: fields.join('; ') });
}

console.log(`cases: ${b.cases.length}   agree: ${pass}   disagree: ${diffs.length}`);
for (const d of diffs) console.log(`  x ${d.id}: ${d.why}`);
process.exit(diffs.length ? 1 : 0);
