/**
 * verse-local-fleet.test.ts — the local agent fleet.
 *
 * WHAT THESE TESTS ARE FOR. The measured constraint in docs/LOCAL-FLEET.md is
 * that Ollama serialises Qwen3.8 and llama-server does not. The dangerous
 * failure is not "too slow" — it is a fleet that reports four agents while four
 * requests queue inside one runtime, or a 24/7 loop that looks alive and is
 * doing nothing. So the assertions below are about HONESTY under failure:
 * concurrency never exceeds real slots, an unreadable runtime fails closed to
 * one agent, a wedged turn is killed rather than held, and a snapshot written by
 * a dead daemon reads as stale rather than as busy.
 *
 * PURE BY CONSTRUCTION. No process is spawned, no port is bound, no model is
 * loaded: the runtime snapshot is a literal and the clock is injected. The
 * filesystem cases run under `withTmpHome`, so the real `~/.ashlr` — and in
 * particular the real `~/.ashlr/KILL` — is never read, written, or created.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { withTmpHome, makeCfg } from './helpers/h1-fixture.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { LlamaRuntimeSnapshot } from '../src/core/local-runtime/llama/types.js';
import {
  LOCAL_FLEET_ENGINE,
  LOCAL_FLEET_FAIL_CLOSED_CONCURRENCY,
  LocalFleetMonitor,
  capacityFromRuntimeSnapshot,
  deriveLocalFleetConcurrency,
  DEFAULT_LOCAL_FLEET_MAX_DISPATCHES_PER_DAY,
  localFleetDispatchAllowed,
  localFleetEnabled,
  localFleetLedgerPath,
  localFleetOutcomeOf,
  localFleetSnapshotPath,
  projectFleetSnapshot,
  readLocalFleetDispatchLedger,
  readLocalFleetSettings,
  readLocalFleetSnapshot,
  recordLocalFleetDispatch,
  reserveLocalFleetDispatch,
  registerServingCapacityProbe,
  resetServingCapacityCache,
  resolveServingCapacity,
  startLocalFleetHangWatchdog,
  writeLocalFleetSnapshot,
  type ServingRuntimeCapacity,
} from '../src/core/daemon/local-fleet.js';
import {
  __resetLocalOnlyLatchForTests,
  engineLocality,
  enginePermitted,
} from '../src/core/policy/local-only.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A llama-server runtime snapshot with the four slots this machine measured. */
function runtimeSnapshot(overrides: Partial<LlamaRuntimeSnapshot> = {}): LlamaRuntimeSnapshot {
  return {
    schemaVersion: 1,
    state: 'up',
    baseUrl: 'http://127.0.0.1:8080/v1',
    origin: 'http://127.0.0.1:8080',
    host: '127.0.0.1',
    port: 8080,
    model: '/blobs/sha256-abc',
    modelName: 'qwen3.8:27b-ctx64k',
    quant: 'Q4_K_M',
    contextTotal: 65_536,
    contextPerSlot: 16_384,
    slots: { configured: 4, busy: 1, idle: 3, source: 'props' },
    pid: 4242,
    owner: 'cli',
    managed: true,
    startedAt: '2026-09-21T00:00:00.000Z',
    uptimeMs: 60_000,
    launchAgentInstalled: false,
    killSwitchEngaged: true,
    lastError: null,
    checkedAt: '2026-09-21T00:01:00.000Z',
    ...overrides,
  };
}

function capacity(overrides: Partial<ServingRuntimeCapacity> = {}): ServingRuntimeCapacity {
  return {
    runtime: 'llama-server',
    endpoint: '127.0.0.1:8080',
    state: 'up',
    slots: 4,
    busySlots: 0,
    model: 'qwen3.8:27b-ctx64k',
    managed: true,
    startedAt: null,
    observedAt: '2026-09-21T00:00:00.000Z',
    detail: 'test',
    ...overrides,
  };
}

function localOnlyCfg(extra: Record<string, unknown> = {}): AshlrConfig {
  return makeCfg({
    foundry: { localOnly: true },
    ...extra,
  } as Partial<AshlrConfig>);
}

let savedLocalOnlyEnv: string | undefined;

