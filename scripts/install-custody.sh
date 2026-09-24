#!/bin/bash
# install-custody.sh — build, sign and install the ashlr-custody helper
# root-owned at /usr/local/libexec/ashlr-custody (SPEC-310B §1 / §8 Phase 0).
#
#   sudo scripts/install-custody.sh              build, test, sign, install
#   scripts/install-custody.sh --dry-run         print the plan; change nothing (no sudo)
#   sudo scripts/install-custody.sh --uninstall  remove the binary (keeps the key + Keychain items)
#
# Optional: ASHLR_CUSTODY_SIGN_IDENTITY="Developer ID Application: …" signs
# with your identity instead of ad hoc. With an identity the Keychain items'
# access lists survive rebuilds; with ad-hoc signing each new build must
# re-run `store-github-app` / `store-claude-token` (the Keychain asks, or the
# helper fails closed — it never prompts from a non-interactive call).
#
# WHY root-owned: confined agents already cannot exec or read it (the
# autonomous sandbox profile denies both), and a root-owned binary in a
# root-owned directory cannot be swapped by any process running as you. The
# build and tests run as YOU (never as root), so no root-owned files land in
# the checkout. Nothing here creates a key, a grant or a Keychain item: after
# installing, run `ashlr-custody init` yourself (Touch ID).

set -euo pipefail
umask 022
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

readonly DEST_DIR=/usr/local/libexec
readonly DEST="$DEST_DIR/ashlr-custody"
readonly IDENTIFIER=ai.ashlr.custody

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_ROOT
readonly PACKAGE="$REPO_ROOT/tools/custody"

mode=install
case "${1:-}" in
  "") ;;
  --dry-run) mode=dry-run ;;
  --uninstall) mode=uninstall ;;
  -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "install-custody: unknown option $1 (see --help)" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then echo "install-custody: one option at most" >&2; exit 2; fi

fail() { echo "install-custody: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[ "$(uname -s)" = Darwin ] || fail "macOS only (the helper needs the Secure Enclave)"
[ -f "$PACKAGE/Package.swift" ] || fail "missing $PACKAGE/Package.swift"

# A directory we install into must be root-owned and writable by root alone —
# otherwise a non-root process could replace the helper after install.
check_root_dir() {
  local dir="$1" owner perms
  owner="$(stat -f '%u' "$dir")"
  perms="$(stat -f '%Lp' "$dir")"
  [ "$owner" = 0 ] || fail "$dir is not owned by root"
  [ $(( 8#$perms & 8#022 )) -eq 0 ] || fail "$dir is group- or world-writable ($perms)"
  [ ! -L "$dir" ] || fail "$dir is a symlink"
}

if [ "$mode" = dry-run ]; then
  echo "install-custody (dry run) — nothing will change"
  echo "  1. as $(id -un): swift test && swift build -c release  (in $PACKAGE)"
  echo "  2. codesign a staged copy: --options runtime --identifier $IDENTIFIER --sign ${ASHLR_CUSTODY_SIGN_IDENTITY:--}"
  echo "  3. install -o root -g wheel -m 0755 → $DEST (atomic rename)"
  echo "  4. verify owner/mode/signature, print its sha256"
  echo "  then YOU run: $DEST status && $DEST init   (Touch ID)"
  if [ -e "$DEST" ]; then echo "  currently installed: $(stat -f '%Su:%Sg %Lp' "$DEST") $(shasum -a 256 "$DEST" | cut -d' ' -f1)"; else echo "  currently installed: none"; fi
  exit 0
fi

[ "$(id -u)" = 0 ] || fail "run with sudo (it installs into $DEST_DIR)"
BUILD_USER="${SUDO_USER:-}"
[ -n "$BUILD_USER" ] && [ "$BUILD_USER" != root ] || fail "run via sudo from your own account (SUDO_USER is unset or root)"

if [ "$mode" = uninstall ]; then
  if [ -e "$DEST" ]; then
    rm -f "$DEST"
    step "removed $DEST (the Secure Enclave key and Keychain items are untouched)"
  else
    step "nothing to remove at $DEST"
  fi
  exit 0
fi

step "testing and building as $BUILD_USER (never as root)"
sudo -u "$BUILD_USER" -H /usr/bin/swift test --package-path "$PACKAGE" >/dev/null \
  || fail "swift test failed — nothing installed (re-run it yourself to see why)"
sudo -u "$BUILD_USER" -H /usr/bin/swift build -c release --package-path "$PACKAGE" >/dev/null \
  || fail "swift build failed — nothing installed"
BIN_DIR="$(sudo -u "$BUILD_USER" -H /usr/bin/swift build -c release --package-path "$PACKAGE" --show-bin-path)"
BUILT="$BIN_DIR/ashlr-custody"
[ -f "$BUILT" ] && [ ! -L "$BUILT" ] || fail "build output $BUILT is missing"

STAGE="$(mktemp -d /private/tmp/ashlr-custody-install.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
chmod 700 "$STAGE"
cp "$BUILT" "$STAGE/ashlr-custody"
chown root:wheel "$STAGE/ashlr-custody"
chmod 0755 "$STAGE/ashlr-custody"

step "signing (hardened runtime blocks DYLD_* injection into the helper)"
codesign --force --options runtime --identifier "$IDENTIFIER" \
  --sign "${ASHLR_CUSTODY_SIGN_IDENTITY:--}" "$STAGE/ashlr-custody"
codesign --verify --strict "$STAGE/ashlr-custody" || fail "signature does not verify"
"$STAGE/ashlr-custody" version >/dev/null || fail "the staged helper does not run"

step "installing $DEST"
check_root_dir /usr/local
if [ ! -d "$DEST_DIR" ]; then
  install -d -o root -g wheel -m 0755 "$DEST_DIR"
fi
check_root_dir "$DEST_DIR"
install -o root -g wheel -m 0755 "$STAGE/ashlr-custody" "$DEST.new"
mv -f "$DEST.new" "$DEST"

[ "$(stat -f '%u:%g %Lp' "$DEST")" = "0:0 755" ] || fail "$DEST does not have root:wheel 0755"
codesign --verify --strict "$DEST" || fail "installed binary signature does not verify"
SUM="$(shasum -a 256 "$DEST" | cut -d' ' -f1)"

step "installed $DEST"
echo "    sha256 $SUM"
echo "    $(codesign -dv "$DEST" 2>&1 | grep -E '^(Identifier|TeamIdentifier|Runtime Version)=' | tr '\n' ' ')"
echo
echo "Next (you, not an agent):"
echo "  $DEST status"
echo "  $DEST init        # Touch ID; prints {keyId, publicKeyPem} for trust-roots.ts"
