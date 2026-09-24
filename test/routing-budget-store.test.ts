/**
 * V3.10 unit A9 — budget persistence (src/core/routing/budget-store.ts).
 *
 * HOME-isolated: every test relocates HOME to a fresh temp dir, so the real
 * ~/.ashlr is never read or written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  budgetPolicyPath,
  capacitySnapshotPath,
  decisionsLogPath,
  DECISIONS_LOG_MAX_BYTES,
  loadBudgetPolicy,
  readCapacitySnapshot,
  readShadowDecisions,
  recordShadowDecision,
  sanitizeSeatCapacity,
  updateBudgetPolicy,
  writeCapacitySnapshot,
  writeCapacitySnapshotAsync,
} from '../src/core/routing/budget-store.js';
import { BudgetPolicyError, defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { SeatDecision } from '../src/core/routing/types.js';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-budget-store-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

const claudeSeat = (extra: Partial<SeatCapacity> = {}): SeatCapacity => ({
  seatId: 'claude',
  engine: 'claude',
  label: 'Claude Code',
  free: false,
  windows: [
    { id: 'five_hour', usedPercent: 15, resetsAt: null, resetDescription: '7pm (America/New_York)', limitReached: false },
    { id: 'seven_day', usedPercent: 20, resetsAt: null, resetDescription: null, limitReached: false },
  ],
  signedOut: false,
  reachable: null,
  contextWindow: 200_000,
  observedAt: '2026-09-24T11:59:00.000Z',
  spentTodayUsd: null,
  ...extra,
});

describe('budget policy file', () => {
  it('paths follow a relocated HOME', () => {
    expect(budgetPolicyPath()).toBe(path.join(home, '.ashlr', 'budget.json'));
    expect(capacitySnapshotPath()).toBe(path.join(home, '.ashlr', 'routing', 'capacity.json'));
  });

  it('a missing file loads the defaults and writes nothing', () => {
    expect(loadBudgetPolicy()).toEqual(defaultBudgetPolicy());
    expect(fs.existsSync(path.join(home, '.ashlr'))).toBe(false);
  });

  it('update persists 0600 in a 0700 directory and round-trips', () => {
    const now = new Date('2026-09-24T12:00:00.000Z');
    const stored = updateBudgetPolicy({ mode: 'reserve' }, { now });
    expect(stored).toEqual({ mode: 'reserve', seats: {}, updatedAt: now.toISOString() });
    expect(mode(budgetPolicyPath())).toBe(0o600);
    expect(mode(path.join(home, '.ashlr'))).toBe(0o700);
    expect(loadBudgetPolicy()).toEqual(stored);

    const seat = updateBudgetPolicy({ seatId: 'claude', policy: { reservePercent: 50 } }, { now });
    // Reserve mode's Claude default (85% / 50% ceiling) with the one field changed.
    expect(seat.seats['claude']).toEqual({ seatId: 'claude', enabled: true, reservePercent: 50, maxSessionWindowPercent: 50 });
    expect(loadBudgetPolicy().seats['claude']!.reservePercent).toBe(50);
  });

  it('an invalid update throws and writes nothing', () => {
    expect(() => updateBudgetPolicy({ mode: 'nope' } as never)).toThrow(BudgetPolicyError);
    expect(fs.existsSync(budgetPolicyPath())).toBe(false);
  });

  it('a mangled, oversized or symlinked file loads the defaults', () => {
    fs.mkdirSync(path.join(home, '.ashlr'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(budgetPolicyPath(), '{not json');
    expect(loadBudgetPolicy()).toEqual(defaultBudgetPolicy());
    fs.writeFileSync(budgetPolicyPath(), JSON.stringify({ mode: 'all-in', pad: 'x'.repeat(70 * 1024) }));
    expect(loadBudgetPolicy()).toEqual(defaultBudgetPolicy());
    fs.rmSync(budgetPolicyPath());
    const target = path.join(home, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ mode: 'all-in', seats: {}, updatedAt: new Date().toISOString() }));
    fs.symlinkSync(target, budgetPolicyPath());
    expect(loadBudgetPolicy().mode).toBe('balanced');
  });
});

describe('capacity snapshot', () => {
  it('writes 0600 and reads back exactly', () => {
    const snap = writeCapacitySnapshot([claudeSeat()], new Date('2026-09-24T12:00:00.000Z'));
    expect(mode(capacitySnapshotPath())).toBe(0o600);
    expect(mode(path.join(home, '.ashlr', 'routing'))).toBe(0o700);
    expect(readCapacitySnapshot()).toEqual(snap);
    expect(snap.seats[0]).toEqual(claudeSeat());
  });

  it('the async (request-path) write is equally private and replaces a planted symlink rather than writing through it', async () => {
    fs.mkdirSync(path.join(home, '.ashlr', 'routing'), { recursive: true, mode: 0o700 });
    const victim = path.join(home, 'victim.json');
    fs.writeFileSync(victim, 'original');
    fs.symlinkSync(victim, capacitySnapshotPath());
    const snap = await writeCapacitySnapshotAsync([claudeSeat()], new Date('2026-09-24T12:00:00.000Z'));
    expect(fs.readFileSync(victim, 'utf8')).toBe('original');
    expect(fs.lstatSync(capacitySnapshotPath()).isSymbolicLink()).toBe(false);
    expect(mode(capacitySnapshotPath())).toBe(0o600);
    expect(readCapacitySnapshot()).toEqual(snap);
    expect(fs.readdirSync(path.join(home, '.ashlr', 'routing')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('absent or corrupt → null (readers fail closed)', () => {
    expect(readCapacitySnapshot()).toBeNull();
    fs.mkdirSync(path.join(home, '.ashlr', 'routing'), { recursive: true });
    fs.writeFileSync(capacitySnapshotPath(), '[]');
    expect(readCapacitySnapshot()).toBeNull();
    fs.writeFileSync(capacitySnapshotPath(), JSON.stringify({ v: 2, publishedAt: new Date().toISOString(), seats: [] }));
    expect(readCapacitySnapshot()).toBeNull();
  });

  it('drops seats that fail validation instead of trusting them', () => {
    fs.mkdirSync(path.join(home, '.ashlr', 'routing'), { recursive: true });
    fs.writeFileSync(capacitySnapshotPath(), JSON.stringify({
      v: 1,
      publishedAt: '2026-09-24T12:00:00.000Z',
      seats: [
        claudeSeat(),
        // A paid seat claiming to be free would bypass every reserve.
        { ...claudeSeat(), seatId: 'claude-b', free: true },
        { ...claudeSeat(), seatId: 'claude-c', windows: [{ id: 'five_hour', usedPercent: 250, resetsAt: null, resetDescription: null, limitReached: false }] },
        { ...claudeSeat(), seatId: 'claude-d', engine: 'gpt' },
      ],
    }));
    expect(readCapacitySnapshot()!.seats.map((s) => s.seatId)).toEqual(['claude']);
  });

  it('scrubs secret-shaped free text on the way in', () => {
    const s = sanitizeSeatCapacity({ ...claudeSeat(), label: 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(s!.label).not.toContain('sk-ant-api03-AAAA');
  });
});

describe('shadow decision log', () => {
  const decision: SeatDecision = { seatId: 'grok', candidates: ['grok'], exclusions: [], why: 'Routed to grok.', mode: 'balanced' };
  const request = { task: 'code' as const, difficulty: 'medium' as const, autonomous: true };

  it('appends 0600 JSONL and reads newest first', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(recordShadowDecision({ source: 'daemon', request, decision: { ...decision, why: `n${i}` },
        now: new Date(Date.UTC(2026, 8, 24, 12, i)) })).toBe(true);
    }
    expect(mode(decisionsLogPath())).toBe(0o600);
    const rows = readShadowDecisions(2);
    expect(rows.map((r) => r.decision.why)).toEqual(['n2', 'n1']);
    expect(rows[0]).toMatchObject({ v: 1, source: 'daemon', actual: null, request });
  });

  it('records what actually ran and scrubs free text', () => {
    recordShadowDecision({ source: 'gateway', request, decision: { ...decision, why: 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      actual: { engine: 'claude', seatId: null } });
    const [row] = readShadowDecisions(1);
    expect(row!.actual).toEqual({ engine: 'claude', seatId: null });
    expect(row!.decision.why).not.toContain('ghp_AAAA');
  });

  it('keeps the 3.10.1 summary and structured reasons, scrubbed', () => {
    const rich: SeatDecision = {
      ...decision,
      summary: 'grok — 94% of its weekly window left; balanced mode prefers Grok for this work.',
      exclusions: [{
        seatId: 'codex-cmp',
        reasons: ['Autonomy is switched off for this seat.', 'The weekly window is spent — limit reached (resets 2026-09-26T03:46:56.000Z).'],
        nextEligibleAt: null,
        details: [
          { kind: 'switched-off', text: 'Autonomy is switched off for this seat.' },
          { kind: 'spent', text: 'The weekly window is spent — limit reached. ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', resetsAt: '2026-09-26T03:46:56.000Z', resetDescription: null },
        ],
      }],
    };
    expect(recordShadowDecision({ source: 'verse', request, decision: rich })).toBe(true);
    const [row] = readShadowDecisions(1);
    expect(row!.decision.summary).toBe(rich.summary);
    expect(row!.decision.exclusions[0]!.details!.map((r) => [r.kind, r.resetsAt])).toEqual([['switched-off', undefined], ['spent', '2026-09-26T03:46:56.000Z']]);
    expect(row!.decision.exclusions[0]!.details![1]!.text).not.toContain('ghp_AAAA');
  });

  it('never throws: bad source, unwritable location, missing log', () => {
    expect(recordShadowDecision({ source: 'nope' as never, request, decision })).toBe(false);
    expect(readShadowDecisions(10)).toEqual([]);
    fs.mkdirSync(path.join(home, '.ashlr'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ashlr', 'routing'), 'a file where the directory should be');
    expect(recordShadowDecision({ source: 'daemon', request, decision })).toBe(false);
  });

  it('refuses to append through a symlink', () => {
    fs.mkdirSync(path.join(home, '.ashlr', 'routing'), { recursive: true, mode: 0o700 });
    const target = path.join(home, 'victim.txt');
    fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, decisionsLogPath());
    expect(recordShadowDecision({ source: 'daemon', request, decision })).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
  });

  it('rotates past the size bound, keeping one generation', () => {
    fs.mkdirSync(path.join(home, '.ashlr', 'routing'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(decisionsLogPath(), 'x'.repeat(DECISIONS_LOG_MAX_BYTES), { mode: 0o600 });
    expect(recordShadowDecision({ source: 'daemon', request, decision })).toBe(true);
    expect(fs.statSync(decisionsLogPath()).size).toBeLessThan(4096);
    expect(fs.existsSync(decisionsLogPath().replace(/\.jsonl$/, '.1.jsonl'))).toBe(true);
    expect(readShadowDecisions(5)).toHaveLength(1);
  });

  it('skips corrupt lines', () => {
    fs.mkdirSync(path.join(home, '.ashlr', 'routing'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(decisionsLogPath(), '{"v":1}\nnot json\n');
    recordShadowDecision({ source: 'leader', request, decision });
    expect(readShadowDecisions(10).map((r) => r.source)).toEqual(['leader']);
  });
});
