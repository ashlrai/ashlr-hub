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
