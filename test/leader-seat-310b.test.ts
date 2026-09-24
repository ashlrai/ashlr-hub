/**
 * V3.10 B-U8 — Leader seat: no cloud fallback (SPEC-310B §4, §7 U8 key test).
 *
 *   - no standing grant ⇒ only free local seats are candidates;
 *   - no eligible seat ⇒ `no-seat`, never a cloud fallback;
 *   - with a grant: grok first, then local; Claude only for the weekly deep
 *     run, and the router still refuses it while its 5-hour window is > 70%
 *     or the weekly reserve would be touched;
 *   - codex is never a Leader seat; a seat the grant does not list for the
 *     leader role is never used; local-only mode refuses paid engines;
 *   - the legacy Strategist's local model is never `managerJudgeModel`;
 *   - Claude is a candidate only when the judges' restricted-credential hook
 *     is available (fails closed to grok / local otherwise);
 *   - transports are the judges' text-only commands (restricted Claude argv
 *     snapshot here; spawning is covered in leader-seat-transports-310b).
 */
import { describe, expect, it } from 'vitest';

import {
  claudeLeaderCommand,
  resolveLeaderSeat,
  resolveLocalLeaderModel,
  type LeaderSeatCandidate,
  type LeaderSeatDeps,
} from '../src/core/vision/leader-seat.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat, type SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { VerseSeat } from '../src/core/verse/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import { DEFAULT_LOCAL_MODEL_TAG } from '../src/core/run/model-catalog.js';
import { CLAUDE_RESTRICTED_ARGS, isRestrictedClaudeCommand } from '../src/core/run/engine-registry.js';
import { makePolicy } from './helpers/leader-310b-fakes.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const OBSERVED = new Date(NOW - 60_000).toISOString();

function seat(id: string, engine: VerseSeat['engine'], model: string): VerseSeat {
  return {
    id, engine, label: id, accountId: engine === 'local' ? 'local' : id,
    models: [{ id: model, label: model, contextWindow: 200_000 }],
    contextWindow: 200_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
  };
}

