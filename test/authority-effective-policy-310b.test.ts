/**
 * V3.10 Track B unit B-U1 — the effective policy (pure).
 *
 * Invariant I3: effective policy = min(grant, current rollout stage, switch,
 * config, compiled ceilings); config and the Leader can only TIGHTEN it. The
 * standing overlay forces the safety flags on, and the budget clamp can only
 * tighten A9's policy.
 */
import { describe, expect, it } from 'vitest';

import {
  applyStandingOverlay,
  clampBudgetPolicy,
  computeEffectivePolicy,
  configConstraints,
  grantSwitchCap,
  standingSeatCapacity,
  standingSeatFor,
} from '../src/core/authority/effective-config.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { EffectivePolicy, StandingGrantV1 } from '../src/core/authority/types.js';
import { editGrant, makeGrant } from './helpers/authority-310b.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const grant = makeGrant({}, NOW);

function policy(opts: { stage?: number; switch?: 'propose' | 'autonomous'; config?: unknown; g?: StandingGrantV1 } = {}): EffectivePolicy {
  const g = opts.g ?? grant;
  const stageIndex = opts.stage ?? 2;
  return computeEffectivePolicy({
    grant: g,
    position: { stageIndex, stageId: g.rollout.stages[stageIndex]!.id, enteredAt: '2026-09-24T00:00:00.000Z' },
    switch: opts.switch ?? 'autonomous',
    config: (opts.config ?? null) as AshlrConfig | null,
    nowMs: NOW,
  });
}

const repo = (p: EffectivePolicy, name: string) => p.repos.find((r) => r.nameWithOwner === name)!;

describe('computeEffectivePolicy — min of everything', () => {
  it('uses only the current stage’s repos, capped by the stage', () => {
    const shadow = policy({ stage: 0 });
    expect(shadow.repos.map((r) => r.nameWithOwner)).toEqual(['ashlrai/fleet-canary', 'ashlrai/ashlrcode']);
    expect(shadow.repos.every((r) => r.stage === 'propose')).toBe(true);
    expect(shadow.rollout).toEqual({ stageId: 'shadow', stageIndex: 0, stageCount: 3, enteredAt: '2026-09-24T00:00:00.000Z' });
    const twoA = policy({ stage: 1 });
    expect(repo(twoA, 'ashlrai/ashlrcode')).toMatchObject({ stage: 'merge', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6 });
    expect(twoA.engines).toEqual(['local', 'grok-cli', 'claude-cli']);
    expect(twoA.leader.classes).toEqual(['A']);
  });

  it('applies the local-enforcement ceilings and the grant repo caps', () => {
    const full = policy();
    expect(repo(full, 'ashlrai/measurably')).toMatchObject({ enforcement: 'local', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 4 });
    expect(repo(full, 'ashlrai/fleet-canary')).toMatchObject({ maxRisk: 'medium', maxFiles: 10, maxLines: 300, maxMergesPerDay: 6 });
    expect(full.merge.localAuthored).toEqual({ maxRisk: 'low', maxFiles: 4, maxLines: 150 });
  });

  it('the propose switch lowers every repo to propose and silences the Leader', () => {
    const proposing = policy({ switch: 'propose' });
    expect(proposing.switch).toBe('propose');
    expect(proposing.repos.every((r) => r.stage === 'propose')).toBe(true);
    expect(proposing.leader.classes).toEqual([]);
  });

  it('ashlr-hub follows merge.selfRepo', () => {
    expect(repo(policy(), 'ashlrai/ashlr-hub')).toMatchObject({ stage: 'merge', selfRepo: 'merge-non-authority' });
    const proposeOnly = editGrant(grant, (g) => { g.merge.selfRepo = 'propose-only'; });
    expect(repo(policy({ g: proposeOnly }), 'ashlrai/ashlr-hub')).toMatchObject({ stage: 'propose', selfRepo: 'propose-only' });
    expect(repo(policy(), 'ashlrai/ashlrcode').selfRepo).toBeNull();
  });

  it('config can only tighten', () => {
    const tight = policy({
      config: {
        foundry: {
          autoMerge: { enabled: true, maxRisk: 'low', maxAutomergeFiles: 3, maxAutomergeLines: 90, allowSelfMerge: false },
          localOnly: true,
        },
      },
    });
    expect(repo(tight, 'ashlrai/fleet-canary')).toMatchObject({ maxRisk: 'low', maxFiles: 3, maxLines: 90 });
    expect(repo(tight, 'ashlrai/ashlr-hub').stage).toBe('propose');
    expect(tight.engines).toEqual(['local']);
    expect(tight.spend.seats['claude']!.enabled).toBe(false);
    expect(tight.spend.seats['local']!.enabled).toBe(true);

    const loose = policy({ config: { foundry: { autoMerge: { enabled: true, maxRisk: 'high', maxAutomergeFiles: 40, maxAutomergeLines: 3000, allowSelfMerge: true } } } });
    expect(repo(loose, 'ashlrai/fleet-canary')).toMatchObject({ maxRisk: 'medium', maxFiles: 10, maxLines: 300 });
    expect(loose).toEqual(policy());

    const disabled = policy({ config: { foundry: { autoMerge: { enabled: false } } } });
    expect(disabled.repos.every((r) => r.stage === 'propose')).toBe(true);
  });

  it('a mangled config value is no constraint — never a loosening', () => {
    expect(configConstraints({ foundry: { autoMerge: { maxAutomergeFiles: -1, maxAutomergeLines: 'x', maxRisk: 7 } } } as unknown as AshlrConfig))
      .toMatchObject({ maxFiles: undefined, maxLines: undefined, maxRisk: undefined, mergeDisabled: false });
  });

  it('seats whose engine is not in the stage are disabled; the policy never names a seat the grant does not', () => {
    const shadow = policy({ stage: 0 });
    expect(Object.keys(shadow.spend.seats).sort()).toEqual(['claude', 'grok', 'local']);
    expect(shadow.spend.seats['claude']).toMatchObject({ enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70 });
    expect(shadow.spend.seats['grok']!.maxSessionWindowPercent).toBeNull();
    const noClaude = editGrant(grant, (g) => { g.rollout.stages[0]!.engines = ['local', 'grok-cli']; });
    expect(policy({ g: noClaude, stage: 0 }).spend.seats['claude']!.enabled).toBe(false);
  });

  it('the switch cap is autonomous only when some rung merges', () => {
    expect(grantSwitchCap(grant)).toBe('autonomous');
    const proposeOnly = editGrant(grant, (g) => {
      for (const stage of g.rollout.stages) for (const r of stage.repos) r.stage = 'propose';
    });
    expect(grantSwitchCap(proposeOnly)).toBe('propose');
  });

  it('refuses a position that does not match the grant', () => {
    expect(() => computeEffectivePolicy({ grant, position: { stageIndex: 1, stageId: 'shadow', enteredAt: 'x' }, switch: 'autonomous', config: null, nowMs: NOW }))
      .toThrow();
  });
});

