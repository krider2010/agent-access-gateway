#!/usr/bin/env node
/**
 * Access Gateway: MCP skill client.
 *
 * The agent's only route to company data. Invoked inside the NemoClaw sandbox as:
 *
 *     node --no-warnings client.js <tool> [--arg value ...]
 *
 * It talks to exactly one thing: the gateway's MCP front door, an n8n MCP Server
 * Trigger at http://host.openshell.internal:5678/mcp/kerbline-access-gateway.
 * Every call goes through the gateway's access decision, so a DENY here is the
 * system working, not a failure.
 *
 * DEPENDENCY-FREE. Nothing here is outside Node's standard library, so the
 * sandbox needs no reachable package index and no virtualenv or `node_modules`
 * to bootstrap. Keep it that way: one import would mean re-opening egress to a
 * registry, and every host opened for that is a host the agent can reach too.
 *
 * FOUR THINGS ABOUT THE FRONT DOOR that are not obvious from the MCP spec and
 * cost an afternoon each if you meet them cold:
 *
 *   1. SESSIONS. The trigger issues an `mcp-session-id` header on `initialize`
 *      and requires it on every request after that. Without it the server
 *      answers HTTP 200 with an empty body, which reads like a broken endpoint
 *      and is not one.
 *
 *   2. SSE FRAMING. Replies arrive as an event stream ("event: message" /
 *      "data: {...}") rather than a bare JSON body, so the payload is on the
 *      last `data:` line.
 *
 *   3. ONE ARGUMENT. n8n hands a tool call's whole argument object to a single
 *      field, so all nine tools take one `args` parameter carrying a JSON
 *      *string*. That is why the gateway is two workflows and not eleven. This
 *      client hides it: the agent calls
 *      `query_aggregate --resource X --columns Y` and never assembles JSON.
 *
 *   4. THE EGRESS PROXY IS THE POLICY ENFORCEMENT POINT, so how we speak to it
 *      decides whether a refusal is legible. See the long note above `proxyFor`;
 *      it is the one thing most likely to be "simplified" back into a bug.
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SKILL_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(SKILL_DIR, "config.json");

const FALLBACK_URL =
  "http://host.openshell.internal:5678/mcp/kerbline-access-gateway";

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    // A missing file is the ordinary case before install.sh has run, and the
    // fallback below covers it. Anything else is reported on stderr.
    if (err.code !== "ENOENT") {
      process.stderr.write(
        `Warning: failed to load ${CONFIG_PATH}: ${err.message}\n`
      );
    }
    return {};
  }
}

const CONFIG = loadConfig();

const DEFAULT_URL =
  process.env.GATEWAY_MCP_URL || CONFIG.server_url || FALLBACK_URL;
// The gateway consults a policy model on every decision, so a call is as slow
// as that model. Generous rather than tight: a timeout here surfaces as a
// transport error and tells the agent nothing about what the gateway decided.
const DEFAULT_TIMEOUT =
  Number(process.env.GATEWAY_TIMEOUT_SEC || CONFIG.timeout_sec) || 180;

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------
// One entry per tool the front door exposes. Each argument carries the flag, the
// key it becomes in the `args` object, and how to parse it. Data rather than nine
// hand-written blocks, so the client and the front door can be diffed by eye.

const QUERY = {
  flag: "--query",
  key: "query",
  required: true,
  help: "What the user asked, in their own words",
};

const resource = (help) => ({
  flag: "--resource",
  key: "resource",
  required: true,
  help,
});

const destination = (help) => ({
  flag: "--destination",
  key: "destination",
  required: true,
  help,
});

const recordCount = (help) => ({
  flag: "--record-count",
  key: "record_count",
  type: "int",
  required: true,
  help,
});

const projection = (help) => ({
  flag: "--projection",
  key: "projection",
  required: true,
  choices: ["records", "index"],
  help,
});

const TOOLS = {
  whoami: {
    help:
      "Who this session is acting as, and what that role may reach. " +
      "Call this first.",
    args: [QUERY],
  },
  list_datasets: {
    help:
      "List the datasets available, with classification and residency. " +
      "Metadata only — never returns records.",
    args: [QUERY],
  },
  describe_dataset: {
    help: "One dataset's schema, volume and accountable owner.",
    args: [QUERY, resource("Dataset id, e.g. fleet.clip_catalog")],
  },
  query_aggregate: {
    help: "Count or distribution over a dataset; returns the aggregate.",
    args: [
      QUERY,
      resource("Dataset id to aggregate over"),
      {
        flag: "--columns",
        key: "columns",
        list: true,
        help: "Columns to group by; omit for an ungrouped total",
      },
      recordCount("How many records the filter selects"),
      // Optional, and deliberately not defaulted here. The gateway treats an
      // ungrouped aggregate as one group of record_count, and treats a *grouped*
      // aggregate whose smallest group was never measured as not shown to be
      // safe. Both are policy decisions; a client-side default would quietly
      // make the second one look measured.
      {
        flag: "--min-cell-count",
        key: "min_cell_count",
        type: "int",
        help:
          "Records in the smallest resulting group. Required in practice when " +
          "grouping: an unmeasured grouping is not treated as safe.",
      },
    ],
  },
  read_records: {
    help: "Read rows from a dataset.",
    args: [
      QUERY,
      resource("Dataset id to read from"),
      recordCount("How many rows the read would return"),
      projection(
        "'records' for full rows, 'index' for index or metadata rows only"
      ),
    ],
  },
  request_export: {
    help:
      "Move data to a destination outside the dataset's current location, " +
      "such as a workstation or an external host.",
    args: [
      QUERY,
      resource("Dataset id to export"),
      destination("Where it should go, e.g. host:workstation"),
      recordCount("How many records the export would carry"),
      projection("'records' or 'index'"),
    ],
  },
  start_training_job: {
    help:
      "Train against a dataset at a named execution location. Returns " +
      "metrics, logs and a model card rather than data.",
    args: [
      QUERY,
      resource("Dataset id to train on"),
      destination("Where the job runs, e.g. enclave:governed"),
    ],
  },
  publish_model: {
    help:
      "Publish a trained model artifact to a registry or deployment target.",
    args: [
      QUERY,
      resource("Model artifact id, e.g. models.pedestrian_v4"),
      destination("Where to publish, e.g. registry:global"),
    ],
  },
  request_approval: {
    help:
      "Record a request for a dataset owner's sign-off. Registers it and " +
      "returns immediately; it does not grant access and does not wait.",
    args: [
      QUERY,
      resource("Dataset id the request concerns"),
      destination("Where the data would go if approved"),
    ],
  },
};

const HEALTH_TOOL = "gateway_health";
const HEALTH_HELP =
  "Confirm the front door is reachable and list its tools. Makes no access " +
  "request. Run this first when triaging.";

// ---------------------------------------------------------------------------
// MCP transport
// ---------------------------------------------------------------------------

class GatewayError extends Error {
  /** Anything that stopped the gateway from answering. Not a DENY. */
}

