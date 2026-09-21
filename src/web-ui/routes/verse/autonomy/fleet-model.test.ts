/**
 * fleet-model.test.ts — the rules that decide what the operator is told about
 * local capacity, pinned at the points where the convenient answer is wrong.
 *
 * The load-bearing one: a runtime that serializes must never have its
 * configured slot count reported as concurrency. That is the measured case on
 * this machine (docs/LOCAL-FLEET.md), and it is the difference between "four
 * agents" and "a four-deep queue that reads as slowness".
 */
import { describe, expect, it } from 'vitest';
import type { FleetSnapshot, LocalOnlyPolicy, ServingRuntimeSnapshot } from './fleet-contract.js';
import {
  elapsedSince,
  fleetPressure,
  formatContextTokens,
  localOnlyImpact,
  localOnlySourceNote,
  orderAgents,
  projectFleet,
  projectLocalOnly,
  projectServingRuntime,
  runtimeCapacity,
  slotUtilisation,
} from './fleet-model.js';

function runtime(over: Partial<ServingRuntimeSnapshot> = {}): ServingRuntimeSnapshot {
  return {
    kind: 'llama-server',
    state: 'running',
    endpoint: '127.0.0.1:8080',
    model: 'qwen3.8:27b-ctx64k',
    slotsTotal: 4,
    slotsBusy: 1,
    contextTokens: 16384,
    startedAt: '2026-09-21T00:00:00.000Z',
    parallel: { capable: true, refusal: null, slots: 4 },
    reason: null,
    supervised: true,
    sampledAt: '2026-09-21T01:00:00.000Z',
    ...over,
  };
}

describe('runtimeCapacity — a slot count is not a concurrency', () => {
  it('reports the configured slots as capacity only when the runtime batches', () => {
    const capacity = runtimeCapacity(runtime());
    expect(capacity.verdict).toBe('batched');
    expect(capacity.effectiveConcurrency).toBe(4);
    expect(capacity.overstated).toBe(false);
    expect(capacity.headline).toBe('4 agents in parallel');
  });

  it('reports ONE agent when the runtime serializes, however many slots are configured', () => {
    const capacity = runtimeCapacity(
      runtime({
        kind: 'ollama',
        slotsTotal: 4,
        parallel: {
          capable: false,
          refusal: 'model architecture does not currently support parallel requests',
          slots: 4,
        },
      }),
    );
    expect(capacity.verdict).toBe('serialized');
    // The number the UI prints. Never 4.
    expect(capacity.effectiveConcurrency).toBe(1);
    expect(capacity.overstated).toBe(true);
    expect(capacity.headline).toBe('Ollama serializes requests');
    expect(capacity.detail).toContain('the real capacity is one agent');
    expect(capacity.detail).toContain('queue');
  });

  it('quotes no concurrency at all when batching is unconfirmed', () => {
    const capacity = runtimeCapacity(runtime({ parallel: { capable: null, refusal: null, slots: 4 } }));
    expect(capacity.verdict).toBe('unknown');
    // Unknown is not 4 and not 1 — it is the absence of a number.
    expect(capacity.effectiveConcurrency).toBeNull();
    expect(capacity.detail).toContain('will not quote a concurrency it cannot stand behind');
  });

  it('is offline, not zero-capacity, when the runtime is not running', () => {
    const capacity = runtimeCapacity(runtime({ state: 'stopped' }));
    expect(capacity.verdict).toBe('offline');
    expect(capacity.effectiveConcurrency).toBeNull();
    expect(capacity.headline).toBe('Not serving');
  });

  it('treats an absent reading as unknown, never as a stopped runtime', () => {
    const capacity = runtimeCapacity(null);
    expect(capacity.verdict).toBe('unknown');
    expect(capacity.effectiveConcurrency).toBeNull();
    expect(capacity.detail).toContain('missing reading');
  });

  it('batches but cannot name a ceiling when the slot count is unreported', () => {
    const capacity = runtimeCapacity(
      runtime({ slotsTotal: null, parallel: { capable: true, refusal: null, slots: null } }),
    );
    expect(capacity.verdict).toBe('batched');
    expect(capacity.effectiveConcurrency).toBeNull();
  });
});

