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
    // The canonical test runner isolates HOME and adds a watchdog timeout.
    expect(ciYml).toContain('npm run test:ci');
    expect(pkg.scripts?.['test:ci']).toContain('scripts/test-ci.mjs');
  });

  it('runs Ubuntu exhaustively and Windows as three named portability shards', () => {
    expect(ciYml.match(/os:\s*ubuntu-latest/g)).toHaveLength(1);
    expect(ciYml.match(/os:\s*windows-latest/g)).toHaveLength(3);
    for (const shard of ['1/3', '2/3', '3/3']) {
      expect(ciYml.match(new RegExp(`--shard=${shard.replace('/', '\\/')}`, 'g'))).toHaveLength(1);
    }
    expect(ciYml).toContain('test_args: ""');
    for (const portabilitySurface of [
      'm43.verify-commands.test.ts',
      'm153.verification-gate.test.ts',
      'm315.remote-handoff-truth.test.ts',
      'm354.trajectory-records.test.ts',
      'm370.branch-protection-attestation.test.ts',
      'm373.directory-durability.test.ts',
    ]) {
      expect(ciYml.match(new RegExp(portabilitySurface.replaceAll('.', '\\.'), 'g'))).toHaveLength(3);
    }
    expect(ciYml).toContain('npm run test:ci -- ${{ matrix.test_args }}');
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
