# Thin wrappers around the scripts in n8n/scripts/ and install.sh; no logic
# of its own lives here. Pass SANDBOX=<name> for targets that need one.
#
#   make n8n-up                     # bring up self-hosted n8n
#   make n8n-setup                  # owner account + MCP key -> .env
#   make n8n-cred                   # nvidiaApi credential from .env -> n8n
#   make install SANDBOX=my-sandbox # sandbox onboard/detect + policy + skill
#   make verify  SANDBOX=my-sandbox # health round-trip
#   make down    SANDBOX=my-sandbox # stop n8n + the in-sandbox gateway, keep data
#   make clean                      # remove the install staging dir only
#
SHELL := /bin/bash
.DEFAULT_GOAL := help

SANDBOX  ?=

# Deliberately NOT the generic `n8n` / `n8n_data`: many hosts already run a
# container by that name, and this demo must never collide with or inherit
# state from one. Kept in sync with the defaults in n8n/scripts/up.sh.
N8N_CONTAINER ?= n8n-gtc
N8N_VOLUME    ?= n8n_gtc_data
export N8N_CONTAINER
export N8N_VOLUME
SKILL_NAME := access-gateway
STAGE_DIR := /tmp/$(SKILL_NAME)-install-stage

.PHONY: help n8n-up n8n-setup n8n-cred rebuild n8n-mcp-on n8n-mcp-off n8n-mcp-status services install verify down clean k8s-off k8s-on

help:
	@echo "Targets:"
	@echo "  n8n-up      bring up the self-hosted n8n container"
	@echo "  n8n-setup   owner account + MCP key -> .env"
	@echo "  n8n-cred    import the nvidiaApi credential from .env into the container"
	@echo "  rebuild     DESTRUCTIVE: fresh volume -> owner -> credential -> both"
	@echo "              workflows -> isolate. Needs CONFIRM=yes. Rotates the MCP"
	@echo "              token, so re-run 'bash install.sh' afterwards."
	@echo "  n8n-mcp-on  re-enable n8n's management MCP (needed before authoring workflows)"
	@echo "  n8n-mcp-off disable it; isolate.sh does this already, so the running demo"
	@echo "              has only the gateway front door live on 5678"
	@echo "  services    start the policy, audit and data service on 4301 (needed by the gateway)"
	@echo "  install     full installer (SANDBOX=<name> optional, auto-detects)"
	@echo "  verify      health round-trip: the gateway front door via the skill,"
	@echo "              from inside the sandbox"
	@echo "  down        stop n8n + the in-sandbox gateway; leaves data untouched"
	@echo "  clean       remove the install staging dir ONLY"
	@echo "  k8s-off     turn off OrbStack's built-in Kubernetes (see warning)"
	@echo "  k8s-on      turn OrbStack's built-in Kubernetes back on"
	@echo ""
	@echo "Pass SANDBOX=<name> for: install, verify, down"

# --- n8n ---------------------------------------------------------------------

n8n-up: ## Bring up the self-hosted n8n container
	bash n8n/scripts/up.sh

n8n-setup: ## Configure n8n: owner account, MCP access, MCP key -> .env
	bash n8n/scripts/setup.sh

n8n-cred: ## Import the nvidiaApi credential from .env into the container
	bash n8n/scripts/create_credential.sh

# DESTRUCTIVE, and guarded rather than commented out like the nuke- targets
# below, because this one is meant to be run routinely: it is how a demo
# instance gets built, and how we find out whether the setup instructions
# still work. It refuses to run without CONFIRM=yes, it is a dependency of
# nothing, and no other target calls it.
rebuild: ## DESTROY the n8n volume and rebuild the gateway from empty. CONFIRM=yes required.
	CONFIRM=$(CONFIRM) bash n8n/scripts/rebuild.sh

# n8n's management API and the gateway front door share port 5678. The sandbox policy now
# scopes its grant to the front-door path, so the management API is already refused from
# inside the sandbox; but that policy governs one sandbox, and switching the endpoint off
# closes it to everything on the host. Needed only at build time, so isolate.sh switches it
# off and these switch it back on.
n8n-mcp-on: ## Re-enable n8n's instance MCP management access (needed before a build)
	bash n8n/scripts/mcp_access.sh on

n8n-mcp-off: ## Disable it again (isolate.sh already does this as its last step)
	bash n8n/scripts/mcp_access.sh off

n8n-mcp-status: ## Is the management API answering, and is the front door reachable?
	bash n8n/scripts/mcp_access.sh status

services: ## Start the gateway's policy, audit and data service on port 4301
	bash gateway/scripts/services.sh

# --- sandbox -------------------------------------------------------------------

install: ## Run the full installer (sandbox onboard/detect, network policy, skill upload)
	bash install.sh $(SANDBOX)

