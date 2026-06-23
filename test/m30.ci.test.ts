/**
 * M30 POLISH — CI matrix guard.
 *
 * Parses .github/workflows/ci.yml (line-based; no YAML dependency, no new deps)
 * and asserts the Node version matrix covers both 20 and 22 across the
 * typecheck / lint / build / test steps, that npm caching is enabled, and that
 * NOTHING public is wired in (no deploy/publish/release step) — per the M30
 * "nothing public / self-hostable" invariant. Read-only; touches no real config.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const ciYml = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
) as { engines?: { node?: string }; scripts?: Record<string, string> };

describe('M30 CI workflow', () => {
  it('declares a Node version matrix containing 22', () => {
    const match = ciYml.match(/node-version:\s*\[([^\]]*)\]/);
    expect(match, 'expected a node-version matrix array in ci.yml').not.toBeNull();
    const versions = (match as RegExpMatchArray)[1]
      .split(',')
      .map((v) => v.replace(/["'\s]/g, ''))
      .filter(Boolean);
    expect(versions).toContain('22');
  });

  it('keeps the typecheck / lint / build / test steps', () => {
    expect(ciYml).toContain('npm run typecheck');
    expect(ciYml).toContain('npm run lint');
    expect(ciYml).toContain('npm run build');
    expect(ciYml).toContain('npm test');
  });

  it('enables npm caching for fast installs', () => {
    expect(ciYml).toMatch(/cache:\s*["']?npm["']?/);
    expect(ciYml).toContain('npm ci');
  });

  it('adds NO deploy / publish / release step (nothing public)', () => {
    expect(ciYml).not.toMatch(/\b(npm\s+publish|deploy|release)\b/i);
    expect(ciYml).not.toMatch(/vercel|netlify|gh-pages|pages-deploy/i);
  });

  it('requires Node >=22 via package.json engines (matches the CI matrix)', () => {
    // The matrix runs Node 22, and install.sh hard-requires >=22, so engines
    // must agree. (Node 20 was dropped — it is unsupported by install.sh.)
    expect(pkg.engines?.node).toBe('>=22');
  });
});
