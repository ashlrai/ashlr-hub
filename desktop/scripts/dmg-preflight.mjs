#!/usr/bin/env node
/**
 * dmg-preflight.mjs
 *
 * Clears the state a previously interrupted `cargo tauri build` leaves behind
 * on macOS, so the DMG step does not fail on the next run.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Tauri bundles the DMG by shelling out to a vendored fork of create-dmg
 * (`bundle_dmg.sh`). That script:
 *
 *   1. writes an interstitial read-write image next to the .app, named
 *      `rw.<pid>.<ProductName>_<version>_<arch>.dmg`;
 *   2. `hdiutil attach -mountrandom /Volumes` it, producing `/Volumes/dmg.XXXXXX`;
 *   3. lays out the volume, runs an AppleScript against Finder to position the
 *      icons, detaches, and compresses the result.
 *
 * If the build is interrupted anywhere between (2) and the detach — a Ctrl-C, a
 * killed parent, a timed-out agent step — the volume stays mounted and the
 * `rw.*.dmg` stays on disk. The *next* build then fails in ways that do not
 * name the real cause: `hdiutil attach` collides with the attached image, or
 * `find_mount_dir` resolves the wrong device and the script exits 1 with
 * "unable to proceed with final disk image creation".
 *
 * That is exactly the state this repo was in: `/Volumes/dmg.gQvqCb` was still
 * attached from an interrupted debug build, alongside a 173 MB
 * `rw.34706.Ashlr_0.1.0_aarch64.dmg`. Detaching the volume and deleting the
 * partial image made `cargo tauri build` produce the DMG on the first attempt.
 *
 * This script is idempotent and safe: it only ever touches images whose
 * `image-path` is inside THIS repository's `desktop/src-tauri/target` tree.
 * Another project's disk image, an installer the user has open, or a mounted
 * volume from anywhere else is never detached.
 *
 * ----------------------------------------------------------------------------
 * ESCAPE HATCH
 * ----------------------------------------------------------------------------
 * The AppleScript in step (3) needs permission to send Apple events to Finder.
 * On a machine where the build runs without that (a headless runner, an SSH
 * session with no Aqua login, a TCC prompt nobody can answer) it fails with
 * `-1743 Not authorized to send Apple events to Finder` and the bundler exits
 * 64. There is no Tauri config for it; the switch is create-dmg's
 * `--skip-jenkins`, which the bundler passes only when `CI` is set. So:
 *
 *     CI=1 cargo tauri build
 *
 * produces a DMG with default icon positions and no custom layout. The .app
 * inside is byte-for-byte the same either way.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
/** Only images under this directory are ever touched. */
const TARGET_DIR = resolve(join(__dir, "..", "src-tauri", "target"));

if (process.platform !== "darwin") {
  // Nothing to do: the DMG step only runs on macOS, and the Linux bundle is
  // refused outright by assert-desktop-bundle-policy.mjs.
  process.exit(0);
}

/** `hdiutil info` as a list of `{ imagePath, devEntries }`. */
function attachedImages() {
  let raw;
  try {
    raw = execFileSync("/usr/bin/hdiutil", ["info"], { encoding: "utf8" });
  } catch (error) {
    console.warn(`[dmg-preflight] could not read hdiutil info: ${error.message}`);
    return [];
  }

  const images = [];
  let current = null;
  for (const line of raw.split("\n")) {
    const imageMatch = line.match(/^image-path\s*:\s*(.+?)\s*$/);
    if (imageMatch) {
      current = { imagePath: imageMatch[1], devEntries: [] };
      images.push(current);
      continue;
    }
    if (!current) continue;
    const devMatch = line.match(/^(\/dev\/disk\d+)(s\d+)?\s/);
    if (devMatch) current.devEntries.push(devMatch[1]);
  }
  return images;
}

/**
 * True when `candidate` really lives inside the target tree.
 *
 * `resolve()` alone is LEXICAL — it normalises `..` and makes the path
 * absolute, and that is all. It does not read the filesystem, so it cannot
 * defeat a symlink: with `target/` (or anything under it) linked elsewhere, a
 * path that resolves inside the tree can name a file that is not, and the
 * reverse. Since the whole safety claim of this script is "it only ever touches
 * images under THIS repo's target/", the check has to resolve links for real.
 *
 * `realpathSync` throws on a path that no longer exists — a race with the build
 * that is detaching things itself. That is not containment, it is absence, and
 * absent means nothing to detach, so it is reported as "outside".
 */
function insideTargetDir(candidate) {
  let real;
  try {
    real = realpathSync(resolve(candidate));
  } catch {
    return false;
  }
  return real === TARGET_REAL || real.startsWith(`${TARGET_REAL}/`);
}

/**
 * The target tree's own realpath, resolved once. Falls back to the lexical path
 * when `target/` does not exist yet (a clean checkout), where there is nothing
 * mounted to match it anyway.
 */
const TARGET_REAL = (() => {
  try {
    return realpathSync(TARGET_DIR);
  } catch {
    return TARGET_DIR;
  }
})();

let detached = 0;
for (const image of attachedImages()) {
  if (!insideTargetDir(image.imagePath)) continue;

  for (const dev of new Set(image.devEntries)) {
    try {
      execFileSync("/usr/bin/hdiutil", ["detach", dev, "-force"], { stdio: "pipe" });
      console.log(`[dmg-preflight] detached ${dev} (left mounted by an interrupted build)`);
      detached += 1;
    } catch (error) {
      console.warn(
        `[dmg-preflight] could not detach ${dev}: ${error.message}\n` +
          `  A later hdiutil step may fail. Detach it by hand with:\n` +
          `    hdiutil detach ${dev} -force`,
      );
    }
  }
}

/** Delete partial `rw.<pid>.*.dmg` interstitial images under target/. */
function sweepPartials(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Only walk the bundle output; target/ is enormous otherwise.
      if (["bundle", "debug", "release", "macos", "dmg"].includes(entry.name)) {
        removed += sweepPartials(full);
      }
      continue;
    }
    if (/^rw\.\d+\..*\.dmg$/.test(entry.name)) {
      try {
        rmSync(full, { force: true });
        console.log(`[dmg-preflight] removed partial image ${entry.name}`);
        removed += 1;
      } catch (error) {
        console.warn(`[dmg-preflight] could not remove ${full}: ${error.message}`);
      }
    }
  }
  return removed;
}

const removed = existsSync(TARGET_DIR) ? sweepPartials(TARGET_DIR) : 0;

if (detached === 0 && removed === 0) {
  console.log("[dmg-preflight] no leftover disk images");
}
