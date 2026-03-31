#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Resume a NemoClaw sandbox after a reboot or Docker restart.
#
# This script restarts the gateway container (preserving all sandbox
# state, images, policies, and inference config), re-establishes
# the dashboard port forward, and restores workspace data from the
# most recent backup if the sandbox was recreated.
#
# All sandbox data (workspace, agent sessions, canvas, cron, identity,
# etc.) is automatically backed up before shutdown and restored on
# resume, so agent memory and work products survive across sessions.
#
# After resume, the sandbox data directory is mounted via SSHFS to
# ~/nemoclaw-sandbox/<name> so you can browse and edit files live.
#
# Usage:
#   ./scripts/resume.sh <sandbox-name>
#   ./scripts/resume.sh my-assistant
#   DASHBOARD_PORT=18789 ./scripts/resume.sh my-assistant
#   MOUNT_POINT=/mnt/my-assistant ./scripts/resume.sh my-assistant

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DASHBOARD_PORT="${DASHBOARD_PORT:-18789}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SANDBOX_READY_TIMEOUT="${SANDBOX_READY_TIMEOUT:-60}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[resume]${NC} $1"; }
warn() { echo -e "${YELLOW}[resume]${NC} $1"; }
fail() {
  echo -e "${RED}[resume]${NC} $1"
  exit 1
}
step() { echo -e "\n${GREEN}[$1/$2]${NC} $3"; }

# ── Validate arguments ───────────────────────────────────────────

SANDBOX_NAME="${1:-}"
if [ -z "$SANDBOX_NAME" ]; then
  echo "Usage: $0 <sandbox-name>"
  echo ""
  echo "Resume a NemoClaw sandbox after a reboot without losing data."
  echo ""
  echo "Examples:"
  echo "  $0 my-assistant"
  echo "  $0 my-assistant"
  echo ""
  echo "Environment:"
  echo "  DASHBOARD_PORT        Port to forward (default: 18789)"
  echo "  MOUNT_POINT           Where to mount sandbox data (default: ~/nemoclaw-sandbox/<name>)"
  echo "  HEALTH_TIMEOUT        Seconds to wait for gateway health (default: 120)"
  echo "  SANDBOX_READY_TIMEOUT Seconds to wait for sandbox ready (default: 60)"
  exit 1
fi

# Validate sandbox name (RFC 1123 subdomain)
if ! echo "$SANDBOX_NAME" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
  fail "Invalid sandbox name: '$SANDBOX_NAME'"
fi

GATEWAY_NAME="${OPENSHELL_GATEWAY:-openshell}"
CLUSTER_CONTAINER="openshell-cluster-${GATEWAY_NAME}"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-workspace.sh"
MOUNT_SCRIPT="${SCRIPT_DIR}/mount-sandbox.sh"
MOUNT_POINT="${MOUNT_POINT:-${HOME}/nemoclaw-sandbox/${SANDBOX_NAME}}"

# ── Step 1: Ensure Docker is running ─────────────────────────────

step 1 6 "Checking Docker"

if ! command -v docker >/dev/null 2>&1; then
  fail "Docker not found. Install Docker first."
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker daemon is not running."
fi

info "Docker is running"

# ── Step 2: Backup workspace (if sandbox is still reachable) ─────

step 2 6 "Backing up workspace"

# Attempt a backup from the current sandbox before any restart.
# This is a best-effort operation — if the sandbox is already down
# (e.g. after a hard reboot), we rely on the most recent prior backup.
if [ -f "$BACKUP_SCRIPT" ]; then
  sandbox_reachable=false
  # Check if gateway container is running AND sandbox is ready
  current_status="$(docker inspect --format '{{.State.Status}}' "$CLUSTER_CONTAINER" 2>/dev/null || echo "missing")"
  if [ "$current_status" = "running" ]; then
    sandbox_list="$(openshell sandbox list 2>&1 || true)"
    if echo "$sandbox_list" | grep -q "$SANDBOX_NAME" && echo "$sandbox_list" | grep "$SANDBOX_NAME" | grep -q "Ready"; then
      sandbox_reachable=true
    fi
  fi

  if [ "$sandbox_reachable" = "true" ]; then
    if bash "$BACKUP_SCRIPT" backup "$SANDBOX_NAME" 2>&1; then
      info "Workspace backed up"
    else
      warn "Backup failed (non-fatal) — will use most recent prior backup if needed"
    fi
  else
    info "Sandbox not reachable — skipping pre-restart backup"
  fi
else
  warn "backup-workspace.sh not found — workspace backup/restore disabled"
fi

# ── Step 3: Start the gateway container ──────────────────────────

