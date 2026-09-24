/**
 * 3.10 review fixes for the Leader action store (review 310 c7, d3, d5):
 *   - c7: apply and veto settle a row by compare-and-set under the store
 *     lock. A veto that lands while an apply is in flight is never
 *     overwritten, and the applier undoes the change it just made; two
 *     tickers never apply one action twice; a claim left by a dead process is
 *     settled from the ledger, never re-applied.
 *   - d3: an over-size or garbled actions.json is never read as empty and
 *     written back: over-size files are archived and compacted, garbled ones
 *     renamed aside, and a transient read failure writes nothing. Writes keep
 *     the file under a byte budget below the read cap.
 *   - d5: goal inverses carry ids + digests + prior status, never whole goal
 *     records, so a 10-goal reorder fits the 64 KB ledger line and a veto
 *     still restores every goal byte-for-byte from the local snapshot.
 *
 * Hermetic: tmp HOME, fake ledger, real goal store. No seat is prompted.
 */
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDueLeaderActions,
  dismissNeedsYouItem,
  dismissedNeedsYouIds,
  enactLeaderActions,
  findStoredAction,
  leaderActionsPath,
  listLeaderActions,
  readLeaderDirectives,
  vetoLeaderAction,
  type LeaderApplyDeps,
} from '../src/core/vision/leader-apply.js';
import { actionIdFor, leaderRoot, type AnyLeaderActionDraft } from '../src/core/vision/leader-memo.js';
import type { LeaderAction } from '../src/core/vision/leader-types.js';
import * as goalsStore from '../src/core/goals/store.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../src/core/verse/preferences.js';
import { fakeLedger, makeApplyDeps, useTmpHome, type FakeLedger } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
let ledger: FakeLedger;
let savedTz: string | undefined;

beforeEach(() => {
  home.setup();
  ledger = fakeLedger();
  savedTz = process.env['TZ'];
  process.env['TZ'] = 'UTC';
});

afterEach(() => {
  home.teardown();
  if (savedTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = savedTz;
});

const MEMO = 'lm-20260924120000-abcdef';
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const AFTER_WINDOW = NOW + 31 * 60_000;
const idFor = (i: number): string => actionIdFor(MEMO, i);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function draft<K extends AnyLeaderActionDraft['kind']>(kind: K, params: Extract<AnyLeaderActionDraft, { kind: K }>['params']): AnyLeaderActionDraft {
  return { kind, params, summary: `${kind} test`, why: 'because the data says so' } as AnyLeaderActionDraft;
}

function statusesFor(id: string): string[] {
  return ledger.rows('leader:action').filter((r) => r.id === id).map((r) => r.status);
}

/** Edit actions.json in place (what another process's write looks like). */
function editStore(fn: (store: { actions: { action: LeaderAction; restore: unknown[]; claim?: unknown }[] } & Record<string, unknown>) => void): void {
  const store = JSON.parse(readFileSync(leaderActionsPath(), 'utf8'));
  fn(store);
  writePrivateFileAtomic(leaderActionsPath(), `${JSON.stringify(store)}\n`);
}

async function scheduleGrokB(deps: LeaderApplyDeps): Promise<LeaderAction> {
  const [b] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 3 })], [], { idFor });
  expect(b).toMatchObject({ class: 'B', status: 'scheduled' });
  return b!;
}

