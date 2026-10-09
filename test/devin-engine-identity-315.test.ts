/**
 * 3.15 — Devin has its OWN engine identity, end to end.
 *
 * Before: `engineOfSeatId('devin')` fell through to `claude`, so a Devin
 * producer seat in a grant also opened the claude-cli producer lane (and a
 * Devin seat could stand in for a Claude judge seat). Covered here:
 *  - routing: the seat → engine → lane mapping, the seat router and the
 *    capacity snapshot never treat a Devin seat as anything but Devin;
 *  - the grant: `devin` is a grant engine (not a dispatch lane), a Devin seat
 *    may produce or lead; judging requires independent-family evidence. Drafting
 *    names Devin only on opt-in; re-approval follows the opt-in (adds / strips);
 *  - effective policy + standingAuthorizesDevin;
 *  - the custody helper's `status.grantEngines` report (an older helper does
 *    not report it → Devin is never drafted for it);
 *  - G6's two-judge rule for Devin work, as a pure gate.
 */
import { describe, expect, it } from 'vitest';

import { computeEffectivePolicy, fleetEngineOfSeat, standingAuthorizesDevin } from '../src/core/authority/effective-config.js';
import { custodySignsDevin } from '../src/core/authority/custody-client.js';
import {
  buildDefaultGrantPayload,
  buildReapprovalGrantPayload,
  describeGrantScope,
  grantNamesDevin,
  parseStandingGrantPayload,
} from '../src/core/authority/standing-grant.js';
import type { EffectivePolicy, StandingGrantV1 } from '../src/core/authority/types.js';
import { laneOfSeat, planLanes, type LanePlanInput } from '../src/core/fleet/dispatch-router.js';
import { FLEET_ENGINES, GRANT_ENGINES, GRANT_LANE_ENGINES } from '../src/core/fleet/fleet-types.js';
import { allowedJudgeLanes, evaluateG6 } from '../src/core/fleet/merge-gates.js';
import { evaluateTwoJudgeRule, judgeLaneFamily, requiresTwoJudges } from '../src/core/fleet/reviewer-independence.js';
import { sanitizeSeatCapacity } from '../src/core/routing/budget-store.js';
import { BUDGET_ENGINES, DEVIN_SEAT_ID, defaultBudgetPolicy, effectiveSeatPolicy, engineOfSeatId, MODE_DEFAULTS } from '../src/core/routing/policy.js';
import { routeSeat } from '../src/core/routing/router.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { DecisionEntry } from '../src/core/types.js';
import { hashDiff, loadOrCreateKey, signJudgeAttestation } from '../src/core/foundry/provenance.js';
import { DEVIN_CUSTODY_REINSTALL_NOTE, devinDraftChoice } from '../src/core/verse/authority-api.js';
import { criteria, makeGrant, TEST_HOST, TEST_KEY_ID, TEST_SURFACE } from './helpers/authority-310b.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