describe('slotUtilisation — occupancy measured against what will actually run', () => {
  it('draws one busy slot on a serializing runtime as FULL, not as a quarter', () => {
    const capacity = runtimeCapacity(
      runtime({ slotsBusy: 1, parallel: { capable: false, refusal: null, slots: 4 } }),
    );
    const u = slotUtilisation(1, capacity.effectiveConcurrency);
    expect(u.percent).toBe(100);
    expect(u.saturated).toBe(true);
    expect(u.label).toContain('new turns wait');
  });

  it('is unknown rather than zero when the slot count is not known', () => {
    const u = slotUtilisation(2, null);
    expect(u.percent).toBeNull();
    expect(u.saturated).toBe(false);
    expect(u.label).toContain('cannot be drawn');
  });

  it('never exceeds 100% when more turns are reported than slots', () => {
    const u = slotUtilisation(7, 4);
    expect(u.percent).toBe(100);
    expect(u.saturated).toBe(true);
  });
});

function fleet(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return { agents: [], queueDepth: 0, slotsTotal: 4, slotsBusy: 0, notes: [], sampledAt: null, ...over };
}

describe('fleetPressure — a queue is named as a queue', () => {
  it('says turns are waiting rather than letting a queue read as slowness', () => {
    const capacity = runtimeCapacity(runtime());
    const u = slotUtilisation(4, capacity.effectiveConcurrency);
    const pressure = fleetPressure(fleet({ queueDepth: 3, slotsBusy: 4 }), u, capacity);
    expect(pressure.state).toBe('queued');
    expect(pressure.headline).toBe('3 waiting for a slot');
    expect(pressure.detail).toContain('queueing, not work');
  });

  it('says the queue drains one at a time on a serializing runtime', () => {
    const capacity = runtimeCapacity(
      runtime({ parallel: { capable: false, refusal: null, slots: 4 } }),
    );
    const u = slotUtilisation(1, capacity.effectiveConcurrency);
    const pressure = fleetPressure(fleet({ queueDepth: 3, slotsBusy: 1 }), u, capacity);
    expect(pressure.detail).toContain('one at a time');
    expect(pressure.detail).toContain('not slow inference');
  });

  it('distinguishes a full fleet with no queue from a fleet with one', () => {
    const capacity = runtimeCapacity(runtime());
    const u = slotUtilisation(4, capacity.effectiveConcurrency);
    const agents = [0, 1, 2, 3].map((i) => ({
      id: `a${i}`,
      task: null,
      repo: null,
      engine: null,
      model: null,
      state: 'running' as const,
      startedAt: null,
      slot: i,
    }));
    const pressure = fleetPressure(fleet({ agents, queueDepth: 0, slotsBusy: 4 }), u, capacity);
    expect(pressure.state).toBe('saturated');
    expect(pressure.detail).toContain('nothing is queued');
  });

  it('calls an absent snapshot unknown, not idle', () => {
    const capacity = runtimeCapacity(null);
    const pressure = fleetPressure(null, slotUtilisation(null, null), capacity);
    expect(pressure.state).toBe('unknown');
    expect(pressure.headline).toBe('Fleet not reported');
  });

  it('calls an empty reported fleet idle, not stuck', () => {
    const capacity = runtimeCapacity(runtime());
    const pressure = fleetPressure(fleet(), slotUtilisation(0, 4), capacity);
    expect(pressure.state).toBe('idle');
    expect(pressure.detail).toContain('not stuck');
  });
});

