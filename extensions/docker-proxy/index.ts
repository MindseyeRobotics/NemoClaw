// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// OpenClaw Docker Proxy Plugin
//
// Registers agent tools for Docker container management via the NemoClaw
// host-side Docker proxy.  Uses the Docker Engine REST API directly over
// HTTP — no Docker CLI, no UNIX socket, no TCP hijack.
//
// Tools:
//   docker_run    — Create, start, wait, and return logs for a container
//   docker_ps     — List containers
//   docker_images — List local images
//   docker_pull   — Pull an image from a registry
//   docker_stop   — Stop a running container
//   docker_rm     — Remove a container
//   docker_logs   — Fetch container logs

import { Type } from "@sinclair/typebox";
import { DockerClient } from "./docker-client.js";
import type { ContainerListEntry, ImageListEntry } from "./docker-client.js";

// ── Configuration ─────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = "tcp://host.openshell.internal:2376";

function resolveEndpoint(pluginConfig: unknown): string {
  if (
    pluginConfig &&
    typeof pluginConfig === "object" &&
    "dockerHost" in pluginConfig &&
    typeof (pluginConfig as Record<string, unknown>).dockerHost === "string"
  ) {
    return (pluginConfig as Record<string, string>).dockerHost;
  }
  return process.env.DOCKER_HOST ?? DEFAULT_ENDPOINT;
}

// ── Formatters ────────────────────────────────────────────────────────────

function fmtContainers(containers: ContainerListEntry[]): string {
  if (containers.length === 0) return "No containers found.";
  return containers
    .map((c) => {
      const name = c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
      return `${c.Id.slice(0, 12)}  ${name}  ${c.Image}  ${c.State}  ${c.Status}`;
    })
    .join("\n");
}

function fmtImages(images: ImageListEntry[]): string {
  if (images.length === 0) return "No images found.";
  return images
    .map((img) => {
      const tags = img.RepoTags?.join(", ") ?? "<none>";
      const sizeMB = (img.Size / 1_048_576).toFixed(1);
      return `${img.Id.slice(7, 19)}  ${tags}  ${sizeMB} MB`;
    })
    .join("\n");
}

// ── Plugin ────────────────────────────────────────────────────────────────

type PluginApi = {
  pluginConfig: unknown;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  registerTool: (tool: Record<string, unknown>, opts?: Record<string, unknown>) => void;
};

