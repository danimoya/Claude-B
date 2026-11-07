#!/usr/bin/env bash
# Persistent container-backed CLI. Each invocation enters the mounted repository.
set -euo pipefail
if [ "$(id -u)" -eq 0 ]; then echo 'Run the Docker CLI as a non-root repository owner.' >&2; exit 1; fi
image=${CB_DOCKER_IMAGE:?Set CB_DOCKER_IMAGE to a verified local build or immutable published image}
container=${CB_DOCKER_CONTAINER:-claude-b-$(id -u)}
container_user="$(id -u):$(id -g)"
data_dir=${CB_DOCKER_DATA_DIR:-${CB_DATA_DIR:-$HOME/.claude-b}}

existing_workspace=$(docker inspect --format '{{index .Config.Labels "com.claude-b.workspace"}}' "$container" 2>/dev/null || true)
workspace=${CB_DOCKER_WORKSPACE:-${existing_workspace:-$PWD}}
workspace=$(cd -- "$workspace" && pwd -P)
caller_dir=$(pwd -P)
case "$caller_dir" in
  "$workspace") container_cwd=/workspace ;;
  "$workspace"/*) container_cwd="/workspace${caller_dir#"$workspace"}" ;;
  *) echo 'Current directory is outside the container workspace; set CB_DOCKER_WORKSPACE and use a separate CB_DOCKER_CONTAINER.' >&2; exit 1 ;;
esac
mkdir -p -- "$data_dir"
data_dir=$(cd -- "$data_dir" && pwd -P)
if [[ "$data_dir" == *,* || "$workspace" == *,* ]]; then echo 'Docker bind paths cannot contain commas.' >&2; exit 1; fi

if [ -n "$existing_workspace" ]; then
  if [ "$existing_workspace" != "$workspace" ]; then echo 'Container workspace differs; choose a separate CB_DOCKER_CONTAINER.' >&2; exit 1; fi
  existing_state=$(docker inspect --format '{{index .Config.Labels "com.claude-b.state"}}' "$container")
  existing_image=$(docker inspect --format '{{index .Config.Labels "com.claude-b.image"}}' "$container")
  existing_user=$(docker inspect --format '{{index .Config.Labels "com.claude-b.user"}}' "$container")
  if [ "$existing_state" != "$data_dir" ] || [ "$existing_image" != "$image" ] || [ "$existing_user" != "$container_user" ]; then
    echo 'Container state/image/user metadata differs or is incomplete; migrate explicitly or choose another CB_DOCKER_CONTAINER.' >&2
    exit 1
  fi
  running=$(docker inspect --format '{{.State.Running}}' "$container")
  if [ "$running" != true ]; then docker start "$container" >/dev/null; fi
else
  options=(run --detach --name "$container" --label "com.claude-b.workspace=$workspace"
    --label "com.claude-b.state=$data_dir" --label "com.claude-b.image=$image" --label "com.claude-b.user=$container_user"
    --user "$container_user"
    --mount "type=bind,source=$data_dir,target=/home/node/.claude-b"
    --mount "type=bind,source=$workspace,target=/workspace")
  if [ -f "$data_dir/.env" ]; then options+=(--env-file "$data_dir/.env"); fi
  # Runtime secrets may come from the state env file. Container infrastructure
  # always uses the mapped paths, even when that file came from a host install.
  options+=(--env CB_DATA_DIR=/home/node/.claude-b --env CB_REST_HOST=0.0.0.0
    --env CB_REST_PORT=3847 --env CLAUDE_CONFIG_DIR=/home/node/.claude-b/claude)
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then options+=(--env ANTHROPIC_API_KEY); fi
  if [ -n "${CB_DOCKER_PORT:-}" ]; then options+=(--publish "127.0.0.1:$CB_DOCKER_PORT:3847"); fi
  docker "${options[@]}" "$image" >/dev/null
fi

ready=false
for ((attempt=0; attempt<100; attempt++)); do
  if docker exec "$container" node /app/scripts/container-ready.mjs health >/dev/null 2>&1; then ready=true; break; fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then echo 'Claude-B container exited during startup; inspect its logs.' >&2; exit 1; fi
  sleep 0.1
done
if [ "$ready" != true ]; then echo 'Claude-B container readiness timed out.' >&2; exit 1; fi
terminal=(-i)
if [ -t 0 ] && [ -t 1 ]; then terminal+=(-t); fi
exec docker exec "${terminal[@]}" --workdir "$container_cwd" "$container" cb "$@"