describe('seat → engine → lane: Devin is Devin', () => {
  it('engineOfSeatId maps devin seats to `devin`, never the claude fallthrough', () => {
    expect(engineOfSeatId('devin')).toBe('devin');
    expect(engineOfSeatId('Devin-b')).toBe('devin');
    expect(engineOfSeatId('claude')).toBe('claude');
    expect(engineOfSeatId('mystery')).toBe('claude');
    expect(BUDGET_ENGINES).toContain('devin');
    expect(DEVIN_SEAT_ID).toBe('devin');
  });

  it('a Devin seat has no dispatch lane and its grant engine is `devin`', () => {
    expect(laneOfSeat({ engine: 'devin' })).toBeNull();
    expect(laneOfSeat({ engine: 'local' })).toBe('local');
    expect(fleetEngineOfSeat('devin')).toBe('devin');
    expect(fleetEngineOfSeat('claude-a')).toBe('claude-cli');
    expect(FLEET_ENGINES).not.toContain('devin');
    // 3.15 devin-cli: the local Devin CLI is a LANE, never a grant engine —
    // the grant vocabulary (and GrantContract.swift's mirror) is unchanged.
    expect(FLEET_ENGINES).toContain('devin-cli');
    expect(GRANT_ENGINES).toEqual(['local', 'grok-cli', 'claude-cli', 'codex', 'devin']);
    expect(GRANT_ENGINES).toEqual([...GRANT_LANE_ENGINES, 'devin']);
    expect(GRANT_ENGINES as readonly string[]).not.toContain('devin-cli');
  });

  it('budget modes: Devin may launch in all-in / balanced, never in reserve', () => {
    expect(MODE_DEFAULTS['all-in'].devin.enabled).toBe(true);
    expect(MODE_DEFAULTS.balanced.devin.enabled).toBe(true);
    expect(MODE_DEFAULTS.reserve.devin.enabled).toBe(false);
    expect(effectiveSeatPolicy({ ...defaultBudgetPolicy(), mode: 'reserve' }, 'devin').enabled).toBe(false);
  });

  it('the capacity snapshot refuses a Devin seat and the seat router never admits one', () => {
    const devinSeat = {
      seatId: 'devin', engine: 'devin', label: 'Devin', free: false, windows: [], signedOut: false, reachable: true,
      contextWindow: 200_000, observedAt: new Date(NOW).toISOString(), spentTodayUsd: 0,
    };
    expect(sanitizeSeatCapacity(devinSeat)).toBeNull();
    const decision = routeSeat({ task: 'code', difficulty: 'low', autonomous: true }, [devinSeat as unknown as SeatCapacity], { ...defaultBudgetPolicy(), mode: 'all-in' }, { nowMs: NOW });
    expect(decision.seatId).toBeNull();
    expect(decision.candidates).toEqual([]);
    expect(decision.exclusions[0]).toMatchObject({ seatId: 'devin' });
    expect(decision.exclusions[0]!.details[0]).toMatchObject({ kind: 'lane' });
  });
});

