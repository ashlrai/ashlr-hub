#!/usr/bin/env node
/**
 * prepare-sidecar.mjs
 *
 * Copies the compiled `ashlr` binary (built by `npm run build:binary` /
 * `scripts/build-sea.mjs`) into `src-tauri/binaries/` with the
 * triple-suffixed filename that Tauri's externalBin bundler expects, and
 * copies the companion `public/` assets directory alongside it.
 *
 * Usage: node scripts/prepare-sidecar.mjs [--target <triple>]
 *
 * The target triple defaults to the host triple reported by `rustc -vV`.
 * For cross-compilation, pass --target explicitly, e.g.:
 *   --target x86_64-pc-windows-msvc
 *   --target aarch64-apple-darwin
 *
 * ----------------------------------------------------------------------------
 * HOW THE SIDECAR STRATEGY WORKS
 * ----------------------------------------------------------------------------
 * Goal: ship a ~10–15 MB installer that does NOT require the user to have
 * Node.js/Bun/npm installed.
 *
 * Chosen approach — Bun single-file executable (SEA):
 *   1. Run `npm run build:binary` (or `node scripts/build-sea.mjs`) from the
 *      ashlr-hub repo root.  This produces:
 *        dist-bin/ashlr        — Bun-compiled native binary (~10–15 MB)
 *        dist-bin/public/      — SPA assets (index.html, app.js, styles.css)
 *      The binary contains a shim that sets ASHLR_WEB_PUBLIC to the sibling
 *      `public/` dir at startup (via import.meta.dir), so no extra env var is
 *      needed when launching directly.
 *   2. This script copies the binary to
 *        src-tauri/binaries/ashlr-<triple>[.exe]
 *      and the assets to
 *        src-tauri/binaries/ashlr-public-<triple>/
 *      Tauri bundles the binary via the `externalBin` key in tauri.conf.json.
 *   3. At runtime, `tauri-plugin-shell` resolves the correct binary for the
 *      host OS/arch and spawns it with ASHLR_WEB_PUBLIC set to the extracted
 *      assets directory (see main.rs sidecar spawn args).
 *
 * Fallback — Node.js SEA (if Bun is not available):
 *   Node 21+ supports `node --experimental-sea-config` to produce a
 *   self-contained executable.  The approach is similar but requires a
 *   `sea-config.json` and a blob-injection step.  See:
 *   https://nodejs.org/api/single-executable-applications.html
 * ----------------------------------------------------------------------------
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, "..", "..");
const binariesDir = join(__dir, "..", "src-tauri", "binaries");

// ── resolve target triple ────────────────────────────────────────────────────
function hostTriple() {
  const raw = execSync("rustc -vV", { encoding: "utf8" });
  const match = raw.match(/host:\s+(\S+)/);
  if (!match) throw new Error("Could not parse rustc -vV output");
  return match[1];
}

const args = process.argv.slice(2);
const targetIdx = args.indexOf("--target");
const triple = targetIdx !== -1 ? args[targetIdx + 1] : hostTriple();

// ── locate the compiled ashlr binary (from build-sea.mjs output) ─────────────
// Priority order:
//   1. dist-bin/ashlr[.exe]  — output of `npm run build:binary` (preferred)
//   2. binaries/ashlr-raw    — legacy location (still accepted)
//   3. PATH `ashlr`          — dev convenience only; NOT self-contained

function findSource() {
  const isWindows = triple.includes("windows");
  const ext = isWindows ? ".exe" : "";
  const candidates = [
    join(repoRoot, "dist-bin", `ashlr${ext}`),   // build-sea.mjs output
    join(repoRoot, "binaries", "ashlr-raw"),       // legacy
    join(repoRoot, "binaries", `ashlr-raw${ext}`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Try PATH as a last resort (dev only; won't be self-contained).
  try {
    const p = execSync("which ashlr || where ashlr", { encoding: "utf8" }).trim();
    if (p && existsSync(p)) return p;
  } catch { /* ignore */ }
  return null;
}

// ── locate the companion public/ assets ──────────────────────────────────────
// build-sea.mjs copies the SPA assets to dist-bin/public/.
function findPublicAssets(binarySrc) {
  // 1. Sibling public/ next to the binary (build-sea.mjs canonical location).
  const siblingPub = join(dirname(binarySrc), "public");
  if (existsSync(siblingPub)) return siblingPub;
  // 2. dist/core/web/public (post-tsc build output).
  const distPub = join(repoRoot, "dist", "core", "web", "public");
  if (existsSync(distPub)) return distPub;
  return null;
}

const src = findSource();
if (!src) {
  console.error(
    "ERROR: Could not locate a compiled ashlr binary.\n" +
    "Run `npm run build:binary` from the repo root first.\n" +
    "  (This calls scripts/build-sea.mjs which uses `bun build --compile`.)"
  );
  process.exit(1);
}

// ── copy binary with Tauri-required filename format ───────────────────────────
mkdirSync(binariesDir, { recursive: true });
const ext = triple.includes("windows") ? ".exe" : "";
const dest = join(binariesDir, `ashlr-${triple}${ext}`);
cpSync(src, dest);
console.log(`[prepare-sidecar] Binary : ${src} → ${dest}`);

// ── copy public/ assets alongside the binary ──────────────────────────────────
// Tauri does NOT bundle arbitrary sibling directories automatically, so we
// store them under a triple-namespaced subdirectory in binaries/ and the Rust
// code (main.rs) resolves them relative to the bundle's resource path.
const publicSrc = findPublicAssets(src);
if (publicSrc) {
  const publicDest = join(binariesDir, `ashlr-public-${triple}`);
  if (existsSync(publicDest)) rmSync(publicDest, { recursive: true });
  cpSync(publicSrc, publicDest, { recursive: true });
  console.log(`[prepare-sidecar] Assets  : ${publicSrc} → ${publicDest}`);
} else {
  console.warn(
    "[prepare-sidecar] WARNING: Could not locate SPA assets (public/).\n" +
    "  Run `npm run build:binary` from the repo root to build them.\n" +
    "  Without assets, the dashboard will return 404 on static requests."
  );
}

console.log(`\n[prepare-sidecar] Done. Triple: ${triple}`);
console.log(`  Binary : ${dest}`);
if (publicSrc) {
  console.log(`  Assets : ${join(binariesDir, `ashlr-public-${triple}`)}`);
}
