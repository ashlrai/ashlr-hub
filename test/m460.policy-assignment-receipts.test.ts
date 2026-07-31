import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadExistingProvenanceKey,
  loadOrCreateKey,
} from '../src/core/foundry/provenance.js';
import {
  createPolicyAssignmentReceipt,
  policyAssignmentReceiptRootPath,
  readPolicyAssignmentReceipts,
  recordPolicyAssignmentReceipt,
  verifyPolicyAssignmentReceipt,
  type PolicyAssignmentReceiptInput,
} from '../src/core/learning/policy-assignment-receipts.js';
import { writePrivateFileAtomically } from '../src/core/util/private-file-write.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
} from '../src/core/util/private-storage.js';
import {
  createSemanticPrivateStorageHarness,
  trustedWindowsSystemRootForTest,
} from './helpers/semantic-private-storage.js';

const GENERATION = 'a'.repeat(64);
const OBJECTIVE = 'b'.repeat(64);
const CODEX_ACTION = '1'.repeat(64);
const LOCAL_ACTION = '2'.repeat(64);
let repoPath = '';
const semanticPrivateStorage = createSemanticPrivateStorageHarness({
  systemRoot: trustedWindowsSystemRootForTest(),
});

function assignment(overrides: Partial<PolicyAssignmentReceiptInput> = {}): PolicyAssignmentReceiptInput {
  return {
    reportedAssignedAt: '2026-07-25T12:00:00.000Z',
    repo: repoPath,
    workItemId: 'issue:secret-42',
    workSource: 'issue',
    workItemGenerationId: GENERATION,
    objectiveHash: OBJECTIVE,
    campaignDigest: 'e'.repeat(64),
    eligibilityPopulationDigest: 'f'.repeat(64),
    contextStratum: 'issue:mid',
    policyVersion: 'router-v9',
    learningEpoch: 'epoch-2026-07',
    reportedAssignmentMechanism: 'randomized-hmac',
    reportedRandomizationCommitment: 'c'.repeat(64),
    reportedProbabilityDenominator: 10,
    reportedEligibleActions: [
      { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 3 },
      { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 7 },
    ],
    reportedSelectedActionId: 'local-coder',
    ...overrides,
  };
}

function interruptedStagePath(receipt: NonNullable<ReturnType<typeof createPolicyAssignmentReceipt>>): string {
  const key = loadExistingProvenanceKey();
  expect(key).not.toBeNull();
  const token = createHmac('sha256', key!).update(JSON.stringify([
    'ashlr:policy-assignment-publication-stage:v1',
    receipt.assignmentUnitId,
  ]), 'utf8').digest('hex').slice(0, 32);
  return join(
    policyAssignmentReceiptRootPath(),
    `.${receipt.assignmentUnitId}.${token}.stage`,
  );
}

function writePrivateCrashFile(path: string, value: string, anchorPath: string): void {
  writePrivateFileAtomically(`${path}.seed`, path, value, {
    anchorPath,
    label: 'policy assignment receipt crash fixture',
  });
}

