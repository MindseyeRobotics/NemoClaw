---
name: nemoclaw-docker-proxy
description: "Enable Docker and Docker Compose inside a NemoClaw sandbox. Deploy the host-side Docker proxy, configure the OpenClaw Docker proxy plugin, set up network policies, and use agent tools for container management. Use when: docker sandbox, docker proxy, docker compose, container management, docker plugin, openclaw docker, docker setup, nemoclaw docker, docker-proxy, agent containers, docker api, docker compose sandbox, compose up, compose down."
---

# NemoClaw Docker Proxy Setup

Enable Docker and Docker Compose inside a NemoClaw sandbox so agents can run containers on the host through a security-filtered proxy.

## Architecture Overview

Sandboxes cannot access the host Docker daemon directly.  Instead, a three-layer proxy chain keeps the agent isolated:

```text
┌─────────────────────────────────────┐
│  Sandbox Pod (k3s)                  │
│                                     │
│  Agent / Plugin                     │
│      │  HTTP REST API               │
│      ▼                              │
│  tcp://host.openshell.internal:2376 │
└───────────────┬─────────────────────┘
                │  OpenShell network policy (gate 1)
                ▼
┌───────────────────────────────────────┐
│  Host: scripts/docker-proxy.js        │
│    - Route allowlist (gate 2)         │
│    - Body validation (gate 3)         │
│      ▼                                │
│  /var/run/docker.sock                 │
└───────────────────────────────────────┘
```

**Why not Docker-in-Docker?**  The sandbox runs inside a k3s pod.  DinD requires `--privileged` which the security policy blocks.  The proxy approach keeps privilege on the host side behind two security gates.

**Why not the Docker CLI directly?**  `docker run` requires a TCP hijack (HTTP Upgrade) that does not traverse the k3s pod network.  The plugin uses discrete REST API calls (create → start → wait → logs) which work reliably.

---

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Host proxy | `scripts/docker-proxy.js` | HTTP proxy on port 2376 with allowlist + body validation |
| Plugin manifest | `extensions/docker-proxy/openclaw.plugin.json` | Declares plugin ID, name, configSchema |
| Plugin entry | `extensions/docker-proxy/index.ts` | Registers 7 tools: docker_run, docker_ps, docker_images, docker_pull, docker_stop, docker_rm, docker_logs |
| HTTP client | `extensions/docker-proxy/docker-client.ts` | Docker Engine REST API client over plain HTTP |
| Network policy | `nemoclaw-blueprint/policies/presets/docker-proxy.yaml` | Allows sandbox → host.openshell.internal:2376 |
| Registry policy | `nemoclaw-blueprint/policies/presets/docker.yaml` | Allows sandbox → Docker Hub, NVCR registries |

---

## Step 1: Start the Host-Side Docker Proxy

The proxy runs on the host machine (not inside the sandbox):

```console
$ node scripts/docker-proxy.js &
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NEMOCLAW_DOCKER_PROXY_PORT` | `2376` | TCP port the proxy listens on |
| `DOCKER_HOST` | auto-detect `/var/run/docker.sock` | Override Docker socket path |

Verify it is running:

```console
$ curl -s http://127.0.0.1:2376/_ping
OK
```

### Make It Persistent

For production, run the proxy under a systemd user service or add it to your sandbox start script. It must be running whenever agent Docker operations are needed.

---

## Step 2: Apply Network Policies

The sandbox policy must include both the `docker-proxy` and `docker` presets.

### Option A: At sandbox creation

```console
$ nemoclaw sandbox-init <name> --policy docker --policy docker-proxy
```

### Option B: Merge into an existing policy

