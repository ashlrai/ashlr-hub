/**
 * capacity-strip-model.test.ts — the ONE projection behind every capacity
 * view (SPEC-310C §4), against Mason's real roster shapes (seat-fixtures).
 * Pinned where it would otherwise mislead: an unread seat counted as usable
 * or blocked, a flagged limit given a percentage, a reserve invented for a
 * free seat, twelve identical local rows, a scarcest-seat ring drawn from a
 * seat nobody measured.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import {
  capacity,
  CLAUDE_MAX_SEAT,
  CLAUDE_TIGHT_SEAT,
  CODEX_CREDITS_SEAT,
  GROK_SEAT,
  LOCAL_SEAT_V2,
  nativeSeat,
  seatWindow,
  UNREAD_SEAT,
} from '../seat-fixtures.test-support.js';
import {
  accountStatus,
  buildCapacityRows,
  CAPACITY_MAX_WINDOWS,
  capacityHeadline,
  capacityRowFor,
  orderAccountRows,
  percentText,
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

/** True when the suite runs under an en-US default locale (the words below are pinned literally only there). */
const EN_US = new Intl.DateTimeFormat().resolvedOptions().locale === 'en-US';

/**
 * Apps & Accounts: the status each account row leads with. Instants are
 * built in LOCAL time so "Sat 11:46 PM" holds in whatever zone the suite
 * runs; every row is built against NOW (never the real clock), so the words
 * hold on whatever DAY it runs; and each expectation is the shared reset
 * formatter's own output, so they hold under any default locale — the
 * literal en-US wording is pinned too, where that is the locale.
 */
