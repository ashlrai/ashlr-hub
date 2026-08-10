import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';

import {
  MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES,
  planMissionReconcileShadow,
  resolveMissionReconcileMode,
  verifyMissionReconcileSuggestion,
  type MissionReconcileCurrentPreview,
  type MissionReconcilePreviewCandidate,
  type MissionReconcileReceiptEvidence,
} from '../src/core/vision/mission-reconcile-shadow.js';
import {
  createMissionObservationReceipt,
  missionObservationBriefingDigest,
  type MissionObservationReceiptV1,
} from '../src/core/vision/mission-receipt.js';

const digest = (character: string): string => character.repeat(64);

let authenticatedReceipt: MissionObservationReceiptV1;

function receipt(options: { graphDigest?: string; briefingTag?: string } = {}): MissionObservationReceiptV1 {
  const briefing = { generatedAt: '2026-08-10T12:00:00.000Z', tag: options.briefingTag ?? 'current' };
  const created = createMissionObservationReceipt({
    recordedAt: '2026-08-10T12:00:00.000Z',
    captureKind: 'explicit-reconcile',
    missionKey: 'autonomous-team-os',
    graphDigest: options.graphDigest ?? digest('a'),
    briefing,
    briefingSource: {
      sourceState: 'healthy', complete: true, digest: missionObservationBriefingDigest(briefing)!,
    },
    enrollmentSource: { sourceState: 'healthy', complete: true, digest: digest('1') },
    goalSource: { sourceState: 'missing', complete: true, digest: digest('2') },
    proposalSource: { sourceState: 'missing', complete: true, digest: digest('3') },
    nodes: [{
      nodeKey: 'hub-shadow', kind: 'work', status: 'ready', blockedBy: [],
      goalId: null, goalRecordDigest: null, milestones: [],
    }],
  });
  if (!created) throw new Error('expected authenticated mission receipt');
  return created;
}

function verifiedReceipt(
  overrides: Partial<MissionObservationReceiptV1> = {},
): MissionReconcileReceiptEvidence {
  return { state: 'verified', receipt: { ...authenticatedReceipt, ...overrides } };
}

function candidate(
  graphOrder: number,
  nodeKey: string,
  overrides: Partial<MissionReconcilePreviewCandidate> = {},
): MissionReconcilePreviewCandidate {
  return {
    graphOrder,
    nodeKey,
    kind: 'work',
    disposition: 'create',
    reason: 'ready',
    ...overrides,
  };
}

function current(
  candidates: readonly MissionReconcilePreviewCandidate[] = [candidate(0, 'hub-shadow')],
  overrides: Partial<MissionReconcileCurrentPreview> = {},
): MissionReconcileCurrentPreview {
  return {
    missionKey: 'autonomous-team-os',
    graphDigest: digest('a'),
    briefingDigest: authenticatedReceipt.briefingDigest,
    briefingSource: { state: 'healthy', complete: true, digest: authenticatedReceipt.briefingDigest },
    enrollmentSource: { state: 'healthy', complete: true, digest: digest('4') },
    goalSource: { state: 'missing', complete: true, digest: digest('5') },
    proposalSource: { state: 'missing', complete: true, digest: digest('6') },
    activeGoalThreshold: 4,
    candidates,
    ...overrides,
  };
}

