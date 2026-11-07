#!/bin/sh
set -eu

# Explicit commands such as `cb --version` run without starting a daemon.
if [ "$#" -gt 0 ]; then exec "$@"; fi
if [ "$(id -u)" -eq 0 ]; then
  echo 'Run the Claude-B daemon as a non-root repository owner.' >&2
  exit 1
fi

node /app/dist/daemon/index.js &
daemon_pid=$!
cleanup() {
  trap - EXIT TERM INT HUP
  if [ -n "$daemon_pid" ]; then
    kill -TERM "$daemon_pid" 2>/dev/null || true
    attempts=0
    while kill -0 "$daemon_pid" 2>/dev/null && [ "$attempts" -lt 50 ]; do
      sleep 0.1
      attempts=$((attempts + 1))
    done
    kill -KILL "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

CB_EXPECTED_DAEMON_PID="$daemon_pid" node /app/scripts/container-ready.mjs start
status=0
wait "$daemon_pid" || status=$?
daemon_pid=''
exit "$status"