describe('apply vs veto: compare-and-set on the action row (review 310 c7)', () => {
  it('a veto that lands while the apply is reading the ledger wins: the change is undone and the veto is not overwritten', async () => {
    let now = NOW;
    const { deps: base } = makeApplyDeps({ ledger, now: () => now });
    const b = await scheduleGrokB(base);
    now = AFTER_WINDOW;
    let veto: Awaited<ReturnType<typeof vetoLeaderAction>> | null = null;
    // Mason hits Veto at 29:59 while the daemon's tick is inside ledgerRowFor.
    const deps: LeaderApplyDeps = {
      ...base,
      readLedger: async (opts) => {
        if (!veto) veto = await vetoLeaderAction(base, b.id, 'not tonight');
        return base.readLedger(opts);
      },
    };
    const [out] = await applyDueLeaderActions(deps);
    expect(veto!.ok).toBe(true);
    expect(veto!.records[0]!.detail).toMatch(/while it was being applied/);
    expect(out).toMatchObject({ id: b.id, status: 'vetoed', vetoNote: 'not tonight' });
    // Before the fix: grokLanes 3 stood and the store said `applied`.
    expect(readLeaderDirectives()).toBeNull();
    expect(findStoredAction(b.id)?.action.status).toBe('vetoed');
    // The ledger records what happened, and its last word is the veto.
    expect(statusesFor(b.id)).toContain('applied');
    expect(statusesFor(b.id).at(-1)).toBe('vetoed');
    expect(ledger.rows('leader:vetoed').at(-1)).toMatchObject({ actionId: b.id, restored: true });
  });

  it('two tickers (daemon + CLI / comms) apply a due action exactly once', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    const b = await scheduleGrokB(deps);
    now = AFTER_WINDOW;
    const [first, second] = await Promise.all([applyDueLeaderActions(deps), applyDueLeaderActions(deps)]);
    const applied = [...first, ...second].filter((a) => a.status === 'applied');
    expect(applied).toHaveLength(1);
    expect(statusesFor(b.id).filter((s) => s === 'applied')).toHaveLength(1);
    expect(readLeaderDirectives()?.grokLanes).toBe(3);
    expect(findStoredAction(b.id)?.claim ?? null).toBeNull();
    // A later veto restores the ORIGINAL state (no second `before` recorded from the post-first state).
    const veto = await vetoLeaderAction(deps, b.id, null);
    expect(veto.records[0]!.restored).toBe(true);
    expect(readLeaderDirectives()).toBeNull();
  });

  it('a claim left by a dead process is settled, never re-applied', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    const b = await scheduleGrokB(deps);
    now = AFTER_WINDOW;
    editStore((store) => {
      store.actions[0]!.claim = { op: 'apply', token: 'dead-process', at: new Date(AFTER_WINDOW - 11 * 60_000).toISOString() };
    });
    const [settled] = await applyDueLeaderActions(deps);
    expect(settled).toMatchObject({ id: b.id, status: 'failed' });
    expect(settled!.statusReason).toMatch(/interrupted/);
    expect(readLeaderDirectives()).toBeNull();
    expect(statusesFor(b.id)).not.toContain('applied');
    expect(await applyDueLeaderActions(deps)).toEqual([]);
  });

  it('a dead claim whose change the ledger recorded is brought back as applied (so it can still be vetoed)', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    const b = await scheduleGrokB(deps);
    now = AFTER_WINDOW;
    ledger.append({ kind: 'leader:action', data: { ...b, status: 'applied', appliedAt: new Date(now).toISOString(), inverse: { op: 'restore-directives', before: null } } as LeaderAction, actor: 'leader', grantId: null, repo: null });
    editStore((store) => {
      store.actions[0]!.claim = { op: 'apply', token: 'dead-process', at: new Date(AFTER_WINDOW - 11 * 60_000).toISOString() };
    });
    const [settled] = await applyDueLeaderActions(deps);
    expect(settled).toMatchObject({ id: b.id, status: 'applied' });
    expect(findStoredAction(b.id)?.action.status).toBe('applied');
  });

  it('a live claim held by another ticker is skipped, not applied again', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    const b = await scheduleGrokB(deps);
    now = AFTER_WINDOW;
    editStore((store) => {
      store.actions[0]!.claim = { op: 'apply', token: 'other-ticker', at: new Date(AFTER_WINDOW - 60_000).toISOString() };
    });
    expect(await applyDueLeaderActions(deps)).toEqual([]);
    expect(readLeaderDirectives()).toBeNull();
    expect(findStoredAction(b.id)?.action.status).toBe('scheduled');
  });

  it('a second veto of an applied action while the first is undoing it is refused (the inverse never runs twice)', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const [a] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 1 })], [], { idFor });
    expect(a!.status).toBe('applied');
    editStore((store) => {
      store.actions[0]!.claim = { op: 'veto', token: 'first-veto', at: new Date(NOW).toISOString() };
    });
    const second = await vetoLeaderAction(deps, a!.id, null);
    expect(second).toMatchObject({ ok: false, code: 409 });
    expect(second.message).toMatch(/already running/);
    expect(readLeaderDirectives()?.grokLanes).toBe(1);
  });
});

