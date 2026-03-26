// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

// ── Isolated temp home so tests never touch real ~/.nemoclaw or ~/.openclaw ──

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-init-test-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);

// ── Load modules after HOME is set ──────────────────────────────────────────

const registry = require("../bin/lib/registry");
const runner = require("../bin/lib/runner");
const policies = require("../bin/lib/policies");
const { sandboxInit } = require("../bin/lib/sandbox-init");

// ── Helpers ──────────────────────────────────────────────────────────────────

const openclawConfigPath = path.join(tmpDir, ".openclaw", "openclaw.json");
const registryFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");

function readOpenClawConfig() {
  return JSON.parse(fs.readFileSync(openclawConfigPath, "utf-8"));
}

/** Register a fake sandbox so sandboxInit passes the registry check. */
function registerFakeSandbox(name = "test-sandbox") {
  registry.registerSandbox({ name, model: "test-model", provider: "test-provider" });
}

/** Minimal options that skip all I/O (no uploads, no policy writes, no git). */
const SKIP_IO_OPTS = {
  skipGithub: true,
  nonInteractive: true,
};

// ── Save originals so we can restore after each test ────────────────────────

const _originalRun = runner.run;
const _originalRunCapture = runner.runCapture;
const _originalApplyPreset = policies.applyPreset;
const _originalGetAppliedPresets = policies.getAppliedPresets;

// ── Cleanup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Clear registry and openclaw config between tests.
  if (fs.existsSync(registryFile)) fs.unlinkSync(registryFile);
  const openclawDir = path.join(tmpDir, ".openclaw");
  if (fs.existsSync(openclawConfigPath)) fs.unlinkSync(openclawConfigPath);
  fs.mkdirSync(openclawDir, { recursive: true });

  // Stub out shell calls so no real openshell commands run.
  runner.run = vi.fn();
  runner.runCapture = vi.fn().mockReturnValue("");
  policies.applyPreset = vi.fn();
  policies.getAppliedPresets = vi.fn().mockReturnValue([]);
});