/**
 * Which proxy, if any, this request goes through, and why we route it ourselves
 * rather than letting Node do it.
 *
 * The sandbox's egress proxy is the enforcement point for
 * `policy/sandbox_policy.yaml`, not plumbing, and it answers a refused request
 * with a JSON body naming the reason: `policy_denied` for an unlisted host or
 * port, `denied by L7 policy` for a permitted port but an unlisted path,
 * `ssrf_denied` for a host that resolved outside `allowed_ips`. Those three
 * strings are the whole top half of HEARTBEAT.md's error ladder: they are how the
 * agent tells "the network refused me" from "the gateway decided no" from "n8n is
 * not running", and the three send the user to three different places.
 *
 * For an `http://` URL a forward proxy expects the request in absolute form,
 * `POST http://host:5678/path HTTP/1.1`, which lets it read the path, apply the
 * L7 rules, and hand back that body. That is what the code below builds.
 *
 * The tempting shortcut does not work. `fetch()` with `NODE_USE_ENV_PROXY=1` set
 * (it is set in this sandbox) reaches the front door perfectly well on the happy
 * path, so it looks obvious. But undici tunnels plain HTTP: its proxy support
 * opens a CONNECT tunnel even for `http://`, and a tunnel is opaque by
 * construction, so the proxy cannot see a path inside one, cannot apply an L7
 * rule, and refuses the CONNECT outright. All three refusals above then collapse
 * into one message: "fetch failed", caused by "Request was cancelled", caused by
 * "Proxy response (403) !== 200 when HTTP Tunneling". The reason is gone,
 * `policy_denied` never appears, and the ladder has nothing to key on. Measured
 * both ways from inside the sandbox on 2026-08-13.
 *
 * Hence `node:http`, absolute-form, and an explicitly constructed Agent. The
 * Agent matters: with `NODE_USE_ENV_PROXY=1` the *global* agent is proxy-aware,
 * so a request already aimed at the proxy gets proxied a second time and arrives
 * asking for the proxy's own port. A private Agent opts out.
 *
 * Doing it here also drops a dependency on that variable being set. With it
 * unset, Node connects direct, the connection is refused, and the agent is told
 * "n8n is not running" when its request never reached the proxy at all.
 */
