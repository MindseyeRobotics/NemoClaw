// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Isolated temp home so tests never touch real ~/.nemoclaw ──────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-add-gpu-agent-test-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);

const runner   = require("../bin/lib/runner");
const registry = require("../bin/lib/registry");
const { addGpuAgent, IMAGE_REF, DASHBOARD_PORT } = require("../bin/lib/sandbox-add-gpu-agent");

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOOP_SLEEP = () => {};
const quietOpts  = { quiet: true, _sleep: NOOP_SLEEP };

function makeSandboxRow(name, phase = "Ready") {
  return `${name}  openshell  2026-03-26 05:00:00  ${phase}`;
}

/** Build a runCapture mock that returns sensible defaults for all known calls. */
function makeDefaultCaptureMock(overrides = {}) {
  return vi.fn().mockImplementation((cmd) => {
    if (overrides[cmd] !== undefined) return overrides[cmd];
    // Gateway info
    if (cmd.includes("gateway info"))           return "Gateway: nemoclaw\nStatus: running";
    // Docker ps — gateway container is running
    if (cmd.includes("docker ps"))              return "openshell-cluster-nemoclaw\nsome-other";
    // openshell sandbox list
    if (cmd.includes("sandbox list")) {
      return [makeSandboxRow("cortana"), makeSandboxRow("jarvis")].join("\n");
    }
    // GPU count
    if (cmd.includes("kubectl get nodes"))      return "4";
    // Image already in k3s
    if (cmd.includes("images ls"))             return "1";
    // Gateway up check (ss)
    if (cmd.includes("ss -tlnp"))              return `:${DASHBOARD_PORT}`;
    return "";
  });
}

// ── Save originals ────────────────────────────────────────────────────────────

const _originalRun        = runner.run;
const _originalRunCapture = runner.runCapture;

beforeEach(() => {
  // Reset registry between tests
  const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");
  if (fs.existsSync(regFile)) fs.unlinkSync(regFile);

  runner.run        = vi.fn();
  runner.runCapture = makeDefaultCaptureMock();
});

