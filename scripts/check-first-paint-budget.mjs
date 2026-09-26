#!/usr/bin/env node
/**
 * scripts/check-first-paint-budget.mjs — CI guard for SPEC-310A §1 / SPEC-310C:
 * "Chat first-paint critical JS ≤ 350 KB".
 *
 * What counts as critical: every JS file the browser must download and
 * evaluate before a cold /verse load can paint the Chat section. That is the
 * static-import closure (Vite manifest `imports`, never `dynamicImports`) of
 * the three modules on the chat paint path:
 *
 *   index.html                     the HTML entry (main.tsx)
 *   app/VerseConsoleApp.tsx        main.tsx's lazy() pick for /verse
 *   routes/verse/sections/ChatSection.tsx
 *                                  started by VerseConsoleApp's preload, mounted by VerseApp
 *
 * Dynamic imports are excluded on purpose: they are fetched after first paint
 * (overlays, dock, markdown renderer, xterm, charts) and each is its own
 * chunk. If one of them becomes a static import again, it joins a closure and
 * this check catches the regression.
 *
 * The build goes to a scratch outDir (never dist/), so running this cannot
 * clobber the served bundle.
 *
 * Usage:
 *   node scripts/check-first-paint-budget.mjs                 # build to a temp dir, check, clean up
 *   node scripts/check-first-paint-budget.mjs --out-dir DIR   # build into DIR and keep it
 *   node scripts/check-first-paint-budget.mjs --no-build --out-dir DIR   # re-check an existing build
 *   node scripts/check-first-paint-budget.mjs --budget-kb 350 --json
 *
 * Exit: 0 within budget, 1 over budget, 2 build/manifest error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Manifest keys (relative to vite root src/web-ui) on the chat first-paint path. */
export const CHAT_FIRST_PAINT_ROOTS = Object.freeze([
  'index.html',
  'app/VerseConsoleApp.tsx',
  'routes/verse/sections/ChatSection.tsx',
]);

export const DEFAULT_BUDGET_KB = 350;

/**
 * Pure: `manifest` with every root that has no key of its own aliased to the
 * chunk that carries its code.
 *
 * vite.config.web.ts folds the Verse shell's first-paint modules into one
 * named chunk (the `VerseConsoleApp` group). A group chunk has no facade
 * module, so the manifest keys it `_VerseConsoleApp-<hash>.js`, and
 * `app/VerseConsoleApp.tsx` stops being a key. The chunk's sourcemap still
 * names every module in it: a root whose source appears in exactly one
 * chunk's map is measured from that chunk. A root found nowhere (or in two
 * chunks) is left missing, and criticalFiles() fails loudly as before.
 *
 * `sourcesOf(file)` returns the `sources` of that chunk's sourcemap (paths as
 * the map spells them; matched by suffix `src/web-ui/<root>`).
 */
export function aliasGroupedRoots(manifest, sourcesOf, roots = CHAT_FIRST_PAINT_ROOTS) {
  const out = { ...manifest };
  for (const root of roots) {
    if (out[root]) continue;
    const suffix = `src/web-ui/${root}`;
    const hits = Object.values(manifest).filter(
      (chunk) => typeof chunk.file === 'string' && chunk.file.endsWith('.js') && sourcesOf(chunk.file).some((s) => s.replace(/\\/g, '/').endsWith(suffix)),
    );
    if (hits.length === 1) out[root] = hits[0];
  }
  return out;
}

/**
 * Pure: the set of JS files in the static closure of `roots`.
 * Throws when a root is missing from the manifest — a renamed module must fail
 * the check loudly rather than silently shrink the measured set to zero.
 */
export function criticalFiles(manifest, roots = CHAT_FIRST_PAINT_ROOTS) {
  const files = new Set();
  const seen = new Set();
  const stack = [];
  for (const root of roots) {
    if (!manifest[root]) throw new Error(`first-paint root "${root}" is not in the Vite manifest`);
    stack.push(root);
  }
  while (stack.length > 0) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`manifest import "${key}" has no entry`);
    if (typeof chunk.file === 'string' && chunk.file.endsWith('.js')) files.add(chunk.file);
    for (const next of chunk.imports ?? []) stack.push(next);
  }
  return files;
}

function parseArgs(argv) {
  const out = { build: true, outDir: null, budgetKb: DEFAULT_BUDGET_KB, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-build') out.build = false;
    else if (arg === '--json') out.json = true;
    else if (arg === '--out-dir') out.outDir = resolve(argv[++i] ?? '');
    else if (arg === '--budget-kb') out.budgetKb = Number(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isFinite(out.budgetKb) || out.budgetKb <= 0) throw new Error('--budget-kb must be a positive number');
  if (!out.build && !out.outDir) throw new Error('--no-build needs --out-dir');
  return out;
}

function build(outDir) {
  const viteBin = join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const res = spawnSync(
    process.execPath,
    [viteBin, 'build', '--config', 'vite.config.web.ts', '--outDir', outDir, '--emptyOutDir', '--manifest', '--logLevel', 'warn'],
    { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (res.status !== 0) throw new Error(`vite build exited ${res.status ?? res.signal}`);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`check-first-paint-budget: ${err.message}`);
    return 2;
  }
  const ownsDir = !args.outDir;
  const outDir = args.outDir ?? mkdtempSync(join(tmpdir(), 'ashlr-first-paint-'));
  try {
    if (args.build) build(outDir);
    const manifestPath = join(outDir, '.vite', 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath} (build with --manifest)`);
    const sourcesOf = (file) => {
      try {
        return JSON.parse(readFileSync(join(outDir, `${file}.map`), 'utf8')).sources ?? [];
      } catch {
        return [];
      }
    };
    const manifest = aliasGroupedRoots(JSON.parse(readFileSync(manifestPath, 'utf8')), sourcesOf);
    const rows = [...criticalFiles(manifest)]
      .map((file) => ({ file, bytes: statSync(join(outDir, file)).size }))
      .sort((a, b) => b.bytes - a.bytes);
    const totalBytes = rows.reduce((sum, r) => sum + r.bytes, 0);
    const totalKb = totalBytes / 1024;
    const ok = totalKb <= args.budgetKb;
    if (args.json) {
      console.log(JSON.stringify({ ok, totalBytes, totalKb: Number(totalKb.toFixed(1)), budgetKb: args.budgetKb, files: rows }, null, 2));
    } else {
      for (const r of rows) console.log(`${(r.bytes / 1024).toFixed(1).padStart(8)} KB  ${r.file}`);
      console.log(`${ok ? 'OK' : 'OVER BUDGET'}: chat first-paint critical JS ${totalKb.toFixed(1)} KB (budget ${args.budgetKb} KB)`);
    }
    return ok ? 0 : 1;
  } catch (err) {
    console.error(`check-first-paint-budget: ${err.message}`);
    return 2;
  } finally {
    if (ownsDir) rmSync(outDir, { recursive: true, force: true });
  }
}

// Import-safe: tests import criticalFiles() without triggering a build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
