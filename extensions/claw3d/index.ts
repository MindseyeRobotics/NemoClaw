// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// OpenClaw Claw3D Plugin
//
// Registers agent tools for interacting with a running Claw3D instance.
// Claw3D is a 3D virtual office platform; this plugin exposes its REST API
// so agents can send messages, query office layout, and manage studio settings.
//
// Tools:
//   claw3d_office_list      — List offices in a workspace
//   claw3d_office_get       — Get the published office map for a workspace
//   claw3d_message_send     — Send a remote message to an office occupant
//   claw3d_studio_settings  — Get or patch Claw3D studio/gateway settings

import { Type } from "@sinclair/typebox";

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:3000";

function resolveBaseUrl(pluginConfig: unknown): string {
  if (
    pluginConfig &&
    typeof pluginConfig === "object" &&
    "baseUrl" in pluginConfig &&
    typeof (pluginConfig as Record<string, unknown>).baseUrl === "string"
  ) {
    return ((pluginConfig as Record<string, string>).baseUrl).replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function claw3dGet(baseUrl: string, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${baseUrl}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Claw3D GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function claw3dPut(baseUrl: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Claw3D PUT ${path} failed: ${res.status} ${res.statusText}${text ? " — " + text : ""}`);
  }
  return res.json();
}

async function claw3dPost(baseUrl: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Claw3D POST ${path} failed: ${res.status} ${res.statusText}${text ? " — " + text : ""}`);
  }
  return res.json();
}

// ── Plugin ────────────────────────────────────────────────────────────────────

type PluginApi = {
  pluginConfig: unknown;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  registerTool: (tool: Record<string, unknown>, opts?: Record<string, unknown>) => void;
};

const claw3dPlugin = {
  id: "claw3d",
  name: "Claw3D",
  description: "Tools for interacting with a Claw3D 3D virtual office instance",

  register(api: PluginApi) {
    const baseUrl = resolveBaseUrl(api.pluginConfig);
    api.logger.info(`[claw3d] Using Claw3D at: ${baseUrl}`);

    // ── claw3d_office_list ────────────────────────────────────────────────
    api.registerTool({
      name: "claw3d_office_list",
      label: "Claw3D Office List",
      description: "List offices available in a Claw3D workspace.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Workspace ID (default: 'default')" })),
      }),
      async execute(_id: string, params: { workspaceId?: string }) {
        const data = await claw3dGet(baseUrl, "/api/office", {
          workspaceId: params.workspaceId ?? "default",
        }) as Record<string, unknown>;
        const offices = (data.offices as Array<{ officeId: string; name: string }> | undefined) ?? [];
        const published = data.published as { officeId?: string; name?: string } | undefined;
        const lines: string[] = offices.map((o) => `${o.officeId}  ${o.name}${published?.officeId === o.officeId ? "  [published]" : ""}`);
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : "No offices found." }],
          details: { count: offices.length, publishedId: published?.officeId },
        };
      },
    });

    // ── claw3d_office_get ─────────────────────────────────────────────────
    api.registerTool({
      name: "claw3d_office_get",
      label: "Claw3D Office Map",
      description: "Get the published office map (rooms, occupants, layout) for a workspace.",
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ description: "Workspace ID (default: 'default')" })),
      }),
      async execute(_id: string, params: { workspaceId?: string }) {
        const data = await claw3dGet(baseUrl, "/api/office", {
          workspaceId: params.workspaceId ?? "default",
        }) as Record<string, unknown>;
        return {
          content: [{ type: "text", text: JSON.stringify(data.publishedMap ?? data.published ?? {}, null, 2) }],
          details: { workspaceId: params.workspaceId ?? "default" },
        };
      },
    });

    // ── claw3d_message_send ───────────────────────────────────────────────
    api.registerTool({
      name: "claw3d_message_send",
      label: "Claw3D Send Message",
      description: "Send a remote message to a Claw3D office participant.",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient identifier (user ID or display name)" }),
        message: Type.String({ description: "Message text to send" }),
        workspaceId: Type.Optional(Type.String({ description: "Workspace ID (default: 'default')" })),
      }),
      async execute(_id: string, params: { to: string; message: string; workspaceId?: string }) {
        const result = await claw3dPost(baseUrl, "/api/office/remote-message", {
          to: params.to,
          message: params.message,
          workspaceId: params.workspaceId ?? "default",
        });
        return {
          content: [{ type: "text", text: `Message sent to ${params.to}.` }],
          details: result,
        };
      },
    });

    // ── claw3d_studio_settings ────────────────────────────────────────────
    api.registerTool({
      name: "claw3d_studio_settings",
      label: "Claw3D Studio Settings",
      description: "Get or update Claw3D studio and gateway settings. Omit 'patch' to read current settings.",
      parameters: Type.Object({
        patch: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Settings patch object to apply (e.g. {\\\"gateway\\\":{\\\"url\\\":\\\"ws://localhost:18789\\\"}}). Omit to just read.",
          })
        ),
      }),
      async execute(_id: string, params: { patch?: Record<string, unknown> }) {
        if (params.patch) {
          const result = await claw3dPut(baseUrl, "/api/studio", params.patch);
          return {
            content: [{ type: "text", text: "Studio settings updated." }],
            details: result,
          };
        }
        const settings = await claw3dGet(baseUrl, "/api/studio") as Record<string, unknown>;
        return {
          content: [{ type: "text", text: JSON.stringify(settings, null, 2) }],
          details: { read: true },
        };
      },
    });
  },
};

export default claw3dPlugin;
