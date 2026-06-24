#!/usr/bin/env node
/**
 * prepare-sidecar.mjs
 *
 * Copies the compiled `ashlr` binary (or a Bun/Node SEA wrapper of it) into
 * `src-tauri/binaries/` with the triple-suffixed filename that Tauri's
 * externalBin bundler expects.
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
 * Goal: ship a ~10 MB installer that *does not require the user to have
 * Node.js/Bun/npm installed*.
 *
 * Chosen approach — Bun single-file executable (SEA):
 *   1. Run `bun build --compile --outfile binaries/ashlr-raw src/index.ts`
 *      from the ashlr-hub repo root.  Bun embeds the V8 runtime + all TS
 *      sources into one native executable (~8-12 MB depending on platform).
 *   2. This script copies that binary to `src-tauri/binaries/ashlr-<triple>`.
 *   3. Tauri bundles it via the `externalBin` key in tauri.conf.json.
 *   4. At runtime, `tauri-plugin-shell` resolves the correct binary for the
 *      host OS/arch from the bundle and spawns it.
 *
 * Fallback — Node.js SEA (if Bun is not available):
 *   Node 21+ supports `node --experimental-sea-config` to produce a
 *   self-contained executable.  The approach is similar but requires a
 *   `sea-config.json` and a blob-injection step.  See:
 *   https://nodejs.org/api/single-executable-applications.html
 *
 * TODO (open items tracked in desktop/README.md):
 *   - Decide Bun vs. Node SEA and wire into CI.
 *   - Confirm binary is signed before notarization on macOS (Gatekeeper
 *     will reject unsigned executables embedded in .app bundles).
 * ----------------------------------------------------------------------------
 */

import { execSync } from "child_process";
import { cpSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

// ── locate the compiled ashlr binary ─────────────────────────────────────────
// Priority order:
//   1. A Bun-compiled SEA at <repo>/binaries/ashlr-raw   (bun build --compile)
//   2. The installed `ashlr` on PATH                      (ln / dev convenience)
//   3. <repo>/dist/bin/ashlr                              (tsc output + node shebang)
//      — NOTE: option 3 still requires Node on the host; it is NOT self-contained.

function findSource() {
  const candidates = [
    join(repoRoot, "binaries", "ashlr-raw"),
    join(repoRoot, "binaries", "ashlr-raw.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Try PATH as a last resort (dev only).
  try {
    const p = execSync("which ashlr || where ashlr", { encoding: "utf8" }).trim();
    if (p && existsSync(p)) return p;
  } catch {}
  return null;
}

const src = findSource();
if (!src) {
  console.error(
    "ERROR: Could not locate a compiled ashlr binary.\n" +
    "Run `bun build --compile --outfile binaries/ashlr-raw src/index.ts` from the repo root first."
  );
  process.exit(1);
}

// ── copy with Tauri-required filename format ──────────────────────────────────
mkdirSync(binariesDir, { recursive: true });
const ext = triple.includes("windows") ? ".exe" : "";
const dest = join(binariesDir, `ashlr-${triple}${ext}`);
cpSync(src, dest);
console.log(`Copied ${src} → ${dest}`);
