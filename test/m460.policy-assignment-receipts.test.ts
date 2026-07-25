import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  createPolicyAssignmentReceipt,
  policyAssignmentReceiptRootPath,
  readPolicyAssignmentReceipts,
  recordPolicyAssignmentReceipt,
  verifyPolicyAssignmentReceipt,
  type PolicyAssignmentReceiptInput,
} from '../src/core/learning/policy-assignment-receipts.js';

const GENERATION = 'a'.repeat(64);
const OBJECTIVE = 'b'.repeat(64);
const CODEX_ACTION = '1'.repeat(64);
const LOCAL_ACTION = '2'.repeat(64);
let repoPath = '';

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

describe('M460 policy assignment receipts', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-policy-assignment-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    repoPath = join(home, 'repo');
    mkdirSync(repoPath);
    loadOrCreateKey();
  });

  afterEach(() => {
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
