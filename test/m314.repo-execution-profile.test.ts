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
  it('surfaces malformed package metadata to source-bound scanners', () => {
    const dir = makeFixture();
    try {
      writeFileSync(join(dir, 'package.json'), '{"scripts":', 'utf8');
      expect(detectRepoExecutionProfile(dir).mergeVerifyContractSource.inputState).toBe('malformed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('canonicalizes merge-contract scanner inputs without absolute repo paths', () => {
    const first = makeFixture();
    const second = makeFixture();
    try {
      for (const dir of [first, second]) {
        const nested = join(dir, 'apps', 'web');
        mkdirSync(nested, { recursive: true });
        writePkg(nested, { scripts: { test: 'vitest', typecheck: 'tsc --noEmit' } });
        writeFileSync(join(nested, 'package-lock.json'), '{}\n', 'utf8');
      }

      const firstSource = detectRepoExecutionProfile(first).mergeVerifyContractSource;
      const secondSource = detectRepoExecutionProfile(second).mergeVerifyContractSource;

      expect(firstSource).toEqual(secondSource);
      expect(JSON.stringify(firstSource)).not.toContain(first);
      expect(firstSource.detectedVerifyCommands).toEqual([
        { kind: 'test', cmd: ['npm', 'run', 'test'], cwd: 'apps/web' },
        { kind: 'typecheck', cmd: ['npm', 'run', 'typecheck'], cwd: 'apps/web' },
      ]);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('includes scanner-relevant contract semantics in the canonical source', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { test: 'vitest' } });
      const before = detectRepoExecutionProfile(dir).mergeVerifyContractSource;
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [{ id: 'merge', kind: 'test', cmd: ['npm', 'test'], required: true, profiles: ['merge'] }],
      });
      const after = detectRepoExecutionProfile(dir).mergeVerifyContractSource;

      expect(before.verifyContract).toBeNull();
      expect(after.verifyContract).toMatchObject({
        summary: { present: true, valid: true, mergeGradeExplicit: true },
        commands: [{ id: 'merge', kind: 'test', cmd: ['npm', 'test'], required: true, profiles: ['merge'] }],
      });
      expect(after.detectedVerifyCommands).toEqual(before.detectedVerifyCommands);
      expect(after.projectKinds).toEqual(before.projectKinds);
      expect(after.projectKinds).toEqual(['node']);
      expect(after).not.toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('requires replace-detected merge contracts to cover nested distinct ecosystems at their own cwd', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { test: 'vitest' } });
      const python = join(dir, 'packages', 'sdk-python');
      const formula = join(dir, 'integrations', 'homebrew');
      mkdirSync(join(python, 'tests'), { recursive: true });
      mkdirSync(join(formula, 'Formula'), { recursive: true });
      writeFileSync(join(python, 'pyproject.toml'), '[project]\nname = "sdk-python"\n', 'utf8');
      writeFileSync(join(python, 'tests', 'test_smoke.py'), 'def test_smoke():\n    assert True\n', 'utf8');
      writeFileSync(join(formula, 'Formula', 'ashlr.rb'), 'class Ashlr < Formula\nend\n', 'utf8');
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [{
          id: 'root-test', kind: 'test', cmd: ['npm', 'test'], required: true, profiles: ['merge'],
        }],
      });

      const incomplete = detectRepoExecutionProfile(dir);
      expect(incomplete.verifyContract).toMatchObject({
        mergeGradeExplicit: true,
        mergeCoverageComplete: false,
        uncoveredMergeProjects: [
          { kind: 'homebrew-formula', relativeRoot: 'integrations/homebrew' },
          { kind: 'python', relativeRoot: 'packages/sdk-python' },
        ],
      });
      expect(incomplete.verifyContract?.mergeGradeReason).toContain('missing required merge coverage');

      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          { id: 'root-test', kind: 'test', cmd: ['npm', 'test'], required: true, profiles: ['merge'] },
          { id: 'python-test', kind: 'test', cmd: ['python', '-m', 'pytest', '-q'], cwd: 'packages/sdk-python', required: true, profiles: ['merge'] },
          { id: 'formula-syntax', kind: 'typecheck', cmd: ['ruby', '-c', 'Formula/ashlr.rb'], cwd: 'integrations/homebrew', required: true, profiles: ['merge'] },
        ],
      });

      expect(detectRepoExecutionProfile(dir).verifyContract).toMatchObject({
        mergeGradeExplicit: true,
        mergeCoverageComplete: true,
        uncoveredMergeProjects: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not infer nested same-kind coverage from a root command', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { test: 'vitest' } });
      const nested = join(dir, 'packages', 'sdk');
      mkdirSync(nested, { recursive: true });
      writePkg(nested, { scripts: { test: 'vitest' } });
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [{ id: 'root-test', kind: 'test', cmd: ['npm', 'test'], required: true, profiles: ['merge'] }],
      });

      const incomplete = detectRepoExecutionProfile(dir);
      expect(incomplete.verifyContract).toMatchObject({
        mergeCoverageComplete: false,
        uncoveredMergeProjects: [{ kind: 'node', relativeRoot: 'packages/sdk' }],
      });

      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          { id: 'root-test', kind: 'test', cmd: ['npm', 'test'], required: true, profiles: ['merge'] },
          { id: 'sdk-test', kind: 'test', cmd: ['npm', 'test'], cwd: 'packages/sdk', required: true, profiles: ['merge'] },
        ],
      });
      expect(detectRepoExecutionProfile(dir).verifyContract?.mergeCoverageComplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts effective detected commands toward augment-detected nested coverage', () => {
    const dir = makeFixture();
    try {
      const python = join(dir, 'packages', 'sdk-python');
      mkdirSync(join(python, 'tests'), { recursive: true });
      writeFileSync(join(python, 'pyproject.toml'), '[project]\nname = "sdk-python"\n', 'utf8');
      writeFileSync(join(python, 'tests', 'test_smoke.py'), 'def test_smoke():\n    assert True\n', 'utf8');
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'augment-detected',
        commands: [{ id: 'root-check', kind: 'typecheck', cmd: ['node', '-e', 'process.exit(0)'], required: true, profiles: ['merge'] }],
      });

      const profile = detectRepoExecutionProfile(dir);
      expect(profile.verifyCommands).toHaveLength(2);
      expect(profile.verifyContract).toMatchObject({ mergeGradeExplicit: true, mergeCoverageComplete: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires distinct detected verifier signatures for co-located ecosystems', () => {
    const dir = makeFixture();
    try {
      const mixed = join(dir, 'packages', 'mixed');
      mkdirSync(join(mixed, 'tests'), { recursive: true });
      writePkg(mixed, { scripts: { test: 'vitest' } });
      writeFileSync(join(mixed, 'pyproject.toml'), '[project]\nname = "mixed"\n', 'utf8');
      writeFileSync(join(mixed, 'tests', 'test_smoke.py'), 'def test_smoke():\n    assert True\n', 'utf8');
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          { id: 'node-test', kind: 'test', cmd: ['npm', 'run', 'test'], cwd: 'packages/mixed', required: true, profiles: ['merge'] },
        ],
      });

      const incomplete = detectRepoExecutionProfile(dir);
      expect(incomplete.projects
        .filter((project) => project.relativeRoot === 'packages/mixed')
        .map((project) => project.kind))
        .toEqual(['node', 'python']);
      expect(incomplete.verifyContract).toMatchObject({
        mergeCoverageComplete: false,
        uncoveredMergeProjects: [{ kind: 'python', relativeRoot: 'packages/mixed' }],
      });

      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          { id: 'node-test', kind: 'test', cmd: ['npm', 'run', 'test'], cwd: 'packages/mixed', required: true, profiles: ['merge'] },
          { id: 'python-test', kind: 'test', cmd: ['python', '-m', 'pytest', '-q'], cwd: 'packages/mixed', required: true, profiles: ['merge'] },
        ],
      });

      expect(detectRepoExecutionProfile(dir).verifyContract).toMatchObject({
        mergeCoverageComplete: true,
        uncoveredMergeProjects: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not exempt co-located root ecosystems from merge coverage', () => {
    const dir = makeFixture();
    try {
      mkdirSync(join(dir, 'tests'), { recursive: true });
      writePkg(dir, { scripts: { test: 'vitest' } });
      writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "root-mixed"\n', 'utf8');
      writeFileSync(join(dir, 'tests', 'test_smoke.py'), 'def test_smoke():\n    assert True\n', 'utf8');
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          { id: 'node-test', kind: 'test', cmd: ['npm', 'run', 'test'], required: true, profiles: ['merge'] },
        ],
      });

      const profile = detectRepoExecutionProfile(dir);
      expect(profile.projects.map((project) => project.kind)).toEqual(['node', 'python']);
      expect(profile.verifyContract).toMatchObject({
        mergeCoverageComplete: false,
        uncoveredMergeProjects: [{ kind: 'python', relativeRoot: '.' }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails merge coverage closed when bounded discovery is truncated', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { test: 'vitest' } });
      mkdirSync(join(dir, 'deeper'), { recursive: true });
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [{ id: 'root-test', kind: 'test', cmd: ['npm', 'run', 'test'], required: true, profiles: ['merge'] }],
      });

      const profile = detectRepoExecutionProfile(dir, { maxDepth: 0 });

      expect(profile.projectDiscoveryTruncated).toBe(true);
      expect(profile.mergeVerifyContractSource.inputState).toBe('depth-truncated');
      expect(profile.verifyContract).toMatchObject({ mergeCoverageComplete: false });
      expect(profile.verifyContract?.mergeGradeReason).toContain('project discovery reached depth limit 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores agent worktrees and fixture projects during merge coverage discovery', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { test: 'vitest' } });
      const agentWorktree = join(dir, '.claude', 'worktrees', 'agent', 'app');
      const fixtureProject = join(dir, 'test', 'fixtures', 'sample-app');
      mkdirSync(agentWorktree, { recursive: true });
      mkdirSync(fixtureProject, { recursive: true });
      writePkg(agentWorktree, { scripts: { test: 'vitest' } });
      writePkg(fixtureProject, { scripts: { test: 'vitest' } });
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [{ id: 'root-test', kind: 'test', cmd: ['npm', 'run', 'test'], required: true, profiles: ['merge'] }],
      });

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.projects.map((project) => project.relativeRoot)).toEqual(['.']);
      expect(profile.projectDiscoveryTruncated).toBe(false);
      expect(profile.verifyContract?.mergeCoverageComplete).toBe(true);
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

  it('accepts native build commands in root verification contracts', () => {
    const dir = makeFixture();
    try {
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          {
            id: 'build',
            kind: 'build',
            cmd: ['npm', 'run', 'build'],
            required: true,
            profiles: ['merge'],
          },
        ],
      });

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.verifyCommands).toEqual([
        { id: 'build', kind: 'build', cmd: ['npm', 'run', 'build'], required: true, profiles: ['merge'] },
      ]);
      expect(profile.verifyContract).toMatchObject({
        present: true,
        valid: true,
        commandCount: 1,
        requiredCount: 1,
        mergeProfileCommandCount: 1,
        requiredMergeProfileCommandCount: 1,
        mergeGradeExplicit: true,
      });
      expect(profile.noVerifyReason).toBeNull();
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

  it('rejects contract cwd symlinks that escape the repository', () => {
    const dir = makeFixture();
    const outside = makeFixture();
    try {
      symlinkSync(outside, join(dir, 'linked-outside'), 'dir');
      writeVerifyContract(dir, {
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          {
            id: 'escape-via-symlink',
            kind: 'test',
            cmd: ['node', 'verify.js'],
            cwd: 'linked-outside',
          },
        ],
      });

      const profile = detectRepoExecutionProfile(dir);

      expect(profile.verifyCommands).toEqual([]);
      expect(profile.verifyContract?.valid).toBe(false);
      expect(profile.verifyContract?.errors.join('\n')).toContain('cwd must stay inside the repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
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