beforeEach(() => {
  savedLocalOnlyEnv = process.env['ASHLR_LOCAL_ONLY'];
  delete process.env['ASHLR_LOCAL_ONLY'];
  __resetLocalOnlyLatchForTests();
  registerServingCapacityProbe(null);
  resetServingCapacityCache();
});

afterEach(() => {
  if (savedLocalOnlyEnv === undefined) delete process.env['ASHLR_LOCAL_ONLY'];
  else process.env['ASHLR_LOCAL_ONLY'] = savedLocalOnlyEnv;
  __resetLocalOnlyLatchForTests();
  registerServingCapacityProbe(null);
  resetServingCapacityCache();
});

// ---------------------------------------------------------------------------
// 1. Concurrency is bounded by real slots
// ---------------------------------------------------------------------------

describe('deriveLocalFleetConcurrency — parallelism derives from measured slots', () => {
  it('uses the runtime slot count when nothing is configured', () => {
    // NOT the old default of 2: that number was correct for a runtime which
    // refuses to run two agents at all, and it strands two measured slots here.
    const derived = deriveLocalFleetConcurrency(capacity({ slots: 4 }), null);
    expect(derived.effective).toBe(4);
    expect(derived.limiter).toBe('serving-slots');
  });

  it('honours a configured cap BELOW the slot count', () => {
    const derived = deriveLocalFleetConcurrency(capacity({ slots: 4 }), 2);
    expect(derived.effective).toBe(2);
    expect(derived.limiter).toBe('config');
  });

  it('refuses a configured cap ABOVE the slot count and says why', () => {
    // Eight agents at four slots is four agents plus an invisible queue.
    const derived = deriveLocalFleetConcurrency(capacity({ slots: 4 }), 8);
    expect(derived.effective).toBe(4);
    expect(derived.limiter).toBe('serving-slots');
    expect(derived.reason).toMatch(/NOT honoured/);
  });

  it('fails closed to one agent when the runtime is down', () => {
    const derived = deriveLocalFleetConcurrency(
      capacity({ state: 'down', slots: null }),
      8,
    );
    expect(derived.effective).toBe(LOCAL_FLEET_FAIL_CLOSED_CONCURRENCY);
    expect(derived.limiter).toBe('fail-closed');
  });

  it('fails closed when the runtime is up but will not report slots', () => {
    // "Reachable" is not "knowable". A runtime that answers but names no slot
    // count gives us nothing to derive from, and guessing is the whole sin.
    const derived = deriveLocalFleetConcurrency(capacity({ state: 'up', slots: null }), 4);
    expect(derived.effective).toBe(1);
    expect(derived.limiter).toBe('fail-closed');
    expect(derived.reason).toMatch(/no slot count/);
  });

  it('ignores a non-positive configured cap rather than hanging on zero', () => {
    const derived = deriveLocalFleetConcurrency(capacity({ slots: 4 }), 0);
    expect(derived.effective).toBe(4);
    expect(derived.configuredLocal).toBeNull();
  });
});

