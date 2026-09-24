/**
 * V3.10 Track B unit B-U1 — .github/CODEOWNERS stays the server-side copy of
 * the owner lane (merge gate G1, src/core/authority/protected-paths.ts).
 *
 * The file is generated from renderCodeownersBlock(); if the owner-lane rules
 * change, regenerate CODEOWNERS (the drift is the failure). Also pins that
 * every authority-surface root is itself a protected path: code that can
 * change what autonomy may do must never be fleet-mergeable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderCodeownersBlock } from '../src/core/authority/protected-paths.js';

const ROOT = join(import.meta.dirname, '..');
const codeowners = readFileSync(join(ROOT, '.github', 'CODEOWNERS'), 'utf8');
const script = (await import(pathToFileURL(join(ROOT, 'scripts', 'authority-surface.mjs')).href)) as { AUTHORITY_SURFACE_ROOTS: readonly string[] };

describe('.github/CODEOWNERS', () => {
  it('contains exactly the owner-lane block for this repo', () => {
    const block = renderCodeownersBlock('@masonwyatt23', { selfRepo: true });
    expect(codeowners.endsWith(block)).toBe(true);
    const rules = codeowners.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
    expect(rules.every((line) => / @masonwyatt23$/.test(line))).toBe(true);
    expect(codeowners).not.toMatch(/ashlr-fleet\[bot\]|@ashlrai\/ashlr-fleet/);
  });

  it('protects every authority-surface root and the authority tooling itself', () => {
    const owned = new Set(codeowners.split('\n').filter((l) => l.startsWith('/')).map((l) => l.split(' ')[0]!));
    for (const rootSpec of script.AUTHORITY_SURFACE_ROOTS) {
      if (!rootSpec.startsWith('dist/core/')) continue;
      const src = `/${rootSpec.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')}`;
      const covered = owned.has(src) || [...owned].some((pattern) => pattern.endsWith('/**') && src.startsWith(pattern.slice(0, -2)));
      expect(covered, `${src} is an authority-surface root but not a protected path`).toBe(true);
    }
    for (const path of ['/scripts/*authority*', '/src/core/authority/**', '/src/cli/authority.ts', '/test/setup/**']) {
      expect(owned.has(path), path).toBe(true);
    }
  });
});