verify: ## Health round-trip: the gateway front door reachable through the skill
         ## from inside the sandbox
	@# The front door needs no token, so this is not a precondition of the round
	@# trip below. It is here because the build helpers in n8n/scripts/
	@# authenticate with the token, and a rebuild rotates it, so the number
	@# worth seeing before a build is how old the current one is.
	@echo "-- MCP token --"
	@if [ -f .env ]; then \
		age=$$(perl -e 'print time() - (stat($$ARGV[0]))[9]' .env 2>/dev/null); \
		if [ -n "$$age" ]; then \
			echo "N8N_MCP_TOKEN: .env last modified $${age}s ago (reported as a proxy for token age — setup.sh mints the token in the same pass it writes .env, but any later unrelated .env edit will make this look newer than the token actually is)"; \
		else \
			echo "N8N_MCP_TOKEN: could not stat .env for its modification time"; \
		fi \
	else \
		echo "N8N_MCP_TOKEN: no .env found — run 'make n8n-setup' first"; \
	fi
	@# gateway_health opens an MCP session and lists the tool surface. It makes
	@# no access request, so it writes no audit record and is safe to run as
	@# often as you like, unlike whoami, which costs an access decision.
	@#
	@# `--no-warnings` keeps Node's experimental-proxy-feature warning off this
	@# output. The sandbox sets NODE_USE_ENV_PROXY=1, which triggers it on every
	@# start, and the client proxies itself regardless.
	@if [ -z "$(SANDBOX)" ]; then \
		echo "Pass SANDBOX=<name> to also check the gateway front door through the skill (see: openshell sandbox list)"; \
	else \
		echo "-- skill -> gateway front door --"; \
		openshell sandbox exec -n "$(SANDBOX)" -- \
			node --no-warnings \
			/sandbox/.openclaw/workspace/skills/$(SKILL_NAME)/scripts/client.js gateway_health; \
	fi

# --- teardown ------------------------------------------------------------------

down: ## Stop n8n and the in-sandbox OpenClaw gateway process. Leaves the
      ## $(N8N_VOLUME) volume and the sandbox itself untouched; nothing
      ## here deletes state.
	-docker stop $(N8N_CONTAINER)
	@if [ -z "$(SANDBOX)" ]; then \
		echo "Pass SANDBOX=<name> to also stop the OpenClaw gateway inside the sandbox"; \
	else \
		openshell sandbox exec -n "$(SANDBOX)" -- openclaw gateway stop || true; \
	fi
	@echo "n8n container stopped (docker start $(N8N_CONTAINER) to resume)."
	@echo "NOTE: no 'suspend the sandbox itself' command is wired up here — none"
	@echo "of the source material this repo was ported from used one. If"
	@echo "OpenShell has a sandbox-level stop/pause command, add it here."

clean: ## Remove ONLY the install staging dir. Never touches the
       ## $(N8N_VOLUME) volume or the sandbox; nothing destructive lives
       ## in this target.
       ##
       ## Neither `node_modules/` nor the eval venv is in scope. Both install
       ## once and rebuild from a lockfile or a requirements file, so deleting
       ## either from a target named `clean` would cost a reinstall nobody
       ## asked for. `npm install` and docs/EVALS.md own them.
	rm -rf "$(STAGE_DIR)"
	@echo "Removed $(STAGE_DIR)."
	@echo "$(N8N_VOLUME) volume and the sandbox were NOT touched."

# Deliberately commented out: destructive, irreversible, and scoped to one
# developer's machine. Uncomment locally if you want them; never wire either
# into a default target, CI, or another script.
#
# nuke-n8n-data:  ## DESTROYS the $(N8N_VOLUME) volume, irreversible, all workflows/credentials lost
# 	docker rm -f $(N8N_CONTAINER) || true
# 	docker volume rm $(N8N_VOLUME)
#
# nuke-sandbox:   ## DESTROYS the sandbox itself, irreversible
# 	openshell sandbox delete $(SANDBOX)

# --- OrbStack Kubernetes toggle ------------------------------------------------
# WARNING: these flip a HOST-WIDE setting, not something scoped to this repo.
# If this machine uses OrbStack's Kubernetes for OTHER work, toggling it off
# stops that work too. Never call these from another script or automatically;
# always confirm with whoever owns the machine first.

k8s-off: ## Turn OFF OrbStack's built-in Kubernetes (needed before `nemoclaw onboard`)
	@echo "WARNING: this disables OrbStack's built-in Kubernetes HOST-WIDE."
	@echo "If you have other Kubernetes work running in OrbStack, it will stop."
	@echo ""
	@echo "Why this is needed: OpenShell's gateway runs its OWN embedded"
	@echo "Kubernetes. If OrbStack's built-in Kubernetes is also on, the two"
	@echo "control planes fight over shared host cgroups and 'nemoclaw onboard'"
	@echo "does not get past '[2/8] Starting OpenShell gateway'."
	@echo ""
	orb config set k8s.enable false
	orb stop
	open -a OrbStack
	@echo "Waiting for Docker to answer..."
	@until docker info >/dev/null 2>&1; do sleep 2; done
	@echo "Docker is back up. OrbStack Kubernetes is OFF."

k8s-on: ## Turn OrbStack's built-in Kubernetes back ON
	@echo "WARNING: this re-enables OrbStack's built-in Kubernetes HOST-WIDE."
	@echo "Confirm nothing here still needs it disabled before proceeding."
	orb config set k8s.enable true
	orb stop
	open -a OrbStack
	@echo "Waiting for Docker to answer..."
	@until docker info >/dev/null 2>&1; do sleep 2; done
	@echo "Docker is back up. OrbStack Kubernetes is ON."
