#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Mount / unmount a NemoClaw sandbox's data directory via SSHFS.
#
# The sandbox SSH server (russh) doesn't ship with sftp-server, so the
# first mount uploads one from the host into the sandbox automatically.
#
# Usage:
#   ./scripts/mount-sandbox.sh mount   <sandbox-name> [mount-point]
#   ./scripts/mount-sandbox.sh unmount <sandbox-name> [mount-point]
#   ./scripts/mount-sandbox.sh status  <sandbox-name> [mount-point]
#
# Default mount-point: ~/nemoclaw-sandbox/<sandbox-name>

set -euo pipefail

DATA_ROOT="/sandbox/.openclaw-data"
MOUNT_BASE="${HOME}/nemoclaw-sandbox"
SSH_HOST_PREFIX="openshell-"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[mount]${NC} $1"; }
warn() { echo -e "${YELLOW}[mount]${NC} $1"; }
fail() {
  echo -e "${RED}[mount]${NC} $1" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  $(basename "$0") mount   <sandbox-name> [mount-point]
  $(basename "$0") unmount <sandbox-name> [mount-point]
  $(basename "$0") status  <sandbox-name> [mount-point]

Mount the sandbox data directory (${DATA_ROOT}) to a local folder
via SSHFS so you can browse and edit files while the sandbox is live.

Default mount-point: ${MOUNT_BASE}/<sandbox-name>
EOF
  exit 1
}

# Ensure the SSH config entry exists for this sandbox.
ensure_ssh_config() {
  local sandbox="$1"
  local host="${SSH_HOST_PREFIX}${sandbox}"
  local config="${HOME}/.ssh/config"

  if grep -q "^Host ${host}$" "$config" 2>/dev/null; then
    return 0
  fi

  mkdir -p "${HOME}/.ssh"
  chmod 0700 "${HOME}/.ssh"

  # Append a newline + the config block
  {
    echo ""
    openshell sandbox ssh-config "$sandbox"
  } >>"$config"
  chmod 0600 "$config"
  info "Added SSH config for ${host}"
}

# Upload sftp-server to the sandbox if it's missing.
ensure_sftp_server() {
  local sandbox="$1"
  local host="${SSH_HOST_PREFIX}${sandbox}"
  local remote_sftp="${DATA_ROOT}/sftp-server/sftp-server"

  # Quick check — does the binary already exist inside the sandbox?
  if ssh -o ConnectTimeout=10 "$host" "test -x ${remote_sftp}" 2>/dev/null; then
    return 0
  fi

  # Find sftp-server on the host
  local host_sftp="/usr/lib/openssh/sftp-server"
  if [ ! -x "$host_sftp" ]; then
    host_sftp="$(find /usr/lib /usr/libexec -name sftp-server -type f 2>/dev/null | head -1)"
  fi

  if [ -z "$host_sftp" ] || [ ! -x "$host_sftp" ]; then
    fail "sftp-server not found on host. Install: sudo apt-get install -y openssh-sftp-server"
  fi

  info "Uploading sftp-server to sandbox..."
  openshell sandbox upload "$sandbox" "$host_sftp" "${DATA_ROOT}/sftp-server" >/dev/null 2>&1
  ssh -o ConnectTimeout=10 "$host" "chmod +x ${remote_sftp}" 2>/dev/null \
    || fail "Failed to set execute permission on sftp-server inside sandbox."
}

do_mount() {
  local sandbox="$1"
  local mountpoint="$2"
  local host="${SSH_HOST_PREFIX}${sandbox}"
  local remote_sftp="${DATA_ROOT}/sftp-server/sftp-server"

  # Already mounted?
  if mountpoint -q "$mountpoint" 2>/dev/null; then
    info "Already mounted at ${mountpoint}"
    return 0
  fi

  # Pre-flight
  command -v sshfs >/dev/null 2>&1 \
    || fail "sshfs not found. Install: sudo apt-get install -y sshfs"
  command -v openshell >/dev/null 2>&1 \
    || fail "openshell not found in PATH."

  ensure_ssh_config "$sandbox"
  ensure_sftp_server "$sandbox"

  mkdir -p "$mountpoint"
  # Ensure current user owns the mountpoint (a previous SSHFS mount may have
  # left it owned by the sandbox uid, causing fusermount3 permission denied).
  if [ "$(stat -c '%U' "$mountpoint")" != "$(id -un)" ]; then
    sudo chown "$(id -un):$(id -gn)" "$mountpoint" \
      || warn "Could not chown ${mountpoint} — mount may fail if owned by another user."
  fi

  info "Mounting ${host}:${DATA_ROOT} → ${mountpoint}"

  sshfs "${host}:${DATA_ROOT}" "$mountpoint" \
    -o "sftp_server=${remote_sftp}" \
    -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3 \
    || fail "SSHFS mount failed."

  info "Mounted successfully"
  echo ""
  echo "  Mount:  ${mountpoint}"
  echo "  Remote: ${host}:${DATA_ROOT}"
  echo ""
  echo "  Workspace: ${mountpoint}/workspace/"
  echo "  Sessions:  ${mountpoint}/agents/"
  echo ""
  echo "  Unmount:   $(basename "$0") unmount ${sandbox}"
}

do_unmount() {
  local mountpoint="$1"

  if ! mountpoint -q "$mountpoint" 2>/dev/null; then
    info "Not mounted at ${mountpoint}"
    return 0
  fi

  fusermount -u "$mountpoint" \
    || fail "Failed to unmount ${mountpoint}. Try: fusermount -uz ${mountpoint}"

  info "Unmounted ${mountpoint}"
}

do_status() {
  local mountpoint="$1"

  if mountpoint -q "$mountpoint" 2>/dev/null; then
    info "Mounted at ${mountpoint}"
    echo "  Contents:"
    find "$mountpoint" -maxdepth 1 -mindepth 1 -printf '    %f\n' 2>/dev/null
  else
    info "Not mounted at ${mountpoint}"
  fi
}

# ── Main ──────────────────────────────────────────────────────────

[ $# -ge 2 ] || usage

action="$1"
sandbox="$2"
mountpoint="${3:-${MOUNT_BASE}/${sandbox}}"

case "$action" in
  mount) do_mount "$sandbox" "$mountpoint" ;;
  unmount) do_unmount "$mountpoint" ;;
  status) do_status "$mountpoint" ;;
  *) usage ;;
esac