describe('applyStandingOverlay', () => {
  const base = {
    foundry: {
      autoMerge: { enabled: true, maxRisk: 'medium', maxAutomergeFiles: 40, maxAutomergeLines: 3000, managerGate: true, pushToRemote: false, trustBasis: 'evidence', allowWithoutVerification: true, midToBranch: true },
      confinement: { claude: { mode: 'off', readAllowed: ['/etc'], networkEgress: false } },
    },
  } as unknown as AshlrConfig;

  it('forces the safety flags, remote-only merges and OS confinement, and clamps the caps', () => {
    const out = applyStandingOverlay(base, policy());
    const foundry = out.foundry as Record<string, unknown>;
    expect(foundry['claimIntegrity']).toBe(true);
    expect(foundry['selfImprove']).toBe(true);
    expect(foundry['counterfactual']).toBe(true);
    expect(out.foundry?.autoMerge).toMatchObject({
      enabled: true,
      maxRisk: 'medium',
      maxAutomergeFiles: 10,
      maxAutomergeLines: 300,
      pushToRemote: true,
      allowWithoutVerification: false,
      midToBranch: false,
      trustBasis: 'verification',
      managerGate: true,
      allowSelfMerge: true,
    });
    expect(out.foundry?.confinement?.['*']).toEqual({ mode: 'os', onUnsupported: 'fail', networkEgress: true });
    expect(out.foundry?.confinement?.claude).toEqual({ mode: 'os', onUnsupported: 'fail', networkEgress: false });
    // Pure: the input is untouched.
    expect((base.foundry as Record<string, unknown>)['claimIntegrity']).toBeUndefined();
  });

  it('keeps tighter config and disables merging when nothing may merge', () => {
    const tighter = { foundry: { autoMerge: { enabled: true, maxRisk: 'low', maxAutomergeFiles: 2, trustBasis: 'tier', allowSelfMerge: false } } } as unknown as AshlrConfig;
    const out = applyStandingOverlay(tighter, policy());
    expect(out.foundry?.autoMerge).toMatchObject({ maxRisk: 'low', maxAutomergeFiles: 2, trustBasis: 'tier', allowSelfMerge: false });
    expect(applyStandingOverlay(base, policy({ stage: 0 })).foundry?.autoMerge?.enabled).toBe(false);
    expect(applyStandingOverlay(base, policy({ switch: 'propose' })).foundry?.autoMerge?.enabled).toBe(false);
  });
});

