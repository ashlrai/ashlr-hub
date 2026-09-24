/**
 * V3.10 unit A9 — budget policy, live headroom and the pure seat router.
 *
 * Pure modules only (no I/O): src/core/routing/{policy,headroom,router}.ts.
 * Fixtures mirror the live machine on 2026-09-24: Claude five_hour 15% with
 * seven_day_fable spent, both Codex accounts at 100% with resets days out,
 * Grok on a weekly billing window, local Qwen via Ollama.
 */
import { describe, it, expect } from 'vitest';
import {
  applyBudgetUpdate,
  applyModeSwitch,
  BudgetPolicyError,
  defaultBudgetPolicy,
  defaultSeatPolicy,
  effectiveSeatPolicy,
  engineOfSeatId,
  MODE_DEFAULTS,
  parseBudgetUpdate,
  sanitizeBudgetPolicy,
} from '../src/core/routing/policy.js';
import {
  assessSeat,
  capacityFromSeat,
  classifyWindow,
  computeHeadroom,
  HEADROOM_READING_MAX_AGE_MS,
  type CapacityWindow,
  type SeatCapacity,
} from '../src/core/routing/headroom.js';
import { enginePreference, rankAlternatives, routeSeat } from '../src/core/routing/router.js';
import type { BudgetPolicy, RoutingRequest } from '../src/core/routing/types.js';
import type { VerseSeat } from '../src/core/verse/types.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const H = 3_600_000;

function win(id: string, usedPercent: number | null, extra: Partial<CapacityWindow> = {}): CapacityWindow {
  return { id, usedPercent, resetsAt: null, resetDescription: null, limitReached: false, ...extra };
}

function seat(seatId: string, engine: SeatCapacity['engine'], windows: CapacityWindow[], extra: Partial<SeatCapacity> = {}): SeatCapacity {
  return {
    seatId,
    engine,
    label: seatId,
    free: engine === 'local',
    windows,
    signedOut: false,
    reachable: engine === 'local' ? true : null,
    contextWindow: engine === 'local' ? 65_536 : 200_000,
    observedAt: engine === 'local' ? null : iso(-60_000),
    spentTodayUsd: null,
    ...extra,
  };
}

const claude = (session: number | null, weekly: number | null, extra: Partial<SeatCapacity> = {}): SeatCapacity => seat('claude', 'claude', [
  win('five_hour', session, { resetDescription: '7pm (America/New_York)' }),
  win('seven_day', weekly, { resetDescription: 'Sep 25 at 7pm (America/New_York)' }),
  win('seven_day_fable', 100, { resetDescription: 'Sep 25 at 7pm (America/New_York)' }),
], extra);
const codexSpent = (id: string, resetH: number): SeatCapacity =>
  seat(id, 'codex', [win('codex_codex_primary', 100, { resetsAt: iso(resetH * H) })]);
const grok = (used: number | null): SeatCapacity =>
  seat('grok', 'grok', [win('grok_unified_weekly', used, { resetsAt: iso(3 * 24 * H) })]);
const local = (tag = 'qwen3.8:27b-ctx64k'): SeatCapacity => seat(`local:${tag}`, 'local', []);

