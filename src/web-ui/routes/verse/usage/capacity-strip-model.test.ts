/**
 * capacity-strip-model.test.ts — the ONE projection behind every capacity
 * view (SPEC-310C §4), against Mason's real roster shapes (seat-fixtures).
 * Pinned where it would otherwise mislead: an unread seat counted as usable
 * or blocked, a flagged limit given a percentage, a reserve invented for a
 * free seat, twelve identical local rows, a scarcest-seat ring drawn from a
 * seat nobody measured.
 */
import { describe, expect, it } from 'vitest';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import {
  CLAUDE_MAX_SEAT,
  CLAUDE_TIGHT_SEAT,
  CODEX_CREDITS_SEAT,
  GROK_SEAT,
  LOCAL_SEAT_V2,
  UNREAD_SEAT,
} from '../seat-fixtures.test-support.js';
import {
  buildCapacityRows,
  capacityHeadline,
  capacityRowFor,
  readBudgetRows,
  readHealthReports,
  scarcestSeat,
  windowSentence,
} from './capacity-strip-model.js';

const CLAUDE = { ...CLAUDE_TIGHT_SEAT, id: 'claude-a', accountId: 'claude-a' };

function report(seatId: string, over: Partial<SeatHealthReport> = {}): SeatHealthReport {
  return {
    seatId,
    engine: 'claude',
    connection: 'connected',
    checkedAt: '2026-09-24T10:00:00.000Z',
    cliVersion: null,
    newestCliVersion: null,
    credentialExpiresAt: null,
    lastRefreshAt: null,
    resetAt: null,
    reasons: [],
    fix: { kind: 'none' },
    ...over,
  };
}

function budget(): BudgetView {
  return {
    mode: 'balanced',
    seats: {},
    updatedAt: '2026-09-24T10:00:00.000Z',
    headroom: [
      { seatId: 'claude-a', sessionUsedPercent: 15, weeklyUsedPercent: 85, bindingWindow: 'weekly', autonomyHeadroomPercent: 0, resetAt: null, eligibleForAutonomy: false, reasons: ['Weekly window is past the 60% ceiling.'] },
      { seatId: 'grok', sessionUsedPercent: null, weeklyUsedPercent: 1, bindingWindow: 'weekly', autonomyHeadroomPercent: 99, resetAt: null, eligibleForAutonomy: true, reasons: ['Room left.'] },
    ],
    seatInfo: [
      { seatId: 'claude-a', label: 'Claude Max', engine: 'claude', free: false },
      { seatId: 'codex-personal', label: 'Personal Codex', engine: 'codex', free: false },
      { seatId: 'grok', label: 'Grok', engine: 'grok', free: false },
      { seatId: 'local:qwen3-coder', label: 'Qwen3 Coder (local)', engine: 'local', free: true },
    ],
    effective: {
      'claude-a': { seatId: 'claude-a', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 },
      'codex-personal': { seatId: 'codex-personal', enabled: false, reservePercent: 0 },
      grok: { seatId: 'grok', enabled: true, reservePercent: 0 },
      'local:qwen3-coder': { seatId: 'local:qwen3-coder', enabled: true, reservePercent: 0 },
    },
    readingMaxAgeMs: 600_000,
    sampledAt: '2026-09-24T10:00:00.000Z',
  } as BudgetView;
}