Edit `nemoclaw-blueprint/policies/cortana.yaml` (or your sandbox's policy file) and add:

```yaml
network_policies:
  docker_proxy:
    name: docker_proxy
    endpoints:
      - host: host.openshell.internal
        port: 2376
        protocol: rest
        enforcement: enforce
        tls: none
        rules:
          - allow: { method: GET,    path: "/v*/version" }
          - allow: { method: GET,    path: "/v*/info" }
          - allow: { method: GET,    path: "/_ping" }
          - allow: { method: HEAD,   path: "/_ping" }
          - allow: { method: GET,    path: "/v*/containers/**" }
          - allow: { method: POST,   path: "/v*/containers/**" }
          - allow: { method: DELETE, path: "/v*/containers/**" }
          - allow: { method: GET,    path: "/v*/images/**" }
          - allow: { method: POST,   path: "/v*/images/**" }
          - allow: { method: DELETE, path: "/v*/images/**" }
          - allow: { method: GET,    path: "/v*/networks/**" }
          - allow: { method: GET,    path: "/v*/volumes/**" }
          - allow: { method: GET,    path: "/v*/events" }
    binaries:
      - { path: /usr/bin/docker }
      - { path: /usr/libexec/docker/cli-plugins/docker-compose }
  docker_registries:
    name: docker_registries
    endpoints:
      - host: registry-1.docker.io
        port: 443
        protocol: rest
        enforcement: enforce
        tls: terminate
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
      - host: auth.docker.io
        port: 443
        protocol: rest
        enforcement: enforce
        tls: terminate
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
      - host: nvcr.io
        port: 443
        protocol: rest
        enforcement: enforce
        tls: terminate
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
      - host: authn.nvidia.com
        port: 443
        protocol: rest
        enforcement: enforce
        tls: terminate
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
    binaries:
      - { path: /usr/bin/docker }
```

Then apply:

```console
$ nemoclaw cortana update-policy   # or recreate sandbox
```

---

## Step 3: Deploy the Plugin Files

Copy the three plugin files into the sandbox's OpenClaw extensions directory:

```console
# From the NemoClaw repo root
for f in extensions/docker-proxy/{openclaw.plugin.json,index.ts,docker-client.ts}; do
  cat "$f" | docker exec -i openshell-cluster-nemoclaw \
    kubectl exec -i <sandbox> -n openshell -- \
    bash -c "mkdir -p /usr/lib/node_modules/openclaw/extensions/docker-proxy && \
             cat > /usr/lib/node_modules/openclaw/extensions/docker-proxy/$(basename $f)"
done
```

Replace `<sandbox>` with your sandbox pod name (e.g., `cortana`).

---

## Step 4: Enable in openclaw.json

Add the plugin entry to `/sandbox/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "docker-proxy": {
        "enabled": true,
        "config": {
          "dockerHost": "tcp://host.openshell.internal:2376"
        }
      }
    }
  }
}
```

**Important:** Plugin-specific config must go under the `config` sub-key. The entry-level object only accepts `enabled`, `hooks`, and `config`. Placing `dockerHost` at the entry level causes `Unrecognized key` validation errors.

Write the config to the sandbox (landlock prevents the OpenClaw CLI from writing it directly):

```console
$ cat /path/to/openclaw.json | docker exec -i openshell-cluster-nemoclaw \
    kubectl exec -i <sandbox> -n openshell -- \
    bash -c 'cat > /sandbox/.openclaw/openclaw.json'
```

---

## Step 5: Restart the Gateway

```console
# Kill existing gateway
$ docker exec openshell-cluster-nemoclaw kubectl exec <sandbox> -n openshell -- \
    bash -c 'kill -9 $(pgrep -f openclaw) 2>/dev/null'

# Restart via NemoClaw CLI
$ nemoclaw cortana resume
```

---

## Step 6: Verify

```console
$ docker exec openshell-cluster-nemoclaw kubectl exec <sandbox> -n openshell -- \
    su -s /bin/bash gateway -c 'openclaw plugins list' 2>&1 | grep docker
```

Expected output:

```text
[plugins] [docker-proxy] Using Docker endpoint: tcp://host.openshell.internal:2376
│ Docker Proxy │ docker-  │ loaded   │ stock:docker-proxy/index.ts
```

---

## Available Agent Tools

Once loaded, the plugin registers these tools:

| Tool | Description |
|------|-------------|
| `docker_run` | Create → start → wait → return logs. Set `detach=true` for background containers. |
| `docker_ps` | List containers. `all=true` includes stopped. |
| `docker_images` | List locally available images with tags and sizes. |
| `docker_pull` | Pull an image from Docker Hub or NVCR. |
| `docker_stop` | Gracefully stop a running container. |
| `docker_rm` | Remove a container. `force=true` kills if running. |
| `docker_logs` | Fetch stdout/stderr. `tail=N` for last N lines. |

### Tool Behavior Notes

- **docker_run** uses create → start → wait → logs (not `docker run`), avoiding the TCP hijack issue.
- Auto-cleanup: `docker_run` removes the container after collecting output (unless `detach=true`).
- **5-minute timeout** on container wait and image pull operations.
- Logs are returned with Docker multiplexed stream headers stripped.

---

## Docker Compose

Docker Compose **works from the CLI** inside the sandbox, but requires the `DOCKER_HOST` environment variable:

```console
# Inside sandbox (as gateway user)
$ export DOCKER_HOST=tcp://host.openshell.internal:2376
$ docker compose -f /path/to/docker-compose.yml up -d
$ docker compose -f /path/to/docker-compose.yml logs
$ docker compose -f /path/to/docker-compose.yml down
```

### Docker Compose via the Agent

The agent exec tool can invoke `docker compose` if `DOCKER_HOST` is set in the sandbox environment. Add to `/etc/environment` or `/etc/profile.d/docker-host.sh`:

```bash
# /etc/profile.d/docker-host.sh
export DOCKER_HOST=tcp://host.openshell.internal:2376
```

Compose operations supported through the proxy:

- `docker compose up -d` — Uses create/start APIs (works)
- `docker compose logs` — Uses container logs API (works)
- `docker compose down` — Uses stop/remove APIs (works)
- `docker compose build` — **NOT supported** (build API is not in the proxy allowlist)
- `docker compose run` — May hang if it uses attach/hijack; prefer `docker compose up -d` + `docker compose logs`

### Proxy Allowlist for Compose

The proxy already includes the endpoints Compose needs: container CRUD, image pull, networks (read), volumes (read), and events. Compose's event streaming (`GET /events`) is explicitly allowed.

---

## Security Model

### Gate 1: OpenShell Network Policy

The sandbox can only reach `host.openshell.internal:2376`. All other host ports are blocked.

### Gate 2: Route Allowlist (`scripts/docker-proxy.js`)

Only these Docker Engine API operations are forwarded:

- **Allowed:** containers (list, inspect, create, start, stop, kill, restart, wait, logs, attach, remove), images (list, inspect, pull, remove), networks (read), volumes (read), events, ping, version, info
- **Blocked:** exec, build, commit, export, import, push, prune, swarm, secrets, configs, system/df

### Gate 3: Body Validation (container create only)

Container create requests are inspected. The following are rejected:

| Parameter | Blocked Value | Reason |
|-----------|--------------|--------|
| `HostConfig.Privileged` | `true` | Full host access |
| `HostConfig.NetworkMode` | `"host"` | Host network bypass |
| `HostConfig.CapAdd` | `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, `SYS_RAWIO`, `MKNOD`, `SETFCAP`, `AUDIT_CONTROL` | Dangerous capabilities |
| `HostConfig.Binds` / `Mounts` | Paths under `/etc`, `/root`, `/home`, `/var/run/docker.sock`, `/proc`, `/sys`, `/boot`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64` | Sensitive host paths |

---

## Troubleshooting

### Proxy not responding

```console
# Check if proxy process is running on host
$ pgrep -f docker-proxy.js || echo "Not running"

# Start it
$ node scripts/docker-proxy.js &

# Test from sandbox
$ docker exec openshell-cluster-nemoclaw kubectl exec <sandbox> -n openshell -- \
    curl -s http://host.openshell.internal:2376/_ping
# Expected: OK
```

### Plugin shows "disabled"

Check that `openclaw.json` has the plugin under `plugins.entries`:

```json
"plugins": {
  "entries": {
    "docker-proxy": {
      "enabled": true,
      "config": { "dockerHost": "tcp://host.openshell.internal:2376" }
    }
  }
}
```

Common mistakes:

- Putting `dockerHost` at entry level instead of under `config` → `Unrecognized key`
- Using `plugins.docker-proxy` instead of `plugins.entries.docker-proxy` → `Unrecognized key`

### "Operation not permitted" from proxy

The requested Docker API path is not in the allowlist. Check `ALLOWED_ROUTES` in `scripts/docker-proxy.js`. Note that `/_ping` must NOT have a version prefix (`/v1.47/_ping` is not allowed, `/_ping` is).

### docker compose run hangs

`docker compose run` uses HTTP upgrade (TCP hijack) which does not traverse the k3s pod network. Use `docker compose up -d` followed by `docker compose logs` instead.

### Container create rejected

The proxy body validation blocks privileged containers, host networking, dangerous capabilities, and mounts of sensitive host paths. Check the error message — it will state exactly which parameter was rejected.
