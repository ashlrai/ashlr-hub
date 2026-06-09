#!/usr/bin/env node
/**
 * scripts/copy-assets.mjs — M14 build step.
 *
 * tsc only emits .js/.d.ts/.map files; it does NOT copy static (non-TS)
 * assets. The web dashboard's SPA (src/core/web/public/*) must be available
 * next to the compiled server (dist/core/web/public/*) so assetsDir() — which
 * resolves `public` relative to the compiled server.js — finds them.
 *
 * Zero new deps: uses only Node builtins (fs/path/url). Idempotent.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const src = join(repoRoot, 'src', 'core', 'web', 'public');
const dest = join(repoRoot, 'dist', 'core', 'web', 'public');

if (!existsSync(src)) {
  console.error(`[copy-assets] source not found: ${src}`);
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });

console.log(`[copy-assets] copied ${src} -> ${dest}`);
