import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  runDetachedPostMergeVerification,
  type DetachedPostMergeRunnerInput,
} from '../src/core/fleet/detached-post-merge-runner.js';
import {
  detachedPostMergeVerificationStorePath,
  readDetachedPostMergeVerificationCohorts,
} from '../src/core/fleet/detached-post-merge-verification.js';
import { buildFleetStatus } from '../src/core/fleet/status.js';
import { formatFleetStatus } from '../src/cli/fleet.js';
import type { AshlrConfig } from '../src/core/types.js';

// Verifier-timeout tests spawn real git subprocesses and wait out an actual
// process timeout before asserting the runner's recovery behavior. Under
// full-suite parallel load that real wall-clock + subprocess work can
// individually exceed the 5s default, causing spurious timeouts unrelated
// to the runner logic itself.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

beforeEach(() => {
  expect.hasAssertions();
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m468-runner-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  expect(loadOrCreateKey()).toHaveLength(32);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10_000,
  }).trim();
}

function contract(script: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    mode: 'replace-detected',
    commands: [{
      id: 'merge-test',
      kind: 'test',
      cmd: ['node', '-e', script],
      cwd: '.',
      timeoutMs: 5_000,
      required: true,
      profiles: ['merge'],
      ...overrides,
    }],
  }, null, 2);
}