describe('M494 pure mission reconcile shadow lane', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-m494-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    loadOrCreateKey();
    authenticatedReceipt = receipt();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  it('requires an exact shadow opt-in and defaults every other value to off', () => {
    expect(resolveMissionReconcileMode('shadow')).toBe('shadow');
    for (const value of ['off', 'active', 'SHADOW', true, null, undefined, { mode: 'shadow' }]) {
      expect(resolveMissionReconcileMode(value)).toBe('off');
    }
  });

  it('selects exactly one would-create candidate in deterministic graph order', () => {
    const candidates = [candidate(2, 'third'), candidate(0, 'first'), candidate(1, 'second')];
    const plan = planMissionReconcileShadow({
      mode: 'shadow',
      receiptEvidence: verifiedReceipt(),
      current: current(candidates),
    });

    expect(plan).toMatchObject({
      disposition: 'would-create',
      reason: 'would-create',
      suggestion: {
        authority: 'observation-only',
        planningAuthority: false,
        executionAuthority: false,
        policyEligible: false,
        decision: {
          disposition: 'would-create',
          nodeKey: 'first',
          graphOrder: 0,
        },
        bounds: { maxSuggestions: 1, maxGoalCreations: 0 },
      },
    });
    if (!plan.suggestion) throw new Error('expected a suggestion');
    expect(verifyMissionReconcileSuggestion(plan.suggestion)).toEqual(plan.suggestion);
    expect(Object.values(plan.suggestion.effects).every((value) => value === false)).toBe(true);
  });

  it('produces stable basis, identity, and suggestion digests independent of candidate input order', () => {
    const candidates = [
      candidate(0, 'blocked', { disposition: 'skip', reason: 'dependency-blocked' }),
      candidate(1, 'ready'),
    ];
    const first = planMissionReconcileShadow({
      mode: 'shadow', receiptEvidence: verifiedReceipt(), current: current(candidates),
    });
    const second = planMissionReconcileShadow({
      mode: 'shadow', receiptEvidence: verifiedReceipt(), current: current([...candidates].reverse()),
    });
    expect(first.suggestion).not.toBeNull();
    expect(second.suggestion).toEqual(first.suggestion);

    const advanced = planMissionReconcileShadow({
      mode: 'shadow',
      receiptEvidence: verifiedReceipt(),
      current: current(candidates, {
        goalSource: { state: 'healthy', complete: true, digest: digest('7') },
      }),
    });
    expect(advanced.suggestion?.basisDigest).not.toBe(first.suggestion?.basisDigest);
    expect(advanced.suggestion?.suggestionId).not.toBe(first.suggestion?.suggestionId);

    const thresholdChanged = planMissionReconcileShadow({
      mode: 'shadow', receiptEvidence: verifiedReceipt(),
      current: current(candidates, { activeGoalThreshold: 5 }),
    });
    expect(thresholdChanged.suggestion?.basisDigest).not.toBe(first.suggestion?.basisDigest);
    expect(thresholdChanged.suggestion?.suggestionId).not.toBe(first.suggestion?.suggestionId);
  });

  it('records deterministic policy holds but never upgrades them to readiness', () => {
    const holds = [
      ['human-gate-required', candidate(0, 'approval', {
        kind: 'human-gate', disposition: 'skip', reason: 'human-gate-required',
      })],
      ['dependency-blocked', candidate(0, 'consumer', {
        disposition: 'skip', reason: 'dependency-blocked',
      })],
      ['goal-focus-cap', candidate(0, 'capacity', {
        disposition: 'skip', reason: 'goal-focus-cap',
      })],
      ['duplicate-existing-goal', candidate(0, 'existing', {
        disposition: 'skip', reason: 'duplicate-existing-goal',
      })],
    ] as const;
    for (const [reason, blocked] of holds) {
      const plan = planMissionReconcileShadow({
        mode: 'shadow', receiptEvidence: verifiedReceipt(), current: current([blocked]),
      });
      expect(plan).toMatchObject({
        disposition: 'held', reason,
        suggestion: { decision: { disposition: 'hold', reason } },
      });
      expect(verifyMissionReconcileSuggestion(plan.suggestion)).toEqual(plan.suggestion);
    }

    const empty = planMissionReconcileShadow({
      mode: 'shadow', receiptEvidence: verifiedReceipt(), current: current([]),
    });
    expect(empty).toMatchObject({
      disposition: 'held',
      reason: 'no-ready-node',
      suggestion: { decision: { nodeKey: null, graphOrder: null } },
    });
  });

  it('fails closed for missing, invalid, degraded, or stale receipt evidence', () => {
    const cases: Array<[MissionReconcileReceiptEvidence, string]> = [
      [{ state: 'missing', receipt: null }, 'receipt-missing'],
      [{ state: 'invalid', receipt: null }, 'receipt-invalid'],
      [{ state: 'source-degraded', receipt: null }, 'receipt-source-degraded'],
      [verifiedReceipt({ planningAuthority: true as false }), 'receipt-invalid'],
      [{ state: 'verified', receipt: receipt({ graphDigest: digest('9') }) }, 'receipt-binding-mismatch'],
      [{ state: 'verified', receipt: receipt({ briefingTag: 'stale' }) }, 'receipt-binding-mismatch'],
    ];
    for (const [receiptEvidence, reason] of cases) {
      expect(planMissionReconcileShadow({
        mode: 'shadow', receiptEvidence, current: current(),
      })).toEqual({ disposition: 'skipped', reason, suggestion: null });
    }
  });

  it('requires independently complete current sources and accepts authoritative empty stores', () => {
    const fields = [
      ['briefingSource', 'briefing-source-degraded'],
      ['enrollmentSource', 'enrollment-source-degraded'],
      ['goalSource', 'goal-source-degraded'],
      ['proposalSource', 'proposal-source-degraded'],
    ] as const;
    for (const [field, reason] of fields) {
      const base = current();
      const plan = planMissionReconcileShadow({
        mode: 'shadow',
        receiptEvidence: verifiedReceipt(),
        current: {
          ...base,
          [field]: { ...base[field], state: 'degraded', complete: false },
        },
      });
      expect(plan).toEqual({ disposition: 'skipped', reason, suggestion: null });
    }

    const authoritativeEmpty = planMissionReconcileShadow({
      mode: 'shadow', receiptEvidence: verifiedReceipt(), current: current(),
    });
    expect(authoritativeEmpty.disposition).toBe('would-create');
  });

  it('rejects malformed, duplicate, or over-limit normalized previews', () => {
    const invalidSets: readonly (readonly MissionReconcilePreviewCandidate[])[] = [
      [candidate(0, 'same'), candidate(1, 'same')],
      [candidate(0, 'one'), candidate(0, 'two')],
      [candidate(0, 'gate', { kind: 'human-gate' })],
      Array.from(
        { length: MAX_MISSION_RECONCILE_PREVIEW_CANDIDATES + 1 },
        (_, index) => candidate(index, `node-${index}`),
      ),
    ];
    for (const candidates of invalidSets) {
      expect(planMissionReconcileShadow({
        mode: 'shadow', receiptEvidence: verifiedReceipt(), current: current(candidates),
      })).toEqual({ disposition: 'skipped', reason: 'preview-invalid', suggestion: null });
    }

    expect(planMissionReconcileShadow({
      mode: 'shadow', receiptEvidence: verifiedReceipt(),
      current: current(undefined, { activeGoalThreshold: Number.POSITIVE_INFINITY }),
    })).toEqual({ disposition: 'skipped', reason: 'preview-invalid', suggestion: null });
  });

  it('strictly verifies the bounded all-false schema and detects any semantic tampering', () => {
    const plan = planMissionReconcileShadow({
      mode: 'shadow', receiptEvidence: verifiedReceipt(), current: current(),
    });
    if (!plan.suggestion) throw new Error('expected a suggestion');

    const authority = structuredClone(plan.suggestion) as Record<string, unknown>;
    authority['executionAuthority'] = true;
    expect(verifyMissionReconcileSuggestion(authority)).toBeNull();

    const unknown = { ...plan.suggestion, objective: 'hidden executable work' };
    expect(verifyMissionReconcileSuggestion(unknown)).toBeNull();

    const decision = structuredClone(plan.suggestion);
    decision.decision.nodeKey = 'different-node';
    expect(verifyMissionReconcileSuggestion(decision)).toBeNull();

    expect(JSON.stringify(plan.suggestion)).not.toContain('Implement the');
    expect(JSON.stringify(plan.suggestion)).not.toContain('/Users/');
  });

  it('has no runtime dependency on mutation-capable goal, proposal, agent, or release modules', () => {
    const source = readFileSync(fileURLToPath(new URL(
      '../src/core/vision/mission-reconcile-shadow.ts', import.meta.url,
    )), 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports).toEqual(['node:crypto', './mission-receipt.js']);
    expect(source).not.toMatch(/from\s+['"][^'"]*(?:goals|proposal|agent|merge|release|deploy)/);
  });
});
