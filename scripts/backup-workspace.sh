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

  # Back up each data directory in full, but skip workspace/git — git repos
  # can be re-cloned from remote and dominate backup size unnecessarily.
  for d in "${BACKUP_DIRS[@]}"; do
    if [ "$d" = "workspace" ]; then
      # Download workspace sub-dirs individually, excluding git/
      for sub in .openclaw memory; do
        if openshell sandbox download "$sandbox" "${DATA_ROOT}/workspace/${sub}/" "${dest}/workspace/${sub}/" 2>/dev/null; then
          info "  ✓ workspace/${sub}/"
        fi
      done
      # Also grab any loose files one level under workspace/ (e.g. AGENTS.md etc)
      openshell sandbox download "$sandbox" "${DATA_ROOT}/workspace/" "${dest}/workspace/" 2>/dev/null || true
      # Remove the git dir from the download if it crept in
      rm -rf "${dest}/workspace/git"
      count=$((count + 1))
      info "  ✓ workspace/ (git/ excluded — re-clone from remote)"
    elif openshell sandbox download "$sandbox" "${DATA_ROOT}/${d}/" "${dest}/${d}/" 2>&1; then
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

  # Remove any symlinks from the backup — symlinks (especially circular ones like
  # ./_codeql_detected_source_root -> . or log/latest -> latest_build) cause
  # "symbolic link loop" errors when openshell sandbox upload traverses the tree.
  local symlink_count=0
  while IFS= read -r -d '' link; do
    rm -f "$link"
    symlink_count=$((symlink_count + 1))
  done < <(find "$dest" -type l -print0 2>/dev/null)
  if [ "$symlink_count" -gt 0 ]; then
    info "  Removed ${symlink_count} symlink(s) from backup (not needed for restore)"
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
      if [ "$d" = "workspace" ]; then
        # Skip workspace/git — those repos must be re-cloned from remote.
        # Upload each sub-dir of workspace/ except git/.
        local ws_count=0
        for sub in "${src}/workspace/"/*/; do
          local sub_name
          sub_name="$(basename "$sub")"
          [ "$sub_name" = "git" ] && continue
          if openshell sandbox upload "$sandbox" "$sub" "${DATA_ROOT}/workspace/${sub_name}/" 2>&1; then
            ws_count=$((ws_count + 1))
          fi
        done
        # Upload any loose files directly under workspace/
        for f in "${src}/workspace/"*; do
          [ -f "$f" ] || continue
          openshell sandbox upload "$sandbox" "$f" "${DATA_ROOT}/workspace/" 2>/dev/null || true
        done
        count=$((count + 1))
        info "  ✓ workspace/ (${ws_count} sub-dirs, git/ skipped — re-clone from remote)"
      else
        if openshell sandbox upload "$sandbox" "${src}/${d}/" "${DATA_ROOT}/${d}/" 2>&1; then
          count=$((count + 1))
          info "  ✓ ${d}/"
        else
          warn "  Failed to restore ${d}/"
        fi
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
