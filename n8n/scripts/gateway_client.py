#!/usr/bin/env python3
"""Minimal MCP client for the gateway's own front door.

Separate from n8n/workflows/build.js, which talks to n8n's management surface. This one
speaks to the MCP Server Trigger, which is what Lena's agent talks to, so it is the closest
thing to being the agent. The trigger issues an `mcp-session-id` on initialize and requires
it on every later request; without it the server answers 200 with an empty body.

    python3 n8n/scripts/gateway_client.py tools
    python3 n8n/scripts/gateway_client.py call <tool> '<json args>'
"""

import json
import sys
import urllib.request

import os
URL = os.environ.get(
    "GATEWAY_MCP_URL", "http://localhost:5678/mcp/kerbline-access-gateway"
)

# Replies are truncated so a tool returning rows or a full aggregate does not flood a
# terminal. Set GATEWAY_MAX_CHARS=0 for the whole thing, needed when reading the data
# plane's payload rather than checking the verdict.
MAX_CHARS = int(os.environ.get("GATEWAY_MAX_CHARS", "4000"))


def post(payload: dict, session: str | None) -> tuple[dict | None, str | None]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session:
        headers["mcp-session-id"] = session
    req = urllib.request.Request(
        URL, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        got_session = resp.headers.get("mcp-session-id") or session
        raw = resp.read().decode()
    lines = [l[len("data:"):].strip() for l in raw.splitlines() if l.startswith("data:")]
    if not lines:
        return None, got_session
    return json.loads(lines[-1]), got_session


def session() -> str:
    _, sid = post({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "kerbline-probe", "version": "0"},
        },
    }, None)
    if not sid:
        raise SystemExit("no mcp-session-id returned by the front door")
    # The spec expects this notification before normal requests.
    try:
        post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, sid)
    except Exception:
        pass
    return sid


def main() -> None:
    sid = session()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "tools"

    if cmd == "tools":
        res, _ = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, sid)
        tools = (res or {}).get("result", {}).get("tools", [])
        print(f"{len(tools)} tools exposed by the front door\n")
        for t in sorted(tools, key=lambda x: x["name"]):
            schema = t.get("inputSchema", {}) or {}
            print(f"  {t['name']}")
            print(f"      args    : {list((schema.get('properties') or {}).keys())}")
            print(f"      required: {schema.get('required', [])}")
    elif cmd == "call":
        args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        res, _ = post({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": sys.argv[2], "arguments": args},
        }, sid)
        rendered = json.dumps(res, indent=2)
        print(rendered if MAX_CHARS <= 0 else rendered[:MAX_CHARS])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
