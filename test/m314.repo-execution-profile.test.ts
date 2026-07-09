import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectPackageManager,
  detectRepoExecutionProfile,
} from '../src/core/run/repo-profile.js';

function makeFixture(): string {
  return mkdtempSync(join(tmpdir(), 'm314-profile-'));
}

function writePkg(dir: string, pkg: unknown): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
}

function writeVerifyContract(dir: string, contract: unknown): void {
  writeFileSync(join(dir, 'ashlr.verify.json'), JSON.stringify(contract), 'utf8');
}

describe('repo execution profile', () => {
  it('honors packageManager before lockfiles', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { packageManager: 'bun@1.2.0', scripts: { test: 'vitest' } });
      writeFileSync(join(dir, 'package-lock.json'), '{}\n', 'utf8');

      expect(detectPackageManager(dir)).toBe('bun');
      expect(detectRepoExecutionProfile(dir).verifyCommands[0]?.cmd).toEqual(['bun', 'run', 'test']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses root verification commands when the root project has them', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { typecheck: 'tsc --noEmit' } });
      const nested = join(dir, 'apps', 'web');
      mkdirSync(nested, { recursive: true });
      writePkg(nested, { scripts: { test: 'vitest' } });

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.projects.map((project) => project.relativeRoot)).toEqual(['.', 'apps/web']);
      expect(profile.verifyCommands).toEqual([
        { kind: 'typecheck', cmd: ['npm', 'run', 'typecheck'] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to nested project commands when the repo root has no verifier', () => {
    const dir = makeFixture();
    try {
      const nested = join(dir, 'server');
      mkdirSync(nested, { recursive: true });
      writePkg(nested, { scripts: { check: 'tsc --noEmit', test: 'vitest' } });
      writeFileSync(join(nested, 'bun.lock'), '# bun lockfile\n', 'utf8');

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.primaryProject?.relativeRoot).toBe('server');
      expect(profile.verifyCommands).toEqual([
        { kind: 'typecheck', cmd: ['bun', 'run', 'check'], cwd: nested },
        { kind: 'test', cmd: ['bun', 'run', 'test'], cwd: nested },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects Cargo workspace verification', () => {
    const dir = makeFixture();
    try {
      writeFileSync(join(dir, 'Cargo.toml'), '[workspace]\nmembers = []\n', 'utf8');

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.projects[0]).toMatchObject({
        kind: 'rust',
        packageManager: 'cargo',
        relativeRoot: '.',
      });
      expect(profile.verifyCommands).toEqual([
        { kind: 'typecheck', cmd: ['cargo', 'check'] },
        { kind: 'test', cmd: ['cargo', 'test'] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces detected commands with a root verification contract', () => {
    const dir = makeFixture();
    try {
      const tools = join(dir, 'tools');
      mkdirSync(tools, { recursive: true });
      writePkg(dir, { scripts: { test: 'vitest' } });
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          {
            id: 'quick-contract',
            kind: 'test',
            cmd: ['node', 'tools/verify.js'],
            cwd: 'tools',
            timeoutMs: 45_000,
            required: true,
            profiles: ['quick', 'merge'],
          },
        ],
      });

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.verifyContract).toMatchObject({
        present: true,
        valid: true,
        schemaVersion: 1,
        mode: 'replace-detected',
        commandCount: 1,
        requiredCount: 1,
        profileCounts: { quick: 1, merge: 1 },
        mergeProfileCommandCount: 1,
        requiredMergeProfileCommandCount: 1,
        mergeGradeExplicit: true,
      });
      expect(profile.verifyContract?.mergeGradeReason).toContain('1 required merge-profile');
      expect(profile.verifyCommandSource).toBe('contract');
      expect(profile.detectedVerifyCommandCount).toBe(1);
      expect(profile.contractVerifyCommandCount).toBe(1);
      expect(profile.noVerifyReason).toBeNull();
      expect(profile.projects[0]?.manifests).toContain('ashlr.verify.json');
      expect(profile.verifyCommands).toEqual([
        {
          id: 'quick-contract',
          kind: 'test',
          cmd: ['node', 'tools/verify.js'],
          cwd: tools,
          timeoutMs: 45_000,
          required: true,
          profiles: ['quick', 'merge'],
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes valid contracts from explicit merge-grade contracts', () => {
    const dir = makeFixture();
    try {
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          {
            id: 'quick-only',
            kind: 'test',
            cmd: ['node', 'verify.js'],
            required: true,
            profiles: ['quick'],
          },
        ],
      });

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.verifyCommands).toEqual([
        { id: 'quick-only', kind: 'test', cmd: ['node', 'verify.js'], required: true, profiles: ['quick'] },
      ]);
      expect(profile.verifyContract).toMatchObject({
        present: true,
        valid: true,
        commandCount: 1,
        requiredCount: 1,
        profileCounts: { quick: 1 },
        mergeProfileCommandCount: 0,
        requiredMergeProfileCommandCount: 0,
        mergeGradeExplicit: false,
        mergeGradeReason: 'no command declares the merge profile',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('augments detected commands with root verification contract commands', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { typecheck: 'tsc --noEmit' } });
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'augment-detected',
        commands: [
          {
            id: 'deep-lint',
            kind: 'lint',
            cmd: ['node', 'scripts/lint.js'],
            profiles: ['deep'],
          },
        ],
      });

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.verifyCommandSource).toBe('mixed');
      expect(profile.detectedVerifyCommandCount).toBe(1);
      expect(profile.contractVerifyCommandCount).toBe(1);
      expect(profile.verifyCommands).toEqual([
        { kind: 'typecheck', cmd: ['npm', 'run', 'typecheck'] },
        { id: 'deep-lint', kind: 'lint', cmd: ['node', 'scripts/lint.js'], profiles: ['deep'] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe contract cwd values and reports the no-command reason', () => {
    const dir = makeFixture();
    try {
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          {
            id: 'escape',
            kind: 'test',
            cmd: ['node', 'verify.js'],
            cwd: '../outside',
          },
        ],
      });

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.verifyCommands).toEqual([]);
      expect(profile.verifyContract).toMatchObject({
        present: true,
        valid: false,
        commandCount: 0,
        requiredCount: 0,
        mergeProfileCommandCount: 0,
        requiredMergeProfileCommandCount: 0,
        mergeGradeExplicit: false,
      });
      expect(profile.verifyContract?.mergeGradeReason).toContain('invalid ashlr.verify.json');
      expect(profile.verifyContract?.errors.join('\n')).toContain('cwd must stay inside the repo');
      expect(profile.projects[0]).toMatchObject({ kind: 'verify-contract', relativeRoot: '.' });
      expect(profile.noVerifyReason).toContain('invalid ashlr.verify.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects shell-only Bats repos without package manifests', () => {
    const dir = makeFixture();
    try {
      mkdirSync(join(dir, 'tests'), { recursive: true });
      writeFileSync(join(dir, 'tests', 'smoke.bats'), '@test "smoke" { true; }\n', 'utf8');

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.projects[0]).toMatchObject({
        kind: 'bats',
        packageManager: 'bats',
        scripts: ['test'],
      });
      expect(profile.verifyCommands).toEqual([
        { kind: 'test', cmd: ['bats', join('tests', 'smoke.bats')] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects Python pytest, mypy, and ruff verification when configured', () => {
    const dir = makeFixture();
    try {
      mkdirSync(join(dir, 'tests'), { recursive: true });
      writeFileSync(
        join(dir, 'pyproject.toml'),
        '[tool.ruff]\nline-length = 100\n[tool.mypy]\npython_version = "3.12"\n',
        'utf8',
      );
      writeFileSync(join(dir, 'tests', 'test_smoke.py'), 'def test_smoke():\n    assert True\n', 'utf8');

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.projects[0]).toMatchObject({
        kind: 'python',
        packageManager: 'python',
        scripts: ['mypy', 'pytest', 'ruff'],
      });
      expect(profile.verifyCommands).toEqual([
        { kind: 'typecheck', cmd: ['python', '-m', 'mypy', '.'] },
        { kind: 'test', cmd: ['python', '-m', 'pytest', '-q'] },
        { kind: 'lint', cmd: ['python', '-m', 'ruff', 'check', '.'] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects Homebrew formula syntax without tap-trust-dependent audit commands', () => {
    const dir = makeFixture();
    try {
      mkdirSync(join(dir, 'Formula'), { recursive: true });
      writeFileSync(join(dir, 'Formula', 'ashlr.rb'), 'class Ashlr < Formula\nend\n', 'utf8');

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.projects[0]).toMatchObject({
        kind: 'homebrew-formula',
        packageManager: 'brew',
        scripts: ['ruby-syntax'],
      });
      expect(profile.verifyCommands).toEqual([
        { kind: 'typecheck', cmd: ['ruby', '-c', join('Formula', 'ashlr.rb')] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips dependency/build artifact directories while discovering nested roots', () => {
    const dir = makeFixture();
    try {
      const ignored = join(dir, 'node_modules', 'pkg');
      const included = join(dir, 'packages', 'real');
      mkdirSync(ignored, { recursive: true });
      mkdirSync(included, { recursive: true });
      writePkg(ignored, { scripts: { test: 'should-not-run' } });
      writePkg(included, { scripts: { test: 'vitest' } });

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.projects.map((project) => project.relativeRoot)).toEqual(['packages/real']);
      expect(profile.verifyCommands).toEqual([
        { kind: 'test', cmd: ['npm', 'run', 'test'], cwd: included },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips symlinked project directories during discovery', () => {
    const dir = makeFixture();
    const outside = makeFixture();
    try {
      writePkg(outside, { scripts: { test: 'should-not-run' } });
      try {
        symlinkSync(outside, join(dir, 'linked-package'), 'dir');
      } catch {
        return;
      }

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.projects).toHaveLength(0);
      expect(profile.verifyCommands).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
