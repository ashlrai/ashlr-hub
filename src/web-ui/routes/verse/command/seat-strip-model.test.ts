/**
 * Command's seat strip (audit 14 + 20): one compact item per seat, worded by
 * the SAME capacity projection the rail reads, with the budget route adding
 * only autonomy eligibility — and "Status unknown" when the two disagree.
 */
import { describe, expect, it } from 'vitest';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import type { VerseSeat } from '../../../data/api-types.js';
import { CLAUDE_MAX_SEAT, GROK_SEAT, LOCAL_SEAT_V2 } from '../seat-fixtures.test-support.js';
import { bindingLeftPercent } from '../usage/binding-left.js';
import { buildCapacityRows } from '../usage/capacity-strip-model.js';
import { seatAutonomy, seatStrip, stripColumns } from './seat-strip-model.js';

const NOW = Date.parse('2026-09-21T12:00:00Z');

type Head = BudgetView['headroom'][number];

function budget(seats: Array<{ id: string; label: string; engine: 'claude' | 'codex' | 'grok' | 'local'; free?: boolean; eligible: boolean; enabled?: boolean; reserve?: number; reason?: string; head?: Partial<Head> }>): BudgetView {
  return {
    mode: 'balanced',
    seats: {},
    updatedAt: new Date(NOW - 60_000).toISOString(),
    headroom: seats.map((s) => ({
      seatId: s.id,
      sessionUsedPercent: null,
      weeklyUsedPercent: s.free ? null : 10,
      bindingWindow: s.free ? null : 'weekly',
      autonomyHeadroomPercent: null,
      resetAt: null,
      eligibleForAutonomy: s.eligible,
      reasons: s.reason ? [s.reason] : [],
      ...s.head,
    })),
    seatInfo: seats.map((s) => ({ seatId: s.id, label: s.label, engine: s.engine, free: s.free ?? false })),
    effective: Object.fromEntries(seats.map((s) => [s.id, { seatId: s.id, enabled: s.enabled ?? true, reservePercent: s.reserve ?? 0 }])),
    readingMaxAgeMs: 600_000,
    sampledAt: new Date(NOW - 30_000).toISOString(),
  } as BudgetView;
}

function strip(seats: VerseSeat[], view: BudgetView | null, opts: { health?: SeatHealthReport[] | null } = {}) {
  const health = opts.health === undefined ? [] : opts.health;
  const rows = buildCapacityRows(seats, { health, budget: view, now: NOW });
  return seatStrip({ rows, budget: view, healthRead: health !== null, now: NOW });
}

const LOCAL_UNREAD: VerseSeat = { ...LOCAL_SEAT_V2, health: { state: 'unknown', summary: null, windows: [], observedAt: null } };