function proxyFor(target) {
  const host = target.hostname.toLowerCase();

  // no_proxy first, so the 127.0.0.1 spelling of the front door (the
  // port-forward build) goes direct, as it must; the proxy is not on that path.
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || "";
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return null;
    const bare = entry.startsWith(".") ? entry.slice(1) : entry;
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }

  const url =
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY;
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    process.stderr.write(
      `Warning: ignoring unparseable proxy setting ${JSON.stringify(url)}\n`
    );
    return null;
  }
}

function post(url, payload, session, timeoutSec) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new GatewayError(`${url} is not a URL`));
      return;
    }
    // The front door is plain HTTP on the host, and the one grant in the sandbox
    // policy is written for that. Saying so beats a confusing failure further in.
    if (target.protocol !== "http:") {
      reject(
        new GatewayError(
          `${url} is not an http:// URL. The gateway front door is plain HTTP ` +
            `on the host; see policy/sandbox_policy.yaml.`
        )
      );
      return;
    }

    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const headers = {
      "Content-Type": "application/json",
      // Both, because the trigger answers streamable-http and picks per request.
      Accept: "application/json, text/event-stream",
      "Content-Length": String(body.length),
    };
    if (session) headers["mcp-session-id"] = session;

    const proxy = proxyFor(target);
    let options;
    if (proxy) {
      headers.Host = target.host;
      if (proxy.username || proxy.password) {
        const credentials = `${decodeURIComponent(
          proxy.username
        )}:${decodeURIComponent(proxy.password)}`;
        headers["Proxy-Authorization"] = `Basic ${Buffer.from(
          credentials,
          "utf8"
        ).toString("base64")}`;
      }
      options = {
        host: proxy.hostname,
        port: proxy.port || 80,
        method: "POST",
        // Absolute form. This is the line that keeps a refusal legible.
        path: target.href,
        headers,
        agent: new http.Agent(),
      };
    } else {
      options = {
        host: target.hostname,
        port: target.port || 80,
        method: "POST",
        path: `${target.pathname}${target.search}`,
        headers,
        agent: new http.Agent(),
      };
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const gotSession = res.headers["mcp-session-id"] || session || null;
        if (res.statusCode >= 400) {
          // Pass the body through rather than summarising it: on a network
          // refusal this body is the proxy's own reason, and HEARTBEAT.md's
          // error ladder reads it.
          reject(
            new GatewayError(
              `HTTP ${res.statusCode} from ${url}: ${raw.trim().slice(0, 500)}`
            )
          );
          return;
        }
        const lines = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim());
        if (lines.length === 0) {
          resolve([null, gotSession]);
          return;
        }
        try {
          resolve([JSON.parse(lines[lines.length - 1]), gotSession]);
        } catch (err) {
          reject(
            new GatewayError(
              `Could not parse the answer from ${url}: ${err.message}`
            )
          );
        }
      });
    });

    // Nothing else in the chain applies a deadline, so a stalled decision would
    // hang the agent's tool call with no output at all.
    req.setTimeout(timeoutSec * 1000, () => {
      req.destroy(
        new GatewayError(
          `No answer from ${url} within ${timeoutSec}s. The gateway's policy ` +
            `model may still be thinking; this is slowness, not a denial.`
        )
      );
    });
    req.on("error", (err) => {
      reject(
        err instanceof GatewayError
          ? err
          : new GatewayError(`Could not reach ${url}: ${err.message}`)
      );
    });
    req.end(body);
  });
}

async function openSession(url, timeoutSec) {
  const [, sid] = await post(
    url,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "access-gateway-skill", version: "1" },
      },
    },
    null,
    timeoutSec
  );
  if (!sid) {
    throw new GatewayError(
      `${url} answered initialize without an mcp-session-id header. ` +
        `Is that the MCP Server Trigger's production URL?`
    );
  }
  // The spec expects this notification before normal requests. The trigger
  // tolerates its absence, but a compliant client sends it, and a strict
  // server would refuse everything after this point without it.
  try {
    await post(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      sid,
      timeoutSec
    );
  } catch (err) {
    if (!(err instanceof GatewayError)) throw err;
  }
  return sid;
}