describe('buildCapacityRows', () => {
  it('leads with the binding window and keeps the others, in provider order', () => {
    const [row] = buildCapacityRows([CLAUDE]);
    expect(row!.windows.map((w) => [w.label, w.usedPercent, w.binding])).toEqual([
      ['weekly fable window', 92, true],
      ['5-hour window', 15, false],
      ['weekly window', 85, false],
    ]);
    expect(row!.plan).toBe('max');
    expect(row!.monogram).toBe('C');
    // Prose resets stay prose.
    expect(row!.windows[1]!.resetText).toBe('resets Sep 21 at 1:40am (America/New_York)');
  });

  it('never gives a flagged limit a percentage', () => {
    const [row] = buildCapacityRows([CLAUDE_MAX_SEAT]);
    const binding = row!.windows.find((w) => w.binding)!;
    expect(binding).toMatchObject({ limitReached: true, usedPercent: null });
    expect(row!.cls).toBe('blocked');
  });

  it('an unread seat has no windows and the word "no reading"', () => {
    const [row] = buildCapacityRows([UNREAD_SEAT]);
    expect(row!.windows).toEqual([]);
    expect(row!.word).toBe('no reading');
    expect(row!.cls).toBe('unread');
  });

  it('reads the reserve and autonomy word from the budget, and invents none for a free seat', () => {
    const rows = buildCapacityRows([CLAUDE, CODEX_CREDITS_SEAT, GROK_SEAT, LOCAL_SEAT_V2], { budget: budget(), local: 'each' });
    const byId = new Map(rows.map((r) => [r.seatId, r]));
    expect(byId.get('claude-a')!.reserve).toMatchObject({ percent: 40, label: 'Reserved for you 40%', autonomyWord: 'Held back', why: 'Weekly window is past the 60% ceiling.' });
    expect(byId.get('codex-personal')!.reserve).toMatchObject({ percent: null, label: 'Autonomy off — all yours', autonomyWord: 'Off' });
    expect(byId.get('grok')!.reserve).toMatchObject({ percent: 0, label: 'No reserve — autonomy may use all of it', autonomyWord: 'Eligible' });
    expect(byId.get('local:qwen3-coder')!.reserve).toBeNull();
  });

  it('carries the A2 connection and its fix command', () => {
    const [row] = buildCapacityRows([CLAUDE], {
      health: [report('claude-a', { connection: 'binary-skew', reasons: ['Pinned to 2.1.257.'], fix: { kind: 'repin', command: ['ashlr', 'resources', 'profile', 'repin'] } })],
    });
    expect(row!.connection).toMatchObject({ word: 'older CLI pinned', tone: 'warning', fixKind: 'repin', fixCommand: ['ashlr', 'resources', 'profile', 'repin'] });
  });

  it('a seat A2 found signed out or out of usage is blocked, whatever its last window said', () => {
    const [row] = buildCapacityRows([GROK_SEAT], {
      health: [report('grok', { connection: 'signed-out', reasons: ['Grok is signed out.'], fix: { kind: 'reauth' } })],
    });
    expect(row).toMatchObject({ cls: 'blocked', word: 'blocked', summary: 'Grok is signed out.' });
    expect(capacityHeadline([row!])).toBe('0 of 1 account usable');
  });

  it('collapses several local seats into one row, in the first local position', () => {
    const second = { ...LOCAL_SEAT_V2, id: 'local:qwen3.8', label: 'Qwen 3.8 (local)', models: [{ ...LOCAL_SEAT_V2.models[0]!, id: 'qwen3.8' }] };
    const rows = buildCapacityRows([CLAUDE, LOCAL_SEAT_V2, GROK_SEAT, second]);
    expect(rows.map((r) => r.seatId)).toEqual(['claude-a', 'local', 'grok']);
    expect(rows[1]).toMatchObject({ label: 'Local models', localCount: 2, word: 'usable', summary: '2 models on this machine · free' });
    // A single local seat keeps its own name.
    expect(buildCapacityRows([LOCAL_SEAT_V2])[0]!.label).toBe('Qwen3 Coder (local)');
    expect(buildCapacityRows([CLAUDE, LOCAL_SEAT_V2], { local: 'hide' }).map((r) => r.seatId)).toEqual(['claude-a']);
  });

  it('honours an explicit seat list and order', () => {
    const rows = buildCapacityRows([CLAUDE, GROK_SEAT, CODEX_CREDITS_SEAT], { seatIds: ['grok', 'missing', 'claude-a'] });
    expect(rows.map((r) => r.seatId)).toEqual(['grok', 'claude-a']);
    expect(capacityRowFor([CLAUDE, GROK_SEAT], 'grok')!.seatId).toBe('grok');
    expect(capacityRowFor([CLAUDE], 'nope')).toBeNull();
  });
});

describe('capacityHeadline', () => {
  it('counts only what was read, and names unread seats', () => {
    const rows = buildCapacityRows([CLAUDE, CLAUDE_MAX_SEAT, UNREAD_SEAT, LOCAL_SEAT_V2]);
    expect(capacityHeadline(rows)).toBe('1 of 3 accounts usable · 1 not read yet · local models ready');
    expect(capacityHeadline(buildCapacityRows([]))).toBe('No accounts connected');
  });
});

describe('scarcestSeat — the rail’s capacity ring', () => {
  it('prefers a blocked seat, then the fullest measured binding window; never an unread one', () => {
    expect(scarcestSeat(buildCapacityRows([GROK_SEAT, CLAUDE]))!.seatId).toBe('claude-a');
    expect(scarcestSeat(buildCapacityRows([CLAUDE, CLAUDE_MAX_SEAT]))!.seatId).toBe('claude');
    expect(scarcestSeat(buildCapacityRows([UNREAD_SEAT, LOCAL_SEAT_V2]))).toBeNull();
  });
});