const dockerProxyPlugin = {
  id: "docker-proxy",
  name: "Docker Proxy",
  description: "Docker container management tools via the NemoClaw host-side Docker proxy",

  register(api: PluginApi) {
    const endpoint = resolveEndpoint(api.pluginConfig);
    const docker = new DockerClient({ endpoint });

    api.logger.info(`[docker-proxy] Using Docker endpoint: ${endpoint}`);

    // ── docker_run ────────────────────────────────────────────────────────
    api.registerTool({
      name: "docker_run",
      label: "Docker Run",
      description:
        "Run a command in a new container (create → start → wait → logs). " +
        "Returns the container output and exit code. " +
        "For long-running containers, set detach=true to start without waiting.",
      parameters: Type.Object({
        image: Type.String({ description: "Docker image (e.g. 'python:3.12-slim', 'ubuntu:24.04')" }),
        command: Type.Optional(Type.Array(Type.String(), { description: "Command and arguments" })),
        env: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description: "Environment variables as key-value pairs",
          }),
        ),
        workdir: Type.Optional(Type.String({ description: "Working directory inside the container" })),
        detach: Type.Optional(Type.Boolean({ description: "If true, start the container and return its ID without waiting" })),
      }),
      async execute(
        _toolCallId: string,
        params: {
          image: string;
          command?: string[];
          env?: Record<string, string>;
          workdir?: string;
          detach?: boolean;
        },
      ) {
        const envList = params.env
          ? Object.entries(params.env).map(([k, v]) => `${k}=${v}`)
          : undefined;

        const { Id: containerId } = await docker.containerCreate({
          Image: params.image,
          Cmd: params.command,
          Env: envList,
          WorkingDir: params.workdir,
        });

        await docker.containerStart(containerId);
        const shortId = containerId.slice(0, 12);

        if (params.detach) {
          return {
            content: [{ type: "text", text: `Container started: ${shortId}` }],
            details: { containerId, shortId, detached: true },
          };
        }

        // Wait for the container to finish
        const { StatusCode: exitCode } = await docker.containerWait(containerId);
        const logs = await docker.containerLogs(containerId);

        // Auto-remove after collecting output
        try {
          await docker.containerRemove(containerId);
        } catch {
          // best-effort cleanup
        }

        const output = logs.trim() || "(no output)";
        const header = exitCode === 0 ? `Container ${shortId} finished successfully` : `Container ${shortId} exited with code ${exitCode}`;

        return {
          content: [{ type: "text", text: `${header}\n\n${output}` }],
          details: { containerId: shortId, exitCode, outputLength: output.length },
        };
      },
    });

    // ── docker_ps ─────────────────────────────────────────────────────────
    api.registerTool({
      name: "docker_ps",
      label: "Docker PS",
      description: "List Docker containers. Shows running containers by default, set all=true to include stopped.",
      parameters: Type.Object({
        all: Type.Optional(Type.Boolean({ description: "Include stopped containers" })),
      }),
      async execute(_toolCallId: string, params: { all?: boolean }) {
        const containers = await docker.containerList(params.all ?? false);
        return {
          content: [{ type: "text", text: fmtContainers(containers) }],
          details: { count: containers.length },
        };
      },
    });

    // ── docker_images ─────────────────────────────────────────────────────
    api.registerTool({
      name: "docker_images",
      label: "Docker Images",
      description: "List locally available Docker images with their tags and sizes.",
      parameters: Type.Object({}),
      async execute() {
        const images = await docker.imageList();
        return {
          content: [{ type: "text", text: fmtImages(images) }],
          details: { count: images.length },
        };
      },
    });

    // ── docker_pull ───────────────────────────────────────────────────────
    api.registerTool({
      name: "docker_pull",
      label: "Docker Pull",
      description: "Pull a Docker image from a registry.",
      parameters: Type.Object({
        image: Type.String({ description: "Image to pull (e.g. 'python:3.12', 'nvcr.io/nvidia/pytorch:24.03-py3')" }),
      }),
      async execute(_toolCallId: string, params: { image: string }) {
        const status = await docker.imagePull(params.image);
        return {
          content: [{ type: "text", text: `Pull complete: ${params.image}\n${status}` }],
          details: { image: params.image },
        };
      },
    });

    // ── docker_stop ───────────────────────────────────────────────────────
    api.registerTool({
      name: "docker_stop",
      label: "Docker Stop",
      description: "Stop a running container gracefully.",
      parameters: Type.Object({
        container: Type.String({ description: "Container ID or name" }),
        timeout: Type.Optional(Type.Number({ description: "Seconds to wait before killing (default: 10)" })),
      }),
      async execute(_toolCallId: string, params: { container: string; timeout?: number }) {
        await docker.containerStop(params.container, params.timeout ?? 10);
        return {
          content: [{ type: "text", text: `Container ${params.container} stopped.` }],
        };
      },
    });

    // ── docker_rm ─────────────────────────────────────────────────────────
    api.registerTool({
      name: "docker_rm",
      label: "Docker Remove",
      description: "Remove a stopped container. Use force=true to remove running containers.",
      parameters: Type.Object({
        container: Type.String({ description: "Container ID or name" }),
        force: Type.Optional(Type.Boolean({ description: "Force remove (kill if running)" })),
      }),
      async execute(_toolCallId: string, params: { container: string; force?: boolean }) {
        await docker.containerRemove(params.container, params.force ?? false);
        return {
          content: [{ type: "text", text: `Container ${params.container} removed.` }],
        };
      },
    });

    // ── docker_logs ───────────────────────────────────────────────────────
    api.registerTool({
      name: "docker_logs",
      label: "Docker Logs",
      description: "Fetch stdout/stderr logs from a container.",
      parameters: Type.Object({
        container: Type.String({ description: "Container ID or name" }),
        tail: Type.Optional(Type.Number({ description: "Number of lines from the end (default: 200)" })),
      }),
      async execute(_toolCallId: string, params: { container: string; tail?: number }) {
        const logs = await docker.containerLogs(params.container, params.tail ?? 200);
        const output = logs.trim() || "(no output)";
        return {
          content: [{ type: "text", text: output }],
          details: { container: params.container, length: output.length },
        };
      },
    });
  },
};

export default dockerProxyPlugin;