describe('seatStrip', () => {
  it('says what is left of the binding window, its reset, and the router\'s verdict — the rail\'s numbers', () => {
    const view = budget([{ id: 'grok', label: 'Grok', engine: 'grok', eligible: true, reserve: 40, reason: '69% of the weekly window is free for autonomy' }]);
    const { items, headline } = strip([GROK_SEAT], view);
    const [grok] = items;
    const rows = buildCapacityRows([GROK_SEAT], { health: [], budget: view, now: NOW });
    expect(grok).toMatchObject({ key: 'grok', engine: 'grok', name: 'Grok', level: 'ok', value: '99% left', reservePercent: 40 });
    // The same projection as the rail's battery, by construction.
    expect(grok!.leftPercent).toBe(bindingLeftPercent(rows[0]!));
    expect(grok!.note).toMatch(/^resets /);
    expect(grok!.autonomy).toEqual({ kind: 'eligible', word: 'Eligible', why: '69% of the weekly window is free for autonomy.' });
    expect(grok!.spoken).toContain('Grok: 99% left');
    expect(grok!.spoken).toContain('Autonomy: Eligible');
    expect(headline).toBe('1 of 1 account usable');
  });

  it('keeps the provider\'s own reset words, led once by "resets"', () => {
    const { items } = strip([CLAUDE_MAX_SEAT], budget([{ id: 'claude', label: 'Claude Max', engine: 'claude', eligible: false, reason: 'weekly window exhausted' }]));
    const [claude] = items;
    expect(claude).toMatchObject({ level: 'out', value: 'Spent', leftPercent: 0 });
    expect(claude!.note).toBe('resets Sep 25 at 7pm (America/New_York)');
    expect(claude!.autonomy).toMatchObject({ kind: 'held', word: 'Held back' });
  });

  // Audit 20: the rail said "readiness not reported" while Command said "Takes autonomous work".
  it('says "Status unknown" when the router calls a seat eligible but readiness was never reported', () => {
    const view = budget([{ id: LOCAL_SEAT_V2.id, label: 'Qwen3 Coder (local)', engine: 'local', free: true, eligible: true, reason: 'local: free, no provider window' }]);
    const [local] = strip([LOCAL_UNREAD], view).items;
    expect(local).toMatchObject({ engine: 'local', value: '—', level: 'unknown', status: 'Not checked' });
    expect(local!.autonomy.kind).toBe('conflict');
    expect(local!.autonomy.word).toBe('Status unknown');
    expect(local!.autonomy.why).toBe('The router lists it as eligible for autonomy, but its readiness check says: Not checked — readiness not reported yet.');
    expect(local!.spoken).not.toMatch(/Takes autonomous work/);
  });

  it('says "Status unknown" for a spent seat the router still lists as eligible', () => {
    const [claude] = strip([CLAUDE_MAX_SEAT], budget([{ id: 'claude', label: 'Claude Max', engine: 'claude', eligible: true }])).items;
    expect(claude!.autonomy).toMatchObject({ kind: 'conflict', word: 'Status unknown' });
    expect(claude!.autonomy.why).toContain('Spent');
  });

  it('a ready local runtime is free, not a percentage, and eligible without a conflict', () => {
    const view = budget([{ id: LOCAL_SEAT_V2.id, label: 'Qwen3 Coder (local)', engine: 'local', free: true, eligible: true }]);
    const [local] = strip([LOCAL_SEAT_V2], view).items;
    expect(local).toMatchObject({ value: 'Free', note: 'Runs on this machine', leftPercent: null, level: 'ok', status: 'Ready' });
    expect(local!.autonomy.kind).toBe('eligible');
  });

  it('folds several local tags into one item and takes eligibility from any of them', () => {
    const second: VerseSeat = { ...LOCAL_SEAT_V2, id: 'local:llama', label: 'Llama (local)' };
    const view = budget([
      { id: LOCAL_SEAT_V2.id, label: 'Qwen', engine: 'local', free: true, eligible: false, enabled: false },
      { id: second.id, label: 'Llama', engine: 'local', free: true, eligible: true },
    ]);
    const { items } = strip([LOCAL_SEAT_V2, second], view);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'local', name: 'Local models (2)', value: 'Free' });
    expect(items[0]!.autonomy.kind).toBe('eligible');
  });

  it('is not a conflict while the health sweep has not answered yet — it is still being checked', () => {
    const view = budget([{ id: LOCAL_SEAT_V2.id, label: 'Qwen', engine: 'local', free: true, eligible: true }]);
    const [local] = strip([LOCAL_UNREAD], view, { health: null }).items;
    expect(local).toMatchObject({ status: 'Checking…', note: 'Checking…' });
    expect(local!.autonomy.kind).toBe('eligible');
  });

  it('orders usable seats first, as Apps & Accounts and the drawer do', () => {
    const view = budget([
      { id: 'claude', label: 'Claude Max', engine: 'claude', eligible: false },
      { id: 'grok', label: 'Grok', engine: 'grok', eligible: true },
    ]);
    expect(strip([CLAUDE_MAX_SEAT, GROK_SEAT], view).items.map((i) => i.key)).toEqual(['grok', 'claude']);
  });

  it('says the budget did not report a seat rather than inventing a verdict', () => {
    const [grok] = strip([GROK_SEAT], null).items;
    expect(grok!.autonomy).toEqual({ kind: 'none', word: 'Not reported', why: null });
  });

  it('falls back to the budget route\'s seat list before the roster loads — readiness unknown, never assumed', () => {
    const view = budget([
      { id: 'grok-a', label: 'Grok (grok-a)', engine: 'grok', eligible: true, head: { weeklyUsedPercent: 31, resetAt: new Date(NOW + 3_600_000).toISOString() } },
      { id: 'local-qwen', label: 'Local Qwen', engine: 'local', free: true, eligible: true },
    ]);
    const { items, headline } = seatStrip({ rows: [], budget: view, healthRead: true, now: NOW });
    expect(headline).toBe('Seat roster not loaded — readiness unknown');
    expect(items.map((i) => [i.name, i.value, i.status])).toEqual([
      ['Grok (grok-a)', '69% left', 'Readiness not reported'],
      ['Local Qwen', '—', 'Readiness not reported'],
    ]);
    expect(items[0]!.note).toMatch(/^resets /);
    expect(seatStrip({ rows: [], budget: null, healthRead: false, now: NOW }).items).toEqual([]);
  });
});

describe('stripColumns', () => {
  it('keeps every row full: one line when the seats fit, balanced rows otherwise', () => {
    expect([1, 2, 3, 4, 5].map((n) => stripColumns('wide', n))).toEqual([1, 2, 3, 4, 5]);
    expect(stripColumns('wide', 6)).toBe(3);
    expect(stripColumns('wide', 8)).toBe(4);
    // Four seats at ~900px: 2 x 2, never 3 + a lonely 1.
    expect([1, 2, 3, 4, 5, 6].map((n) => stripColumns('medium', n))).toEqual([1, 2, 3, 2, 3, 3]);
    expect(stripColumns('compact', 4)).toBe(1);
    expect(stripColumns('wide', 0)).toBe(1);
  });
});

describe('seatAutonomy', () => {
  const status = (kind: 'usable' | 'unavailable', label: string) =>
    ({ kind, label, detail: null, tone: 'neutral', usableAgain: null, checked: null, checkedTitle: null, coversConnection: false }) as const;

  it('trusts the router when readiness agrees, and adds its reason as a sentence', () => {
    expect(seatAutonomy({ status: 'held', why: 'above the 70% ceiling' }, status('usable', 'Connected'), true)).toEqual({ kind: 'held', word: 'Held back', why: 'above the 70% ceiling.' });
    expect(seatAutonomy({ status: 'off', why: '' }, status('usable', 'Connected'), true)).toEqual({ kind: 'off', word: 'Off', why: null });
  });

  it('never calls an offline seat eligible', () => {
    expect(seatAutonomy({ status: 'eligible', why: 'free' }, status('unavailable', 'Not running'), true)).toMatchObject({ kind: 'conflict', word: 'Status unknown' });
  });
});