describe('localOnlyImpact — the blast radius is the operator’s own number', () => {
  const seats = [
    { id: 'claude', engine: 'claude', label: 'Claude Code' },
    { id: 'codex-a', engine: 'codex', label: 'Personal Codex' },
    { id: 'local:qwen', engine: 'local', label: 'Qwen3.8 (local)' },
  ];

  it('counts blocked seats out of the live roster and names them', () => {
    const impact = localOnlyImpact(null, seats);
    expect(impact.blocked.map((s) => s.id)).toEqual(['claude', 'codex-a']);
    expect(impact.allowed.map((s) => s.id)).toEqual(['local:qwen']);
    expect(impact.summary).toContain('2 of 3 seats');
  });

  it('uses the policy’s own named refusal when it sent one', () => {
    const policy: LocalOnlyPolicy = {
      enabled: true,
      source: 'config',
      refuses: [{ engine: 'claude', reason: 'engine claude is cloud; local-only is on (config)' }],
      mutable: true,
      detail: null,
      sampledAt: null,
    };
    const impact = localOnlyImpact(policy, seats);
    expect(impact.refusalFor('claude')).toBe('engine claude is cloud; local-only is on (config)');
    // An engine the policy did not name still gets a refusal, not silence.
    expect(impact.refusalFor('codex')).toContain('local-only is on');
  });

  it('says plainly when nothing would be blocked', () => {
    const impact = localOnlyImpact(null, [seats[2]!]);
    expect(impact.summary).toContain('would block nothing');
  });
});

describe('localOnlySourceNote', () => {
  const base: LocalOnlyPolicy = {
    enabled: true,
    source: 'env',
    refuses: [],
    mutable: false,
    detail: null,
    sampledAt: null,
  };

  it('explains that an env-pinned policy cannot be changed from the UI', () => {
    expect(localOnlySourceNote(base)).toContain('cannot be changed from here');
  });

  it('prefers the policy’s own sentence over the template', () => {
    expect(localOnlySourceNote({ ...base, detail: 'ASHLR_LOCAL_ONLY=0 was refused: latched on.' })).toBe(
      'ASHLR_LOCAL_ONLY=0 was refused: latched on.',
    );
  });
});

