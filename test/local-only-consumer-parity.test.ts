/**
 * local-only consumer parity — the tripwire for the ONE-ENUMERATOR rule.
 *
 * `src/core/policy/local-only.ts` is the only module allowed to answer "is this
 * local". Every other module asks it. This suite fails the moment that stops
 * being true, and it fails in the shape the breakage actually takes: a new
 * local engine is registered, and some consumer — still carrying a private list
 * it forgot to update — keeps calling it cloud. That is not hypothetical. The
 * daemon's `LOCAL_ONLY_BACKENDS` said 'ashlrcode' was local while
 * resource-strategy's `CLOUD_BACKENDS` said it was cloud, and both were
 * shipping.
 *
 * DRIVEN OFF THE REGISTRY, NOT OFF A LIST WRITTEN HERE. A roster hardcoded in
 * this file would be another copy of the very thing being deleted, and it would
 * go stale in exactly the same way. So:
 *
 *   - the engine cases iterate `resolveEngineRegistry(cfg)`, including an
 *     engine this suite registers through `cfg.foundry.engines` that no
 *     hand-written list anywhere could contain;
 *   - the provider cases iterate `LOCAL_PROVIDER_IDS`, the authority's own
 *     enumeration, so adding a provider there extends this suite by itself.
 *
 * Add a local engine to the registry and every consumer must recognise it with
 * no edit to this file. That is the property under test.
 */
import { describe, expect, it } from 'vitest';

import {
  engineLocality,
  providerLocality,
  LOCAL_PROVIDER_IDS,
} from '../src/core/policy/local-only.js';
import { resolveEngineRegistry, resolveEngineSpec } from '../src/core/run/engine-registry.js';
import { poolTierForBackend } from '../src/core/daemon/loop.js';
import { isLocalBackend as resourceStrategyIsLocalBackend } from '../src/core/autonomy/resource-strategy.js';
import { isLocalContextEnabled } from '../src/core/run/local-context.js';
import { isCloudProvider } from '../src/core/run/router.js';
import { isLocalProviderModel } from '../src/core/observability/rollup.js';
import { engineTierOf } from '../src/core/run/sandboxed-engine.js';
import type { AshlrConfig, EngineId } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// The engine nothing has a list for.
//
// A brand-new api-model engine served from loopback. It exists ONLY in this
// config, so no set literal in src/ can possibly contain it — the only way a
// consumer classifies it correctly is by asking the policy.
// ---------------------------------------------------------------------------

const NEW_LOCAL_ENGINE = 'parity-local-runtime';
const NEW_CLOUD_ENGINE = 'parity-remote-runtime';

function cfgWithNewEngines(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {},
    telemetry: {},
    tools: {},
    foundry: {
      allowedBackends: ['builtin'],
      engines: {
        [NEW_LOCAL_ENGINE]: {
          id: NEW_LOCAL_ENGINE,
          kind: 'api-model',
          tier: 'mid',
          api: {
            envKey: '',
            baseUrlEnv: 'ASHLR_PARITY_LOCAL_BASE_URL',
            defaultBaseUrl: 'http://127.0.0.1:19999/v1',
            defaultModel: 'parity-local',
            protocol: 'openai',
          },
          capabilities: ['agent'],
        },
        [NEW_CLOUD_ENGINE]: {
          id: NEW_CLOUD_ENGINE,
          kind: 'api-model',
          tier: 'mid',
          api: {
            envKey: 'ASHLR_PARITY_REMOTE_API_KEY',
            baseUrlEnv: 'ASHLR_PARITY_REMOTE_BASE_URL',
            defaultBaseUrl: 'https://parity.example.invalid/v1',
            defaultModel: 'parity-remote',
            protocol: 'openai',
          },
          capabilities: ['agent'],
        },
      },
    },
  } as unknown as AshlrConfig;
}

/** Every engine the policy calls local, for this config. Never hardcoded. */
function localEngines(cfg: AshlrConfig): EngineId[] {
  return (Object.keys(resolveEngineRegistry(cfg)) as EngineId[])
    .filter((id) => engineLocality(id, cfg) === 'local');
}

/** Every engine the policy calls cloud, for this config. */
function cloudEngines(cfg: AshlrConfig): EngineId[] {
  return (Object.keys(resolveEngineRegistry(cfg)) as EngineId[])
    .filter((id) => engineLocality(id, cfg) === 'cloud');
}

describe('the registry fixture actually exercises the property', () => {
  const cfg = cfgWithNewEngines();

  it('registers an engine the policy calls local and that no src/ list contains', () => {
    // If this ever fails, every parity assertion below is vacuous — the new
    // engine stopped resolving, so "every consumer agrees" would be trivially
    // true over the builtin roster alone.
    expect(resolveEngineSpec(NEW_LOCAL_ENGINE, cfg)).toBeDefined();
    expect(engineLocality(NEW_LOCAL_ENGINE, cfg)).toBe('local');
    expect(localEngines(cfg)).toContain(NEW_LOCAL_ENGINE);
  });

  it('registers a remote counterpart so the parity checks can fail in both directions', () => {
    // A consumer that answers 'local' to everything would pass the local cases
    // and nothing else. This is what stops that.
    expect(engineLocality(NEW_CLOUD_ENGINE, cfg)).toBe('cloud');
    expect(cloudEngines(cfg)).toContain(NEW_CLOUD_ENGINE);
  });
});

