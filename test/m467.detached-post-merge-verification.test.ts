import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  buildDetachedPostMergeVerificationCohort,
  detachedPostMergeVerificationStorePath,
  readDetachedPostMergeVerificationCohorts,
  recordDetachedPostMergeVerificationCohort,
  type DetachedPostMergeVerificationCohortInput,
  type DetachedPostMergeVerificationMemberInput,
} from '../src/core/fleet/detached-post-merge-verification.js';

let home: string;
let previousHome: string | undefined;
let previousAshlrHome: string | undefined;

beforeEach(() => {
  expect.hasAssertions();
  previousHome = process.env.HOME;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m467-postmerge-'));
  process.env.HOME = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function key(): void {
  expect(loadOrCreateKey()).toHaveLength(32);
}

function member(
  suffix = '1',
  overrides: Partial<DetachedPostMergeVerificationMemberInput> = {},
): DetachedPostMergeVerificationMemberInput {
  return {
    repo: join(home, `repo-${suffix}`),
    proposalId: `proposal-${suffix}`,
    baseBranch: 'main',
    baseHead: 'a'.repeat(40),
    candidateHead: 'b'.repeat(40),
    mergeCommit: suffix.repeat(40).slice(0, 40),
    verifierManifest: { digest: 'd'.repeat(64), commandCount: 4 },
    sourceState: 'healthy',
    terminal: 'pass',
    verifiedHead: suffix.repeat(40).slice(0, 40),
    verifiedAt: '2026-07-28T12:00:00.000Z',
    workspaceClean: true,
    isolation: 'detached-worktree',
    runId: `run-${suffix}`,
    trajectoryId: `trajectory-${suffix}`,
    workItemId: `work-${suffix}`,
    ...overrides,
  };
}

function cohort(
  overrides: Partial<DetachedPostMergeVerificationCohortInput> = {},
): DetachedPostMergeVerificationCohortInput {
  return {
    cohortId: 'cohort-2026-07-28-a',
    observedAt: '2026-07-28T12:05:00.000Z',
    expectedMemberCount: 2,
    members: [
      member('1'),
      member('2', { terminal: 'fail', failureCategory: 'code' }),
    ],
    ...overrides,
  };
}

function recordPath(cohortId = 'cohort-2026-07-28-a'): string {
  return join(detachedPostMergeVerificationStorePath(), 'records', `${cohortId}.json`);
}

describe('M467 detached post-merge verification cohorts', () => {
  it('fails closed without creating signing authority', () => {
    expect(buildDetachedPostMergeVerificationCohort(cohort())).toBeNull();
    expect(recordDetachedPostMergeVerificationCohort(cohort())).toBe('invalid');
    expect(existsSync(join(home, '.ashlr', 'foundry', 'provenance.key'))).toBe(false);
    expect(readDetachedPostMergeVerificationCohorts()).toMatchObject({
      sourceState: 'missing',
      complete: false,
      cohorts: [],
      summary: { cohorts: 0, observedMembers: 0, pass: 0, fail: 0, unknown: 0 },
    });
  });

  it('binds exact immutable identities and records a conclusive denominator', () => {
    key();
    const built = buildDetachedPostMergeVerificationCohort(cohort())!;
    expect(built).toMatchObject({
      authority: 'observation-only',
      policyEligible: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      expectedMemberCount: 2,
      memberCount: 2,
      passCount: 1,
      failCount: 1,
      unknownCount: 0,
      denominatorComplete: true,
      conclusiveComplete: true,
      cohortDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      attestation: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(built.members[0]).toMatchObject({
      repoDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      verifierManifestDigest: 'd'.repeat(64),
      requiredCommandCount: 4,
      verifiedHead: expect.stringMatching(/^[a-f0-9]{40}$/),
      workspaceClean: true,
      isolation: 'detached-worktree',
      memberDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(recordDetachedPostMergeVerificationCohort(cohort())).toBe('recorded');
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true })).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      summary: {
        cohorts: 1,
        denominatorCompleteCohorts: 1,
        conclusiveCompleteCohorts: 1,
        expectedMembers: 2,
        observedMembers: 2,
        pass: 1,
        fail: 1,
        unknown: 0,
      },
    });
  });

  it('persists metadata only and pseudonymizes the repository path', () => {
    key();
    const secret = 'github_pat_never-persist';
    const supplied = Object.assign(member('1'), {
      prompt: secret,
      diff: secret,
      stdout: secret,
      stderr: secret,
      output: secret,
      env: { TOKEN: secret },
      files: [secret],
      fileContents: secret,
    });
    expect(recordDetachedPostMergeVerificationCohort(cohort({
      expectedMemberCount: 1,
      members: [supplied],
    }))).toBe('recorded');
    const raw = readFileSync(recordPath(), 'utf8');
    for (const forbidden of [
      '"repo"', 'prompt', 'diff', 'stdout', 'stderr', 'output', 'env',
      'files', secret, home,
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('converts stale, missing, degraded, and infrastructure results to unknown', () => {
    key();
    const built = buildDetachedPostMergeVerificationCohort(cohort({
      expectedMemberCount: 4,
      members: [
        member('1', { verifiedAt: '2026-07-26T12:00:00.000Z' }),
        member('2', { sourceState: 'missing', terminal: undefined, verifiedAt: undefined }),
        member('3', { sourceState: 'degraded', terminal: 'pass' }),
        member('4', { terminal: 'fail', failureCategory: 'infra' }),
      ],
    }))!;
    expect(built).toMatchObject({
      denominatorComplete: true,
      conclusiveComplete: false,
      passCount: 0,
      failCount: 0,
      unknownCount: 4,
    });
    expect(built.members
      .map((entry) => [entry.sourceState, entry.unknownReason])
      .sort(([left], [right]) => left!.localeCompare(right!))).toEqual([
      ['degraded', 'degraded-source'],
      ['healthy', 'verification-infrastructure'],
      ['missing', 'missing-evidence'],
      ['stale', 'stale-evidence'],
    ]);
  });

  it('withholds conclusive outcomes when exact-head or detached isolation is unproven', () => {
    key();
    const built = buildDetachedPostMergeVerificationCohort(cohort({
      expectedMemberCount: 3,
      members: [
        member('1', { verifiedHead: 'f'.repeat(40) }),
        member('2', { isolation: 'clean-workspace' }),
        member('3', { workspaceClean: false }),
      ],
    }))!;
    expect(built).toMatchObject({
      denominatorComplete: true,
      conclusiveComplete: false,
      passCount: 0,
      failCount: 0,
      unknownCount: 3,
    });
    expect(built.members
      .map((entry) => entry.unknownReason)
      .sort()).toEqual([
      'binding-mismatch',
      'isolation-unproven',
      'isolation-unproven',
    ]);
  });

  it('distinguishes denominator completeness from terminal conclusiveness', () => {
    key();
    const partial = buildDetachedPostMergeVerificationCohort(cohort({
      expectedMemberCount: 3,
      members: [member('1'), member('2')],
    }))!;
    expect(partial).toMatchObject({
      expectedMemberCount: 3,
      memberCount: 2,
      denominatorComplete: false,
      conclusiveComplete: false,
    });
    const completeUnknown = buildDetachedPostMergeVerificationCohort(cohort({
      expectedMemberCount: 1,
      members: [member('1', { sourceState: 'missing', terminal: undefined, verifiedAt: undefined })],
    }))!;
    expect(completeUnknown).toMatchObject({
      denominatorComplete: true,
      conclusiveComplete: false,
      unknownCount: 1,
    });
  });

  it('replays exact cohorts and rejects identity reuse or duplicate members', () => {
    key();
    expect(recordDetachedPostMergeVerificationCohort(cohort())).toBe('recorded');
    expect(recordDetachedPostMergeVerificationCohort(cohort())).toBe('replayed');
    expect(recordDetachedPostMergeVerificationCohort(cohort({
      members: [member('1'), member('2', { verifierManifest: { digest: 'e'.repeat(64), commandCount: 4 } })],
    }))).toBe('conflicted');
    expect(recordDetachedPostMergeVerificationCohort(cohort({
      members: [member('1'), member('1')],
    }))).toBe('invalid');
  });

  it('rejects malformed commits, manifests, timestamps, branches, and causal ids', () => {
    key();
    const invalidMembers: DetachedPostMergeVerificationMemberInput[] = [
      member('1', { repo: 'relative/repo' }),
      member('1', { baseBranch: '../main' }),
      member('1', { baseHead: 'A'.repeat(40) }),
      member('1', { candidateHead: 'short' }),
      member('1', { mergeCommit: 'g'.repeat(40) }),
      member('1', { verifierManifest: { digest: 'bad', commandCount: 1 } }),
      member('1', { verifierManifest: { digest: 'd'.repeat(64), commandCount: 0 } }),
      member('1', { verifiedAt: 'not-a-timestamp' }),
      member('1', { trajectoryId: '../bad id' }),
    ];
    expect(invalidMembers.map((entry) => buildDetachedPostMergeVerificationCohort(cohort({
      expectedMemberCount: 1,
      members: [entry],
    })))).toEqual(Array(invalidMembers.length).fill(null));
    expect(buildDetachedPostMergeVerificationCohort(cohort({ cohortId: '../bad' }))).toBeNull();
    expect(buildDetachedPostMergeVerificationCohort(cohort({ expectedMemberCount: 1 }))).toBeNull();
  });

  it('detects payload, count, signature, and extra-field tampering', () => {
    key();
    expect(recordDetachedPostMergeVerificationCohort(cohort())).toBe('recorded');
    const path = recordPath();
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    for (const mutate of [
      (row: Record<string, unknown>) => { row['passCount'] = 2; },
      (row: Record<string, unknown>) => { row['attestation'] = 'f'.repeat(64); },
      (row: Record<string, unknown>) => {
        (row['members'] as Array<Record<string, unknown>>)[0]!['mergeCommit'] = 'e'.repeat(40);
      },
      (row: Record<string, unknown>) => { row['prompt'] = 'forbidden'; },
    ]) {
      const row = structuredClone(original);
      mutate(row);
      writeFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true })).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        cohorts: [],
        invalidFiles: 1,
      });
    }
  });

  it('fails closed when the key disappears or storage permissions widen', () => {
    key();
    expect(recordDetachedPostMergeVerificationCohort(cohort())).toBe('recorded');
    rmSync(join(home, '.ashlr', 'foundry', 'provenance.key'));
    expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      cohorts: [],
      stopReasons: ['codec-unavailable'],
    });
    expect(loadOrCreateKey()).toHaveLength(32);
    if (process.platform !== 'win32') {
      chmodSync(recordPath(), 0o644);
      expect(readDetachedPostMergeVerificationCohorts({ requireComplete: true })).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        cohorts: [],
      });
    }
  });

  it('withholds all cohorts when bounded reads are incomplete', () => {
    key();
    expect(recordDetachedPostMergeVerificationCohort(cohort())).toBe('recorded');
    expect(readDetachedPostMergeVerificationCohorts({
      maxFiles: 0,
      requireComplete: true,
    })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      limitExceeded: true,
      cohorts: [],
      summary: { cohorts: 0, observedMembers: 0 },
    });
    expect(readDetachedPostMergeVerificationCohorts({
      maxBytes: 1,
      requireComplete: true,
    })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      limitExceeded: true,
      cohorts: [],
    });
  });
});
