import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowText = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
const releaseDocs = readFileSync(join(repoRoot, 'docs/RELEASING.md'), 'utf8');
const workflow = parse(workflowText) as {
  jobs: Record<string, {
    environment?: string;
    needs?: string | string[];
    permissions?: Record<string, string>;
    steps?: Array<Record<string, unknown>>;
    'runs-on'?: string;
    'timeout-minutes'?: number;
  }>;
};
const canary = workflow.jobs.release_canary!;
const publish = workflow.jobs.publish!;
const steps = canary.steps ?? [];
const step = (name: string) => steps.find((entry) => entry.name === name);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim();
}

function commit(cwd: string, name: string, value: string): string {
  writeFileSync(join(cwd, name), `${value}\n`);
  git(cwd, ['add', name]);
  git(cwd, ['-c', 'user.name=Canary Test', '-c', 'user.email=canary@example.invalid',
    'commit', '-m', value]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

describe('release workflow signed canary gate', () => {
  it('keeps the disposable canary credential-minimized and gates publication', () => {
    expect(canary).toMatchObject({
      needs: 'verify',
      permissions: { contents: 'read' },
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 30,
    });
    expect(canary.environment).toBeUndefined();
    expect(publish.needs).toEqual(['verify', 'release_canary']);

    expect(steps[0]).toEqual({
      name: 'Checkout the immutable event commit',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        'fetch-depth': 0,
        'persist-credentials': false,
        ref: '${{ github.sha }}',
      },
    });
    expect(step('Set up Node.js 24')).toMatchObject({
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': '24', 'package-manager-cache': false },
    });
    expect(step('Install dependencies without lifecycle scripts')?.run)
      .toBe('npm ci --ignore-scripts --no-audit --no-fund');

    const run = String(step('Run and verify bounded NO_AUTHORITY receipt')?.run ?? '');
    expect(run).toContain('env -i');
    expect(run).toContain('--candidate "$GITHUB_SHA"');
    expect(run).toContain('--expected-revision "$GITHUB_SHA"');
    expect(run).toContain('--rollback "${{ steps.revisions.outputs.rollback }}"');
    expect(run).toContain('--trusted-protected-source');
    expect(run).toContain('verify-signed-release-canary-receipt.mjs');
    expect(run).toContain('receipt_bytes > 1048576');
    expect(run).toContain('observed_sha256" != "$receipt_sha256');

    expect(step('Upload bounded signed canary evidence')).toMatchObject({
      uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      with: {
        name: 'signed-release-canary-${{ github.run_id }}-${{ github.run_attempt }}',
        'if-no-files-found': 'error',
        'retention-days': 7,
        'compression-level': 9,
        overwrite: false,
        'include-hidden-files': false,
      },
    });
    const uploadPath = String((step('Upload bounded signed canary evidence')?.with as {
      path?: unknown;
    } | undefined)?.path ?? '');
    expect(uploadPath.trim().split('\n')).toEqual([
      '${{ steps.canary.outputs.receipt }}',
      '${{ steps.canary.outputs.digest }}',
    ]);
    const summary = String(step('Summarize observation-only canary evidence')?.run ?? '');
    expect(summary).toContain('Signed release canary (NO_AUTHORITY)');
    expect(summary).toContain('Receipt SHA-256');
    expect(summary).toContain('Artifact SHA-256');

    const serialized = JSON.stringify(canary);
    expect(serialized).not.toMatch(/npm publish|npm-release|id-token|secrets\.|github\.token/);
    expect(releaseDocs).toContain('GitHub-hosted runner retains\nnetwork access');
    expect(releaseDocs).toContain('same workflow commit being evaluated');
    expect(releaseDocs).toContain('signature proves receipt self-consistency only');
    expect(releaseDocs).toContain('not independent release authority');
  });

  it.skipIf(process.platform === 'win32')(
    'selects the distinct immediate first parent of a merge candidate',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'ashlr-release-canary-parent-'));
      try {
        git(root, ['init', '-b', 'master']);
        commit(root, 'base.txt', 'base');
        git(root, ['checkout', '-b', 'feature']);
        const feature = commit(root, 'feature.txt', 'feature');
        git(root, ['checkout', 'master']);
        const firstParent = commit(root, 'main.txt', 'main');
        git(root, ['-c', 'user.name=Canary Test', '-c', 'user.email=canary@example.invalid',
          'merge', '--no-ff', 'feature', '-m', 'merge feature']);
        const candidate = git(root, ['rev-parse', 'HEAD']);
        const output = join(root, 'github-output');
        const selection = String(step('Bind candidate and distinct first-parent rollback')?.run ?? '');

        execFileSync('/bin/bash', ['-c', selection], {
          cwd: root,
          env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_SHA: candidate },
          stdio: 'pipe',
        });

        expect(readFileSync(output, 'utf8')).toBe(`rollback=${firstParent}\n`);
        expect(firstParent).not.toBe(feature);
        expect(firstParent).not.toBe(candidate);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('fails closed when no rollback parent exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-release-canary-root-'));
    try {
      git(root, ['init', '-b', 'master']);
      const candidate = commit(root, 'initial.txt', 'initial');
      const output = join(root, 'github-output');
      const selection = String(step('Bind candidate and distinct first-parent rollback')?.run ?? '');

      expect(() => execFileSync('/bin/bash', ['-c', selection], {
        cwd: root,
        env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_SHA: candidate },
        stdio: 'pipe',
      })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