step 3 6 "Starting gateway"

CONTAINER_STATUS="$(docker inspect --format '{{.State.Status}}' "$CLUSTER_CONTAINER" 2>/dev/null || echo "missing")"

case "$CONTAINER_STATUS" in
  running)
    info "Gateway container already running"
    ;;
  exited | created)
    info "Starting gateway container (preserving state)..."
    docker start "$CLUSTER_CONTAINER" >/dev/null
    info "Container started"
    ;;
  missing)
    fail "Gateway container '$CLUSTER_CONTAINER' not found. Run 'nemoclaw onboard' first."
    ;;
  *)
    fail "Gateway container is in unexpected state: $CONTAINER_STATUS"
    ;;
esac

# Wait for the container to become healthy
info "Waiting for gateway to become healthy (up to ${HEALTH_TIMEOUT}s)..."
elapsed=0
while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$CLUSTER_CONTAINER" 2>/dev/null || echo "unknown")"
  if [ "$health" = "healthy" ]; then
    break
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done

if [ "$health" != "healthy" ]; then
  fail "Gateway did not become healthy within ${HEALTH_TIMEOUT}s (status: $health). Check: docker logs $CLUSTER_CONTAINER"
fi

info "Gateway is healthy"

# ── Step 4: Wait for sandbox + restore workspace ─────────────────

step 4 6 "Waiting for sandbox '$SANDBOX_NAME'"

elapsed=0
ready=false
while [ "$elapsed" -lt "$SANDBOX_READY_TIMEOUT" ]; do
  sandbox_list="$(openshell sandbox list 2>&1 || true)"
  if echo "$sandbox_list" | grep -q "$SANDBOX_NAME" && echo "$sandbox_list" | grep "$SANDBOX_NAME" | grep -q "Ready"; then
    ready=true
    break
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done

if [ "$ready" != "true" ]; then
  warn "Sandbox '$SANDBOX_NAME' not ready after ${SANDBOX_READY_TIMEOUT}s."
  warn "Current sandbox state:"
  openshell sandbox list 2>&1 || true
  fail "Sandbox did not reach Ready state. Check: docker logs $CLUSTER_CONTAINER"
fi

info "Sandbox '$SANDBOX_NAME' is ready"

# Restore workspace from most recent backup
if [ -f "$BACKUP_SCRIPT" ]; then
  BACKUP_BASE="${HOME}/.nemoclaw/backups"
  if [ -d "$BACKUP_BASE" ] && [ -n "$(ls -A "$BACKUP_BASE" 2>/dev/null)" ]; then
    info "Restoring workspace from backup..."
    if bash "$BACKUP_SCRIPT" restore "$SANDBOX_NAME" 2>&1; then
      info "Workspace restored"
    else
      warn "Workspace restore failed (non-fatal) — sandbox is running but may lack prior session data"
    fi
  else
    info "No prior backups found — starting with fresh workspace"
  fi
fi

# ── Step 5: Port forward ─────────────────────────────────────────

step 5 6 "Setting up dashboard"

# Clean up any stale forward
openshell forward stop "$DASHBOARD_PORT" "$SANDBOX_NAME" 2>/dev/null || true

openshell forward start --background "$DASHBOARD_PORT" "$SANDBOX_NAME"

echo ""
echo -e "  ${GREEN}NemoClaw resumed successfully${NC}"

# ── Step 6: Mount sandbox data directory ──────────────────────────

step 6 6 "Mounting sandbox data"

if [ -f "$MOUNT_SCRIPT" ]; then
  if bash "$MOUNT_SCRIPT" mount "$SANDBOX_NAME" "$MOUNT_POINT" 2>&1; then
    info "Sandbox data mounted at ${MOUNT_POINT}"
  else
    warn "SSHFS mount failed (non-fatal) — use 'bash scripts/mount-sandbox.sh mount ${SANDBOX_NAME}' to retry"
  fi
else
  warn "mount-sandbox.sh not found — skipping SSHFS mount"
fi

echo ""
echo "  Dashboard:  http://127.0.0.1:${DASHBOARD_PORT}/"
echo "  Sandbox:    $SANDBOX_NAME"
echo "  Mounted:    ${MOUNT_POINT}"
echo "  Backups:    ~/.nemoclaw/backups/"
echo ""
echo "  Connect:    nemoclaw $SANDBOX_NAME connect"
echo "  Status:     nemoclaw $SANDBOX_NAME status"
echo "  Unmount:    bash scripts/mount-sandbox.sh unmount $SANDBOX_NAME"
echo "  Services:   nemoclaw start"
echo ""
