#!/usr/bin/env bash
# Claude-B installer
# Usage:
#   curl -fsSL https://cb.danimoya.com | bash
#   curl -fsSL https://cb.danimoya.com | bash -s -- --method npm
#
# Methods (auto-detected, override with --method):
#   npm     — requires node >= 20
#   docker  — installs a persistent container CLI (pinned release image)
#   auto    — prefers npm, falls back to docker (default)
set -euo pipefail

REPO="${CLAUDE_B_REPO:-danimoya/Claude-B}"
GHCR_IMAGE="ghcr.io/${REPO,,}"
METHOD="auto"
SKIP_INIT=0

for arg in "$@"; do
  case "$arg" in
    --method=*) METHOD="${arg#*=}" ;;
    --method) shift; METHOD="${1:-auto}" ;;
    --skip-init) SKIP_INIT=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

RESET='\033[0m'; BOLD='\033[1m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; GRAY='\033[90m'

say()  { printf '%b\n' "${BOLD}==>${RESET} $*"; }
warn() { printf '%b\n' "${YELLOW}warning:${RESET} $*" >&2; }
fail() { printf '%b\n' "${RED}error:${RESET} $*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

check_node() {
  have node || return 1
  local major; major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] || return 1
}

pick_method() {
  case "$METHOD" in
    npm|docker) return 0 ;;
    auto)
      if check_node && have npm; then METHOD=npm
      elif have docker; then METHOD=docker
      else fail "neither node>=20 nor docker found. install one and re-run, or pick --method"
      fi
      ;;
    *) fail "unknown --method '$METHOD' (use npm|docker|auto)" ;;
  esac
}

install_npm() {
  say "Installing Claude-B via npm"
  if [ "$(id -u)" -ne 0 ] && [ ! -w "$(npm prefix -g 2>/dev/null || echo /usr/local)" ]; then
    warn "global npm install may need sudo"
    if have sudo; then
      sudo npm install -g claude-b
    else
      npm install -g claude-b
    fi
  else
    npm install -g claude-b
  fi
  say "${GREEN}✓ installed${RESET}: $(command -v cb)"
}

install_docker() {
  local version="${CLAUDE_B_VERSION:-0.7.0}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail "invalid CLAUDE_B_VERSION"
  [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "invalid CLAUDE_B_REPO"
  local image="${CB_DOCKER_IMAGE:-}"
  [ -n "$image" ] || fail "set CB_DOCKER_IMAGE to a verified local build or immutable published image"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    say "Pulling explicitly selected Docker image ${image}"
    docker pull "$image"
  fi

  local bin_dir="${CLAUDE_B_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$bin_dir"
  local helper_file
  helper_file=$(mktemp)
  if [ -f "$(dirname -- "${BASH_SOURCE[0]}")/docker-launcher.sh" ]; then
    cp "$(dirname -- "${BASH_SOURCE[0]}")/docker-launcher.sh" "$helper_file"
  else
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/v${version}/scripts/docker-launcher.sh" -o "$helper_file" || { rm -f "$helper_file"; fail "cannot download versioned Docker launcher"; }
  fi
  {
    printf '#!/usr/bin/env bash\n'
    printf 'export CB_DOCKER_IMAGE=%q\n' "$image"
    tail -n +2 "$helper_file"
  } > "$bin_dir/cb"
  rm -f "$helper_file"
  chmod +x "$bin_dir/cb"
  say "${GREEN}✓ installed${RESET}: $bin_dir/cb (ensure this directory is on PATH)"
}

main() {
  say "${BOLD}Claude-B installer${RESET}"
  pick_method
  say "Method: ${BOLD}${METHOD}${RESET}"

  case "$METHOD" in
    npm)    install_npm ;;
    docker) install_docker ;;
  esac

  if [ "$SKIP_INIT" -eq 0 ]; then
    say "Running ${BOLD}cb init${RESET} to configure your environment"
    echo
    cb init || warn "init skipped — rerun with: cb init"
  else
    say "Install complete. Configure with: ${BOLD}cb init${RESET}"
  fi
}

main "$@"