function createRepo(
  script: string,
  overrides: Record<string, unknown> = {},
): { repo: string; input: DetachedPostMergeRunnerInput } {
  const repo = join(home, `repo-${Math.random().toString(16).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
  git(repo, ['config', 'user.email', 'runner-test@ashlr.test']);
  git(repo, ['config', 'user.name', 'Runner Test']);
  writeFileSync(join(repo, 'ashlr.verify.json'), contract(script, overrides));
  writeFileSync(join(repo, '.gitignore'), 'ignored-output.txt\n');
  writeFileSync(join(repo, 'README.md'), '# base\n');
  git(repo, ['add', 'ashlr.verify.json', '.gitignore', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  const baseHead = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-b', 'candidate']);
  writeFileSync(join(repo, 'README.md'), '# candidate\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'candidate']);
  const candidateHead = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', 'main']);
  git(repo, ['merge', '--no-ff', 'candidate', '-m', 'merge result']);
  const mergeCommit = git(repo, ['rev-parse', 'HEAD']);
  return {
    repo,
    input: {
      repo,
      cohortId: `cohort-${mergeCommit.slice(0, 12)}`,
      proposalId: `proposal-${mergeCommit.slice(0, 12)}`,
      baseBranch: 'main',
      baseHead,
      candidateHead,
      mergeCommit,
      runId: `run-${mergeCommit.slice(0, 12)}`,
      trajectoryId: `trajectory-${mergeCommit.slice(0, 12)}`,
      workItemId: `work-${mergeCommit.slice(0, 12)}`,
    },
  };
}

function recordBytes(): string {
  const records = join(detachedPostMergeVerificationStorePath(), 'records');
  return readdirSync(records)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(join(records, name), 'utf8'))
    .join('');
}

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

describe('M468 detached post-merge runner', () => {
  it('verifies the exact merge head in a fresh detached worktree and cleans it up', async () => {
    const shellPayload = '$(touch should-not-exist)';
    const fixture = createRepo(
      `if (process.argv[1] !== ${JSON.stringify(shellPayload)}) process.exit(2)`,
      { cmd: ['node', '-e', `if (process.argv[1] !== ${JSON.stringify(shellPayload)}) process.exit(2)`, shellPayload] },
    );
    const before = git(fixture.repo, ['worktree', 'list', '--porcelain']);

    const outcome = await runDetachedPostMergeVerification(fixture.input);

    expect(outcome).toMatchObject({
      authority: 'observation-only',
      policyEligible: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      terminal: 'pass',
      reason: 'verified',
      requiredCommandCount: 1,
      commandsRun: 1,
      cleanup: 'removed',
      recordDisposition: 'recorded',
    });
    expect(outcome.verifierManifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(git(fixture.repo, ['worktree', 'list', '--porcelain'])).toBe(before);
    expect(existsSync(join(fixture.repo, 'should-not-exist'))).toBe(false);
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true })).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      summary: {
        cohorts: 1,
        denominatorCompleteCohorts: 1,
        conclusiveCompleteCohorts: 1,
        pass: 1,
        fail: 0,
        unknown: 0,
      },
    });
  });

  it('records a code failure without exposing command output', async () => {
    const secret = 'github_pat_runner_secret';
    const fixture = createRepo(
      `process.stdout.write(${JSON.stringify(secret)}); process.stderr.write(${JSON.stringify(secret)}); process.exit(7)`,
    );

    const outcome = await runDetachedPostMergeVerification(fixture.input);

    expect(outcome).toMatchObject({
      terminal: 'fail',
      reason: 'code-failure',
      failureCategory: 'code',
      cleanup: 'removed',
      recordDisposition: 'recorded',
    });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(recordBytes()).not.toContain(secret);
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true }).summary).toMatchObject({
      pass: 0,
      fail: 1,
      unknown: 0,
    });
  });

  it('turns verifier timeout into unknown and removes the owned process worktree', async () => {
    const fixture = createRepo('setInterval(() => {}, 1_000)', { timeoutMs: 25 });

    const outcome = await runDetachedPostMergeVerification(fixture.input, {
      maxCommandTimeoutMs: 25,
      maxTotalTimeoutMs: 1_000,
    });

    expect(outcome).toMatchObject({
      terminal: 'unknown',
      reason: 'verification-timeout',
      failureCategory: 'timeout',
      cleanup: 'removed',
      recordDisposition: 'recorded',
    });
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true }).summary).toMatchObject({
      pass: 0,
      fail: 0,
      unknown: 1,
    });
  });

  it('withholds a stale-head race before model-independent verification', async () => {
    const fixture = createRepo('process.exit(0)');

    const outcome = await runDetachedPostMergeVerification(fixture.input, {
      _beforeCommand: (worktree) => {
        git(worktree, ['checkout', '--detach', fixture.input.candidateHead]);
      },
    });

    expect(outcome).toMatchObject({
      terminal: 'unknown',
      reason: 'isolation-lost',
      commandsRun: 0,
      cleanup: 'removed',
      recordDisposition: 'recorded',
    });
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true }).summary.unknown).toBe(1);
  });

  it('withholds a command that dirties the isolated worktree even when it exits zero', async () => {
    const fixture = createRepo(
      "require('node:fs').writeFileSync('verification-side-effect.txt', 'dirty')",
    );

    const outcome = await runDetachedPostMergeVerification(fixture.input);

    expect(outcome).toMatchObject({
      terminal: 'unknown',
      reason: 'isolation-lost',
      commandsRun: 1,
      cleanup: 'removed',
      recordDisposition: 'recorded',
    });
    expect(existsSync(join(fixture.repo, 'verification-side-effect.txt'))).toBe(false);
  });

  it('withholds a command that writes only gitignored output', async () => {
    const fixture = createRepo(
      "require('node:fs').writeFileSync('ignored-output.txt', 'dirty')",
    );

    const outcome = await runDetachedPostMergeVerification(fixture.input);

    expect(outcome).toMatchObject({
      terminal: 'unknown',
      reason: 'isolation-lost',
      commandsRun: 1,
      cleanup: 'removed',
      recordDisposition: 'recorded',
    });
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true }).summary.unknown).toBe(1);
  });

  it('records unknown without executing when the claimed merge is not bound to the supplied heads', async () => {
    const fixture = createRepo('process.exit(0)');
    writeFileSync(join(fixture.repo, 'UNRELATED.md'), 'unrelated\n');
    git(fixture.repo, ['add', 'UNRELATED.md']);
    git(fixture.repo, ['commit', '-m', 'unrelated commit']);
    fixture.input.mergeCommit = git(fixture.repo, ['rev-parse', 'HEAD']);

    const outcome = await runDetachedPostMergeVerification(fixture.input);

    expect(outcome).toMatchObject({
      terminal: 'unknown',
      reason: 'binding-mismatch',
      commandsRun: 0,
      failureCategory: 'infra',
      cleanup: 'removed',
      recordDisposition: 'recorded',
    });
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true }).summary.unknown).toBe(1);
  });

  it('refuses cleanup after the runner-owned temp identity loses private permissions', async () => {
    const fixture = createRepo('process.exit(0)');
    let unsafeRoot = '';
    let worktree = '';

    const outcome = await runDetachedPostMergeVerification(fixture.input, {
      _beforeCleanup: (path, root) => {
        worktree = path;
        unsafeRoot = root;
        if (process.platform !== 'win32') chmodSync(root, 0o755);
      },
    });

    if (process.platform === 'win32') {
      expect(outcome.cleanup).toBe('removed');
      return;
    }
    expect(outcome).toMatchObject({
      terminal: 'unknown',
      reason: 'cleanup-failed',
      cleanup: 'failed',
      recordDisposition: 'recorded',
    });
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true })).toMatchObject({
      sourceState: 'healthy',
      summary: { unknown: 1 },
    });
    chmodSync(unsafeRoot, 0o700);
    git(fixture.repo, ['worktree', 'remove', '--force', worktree]);
    rmdirSync(unsafeRoot);
  });

  it('fails closed on a missing merge profile and leaves no cohort', async () => {
    const fixture = createRepo('process.exit(0)', { profiles: ['quick'] });

    const outcome = await runDetachedPostMergeVerification(fixture.input);

    expect(outcome).toMatchObject({
      terminal: 'unknown',
      reason: 'manifest-unavailable',
      verifierManifestDigest: null,
      cleanup: 'removed',
      recordDisposition: 'not-recorded',
    });
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true }).summary.cohorts).toBe(0);
  });

  it('persists pseudonymous metadata without treating a singleton as fleet completeness', async () => {
    const sensitive = 'customer-acme-incident-42';
    const fixture = createRepo('process.exit(0)');
    fixture.input.cohortId = `cohort-${sensitive}`;
    fixture.input.proposalId = `proposal-${sensitive}`;
    fixture.input.baseBranch = sensitive;
    fixture.input.runId = `run-${sensitive}`;
    fixture.input.trajectoryId = `trajectory-${sensitive}`;
    fixture.input.workItemId = `work-${sensitive}`;

    expect((await runDetachedPostMergeVerification(fixture.input)).terminal).toBe('pass');
    const status = await buildFleetStatus(baseConfig());
    const formatted = formatFleetStatus(status);

    expect(recordBytes()).not.toContain(sensitive);
    expect(recordBytes()).not.toContain(fixture.repo);
    expect(status.detachedPostMergeVerificationSource).toMatchObject({
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      invalidRows: 0,
    });
    expect(status.detachedPostMergeVerificationReadiness).toMatchObject({
      authority: 'observation-only',
      policyEligible: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      state: 'missing',
      passRate: null,
      denominator: {
        candidateSetDigest: null,
        eligibleCandidates: 0,
        observedCandidates: 0,
        conclusiveCandidates: 0,
        unobservedCandidates: 0,
      },
      summary: { cohorts: 1, pass: 1, fail: 0, unknown: 0 },
    });
    expect(status.detachedPostMergeDenominatorSource).toMatchObject({
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
    });
    expect(status.autoMergeCanaryPromotionReadiness).toMatchObject({
      authority: 'observation-only',
      verdict: 'blocked',
      activationPermitted: false,
    });
    expect(status.autoMergeCanaryPromotionReadiness?.blockers.map((entry) => entry.code)).toContain(
      'post-merge-source-unhealthy',
    );
    expect(status.autoMergeCanaryPromotionReadiness?.blockers.map((entry) => entry.code)).toContain(
      'post-merge-cohort-insufficient',
    );
    expect(formatted).toContain('Detached post-merge verification (observation only):');
    expect(formatted).toContain('Auto-merge canary promotion readiness (observation only):');
    expect(formatted).toContain('authority:  policy=false, merge=false, rollback=false, deploy=false');
    expect(formatted).toContain('authority:  activation=false');
    expect(JSON.stringify(status.detachedPostMergeVerificationReadiness)).not.toContain(sensitive);
  });
});
