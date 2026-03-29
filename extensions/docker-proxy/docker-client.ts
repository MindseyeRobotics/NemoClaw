// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Docker API client — thin HTTP wrapper for the Docker Engine REST API.
// Talks to the NemoClaw host-side Docker proxy over plain HTTP (no TLS, no
// UNIX socket, no TCP hijack/upgrade).  This avoids the `docker run` hang
// caused by HTTP upgrade not traversing the k3s pod network correctly.

import http from "node:http";
import { URL } from "node:url";

export type DockerClientOptions = {
  /** Full TCP URL, e.g. "tcp://host.openshell.internal:2376" */
  endpoint: string;
};

type RequestOptions = {
  method: string;
  path: string;
  body?: string;
  timeout?: number;
};

function parseEndpoint(endpoint: string): { hostname: string; port: number } {
  // Normalise tcp:// → http:// for URL parsing
  const url = new URL(endpoint.replace(/^tcp:\/\//, "http://"));
  return {
    hostname: url.hostname,
    port: Number(url.port) || 2376,
  };
}

export class DockerClient {
  private hostname: string;
  private port: number;

  constructor(opts: DockerClientOptions) {
    const parsed = parseEndpoint(opts.endpoint);
    this.hostname = parsed.hostname;
    this.port = parsed.port;
  }

  // ── Low-level request ──────────────────────────────────────────────────

  private request(opts: RequestOptions): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this.hostname,
          port: this.port,
          method: opts.method,
          path: opts.path,
          headers: opts.body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(opts.body) }
            : undefined,
          timeout: opts.timeout ?? 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") });
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("Docker API request timed out"));
      });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  private async json<T>(opts: RequestOptions): Promise<T> {
    const { status, body } = await this.request(opts);
    if (status < 200 || status >= 300) {
      let message = `Docker API ${opts.method} ${opts.path} returned ${status}`;
      try {
        const parsed = JSON.parse(body);
        if (parsed.message) message += `: ${parsed.message}`;
      } catch {
        if (body) message += `: ${body.slice(0, 200)}`;
      }
      throw new Error(message);
    }
    return body ? JSON.parse(body) : ({} as T);
  }

  private async text(opts: RequestOptions): Promise<string> {
    const { status, body } = await this.request(opts);
    if (status < 200 || status >= 300) {
      throw new Error(`Docker API ${opts.method} ${opts.path} returned ${status}: ${body.slice(0, 200)}`);
    }
    return body;
  }

  private async noContent(opts: RequestOptions): Promise<void> {
    const { status, body } = await this.request(opts);
    if (status < 200 || status >= 400) {
      throw new Error(`Docker API ${opts.method} ${opts.path} returned ${status}: ${body.slice(0, 200)}`);
    }
  }

  // ── API version prefix ────────────────────────────────────────────────

  private v = "/v1.47";

  // ── Containers ────────────────────────────────────────────────────────

  async containerList(all = false): Promise<ContainerListEntry[]> {
    return this.json({ method: "GET", path: `${this.v}/containers/json?all=${all}` });
  }

  async containerInspect(id: string): Promise<Record<string, unknown>> {
    return this.json({ method: "GET", path: `${this.v}/containers/${encodeURIComponent(id)}/json` });
  }

  async containerCreate(spec: ContainerCreateSpec): Promise<{ Id: string; Warnings: string[] }> {
    return this.json({
      method: "POST",
      path: `${this.v}/containers/create`,
      body: JSON.stringify(spec),
    });
  }

  async containerStart(id: string): Promise<void> {
    return this.noContent({ method: "POST", path: `${this.v}/containers/${encodeURIComponent(id)}/start` });
  }

  async containerStop(id: string, timeoutSec = 10): Promise<void> {
    return this.noContent({
      method: "POST",
      path: `${this.v}/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}`,
      timeout: (timeoutSec + 5) * 1000,
    });
  }

  async containerKill(id: string): Promise<void> {
    return this.noContent({ method: "POST", path: `${this.v}/containers/${encodeURIComponent(id)}/kill` });
  }

  async containerRemove(id: string, force = false): Promise<void> {
    return this.noContent({
      method: "DELETE",
      path: `${this.v}/containers/${encodeURIComponent(id)}?force=${force}`,
    });
  }

  async containerWait(id: string): Promise<{ StatusCode: number }> {
    return this.json({
      method: "POST",
      path: `${this.v}/containers/${encodeURIComponent(id)}/wait`,
      timeout: 300_000, // 5 minute max wait
    });
  }

  async containerLogs(id: string, tail = 200): Promise<string> {
    const raw = await this.text({
      method: "GET",
      path: `${this.v}/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail}`,
    });
    // Docker multiplexed stream: strip 8-byte headers from each frame
    return stripDockerStreamHeaders(raw);
  }

  // ── Images ────────────────────────────────────────────────────────────

  async imageList(): Promise<ImageListEntry[]> {
    return this.json({ method: "GET", path: `${this.v}/images/json` });
  }

  async imagePull(image: string): Promise<string> {
    // Docker pull uses POST /images/create?fromImage=... and streams progress
    const raw = await this.text({
      method: "POST",
      path: `${this.v}/images/create?fromImage=${encodeURIComponent(image)}`,
      timeout: 300_000, // image pulls can be slow
    });
    // Return the last status line
    const lines = raw.trim().split("\n");
    const statuses = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    const last = statuses[statuses.length - 1];
    return last?.status ?? "Pull complete";
  }

  async imageRemove(image: string): Promise<void> {
    return this.noContent({ method: "DELETE", path: `${this.v}/images/${encodeURIComponent(image)}` });
  }

  // ── Info ───────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.text({ method: "GET", path: "/_ping", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<Record<string, unknown>> {
    return this.json({ method: "GET", path: `${this.v}/version` });
  }

  async info(): Promise<Record<string, unknown>> {
    return this.json({ method: "GET", path: `${this.v}/info` });
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export type ContainerCreateSpec = {
  Image: string;
  Cmd?: string[];
  Env?: string[];
  WorkingDir?: string;
  HostConfig?: {
    Binds?: string[];
    NetworkMode?: string;
  };
};

export type ContainerListEntry = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
};

export type ImageListEntry = {
  Id: string;
  RepoTags: string[] | null;
  Size: number;
  Created: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────

/** Strip Docker multiplexed stream 8-byte frame headers */
function stripDockerStreamHeaders(raw: string): string {
  const buf = Buffer.from(raw, "binary");
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const frameLen = buf.readUInt32BE(offset + 4);
    if (offset + 8 + frameLen > buf.length) break;
    parts.push(buf.subarray(offset + 8, offset + 8 + frameLen).toString("utf-8"));
    offset += 8 + frameLen;
  }
  // If parsing failed or no frames detected, return raw
  return parts.length > 0 ? parts.join("") : raw;
}
