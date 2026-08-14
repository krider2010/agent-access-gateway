#!/usr/bin/env node
/**
 * Persist a random gateway auth token into /sandbox/.openclaw/openclaw.json.
 *
 * The OpenClaw gateway loads its auth.token from this config file, not from the
 * CLI --token flag alone (which only sets, and does not override, an existing
 * empty value under mode=token). The TUI sends OPENCLAW_GATEWAY_TOKEN over the
 * wire, and it must match what the gateway reads from this file or the handshake
 * fails with "unauthorized: gateway token mismatch".
 *
 * Idempotent: an existing non-empty token is preserved unless --rotate is
 * passed, so re-running the installer does not invalidate open sessions.
 *
 * Usage, inside the sandbox:
 *     node set_oc_token.js [--rotate]
 *
 * Prints the token, existing or newly written, on stdout. install.sh uploads
 * this file and reads that line.
 *
 * Node rather than Python: the sandbox image ships node 22, and this repo keeps
 * Python to the eval harness and the data generator, where the libraries earn
 * it. No dependency needed; `crypto` and `fs` are built in.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');

const CFG = '/sandbox/.openclaw/openclaw.json';

function main() {
  const rotate = process.argv.slice(2).includes('--rotate');

  if (!fs.existsSync(CFG)) {
    process.stderr.write(`ERROR: ${CFG} not found\n`);
    return 1;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  } catch (err) {
    // Reported rather than repaired: this file is OpenClaw's, and silently
    // rewriting a config we failed to parse is how you lose someone's settings.
    process.stderr.write(`ERROR: ${CFG} is not valid JSON (${err.message})\n`);
    return 1;
  }

  data.gateway = data.gateway || {};
  data.gateway.auth = data.gateway.auth || {};
  const auth = data.gateway.auth;

  const existing = auth.token || '';
  if (existing && !rotate) {
    process.stdout.write(`${existing}\n`);
    return 0;
  }

  auth.token = crypto.randomBytes(32).toString('hex');
  auth.mode = 'token';
  fs.writeFileSync(CFG, `${JSON.stringify(data, null, 2)}\n`);
  process.stdout.write(`${auth.token}\n`);
  return 0;
}

process.exit(main());
