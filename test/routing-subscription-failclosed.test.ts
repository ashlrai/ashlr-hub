/**
 * V3.10 unit A9 — the Claude fail-open regression.
 *
 * `subscriptionAllows('claude')` used to return allowed:true because Claude
 * had "no local signal". It now reads the Verse capacity snapshot
 * (~/.ashlr/routing/capacity.json) and applies the operator's budget policy
 * (~/.ashlr/budget.json). Unknown, stale or out-of-policy usage blocks.
 *
 * HOME-isolated per test. readCodexRateLimits is mocked so no real ~/.codex
 * session is ever read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodexRateLimits } from '../src/core/observability/codex-source.js';

let mockRateLimitsReturn: CodexRateLimits | null = null;

vi.mock('../src/core/observability/codex-source.js', () => ({
  readCodexRateLimits: () => mockRateLimitsReturn,
  CODEX_PROVIDER_KEY: 'codex',
  collectCodexEvents: () => [],
}));

import { subscriptionAllows } from '../src/core/fleet/subscription-usage.js';
import { updateBudgetPolicy, writeCapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  mockRateLimitsReturn = null;
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-failclosed-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function claudeSeat(session: number | null, weekly: number | null, extra: Partial<SeatCapacity> = {}): SeatCapacity {
  return {
    seatId: 'claude',
    engine: 'claude',
    label: 'Claude Code',
    free: false,
    windows: [
      { id: 'five_hour', usedPercent: session, resetsAt: null, resetDescription: '7pm (America/New_York)', limitReached: false },
      { id: 'seven_day', usedPercent: weekly, resetsAt: null, resetDescription: null, limitReached: false },
      { id: 'seven_day_fable', usedPercent: 100, resetsAt: null, resetDescription: null, limitReached: false },
    ],
    signedOut: false,
    reachable: null,
    contextWindow: 200_000,
    observedAt: new Date(NOW - 60_000).toISOString(),
    spentTodayUsd: null,
    ...extra,
  };
}

function codexSeat(id: string, used: number): SeatCapacity {
  return {
    seatId: id,
    engine: 'codex',
    label: id,
    free: false,
    windows: [{ id: 'codex_codex_primary', usedPercent: used, resetsAt: new Date(NOW + 3_600_000).toISOString(), resetDescription: null, limitReached: false }],
    signedOut: false,
    reachable: null,
    contextWindow: 272_000,
    observedAt: new Date(NOW - 60_000).toISOString(),
    spentTodayUsd: null,
  };
}

describe('Claude: the fail-open is closed', () => {
  it('no snapshot → blocked as unknown', () => {
    const r = subscriptionAllows('claude', { nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('unknown usage is not headroom');
  });

  it('a fresh reading inside the balanced budget → allowed, with the headroom in the reason', () => {
    writeCapacitySnapshot([claudeSeat(15, 20)], new Date(NOW));
    const r = subscriptionAllows('claude', { nowMs: NOW });
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain('within the balanced budget');
    expect(r.reason).toContain('40% of the weekly window is left for autonomy');
  });

  it('5-hour window above 70% protects the live session', () => {
    writeCapacitySnapshot([claudeSeat(71, 20)], new Date(NOW));
    const r = subscriptionAllows('claude', { nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('protect your live session');
  });

  it('weekly usage past the 40% reserve blocks', () => {
    writeCapacitySnapshot([claudeSeat(10, 61)], new Date(NOW));
    expect(subscriptionAllows('claude', { nowMs: NOW }).allowed).toBe(false);
  });

  it('a stale reading blocks (older than 15 minutes)', () => {
    writeCapacitySnapshot([claudeSeat(15, 20, { observedAt: new Date(NOW - 16 * 60_000).toISOString() })], new Date(NOW));
    const r = subscriptionAllows('claude', { nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('too stale');
  });

  it('a null weekly window blocks', () => {
    writeCapacitySnapshot([claudeSeat(15, null)], new Date(NOW));
    expect(subscriptionAllows('claude', { nowMs: NOW }).allowed).toBe(false);
  });

  it('maxPercent still applies on top of the budget (all-in mode)', () => {
    updateBudgetPolicy({ mode: 'all-in' });
    writeCapacitySnapshot([claudeSeat(20, 92)], new Date(NOW));
    const r = subscriptionAllows('claude', { nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('92% used (max 90%)');
    expect(subscriptionAllows('claude', { nowMs: NOW, maxPercent: 95 }).allowed).toBe(true);
  });

  it('the operator switching Claude off blocks it', () => {
    updateBudgetPolicy({ seatId: 'claude', policy: { enabled: false } });
    writeCapacitySnapshot([claudeSeat(1, 1)], new Date(NOW));
    const r = subscriptionAllows('claude', { nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('switched off');
  });

  it('a corrupt snapshot fails closed', () => {
    fs.mkdirSync(path.join(home, '.ashlr', 'routing'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ashlr', 'routing', 'capacity.json'), '{"v":1,');
    expect(subscriptionAllows('claude', { nowMs: NOW }).allowed).toBe(false);
  });
});

describe('Codex: every account must be eligible; off by default', () => {
  it('default budget keeps Codex off even with a fresh low reading in the snapshot', () => {
    writeCapacitySnapshot([codexSeat('codex-personal', 5)], new Date(NOW));
    mockRateLimitsReturn = null;
    const r = subscriptionAllows('codex', { nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('switched off');
  });

  it('with both accounts on, one spent account closes the engine', () => {
    updateBudgetPolicy({ seatId: 'codex-personal', policy: { enabled: true, reservePercent: 0 } });
    updateBudgetPolicy({ seatId: 'codex-cmp', policy: { enabled: true, reservePercent: 0 } });
    writeCapacitySnapshot([codexSeat('codex-personal', 20), codexSeat('codex-cmp', 100)], new Date(NOW));
    const r = subscriptionAllows('codex', { nowMs: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('codex-cmp');
    writeCapacitySnapshot([codexSeat('codex-personal', 20), codexSeat('codex-cmp', 30)], new Date(NOW));
    expect(subscriptionAllows('codex', { nowMs: NOW }).allowed).toBe(true);
  });

  it('a local codex reading over the cap blocks even when the snapshot allows', () => {
    updateBudgetPolicy({ seatId: 'codex-personal', policy: { enabled: true, reservePercent: 0 } });
    writeCapacitySnapshot([codexSeat('codex-personal', 20)], new Date(NOW));
    mockRateLimitsReturn = {
      primary: { usedPercent: 95, windowMinutes: 300, resetsAt: Math.floor(NOW / 1000) + 3600 },
      planType: 'pro',
    } as CodexRateLimits;
    expect(subscriptionAllows('codex', { nowMs: NOW }).allowed).toBe(false);
  });
});

describe('non-subscription engines are untouched', () => {
  it('builtin and local engines stay allowed with no data at all', () => {
    expect(subscriptionAllows('builtin', { nowMs: NOW }).allowed).toBe(true);
  });
});