describe('the action store is never read as empty and written back (review 310 d3)', () => {
  function bigApplied(i: number, bytes: number): { action: LeaderAction; restore: unknown[] } {
    const record = JSON.stringify({ id: `g-${i}`, status: 'active', notes: 'n'.repeat(bytes) });
    const action = {
      v: 1, id: `la-old-${i}`, memoId: 'lm-old', kind: 'goal.pause', class: 'A', params: { goalId: `g-${i}`, until: null },
      summary: 'old', why: 'old', createdAt: '2026-08-01T00:00:00.000Z', applyAfter: '2026-08-01T00:00:00.000Z',
      deferredForQuietHours: false, status: 'applied', statusReason: null, appliedAt: '2026-08-01T00:00:00.000Z',
      vetoedAt: null, vetoNote: null,
      // A pre-3.10.1 row: the whole goal twice (inverse + snapshot).
      inverse: { op: 'restore-goals', before: [{ goalId: `g-${i}`, record }] },
    } as unknown as LeaderAction;
    return { action, restore: [{ target: `g-${i}`, existed: true, before: record, afterSha: null }] };
  }

  it('an over-size store is recovered (archived, compacted), and the scheduled action and dismissals survive a write', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    const b = await scheduleGrokB(deps);
    dismissNeedsYouItem('q-kept');
    editStore((store) => {
      const old = Array.from({ length: 20 }, (_, i) => bigApplied(i, 240 * 1024));
      store.actions = [...old, ...store.actions];
    });
    const original = readFileSync(leaderActionsPath(), 'utf8');
    expect(statSync(leaderActionsPath()).size).toBeGreaterThan(8 * 1024 * 1024);

    // Readers see the real rows, not an empty store.
    expect(listLeaderActions(100).some((a) => a.id === b.id)).toBe(true);
    // Before the fix this write replaced the file with {actions: [], dismissed: ['q-new']}.
    dismissNeedsYouItem('q-new');
    expect(statSync(leaderActionsPath()).size).toBeLessThanOrEqual(6 * 1024 * 1024);
    expect(findStoredAction(b.id)?.action.status).toBe('scheduled');
    expect([...dismissedNeedsYouIds()].sort()).toEqual(['q-kept', 'q-new']);
    const archives = readdirSync(leaderRoot()).filter((f) => f.startsWith('actions.oversize-'));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(leaderRoot(), archives[0]!), 'utf8')).toBe(original);
    // Compacted rows keep only digests of goal bytes.
    const stored = JSON.parse(readFileSync(leaderActionsPath(), 'utf8')) as { actions: { action: LeaderAction }[] };
    for (const s of stored.actions) {
      if (s.action.inverse?.op === 'restore-goals') expect(s.action.inverse.before.every((x) => x.record === null && typeof x.recordSha256 === 'string')).toBe(true);
    }
    // And the scheduled class-B action still applies after its window.
    now = AFTER_WINDOW;
    const [applied] = await applyDueLeaderActions(deps);
    expect(applied).toMatchObject({ id: b.id, status: 'applied' });
  }, 30_000);

  it('a garbled store is renamed aside (kept byte-exact), never overwritten in place', () => {
    ensurePrivateDirectory(leaderRoot());
    writeFileSync(leaderActionsPath(), '{"v":1,"actions":[{"broken"', { mode: 0o600 });
    dismissNeedsYouItem('q-1');
    const archives = readdirSync(leaderRoot()).filter((f) => f.startsWith('actions.unreadable-'));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(leaderRoot(), archives[0]!), 'utf8')).toBe('{"v":1,"actions":[{"broken"');
    expect([...dismissedNeedsYouIds()]).toEqual(['q-1']);
  });

  it.skipIf(isRoot)('a store that cannot be read right now refuses the write and is left intact', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    await scheduleGrokB(deps);
    const before = readFileSync(leaderActionsPath(), 'utf8');
    chmodSync(leaderActionsPath(), 0o000);
    try {
      expect(() => dismissNeedsYouItem('q-1')).toThrow(/could not be read.*nothing was written/);
    } finally {
      chmodSync(leaderActionsPath(), 0o600);
    }
    expect(readFileSync(leaderActionsPath(), 'utf8')).toBe(before);
    expect(readdirSync(leaderRoot()).filter((f) => f.startsWith('actions.unreadable-'))).toEqual([]);
  });
});

