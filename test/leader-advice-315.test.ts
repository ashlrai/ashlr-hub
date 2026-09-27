/**
 * 3.15 follow-up: `suggestActionClass` wired as the Leader's ADVISORY class
 * check (vision/leader-advice.ts). Advice may label an action and show on the
 * memo; it may never lower a class, approve anything, or reach a gate.
 *
 * The decision module is mocked where a confident Jev answer is needed; the
 * unmocked path runs with Jev killed (ASHLR_JEV_DISABLE=1), so no paid call
 * is ever made. HOME is isolated by test/setup/home.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LeaderAction, LeaderActionAdvice, LeaderActionClass, LeaderMemo } from '../src/core/vision/leader-types.js';
import {
  MAX_ADVISED_ACTIONS_PER_MEMO,
  adviseLeaderActions,
  defaultLeaderActionAdvisor,
  isAdvisableAction,
  stricterAdviceFor,
} from '../src/core/vision/leader-advice.js';
import { memoSummaryText } from '../src/core/vision/leader-thread.js';

const ROOT = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$|\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function action(id: string, cls: LeaderActionClass, status: LeaderAction['status'], statusReason: string | null = null): LeaderAction {
  return {
    v: 1, id, memoId: 'lm-20260924090000-abcdef', kind: 'lanes.grok', class: cls,
    params: { slots: 1 }, summary: `Action ${id}`, why: 'cost', createdAt: '2026-09-24T09:00:00.000Z',
    applyAfter: null, deferredForQuietHours: false, status, statusReason,
    appliedAt: null, vetoedAt: null, vetoNote: null, inverse: null,
  } as LeaderAction;
}

function advice(a: LeaderAction, suggested: LeaderActionClass, over: Partial<LeaderActionAdvice> = {}): LeaderActionAdvice {
  const rank = { A: 0, B: 1, C: 2 } as const;
  return { actionId: a.id, deterministic: a.class, suggested, stricter: rank[suggested] > rank[a.class], confidence: 0.93, source: 'jev', ...over };
}

afterEach(() => {
  vi.doUnmock('../src/core/decide/action-class.js');
  vi.resetModules();
  delete process.env['ASHLR_JEV_DISABLE'];
});

describe('isAdvisableAction', () => {
  it('advises live or would-be-live A/B actions only', () => {
    expect(isAdvisableAction(action('a1', 'A', 'applied'))).toBe(true);
    expect(isAdvisableAction(action('a2', 'B', 'scheduled'))).toBe(true);
    expect(isAdvisableAction(action('a3', 'A', 'failed'))).toBe(true);
    expect(isAdvisableAction(action('a4', 'A', 'refused', 'dry run: no standing grant is in force, so the Leader only proposes.'))).toBe(true);
    // Already the strictest, or nothing stricter to flag.
    expect(isAdvisableAction(action('c1', 'C', 'escalated'))).toBe(false);
    expect(isAdvisableAction(action('r1', 'A', 'refused', 'Leader limit: 3 goals a day'))).toBe(false);
    expect(isAdvisableAction(action('v1', 'B', 'vetoed'))).toBe(false);
  });
});

describe('adviseLeaderActions', () => {
  it('records stricter and agreeing advice, class A first, capped, in memo order; never mutates the actions', async () => {
    const actions = [
      action('b1', 'B', 'scheduled'),
      action('a1', 'A', 'applied'),
      action('c1', 'C', 'escalated'),
      action('a2', 'A', 'applied'),
    ];
    const before = JSON.stringify(actions);
    const asked: string[] = [];
    const out = await adviseLeaderActions(actions, async (a) => {
      asked.push(a.id);
      return a.id === 'a1' ? advice(a, 'B') : advice(a, a.class);
    }, { max: 2 });
    // Cap 2: both A's are asked (A first), the B and the C are not.
    expect(asked.sort()).toEqual(['a1', 'a2']);
    expect(out.map((x) => [x.actionId, x.suggested, x.stricter])).toEqual([['a1', 'B', true], ['a2', 'A', false]]);
    expect(JSON.stringify(actions)).toBe(before);
    expect(MAX_ADVISED_ACTIONS_PER_MEMO).toBeGreaterThan(0);
  });

  it('drops advice that would LOWER a class, names another action, lies about the class, or is not from Jev', async () => {
    const b = action('b1', 'B', 'scheduled');
    const cases: LeaderActionAdvice[] = [
      advice(b, 'A'),                                    // de-escalation
      advice(b, 'C', { actionId: 'someone-else' }),      // wrong action
      advice(b, 'C', { deterministic: 'A' }),            // misreports the class
      advice(b, 'C', { source: 'rule' as never }),       // not a Jev answer
      advice(b, 'C', { confidence: Number.NaN }),
    ];
    for (const c of cases) {
      expect(await adviseLeaderActions([b], async () => c)).toEqual([]);
    }
    // And `stricter` is recomputed, never trusted.
    const [kept] = await adviseLeaderActions([b], async () => advice(b, 'C', { stricter: false }));
    expect(kept).toMatchObject({ suggested: 'C', stricter: true, deterministic: 'B' });
  });

  it('never throws: a failing or null advisor leaves no advice', async () => {
    const a = action('a1', 'A', 'applied');
    await expect(adviseLeaderActions([a], async () => { throw new Error('network'); })).resolves.toEqual([]);
    await expect(adviseLeaderActions([a], async () => null)).resolves.toEqual([]);
  });
});

describe('defaultLeaderActionAdvisor (the decide layer)', () => {
  it('with Jev killed, returns no advice and makes no call (fallback = the deterministic class)', async () => {
    process.env['ASHLR_JEV_DISABLE'] = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const advise = defaultLeaderActionAdvisor(null);
      await expect(advise(action('a1', 'A', 'applied'))).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('maps a confident Jev answer, asking with the action and its DETERMINISTIC class; a fallback answer is no advice', async () => {
    const suggest = vi.fn(async (_action: unknown, deterministic: LeaderActionClass) => ({
      deterministic,
      suggested: 'C' as const,
      stricter: true,
      decision: { kind: 'action-class', value: 'C', path: 'jev', confidence: 0.91, threshold: 0.85, cached: false, durationMs: 3 },
    }));
    vi.doMock('../src/core/decide/action-class.js', () => ({ suggestActionClass: suggest }));
    vi.resetModules();
    const mod = await import('../src/core/vision/leader-advice.js');
    const b = { ...action('b1', 'B', 'scheduled'), params: { repo: 'ashlrai/ashlr-hub' } } as unknown as LeaderAction;
    const got = await mod.defaultLeaderActionAdvisor(null)(b);
    expect(got).toEqual({ actionId: 'b1', deterministic: 'B', suggested: 'C', stricter: true, confidence: 0.91, source: 'jev' });
    expect(suggest).toHaveBeenCalledWith(
      { kind: 'lanes.grok', summary: 'Action b1', detail: 'cost', repo: 'ashlrai/ashlr-hub' },
      'B',
      {},
    );

    suggest.mockResolvedValueOnce({
      deterministic: 'B', suggested: 'B', stricter: false,
      decision: { kind: 'action-class', value: 'B', path: 'fallback', reason: 'below-threshold', confidence: 1, threshold: 0.85, cached: false, durationMs: 3 },
    } as never);
    await expect(mod.defaultLeaderActionAdvisor(null)(b)).resolves.toBeNull();
  });
});

describe('the memo shows it; nothing that decides reads it', () => {
  it('the memo message flags a stricter opinion next to the action, and says the class stands', () => {
    const a = action('lm-20260924090000-abcdef-a0', 'A', 'applied');
    const memo = {
      v: 1, id: 'lm-20260924090000-abcdef', at: '2026-09-24T09:00:00.000Z', status: 'ok', statusReason: null,
      trigger: 'manual', dryRun: false, seatId: null, model: null, evidenceDigest: 'x',
      bottleneck: null, move: null, killList: [], goals: [], priorityChanges: [], standards: [], critiques: [],
      seatPlan: [], hypotheses: [], questionsForMason: [], actions: [a],
      actionAdvice: [advice(a, 'B')],
    } as LeaderMemo;
    const text = memoSummaryText(memo);
    expect(text).toContain(`[A] Action ${a.id} — applied (${a.id}) — Jev suggests class B (advisory; the class above stands)`);
    expect(memoSummaryText({ ...memo, actionAdvice: [advice(a, 'A')] })).not.toContain('Jev suggests');
    expect(memoSummaryText({ ...memo, actionAdvice: undefined })).not.toContain('Jev suggests');
    expect(stricterAdviceFor(undefined, a.id)).toBeNull();
  });

  it('no gate or approval path imports the advisor or the action-class decision', () => {
    // Exactly who may touch the advice: the Leader run (after enactment) and the
    // memo message. Everything else — leader-apply.ts's policy check / approve /
    // veto, authority/, inbox/merge, swarm/gate, the daemon — must not.
    const importers = (pattern: RegExp): string[] => sourceFiles(join(ROOT, 'src'))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file).split(sep).join('/'))
      .sort();
    expect(importers(/['"][^'"]*leader-advice\.js['"]/)).toEqual(['src/core/vision/leader-thread.ts', 'src/core/vision/leader.ts']);
    expect(importers(/['"][^'"]*decide\/action-class\.js['"]|['"]\.\/action-class\.js['"]/)).toEqual(['src/core/decide/index.ts', 'src/core/vision/leader-advice.ts']);
    // And the advisor has no route to applying or approving anything.
    const src = readFileSync(join(ROOT, 'src/core/vision/leader-advice.ts'), 'utf8');
    expect(src).not.toMatch(/leader-apply\.js|applyApprovedLeaderAction|enactLeaderActions\(/);
    expect(src).toContain("import('../decide/action-class.js')");
  });
});
