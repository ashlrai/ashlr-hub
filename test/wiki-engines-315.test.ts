/**
 * 3.15 — which engines may write the wiki / answer Ask. The wiki reuses the
 * Leader's seat plan in CHECK-IN mode; these tests pin what it adds on top:
 * Claude is never admitted (no credential hook, and any Claude step is
 * dropped), reserve budget mode means local only, remote seats vanish for
 * local-only repos, per-call output caps are applied, and shadow decisions
 * are not recorded under the Leader's name.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import { defaultWikiEngineResolver, repoLocalOnlyReason, runEngineChain, wikiConfig, type SeatModule, type WikiEngine } from '../src/core/knowledge/wiki/model.js';

type Deps = Awaited<ReturnType<SeatModule['loadDefaultLeaderSeatDeps']>>;
type PlanOpts = Parameters<SeatModule['planLeaderSeats']>[1];

function fakeSeat(opts: { mode?: 'balanced' | 'reserve'; steps?: Array<'local' | 'grok' | 'claude'> } = {}) {
  const calls: { plan: PlanOpts[]; deps: Deps[]; localOpts: unknown[]; recorded: number } = { plan: [], deps: [], localOpts: [], recorded: 0 };
  const baseDeps = {
    budgetPolicy: () => ({ mode: opts.mode ?? 'balanced' }),
    recordDecision: () => { calls.recorded++; },
    claudeCredential: async () => undefined,
    transports: {
      local: (_url: string, _model: string, o?: unknown) => { calls.localOpts.push(o); return async () => '{"markdown":"local"}'; },
      grok: () => async () => 'grok',
      claude: () => async () => 'claude',
    },
  } as unknown as Deps;
  const seat: SeatModule = {
    loadDefaultLeaderSeatDeps: async () => baseDeps,
    planLeaderSeats: async (deps, planOpts) => {
      calls.plan.push(planOpts);
      calls.deps.push(deps);
      deps.recordDecision({} as never, {} as never);
      const steps = (opts.steps ?? ['grok', 'local']).map((engine) => ({
        choice: { seatId: `${engine}-a`, engine, model: `${engine}-model`, deep: false },
        complete: engine === 'local' ? deps.transports.local('http://127.0.0.1:11434', 'qwen', { timeoutMs: 1, maxOutputTokens: 1, contextTokens: 1 }) : async () => engine,
        budget: { timeoutMs: 1, maxOutputTokens: 1, contextTokens: null },
      }));
      return { ok: true, steps, skipped: [], decision: {} as never } as Awaited<ReturnType<SeatModule['planLeaderSeats']>>;
    },
  };
  return { seat, calls };
}

const CFG = {} as AshlrConfig;

describe('defaultWikiEngineResolver', () => {
  it('plans in check-in mode with no Claude credential, and drops any Claude step', async () => {
    const { seat, calls } = fakeSeat({ steps: ['claude', 'grok', 'local'] });
    const choice = await defaultWikiEngineResolver(CFG, async () => seat)({ promptChars: 10_000, localOnly: false, purpose: 'page' });
    expect(calls.plan[0]).toMatchObject({ deep: false, mode: 'checkin', localOnly: false });
    expect(calls.deps[0]!.claudeCredential).toBeNull();
    expect(choice.engines.map((e) => e.label)).toEqual(['grok:grok-model', 'local:local-model']);
    expect(choice.engines.map((e) => e.local)).toEqual([false, true]);
    // The wiki does not write shadow decisions under the Leader's name.
    expect(calls.recorded).toBe(0);
    // The wiki's own output caps reach the local transport.
    expect(calls.localOpts[0]).toMatchObject({ maxOutputTokens: 1_600, timeoutMs: 360_000 });
    await expect(calls.deps[0]!.transports.claude([], 'm', async () => undefined)('s', 'u')).rejects.toThrow(/never uses Claude/);
  });

  it('forces local-only in reserve budget mode and for local-only requests', async () => {
    const reserve = fakeSeat({ mode: 'reserve' });
    const a = await defaultWikiEngineResolver(CFG, async () => reserve.seat)({ promptChars: 1, localOnly: false, purpose: 'ask' });
    expect(reserve.calls.plan[0]!.localOnly).toBe(true);
    expect(a.engines.every((e) => e.local)).toBe(true);

    const req = fakeSeat();
    const b = await defaultWikiEngineResolver(CFG, async () => req.seat)({ promptChars: 1, localOnly: true, purpose: 'ask' });
    expect(b.engines.map((e) => e.kind)).toEqual(['local']);
  });

  it('degrades to no engine (facts-only) when seat routing cannot load or plan', async () => {
    const broken = await defaultWikiEngineResolver(CFG, async () => { throw new Error('nope'); })({ promptChars: 1, localOnly: false, purpose: 'page' });
    expect(broken.engines).toEqual([]);
    expect(broken.note).toMatch(/unavailable/);
    const { seat } = fakeSeat();
    const refusing: SeatModule = { ...seat, planLeaderSeats: async () => ({ ok: false, reason: 'No seat.', skipped: [], decision: null }) };
    const none = await defaultWikiEngineResolver(CFG, async () => refusing)({ promptChars: 1, localOnly: false, purpose: 'page' });
    expect(none).toEqual({ engines: [], note: 'No seat.' });
  });
});

describe('local-only reasons and config', () => {
  const cfg = (wiki: Record<string, unknown>) => ({ foundry: { wiki } }) as unknown as AshlrConfig;

  it('honours foundry.wiki.localOnly, localOnlyRepos (path or name) and the repo steering flag', () => {
    expect(repoLocalOnlyReason(cfg({}), '/x/app', false)).toBeNull();
    expect(repoLocalOnlyReason(cfg({ localOnly: true }), '/x/app', false)).toMatch(/local-only/);
    expect(repoLocalOnlyReason(cfg({ allowRemote: false }), '/x/app', false)).toMatch(/local-only/);
    expect(repoLocalOnlyReason(cfg({ localOnlyRepos: ['app'] }), '/x/app', false)).toMatch(/localOnlyRepos/);
    expect(repoLocalOnlyReason(cfg({ localOnlyRepos: ['/x/app'] }), '/x/app', false)).toMatch(/localOnlyRepos/);
    expect(repoLocalOnlyReason(cfg({}), '/x/app', true)).toMatch(/wiki\.json/);
  });

  it('bounds the configured budgets', () => {
    expect(wikiConfig(undefined)).toMatchObject({ pageBudget: 8, tokenBudget: 60_000, autoRefresh: true, autoRefreshMinutes: 30 });
    expect(wikiConfig(cfg({ pageBudget: 10_000, tokenBudget: 1, autoRefresh: false, autoRefreshMinutes: 1 }))).toMatchObject({ pageBudget: 60, tokenBudget: 2_000, autoRefresh: false, autoRefreshMinutes: 5 });
  });
});

describe('runEngineChain', () => {
  it('falls through failures and stops at the first answer', async () => {
    const third = vi.fn(async () => 'never');
    const engines: WikiEngine[] = [
      { label: 'a', kind: 'test', local: true, complete: async () => { throw new Error('down'); } },
      { label: 'b', kind: 'test', local: false, complete: async () => 'answer' },
      { label: 'c', kind: 'test', local: true, complete: third },
    ];
    const errors: string[] = [];
    const res = await runEngineChain(engines, 's', 'u', (e) => errors.push(e.label));
    expect(res?.engine.label).toBe('b');
    expect(errors).toEqual(['a']);
    expect(third).not.toHaveBeenCalled();
    expect(await runEngineChain([], 's', 'u')).toBeNull();
  });
});
