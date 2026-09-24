/**
 * V3.10 Track B unit B-U1 — .github/CODEOWNERS stays the server-side copy of
 * the owner lane (merge gate G1, src/core/authority/protected-paths.ts).
 *
 * 3.10 review c14: this test used to compare CODEOWNERS with
 * renderCodeownersBlock() alone — the same renderer that produced it — so when
 * the renderer dropped the `tier1-test` rule (which lives in
 * matchProtectedPath, not in PROTECTED_PATH_RULES) GitHub owned none of the
 * ~500 invariant suites and the test stayed green. Now it checks CODEOWNERS
 * against the RULES SOURCE independently of the renderer:
 *   - every pattern of every owner-lane rule appears as a CODEOWNERS line;
 *   - every file under test/ that matchProtectedPath (G1 itself) protects is
 *     matched by some CODEOWNERS pattern (a small CODEOWNERS glob matcher
 *     below, not the renderer);
 * and it still pins the generated block byte for byte.
 *
 * Regenerate after a reviewed change (new Tier-1 tests, new rules):
 *   ASHLR_UPDATE_CODEOWNERS=1 npx vitest run test/authority-codeowners-310b.test.ts
 * CODEOWNERS is itself owner-lane, so only Mason's own change can land it.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PROTECTED_PATH_RULES,
  matchProtectedPath,
  renderCodeownersBlock,
  testContentImportsTier1,
  tier1TestPathsIn,
} from '../src/core/authority/protected-paths.js';

const ROOT = join(import.meta.dirname, '..');
const CODEOWNERS_PATH = join(ROOT, '.github', 'CODEOWNERS');
const OWNER = '@masonwyatt23';
const MARKER = '# Generated from src/core/authority/protected-paths.ts';
const script = (await import(pathToFileURL(join(ROOT, 'scripts', 'authority-surface.mjs')).href)) as { AUTHORITY_SURFACE_ROOTS: readonly string[] };

/** Every file under test/ with its content (G1 scans any test/ file's content for Tier-1 imports). */
function testTree(): { path: string; content: string | null }[] {
  const out: { path: string; content: string | null }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (entry.isFile()) {
        const path = relative(ROOT, full).split('\\').join('/');
        out.push({ path, content: statSync(full).size <= 8 * 1024 * 1024 ? readFileSync(full, 'utf8') : null });
      }
    }
  };
  walk(join(ROOT, 'test'));
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** GitHub CODEOWNERS pattern → RegExp (the subset this repo uses: leading `/`, `**`, `*`, `?`). Independent of the renderer. */
function codeownersRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith('/');
  const body = anchored ? pattern.slice(1) : pattern;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '*' && body[i + 1] === '*') {
      if (body[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // No leading "/": GitHub matches the pattern at any depth.
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${out}$`);
}

const tree = testTree();
const tier1Tests = tier1TestPathsIn(tree);
const block = renderCodeownersBlock(OWNER, { selfRepo: true, tier1TestPaths: tier1Tests });

describe('.github/CODEOWNERS', () => {
  if (process.env['ASHLR_UPDATE_CODEOWNERS'] === '1') {
    it('regenerates the owner-lane block (ASHLR_UPDATE_CODEOWNERS=1)', () => {
      const current = readFileSync(CODEOWNERS_PATH, 'utf8');
      const at = current.indexOf(MARKER);
      expect(at, 'generated block marker not found').toBeGreaterThanOrEqual(0);
      writeFileSync(CODEOWNERS_PATH, current.slice(0, at) + block);
    });
    return;
  }

  const codeowners = readFileSync(CODEOWNERS_PATH, 'utf8');
  const lines = codeowners.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
  const patterns = lines.map((line) => line.split(' ')[0]!);
  const regexes = patterns.map((pattern) => codeownersRegExp(pattern));

  it('contains exactly the owner-lane block for this repo (regenerate on drift)', () => {
    expect(codeowners.endsWith(block), 'CODEOWNERS drifted: ASHLR_UPDATE_CODEOWNERS=1 npx vitest run test/authority-codeowners-310b.test.ts').toBe(true);
    expect(lines.every((line) => / @masonwyatt23$/.test(line))).toBe(true);
    expect(codeowners).not.toMatch(/ashlr-fleet\[bot\]|@ashlrai\/ashlr-fleet/);
  });

  it('carries every pattern of every owner-lane rule (checked against the rules, not the renderer)', () => {
    const owned = new Set(patterns);
    for (const rule of PROTECTED_PATH_RULES) {
      for (const pattern of rule.patterns) {
        const expected = pattern.startsWith('**/') ? pattern : `/${pattern}`;
        expect(owned.has(expected), `${rule.id}: ${expected}`).toBe(true);
      }
    }
  });

  it('owns every test/ file G1 protects — including the Tier-1 tests held by name, safety suite or import (c14)', () => {
    expect(tier1Tests.length).toBeGreaterThan(100);
    const missing: string[] = [];
    for (const file of tree) {
      const imports = testContentImportsTier1(file.path, [file.content]);
      const hit = matchProtectedPath(file.path, imports ? { selfRepo: true, testsImportingTier1: new Set([file.path]) } : { selfRepo: true });
      if (!hit) continue;
      if (!regexes.some((re) => re.test(file.path))) missing.push(`${file.path} (${hit.ruleId})`);
    }
    expect(missing, 'G1 protects these but GitHub does not — regenerate CODEOWNERS').toEqual([]);
    // The invariant suites the review named, concretely.
    for (const path of ['test/merge-gates-310b.test.ts', 'test/authority-rollout-310b.test.ts', 'test/host-merge-310b.test.ts', 'test/authority-review-fixes-310.test.ts']) {
      expect(regexes.some((re) => re.test(path)), path).toBe(true);
    }
  });

  it('the glob matcher is not vacuous', () => {
    const matches = (path: string) => regexes.some((re) => re.test(path));
    expect(matches('src/core/authority/rollout.ts')).toBe(true);
    expect(matches('pkg/nested/package.json')).toBe(true);
    expect(matches('README.md')).toBe(false);
    expect(matches('src/web-ui/routes/verse/Workspace.tsx')).toBe(false);
  });

  it('protects every authority-surface root and the authority tooling itself', () => {
    const owned = new Set(patterns.filter((p) => p.startsWith('/')));
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
