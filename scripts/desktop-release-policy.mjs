/** Maintainer-only publisher tool policy; consumers never build or execute these tools. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export const DESKTOP_RELEASE_TOOL_PINS = Object.freeze({
  "gh": {"relative": "gh/bin/gh", "sha256": "0092756c8e454134482702fc1d079434efb05570056554183826c67164dce0d0", "version": "2.88.1"},
  "node": {
    "relative": "node-v22.23.2-darwin-arm64/bin/node",
    "sha256": "18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572",
    "version": "v22.23.2"
  },
  "bun": {
    "relative": "bun/bin/bun",
    "sha256": "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
    "version": "1.3.14"
  },
  "rustc": {
    "relative": "rustup/toolchains/1.97.1-aarch64-apple-darwin/bin/rustc",
    "sha256": "210df6794001b73ec3d453878707fa1e0bdcb63c427024a6e6574bbe5615a4da",
    "version": "rustc 1.97.1 (8bab26f4f 2026-07-14)"
  },
  "cargo": {
    "relative": "rustup/toolchains/1.97.1-aarch64-apple-darwin/bin/cargo",
    "sha256": "7672ead309d505577c018fff2cafb3433601f073e38cbe87359ac1f7b944bbf5",
    "version": "cargo 1.97.1 (c980f4866 2026-06-30)"
  },
  "tauri": {
    "relative": "tauri-cli/bin/cargo-tauri",
    "sha256": "830fa5a4900d33af4bed362b79c7509d2377be28eb1c1e51381cc2d3c5cd72a1",
    "version": "tauri-cli 2.11.4"
  },
  "npm": {
    "relative": "node-v22.23.2-darwin-arm64/lib/node_modules/npm/bin/npm-cli.js",
    "sha256": "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    "version": "10.9.8"
  }
});
for (const pin of Object.values(DESKTOP_RELEASE_TOOL_PINS)) Object.freeze(pin);
export const DESKTOP_RELEASE_APPLE_SIGNER = '0EA409C87A3CDE7B6E26015581E575D831698B23';

function fail() { throw new Error('Desktop publisher toolchain is missing, changed or not private; commission the pinned maintainer tools before publishing.'); }
function requireParents(path, root) {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) fail();
    if (parent === root) break;
    if (parent === dirname(parent) || !parent.startsWith(root + '/')) fail();
  }
}
function pinnedFile(path, root, expected) {
  requireParents(path, root);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o022)) fail();
    const digest = createHash('sha256').update(readFileSync(fd)).digest('hex');
    const after = fstatSync(fd);
    if (digest !== expected || before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || before.size !== after.size) fail();
  } finally { closeSync(fd); }
}

/** No PATH lookup, caller executable override, or key from a release manifest. */
export function getDesktopReleaseToolchain() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail();
  const home = userInfo().homedir;
  const root = join(home, 'Library/Application Support/PhantomReleaseToolchain');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077)) fail();
  const paths = {};
  for (const [name, pin] of Object.entries(DESKTOP_RELEASE_TOOL_PINS)) {
    const path = join(root, pin.relative);
    pinnedFile(path, root, pin.sha256); paths[name] = path;
  }
  const signingRoot = join(home, 'Library/Application Support/PhantomReleaseSigning');
  const signingKeyPath = join(signingRoot, 'desktop-ed25519.key');
  const dir = lstatSync(signingRoot), key = lstatSync(signingKeyPath);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077) ||
      !key.isFile() || key.isSymbolicLink() || key.nlink !== 1 || key.uid !== process.getuid() || (key.mode & 0o077)) fail();
  // A sign-only child reads the private file. This function never opens or returns its bytes.
  return Object.freeze({...paths, home, npmCli: paths.npm, signingKeyPath, appleSigner: DESKTOP_RELEASE_APPLE_SIGNER, root});
}
