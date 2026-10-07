#!/usr/bin/env bash
# install.sh — build Phantom and install phm + compatible ashlr into ~/.local/bin
#
# Idempotent: safe to re-run after pulling updates.
# Usage: ./install.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="$REPO_DIR/bin/ashlr"
INSTALL_DIR="$HOME/.local/bin"
INSTALL_ALIASES=(phm ashlr)

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
printf "${bold}Phantom installer${reset}\n"
echo "────────────────────────────────────────"

# ── 1. Verify Node ────────────────────────────────────────────────────────────
log "Checking Node.js version..."
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node v22.15+ and retry."
fi

NODE_SUPPORTED=$(node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.stdout.write(major > 22 || (major === 22 && minor >= 15) ? "1" : "0")')
if [[ "$NODE_SUPPORTED" != "1" ]]; then
  fail "Node v22.15+ required; found v$(node --version). Please upgrade."
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

# ── 6. Preflight both aliases, then create only absent links ──────────────────
# No alias may overwrite another tool, including an unrelated dangling link.
# Preflight all destinations before writing either; never force a replacement.
node -e '
const fs = require("node:fs");
const path = require("node:path");
const [source, directory] = process.argv.slice(1);
const destinations = ["phm", "ashlr"].map(name => path.join(directory, name));
const created = [];
const stat = target => {
  try { return fs.lstatSync(target); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
try {
  for (const target of destinations) {
    const item = stat(target);
    if (item && !(item.isSymbolicLink() && fs.readlinkSync(target) === source)) {
      throw new Error(target + " belongs to another file or link. Move it manually and retry.");
    }
  }
  for (const target of destinations) {
    const existing = stat(target);
    if (existing && existing.isSymbolicLink() && fs.readlinkSync(target) === source) continue;
    // Exact-path exclusive creation refuses even a newly appeared directory.
    fs.symlinkSync(source, target);
    created.push({ target, identity: fs.lstatSync(target) });
    console.log("  symlink created (" + target + " → " + source + ")");
  }
} catch (error) {
  for (const { target, identity } of created.reverse()) {
    const current = stat(target);
    // Roll back only links this invocation created and that still match.
    if (current && current.isSymbolicLink() && current.dev === identity.dev &&
        current.ino === identity.ino && current.birthtimeMs === identity.birthtimeMs &&
        current.ctimeMs === identity.ctimeMs && fs.readlinkSync(target) === source) {
      fs.unlinkSync(target);
    }
  }
  console.error("  fail " + error.message);
  process.exitCode = 1;
}
' "$BIN_SRC" "$INSTALL_DIR"

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
for ALIAS in "${INSTALL_ALIASES[@]}"; do
  log "Verifying $ALIAS help..."
  if "$INSTALL_DIR/$ALIAS" help &>/dev/null; then
    ok "$ALIAS help succeeded"
  else
    "$INSTALL_DIR/$ALIAS" help || true
    fail "$ALIAS help exited non-zero. Check the output above."
  fi
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
printf "${green}${bold}Installation complete.${reset}\n"
echo ""
echo "  phm index           # scan Desktop and build the index"
echo "  phm go              # fuzzy-jump to any project"
echo "  phm status          # repo health overview"
echo "  phm help            # full command reference"
echo "  ashlr remains a compatible alias; phantom belongs to Phantom Secrets."
echo ""
