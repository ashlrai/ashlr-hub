/**
 * verse-fleet-dispatch — the rules that decide how WIDE the local fleet runs.
 *
 * Every assertion here exists because the corresponding property was wrong in
 * the permissive or the dishonest direction, and wrong in a way no surface
 * reported. They are pure: no server is started, no socket is opened, nothing
 * is read from the real home.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  poolTierForBackend,
  resolveLocalPoolCap,
} from '../src/core/daemon/loop.js';
import {
  FENCE_SERIALIZED_ENGINES,
  LOCAL_FLEET_ENGINE,
  deriveLocalFleetConcurrency,
  type ServingRuntimeCapacity,
} from '../src/core/daemon/local-fleet.js';
import { engineTierOf } from '../src/core/run/sandboxed-engine.js';
import type { AshlrConfig, EngineId } from '../src/core/types.js';

function capacity(over: Partial<ServingRuntimeCapacity> = {}): ServingRuntimeCapacity {
  return {
    runtime: 'llama-server',
    endpoint: '127.0.0.1:8080',
    state: 'up',
    slots: 4,
    busySlots: 0,
    model: 'qwen3.8:27b-ctx64k',
    managed: true,
    startedAt: null,
    observedAt: new Date(0).toISOString(),
    detail: 'llama-server up with 4 slot(s)',
    ...over,
  };
}

describe('the local pool cap — the derivation must not be re-clamped', () => {
  it('uses the DERIVED slot count, not the resolveCfg default of 2', () => {
    // `deriveLocalFleetConcurrency` is deliberately fed null when the operator
    // configured nothing, so the runtime's own slot count becomes the
    // parallelism. Intersecting its answer with `dcfg.concurrency.local ?? 2`
    // afterwards threw that away — and `resolveCfg` ALWAYS populates
    // `concurrency`, so the intersection always found a 2. A four-slot runtime
    // ran two agents while the cockpit printed concurrency 4, limiter
    // 'serving-slots' and 50% utilisation, with nothing explaining the gap.
    const derived = deriveLocalFleetConcurrency(capacity({ slots: 4 }), null);
    expect(derived.effective).toBe(4);
    expect(derived.limiter).toBe('serving-slots');
    expect(resolveLocalPoolCap(derived, 2)).toBe(4);
  });

  it('still honours an operator cap BELOW the slot count', () => {
    // Lowering is the operator's prerogative; the derivation already applied
    // it and says so, so the dispatcher must not apply it a second time.
    const derived = deriveLocalFleetConcurrency(capacity({ slots: 4 }), 2);
    expect(derived.effective).toBe(2);
    expect(derived.limiter).toBe('config');
    expect(resolveLocalPoolCap(derived, 2)).toBe(2);
  });

  it('never lets a configured cap EXCEED the measured slots', () => {
    const derived = deriveLocalFleetConcurrency(capacity({ slots: 4 }), 12);
    expect(derived.effective).toBe(4);
    expect(derived.reason).toMatch(/NOT honoured/);
    expect(resolveLocalPoolCap(derived, 12)).toBe(4);
  });

  it('falls back to the daemon cap when the fleet is not armed', () => {
    expect(resolveLocalPoolCap(null, 2)).toBe(2);
    expect(resolveLocalPoolCap(null, 5)).toBe(5);
  });

  it('fails CLOSED to one agent when the runtime will not say how wide it is', () => {
    const mute = deriveLocalFleetConcurrency(capacity({ slots: null }), null);
    expect(mute.effective).toBe(1);
    expect(mute.limiter).toBe('fail-closed');

    const down = deriveLocalFleetConcurrency(capacity({ state: 'down', slots: null }), null);
    expect(down.effective).toBe(1);
    expect(down.limiter).toBe('fail-closed');
  });

  it('reports the MUTATION FENCE when the dispatch path holds it across a run', () => {
    // `runSwarm` holds the process-wide outward mutation fence for the whole
    // retained lifecycle, so exactly one such agent executes machine-wide no
    // matter how many slots exist. Quoting the slot count there would be a
    // number the machine cannot deliver.
    const fenced = deriveLocalFleetConcurrency(capacity({ slots: 4 }), null, {
      fenceSerialized: true,
    });
    expect(fenced.effective).toBe(1);
    expect(fenced.limiter).toBe('mutation-fence');
    expect(fenced.reason).toMatch(/one sandboxed agent/);

    // The fleet's own engine is NOT fence-serialised: `runApiModelSandboxed`
    // releases the fence across inference. If that ever regresses, this fails.
    expect(FENCE_SERIALIZED_ENGINES.has(LOCAL_FLEET_ENGINE)).toBe(false);
    expect(FENCE_SERIALIZED_ENGINES.has('builtin' as EngineId)).toBe(true);
  });
});

describe('pool tiering — by locality, never by trust tier', () => {
  const cfg = { user: { id: 't', name: 'T' } } as unknown as AshlrConfig;

  it('puts the fleet engine in the LOCAL pool even though its tier is mid', () => {
    // This is the whole bug: the registry calls llama-server tier 'mid' (it is
    // branch-eligible after verification), `poolTierOf` maps everything that
    // is not tier 'local' to 'cloud', and the measured slot ceiling is only
    // ever applied to TieredPool.local. So the ceiling bounded nothing the
    // fleet actually dispatched.
    const tier = engineTierOf(LOCAL_FLEET_ENGINE, cfg);
    expect(tier).toBe('mid');
    expect(poolTierForBackend(LOCAL_FLEET_ENGINE, tier)).toBe('local');
  });

  it('keeps every other on-device backend local too', () => {
    for (const backend of ['builtin', 'local-coder', 'ashlrcode', 'aw'] as EngineId[]) {
      expect(poolTierForBackend(backend, engineTierOf(backend, cfg))).toBe('local');
    }
  });

  it('leaves genuinely remote backends in the cloud pool', () => {
    for (const backend of ['claude', 'codex'] as EngineId[]) {
      expect(poolTierForBackend(backend, engineTierOf(backend, cfg))).toBe('cloud');
    }
  });
});

describe('getActiveClient — the fleet runtime is a dispatchable provider', () => {
  it('builds a client for llama-server instead of throwing "unknown provider"', async () => {
    // `getProviderRegistry` probes llama-server unconditionally and the
    // failover fallback selects it whenever lmstudio and ollama are down and
    // no cloud key is present — the steady state of a local-only 24/7 box.
    // Without this branch, every in-process provider chat (judge, manager,
    // strategist, director, playbook, dialogue) threw a misleading
    // "unknown provider 'llama-server'" precisely BECAUSE the fleet runtime
    // was healthy.
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/models') || url.includes('/api/tags')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'qwen3.8:27b-ctx64k' }] }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    try {
      const cfg = {
        user: { id: 't', name: 'T' },
        models: { providerChain: [] },
      } as unknown as AshlrConfig;

      const { getProviderRegistry } = await import('../src/core/providers.js');
      const registry = await getProviderRegistry(cfg);
      expect(registry.activeProvider).toBe('llama-server');

      const { getActiveClient } = await import('../src/core/run/provider-client.js');
      const client = await getActiveClient(cfg, { allowCloud: false });
      expect(client.id).toBe('llama-server');
      // The model id is what run records and telemetry will name, so it must
      // be the runtime's reference and never an empty string.
      expect(typeof client.model).toBe('string');
      expect(client.model.length).toBeGreaterThan(0);
      expect(typeof client.chat).toBe('function');
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });
});
