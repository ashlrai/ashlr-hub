import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadExistingProvenanceKey,
  loadOrCreateKey,
  provenanceKeyPath,
} from '../src/core/foundry/provenance.js';
import {
  admitClaimedBatchAfterExactFence,
  claimedBatchAdmissionCommitRootPath,
  claimedBatchAdmissionRootPath,
  decodeClaimedBatchAdmission,
  encodeClaimedBatchAdmission,
  expectedPolicyAssignmentUnitId,
  readClaimedBatchAdmissions,
  verifyClaimedBatchAdmission,
  type ClaimedBatchAdmissionInput,
  type ClaimedBatchAdmissionV1,
} from '../src/core/learning/claimed-batch-admission.js';
import { createPolicyAssignmentReceipt } from '../src/core/learning/policy-assignment-receipts.js';
import { enroll } from '../src/core/sandbox/policy.js';
import * as durability from '../src/core/util/durability.js';
import {
  assurePrivateStoragePath,
  type PrivateStorageInvocation,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';
import type { WorkItem } from '../src/core/types.js';
import type { SemanticPrivateStorageHarness } from './helpers/semantic-private-storage.js';

const privateStorageHarness = vi.hoisted(() => ({
  harness: undefined as SemanticPrivateStorageHarness | undefined,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  const { createSemanticPrivateStorageHarness, trustedWindowsSystemRootForTest } =
    await import('./helpers/semantic-private-storage.js');
  privateStorageHarness.harness ??= createSemanticPrivateStorageHarness({
    systemRoot: trustedWindowsSystemRootForTest(),
  });
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

const CAMPAIGN = 'a'.repeat(64);
const ADMISSION_POLICY = 'b'.repeat(64);

function privateStorageResponse(
  invocation: PrivateStorageInvocation,
  status: number,
  ok: boolean,
  reason: string,
): ReturnType<PrivateStorageRunner> {
  const request = JSON.parse(invocation.input) as { nonce: string; operation: string };
  return {
    status,
    stdout: JSON.stringify({
      nonce: request.nonce,
      operation: request.operation,
      ok,
      reason,
    }),
  };
}

describe('M463 Windows setup adapter resilience', () => {
  const options = {
    platform: 'win32' as const,
    systemRoot: 'C:\\Windows',
    anchorPath: 'C:\\fixture',
  };

  it('retries one adapter failure without retrying semantic ACL rejection', () => {
    const transport = vi.fn<PrivateStorageRunner>()
      .mockReturnValueOnce({ status: null, error: new Error('simulated timeout') })
      .mockImplementation((invocation) =>
        privateStorageResponse(invocation, 0, true, 'exact-private-dacl'));
    expect(assurePrivateStoragePath(
      'C:\\fixture\\.ashlr',
      'directory',
      'secure-created',
      { ...options, runner: transport },
    )).toEqual({ ok: true, reason: 'exact-private-dacl' });
    expect(transport).toHaveBeenCalledTimes(2);

    const readOwner = vi.fn<PrivateStorageRunner>()
      .mockImplementationOnce((invocation) =>
        privateStorageResponse(invocation, 1, false, 'adapter-error-read-owner'))
      .mockImplementation((invocation) =>
        privateStorageResponse(invocation, 0, true, 'exact-private-dacl'));
    expect(assurePrivateStoragePath(
      'C:\\fixture\\.ashlr',
      'directory',
      'secure-created',
      { ...options, runner: readOwner },
    )).toEqual({ ok: true, reason: 'exact-private-dacl' });
    expect(readOwner).toHaveBeenCalledTimes(2);

    const repeatedReadOwner = vi.fn<PrivateStorageRunner>()
      .mockImplementation((invocation) =>
        privateStorageResponse(invocation, 1, false, 'adapter-error-read-owner'));
    expect(assurePrivateStoragePath(
      'C:\\fixture\\.ashlr',
      'directory',
      'secure-created',
      { ...options, runner: repeatedReadOwner },
    )).toEqual({ ok: false, reason: 'adapter-error-read-owner' });
    expect(repeatedReadOwner).toHaveBeenCalledTimes(2);

    const semantic = vi.fn<PrivateStorageRunner>()
      .mockImplementation((invocation) =>
        privateStorageResponse(invocation, 1, false, 'untrusted-ancestor-owner'));
    expect(assurePrivateStoragePath(
      'C:\\fixture\\.ashlr',
      'directory',
      'secure-created',
      { ...options, runner: semantic },
    )).toEqual({ ok: false, reason: 'untrusted-ancestor-owner' });
    expect(semantic).toHaveBeenCalledOnce();
  });
});

function item(repo: string, suffix: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `repo:issue:${suffix}`,
    repo,
    source: 'issue',
    title: `Fix scheduler ${suffix}`,
    detail: `Repair the scheduler path for ${suffix}.`,
    value: 5,
    effort: 2,
    score: 2.5,
    tags: ['scheduler'],
    ts: '2026-07-25T12:00:00.000Z',
    ...overrides,
  };
}

function input(items: readonly WorkItem[], overrides: Partial<ClaimedBatchAdmissionInput> = {}):
ClaimedBatchAdmissionInput {
  return {
    campaignDigest: CAMPAIGN,
    admissionPolicyDigest: ADMISSION_POLICY,
    policyVersion: 'fleet-router-v1',
    learningEpoch: '2026-07-25',
    items,
    ...overrides,
  };
}

function interruptedPaths(receipt: ClaimedBatchAdmissionV1): {
  target: string;
  stage: string;
  temporary: string;
} {
  const key = loadExistingProvenanceKey();
  expect(key).not.toBeNull();
  const token = createHmac('sha256', key!).update(JSON.stringify([
    'ashlr:claimed-batch-publication-stage:v1',
    receipt.batchId,
  ]), 'utf8').digest('hex').slice(0, 32);
  const root = claimedBatchAdmissionRootPath();
  const stage = join(root, 'staging', `.${receipt.batchId}.${token}.stage`);
  return {
    target: join(root, 'records', `${receipt.batchId}.json`),
    stage,
    temporary: `${stage}.tmp`,
  };
}

function admit(
  value: ClaimedBatchAdmissionInput,
  overrides: {
    fenceClaimGenerations?: (
      expected: Array<{ itemId: string; generationId: string }>,
      machineId: string,
    ) => Array<{ itemId: string; generationId: string }>;
    expectedGenerations?: Array<{ itemId: string; generationId: string }>;
    releaseClaimGenerations?: (
      expected: Array<{ itemId: string; generationId: string }>,
      machineId: string,
    ) => void;
    aggregateReadMaxFiles?: number;
    aggregateReadMaxBytes?: number;
  } = {},
): ReturnType<typeof admitClaimedBatchAfterExactFence> {
  const expectedGenerations = overrides.expectedGenerations ?? value.items.map((workItem) => ({
    itemId: workItem.id,
    generationId: createHash('sha256')
      .update(JSON.stringify(['test-claim-generation-v1', 'test-machine', workItem.id]))
      .digest('hex'),
  }));
  return admitClaimedBatchAfterExactFence({
    fenceClaimGenerations: overrides.fenceClaimGenerations ??
      ((expected) => expected.map((claim) => ({ ...claim }))),
    releaseClaimGenerations: overrides.releaseClaimGenerations ?? (() => undefined),
  }, 'test-machine', value, expectedGenerations, {
    aggregateReadMaxFiles: overrides.aggregateReadMaxFiles,
    aggregateReadMaxBytes: overrides.aggregateReadMaxBytes,
  });
}

function admittedReceipt(value: ClaimedBatchAdmissionInput): ClaimedBatchAdmissionV1 {
  const result = admit(value);
  expect(['recorded', 'replayed']).toContain(result.disposition);
  expect(result.receipt).not.toBeNull();
  return result.receipt!;
}

describe.runIf(process.platform !== 'win32')('M463 claimed-batch admission', () => {
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-claimed-batch-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    repo = join(home, 'repo');
    mkdirSync(repo);
    privateStorageHarness.harness?.reset();
    loadOrCreateKey();
    expect(enroll(repo).ok).toBe(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('creates fixed observation-only evidence with order-independent identities', () => {
    const left = item(repo, 'left');
    const right = item(repo, 'right', { source: 'todo' });
    const forward = admittedReceipt(input([left, right]));
    const reverse = admittedReceipt(input([right, left]));

    expect(reverse.members.map((member) => member.admissionUnitId))
      .toEqual(forward.members.map((member) => member.admissionUnitId));
    expect(reverse.batchId).toBe(forward.batchId);
    expect(reverse.eligibilityPopulationDigest).toBe(forward.eligibilityPopulationDigest);
    expect(forward).toMatchObject({
      schemaVersion: 1,
      protocol: 'claimed-batch-admission-v1',
      authority: 'observation-only',
      executionAuthority: false,
      learningAuthority: false,
      policyEligible: false,
      causalIdentifiability: 'not-identifiable',
      commitSemantics: 'historical-exact-generation-fence',
      attestationAuthority: 'host-shared-hmac',
      verifierIsolated: false,
      queueAtomicDecision: false,
      leaseAuthorityAtCommit: false,
      leaseAuthorityAtReturn: false,
      orderingEvidence: 'daemon-observed-post-fence-pre-dispatch',
      batchDenominatorComplete: true,
      batchAssignmentExpectationComplete: true,
      campaignDenominatorComplete: false,
      causalDenominatorComplete: false,
      assignmentDenominatorComplete: false,
      preExposureVerified: false,
      memberCount: 2,
    });
    expect(forward.members).toEqual(
      [...forward.members].sort((a, b) => a.admissionUnitId.localeCompare(b.admissionUnitId)),
    );
  });

  it('rejects empty and duplicate claimed batches', () => {
    const duplicate = item(repo, 'duplicate');
    expect(admit(input([]))).toMatchObject({ disposition: 'invalid', receipt: null });
    const release = vi.fn();
    expect(admit(input([duplicate, { ...duplicate }]), {
      releaseClaimGenerations: release,
    })).toMatchObject({
      disposition: 'duplicate-claim',
      receipt: null,
    });
    expect(release).toHaveBeenCalled();
  });

  it('keeps ordinary semantic generations stable across operational metadata and rotates on meaning', () => {
    const base = item(repo, 'semantic');
    const first = admittedReceipt(input([base]));
    const operational = admittedReceipt(input([{
      ...base,
      value: 1,
      effort: 5,
      score: 0.2,
      tags: ['changed', 'metadata'],
      ts: '2026-07-26T12:00:00.000Z',
      title: '  Fix   scheduler semantic ',
      detail: 'Repair the scheduler path for semantic.\n',
    }]));
    const changed = admittedReceipt(input([{
      ...base,
      detail: 'Repair a different scheduler contract.',
    }]));

    expect(operational.members[0]?.admissionUnitId).toBe(first.members[0]?.admissionUnitId);
    expect(operational.members[0]?.expectedAssignmentUnitId)
      .toBe(first.members[0]?.expectedAssignmentUnitId);
    expect(changed.members[0]?.admissionUnitId).not.toBe(first.members[0]?.admissionUnitId);
    expect(changed.members[0]?.expectedAssignmentUnitId)
      .not.toBe(first.members[0]?.expectedAssignmentUnitId);
  });

  it.runIf(process.platform !== 'win32')(
    'collapses POSIX physical aliases to one identity',
    () => {
      const alias = join(home, 'repo-alias');
      symlinkSync(repo, alias, 'dir');
      const physical = admittedReceipt(input([item(repo, 'alias')]));
      const linked = admittedReceipt(input([item(alias, 'alias')]));

      expect(linked.members[0]?.admissionUnitId).toBe(physical.members[0]?.admissionUnitId);
      expect(admit(input([
        item(repo, 'alias'),
        item(alias, 'alias'),
      ]))).toMatchObject({ disposition: 'duplicate-claim', receipt: null });
    },
  );

  it('rejects legacy timestamp-derived and forged repair authority', () => {
    const repair = item(repo, 'abcdef123456', {
      id: 'repo:proposal-repair:abcdef123456',
      source: 'self',
      title: 'Proposal repair: complete the stalled scheduler fix',
      detail:
        'Proposal repair: produce a corrected proposal.\n' +
        'Proposal: prop-stalled\n' +
        'Original work item: repo:goal:stalled\n' +
        'Produce a fresh complete fix and verify it.',
      tags: ['self-heal', 'proposal-repair', 'verify'],
    });
    const first = admit(input([repair]));
    const retry = admit(input([{ ...repair, ts: '2026-07-26T12:00:00.000Z' }]));
    const forged = admit(input([{
      ...item(repo, 'forged'),
      repairGenerationId: 'c'.repeat(64),
    }]));

    expect(first).toMatchObject({ disposition: 'invalid', receipt: null });
    expect(retry).toMatchObject({ disposition: 'invalid', receipt: null });
    expect(forged).toMatchObject({ disposition: 'invalid', receipt: null });
  });

  it('matches the established M460 expected-assignment identity', () => {
    const identity = {
      repo,
      workItemId: 'repo:issue:assignment-parity',
      workSource: 'issue' as const,
      workItemGenerationId: 'c'.repeat(64),
      objectiveHash: 'd'.repeat(64),
      campaignDigest: CAMPAIGN,
      eligibilityPopulationDigest: 'e'.repeat(64),
      policyVersion: 'fleet-router-v1',
      learningEpoch: '2026-07-25',
    };
    const expected = expectedPolicyAssignmentUnitId(identity);
    const assignment = createPolicyAssignmentReceipt({
      reportedAssignedAt: '2026-07-25T12:31:00.000Z',
      ...identity,
      contextStratum: 'issue-mid',
      reportedAssignmentMechanism: 'deterministic-policy',
      reportedProbabilityDenominator: 1,
      reportedEligibleActions: [{
        actionId: 'local-coder',
        actionDefinitionDigest: 'f'.repeat(64),
        probabilityNumerator: 1,
      }],
      reportedSelectedActionId: 'local-coder',
    });

    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    expect(assignment?.assignmentUnitId).toBe(expected);
  });

  it('round-trips canonical bytes and rejects reordered, extended, or tampered records', () => {
    const receipt = admittedReceipt(input([item(repo, 'canonical')]));
    const encoded = encodeClaimedBatchAdmission(receipt)!;

    expect(decodeClaimedBatchAdmission(encoded)).toEqual(receipt);
    expect(verifyClaimedBatchAdmission(receipt)).toEqual(receipt);
    expect(decodeClaimedBatchAdmission(JSON.stringify({
      protocol: receipt.protocol,
      schemaVersion: receipt.schemaVersion,
      ...receipt,
    }))).toBeNull();
    expect(verifyClaimedBatchAdmission({ ...receipt, extra: true })).toBeNull();
    expect(verifyClaimedBatchAdmission({
      ...receipt,
      batchDenominatorComplete: false,
    })).toBeNull();
    expect(verifyClaimedBatchAdmission({
      ...receipt,
      members: [{ ...receipt.members[0], expectedAssignmentUnitId: 'f'.repeat(64) }],
    })).toBeNull();
  });

  it('persists no raw work identity or semantic text in the canonical artifact', () => {
    const rawRepo = repo;
    const rawId = 'repo:issue:private-canary-42';
    const rawTitle = 'PRIVATE_TITLE_CANARY';
    const rawDetail = 'PRIVATE_DETAIL_CANARY';
    const receipt = admittedReceipt(input([
      item(rawRepo, 'privacy', { id: rawId, title: rawTitle, detail: rawDetail }),
    ]));
    const encoded = encodeClaimedBatchAdmission(receipt)!;

    for (const canary of [rawRepo, rawId, rawTitle, rawDetail, 'scheduler']) {
      expect(encoded).not.toContain(canary);
    }
    expect(receipt.campaignDigest).not.toBe(CAMPAIGN);
    expect(receipt.admissionPolicyDigest).not.toBe(ADMISSION_POLICY);
    expect(Object.keys(receipt.members[0]!)).toEqual([
      'admissionUnitId',
      'expectedAssignmentUnitId',
      'workSource',
    ]);
  });

  it('refuses an existing repository outside the healthy enrollment snapshot', () => {
    const outside = join(home, 'outside-repo');
    mkdirSync(outside);
    const release = vi.fn();
    expect(admit(input([item(outside, 'unenrolled')]), {
      releaseClaimGenerations: release,
    })).toMatchObject({
      disposition: 'invalid',
      receipt: null,
    });
    expect(release).toHaveBeenCalled();
    expect(readClaimedBatchAdmissions()).toMatchObject({
      sourceState: 'missing',
      records: [],
    });
  });

  it.runIf(process.platform !== 'win32')(
    'replays one exact claim generation without double-counting the batch',
    () => {
      const first = input([item(repo, 'stored')]);
      expect(admit(first).disposition).toBe('recorded');
      expect(admit(first).disposition).toBe('replayed');
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'healthy',
        sourcePresent: true,
        complete: true,
        filesRead: 2,
        invalidFiles: 0,
      });
    },
  );

  it('confirms its exact pair when the bounded aggregate view is over limit', () => {
    expect(admit(input([item(repo, 'point-read-first')])).disposition).toBe('recorded');
    const value = input([item(repo, 'point-read-over-limit')]);
    expect(admit(value, { aggregateReadMaxFiles: 1 }).disposition).toBe('recorded');
    expect(readClaimedBatchAdmissions({
      requireComplete: false,
      maxFiles: 1,
    })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: expect.arrayContaining(['file-limit']),
    });
    const stopReasons = readClaimedBatchAdmissions({
      requireComplete: false,
      maxFiles: 1,
    }).stopReasons;
    for (const reason of ['uncommitted-admission', 'orphaned-commit', 'commit-mismatch']) {
      expect(stopReasons).not.toContain(reason);
    }
  });

  it('does not infer an orphan when byte limits expose only the smaller commit', () => {
    const receipt = admittedReceipt(input([item(repo, 'byte-limited-pair')]));
    const observationSize = statSync(
      join(claimedBatchAdmissionRootPath(), 'records', `${receipt.batchId}.json`),
    ).size;
    const commitSize = statSync(
      join(claimedBatchAdmissionCommitRootPath(), 'records', `${receipt.batchId}.json`),
    ).size;
    expect(observationSize).toBeGreaterThan(commitSize);

    const read = readClaimedBatchAdmissions({
      requireComplete: false,
      maxBytes: commitSize,
    });
    expect(read).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: expect.arrayContaining(['byte-limit']),
    });
    expect(read.stopReasons).not.toContain('orphaned-commit');
  });

  it.runIf(process.platform !== 'win32')(
    'rotates the batch only when the exact claim generation changes',
    () => {
      const value = input([item(repo, 'generation-rotation')]);
      const claimsFor = (salt: string) => value.items.map((workItem) => ({
          itemId: workItem.id,
          generationId: createHash('sha256')
            .update(JSON.stringify([salt, 'test-machine', workItem.id]))
            .digest('hex'),
        }));

      const first = admit(value, { expectedGenerations: claimsFor('generation-a') });
      const replay = admit(value, { expectedGenerations: claimsFor('generation-a') });
      const next = admit(value, { expectedGenerations: claimsFor('generation-b') });

      expect(first.disposition).toBe('recorded');
      expect(replay.disposition).toBe('replayed');
      expect(next.disposition).toBe('recorded');
      expect(next.receipt?.batchId).not.toBe(first.receipt?.batchId);
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'healthy',
        complete: true,
        filesRead: 4,
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'recovers canonical pre-stage and post-link crash states',
    () => {
      const admission = input([item(repo, 'recover')]);
      const receipt = admittedReceipt(admission);
      const paths = interruptedPaths(receipt);

      rmSync(paths.target);
      writeFileSync(paths.temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      expect(admit(admission).disposition).toBe('recorded');
      expect(existsSync(paths.temporary)).toBe(false);

      linkSync(paths.target, paths.stage);
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        records: [],
        sourceState: 'degraded',
        complete: false,
        stopReasons: expect.arrayContaining(['source-mutated', 'invalid-file']),
      });
      expect(admit(admission).disposition).toBe('recorded');
      expect(existsSync(paths.stage)).toBe(false);
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'healthy',
        complete: true,
        filesRead: 2,
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'preserves a stranded authenticated temporary for its original batch',
    () => {
      const admission = input([item(repo, 'conflict-recovery')]);
      const receipt = admittedReceipt(admission);
      const paths = interruptedPaths(receipt);
      rmSync(paths.target);
      writeFileSync(paths.temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });

      expect(admit(admission).disposition).toBe('recorded');
      expect(existsSync(paths.target)).toBe(true);
      expect(existsSync(paths.temporary)).toBe(false);
      expect(readFileSync(paths.target, 'utf8')).toBe(`${JSON.stringify(receipt)}\n`);
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'healthy',
        complete: true,
        filesRead: 2,
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'recovers an unrelated stranded transaction before recording the next batch',
    () => {
      const firstInput = input([item(repo, 'stranded-first')]);
      const first = admittedReceipt(firstInput);
      const firstPaths = interruptedPaths(first);
      rmSync(firstPaths.target);
      writeFileSync(firstPaths.temporary, `${JSON.stringify(first)}\n`, { mode: 0o600 });

      const second = admit(input([item(repo, 'stranded-second')]));
      expect(second.disposition).toBe('recorded');
      expect(existsSync(firstPaths.temporary)).toBe(false);
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'healthy',
        complete: true,
        filesRead: 4,
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'preserves the stage witness when directory durability fails after target link',
    () => {
      const value = input([item(repo, 'durability-retry')]);
      const realFsync = durability.fsyncDirectory;
      const fsync = vi.spyOn(durability, 'fsyncDirectory').mockImplementation((path) => {
        if (path.endsWith(`${join('claimed-batch-admissions', 'records')}`)) {
          throw new Error('simulated directory fsync failure');
        }
        return realFsync(path);
      });
      const failed = admit(value);
      expect(failed.disposition).toBe('persistence-failed');
      expect(failed.receipt).toBeNull();
      const recordFiles = readdirSync(join(claimedBatchAdmissionRootPath(), 'records'));
      expect(recordFiles).toHaveLength(1);
      const failedReceipt = verifyClaimedBatchAdmission(JSON.parse(readFileSync(
        join(claimedBatchAdmissionRootPath(), 'records', recordFiles[0]!),
        'utf8',
      )))!;
      const paths = interruptedPaths(failedReceipt);
      expect(existsSync(paths.target)).toBe(true);
      expect(existsSync(paths.stage)).toBe(true);

      fsync.mockRestore();
      expect(admit(value).disposition).toBe('recorded');
      expect(existsSync(paths.stage)).toBe(false);
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'healthy',
        complete: true,
        filesRead: 2,
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'withholds a commit whose directory entry is not yet durable and recovers on retry',
    () => {
      const value = input([item(repo, 'commit-durability-retry')]);
      const realFsync = durability.fsyncDirectory;
      const fsync = vi.spyOn(durability, 'fsyncDirectory').mockImplementation((path) => {
        if (path.endsWith(join('claimed-batch-admission-commits', 'records'))) {
          throw new Error('simulated commit directory fsync failure');
        }
        return realFsync(path);
      });

      expect(admit(value)).toMatchObject({
        disposition: 'persistence-failed',
        receipt: null,
      });
      expect(readdirSync(join(claimedBatchAdmissionCommitRootPath(), 'staging')))
        .toHaveLength(1);
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        records: [],
        stopReasons: expect.arrayContaining(['source-mutated', 'invalid-file']),
      });

      fsync.mockRestore();
      expect(admit(value).disposition).toBe('replayed');
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'healthy',
        complete: true,
        records: [expect.objectContaining({ protocol: 'claimed-batch-admission-v1' })],
      });
    },
  );

  it('keeps reads pure when the store is missing and fails closed on Windows writes', () => {
    const before = claimedBatchAdmissionRootPath();
    expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
      sourceState: 'missing',
      sourcePresent: false,
      complete: false,
      records: [],
    });
    if (process.platform === 'win32') {
      expect(admit(input([item(repo, 'windows-refusal')]))).toMatchObject({
        disposition: 'persistence-failed',
        receipt: null,
      });
      expect(readClaimedBatchAdmissions()).toMatchObject({
        sourceState: 'missing',
        sourcePresent: false,
      });
    }
    expect(claimedBatchAdmissionRootPath()).toBe(before);
  });

  it('does not report one empty half of the protocol as a complete source', () => {
    const makeEmptyStore = (root: string): void => {
      mkdirSync(root, { mode: 0o700 });
      mkdirSync(join(root, 'records'), { mode: 0o700 });
      mkdirSync(join(root, 'staging'), { mode: 0o700 });
    };
    makeEmptyStore(claimedBatchAdmissionRootPath());
    expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      records: [],
      stopReasons: expect.arrayContaining(['missing-store']),
    });

    rmSync(claimedBatchAdmissionRootPath(), { recursive: true, force: true });
    makeEmptyStore(claimedBatchAdmissionCommitRootPath());
    expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      records: [],
      stopReasons: expect.arrayContaining(['missing-store']),
    });
  });

  it('writes nothing and releases the batch when exact fencing is partial', () => {
    const release = vi.fn();
    const value = input([item(repo, 'fence-left'), item(repo, 'fence-right')]);
    const result = admit(value, {
      fenceClaimGenerations: (expected) => expected.slice(0, 1),
      releaseClaimGenerations: release,
    });
    expect(result).toMatchObject({ disposition: 'fence-mismatch', receipt: null });
    expect(release).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'repo:issue:fence-left' }),
        expect.objectContaining({ itemId: 'repo:issue:fence-right' }),
      ]),
      'test-machine',
    );
    expect(readClaimedBatchAdmissions()).toMatchObject({
      sourceState: 'missing',
      records: [],
    });
  });

  it.runIf(process.platform !== 'win32')(
    'refuses and releases when lease authority is lost during persistence',
    () => {
      const release = vi.fn();
      let fences = 0;
      const result = admit(input([
        item(repo, 'late-fence-left'),
        item(repo, 'late-fence-right'),
      ]), {
        fenceClaimGenerations: (expected) => {
          fences += 1;
          return fences === 1 ? [...expected] : expected.slice(0, 1);
        },
        releaseClaimGenerations: release,
      });
      expect(result).toMatchObject({ disposition: 'fence-mismatch', receipt: null });
      expect(fences).toBe(2);
      expect(release).toHaveBeenCalled();
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        records: [],
        filesRead: 1,
        stopReasons: expect.arrayContaining(['uncommitted-admission']),
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'withholds an observation when the final fence has a different claim generation',
    () => {
      let fences = 0;
      const result = admit(input([item(repo, 'reclaimed-generation')]), {
        fenceClaimGenerations: (expected) => {
          fences += 1;
          return expected.map((claim) => ({
            ...claim,
            generationId: fences === 1
              ? claim.generationId
              : createHash('sha256').update(claim.generationId).digest('hex'),
          }));
        },
      });

      expect(result).toMatchObject({ disposition: 'fence-mismatch', receipt: null });
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        records: [],
        stopReasons: expect.arrayContaining(['uncommitted-admission']),
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not let an unrelated uncommitted observation wedge later admissions',
    () => {
      let fences = 0;
      const abandoned = admit(input([item(repo, 'abandoned-observation')]), {
        fenceClaimGenerations: (expected) => {
          fences += 1;
          return expected.map((claim) => ({
            ...claim,
            generationId: fences === 1
              ? claim.generationId
              : createHash('sha256').update(claim.generationId).digest('hex'),
          }));
        },
      });
      expect(abandoned.disposition).toBe('fence-mismatch');

      const later = admit(input([item(repo, 'later-admission')]));
      expect(later.disposition).toBe('recorded');
      expect(readClaimedBatchAdmissions({ requireComplete: false })).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        records: [expect.objectContaining({ batchId: later.receipt?.batchId })],
        stopReasons: expect.arrayContaining(['uncommitted-admission']),
      });
      expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
        records: [],
        complete: false,
      });
      const truncated = readClaimedBatchAdmissions({
        requireComplete: false,
        maxFiles: 1,
      });
      expect(truncated.stopReasons).toContain('file-limit');
      expect(truncated.stopReasons).not.toContain('uncommitted-admission');
      expect(truncated.stopReasons).not.toContain('orphaned-commit');
    },
  );

  it('refuses a new admission while an orphaned commit degrades the source', () => {
    const first = admittedReceipt(input([item(repo, 'orphaned-first')]));
    rmSync(join(claimedBatchAdmissionRootPath(), 'records', `${first.batchId}.json`));
    const releaseClaimGenerations = vi.fn();

    expect(admit(input([item(repo, 'orphaned-later')]), {
      releaseClaimGenerations,
    })).toMatchObject({
      disposition: 'persistence-failed',
      receipt: null,
    });
    expect(releaseClaimGenerations).toHaveBeenCalled();
    expect(readClaimedBatchAdmissions({ requireComplete: true })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      records: [],
      stopReasons: expect.arrayContaining(['orphaned-commit']),
    });
  });

  it('has no production consumer before the admission barrier is activated', () => {
    const root = resolve('src/core');
    const consumers: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(path);
        } else if (
          entry.isFile() &&
          path.endsWith('.ts') &&
          !path.endsWith('learning/claimed-batch-admission.ts') &&
          readFileSync(path, 'utf8').includes('claimed-batch-admission')
        ) {
          consumers.push(relative(root, path));
        }
      }
    };
    visit(root);
    expect(consumers).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('M463 Windows refusal', () => {
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-claimed-batch-windows-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    repo = join(home, 'repo');
    mkdirSync(repo);
    privateStorageHarness.harness?.reset();
    loadOrCreateKey();
    expect(enroll(repo).ok).toBe(true);
    privateStorageHarness.harness?.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('releases the exact generation and creates no store when durability is unsupported', () => {
    const releaseClaimGenerations = vi.fn();
    expect(admit(input([item(repo, 'windows-refusal')]), {
      releaseClaimGenerations,
    })).toMatchObject({
      disposition: 'persistence-failed',
      receipt: null,
    });
    expect(releaseClaimGenerations).toHaveBeenCalledOnce();
    expect(privateStorageHarness.harness?.requests).toEqual(expect.arrayContaining([{
      operation: 'assure-private-path',
      anchorPath: win32.normalize(join(home, '.ashlr', 'foundry')),
      paths: [win32.normalize(provenanceKeyPath())],
      kind: 'file',
      mode: 'inspect-existing',
    }]));
    expect(existsSync(claimedBatchAdmissionRootPath())).toBe(false);
    expect(existsSync(claimedBatchAdmissionCommitRootPath())).toBe(false);
  });
});
