import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shadowVerifierSeam = vi.hoisted(() => ({ failSuggestionVerification: false }));
const receiptWriterSeam = vi.hoisted(() => ({ persistenceAmbiguous: false }));

vi.mock('../src/core/vision/mission-reconcile-shadow.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/vision/mission-reconcile-shadow.js')>();
  return {
    ...original,
    verifyMissionReconcileSuggestion(value: unknown) {
      return shadowVerifierSeam.failSuggestionVerification
        ? null
        : original.verifyMissionReconcileSuggestion(value);
    },
  };
});

vi.mock('../src/core/vision/mission-receipt.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/vision/mission-receipt.js')>();
  return {
    ...original,
    recordMissionObservationReceipt(...args: Parameters<typeof original.recordMissionObservationReceipt>) {
      return receiptWriterSeam.persistenceAmbiguous
        ? { disposition: 'persistence-failed' as const, receipt: null }
        : original.recordMissionObservationReceipt(...args);
    },
  };
});

describe('M497 vision shadow CLI', () => {
  let home: string;
  let repo: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    shadowVerifierSeam.failSuggestionVerification = false;
    receiptWriterSeam.persistenceAmbiguous = false;
    home = mkdtempSync(join(tmpdir(), 'ashlr-m497-'));
    repo = join(home, 'repo');
    mkdirSync(repo, { recursive: true });
    repo = realpathSync(repo);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.resetModules();
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const provenance = await import('../src/core/foundry/provenance.js');
    provenance.loadOrCreateKey();
    const policy = await import('../src/core/sandbox/policy.js');
    expect(policy.enroll(repo)).toMatchObject({ ok: true, quiesced: true });

    const briefing = {
      generatedAt: '2026-08-10T20:00:00.000Z',
      project: null,
      currentState: 'The planning kernel is ready for evidence-only shadowing.',
      gapToVision: 'Durable observation and safe automatic suggestion are missing.',
      proposedEvolution: {},
      recommendedDirection: ['Prove the zero-effect mission reconciliation loop.'],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [{
        key: 'shadow-loop',
        objective: 'Build the evidence-only shadow reconciliation loop',
        rationale: 'Measure autonomous planning without steering daemon execution.',
        targetRepo: repo,
        dependsOn: [],
        deliverable: 'A durable receipt and zero-effect suggestion',
        acceptanceEvidence: ['Authenticated receipt', 'All effect flags false'],
        riskClass: 'low',
        humanGate: false,
        outcome: {
          desiredOutcome: 'Autonomous planning can be measured without creating executable work.',
          successSignals: ['A replay-stable suggestion is emitted'],
          guardrails: ['No goal or outward effect is created'],
        },
      }],
    };
    const briefings = join(home, '.ashlr', 'vision', 'briefings');
    mkdirSync(briefings, { recursive: true });
    writeFileSync(
      join(briefings, '2026-08-10T20-00-00-000Z.json'),
      `${JSON.stringify(briefing)}\n`,
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    shadowVerifierSeam.failSuggestionVerification = false;
    receiptWriterSeam.persistenceAmbiguous = false;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('records one immutable observation and emits a replay-stable zero-effect suggestion', async () => {
    const strategist = await import('../src/core/vision/strategist.js');
    const briefingRead = strategist.readLatestBriefingDetailed();
    expect(briefingRead.sourceState, JSON.stringify(briefingRead)).toBe('healthy');
    const policy = await import('../src/core/sandbox/policy.js');
    const enrollment = policy.readEnrollmentRegistry();
    expect(enrollment.state, JSON.stringify(enrollment)).toBe('ready');
    if (enrollment.state !== 'ready' || !briefingRead.briefing) throw new Error('missing fixture authority');
    const compiled = strategist.compileBriefingMissionGraph(briefingRead.briefing, enrollment.repos);
    expect(compiled?.ok, JSON.stringify(compiled)).toBe(true);
    const { cmdVision } = await import('../src/cli/vision.js');
    const firstCode = await cmdVision(['shadow', '--json']);
    expect(firstCode, JSON.stringify(log.mock.calls)).toBe(0);
    const first = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, any>;
    expect(first).toMatchObject({
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'would-create',
      receipt: { disposition: 'recorded' },
      suggestion: {
        authority: 'observation-only',
        planningAuthority: false,
        executionAuthority: false,
        decision: { nodeKey: 'shadow-loop' },
        bounds: { maxSuggestions: 1, maxGoalCreations: 0 },
      },
    });
    expect(Object.values(first.suggestion.effects).every((value) => value === false)).toBe(true);
    expect(existsSync(join(home, '.ashlr', 'mission-receipts', 'records'))).toBe(true);
    expect(existsSync(join(home, '.ashlr', 'goals'))).toBe(false);

    log.mockClear();
    expect(await cmdVision(['shadow', '--json'])).toBe(0);
    const second = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, any>;
    expect(second.receipt.disposition).toBe('replayed');
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(second.suggestion.suggestionId).toBe(first.suggestion.suggestionId);
    expect(error).not.toHaveBeenCalled();
  });

  it('rejects unknown flags before reading or writing mission evidence', async () => {
    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['shadow', '--json', '--active'])).toBe(2);
    expect(existsSync(join(home, '.ashlr', 'mission-receipts'))).toBe(false);
  });

  it('truthfully reports a recorded receipt when post-persistence suggestion verification fails', async () => {
    shadowVerifierSeam.failSuggestionVerification = true;
    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['shadow', '--json'])).toBe(1);
    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, any>;
    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'withheld',
      reason: 'suggestion-invalid',
      receipt: { disposition: 'recorded' },
      effects: { missionReceipt: 'recorded', outward: 'none' },
    });
    expect(result.receipt.receiptId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(home, '.ashlr', 'mission-receipts', 'records'))).toBe(true);
    expect(existsSync(join(home, '.ashlr', 'goals'))).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('reports unknown effects when receipt persistence cannot be proven', async () => {
    receiptWriterSeam.persistenceAmbiguous = true;
    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['shadow', '--json'])).toBe(1);
    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, any>;
    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'withheld',
      reason: 'receipt-persistence-failed',
      receipt: { disposition: 'persistence-failed' },
      effects: { missionReceipt: 'unknown', outward: 'unknown' },
    });
    expect(existsSync(join(home, '.ashlr', 'goals'))).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});