describe('capacityFromRuntimeSnapshot — adapting the runtime lane answer', () => {
  it('carries the slot count through for a running runtime', () => {
    const observed = capacityFromRuntimeSnapshot(runtimeSnapshot(), Date.parse('2026-09-21T00:02:00Z'));
    expect(observed.state).toBe('up');
    expect(observed.slots).toBe(4);
    expect(observed.busySlots).toBe(1);
    expect(observed.endpoint).toBe('127.0.0.1:8080');
  });

  it('never publishes a URL, only host:port', () => {
    const observed = capacityFromRuntimeSnapshot(runtimeSnapshot());
    expect(observed.endpoint).not.toMatch(/https?:\/\//);
  });

  it('treats a loading runtime as unknown, not as up', () => {
    // A model still loading has no usable slot. Reporting it up would let the
    // fleet dispatch into a wall and call the resulting failures the item's.
    const observed = capacityFromRuntimeSnapshot(
      runtimeSnapshot({ state: 'loading', slots: { configured: null, busy: null, idle: null, source: 'unknown' } }),
    );
    expect(observed.state).toBe('unknown');
    expect(observed.slots).toBeNull();
    expect(deriveLocalFleetConcurrency(observed, 4).effective).toBe(1);
  });

  it('reports a down runtime as down with no slots', () => {
    const observed = capacityFromRuntimeSnapshot(
      runtimeSnapshot({
        state: 'down',
        slots: { configured: null, busy: null, idle: null, source: 'unknown' },
        lastError: 'ECONNREFUSED',
      }),
    );
    expect(observed.state).toBe('down');
    expect(observed.slots).toBeNull();
    expect(observed.detail).toBe('ECONNREFUSED');
  });

  it('does not trust a slot count from a runtime that is not up', () => {
    // fleetConcurrencyLimit() is the runtime lane's rule; reading
    // slots.configured directly here would fork it.
    const observed = capacityFromRuntimeSnapshot(
      runtimeSnapshot({ state: 'down', slots: { configured: 4, busy: 0, idle: 4, source: 'props' } }),
    );
    expect(observed.slots).toBeNull();
  });
});

describe('resolveServingCapacity', () => {
  it('reports a throwing probe as down rather than propagating', async () => {
    registerServingCapacityProbe(async () => { throw new Error('boom'); });
    const settings = readLocalFleetSettings(localOnlyCfg());
    const observed = await resolveServingCapacity(localOnlyCfg(), settings, { nowMs: 1_000 });
    expect(observed.state).toBe('down');
    expect(observed.detail).toMatch(/probe failed/);
  });

  it('memoises within the TTL so a continuous loop does not become load', async () => {
    let calls = 0;
    registerServingCapacityProbe(async () => { calls += 1; return capacity(); });
    const settings = readLocalFleetSettings(localOnlyCfg());
    await resolveServingCapacity(localOnlyCfg(), settings, { nowMs: 1_000 });
    await resolveServingCapacity(localOnlyCfg(), settings, { nowMs: 1_500 });
    expect(calls).toBe(1);
    await resolveServingCapacity(localOnlyCfg(), settings, { nowMs: 9_000 });
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Local dispatch path + settings
// ---------------------------------------------------------------------------

describe('readLocalFleetSettings', () => {
  it('is armed by the local-only policy, not by a switch of its own', () => {
    expect(readLocalFleetSettings(makeCfg()).enabled).toBe(false);
    expect(readLocalFleetSettings(localOnlyCfg()).enabled).toBe(true);
  });

  it('follows an env-enabled local-only', () => {
    process.env['ASHLR_LOCAL_ONLY'] = '1';
    expect(localFleetEnabled(makeCfg())).toBe(true);
  });

  it('clamps the hang watchdog and backoff into sane ranges', () => {
    const settings = readLocalFleetSettings(localOnlyCfg({
      daemon: { localFleet: { taskTimeoutMs: 5, runtimeDownBackoffMs: 99_999_999, probeTimeoutMs: -3 } },
    }));
    expect(settings.taskTimeoutMs).toBeGreaterThanOrEqual(10_000);
    expect(settings.runtimeDownBackoffMs).toBeLessThanOrEqual(15 * 60_000);
    expect(settings.probeTimeoutMs).toBeGreaterThanOrEqual(100);
  });

  it('reads the explicit daily ceiling and rejects nonsense', () => {
    expect(readLocalFleetSettings(localOnlyCfg({
      daemon: { localFleet: { maxDispatchesPerDay: 40 } },
    })).maxDispatchesPerDay).toBe(40);
    // Junk is not an opt-out: it falls back to the finite default, because
    // "we could not parse your ceiling" must never mean "run unbounded".
    expect(readLocalFleetSettings(localOnlyCfg({
      daemon: { localFleet: { maxDispatchesPerDay: 'lots' } },
    })).maxDispatchesPerDay).toBe(DEFAULT_LOCAL_FLEET_MAX_DISPATCHES_PER_DAY);
    // An explicit null IS one.
    expect(readLocalFleetSettings(localOnlyCfg({
      daemon: { localFleet: { maxDispatchesPerDay: null } },
    })).maxDispatchesPerDay).toBeNull();
  });

  it('targets the llama-server engine, which local-only permits as local', () => {
    // The cross-lane invariant that makes this fleet dispatchable at all: if
    // the policy classified this engine as cloud, local-only would refuse every
    // turn and the fleet would be a fleet of zero.
    expect(LOCAL_FLEET_ENGINE).toBe('llama-server');
    expect(engineLocality(LOCAL_FLEET_ENGINE)).toBe('local');
    expect(enginePermitted(LOCAL_FLEET_ENGINE, localOnlyCfg()).permitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. 24/7 — the hang watchdog and health backoff
// ---------------------------------------------------------------------------

describe('startLocalFleetHangWatchdog', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires once the deadline passes', () => {
    let fired = 0;
    startLocalFleetHangWatchdog({ timeoutMs: 1_000, onExpire: () => { fired += 1; } });
    vi.advanceTimersByTime(1_001);
    expect(fired).toBe(1);
  });

  it('does not fire after it is cancelled', () => {
    let fired = 0;
    const cancel = startLocalFleetHangWatchdog({ timeoutMs: 1_000, onExpire: () => { fired += 1; } });
    cancel();
    cancel(); // idempotent
    vi.advanceTimersByTime(10_000);
    expect(fired).toBe(0);
  });

  it('survives an onExpire that throws', () => {
    const cancel = startLocalFleetHangWatchdog({
      timeoutMs: 10,
      onExpire: () => { throw new Error('abort failed'); },
    });
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    cancel();
  });
});

describe('LocalFleetMonitor health — a runtime restart must not wedge or stop the loop', () => {
  it('degrades then reports runtime-down with a growing park', () => {
    let clock = 0;
    const monitor = new LocalFleetMonitor({ now: () => clock });
    monitor.setSettings(readLocalFleetSettings(localOnlyCfg()));

    expect(monitor.health().state).toBe('healthy');

    clock = 1_000;
    monitor.setCapacity(capacity({ state: 'down', slots: null, detail: 'ECONNREFUSED' }));
    const first = monitor.health();
    expect(first.state).toBe('degraded');
    expect(first.backoffMs).toBeGreaterThan(0);

    clock = 2_000;
    monitor.setCapacity(capacity({ state: 'down', slots: null }));
    const second = monitor.health();
    expect(second.state).toBe('runtime-down');
    expect(second.backoffMs).toBeGreaterThan(first.backoffMs);
    expect(second.reasons.length).toBeGreaterThan(0);
  });

  it('recovers to healthy with no backoff when the runtime comes back', () => {
    const monitor = new LocalFleetMonitor({ now: () => 0 });
    monitor.setCapacity(capacity({ state: 'down', slots: null }));
    monitor.setCapacity(capacity({ state: 'down', slots: null }));
    expect(monitor.health().state).toBe('runtime-down');

    monitor.setCapacity(capacity({ state: 'up', slots: 4 }));
    const recovered = monitor.health();
    expect(recovered.state).toBe('healthy');
    expect(recovered.backoffMs).toBe(0);
    expect(recovered.lastRuntimeSuccessAt).not.toBeNull();
  });

  it('counts a timed-out turn as a runtime failure', () => {
    const monitor = new LocalFleetMonitor({ now: () => 0 });
    const id = monitor.beginAgent({ itemId: 'i1', repo: '/r', title: 't', engine: 'llama-server', model: null });
    monitor.endAgent(id, 'timeout', 'hang watchdog expired');
    const health = monitor.health();
    expect(health.timeouts).toBe(1);
    expect(health.state).not.toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// 4. Observability
// ---------------------------------------------------------------------------

describe('LocalFleetMonitor snapshot — is it working, and on what', () => {
  it('reports in-flight agents, elapsed time and slot utilisation', () => {
    let clock = 1_000;
    const monitor = new LocalFleetMonitor({ now: () => clock });
    monitor.setSettings(readLocalFleetSettings(localOnlyCfg()));
    monitor.setConcurrency(deriveLocalFleetConcurrency(capacity({ slots: 4 }), null));
    monitor.setCapacity(capacity({ slots: 4, busySlots: 2 }));

    // `beginAgent` enrolls a turn BEFORE sandbox creation and before the model
    // is contacted, so both start 'queued'. Only `markRunning` — wired to the
    // provider request — makes an agent occupy a slot.
    const a1 = monitor.beginAgent({ itemId: 'i1', repo: '/repo-a', title: 'Fix the parser', engine: 'llama-server', model: 'qwen3.8' });
    const a2 = monitor.beginAgent({ itemId: 'i2', repo: '/repo-b', title: 'Add a test', engine: 'llama-server', model: 'qwen3.8' });
    monitor.markRunning(a1);
    monitor.markRunning(a2);
    monitor.setQueue(7, ['Next thing', 'Other thing']);
    clock = 6_000;

    const snap = monitor.snapshot();
    expect(snap.inFlight).toHaveLength(2);
    expect(snap.inFlight[0]?.title).toBe('Fix the parser');
    expect(snap.inFlight[0]?.elapsedMs).toBe(5_000);
    expect(snap.slots).toEqual({ total: 4, busy: 2, idle: 2, utilizationPct: 50 });
    expect(snap.queue.depth).toBe(7);
    expect(snap.authority).toBe('none');
  });

  it('does not count a QUEUED agent as a busy slot', () => {
    // A turn waiting on sandbox creation or the process-wide mutation fence has
    // asked nothing of the runtime. Counting it busy is how a utilisation meter
    // reads 100% while llama-server's own /slots reports 1/4 — which is exactly
    // the disagreement that made "4 agents in flight" unfalsifiable.
    const monitor = new LocalFleetMonitor({ now: () => 0 });
    monitor.setSettings(readLocalFleetSettings(localOnlyCfg()));
    monitor.setConcurrency(deriveLocalFleetConcurrency(capacity({ slots: 4 }), null));
    monitor.setCapacity(capacity({ slots: 4, busySlots: 0 }));

    const waiting = monitor.beginAgent({ itemId: 'i1', repo: '/r', title: 't', engine: 'llama-server', model: null });
    expect(monitor.snapshot().slots.busy).toBe(0);
    expect(monitor.snapshot().inFlight[0]?.state).toBe('queued');

    monitor.markRunning(waiting);
    expect(monitor.snapshot().slots.busy).toBe(1);
    expect(monitor.snapshot().inFlight[0]?.state).toBe('running');
  });

  it('keeps recent completions newest-first and bounded', () => {
    const monitor = new LocalFleetMonitor({ now: () => 0, recentLimit: 2 });
    for (const id of ['a', 'b', 'c']) {
      const agentId = monitor.beginAgent({ itemId: id, repo: '/r', title: id, engine: 'llama-server', model: null });
      monitor.endAgent(agentId, 'proposed', 'filed');
    }
    const snap = monitor.snapshot();
    expect(snap.recent).toHaveLength(2);
    expect(snap.recent[0]?.title).toBe('c');
    expect(snap.totals.completed).toBe(3);
    expect(snap.totals.proposed).toBe(3);
  });

  it('clears in-flight agents when a tick unwinds, so no phantom agents remain', () => {
    // A cockpit showing busy agents for a tick that died is worse than showing
    // none: it looks like the fleet is working.
    const monitor = new LocalFleetMonitor({ now: () => 0 });
    monitor.beginAgent({ itemId: 'i1', repo: '/r', title: 't', engine: 'llama-server', model: null });
    monitor.clearInFlight('tick unwound');
    const snap = monitor.snapshot();
    expect(snap.inFlight).toHaveLength(0);
    expect(snap.recent[0]?.outcome).toBe('cancelled');
  });

  it('states the limiter, and that a spend cap is not it', () => {
    const monitor = new LocalFleetMonitor({ now: () => 0 });
    monitor.setSettings(readLocalFleetSettings(localOnlyCfg()));
    monitor.setConcurrency(deriveLocalFleetConcurrency(capacity({ slots: 4 }), null));
    const snap = monitor.snapshot();
    expect(snap.limiter.kind).toBe('serving-slots');
    expect(snap.limiter.concurrency).toBe(4);
    expect(snap.limiter.note).toMatch(/\$0/);
  });

  it('truncates long titles rather than carrying a payload into the snapshot', () => {
    const monitor = new LocalFleetMonitor({ now: () => 0 });
    monitor.beginAgent({
      itemId: 'i1', repo: '/r', title: 'x'.repeat(5_000), engine: 'llama-server', model: null,
    });
    expect((monitor.snapshot().inFlight[0]?.title ?? '').length).toBeLessThanOrEqual(120);
  });
});

describe('projectFleetSnapshot — the cockpit contract', () => {
  it('projects agents and carries the runtime numbers, not the derived cap', () => {
    const monitor = new LocalFleetMonitor({ now: () => 0 });
    monitor.setSettings(readLocalFleetSettings(localOnlyCfg()));
    monitor.setCapacity(capacity({ slots: 4, busySlots: 1 }));
    monitor.setConcurrency(deriveLocalFleetConcurrency(capacity({ slots: 4 }), 2));
    const running = monitor.beginAgent({ itemId: 'i1', repo: '/r', title: 'Task', engine: 'llama-server', model: 'qwen3.8' });
    monitor.markRunning(running);

    const view = projectFleetSnapshot(monitor.snapshot());
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]).toMatchObject({ task: 'Task', repo: '/r', engine: 'llama-server', state: 'running' });
    expect(view.slotsTotal).toBe(4);
    expect(view.slotsBusy).toBe(1);
    expect(view.notes.some((note) => note.includes('$0'))).toBe(true);
  });

  it('leaves unknown slot counts null instead of drawing a zero meter', () => {
    const monitor = new LocalFleetMonitor({ now: () => 0 });
    monitor.setCapacity(capacity({ state: 'up', slots: null, busySlots: null }));
    const view = projectFleetSnapshot(monitor.snapshot());
    expect(view.slotsTotal).toBeNull();
    expect(view.slotsBusy).toBeNull();
  });

  it('notes a stale read so four idle agents are not mistaken for a live fleet', () => {
    const monitor = new LocalFleetMonitor({ now: () => 0 });
    const view = projectFleetSnapshot(monitor.snapshot(), { freshness: 'stale', ageMs: 600_000 });
    expect(view.notes.some((note) => note.includes('stale'))).toBe(true);
  });
});

describe('localFleetOutcomeOf', () => {
  it('classifies a filed proposal, a no-diff run, a failure and a skip', () => {
    expect(localFleetOutcomeOf({ dispatched: true, dispatch: { production: { outcome: 'proposal-created' } } }).outcome)
      .toBe('proposed');
    expect(localFleetOutcomeOf({ dispatched: true, dispatch: { production: { outcome: 'no-diff' } } }).outcome)
      .toBe('no-proposal');
    expect(localFleetOutcomeOf({ dispatched: true, dispatch: { production: { outcome: 'producer-failed' } } }).outcome)
      .toBe('failed');
    expect(localFleetOutcomeOf({ dispatched: false, dispatch: { skipReason: 'budget-cap' } }).outcome)
      .toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// 5. Durable surfaces — all under an isolated HOME
// ---------------------------------------------------------------------------

describe('snapshot persistence', () => {
  it('writes under the isolated home and reads back fresh', async () => {
    await withTmpHome(async () => {
      const monitor = new LocalFleetMonitor({ now: () => Date.now() });
      monitor.setSettings(readLocalFleetSettings(localOnlyCfg()));
      monitor.setCapacity(capacity({ slots: 4 }));
      monitor.setConcurrency(deriveLocalFleetConcurrency(capacity({ slots: 4 }), null));
      monitor.beginAgent({ itemId: 'i1', repo: '/r', title: 'Work', engine: 'llama-server', model: null });
      expect(monitor.publish()).toBe(true);

      expect(localFleetSnapshotPath().startsWith(join(homedir(), '.ashlr'))).toBe(true);
      const read = readLocalFleetSnapshot();
      expect(read.freshness).toBe('fresh');
      expect(read.snapshot?.inFlight[0]?.title).toBe('Work');
      expect(read.snapshot?.concurrency.effective).toBe(4);
    });
  });

  it('reports a missing snapshot as missing, not as an empty fleet', async () => {
    await withTmpHome(async () => {
      const read = readLocalFleetSnapshot();
      expect(read.freshness).toBe('missing');
      expect(read.snapshot).toBeNull();
    });
  });

  it('reports an old snapshot as stale and still hands back its content', async () => {
    await withTmpHome(async () => {
      const monitor = new LocalFleetMonitor({ now: () => Date.now() - 600_000 });
      monitor.beginAgent({ itemId: 'i1', repo: '/r', title: 'Left running', engine: 'llama-server', model: null });
      expect(writeLocalFleetSnapshot(monitor.snapshot())).toBe(true);

      const read = readLocalFleetSnapshot();
      expect(read.freshness).toBe('stale');
      expect(read.snapshot?.inFlight).toHaveLength(1);
      expect(read.reason).toMatch(/may have stopped/);
    });
  });

  it('refuses a malformed snapshot rather than rendering garbage', async () => {
    await withTmpHome(async () => {
      mkdirSync(join(homedir(), '.ashlr', 'local-fleet'), { recursive: true, mode: 0o700 });
      writeFileSync(localFleetSnapshotPath(), '{"schemaVersion":99}\n', { mode: 0o600 });
      const read = readLocalFleetSnapshot();
      expect(read.freshness).toBe('unreadable');
      expect(read.snapshot).toBeNull();
    });
  });

  it('never writes anything that looks like a credential', async () => {
    await withTmpHome(async () => {
      const monitor = new LocalFleetMonitor({ now: () => Date.now() });
      monitor.setSettings(readLocalFleetSettings(localOnlyCfg()));
      monitor.setCapacity(capacity());
      monitor.publish();
      const body = readFileSync(localFleetSnapshotPath(), 'utf8');
      expect(body).not.toMatch(/Bearer|sk-|Authorization|token/i);
      expect(body).not.toMatch(/https?:\/\//);
    });
  });
});

describe('the explicit daily limiter — a spend cap cannot bound free work', () => {
  it('starts at zero and counts dispatches', async () => {
    await withTmpHome(async () => {
      expect(readLocalFleetDispatchLedger().dispatches).toBe(0);
      recordLocalFleetDispatch();
      recordLocalFleetDispatch();
      expect(readLocalFleetDispatchLedger().dispatches).toBe(2);
      expect(localFleetLedgerPath().startsWith(join(homedir(), '.ashlr'))).toBe(true);
    });
  });

  it('resets on a new UTC day rather than carrying yesterday forward', async () => {
    await withTmpHome(async () => {
      const day1 = Date.parse('2026-09-21T23:00:00Z');
      recordLocalFleetDispatch(day1);
      expect(readLocalFleetDispatchLedger(day1).dispatches).toBe(1);
      const day2 = Date.parse('2026-09-22T01:00:00Z');
      expect(readLocalFleetDispatchLedger(day2).dispatches).toBe(0);
    });
  });

  it('has a FINITE default ceiling, and null only as an explicit opt-out', async () => {
    await withTmpHome(async () => {
      // A local dispatch costs $0, so the USD cap can never fire for it. An
      // absent ceiling therefore meant a continuous loop with a 5s idle backoff
      // and a healthy runtime had nothing at all bounding its daily turn count.
      const allowance = localFleetDispatchAllowed(readLocalFleetSettings(localOnlyCfg()));
      expect(allowance.allowed).toBe(true);
      expect(allowance.cap).toBe(DEFAULT_LOCAL_FLEET_MAX_DISPATCHES_PER_DAY);

      // Writing null is a deliberate operator choice, and is reported as one.
      const optedOut = localFleetDispatchAllowed(readLocalFleetSettings(localOnlyCfg({
        daemon: { localFleet: { maxDispatchesPerDay: null } },
      })));
      expect(optedOut.cap).toBeNull();
      expect(optedOut.reason).toMatch(/opt-out/);
    });
  });

  it('reserves a place BEFORE the turn, and gives it back when nothing dispatched', async () => {
    await withTmpHome(async () => {
      const settings = readLocalFleetSettings(localOnlyCfg({
        daemon: { localFleet: { maxDispatchesPerDay: 2 } },
      }));
      // Counting after completion made long-running agents invisible to the
      // ceiling for their whole duration; reserving first is what makes it one.
      const first = reserveLocalFleetDispatch(settings);
      const second = reserveLocalFleetDispatch(settings);
      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      expect(reserveLocalFleetDispatch(settings).allowed).toBe(false);

      // A turn that never dispatched must not consume the day's quota.
      second.release();
      second.release(); // idempotent
      expect(reserveLocalFleetDispatch(settings).allowed).toBe(true);
    });
  });

  it('refuses once the configured ceiling is reached', async () => {
    await withTmpHome(async () => {
      const settings = readLocalFleetSettings(localOnlyCfg({
        daemon: { localFleet: { maxDispatchesPerDay: 2 } },
      }));
      recordLocalFleetDispatch();
      expect(localFleetDispatchAllowed(settings).allowed).toBe(true);
      recordLocalFleetDispatch();
      const blocked = localFleetDispatchAllowed(settings);
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toMatch(/daily ceiling reached/);
    });
  });
});