describe('M460 policy assignment receipts', () => {
  let home: string;

  beforeEach(() => {
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
    home = mkdtempSync(join(tmpdir(), 'ashlr-policy-assignment-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    repoPath = join(home, 'repo');
    mkdirSync(repoPath);
    semanticPrivateStorage.reset();
    if (process.platform === 'win32') {
      _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
        runner: semanticPrivateStorage.runner,
      });
    }
    loadOrCreateKey();
    semanticPrivateStorage.reset();
  });

  afterEach(() => {
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('freezes a complete exact action distribution without raw causal identities', () => {
    const input = assignment({
      reportedEligibleActions: [
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 7 },
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 3 },
      ],
    });
    const receipt = createPolicyAssignmentReceipt(input);

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      protocol: 'policy-assignment-receipt-v1',
      authority: 'observation-only',
      executionAuthority: false,
      policyEligible: false,
      causalIdentifiability: 'not-identifiable',
      assignmentEvidence: 'policy-reported',
      timingEvidence: 'policy-reported',
      preExposureVerified: false,
      denominatorComplete: false,
      reportedAssignmentMechanism: 'randomized-hmac',
      reportedRandomizationCommitment: 'c'.repeat(64),
      reportedProbabilityDenominator: 10,
      reportedSelectedActionId: 'local-coder',
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 3 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 7 },
      ],
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(input.repo);
    expect(serialized).not.toContain(input.workItemId);
    expect(serialized).not.toContain(input.workItemGenerationId);
    expect(serialized).not.toContain(input.objectiveHash);
    expect(serialized).not.toContain(input.contextStratum);
    expect(verifyPolicyAssignmentReceipt(receipt)).toEqual(receipt);
  });

  it.each([
    ['missing probability mass', { reportedProbabilityDenominator: 11 }],
    ['unreduced probability vector', {
      reportedProbabilityDenominator: 20,
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 6 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 14 },
      ],
    }],
    ['duplicate actions', {
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 3 },
        { actionId: 'codex', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 7 },
      ],
    }],
    ['unselected action', { reportedSelectedActionId: 'claude' }],
    ['non-canonical time', { reportedAssignedAt: '2026-07-25T12:00:00Z' }],
    ['missing generation', { workItemGenerationId: '' }],
    ['randomized assignment without commitment', { reportedRandomizationCommitment: undefined }],
    ['missing action definition', {
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: '', probabilityNumerator: 3 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 7 },
      ],
    }],
  ])('rejects %s', (_label, override) => {
    expect(createPolicyAssignmentReceipt(assignment(override))).toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment(override))).toBe('invalid');
  });

  it('records once, recognizes exact replay, and rejects a conflicting policy assignment', () => {
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    if (process.platform === 'win32') {
      const receiptRoot = win32.normalize(policyAssignmentReceiptRootPath());
      const root = `${receiptRoot}\\`;
      expect(semanticPrivateStorage.requests.some((request) =>
        request.operation === 'assure-private-path' &&
        request.kind === 'file' &&
        request.mode === 'secure-created' &&
        request.anchorPath === win32.dirname(win32.dirname(receiptRoot)) &&
        request.paths.length === 1 &&
        request.paths[0]!.startsWith(root),
      )).toBe(true);
    }
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('replayed');
    expect(recordPolicyAssignmentReceipt(assignment({
      reportedProbabilityDenominator: 2,
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 1 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 1 },
      ],
    }))).toBe('conflicted');

    const result = readPolicyAssignmentReceipts({ requireComplete: true });
    expect(result).toMatchObject({
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      filesRead: 1,
      invalidFiles: 0,
      limitExceeded: false,
    });
    expect(result.receipts).toHaveLength(1);
  });

  it('recovers the exact authenticated hard-link pair left by an interrupted publication', () => {
    const receipt = createPolicyAssignmentReceipt(assignment());
    expect(receipt).not.toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const target = join(policyAssignmentReceiptRootPath(), `${receipt!.assignmentUnitId}.json`);
    const stage = interruptedStagePath(receipt!);
    linkSync(target, stage);

    expect(readPolicyAssignmentReceipts({ requireComplete: true })).toMatchObject({
      receipts: [],
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['invalid-file'],
    });
    expect(existsSync(stage)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    expect(existsSync(stage)).toBe(false);
    expect(readPolicyAssignmentReceipts({ requireComplete: true })).toMatchObject({
      receipts: [receipt],
      sourceState: 'healthy',
      complete: true,
    });
  });

  it('finishes an authenticated stage left before target publication', () => {
    const receipt = createPolicyAssignmentReceipt(assignment());
    expect(receipt).not.toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const target = join(policyAssignmentReceiptRootPath(), `${receipt!.assignmentUnitId}.json`);
    const stage = interruptedStagePath(receipt!);
    linkSync(target, stage);
    rmSync(target);

    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    expect(existsSync(stage)).toBe(false);
    expect(readPolicyAssignmentReceipts({ requireComplete: true }).receipts).toEqual([receipt]);
  });

  it('resumes a complete authenticated temporary left before stage publication', () => {
    const receipt = createPolicyAssignmentReceipt(assignment());
    expect(receipt).not.toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const target = join(policyAssignmentReceiptRootPath(), `${receipt!.assignmentUnitId}.json`);
    const temporary = `${interruptedStagePath(receipt!)}.tmp`;
    rmSync(target);
    writePrivateCrashFile(temporary, `${JSON.stringify(receipt)}\n`, home);

    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    expect(existsSync(temporary)).toBe(false);
    expect(readPolicyAssignmentReceipts({ requireComplete: true }).receipts).toEqual([receipt]);
  });

  it('replaces a private partial temporary from an interrupted write', () => {
    const receipt = createPolicyAssignmentReceipt(assignment());
    expect(receipt).not.toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const target = join(policyAssignmentReceiptRootPath(), `${receipt!.assignmentUnitId}.json`);
    const temporary = `${interruptedStagePath(receipt!)}.tmp`;
    rmSync(target);
    writePrivateCrashFile(temporary, '{"partial":', home);

    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    expect(existsSync(temporary)).toBe(false);
    expect(readPolicyAssignmentReceipts({ requireComplete: true }).receipts).toEqual([receipt]);
  });

  it('refuses recovery when the interrupted inode has an unknown third link', () => {
    const receipt = createPolicyAssignmentReceipt(assignment());
    expect(receipt).not.toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const target = join(policyAssignmentReceiptRootPath(), `${receipt!.assignmentUnitId}.json`);
    const stage = interruptedStagePath(receipt!);
    const unknown = join(policyAssignmentReceiptRootPath(), '.unknown-link');
    linkSync(target, stage);
    linkSync(target, unknown);

    expect(recordPolicyAssignmentReceipt(assignment())).toBe('failed');
    expect(existsSync(stage)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
  });

  it('preserves an unauthenticated stage-shaped hardlink', () => {
    const receipt = createPolicyAssignmentReceipt(assignment());
    expect(receipt).not.toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const target = join(policyAssignmentReceiptRootPath(), `${receipt!.assignmentUnitId}.json`);
    const untrustedStage = join(
      policyAssignmentReceiptRootPath(),
      `.${receipt!.assignmentUnitId}.${'0'.repeat(64)}.stage`,
    );
    linkSync(target, untrustedStage);

    expect(recordPolicyAssignmentReceipt(assignment())).toBe('failed');
    expect(existsSync(untrustedStage)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('does not publish a conflicting receipt around a stranded authenticated stage', () => {
    const first = createPolicyAssignmentReceipt(assignment());
    const conflictingInput = assignment({
      reportedProbabilityDenominator: 2,
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 1 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 1 },
      ],
    });
    const conflicting = createPolicyAssignmentReceipt(conflictingInput);
    expect(first).not.toBeNull();
    expect(conflicting).not.toBeNull();
    expect(conflicting!.assignmentUnitId).toBe(first!.assignmentUnitId);
    expect(conflicting!.assignmentDigest).not.toBe(first!.assignmentDigest);
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const target = join(policyAssignmentReceiptRootPath(), `${first!.assignmentUnitId}.json`);
    const stage = interruptedStagePath(first!);
    linkSync(target, stage);
    rmSync(target);

    expect(recordPolicyAssignmentReceipt(conflictingInput)).toBe('conflicted');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(stage)).toBe(true);
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    expect(readPolicyAssignmentReceipts({ requireComplete: true }).receipts).toEqual([first]);
  }, 90_000);

  it('preserves a conflicting authenticated temporary for its original assignment', () => {
    const first = createPolicyAssignmentReceipt(assignment());
    const conflictingInput = assignment({
      reportedProbabilityDenominator: 2,
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 1 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 1 },
      ],
    });
    expect(first).not.toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const target = join(policyAssignmentReceiptRootPath(), `${first!.assignmentUnitId}.json`);
    const temporary = `${interruptedStagePath(first!)}.tmp`;
    rmSync(target);
    writePrivateCrashFile(temporary, `${JSON.stringify(first)}\n`, home);

    expect(recordPolicyAssignmentReceipt(conflictingInput)).toBe('conflicted');
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(temporary, 'utf8')).toBe(`${JSON.stringify(first)}\n`);
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    expect(readPolicyAssignmentReceipts({ requireComplete: true }).receipts).toEqual([first]);
  }, 90_000);

  it('retains zero-support candidates for an exact deterministic assignment', () => {
    const receipt = createPolicyAssignmentReceipt(assignment({
      reportedAssignmentMechanism: 'deterministic-policy',
      reportedRandomizationCommitment: undefined,
      reportedProbabilityDenominator: 1,
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 0 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 1 },
      ],
    }));
    expect(receipt).toMatchObject({
      reportedAssignmentMechanism: 'deterministic-policy',
      reportedRandomizationCommitment: null,
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 0 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 1 },
      ],
    });
  });

  it('retains zero-support candidates in a reported randomized policy without claiming positivity', () => {
    expect(createPolicyAssignmentReceipt(assignment({
      reportedProbabilityDenominator: 1,
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 0 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 1 },
      ],
    }))).toMatchObject({
      causalIdentifiability: 'not-identifiable',
      reportedEligibleActions: [
        { actionId: 'codex', actionDefinitionDigest: CODEX_ACTION, probabilityNumerator: 0 },
        { actionId: 'local-coder', actionDefinitionDigest: LOCAL_ACTION, probabilityNumerator: 1 },
      ],
    });
  });

  it.skipIf(process.platform === 'win32')('collapses physical repository aliases into one assignment unit', () => {
    const alias = join(home, 'repo-alias');
    symlinkSync(repoPath, alias, 'dir');
    expect(createPolicyAssignmentReceipt(assignment({ repo: alias }))?.assignmentUnitId)
      .toBe(createPolicyAssignmentReceipt(assignment())?.assignmentUnitId);
    expect(createPolicyAssignmentReceipt(assignment({ repo: join(home, 'missing') }))).toBeNull();
  });

  it('withholds a tampered source instead of projecting healthy zero', () => {
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const [receipt] = readPolicyAssignmentReceipts().receipts;
    expect(receipt).toBeDefined();
    const path = join(policyAssignmentReceiptRootPath(), `${receipt!.assignmentUnitId}.json`);
    const tampered = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    tampered['policyEligible'] = true;
    writeFileSync(path, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });

    expect(readPolicyAssignmentReceipts()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidFiles: 1,
      stopReasons: ['invalid-file'],
    });
    expect(readPolicyAssignmentReceipts({ requireComplete: true }).receipts).toEqual([]);
  });

  it('treats unexpected receipt-directory entries as degraded source integrity', () => {
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    writeFileSync(join(policyAssignmentReceiptRootPath(), 'uncommitted.stage'), 'partial', { mode: 0o600 });
    expect(readPolicyAssignmentReceipts({ requireComplete: true })).toMatchObject({
      receipts: [],
      sourceState: 'degraded',
      complete: false,
      invalidFiles: 1,
      stopReasons: ['invalid-file'],
    });
  });

  it('rejects non-canonical JSON bytes even when the retained fields still authenticate', () => {
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const [receipt] = readPolicyAssignmentReceipts().receipts;
    const path = join(policyAssignmentReceiptRootPath(), `${receipt!.assignmentUnitId}.json`);
    const canonical = readFileSync(path, 'utf8');
    writeFileSync(path, canonical.replace('{', '{"policyEligible":true,'), { mode: 0o600 });
    expect(readPolicyAssignmentReceipts({ requireComplete: true })).toMatchObject({
      receipts: [],
      sourceState: 'degraded',
      complete: false,
      invalidFiles: 1,
      stopReasons: ['invalid-file'],
    });
  });

  it('reports bounded reads as degraded and incomplete', () => {
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const result = readPolicyAssignmentReceipts({ maxFiles: 0, requireComplete: true });
    expect(result).toMatchObject({
      receipts: [],
      sourceState: 'degraded',
      complete: false,
      limitExceeded: true,
      stopReasons: ['file-limit'],
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite read limits without projecting healthy zero',
    (limit) => {
      expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
      expect(readPolicyAssignmentReceipts({
        maxFiles: limit,
        maxBytes: limit,
        requireComplete: true,
      })).toMatchObject({
        receipts: [],
        sourceState: 'degraded',
        complete: false,
        denominatorComplete: false,
        limitExceeded: true,
        stopReasons: ['invalid-options'],
      });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite writer lock limits',
    (limit) => {
      expect(recordPolicyAssignmentReceipt(assignment(), { lockWaitMs: limit })).toBe('failed');
      expect(existsSync(policyAssignmentReceiptRootPath())).toBe(false);
    },
  );

  it('keeps a missing receipt source missing without creating read-side state', () => {
    rmSync(policyAssignmentReceiptRootPath(), { recursive: true, force: true });
    expect(readPolicyAssignmentReceipts()).toMatchObject({
      receipts: [],
      sourceState: 'missing',
      sourcePresent: false,
      complete: false,
      denominatorComplete: false,
    });
    expect(existsSync(policyAssignmentReceiptRootPath())).toBe(false);
  });

  it('withholds while a writer lock is visible', () => {
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    writeFileSync(
      join(policyAssignmentReceiptRootPath(), '.policy-assignment-receipts.lock'),
      'active',
      { mode: 0o600 },
    );
    expect(readPolicyAssignmentReceipts({ requireComplete: true })).toMatchObject({
      receipts: [],
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['source-mutated'],
    });
  });

  it('fails closed when the protected identity key disappears', () => {
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    rmSync(join(home, '.ashlr', 'foundry', 'provenance.key'));
    expect(createPolicyAssignmentReceipt(assignment())).toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('failed');
    expect(readPolicyAssignmentReceipts()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['identity-key-unavailable'],
      receipts: [],
    });
  });

  it.skipIf(process.platform === 'win32')('rejects unsafe receipt storage', () => {
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    chmodSync(policyAssignmentReceiptRootPath(), 0o755);
    expect(readPolicyAssignmentReceipts()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['unsafe-storage'],
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked receipt file', () => {
    const receipt = createPolicyAssignmentReceipt(assignment());
    expect(receipt).not.toBeNull();
    expect(recordPolicyAssignmentReceipt(assignment())).toBe('recorded');
    const path = join(policyAssignmentReceiptRootPath(), `${receipt!.assignmentUnitId}.json`);
    rmSync(path);
    symlinkSync('/dev/null', path);
    expect(readPolicyAssignmentReceipts({ requireComplete: true })).toMatchObject({
      receipts: [],
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['invalid-file'],
    });
  });
});
