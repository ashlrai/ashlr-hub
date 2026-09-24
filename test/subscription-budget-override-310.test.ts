/**
 * V3.10 P1 — subscriptionAllows(engine, { budget }): the tick's budget
 * replaces the stored ~/.ashlr/budget.json while EVERY other check stays.
 *
 * WHY: a Leader class-B directive switches a Codex seat on for one tick only.
 * Judged by the stored policy (Codex off by default) the seat was refused, so
 * tick-hooks-live skipped the whole gate for it — and with it the M114
 * cross-machine reading. With `budget`, the directive path can call the gate
 * and keep the cross-machine check.
 *
 * HOME-isolated per test; the Codex session reader is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../src/core/observability/codex-source.js', () => ({
  readCodexRateLimits: () => null,
  CODEX_PROVIDER_KEY: 'codex',
  collectCodexEvents: () => [],
}));

const { subscriptionAllows } = await import('../src/core/fleet/subscription-usage.js');
const { writeCapacitySnapshot } = await import('../src/core/routing/budget-store.js');
const { SharedStore } = await import('../src/core/fleet/shared-store.js');
type SeatCapacity = import('../src/core/routing/headroom.js').SeatCapacity;
type BudgetPolicy = import('../src/core/routing/types.js').BudgetPolicy;

const NOW = Date.now();
let home: string;
let shared: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-sub-budget-'));
  shared = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-sub-shared-'));
  process.env['HOME'] = home;
  // No stored budget.json: the stored policy is the mode default (Codex OFF).
  writeCapacitySnapshot([codexSeat('codex-personal', 20)], new Date(NOW));
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
});

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

/** The budget a Leader directive produces for one tick: the Codex seat switched on. */
const tickBudget: BudgetPolicy = {
  mode: 'balanced',
  seats: { 'codex-personal': { seatId: 'codex-personal', enabled: true, reservePercent: 0 } },
  updatedAt: new Date(NOW).toISOString(),
};

function cfgWithSiblingReading(usedPercent: number): unknown {
  new SharedStore(shared).publishUsage({
    machineId: 'machine-B',
    engine: 'codex',
    ts: new Date().toISOString(),
    usedPercent,
    windowLabel: '5h',
    resetsAt: Math.floor(NOW / 1000) + 3600,
  });
  return { fleet: { sharedQueue: { mode: 'filesystem', path: shared, machineId: 'machine-A', trustedCoherentStorage: true } } };
}

describe('subscriptionAllows opts.budget (P1)', () => {
  it('without an override the STORED policy decides (Codex off by default)', () => {
    const r = subscriptionAllows('codex', { maxPercent: 90, nowMs: NOW, cfg: cfgWithSiblingReading(10) });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/held back by the balanced budget/);
  });

  it('with the tick budget the seat is judged by it — and a saturated SIBLING machine still blocks (cross-machine kept)', () => {
    const r = subscriptionAllows('codex', { maxPercent: 90, nowMs: NOW, budget: tickBudget, cfg: cfgWithSiblingReading(95) });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/95% used/);
    expect(r.reason).toContain('cross-machine');
  });

  it('with the tick budget and headroom everywhere the seat is allowed', () => {
    const r = subscriptionAllows('codex', { maxPercent: 90, nowMs: NOW, budget: tickBudget, cfg: cfgWithSiblingReading(30) });
    expect(r.allowed).toBe(true);
  });

  it('the override still applies the capacity snapshot: a saturated local seat blocks', () => {
    writeCapacitySnapshot([codexSeat('codex-personal', 97)], new Date(NOW));
    const r = subscriptionAllows('codex', { maxPercent: 90, nowMs: NOW, budget: tickBudget });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/codex-personal window 97% used/);
  });

  it('with no snapshot the override feeds the local-reading policy gate too', () => {
    fs.rmSync(path.join(home, '.ashlr', 'routing'), { recursive: true, force: true });
    const allowed = subscriptionAllows('codex', { maxPercent: 90, nowMs: NOW, budget: tickBudget, cfg: cfgWithSiblingReading(40) });
    expect(allowed.allowed).toBe(true);
    const stored = subscriptionAllows('codex', { maxPercent: 90, nowMs: NOW, cfg: cfgWithSiblingReading(40) });
    expect(stored.allowed).toBe(false);
    expect(stored.reason).toMatch(/switched off for autonomy/);
  });
});