afterEach(() => {
  // Restore originals.
  runner.run = _originalRun;
  runner.runCapture = _originalRunCapture;
  policies.applyPreset = _originalApplyPreset;
  policies.getAppliedPresets = _originalGetAppliedPresets;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sandboxInit", () => {

  describe("sandbox validation", () => {
    it("exits with code 1 if sandbox is not in registry", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(
        sandboxInit("nonexistent-sandbox", SKIP_IO_OPTS)
      ).rejects.toThrow("process.exit(1)");

      exitSpy.mockRestore();
    });

    it("proceeds when sandbox exists in registry", async () => {
      registerFakeSandbox("my-sandbox");
      // Should not throw
      await expect(
        sandboxInit("my-sandbox", SKIP_IO_OPTS)
      ).resolves.toBeUndefined();
    });
  });

  describe("openclaw.json agent registration", () => {
    it("creates openclaw.json with agent entry on first run", async () => {
      registerFakeSandbox("my-sandbox");
      await sandboxInit("my-sandbox", SKIP_IO_OPTS);

      const config = readOpenClawConfig();
      expect(config.agents.list).toHaveLength(1);
      expect(config.agents.list[0].id).toBe("my-sandbox");
      expect(config.agents.list[0].name).toBe("my-sandbox");
    });

    it("uses --agent-name and --agent-id when provided", async () => {
      registerFakeSandbox("my-sandbox");
      await sandboxInit("my-sandbox", {
        ...SKIP_IO_OPTS,
        agentId: "robotics-lead",
        agentName: "Robotics Lead Engineer",
      });

      const config = readOpenClawConfig();
      const agent = config.agents.list.find((a) => a.id === "robotics-lead");
      expect(agent).toBeDefined();
      expect(agent.name).toBe("Robotics Lead Engineer");
    });

    it("is idempotent — re-running updates name without duplicating", async () => {
      registerFakeSandbox("my-sandbox");
      await sandboxInit("my-sandbox", { ...SKIP_IO_OPTS, agentName: "First Name" });
      await sandboxInit("my-sandbox", { ...SKIP_IO_OPTS, agentName: "Updated Name" });

      const config = readOpenClawConfig();
      const matching = config.agents.list.filter((a) => a.id === "my-sandbox");
      expect(matching).toHaveLength(1);
      expect(matching[0].name).toBe("Updated Name");
    });

    it("wires agent as subagent of parent when --parent-agent is given", async () => {
      // Register parent first
      registerFakeSandbox("cortana");
      await sandboxInit("cortana", SKIP_IO_OPTS);

      // Register child linked to parent
      registerFakeSandbox("robotics-team");
      await sandboxInit("robotics-team", {
        ...SKIP_IO_OPTS,
        parentAgentId: "cortana",
      });

      const config = readOpenClawConfig();
      const parent = config.agents.list.find((a) => a.id === "cortana");
      expect(parent.subagents.allowAgents).toContain("robotics-team");
    });

    it("wiring is idempotent — repeated runs don't duplicate subagent entry", async () => {
      registerFakeSandbox("cortana");
      await sandboxInit("cortana", SKIP_IO_OPTS);
      registerFakeSandbox("robotics-team");

      await sandboxInit("robotics-team", { ...SKIP_IO_OPTS, parentAgentId: "cortana" });
      await sandboxInit("robotics-team", { ...SKIP_IO_OPTS, parentAgentId: "cortana" });

      const config = readOpenClawConfig();
      const parent = config.agents.list.find((a) => a.id === "cortana");
      const occurrences = parent.subagents.allowAgents.filter((id) => id === "robotics-team");
      expect(occurrences).toHaveLength(1);
    });

    it("warns but does not crash if parent agent does not exist in config", async () => {
      registerFakeSandbox("orphan");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        sandboxInit("orphan", { ...SKIP_IO_OPTS, parentAgentId: "missing-parent" })
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("missing-parent")
      );
      warnSpy.mockRestore();
    });

    it("multiple sandboxes can be registered independently", async () => {
      for (const name of ["alpha", "beta", "gamma"]) {
        registerFakeSandbox(name);
        await sandboxInit(name, SKIP_IO_OPTS);
      }

      const config = readOpenClawConfig();
      const ids = config.agents.list.map((a) => a.id);
      expect(ids).toContain("alpha");
      expect(ids).toContain("beta");
      expect(ids).toContain("gamma");
    });
  });

  describe("policy application", () => {
    it("applies github policy by default", async () => {
      registerFakeSandbox("my-sandbox");
      await sandboxInit("my-sandbox", { ...SKIP_IO_OPTS, skipGithub: false, nonInteractive: true });

      expect(policies.applyPreset).toHaveBeenCalledWith("my-sandbox", "github");
    });

    it("skips github policy when --no-github is set", async () => {
      registerFakeSandbox("my-sandbox");
      await sandboxInit("my-sandbox", { ...SKIP_IO_OPTS, skipGithub: true });

      // @ts-ignore — policies.applyPreset is vi.fn() at runtime
      const calledWithGithub = policies.applyPreset.mock.calls.some(
        ([, preset]) => preset === "github"
      );
      expect(calledWithGithub).toBe(false);
    });

    it("applies extra --policy presets", async () => {
      registerFakeSandbox("my-sandbox");
      await sandboxInit("my-sandbox", {
        ...SKIP_IO_OPTS,
        extraPolicies: ["npm", "pypi"],
      });

      expect(policies.applyPreset).toHaveBeenCalledWith("my-sandbox", "npm");
      expect(policies.applyPreset).toHaveBeenCalledWith("my-sandbox", "pypi");
    });

    it("deduplicates repeated policy names", async () => {
      registerFakeSandbox("my-sandbox");
      await sandboxInit("my-sandbox", {
        skipGithub: true,
        nonInteractive: true,
        extraPolicies: ["npm", "npm", "pypi"],
      });

      // @ts-ignore — policies.applyPreset is vi.fn() at runtime
      const npmCalls = policies.applyPreset.mock.calls.filter(([, p]) => p === "npm");
      expect(npmCalls).toHaveLength(1);
    });
  });

  describe("workspace file resolution", () => {
    it("exits 1 if a supplied --soul file does not exist", async () => {
      registerFakeSandbox("my-sandbox");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(
        sandboxInit("my-sandbox", {
          ...SKIP_IO_OPTS,
          soulFile: "/nonexistent/soul.md",
        })
      ).rejects.toThrow("process.exit(1)");

      exitSpy.mockRestore();
    });

    it("reads content from a supplied --soul file on disk", async () => {
      registerFakeSandbox("my-sandbox");

      const tmpSoul = path.join(tmpDir, "custom-soul.md");
      fs.writeFileSync(tmpSoul, "# Custom Soul\nDo great things.\n");

      await sandboxInit("my-sandbox", {
        ...SKIP_IO_OPTS,
        soulFile: tmpSoul,
      });

      // runner.run should have been called for the upload; verify SOUL.md was written
      // @ts-ignore — runner.run is vi.fn() at runtime
      const uploadCall = runner.run.mock.calls.find(
        ([cmd]) => typeof cmd === "string" && cmd.includes("SOUL.md")
      );
      expect(uploadCall).toBeDefined();
    });
  });

});
