#!/usr/bin/env bash
# Install the harnext CLI globally via npm.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/yasha-dev1/codefactory/main/scripts/install.sh | bash
#
# Requires Node.js >= 20 and npm to already be on PATH.

set -euo pipefail

PACKAGE="harnext"
MIN_NODE_MAJOR=20

err() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  err "node is not installed or not on PATH. Install Node.js >= ${MIN_NODE_MAJOR} from https://nodejs.org/ and try again."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  err "npm is not installed or not on PATH. Install Node.js (which ships with npm) and try again."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt "${MIN_NODE_MAJOR}" ]; then
  err "Node.js >= ${MIN_NODE_MAJOR} is required (found $(node -v))."
  exit 1
fi

info "Installing ${PACKAGE} globally via npm..."
npm install -g "${PACKAGE}"

if ! command -v "${PACKAGE}" >/dev/null 2>&1; then
  err "Install completed but '${PACKAGE}' is not on PATH. Check 'npm config get prefix' and ensure its bin directory is on PATH."
  exit 1
fi

INSTALLED_VERSION="$("${PACKAGE}" --version 2>/dev/null || echo 'unknown')"
info "Installed ${PACKAGE} ${INSTALLED_VERSION}. Run '${PACKAGE} --help' to get started."

# Fresh terminals will see the new binary immediately, but the *current*
# shell may have cached a negative lookup for `${PACKAGE}` in its command
# hash. Tell the user exactly how to refresh the current shell so they
# don't have to open a new terminal.
case "$(basename "${SHELL:-}")" in
  zsh) REFRESH_CMD="rehash" ;;
  bash) REFRESH_CMD="hash -r" ;;
  fish) REFRESH_CMD="" ;; # fish rescans $PATH automatically
  *) REFRESH_CMD="hash -r" ;;
esac

if [ -n "${REFRESH_CMD}" ]; then
  info "If '${PACKAGE}' is not found in your current terminal, run '${REFRESH_CMD}' to refresh it (or open a new terminal)."
fi
