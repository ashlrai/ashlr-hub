/**
 * M33 — distribution metadata: package.json publish shape, the exports map,
 * the release scripts (check-version / extract-changelog), and the release
 * workflow's gates. Pure filesystem reads + child-process runs of the
 * scripts; no network, no HOME mutation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  expect.hasAssertions();
});

describe('package.json publish shape', () => {
  it('is the public scoped package with provenance', () => {
    expect(pkg['name']).toBe('@ashlr/hub');
    expect(pkg['private']).toBeUndefined();
    expect((pkg['publishConfig'] as Record<string, unknown>)['access']).toBe('public');
    expect((pkg['publishConfig'] as Record<string, unknown>)['provenance']).toBe(true);
  });

  it('gates publish behind the full verification suite', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['prepublishOnly']).toContain('typecheck');
    expect(scripts['prepublishOnly']).toContain('test');
    expect(scripts['prepack']).toContain('build');
  });

  it('exports map covers ., ./core, ./types, ./plugin with types conditions', () => {
    const exports = pkg['exports'] as Record<string, Record<string, string> | string>;
    for (const entry of ['.', './core', './types', './plugin']) {
      const e = exports[entry];
      expect(e, `missing exports["${entry}"]`).toBeTruthy();
      expect((e as Record<string, string>)['types']).toMatch(/^\.\/dist\/api\/.+\.d\.ts$/);
      expect((e as Record<string, string>)['import']).toMatch(/^\.\/dist\/api\/.+\.js$/);
    }
    expect(exports['./package.json']).toBe('./package.json');
  });

  it('the api source files behind the exports map exist', () => {
    for (const f of ['index.ts', 'core.ts', 'types.ts', 'plugin.ts']) {
      expect(existsSync(join(REPO_ROOT, 'src', 'api', f)), `src/api/${f} missing`).toBe(true);
    }
  });
});

describe('release scripts', () => {
  it('check-version passes on a matching tag and fails on a mismatch', () => {
    const version = pkg['version'] as string;
    const ok = execFileSync('node', [join(REPO_ROOT, 'scripts/check-version.mjs'), `v${version}`], {
      encoding: 'utf8',
    });
    expect(ok).toContain('ok');

    expect(() =>
      execFileSync('node', [join(REPO_ROOT, 'scripts/check-version.mjs'), 'v0.0.1-nope'], {
        encoding: 'utf8', stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('extract-changelog prints the current version section and fails on unknown versions', () => {
    const version = pkg['version'] as string;
    const body = execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), version], {
      encoding: 'utf8',
    });
    expect(body.trim().length).toBeGreaterThan(50);

    expect(() =>
      execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), '0.0.1-nope'], {
        encoding: 'utf8', stdio: 'pipe',
      }),
    ).toThrow();
  });
});

describe('release workflow', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
  const ciWorkflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const verifyJob = workflow.match(/^ {2}verify:\n[\s\S]*?(?=^ {2}publish:)/m)?.[0] ?? '';

  it('is tag-triggered and reuses the exact native CI gate before publish', () => {
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain('needs: verify');
    expect(verifyJob).toContain('uses: ./.github/workflows/ci.yml');
    expect(ciWorkflow).toMatch(/(?:^|\n)\s{2}workflow_call:\s*(?:\n|$)/);
    expect(verifyJob).not.toContain('runs-on:');
    expect(verifyJob).not.toContain('steps:');
    expect(verifyJob).not.toContain('secrets:');
    expect(verifyJob).not.toContain('environment:');
    expect(ciWorkflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(ciWorkflow).not.toMatch(/^\s+environment:/m);
  });

  it('publishes with provenance and gates on version+changelog scripts', () => {
    expect(workflow).toContain('npm publish --provenance --access public');
    expect(workflow).toContain('scripts/check-version.mjs');
    expect(workflow).toContain('scripts/extract-changelog.mjs');
    expect(workflow).toContain('id-token: write');
  });
});
