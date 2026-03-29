// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// `nemoclaw add-gpu-agent` — create a GPU-enabled agent sandbox and register it
// in the parent agent's openclaw dashboard.
//
// Prerequisites:
//   • A NemoClaw gateway running with GPU support  (via post-onboard-gpu.sh)
//   • The GPU image built and imported into k3s    (post-onboard-gpu.sh does this)
//   • A parent agent sandbox already running       (default: defaultSandbox)
//
// Usage:
//   nemoclaw add-gpu-agent <agent-name> [--parent <parent-name>]

"use strict";

const { spawnSync } = require("child_process");

const runner = require("./runner");
const registry = require("./registry");

const IMAGE_NAME = "nemoclaw-sandbox-ai";
const IMAGE_TAG  = "v3";
const IMAGE_REF  = `${IMAGE_NAME}:${IMAGE_TAG}`;

const DASHBOARD_PORT    = 18789;
const MAX_READY_WAIT_S  = 60;
const MAX_GATEWAY_WAIT_S = 30;
const TIME_SLICE_REPLICAS = 4;

/** @internal — exposed for testing */
function _sleep(ms) {
  spawnSync("sleep", [String(ms / 1000)]);
}

/**
 * Create a GPU-enabled agent sandbox and register it under the parent.
 *
 * @param {string}   agentName          - Name for the new GPU agent sandbox
 * @param {object}   [opts]
 * @param {string}   [opts.parentName]  - Parent sandbox (default: defaultSandbox)
 * @param {boolean}  [opts.quiet]       - Suppress informational output
 * @param {Function} [opts._sleep]      - Sleep override for testing
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
async function addGpuAgent(agentName, opts = {}) {
  const quiet   = opts.quiet || false;
  const sleepFn = opts._sleep || _sleep;
  const model   = opts.model || null;

  // ── Resolve parent ──────────────────────────────────────────────────────
  let parentName = opts.parentName || "";
  if (!parentName) {
    const { defaultSandbox } = registry.listSandboxes();
    if (!defaultSandbox) {
      return _fail(quiet, "No --parent given and no defaultSandbox registered.\n" +
        "    Run 'nemoclaw sandbox-init <name>' first or pass --parent <name>.");
    }
    parentName = defaultSandbox;
  }

  if (agentName === parentName) {
    return _fail(quiet, `Agent name cannot be the same as parent ('${parentName}')`);
  }

  // ── Resolve gateway ─────────────────────────────────────────────────────
  const gatewayOut  = runner.runCapture("openshell gateway info 2>&1", { ignoreError: true });
  const gwMatch     = gatewayOut.match(/Gateway:\s+(\S+)/);
  const gatewayName = gwMatch ? gwMatch[1] : "nemoclaw";
  const gatewayCtr  = `openshell-cluster-${gatewayName}`;

  // ── Preflight ───────────────────────────────────────────────────────────
  const dockerPs = runner.runCapture("docker ps --format '{{.Names}}'", { ignoreError: true });
  if (!dockerPs.includes(gatewayCtr)) {
    return _fail(quiet, `Gateway container '${gatewayCtr}' is not running.\n` +
      "    Start NemoClaw with 'nemoclaw start' first.");
  }

  const sandboxList = runner.runCapture("openshell sandbox list 2>/dev/null", { ignoreError: true });
  if (!sandboxList.match(new RegExp(`${_escRe(parentName)}.*Ready`))) {
    return _fail(quiet, `Parent sandbox '${parentName}' is not in Ready state.\n` +
      `    Check status: nemoclaw ${parentName} status`);
  }

  if (sandboxList.match(new RegExp(`^${_escRe(agentName)}\\s`, "m"))) {
    return _fail(quiet, `Sandbox '${agentName}' already exists.\n` +
      `    Delete it first: openshell sandbox delete ${agentName}`);
  }

  // ── [1/5] GPU time-slicing ──────────────────────────────────────────────
  if (!quiet) console.log("  \u25B8 [1/5] Checking GPU time-slicing...");
  const gpuAlloc = _parseInt(
    runner.runCapture(
      `docker exec "${gatewayCtr}" kubectl get nodes ` +
      `-o jsonpath='{.items[0].status.allocatable.nvidia\\.com/gpu}' 2>/dev/null`,
      { ignoreError: true },
    ),
  );

  if (gpuAlloc <= 1) {
    if (!quiet) console.log(`  \u25B8 Only ${gpuAlloc} GPU(s) allocatable — enabling time-slicing (${TIME_SLICE_REPLICAS} replicas)...`);
    _applyTimeSlicingConfigMap(gatewayCtr);
    _patchDevicePluginDaemonSet(gatewayCtr, sleepFn);
    _waitForGpuSlices(gatewayCtr, quiet, sleepFn);
  } else {
    if (!quiet) console.log(`  \u2713 GPU allocation OK: ${gpuAlloc} GPU(s) available`);
  }

  // ── [2/5] GPU image in k3s ───────────────────────────────────────────────
  if (!quiet) console.log(`  \u25B8 [2/5] Checking GPU image '${IMAGE_REF}'...`);
  const imageCount = _parseInt(
    runner.runCapture(
      `docker exec "${gatewayCtr}" ` +
      `ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images ls -q 2>/dev/null ` +
      `| grep -c "docker.io/library/${IMAGE_REF}"`,
      { ignoreError: true },
    ),
  );

  if (imageCount === 0) {
    if (!quiet) console.log(`  \u25B8 Importing '${IMAGE_REF}' into k3s containerd...`);
    runner.run(
      `docker save "${IMAGE_REF}" | ` +
      `docker exec -i "${gatewayCtr}" ` +
      `ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import - 2>&1 | grep -v "^$" || true`,
      { ignoreError: true },
    );
    if (!quiet) console.log("  \u2713 Image imported");
  } else {
    if (!quiet) console.log(`  \u2713 Image '${IMAGE_REF}' already in k3s`);
  }

  // ── [3/5] Create sandbox ─────────────────────────────────────────────────
  if (!quiet) console.log(`  \u25B8 [3/5] Creating GPU sandbox '${agentName}'...`);
  runner.run(
    `openshell sandbox create --name ${runner.shellQuote(agentName)} ` +
    `--from ${IMAGE_REF} --gpu 2>&1 | grep -v "^$" || true`,
    { ignoreError: true },
  );

  // Wait for Ready
  let ready = false;
  for (let i = 0; i < MAX_READY_WAIT_S; i++) {
    const list = runner.runCapture("openshell sandbox list 2>/dev/null", { ignoreError: true });
    if (list.match(new RegExp(`${_escRe(agentName)}.*Ready`))) {
      ready = true;
      break;
    }
    sleepFn(1000);
  }
  if (!ready) {
    return _fail(quiet,
      `Sandbox '${agentName}' did not reach Ready state within ${MAX_READY_WAIT_S}s.\n` +
      `    Check: openshell sandbox list`,
    );
  }
  if (!quiet) console.log(`  \u2713 Sandbox '${agentName}' is Ready`);

  // ── [4/5] Start gateway inside sandbox ──────────────────────────────────
  if (!quiet) console.log("  \u25B8 [4/5] Starting openclaw gateway inside sandbox...");
  const sshProxy = `$HOME/.local/bin/openshell ssh-proxy --gateway-name ${runner.shellQuote(gatewayName)} --name ${runner.shellQuote(agentName)}`;
  const sshBase  = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ` +
                   `-o "ProxyCommand=${sshProxy}" sandbox@openshell-${agentName}`;

  // Fix .openclaw permissions (root-owned from Dockerfile) and start gateway
  runner.run(
    `${sshBase} "chmod 755 /sandbox/.openclaw 2>/dev/null; ` +
    `chmod 755 /sandbox/.openclaw/logs 2>/dev/null; ` +
    `chown sandbox:sandbox /sandbox/.openclaw/logs 2>/dev/null; ` +
    `HTTPS_PROXY=http://10.200.0.1:3128 NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_OPTIONS=--use-env-proxy HOME=/sandbox nohup openclaw gateway run > /sandbox/gateway.log 2>&1 &"`,
    { ignoreError: true },
  );

  let gatewayUp = false;
  for (let i = 0; i < MAX_GATEWAY_WAIT_S; i++) {
    const up = _parseInt(
      runner.runCapture(
        `${sshBase} "ss -tlnp 2>/dev/null | grep -c ':${DASHBOARD_PORT}'" 2>/dev/null`,
        { ignoreError: true },
      ),
    );
    if (up > 0) { gatewayUp = true; break; }
    sleepFn(1000);
  }

  if (gatewayUp) {
    if (!quiet) console.log("  \u2713 Gateway listening on port " + DASHBOARD_PORT);
  } else {
    if (!quiet) console.log(
      `  \u26A0 Gateway may not be ready yet — check:\n` +
      `    ${sshBase} "cat /sandbox/gateway.log"`,
    );
  }

  // ── [5/5] Register agent via sandbox-init ────────────────────────────────
  if (!quiet) console.log("  \u25B8 [5/5] Registering agent under parent dashboard...");
  const { sandboxInit } = require("./sandbox-init");
  try {
    await sandboxInit(agentName, {
      agentName,
      agentId:        agentName,
      parentAgent:    parentName,
      nonInteractive: true,
      skipGithub:     false,
      model,
    });
  } catch (_e) {
    // sandbox-init errors don't fail the GPU agent creation
    if (!quiet) console.log(`  \u26A0 sandbox-init warning: ${_e.message}`);
  }

  if (!quiet) {
    console.log("");
    console.log(`  \u2713 GPU agent '${agentName}' created and registered under '${parentName}'`);
    console.log(`    Connect: nemoclaw ${agentName} connect`);
  }

  return { success: true, error: null };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _fail(quiet, msg) {
  if (!quiet) console.error(`  \u2717 ${msg}`);
  return { success: false, error: msg };
}

function _parseInt(str) {
  const n = parseInt(str || "0", 10);
  return isNaN(n) ? 0 : n;
}

/** Escape string for use in a RegExp */
function _escRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _applyTimeSlicingConfigMap(gatewayCtr) {
  const configYaml = [
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata:",
    "  name: nvidia-device-plugin-config",
    "  namespace: nvidia-device-plugin",
    "data:",
    "  config.yaml: |",
    "    version: v1",
    "    sharing:",
    "      timeSlicing:",
    "        renameByDefault: false",
    "        resources:",
    "          - name: nvidia.com/gpu",
    `            replicas: ${TIME_SLICE_REPLICAS}`,
  ].join("\\n");

  runner.run(
    `printf '${configYaml}\\n' | docker exec -i "${gatewayCtr}" kubectl apply -f -`,
    { ignoreError: true },
  );
}

