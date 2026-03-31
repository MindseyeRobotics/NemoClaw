#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Back up all registered NemoClaw sandboxes and prune old backups,
# keeping only the most recent KEEP_BACKUPS snapshots.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SANDBOXES_FILE="${HOME}/.nemoclaw/sandboxes.json"
BACKUP_BASE="${HOME}/.nemoclaw/backups"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"

log() { echo "$(date '+%H:%M:%S') [nemoclaw-backup] $*"; }

if [[ ! -f "${SANDBOXES_FILE}" ]]; then
  log "No sandboxes registry found — nothing to back up"
  exit 0
fi

# Check at least one sandbox is reachable before attempting
if ! openshell sandbox list >/dev/null 2>&1; then
  log "Gateway not reachable — skipping backup"
  exit 0
fi

SANDBOXES=$(python3 -c "
import json
d = json.load(open('${SANDBOXES_FILE}'))
sbs = d.get('sandboxes', {})
names = [sb.get('name','') for sb in (sbs.values() if isinstance(sbs, dict) else sbs)]
print('\n'.join(n for n in names if n))
" 2>/dev/null || true)

if [[ -z "${SANDBOXES}" ]]; then
  log "No sandboxes registered — nothing to back up"
  exit 0
fi

BACKED_UP=0
FAILED=0

while IFS= read -r name; do
  [[ -z "${name}" ]] && continue

  # Only back up sandboxes that are in Ready state
  if ! openshell sandbox list 2>/dev/null | grep -q "${name}"; then
    log "Skipping '${name}' — not found in openshell"
    continue
  fi

  log "Backing up '${name}'..."
  if bash "${SCRIPT_DIR}/backup-workspace.sh" backup "${name}"; then
    log "  ✓ ${name} backed up"
    BACKED_UP=$((BACKED_UP + 1))
  else
    log "  ✗ ${name} backup failed"
    FAILED=$((FAILED + 1))
  fi
done <<<"${SANDBOXES}"

# Prune old backups — keep only the most recent KEEP_BACKUPS directories
if [[ -d "${BACKUP_BASE}" ]]; then
  # List dirs sorted oldest-first, remove all but the last KEEP_BACKUPS
  mapfile -t ALL_BACKUPS < <(find "${BACKUP_BASE}" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9]*' 2>/dev/null | sort)
  TOTAL=${#ALL_BACKUPS[@]}
  TO_DELETE=$((TOTAL - KEEP_BACKUPS))
  if [[ "${TO_DELETE}" -gt 0 ]]; then
    log "Pruning ${TO_DELETE} old backup(s) (keeping last ${KEEP_BACKUPS})..."
    for ((i = 0; i < TO_DELETE; i++)); do
      log "  Removing ${ALL_BACKUPS[$i]}"
      rm -rf "${ALL_BACKUPS[$i]}"
    done
  else
    log "Backup count (${TOTAL}) within limit (${KEEP_BACKUPS}) — no pruning needed"
  fi
fi

log "Done: ${BACKED_UP} backed up, ${FAILED} failed"
[[ "${FAILED}" -eq 0 ]]
