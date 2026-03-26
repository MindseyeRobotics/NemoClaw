// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const runner = require("../bin/lib/runner");
const { sandboxResume, DASHBOARD_PORT } = require("../bin/lib/sandbox-resume");

/** No-op sleep so tests don't actually wait */
const NOOP_SLEEP = () => {};
const quietOpts = { quiet: true, _sleep: NOOP_SLEEP };

// ── Save originals ──────────────────────────────────────────────────────────

const _originalRun = runner.run;
const _originalRunCapture = runner.runCapture;

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  runner.run = vi.fn();
  runner.runCapture = vi.fn().mockReturnValue("");
});

afterEach(() => {
  runner.run = _originalRun;
  runner.runCapture = _originalRunCapture;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sandboxResume", () => {
  describe("sandbox not found", () => {
    it("returns error when sandbox is not in openshell list", () => {
      runner.runCapture = vi.fn().mockReturnValue("No sandboxes found.");

      const result = sandboxResume("ghost", quietOpts);

      expect(result.error).toBeTruthy();
      expect(result.gatewayStarted).toBe(false);
      expect(result.token).toBeNull();
    });
  });

  describe("gateway already running", () => {
    it("skips startup and returns token when gateway is listening on 18789", () => {
      // @ts-ignore — vi.fn() mock
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("sandbox list")) {
          return "NAME     NAMESPACE  CREATED              PHASE\ncortana  openshell  2026-03-26 05:11:42  Ready";
        }
        if (cmd.includes("ss -tlnp")) {
          return `LISTEN 0 511 127.0.0.1:${DASHBOARD_PORT} 0.0.0.0:* users:(("openclaw-gatewa",pid=229,fd=22))`;
        }
        if (cmd.includes("python3")) {
          return "abc123tokenvalue";
        }
        return "";
      });

      const result = sandboxResume("cortana", quietOpts);

      expect(result.gatewayStarted).toBe(true);
      expect(result.token).toBe("abc123tokenvalue");
      expect(result.error).toBeNull();

      // Should NOT have started a new gateway process
      // @ts-ignore — vi.fn() mock
      const runCalls = runner.run.mock.calls;
      const startGatewayCalls = runCalls.filter(
        ([cmd]) => typeof cmd === "string" && cmd.includes("openclaw gateway run"),
      );
      expect(startGatewayCalls).toHaveLength(0);
    });

    it("sets up port forward even when gateway is already running", () => {
      // @ts-ignore — vi.fn() mock
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("sandbox list")) return "cortana  openshell";
        if (cmd.includes("ss -tlnp")) return `:${DASHBOARD_PORT}`;
        return "";
      });

      sandboxResume("cortana", quietOpts);

      // @ts-ignore — vi.fn() mock
      const runCalls = runner.run.mock.calls.map(([cmd]) => cmd);
      const forwardStop = runCalls.find((c) => c.includes("forward stop"));
      const forwardStart = runCalls.find((c) => c.includes("forward start"));
      expect(forwardStop).toBeTruthy();
      expect(forwardStart).toBeTruthy();
      expect(forwardStart).toContain("18789");
      expect(forwardStart).toContain("cortana");
    });
  });

  describe("gateway needs starting", () => {
    it("starts gateway and returns success when it comes up", () => {
      let ssCallCount = 0;
      // @ts-ignore — vi.fn() mock
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("sandbox list")) return "cortana  openshell  Ready";
        if (cmd.includes("ss -tlnp")) {
          ssCallCount++;
          // First call: gateway not running. Third call (retry): running.
          return ssCallCount >= 3 ? `:${DASHBOARD_PORT}` : "";
        }
        if (cmd.includes("python3")) return "mytoken";
        return "";
      });

      const result = sandboxResume("cortana", quietOpts);

      expect(result.gatewayStarted).toBe(true);
      expect(result.token).toBe("mytoken");
      expect(result.error).toBeNull();

      // Should have started the gateway
      // @ts-ignore — vi.fn() mock
      const runCalls = runner.run.mock.calls.map(([cmd]) => cmd);
      const startCmd = runCalls.find((c) => c.includes("openclaw gateway run"));
      expect(startCmd).toBeTruthy();
      expect(startCmd).toContain("HOME=/sandbox");
    });

    it("returns error when gateway never comes up", () => {
      // @ts-ignore — vi.fn() mock
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("sandbox list")) return "cortana  openshell  Ready";
        if (cmd.includes("ss -tlnp")) return ""; // never becomes ready
        if (cmd.includes("gateway.log")) return "Config invalid: missing key";
        return "";
      });

      const result = sandboxResume("cortana", quietOpts);

      expect(result.gatewayStarted).toBe(false);
      expect(result.token).toBeNull();
      expect(result.error).toContain("Config invalid");
    });
  });

  describe("port forwarding", () => {
    it("stops then starts the forward with correct sandbox name", () => {
      // @ts-ignore — vi.fn() mock
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("sandbox list")) return "my-sandbox  openshell  Ready";
        if (cmd.includes("ss -tlnp")) return `:${DASHBOARD_PORT}`;
        return "";
      });

      sandboxResume("my-sandbox", quietOpts);

      // @ts-ignore — vi.fn() mock
      const runCalls = runner.run.mock.calls.map(([cmd]) => cmd);
      const forwardStop = runCalls.find((c) => c.includes("forward stop"));
      const forwardStart = runCalls.find((c) => c.includes("forward start"));

      expect(forwardStop).toContain("18789");
      expect(forwardStop).toContain("my-sandbox");
      expect(forwardStart).toContain("--background");
      expect(forwardStart).toContain("18789");
      expect(forwardStart).toContain("my-sandbox");
    });
  });

  describe("auth token", () => {
    it("returns null token when extraction fails", () => {
      // @ts-ignore — vi.fn() mock
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("sandbox list")) return "cortana  openshell  Ready";
        if (cmd.includes("ss -tlnp")) return `:${DASHBOARD_PORT}`;
        if (cmd.includes("python3")) return ""; // empty = no token
        return "";
      });

      const result = sandboxResume("cortana", quietOpts);

      expect(result.token).toBeNull();
      expect(result.gatewayStarted).toBe(true);
    });
  });

  describe("DASHBOARD_PORT constant", () => {
    it("is 18789", () => {
      expect(DASHBOARD_PORT).toBe(18789);
    });
  });
});