describe('clampBudgetPolicy — only tightens', () => {
  const standing = policy();
  const allIn: BudgetPolicy = {
    mode: 'all-in',
    seats: {
      claude: { seatId: 'claude', enabled: true, reservePercent: 10 },
      'codex-work': { seatId: 'codex-work', enabled: true, reservePercent: 0 },
      grok: { seatId: 'grok', enabled: true, reservePercent: 5, maxSessionWindowPercent: 90, dailyUsdCap: 40 },
    },
    updatedAt: '2026-09-20T00:00:00.000Z',
  };

  it('caps the mode, disables seats the grant does not name, and raises reserves to the floor', () => {
    const out = clampBudgetPolicy(allIn, standing, ['local:qwen', 'claude-other']);
    expect(out.mode).toBe('balanced');
    expect(out.seats['claude']).toMatchObject({ enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 });
    expect(out.seats['codex-work']!.enabled).toBe(false);
    expect(out.seats['claude-other']!.enabled).toBe(false);
    expect(out.seats['local:qwen']).toMatchObject({ enabled: true, reservePercent: 0 });
    expect(out.seats['grok']).toMatchObject({ enabled: true, reservePercent: 5, maxSessionWindowPercent: 90, dailyUsdCap: 0 });
    expect(out.updatedAt).toBe(allIn.updatedAt);
  });

  it('never loosens any field (randomized)', () => {
    const modes = ['reserve', 'balanced', 'all-in'] as const;
    const rank = { reserve: 0, balanced: 1, 'all-in': 2 } as const;
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 200; i += 1) {
      const ids = ['claude', 'grok', 'local', 'local:x', 'codex', 'mystery'];
      const seats: BudgetPolicy['seats'] = {};
      for (const id of ids) {
        if (rand(2) === 0) continue;
        seats[id] = { seatId: id, enabled: rand(2) === 0, reservePercent: rand(101), ...(rand(2) ? { maxSessionWindowPercent: 1 + rand(100) } : {}), ...(rand(2) ? { dailyUsdCap: rand(50) } : {}) };
      }
      const input: BudgetPolicy = { mode: modes[rand(3)]!, seats, updatedAt: '2026-09-01T00:00:00.000Z' };
      const out = clampBudgetPolicy(input, standing, ids);
      expect(rank[out.mode]).toBeLessThanOrEqual(rank[input.mode]);
      for (const [id, before] of Object.entries(input.seats)) {
        const after = out.seats[id]!;
        if (!before.enabled) expect(after.enabled).toBe(false);
        expect(after.reservePercent).toBeGreaterThanOrEqual(before.reservePercent);
        if (before.maxSessionWindowPercent !== undefined) expect(after.maxSessionWindowPercent).toBeLessThanOrEqual(before.maxSessionWindowPercent);
        if (before.dailyUsdCap !== undefined) expect(after.dailyUsdCap).toBeLessThanOrEqual(before.dailyUsdCap);
      }
    }
  });

  it('the local wildcard covers local-runtime seats only; capacity can be filtered to usable seats', () => {
    expect(standingSeatFor(standing.spend, 'local:llama')).toBe(standing.spend.seats['local']);
    expect(standingSeatFor(standing.spend, 'claude-2')).toBeNull();
    const capacity = [{ seatId: 'claude' }, { seatId: 'local:llama' }, { seatId: 'codex' }, { seatId: 'grok' }];
    expect(standingSeatCapacity(capacity, standing).map((s) => s.seatId)).toEqual(['claude', 'local:llama', 'grok']);
  });
});
