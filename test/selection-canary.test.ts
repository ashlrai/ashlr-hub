import { describe, expect, it } from 'vitest';
import {
  resolveSelectionCanary,
  canonicalSelectionCanaryCandidate,
  drawEligibleBinaryCanaryRoute,
  selectEligibleBinaryCanaryPair,
  type SelectionCanaryCandidate,
} from '../src/core/fabric/selection-canary.js';

const ready = { gateway: true, concurrentDispatch: true };

function candidate(backend: 'codex' | 'claude' | 'builtin' = 'codex', overrides: Partial<SelectionCanaryCandidate> = {}): SelectionCanaryCandidate {
  return {
    route: { backend, tier: 'frontier', model: backend === 'codex' ? 'gpt-5.6' : 'opus', disposition: 'gateway-exact' },
    candidateAllowed: true,
    slotsAtPlan: 2,
    remainingBefore: 1,
    ...overrides,
  };
}

describe('selection canary config resolver', () => {
  it('is inert by default and rejects malformed or broadened config', () => {
    expect(resolveSelectionCanary(undefined, ready)).toMatchObject({
      requested: false, eligible: false, disabledReason: 'not-requested',
    });
    for (const raw of [null, [], { enabled: 'true' }, { enabled: true, probability: 1 }]) {
      expect(resolveSelectionCanary(raw, ready)).toMatchObject({ eligible: false, disabledReason: 'invalid-config' });
    }
  });

  it('accepts only the fixed binary-uniform protocol and enabled prerequisites', () => {
    expect(resolveSelectionCanary({ enabled: true, protocol: 'other-v1' }, ready)).toMatchObject({
      requested: true, eligible: false, disabledReason: 'unsupported-protocol',
    });
    expect(resolveSelectionCanary({ enabled: true }, { gateway: false, concurrentDispatch: true })).toMatchObject({
      eligible: false, disabledReason: 'gateway-disabled',
    });
    expect(resolveSelectionCanary({ enabled: true }, { gateway: true, concurrentDispatch: false })).toMatchObject({
      eligible: false, disabledReason: 'concurrent-dispatch-disabled',
    });
    expect(resolveSelectionCanary({ enabled: true }, ready)).toEqual({
      requested: true,
      protocol: 'binary-uniform-v1',
      eligible: true,
      disabledReason: null,
    });
  });
});

describe('binary canary pair eligibility', () => {
  it('returns a deterministic in-order pair only for two exact ordinary routes with fresh capacity', () => {
    const first = candidate('codex');
    const second = candidate('claude');
    const result = selectEligibleBinaryCanaryPair({
      candidates: [first, second], context: 'ordinary-direct', snapshotState: 'fresh',
    });
    expect(result).toEqual({ protocol: 'binary-uniform-v1', candidates: [first, second] });
    expect(first.remainingBefore).toBe(1);
    expect(second.remainingBefore).toBe(1);
  });

  it('draws only from an already eligible pair at the fixed 50/50 probability', () => {
    const first = candidate('codex');
    const second = candidate('claude');
    const pair = selectEligibleBinaryCanaryPair({
      candidates: [first, second], context: 'ordinary-direct', snapshotState: 'fresh',
    });
    if (!pair) throw new Error('fixture pair was not eligible');
    const draws = Array.from({ length: 32 }, () => drawEligibleBinaryCanaryRoute(pair));
    for (const draw of draws) {
      expect(draw).toMatchObject({
        protocol: 'binary-uniform-v1', selectionProbabilityPpm: 500_000,
      });
      expect([first, second]).toContain(draw.selected);
      expect([0, 1]).toContain(draw.selectedIndex);
      expect(draw.selected).toBe(pair.candidates[draw.selectedIndex]);
    }
  });

  it('fails closed for non-ordinary context, stale capacity, invalid pairs, and non-final routes', () => {
    const valid = [candidate('codex'), candidate('claude')] as const;
    for (const context of [
      'best-of-n', 'generated-repair', 'diagnostic-reslice', 'retry', 'quota-fallback',
      'resource-fallback', 'budget-pause', 'local-only', 'executor-substitution',
    ] as const) {
      expect(selectEligibleBinaryCanaryPair({ candidates: valid, context, snapshotState: 'fresh' })).toBeNull();
    }
    expect(selectEligibleBinaryCanaryPair({ candidates: valid, context: 'ordinary-direct', snapshotState: 'stale' })).toBeNull();
    expect(selectEligibleBinaryCanaryPair({ candidates: [candidate('codex')], context: 'ordinary-direct', snapshotState: 'fresh' })).toBeNull();
    expect(selectEligibleBinaryCanaryPair({ candidates: [candidate('codex'), candidate('codex')], context: 'ordinary-direct', snapshotState: 'fresh' })).toBeNull();
    expect(selectEligibleBinaryCanaryPair({ candidates: [candidate('codex'), candidate('builtin')], context: 'ordinary-direct', snapshotState: 'fresh' })).toBeNull();
    expect(selectEligibleBinaryCanaryPair({
      candidates: [candidate('codex'), candidate('claude', { route: { backend: 'claude', tier: 'mid', model: 'opus', disposition: 'gateway-exact' } })],
      context: 'ordinary-direct', snapshotState: 'fresh',
    })).toBeNull();
    expect(selectEligibleBinaryCanaryPair({
      candidates: [candidate('codex', { remainingBefore: 0 }), candidate('claude')],
      context: 'ordinary-direct', snapshotState: 'fresh',
    })).toBeNull();
    expect(selectEligibleBinaryCanaryPair({
      candidates: [candidate('codex', { route: { backend: 'codex', tier: 'frontier', model: null, disposition: 'planner-reassigned' } }), candidate('claude')],
      context: 'ordinary-direct', snapshotState: 'fresh',
    })).toBeNull();
  });
});

describe('canonical selection candidate', () => {
  it('binds only an ordinary gateway decision to its unchanged final route', () => {
    const route = candidate('codex').route;
    expect(canonicalSelectionCanaryCandidate({
      gatewayDecision: {
        backend: 'codex', tier: 'frontier', model: 'gpt-5.6', source: 'fleet', reason: 'base',
        trace: [{ stage: 'routeBackend', backend: 'codex', tier: 'frontier', reason: 'base' }],
      },
      finalRoute: route,
      candidateAllowed: true,
      slotsAtPlan: 2,
      remainingBefore: 2,
    })).toEqual(candidate('codex', { remainingBefore: 2 }));
  });

  it('refuses trace overrides, route changes, and model inheritance', () => {
    const decision = {
      backend: 'codex' as const, tier: 'frontier' as const, model: 'gpt-5.6', source: 'fleet' as const, reason: 'base',
      trace: [{ stage: 'routeBackend', backend: 'codex' as const, tier: 'frontier' as const, reason: 'base' }],
    };
    expect(canonicalSelectionCanaryCandidate({
      gatewayDecision: decision,
      finalRoute: { backend: 'nim', tier: 'frontier', model: null, disposition: 'planner-reassigned' },
      candidateAllowed: true, slotsAtPlan: 2, remainingBefore: 2,
    })).toBeNull();
    expect(canonicalSelectionCanaryCandidate({
      gatewayDecision: { ...decision, trace: [...decision.trace, { stage: 'resourceDemote', backend: 'nim', tier: 'frontier', reason: 'demoted' }] },
      finalRoute: candidate('codex').route,
      candidateAllowed: true, slotsAtPlan: 2, remainingBefore: 2,
    })).toBeNull();
  });
});
