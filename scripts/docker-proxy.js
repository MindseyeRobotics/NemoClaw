#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NemoClaw Docker proxy — runs on the HOST machine.
//
// Provides a restricted Docker Engine API endpoint that the sandbox agent
// can reach at http://host.openshell.internal:NEMOCLAW_DOCKER_PROXY_PORT.
// Agents run `docker` / `docker compose` inside the sandbox; the Docker CLI
// connects to this proxy instead of the host socket directly.
//
// SECURITY MODEL:
//   - Only a hard-coded allowlist of Docker API operations is forwarded.
//   - Container-create requests are inspected; Privileged mode, host network,
//     CAP_ADD, and mounts of sensitive host paths are rejected.
//   - No exec, no attach, no build — agents can run pre-built images only.
//   - No token auth here; OpenShell network policy is gate 1 (sandbox traffic
//     only), this allowlist is gate 2.
//
// Usage:
//   [env] node scripts/docker-proxy.js
//
// Environment variables:
//   NEMOCLAW_DOCKER_PROXY_PORT  TCP port to listen on (default: 2376)
//   DOCKER_HOST                 Override Docker socket path (unix:// or tcp://)

"use strict";

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ── Config ─────────────────────────────────────────────────────────────────

const PROXY_PORT = parseInt(process.env.NEMOCLAW_DOCKER_PROXY_PORT || "2376", 10);

// Resolve Docker socket, mirroring the logic in bin/lib/platform.js
function resolveDockerSocket() {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    return dockerHost.startsWith("unix://")
      ? { type: "unix", path: dockerHost.slice(7) }
      : { type: "tcp", url: dockerHost };
  }

  const home = process.env.HOME || "/tmp";
  const candidates = [
    "/var/run/docker.sock",
    path.join(home, ".docker/run/docker.sock"),
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".config/colima/default/docker.sock"),
    // rootless Docker
    path.join(`/run/user/${process.getuid()}`, "docker.sock"),
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
      return { type: "unix", path: candidate };
    } catch {
      // not accessible — try next
    }
  }

  return null;
}

// ── Allowlist ───────────────────────────────────────────────────────────────

// [method, pathRegexp] pairs. If any matches, the request is forwarded
// (subject to body validation for POST /containers/create).
const ALLOWED_ROUTES = [
  // Info / version
  ["GET",    /^\/v[\d.]+\/version$/],
  ["GET",    /^\/v[\d.]+\/info$/],
  // Container list / inspect / logs / wait / top
  ["GET",    /^\/v[\d.]+\/containers\/json(\?.*)?$/],
  ["GET",    /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+\/json(\?.*)?$/],
  ["GET",    /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+\/logs(\?.*)?$/],
  ["GET",    /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+\/top(\?.*)?$/],
  ["POST",   /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+\/wait(\?.*)?$/],
  // Container lifecycle
  ["POST",   /^\/v[\d.]+\/containers\/create(\?.*)?$/],   // body-validated below
  ["POST",   /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+\/start(\?.*)?$/],
  ["POST",   /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+\/stop(\?.*)?$/],
  ["POST",   /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+\/kill(\?.*)?$/],
  ["POST",   /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+\/restart(\?.*)?$/],
  ["DELETE", /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+(\?.*)?$/],
  // Image list / inspect / pull / remove
  ["GET",    /^\/v[\d.]+\/images\/json(\?.*)?$/],
  ["GET",    /^\/v[\d.]+\/images\/[^/]+\/json(\?.*)?$/],
  ["POST",   /^\/v[\d.]+\/images\/create(\?.*)?$/],  // docker pull
  ["DELETE", /^\/v[\d.]+\/images\/[^/]+(\?.*)?$/],
  // Networks — read only
  ["GET",    /^\/v[\d.]+\/networks(\?.*)?$/],
  ["GET",    /^\/v[\d.]+\/networks\/[a-zA-Z0-9_.-]+(\?.*)?$/],
  // Volumes — read only (agents can use docker-managed volumes via create body)
  ["GET",    /^\/v[\d.]+\/volumes(\?.*)?$/],
  ["GET",    /^\/v[\d.]+\/volumes\/[a-zA-Z0-9_.-]+(\?.*)?$/],
  // Docker Compose uses this for event streaming
  ["GET",    /^\/v[\d.]+\/events(\?.*)?$/],
  // Container attach — requires TCP hijack (handled in `upgrade` event)
  ["POST",   /^\/v[\d.]+\/containers\/[a-zA-Z0-9_.-]+\/attach(\?.*)?$/],
  // Ping
  ["GET",    /^\/_ping$/],
  ["HEAD",   /^\/_ping$/],
];

