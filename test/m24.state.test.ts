/**
 * M24 daemon state tests — daemonStatePath, loadDaemonState, saveDaemonState,
 * resetDayIfNeeded.
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir so the real ~/.ashlr/daemon.json is never touched.
 *  - All tests are hermetic: fresh tmp HOME per test.
 *  - No real agents, swarms, or repos are touched.
 *
 * Invariants asserted:
 *  - daemonStatePath() is under HOME/.ashlr/daemon.json
 *  - loadDaemonState() never throws; returns zeroed state on missing/corrupt file
 *  - saveDaemonState() writes atomically; round-trips all fields
 *  - resetDayIfNeeded() resets todaySpentUsd when todayDate rolls over
 *  - resetDayIfNeeded() preserves itemsProcessed and ticks across day-roll
 *  - ticks history is bounded (implementation may cap; tests just assert
 *    the structure remains valid and most-recent last)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DaemonState, DaemonTick } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation — must happen before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m24-state-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Lazy imports — MUST be after HOME isolation setup
// ---------------------------------------------------------------------------

import {
  daemonStatePath,
  loadDaemonState,
  saveDaemonState,
  resetDayIfNeeded,
} from '../src/core/daemon/state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function makeTick(overrides?: Partial<DaemonTick>): DaemonTick {
  return {
    ts: new Date().toISOString(),
    itemsConsidered: 2,
    proposalsCreated: 1,
    spentUsd: 0.01,
    reason: 'ok',
    ...overrides,
  };
}

function zeroedState(): DaemonState {
  return {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks: [],
  };
}

// ===========================================================================
// daemonStatePath
// ===========================================================================

describe('M24 daemonStatePath — location', () => {
  it('returns a path ending in daemon.json', () => {
    const p = daemonStatePath();
    expect(p.endsWith('daemon.json')).toBe(true);
  });

  it('is under the current HOME/.ashlr/', () => {
    const p = daemonStatePath();
    expect(p.startsWith(tmpHome)).toBe(true);
    expect(p).toContain('.ashlr');
  });

  it('is absolute', () => {
    const p = daemonStatePath();
    expect(path.isAbsolute(p)).toBe(true);
  });
});

// ===========================================================================
// loadDaemonState — never throws, returns zeroed state on missing/corrupt
// ===========================================================================

describe('M24 loadDaemonState — never throws; zeroed state on missing/corrupt', () => {
  it('returns a zeroed state when daemon.json does not exist', () => {
    const state = loadDaemonState();
    expect(state.running).toBe(false);
    expect(state.pid).toBeNull();
    expect(state.startedAt).toBeNull();
    expect(state.lastTickAt).toBeNull();
    expect(state.todayDate).toBeNull();
    expect(state.todaySpentUsd).toBe(0);
    expect(state.itemsProcessed).toBe(0);
    expect(state.ticks).toEqual([]);
  });

  it('does not throw when the file is absent', () => {
    expect(() => loadDaemonState()).not.toThrow();
  });

  it('does not throw when the file is malformed JSON', () => {
    const p = daemonStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'NOT VALID JSON {{{', 'utf8');
    expect(() => loadDaemonState()).not.toThrow();
  });

  it('returns zeroed state when the file is malformed JSON', () => {
    const p = daemonStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'NOT VALID JSON {{{', 'utf8');
    const state = loadDaemonState();
    expect(state.running).toBe(false);
    expect(state.todaySpentUsd).toBe(0);
    expect(state.ticks).toEqual([]);
  });

  it('does not throw when the file is empty', () => {
    const p = daemonStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
    expect(() => loadDaemonState()).not.toThrow();
  });

  it('returns zeroed state on an empty file', () => {
    const p = daemonStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
    const state = loadDaemonState();
    expect(state.running).toBe(false);
    expect(state.ticks).toEqual([]);
  });

  it('does not throw when the file is a JSON object with unexpected shape', () => {
    const p = daemonStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ foo: 'bar', count: 42 }), 'utf8');
    expect(() => loadDaemonState()).not.toThrow();
  });

  it('returns a valid DaemonState shape from a well-formed file', () => {
    const s: DaemonState = {
      running: true,
      // H5 CHANGE 2: loadDaemonState() now reconciles a phantom-live daemon
      // (running:true with a DEAD pid) at the load chokepoint. To round-trip a
      // GENUINELY-running daemon we use the live test-process pid (process.pid),
      // which the liveness check confirms is alive — so running:true survives.
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastTickAt: '2026-01-01T01:00:00.000Z',
      todayDate: '2026-01-01',
      todaySpentUsd: 0.05,
      itemsProcessed: 7,
      ticks: [makeTick()],
    };
    saveDaemonState(s);
    const loaded = loadDaemonState();
    expect(loaded.running).toBe(true);
    expect(loaded.pid).toBe(process.pid);
    expect(loaded.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(loaded.todaySpentUsd).toBe(0.05);
    expect(loaded.itemsProcessed).toBe(7);
    expect(Array.isArray(loaded.ticks)).toBe(true);
    expect(loaded.ticks.length).toBe(1);
  });
});

// ===========================================================================
// saveDaemonState — atomic write + round-trip
// ===========================================================================

describe('M24 saveDaemonState — atomic write + round-trip', () => {
  it('creates the daemon.json file', () => {
    saveDaemonState(zeroedState());
    expect(fs.existsSync(daemonStatePath())).toBe(true);
  });

  it('creates ~/.ashlr directory if it does not exist', () => {
    // HOME starts as a fresh tmpdir with no .ashlr subdir
    const ashlrDir = path.join(tmpHome, '.ashlr');
    expect(fs.existsSync(ashlrDir)).toBe(false);
    saveDaemonState(zeroedState());
    expect(fs.existsSync(ashlrDir)).toBe(true);
  });

  it('does not throw when called', () => {
    expect(() => saveDaemonState(zeroedState())).not.toThrow();
  });

  it('round-trips running=false + zeroed fields', () => {
    saveDaemonState(zeroedState());
    const loaded = loadDaemonState();
    expect(loaded.running).toBe(false);
    expect(loaded.pid).toBeNull();
    expect(loaded.todaySpentUsd).toBe(0);
    expect(loaded.itemsProcessed).toBe(0);
    expect(loaded.ticks).toEqual([]);
  });

  it('round-trips running=true + non-null pid (LIVE pid survives reconcile)', () => {
    // H5 CHANGE 2: loadDaemonState() reconciles a dead-pid running:true to
    // running:false at load. A genuine running daemon's pid IS alive, so this
    // round-trip uses the live test-process pid — running:true is preserved.
    const s: DaemonState = { ...zeroedState(), running: true, pid: process.pid };
    saveDaemonState(s);
    const loaded = loadDaemonState();
    expect(loaded.running).toBe(true);
    expect(loaded.pid).toBe(process.pid);
  });

  it('round-trips todaySpentUsd accurately', () => {
    const s: DaemonState = { ...zeroedState(), todaySpentUsd: 1.2345 };
    saveDaemonState(s);
    expect(loadDaemonState().todaySpentUsd).toBeCloseTo(1.2345, 4);
  });

  it('round-trips itemsProcessed', () => {
    const s: DaemonState = { ...zeroedState(), itemsProcessed: 42 };
    saveDaemonState(s);
    expect(loadDaemonState().itemsProcessed).toBe(42);
  });

  it('round-trips todayDate', () => {
    const s: DaemonState = { ...zeroedState(), todayDate: '2026-06-10' };
    saveDaemonState(s);
    expect(loadDaemonState().todayDate).toBe('2026-06-10');
  });

  it('round-trips ticks array with one tick', () => {
    const tick = makeTick({ reason: 'ok', proposalsCreated: 3 });
    const s: DaemonState = { ...zeroedState(), ticks: [tick] };
    saveDaemonState(s);
    const loaded = loadDaemonState();
    expect(loaded.ticks.length).toBe(1);
    expect(loaded.ticks[0]!.reason).toBe('ok');
    expect(loaded.ticks[0]!.proposalsCreated).toBe(3);
  });

  it('overwrites a previous save (idempotent on same state)', () => {
    saveDaemonState(zeroedState());
    saveDaemonState({ ...zeroedState(), itemsProcessed: 5 });
    expect(loadDaemonState().itemsProcessed).toBe(5);
  });

  it('persisted file is valid JSON', () => {
    saveDaemonState({ ...zeroedState(), itemsProcessed: 3 });
    const raw = fs.readFileSync(daemonStatePath(), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ===========================================================================
// resetDayIfNeeded — resets spend on day-roll; preserves other fields
// ===========================================================================

describe('M24 resetDayIfNeeded — zeroes spend on new day', () => {
  it('returns state unchanged when todayDate matches today', () => {
    const today = todayStr();
    const s: DaemonState = {
      ...zeroedState(),
      todayDate: today,
      todaySpentUsd: 0.5,
      itemsProcessed: 10,
    };
    const result = resetDayIfNeeded(s);
    expect(result.todaySpentUsd).toBe(0.5);
    expect(result.itemsProcessed).toBe(10);
    expect(result.todayDate).toBe(today);
  });

  it('zeroes todaySpentUsd when todayDate is yesterday', () => {
    const s: DaemonState = {
      ...zeroedState(),
      todayDate: yesterdayStr(),
      todaySpentUsd: 2.5,
    };
    const result = resetDayIfNeeded(s);
    expect(result.todaySpentUsd).toBe(0);
  });

  it('sets todayDate to today when it was yesterday', () => {
    const s: DaemonState = {
      ...zeroedState(),
      todayDate: yesterdayStr(),
      todaySpentUsd: 2.5,
    };
    const result = resetDayIfNeeded(s);
    expect(result.todayDate).toBe(todayStr());
  });

  it('zeroes todaySpentUsd when todayDate is null', () => {
    const s: DaemonState = { ...zeroedState(), todayDate: null, todaySpentUsd: 1.0 };
    const result = resetDayIfNeeded(s);
    expect(result.todaySpentUsd).toBe(0);
  });

  it('preserves itemsProcessed across day-roll', () => {
    const s: DaemonState = {
      ...zeroedState(),
      todayDate: yesterdayStr(),
      todaySpentUsd: 1.0,
      itemsProcessed: 99,
    };
    const result = resetDayIfNeeded(s);
    expect(result.itemsProcessed).toBe(99);
  });

  it('preserves ticks across day-roll', () => {
    const tick = makeTick({ reason: 'ok' });
    const s: DaemonState = {
      ...zeroedState(),
      todayDate: yesterdayStr(),
      todaySpentUsd: 1.0,
      ticks: [tick],
    };
    const result = resetDayIfNeeded(s);
    expect(result.ticks.length).toBe(1);
    expect(result.ticks[0]!.reason).toBe('ok');
  });

  it('preserves running, pid, startedAt, lastTickAt across day-roll', () => {
    const s: DaemonState = {
      running: true,
      pid: 42,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastTickAt: '2026-01-01T01:00:00.000Z',
      todayDate: yesterdayStr(),
      todaySpentUsd: 1.0,
      itemsProcessed: 3,
      ticks: [],
    };
    const result = resetDayIfNeeded(s);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(42);
    expect(result.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.lastTickAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('is pure — does not mutate the input state', () => {
    const s: DaemonState = {
      ...zeroedState(),
      todayDate: yesterdayStr(),
      todaySpentUsd: 3.0,
    };
    const original = { ...s };
    resetDayIfNeeded(s);
    expect(s.todaySpentUsd).toBe(original.todaySpentUsd);
    expect(s.todayDate).toBe(original.todayDate);
  });

  it('does not change state when todayDate is already today (no mutation)', () => {
    const today = todayStr();
    const s: DaemonState = {
      ...zeroedState(),
      todayDate: today,
      todaySpentUsd: 0.99,
    };
    const result = resetDayIfNeeded(s);
    // Either returns same object or a copy — both fine; but values must be same
    expect(result.todaySpentUsd).toBe(0.99);
    expect(result.todayDate).toBe(today);
  });
});

// ===========================================================================
// Ticks history — bounded, most-recent last
// ===========================================================================

describe('M24 DaemonState ticks history — round-trip fidelity', () => {
  it('ticks persist in insertion order (most-recent last)', () => {
    const t1 = makeTick({ ts: '2026-01-01T00:00:00.000Z', reason: 'ok' });
    const t2 = makeTick({ ts: '2026-01-01T01:00:00.000Z', reason: 'no-backlog' });
    const t3 = makeTick({ ts: '2026-01-01T02:00:00.000Z', reason: 'kill-switch' });
    const s: DaemonState = { ...zeroedState(), ticks: [t1, t2, t3] };
    saveDaemonState(s);
    const loaded = loadDaemonState();
    expect(loaded.ticks.length).toBe(3);
    expect(loaded.ticks[0]!.reason).toBe('ok');
    expect(loaded.ticks[1]!.reason).toBe('no-backlog');
    expect(loaded.ticks[2]!.reason).toBe('kill-switch');
  });

  it('all tick fields round-trip correctly', () => {
    const tick: DaemonTick = {
      ts: '2026-06-10T12:00:00.000Z',
      itemsConsidered: 5,
      proposalsCreated: 2,
      spentUsd: 0.025,
      reason: 'ok',
    };
    saveDaemonState({ ...zeroedState(), ticks: [tick] });
    const loaded = loadDaemonState();
    const lt = loaded.ticks[0]!;
    expect(lt.ts).toBe(tick.ts);
    expect(lt.itemsConsidered).toBe(5);
    expect(lt.proposalsCreated).toBe(2);
    expect(lt.spentUsd).toBeCloseTo(0.025, 6);
    expect(lt.reason).toBe('ok');
  });

  it('ticks with reason "dry-run" round-trip', () => {
    const tick = makeTick({ reason: 'dry-run', proposalsCreated: 0 });
    saveDaemonState({ ...zeroedState(), ticks: [tick] });
    const loaded = loadDaemonState();
    expect(loaded.ticks[0]!.reason).toBe('dry-run');
    expect(loaded.ticks[0]!.proposalsCreated).toBe(0);
  });

  it('ticks with reason "budget-exhausted" round-trip', () => {
    const tick = makeTick({ reason: 'budget-exhausted', proposalsCreated: 0, spentUsd: 0 });
    saveDaemonState({ ...zeroedState(), ticks: [tick] });
    const loaded = loadDaemonState();
    expect(loaded.ticks[0]!.reason).toBe('budget-exhausted');
  });

  it('large ticks array round-trips intact', () => {
    // The implementation may or may not bound; test just validates the
    // round-trip is valid (all fields present, array is an array).
    const ticks = Array.from({ length: 20 }, (_, i) =>
      makeTick({ ts: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`, reason: 'ok' }),
    );
    saveDaemonState({ ...zeroedState(), ticks });
    const loaded = loadDaemonState();
    expect(Array.isArray(loaded.ticks)).toBe(true);
    expect(loaded.ticks.length).toBeGreaterThan(0);
    for (const t of loaded.ticks) {
      expect(typeof t.ts).toBe('string');
      expect(typeof t.reason).toBe('string');
      expect(typeof t.proposalsCreated).toBe('number');
      expect(typeof t.spentUsd).toBe('number');
    }
  });

  it('a ticks array with 100 entries does not throw when saved', () => {
    const ticks = Array.from({ length: 100 }, (_, i) =>
      makeTick({ ts: new Date(Date.now() + i * 1000).toISOString() }),
    );
    expect(() => saveDaemonState({ ...zeroedState(), ticks })).not.toThrow();
  });
});