async function rpc(url, method, params, timeoutSec) {
  const sid = await openSession(url, timeoutSec);
  const [res] = await post(
    url,
    { jsonrpc: "2.0", id: 2, method, params },
    sid,
    timeoutSec
  );
  if (res === null) {
    throw new GatewayError(
      `Empty body from ${url} for ${method}. Usually a missing session id.`
    );
  }
  if (res.error !== undefined) {
    throw new GatewayError(
      `JSON-RPC error from the front door: ${JSON.stringify(res.error)}`
    );
  }
  return res.result || {};
}

/**
 * tools/call returns content[].text; the gateway puts its answer in there as
 * JSON, wrapped in a one-item list because an n8n node returns items.
 */
function unwrap(result) {
  const texts = (result.content || [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text || "");
  if (texts.length === 0) return result;
  const joined = texts.join("\n");
  let parsed;
  try {
    parsed = JSON.parse(joined);
  } catch {
    return joined;
  }
  if (Array.isArray(parsed) && parsed.length === 1) return parsed[0];
  return parsed;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function callTool(url, timeoutSec, tool, args) {
  const result = await rpc(
    url,
    "tools/call",
    { name: tool, arguments: { args: JSON.stringify(args) } },
    timeoutSec
  );
  process.stdout.write(`${JSON.stringify(unwrap(result), null, 2)}\n`);
}

/**
 * Reachability probe: opens a session and lists the tool surface.
 *
 * Costs no access decision and writes no audit record, so it is safe to run
 * from `make verify` and to use as the first rung when triaging.
 */
async function gatewayHealth(url, timeoutSec) {
  const tools = (await rpc(url, "tools/list", {}, timeoutSec)).tools || [];
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "ok",
        url,
        tool_count: tools.length,
        tools: tools.map((t) => t.name).sort(),
      },
      null,
      2
    )}\n`
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ROOT_FLAGS = {
  "--server-url": {
    flag: "--server-url",
    key: "server_url",
    help: `Gateway front-door URL (default: ${DEFAULT_URL})`,
  },
  "--timeout": {
    flag: "--timeout",
    key: "timeout",
    type: "float",
    help: `Seconds to wait for a decision (default: ${DEFAULT_TIMEOUT})`,
  },
};

// Every tool flag, in one table. A flag appearing on more than one tool means
// the same thing and parses the same way everywhere, so one table can tokenise
// the command line before we know which tool was asked for. The tool then decides
// what is allowed and what is required.
const ALL_TOOL_FLAGS = {};
for (const spec of Object.values(TOOLS)) {
  for (const arg of spec.args) ALL_TOOL_FLAGS[arg.flag] = arg;
}

class UsageError extends Error {}

function usage(tool) {
  const lines = [];
  if (!tool) {
    lines.push(
      "usage: client.js [--server-url URL] [--timeout SECS] <tool> [args ...]",
      "",
      "Access Gateway skill client — the agent's one route to company data.",
      "",
      "tools:"
    );
    const width = Math.max(
      HEALTH_TOOL.length,
      ...Object.keys(TOOLS).map((n) => n.length)
    );
    for (const [name, spec] of Object.entries(TOOLS)) {
      lines.push(`  ${name.padEnd(width)}  ${spec.help}`);
    }
    lines.push(`  ${HEALTH_TOOL.padEnd(width)}  ${HEALTH_HELP}`);
    lines.push("", "options:");
    for (const opt of Object.values(ROOT_FLAGS)) {
      lines.push(`  ${opt.flag.padEnd(14)}  ${opt.help}`);
    }
    lines.push(
      "",
      "Run 'client.js <tool> --help' for one tool's arguments."
    );
    return lines.join("\n");
  }
  if (tool === HEALTH_TOOL) {
    return [`usage: client.js ${HEALTH_TOOL}`, "", HEALTH_HELP].join("\n");
  }
  const spec = TOOLS[tool];
  const shape = spec.args
    .map((a) => (a.required ? `${a.flag} ...` : `[${a.flag} ...]`))
    .join(" ");
  lines.push(`usage: client.js ${tool} ${shape}`, "", spec.help, "", "arguments:");
  const width = Math.max(...spec.args.map((a) => a.flag.length));
  for (const arg of spec.args) {
    const extra = arg.choices ? ` (one of: ${arg.choices.join(", ")})` : "";
    const need = arg.required ? "" : " [optional]";
    lines.push(`  ${arg.flag.padEnd(width)}  ${arg.help}${extra}${need}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const ns = { tool: null, values: {}, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--help" || token === "-h") {
      ns.help = true;
      continue;
    }

    if (!token.startsWith("-")) {
      if (ns.tool) {
        throw new UsageError(
          `unexpected argument ${JSON.stringify(token)} (tool is already ` +
            `'${ns.tool}')`
        );
      }
      if (token !== HEALTH_TOOL && !TOOLS[token]) {
        throw new UsageError(`unknown tool ${JSON.stringify(token)}`);
      }
      ns.tool = token;
      continue;
    }

    const spec = ROOT_FLAGS[token] || ALL_TOOL_FLAGS[token];
    if (!spec) throw new UsageError(`unrecognised argument ${token}`);

    if (spec.list) {
      // nargs='*': take every following token that is not itself a flag, so
      // `--columns A B --record-count 10` groups by A and B. A tool name stops
      // the run too, so `--columns A query_aggregate` names the tool rather than
      // quietly grouping by a column called "query_aggregate".
      const collected = [];
      while (
        i + 1 < argv.length &&
        !argv[i + 1].startsWith("-") &&
        argv[i + 1] !== HEALTH_TOOL &&
        !TOOLS[argv[i + 1]]
      ) {
        collected.push(argv[i + 1]);
        i += 1;
      }
      ns.values[spec.key] = collected;
      continue;
    }

    if (i + 1 >= argv.length) {
      throw new UsageError(`${token} expects a value`);
    }
    const raw = argv[i + 1];
    i += 1;

    if (spec.type === "int" || spec.type === "float") {
      // Number("") and Number(" ") are both 0, so a blank value would silently
      // become a record count of zero and be sent to the gateway as a measured
      // fact. Reject it instead.
      const value = raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(value)) {
        throw new UsageError(`${token}: ${JSON.stringify(raw)} is not a number`);
      }
      if (spec.type === "int" && !Number.isInteger(value)) {
        throw new UsageError(`${token}: ${JSON.stringify(raw)} is not an integer`);
      }
      ns.values[spec.key] = value;
      continue;
    }

    if (spec.choices && !spec.choices.includes(raw)) {
      throw new UsageError(
        `${token}: ${JSON.stringify(raw)} is not one of ${spec.choices.join(", ")}`
      );
    }
    ns.values[spec.key] = raw;
  }

  return ns;
}