describe('account status', () => {
  const NOW = new Date(2026, 8, 25, 16, 34).getTime(); // Fri Sep 25, 4:34 PM local
  const RESET = new Date(2026, 8, 26, 23, 46).toISOString(); // Sat 11:46 PM local
  const CHECKED = new Date(NOW - 2 * 60_000).toISOString();
  const RESETS = `resets ${describeResetAt(RESET, NOW)}`;

  const spentWindow = seatWindow({ id: 'codex_codex_primary', usedPercent: 100, resetsAt: RESET, limitReached: true, measured: false });
  const PERSONAL = nativeSeat(capacity({ planType: 'plus', windows: [spentWindow], binding: spentWindow, usability: 'exhausted', observedAt: CHECKED }),
    { id: 'codex-personal', engine: 'codex', label: 'Personal Codex', accountId: 'codex-personal' });
  const okWindow = seatWindow({ id: 'codex_codex_primary', usedPercent: 31, resetsAt: RESET });
  const CMP = nativeSeat(capacity({ planType: 'pro', windows: [okWindow], binding: okWindow, usability: 'ready', observedAt: CHECKED }),
    { id: 'codex-cmp', engine: 'codex', label: 'Cash Margin Partners', accountId: 'codex-cmp' });
  const HEALTH = [
    report('codex-personal', { engine: 'codex', connection: 'exhausted', resetAt: RESET, checkedAt: CHECKED, reasons: [`Every usage window with a reading is spent (resets ${RESET}).`], fix: { kind: 'wait' } }),
    report('codex-cmp', { engine: 'codex', checkedAt: CHECKED }),
    report('grok', { engine: 'grok', connection: 'signed-out', checkedAt: CHECKED, reasons: ['Grok CLI reports this account is not signed in.'], fix: { kind: 'reauth' } }),
    report('claude-a', { checkedAt: CHECKED }),
  ];
  const ROSTER = [PERSONAL, GROK_SEAT, CLAUDE, CMP, LOCAL_SEAT_V2];
  const rows = buildCapacityRows(ROSTER, { health: HEALTH, now: NOW });
  const byId = new Map(rows.map((r) => [r.seatId, r]));
  const status = (id: string, opts: { healthRead?: boolean; checking?: boolean } = {}) =>
    accountStatus(byId.get(id)!, { healthRead: opts.healthRead ?? true, checking: opts.checking ?? false, now: NOW });

  it('Connected · usable now, with when it was last checked', () => {
    expect(status('codex-cmp')).toMatchObject({ kind: 'usable', label: 'Connected', detail: 'usable now', tone: 'success', checked: 'checked 2m ago', usableAgain: null });
    const title = status('codex-cmp').checkedTitle!;
    expect(title.startsWith('Last checked ')).toBe(true);
    if (EN_US) expect(title).toMatch(/^Last checked Fri, Sep 25, 4:32/);
  });

  it('Spent · resets <local day and time>, and usable again in <countdown> — never the ISO instant', () => {
    const spent = status('codex-personal');
    expect(spent).toMatchObject({ kind: 'spent', label: 'Spent', detail: RESETS, tone: 'danger', usableAgain: 'usable again in 1d 7h', coversConnection: true });
    // The health reason the row prints is localised too.
    expect(byId.get('codex-personal')!.summary).toBe(`Every usage window with a reading is spent (${RESETS}).`);
    expect(byId.get('codex-personal')!.windows[0]!.resetText).toBe(RESETS);
    expect(RESETS).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    if (EN_US) expect(RESETS).toBe('resets Sat 11:46 PM');
  });

  describe('the words are a function of the inputs, not of the day the suite runs', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // The 3.10.1 time bomb: rows built against the real clock read "resets
    // today 11:46 PM" from Sat Sep 26 2026, and "Sep 26, 11:46 PM" after it.
    it.each([
      ['on the day of the reset', Date.parse(RESET) - 6 * 3_600_000],
      ['after the reset', Date.parse(RESET) + 86_400_000],
      ['a year later', NOW + 365 * 86_400_000],
      ['a week earlier', NOW - 7 * 86_400_000],
    ])('same words when the real clock reads %s', (_label, realClock) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(realClock);
      const again = new Map(buildCapacityRows(ROSTER, { health: HEALTH, now: NOW }).map((r) => [r.seatId, r]));
      const personal = again.get('codex-personal')!;
      expect(personal.summary).toBe(`Every usage window with a reading is spent (${RESETS}).`);
      expect(personal.windows[0]!.resetText).toBe(RESETS);
      expect(accountStatus(personal, { healthRead: true, now: NOW })).toMatchObject({ detail: RESETS, usableAgain: 'usable again in 1d 7h' });
    });
  });

  it('a spent seat whose reset has passed says so instead of counting down past zero', () => {
    const late = accountStatus(byId.get('codex-personal')!, { healthRead: true, now: Date.parse(RESET) + 60_000 });
    expect(late.detail).toMatch(/^was due to reset /);
    expect(late.usableAgain).toBeNull();
  });

  it('Signed out · reconnect to use it', () => {
    expect(status('grok')).toMatchObject({ kind: 'signed-out', label: 'Signed out', detail: 'reconnect to use it', tone: 'danger', coversConnection: true });
  });

  it('a running check, and a sweep that has not answered yet, both read "Checking…"', () => {
    expect(status('codex-cmp', { checking: true })).toMatchObject({ kind: 'checking', label: 'Checking…', detail: null });
    const unread = buildCapacityRows([UNREAD_SEAT], { health: null })[0]!;
    expect(accountStatus(unread, { healthRead: false, now: NOW })).toMatchObject({ kind: 'checking', label: 'Checking…' });
    expect(accountStatus(unread, { healthRead: true, now: NOW })).toMatchObject({ kind: 'not-checked', label: 'Not checked', detail: 'no reading yet' });
  });

  it('tight seats read as running low, or usable on credits when the window is spent but credits are not', () => {
    expect(status('claude-a')).toMatchObject({ kind: 'low', label: 'Connected', detail: 'running low', tone: 'warning' });
    const credits = buildCapacityRows([CODEX_CREDITS_SEAT], { health: [report('codex-personal', { engine: 'codex' })] })[0]!;
    expect(accountStatus(credits, { healthRead: true, now: NOW })).toMatchObject({ kind: 'low', detail: 'usable on credits' });
  });

  it('local models read as Ready and free', () => {
    expect(status('local:qwen3-coder')).toMatchObject({ kind: 'usable', label: 'Ready', detail: 'runs on this machine · free' });
  });

  it('orders usable accounts first, then what comes back by itself, then what needs you — stable within each', () => {
    expect(orderAccountRows(rows, { healthRead: true, now: NOW }).map((r) => r.seatId))
      .toEqual(['codex-cmp', 'local:qwen3-coder', 'claude-a', 'codex-personal', 'grok']);
  });
});

/**
 * Accounts' "Spent · resets … · usable again in …" and Fleet's "eligible
 * again" must name the same instant: a seat reopens only once EVERY spent
 * window has reset, so the LATEST spent reset is the one that counts.
 */
