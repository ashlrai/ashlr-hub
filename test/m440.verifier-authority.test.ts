import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureVerifierCandidateState,
  captureVerifierAuthoritySnapshot,
  compareVerifierAuthorityCandidateTree,
  compareVerifierAuthorityWorktree,
  compareVerifierCandidateState,
  type VerifierAuthoritySnapshotV1,
} from '../src/core/run/verifier-authority.js';
import type { VerifyCommand } from '../src/core/run/verify-commands.js';

const MERGE_COMMANDS: VerifyCommand[] = [{
  id: 'test',
  kind: 'test',
  cmd: ['npm', 'test'],
  cwd: '.',
  timeoutMs: 120_000,
  required: true,
  profiles: ['merge'],
}];

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeContract(repo: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(repo, 'ashlr.verify.json'), `${JSON.stringify({
    schemaVersion: 1,
    mode: 'replace-detected',
    authorityFiles: ['package.json', 'scripts/verify.mjs'],
    commands: [{
      id: 'test',
      kind: 'test',
      cmd: ['npm', 'test'],
      required: true,
      profiles: ['merge'],
    }],
    ...overrides,
  }, null, 2)}\n`, 'utf8');
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'm386-verifier-authority-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'm386@example.invalid']);
  git(repo, ['config', 'user.name', 'M386']);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"m386"}\n', 'utf8');
  writeFileSync(join(repo, '.gitignore'), 'coverage/\n', 'utf8');
  writeFileSync(join(repo, 'scripts', 'verify.mjs'), 'process.exit(0);\n', 'utf8');
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
  writeContract(repo);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  return repo;
}

