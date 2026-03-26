---
name: nemoclaw-mount-filesystem
description: Mount the sandbox filesystem locally with SSHFS, back up and restore all agent data, and resume a sandbox after a reboot. Use when backup nemoclaw sandbox, mount nemoclaw sandbox, mount sandbox filesystem, nemoclaw backup, nemoclaw mount, nemoclaw persist data, nemoclaw resume, nemoclaw sshfs, persist sandbox data, resume nemoclaw sandbox, restore nemoclaw sandbox.
---

# NemoClaw Mount Filesystem

Mount the sandbox filesystem locally with SSHFS, back up and restore all agent data, and resume a sandbox after a reboot.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.
- `sshfs` installed on the host (`sudo apt-get install -y sshfs`).
- `openssh-sftp-server` installed on the host (`sudo apt-get install -y openssh-sftp-server`).

The sandbox data directory (`/sandbox/.openclaw-data`) contains all writable state that the agent produces at runtime. This includes workspace files, agent sessions, canvas pages, cron jobs, device pairings, hooks, identity, and skills. Mounting this directory locally lets you browse and edit files while the sandbox is live.

## Mount the Sandbox Data Directory

Mount the sandbox data directory to a local folder via SSHFS.

```console
$ nemoclaw <name> mount
```

The default mount point is `~/nemoclaw-sandbox/<name>`. To override it, pass a path:

```console
$ nemoclaw my-assistant mount /mnt/my-assistant
```

On first mount, the script automatically uploads `sftp-server` from the host into the sandbox because the sandbox SSH server (russh) does not include one. Subsequent mounts skip this step.

After mounting, the following directories are available at the mount point:

| Directory      | Contents                                 |
|----------------|------------------------------------------|
| `workspace/`   | Agent workspace files (SOUL.md, source code, research, etc.) |
| `agents/`      | Agent sessions and configuration         |
| `canvas/`      | Canvas pages                             |
| `cron/`        | Scheduled jobs                           |
| `devices/`     | Paired and pending device state          |
| `hooks/`       | Event hooks                              |
| `identity/`    | Device identity and auth                 |
| `skills/`      | Installed skills                         |

### Check Mount Status

Run the sandbox status command to see mount information alongside other sandbox state:

```console
$ nemoclaw <name> status
```

### Unmount

```console
$ nemoclaw <name> unmount
```

If the unmount fails because a process holds a file descriptor, use `fusermount -uz` to force a lazy unmount:

```console
$ fusermount -uz ~/nemoclaw-sandbox/<name>
```

## Back Up All Sandbox Data

Download all sandbox data to a timestamped local backup. This captures every directory the agent writes to, not just workspace files.

```console
$ nemoclaw <name> backup
```

Backups are stored in `~/.nemoclaw/backups/<timestamp>/`. Each backup includes all directories listed in the mount table above, plus any loose files in the data root.

### Restore from a Backup

Restore the most recent backup into a running sandbox:

```console
$ nemoclaw <name> restore
```

To restore a specific backup, pass the timestamp:

```console
$ nemoclaw <name> restore 20260325-214252
```

## Resume After a Reboot

Bring a sandbox back online after a reboot or Docker restart. The resume command runs six steps in sequence:

1. Check that Docker is running.
2. Back up sandbox data (best-effort, in case the sandbox is still reachable).
3. Start the gateway container (preserving all state).
4. Wait for the sandbox to reach Ready state and restore data from the most recent backup.
5. Set up the dashboard port forward.
6. Mount the sandbox data directory via SSHFS.

```console
$ nemoclaw resume my-assistant
```

If no name is given, the default sandbox is used:

```console
$ nemoclaw resume
```

After resume, the dashboard is available at `http://127.0.0.1:18789/` and the sandbox data is mounted at `~/nemoclaw-sandbox/my-assistant/`.

## Persistent Mounts Across Reboots (Autostart)

If you have run `scripts/setup-autostart.sh` (see the `nemoclaw-gpu-sandbox` skill, Step 5), the autostart systemd service automatically re-mounts all registered sandboxes on every reboot.

The generated `scripts/resume-all-sandboxes.sh` performs these steps for each sandbox in `~/.nemoclaw/sandboxes.json`:

1. Calls `nemoclaw <name> resume` to bring the sandbox back online.
2. Checks if the mount point (`~/nemoclaw-sandbox/<name>`) is already mounted.
3. If stale (e.g., leftover from a dirty shutdown), runs `fusermount -uz` to force-clear the mount.
4. Calls `nemoclaw <name> mount` to establish a fresh SSHFS connection.

This means after every reboot, workspace files are immediately accessible at `~/nemoclaw-sandbox/<name>/workspace/` with no manual steps required.

### First-time mount setup

Before autostart can re-mount, the sandbox must be mounted at least once manually so the SSH config entry and `sftp-server` upload are done:

```console
$ nemoclaw cortana mount
$ nemoclaw jarvis mount
```

Subsequent mounts (including those done by autostart) skip the `sftp-server` upload because the binary is already present inside the sandbox.

### Flags

| Flag                    | Description                    |
|-------------------------|--------------------------------|
| `--port <port>`         | Port to forward for the dashboard (default: 18789) |
| `--mount-point <path>`  | Where to mount sandbox data (default: `~/nemoclaw-sandbox/<name>`) |

Example with overrides:

```console
$ nemoclaw resume my-assistant --port 9000 --mount-point /mnt/my-assistant
```

## Related Skills

- `nemoclaw-monitor-sandbox` — Check sandbox health and view logs
- `nemoclaw-get-started` — Install NemoClaw and launch a sandbox
- `nemoclaw-reference` — CLI commands reference and troubleshooting
