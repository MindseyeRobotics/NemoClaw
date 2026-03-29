#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# post-onboard-gpu.sh — Replace standard onboard sandbox with GPU-enabled image.
#
# Run AFTER `nemoclaw onboard` completes. This script:
#   1. Deletes the standard (non-GPU) sandbox created by onboard
#   2. Builds the GPU image from Dockerfile.sandbox-ai
#   3. Imports it into the k3s containerd inside the gateway container
#   4. Recreates the sandbox with --gpu using the imported image
#   5. Waits for the sandbox to be Ready
#   6. Starts the openclaw gateway inside the sandbox
#   7. Re-establishes the port forward on 18789
#   8. Syncs the NemoClaw config written by onboard
#
# Usage:
#   bash scripts/post-onboard-gpu.sh [sandbox-name]
#
# Defaults to the sandbox registered in ~/.nemoclaw/sandboxes.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEMOCLAW_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="nemoclaw-sandbox-ai"
IMAGE_TAG="v3"
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

# ── Resolve sandbox name ─────────────────────────────────────────────────────
SANDBOX_NAME="${1:-}"
if [[ -z "$SANDBOX_NAME" ]]; then
  SANDBOX_NAME=$(python3 -c "
import json, sys, os
p = os.path.expanduser('~/.nemoclaw/sandboxes.json')
if not os.path.exists(p):
    sys.exit(1)
d = json.load(open(p))
name = d.get('defaultSandbox') or next(iter(d.get('sandboxes', {})), '')
print(name)
" 2>/dev/null) || true
fi
[[ -n "$SANDBOX_NAME" ]] || fatal "No sandbox name given and none found in ~/.nemoclaw/sandboxes.json"

# ── Resolve gateway name ─────────────────────────────────────────────────────
GATEWAY_NAME=$(openshell gateway info 2>&1 | grep -oP 'Gateway:\s+\K\S+' || echo "nemoclaw")
GATEWAY_CONTAINER="openshell-cluster-${GATEWAY_NAME}"

echo ""
echo -e "  ${CYAN}Post-Onboard GPU Swap${NC}"
echo "  ════════════════════════════════════════════"
echo ""
info "Sandbox:   ${SANDBOX_NAME}"
info "Gateway:   ${GATEWAY_NAME} (${GATEWAY_CONTAINER})"
info "Image:     ${IMAGE_REF}"
echo ""

# ── Preflight checks ─────────────────────────────────────────────────────────
docker ps --format '{{.Names}}' | grep -q "^${GATEWAY_CONTAINER}$" \
  || fatal "Gateway container '${GATEWAY_CONTAINER}' is not running. Run 'nemoclaw onboard' first."

[[ -f "${NEMOCLAW_ROOT}/Dockerfile.sandbox-ai" ]] \
  || fatal "Dockerfile.sandbox-ai not found in ${NEMOCLAW_ROOT}"

# ── Step 0: Ensure gateway has GPU support ───────────────────────────────────
# The onboard command creates the gateway WITHOUT --gpu. GPU sandboxes require
# the gateway to have the NVIDIA k8s-device-plugin deployed. Recreate it with
# --gpu if the current gateway lacks GPU allocation.
GPU_IN_GW=$(docker exec "${GATEWAY_CONTAINER}" kubectl get nodes -o json 2>/dev/null \
  | python3 -c "import json,sys; n=json.load(sys.stdin); print(sum(int(node.get('status',{}).get('allocatable',{}).get('nvidia.com/gpu','0')) for node in n.get('items',[])))" 2>/dev/null || echo "0")

if ((GPU_IN_GW == 0)); then
  warn "Gateway '${GATEWAY_NAME}' has no GPU support — recreating with --gpu"
  openshell forward stop "${DASHBOARD_PORT}" 2>/dev/null || true
  openshell sandbox delete "${SANDBOX_NAME}" 2>/dev/null || true

  openshell gateway start --name "${GATEWAY_NAME}" --recreate --gpu 2>&1 | tail -5
  openshell gateway select "${GATEWAY_NAME}" 2>/dev/null || true

  # Recreating the gateway wipes inference config. Restore the NVIDIA provider
  # and model that onboard set up in step 4.
  CREDS_FILE="$HOME/.nemoclaw/credentials.json"
  if [[ -f "$CREDS_FILE" ]]; then
    API_KEY=$(python3 -c "import json; print(json.load(open('${CREDS_FILE}'))['NVIDIA_API_KEY'])" 2>/dev/null || echo "")
    if [[ -n "$API_KEY" ]]; then
      info "Restoring inference provider nvidia-prod..."
      openshell provider create --name nvidia-prod --type nvidia \
        --credential "NVIDIA_API_KEY=${API_KEY}" \
        --config "baseUrl=https://integrate.api.nvidia.com/v1" 2>&1 | tail -1
      openshell inference set --provider nvidia-prod \
        --model nvidia/nemotron-3-super-120b-a12b 2>&1 | tail -1
      ok "Inference restored: nvidia-prod / nvidia/nemotron-3-super-120b-a12b"
    else
      warn "Could not read NVIDIA_API_KEY from ${CREDS_FILE} — run 'openshell inference set' manually"
    fi
  else
    warn "No credentials file found at ${CREDS_FILE} — inference not configured"
  fi

  # Update container name (should be the same, but refresh)
  GATEWAY_CONTAINER="openshell-cluster-${GATEWAY_NAME}"
  ok "Gateway recreated with GPU support"
else
  ok "Gateway already has GPU support (${GPU_IN_GW} GPU(s))"
fi

# ── Step 1: Stop forward and delete existing sandbox ─────────────────────────
echo -e "  ${CYAN}[1/6]${NC} Removing standard sandbox '${SANDBOX_NAME}'"
openshell forward stop "${DASHBOARD_PORT}" "${SANDBOX_NAME}" 2>/dev/null || true
openshell sandbox delete "${SANDBOX_NAME}" 2>/dev/null || true
ok "Old sandbox removed"

# ── Step 2: Build GPU image ──────────────────────────────────────────────────
echo -e "  ${CYAN}[2/6]${NC} Building GPU image (${IMAGE_REF})"
docker build -f "${NEMOCLAW_ROOT}/Dockerfile.sandbox-ai" \
  -t "${IMAGE_REF}" \
  "${NEMOCLAW_ROOT}" 2>&1 | tail -5
ok "Image built: ${IMAGE_REF}"

# ── Step 3: Import into k3s containerd ───────────────────────────────────────
echo -e "  ${CYAN}[3/6]${NC} Importing image into k3s"
docker save "${IMAGE_REF}" | docker exec -i "${GATEWAY_CONTAINER}" \
  ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import - 2>&1 \
  | grep -v "^$" || true
ok "Image available in k3s"

# ── Step 4: Create GPU sandbox ───────────────────────────────────────────────
echo -e "  ${CYAN}[4/6]${NC} Creating GPU sandbox '${SANDBOX_NAME}'"

CREATE_ARGS=(
  "--name" "${SANDBOX_NAME}"
  "--from" "${IMAGE_REF}"
  "--gpu"
)
if [[ -f "$POLICY_FILE" ]]; then
  CREATE_ARGS+=("--policy" "${POLICY_FILE}")
fi

# Create the sandbox (-- separator sends startup command into container)
openshell sandbox create "${CREATE_ARGS[@]}" -- env "CHAT_UI_URL=http://127.0.0.1:${DASHBOARD_PORT}" nemoclaw-start 2>&1 \
  | grep -v "^$" || true

# Wait for Ready
info "Waiting for sandbox to become Ready..."
for i in $(seq 1 $MAX_READY_WAIT); do
  if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready"; then
    break
  fi
  if ((i == MAX_READY_WAIT)); then
    fatal "Sandbox did not reach Ready state within ${MAX_READY_WAIT}s"
  fi
  sleep 1
done
ok "Sandbox '${SANDBOX_NAME}' is Ready"

# ── Step 5: Start gateway inside sandbox ─────────────────────────────────────
echo -e "  ${CYAN}[5/6]${NC} Starting openclaw gateway inside sandbox"

# The OpenShell ENTRYPOINT override means nemoclaw-start didn't run.
# Start the gateway manually via SSH.
SSH_CMD="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
SSH_CMD+=" -o ProxyCommand='/home/mindseye/.local/bin/openshell ssh-proxy --gateway-name ${GATEWAY_NAME} --name ${SANDBOX_NAME}'"
SSH_CMD+=" sandbox@openshell-${SANDBOX_NAME}"

# Check if gateway is already listening (in case nemoclaw-start DID run)
GATEWAY_UP=$(eval "${SSH_CMD}" "ss -tlnp 2>/dev/null | grep -c ':${DASHBOARD_PORT}'" 2>/dev/null || echo "0")

if ((GATEWAY_UP == 0)); then
  info "Gateway not running, starting it..."

  # Fix permissions on .openclaw directory if needed (root-owned from Dockerfile build)
  docker exec "${GATEWAY_CONTAINER}" kubectl exec -n openshell "${SANDBOX_NAME}" -- \
    bash -c 'chmod 755 /sandbox/.openclaw 2>/dev/null; chmod 755 /sandbox/.openclaw/logs 2>/dev/null; chown sandbox:sandbox /sandbox/.openclaw/logs 2>/dev/null' \
    2>/dev/null || true

  # Start the gateway
  eval "${SSH_CMD}" "HTTPS_PROXY=http://10.200.0.1:3128 NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_OPTIONS=--use-env-proxy HOME=/sandbox nohup openclaw gateway run > /sandbox/gateway.log 2>&1 &" 2>/dev/null || true

  # Wait for gateway to come up
  for i in $(seq 1 $MAX_GATEWAY_WAIT); do
    UP=$(eval "${SSH_CMD}" "ss -tlnp 2>/dev/null | grep -c ':${DASHBOARD_PORT}'" 2>/dev/null || echo "0")
    if ((UP > 0)); then
      break
    fi
    if ((i == MAX_GATEWAY_WAIT)); then
      warn "Gateway did not start within ${MAX_GATEWAY_WAIT}s"
      warn "Check logs: ssh into sandbox and run 'cat /sandbox/gateway.log'"
    fi
    sleep 1
  done
fi
ok "Gateway listening on port ${DASHBOARD_PORT}"

# ── Step 6: Port forward + verify ────────────────────────────────────────────
echo -e "  ${CYAN}[6/6]${NC} Setting up port forward and verifying"

openshell forward stop "${DASHBOARD_PORT}" 2>/dev/null || true
openshell forward start --background "${DASHBOARD_PORT}" "${SANDBOX_NAME}" 2>/dev/null || true

# Extract auth token
AUTH_TOKEN=$(eval "${SSH_CMD}" \
  "python3 -c \"import json; print(json.load(open('/sandbox/.openclaw/openclaw.json'))['gateway']['auth']['token'])\"" \
  2>/dev/null || echo "")

# Sync NemoClaw config if it exists locally but not in sandbox
eval "${SSH_CMD}" "mkdir -p ~/.nemoclaw" 2>/dev/null || true
if [[ -f "$HOME/.nemoclaw/sandboxes.json" ]]; then
  # Update registry to mark GPU-enabled
  python3 -c "
import json, os
p = os.path.expanduser('~/.nemoclaw/sandboxes.json')
d = json.load(open(p))
if '${SANDBOX_NAME}' in d.get('sandboxes', {}):
    d['sandboxes']['${SANDBOX_NAME}']['gpuEnabled'] = True
    json.dump(d, open(p, 'w'), indent=2)
" 2>/dev/null || true
fi

# Verify GPU inside sandbox
info "Verifying GPU access..."
GPU_CHECK=$(eval "${SSH_CMD}" \
  "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null" \
  2>/dev/null || echo "")

echo ""
echo "  ════════════════════════════════════════════"
if [[ -n "$GPU_CHECK" ]]; then
  ok "GPU: ${GPU_CHECK}"
else
  warn "GPU not detected inside sandbox (nvidia-smi not found)"
  warn "The --gpu flag may not have allocated a device"
fi

# Verify PyTorch
TORCH_CHECK=$(eval "${SSH_CMD}" \
  "python3 -c 'import torch; print(f\"PyTorch {torch.__version__}, CUDA={torch.cuda.is_available()}\")'" \
  2>/dev/null || echo "")
if [[ -n "$TORCH_CHECK" ]]; then
  ok "${TORCH_CHECK}"
fi

if [[ -n "$AUTH_TOKEN" ]]; then
  ok "Dashboard: http://127.0.0.1:${DASHBOARD_PORT}/#token=${AUTH_TOKEN}"
else
  ok "Dashboard: http://127.0.0.1:${DASHBOARD_PORT}/"
  warn "Could not extract auth token"
fi
echo ""
ok "Done! Sandbox '${SANDBOX_NAME}' is running with GPU."
echo ""
