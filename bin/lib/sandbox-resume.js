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
        `bash -c 'HOME=/sandbox nohup openclaw gateway run > /tmp/gateway.log 2>&1 &'`,
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

  // 3. (Re-)establish port forward
  runner.run(`openshell forward stop ${DASHBOARD_PORT} ${qn} 2>/dev/null || true`, { ignoreError: true });
  runner.run(`openshell forward start --background ${DASHBOARD_PORT} ${qn} 2>/dev/null || true`, { ignoreError: true });

  // 4. Retrieve auth token
  const token = runner.runCapture(
    `openshell doctor exec -- kubectl exec ${sandboxName} -n openshell -- ` +
      `bash -c "HOME=/sandbox python3 -c \\"import json; cfg=json.load(open('/sandbox/.openclaw/openclaw.json')); print(cfg.get('gateway',{}).get('auth',{}).get('token',''))\\""`,
    { ignoreError: true },
  ) || null;

  return { token, gatewayStarted: true, error: null };
}

module.exports = { sandboxResume, DASHBOARD_PORT, _sleep };
