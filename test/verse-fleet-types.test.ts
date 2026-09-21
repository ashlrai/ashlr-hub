/**
 * verse-fleet-types — the wire contract for /api/verse/{runtime,fleet,local-only}.
 *
 * These tests pin the judgement calls in `src/core/verse/fleet-types.ts`, all
 * of which are about refusing to overstate capacity. They are pure: no server
 * is started, no socket is opened, nothing is read from the real home.
 */
import { describe, expect, it } from 'vitest';

import {
  emptyFleetSnapshot,
  projectLocalOnlyPolicy,
  projectServingRuntime,
  withLiveSlots,
  type ServingRuntimeSnapshot,
} from '../src/core/verse/fleet-types.js';
import type { LlamaRuntimeSnapshot } from '../src/core/local-runtime/llama/types.js';
import type { LocalOnlyPolicySnapshot } from '../src/core/policy/local-only.js';

function runtime(over: Partial<LlamaRuntimeSnapshot> = {}): LlamaRuntimeSnapshot {
  return {
    schemaVersion: 1,
    state: 'up',
    baseUrl: 'http://127.0.0.1:8080/v1',
    origin: 'http://127.0.0.1:8080',
    host: '127.0.0.1',
    port: 8080,
    model: '/blobs/sha256-abc',
    modelName: 'qwen3.8:27b-ctx64k',
    quant: 'Q8_0',
    contextTotal: 65536,
    contextPerSlot: 16384,
    slots: { configured: 4, busy: 2, idle: 2, source: 'props' },
    pid: 6296,
    owner: 'cli',
    managed: true,
    startedAt: '2026-09-21T05:31:00.000Z',
    uptimeMs: 600_000,
    launchAgentInstalled: false,
    killSwitchEngaged: true,
    lastError: null,
    checkedAt: '2026-09-21T05:41:00.000Z',
    ...over,
  };
}

describe('projectServingRuntime — capacity is never overstated', () => {
  it('reports the live slot count and calls a multi-slot runtime batching', () => {
    const wire = projectServingRuntime(runtime());
    expect(wire.kind).toBe('llama-server');
    expect(wire.state).toBe('running');
    expect(wire.slotsTotal).toBe(4);
    expect(wire.slotsBusy).toBe(2);
    expect(wire.parallel.capable).toBe(true);
    expect(wire.parallel.slots).toBe(4);
    expect(wire.supervised).toBe(true);
  });

  it('quotes context PER SLOT, not the -c total', () => {
    // `-c 65536 --parallel 4` gives each agent 16k. Quoting 64k would overstate
    // every turn fourfold — the same error class as quoting slots as concurrency.
    expect(projectServingRuntime(runtime()).contextTokens).toBe(16384);

    // And when /props cannot be read, the `-c` TOTAL is not a substitute. It is
    // only usable divided by a slot count we trust — otherwise a runtime whose
    // /props is briefly unreadable would report 65536 per agent when each slot
    // actually has 16384, in exactly the degraded state where nobody can check.
    expect(
      projectServingRuntime(runtime({ contextPerSlot: null })).contextTokens,
    ).toBe(16384);

    // No trusted slot count means no division, and no number.
    expect(
      projectServingRuntime(runtime({
        contextPerSlot: null,
        slots: { configured: 4, busy: 1, idle: 3, source: 'unknown' },
      })).contextTokens,
    ).toBeNull();
  });

  it('DROPS a slot count the runtime lane does not vouch for', () => {
    // `source: 'unknown'` is the runtime lane's own trust marker. A count
    // carrying it must not be quoted, and dropping it must cascade all the way
    // to "no concurrency claim" rather than stopping at a blank meter.
    const wire = projectServingRuntime(
      runtime({ slots: { configured: 4, busy: 1, idle: 3, source: 'unknown' } }),
    );
    expect(wire.slotsTotal).toBeNull();
    expect(wire.slotsBusy).toBeNull();
    expect(wire.parallel.slots).toBeNull();
    expect(wire.parallel.capable).toBeNull();
  });

  it('calls a single-slot runtime NOT batching, and says why', () => {
    // The field answers "will this runtime run my agents at the same time",
    // not "is this binary capable of continuous batching in principle".
    const wire = projectServingRuntime(
      runtime({ slots: { configured: 1, busy: 1, idle: 0, source: 'props' } }),
    );
    expect(wire.parallel.capable).toBe(false);
    expect(wire.reason).toContain('single slot');
    expect(wire.reason).toContain('--parallel');
  });

  it('never reports a loading runtime as running', () => {
    // A runtime still mapping 27 GB of weights answers /health before it can
    // answer a completion. Calling that "running" is how a fleet dispatches
    // into a wall.
    expect(projectServingRuntime(runtime({ state: 'loading' })).state).toBe('starting');
    expect(projectServingRuntime(runtime({ state: 'down' })).state).toBe('stopped');
    expect(projectServingRuntime(runtime({ state: 'unknown' })).state).toBe('unknown');
  });

  it('offers no controls for a runtime it does not own', () => {
    expect(projectServingRuntime(runtime({ managed: false })).supervised).toBe(false);
  });

  it('carries no secret, no launcher argv and no full URL', () => {
    const wire = projectServingRuntime(runtime());
    const serialized = JSON.stringify(wire);
    expect(wire.endpoint).toBe('127.0.0.1:8080');
    expect(serialized).not.toContain('http://');
    expect(serialized).not.toContain('--parallel');
    expect(serialized).not.toContain('llama-server -m');
    // Scan VALUES, not key names — `contextTokens` is a legitimate field and a
    // blanket regex over the serialized blob only catches itself.
    for (const value of Object.values(wire)) {
      if (typeof value !== 'string') continue;
      expect(value).not.toMatch(/bearer|authorization|api[-_]?key|sk-[A-Za-z0-9]/i);
    }
    // The blob path the server was launched with is machine-identifying and has
    // no operator value; the human model name is what travels.
    expect(serialized).not.toContain('sha256-');
  });

  it('never reports a blob digest as the model name', () => {
    // An ADOPTED runtime — one the operator launched in a terminal — has no
    // `modelName`, and llama-server reports its model as the Ollama blob path.
    // Falling back to that put `sha256-2bb22714…` on the wire as the model an
    // operator is running: it identifies the machine's storage layout and names
    // nothing. Null renders as "unknown", which is the honest answer.
    const adopted = projectServingRuntime(
      runtime({
        modelName: null,
        model: '/Users/x/.ollama/models/blobs/sha256-2bb22714289826d7b9e0ba376c3ce47d08bce39abe598745857c44d88c09bdbf',
        managed: false,
      }),
    );
    expect(adopted.model).toBeNull();
    expect(JSON.stringify(adopted)).not.toContain('sha256-');

    // A real filename is still worth showing.
    expect(
      projectServingRuntime(runtime({ modelName: null, model: '/models/qwen3.8-27b-q8_0.gguf' })).model,
    ).toBe('qwen3.8-27b-q8_0.gguf');
  });

  it('surfaces the runtime lane’s own error rather than inventing one', () => {
    const wire = projectServingRuntime(runtime({ lastError: 'connect ECONNREFUSED' }));
    expect(wire.reason).toBe('connect ECONNREFUSED');
    // And never fabricates a refusal llama-server did not make.
    expect(wire.parallel.refusal).toBeNull();
  });
});

