#!/usr/bin/env bash
# install.sh — build ashlr-hub and install the `ashlr` CLI into ~/.local/bin
#
# Idempotent: safe to re-run after pulling updates.
# Usage: ./install.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="$REPO_DIR/bin/ashlr"
INSTALL_DIR="$HOME/.local/bin"
INSTALL_DEST="$INSTALL_DIR/ashlr"

# ── colours ──────────────────────────────────────────────────────────────────
bold='\033[1m'
green='\033[0;32m'
yellow='\033[0;33m'
red='\033[0;31m'
reset='\033[0m'

log()  { printf "  ${bold}%s${reset}\n" "$*"; }
ok()   { printf "  ${green}ok${reset}  %s\n" "$*"; }
warn() { printf "  ${yellow}warn${reset} %s\n" "$*"; }
fail() { printf "  ${red}fail${reset} %s\n" "$*" >&2; exit 1; }

echo ""
printf "${bold}ashlr-hub installer${reset}\n"
echo "────────────────────────────────────────"

# ── 1. Verify Node ────────────────────────────────────────────────────────────
log "Checking Node.js version..."
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node v22+ and retry."
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if (( NODE_MAJOR < 22 )); then
  fail "Node v22+ required; found v$(node --version). Please upgrade."
fi
ok "Node $(node --version)"

# ── 2. Install npm dependencies ───────────────────────────────────────────────
log "Installing npm dependencies..."
cd "$REPO_DIR"
if npm install --silent; then
  ok "npm install"
else
  fail "npm install failed."
fi

# ── 3. Build ──────────────────────────────────────────────────────────────────
log "Building TypeScript..."
if npm run build --silent 2>&1; then
  ok "npm run build → dist/"
else
  # Re-run without --silent so the error is visible
  echo ""
  npm run build || true
  fail "Build failed. Fix TypeScript errors above and retry."
fi

# ── 4. Ensure bin/ashlr exists and is executable ─────────────────────────────
if [[ ! -f "$BIN_SRC" ]]; then
  fail "bin/ashlr not found at $BIN_SRC"
fi
chmod +x "$BIN_SRC"
ok "chmod +x bin/ashlr"

# ── 5. Create ~/.local/bin if missing ────────────────────────────────────────
if [[ ! -d "$INSTALL_DIR" ]]; then
  mkdir -p "$INSTALL_DIR"
  ok "created $INSTALL_DIR"
fi

# ── 6. Symlink ────────────────────────────────────────────────────────────────
log "Symlinking ashlr → $INSTALL_DEST..."

# Remove stale symlink or warn about a real file
if [[ -L "$INSTALL_DEST" ]]; then
  EXISTING_TARGET=$(readlink "$INSTALL_DEST")
  if [[ "$EXISTING_TARGET" == "$BIN_SRC" ]]; then
    ok "symlink already up-to-date ($INSTALL_DEST → $BIN_SRC)"
  else
    warn "Replacing existing symlink: $EXISTING_TARGET → $BIN_SRC"
    ln -sf "$BIN_SRC" "$INSTALL_DEST"
    ok "symlink updated"
  fi
elif [[ -e "$INSTALL_DEST" ]]; then
  fail "$INSTALL_DEST exists and is not a symlink. Remove it manually and retry."
else
  ln -s "$BIN_SRC" "$INSTALL_DEST"
  ok "symlink created ($INSTALL_DEST → $BIN_SRC)"
fi

# ── 7. PATH check ────────────────────────────────────────────────────────────
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  warn "$INSTALL_DIR is not on your PATH."
  echo "       Add this line to your ~/.zshrc (or ~/.bashrc):"
  echo ""
  echo '         export PATH="$HOME/.local/bin:$PATH"'
  echo ""
  echo "       Then run: source ~/.zshrc"
fi

# ── 8. Smoke-test ─────────────────────────────────────────────────────────────
log "Verifying \`ashlr help\`..."

# Use the resolved symlink target directly so we don't depend on PATH being reloaded
ASHLR_CMD="$INSTALL_DEST"

if "$ASHLR_CMD" help &>/dev/null; then
  ok "\`ashlr help\` succeeded"
else
  # Show output for diagnosis
  echo ""
  "$ASHLR_CMD" help || true
  fail "\`ashlr help\` exited non-zero. Check the output above."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
printf "${green}${bold}Installation complete.${reset}\n"
echo ""
echo "  ashlr index           # scan Desktop and build the index"
echo "  ashlr go              # fuzzy-jump to any project"
echo "  ashlr status          # repo health overview"
echo "  ashlr help            # full command reference"
echo ""
