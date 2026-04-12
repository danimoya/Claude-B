#!/usr/bin/env bash
# Claude-B daemon startup script for systemd
# Cleans stale files, starts the daemon, then enables the REST API.

set -euo pipefail

SOCK="$HOME/.claude-b/daemon.sock"
PID_FILE="$HOME/.claude-b/daemon.pid"
REST_PORT="${CB_REST_PORT:-3847}"

# Clean stale files from previous crash
rm -f "$SOCK" "$PID_FILE"

# Start daemon (foreground — systemd manages the process)
exec /usr/bin/node /home/app/Claude-B/dist/daemon/index.js
