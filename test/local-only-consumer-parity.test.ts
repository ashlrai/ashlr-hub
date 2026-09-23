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
 * Hermetic: no network, no filesystem, no process.env mutation. Every call
 * takes an explicit `env` object.
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
import { resolveEngineRegistry, BUILTIN_ENGINE_REGISTRY } from '../src/core/run/engine-registry.js';
import { estCostUsd, __resetBudgetMeterednessCacheForTests } from '../src/core/run/budget.js';

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
