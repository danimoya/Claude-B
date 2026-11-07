#!/usr/bin/env bash
# Repository-aware foreground launcher. The daemon owns state/lock cleanup.
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
node_bin=${CB_NODE_BIN:-$(command -v node)}
exec "$node_bin" "$script_dir/dist/daemon/index.js"
