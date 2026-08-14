#!/usr/bin/env node
/**
 * policy_engine_bridge.js: serves gateway/policy_engine.js to the Python harness.
 *
 * The access decision has exactly one implementation, gateway/policy_engine.js, and
 * eval/policy_engine.py is a shim over it rather than a second copy of the rules. This script
 * is what the shim talks to. Nothing here knows anything about the policy: it holds a policy
 * document and a catalog, and forwards requests.
 *
 * WHY A LONG-LIVED PROCESS RATHER THAN ONE `node` PER DECISION. Starting node costs ~35ms on
 * this machine, and the harnesses evaluate one request at a time over the whole eval set. A
 * batch entry point would be faster still, but every caller (eval/run_eval.py,
 * eval/oracle_check.py, eval/cross_check.py, eval/fill_check.py) calls
 * `engine.evaluate(one_request)` inside its own loop, so a batch API would need all four
 * rewritten. One process per Python interpreter, reused for every request, buys the same win
 * without touching a call site: 35 decisions cost one startup instead of thirty-five.
 *
 * PROTOCOL. Line-delimited JSON on stdin, exactly one JSON line of reply per line read.
 *
 *   first line:  {"policy": {...}, "catalog": {...}}  ->  {"ready": true}
 *   every line after that: a request object           ->  {"decision": {...}} | {"error": "..."}
 *
 * The policy and catalog arrive once, in the handshake, rather than riding along with every
 * request: they are the same ~29KB for the life of the process, and the JSON is the same shape
 * the :4301 policy service serves to the gateway's HTTP Request node.
 *
 * Errors come back as data rather than as a thrown exception, so one unanswerable request (an
 * unknown actor, say) does not take the process down and strand everything queued behind it.
 * The shim turns them back into Python exceptions.
 *
 * There is no shutdown message. When the Python process ends, its end of the stdin pipe closes,
 * readline sees EOF, and node exits on its own.
 */

'use strict';

const path = require('path');
const readline = require('readline');

const { evaluate } = require(path.join(__dirname, '..', 'gateway', 'policy_engine.js'));

let context = null;

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (e) {
    reply({ error: `policy_engine_bridge.js could not parse its input: ${e.message}` });
    return;
  }

  if (context === null) {
    context = { policy: message.policy, catalog: message.catalog };
    reply({ ready: true });
    return;
  }

  try {
    reply({ decision: evaluate({ ...context, request: message }) });
  } catch (e) {
    reply({ error: e.message });
  }
});