describe('every engine consumer agrees with engineLocality', () => {
  const cfg = cfgWithNewEngines();

  it('daemon/loop.ts pools every local engine locally — including the new one', () => {
    for (const engine of localEngines(cfg)) {
      expect(
        poolTierForBackend(engine, engineTierOf(engine, cfg), cfg),
        `poolTierForBackend disagrees with the policy about '${engine}'`,
      ).toBe('local');
    }
  });

  it('daemon/loop.ts never pulls a cloud engine into the local pool on LOCALITY grounds', () => {
    // `poolTierForBackend` only ever OVERRIDES toward local; for anything the
    // policy calls cloud it defers to the trust tier (`poolTierOf`). So the
    // property to assert is that the locality override does not misfire — a
    // cloud engine at a non-local trust tier must stay in the cloud pool.
    for (const engine of cloudEngines(cfg)) {
      if (engineTierOf(engine, cfg) === 'local') continue; // see the next test
      expect(
        poolTierForBackend(engine, engineTierOf(engine, cfg), cfg),
        `poolTierForBackend disagrees with the policy about '${engine}'`,
      ).toBe('cloud');
    }
  });

  it('PINS a residue: a cloud engine at TRUST tier local still pools local', () => {
    // NOT introduced by the migration and NOT fixed by it — pinned so it is a
    // known, visible property rather than a surprise. `poolTierForBackend`
    // upgrades local-LOCALITY engines into the local pool and otherwise falls
    // through to `poolTierOf`, which maps the TRUST tier. 'opencode' is
    // registered `tier: 'local'` (it is not merge authority) while its
    // inference reaches a vendor, so the trust fallback pools it locally. The
    // old hardcoded LOCAL_ONLY_BACKENDS behaved identically here.
    //
    // Derived, not named: whatever engines have this shape, they are these.
    const trustLocalButRemote = cloudEngines(cfg)
      .filter((id) => engineTierOf(id, cfg) === 'local');
    for (const engine of trustLocalButRemote) {
      expect(poolTierForBackend(engine, 'local', cfg)).toBe('local');
    }
    // If this set ever empties, delete this test — do not relax the one above.
    expect(trustLocalButRemote.length).toBeGreaterThan(0);
  });

  it('autonomy/resource-strategy.ts agrees about every engine', () => {
    // This consumer is the one that DISAGREED: its CLOUD_BACKENDS listed
    // 'ashlrcode' while the daemon and the policy both called it local, so the
    // autonomous director and the dispatcher held opposite views of the same
    // backend. Parity is asserted over the whole registry, both directions.
    for (const engine of localEngines(cfg)) {
      expect(
        resourceStrategyIsLocalBackend(engine, cfg),
        `resource-strategy disagrees with the policy about '${engine}'`,
      ).toBe(true);
    }
    for (const engine of cloudEngines(cfg)) {
      expect(
        resourceStrategyIsLocalBackend(engine, cfg),
        `resource-strategy disagrees with the policy about '${engine}'`,
      ).toBe(false);
    }
  });

  it('ashlrcode is local everywhere, or nowhere', () => {
    // The specific contradiction this migration resolved, pinned so it cannot
    // come back quietly. local-only.ts is the authority; the others follow.
    const ashlrcode = 'ashlrcode' as EngineId;
    expect(engineLocality(ashlrcode, cfg)).toBe('local');
    expect(poolTierForBackend(ashlrcode, engineTierOf(ashlrcode, cfg), cfg)).toBe('local');
    expect(resourceStrategyIsLocalBackend(ashlrcode, cfg)).toBe(true);
  });
});

describe('local-context injection follows the registry, not a name list', () => {
  const cfg = cfgWithNewEngines();

  it('enables injection for every LOCAL API-MODEL engine, the new one included', () => {
    // The gate is deliberately narrower than "local": the bundle is a system-
    // prompt prefix, which only the in-process api-model path can apply. A
    // local CLI agent owns its own prompt. So the assertion is over the
    // intersection the module actually claims — still derived, never listed.
    const localApiModels = localEngines(cfg).filter(
      (id) => resolveEngineSpec(id, cfg)?.kind === 'api-model',
    );
    expect(localApiModels).toContain(NEW_LOCAL_ENGINE);
    for (const engine of localApiModels) {
      expect(
        isLocalContextEnabled(engine, cfg),
        `local-context disagrees with the policy about '${engine}'`,
      ).toBe(true);
    }
  });

  it('never injects into a cloud engine', () => {
    for (const engine of cloudEngines(cfg)) {
      expect(
        isLocalContextEnabled(engine, cfg),
        `local-context would inject into cloud engine '${engine}'`,
      ).toBe(false);
    }
  });
});

describe('every provider consumer agrees with providerLocality', () => {
  // Iterating the authority's own enumeration: adding a provider id to
  // LOCAL_PROVIDER_IDS extends this suite with no edit here.
  const localProviders = [...LOCAL_PROVIDER_IDS];

  it('the authority actually enumerates something', () => {
    expect(localProviders.length).toBeGreaterThan(0);
  });

  it('run/router.ts calls no local provider a cloud provider', () => {
    for (const id of localProviders) {
      expect(providerLocality(id)).toBe('local');
      expect(isCloudProvider(id), `router calls local provider '${id}' cloud`).toBe(false);
    }
  });

  it('observability/rollup.ts counts every local provider as local', () => {
    // rollup keys off a model string, and a bare provider id is the degenerate
    // case of one. Before the migration this was false for 'llama-server',
    // 'builtin' and 'local' — three local providers billed at cloud rates in
    // the rollup, which is the savings figure the cockpit prints.
    for (const id of localProviders) {
      expect(
        isLocalProviderModel(id),
        `rollup does not recognise local provider '${id}'`,
      ).toBe(true);
    }
  });

  it('both consumers still call a genuine cloud provider cloud', () => {
    for (const id of ['anthropic', 'openai', 'gemini']) {
      expect(providerLocality(id)).toBe('cloud');
      expect(isCloudProvider(id)).toBe(true);
      expect(isLocalProviderModel(id)).toBe(false);
    }
  });
});