describe('windowSentence', () => {
  it('reads a bar aloud with its reserve and reset, and says "no reading" / "limit reached"', () => {
    const [row] = buildCapacityRows([CLAUDE]);
    expect(windowSentence(row!, row!.windows[0]!, 40)).toBe('Claude Max weekly fable window: 92% used; 40% kept for you, resets Sep 25 at 7pm (America/New_York)');
    expect(windowSentence(row!, { ...row!.windows[0]!, usedPercent: null }, null)).toBe('Claude Max weekly fable window: no reading, resets Sep 25 at 7pm (America/New_York)');
    expect(windowSentence(row!, { ...row!.windows[0]!, limitReached: true, resetText: null }, 40)).toBe('Claude Max weekly fable window: limit reached');
  });
});

/**
 * The strip renders synchronously from cached server reads on five surfaces;
 * a `{}` from an older sidecar's budget route (INT6) used to throw inside
 * useMemo and blank the whole surface. Malformed input must make a row say
 * LESS — never crash, never invent a reserve or a connection.
 */
describe('malformed server reads', () => {
  const bad = (v: unknown) => v as BudgetView;

  it.each([
    ['{}', {}],
    ['null', null],
    ['an array', []],
    ['a string', 'oops'],
    ['seatInfo not a list', { seatInfo: 'x', headroom: [], effective: {} }],
    ['headroom and effective missing', { seatInfo: [{ seatId: 'claude-a', label: 'Claude', engine: 'claude', free: false }] }],
    ['entries of the wrong shape', { seatInfo: [null, 3, { seatId: 7 }], headroom: [null, 'x', { seatId: 1 }], effective: [] }],
  ])('budget = %s → rows still build, no reserve is invented', (_name, value) => {
    const rows = buildCapacityRows([CLAUDE, GROK_SEAT], { budget: bad(value) });
    expect(rows).toHaveLength(2);
    // Only a well-formed policy may produce a reserve line.
    for (const row of rows) expect(row.reserve === null || row.reserve.label === 'Autonomy off — all yours').toBe(true);
  });

  it('drops only the seat whose policy is garbled; the rest of the budget still speaks', () => {
    const view = budget();
    (view.effective as Record<string, unknown>)['claude-a'] = { enabled: 'yes', reservePercent: '40' };
    const rows = buildCapacityRows([CLAUDE, GROK_SEAT], { budget: view });
    const byId = new Map(rows.map((r) => [r.seatId, r]));
    // Not "Autonomy off — all yours": nobody said that.
    expect(byId.get('claude-a')!.reserve).toBeNull();
    expect(byId.get('grok')!.reserve).toMatchObject({ label: 'No reserve — autonomy may use all of it', autonomyWord: 'Eligible' });
  });

  it('treats a garbled eligibility flag as "not known to be eligible" and garbled percents as no reading', () => {
    const view = budget();
    view.headroom = [{ seatId: 'grok', sessionUsedPercent: 'x', weeklyUsedPercent: NaN, eligibleForAutonomy: 'true', reasons: 'Room left.' } as never];
    const row = readBudgetRows(view).get('grok')!;
    expect(row.status).toBe('unknown');
    expect(row.headroom).toMatchObject({ sessionUsedPercent: null, weeklyUsedPercent: null, reasons: [] });
  });

  it('keeps a well-formed budget exactly as buildBudgetRows reads it', () => {
    const rows = readBudgetRows(budget());
    expect([...rows.keys()]).toEqual(['claude-a', 'codex-personal', 'grok', 'local:qwen3-coder']);
    expect(rows.get('claude-a')!.policy).toMatchObject({ enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 });
  });

  it('health that is not a list, or reports it cannot word, are ignored — the row falls back to its windows', () => {
    expect(readHealthReports({}).size).toBe(0);
    expect(readHealthReports('nope').size).toBe(0);
    const reports = readHealthReports([
      null,
      { seatId: 'claude-a', connection: 'haunted', reasons: [], fix: { kind: 'none' } },
      { seatId: 'grok', connection: 'signed-out' },
    ]);
    expect([...reports.keys()]).toEqual(['grok']);
    // A report with no fix / reasons still reads, with nothing invented.
    expect(reports.get('grok')).toMatchObject({ reasons: [], fix: { kind: 'none' } });
    const rows = buildCapacityRows([CLAUDE, GROK_SEAT], { health: [{ seatId: 'claude-a', connection: 'haunted' }, { seatId: 'grok', connection: 'signed-out', fix: { kind: 'reauth', command: [1, 2] } }] as never });
    expect(rows[0]!.connection).toBeNull();
    expect(rows[1]!.connection).toMatchObject({ word: 'signed out', fixKind: 'reauth', fixCommand: null });
    expect(rows[1]!.cls).toBe('blocked');
  });

  it('a roster that is not a list reads as no seats (the empty state), not a crash', () => {
    expect(buildCapacityRows({} as never)).toEqual([]);
    expect(buildCapacityRows([null, CLAUDE] as never).map((r) => r.seatId)).toEqual(['claude-a']);
    expect(capacityRowFor(null as never, 'claude-a')).toBeNull();
  });
});
