#!/usr/bin/env bash
# Claude-B installer
# Usage:
#   curl -fsSL https://cb.danielmoya.cv | bash
#   curl -fsSL https://cb.danielmoya.cv | bash -s -- --method npm
#
# Methods (auto-detected, override with --method):
#   npm     — requires node >= 20
#   docker  — pulls ghcr.io/danimoya/claude-b:latest
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
  say "Pulling Docker image ${GHCR_IMAGE}:latest"
  docker pull "${GHCR_IMAGE}:latest"

  local shim="/usr/local/bin/cb"
  local data_dir="${HOME}/.claude-b"
  mkdir -p "$data_dir"

  say "Writing shim to ${shim}"
  local shim_content
  shim_content=$(cat <<EOF
#!/usr/bin/env bash
# Claude-B docker shim
exec docker run --rm -it \\
  -v "\${HOME}/.claude-b:/root/.claude-b" \\
  --env-file "\${HOME}/.claude-b/.env" 2>/dev/null || \\
exec docker run --rm -it \\
  -v "\${HOME}/.claude-b:/root/.claude-b" \\
  ${GHCR_IMAGE}:latest "\$@"
EOF
)
  if [ -w "$(dirname "$shim")" ]; then
    printf '%s\n' "$shim_content" > "$shim"
    chmod +x "$shim"
  elif have sudo; then
    printf '%s\n' "$shim_content" | sudo tee "$shim" >/dev/null
    sudo chmod +x "$shim"
  else
    fail "cannot write to $shim (no sudo). try --method npm or run as root."
  fi
  say "${GREEN}✓ installed${RESET}: $shim"
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
