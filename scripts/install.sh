#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# CodeFactory installer — curl-pipe-bash one-liner
#   curl -fsSL https://raw.githubusercontent.com/yasha-dev1/codefactory/main/scripts/install.sh | bash
#
# Environment variables:
#   CODEFACTORY_INSTALL_DIR  — override the default install location
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────
REPO="yasha-dev1/codefactory"
DEFAULT_INSTALL_DIR="$HOME/.codefactory/bin"
MIN_NODE_VERSION=20

# ── Helpers ──────────────────────────────────────────────────────────
info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[warn]\033[0m  %s\n' "$*" >&2; }
error() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Check Node.js ────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  error "Node.js is not installed. Please install Node.js >= ${MIN_NODE_VERSION} first."
fi

NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt "$MIN_NODE_VERSION" ]; then
  error "Node.js v${NODE_MAJOR} detected — v${MIN_NODE_VERSION}+ is required."
fi
info "Node.js v$(node --version | sed 's/^v//') detected."

# ── 2. Detect platform ──────────────────────────────────────────────
OS=$(uname -s)
case "$OS" in
  Linux)  PLATFORM="linux"  ;;
  Darwin) PLATFORM="darwin" ;;
  *)      warn "Unsupported platform: ${OS}. Proceeding anyway."; PLATFORM="unknown" ;;
esac
info "Platform: ${PLATFORM}"

# ── 3. Resolve install directory ─────────────────────────────────────
INSTALL_DIR="${CODEFACTORY_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"
info "Install directory: ${INSTALL_DIR}"

# ── 4. Fetch latest release URL ─────────────────────────────────────
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
info "Fetching latest release from ${API_URL} ..."

RELEASE_JSON=$(curl -fsSL "$API_URL")

# Extract the binary download URL for the 'codefactory' asset (no jq dependency).
# Anchor to /codefactory" so we only match URLs whose filename is exactly "codefactory",
# avoiding false matches on other assets whose URL path contains the repo name.
BINARY_URL=$(printf '%s' "$RELEASE_JSON" \
  | grep -o '"browser_download_url":[[:space:]]*"[^"]*/codefactory"' \
  | head -1 \
  | sed 's/"browser_download_url":[[:space:]]*"//;s/"$//')

if [ -z "$BINARY_URL" ]; then
  error "Could not find a 'codefactory' binary asset in the latest release."
fi
info "Binary URL: ${BINARY_URL}"

# ── 5. Download binary ──────────────────────────────────────────────
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL -o "${TMP_DIR}/codefactory" "$BINARY_URL"
info "Downloaded binary to temp directory."

# ── 6. Download and verify checksum ─────────────────────────────────
CHECKSUM_URL=$(printf '%s' "$RELEASE_JSON" \
  | grep -o '"browser_download_url":[[:space:]]*"[^"]*checksums\.sha256[^"]*"' \
  | head -1 \
  | sed 's/"browser_download_url":[[:space:]]*"//;s/"$//')

if [ -n "$CHECKSUM_URL" ]; then
  curl -fsSL -o "${TMP_DIR}/checksums.sha256" "$CHECKSUM_URL"

  # Use sha256sum (Linux) or shasum (macOS) for verification
  if command -v sha256sum >/dev/null 2>&1; then
    SHA_CMD="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHA_CMD="shasum -a 256"
  else
    warn "Neither sha256sum nor shasum found — skipping checksum verification."
    SHA_CMD=""
  fi

  if [ -n "$SHA_CMD" ]; then
    EXPECTED=$(grep 'codefactory' "${TMP_DIR}/checksums.sha256" | awk '{print $1}')
    ACTUAL=$($SHA_CMD "${TMP_DIR}/codefactory" | awk '{print $1}')
    if [ "$EXPECTED" != "$ACTUAL" ]; then
      error "Checksum mismatch! Expected ${EXPECTED}, got ${ACTUAL}."
    fi
    info "Checksum verified."
  fi
else
  warn "No checksums.sha256 asset found — skipping verification."
fi

# ── 7. Install binary ───────────────────────────────────────────────
mv "${TMP_DIR}/codefactory" "${INSTALL_DIR}/codefactory"
chmod +x "${INSTALL_DIR}/codefactory"
info "Installed codefactory to ${INSTALL_DIR}/codefactory"

# ── 8. Add to PATH in shell rc file ─────────────────────────────────
PATH_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""

add_to_rc() {
  local rc_file="$1"
  if [ -f "$rc_file" ] && grep -qF "$INSTALL_DIR" "$rc_file"; then
    info "PATH already configured in ${rc_file}"
  else
    printf '\n# Added by CodeFactory installer\n%s\n' "$PATH_LINE" >> "$rc_file"
    info "Added ${INSTALL_DIR} to PATH in ${rc_file}"
  fi
}

# Detect current shell and update the appropriate rc file
CURRENT_SHELL=$(basename "${SHELL:-bash}")
case "$CURRENT_SHELL" in
  zsh)  add_to_rc "$HOME/.zshrc"   ;;
  fish)
    # fish uses a different syntax for PATH
    FISH_CONFIG="${HOME}/.config/fish/config.fish"
    mkdir -p "$(dirname "$FISH_CONFIG")"
    if [ -f "$FISH_CONFIG" ] && grep -qF "$INSTALL_DIR" "$FISH_CONFIG"; then
      info "PATH already configured in ${FISH_CONFIG}"
    else
      printf '\n# Added by CodeFactory installer\nset -gx PATH %s $PATH\n' "$INSTALL_DIR" >> "$FISH_CONFIG"
      info "Added ${INSTALL_DIR} to PATH in ${FISH_CONFIG}"
    fi
    ;;
  *)    add_to_rc "$HOME/.bashrc"  ;;
esac

# Make the binary available in the current session
export PATH="${INSTALL_DIR}:$PATH"

# ── 9. Verify installation ──────────────────────────────────────────
if codefactory --version >/dev/null 2>&1; then
  VERSION=$(codefactory --version)
  info "Verification passed: codefactory ${VERSION}"
else
  warn "Could not verify installation — 'codefactory --version' failed."
  warn "You may need to restart your shell or run: export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

# ── Done ─────────────────────────────────────────────────────────────
printf '\n\033[1;32mCodeFactory installed successfully!\033[0m\n'
printf 'Run \033[1mcodefactory --help\033[0m to get started.\n'