afterEach(() => {
  runner.run        = _originalRun;
  runner.runCapture = _originalRunCapture;
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("addGpuAgent", () => {

  // ── Argument validation ────────────────────────────────────────────────────

  describe("argument validation", () => {
    it("fails when no parentName and no defaultSandbox registered", async () => {
      // Registry is empty (no defaultSandbox)
      const result = await addGpuAgent("jarvis", quietOpts);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/defaultSandbox/i);
    });

    it("fails when agent name equals parent name", async () => {
      registry.registerSandbox({ name: "cortana", model: "m", provider: "p" });
      const result = await addGpuAgent("cortana", { ...quietOpts, parentName: "cortana" });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/same as parent/i);
    });
  });

  // ── Preflight checks ───────────────────────────────────────────────────────

  describe("preflight checks", () => {
    it("fails when gateway container is not running", async () => {
      runner.runCapture = makeDefaultCaptureMock({
        "docker ps --format '{{.Names}}'": "some-unrelated-container",
      });

      const result = await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not running/i);
    });

    it("fails when parent sandbox is not in Ready state", async () => {
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info")) return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))    return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list")) return makeSandboxRow("cortana", "Starting");
        return "";
      });

      const result = await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not in Ready state/i);
    });

    it("fails when the new agent sandbox already exists", async () => {
      runner.runCapture = makeDefaultCaptureMock({
        // sandbox list shows both cortana (parent) AND jarvis (agent-to-create) already there
        "openshell sandbox list 2>/dev/null": [
          makeSandboxRow("cortana"),
          makeSandboxRow("jarvis"),
        ].join("\n"),
      });

      const result = await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already exists/i);
    });
  });

  // ── GPU time-slicing ───────────────────────────────────────────────────────

  describe("GPU time-slicing", () => {
    it("skips time-slicing when GPU count is already > 1", async () => {
      // Default mock returns "4" for kubectl get nodes
      runner.runCapture = makeDefaultCaptureMock();
      // Sandbox list: cortana ready, jarvis NOT in list yet (so we can create it)
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))  return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))     return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list"))  return makeSandboxRow("cortana");
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))    return "1";
        if (cmd.includes("ss -tlnp"))     return `:${DASHBOARD_PORT}`;
        return "";
      });

      await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      // kubectl apply (ConfigMap) should NOT have been called
      // @ts-ignore
      const applyCalls = runner.run.mock.calls.map(([c]) => c).filter((c) => c.includes("kubectl apply"));
      expect(applyCalls).toHaveLength(0);
    });

    it("applies time-slicing ConfigMap and patches DaemonSet when GPU count is <= 1", async () => {
      let nodeCallCount = 0;
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))  return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))     return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list"))  return makeSandboxRow("cortana");
        if (cmd.includes("kubectl get nodes")) {
          nodeCallCount++;
          // First call (initial check): 1 GPU. Subsequent calls (wait loop): 4.
          return nodeCallCount === 1 ? "1" : "4";
        }
        if (cmd.includes("containers[0].args")) return ""; // not yet patched
        if (cmd.includes("images ls"))    return "1";
        if (cmd.includes("ss -tlnp"))     return `:${DASHBOARD_PORT}`;
        return "";
      });

      await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      // @ts-ignore
      const runCalls = runner.run.mock.calls.map(([c]) => c);
      const hasApply = runCalls.some((c) => c.includes("kubectl apply"));
      const hasPatch = runCalls.some((c) => c.includes("kubectl patch"));
      expect(hasApply).toBe(true);
      expect(hasPatch).toBe(true);
    });

    it("does not re-patch DaemonSet when --config-file is already present", async () => {
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))         return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list"))      return makeSandboxRow("cortana");
        if (cmd.includes("kubectl get nodes")) return "1"; // triggers time-slicing path
        if (cmd.includes("containers[0].args")) return '["--config-file=/etc/nvidia/device-plugin/config.yaml"]';
        if (cmd.includes("images ls"))        return "1";
        if (cmd.includes("ss -tlnp"))         return `:${DASHBOARD_PORT}`;
        return "";
      });

      await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      // @ts-ignore
      const runCalls = runner.run.mock.calls.map(([c]) => c);
      const patchCalls = runCalls.filter((c) => c.includes("kubectl patch"));
      expect(patchCalls).toHaveLength(0);
    });
  });

  // ── Image import ───────────────────────────────────────────────────────────

  describe("GPU image", () => {
    it("imports image when not found in k3s", async () => {
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))         return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list"))      return makeSandboxRow("cortana");
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))        return "0"; // not in k3s
        if (cmd.includes("ss -tlnp"))         return `:${DASHBOARD_PORT}`;
        return "";
      });

      await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      // @ts-ignore
      const runCalls = runner.run.mock.calls.map(([c]) => c);
      const importCall = runCalls.find((c) => c.includes("docker save") && c.includes("images import"));
      expect(importCall).toBeTruthy();
      expect(importCall).toContain(IMAGE_REF);
    });

    it("skips import when image is already in k3s", async () => {
      runner.runCapture = makeDefaultCaptureMock(); // returns "1" for images ls

      // Sandbox list: only cortana (so jarvis does not yet exist)
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))         return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list"))      return makeSandboxRow("cortana");
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))        return "1";
        if (cmd.includes("ss -tlnp"))         return `:${DASHBOARD_PORT}`;
        return "";
      });

      await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      // @ts-ignore
      const runCalls = runner.run.mock.calls.map(([c]) => c);
      const importCalls = runCalls.filter((c) => c.includes("images import"));
      expect(importCalls).toHaveLength(0);
    });
  });

  // ── Sandbox lifecycle ──────────────────────────────────────────────────────

  describe("sandbox creation", () => {
    it("creates sandbox with --gpu flag and correct image", async () => {
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))         return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list"))      return makeSandboxRow("cortana");
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))        return "1";
        if (cmd.includes("ss -tlnp"))         return `:${DASHBOARD_PORT}`;
        return "";
      });

      await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      // @ts-ignore
      const runCalls = runner.run.mock.calls.map(([c]) => c);
      const createCall = runCalls.find((c) => c.includes("sandbox create"));
      expect(createCall).toBeTruthy();
      expect(createCall).toContain("--gpu");
      expect(createCall).toContain(IMAGE_REF);
      expect(createCall).toContain("jarvis");
    });

    it("returns error when sandbox never reaches Ready state", async () => {
      let sandboxListCallCount = 0;
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))         return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list")) {
          sandboxListCallCount++;
          // First call (parent check): cortana ready; subsequent calls (wait): never ready
          if (sandboxListCallCount === 1) return makeSandboxRow("cortana");
          return makeSandboxRow("cortana"); // jarvis never appears as Ready
        }
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))        return "1";
        return "";
      });

      const result = await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/did not reach Ready/i);
    });
  });

  // ── Gateway startup ────────────────────────────────────────────────────────

  describe("gateway startup", () => {
    it("starts gateway via SSH inside the new sandbox", async () => {
      let sbListCount = 0;
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))         return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list")) {
          sbListCount++;
          if (sbListCount === 1) return makeSandboxRow("cortana");
          return makeSandboxRow("cortana") + "\n" + makeSandboxRow("jarvis");
        }
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))        return "1";
        if (cmd.includes("ss -tlnp"))         return `:${DASHBOARD_PORT}`;
        return "";
      });

      await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      // @ts-ignore
      const runCalls = runner.run.mock.calls.map(([c]) => c);
      const gatewayStart = runCalls.find((c) => c.includes("openclaw gateway run"));
      expect(gatewayStart).toBeTruthy();
      expect(gatewayStart).toContain("HOME=/sandbox");
      expect(gatewayStart).toContain("jarvis");
    });
  });

  // ── Resolving gateway name ─────────────────────────────────────────────────

  describe("gateway name resolution", () => {
    it("uses gateway name from 'openshell gateway info' output", async () => {
      let sbListCount = 0;
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return "Gateway: mygateway\nStatus: running";
        if (cmd.includes("docker ps"))         return "openshell-cluster-mygateway";
        if (cmd.includes("sandbox list")) {
          sbListCount++;
          if (sbListCount === 1) return makeSandboxRow("cortana");
          return makeSandboxRow("cortana") + "\n" + makeSandboxRow("jarvis");
        }
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))        return "1";
        if (cmd.includes("ss -tlnp"))         return `:${DASHBOARD_PORT}`;
        return "";
      });

      const result = await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      // Gateway container check used "mygateway" — if result is success, the test passed
      expect(result.success).toBe(true);
    });

    it("falls back to 'nemoclaw' gateway name when info command gives no match", async () => {
      let sbListCount = 0;
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return ""; // no match
        if (cmd.includes("docker ps"))         return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list")) {
          sbListCount++;
          if (sbListCount === 1) return makeSandboxRow("cortana");
          return makeSandboxRow("cortana") + "\n" + makeSandboxRow("jarvis");
        }
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))        return "1";
        if (cmd.includes("ss -tlnp"))         return `:${DASHBOARD_PORT}`;
        return "";
      });

      const result = await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });
      expect(result.success).toBe(true);
    });
  });

  // ── Using defaultSandbox from registry ────────────────────────────────────

  describe("parent resolved from registry", () => {
    it("uses defaultSandbox when --parent is not specified", async () => {
      registry.registerSandbox({ name: "cortana", model: "m", provider: "p" });
      // Make cortana the default
      const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");
      const reg = JSON.parse(fs.readFileSync(regFile, "utf-8"));
      reg.defaultSandbox = "cortana";
      fs.writeFileSync(regFile, JSON.stringify(reg));

      let sbListCount2 = 0;
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))         return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list")) {
          sbListCount2++;
          if (sbListCount2 === 1) return makeSandboxRow("cortana");
          return makeSandboxRow("cortana") + "\n" + makeSandboxRow("jarvis");
        }
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))        return "1";
        if (cmd.includes("ss -tlnp"))         return `:${DASHBOARD_PORT}`;
        return "";
      });

      const result = await addGpuAgent("jarvis", { quiet: true, _sleep: NOOP_SLEEP });
      expect(result.success).toBe(true);
    });
  });

  // ── Constants ─────────────────────────────────────────────────────────────

  describe("exported constants", () => {
    it("IMAGE_REF is nemoclaw-sandbox-ai:v3", () => {
      expect(IMAGE_REF).toBe("nemoclaw-sandbox-ai:v3");
    });

    it("DASHBOARD_PORT is 18789", () => {
      expect(DASHBOARD_PORT).toBe(18789);
    });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("successful creation", () => {
    it("returns success:true on a complete happy-path flow", async () => {
      let sbListCount = 0;
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("gateway info"))      return "Gateway: nemoclaw";
        if (cmd.includes("docker ps"))         return "openshell-cluster-nemoclaw";
        if (cmd.includes("sandbox list")) {
          sbListCount++;
          if (sbListCount === 1) return makeSandboxRow("cortana");
          return makeSandboxRow("cortana") + "\n" + makeSandboxRow("jarvis");
        }
        if (cmd.includes("kubectl get nodes")) return "4";
        if (cmd.includes("images ls"))        return "1";
        if (cmd.includes("ss -tlnp"))         return `:${DASHBOARD_PORT}`;
        return "";
      });

      const result = await addGpuAgent("jarvis", { ...quietOpts, parentName: "cortana" });

      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
    });
  });
});