describe('dispatch lanes: a Devin producer seat opens NO other lane', () => {
  const lanesFor = (seats: EffectivePolicy['spend']['seats'], engines: EffectivePolicy['engines']) => planLanes({
    policy: { engines, spend: { maxMode: 'balanced', meteredUsdPerDay: 0, seats } },
    directives: null,
    presence: { present: false, reason: 'away', evidenceAt: null },
    localServingSlots: 4,
    engineUnavailable: {},
  } as LanePlanInput);

  const devin = { seatId: 'devin', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer'] as const };
  const claudeJudge = { seatId: 'claude-a', enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge', 'leader'] as const };

  it('claude-cli stays closed when only Devin (and a judge-only Claude seat) produce', () => {
    const plan = lanesFor({ devin: { ...devin, roles: [...devin.roles] }, 'claude-a': { ...claudeJudge, roles: [...claudeJudge.roles] } }, ['local', 'grok-cli', 'claude-cli', 'codex', 'devin']);
    expect(plan['claude-cli'].slots).toBe(0);
    expect(plan['claude-cli'].capReason).toMatch(/no producer role/);
    expect(plan.codex.slots).toBe(0);
    expect(plan['grok-cli'].slots).toBe(0);
  });

  it('control: a real Claude producer seat still opens claude-cli (while Mason is away)', () => {
    const plan = lanesFor({ 'claude-a': { ...claudeJudge, roles: ['producer', 'judge'] } }, ['local', 'grok-cli', 'claude-cli']);
    expect(plan['claude-cli'].slots).toBe(1);
  });
});

describe('the grant: Devin is an opt-in producer and Leader engine', () => {
  const draftInput = {
    nowMs: NOW,
    grantId: 'd'.repeat(32),
    grantSeq: 3,
    keyId: TEST_KEY_ID,
    hostBinding: TEST_HOST,
    authoritySurfaceDigest: TEST_SURFACE,
    repos: [{ nameWithOwner: 'ashlrai/fleet-canary', visibility: 'public' as const, hasVerify: true, serverEnforcement: 'enforced' as const }],
    seats: [
      { seatId: 'claude', engine: 'claude' as const },
      { seatId: 'grok', engine: 'grok' as const },
      // A stray Devin seat in the seat list never enters a draft by itself.
      { seatId: 'devin', engine: 'devin' as const },
    ],
  };

  it('without the opt-in there is no Devin anywhere in the draft (an old helper can sign it)', () => {
    const payload = buildDefaultGrantPayload(draftInput);
    expect(payload.engines).toEqual(['local', 'grok-cli', 'claude-cli', 'codex']);
    expect(payload.rollout.stages.every((s) => !s.engines.includes('devin'))).toBe(true);
    expect(payload.spend.seats['devin']).toBeUndefined();
    expect(grantNamesDevin(payload)).toBe(false);
  });

  it('with the opt-in: the engine in the grant and every rung, one producer and Leader seat', () => {
    const payload = buildDefaultGrantPayload({ ...draftInput, devin: true });
    expect(parseStandingGrantPayload(payload).ok).toBe(true);
    expect(payload.engines).toEqual(['local', 'grok-cli', 'claude-cli', 'codex', 'devin']);
    expect(payload.rollout.stages.every((s) => s.engines.at(-1) === 'devin')).toBe(true);
    expect(payload.spend.seats['devin']).toEqual({ enabled: true, reserveFloorPercent: 0, roles: ['producer', 'leader'] });
    // Claude independently receives its current roles; adding Devin does not alias its seat.
    expect(payload.spend.seats['claude']!.roles).toEqual(['producer', 'judge', 'leader']);
    const lines = describeGrantScope(payload);
    expect(lines.some((l) => l.includes('seat devin: on, Devin sessions (producer/leader only, never a judge)'))).toBe(true);
  });

  it('the verifier admits Devin planning roles but refuses unqualified judging and an unknown engine', () => {
    const base = buildDefaultGrantPayload({ ...draftInput, devin: true });
    for (const roles of [['producer', 'judge'], ['judge'], ['leader', 'judge']] as const) {
      const bad = structuredClone(base);
      bad.spend.seats['devin'] = { enabled: true, reserveFloorPercent: 0, roles: [...roles] };
      const parsed = parseStandingGrantPayload(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/Devin judge requires independent model-family evidence/);
    }
    for (const roles of [['producer'], ['leader'], ['producer', 'leader']] as const) {
      const planning = structuredClone(base);
      planning.spend.seats['devin'] = { enabled: true, reserveFloorPercent: 0, roles: [...roles] };
      expect(parseStandingGrantPayload(planning).ok).toBe(true);
    }
    const renamed = structuredClone(base);
    renamed.spend.seats['devin-b'] = { enabled: true, reserveFloorPercent: 0, roles: ['judge'] };
    expect(parseStandingGrantPayload(renamed).ok).toBe(false);
    const stranger = structuredClone(base) as unknown as { engines: string[] };
    stranger.engines = [...stranger.engines, 'devin-cloud'];
    expect(parseStandingGrantPayload(stranger).ok).toBe(false);
  });

  it('a re-approval follows the opt-in: strips Devin when off, adds it when on, keeps it when unspecified', () => {
    const withDevin = buildDefaultGrantPayload({ ...draftInput, devin: true });
    const next = { ...draftInput, nowMs: NOW + 1000, grantId: 'e'.repeat(32), grantSeq: 4 };
    const stripped = buildReapprovalGrantPayload(withDevin, 1, { ...next, devin: false });
    expect(grantNamesDevin(stripped)).toBe(false);
    expect(stripped.rollout.stages.every((s) => !s.engines.includes('devin'))).toBe(true);
    const kept = buildReapprovalGrantPayload(withDevin, 1, next);
    expect(grantNamesDevin(kept)).toBe(true);
    const without = buildDefaultGrantPayload(draftInput);
    const added = buildReapprovalGrantPayload(without, 0, { ...next, devin: true });
    expect(added.engines).toContain('devin');
    expect(added.spend.seats['devin']).toEqual({ enabled: true, reserveFloorPercent: 0, roles: ['producer', 'leader'] });
    expect(parseStandingGrantPayload(added).ok).toBe(true);
  });
});

describe('effective policy: Devin authorized only by its own engine + producer seat', () => {
  const grantWith = (stageEngines: StandingGrantV1['engines'], seat: StandingGrantV1['spend']['seats'][string] | null): StandingGrantV1 => {
    const g = makeGrant({}, NOW);
    g.engines = [...g.engines, 'devin'];
    g.rollout.stages = [{
      id: 'only', repos: [{ nameWithOwner: 'ashlrai/fleet-canary', stage: 'merge' }], engines: stageEngines, maxRisk: 'low',
      maxFiles: 4, maxLines: 150, maxMergesPerRepoPerDay: 6, leaderClasses: [], criteria: criteria(1),
    }];
    if (seat) g.spend.seats['devin'] = seat;
    return g;
  };
  const policyOf = (grant: StandingGrantV1, config: Record<string, unknown> | null = null) => computeEffectivePolicy({
    grant, position: { stageIndex: 0, stageId: 'only', enteredAt: new Date(NOW).toISOString() }, switch: 'autonomous', config: config as never, nowMs: NOW,
  });

  it('stage + seat name Devin → authorized; the Claude lane is unaffected', () => {
    const policy = policyOf(grantWith(['local', 'devin'], { enabled: true, reserveFloorPercent: 0, roles: ['producer'] }));
    expect(policy.engines).toEqual(['local', 'devin']);
    expect(policy.spend.seats['devin']!.enabled).toBe(true);
    expect(standingAuthorizesDevin(policy)).toMatchObject({ ok: true });
    expect(policy.engines).not.toContain('claude-cli');
  });

  it('refused: the stage lacks Devin, the seat is missing or off, or foundry.localOnly is set', () => {
    expect(standingAuthorizesDevin(policyOf(grantWith(['local'], { enabled: true, reserveFloorPercent: 0, roles: ['producer'] }))))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/stage does not include Devin/) });
    expect(standingAuthorizesDevin(policyOf(grantWith(['local', 'devin'], null)))).toMatchObject({ ok: false });
    expect(standingAuthorizesDevin(policyOf(grantWith(['local', 'devin'], { enabled: false, reserveFloorPercent: 0, roles: ['producer'] }))))
      .toMatchObject({ ok: false });
    const localOnly = policyOf(grantWith(['local', 'devin'], { enabled: true, reserveFloorPercent: 0, roles: ['producer'] }), { foundry: { localOnly: true } });
    expect(localOnly.engines).toEqual(['local']);
    expect(standingAuthorizesDevin(localOnly).ok).toBe(false);
    expect(standingAuthorizesDevin(null).ok).toBe(false);
  });
});

