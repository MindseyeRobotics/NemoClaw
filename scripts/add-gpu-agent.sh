#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# add-gpu-agent.sh — Create a new GPU-enabled agent sandbox and register it
# in the parent agent's dashboard Agents tab.
#
# Prerequisites:
#   • A NemoClaw gateway running with --gpu support (via post-onboard-gpu.sh)
#   • The GPU image already built and imported into k3s
#     (post-onboard-gpu.sh does this automatically)
#   • A parent agent sandbox already running (default: the defaultSandbox)
#
# Usage:
#   bash scripts/add-gpu-agent.sh <agent-name> [--parent <parent-name>]
#
# Examples:
#   bash scripts/add-gpu-agent.sh jarvis
#   bash scripts/add-gpu-agent.sh jarvis --parent cortana

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEMOCLAW_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="nemoclaw-sandbox-ai"
IMAGE_TAG="v4"
IMAGE_REF="${IMAGE_NAME}:${IMAGE_TAG}"
DASHBOARD_PORT=18789
MAX_READY_WAIT=60
MAX_GATEWAY_WAIT=30
POLICY_FILE="${NEMOCLAW_ROOT}/nemoclaw-blueprint/policies/openclaw-sandbox.yaml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}  ▸${NC} $*"; }
ok() { echo -e "${GREEN}  ✓${NC} $*"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $*"; }
fatal() {
  echo -e "${RED}  ✗${NC} $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 <agent-name> [--parent <parent-name>]"
  echo ""
  echo "Creates a new GPU-enabled agent sandbox and registers it in the"
  echo "parent agent's dashboard Agents tab."
  echo ""
  echo "Options:"
  echo "  --parent <name>   Parent agent to register under (default: defaultSandbox)"
  exit 1
}

# ── Parse arguments ──────────────────────────────────────────────────────────
AGENT_NAME=""
PARENT_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parent)
      PARENT_NAME="${2:-}"
      [[ -n "$PARENT_NAME" ]] || fatal "--parent requires a value"
      shift 2
      ;;
    -h | --help)
      usage
      ;;
    -*)
      fatal "Unknown option: $1"
      ;;
    *)
      if [[ -z "$AGENT_NAME" ]]; then
        AGENT_NAME="$1"
      else
        fatal "Unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

[[ -n "$AGENT_NAME" ]] || usage

# ── Resolve parent from registry ─────────────────────────────────────────────
SANDBOXES_FILE="$HOME/.nemoclaw/sandboxes.json"