const balanced = (): BudgetPolicy => defaultBudgetPolicy();
const opts = { nowMs: NOW };
const auto = (task: RoutingRequest['task'], difficulty: RoutingRequest['difficulty'], extra: Partial<RoutingRequest> = {}): RoutingRequest =>
  ({ task, difficulty, autonomous: true, ...extra });

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe('budget policy defaults (Mason, 2026-09-24)', () => {
  it('defaults to balanced with Claude 40% weekly reserve + 70% 5-hour ceiling, Grok 0%, local unlimited, Codex off', () => {
    const p = balanced();
    expect(p.mode).toBe('balanced');
    expect(p.seats).toEqual({});
    expect(effectiveSeatPolicy(p, 'claude')).toEqual({ seatId: 'claude', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 });
    expect(effectiveSeatPolicy(p, 'grok')).toEqual({ seatId: 'grok', enabled: true, reservePercent: 0 });
    expect(effectiveSeatPolicy(p, 'local:qwen')).toEqual({ seatId: 'local:qwen', enabled: true, reservePercent: 0 });
    expect(effectiveSeatPolicy(p, 'codex-personal').enabled).toBe(false);
    expect(effectiveSeatPolicy(p, 'codex-cmp').enabled).toBe(false);
  });

  it('keeps Codex off in every mode and gives all-in no reserve at all', () => {
    for (const mode of ['all-in', 'balanced', 'reserve'] as const) expect(MODE_DEFAULTS[mode].codex.enabled).toBe(false);
    expect(defaultSeatPolicy('all-in', 'claude')).toEqual({ seatId: 'claude', enabled: true, reservePercent: 0 });
    expect(defaultSeatPolicy('reserve', 'grok').reservePercent).toBe(85);
  });

  it('infers engines from seat ids and treats an unknown id as the most protected class', () => {
    expect(engineOfSeatId('local:qwen3-coder')).toBe('local');
    expect(engineOfSeatId('codex-cmp')).toBe('codex');
    expect(engineOfSeatId('grok')).toBe('grok');
    expect(engineOfSeatId('mystery-seat')).toBe('claude');
  });

  it('default mode table is frozen', () => {
    expect(Object.isFrozen(MODE_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(MODE_DEFAULTS.balanced.claude)).toBe(true);
  });
});

describe('parseBudgetUpdate — exactly one form, strict', () => {
  it('accepts {mode} and {seatId, policy}', () => {
    expect(parseBudgetUpdate({ mode: 'reserve' })).toEqual({ kind: 'mode', mode: 'reserve' });
    expect(parseBudgetUpdate({ seatId: 'claude', policy: { reservePercent: 50.4, maxSessionWindowPercent: null } }))
      .toEqual({ kind: 'seat', seatId: 'claude', patch: { reservePercent: 50, maxSessionWindowPercent: null } });
  });

  it.each([
    [null, 'JSON object'],
    [{}, 'exactly one of'],
    [{ mode: 'yolo' }, 'mode must be'],
    [{ mode: 'balanced', seatId: 'claude' }, 'exactly one of'],
    [{ seatId: '../etc', policy: { enabled: true } }, 'seatId'],
    [{ seatId: 'claude', policy: {} }, 'at least one'],
    [{ seatId: 'claude', policy: { reservepercent: 5 } }, 'unknown policy key'],
    [{ seatId: 'claude', policy: { reservePercent: 101 } }, 'reservePercent'],
    [{ seatId: 'claude', policy: { reservePercent: Number.NaN } }, 'reservePercent'],
    [{ seatId: 'claude', policy: { enabled: 'yes' } }, 'enabled'],
    [{ seatId: 'claude', policy: { maxSessionWindowPercent: 0 } }, 'maxSessionWindowPercent'],
    [{ seatId: 'claude', policy: { dailyUsdCap: -1 } }, 'dailyUsdCap'],
    [{ seatId: 'claude', policy: 'x' }, 'policy must be an object'],
  ])('refuses %j', (body, message) => {
    expect(() => parseBudgetUpdate(body)).toThrow(BudgetPolicyError);
    expect(() => parseBudgetUpdate(body)).toThrow(message);
  });
});

describe('applying updates', () => {
  const now = '2026-09-24T12:00:00.000Z';

  it('a seat patch stores the full effective policy and stamps updatedAt', () => {
    const next = applyBudgetUpdate(balanced(), { seatId: 'codex-personal', policy: { enabled: true } }, now);
    expect(next.seats['codex-personal']).toEqual({ seatId: 'codex-personal', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 });
    expect(next.updatedAt).toBe(now);
  });

  it('null clears optional fields', () => {
    const withCap = applyBudgetUpdate(balanced(), { seatId: 'claude', policy: { dailyUsdCap: 5 } }, now);
    expect(withCap.seats['claude']!.dailyUsdCap).toBe(5);
    const cleared = applyBudgetUpdate(withCap, { seatId: 'claude', policy: { dailyUsdCap: null, maxSessionWindowPercent: null } } as never, now);
    expect(cleared.seats['claude']).toEqual({ seatId: 'claude', enabled: true, reservePercent: 40 });
  });

  it('a mode switch re-bases reserves but keeps on/off and a hard USD cap', () => {
    let p = applyBudgetUpdate(balanced(), { seatId: 'claude', policy: { reservePercent: 55, dailyUsdCap: 3, enabled: false } }, now);
    p = applyBudgetUpdate(p, { seatId: 'codex-cmp', policy: { enabled: true } }, now);
    const allIn = applyModeSwitch(p, 'all-in', now);
    expect(allIn.mode).toBe('all-in');
    expect(allIn.seats['claude']).toEqual({ seatId: 'claude', enabled: false, reservePercent: 0, dailyUsdCap: 3 });
    expect(allIn.seats['codex-cmp']).toEqual({ seatId: 'codex-cmp', enabled: true, reservePercent: 0 });
  });

  it('refuses a new seat past the registry bound', () => {
    let p = balanced();
    for (let i = 0; i < 64; i += 1) p = applyBudgetUpdate(p, { seatId: `local:m${i}`, policy: { enabled: true } }, now);
    expect(() => applyBudgetUpdate(p, { seatId: 'local:one-more', policy: { enabled: true } }, now)).toThrow('at most 64');
    // Updating an existing seat is still fine.
    expect(() => applyBudgetUpdate(p, { seatId: 'local:m1', policy: { enabled: false } }, now)).not.toThrow();
  });

  it('sanitizeBudgetPolicy salvages field by field and never throws', () => {
    expect(sanitizeBudgetPolicy('garbage')).toEqual(defaultBudgetPolicy());
    const salvaged = sanitizeBudgetPolicy({
      mode: 'reserve',
      updatedAt: 'not a date',
      seats: {
        claude: { enabled: true, reservePercent: 30, maxSessionWindowPercent: 'x', dailyUsdCap: 1e9 },
        grok: { enabled: 'yes', reservePercent: 0 },
        '../bad': { enabled: true, reservePercent: 0 },
      },
    });
    expect(salvaged.mode).toBe('reserve');
    expect(salvaged.updatedAt).toBe(new Date(0).toISOString());
    expect(salvaged.seats).toEqual({ claude: { seatId: 'claude', enabled: true, reservePercent: 30 } });
  });
});

// ---------------------------------------------------------------------------
// Headroom
// ---------------------------------------------------------------------------

describe('window classification', () => {
  it('Claude: five_hour session, seven_day weekly, seven_day_* model-only', () => {
    expect(classifyWindow('claude', win('five_hour', 1), NOW)).toBe('session');
    expect(classifyWindow('claude', win('seven_day', 1), NOW)).toBe('weekly');
    expect(classifyWindow('claude', win('seven_day_fable', 1), NOW)).toBe('model');
  });

  it('Codex primary is a session window unless its reset is further than five hours out', () => {
    expect(classifyWindow('codex', win('codex_codex_primary', 1, { resetsAt: iso(2 * H) }), NOW)).toBe('session');
    expect(classifyWindow('codex', win('codex_codex_primary', 1, { resetsAt: iso(42 * H) }), NOW)).toBe('weekly');
    expect(classifyWindow('codex', win('codex_codex_primary', 1), NOW)).toBe('session');
    expect(classifyWindow('codex', win('codex_codex_secondary', 1, { resetsAt: iso(H) }), NOW)).toBe('weekly');
  });

  it('Grok billing windows and unknown ids are long unless a near reset proves otherwise', () => {
    expect(classifyWindow('grok', win('grok_unified_weekly', 1), NOW)).toBe('weekly');
    expect(classifyWindow('claude', win('mystery', 1), NOW)).toBe('weekly');
    expect(classifyWindow('claude', win('mystery', 1, { resetsAt: iso(H) }), NOW)).toBe('session');
  });
});

describe('assessSeat — autonomy headroom', () => {
  const claudePolicy = effectiveSeatPolicy(balanced(), 'claude');

  it('Claude at 15% / 20% is eligible with the weekly reserve binding; a spent Fable window is not the account', () => {
    const a = assessSeat(claude(15, 20), claudePolicy, opts);
    expect(a.headroom).toMatchObject({
      sessionUsedPercent: 15,
      weeklyUsedPercent: 20,
      bindingWindow: 'weekly',
      autonomyHeadroomPercent: 40,
      eligibleForAutonomy: true,
      resetAt: null,
    });
    expect(a.headroom.reasons[0]).toBe('40% of the weekly window is left for autonomy (40% kept for you).');
    expect(a.headroom.reasons.some((r) => r.includes('Fable-only weekly window is spent') && r.includes('that model only'))).toBe(true);
    expect(a.exhausted).toBe(false);
  });

  it('never touches Claude while its 5-hour window is above 70% — quoting the provider reset verbatim', () => {
    const a = assessSeat(claude(82, 20), claudePolicy, opts);
    expect(a.headroom.eligibleForAutonomy).toBe(false);
    expect(a.headroom.bindingWindow).toBe('session');
    expect(a.headroom.autonomyHeadroomPercent).toBe(0);
    expect(a.headroom.reasons).toContain(
      'The 5-hour window is 82% used; autonomy stops at 70% to protect your live session (resets 7pm (America/New_York)).');
    // Claude has no machine reset, so no reopening time is invented.
    expect(a.reopensAt).toBeNull();
  });

  it('stops at the weekly reserve', () => {
    const a = assessSeat(claude(10, 61), claudePolicy, opts);
    expect(a.headroom.eligibleForAutonomy).toBe(false);
    expect(a.headroom.reasons[0]).toContain('The weekly window is 61% used; 40% is kept for you, so autonomy stops at 60%');
  });

  it('unknown usage is NOT headroom: no windows, a null window, a stale or undated reading', () => {
    const none = assessSeat(seat('claude', 'claude', []), claudePolicy, opts);
    expect(none.headroom.eligibleForAutonomy).toBe(false);
    expect(none.unknownUsage).toBe(true);
    expect(none.headroom.autonomyHeadroomPercent).toBeNull();
    expect(none.headroom.reasons[0]).toContain('unknown usage is not headroom');

    const partial = assessSeat(claude(10, null), claudePolicy, opts);
    expect(partial.headroom.eligibleForAutonomy).toBe(false);
    expect(partial.headroom.reasons.join(' ')).toContain('weekly window carried no percentage');

    const stale = assessSeat(claude(10, 10, { observedAt: iso(-HEADROOM_READING_MAX_AGE_MS - 60_000) }), claudePolicy, opts);
    expect(stale.headroom.eligibleForAutonomy).toBe(false);
    expect(stale.headroom.reasons.join(' ')).toContain('too stale to spend against');
    // The numbers are still shown — stale is labelled, not hidden.
    expect(stale.headroom.weeklyUsedPercent).toBe(10);

    const undated = assessSeat(claude(10, 10, { observedAt: null }), claudePolicy, opts);
    expect(undated.headroom.eligibleForAutonomy).toBe(false);
  });

  it('spent Codex blocks autonomy even with credits and reopens at its reset', () => {
    const on = { seatId: 'codex-personal', enabled: true, reservePercent: 0 };
    const a = assessSeat(codexSpent('codex-personal', 30), on, opts);
    expect(a.exhausted).toBe(true);
    expect(a.headroom.eligibleForAutonomy).toBe(false);
    expect(a.reopensAt).toBe(iso(30 * H));
    expect(a.spentReasons[0]).toContain('weekly window is spent — 100% used');
  });

  it('a flagged limit is reported as "limit reached", not a percentage', () => {
    const s = seat('codex-cmp', 'codex', [win('codex_codex_primary', 100, { limitReached: true, resetsAt: iso(H) })]);
    const a = assessSeat(s, { seatId: 'codex-cmp', enabled: true, reservePercent: 0 }, opts);
    expect(a.spentReasons[0]).toContain('limit reached');
  });

  it('switched off / signed out seats are ineligible with no reopening time', () => {
    const off = assessSeat(claude(1, 1), { ...claudePolicy, enabled: false }, opts);
    expect(off.headroom.eligibleForAutonomy).toBe(false);
    expect(off.headroom.reasons[0]).toBe('Autonomy is switched off for this seat.');
    const out = assessSeat(claude(1, 1, { signedOut: true }), claudePolicy, opts);
    expect(out.headroom.eligibleForAutonomy).toBe(false);
    expect(out.reopensAt).toBeNull();
  });

  it('a daily USD cap with unknown spend fails closed; known spend under the cap passes', () => {
    const capped = { ...claudePolicy, dailyUsdCap: 5 };
    expect(assessSeat(claude(1, 1), capped, opts).headroom.eligibleForAutonomy).toBe(false);
    expect(assessSeat(claude(1, 1, { spentTodayUsd: 2 }), capped, opts).headroom.eligibleForAutonomy).toBe(true);
    expect(assessSeat(claude(1, 1, { spentTodayUsd: 5 }), capped, opts).headroom.eligibleForAutonomy).toBe(false);
  });

  it('a seat with only a short window applies the reserve to it', () => {
    const s = seat('codex-personal', 'codex', [win('codex_codex_primary', 50, { resetsAt: iso(H) })]);
    const a = assessSeat(s, { seatId: 'codex-personal', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 }, opts);
    expect(a.headroom.bindingWindow).toBe('session');
    expect(a.headroom.autonomyHeadroomPercent).toBe(10);
    expect(a.headroom.reasons[0]).toContain('(40% kept for you)');
    const blocked = assessSeat(
      seat('codex-personal', 'codex', [win('codex_codex_primary', 65, { resetsAt: iso(H) })]),
      { seatId: 'codex-personal', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 }, opts);
    expect(blocked.headroom.reasons[0]).toContain('40% is kept for you, so autonomy stops at 60%');
    expect(blocked.reopensAt).toBe(iso(H));
  });

  it('local seats are free and unlimited while reachable', () => {
    const h = computeHeadroom(local(), effectiveSeatPolicy(balanced(), 'local:qwen'), opts);
    expect(h).toMatchObject({ autonomyHeadroomPercent: 100, bindingWindow: null, eligibleForAutonomy: true });
    const down = computeHeadroom({ ...local(), reachable: false }, effectiveSeatPolicy(balanced(), 'local:qwen'), opts);
    expect(down).toMatchObject({ autonomyHeadroomPercent: null, eligibleForAutonomy: false });
  });
});

describe('capacityFromSeat', () => {
  const base: VerseSeat = {
    id: 'claude',
    engine: 'claude',
    label: 'Claude Code',
    accountId: 'claude',
    models: [],
    contextWindow: 200_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: iso(-1000) },
  };

  it('projects windows, clamps percents and keeps unknown as null', () => {
    const c = capacityFromSeat({
      ...base,
      capacity: {
        planType: 'max',
        binding: null,
        windows: [
          { id: 'five_hour', usedPercent: 140, resetsAt: null, resetDescription: '7pm (UTC)', limitReached: false, measured: true },
          { id: 'seven_day', usedPercent: null, resetsAt: null, resetDescription: null, limitReached: false, measured: true },
        ],
        credits: null,
        usability: 'tight',
        observedAt: iso(-5000),
        evidenceSource: 'collector',
        notes: [],
      },
    });
    expect(c.windows.map((w) => w.usedPercent)).toEqual([100, null]);
    expect(c.observedAt).toBe(iso(-5000));
    expect(c.free).toBe(false);
    expect(c.signedOut).toBe(false);
  });

  it('a seat with no capacity has no windows (unknown), and live capacity overrides the cached one', () => {
    expect(capacityFromSeat(base).windows).toEqual([]);
    const signedOut = capacityFromSeat(base, {
      planType: null, binding: null, windows: [], credits: null, usability: 'signed-out',
      observedAt: null, evidenceSource: 'none', notes: [],
    });
    expect(signedOut.signedOut).toBe(true);
    expect(signedOut.reachable).toBe(false);
  });

  it('local seats are free and reachable', () => {
    const c = capacityFromSeat({ ...base, id: 'local:qwen', engine: 'local', accountId: 'local', contextWindow: 65_536 });
    expect(c).toMatchObject({ free: true, reachable: true, windows: [], contextWindow: 65_536, observedAt: null });
  });
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

describe('routeSeat — today’s machine in balanced mode', () => {
  const fleet = (): SeatCapacity[] => [claude(15, 20), codexSpent('codex-personal', 30), codexSpent('codex-cmp', 40), grok(12), local()];

  it('medium autonomous code work goes to Grok, with Codex held back and a one-sentence why', () => {
    const d = routeSeat(auto('code', 'medium'), fleet(), balanced(), opts);
    expect(d.seatId).toBe('grok');
    expect(d.mode).toBe('balanced');
    expect(d.candidates).toEqual(['grok', 'local:qwen3.8:27b-ctx64k', 'claude']);
    expect(d.exclusions.map((e) => e.seatId)).toEqual(['codex-cmp', 'codex-personal']);
    // Codex is OFF by policy — that is the first reason, and "off" has no reopening date.
    expect(d.exclusions[0]!.reasons[0]).toBe('Autonomy is switched off for this seat.');
    expect(d.exclusions[0]!.nextEligibleAt).toBeNull();
    expect(d.why).toMatch(/^Routed autonomous medium-difficulty code work to grok \(grok\) with 88% of its weekly window left for autonomy: balanced mode prefers Grok first/);
    expect(d.why.split('. ').length).toBe(1);
  });

  it('high-difficulty work prefers Claude inside its capped slice', () => {
    const d = routeSeat(auto('code', 'high'), fleet(), balanced(), opts);
    expect(d.seatId).toBe('claude');
    expect(d.why).toContain('40% of its weekly window left for autonomy');
  });

  it('low-difficulty and bulk work goes local first, at no cost', () => {
    for (const req of [auto('code', 'low'), auto('bulk', 'high')]) {
      const d = routeSeat(req, fleet(), balanced(), opts);
      expect(d.seatId).toBe('local:qwen3.8:27b-ctx64k');
      expect(d.why).toContain('at no cost');
    }
  });

  it('protects a live Claude session: 5-hour above 70% sends high work elsewhere', () => {
    const d = routeSeat(auto('code', 'high'), [claude(75, 20), grok(12), local()], balanced(), opts);
    expect(d.seatId).toBe('grok');
    expect(d.exclusions[0]!.reasons[0]).toContain('autonomy stops at 70% to protect your live session');
  });

  it('closes the Claude fail-open: unknown Claude usage is never routed autonomous work', () => {
    const d = routeSeat(auto('leader', 'high'), [seat('claude', 'claude', [])], balanced(), opts);
    expect(d.seatId).toBeNull();
    expect(d.exclusions[0]!.reasons[0]).toContain('unknown usage is not headroom');
    expect(d.why).toMatch(/^No seat can take autonomous high-difficulty leader work in balanced mode/);
  });

  it('with nothing eligible, why names the earliest known reopening', () => {
    const on: BudgetPolicy = { ...balanced(), seats: {
      'codex-personal': { seatId: 'codex-personal', enabled: true, reservePercent: 0 },
      'codex-cmp': { seatId: 'codex-cmp', enabled: true, reservePercent: 0 },
    } };
    const d = routeSeat(auto('code', 'medium'), [codexSpent('codex-personal', 30), codexSpent('codex-cmp', 40)], on, opts);
    expect(d.seatId).toBeNull();
    expect(d.exclusions.find((e) => e.seatId === 'codex-personal')!.nextEligibleAt).toBe(iso(30 * H));
    expect(d.why).toContain(`the earliest known reopening is ${iso(30 * H)}`);
  });

  it('never truncates silently: a task larger than 80% of a window skips that seat', () => {
    const d = routeSeat(auto('code', 'low', { contextTokens: 60_000 }), fleet(), balanced(), opts);
    expect(d.seatId).toBe('grok');
    const localExclusion = d.exclusions.find((e) => e.seatId.startsWith('local:'))!;
    expect(localExclusion.reasons[0]).toContain('Needs about 60k tokens of context');
    expect(localExclusion.nextEligibleAt).toBeNull();
  });

  it('every seat lands in exactly one of candidates or exclusions, and routing is deterministic', () => {
    const d1 = routeSeat(auto('review', 'medium'), fleet(), balanced(), opts);
    const d2 = routeSeat(auto('review', 'medium'), [...fleet()].reverse(), balanced(), opts);
    expect(d1).toEqual(d2);
    const all = [...d1.candidates, ...d1.exclusions.map((e) => e.seatId)].sort();
    expect(all).toEqual(fleet().map((s) => s.seatId).sort());
  });

  it('equal free local seats resolve in discovery order (the operator’s preferred tag first)', () => {
    const d = routeSeat(auto('code', 'low'), [local('qwen3.8:27b-ctx64k'), local('gpt-oss:20b')], balanced(), opts);
    expect(d.candidates).toEqual(['local:qwen3.8:27b-ctx64k', 'local:gpt-oss:20b']);
  });

  it('within one engine, more headroom wins', () => {
    const a = seat('claude-a', 'claude', [win('five_hour', 10), win('seven_day', 50)]);
    const b = seat('claude-b', 'claude', [win('five_hour', 10), win('seven_day', 10)]);
    const d = routeSeat(auto('code', 'high'), [a, b], balanced(), opts);
    expect(d.candidates).toEqual(['claude-b', 'claude-a']);
  });

  it('no seats at all is explained, not thrown', () => {
    const d = routeSeat(auto('code', 'medium'), [], balanced(), opts);
    expect(d).toMatchObject({ seatId: null, candidates: [], exclusions: [] });
    expect(d.why).toContain('No seats are known');
  });
});

describe('routeSeat — modes', () => {
  it('reserve mode runs medium work locally and only lets paid seats take a small slice', () => {
    const reserve = applyModeSwitch(balanced(), 'reserve', iso(0));
    expect(routeSeat(auto('code', 'medium'), [claude(5, 5), grok(5), local()], reserve, opts).seatId).toBe('local:qwen3.8:27b-ctx64k');
    // Grok at 20% of its week is past reserve mode's 15% slice.
    const d = routeSeat(auto('code', 'high'), [claude(5, 20), grok(20), local()], reserve, opts);
    expect(d.seatId).toBe('local:qwen3.8:27b-ctx64k');
    expect(d.exclusions.map((e) => e.seatId)).toEqual(['claude', 'grok']);
    // …but under it, hard work may use the slice.
    expect(routeSeat(auto('code', 'high'), [claude(5, 20), grok(10), local()], reserve, opts).seatId).toBe('grok');
  });

  it('all-in mode lets autonomy use Claude up to its limit', () => {
    const allIn = applyModeSwitch(balanced(), 'all-in', iso(0));
    const d = routeSeat(auto('code', 'high'), [claude(95, 97), grok(10)], allIn, opts);
    expect(d.seatId).toBe('claude');
    // A spent window still blocks in all-in.
    expect(routeSeat(auto('code', 'high'), [claude(100, 97), grok(10)], allIn, opts).seatId).toBe('grok');
  });

  it('engine preference table', () => {
    expect(enginePreference('balanced', auto('code', 'medium'))).toEqual(['grok', 'local', 'codex', 'claude']);
    expect(enginePreference('all-in', auto('code', 'medium'))).toEqual(['grok', 'codex', 'claude', 'local']);
    expect(enginePreference('balanced', auto('leader', 'low'))).toEqual(['claude', 'codex', 'grok', 'local']);
    expect(enginePreference('reserve', auto('plan', 'high'))).toEqual(['grok', 'codex', 'claude', 'local']);
    expect(enginePreference('reserve', { task: 'code', difficulty: 'high', autonomous: false })).toEqual(['claude', 'codex', 'grok', 'local']);
  });
});

describe('interactive routing ignores reserves (they exist for Mason)', () => {
  it('Claude above its autonomy ceiling is still Mason’s first choice', () => {
    const d = routeSeat({ task: 'code', difficulty: 'high', autonomous: false }, [claude(82, 65), grok(10)], balanced(), opts);
    expect(d.seatId).toBe('claude');
  });

  it('unknown usage does not block Mason, but spent and signed-out seats do', () => {
    const d = routeSeat({ task: 'code', difficulty: 'medium', autonomous: false },
      [seat('claude', 'claude', []), codexSpent('codex-personal', 30), grok(10, ), { ...grok(1), seatId: 'grok-b', signedOut: true }],
      balanced(), opts);
    expect(d.candidates).toEqual(['claude', 'grok']);
    const codex = d.exclusions.find((e) => e.seatId === 'codex-personal')!;
    expect(codex.reasons[0]).toContain('is spent');
    expect(codex.nextEligibleAt).toBe(iso(30 * H));
    expect(d.exclusions.find((e) => e.seatId === 'grok-b')!.reasons[0]).toContain('Signed out');
  });

  it('rankAlternatives offers the same provider first, then the router order', () => {
    const capacity = [codexSpent('codex-personal', 30), seat('codex-cmp', 'codex', [win('codex_codex_primary', 20, { resetsAt: iso(H) })]),
      claude(10, 10), grok(10), local()];
    expect(rankAlternatives('codex-personal', capacity, balanced(), opts))
      .toEqual(['codex-cmp', 'claude', 'grok', 'local:qwen3.8:27b-ctx64k']);
    expect(rankAlternatives('unknown-seat', capacity, balanced(), opts)[0]).toBe('claude');
  });
});