describe('custody helper support is reported, never assumed', () => {
  it('only a helper that lists `devin` in status.grantEngines signs Devin grants', () => {
    expect(custodySignsDevin({ grantEngines: ['local', 'grok-cli', 'claude-cli', 'codex', 'devin'] })).toBe(true);
    expect(custodySignsDevin({ grantEngines: ['local', 'grok-cli', 'claude-cli', 'codex'] })).toBe(false);
    expect(custodySignsDevin({ grantEngines: null })).toBe(false);
    expect(custodySignsDevin({})).toBe(false);
    expect(custodySignsDevin(null)).toBe(false);
  });
});

describe('drafting Devin: opt-in + key + a helper that signs it', () => {
  const NEW_HELPER = ['local', 'grok-cli', 'claude-cli', 'codex', 'devin'] as const;
  const OLD_HELPER = ['local', 'grok-cli', 'claude-cli', 'codex'] as const;
  const choice = (over: Partial<Parameters<typeof devinDraftChoice>[0]> = {}) => devinDraftChoice({
    config: () => ({ enabled: true, fleet: true }),
    connected: () => true,
    hasKey: async () => true,
    custody: async () => ({ grantEngines: [...NEW_HELPER] }),
    ...over,
  });

  it('includes Devin only when everything holds', async () => {
    expect(await choice()).toEqual({ include: true, note: null });
  });

  it('no opt-in → silently out; no key → out with a sentence', async () => {
    expect(await choice({ config: () => ({ enabled: true, fleet: false }) })).toEqual({ include: false, note: null });
    expect(await choice({ config: () => ({ enabled: false, fleet: true }) })).toEqual({ include: false, note: null });
    expect(await choice({ connected: () => false })).toMatchObject({ include: false, note: expect.stringMatching(/no Devin key/) });
    expect(await choice({ hasKey: async () => false })).toMatchObject({ include: false });
  });

  it('an older custody helper (no or partial grantEngines) → out, with the reinstall step', async () => {
    expect(await choice({ custody: async () => ({ grantEngines: null }) })).toEqual({ include: false, note: DEVIN_CUSTODY_REINSTALL_NOTE });
    expect(await choice({ custody: async () => ({ grantEngines: [...OLD_HELPER] }) })).toEqual({ include: false, note: DEVIN_CUSTODY_REINSTALL_NOTE });
    expect(DEVIN_CUSTODY_REINSTALL_NOTE).toContain('sudo scripts/install-custody.sh');
  });

  it('anything throwing leaves Devin out (the narrower grant)', async () => {
    expect(await choice({ custody: async () => { throw new Error('helper missing'); } })).toEqual({ include: false, note: null });
  });
});

