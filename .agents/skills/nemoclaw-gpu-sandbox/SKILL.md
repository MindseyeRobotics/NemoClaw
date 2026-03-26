---
name: nemoclaw-gpu-sandbox
description: "Set up a GPU-accelerated NemoClaw sandbox using a custom CUDA image. Add multiple GPU agents on a single physical GPU using time-slicing via 'nemoclaw add-gpu-agent'. Resume a sandbox after a reboot or restart. Persist sandboxes across reboots via systemd autostart. Use when: gpu sandbox, gpu agent, cuda sandbox, pytorch sandbox, add agent, multi-agent gpu, time-slicing gpu, sandbox resume, post-onboard gpu, gpu enablement, add-gpu-agent, post-onboard-gpu, nemoclaw add-gpu-agent command, autostart, reboot, systemd, persist sandbox, restart policy."
---

# NemoClaw GPU Sandbox Enablement

Set up GPU-accelerated sandboxes with CUDA/PyTorch support, add multiple GPU agents on a single machine using time-slicing, and resume sandboxes after a restart.

## Overview

NemoClaw's default `nemoclaw onboard` creates a CPU-only sandbox. For AI/ML workloads that need a GPU directly inside the sandbox, use the GPU enablement scripts in `scripts/`:

| Script | Purpose |
|--------|---------|
| `scripts/post-onboard-gpu.sh` | After `nemoclaw onboard`, replace the standard sandbox with a GPU-backed one |
| `scripts/add-gpu-agent.sh` | Add a second (or third, etc.) named GPU agent that appears in the Agents tab |
| `scripts/setup-autostart.sh` | Configure Docker restart policy + systemd user service so sandboxes survive reboots |
| `Dockerfile.sandbox-ai` | CUDA 12.6 + PyTorch 2.6.0+cu126 + Node 22 + openclaw — source image for all GPU sandboxes |

---

## Step 1: Run the Initial Onboard

Run the standard onboard if you haven't already. This creates the gateway and configures inference.

```console
$ cd NemoClaw
$ nemoclaw onboard
```

Follow the prompts to select an inference provider and model. This registers your NVIDIA API key in `~/.nemoclaw/credentials.json`.

---

## Step 2: Swap to a GPU Sandbox (`post-onboard-gpu.sh`)

After onboard completes, run the post-onboard GPU swap script:

```console
$ bash scripts/post-onboard-gpu.sh [sandbox-name]
```

If you omit `sandbox-name`, the script reads the default sandbox from `~/.nemoclaw/sandboxes.json`.

### What the script does

1. **Step 0** — Detects whether the gateway was created without `--gpu` (onboard intentionally omits it). If so, recreates the gateway with `--gpu` and restores the inference provider from `~/.nemoclaw/credentials.json`.
2. **Steps 1–6** — Deletes the standard sandbox → builds `Dockerfile.sandbox-ai` → imports the image into the gateway's k3s containerd → creates a new GPU sandbox with `--gpu` → waits for Ready → starts the openclaw gateway inside the sandbox → re-establishes port-forward on `18789`.

### Expected output

```text
  ✓ Gateway already has GPU support (1 GPU(s))
  [1/6] Removing standard sandbox 'cortana'
  [2/6] Building GPU image (nemoclaw-sandbox-ai:v3)
  [3/6] Importing image into k3s
  [4/6] Creating GPU sandbox 'cortana'
  [5/6] Starting openclaw gateway inside sandbox
  [6/6] Setting up port forward and verifying
  ✓ GPU: NVIDIA GeForce RTX 5070 Laptop GPU, 8151 MiB
  ✓ PyTorch 2.6.0+cu126, CUDA=True
  ✓ Dashboard: http://127.0.0.1:18789/#token=<token>
```

### Important: k8s image tagging

The GPU image uses an explicit version tag (`:v3`, not `:latest`). k3s uses `IfNotPresent` pull policy, which means `:latest` tags are **never** re-pulled. Always use versioned tags when building a new image variant.

---

## Step 3: Add More GPU Agents (`nemoclaw add-gpu-agent`)

To add a second agent (e.g., "jarvis") that appears in the Agents tab alongside the primary agent:

```console
$ nemoclaw add-gpu-agent jarvis
# or specify a parent explicitly:
$ nemoclaw add-gpu-agent jarvis --parent cortana
```

The underlying shell script (`scripts/add-gpu-agent.sh`) is also available for advanced use.

### Prerequisites

- A running parent sandbox (default: `defaultSandbox` from `~/.nemoclaw/sandboxes.json`).
- The GPU image already built (the script auto-imports from Docker if needed, or builds from `Dockerfile.sandbox-ai`).

### Single-GPU time-slicing (automatic)

If only one physical GPU is allocatable, the script automatically enables **NVIDIA device plugin time-slicing** before creating the sandbox. This exposes 4 virtual GPU replicas from the single physical GPU, allowing multiple sandboxes to share it concurrently.

The script is idempotent: if time-slicing is already active, it skips the configuration step.

### What the script does

1. Checks that GPU time-slicing is active; enables it if needed (4 replicas by default).
2. Creates a new GPU sandbox from the shared image.
3. Fixes `.openclaw` directory permissions and starts the openclaw gateway inside the new sandbox.
4. Copies the inference config (`~/.nemoclaw/config.json`) from the parent sandbox.
5. Registers the new agent in the parent sandbox's `~/.openclaw/openclaw.json` as a subagent — this makes it appear in the dashboard Agents tab.
6. Updates `~/.nemoclaw/sandboxes.json` with the new agent entry.