describe('goal inverses stay under the ledger line cap (review 310 d5)', () => {
  const LINE_CAP = 64 * 1024;

  function capLedger(): void {
    const append = ledger.append.bind(ledger);
    ledger.append = ((input) => {
      // What authority/ledger.ts writeEntry enforces (LEDGER_MAX_LINE_BYTES).
      if (Buffer.byteLength(JSON.stringify(input.data), 'utf8') > LINE_CAP - 512) return { ok: false, reason: `ledger entry is larger than ${LINE_CAP} bytes` };
      return append(input);
    }) as FakeLedger['append'];
  }

  function bigGoals(n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const g = goalsStore.createGoal(`Large goal number ${i}`, { now: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
      goalsStore.addMilestone(g.id, { title: 'm1', detail: `detail ${i} `.repeat(900) });
      goalsStore.addMilestone(g.id, { title: 'm2', detail: `more ${i} `.repeat(900) });
      ids.push(g.id);
    }
    return ids;
  }

  const goalPath = (id: string): string => join(home.home(), '.ashlr', 'goals', `${id}.json`);

  it('a 10-goal reorder of large goals applies (not auto-undone) and its veto restores every goal byte-for-byte', async () => {
    capLedger();
    const ids = bigGoals(10);
    const befores = ids.map((id) => readFileSync(goalPath(id), 'utf8'));
    expect(befores.reduce((n, b) => n + b.length, 0)).toBeGreaterThan(LINE_CAP * 2);
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const [a] = await enactLeaderActions(deps, MEMO, [draft('goal.reorder', { goalIds: [...ids].reverse() })], [], { idFor });
    // Before the fix: failed, "The ledger did not record the change, so it was undone".
    expect(a).toMatchObject({ status: 'applied' });
    const row = ledger.rows('leader:action').find((r) => r.id === a!.id && r.status === 'applied')!;
    expect(Buffer.byteLength(JSON.stringify(row), 'utf8')).toBeLessThan(8 * 1024);
    expect(JSON.stringify(row)).not.toContain('detail 0');
    expect(row.inverse).toMatchObject({ op: 'restore-goals' });

    const veto = await vetoLeaderAction(deps, a!.id, null);
    expect(veto.records[0]).toMatchObject({ restored: true });
    ids.forEach((id, i) => expect(readFileSync(goalPath(id), 'utf8')).toBe(befores[i]));
    expect(Buffer.byteLength(JSON.stringify(ledger.rows('leader:vetoed').at(-1)), 'utf8')).toBeLessThan(8 * 1024);
  }, 30_000);

  it('a tampered local snapshot is not restored (digest mismatch): the veto puts back the status only', async () => {
    const g = goalsStore.createGoal('Tamper target', { now: '2026-09-01T00:00:00.000Z' });
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const [a] = await enactLeaderActions(deps, MEMO, [draft('goal.pause', { goalId: g.id, until: null })], [], { idFor });
    expect(a!.status).toBe('applied');
    editStore((store) => {
      const s = store.actions.find((x) => x.action.id === a!.id)!;
      (s.restore[0] as { before: string }).before = JSON.stringify({ ...goalsStore.loadGoal(g.id), objective: 'SMUGGLED', status: 'active' });
    });
    const veto = await vetoLeaderAction(deps, a!.id, null);
    expect(veto.records[0]).toMatchObject({ restored: false });
    const after = goalsStore.loadGoal(g.id)!;
    expect(after.objective).toBe('Tamper target');
    expect(after.status).toBe('planning');
    expect(existsSync(goalPath(g.id))).toBe(true);
  });
});
