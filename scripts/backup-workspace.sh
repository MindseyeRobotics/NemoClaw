#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# The writable data root inside the sandbox.  All agent-created files
# (workspace, sessions, canvas, cron, identity, etc.) live here.
DATA_ROOT="/sandbox/.openclaw-data"
BACKUP_BASE="${HOME}/.nemoclaw/backups"

# Directories inside DATA_ROOT to back up.  Each is downloaded in full
# so that any files or sub-folders the agents created are captured.
# Order matters only for display; everything is backed up/restored.
BACKUP_DIRS=(workspace agents canvas cron devices hooks identity skills)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[backup]${NC} $1"; }
warn() { echo -e "${YELLOW}[backup]${NC} $1"; }
fail() {
  echo -e "${RED}[backup]${NC} $1" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  $(basename "$0") backup  <sandbox-name>
  $(basename "$0") restore <sandbox-name> [timestamp]

Commands:
  backup   Download ALL sandbox data to a timestamped local backup.
           Captures workspace files, agent sessions, canvas, cron jobs,
           device pairings, hooks, identity, and skills.
  restore  Upload a backup into a sandbox.
           If no timestamp is given, the most recent backup is used.

Backup location: ${BACKUP_BASE}/<timestamp>/
EOF
  exit 1
}

do_backup() {
  local sandbox="$1"
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  local dest="${BACKUP_BASE}/${ts}"

  mkdir -p "$BACKUP_BASE"
  chmod 0700 "${HOME}/.nemoclaw" "$BACKUP_BASE" \
    || fail "Failed to set secure permissions on ${HOME}/.nemoclaw — check directory ownership."
  mkdir -p "$dest"
  chmod 0700 "$dest"

  info "Backing up sandbox data from '${sandbox}'..."

  local count=0

  # Back up each data directory in full
  for d in "${BACKUP_DIRS[@]}"; do
    if openshell sandbox download "$sandbox" "${DATA_ROOT}/${d}/" "${dest}/${d}/" 2>&1; then
      count=$((count + 1))
      info "  ✓ ${d}/"
    else
      warn "  Skipped ${d}/ (not found or empty)"
    fi
  done

  # Also grab any loose files in DATA_ROOT (e.g. update-check.json)
  if openshell sandbox download "$sandbox" "${DATA_ROOT}/update-check.json" "${dest}/" 2>/dev/null; then
    count=$((count + 1))
  fi

  if [ "$count" -eq 0 ]; then
    fail "No data was backed up. Check that the sandbox '${sandbox}' exists and has data."
  fi

  # Write a manifest so we know what's in this backup
  find "$dest" -type f | wc -l >"${dest}/.file-count"
  info "Backup saved to ${dest}/ (${count} directories, $(cat "${dest}/.file-count") files)"
}

do_restore() {
  local sandbox="$1"
  local ts="${2:-}"

  if [ -z "$ts" ]; then
    ts="$(find "$BACKUP_BASE" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -r | head -n1 || true)"
    [ -n "$ts" ] || fail "No backups found in ${BACKUP_BASE}/"
    info "Using most recent backup: ${ts}"
  fi

  local src="${BACKUP_BASE}/${ts}"
  [ -d "$src" ] || fail "Backup directory not found: ${src}"

  info "Restoring sandbox data to '${sandbox}' from ${src}..."

  local count=0

  for d in "${BACKUP_DIRS[@]}"; do
    if [ -d "${src}/${d}" ]; then
      if openshell sandbox upload "$sandbox" "${src}/${d}/" "${DATA_ROOT}/${d}/" 2>&1; then
        count=$((count + 1))
        info "  ✓ ${d}/"
      else
        warn "  Failed to restore ${d}/"
      fi
    fi
  done

  # Restore loose files
  if [ -f "${src}/update-check.json" ]; then
    openshell sandbox upload "$sandbox" "${src}/update-check.json" "${DATA_ROOT}/" 2>/dev/null || true
  fi

  if [ "$count" -eq 0 ]; then
    fail "No data was restored. Check that the sandbox '${sandbox}' is running."
  fi

  info "Restored ${count} directories to sandbox '${sandbox}'."
}

# --- Main ---

[ $# -ge 2 ] || usage
command -v openshell >/dev/null 2>&1 || fail "'openshell' is required but not found in PATH."

action="$1"
sandbox="$2"
shift 2

case "$action" in
  backup) do_backup "$sandbox" ;;
  restore) do_restore "$sandbox" "$@" ;;
  *) usage ;;
esac