describe('projection — owner R and L’s own shapes are read, not just this surface’s', () => {
  it('narrows a LlamaRuntimeSnapshot, preferring per-slot context over the total', () => {
    const projected = projectServingRuntime({
      schemaVersion: 1,
      state: 'up',
      baseUrl: 'http://127.0.0.1:8080/v1',
      origin: 'http://127.0.0.1:8080',
      host: '127.0.0.1',
      port: 8080,
      model: '/Users/x/.ollama/models/blobs/sha256-abc',
      modelName: 'qwen3.8:27b-ctx64k',
      quant: 'Q4_K_M',
      contextTotal: 65536,
      contextPerSlot: 16384,
      slots: { configured: 4, busy: 2, idle: 2, source: 'props' },
      pid: 4242,
      owner: 'cli',
      managed: true,
      startedAt: '2026-09-21T00:00:00.000Z',
      uptimeMs: 3_600_000,
      launchAgentInstalled: false,
      killSwitchEngaged: true,
      lastError: null,
      checkedAt: '2026-09-21T01:00:00.000Z',
    });
    expect(projected).not.toBeNull();
    expect(projected?.kind).toBe('llama-server');
    expect(projected?.state).toBe('running');
    expect(projected?.endpoint).toBe('127.0.0.1:8080');
    expect(projected?.model).toBe('qwen3.8:27b-ctx64k');
    expect(projected?.slotsTotal).toBe(4);
    expect(projected?.slotsBusy).toBe(2);
    // 65536 across four slots is 16k per agent — quoting the total would
    // overstate every turn's context fourfold.
    expect(projected?.contextTokens).toBe(16384);
    expect(projected?.supervised).toBe(true);
    expect(projected?.parallel.capable).toBe(true);
  });

  it('refuses to trust a slot count the runtime marked untrustworthy', () => {
    const projected = projectServingRuntime({
      state: 'up',
      host: '127.0.0.1',
      port: 8080,
      slots: { configured: 4, busy: 1, idle: 3, source: 'unknown' },
      managed: true,
      checkedAt: null,
    });
    expect(projected?.slotsTotal).toBeNull();
    expect(projected?.slotsBusy).toBeNull();
    // And therefore claims no batching, rather than inventing a concurrency.
    expect(projected?.parallel.capable).toBeNull();
    expect(runtimeCapacity(projected).effectiveConcurrency).toBeNull();
  });

  it('carries the resolver\u2019s own source through, and pins a process-pinned policy read-only', () => {
    const projected = projectLocalOnly({
      enabled: true,
      source: 'config+env',
      detail: 'Local-only is on: set in config and confirmed by ASHLR_LOCAL_ONLY.',
      mutable: true,
    });
    expect(projected?.enabled).toBe(true);
    // Carried through verbatim, NOT flattened onto a smaller union. The
    // flattening this replaced mapped 'latch' onto 'config', which tells an
    // operator a process-pinned mode is an editable stored setting.
    expect(projected?.source).toBe('config+env');
    // `mutable: true` in the body does not survive a process-pinned source.
    expect(projected?.mutable).toBe(false);
    expect(projected?.detail).toContain('confirmed by ASHLR_LOCAL_ONLY');
  });

  it('treats a latched policy as pinned, and an unrecognised source as pinned too', () => {
    // 'latch' means this process already observed a persisted local-only and
    // cannot un-observe it. A switch offered here would appear to work and
    // then be overridden on the next read.
    const latched = projectLocalOnly({ enabled: true, source: 'latch', mutable: true });
    expect(latched?.source).toBe('latch');
    expect(latched?.mutable).toBe(false);

    // A source this client cannot identify makes no claim — and offering a
    // switch for a policy it does not understand is the costlier mistake.
    const alien = projectLocalOnly({ enabled: true, source: 'from-the-future', mutable: true });
    expect(alien?.source).toBe('unknown');
    expect(alien?.mutable).toBe(false);

    // A plain stored setting is still editable.
    const stored = projectLocalOnly({ enabled: true, source: 'config', mutable: true });
    expect(stored?.mutable).toBe(true);
  });

  it('never reads an unstated local-only as "on"', () => {
    expect(projectLocalOnly({})?.enabled).toBe(false);
    expect(projectLocalOnly(null)).toBeNull();
  });

  it('drops fleet agents with no id rather than rendering a row it cannot key', () => {
    const projected = projectFleet({
      agents: [{ id: 'a1', state: 'running' }, { state: 'running' }, 'nonsense'],
      queueDepth: 2,
      notes: ['one note', 7],
    });
    expect(projected?.agents.map((a) => a.id)).toEqual(['a1']);
    expect(projected?.queueDepth).toBe(2);
    expect(projected?.notes).toEqual(['one note']);
  });
});

describe('small formatters', () => {
  it('quotes context in powers of two, the way the model card does', () => {
    expect(formatContextTokens(65536)).toBe('64k');
    expect(formatContextTokens(16384)).toBe('16k');
    expect(formatContextTokens(null)).toBe('—');
  });

  it('renders an absent start time as unknown rather than as zero elapsed', () => {
    expect(elapsedSince(null, Date.now())).toBe('—');
    expect(elapsedSince('not-a-date', Date.now())).toBe('—');
    expect(elapsedSince('2026-09-21T00:00:00.000Z', Date.parse('2026-09-21T00:02:05.000Z'))).toBe(
      '2m 05s',
    );
  });

  it('orders running before queued, and the longest-running first', () => {
    const ordered = orderAgents([
      { id: 'q', task: null, repo: null, engine: null, model: null, state: 'queued', startedAt: '2026-09-21T00:00:00.000Z', slot: null },
      { id: 'new', task: null, repo: null, engine: null, model: null, state: 'running', startedAt: '2026-09-21T00:05:00.000Z', slot: 1 },
      { id: 'old', task: null, repo: null, engine: null, model: null, state: 'running', startedAt: '2026-09-21T00:01:00.000Z', slot: 0 },
    ]);
    expect(ordered.map((a) => a.id)).toEqual(['old', 'new', 'q']);
  });
});
