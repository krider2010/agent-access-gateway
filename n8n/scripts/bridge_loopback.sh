#!/usr/bin/env bash
# Forward the docker bridge to a server published only on 127.0.0.1.
#
# vLLM is published as 127.0.0.1:8000. That address works for the eval harness
# and for OpenShell, both of which run on the host. It does not work for n8n.
# The model node runs in a container, and create_credential.sh points that
# credential at host.docker.internal. On Docker Engine that name is the bridge
# gateway, usually 172.17.0.1, and a port bound only to loopback is not
# listening there.
#
# This process listens on the bridge address and copies bytes to the loopback
# port. Leave it running while n8n calls the model. It does not touch the
# vLLM container, which takes a long time to load.
set -euo pipefail

PORT="${1:-8000}"
GATEWAY="$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
[ -n "$GATEWAY" ] || { echo "✗ docker bridge has no gateway" >&2; exit 1; }

echo "▸ ${GATEWAY}:${PORT} -> 127.0.0.1:${PORT}"
exec python3 - "$GATEWAY" "$PORT" <<'PY'
import socket, sys, threading

gateway, port = sys.argv[1], int(sys.argv[2])
target = ("127.0.0.1", port)

def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

def handle(client):
    try:
        upstream = socket.create_connection(target, timeout=10)
    except OSError:
        client.close()
        return
    left = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
    right = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
    left.start()
    right.start()
    left.join()
    right.join()
    client.close()
    upstream.close()

server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind((gateway, port))
server.listen(32)
while True:
    client, _addr = server.accept()
    threading.Thread(target=handle, args=(client,), daemon=True).start()
PY