/**
 * Turn parsed flags into the `args` object the front door is sent, and report
 * anything wrong with them. The single flag table means the parser accepts a
 * flag belonging to some other tool, so this is where the chosen tool's own
 * shape is checked.
 */
function collectArgs(ns) {
  const spec = TOOLS[ns.tool];
  const belongs = new Set(spec.args.map((a) => a.key));
  const args = {};
  const missing = [];

  for (const arg of spec.args) {
    // Omit rather than send null: the gateway distinguishes "not supplied" from
    // a value, and min_cell_count is the case where the difference changes the
    // verdict.
    if (ns.values[arg.key] === undefined) {
      if (arg.required) missing.push(arg.flag);
    } else {
      args[arg.key] = ns.values[arg.key];
    }
  }

  const stray = Object.values(ALL_TOOL_FLAGS)
    .filter((a) => !belongs.has(a.key) && ns.values[a.key] !== undefined)
    .map((a) => a.flag);

  const problems = [];
  if (missing.length > 0) problems.push(`missing required ${missing.join(", ")}`);
  if (stray.length > 0) {
    problems.push(`${stray.join(", ")} does not apply to ${ns.tool}`);
  }
  return { args, problems };
}

async function main() {
  let ns;
  try {
    ns = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${usage(null)}\n\nclient.js: error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (ns.help) {
    process.stdout.write(`${usage(ns.tool)}\n`);
    return;
  }
  if (!ns.tool) {
    process.stderr.write(`${usage(null)}\n\nclient.js: error: no tool given\n`);
    process.exitCode = 2;
    return;
  }

  const serverUrl = ns.values.server_url ?? DEFAULT_URL;
  const timeoutSec = ns.values.timeout ?? DEFAULT_TIMEOUT;

  try {
    if (ns.tool === HEALTH_TOOL) {
      await gatewayHealth(serverUrl, timeoutSec);
      return;
    }

    const { args, problems } = collectArgs(ns);
    if (problems.length > 0) {
      process.stderr.write(
        `${usage(ns.tool)}\n\nclient.js: error: ${problems.join("; ")}\n`
      );
      process.exitCode = 2;
      return;
    }

    await callTool(serverUrl, timeoutSec, ns.tool, args);
  } catch (err) {
    if (!(err instanceof GatewayError)) throw err;
    // Transport or protocol failure; the gateway did not decide anything.
    // A DENY arrives instead as a normal, successful answer.
    process.stderr.write(
      `gateway unreachable or not answering: ${err.message}\n`
    );
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => process.exit(130));

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
