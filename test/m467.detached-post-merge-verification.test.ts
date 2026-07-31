import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  buildDetachedPostMergeVerificationCohort,
  detachedPostMergeVerificationStorePath,
  readDetachedPostMergeVerificationCohorts,
  recordDetachedPostMergeVerificationCohort,
  type DetachedPostMergeVerificationCohortInput,
  type DetachedPostMergeVerificationMemberInput,
} from '../src/core/fleet/detached-post-merge-verification.js';
import type { SemanticPrivateStorageHarness } from './helpers/semantic-private-storage.js';

const privateStorageHarness = vi.hoisted(() => ({
  harness: undefined as SemanticPrivateStorageHarness | undefined,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  const { createSemanticPrivateStorageHarness } =
    await import('./helpers/semantic-private-storage.js');
  privateStorageHarness.harness ??= createSemanticPrivateStorageHarness();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      const options = args[3];
      if (process.platform !== 'win32' || options?.runner !== undefined) {
        return actual.assurePrivateStoragePath(...args);
      }
      return actual.assurePrivateStoragePath(args[0], args[1], args[2], {
        ...options,
        runner: privateStorageHarness.harness!.runner,
      });
    },
  };
});

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
  privateStorageHarness.harness?.reset();
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

function recordPath(): string {
  const records = join(detachedPostMergeVerificationStorePath(), 'records');
  const files = readdirSync(records).filter((name) => name.endsWith('.json'));
  if (files.length !== 1) throw new Error(`expected one cohort record, found ${files.length}`);
  return join(records, files[0]!);
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
    const sensitiveBranch = 'customer-acme-incident-42';
    const sensitiveProposal = 'proposal-customer-acme';
    const sensitiveRun = 'run-customer-acme';
    const sensitiveTrajectory = 'trajectory-customer-acme';
    const sensitiveWorkItem = 'work-customer-acme';
    const supplied = Object.assign(member('1', {
      baseBranch: sensitiveBranch,
      proposalId: sensitiveProposal,
      runId: sensitiveRun,
      trajectoryId: sensitiveTrajectory,
      workItemId: sensitiveWorkItem,
    }), {
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
      'files', secret, home, sensitiveBranch, sensitiveProposal, sensitiveRun,
      sensitiveTrajectory, sensitiveWorkItem, 'cohort-2026-07-28-a',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    const persisted = JSON.parse(raw) as {
      cohortId: string;
      members: Array<{
        proposalId: string;
        baseBranch: string;
        runId: string;
        trajectoryId: string;
        workItemId: string;
      }>;
    };
    expect(persisted.cohortId).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(persisted.members[0]!)).toEqual(
      expect.arrayContaining(Array(5).fill(expect.stringMatching(/^[a-f0-9]{64}$/))),
    );
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
    privateStorageHarness.harness?.reset();
    expect(recordDetachedPostMergeVerificationCohort(cohort())).toBe('recorded');
    if (process.platform === 'win32') {
      const store = win32.normalize(detachedPostMergeVerificationStorePath());
      expect(privateStorageHarness.harness?.requests.some((request) =>
        request.operation === 'assure-private-path' &&
        request.kind === 'file' &&
        request.mode === 'secure-created' &&
        request.paths.length === 1 &&
        request.paths[0]!.startsWith(`${store}\\`),
      )).toBe(true);
    }
    expect(recordDetachedPostMergeVerificationCohort(cohort())).toBe('replayed');
    expect(recordDetachedPostMergeVerificationCohort(cohort({
      members: [member('1'), member('2', { verifierManifest: { digest: 'e'.repeat(64), commandCount: 4 } })],
    }))).toBe('conflicted');
    expect(recordDetachedPostMergeVerificationCohort(cohort({
      members: [member('1'), member('1')],
    }))).toBe('invalid');
  }, process.platform === 'win32' ? 120_000 : 30_000);

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
  }, process.platform === 'win32' ? 120_000 : 30_000);

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
