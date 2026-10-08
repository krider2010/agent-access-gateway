# Follow this repository

The order for a first run on the `multiverse` branch. The policy brain and the
sandbox agent both use a local vLLM server named `hypernova`
(`MultiverseComputingCAI/Hypernova-60B-2605`). The rules decide access. The model
only writes the explanation.

This sequence was run on a DGX Spark with Docker Engine on 2026-10-08. Diagnosis
by failing hop is in [RUNBOOK.md](RUNBOOK.md). The longer failure catalogue is
[SETUP.md](SETUP.md).

## 1. What you need first

| Requirement | Notes |
|---|---|
| Docker, with a NVIDIA GPU | Hypernova is served by vLLM. The weights took about 34 GiB on this Spark. |
| Node.js ≥ 22.2 | The gateway service on port 4301 uses it. |
| Python ≥ 3.10, `perl`, `curl`, `git` | Host tooling. |
| NemoClaw already installed | This repo does not install it. `nemoclaw` and `openshell` must be on `PATH`. |
| No host Kubernetes | OpenShell runs its own. See [SETUP.md](SETUP.md) §2. `make k8s-off` on OrbStack. |

## 2. Clone the branch

```bash
git clone git@github.com:krider2010/agent-access-gateway.git
cd agent-access-gateway
git checkout multiverse
```

## 3. Start Hypernova

The first start downloads the weights into the Hugging Face cache. If the model
is gated, log in to Hugging Face before this command.

```bash
mkdir -p "$HOME/.cache/huggingface"
docker run -d --name hypernova \
  --restart unless-stopped \
  --gpus all --ipc=host \
  -p 127.0.0.1:8000:8000 \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  -v hypernova-vllm-cache:/root/.cache/vllm \
  -e VLLM_CACHE_ROOT=/root/.cache/vllm \
  nvcr.io/nvidia/vllm:26.09-py3 \
  vllm serve MultiverseComputingCAI/Hypernova-60B-2605 \
    --served-model-name hypernova \
    --host 0.0.0.0 --port 8000 \
    --gpu-memory-utilization 0.70 \
    --max-model-len 16384 \
    --max-num-seqs 4 \
    --tool-call-parser openai
```

Wait until the server answers:

```bash
curl -s http://127.0.0.1:8000/v1/models
```

The model id in that JSON must be `hypernova`.

## 4. Let the other containers reach it

The port above is published only on `127.0.0.1`. n8n and the OpenShell gateway
run in containers, and that address is not the host from inside them. Leave
this process running for the whole demo:

```bash
bash n8n/scripts/bridge_loopback.sh
```

It listens on the docker bridge and forwards to `127.0.0.1:8000`. Start it
again after a reboot. It does not restart the model.

## 5. Configure the environment

```bash
cp .env.template .env
```

The template already points inference at `http://127.0.0.1:8000/v1` and the
model `hypernova`. Set the demo owner password:

```bash
# in .env
OWNER_PASSWORD=ChangeMe-Demo1
```

Leave `N8N_MCP_TOKEN` blank. `make rebuild` writes it. The n8n login is
`platform@kerbline.example` / `ChangeMe-Demo1`.

## 6. Build the gateway

`make rebuild` drops the `n8n_gtc_data` volume. On a clean machine there is
nothing to drop. It does not touch any other n8n you already run.

```bash
npm install
make rebuild CONFIRM=yes
```

n8n is then at `http://localhost:5678`.

## 7. Generate the data and start the policy service

```bash
python3 -m venv .venv-seed
.venv-seed/bin/pip install -r seed/requirements.txt
.venv-seed/bin/python seed/generate.py --full
make services
curl -s http://127.0.0.1:4301/health
```

`health` should report `policy`, `catalog`, `prompts` and `full_datasets` as
true. The governance console is `http://127.0.0.1:4301/console`.

## 8. Install the sandbox

```bash
export PATH="$HOME/.local/bin:$PATH"
make install SANDBOX=lena-agent
```

`install.sh` points the OpenShell provider at `host.openshell.internal` when
`.env` uses a loopback URL, and it writes that provider and model into
`~/.nemoclaw/sandboxes.json`. `nemoclaw connect` restores that record onto the
live route. A record left from an older onboard, such as hosted Nemotron, is
what connect will put back, and a retired model answers HTTP 410.

If `openshell sandbox list` shows `lena-agent` stuck in `Provisioning` and the
pod is `Failed`, delete the pod and wait until the phase is `Ready`. Then run
`make install` again:

```bash
docker exec openshell-cluster-nemoclaw \
  kubectl delete pod lena-agent -n openshell
openshell sandbox list
```

## 9. Check the front door from inside the sandbox

```bash
make verify SANDBOX=lena-agent
```

`status` is `ok` and `tool_count` is 9. This check does not call the model.

## 10. Try a denial and an allow

From the repo directory on the host:

```bash
python3 n8n/scripts/gateway_client.py call request_export \
  '{"args":"{\"query\":\"copy the night clips to my laptop\",\"resource\":\"fleet.night_clips_annotated\",\"destination\":\"host:workstation\",\"record_count\":5000,\"projection\":\"records\"}"}'
```

You want `DENY`, rule `R1`, and `answer_source` `model`. The data plane is
`not reached`.

```bash
python3 n8n/scripts/gateway_client.py call list_datasets \
  '{"args":"{\"query\":\"what data do we have?\"}"}'
```

You want `ALLOW` and rule `R11`. The client shortens a long reply. Set
`GATEWAY_MAX_CHARS=0` in front of the command to print the whole list.

The same calls from inside the sandbox:

```bash
nemoclaw lena-agent connect
```

```bash
SKILL="node --no-warnings /sandbox/.openclaw/workspace/skills/access-gateway/scripts/client.js"
$SKILL request_export --query "copy the night clips to my laptop" \
  --resource fleet.night_clips_annotated --destination host:workstation \
  --record-count 5000 --projection records
$SKILL list_datasets --query "what data do we have?"
```

A failure to forward port `18789` blocks only the browser dashboard. The shell
and these commands do not use that port. `exit` returns to the host.

## 11. Chat with the agent

At the sandbox prompt:

```bash
openclaw tui
```

`/exit` leaves the chat. On the host, `docker logs -f hypernova` should show a
`POST /v1/chat/completions` with status 200 for that turn. The TUI footer names
the model `inference/hypernova`.

The model the agent asks for is in `/sandbox/.openclaw/openclaw.json`. The
route OpenShell actually uses is the live inference route, and `nemoclaw connect`
sets that from `~/.nemoclaw/sandboxes.json`. After `make install` those two
agree on `hypernova`.
