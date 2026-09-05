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
      commandCount: 6,
      requiredCount: 6,
      profileCounts: { quick: 1, merge: 6, deep: 6 },
      mergeProfileCommandCount: 6,
      requiredMergeProfileCommandCount: 6,
      mergeGradeExplicit: true,
      authorityFileCount: 22,
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
        id: 'test-ci-1-of-3',
        kind: 'test',
        cmd: ['npm', 'run', 'test:ci', '--', '--shard=1/3'],
        timeoutMs: 600_000,
        required: true,
        profiles: ['merge', 'deep'],
      },
      {
        id: 'test-ci-2-of-3',
        kind: 'test',
        cmd: ['npm', 'run', 'test:ci', '--', '--shard=2/3'],
        timeoutMs: 600_000,
        required: true,
        profiles: ['merge', 'deep'],
      },
      {
        id: 'test-ci-3-of-3',
        kind: 'test',
        cmd: ['npm', 'run', 'test:ci', '--', '--shard=3/3'],
        timeoutMs: 600_000,
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
      'scripts/run-bounded-command.mjs',
      'scripts/run-local-production-gate.mjs',
      'scripts/run-local-pack-smoke.mjs',
      'scripts/verify-local-production-gate-receipt.mjs',
      'scripts/verify-release-policy.mjs',
      'scripts/npm-audit-with-osv-fallback.sh',
      'src/raycast/package.json',
      'src/raycast/package-lock.json',
      'desktop/src-tauri/Cargo.toml',
      'desktop/src-tauri/Cargo.lock',
      'desktop/src-tauri/build.rs',
      'desktop/src-tauri/tauri.conf.json',
      'docs/contracts/CONTRACT-M571.md',
    ]);
  });
});
