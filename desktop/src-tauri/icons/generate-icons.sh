#!/usr/bin/env bash
# generate-icons.sh — produce all Tauri-required icon sizes from icon.svg
#
# Usage (run from desktop/src-tauri/icons/):
#   ./generate-icons.sh
#
# Requirements:
#   cargo tauri   (install: cargo install tauri-cli --version "^2")
#
# What it does:
#   `cargo tauri icon icon.svg` generates the full set that tauri.conf.json
#   references:
#     32x32.png, 128x128.png, 128x128@2x.png,
#     icon.icns  (macOS),  icon.ico  (Windows)
#   It also outputs tray-icon-sized images; we rename one to tray-icon.png.
#
# After running, verify the output:
#   ls -lh *.png *.icns *.ico

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# tauri icon must be run from the src-tauri directory
SRC_TAURI="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$SRC_TAURI"

echo "[icons] Running: cargo tauri icon icons/icon.svg"
cargo tauri icon icons/icon.svg

# cargo tauri icon writes files into icons/ automatically.
# It produces a 32x32.png which we also use as the tray icon (monochrome
# adaptation should be done manually for macOS template icons; see README).
if [ -f "icons/32x32.png" ] && [ ! -f "icons/tray-icon.png" ]; then
  cp "icons/32x32.png" "icons/tray-icon.png"
  echo "[icons] Copied 32x32.png -> tray-icon.png (replace with a monochrome version for macOS)"
fi

echo "[icons] Done. Files in icons/:"
ls -lh icons/*.png icons/*.icns icons/*.ico 2>/dev/null || true