describe('when a spent seat is usable again', () => {
  // Mon–Wed of a week with no DST change anywhere, so the countdowns hold in every zone.
  const NOW = new Date(2026, 8, 21, 15, 40).getTime(); // Mon 3:40 PM local
  const SOON = new Date(2026, 8, 21, 17, 40).toISOString(); // today 5:40 PM — the 5-hour window
  const WED = new Date(2026, 8, 23, 15, 0).toISOString(); // Wed 3:00 PM — the weekly window
  const five = seatWindow({ id: 'codex_codex_primary', usedPercent: 100, resetsAt: SOON, limitReached: true, measured: false });
  const weekly = seatWindow({ id: 'codex_codex_secondary', usedPercent: 100, resetsAt: WED, limitReached: true, measured: false });
  const seat = (windows: ReturnType<typeof seatWindow>[], binding = windows[0]!) => nativeSeat(
    capacity({ planType: 'plus', windows, binding, usability: 'exhausted', observedAt: new Date(NOW).toISOString() }),
    { id: 'codex-personal', engine: 'codex', label: 'Personal Codex', accountId: 'codex-personal' },
  );
  const exhausted = (over: Partial<SeatHealthReport> = {}) =>
    report('codex-personal', { engine: 'codex', connection: 'exhausted', checkedAt: new Date(NOW).toISOString(), fix: { kind: 'wait' }, ...over });

  it('takes the LATEST reset among the spent windows, not the first to come back', () => {
    // The server's binding (and the sweep's resetAt) is the 5-hour window, which resets first.
    const row = buildCapacityRows([seat([five, weekly])], { health: [exhausted({ resetAt: SOON })], now: NOW })[0]!;
    expect(row.resetAt).toBe(WED);
    const status = accountStatus(row, { healthRead: true, now: NOW });
    expect(status).toMatchObject({ kind: 'spent', detail: `resets ${describeResetAt(WED, NOW)}`, usableAgain: 'usable again in 1d 23h' });
    // Two hours on, the 5-hour window has reset — and the seat is STILL spent until Wednesday.
    const later = accountStatus(row, { healthRead: true, now: Date.parse(SOON) + 60_000 });
    expect(later.usableAgain).toBe('usable again in 1d 21h');
  });

  it('with no sweep report, still the latest spent window', () => {
    const row = buildCapacityRows([seat([five, weekly])], { now: NOW })[0]!;
    expect(row.resetAt).toBe(WED);
  });

  it('counts a spent window the row has no room to draw', () => {
    const fillers = Array.from({ length: CAPACITY_MAX_WINDOWS }, (_, i) =>
      seatWindow({ id: `codex_extra_${i}`, usedPercent: 10, resetsAt: SOON }));
    const row = buildCapacityRows([seat([five, ...fillers, weekly])], { now: NOW })[0]!;
    expect(row.windows.map((w) => w.id)).not.toContain('codex_codex_secondary');
    expect(row.resetAt).toBe(WED);
  });

  it('never lets the sweep make it EARLIER than a spent window, but a later sweep instant wins', () => {
    const LATER = new Date(2026, 8, 25, 9, 0).toISOString();
    expect(buildCapacityRows([seat([five, weekly])], { health: [exhausted({ resetAt: LATER })], now: NOW })[0]!.resetAt).toBe(LATER);
  });

  it('is unknown when a spent window only has provider prose — "when all of them reset" cannot be said', () => {
    const prose = seatWindow({ id: 'codex_codex_secondary', usedPercent: 100, resetDescription: 'resets next week', limitReached: true, measured: false });
    const row = buildCapacityRows([seat([five, prose])], { health: [exhausted({ resetAt: SOON })], now: NOW })[0]!;
    expect(row.resetAt).toBeNull();
    const status = accountStatus(row, { healthRead: true, now: NOW });
    expect(status.usableAgain).toBeNull();
    // The words of the window that holds the seat stand in — never the 5-hour
    // window's earlier instant, and never a countdown to the wrong window.
    expect(status.detail).toBe('resets next week');
  });

  it('with nothing spent, the sweep’s reset or the binding window’s', () => {
    const ok = seatWindow({ id: 'codex_codex_primary', usedPercent: 40, resetsAt: SOON });
    const ready = nativeSeat(capacity({ windows: [ok], binding: ok, usability: 'ready' }), { id: 'codex-personal', engine: 'codex', label: 'Personal Codex' });
    expect(buildCapacityRows([ready], { now: NOW })[0]!.resetAt).toBe(SOON);
    expect(buildCapacityRows([ready], { health: [exhausted({ resetAt: WED })], now: NOW })[0]!.resetAt).toBe(WED);
  });
});

describe('one percent rule on the row itself', () => {
  it('the summary and the bar agree: "99%", never a rounded "100%"; "<1%", never "0%"', () => {
    const row = (usedPercent: number) => {
      const w = seatWindow({ id: 'five_hour', usedPercent });
      return buildCapacityRows([nativeSeat(capacity({ windows: [w], binding: w, usability: 'tight' }))])[0]!;
    };
    const high = row(99.6);
    expect(high.summary).toBe('99% of 5-hour window used');
    expect(percentText(high.windows[0]!.usedPercent!)).toBe('99%');
    expect(row(0.4).summary).toBe('<1% of 5-hour window used');
  });
});

describe('percentText', () => {
  it('prints whole percents, never "0%" for a real reading or "100%" for one short of it', () => {
    expect(percentText(62.4)).toBe('62%');
    expect(percentText(0)).toBe('0%');
    expect(percentText(0.4)).toBe('<1%');
    expect(percentText(99.6)).toBe('99%');
    expect(percentText(100)).toBe('100%');
    expect(percentText(140)).toBe('100%');
    expect(percentText(Number.NaN)).toBe('—');
  });
});
