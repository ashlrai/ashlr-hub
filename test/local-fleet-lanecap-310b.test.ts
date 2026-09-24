/**
 * V3.10 U6 — the local fleet's concurrency derivation knows about the tick's
 * lane cap (TickHooks.beforeTick `laneCaps.local`: 2 while Mason is present, a
 * Leader lane decision, budget, grant) and names it when it binds, instead of
 * quoting a slot count the dispatcher will not use. Pure; nothing is read from
 * disk or the network.
 */
import { describe, expect, it } from 'vitest';

import {
  FENCE_SERIALIZED_ENGINES,
  LOCAL_FLEET_ENGINE,
  deriveLocalFleetConcurrency,
  type ServingRuntimeCapacity,
} from '../src/core/daemon/local-fleet.js';
import type { EngineId } from '../src/core/types.js';

function capacity(over: Partial<ServingRuntimeCapacity> = {}): ServingRuntimeCapacity {
  return {
    runtime: 'llama-server',
    endpoint: '127.0.0.1:8080',
    state: 'up',
    slots: 4,
    busySlots: 0,
    model: 'qwen',
    managed: true,
    startedAt: null,
    observedAt: new Date(0).toISOString(),
    detail: 'llama-server up with 4 slot(s)',
    ...over,
  };
}

describe('local fleet lane cap', () => {
  it('binds below the slot count and says why', () => {
    const derived = deriveLocalFleetConcurrency(capacity(), null, {
      laneCap: { limit: 2, reason: 'Mason is present (live Verse turn)' },
    });
    expect(derived).toMatchObject({ slots: 4, effective: 2, limiter: 'lane-cap' });
    expect(derived.reason).toBe('lane cap 2 is below 4 (serving-slots): Mason is present (live Verse turn)');
  });

  it('never raises the answer', () => {
    const derived = deriveLocalFleetConcurrency(capacity({ slots: 4 }), 3, {
      laneCap: { limit: 8, reason: 'Leader set 8' },
    });
    expect(derived).toMatchObject({ effective: 3, limiter: 'config' });
    const failClosed = deriveLocalFleetConcurrency(capacity({ state: 'down', slots: null }), null, {
      laneCap: { limit: 4, reason: 'default' },
    });
    expect(failClosed).toMatchObject({ effective: 1, limiter: 'fail-closed' });
  });

  it('a zero cap reads as lane off, with effective kept at 1', () => {
    const derived = deriveLocalFleetConcurrency(capacity(), null, { laneCap: { limit: 0, reason: 'grant lists no local engine' } });
    expect(derived).toMatchObject({ effective: 1, limiter: 'lane-cap' });
    expect(derived.reason).toBe('local lane is off this tick: grant lists no local engine');
  });

  it('no lane cap = exactly the previous derivation', () => {
    expect(deriveLocalFleetConcurrency(capacity(), null, { laneCap: null }))
      .toEqual(deriveLocalFleetConcurrency(capacity(), null));
  });

  it('only runSwarm still holds the fence across a whole run', () => {
    expect([...FENCE_SERIALIZED_ENGINES]).toEqual(['builtin']);
    expect(FENCE_SERIALIZED_ENGINES.has(LOCAL_FLEET_ENGINE)).toBe(false);
    for (const engine of ['claude', 'codex', 'grok-cli', 'local-coder'] as EngineId[]) {
      expect(FENCE_SERIALIZED_ENGINES.has(engine)).toBe(false);
    }
  });
});