const LOCAL: LeaderSeatCandidate = { seat: seat('local:qwen3.8:27b-ctx64k', 'local', 'qwen3.8:27b-ctx64k'), launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' };
const GROK: LeaderSeatCandidate = { seat: seat('grok', 'grok', 'grok-4.6'), launcher: ['node', '/profiles/grok/launcher.js'], ollamaBaseUrl: null };
const CLAUDE: LeaderSeatCandidate = { seat: seat('claude', 'claude', 'claude-opus-5-5'), launcher: ['node', '/profiles/claude/launcher.js'], ollamaBaseUrl: null };
const CODEX: LeaderSeatCandidate = { seat: seat('codex-personal', 'codex', 'gpt-5.5'), launcher: ['node', '/profiles/codex/launcher.js'], ollamaBaseUrl: null };

function paidCapacity(id: string, engine: SeatCapacity['engine'], windows: SeatCapacity['windows']): SeatCapacity {
  return { seatId: id, engine, label: id, free: false, windows, signedOut: false, reachable: null, contextWindow: 200_000, observedAt: OBSERVED, spentTodayUsd: null };
}

const GROK_OK = paidCapacity('grok', 'grok', [{ id: 'weekly', usedPercent: 20, resetsAt: '2026-09-28T00:00:00.000Z', resetDescription: null, limitReached: false }]);
const claudeAt = (fiveHour: number, week: number): SeatCapacity => paidCapacity('claude', 'claude', [
  { id: 'five_hour', usedPercent: fiveHour, resetsAt: null, resetDescription: null, limitReached: false },
  { id: 'seven_day', usedPercent: week, resetsAt: null, resetDescription: null, limitReached: false },
]);

function deps(opts: {
  candidates: LeaderSeatCandidate[];
  standing?: ReturnType<typeof makePolicy> | null;
  snapshot?: SeatCapacity[] | null;
  cfg?: AshlrConfig;
  clampThrows?: boolean;
  calls?: string[];
  /** false = the judges' credential hook is not available in this build. */
  claudeHook?: boolean;
}): LeaderSeatDeps {
  const calls = opts.calls ?? [];
  return {
    cfg: opts.cfg ?? ({} as AshlrConfig),
    now: () => NOW,
    candidates: async () => opts.candidates,
    capacitySnapshot: () => (opts.snapshot === null ? null : { publishedAt: OBSERVED, seats: opts.snapshot ?? [] }),
    budgetPolicy: (): BudgetPolicy => defaultBudgetPolicy(),
    standingPolicy: () => (opts.standing === undefined ? makePolicy() : opts.standing),
    clampBudget: (policy) => {
      if (opts.clampThrows) throw new Error('not implemented');
      return policy;
    },
    route: (req, capacity, policy, nowMs) => routeSeat(req, capacity, policy, { nowMs }),
    capacityFromSeat: (s) => capacityFromSeat(s),
    recordDecision: () => undefined,
    transports: {
      local: (base, model) => async () => { calls.push(`local ${base} ${model}`); return '{}'; },
      grok: (launcher, model) => async () => { calls.push(`grok ${launcher.join(' ')} ${model}`); return '{}'; },
      claude: (launcher, model) => async () => { calls.push(`claude ${launcher.join(' ')} ${model}`); return '{}'; },
    },
    claudeCredential: opts.claudeHook === false ? null : async () => undefined,
  };
}

describe('resolveLeaderSeat', () => {
  it('without a standing grant only free local seats are candidates', async () => {
    const r = await resolveLeaderSeat(deps({ candidates: [GROK, CLAUDE, LOCAL], standing: null, snapshot: [GROK_OK, claudeAt(5, 5)] }), { deep: true, promptChars: 20_000 });
    expect(r.ok && r.choice).toMatchObject({ seatId: LOCAL.seat.id, engine: 'local', model: 'qwen3.8:27b-ctx64k', deep: false });
  });

  it('no local seat and no grant ⇒ no-seat (fails closed, no cloud fallback)', async () => {
    const r = await resolveLeaderSeat(deps({ candidates: [GROK, CLAUDE], standing: null, snapshot: [GROK_OK, claudeAt(5, 5)] }), { deep: true, promptChars: 1_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/without a standing grant/);
  });

  it('with a grant: grok first, then local', async () => {
    const calls: string[] = [];
    const r = await resolveLeaderSeat(deps({ candidates: [LOCAL, GROK], snapshot: [GROK_OK], calls }), { deep: false, promptChars: 20_000 });
    expect(r.ok && r.choice.seatId).toBe('grok');
    if (r.ok) await r.complete('s', 'u');
    expect(calls).toEqual(['grok node /profiles/grok/launcher.js grok-4.6']);
    // Grok with no fresh reading is ineligible (unknown usage is not headroom) → local.
    const stale = await resolveLeaderSeat(deps({ candidates: [LOCAL, GROK], snapshot: [] }), { deep: false, promptChars: 20_000 });
    expect(stale.ok && stale.choice.seatId).toBe(LOCAL.seat.id);
  });

  it('Claude is a candidate only for the weekly deep run, and only inside the reserve', async () => {
    const notDeep = await resolveLeaderSeat(deps({ candidates: [CLAUDE, GROK, LOCAL], snapshot: [claudeAt(10, 10), GROK_OK] }), { deep: false, promptChars: 20_000 });
    expect(notDeep.ok && notDeep.choice.seatId).toBe('grok');
    const deep = await resolveLeaderSeat(deps({ candidates: [CLAUDE, GROK, LOCAL], snapshot: [claudeAt(10, 10), GROK_OK] }), { deep: true, promptChars: 20_000 });
    expect(deep.ok && deep.choice).toMatchObject({ seatId: 'claude', deep: true });
    // 5-hour window above 70% protects Mason's live session.
    const busy = await resolveLeaderSeat(deps({ candidates: [CLAUDE, GROK, LOCAL], snapshot: [claudeAt(75, 10), GROK_OK] }), { deep: true, promptChars: 20_000 });
    expect(busy.ok && busy.choice.seatId).toBe('grok');
    // Weekly reserve (40% kept for Mason) would be touched.
    const reserve = await resolveLeaderSeat(deps({ candidates: [CLAUDE, GROK, LOCAL], snapshot: [claudeAt(10, 65), GROK_OK] }), { deep: true, promptChars: 20_000 });
    expect(reserve.ok && reserve.choice.seatId).toBe('grok');
  });

  it('without the judges\' credential hook Claude is not a candidate, even for the deep run', async () => {
    const r = await resolveLeaderSeat(deps({ candidates: [CLAUDE, GROK, LOCAL], snapshot: [claudeAt(10, 10), GROK_OK], claudeHook: false }), { deep: true, promptChars: 20_000 });
    expect(r.ok && r.choice.seatId).toBe('grok');
    const alone = await resolveLeaderSeat(deps({ candidates: [CLAUDE], snapshot: [claudeAt(10, 10)], claudeHook: false }), { deep: true, promptChars: 20_000 });
    expect(alone.ok).toBe(false);
  });

  it('never codex, and never a seat the grant does not list for the leader role', async () => {
    const r = await resolveLeaderSeat(deps({ candidates: [CODEX, CLAUDE], snapshot: [claudeAt(1, 1)] }), { deep: false, promptChars: 1_000 });
    expect(r.ok).toBe(false);
    const base = makePolicy();
    const noLeaderRole = makePolicy({
      spend: { ...base.spend, seats: { ...base.spend.seats, grok: { ...base.spend.seats['grok']!, roles: ['producer'] } } },
    });
    const r2 = await resolveLeaderSeat(deps({ candidates: [GROK, LOCAL], standing: noLeaderRole, snapshot: [GROK_OK] }), { deep: false, promptChars: 1_000 });
    expect(r2.ok && r2.choice.seatId).toBe(LOCAL.seat.id);
  });

  it('when the budget cannot be clamped to the grant, paid seats are dropped', async () => {
    const r = await resolveLeaderSeat(deps({ candidates: [GROK, LOCAL], snapshot: [GROK_OK], clampThrows: true }), { deep: false, promptChars: 1_000 });
    expect(r.ok && r.choice.seatId).toBe(LOCAL.seat.id);
    const none = await resolveLeaderSeat(deps({ candidates: [GROK], snapshot: [GROK_OK], clampThrows: true }), { deep: false, promptChars: 1_000 });
    expect(none.ok).toBe(false);
  });

  it('local-only mode refuses a paid engine even when routed to it', async () => {
    const cfg = { foundry: { localOnly: true } } as unknown as AshlrConfig;
    const r = await resolveLeaderSeat(deps({ candidates: [GROK], snapshot: [GROK_OK], cfg }), { deep: false, promptChars: 1_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Local-only mode refuses grok/);
  });

  it('a prompt that does not fit the seat window is not sent there', async () => {
    const small = { ...LOCAL, seat: { ...LOCAL.seat, contextWindow: 8_192, models: [{ id: 'tiny', label: 'tiny', contextWindow: 8_192 }] } };
    const r = await resolveLeaderSeat(deps({ candidates: [small], standing: null }), { deep: false, promptChars: 60_000 });
    expect(r.ok).toBe(false);
  });
});

describe('Claude Leader command (inference only)', () => {
  it('is the judges\' restricted command: no tools, no MCP, no settings, prompt on stdin', () => {
    const cmd = claudeLeaderCommand(['node', 'l.js'], 'claude-opus-5-5', 'SYS');
    expect(cmd).toEqual({
      bin: 'node',
      args: ['l.js', '-p', '--output-format', 'json', '--model', 'claude-opus-5-5', '--safe-mode', '--system-prompt', 'SYS', ...CLAUDE_RESTRICTED_ARGS],
    });
    // The ONE check that lets the claude-a credential reach a spawn.
    expect(isRestrictedClaudeCommand(cmd!)).toBe(true);
  });

  it('refuses a launcher that would re-open tools', () => {
    expect(claudeLeaderCommand(['node', 'l.js', '--dangerously-skip-permissions'], 'm', 'SYS')).toBeNull();
    expect(claudeLeaderCommand([], 'm', 'SYS')).toBeNull();
  });
});

describe('the Strategist fallback model', () => {
  it('is an Ollama tag, never managerJudgeModel (the gpt-5.5 bug)', () => {
    const cfg = { foundry: { managerJudgeEngine: 'codex', managerJudgeModel: 'gpt-5.5' } } as unknown as AshlrConfig;
    expect(resolveLocalLeaderModel(cfg)).toBe(DEFAULT_LOCAL_MODEL_TAG);
    expect(resolveLocalLeaderModel({ foundry: { leader: { localModel: 'qwen3.8:27b-q8_0' } } } as unknown as AshlrConfig)).toBe('qwen3.8:27b-q8_0');
    expect(resolveLocalLeaderModel({ foundry: { leader: { localModel: '$(rm -rf)' } } } as unknown as AshlrConfig)).toBe(DEFAULT_LOCAL_MODEL_TAG);
  });
});
