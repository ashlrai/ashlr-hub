import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadOrCreateKey, provenanceKeyPath } from '../src/core/foundry/provenance.js';
import {
  createMissionObservationReceipt,
  missionObservationBriefingDigest,
  missionObservationReceiptRootPath,
  readMissionObservationReceiptPoint,
  readMissionObservationReceipts,
  recordMissionObservationReceipt,
  verifyMissionObservationReceipt,
  type MissionObservationReceiptInput,
} from '../src/core/vision/mission-receipt.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const REVISION = 'd'.repeat(40);

function briefing() {
  return {
    generatedAt: '2026-08-10T12:00:00.000Z',
    project: '/private/company/ashlr-hub',
    currentState: 'The mission needs durable evidence.',
    gapToVision: 'Receipts are not yet durable.',
    proposedEvolution: {},
    recommendedDirection: ['Record bounded evidence.'],
    newProblems: [],
    questionsForMason: [],
    proposedGoals: [{
      key: 'receipt',
      objective: 'Build the durable mission receipt',
      rationale: 'Preserve exact evidence without granting authority.',
      targetRepo: '/private/company/ashlr-hub',
    }],
  };
}

function source(digest: string) {
  return { sourceState: 'healthy' as const, complete: true, digest };
}

function input(overrides: Partial<MissionObservationReceiptInput> = {}): MissionObservationReceiptInput {
  const exactBriefing = briefing();
  return {
    recordedAt: '2026-08-10T12:30:00.000Z',
    captureKind: 'explicit-reconcile',
    missionKey: 'autonomous-team-os',
    graphDigest: DIGEST_A,
    briefing: exactBriefing,
    briefingSource: source(missionObservationBriefingDigest(exactBriefing)!),
    enrollmentSource: source(DIGEST_A),
    goalSource: source(DIGEST_B),
    proposalSource: source(DIGEST_C),
    nodes: [
      {
        nodeKey: 'receipt',
        kind: 'work',
        status: 'ready',
        blockedBy: [],
        goalId: null,
        goalRecordDigest: null,
        milestones: [],
      },
      {
        nodeKey: 'human-release',
        kind: 'human-gate',
        status: 'blocked',
        blockedBy: ['receipt'],
        goalId: null,
        goalRecordDigest: null,
        milestones: [],
      },
    ],
    ...overrides,
  };
}

function realizedInput(): MissionObservationReceiptInput {
  return input({
    nodes: [{
      nodeKey: 'receipt',
      kind: 'work',
      status: 'complete',
      blockedBy: [],
      goalId: 'goal-sensitive-objective-slug-123',
      goalRecordDigest: DIGEST_A,
      milestones: [{
        milestoneId: 'goal-sensitive-objective-slug-123-m0',
        status: 'done',
        proposalId: 'prop-private-identifier',
        proposalStatus: 'applied',
        verificationPassed: true,
        verificationDigest: DIGEST_B,
        mergeSource: 'github-host',
        exactRevision: REVISION,
        realizedMergeDigest: DIGEST_C,
      }],
    }],
  });
}

