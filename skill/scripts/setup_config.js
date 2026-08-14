#!/usr/bin/env node
/**
 * Setup script for the access-gateway skill.
 *
 * Writes config.json so client.js can be invoked without passing the front-door
 * URL and timeout every time. install.sh writes the same file directly; this is
 * for setting the skill up by hand inside the sandbox, or repointing the URL.
 *
 * Usage:
 *     node --no-warnings scripts/setup_config.js [--server-url URL] [--timeout SECS]
 *
 * If flags are not provided, prompts interactively.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const SKILL_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(SKILL_DIR, "config.json");

// The gateway's MCP front door, as addressed from inside the sandbox. The host
// is host.openshell.internal because that is the only host the sandbox network
// policy resolves and permits; see policy/sandbox_policy.yaml.
const DEFAULT_SERVER_URL =
  "http://host.openshell.internal:5678/mcp/kerbline-access-gateway";
const DEFAULT_TIMEOUT = 180;

const USAGE = [
  "usage: setup_config.js [--server-url URL] [--timeout SECS] [--non-interactive]",
  "",
  "Generate config.json for the access-gateway skill.",
  "",
  "  --server-url        Gateway front-door URL " +
    `(default: ${DEFAULT_SERVER_URL})`,
  "  --timeout           Seconds to wait for an access decision (default: 180)",
  "  --non-interactive   Do not prompt; fall back to defaults / existing values",
  "                      for missing flags",
].join("\n");

function parseArgs(argv) {
  const args = { nonInteractive: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (token === "--non-interactive") {
      args.nonInteractive = true;
    } else if (token === "--server-url" || token === "--timeout") {
      if (i + 1 >= argv.length) {
        process.stderr.write(`${USAGE}\n\nerror: ${token} expects a value\n`);
        process.exit(2);
      }
      args[token === "--timeout" ? "timeout" : "serverUrl"] = argv[i + 1];
      i += 1;
    } else {
      process.stderr.write(`${USAGE}\n\nerror: unrecognised argument ${token}\n`);
      process.exit(2);
    }
  }
  return args;
}

function prompt(rl, label, fallback) {
  return new Promise((resolve) => {
    rl.question(`${label} [${fallback}]: `, (answer) => {
      resolve(answer.trim() || String(fallback));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      process.stdout.write(`Found existing config at ${CONFIG_PATH}\n`);
    } catch {
      // An unreadable or malformed file is treated as absent: this script's job
      // is to end with a valid config, and refusing to overwrite a broken one
      // would leave the caller with no way to fix it from here.
    }
  }

  const rl = args.nonInteractive
    ? null
    : readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

  let serverUrl = args.serverUrl;
  if (!serverUrl) {
    const fallback = existing.server_url || DEFAULT_SERVER_URL;
    serverUrl = rl ? await prompt(rl, "Server URL", fallback) : fallback;
  }

  let timeout = args.timeout;
  if (timeout === undefined) {
    const fallback = existing.timeout_sec ?? DEFAULT_TIMEOUT;
    timeout = rl ? await prompt(rl, "Timeout (sec)", fallback) : fallback;
  }
  if (rl) rl.close();

  timeout = Number(timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    process.stderr.write("Error: timeout must be > 0\n");
    process.exit(1);
  }

  // Drop the Phase 1 polling keys if an older config.json is being upgraded:
  // the front door answers synchronously and nothing reads them.
  const config = { ...existing };
  delete config.poll_interval_sec;
  delete config.poll_timeout_sec;
  config.server_url = serverUrl;
  config.timeout_sec = timeout;

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`\nConfig written to ${CONFIG_PATH}\n`);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
