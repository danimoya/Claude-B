#!/usr/bin/env bash
# Claude-B daemon startup script for systemd
# Cleans stale files, starts the daemon, then enables the REST API.

set -euo pipefail

# The daemon owns pid/socket/lock cleanup. Do not remove them here: doing so
# can defeat duplicate-instance protection when system and user units coexist.

# Start daemon (foreground — systemd manages the process)
exec /usr/bin/node /home/app/Claude-B/dist/daemon/index.js