describe('M493 mission observation receipts', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-m493-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    loadOrCreateKey();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('binds one bounded exact briefing digest without persisting briefing prose or paths', () => {
    const first = briefing();
    const second = {
      proposedGoals: first.proposedGoals,
      questionsForMason: first.questionsForMason,
      newProblems: first.newProblems,
      recommendedDirection: first.recommendedDirection,
      proposedEvolution: first.proposedEvolution,
      gapToVision: first.gapToVision,
      currentState: first.currentState,
      project: first.project,
      generatedAt: first.generatedAt,
    };
    expect(missionObservationBriefingDigest(second)).toBe(missionObservationBriefingDigest(first));
    expect(missionObservationBriefingDigest({ value: Number.NaN })).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(missionObservationBriefingDigest(cyclic)).toBeNull();

    const receipt = createMissionObservationReceipt(input());
    expect(receipt?.briefingDigest).toBe(missionObservationBriefingDigest(first));
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('/private/company');
    expect(serialized).not.toContain('durable mission receipt');
  });

  it('fixes every authority field false and keeps business/human evidence explicitly unobserved', () => {
    const receipt = createMissionObservationReceipt(input());
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      protocol: 'mission-observation-receipt-v1',
      recordType: 'mission-observation',
      authority: 'observation-only',
      planningAuthority: false,
      executionAuthority: false,
      proposalAuthority: false,
      mergeAuthority: false,
      releaseAuthority: false,
      deployAuthority: false,
      externalMutationAuthority: false,
      learningAuthority: false,
      policyEligible: false,
      attestationAuthority: 'host-shared-hmac',
      verifierIsolated: false,
      sourceComplete: true,
      engineeringStatus: 'ready',
      businessOutcomeStatus: 'not-observed',
      humanDecisionEvidenceComplete: false,
      outcomeEvidenceComplete: false,
    });
    expect(verifyMissionObservationReceipt(receipt)).toEqual(receipt);
  });

  it('HMACs local identifiers while binding verified realized-merge evidence and exact revision', () => {
    const receipt = createMissionObservationReceipt(realizedInput());
    expect(receipt).toMatchObject({
      engineeringStatus: 'complete',
      businessOutcomeStatus: 'not-observed',
      nodes: [{
        status: 'complete',
        engineeringRealized: true,
        goalRef: expect.stringMatching(/^[a-f0-9]{64}$/),
        milestones: [{
          proposalRef: expect.stringMatching(/^[a-f0-9]{64}$/),
          verificationPassed: true,
          mergeSource: 'github-host',
          exactRevision: REVISION,
          engineeringRealized: true,
        }],
      }],
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('goal-sensitive-objective');
    expect(serialized).not.toContain('prop-private-identifier');
  });

  it('rejects partial or shape-only realization evidence', () => {
    const broken = realizedInput();
    broken.nodes[0]!.milestones[0]!.verificationPassed = false;
    expect(createMissionObservationReceipt(broken)).toBeNull();

    const noMerge = realizedInput();
    noMerge.nodes[0]!.milestones[0]!.mergeSource = null;
    noMerge.nodes[0]!.milestones[0]!.exactRevision = null;
    noMerge.nodes[0]!.milestones[0]!.realizedMergeDigest = null;
    expect(createMissionObservationReceipt(noMerge)).toBeNull();

    const rawHumanApproval = input() as MissionObservationReceiptInput & { humanApproved?: boolean };
    rawHumanApproval.humanApproved = true;
    expect(createMissionObservationReceipt(rawHumanApproval)).toBeNull();
    expect(recordMissionObservationReceipt(rawHumanApproval)).toEqual({
      disposition: 'invalid',
      receipt: null,
    });
  });

  it('records atomically and replays the same semantic snapshot despite a later wall clock', () => {
    const first = recordMissionObservationReceipt(input());
    const second = recordMissionObservationReceipt(input({
      recordedAt: '2026-08-10T13:30:00.000Z',
    }));
    expect(first.disposition).toBe('recorded');
    expect(second.disposition).toBe('replayed');
    expect(second.receipt?.receiptId).toBe(first.receipt?.receiptId);
    expect(second.receipt?.recordedAt).toBe('2026-08-10T12:30:00.000Z');
    expect(readMissionObservationReceipts({ requireComplete: true })).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      receipts: [expect.objectContaining({ receiptId: first.receipt?.receiptId })],
    });
    expect(readMissionObservationReceiptPoint(first.receipt!.receiptId).record).toEqual(first.receipt);
  });

  it.each([
    ['briefing', { briefingSource: { sourceState: 'degraded', complete: false, digest: DIGEST_A } }],
    ['enrollment', { enrollmentSource: { sourceState: 'degraded', complete: false, digest: DIGEST_A } }],
    ['goals', { goalSource: { sourceState: 'degraded', complete: false, digest: DIGEST_B } }],
    ['proposals', { proposalSource: { sourceState: 'degraded', complete: false, digest: DIGEST_C } }],
  ] as const)('writes nothing when the %s evidence source is degraded', (_name, override) => {
    const result = recordMissionObservationReceipt(input(override as Partial<MissionObservationReceiptInput>));
    expect(result).toEqual({ disposition: 'source-degraded', receipt: null });
    expect(readMissionObservationReceipts({ requireComplete: true }).sourceState).toBe('missing');
  });

  it('fails closed when the existing provenance key is unavailable and creates no receipt store', () => {
    rmSync(provenanceKeyPath());
    expect(recordMissionObservationReceipt(input())).toEqual({
      disposition: 'key-unavailable',
      receipt: null,
    });
    expect(createMissionObservationReceipt(input())).toBeNull();
    expect(verifyMissionObservationReceipt({})).toBeNull();
    expect(readMissionObservationReceipts({ requireComplete: true })).toMatchObject({
      sourceState: 'missing',
      receipts: [],
    });
  });

  it('rejects tampering, unknown fields, duplicate nodes, invalid bounds, and inconsistent statuses', () => {
    const receipt = createMissionObservationReceipt(realizedInput())!;
    for (const tampered of [
      { ...receipt, mergeAuthority: true },
      { ...receipt, graphDigest: DIGEST_B },
      { ...receipt, receiptDigest: DIGEST_A },
      { ...receipt, attestation: DIGEST_A },
      { ...receipt, surpriseAuthority: true },
    ]) expect(verifyMissionObservationReceipt(tampered)).toBeNull();

    const duplicate = input({ nodes: [input().nodes[0]!, input().nodes[0]!] });
    expect(createMissionObservationReceipt(duplicate)).toBeNull();
    const oversized = input({ nodes: Array.from({ length: 25 }, (_, index) => ({
      ...input().nodes[0]!, nodeKey: `node-${index}`,
    })) });
    expect(createMissionObservationReceipt(oversized)).toBeNull();
    const inconsistent = input();
    inconsistent.nodes[0]!.status = 'blocked';
    expect(createMissionObservationReceipt(inconsistent)).toBeNull();

    const accessor = input() as MissionObservationReceiptInput & { approval?: boolean };
    Object.defineProperty(accessor, 'approval', { enumerable: true, get: () => true });
    expect(createMissionObservationReceipt(accessor)).toBeNull();
    expect(recordMissionObservationReceipt(accessor).disposition).toBe('invalid');

    const symbolField = input() as MissionObservationReceiptInput & Record<symbol, boolean>;
    symbolField[Symbol('approval')] = true;
    expect(createMissionObservationReceipt(symbolField)).toBeNull();
  });

  it('degrades a complete ledger read when the record namespace is corrupt', () => {
    expect(recordMissionObservationReceipt(input()).disposition).toBe('recorded');
    const records = join(missionObservationReceiptRootPath(), 'records');
    writeFileSync(join(records, 'unknown.txt'), 'hostile\n', { mode: 0o600 });
    const read = readMissionObservationReceipts({ requireComplete: true });
    expect(read).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      receipts: [],
      stopReasons: expect.arrayContaining(['invalid-file']),
    });
  });

  it('withholds records when caller bounds make the aggregate snapshot incomplete', () => {
    expect(recordMissionObservationReceipt(input()).disposition).toBe('recorded');
    expect(readMissionObservationReceipts({ maxFiles: 0, requireComplete: true })).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      receipts: [],
      limitExceeded: true,
    });
  });

  it('persists a single-line private canonical record', () => {
    const result = recordMissionObservationReceipt(input());
    expect(result.disposition).toBe('recorded');
    const file = join(missionObservationReceiptRootPath(), 'records', `${result.receipt!.receiptId}.json`);
    const contents = readFileSync(file, 'utf8');
    expect(contents.endsWith('\n')).toBe(true);
    expect(contents.slice(0, -1)).not.toContain('\n');
    if (process.platform !== 'win32') {
      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