### After creation

Initialize workspace files for the new agent:

```console
$ nemoclaw sandbox-init jarvis --parent-agent cortana
```

This uploads `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, and `USER.md` into the new sandbox's workspace.

---

## Step 4: Resume a Sandbox (`nemoclaw <name> resume`)

After a reboot or when the dashboard port-forward drops, resume the sandbox without recreating it:

```console
$ nemoclaw cortana resume
$ nemoclaw jarvis resume
```

This:

1. Verifies the sandbox still exists in openshell.
2. Checks whether the openclaw gateway is already listening; starts it if not.
3. Re-establishes the port-forward on `18789`.
4. Prints the dashboard URL with the auth token.

---

## Step 5: Persist Sandboxes Across Reboots (`setup-autostart.sh`)

By default, sandboxes do **not** survive a reboot:

| Component | Survives reboot? | Reason |
|---|---|---|
| Gateway container (`openshell-cluster-nemoclaw`) | No | Docker restart policy defaults to `no` |
| k3s + sandbox pods (cortana, jarvis) | No | Pods run inside the gateway container |
| Port forwards (port 18789) | No | Background processes, not supervised |
| openclaw gateway inside sandboxes | No | Started on-demand, no supervisor |
| Config files (`~/.nemoclaw/`, `~/.openclaw/`) | **Yes** | Host filesystem |

To make everything come back automatically after a reboot, run the autostart setup script once:

```console
$ bash scripts/setup-autostart.sh
```

### What the script does

1. Sets Docker restart policy to `unless-stopped` on the gateway container so Docker brings it back.
2. Generates `scripts/resume-all-sandboxes.sh` — polls until the gateway is ready, then runs `nemoclaw <name> resume` for every sandbox in `~/.nemoclaw/sandboxes.json`.
3. Writes `~/.config/systemd/user/nemoclaw-autostart.service` — a oneshot service that runs the resume script after the network and Docker are up.
4. Enables the service with `systemctl --user enable nemoclaw-autostart`.
5. Optionally enables `loginctl enable-linger` so the service fires at boot even without an interactive login.

### After setup

On every reboot:

1. Docker starts the gateway container automatically.
2. systemd user service starts and runs `resume-all-sandboxes.sh`.
3. All registered sandboxes come up with their gateway and port-forward restored.

### Manual alternative (no autostart)

If you prefer to resume manually after each reboot:

```console
$ nemoclaw start           # restart the gateway container
$ nemoclaw cortana resume  # restore gateway + port-forward for cortana
$ nemoclaw jarvis resume   # restore gateway + port-forward for jarvis
```

### Manage the service

```console
$ systemctl --user status  nemoclaw-autostart
$ systemctl --user restart nemoclaw-autostart
$ journalctl --user -u nemoclaw-autostart -f
$ bash scripts/setup-autostart.sh --uninstall
```

---

## Troubleshooting

### `FailedPrecondition: GPU sandbox requested, but the active gateway has no allocatable GPUs`

The gateway was created without `--gpu`. Run `post-onboard-gpu.sh` — Step 0 detects this and recreates the gateway automatically.

### `Sandbox did not reach Ready state within 60s`

The physical GPU is already fully allocated to another sandbox. Run `add-gpu-agent.sh`, which enables time-slicing so the GPU can be shared. If time-slicing was already enabled and the error persists, check the device plugin pod:

```console
$ docker exec openshell-cluster-nemoclaw kubectl get pods -n nvidia-device-plugin
$ docker exec openshell-cluster-nemoclaw kubectl get nodes -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}'
```

### Agent doesn't appear in the Agents tab

The dashboard reads agent list from `~/.openclaw/openclaw.json` inside the primary sandbox. Run `add-gpu-agent.sh` again (it's idempotent) to ensure the agent is registered, or manually patch the config:

```console
$ docker exec openshell-cluster-nemoclaw kubectl exec -n openshell cortana -- \
    python3 -c "import json; ..."
```

### Dashboard returns HEARTBEAT.md instead of an LLM response

The sandbox is missing `~/.nemoclaw/config.json`. Run `add-gpu-agent.sh` (it copies from the parent), or write it manually:

```console
$ ssh -o ProxyCommand='openshell ssh-proxy --gateway-name nemoclaw --name <sandbox>' \
    sandbox@openshell-<sandbox> \
    "mkdir -p ~/.nemoclaw && cat > ~/.nemoclaw/config.json" <<'EOF'
{
  "endpointType": "custom",
  "endpointUrl": "https://inference.local/v1",
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "profile": "inference-local",
  "provider": "nvidia-prod"
}
EOF
```

---

## Image Rebuild

To update the GPU image (e.g., upgrade PyTorch) bump the tag and rebuild:

```console
$ docker build -f Dockerfile.sandbox-ai -t nemoclaw-sandbox-ai:v4 .
$ docker save nemoclaw-sandbox-ai:v4 | docker exec -i openshell-cluster-nemoclaw \
    ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import -
```

Then update `IMAGE_TAG` in both scripts:

```bash
# scripts/post-onboard-gpu.sh and scripts/add-gpu-agent.sh
IMAGE_TAG="v4"
```
