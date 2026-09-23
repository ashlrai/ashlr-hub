/**
 * local-only-consumer-parity.test.ts — METEREDNESS is the spend axis, and
 * local-only refuses anything not provably free.
 *
 * WHY THIS FILE EXISTS (docs/LOCALITY-VS-SPEND.md)
 * -----------------------------------------------
 * `local-only.ts` used to answer ONE question — `EngineLocality` — and two
 * different callers read that one answer:
 *
 *   "where does the inference run?"  → a fact about processes and endpoints
 *   "can this spend money?"          → a fact about credentials and billing
 *
 * For every subject except CLI agents those happen to coincide. For
 * `ashlrcode` they do not: it is a local PROCESS that the hub hands
 * `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` and the config dirs where
 * subscription auth lives (`sandboxed-engine.ts:782` and the env builder
 * ~`:860-895`), and then controls nothing past the spawn. So under local-only
 * the hub was handing a "local" agent working paid credentials.
 *
 * The tests that matter here are NEGATIVE. A permissive test cannot catch a
 * permission bug — the bug IS the permission — so every assertion below is
 * either "this must be refused" or "this must not report $0".
 *
 * THE FOUR PROPERTIES
 *   §1  the classification table is COMPLETE — a new engine with no
 *       meteredness lands in 'unknown', and an unclassified shipped engine
 *       fails this suite (the drift tripwire)
 *   §2  local-only REFUSES `ashlrcode`, by engine id and by its `ac` binary
 *   §3  local-only REFUSES `unknown` — "I cannot tell" is not "safe"
 *   §4  free subjects still PASS, and `estCostUsd` never reports $0 for a
 *       metered or unknown subject
 *
 * §5 guards the OTHER failure mode: the locality axis must be untouched, because
 * local-fleet membership, pool tiering and local-context injection all
 * legitimately want "runs on this machine".
 *
 * §6-§8 ARE THE OTHER HALF OF "CONSUMER PARITY", and they police a different
 * kind of drift. §1-§5 ask whether the two AXES stay separate. §6-§8 ask
 * whether the consumers of the LOCALITY axis all get their answer from this
 * module instead of from a private list of their own. That is not
 * hypothetical either: the daemon's `LOCAL_ONLY_BACKENDS` called 'ashlrcode'
 * local while `autonomy/resource-strategy.ts`'s `CLOUD_BACKENDS` called it
 * cloud, and both were shipping. Seven such lists existed.
 *
 * DRIVEN OFF THE REGISTRY, NOT OFF A LIST WRITTEN HERE. A roster hardcoded in
 * this file would be another copy of the thing being deleted and would go
 * stale the same way. So the engine cases iterate `resolveEngineRegistry(cfg)`
 * — including engines these tests register through `cfg.foundry.engines` that
 * no hand-written list in `src/` could possibly contain — and the provider
 * cases iterate `LOCAL_PROVIDER_IDS`, the authority's own enumeration.
 *
 * Hermetic: no network, no filesystem, no process.env mutation. §1-§5 pass an
 * explicit `env` object to every policy call. §6-§8 deliberately do NOT: they
 * compare a consumer's answer against the policy's, and the consumers call
 * `engineLocality(id, cfg)` with no env argument, so the expectation must be
 * computed under the very same ambient env or the comparison is not
 * apples-to-apples.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import type { AshlrConfig, EngineId } from '../src/core/types.js';
import {
  CLI_AGENT_METEREDNESS,
  LOCAL_PROVIDER_IDS,
  __resetLocalOnlyLatchForTests,
  binPermitted,
  endpointMeteredness,
  endpointPermitted,
  engineIdForBin,
  engineLocality,
  engineMeteredness,
  enginePermitted,
  filterPermittedEngines,
  localOnlyPolicySnapshot,
  providerLocality,
  providerMeteredness,
  providerPermitted,
  subjectMeteredness,
  type Meteredness,
} from '../src/core/policy/local-only.js';
import {
  resolveEngineRegistry,
  resolveEngineSpec,
  BUILTIN_ENGINE_REGISTRY,
} from '../src/core/run/engine-registry.js';
import { estCostUsd, __resetBudgetMeterednessCacheForTests } from '../src/core/run/budget.js';
// The LOCALITY-axis consumers under parity in §6-§8. Each one used to carry its
// own hand-written set; each one now asks `local-only.ts`.
import { poolTierForBackend } from '../src/core/daemon/loop.js';
import { isLocalBackend as resourceStrategyIsLocalBackend } from '../src/core/autonomy/resource-strategy.js';
import { isLocalContextEnabled } from '../src/core/run/local-context.js';
import { isCloudProvider } from '../src/core/run/router.js';
import { isLocalProviderModel } from '../src/core/observability/rollup.js';
import { engineTierOf } from '../src/core/run/sandboxed-engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NO_ENV: Record<string, string | undefined> = {};

/**
 * A cli-agent the hub has never heard of, registered through
 * `cfg.foundry.engines`. No set literal anywhere in `src/` can contain it, so
 * the ONLY answer the policy can honestly give is 'unknown' — and 'unknown'
 * must be refused.
 */