function _patchDevicePluginDaemonSet(gatewayCtr, sleepFn) {
  const currentArgs = runner.runCapture(
    `docker exec "${gatewayCtr}" kubectl get ds nvidia-device-plugin ` +
    `-n nvidia-device-plugin ` +
    `-o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null`,
    { ignoreError: true },
  );

  if (currentArgs.includes("--config-file")) return; // already patched

  const patch = JSON.stringify([
    { op: "add", path: "/spec/template/spec/volumes/-", value: { name: "device-plugin-config", configMap: { name: "nvidia-device-plugin-config" } } },
    { op: "add", path: "/spec/template/spec/containers/0/volumeMounts/-", value: { name: "device-plugin-config", mountPath: "/etc/nvidia/device-plugin" } },
    { op: "replace", path: "/spec/template/spec/containers/0/args", value: ["--config-file=/etc/nvidia/device-plugin/config.yaml"] },
  ]);

  runner.run(
    `docker exec -i "${gatewayCtr}" kubectl patch ds nvidia-device-plugin ` +
    `-n nvidia-device-plugin --type=json -p ${runner.shellQuote(patch)} 2>&1 | tail -1`,
    { ignoreError: true },
  );

  sleepFn(8000); // wait for pod restart
}

function _waitForGpuSlices(gatewayCtr, quiet, sleepFn) {
  for (let i = 0; i < 20; i++) {
    const n = _parseInt(
      runner.runCapture(
        `docker exec "${gatewayCtr}" kubectl get nodes ` +
        `-o jsonpath='{.items[0].status.allocatable.nvidia\\.com/gpu}' 2>/dev/null`,
        { ignoreError: true },
      ),
    );
    if (n > 1) {
      if (!quiet) console.log(`  \u2713 GPU time-slicing active: ${n} virtual GPUs available`);
      return;
    }
    if (i === 19 && !quiet) console.log("  \u26A0 GPU time-slicing may not have taken effect yet");
    sleepFn(2000);
  }
}

module.exports = { addGpuAgent, IMAGE_REF, DASHBOARD_PORT, _sleep };
