/**
 * 3.10.1 — seat capacity history (src/core/routing/capacity-history.ts) and
 * its route (capacity-history-api.ts, mounted inside the 'budget' entry).
 *
 * Every test runs under a relocated HOME (a fresh temp dir per test, inside
 * the per-worker temp home test/setup provides, whose write guard also fails
 * any write under the real ~/.ashlr). The capacity source is injected: no
 * collector, probe or seat is ever started.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  appendCapacityHistory,
  buildCapacityHistoryResponse,
  capacityHistoryPath,
  collapseFlatRuns,
  compactCapacityHistory,
  HISTORY_FLAT_ROW_MS,
  HISTORY_KEEP_MS,
  HISTORY_MAX_BYTES,
  HISTORY_MAX_POINTS_PER_SERIES,
  historyRowsFromSeats,
  parseHistoryLine,
  readCapacityHistory,
  recordCapacityHistoryFromSnapshot,
  shouldRecordRow,
} from '../src/core/routing/capacity-history.js';
import {
  capacityHistoryFollowRefusal,
  ensureServerCapacityHistoryFollow,
  handleCapacityHistoryApi,
  recordServerCapacityHistory,
  resetCapacityHistoryApiForTest,
  withCapacityHistory,
} from '../src/core/routing/capacity-history-api.js';
import type { CapacityHistoryResponse, CapacityHistoryRow } from '../src/core/routing/capacity-history-types.js';
import { handleBudgetApi, setBudgetCapacitySourceForTest, type CapacityReading } from '../src/core/routing/budget-api.js';
import { writeCapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-24T15:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-history-')));
  process.env['HOME'] = home;
  resetCapacityHistoryApiForTest();
});

afterEach(() => {
  resetCapacityHistoryApiForTest();
  setBudgetCapacitySourceForTest();
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function claude(observedAt: number, fiveHour: number | null, sevenDay: number | null, fable = 100): SeatCapacity {
  return {
    seatId: 'claude-a', engine: 'claude', label: 'Claude Code', free: false,
    windows: [
      { id: 'five_hour', usedPercent: fiveHour, resetsAt: null, resetDescription: '7pm (America/New_York)', limitReached: false },
      { id: 'seven_day', usedPercent: sevenDay, resetsAt: null, resetDescription: 'Sep 25 at 7pm (America/New_York)', limitReached: false },
      // Per-model windows never bind (headroom.ts) and are never recorded.
      { id: 'seven_day_fable', usedPercent: fable, resetsAt: null, resetDescription: null, limitReached: false },
    ],
    signedOut: false, reachable: null, contextWindow: 200_000, observedAt: iso(observedAt), spentTodayUsd: null,
  };
}

function codex(observedAt: number, primary: number, secondary: number, resetAt = NOW + 3 * DAY): SeatCapacity {
  return {
    seatId: 'codex:personal', engine: 'codex', label: 'Personal Codex', free: false,
    windows: [
      { id: 'codex_codex_primary', usedPercent: primary, resetsAt: iso(NOW + 2 * HOUR), resetDescription: null, limitReached: false },
      { id: 'codex_codex_secondary', usedPercent: secondary, resetsAt: iso(resetAt), resetDescription: null, limitReached: false },
    ],
    signedOut: false, reachable: null, contextWindow: 272_000, observedAt: iso(observedAt), spentTodayUsd: null,
  };
}

const local: SeatCapacity = {
  seatId: 'local:qwen3.8:27b', engine: 'local', label: 'Qwen', free: true,
  windows: [], signedOut: false, reachable: true, contextWindow: 65_536, observedAt: null, spentTodayUsd: null,
};

function fileRows(file = capacityHistoryPath()): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

describe('rows from a snapshot', () => {
  it('records each paid seat\'s session and weekly peak exactly as headroom reads them, stamped with observedAt', () => {
    const rows = historyRowsFromSeats([claude(NOW - 30_000, 15, 42.26), codex(NOW - 10_000, 60, 33), local], { nowMs: NOW, source: 'verse' });
    expect(rows).toEqual([
      { ts: '2026-09-24T14:59:30Z', seat: 'claude-a', window: 'session', usedPct: 15, resetsAt: null, source: 'verse' },
      { ts: '2026-09-24T14:59:30Z', seat: 'claude-a', window: 'weekly', usedPct: 42.3, resetsAt: null, source: 'verse' },
      { ts: '2026-09-24T14:59:50Z', seat: 'codex:personal', window: 'session', usedPct: 60, resetsAt: '2026-09-24T17:00:00Z', source: 'verse' },
      { ts: '2026-09-24T14:59:50Z', seat: 'codex:personal', window: 'weekly', usedPct: 33, resetsAt: '2026-09-27T15:00:00Z', source: 'verse' },
    ]);
  });

  it('records nothing it cannot place: no timestamp, a null percent, a free seat, a future stamp', () => {
    const undated = { ...claude(NOW, 10, 20), observedAt: null };
    const future = claude(NOW + HOUR, 10, 20);
    expect(historyRowsFromSeats([undated, future, local], { nowMs: NOW, source: 'daemon' })).toEqual([]);
    const partial = historyRowsFromSeats([claude(NOW, null, 20)], { nowMs: NOW, source: 'daemon' });
    expect(partial.map((r) => r.window)).toEqual(['weekly']);
  });

  it('classifies a Codex primary resetting days out as weekly (headroom.ts rule)', () => {
    const seat = codex(NOW, 40, 30);
    seat.windows[0] = { ...seat.windows[0]!, resetsAt: iso(NOW + 42 * HOUR) };
    const rows = historyRowsFromSeats([seat], { nowMs: NOW, source: 'verse' });
    // Both are weekly now; the peak (40) is the weekly reading, and there is no session row.
    expect(rows.map((r) => [r.window, r.usedPct])).toEqual([['weekly', 40]]);
  });
});

describe('flat-run compression', () => {
  const row = (ts: number, usedPct: number, resetsAt: string | null = null): CapacityHistoryRow =>
    ({ ts: iso(ts).replace('.000Z', 'Z'), seat: 'claude-a', window: 'weekly', usedPct, resetsAt, source: 'verse' });

  it('records a change at once, a flat value only every 10 minutes, and never an old observation', () => {
    const last = row(NOW, 40);
    expect(shouldRecordRow(undefined, last)).toBe(true);
    expect(shouldRecordRow(last, row(NOW + MIN, 41))).toBe(true);
    expect(shouldRecordRow(last, row(NOW + MIN, 40))).toBe(false);
    expect(shouldRecordRow(last, row(NOW + HISTORY_FLAT_ROW_MS, 40))).toBe(true);
    expect(shouldRecordRow(last, row(NOW, 99))).toBe(false);
    expect(shouldRecordRow(last, row(NOW - MIN, 99))).toBe(false);
  });

  it('treats a moved reset as a new window, but not a countdown\'s one-second jitter', () => {
    const last = row(NOW, 40, '2026-09-27T15:00:00Z');
    expect(shouldRecordRow(last, row(NOW + MIN, 40, '2026-09-27T15:00:01Z'))).toBe(false);
    expect(shouldRecordRow(last, row(NOW + MIN, 40, '2026-10-04T15:00:00Z'))).toBe(true);
  });

  it('appends under the rule — republishing the same reading adds nothing', () => {
    const file = capacityHistoryPath();
    expect(file.startsWith(home)).toBe(true);
    expect(appendCapacityHistory([claude(NOW, 10, 40)], { source: 'verse', nowMs: NOW })).toEqual({ appended: 2, compacted: false, error: null });
    // The same observation, recorded again by the other recorder: nothing new.
    expect(appendCapacityHistory([claude(NOW, 10, 40)], { source: 'daemon', nowMs: NOW + 30_000 }).appended).toBe(0);
    // A newer flat reading 5 min later: nothing. A change in one window: one row.
    expect(appendCapacityHistory([claude(NOW + 5 * MIN, 10, 40)], { source: 'verse', nowMs: NOW + 5 * MIN }).appended).toBe(0);
    expect(appendCapacityHistory([claude(NOW + 6 * MIN, 11, 40)], { source: 'verse', nowMs: NOW + 6 * MIN }).appended).toBe(1);
    // Ten minutes after the weekly row, the flat weekly window gets its heartbeat row.
    expect(appendCapacityHistory([claude(NOW + 10 * MIN, 11, 40)], { source: 'verse', nowMs: NOW + 10 * MIN }).appended).toBe(1);
    expect(fileRows().map((l) => JSON.parse(l) as Record<string, unknown>).map((r) => [r['window'], r['usedPct']])).toEqual([
      ['session', 10], ['weekly', 40], ['session', 11], ['weekly', 40],
    ]);
    // Unknown resets are omitted on disk, and read back as null.
    expect(fileRows()[0]).not.toContain('resetsAt');
    expect(readCapacityHistory()[0]!.resetsAt).toBeNull();
  });

  it('keeps flat readings small: one publish a minute is one row per window per 10 minutes', () => {
    // A day of per-minute publishes (1 441), every value flat.
    let nowMs = NOW - DAY;
    for (; nowMs <= NOW; nowMs += MIN) appendCapacityHistory([claude(nowMs, 10, 40)], { source: 'verse', nowMs });
    const rows = readCapacityHistory();
    expect(rows.length).toBeLessThanOrEqual(2 * (24 * 6 + 1));
    // ~2 × 145 rows ≈ 25 KB a day: a week of two flat windows per seat is well under the 2 MiB cap.
    expect(fs.statSync(capacityHistoryPath()).size * 8).toBeLessThan(HISTORY_MAX_BYTES / 4);
  }, 20_000);
});

describe('storage', () => {
  it('creates the file 0600 in a 0700 directory, and re-tightens a loosened file', () => {
    appendCapacityHistory([claude(NOW, 10, 40)], { source: 'verse', nowMs: NOW });
    const file = capacityHistoryPath();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    fs.chmodSync(file, 0o644);
    appendCapacityHistory([claude(NOW + MIN, 12, 40)], { source: 'verse', nowMs: NOW + MIN });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('skips a corrupt or partial line, and starts the next append on a fresh line', () => {
    appendCapacityHistory([claude(NOW, 10, 40)], { source: 'verse', nowMs: NOW });
    const file = capacityHistoryPath();
    // A writer died mid-line; someone also left garbage and a foreign row.
    fs.appendFileSync(file, 'not json\n{"ts":"2026-09-24T15:00:00Z","seat":"x","window":"monthly","usedPct":5,"source":"verse"}\n{"ts":"2026-09-24T15:0');
    expect(readCapacityHistory()).toHaveLength(2);
    expect(parseHistoryLine('{"ts":"2026-09-24T15:0')).toBeNull();
    expect(appendCapacityHistory([claude(NOW + MIN, 11, 41)], { source: 'verse', nowMs: NOW + MIN }).appended).toBe(2);
    const rows = readCapacityHistory();
    expect(rows.map((r) => r.usedPct)).toEqual([10, 40, 11, 41]);
    // The fragment stays on its own line: it never swallowed the new rows.
    expect(fileRows().at(-3)).toBe('{"ts":"2026-09-24T15:0');
  });

  it('never throws: an unusable path comes back as an error', () => {
    const file = capacityHistoryPath();
    fs.mkdirSync(file, { recursive: true }); // a directory where the file should be
    const result = appendCapacityHistory([claude(NOW, 10, 40)], { source: 'daemon', nowMs: NOW });
    expect(result.appended).toBe(0);
    expect(result.error).not.toBeNull();
    expect(readCapacityHistory()).toEqual([]);
  });

  it('drops rows past the keep window (≥ 8 days are kept) once the oldest is a day overdue', () => {
    const file = capacityHistoryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = (ms: number, used: number) => JSON.stringify({ ts: iso(ms), seat: 'grok', window: 'weekly', usedPct: used, source: 'verse' });
    fs.writeFileSync(file, `${[line(NOW - 10 * DAY, 1), line(NOW - 9 * DAY - HOUR, 2), line(NOW - 8 * DAY + HOUR, 3), line(NOW - DAY, 4)].join('\n')}\n`, { mode: 0o600 });
    const result = appendCapacityHistory([claude(NOW, 10, 40)], { source: 'verse', nowMs: NOW });
    expect(result.compacted).toBe(true);
    const kept = readCapacityHistory();
    expect(kept.map((r) => r.usedPct)).toEqual([3, 4, 10, 40]);
    expect(Math.min(...kept.map((r) => Date.parse(r.ts)))).toBeGreaterThanOrEqual(NOW - HISTORY_KEEP_MS);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Freshly compacted: the next append does not compact again.
    expect(appendCapacityHistory([claude(NOW + MIN, 11, 40)], { source: 'verse', nowMs: NOW + MIN }).compacted).toBe(false);
  });

  it('caps the file by bytes, keeping the newest rows', () => {
    const file = capacityHistoryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lines: string[] = [];
    let bytes = 0;
    for (let i = 0; bytes <= HISTORY_MAX_BYTES + 4096; i++) {
      const l = JSON.stringify({ ts: iso(NOW - DAY + i * 1000), seat: `seat-${i % 50}`, window: 'weekly', usedPct: i % 100, source: 'verse' });
      lines.push(l);
      bytes += l.length + 1;
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    const result = appendCapacityHistory([claude(NOW, 10, 40)], { source: 'verse', nowMs: NOW });
    expect(result).toMatchObject({ appended: 2, compacted: true, error: null });
    const size = fs.statSync(file).size;
    expect(size).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    const rows = readCapacityHistory();
    expect(rows.at(-1)).toMatchObject({ seat: 'claude-a', window: 'weekly', usedPct: 40 });
    // Oldest went first.
    expect(rows[0]!.ts > iso(NOW - DAY)).toBe(true);
  });

  it('compaction also removes one observation recorded twice', () => {
    const file = capacityHistoryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const l = JSON.stringify({ ts: '2026-09-24T14:00:00Z', seat: 'grok', window: 'weekly', usedPct: 12, source: 'verse' });
    const d = JSON.stringify({ ts: '2026-09-24T14:00:00Z', seat: 'grok', window: 'weekly', usedPct: 12, source: 'daemon' });
    fs.writeFileSync(file, `${l}\n${d}\n`, { mode: 0o600 });
    expect(compactCapacityHistory(file, NOW)).toBe(1);
  });

  it('records the on-disk snapshot, and nothing when there is none', () => {
    expect(recordCapacityHistoryFromSnapshot(undefined, 'verse', { nowMs: NOW })).toEqual({ appended: 0, compacted: false, error: null });
    writeCapacitySnapshot([claude(NOW - MIN, 20, 50), local], new Date(NOW));
    expect(recordCapacityHistoryFromSnapshot(undefined, 'verse', { nowMs: NOW }).appended).toBe(2);
    expect(readCapacityHistory().map((r) => r.source)).toEqual(['verse', 'verse']);
  });
});

describe('response', () => {
  const row = (ts: number, seat: string, window: 'session' | 'weekly', usedPct: number): CapacityHistoryRow =>
    ({ ts: iso(ts), seat, window, usedPct, resetsAt: null, source: 'verse' });

  it('groups per seat window, oldest first, one point per instant, flat interiors dropped', () => {
    const rows = [
      row(NOW - 9 * DAY, 'grok', 'weekly', 1), // outside 8 days
      row(NOW - 3 * HOUR, 'grok', 'weekly', 20),
      row(NOW - 2 * HOUR, 'grok', 'weekly', 20),
      row(NOW - HOUR, 'grok', 'weekly', 20),
      row(NOW - HOUR, 'grok', 'weekly', 20), // the other recorder saw it too
      row(NOW - 30 * MIN, 'grok', 'weekly', 22),
      row(NOW - 4 * HOUR, 'claude-a', 'session', 5),
    ];
    const body = buildCapacityHistoryResponse(rows, { nowMs: NOW, days: 8 });
    expect(body).toMatchObject({ v: 1, days: 8, since: iso(NOW - 8 * DAY), oldestAt: iso(NOW - 4 * HOUR), truncated: false });
    expect(body.series.map((s) => [s.seatId, s.window, s.points])).toEqual([
      ['claude-a', 'session', [[NOW - 4 * HOUR, 5]]],
      ['grok', 'weekly', [[NOW - 3 * HOUR, 20], [NOW - HOUR, 20], [NOW - 30 * MIN, 22]]],
    ]);
  });

  it('bounds every series and the series count', () => {
    const rows: CapacityHistoryRow[] = [];
    for (let i = 0; i < 3000; i++) rows.push(row(NOW - 3000 * MIN + i * MIN, 'grok', 'weekly', i % 7));
    for (let s = 0; s < 40; s++) rows.push(row(NOW - HOUR, `seat-${String(s).padStart(2, '0')}`, 'weekly', 1));
    const body = buildCapacityHistoryResponse(rows, { nowMs: NOW, days: 8 });
    expect(body.truncated).toBe(true);
    expect(body.series).toHaveLength(32);
    const grok = body.series.find((s) => s.seatId === 'grok')!;
    expect(grok.thinned).toBe(true);
    expect(grok.points.length).toBeLessThanOrEqual(HISTORY_MAX_POINTS_PER_SERIES);
    expect(grok.points[0]![0]).toBe(NOW - 3000 * MIN);
    expect(grok.points.at(-1)![0]).toBe(NOW - MIN);
  });

  it('collapses flat runs to their ends', () => {
    expect(collapseFlatRuns([[1, 5], [2, 5], [3, 5], [4, 6], [5, 6], [6, 6]])).toEqual([[1, 5], [3, 5], [4, 6], [6, 6]]);
  });
});

// ---------------------------------------------------------------------------
// The route, through a real http server (production sendJson + sanitizer)
// ---------------------------------------------------------------------------

describe('GET /api/verse/budget/history', () => {
  let server: http.Server;
  let base: string;
  let handler: ApiModule;
  const ctx: VerseApiContext = { cfg: {} as AshlrConfig, token: 'test-token', allowDispatch: true };
  let budgetCalls = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      void handler(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'fallthrough' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    budgetCalls = 0;
    handler = withCapacityHistory(async (c, req, res, p, m) => {
      budgetCalls += 1;
      return handleBudgetApi(c, req, res, p, m);
    });
  });

  async function get<T>(p: string): Promise<{ status: number; body: T }> {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, body: (await res.json()) as T };
  }

  it('serves per-seat series for the last 8 days by default', async () => {
    const now = Date.now();
    appendCapacityHistory([claude(now - 2 * DAY, 10, 30)], { source: 'daemon', nowMs: now });
    appendCapacityHistory([claude(now - DAY, 12, 45)], { source: 'verse', nowMs: now });
    const { status, body } = await get<CapacityHistoryResponse>('/api/verse/budget/history');
    expect(status).toBe(200);
    expect(body.v).toBe(1);
    expect(body.days).toBe(8);
    expect(body.series.map((s) => [s.seatId, s.window, s.points.map((p) => p[1])])).toEqual([
      ['claude-a', 'session', [10, 12]],
      ['claude-a', 'weekly', [30, 45]],
    ]);
    // Answered before the budget module was consulted.
    expect(budgetCalls).toBe(0);
    const short = await get<CapacityHistoryResponse>('/api/verse/budget/history?days=1');
    expect(short.body.series.every((s) => s.points.length === 0 || s.points[0]![0] >= now - DAY - 1000)).toBe(true);
  });

  it('answers an empty history honestly', async () => {
    const { status, body } = await get<CapacityHistoryResponse>('/api/verse/budget/history');
    expect(status).toBe(200);
    expect(body).toMatchObject({ v: 1, series: [], oldestAt: null, truncated: false });
  });

  it('refuses bad queries and non-GET verbs', async () => {
    expect((await get('/api/verse/budget/history?days=0')).status).toBe(400);
    expect((await get('/api/verse/budget/history?days=15')).status).toBe(400);
    expect((await get('/api/verse/budget/history?days=abc')).status).toBe(400);
    expect((await get('/api/verse/budget/history?days=2&days=3')).status).toBe(400);
    expect((await get('/api/verse/budget/history?seat=claude')).status).toBe(400);
    const post = await fetch(`${base}/api/verse/budget/history`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ashlr-token': 'test-token' }, body: '{}' });
    expect(post.status).toBe(404);
  });

  it('declines every other path, so the budget module still answers its own', async () => {
    const probe = async (p: string) => handleCapacityHistoryApi(ctx, { url: p } as http.IncomingMessage, {} as http.ServerResponse, p, 'GET');
    expect(await probe('/api/verse/budget')).toBe(false);
    expect(await probe('/api/verse/budget/history/x')).toBe(false);
    expect(await probe('/api/verse/health')).toBe(false);
  });

  it('records seat history after a successful budget read — the path the Command surface polls', async () => {
    const reading: CapacityReading = { seats: [claude(Date.now() - 20_000, 33, 61), local], sampledAt: new Date().toISOString() };
    setBudgetCapacitySourceForTest(async () => reading);
    const { status } = await get('/api/verse/budget');
    expect(status).toBe(200);
    expect(budgetCalls).toBe(1);
    expect(readCapacityHistory().map((r) => [r.window, r.usedPct, r.source])).toEqual([['session', 33, 'verse'], ['weekly', 61, 'verse']]);
    // A second poll inside the throttle records nothing more (and would add nothing anyway).
    await get('/api/verse/budget');
    expect(readCapacityHistory()).toHaveLength(2);
    // A refused budget read records nothing.
    resetCapacityHistoryApiForTest();
    expect((await get('/api/verse/budget?x=1')).status).toBe(400);
    expect(readCapacityHistory()).toHaveLength(2);
  });
});

describe('server-side recording', () => {
  it('throttles, and reports a failure once per distinct error without throwing', () => {
    const logs: string[] = [];
    const failing = () => ({ appended: 0, compacted: false, error: 'EACCES' });
    expect(recordServerCapacityHistory(NOW, failing, (m) => logs.push(m))?.error).toBe('EACCES');
    expect(recordServerCapacityHistory(NOW + 1000, failing, (m) => logs.push(m))).toBeNull(); // throttled
    expect(recordServerCapacityHistory(NOW + 20_000, failing, (m) => logs.push(m))?.error).toBe('EACCES');
    expect(logs).toHaveLength(1);
    const throwing = () => { throw new Error('boom'); };
    expect(recordServerCapacityHistory(NOW + 40_000, throwing, (m) => logs.push(m))?.error).toBe('boom');
    expect(logs).toHaveLength(2);
  });

  it('never starts the background follow in a test process', () => {
    expect(capacityHistoryFollowRefusal()).toBe('test process');
    expect(capacityHistoryFollowRefusal({ ASHLR_CAPACITY_HISTORY: '0' })).toMatch(/disabled/);
    expect(capacityHistoryFollowRefusal({})).toBeNull();
    expect(ensureServerCapacityHistoryFollow()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real server: mounted in verse-api's 'budget' entry, behind read auth
// ---------------------------------------------------------------------------

describe('through the real server', () => {
  function request(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('requires a read session, then serves the history', async () => {
    const accountsRoot = path.join(home, '.ashlr', 'account-connections');
    fs.mkdirSync(accountsRoot, { recursive: true });
    fs.writeFileSync(path.join(accountsRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
    const cfg = {
      version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
      models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
      telemetry: {}, tools: {}, verse: { accountsRoot },
    } as unknown as AshlrConfig;
    appendCapacityHistory([claude(Date.now() - HOUR, 20, 50)], { source: 'verse' });
    const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: false } as Parameters<typeof startServer>[1]);
    try {
      const anonymous = await request(handle.port, '/api/verse/budget/history');
      expect(anonymous.status).toBe(401);
      const authed = await request(handle.port, '/api/verse/budget/history', readAuthHeaders(handle.port));
      expect(authed.status).toBe(200);
      const body = authed.json as CapacityHistoryResponse;
      expect(body.series.map((s) => [s.seatId, s.window])).toEqual([['claude-a', 'session'], ['claude-a', 'weekly']]);
    } finally {
      await handle.close();
    }
  });
});