const MYSTERY_AGENT = 'parity-mystery-agent';

/** A loopback api-model registered the same way — provably free, must pass. */
const LOOPBACK_ENGINE = 'parity-loopback-runtime';

function cfgWith(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: { name: 'vscode' },
    models: { providerChain: ['ollama'], ollama: 'http://localhost:11434', lmstudio: '' },
    ...over,
  } as unknown as AshlrConfig;
}

function foundry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowedBackends: ['builtin'],
    engines: {
      [MYSTERY_AGENT]: {
        id: MYSTERY_AGENT,
        kind: 'cli-agent',
        tier: 'local',
        bin: 'parity-mystery',
        bins: ['parity-mystery'],
        argv: ['$GOAL'],
        capabilities: ['agent'],
      },
      [LOOPBACK_ENGINE]: {
        id: LOOPBACK_ENGINE,
        kind: 'api-model',
        tier: 'mid',
        api: {
          envKey: '',
          baseUrlEnv: 'ASHLR_PARITY_LOOPBACK_BASE_URL',
          defaultBaseUrl: 'http://127.0.0.1:19999/v1',
          defaultModel: 'parity-loopback',
          protocol: 'openai',
        },
        capabilities: ['agent'],
      },
    },
    ...extra,
  };
}

/** Local-only ON via the persisted setting. */
function localOnlyCfg(): AshlrConfig {
  return cfgWith({ foundry: foundry({ localOnly: true }) });
}

/** Local-only OFF (the default). */
function openCfg(): AshlrConfig {
  return cfgWith({ foundry: foundry() });
}

beforeEach(() => {
  __resetLocalOnlyLatchForTests();
  __resetBudgetMeterednessCacheForTests();
});

// ---------------------------------------------------------------------------
// §1 — the classification table is complete (the drift tripwire)
// ---------------------------------------------------------------------------