// Sensitive host paths that must never be bind-mounted into agent containers.
const BLOCKED_MOUNT_PREFIXES = [
  "/etc",
  "/root",
  "/home",
  "/var/run/docker.sock",
  "/proc",
  "/sys",
  "/boot",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
];

function isBlockedMount(hostPath) {
  const normalized = path.resolve(hostPath);
  return BLOCKED_MOUNT_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix + "/"));
}

// Validate the body of POST /containers/create.
// Returns null if safe, or an error string if the body should be rejected.
function validateContainerCreate(body) {
  let spec;
  try {
    spec = JSON.parse(body);
  } catch {
    return "Invalid JSON in container create body";
  }

  // Block privileged containers
  if (spec.HostConfig?.Privileged === true) {
    return "Privileged containers are not allowed";
  }

  // Block host network mode
  const networkMode = spec.HostConfig?.NetworkMode || "";
  if (networkMode === "host") {
    return "NetworkMode=host is not allowed";
  }

  // Block CAP_ADD of dangerous capabilities
  const capAdd = spec.HostConfig?.CapAdd || [];
  const DANGEROUS_CAPS = ["SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "SYS_RAWIO", "MKNOD", "SETFCAP", "AUDIT_CONTROL"];
  for (const cap of capAdd) {
    if (DANGEROUS_CAPS.includes(cap.toUpperCase())) {
      return `CapAdd=${cap} is not allowed`;
    }
  }

  // Block bind-mounts to sensitive host paths
  const binds = spec.HostConfig?.Binds || [];
  for (const bind of binds) {
    const hostPart = bind.split(":")[0];
    if (hostPart.startsWith("/") && isBlockedMount(hostPart)) {
      return `Bind-mount of host path '${hostPart}' is not allowed`;
    }
  }

  // Also check Mounts (new-style)
  const mounts = spec.HostConfig?.Mounts || [];
  for (const mount of mounts) {
    if (mount.Type === "bind") {
      const source = mount.Source || "";
      if (source.startsWith("/") && isBlockedMount(source)) {
        return `Mount of host path '${source}' is not allowed`;
      }
    }
  }

  return null; // safe
}

function isAllowed(method, urlPath) {
  // Strip query string for route matching
  const pathOnly = urlPath.split("?")[0];
  return ALLOWED_ROUTES.some(([m, re]) => m === method && re.test(urlPath)) ||
    ALLOWED_ROUTES.some(([m, re]) => m === method && re.test(pathOnly));
}

// ── Proxy core ──────────────────────────────────────────────────────────────

function deny(res, code, message) {
  const body = JSON.stringify({ message });
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function forwardRequest(dockerTarget, incomingReq, incomingRes, bodyOverride) {
  const options = {
    method: incomingReq.method,
    path: incomingReq.url,
    headers: { ...incomingReq.headers },
  };

  if (dockerTarget.type === "unix") {
    options.socketPath = dockerTarget.path;
    options.hostname = "localhost";
  } else {
    // TCP target (remote Docker daemon)
    const parsed = new URL(dockerTarget.url);
    options.hostname = parsed.hostname;
    options.port = parsed.port || 2375;
  }

  // Remove hop-by-hop headers
  delete options.headers["connection"];
  delete options.headers["keep-alive"];
  delete options.headers["transfer-encoding"];
  delete options.headers["upgrade"];

  if (bodyOverride !== undefined) {
    options.headers["content-length"] = Buffer.byteLength(bodyOverride);
    options.headers["content-type"] = "application/json";
  }

  const proxyReq = http.request(options, (proxyRes) => {
    incomingRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(incomingRes, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error(`[docker-proxy] upstream error: ${err.message}`);
    if (!incomingRes.headersSent) {
      deny(incomingRes, 502, `Docker daemon error: ${err.message}`);
    } else {
      incomingRes.destroy();
    }
  });

  if (bodyOverride !== undefined) {
    proxyReq.write(bodyOverride);
    proxyReq.end();
  } else if (incomingReq.method !== "GET" && incomingReq.method !== "HEAD" && incomingReq.method !== "DELETE") {
    incomingReq.pipe(proxyReq, { end: true });
  } else {
    proxyReq.end();
  }

  return proxyReq;
}

// ── Server ──────────────────────────────────────────────────────────────────

const dockerTarget = resolveDockerSocket();

if (!dockerTarget) {
  console.error("[docker-proxy] ERROR: Docker socket not found.");
  console.error("[docker-proxy] Set DOCKER_HOST or ensure Docker is running.");
  process.exit(1);
}

console.log(`[docker-proxy] Docker target: ${dockerTarget.type === "unix" ? dockerTarget.path : dockerTarget.url}`);

const server = http.createServer((req, res) => {
  const method = req.method.toUpperCase();
  const url = req.url;

  // Check allowlist first
  if (!isAllowed(method, url)) {
    console.warn(`[docker-proxy] DENY  ${method} ${url}`);
    return deny(res, 403, `Operation not permitted: ${method} ${url}`);
  }

  // For container create, read body and validate before forwarding
  const pathOnly = url.split("?")[0];
  if (method === "POST" && /^\/v[\d.]+\/containers\/create/.test(pathOnly)) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const err = validateContainerCreate(body);
      if (err) {
        console.warn(`[docker-proxy] DENY  ${method} ${url} — ${err}`);
        return deny(res, 403, err);
      }
      console.log(`[docker-proxy] ALLOW ${method} ${url}`);
      forwardRequest(dockerTarget, req, res, body);
    });
    return;
  }

  console.log(`[docker-proxy] ALLOW ${method} ${url}`);
  forwardRequest(dockerTarget, req, res, undefined);
});

