import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MissionShadowObservationInput } from '../src/core/vision/mission-shadow-observer.js';

describe('M502 read-only Mission shadow observer', () => {
  let home: string;
  let repo: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-m502-'));
    repo = join(home, 'repo');
    mkdirSync(repo, { recursive: true });
    repo = realpathSync(repo);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.resetModules();
    const provenance = await import('../src/core/foundry/provenance.js');
    provenance.loadOrCreateKey();
    const policy = await import('../src/core/sandbox/policy.js');
    expect(policy.enroll(repo)).toMatchObject({ ok: true, quiesced: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  async function observationInput(recordedAt = '2026-08-10T20:00:00.000Z'): Promise<MissionShadowObservationInput> {
    const strategist = await import('../src/core/vision/strategist.js');
    const goals = await import('../src/core/goals/store.js');
    const inbox = await import('../src/core/inbox/store.js');
    const policy = await import('../src/core/sandbox/policy.js');
    const enrollment = policy.readEnrollmentRegistry();
    if (enrollment.state !== 'ready') throw new Error('fixture enrollment unavailable');
    const briefing = {
      generatedAt: '2026-08-10T19:00:00.000Z',
      project: null,
      currentState: 'Mission OS has a bounded shadow planner.',
      gapToVision: 'The operator cannot see its current read-only result in Mission Control.',
      proposedEvolution: {},
      recommendedDirection: ['Expose a current, zero-effect suggestion.'],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [{
        key: 'shadow-room',
        objective: 'Show the verified shadow suggestion in the Outcome Room',
        rationale: 'Make bounded autonomy legible.',
        targetRepo: repo,
        dependsOn: [],
        deliverable: 'A read-only shadow status card',
        acceptanceEvidence: ['No receipt write', 'All effect flags remain false'],
        riskClass: 'low' as const,
        humanGate: false,
        outcome: {
          desiredOutcome: 'The operator sees what Mission OS would plan next.',
          successSignals: ['The displayed decision is receipt-bound'],
          guardrails: ['No planning or execution mutation'],
        },
      }],
    };
    const graph = strategist.compileBriefingMissionGraph(briefing, enrollment.repos);
    if (!graph?.ok) throw new Error(`fixture graph unavailable: ${JSON.stringify(graph)}`);
    const inventory = goals.listGoalsDetailed();
    const proposals = inbox.listProposalsDetailed({ requireComplete: true });
    const preview = strategist.previewBriefingAdoption(briefing, {
      enrolledRepos: enrollment.repos,
      existingGoals: inventory.goals,
      goalSourceState: inventory.sourceState,
      activeThreshold: 3,
      goalRealized: () => false,
    });
    return {
      recordedAt,
      graph: graph.graph,
      briefing,
      briefingQuality: { sourceState: 'healthy', sourcePresent: true, complete: true },
      enrollment,
      goals: inventory,
      proposals,
      preview,
    };
  }

  function captureInput(input: MissionShadowObservationInput) {
    const { preview: _preview, ...captureOnly } = input;
    return captureOnly;
  }

  it('reports a complete missing receipt ledger without creating it', async () => {
    const { observeMissionReconcileShadow } = await import('../src/core/vision/mission-shadow-observer.js');
    const receipts = await import('../src/core/vision/mission-receipt.js');
    const receiptRoot = join(home, '.ashlr', 'mission-receipts');
    expect(existsSync(receiptRoot)).toBe(false);
    expect(receipts.readMissionObservationReceipts({ requireComplete: true })).toMatchObject({
      receipts: [], sourceState: 'missing', sourcePresent: false, complete: false,
      invalidFiles: 0, limitExceeded: false,
    });
    expect(observeMissionReconcileShadow(await observationInput())).toMatchObject({
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'missing',
      reason: 'receipt-missing',
      receipt: { state: 'missing', recordedAt: null },
      suggestion: null,
    });
    expect(existsSync(receiptRoot)).toBe(false);
    expect(existsSync(join(home, '.ashlr', 'goals'))).toBe(false);
  });

  it('reads an existing receipt and emits one all-false suggestion without changing storage', async () => {
    const input = await observationInput();
    const capture = await import('../src/core/vision/mission-observation-capture.js');
    const receipts = await import('../src/core/vision/mission-receipt.js');
    const captured = capture.captureMissionObservation(captureInput(input));
    if (!captured.ok) throw new Error(`fixture capture failed: ${captured.reason}`);
    expect(receipts.recordMissionObservationReceipt(captured.receiptInput).disposition).toBe('recorded');
    const recordsDir = join(receipts.missionObservationReceiptRootPath(), 'records');
    const before = readdirSync(recordsDir).sort();

    const observer = await import('../src/core/vision/mission-shadow-observer.js');
    const result = observer.observeMissionReconcileShadow({
      ...input,
      recordedAt: '2026-08-10T21:00:00.000Z',
    });
    expect(result).toMatchObject({
      state: 'would-create',
      reason: 'would-create',
      receipt: { state: 'verified', recordedAt: input.recordedAt },
      suggestion: {
        authority: 'observation-only',
        planningAuthority: false,
        executionAuthority: false,
        decision: { nodeKey: 'shadow-room', graphOrder: 0 },
        bounds: { maxSuggestions: 1, maxGoalCreations: 0 },
      },
    });
    if (result.suggestion === null) throw new Error('expected verified suggestion');
    expect(Object.values(result.suggestion.effects).every((effect) => effect === false)).toBe(true);
    expect(readdirSync(recordsDir).sort()).toEqual(before);
    expect(existsSync(join(home, '.ashlr', 'goals'))).toBe(false);
  });

  it('selects the newest mission receipt while recomputing from caller-supplied current sources', async () => {
    const oldInput = await observationInput('2026-08-10T20:00:00.000Z');
    const capture = await import('../src/core/vision/mission-observation-capture.js');
    const receipts = await import('../src/core/vision/mission-receipt.js');
    const goals = await import('../src/core/goals/store.js');
    const oldCapture = capture.captureMissionObservation(captureInput(oldInput));
    if (!oldCapture.ok) throw new Error(`old capture failed: ${oldCapture.reason}`);
    const oldReceipt = receipts.createMissionObservationReceipt(oldCapture.receiptInput);
    if (!oldReceipt) throw new Error('old receipt unavailable');

    goals.createGoal('Unrelated current planning work', {
      project: repo,
      now: '2026-08-10T20:30:00.000Z',
    });
    const newerInput = await observationInput('2026-08-10T21:00:00.000Z');
    const newerCapture = capture.captureMissionObservation(captureInput(newerInput));
    if (!newerCapture.ok) throw new Error(`new capture failed: ${newerCapture.reason}`);
    const newerReceipt = receipts.createMissionObservationReceipt(newerCapture.receiptInput);
    if (!newerReceipt) throw new Error('new receipt unavailable');

    const observer = await import('../src/core/vision/mission-shadow-observer.js');
    const result = observer.observeMissionReconcileShadowFromRead(oldInput, {
      receipts: [oldReceipt, newerReceipt],
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      stopReasons: [],
      filesRead: 2,
      bytesRead: 1,
      invalidFiles: 0,
      limitExceeded: false,
    });
    expect(result).toMatchObject({
      state: 'would-create',
      reason: 'would-create',
      receipt: { state: 'verified', recordedAt: newerReceipt.recordedAt },
      suggestion: {
        basis: {
          missionReceiptId: newerReceipt.receiptId,
          currentGoalSourceDigest: oldCapture.receiptInput.goalSource.digest,
        },
      },
    });
    expect(oldCapture.receiptInput.goalSource.digest).not.toBe(newerReceipt.goalSourceDigest);
  });

  it('fails closed on an incomplete receipt ledger and imports no mutation API', async () => {
    const observer = await import('../src/core/vision/mission-shadow-observer.js');
    expect(observer.observeMissionReconcileShadowFromRead(await observationInput(), {
      receipts: [],
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      stopReasons: ['invalid-file'],
      filesRead: 0,
      bytesRead: 0,
      invalidFiles: 1,
      limitExceeded: false,
    })).toMatchObject({
      state: 'withheld',
      reason: 'receipt-source-degraded',
      receipt: { state: 'degraded' },
      suggestion: null,
    });

    const source = readFileSync(join(process.cwd(), 'src/core/vision/mission-shadow-observer.ts'), 'utf8');
    expect(source).not.toContain('recordMissionObservationReceipt');
    expect(source).not.toContain("../goals/store.js");
    expect(source).not.toContain("../inbox/store.js");
    expect(source).not.toContain('createProposal');
    expect(source).not.toContain('runGoal');
    expect(source).not.toContain('mergeProposal');
  });

  it('withholds before receipt selection when the current proposal source is incomplete', async () => {
    const input = await observationInput();
    input.proposals = {
      ...input.proposals,
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      stopReasons: ['io-error'],
    };
    const observer = await import('../src/core/vision/mission-shadow-observer.js');
    expect(observer.observeMissionReconcileShadowFromRead(input, {
      receipts: [],
      sourceState: 'missing',
      sourcePresent: false,
      complete: false,
      stopReasons: [],
      filesRead: 0,
      bytesRead: 0,
      invalidFiles: 0,
      limitExceeded: false,
    })).toMatchObject({
      state: 'withheld',
      reason: 'proposal-source-incomplete',
      receipt: { state: 'degraded' },
      suggestion: null,
    });
  });
});
