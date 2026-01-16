#!/bin/sh
set -e

# Start daemon in background
node /app/dist/daemon/index.js &
DAEMON_PID=$!

# Wait for socket to be ready
SOCKET_PATH="$HOME/.claude-b/daemon.sock"
echo "Waiting for daemon..."
for i in $(seq 1 30); do
  if [ -S "$SOCKET_PATH" ]; then
    echo "Daemon ready"
    break
  fi
  sleep 0.1
done

# Start REST API
echo "Starting REST API..."
node /app/dist/cli/index.js --rest ${REST_PORT:-3847}

# Keep container running
wait $DAEMON_PID
