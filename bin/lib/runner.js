// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const { detectDockerHost } = require("./platform");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");

const dockerHost = detectDockerHost();
if (dockerHost) {
  process.env.DOCKER_HOST = dockerHost.dockerHost;
}

function run(cmd, opts = {}) {
  const stdio = opts.stdio ?? ["ignore", "inherit", "inherit"];
  const result = spawnSync("bash", ["-c", cmd], {
    ...opts,
    stdio,
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${cmd.slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

function runInteractive(cmd, opts = {}) {
  const stdio = opts.stdio ?? "inherit";
  const result = spawnSync("bash", ["-c", cmd], {
    ...opts,
    stdio,
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): ${cmd.slice(0, 80)}`);
    process.exit(result.status || 1);
  }
  return result;
}

function runCapture(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      ...opts,
      encoding: "utf-8",
      cwd: ROOT,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

/**
 * Shell-quote a value for safe interpolation into bash -c strings.
 * Wraps in single quotes and escapes embedded single quotes.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate a name (sandbox, instance, container) against RFC 1123 label rules.
 * Rejects shell metacharacters, path traversal, and empty/overlength names.
 */
function validateName(name, label = "name") {
  if (!name || typeof name !== "string") {
    throw new Error(`${label} is required`);
  }
  if (name.length > 63) {
    throw new Error(`${label} too long (max 63 chars): '${name.slice(0, 20)}...'`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error(
      `Invalid ${label}: '${name}'. Must be lowercase alphanumeric with optional internal hyphens.`
    );
  }
  return name;
}

/**
 * Read the gateway auth token from a sandbox's openclaw.json.
 * Returns the token string, or "" if it cannot be read.
 */
function readSandboxToken(sandboxName) {
  const tmpDir = require("os").tmpdir();
  const destDir = path.join(tmpDir, `nemoclaw-token-${Date.now()}`);
  try {
    require("fs").mkdirSync(destDir, { recursive: true });
    execSync(
      `openshell sandbox download ${shellQuote(sandboxName)} /sandbox/.openclaw/openclaw.json ${shellQuote(destDir)}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd: ROOT, timeout: 15000 }
    );
    const configPath = path.join(destDir, "openclaw.json");
    const cfg = JSON.parse(require("fs").readFileSync(configPath, "utf-8"));
    const token = (cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token) || "";
    return /^[0-9a-f]{64}$/.test(token) ? token : "";
  } catch {
    return "";
  } finally {
    try { require("fs").rmSync(destDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Build the full dashboard URL with auth token for a sandbox.
 * Returns the URL string, or the bare URL if the token cannot be read.
 */
function getDashboardUrl(sandboxName, port = 18789) {
  const token = readSandboxToken(sandboxName);
  const base = `http://127.0.0.1:${port}/`;
  return token ? `${base}#token=${token}` : base;
}

module.exports = { ROOT, SCRIPTS, run, runCapture, runInteractive, shellQuote, validateName, readSandboxToken, getDashboardUrl };