function capture(repo: string): VerifierAuthoritySnapshotV1 {
  const result = captureVerifierAuthoritySnapshot({
    repoRoot: repo,
    baseRevision: 'HEAD',
    mergeCommands: MERGE_COMMANDS,
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.reason);
  return result.snapshot;
}

function captureWithCommands(repo: string, mergeCommands: VerifyCommand[]) {
  return captureVerifierAuthoritySnapshot({
    repoRoot: repo,
    baseRevision: 'HEAD',
    mergeCommands,
  });
}

describe('verifier Git authority', () => {
  it('captures a deterministic domain-bound snapshot with contract self-inclusion', () => {
    const repo = makeRepo();
    try {
      writeContract(repo, { authorityFiles: ['scripts/verify.mjs', 'package.json'] });
      git(repo, ['add', 'ashlr.verify.json']);
      git(repo, ['commit', '-qm', 'reorder declaration']);

      const first = capture(repo);
      const second = capture(repo);

      expect(second).toEqual(first);
      expect(first.authoritySnapshotDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(first.authorityEntries.map((entry) => entry.path)).toEqual([
        'ashlr.verify.json',
        'package.json',
        'scripts/verify.mjs',
      ]);
      expect(first.contractBlobOid).toBe(first.authorityEntries[0]?.blobOid);
      expect(first.baseCommitOid).toBe(git(repo, ['rev-parse', 'HEAD']));
      expect(first.baseTreeOid).toBe(git(repo, ['rev-parse', 'HEAD^{tree}']));

      git(repo, ['commit', '--allow-empty', '-qm', 'same tree new authority epoch']);
      const nextCommit = capture(repo);
      expect(nextCommit.baseTreeOid).toBe(first.baseTreeOid);
      expect(nextCommit.baseCommitOid).not.toBe(first.baseCommitOid);
      expect(nextCommit.authoritySnapshotDigest).not.toBe(first.authoritySnapshotDigest);

      writeContract(repo, { authorityFiles: ['scripts/verify.mjs', 'package.json'], note: 'changed contract blob' });
      git(repo, ['add', 'ashlr.verify.json']);
      const candidateTree = git(repo, ['write-tree']);
      expect(compareVerifierAuthorityCandidateTree({
        repoRoot: repo,
        candidateRevision: candidateTree,
        snapshot: first,
      })).toMatchObject({ ok: false, code: 'authority-entry-changed' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    [{ schemaVersion: 2 }, 'contract-invalid-schema'],
    [{ mode: 'augment-detected' }, 'contract-invalid-mode'],
    [{ authorityFiles: [] }, 'contract-missing-authority-files'],
    [{ commands: [{ id: 'test', kind: 'test', cmd: ['npm', 'test'], required: false, profiles: ['merge'] }] },
      'contract-missing-required-merge-command'],
  ])('fails closed for an ineligible authority contract %#', (overrides, code) => {
    const repo = makeRepo();
    try {
      writeContract(repo, overrides);
      git(repo, ['add', 'ashlr.verify.json']);
      git(repo, ['commit', '-qm', 'invalid authority contract']);
      expect(captureVerifierAuthoritySnapshot({
        repoRoot: repo,
        baseRevision: 'HEAD',
        mergeCommands: MERGE_COMMANDS,
      })).toMatchObject({ ok: false, code });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('requires the verifier contract itself to be tracked at the repository root', () => {
    const repo = makeRepo();
    try {
      git(repo, ['rm', '-q', 'ashlr.verify.json']);
      git(repo, ['commit', '-qm', 'remove verifier contract']);
      writeContract(repo);

      expect(captureVerifierAuthoritySnapshot({
        repoRoot: repo,
        baseRevision: 'HEAD',
        mergeCommands: MERGE_COMMANDS,
      })).toMatchObject({ ok: false, code: 'contract-missing' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses an authority file that is untracked or missing from the base tree', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'untracked.mjs'), 'process.exit(0);\n', 'utf8');
      writeContract(repo, { authorityFiles: ['untracked.mjs'] });
      git(repo, ['add', 'ashlr.verify.json']);
      git(repo, ['commit', '-qm', 'declare untracked authority']);

      expect(captureVerifierAuthoritySnapshot({
        repoRoot: repo,
        baseRevision: 'HEAD',
        mergeCommands: MERGE_COMMANDS,
      })).toMatchObject({ ok: false, code: 'authority-entry-missing' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('requires directly named tracked argv inputs to be explicitly declared authority', () => {
    const repo = makeRepo();
    try {
      mkdirSync(join(repo, 'tests'), { recursive: true });
      writeFileSync(join(repo, 'tests', 'verify.test.js'), 'process.exit(0);\n', 'utf8');
      const commands: VerifyCommand[] = [{
        id: 'direct-test',
        kind: 'test',
        cmd: ['node', 'tests/verify.test.js'],
        cwd: '.',
        required: true,
        profiles: ['merge'],
      }];
      writeContract(repo, {
        authorityFiles: ['package.json'],
        commands: [{
          id: 'direct-test',
          kind: 'test',
          cmd: ['node', 'tests/verify.test.js'],
          required: true,
          profiles: ['merge'],
        }],
      });
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'add direct verifier input']);

      expect(captureWithCommands(repo, commands)).toMatchObject({
        ok: false,
        code: 'contract-missing-direct-argv-authority',
      });

      writeContract(repo, { authorityFiles: ['package.json', 'tests/verify.test.js'] });
      git(repo, ['add', 'ashlr.verify.json']);
      git(repo, ['commit', '-qm', 'declare direct verifier input']);
      const captured = captureWithCommands(repo, commands);
      expect(captured).toMatchObject({ ok: true });
      if (!captured.ok) throw new Error(captured.reason);
      expect(captured.snapshot.authorityEntries.map((entry) => entry.path)).toContain('tests/verify.test.js');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('canonicalizes contained absolute command cwd to portable repo-relative identity', () => {
    const repo = makeRepo();
    try {
      const nested = join(repo, 'apps', 'web');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'verify.mjs'), 'process.exit(0);\n', 'utf8');
      writeContract(repo, {
        authorityFiles: ['package.json', 'scripts/verify.mjs', 'apps/web/verify.mjs'],
        commands: [{
          id: 'nested-test',
          kind: 'test',
          cmd: ['node', 'verify.mjs'],
          cwd: 'apps/web',
          required: true,
          profiles: ['merge'],
        }],
      });
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'add nested verifier']);

      const command = {
        id: 'nested-test',
        kind: 'test' as const,
        cmd: ['node', 'verify.mjs'],
        required: true,
        profiles: ['merge' as const],
      };
      const absolute = captureWithCommands(repo, [{ ...command, cwd: nested }]);
      const relative = captureWithCommands(repo, [{ ...command, cwd: 'apps/web' }]);
      expect(absolute).toMatchObject({ ok: true });
      expect(relative).toMatchObject({ ok: true });
      if (!absolute.ok || !relative.ok) throw new Error('nested authority capture failed');
      expect(absolute.snapshot).toEqual(relative.snapshot);
      expect(absolute.snapshot.mergeCommands[0]?.cwd).toBe('apps/web');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses symlink and gitlink authority entries', () => {
    const repo = makeRepo();
    try {
      const target = join(repo, 'scripts', 'verify.mjs');
      let symlinkCreated = false;
      try {
        symlinkSync(target, join(repo, 'linked-verify.mjs'));
        symlinkCreated = true;
      } catch {
        // Windows may deny symlink creation without developer mode.
      }
      if (symlinkCreated) {
        writeContract(repo, { authorityFiles: ['linked-verify.mjs'] });
        git(repo, ['add', 'ashlr.verify.json', 'linked-verify.mjs']);
        git(repo, ['commit', '-qm', 'symlink authority']);
        expect(captureVerifierAuthoritySnapshot({
          repoRoot: repo,
          baseRevision: 'HEAD',
          mergeCommands: MERGE_COMMANDS,
        })).toMatchObject({ ok: false, code: 'authority-entry-not-regular' });
        git(repo, ['rm', '-q', 'linked-verify.mjs']);
      }
      writeContract(repo, { authorityFiles: ['vendor/submodule'] });
      git(repo, ['add', 'ashlr.verify.json']);
      const head = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['update-index', '--add', '--cacheinfo', `160000,${head},vendor/submodule`]);
      git(repo, ['commit', '-qm', 'gitlink authority']);
      expect(captureVerifierAuthoritySnapshot({
        repoRoot: repo,
        baseRevision: 'HEAD',
        mergeCommands: MERGE_COMMANDS,
      })).toMatchObject({ ok: false, code: 'authority-entry-not-blob' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects candidate authority mutation and accepts ordinary source changes', () => {
    const repo = makeRepo();
    try {
      const snapshot = capture(repo);
      writeFileSync(join(repo, 'scripts', 'verify.mjs'), 'process.exit(1);\n', 'utf8');
      git(repo, ['add', 'scripts/verify.mjs']);
      const authorityTree = git(repo, ['write-tree']);

      expect(compareVerifierAuthorityCandidateTree({
        repoRoot: repo,
        candidateRevision: authorityTree,
        snapshot,
      })).toMatchObject({ ok: false, code: 'authority-entry-changed' });
      expect(compareVerifierAuthorityWorktree({ repoRoot: repo, snapshot }))
        .toMatchObject({ ok: false, code: 'authority-index-mismatch' });

      git(repo, ['restore', '--staged', 'scripts/verify.mjs']);
      git(repo, ['restore', 'scripts/verify.mjs']);
      writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
      git(repo, ['add', 'src/index.ts']);
      const sourceTree = git(repo, ['write-tree']);

      expect(compareVerifierAuthorityCandidateTree({
        repoRoot: repo,
        candidateRevision: sourceTree,
        snapshot,
      })).toMatchObject({ ok: true, checkedEntryCount: 3, candidateTreeOid: sourceTree });
      expect(compareVerifierAuthorityWorktree({ repoRoot: repo, snapshot }))
        .toEqual({ ok: true, checkedEntryCount: 3 });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a live authority file reached through a symlinked parent component', () => {
    const repo = makeRepo();
    try {
      const snapshot = capture(repo);
      renameSync(join(repo, 'scripts'), join(repo, 'scripts-real'));
      try {
        symlinkSync(
          join(repo, 'scripts-real'),
          join(repo, 'scripts'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch {
        return;
      }

      expect(compareVerifierAuthorityWorktree({ repoRoot: repo, snapshot })).toMatchObject({
        ok: false,
        code: 'authority-worktree-symlink-component',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fences staged, tracked, and relevant untracked drift while allowing ignored verifier outputs', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
      git(repo, ['add', 'src/index.ts']);
      const candidateTreeOid = git(repo, ['write-tree']);
      const captured = captureVerifierCandidateState({ repoRoot: repo, candidateTreeOid });
      expect(captured).toMatchObject({ ok: true });
      if (!captured.ok) throw new Error(captured.reason);

      writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 3;\n', 'utf8');
      expect(compareVerifierCandidateState({ repoRoot: repo, snapshot: captured.snapshot }))
        .toMatchObject({ ok: false, code: 'candidate-worktree-changed' });

      git(repo, ['checkout-index', '--force', '--', 'src/index.ts']);
      writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 4;\n', 'utf8');
      git(repo, ['add', 'src/index.ts']);
      expect(compareVerifierCandidateState({ repoRoot: repo, snapshot: captured.snapshot }))
        .toMatchObject({ ok: false, code: 'candidate-index-changed' });

      git(repo, ['read-tree', candidateTreeOid]);
      git(repo, ['checkout-index', '--force', '--', 'src/index.ts']);
      git(repo, ['update-index', '--refresh']);
      writeFileSync(join(repo, 'verifier-output.txt'), 'unexpected\n', 'utf8');
      expect(compareVerifierCandidateState({ repoRoot: repo, snapshot: captured.snapshot }))
        .toMatchObject({ ok: false, code: 'candidate-untracked-path' });

      rmSync(join(repo, 'verifier-output.txt'));
      mkdirSync(join(repo, 'coverage'), { recursive: true });
      writeFileSync(join(repo, 'coverage', 'report.json'), '{}\n', 'utf8');
      expect(compareVerifierCandidateState({ repoRoot: repo, snapshot: captured.snapshot }))
        .toEqual({ ok: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