if [[ -z "$PARENT_NAME" ]]; then
  PARENT_NAME=$(python3 -c "
import json, sys, os
p = os.path.expanduser('$SANDBOXES_FILE')
if not os.path.exists(p): sys.exit(1)
d = json.load(open(p))
print(d.get('defaultSandbox', ''))
" 2>/dev/null) || true
  [[ -n "$PARENT_NAME" ]] || fatal "No --parent given and no defaultSandbox in $SANDBOXES_FILE"
fi

# Can't use same name as parent
[[ "$AGENT_NAME" != "$PARENT_NAME" ]] || fatal "Agent name cannot be the same as parent ('$PARENT_NAME')"

# ── Resolve gateway name ─────────────────────────────────────────────────────
GATEWAY_NAME=$(openshell gateway info 2>&1 | grep -oP 'Gateway:\s+\K\S+' || echo "nemoclaw")
GATEWAY_CONTAINER="openshell-cluster-${GATEWAY_NAME}"

echo ""
echo -e "  ${CYAN}Add GPU Agent${NC}"
echo "  ════════════════════════════════════════════"
echo ""
info "New agent: ${AGENT_NAME}"
info "Parent:    ${PARENT_NAME}"
info "Gateway:   ${GATEWAY_NAME} (${GATEWAY_CONTAINER})"
info "Image:     ${IMAGE_REF}"
echo ""

# ── Preflight checks ─────────────────────────────────────────────────────────
docker ps --format '{{.Names}}' | grep -q "^${GATEWAY_CONTAINER}$" \
  || fatal "Gateway container '${GATEWAY_CONTAINER}' is not running."

# Check parent sandbox is running
openshell sandbox list 2>/dev/null | grep -q "${PARENT_NAME}.*Ready" \
  || fatal "Parent sandbox '${PARENT_NAME}' is not in Ready state."

# Check agent doesn't already exist
if openshell sandbox list 2>/dev/null | grep -q "^${AGENT_NAME} "; then
  fatal "Sandbox '${AGENT_NAME}' already exists. Delete it first: openshell sandbox delete ${AGENT_NAME}"
fi

# ── Ensure GPU time-slicing is enabled ────────────────────────────────────────
# With a single physical GPU, time-slicing lets multiple sandboxes share it.
GPU_ALLOC=$(docker exec "${GATEWAY_CONTAINER}" \
  kubectl get nodes -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}' 2>/dev/null || echo "0")

if ((GPU_ALLOC <= 1)); then
  info "Only ${GPU_ALLOC} GPU(s) allocatable — enabling time-slicing (4 replicas)..."
  docker exec -i "${GATEWAY_CONTAINER}" kubectl apply -f - <<'TSCM'
apiVersion: v1
kind: ConfigMap
metadata:
  name: nvidia-device-plugin-config
  namespace: nvidia-device-plugin
data:
  config.yaml: |
    version: v1
    sharing:
      timeSlicing:
        renameByDefault: false
        resources:
          - name: nvidia.com/gpu
            replicas: 4
TSCM

  # Patch DaemonSet to use the config (idempotent — will no-op if already patched)
  CURRENT_ARGS=$(docker exec "${GATEWAY_CONTAINER}" \
    kubectl get ds nvidia-device-plugin -n nvidia-device-plugin \
    -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null || echo "")

  if [[ "$CURRENT_ARGS" != *"--config-file"* ]]; then
    docker exec -i "${GATEWAY_CONTAINER}" kubectl patch ds nvidia-device-plugin \
      -n nvidia-device-plugin --type=json -p '[
      {"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"device-plugin-config","configMap":{"name":"nvidia-device-plugin-config"}}},
      {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-","value":{"name":"device-plugin-config","mountPath":"/etc/nvidia/device-plugin"}},
      {"op":"replace","path":"/spec/template/spec/containers/0/args","value":["--config-file=/etc/nvidia/device-plugin/config.yaml"]}
    ]' 2>&1 | tail -1

    info "Waiting for device plugin pod to restart..."
    sleep 8
  fi

  # Wait for GPU count to update
  for i in $(seq 1 20); do
    NEW_ALLOC=$(docker exec "${GATEWAY_CONTAINER}" \
      kubectl get nodes -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}' 2>/dev/null || echo "0")
    if ((NEW_ALLOC > 1)); then
      ok "GPU time-slicing active: ${NEW_ALLOC} virtual GPUs available"
      break
    fi
    if ((i == 20)); then
      warn "GPU time-slicing may not have taken effect yet (still ${NEW_ALLOC} GPU(s))"
    fi
    sleep 2
  done
else
  ok "GPU allocation OK: ${GPU_ALLOC} GPU(s) available"
fi

# Check GPU image exists in k3s
IMAGE_IN_K3S=$(docker exec "${GATEWAY_CONTAINER}" \
  ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images ls -q 2>/dev/null \
  | grep -c "docker.io/library/${IMAGE_REF}" || echo "0")

if ((IMAGE_IN_K3S == 0)); then
  # Check if the image exists locally in Docker
  if docker image inspect "${IMAGE_REF}" >/dev/null 2>&1; then
    info "Image '${IMAGE_REF}' not in k3s — importing from Docker..."
    docker save "${IMAGE_REF}" | docker exec -i "${GATEWAY_CONTAINER}" \
      ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import - 2>&1 \
      | grep -v "^$" || true
    ok "Image imported into k3s"
  else
    # Need to build the image first
    [[ -f "${NEMOCLAW_ROOT}/Dockerfile.sandbox-ai" ]] \
      || fatal "Dockerfile.sandbox-ai not found and image '${IMAGE_REF}' not available"
    info "Building GPU image (${IMAGE_REF})..."
    docker build -f "${NEMOCLAW_ROOT}/Dockerfile.sandbox-ai" \
      -t "${IMAGE_REF}" \
      "${NEMOCLAW_ROOT}" 2>&1 | tail -5
    docker save "${IMAGE_REF}" | docker exec -i "${GATEWAY_CONTAINER}" \
      ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import - 2>&1 \
      | grep -v "^$" || true
    ok "Image built and imported into k3s"
  fi
else
  ok "Image '${IMAGE_REF}' already in k3s"
fi

# ── Step 1: Create GPU sandbox ───────────────────────────────────────────────
echo -e "  ${CYAN}[1/5]${NC} Creating GPU sandbox '${AGENT_NAME}'"

CREATE_ARGS=(
  "--name" "${AGENT_NAME}"
  "--from" "${IMAGE_REF}"
  "--gpu"
)
if [[ -f "$POLICY_FILE" ]]; then
  CREATE_ARGS+=("--policy" "${POLICY_FILE}")
fi

openshell sandbox create "${CREATE_ARGS[@]}" -- env "CHAT_UI_URL=http://127.0.0.1:${DASHBOARD_PORT}" nemoclaw-start 2>&1 \
  | grep -v "^$" || true

info "Waiting for sandbox to become Ready..."
for i in $(seq 1 $MAX_READY_WAIT); do
  if openshell sandbox list 2>/dev/null | grep -q "${AGENT_NAME}.*Ready"; then
    break
  fi
  if ((i == MAX_READY_WAIT)); then
    fatal "Sandbox did not reach Ready state within ${MAX_READY_WAIT}s"
  fi
  sleep 1
done
ok "Sandbox '${AGENT_NAME}' is Ready"

# ── Step 2: Fix permissions & start gateway ──────────────────────────────────
echo -e "  ${CYAN}[2/5]${NC} Starting openclaw gateway inside sandbox"

# Fix .openclaw directory permissions (root-owned from Dockerfile)
docker exec "${GATEWAY_CONTAINER}" kubectl exec -n openshell "${AGENT_NAME}" -- \
  bash -c 'chmod 755 /sandbox/.openclaw 2>/dev/null; chmod 755 /sandbox/.openclaw/logs 2>/dev/null; chown sandbox:sandbox /sandbox/.openclaw/logs 2>/dev/null' \
  2>/dev/null || true

# SSH proxy command for the new sandbox
SSH_PROXY="/home/mindseye/.local/bin/openshell ssh-proxy --gateway-name ${GATEWAY_NAME} --name ${AGENT_NAME}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

ssh_exec() {
  ssh "${SSH_OPTS[@]}" -o "ProxyCommand=${SSH_PROXY}" "sandbox@openshell-${AGENT_NAME}" "$@"
}

# Check if gateway is already running
GATEWAY_UP=$(ssh_exec "ss -tlnp 2>/dev/null | grep -c ':${DASHBOARD_PORT}'" 2>/dev/null || echo "0")

if ((GATEWAY_UP == 0)); then
  ssh_exec "HOME=/sandbox nohup openclaw gateway run > /sandbox/gateway.log 2>&1 &" 2>/dev/null || true

  for i in $(seq 1 $MAX_GATEWAY_WAIT); do
    UP=$(ssh_exec "ss -tlnp 2>/dev/null | grep -c ':${DASHBOARD_PORT}'" 2>/dev/null || echo "0")
    if ((UP > 0)); then break; fi
    if ((i == MAX_GATEWAY_WAIT)); then
      warn "Gateway did not start within ${MAX_GATEWAY_WAIT}s — check 'cat /sandbox/gateway.log'"
    fi
    sleep 1
  done
fi
ok "Gateway listening on port ${DASHBOARD_PORT}"

# ── Step 3: Write NemoClaw config inside sandbox ─────────────────────────────
echo -e "  ${CYAN}[3/5]${NC} Writing NemoClaw config inside sandbox"

ssh_exec "mkdir -p ~/.nemoclaw" 2>/dev/null || true

# Read the config from parent sandbox and replicate it
PARENT_SSH_PROXY="/home/mindseye/.local/bin/openshell ssh-proxy --gateway-name ${GATEWAY_NAME} --name ${PARENT_NAME}"
parent_ssh_exec() {
  ssh "${SSH_OPTS[@]}" -o "ProxyCommand=${PARENT_SSH_PROXY}" "sandbox@openshell-${PARENT_NAME}" "$@"
}

PARENT_CONFIG=$(parent_ssh_exec "cat ~/.nemoclaw/config.json 2>/dev/null" 2>/dev/null || echo "")

if [[ -n "$PARENT_CONFIG" ]]; then
  # Use parent's config as template (same inference endpoint, model, etc.)
  ssh_exec "cat > ~/.nemoclaw/config.json" <<<"$PARENT_CONFIG" 2>/dev/null || true
  ok "Config copied from parent '${PARENT_NAME}'"
else
  # Fallback: construct from credentials
  CREDS_FILE="$HOME/.nemoclaw/credentials.json"
  if [[ -f "$CREDS_FILE" ]]; then
    ssh_exec "cat > ~/.nemoclaw/config.json" <<'CONFIGEOF' 2>/dev/null || true
{
  "endpointType": "custom",
  "endpointUrl": "https://inference.local/v1",
  "ncpPartner": null,
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "profile": "inference-local",
  "credentialEnv": "OPENAI_API_KEY",
  "provider": "nvidia-prod",
  "providerLabel": "NVIDIA Endpoints"
}
CONFIGEOF
    ok "Config written (fallback)"
  else
    warn "No config available — agent may not have inference configured"
  fi
fi

# ── Step 4: Register agent in parent's openclaw.json ─────────────────────────
echo -e "  ${CYAN}[4/5]${NC} Registering '${AGENT_NAME}' in parent's Agents tab"

# Extract the new agent's auth token for reference
NEW_AUTH_TOKEN=$(ssh_exec \
  "python3 -c \"import json; print(json.load(open('/sandbox/.openclaw/openclaw.json'))['gateway']['auth']['token'])\"" \
  2>/dev/null || echo "")

# Patch the parent sandbox's openclaw.json to add this agent.
# The file is root-owned (444), so we must use kubectl exec (runs as root).
docker exec -i "${GATEWAY_CONTAINER}" kubectl exec -n openshell "${PARENT_NAME}" -- python3 -c '
import json, os, stat

config_path = "/sandbox/.openclaw/openclaw.json"
config = json.load(open(config_path))

if "agents" not in config:
    config["agents"] = {"defaults": {}, "list": []}
if "list" not in config.get("agents", {}):
    config["agents"]["list"] = []

agent_list = config["agents"]["list"]

existing = [a for a in agent_list if a.get("id") == "'"${AGENT_NAME}"'"]
if not existing:
    agent_list.append({"id": "'"${AGENT_NAME}"'", "name": "'"${AGENT_NAME}"'"})

parent = None
for a in agent_list:
    if a.get("id") == "'"${PARENT_NAME}"'":
        parent = a
        break
if parent is None:
    parent = {"id": "'"${PARENT_NAME}"'", "name": "'"${PARENT_NAME}"'"}
    agent_list.insert(0, parent)

if "subagents" not in parent:
    parent["subagents"] = {"allowAgents": []}
if "'"${AGENT_NAME}"'" not in parent["subagents"]["allowAgents"]:
    parent["subagents"]["allowAgents"].append("'"${AGENT_NAME}"'")

os.chmod(config_path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
json.dump(config, open(config_path, "w"), indent=2)
os.chmod(config_path, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
print("Agent registered as subagent of '"${PARENT_NAME}"'")
' 2>/dev/null || warn "Could not patch parent openclaw.json"

ok "Agent visible in parent's Agents tab"

# ── Step 5: Update local registry ────────────────────────────────────────────
echo -e "  ${CYAN}[5/5]${NC} Updating local sandbox registry"

python3 -c "
import json, os, datetime
p = os.path.expanduser('$SANDBOXES_FILE')
if os.path.exists(p):
    d = json.load(open(p))
else:
    d = {'sandboxes': {}, 'defaultSandbox': ''}

d['sandboxes']['${AGENT_NAME}'] = {
    'name': '${AGENT_NAME}',
    'createdAt': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z'),
    'model': None,
    'nimContainer': None,
    'provider': None,
    'gpuEnabled': True,
    'policies': ['pypi', 'npm'],
    'parentAgent': '${PARENT_NAME}'
}
json.dump(d, open(p, 'w'), indent=2)
print('  ✓ Registry updated')
" 2>/dev/null || warn "Could not update local registry"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "  ════════════════════════════════════════════"

# Verify GPU
GPU_CHECK=$(ssh_exec "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null" 2>/dev/null || echo "")
if [[ -n "$GPU_CHECK" ]]; then
  ok "GPU: ${GPU_CHECK}"
else
  warn "GPU not detected inside sandbox"
fi

# Verify PyTorch
TORCH_CHECK=$(ssh_exec \
  "python3 -c 'import torch; print(f\"PyTorch {torch.__version__}, CUDA={torch.cuda.is_available()}\")'" \
  2>/dev/null || echo "")
if [[ -n "$TORCH_CHECK" ]]; then
  ok "${TORCH_CHECK}"
fi

ok "Agent '${AGENT_NAME}' created (subagent of '${PARENT_NAME}')"

if [[ -n "$NEW_AUTH_TOKEN" ]]; then
  info "Agent's own dashboard: http://127.0.0.1:<port>/#token=${NEW_AUTH_TOKEN}"
  info "(Use 'openshell forward start --background <port> ${AGENT_NAME}' to access)"
fi

echo ""
info "The agent should now appear in ${PARENT_NAME}'s dashboard Agents tab."
info "Refresh the dashboard at: http://127.0.0.1:${DASHBOARD_PORT}/"
echo ""
info "Next steps:"
info "  nemoclaw sandbox-init ${AGENT_NAME} --parent-agent ${PARENT_NAME}   # set up workspace files"
info "  ssh into ${AGENT_NAME}: ssh ${SSH_OPTS[*]} -o \"ProxyCommand=${SSH_PROXY}\" sandbox@openshell-${AGENT_NAME}"
echo ""
