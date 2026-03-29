// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// `nemoclaw <name> resume` — ensure the openclaw gateway is running inside the
// sandbox, (re-)establish the port forward on 18789, and print the dashboard URL.
//
// The OpenShell sandbox runtime overrides the image ENTRYPOINT with its own
// supervisor, so the openclaw gateway is not automatically started on container
// creation. This command bridges that gap by checking whether the gateway is
// listening and starting it if needed.

const { spawnSync } = require("child_process");
const path = require("path");
const runner = require("./runner");

const DASHBOARD_PORT = 18789;
const POLL_INTERVAL_MS = 500;
const MAX_POLLS = 20;

/** @internal — exposed for testing; not part of public API */
function _sleep(ms) {
  spawnSync("sleep", [String(ms / 1000)]);
}

/**
 * Resume a sandbox: ensure the gateway is running, forward port 18789,
 * and print the dashboard URL with auth token.
 *
 * @param {string} sandboxName  - validated sandbox name
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] - suppress informational output
 * @param {Function} [opts._sleep] - sleep function override for testing
 * @returns {{ token: string|null, gatewayStarted: boolean, error: string|null }}
 */
function sandboxResume(sandboxName, opts = {}) {
  const qn = runner.shellQuote(sandboxName);
  const quiet = opts.quiet || false;

  // 1. Verify sandbox exists in openshell
  const sbListOut = runner.runCapture("openshell sandbox list 2>&1", { ignoreError: true });
  if (!sbListOut.includes(sandboxName)) {
    const msg = `Sandbox '${sandboxName}' not found in openshell.`;
    if (!quiet) {
      console.error(`  \u2717 ${msg}`);
      console.error("    Run 'openshell sandbox list' to see available sandboxes.");
    }
    return { token: null, gatewayStarted: false, error: msg };
  }

  // 2. Check if openclaw gateway is already listening inside the sandbox
  const ssOut = runner.runCapture(
    `openshell doctor exec -- kubectl exec ${sandboxName} -n openshell -- ss -tlnp 2>/dev/null`,
    { ignoreError: true },
  );
  let gatewayStarted = ssOut.includes(`:${DASHBOARD_PORT}`);

  if (gatewayStarted) {
    if (!quiet) console.log(`  \u2713 Gateway already running inside '${sandboxName}'`);
  } else {
    if (!quiet) console.log(`  \u25CF Starting openclaw gateway inside '${sandboxName}'...`);

    // Start the gateway as a background process inside the sandbox.
    // HOME=/sandbox ensures openclaw finds ~/.openclaw/openclaw.json.
    runner.run(
      `openshell doctor exec -- kubectl exec ${sandboxName} -n openshell -- ` +
        `bash -c 'HTTPS_PROXY=http://10.200.0.1:3128 NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_OPTIONS=--use-env-proxy HOME=/sandbox nohup openclaw gateway run > /tmp/gateway.log 2>&1 &'`,
      { ignoreError: true },
    );

    // Wait for gateway to become ready (up to 10 seconds)
    const sleepFn = opts._sleep || _sleep;
    for (let i = 0; i < MAX_POLLS; i++) {
      const check = runner.runCapture(
        `openshell doctor exec -- kubectl exec ${sandboxName} -n openshell -- ss -tlnp 2>/dev/null`,
        { ignoreError: true },
      );
      if (check.includes(`:${DASHBOARD_PORT}`)) {
        gatewayStarted = true;
        break;
      }
      sleepFn(POLL_INTERVAL_MS);
    }

    if (gatewayStarted) {
      if (!quiet) console.log("  \u2713 Gateway started");
    } else {
      const logOut = runner.runCapture(
        `openshell doctor exec -- kubectl exec ${sandboxName} -n openshell -- ` +
          `cat /tmp/gateway.log 2>/dev/null`,
        { ignoreError: true },
      );
      const firstLine = logOut ? logOut.split("\n")[0] : "";
      if (!quiet) {
        console.error("  \u2717 Gateway failed to start.");
        if (firstLine) console.error(`    Log: ${firstLine}`);
        console.error(
          `    Try: openshell doctor exec -- kubectl exec ${sandboxName} -n openshell -- cat /tmp/gateway.log`,
        );
      }
      return { token: null, gatewayStarted: false, error: firstLine || "gateway failed to start" };
    }
  }

  // 3. (Re-)establish port forward via gateway-relay (kubectl port-forward inside
  // the k3s container, relayed through a Python TCP proxy on localhost).
  // The openshell SSH forward only supports SFTP; it does not pass TCP channel data.
  const containerName = `openshell-cluster-${sandboxName}`;
  const relayScript = path.join(__dirname, "..", "..", "scripts", "gateway-relay.py");
  // Get docker network IP of the k3s container
  const containerIp = runner.runCapture(
    `docker inspect ${runner.shellQuote(containerName)} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null | head -1`,
    { ignoreError: true }
  ).trim();

  if (containerIp) {
    // Start kubectl port-forward inside the container (idempotent; fails silently if already running)
    runner.run(
      `docker exec -d ${runner.shellQuote(containerName)} kubectl port-forward pod/${runner.shellQuote(sandboxName)} ${DASHBOARD_PORT}:${DASHBOARD_PORT} -n openshell --address 0.0.0.0 2>/dev/null || true`,
      { ignoreError: true }
    );
    // Kill any existing relay on this port then start fresh
    runner.run(
      `python3 -c "import socket; s=socket.socket(); s.settimeout(0.1); s.connect(('127.0.0.1',${DASHBOARD_PORT})); s.close()" 2>/dev/null && ` +
      `pkill -f "gateway-relay.py ${DASHBOARD_PORT}" 2>/dev/null || true`,
      { ignoreError: true }
    );
    runner.run(
      `nohup python3 ${runner.shellQuote(relayScript)} ${DASHBOARD_PORT} ${runner.shellQuote(containerIp)} ${DASHBOARD_PORT} >/tmp/gateway-relay.log 2>&1 &`,
      { ignoreError: true }
    );
  } else {
    // Fallback: try the openshell SSH forward (may not work for WS but worth attempting)
    runner.run(`openshell forward stop ${DASHBOARD_PORT} ${qn} 2>/dev/null || true`, { ignoreError: true });
    runner.run(`openshell forward start --background ${DASHBOARD_PORT} ${qn} 2>/dev/null || true`, { ignoreError: true });
  }

  // 4. Retrieve auth token
  const token = runner.runCapture(
    `openshell doctor exec -- kubectl exec ${sandboxName} -n openshell -- ` +
      `bash -c "HOME=/sandbox python3 -c \\"import json; cfg=json.load(open('/sandbox/.openclaw/openclaw.json')); print(cfg.get('gateway',{}).get('auth',{}).get('token',''))\\""`,
    { ignoreError: true },
  ) || null;

  return { token, gatewayStarted: true, error: null };
}

module.exports = { sandboxResume, DASHBOARD_PORT, _sleep };
