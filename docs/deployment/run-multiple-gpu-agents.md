---
title:
  page: "Run Multiple GPU Agents on a Single Machine with NemoClaw"
  nav: "Run Multiple GPU Agents"
description: "Use GPU time-slicing to run two or more GPU-accelerated NemoClaw agents from a single physical GPU."
keywords: ["nemoclaw gpu agents", "gpu time-slicing kubernetes", "cuda sandbox nemoclaw", "multi-agent gpu nemoclaw"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "gpu", "cuda", "multi-agent", "time-slicing", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Run Multiple GPU Agents on a Single Machine

NemoClaw supports running multiple GPU-accelerated agent sandboxes on a single physical GPU using NVIDIA device plugin **time-slicing**.
Each sandbox gets its own `nvidia.com/gpu` allocation and sees the full GPU (with shared access at the hardware scheduler level).

## Prerequisites

- NemoClaw installed and a primary GPU sandbox already running.
  Follow the [Quickstart](../get-started/quickstart.md) and then run `scripts/post-onboard-gpu.sh` to enable GPU on the primary sandbox.
- Docker and the NVIDIA Container Toolkit installed on the host.
- The `openshell` CLI authenticated (`openshell gateway info` should return a gateway name).

## Step 1: Create a Second GPU Agent

Use the `nemoclaw add-gpu-agent` command with the name of the new agent:

```console
$ nemoclaw add-gpu-agent jarvis
```

To specify which existing agent acts as the parent (for the Agents tab graph view):

```console
$ nemoclaw add-gpu-agent jarvis --parent cortana
```

The command:

1. Checks if GPU time-slicing is active on the gateway k3s node. If the node reports only 1 allocatable GPU, it automatically configures the NVIDIA device plugin with 4 virtual replicas and waits for the node to report the new count.
2. Creates a new sandbox named `jarvis` from the shared GPU image (`nemoclaw-sandbox-ai:v3`).
3. Starts the openclaw gateway inside the new sandbox and copies the inference config from the parent sandbox.
4. Registers `jarvis` as a subagent of `cortana` in the parent's `openclaw.json`, which makes it appear in the dashboard **Agents** tab.

:::{note}
Time-slicing shares the physical GPU across all virtual replicas concurrently.
There is no memory isolation — each sandbox sees the full GPU memory.
For memory-heavy workloads, ensure total VRAM usage across all active agents stays within the physical GPU limit.
:::

## Step 2: Initialize the Workspace

Set up workspace identity and policy files for the new agent:

```console
$ nemoclaw sandbox-init jarvis --parent-agent cortana
```

This uploads `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, and `USER.md` into the new sandbox workspace.
See [Customize the workspace](../workspace/customize-workspace.md) for details on these files.

## Step 3: Verify GPU Access

SSH into the new sandbox and confirm GPU and PyTorch are available:

```console
$ ssh -o ProxyCommand='openshell ssh-proxy --gateway-name nemoclaw --name jarvis' \
    sandbox@openshell-jarvis \
    "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader && \
     python3 -c 'import torch; print(torch.__version__, torch.cuda.is_available())'"
```

Expected output:

```text
NVIDIA GeForce RTX 5070 Laptop GPU, 8151 MiB
2.6.0+cu126 True
```

## Step 4: View Agents in the Dashboard

Refresh the parent agent's dashboard. The new agent appears in the **Agents** tab as a node connected to the parent:

```text
http://127.0.0.1:18789/#token=<auth-token>
```

## Resuming After a Restart

Gateway port-forwards do not persist across reboots. To resume all sandboxes:

```console
$ nemoclaw cortana resume
$ nemoclaw jarvis resume
```

Each `resume` command restarts the gateway inside the sandbox (if it stopped) and re-establishes the port-forward on port `18789`.

## How Many Agents Can Share One GPU?

The default configuration sets `replicas: 4`, meaning up to 4 sandboxes can each request `nvidia.com/gpu: 1`.
To change the replica count, update the `nvidia-device-plugin-config` ConfigMap inside the gateway:

```console
$ docker exec -i openshell-cluster-nemoclaw kubectl edit configmap \
    nvidia-device-plugin-config -n nvidia-device-plugin
```

Change the `replicas` value and save. The device plugin picks up the change within a few seconds.

## Troubleshooting

**Agent doesn't appear in the Agents tab**
: The `openclaw.json` inside the parent sandbox was not updated. Re-run `nemoclaw add-gpu-agent` (it is idempotent via `sandbox-init`) or see the [GPU sandbox skill](./../../../.agents/skills/nemoclaw-gpu-sandbox/SKILL.md) for the manual patch command.

**Sandbox stuck in Provisioning**
: The GPU's physical memory is fully consumed. Either reduce workloads in running sandboxes or lower the replica count to prevent k8s from over-scheduling GPU requests beyond what the hardware can handle concurrently.

**`nvidia-smi` not found inside sandbox**
: The sandbox was not created from `nemoclaw-sandbox-ai` image. Re-run `post-onboard-gpu.sh` or `add-gpu-agent.sh` to recreate the sandbox with the CUDA image.