describe('§1 every shipped subject carries an explicit meteredness', () => {
  it('every builtin cli-agent appears in CLI_AGENT_METEREDNESS', () => {
    // THE DRIFT TEST. Add a cli-agent to the registry without classifying it
    // and this fails, naming it. Without this, a new agent silently inherits
    // whatever the fallback happens to be — which is exactly how a "local"
    // ashlrcode kept paid credentials for as long as it did.
    const unclassified = Object.entries(BUILTIN_ENGINE_REGISTRY)
      .filter(([, spec]) => spec.kind === 'cli-agent')
      .map(([id]) => id)
      .filter((id) => !(id in CLI_AGENT_METEREDNESS));
    expect(
      unclassified,
      'these cli-agents ship with no meteredness classification — add them to CLI_AGENT_METEREDNESS in src/core/policy/local-only.ts',
    ).toEqual([]);
  });

  it('a builtin engine is "unknown" only where the table SAYS unknown', () => {
    // 'unknown' must be a deliberate statement ("we cannot read this agent's
    // backend"), never the residue of a missing entry. `aw` is the one engine
    // that earns it; anything else arriving here means someone shipped an
    // engine the classifier fell through on.
    const cfg = openCfg();
    const unknowns = Object.keys(BUILTIN_ENGINE_REGISTRY).filter(
      (id) => engineMeteredness(id, cfg, NO_ENV) === 'unknown',
    );
    for (const id of unknowns) {
      expect(
        CLI_AGENT_METEREDNESS[id],
        `${id} resolved to 'unknown' by accident — classify it in CLI_AGENT_METEREDNESS`,
      ).toBe('unknown');
    }
  });

  it('classifies the roster exactly as docs/LOCALITY-VS-SPEND.md decided', () => {
    const cfg = openCfg();
    const actual: Record<string, Meteredness> = {};
    for (const id of ['builtin', 'local-coder', 'llama-server', 'openai-compat',
                      'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'opencode',
                      'nim', 'kimi', 'grok']) {
      actual[id] = engineMeteredness(id, cfg, NO_ENV);
    }
    expect(actual).toEqual({
      // free — in-process, or a loopback endpoint that cannot bill anyone
      builtin: 'free',
      'local-coder': 'free',
      'llama-server': 'free',
      'openai-compat': 'free',   // default base URL is http://localhost:8000/v1
      // metered — the hub hands it credentials, or it is an outright cloud API
      ashlrcode: 'metered',      // OWNER DECISION (Option A): spends, hub controls nothing past the spawn
      claude: 'metered',
      codex: 'metered',
      hermes: 'metered',
      opencode: 'metered',
      nim: 'metered',
      kimi: 'metered',
      grok: 'metered',
      // unknown — a local-first agent whose cloud fallback is an OPT-IN the
      // hub cannot read (docs/ECOSYSTEM-MAP.md:155). Refused all the same.
      aw: 'unknown',
    });
  });

  it('an engine registered at runtime with no classification is "unknown"', () => {
    expect(engineMeteredness(MYSTERY_AGENT, openCfg(), NO_ENV)).toBe('unknown');
  });

  it('every free provider id is classified free, and the rest metered', () => {
    for (const id of LOCAL_PROVIDER_IDS) {
      expect(providerMeteredness(id), `${id} must be free`).toBe('free');
    }
    for (const id of ['anthropic', 'openai', 'google', 'xai', 'groq', 'deepseek']) {
      expect(providerMeteredness(id), `${id} must be metered`).toBe('metered');
    }
  });

  it('an endpoint we cannot parse is "unknown", never assumed free', () => {
    expect(endpointMeteredness('http://127.0.0.1:11434/v1')).toBe('free');
    expect(endpointMeteredness('https://api.anthropic.com')).toBe('metered');
    expect(endpointMeteredness('not a url')).toBe('unknown');
    expect(endpointMeteredness('')).toBe('unknown');
    expect(endpointMeteredness(undefined)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// §2 — local-only REFUSES ashlrcode (the hole this whole change exists to close)
// ---------------------------------------------------------------------------

describe('§2 local-only refuses ashlrcode', () => {
  it('refuses the engine id, naming the engine and the mode', () => {
    const v = enginePermitted('ashlrcode', localOnlyCfg(), NO_ENV);
    expect(v.permitted, 'ashlrcode can spend — it must be refused under local-only').toBe(false);
    expect(v.reason).toContain("'ashlrcode'");
    expect(v.reason).toContain('local-only');
    expect(v.reason).toContain('cfg.foundry.localOnly=false');
    expect(v.subject.meteredness).toBe('metered');
  });

  it('refuses the `ac` BINARY — the last-resort spawnEngine gate', () => {
    // run/engines.ts:455 is the actual hole: spawnEngine is handed a bin, not
    // an engine id, and `ac` resolved to a "local" engine and was permitted.
    const cfg = localOnlyCfg();
    expect(engineIdForBin('/usr/local/bin/ac', cfg)).toBe('ashlrcode');
    for (const bin of ['ac', '/usr/local/bin/ac', 'ashlrcode']) {
      const v = binPermitted(bin, cfg, NO_ENV);
      expect(v.permitted, `${bin} must not reach a spawn under local-only`).toBe(false);
      expect(v.reason).toContain("'ashlrcode'");
    }
  });

  it('is absent from the permitted routing set', () => {
    const cfg = localOnlyCfg();
    const permitted = filterPermittedEngines(
      ['builtin', 'local-coder', 'ashlrcode', 'aw', 'claude'] as EngineId[],
      cfg,
      NO_ENV,
    );
    expect(permitted).not.toContain('ashlrcode');
    expect(permitted).not.toContain('aw');
    expect(permitted).toContain('builtin');
    expect(permitted).toContain('local-coder');
  });

  it('is listed in the operator snapshot as refused, so the UI copy is true', () => {
    // "Nothing can spend money while this is on" — a panel that omits ashlrcode
    // while the dispatcher refuses it is the same disagreement in a new place.
    const engines = localOnlyPolicySnapshot(openCfg(), NO_ENV).refuses.map((r) => r.engine);
    expect(engines).toContain('ashlrcode');
    expect(engines).toContain('aw');
    expect(engines).not.toContain('builtin');
    expect(engines).not.toContain('local-coder');
    expect(engines).not.toContain('llama-server');
  });

  it('is permitted again when the mode is OFF — this is a refusal, not a ban', () => {
    expect(enginePermitted('ashlrcode', openCfg(), NO_ENV).permitted).toBe(true);
    expect(binPermitted('ac', openCfg(), NO_ENV).permitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3 — "I cannot tell" is not "safe"
// ---------------------------------------------------------------------------

describe('§3 local-only refuses unknown', () => {
  it('refuses a cli-agent whose configuration the hub cannot read', () => {
    const v = enginePermitted(MYSTERY_AGENT, localOnlyCfg(), NO_ENV);
    expect(v.permitted, 'unknown must be refused — a spend policy cannot guess').toBe(false);
    expect(v.subject.meteredness).toBe('unknown');
    // The refusal must say WHY it is different from a plain cloud refusal, or
    // an operator will read it as a misclassification and go turn the mode off.
    expect(v.reason).toContain(MYSTERY_AGENT);
    expect(v.reason).toMatch(/cannot verify|unclassified|not provably free/i);
  });

  it('refuses `aw` — local-first, but its cloud fallback is an opt-in we cannot read', () => {
    const v = enginePermitted('aw', localOnlyCfg(), NO_ENV);
    expect(v.permitted).toBe(false);
    expect(v.subject.meteredness).toBe('unknown');
    expect(binPermitted('aw', localOnlyCfg(), NO_ENV).permitted).toBe(false);
  });

  it('refuses an endpoint it cannot parse', () => {
    expect(endpointPermitted('not a url', localOnlyCfg(), NO_ENV).permitted).toBe(false);
    expect(endpointPermitted('', localOnlyCfg(), NO_ENV).permitted).toBe(false);
  });

  it('still permits an unrecognised BINARY — not every executable is an agent', () => {
    // Deliberate and documented: refusing every unknown executable would break
    // phantom wrapping and local tooling. Every engine the hub can route to IS
    // in the registry, so a spendable seat always resolves to an engine id.
    const cfg = localOnlyCfg();
    expect(binPermitted('phantom', cfg, NO_ENV).permitted).toBe(true);
    expect(binPermitted('/bin/sh', cfg, NO_ENV).permitted).toBe(true);
    // ...but an unknown ENGINE, which is a routable seat, is refused.
    expect(binPermitted('parity-mystery', cfg, NO_ENV).permitted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4 — free still passes, and nothing metered reports $0
// ---------------------------------------------------------------------------

describe('§4 free subjects pass; metered subjects cost something', () => {
  it('a local seat and a loopback endpoint still pass under local-only', () => {
    const cfg = localOnlyCfg();
    for (const e of ['builtin', 'local-coder', 'llama-server', LOOPBACK_ENGINE]) {
      const v = enginePermitted(e, cfg, NO_ENV);
      expect(v.permitted, `${e} is free and must still be permitted`).toBe(true);
      expect(v.reason).toBeNull();
      expect(v.subject.meteredness).toBe('free');
    }
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:11434/v1',
    ]) {
      expect(endpointPermitted(url, cfg, NO_ENV).permitted, url).toBe(true);
    }
    for (const p of ['ollama', 'lmstudio', 'llama-server']) {
      expect(providerPermitted(p, cfg, NO_ENV).permitted, p).toBe(true);
    }
  });

  it('estCostUsd does NOT report $0 for a metered cli-agent', () => {
    // ZERO IS WORSE THAN WRONG. Before this change 'ashlrcode' matched no price
    // key and fell to the conservative $3/$15 estimate — a wrong number, but a
    // VISIBLE one. Routing cost through locality would have made it $0 and
    // ended the scrutiny. It must stay non-zero.
    const cfg = openCfg();
    const cost = estCostUsd('ashlrcode', 1_000_000, 1_000_000, 0, 0, 0, cfg);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(18, 6); // the conservative $3 in / $15 out fallback
  });

  it('estCostUsd does NOT report $0 for an unknown subject either', () => {
    const cfg = openCfg();
    expect(estCostUsd('aw', 1_000_000, 1_000_000, 0, 0, 0, cfg)).toBeGreaterThan(0);
    expect(estCostUsd(MYSTERY_AGENT, 1_000_000, 1_000_000, 0, 0, 0, cfg)).toBeGreaterThan(0);
  });

  it('estCostUsd still reports $0 for genuinely free subjects, in BOTH id spaces', () => {
    // The id-space bug: budget.ts documents a PROVIDER id, sandboxed-engine.ts
    // calls it with an ENGINE id (:1825, :2161, :3061). Both must work, and
    // 'local-coder' (an engine, loopback) must not be priced as cloud just
    // because it is absent from the provider table.
    const cfg = openCfg();
    for (const id of ['ollama', 'lmstudio', 'builtin', 'local-coder', 'llama-server', LOOPBACK_ENGINE]) {
      expect(estCostUsd(id, 1_000_000, 1_000_000, 0, 0, 0, cfg), id).toBe(0);
    }
  });

  it('estCostUsd prices known cloud providers from the table, not the fallback', () => {
    expect(estCostUsd('anthropic', 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    expect(estCostUsd('openai', 1_000_000, 1_000_000)).toBeCloseTo(12.5, 6);
  });

  it('subjectMeteredness answers for engine ids and provider ids alike', () => {
    const cfg = openCfg();
    expect(subjectMeteredness('ollama', cfg, NO_ENV)).toBe('free');       // provider
    expect(subjectMeteredness('local-coder', cfg, NO_ENV)).toBe('free');  // engine
    expect(subjectMeteredness('ashlrcode', cfg, NO_ENV)).toBe('metered'); // engine
    expect(subjectMeteredness('anthropic', cfg, NO_ENV)).toBe('metered'); // provider
  });
});

// ---------------------------------------------------------------------------
// §5 — the locality axis must be UNCHANGED
// ---------------------------------------------------------------------------

describe('§5 locality still answers "where does the process run"', () => {
  it('ashlrcode and aw are still LOCAL on the locality axis', () => {
    // Reclassifying them as 'cloud' would fix spend and break local-fleet
    // membership, pool tiering and local-context injection — the failure mode
    // docs/LOCALITY-VS-SPEND.md exists to avoid. Two axes, not one renamed.
    const cfg = openCfg();
    expect(engineLocality('ashlrcode', cfg, NO_ENV)).toBe('local');
    expect(engineLocality('aw', cfg, NO_ENV)).toBe('local');
    expect(engineLocality('claude', cfg, NO_ENV)).toBe('cloud');
    expect(engineLocality('nim', cfg, NO_ENV)).toBe('cloud');
  });

  it('the two axes genuinely disagree for at least one subject', () => {
    // If they ever agree everywhere, someone has collapsed them again and the
    // split has silently become a rename.
    const cfg = openCfg();
    const disagree = Object.keys(resolveEngineRegistry(cfg)).filter((id) => {
      const local = engineLocality(id, cfg, NO_ENV) === 'local';
      const free = engineMeteredness(id, cfg, NO_ENV) === 'free';
      return local !== free;
    });
    expect(disagree).toContain('ashlrcode');
    expect(disagree).toContain('aw');
  });

  it('provider locality is untouched', () => {
    expect(providerLocality('ollama')).toBe('local');
    expect(providerLocality('anthropic')).toBe('cloud');
  });
});

// ---------------------------------------------------------------------------
// §6-§8 — every LOCALITY consumer asks this module, and none keeps a list
//
// The fixture below is separate from §1-§5's on purpose. Those sections assert
// completeness properties over `foundry()`'s roster (an unclassified cli-agent
// must land in 'unknown'), so quietly adding engines to it would change what
// they are testing. This one exists to prove a different thing: an engine that
// no set literal in `src/` can contain is still classified correctly by every
// consumer.
// ---------------------------------------------------------------------------

/** A brand-new api-model engine served from loopback — local, and unlistable. */
const NEW_LOCAL_ENGINE = 'parity-local-runtime';
/** Its remote counterpart, so the parity checks can fail in BOTH directions. */
const NEW_CLOUD_ENGINE = 'parity-remote-runtime';

function cfgWithNewEngines(): AshlrConfig {
  return cfgWith({
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
  });
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

describe('§6 the registry fixture actually exercises the property', () => {
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

describe('§7 every engine consumer agrees with engineLocality', () => {
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
    //
    // Note the axis: this says nothing about whether ashlrcode may SPEND. §2
    // and §4 answer that, and they answer 'no' — it is refused under local-only
    // and it is never priced at $0. Local process, metered credentials.
    const ashlrcode = 'ashlrcode' as EngineId;
    expect(engineLocality(ashlrcode, cfg)).toBe('local');
    expect(poolTierForBackend(ashlrcode, engineTierOf(ashlrcode, cfg), cfg)).toBe('local');
    expect(resourceStrategyIsLocalBackend(ashlrcode, cfg)).toBe(true);
  });

  it('local-context injection follows the registry, not a name list', () => {
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

  it('local-context never injects into a cloud engine', () => {
    for (const engine of cloudEngines(cfg)) {
      expect(
        isLocalContextEnabled(engine, cfg),
        `local-context would inject into cloud engine '${engine}'`,
      ).toBe(false);
    }
  });
});

describe('§8 every provider consumer agrees with providerLocality', () => {
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
    //
    // rollup asks LOCALITY here and that is correct for what it computes: a
    // "what would this have cost on a frontier API" savings estimate is a
    // counterfactual about where the weights ran, not a claim about what any
    // subject may bill. The spend question is `estCostUsd`, and §4 pins it.
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
