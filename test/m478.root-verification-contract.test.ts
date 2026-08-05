import { describe, expect, it } from 'vitest';
import { detectRepoExecutionProfile } from '../src/core/run/repo-profile.js';

describe('M478 root verification contract', () => {
  it('declares a fail-closed merge and deep verification surface', () => {
    const profile = detectRepoExecutionProfile(process.cwd());

    expect(profile.verifyCommandSource).toBe('contract');
    expect(profile.verifyContract).toMatchObject({
      present: true,
      valid: true,
      mode: 'replace-detected',
      commandCount: 4,
      requiredCount: 4,
      profileCounts: { quick: 1, merge: 4, deep: 4 },
      mergeProfileCommandCount: 4,
      requiredMergeProfileCommandCount: 4,
      mergeGradeExplicit: true,
      authorityFileCount: 9,
    });
    expect(profile.verifyContract?.errors).toEqual([]);
    expect(profile.verifyCommands.map((command) => ({
      id: command.id,
      kind: command.kind,
      cmd: command.cmd,
      timeoutMs: command.timeoutMs,
      required: command.required,
      profiles: command.profiles,
    }))).toEqual([
      {
        id: 'typecheck',
        kind: 'typecheck',
        cmd: ['npm', 'run', 'typecheck'],
        timeoutMs: 180_000,
        required: true,
        profiles: ['quick', 'merge', 'deep'],
      },
      {
        id: 'lint',
        kind: 'lint',
        cmd: ['npm', 'run', 'lint'],
        timeoutMs: 300_000,
        required: true,
        profiles: ['merge', 'deep'],
      },
      {
        id: 'build',
        kind: 'build',
        cmd: ['npm', 'run', 'build'],
        timeoutMs: 300_000,
        required: true,
        profiles: ['merge', 'deep'],
      },
      {
        id: 'test-ci',
        kind: 'test',
        cmd: ['npm', 'run', 'test:ci'],
        timeoutMs: 900_000,
        required: true,
        profiles: ['merge', 'deep'],
      },
    ]);
    expect(profile.mergeVerifyContractSource.verifyContract?.authorityFiles).toEqual([
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'eslint.config.js',
      'vitest.config.ts',
      'test/setup/home.ts',
      'scripts/test-ci.mjs',
      'scripts/copy-assets.mjs',
      'scripts/build-identity.mjs',
    ]);
  });
});