describe('G6 two-judge rule (pure)', () => {
  const DIFF = 'diff --git a/x b/x\n+1\n';
  const PROPOSAL = 'p-devin-2j';
  const at = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();
  function judged(judge: string, verdict: 'ship' | 'review', ts: string): DecisionEntry {
    loadOrCreateKey();
    const attestation = verdict === 'ship'
      ? signJudgeAttestation({ proposalId: PROPOSAL, judgeEngine: judge, verdict: 'ship', diffHash: hashDiff(DIFF), issuedAt: ts, mergeIntent: 'would-merge' })
      : undefined;
    return {
      ts, proposalId: PROPOSAL, action: 'judged', engine: judge, model: judge, verdict, detail: verdict === 'ship' ? 'would-merge' : '',
      ...(attestation ? { judgeAttestation: attestation, judgeAttestationIssuedAt: ts, judgeAttestationIntent: 'would-merge' as const } : {}),
    } as DecisionEntry;
  }
  const g6 = (decisions: DecisionEntry[], producerModel = 'devin:normal') =>
    evaluateG6({ proposalId: PROPOSAL, producerModel, diff: DIFF, decisions, nowMs: NOW + 60 * 60_000 });

  it('Devin needs two; every other producer still passes on one eligible judge', () => {
    expect(requiresTwoJudges('devin')).toBe(true);
    expect(requiresTwoJudges('local')).toBe(false);
    const one = [judged('grok-cli:grok-4.7', 'ship', at(1))];
    expect(g6(one)).toMatchObject({ verdict: 'wait', code: 'second-judge-needed', needsJudge: true, judgedFamilies: ['xai'] });
    expect(g6(one, 'local-coder:qwen3.8-coder')).toMatchObject({ verdict: 'pass', code: 'judge-ship' });
  });

  it('two ships from different families pass, naming both judges', () => {
    const e = g6([judged('grok-cli:grok-4.7', 'ship', at(1)), judged('gpt-5.5', 'ship', at(2))]);
    expect(e).toMatchObject({ verdict: 'pass', code: 'two-judge-ship', judgeId: 'gpt-5.5', judgeIds: ['gpt-5.5', 'grok-cli:grok-4.7'] });
    expect(new Set(e.judgedFamilies)).toEqual(new Set(['xai', 'openai']));
  });

  it('the same family twice is still one judge; Devin / local / bare-Grok judges never count', () => {
    expect(g6([judged('claude-opus-4-8', 'ship', at(1)), judged('claude-sonnet-5', 'ship', at(2))]).code).toBe('second-judge-needed');
    expect(g6([judged('gpt-5.5', 'ship', at(1)), judged('devin:normal', 'ship', at(2))]).code).toBe('second-judge-needed');
    expect(g6([judged('gpt-5.5', 'ship', at(1)), judged('qwen2.5:72b', 'ship', at(2))]).code).toBe('second-judge-needed');
    expect(g6([judged('gpt-5.5', 'ship', at(1)), judged('grok-4.7', 'ship', at(2))]).code).toBe('second-judge-needed');
  });

  it('one eligible rejection refuses, even when two other families shipped', () => {
    const e = g6([judged('grok-cli:grok-4.7', 'ship', at(1)), judged('gpt-5.5', 'ship', at(2)), judged('claude-opus-4-8', 'review', at(3))]);
    expect(e).toMatchObject({ verdict: 'refuse', code: 'judge-rejected' });
    // A family's NEWER ship overrides its own older rejection (same rule as one judge).
    const recovered = g6([judged('gpt-5.5', 'review', at(1)), judged('gpt-5.5', 'ship', at(2)), judged('grok-cli:grok-4.7', 'ship', at(3))]);
    expect(recovered).toMatchObject({ verdict: 'pass', code: 'two-judge-ship' });
  });

  it('a stale first ship no longer counts (each ship must be fresh and attested)', () => {
    const e = evaluateG6({
      proposalId: PROPOSAL, producerModel: 'devin:normal', diff: DIFF,
      decisions: [judged('grok-cli:grok-4.7', 'ship', at(0)), judged('gpt-5.5', 'ship', at(25 * 60))],
      nowMs: NOW + 25 * 60 * 60_000 + 60_000,
    });
    expect(e).toMatchObject({ verdict: 'wait', code: 'second-judge-needed', judgedFamilies: ['openai'] });
    const tampered = g6([judged('grok-cli:grok-4.7', 'ship', at(1)), { ...judged('gpt-5.5', 'ship', at(2)), proposalId: PROPOSAL, judgeAttestation: 'x' } as DecisionEntry]);
    expect(tampered.code).toBe('second-judge-needed');
  });

  it('the second judge is asked only on lanes of OTHER families, all at once', () => {
    expect(allowedJudgeLanes('devin', null, NOW)).toEqual(['grok-cli']);
    expect(allowedJudgeLanes('devin', null, NOW, ['xai'])).toEqual(['codex', 'claude-cli']);
    expect(allowedJudgeLanes('devin', null, NOW, ['xai', 'openai'])).toEqual(['claude-cli']);
    expect(allowedJudgeLanes('devin', null, NOW, ['xai', 'openai', 'claude'])).toEqual([]);
    expect(judgeLaneFamily('codex')).toBe('openai');
  });

  it('evaluateTwoJudgeRule is the merge-time re-check', () => {
    expect(evaluateTwoJudgeRule('devin:normal', ['grok-cli:grok-4.7', 'claude-opus-4-8'])).toMatchObject({ satisfied: true, families: ['xai', 'claude'] });
    expect(evaluateTwoJudgeRule('devin:normal', ['grok-cli:grok-4.7'])).toMatchObject({ satisfied: false });
    expect(evaluateTwoJudgeRule('devin:normal', null)).toMatchObject({ satisfied: false, families: [] });
  });
});