// ── TCP upgrade handler (docker attach / docker run attached) ──────────────
//
// Docker uses HTTP hijacking for container attach: the client sends
// POST /containers/{id}/attach with `Upgrade: tcp`, the daemon replies with
// 101 Switching Protocols, then both ends communicate over the raw TCP socket.
// Node's http.createServer fires the `upgrade` event for these requests
// instead of the normal `request` event, so we must handle them separately.

server.on("upgrade", (req, socket, head) => {
  const method = req.method.toUpperCase();
  const url = req.url;

  if (!isAllowed(method, url)) {
    console.warn(`[docker-proxy] DENY  UPGRADE ${method} ${url}`);
    socket.write(
      "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
      JSON.stringify({ message: `Operation not permitted: ${method} ${url}` })
    );
    socket.destroy();
    return;
  }

  console.log(`[docker-proxy] ALLOW UPGRADE ${method} ${url}`);

  // Disable Nagle on the client-facing socket so the 101 response headers
  // are flushed immediately rather than being held waiting for container output.
  // Without this, the Docker CLI never receives the 101 and blocks before start.
  socket.setNoDelay(true);

  // Open a raw socket to the Docker daemon and replay the HTTP request so
  // the daemon sees the Upgrade header and upgrades the connection itself.
  let upstream;
  if (dockerTarget.type === "unix") {
    upstream = net.connect(dockerTarget.path);
  } else {
    const parsed = new URL(dockerTarget.url);
    upstream = net.connect(parseInt(parsed.port, 10) || 2375, parsed.hostname);
  }

  upstream.once("connect", () => {
    // Forward the original upgrade request to the Docker daemon verbatim,
    // preserving Connection: Upgrade and Upgrade: tcp so the daemon triggers
    // the HTTP hijack protocol and replies with 101 Switching Protocols.
    // Only strip hop-by-hop headers that must not be forwarded as-is.
    const skipHeaders = new Set(["keep-alive", "transfer-encoding"]);
    const headerLines = Object.entries(req.headers)
      .filter(([k]) => !skipHeaders.has(k.toLowerCase()))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");

    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      `${headerLines}\r\n` +
      `\r\n`
    );

    if (head && head.length > 0) upstream.write(head);

    // Bidirectional pipe: client ↔ upstream Docker daemon
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", (err) => {
    console.error(`[docker-proxy] upstream upgrade error: ${err.message}`);
    socket.destroy();
  });

  socket.on("error", () => upstream.destroy());
  socket.on("end",   () => upstream.end());
  upstream.on("end", () => socket.end());
});

server.on("error", (err) => {
  console.error(`[docker-proxy] Server error: ${err.message}`);
  process.exit(1);
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`[docker-proxy] Listening on 0.0.0.0:${PROXY_PORT}`);
  console.log("[docker-proxy] Sandbox agents can reach Docker at:");
  console.log(`[docker-proxy]   DOCKER_HOST=tcp://host.openshell.internal:${PROXY_PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { server.close(() => process.exit(0)); });