describe('projectLocalOnlyPolicy — the resolver’s own words survive', () => {
  const snap: LocalOnlyPolicySnapshot = {
    enabled: true,
    source: 'config+env',
    refuses: [{ engine: 'claude', reason: 'local-only: claude is a cloud engine and is refused.' }],
    mutable: false,
    detail: 'local-only is ON (persisted, and ASHLR_LOCAL_ONLY is set).',
  };

  it('carries source, refusals and detail through unflattened', () => {
    const wire = projectLocalOnlyPolicy(snap, '2026-09-21T05:41:00.000Z');
    expect(wire.source).toBe('config+env');
    expect(wire.mutable).toBe(false);
    expect(wire.detail).toContain('ASHLR_LOCAL_ONLY');
    expect(wire.refuses[0]?.reason).toContain('refused');
    expect(wire.sampledAt).toBe('2026-09-21T05:41:00.000Z');
  });

  it('ships the refusal list even while the mode is OFF, so it can be previewed', () => {
    const off = projectLocalOnlyPolicy({ ...snap, enabled: false, source: 'off', mutable: true }, 'now');
    expect(off.enabled).toBe(false);
    expect(off.refuses).toHaveLength(1);
    expect(off.mutable).toBe(true);
  });
});

describe('fleet snapshot folding', () => {
  it('an absent snapshot is a stated absence, not an idle fleet', () => {
    const empty = emptyFleetSnapshot('the local fleet has not written a snapshot yet', 'now');
    expect(empty.agents).toEqual([]);
    // The distinction that matters: no slot numbers at all, rather than zeros
    // that read as "up and idle".
    expect(empty.slotsTotal).toBeNull();
    expect(empty.slotsBusy).toBeNull();
    expect(empty.notes[0]).toContain('has not written a snapshot');
  });

  it('the LIVE runtime reading wins over the snapshot’s aged slot numbers', () => {
    // Otherwise the fleet panel and the runtime panel show two different slot
    // counts for the same server — the exact disagreement this contract exists
    // to prevent.
    const stale = { ...emptyFleetSnapshot('stale', 'now'), slotsTotal: 2, slotsBusy: 2 };
    const live = projectServingRuntime(runtime());
    const folded = withLiveSlots(stale, live);
    expect(folded.slotsTotal).toBe(4);
    expect(folded.slotsBusy).toBe(2);
  });

  it('an untrustworthy live reading does NOT blank the snapshot’s numbers', () => {
    const known = { ...emptyFleetSnapshot('n', 'now'), slotsTotal: 4, slotsBusy: 1 };
    const untrusted: ServingRuntimeSnapshot = projectServingRuntime(
      runtime({ slots: { configured: 4, busy: 1, idle: 3, source: 'unknown' } }),
    );
    expect(withLiveSlots(known, untrusted).slotsTotal).toBe(4);
    expect(withLiveSlots(known, null).slotsTotal).toBe(4);
  });
});
