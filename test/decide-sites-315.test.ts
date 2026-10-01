/**
 * decide-sites-315 — every Jev call site: its deterministic fallback, its
 * gate, and what Jev is (and is not) allowed to change. All against the
 * in-process fake TypeSafe endpoint; nothing reaches the paid API.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { TYPESAFE_API_KEY_ENV } from '../src/core/classify/typesafe-client.js';
import { clearDecisionCache } from '../src/core/decide/cache.js';
import { readLedger, resetLedgerCountersForTests } from '../src/core/decide/ledger.js';
import { classifyOperatorIntent, classifyOperatorIntentHeuristic, type OperatorIntent } from '../src/core/decide/intent.js';
import { adviseDevinLane, chooseLane, chooseLaneHeuristic } from '../src/core/decide/lane.js';
import { automationTriageDecider, triageTrigger, triageTriggerHeuristic } from '../src/core/decide/triage.js';
import {
  needsYouPriorityHeuristic,
  orderNeedsYouWithJev,
  prioritizeNeedsYou,
  resetNeedsYouOrderingForTests,
  worthInterrupting,
  type AttentionItem,
} from '../src/core/decide/needs-you.js';
import { suggestActionClass } from '../src/core/decide/action-class.js';
import {
  clearTaskClassMemo,
  labelTaskClass,
  peekTaskClass,
  primeTaskClasses,
  toGoalCategory,
  toRetroTaskKind,
  toSkillTaskClass,
} from '../src/core/decide/task-class.js';
import { labelRetroRootCauses, rootCauseCategoryHeuristic } from '../src/core/decide/retro.js';
import { extractJudgeRubric, extractRedTeamSeverity, extractTasteScore } from '../src/core/decide/verdict.js';
import { classifyGoal } from '../src/core/learn/reflect.js';
import { classifyTaskKind } from '../src/core/learn/retro/inject.js';
import { choice, FAKE_TYPESAFE_ENDPOINT, FAKE_TYPESAFE_KEY, installFakeTypeSafe, noul, type FakeTypeSafe } from './helpers/fake-typesafe.js';

const cfg = { phantom: { enabled: false } } as unknown as AshlrConfig;
const SAVED = { ...process.env };
let fake: FakeTypeSafe;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jev-sites-'));
  process.env['ASHLR_HOME'] = home;
  process.env[TYPESAFE_API_KEY_ENV] = FAKE_TYPESAFE_KEY;
  process.env['ASHLR_TYPESAFE_ENDPOINT'] = FAKE_TYPESAFE_ENDPOINT;
  delete process.env['ASHLR_JEV_DISABLE'];
  delete process.env['ASHLR_CLASSIFY_DISABLE'];
  clearDecisionCache();
  clearTaskClassMemo();
  resetLedgerCountersForTests();
  resetNeedsYouOrderingForTests();
  fake = installFakeTypeSafe();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  for (const k of ['ASHLR_HOME', TYPESAFE_API_KEY_ENV, 'ASHLR_TYPESAFE_ENDPOINT']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

const unkeyed = () => delete process.env[TYPESAFE_API_KEY_ENV];

// ---------------------------------------------------------------------------
// Operator intent
// ---------------------------------------------------------------------------

describe('classifyOperatorIntent', () => {
  const table: Array<[string, Parameters<typeof classifyOperatorIntentHeuristic>[1], OperatorIntent]> = [
    ["what's the status of the fleet?", {}, 'status-request'],
    ['/status', {}, 'status-request'],
    ['focus: charts polish this week', {}, 'directive'],
    ['from now on never touch the billing module', {}, 'directive'],
    ['2', { pendingQuestion: 'Which repo? 1) hub 2) plugin' }, 'answer'],
    ['the plugin one', { pendingQuestion: 'Which repo?' }, 'answer'],
    ['yes', { pendingApproval: true }, 'approval'],
    ['ship it', { pendingApproval: true }, 'approval'],
    ['no, stop', { pendingApproval: true }, 'veto'],
    ['veto', { pendingApproval: true }, 'veto'],
    ['fix the flaky login test in ashlr-hub', {}, 'task-request'],
    ['can you add dark mode to the usage view', {}, 'task-request'],
    ['thanks!', {}, 'chit-chat'],
    ['good morning', {}, 'chit-chat'],
  ];

  it.each(table)('heuristic: %j → %s', (text, ctx, expected) => {
    expect(classifyOperatorIntentHeuristic(text, ctx)).toBe(expected);
  });

  it('a bare "yes" with nothing pending is never an approval', () => {
    expect(classifyOperatorIntentHeuristic('yes', {})).not.toBe('approval');
  });

  it('unkeyed: the heuristic, no request', async () => {
    unkeyed();
    const d = await classifyOperatorIntent('what shipped today?', {}, { cfg });
    expect(d).toMatchObject({ value: 'status-request', path: 'fallback', reason: 'no-key' });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('Jev resolves what the regex ladder cannot (above 0.8)', async () => {
    fake.respond((req) => {
      expect(req.state).toContain('Operator message: the dashboard keeps double counting merges, sort it out');
      expect(Object.keys(req.questions)).toEqual(['intent']);
      return { intent: choice('task-request', 0.94) };
    });
    const d = await classifyOperatorIntent('the dashboard keeps double counting merges, sort it out', {}, { cfg });
    expect(d).toMatchObject({ value: 'task-request', path: 'jev', confidence: 0.94 });
  });

  it('Jev can never introduce an approval the deterministic reading did not see', async () => {
    fake.respond(() => ({ intent: choice('approval', 0.99) }));
    const d = await classifyOperatorIntent('sounds like a plan i guess, whatever you think', { pendingApproval: true }, { cfg });
    expect(d.value).not.toBe('approval');
    expect(d).toMatchObject({ path: 'fallback', reason: 'escalate-only', jevLabel: 'approval' });
  });

  it('Jev may turn an apparent approval into a veto (the cautious direction)', async () => {
    fake.respond(() => ({ intent: choice('veto', 0.97) }));
    const d = await classifyOperatorIntent('yes... actually no', { pendingApproval: true }, { cfg });
    expect(d).toMatchObject({ value: 'veto', path: 'jev' });
  });

  it('the pending context goes into the state (and so the cache key)', async () => {
    fake.answerAll({ pick: () => 'answer', confidence: 0.9 });
    await classifyOperatorIntent('the second', { pendingQuestion: 'Which repo?' }, { cfg });
    await classifyOperatorIntent('the second', {}, { cfg });
    expect(fake.fetch).toHaveBeenCalledTimes(2);
    expect(fake.calls[0]!.state).toContain("pending question: Which repo?");
  });
});

// ---------------------------------------------------------------------------
// Lane choice + Devin adapter
// ---------------------------------------------------------------------------

describe('chooseLane', () => {
  it('heuristic: protected → interactive, small → fleet, large → cloud, design → interactive', () => {
    expect(chooseLaneHeuristic({ title: 'anything', protectedPaths: true })).toBe('interactive');
    expect(chooseLaneHeuristic({ title: 'bump vitest to 4.1' })).toBe('fleet');
    expect(chooseLaneHeuristic({ title: 'Migrate the store to SQLite', githubRepo: true })).toBe('cloud');
    expect(chooseLaneHeuristic({ title: 'Decide how pricing tiers should work' })).toBe('interactive');
    expect(chooseLaneHeuristic({ title: 'Migrate the store', githubRepo: false })).toBe('fleet');
    expect(chooseLaneHeuristic({ title: 'bump deps' }, { available: { fleet: false } })).toBe('devin');
  });

  it('only available lanes are offered, and an unavailable answer is discarded', async () => {
    fake.respond((req) => {
      expect(Object.keys(req.questions['lane']!.criteria!)).toEqual(['fleet', 'devin']);
      return { lane: choice('cloud', 0.99) };
    });
    const d = await chooseLane({ title: 'Add CSV export to reports' }, { available: { cloud: false, interactive: false } }, { cfg });
    expect(d).toMatchObject({ path: 'fallback', reason: 'no-answer' });
    expect(['fleet', 'devin']).toContain(d.value);
  });

  it('a single open lane costs nothing', async () => {
    const d = await chooseLane({ title: 'x' }, { available: { cloud: false, devin: false, interactive: false } }, { cfg });
    expect(d.value).toBe('fleet');
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('Jev above 0.8 wins; below falls back', async () => {
    fake.respond(() => ({ lane: choice('devin', 0.91) }));
    expect(await chooseLane({ title: 'Fix off-by-one in pagination', repo: 'ashlrai/x' }, {}, { cfg })).toMatchObject({ value: 'devin', path: 'jev' });
    fake.respond(() => ({ lane: choice('devin', 0.7) }));
    const low = await chooseLane({ title: 'Fix off-by-one in the pager', repo: 'ashlrai/x' }, {}, { cfg });
    expect(low).toMatchObject({ path: 'fallback', reason: 'below-threshold' });
  });

  it('adviseDevinLane answers null whenever Jev fell back (the launcher heuristic stands)', async () => {
    unkeyed();
    const q = { itemId: 'b1', title: 'Fix login redirect', area: 'bug', repo: 'ashlrai/x', priority: 1, promptChars: 900 };
    expect(await adviseDevinLane(q, { cfg })).toBeNull();
    process.env[TYPESAFE_API_KEY_ENV] = FAKE_TYPESAFE_KEY;
    fake.respond((req) => {
      expect(Object.keys(req.questions['lane']!.criteria!)).not.toContain('interactive');
      return { lane: choice('fleet', 0.92) };
    });
    expect(await adviseDevinLane(q, { cfg })).toMatchObject({ lane: 'fleet', confidence: 0.92 });
  });
});

// ---------------------------------------------------------------------------
// Trigger triage
// ---------------------------------------------------------------------------

describe('triageTrigger', () => {
  const playbooks = [
    { id: 'flaky-test', when: 'A test fails intermittently.', keywords: ['flaky'] },
    { id: 'dep-bump', when: 'A dependency needs upgrading.', keywords: ['bump', 'dependabot'] },
  ];

  it('heuristic: questions and epics are not work; keywords pick a playbook', () => {
    expect(triageTriggerHeuristic({ source: 'issue', title: 'How do I configure X?', labels: ['question'] }).work).toBe(false);
    expect(triageTriggerHeuristic({ source: 'issue', title: 'Epic: rewrite the router' }).work).toBe(false);
    const t = triageTriggerHeuristic({ source: 'ci-failure', title: 'flaky: login.spec times out' }, { playbooks });
    expect(t).toMatchObject({ work: true, lane: 'fleet', playbook: 'flaky-test' });
  });

  it('asks work, lane and playbook in ONE call; accepts only when every part clears', async () => {
    fake.respond((req) => {
      expect(Object.keys(req.questions).sort()).toEqual(['lane', 'playbook', 'work']);
      expect(req.questions['playbook']!.criteria).toHaveProperty('none');
      return { work: noul(0.95), lane: choice('fleet', 0.9), playbook: choice('flaky-test', 0.88) };
    });
    const d = await triageTrigger({ source: 'ci-failure', title: 'login spec red about 1 run in 5' }, { playbooks }, { cfg });
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(d).toMatchObject({ path: 'jev', value: { work: true, lane: 'fleet', playbook: 'flaky-test', workProbability: 0.95 } });
    expect(d.confidence).toBeCloseTo(0.88);
  });

  it('an indecisive work Noul fails the whole decision (no half-Jev result)', async () => {
    fake.respond(() => ({ work: noul(0.6), lane: choice('cloud', 0.99), playbook: choice('none', 0.99) }));
    const d = await triageTrigger({ source: 'issue', title: 'Support SSO', body: 'Customers want SAML' }, { playbooks }, { cfg });
    expect(d).toMatchObject({ path: 'fallback', reason: 'below-threshold' });
    expect(d.value).toEqual(triageTriggerHeuristic({ source: 'issue', title: 'Support SSO', body: 'Customers want SAML' }, { playbooks }));
  });

  it('automations adapter: one call, raw per-part answers, leader-review ↔ interactive', async () => {
    fake.respond((req) => {
      expect(Object.keys(req.questions['lane']!.criteria!)).toEqual(['fleet', 'interactive']);
      expect(req.state).toContain('Title: Login page 500s');
      return { work: noul(0.1), lane: choice('interactive', 0.6), playbook: choice('flaky-test', 0.95) };
    });
    const a = await automationTriageDecider(
      { state: 'Login page 500s\n\nsince the deploy', lanes: ['fleet', 'leader-review'], playbooks: ['flaky-test'], minConfidence: 0.75 },
      { cfg },
    );
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    // Below the combined gate, but the engine gates each part itself — so the raw parts come back.
    expect(a).toEqual({ worth: 0.1, lane: { choice: 'leader-review', confidence: 0.6 }, playbook: { choice: 'flaky-test', confidence: 0.95 } });
    expect(readLedger().find((l) => l.kind === 'trigger-triage')).toMatchObject({ path: 'fallback', reason: 'below-threshold' });
  });

  it('automations adapter: unkeyed is unavailable (the engine keeps its rules path)', async () => {
    unkeyed();
    expect(await automationTriageDecider({ state: 'x', lanes: ['fleet'], playbooks: [] }, { cfg })).toEqual({ unavailable: 'no-key' });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('an unknown playbook id is no answer', async () => {
    fake.respond(() => ({ work: noul(0.99), lane: choice('fleet', 0.99), playbook: choice('rm-rf', 0.99) }));
    expect((await triageTrigger({ source: 'issue', title: 'x y z' }, { playbooks }, { cfg })).reason).toBe('no-answer');
  });
});

// ---------------------------------------------------------------------------
// Needs-you + interrupts
// ---------------------------------------------------------------------------

describe('Needs-you prioritization and interrupts', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const items: AttentionItem[] = [
    { id: 'info-1', title: 'Weekly digest ready', severity: 'info', since: '2026-09-27T11:00:00.000Z' },
    { id: 'warn-1', title: 'Owner-lane PR waiting', severity: 'warn', since: '2026-09-27T10:00:00.000Z' },
    { id: 'high-1', title: 'Approve risky merge', severity: 'high', since: '2026-09-27T09:00:00.000Z' },
    { id: 'info-2', title: 'Veto window closing', severity: 'info', expiresAt: '2026-09-27T12:30:00.000Z', since: '2026-09-27T08:00:00.000Z' },
  ];

  it('heuristic priority: expiring or high → now', () => {
    expect(needsYouPriorityHeuristic(items[2]!, now)).toBe('now');
    expect(needsYouPriorityHeuristic(items[3]!, now)).toBe('now');
    expect(needsYouPriorityHeuristic(items[0]!, now)).toBe('this-week');
  });

  it('one call ranks every item; severity bands are never crossed', async () => {
    fake.respond((req) => {
      expect(Object.keys(req.questions)).toEqual(['item_1', 'item_2', 'item_3', 'item_4']);
      return {
        item_1: choice('now', 0.95), // info digest "now" — may lead its band, never above warn/high
        item_2: choice('whenever', 0.95),
        item_3: choice('whenever', 0.95), // high stays first regardless
        item_4: choice('whenever', 0.95),
      };
    });
    const ranked = await prioritizeNeedsYou(items, { cfg, nowMs: now });
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(ranked.map((r) => r.item.id)).toEqual(['high-1', 'warn-1', 'info-1', 'info-2']);
    expect(ranked.every((r) => r.path === 'jev')).toBe(true);
  });

  it('the polled view never awaits: first call is deterministic, the next uses the background ranking', async () => {
    fake.respond(() => ({ item_1: choice('whenever', 0.95), item_2: choice('now', 0.95) }));
    const sorted = [items[3]!, items[0]!]; // both info
    expect(orderNeedsYouWithJev(sorted, now).map((i) => i.id)).toEqual(['info-2', 'info-1']);
    await vi.waitFor(() => expect(fake.fetch).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(orderNeedsYouWithJev(sorted, now).map((i) => i.id)).toEqual(['info-1', 'info-2']);
  });

  async function completeOrdering(sorted: readonly AttentionItem[], at: number, calls: number): Promise<void> {
    orderNeedsYouWithJev(sorted, at);
    await vi.waitFor(() => expect(fake.fetch).toHaveBeenCalledTimes(calls), { interval: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('unchanged low-confidence polls stay deterministic without paying again each minute', async () => {
    fake.answerAll({ confidence: 0.3 });
    const sorted = [items[2]!, items[1]!, items[3]!, items[0]!];
    await completeOrdering(sorted, now, 1);
    for (let minute = 1; minute < 15; minute++) {
      expect(orderNeedsYouWithJev(sorted, now + minute * 60_000)).toEqual(sorted);
    }
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(readLedger()).toHaveLength(4);
  });

  it('all-fallback answers retry at fifteen minutes and can recover to Jev ordering', async () => {
    const sorted = [items[3]!, items[0]!];
    fake.answerAll({ confidence: 0.3 });
    await completeOrdering(sorted, now, 1);
    fake.respond(() => ({ item_1: choice('whenever', 0.95), item_2: choice('now', 0.95) }));
    orderNeedsYouWithJev(sorted, now + 15 * 60_000 - 1);
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    await completeOrdering(sorted, now + 15 * 60_000, 2);
    expect(orderNeedsYouWithJev(sorted, now + 15 * 60_000).map((i) => i.id)).toEqual(['info-1', 'info-2']);
  });

  it('a cached winner refreshes when a deadline enters the immediate urgency band', async () => {
    const sorted = [{ ...items[0]!, expiresAt: new Date(now + 2 * 3_600_000 + 60_000).toISOString() }, items[3]!];
    fake.respond(() => ({ item_1: choice('whenever', 0.95), item_2: choice('now', 0.95) }));
    await completeOrdering(sorted, now, 1);
    expect(orderNeedsYouWithJev(sorted, now).map((i) => i.id)).toEqual(['info-2', 'info-1']);
    await completeOrdering(sorted, now + 60_000, 2);
  });

  it.each([
    { detail: 'A new consequential failure' },
    { blocking: true },
    { kind: 'approval' },
    { since: '2026-09-27T11:01:00.000Z' },
  ])('changed semantic facts invalidate the attempt immediately: %j', async (change) => {
    fake.answerAll({ confidence: 0.3 });
    const sorted = [items[0]!, items[3]!];
    await completeOrdering(sorted, now, 1);
    await completeOrdering([{ ...sorted[0]!, ...change }, sorted[1]!], now + 1, 2);
  });

  it.each(['network', 'timeout'])('%s failures retry after sixty seconds rather than the answer interval', async (failure) => {
    const sorted = [items[3]!, items[0]!];
    fake.respond(() => { throw failure === 'timeout' ? new DOMException('timed out', 'AbortError') : new Error('offline'); });
    await completeOrdering(sorted, now, 1);
    expect(readLedger().every((row) => row.reason === failure)).toBe(true);
    fake.answerAll({ confidence: 0.95 });
    expect(orderNeedsYouWithJev(sorted, now + 59_999)).toEqual(sorted);
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    await completeOrdering(sorted, now + 60_000, 2);
  });

  it('unkeyed ordering keeps the deterministic list and recovers after a minute', async () => {
    const sorted = [items[3]!, items[0]!];
    unkeyed();
    expect(orderNeedsYouWithJev(sorted, now)).toEqual(sorted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.env[TYPESAFE_API_KEY_ENV] = FAKE_TYPESAFE_KEY;
    fake.answerAll({ confidence: 0.95 });
    expect(orderNeedsYouWithJev(sorted, now + 59_999)).toEqual(sorted);
    expect(fake.fetch).not.toHaveBeenCalled();
    await completeOrdering(sorted, now + 60_000, 1);
  });

  it('the same signature has one background attempt even during repeated reads', async () => {
    fake.answerAll({ confidence: 0.3 });
    const sorted = [items[3]!, items[0]!];
    for (let i = 0; i < 50; i++) expect(orderNeedsYouWithJev(sorted, now)).toEqual(sorted);
    await vi.waitFor(() => expect(fake.fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(orderNeedsYouWithJev(sorted, now + 60_000)).toEqual(sorted);
    expect(fake.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounded LRU evicts the oldest of 129 signatures and retains recently read ones', async () => {
    fake.answerAll({ confidence: 0.3 });
    const list = (id: number) => [{ ...items[0]!, id: `attention-${id}`, title: `Attention item ${id}` }, items[3]!];
    for (let i = 0; i < 128; i++) await completeOrdering(list(i), now, i + 1);
    orderNeedsYouWithJev(list(0), now); // Keep zero recent; one is now oldest.
    await completeOrdering(list(128), now, 129);
    clearDecisionCache(); // Prove ordering-cache eviction independently of transport caching.
    expect(orderNeedsYouWithJev(list(0), now)).toEqual(list(0));
    expect(fake.fetch).toHaveBeenCalledTimes(129);
    await completeOrdering(list(1), now, 130);
  });

  it('a high or blocking item always interrupts, with no call', async () => {
    fake.respond(() => ({ interrupt: noul(0.01) }));
    const d = await worthInterrupting(items[2]!, { quietHours: true }, { cfg, nowMs: now });
    expect(d).toMatchObject({ value: true, path: 'fallback' });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('Jev may hold low-value noise, and needs a decisive Noul', async () => {
    fake.respond(() => ({ interrupt: noul(0.05) }));
    expect(await worthInterrupting(items[1]!, {}, { cfg, nowMs: now })).toMatchObject({ value: false, path: 'jev' });
    fake.respond(() => ({ interrupt: noul(0.55) }));
    const unsure = await worthInterrupting({ ...items[1]!, id: 'warn-2', title: 'Another PR' }, {}, { cfg, nowMs: now });
    expect(unsure).toMatchObject({ value: true, path: 'fallback', reason: 'below-threshold' });
  });
});

// ---------------------------------------------------------------------------
// Leader action class — advisory, escalate-only
// ---------------------------------------------------------------------------

describe('suggestActionClass', () => {
  it('can flag a stricter class', async () => {
    fake.respond(() => ({ action_class: choice('C', 0.93) }));
    const a = await suggestActionClass({ kind: 'budget.mode', summary: 'Raise budget mode to max' }, 'A', { cfg });
    expect(a).toMatchObject({ deterministic: 'A', suggested: 'C', stricter: true });
  });

  it('can never suggest loosening', async () => {
    fake.respond(() => ({ action_class: choice('A', 0.99) }));
    const a = await suggestActionClass({ kind: 'harness.adopt', summary: 'Adopt a new harness' }, 'B', { cfg });
    expect(a).toMatchObject({ suggested: 'B', stricter: false });
    expect(a.decision.reason).toBe('escalate-only');
  });

  it('class C is already strictest: no call', async () => {
    await suggestActionClass({ kind: 'escalate', summary: 'x' }, 'C', { cfg });
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task class — one label set, three vocabularies
// ---------------------------------------------------------------------------

describe('task class', () => {
  it('projects the unified label onto each persisted vocabulary', () => {
    expect([toSkillTaskClass('bug-fix'), toGoalCategory('bug-fix'), toRetroTaskKind('bug-fix')]).toEqual(['bug-fix', 'bugfix', 'fix']);
    expect([toSkillTaskClass('deps'), toGoalCategory('deps'), toRetroTaskKind('deps')]).toEqual(['dependency-update', 'chore', 'deps']);
    expect([toSkillTaskClass('other'), toGoalCategory('other'), toRetroTaskKind('other')]).toEqual(['general', 'other', 'other']);
  });

  it('unprimed, the sync classifiers are exactly their keyword tables', () => {
    expect(classifyGoal('Stop the dashboard from double-counting merges')).toBe('other');
    expect(classifyTaskKind('Stop the dashboard from double-counting merges')).toBe('other');
  });

  it('one batched priming call makes the sync classifiers see the typed label', async () => {
    const title = 'Stop the dashboard from double-counting merges';
    fake.respond(() => ({ item_1: choice('bug-fix', 1.0), item_2: choice('docs', 0.55) }));
    const accepted = await primeTaskClasses([title, 'Tidy up words', title], { cfg });
    expect(accepted).toBe(1);
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(peekTaskClass(title)).toBe('bug-fix');
    expect(classifyGoal(title)).toBe('bugfix');
    expect(classifyTaskKind(title)).toBe('fix');
    // Below the gate: nothing memoized, the table decides.
    expect(peekTaskClass('Tidy up words')).toBeUndefined();
    // Already asked texts are never paid for twice.
    await primeTaskClasses([title, 'Tidy up words'], { cfg });
    expect(fake.fetch).toHaveBeenCalledTimes(1);
  });

  it('labelTaskClass falls back to the unified heuristic when unkeyed', async () => {
    unkeyed();
    const d = await labelTaskClass('bump react to 19', { cfg });
    expect(d).toMatchObject({ value: 'deps', path: 'fallback' });
  });
});

// ---------------------------------------------------------------------------
// Retro root causes
// ---------------------------------------------------------------------------

describe('retro root-cause categories', () => {
  it('specific codes map by table, with no call', async () => {
    const out = await labelRetroRootCauses([
      { id: 'r1', rootCause: { code: 'verify:typecheck', label: 'Typecheck failed', detail: 'tsc' } },
      { id: 'r2', rootCause: { code: 'gate:diff-does-not-apply', label: 'Stale base', detail: '' } },
      { id: 'r3', rootCause: null },
    ], { cfg });
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(out.get('r1')).toMatchObject({ category: 'type-error', source: 'rule' });
    expect(out.get('r2')).toMatchObject({ category: 'stale-base', source: 'rule' });
    expect(out.has('r3')).toBe(false);
  });

  it('generic codes go to Jev in one call; below the gate the rule stands', async () => {
    fake.respond(() => ({ item_1: choice('missing-context', 0.9), item_2: choice('wrong-approach', 0.5) }));
    const out = await labelRetroRootCauses([
      { id: 'g1', happened: 'The task failed', rootCause: { code: 'fleet:failed', label: 'Run failed', detail: 'agent could not find the config loader' } },
      { id: 'g2', rootCause: { code: 'closed:by-fleet', label: 'Closed by the fleet', detail: 'request timed out waiting for CI' } },
    ], { cfg });
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(out.get('g1')).toMatchObject({ category: 'missing-context', source: 'jev' });
    expect(out.get('g2')).toMatchObject({ category: rootCauseCategoryHeuristic('closed:by-fleet', 'request timed out waiting for CI'), source: 'rule' });
    expect(out.get('g2')!.category).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// Verdict extraction
// ---------------------------------------------------------------------------

describe('verdict extraction', () => {
  const judgeAnswers = (verdict: string, conf = 0.95, dims = ['4', '5', '4', '4']) => ({
    states_verdict: noul(0.97),
    verdict: choice(verdict, conf),
    value: choice(dims[0]!, conf),
    correctness: choice(dims[1]!, conf),
    scope: choice(dims[2]!, conf),
    alignment: choice(dims[3]!, conf),
  });

  it('extracts a stated rubric in one call', async () => {
    fake.respond((req) => {
      expect(Object.keys(req.questions).sort()).toEqual(['alignment', 'correctness', 'scope', 'states_verdict', 'value', 'verdict']);
      return judgeAnswers('review');
    });
    const d = await extractJudgeRubric('Overall I would send this to review. Value 4 correctness 5 scope 4 alignment 4. RATIONALE: good but touches auth', { cfg });
    expect(d).toMatchObject({ path: 'jev', value: { verdict: 'review', value: 4, correctness: 5, scope: 4, alignment: 4, rationale: 'good but touches auth' } });
  });

  it('never invents a ship: the word must be in the reply and the rubric must allow it', async () => {
    fake.respond(() => judgeAnswers('ship'));
    expect((await extractJudgeRubric('Looks great, merge it. 4/5/4/4', { cfg })).value).toBeNull();
    fake.respond(() => judgeAnswers('ship', 0.95, ['2', '5', '4', '4']));
    expect((await extractJudgeRubric('ship it — value 2', { cfg })).value).toBeNull();
    fake.respond(() => judgeAnswers('ship'));
    expect((await extractJudgeRubric("I would not ship this yet. value 4, correctness 5", { cfg })).value).toBeNull();
    fake.respond(() => judgeAnswers('ship'));
    expect((await extractJudgeRubric('VERDICT: ship. value 4, correctness 5', { cfg })).value).toMatchObject({ verdict: 'ship' });
  });

  it('a reply that states no verdict, or a sub-0.9 answer, is no extraction', async () => {
    fake.respond(() => ({ ...judgeAnswers('review'), states_verdict: noul(0.2) }));
    expect((await extractJudgeRubric('I was cut off mid', { cfg })).path).toBe('fallback');
    fake.respond(() => judgeAnswers('review', 0.85));
    expect((await extractJudgeRubric('probably review?', { cfg })).reason).toBe('below-threshold');
  });

  it('taste: verdict + axes', async () => {
    fake.respond(() => ({ states_verdict: noul(0.9), verdict: choice('gold', 0.96), alignment: choice('5', 0.96), ambition: choice('4', 0.96), design: choice('5', 0.96) }));
    expect((await extractTasteScore('An exemplary change: gold.', { cfg })).value).toEqual({ verdict: 'gold', alignment: 5, ambition: 4, design: 5 });
  });

  it('red team is escalate-only: it can add a finding, never report "none" over a fallback', async () => {
    fake.respond(() => ({ severity: choice('high', 0.95) }));
    expect(await extractRedTeamSeverity('This leaks the session token to logs.', { cfg })).toMatchObject({ value: 'high', path: 'jev' });
    unkeyed();
    expect(await extractRedTeamSeverity('whatever', { cfg })).toMatchObject({ value: 'none', path: 'fallback' });
  });
});

// ---------------------------------------------------------------------------
// Contract check: the multi-model labeller (#547) against the REAL layer
// ---------------------------------------------------------------------------

describe('multimodel labelPrompt through the real decide()', () => {
  it('its lazy loader resolves this module, and its own vocabulary is interpreted on its side', async () => {
    const { loadDecide, labelPrompt, resetLabelCacheForTest } = await import('../src/core/verse/multimodel/label.js');
    resetLabelCacheForTest();
    const decideFn = await loadDecide();
    expect(decideFn).toBeTypeOf('function');
    fake.respond((req) => {
      expect(Object.keys(req.questions).sort()).toEqual(['complexity', 'needs_frontier', 'task_class']);
      return { task_class: choice('review', 0.94), complexity: choice('high', 0.94), needs_frontier: noul(0.83) };
    });
    const out = await labelPrompt('please take a careful look at this diff before I merge it', { decide: decideFn! });
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(out.classification).toMatchObject({ kind: 'review', decidedBy: 'jev' });
    expect(readLedger().find((l) => l.kind === 'task-class')).toMatchObject({ path: 'jev', called: true });
  });
});

// ---------------------------------------------------------------------------
// Ledger coverage across sites
// ---------------------------------------------------------------------------

it('every wired kind lands in the ledger under its own kind', async () => {
  fake.answerAll({ confidence: 0.99, noul: 0.99 });
  await classifyOperatorIntent('status please?', {}, { cfg });
  await chooseLane({ title: 'Fix a bug in pager' }, {}, { cfg });
  await labelTaskClass('Fix a crash', { cfg });
  const kinds = new Set(readLedger().map((l) => l.kind));
  expect([...kinds].sort()).toEqual(['lane-choice', 'operator-intent', 'task-class']);
});
