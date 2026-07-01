/**
 * M30 POLISH — CI workflow guard.
 *
 * Parses .github/workflows/ci.yml (line-based; no YAML dependency, no new deps)
 * and asserts the CI runs on Node 22 (the hard minimum — install.sh hard-fails
 * below 22, so a 20+22 matrix would silently lie), runs the required
 * typecheck / lint / build / test steps with hermetic isolation, that npm
 * caching is enabled, and that NOTHING public is wired in (no deploy/publish/
 * release step) — per the M30 "nothing public / self-hostable" invariant.
 * Read-only; touches no real config.
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
  it('runs on Node 22 only (install.sh hard-fails below 22; no 20+22 matrix)', () => {
    // The CI uses a single node-version: "22" (not a matrix array).
    // A Node-20 entry would be wrong — install.sh rejects it at runtime.
    expect(ciYml).toMatch(/node-version:\s*["']?22["']?/);
    // Confirm Node 20 is NOT in the workflow as a version entry.
    expect(ciYml).not.toMatch(/node-version:\s*["']?20["']?/);
  });

  it('keeps the typecheck / lint / build / test steps (hermetic invocation)', () => {
    expect(ciYml).toContain('npm run typecheck');
    expect(ciYml).toContain('npm run lint');
    expect(ciYml).toContain('npm run build');
    // The hermetic test invocation isolates from the developer's ~/.ashlr/ state.
    // HOME=$(mktemp -d) is required so CI tests never read real local config.
    expect(ciYml).toMatch(/HOME=\$\(mktemp -d\).*vitest run/);
    expect(ciYml).toContain('--no-file-parallelism');
  });

  it('enables npm caching for fast installs', () => {
    expect(ciYml).toMatch(/cache:\s*["']?npm["']?/);
    expect(ciYml).toContain('npm ci');
  });

  it('adds NO deploy / publish / release step (nothing public)', () => {
    expect(ciYml).not.toMatch(/\b(npm\s+publish|deploy|release)\b/i);
    expect(ciYml).not.toMatch(/vercel|netlify|gh-pages|pages-deploy/i);
  });

  it('package.json engines field declares the supported Node floor', () => {
    // Keep npm metadata aligned with install.sh, CI, and release workflows.
    expect(pkg.engines?.node).toBe('>=22');
  });
});
