/**
 * local-only-policy.test.ts — OWNER L: the local-only mode as a REFUSAL.
 *
 * Covers `src/core/policy/local-only.ts`, the single predicate every dispatch
 * path consults:
 *
 *   1. Mode resolution — persisted config, env override, and the invariant that
 *      the env can turn local-only ON but NEVER silently OFF.
 *   2. Locality classification — resolved-endpoint based, NOT tier based
 *      (local-coder and nim are both tier 'mid'; only one of them is free).
 *   3. The verdict — refusal names the subject, the mode, and the remedy.
 *   4. Routing helpers used by the cascade to terminate escalation cleanly.
 *
 * Hermetic: no network, no filesystem, no process.env mutation that outlives a
 * test (every call takes an explicit `env` object).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AshlrConfig, EngineId } from '../src/core/types.js';
import {
  ALWAYS_PERMITTED_ENGINE,
  LOCAL_ONLY_ENV_VAR,
  LocalOnlyRefusal,
  __resetLocalOnlyLatchForTests,
  ambientLocalOnlyMode,
  assertPermitted,
  binPermitted,
  cloudSubjectPermitted,
  endpointPermitted,
  engineIdForBin,
  engineLocality,
  enginePermitted,
  filterPermittedEngines,
  isLocalOnlyRefusal,
  isLoopbackEndpoint,
  localOnlyEnabled,
  localOnlyLatched,
  localOnlyPolicySnapshot,
  localOnlyReasonTag,
  permittedEnginesAtTier,
  providerLocality,
  providerPermitted,
  resolveLocalOnlyMode,
} from '../src/core/policy/local-only.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NO_ENV: Record<string, string | undefined> = {};

function cfgWith(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: { name: 'vscode' },
    models: { providerChain: ['ollama'], ollama: 'http://localhost:11434', lmstudio: '' },
    ...over,
  } as unknown as AshlrConfig;
}

/** Local-only ON via the persisted setting. */
function localOnlyCfg(): AshlrConfig {
  return cfgWith({ foundry: { localOnly: true, allowedBackends: ['builtin'] } });
}

/** Local-only OFF (the default). */
function openCfg(): AshlrConfig {
  return cfgWith({ foundry: { allowedBackends: ['builtin'] } });
}

beforeEach(() => {
  // The latch is a documented monotonic process global; clear it so suites
  // stay independent of each other's ordering.
  __resetLocalOnlyLatchForTests();
});

// ---------------------------------------------------------------------------
// 1. Mode resolution
// ---------------------------------------------------------------------------

describe('local-only mode resolution', () => {
  it('is OFF by default — no config, no env', () => {
    const mode = resolveLocalOnlyMode(openCfg(), NO_ENV);
    expect(mode.enabled).toBe(false);
    expect(mode.source).toBe('off');
    expect(localOnlyEnabled(openCfg(), NO_ENV)).toBe(false);
  });

  it('is OFF when cfg is entirely absent', () => {
    expect(resolveLocalOnlyMode(undefined, NO_ENV).enabled).toBe(false);
  });

  it('is ON from the persisted cfg.foundry.localOnly setting', () => {
    const mode = resolveLocalOnlyMode(localOnlyCfg(), NO_ENV);
    expect(mode.enabled).toBe(true);
    expect(mode.source).toBe('config');
    expect(mode.detail).toContain('cfg.foundry.localOnly=true');
  });

  it('also honours cfg.models.localOnly', () => {
    const cfg = cfgWith({
      models: { providerChain: ['ollama'], ollama: 'http://localhost:11434', lmstudio: '', localOnly: true },
    });
    expect(resolveLocalOnlyMode(cfg, NO_ENV).enabled).toBe(true);
  });

  it('cfg.foundry.localOnly=false does NOT enable the mode', () => {
    const cfg = cfgWith({ foundry: { localOnly: false } });
    expect(resolveLocalOnlyMode(cfg, NO_ENV).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The env override — can ENABLE, can never silently DISABLE
// ---------------------------------------------------------------------------

describe('local-only env override', () => {
  for (const token of ['1', 'true', 'yes', 'on', 'TRUE', ' 1 ']) {
    it(`env ${LOCAL_ONLY_ENV_VAR}=${JSON.stringify(token)} ENABLES the mode for one session`, () => {
      const mode = resolveLocalOnlyMode(openCfg(), { [LOCAL_ONLY_ENV_VAR]: token });
      expect(mode.enabled).toBe(true);
      expect(mode.source).toBe('env');
    });
  }

  it('an unrecognised env value FAILS SAFE and enables the mode', () => {
    // 'ture' is a typo for 'true'; failing toward local is the documented rule.
    const mode = resolveLocalOnlyMode(openCfg(), { [LOCAL_ONLY_ENV_VAR]: 'ture' });
    expect(mode.enabled).toBe(true);
    expect(mode.source).toBe('env');
  });

  for (const token of ['0', 'false', 'no', 'off', 'disabled']) {
    it(`env ${LOCAL_ONLY_ENV_VAR}=${JSON.stringify(token)} CANNOT disable a persisted local-only`, () => {
      const mode = resolveLocalOnlyMode(localOnlyCfg(), { [LOCAL_ONLY_ENV_VAR]: token });
      // THE INVARIANT: the mode stays on.
      expect(mode.enabled).toBe(true);
      expect(mode.source).toBe('config');
      // And the refusal is REPORTED, not silent.
      expect(mode.detail).toMatch(/refused/i);
      expect(mode.detail).toContain(LOCAL_ONLY_ENV_VAR);
      expect(mode.detail).toContain('cfg.foundry.localOnly=false');
    });
  }

  it('env off with no persisted setting leaves the mode off (the default)', () => {
    const mode = resolveLocalOnlyMode(openCfg(), { [LOCAL_ONLY_ENV_VAR]: '0' });
    expect(mode.enabled).toBe(false);
  });

  it('config ON + env ON reports both sources', () => {
    const mode = resolveLocalOnlyMode(localOnlyCfg(), { [LOCAL_ONLY_ENV_VAR]: '1' });
    expect(mode.enabled).toBe(true);
    expect(mode.source).toBe('config+env');
  });

  it('an empty env value is treated as unset, not as "on"', () => {
    expect(resolveLocalOnlyMode(openCfg(), { [LOCAL_ONLY_ENV_VAR]: '' }).enabled).toBe(false);
    expect(resolveLocalOnlyMode(openCfg(), { [LOCAL_ONLY_ENV_VAR]: '   ' }).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The process latch (for cfg-less transport seams)
// ---------------------------------------------------------------------------

describe('local-only process latch', () => {
  it('starts clear and latches when a persisted ON is observed', () => {
    expect(localOnlyLatched()).toBe(false);
    resolveLocalOnlyMode(localOnlyCfg(), NO_ENV);
    expect(localOnlyLatched()).toBe(true);
  });

  it('is monotonic — a later cfg with the setting off does not unlatch it', () => {
    resolveLocalOnlyMode(localOnlyCfg(), NO_ENV);
    resolveLocalOnlyMode(openCfg(), NO_ENV);
    expect(localOnlyLatched()).toBe(true);
  });

  it('a latched process refuses through the cfg-less ambient mode', () => {
    expect(ambientLocalOnlyMode(NO_ENV).enabled).toBe(false);
    resolveLocalOnlyMode(localOnlyCfg(), NO_ENV);
    const ambient = ambientLocalOnlyMode(NO_ENV);
    expect(ambient.enabled).toBe(true);
    expect(ambient.source).toBe('latch');
  });

  it('cfg-aware callers still read the live cfg, not the latch', () => {
    resolveLocalOnlyMode(localOnlyCfg(), NO_ENV);
    // The latch is on, but an explicit cfg that says off wins for this caller.
    expect(resolveLocalOnlyMode(openCfg(), NO_ENV).enabled).toBe(false);
  });

  it('an env-only enable does NOT latch the process', () => {
    resolveLocalOnlyMode(openCfg(), { [LOCAL_ONLY_ENV_VAR]: '1' });
    expect(localOnlyLatched()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Locality classification
// ---------------------------------------------------------------------------

describe('isLoopbackEndpoint', () => {
  for (const url of [
    'http://localhost:8080/v1',
    'http://127.0.0.1:11434/v1',
    'http://127.5.4.3:1234',
    'http://[::1]:8080/v1',
    'http://0.0.0.0:8080/v1',
    'https://app.localhost/v1',
  ]) {
    it(`treats ${url} as loopback`, () => expect(isLoopbackEndpoint(url)).toBe(true));
  }

  for (const url of [
    'https://api.moonshot.ai/v1',
    'https://integrate.api.nvidia.com/v1',
    'https://api.x.ai/v1',
    'https://openrouter.ai/api/v1',
    'http://192.168.1.14:8080/v1',
    'http://127.0.0.1.evil.com/v1',
  ]) {
    it(`treats ${url} as NOT loopback`, () => expect(isLoopbackEndpoint(url)).toBe(false));
  }

  it('treats an unparseable or empty endpoint as NOT loopback (fails safe)', () => {
    expect(isLoopbackEndpoint('not a url')).toBe(false);
    expect(isLoopbackEndpoint('')).toBe(false);
    expect(isLoopbackEndpoint(undefined)).toBe(false);
  });
});

describe('engineLocality', () => {
  const cfg = openCfg();

  it('builtin is local', () => expect(engineLocality('builtin', cfg, NO_ENV)).toBe('local'));

  it('local-coder (Ollama on loopback) is local DESPITE being tier "mid"', () => {
    expect(engineLocality('local-coder', cfg, NO_ENV)).toBe('local');
  });

  it('llama-server is local', () => {
    expect(engineLocality('llama-server', cfg, NO_ENV)).toBe('local');
  });

  it('llama-server pointed off-box by env is cloud', () => {
    expect(
      engineLocality('llama-server', cfg, { LLAMA_SERVER_BASE_URL: 'https://gpu.example.com/v1' }),
    ).toBe('cloud');
  });

  it('nim / kimi / grok are cloud DESPITE also being tier "mid"', () => {
    expect(engineLocality('nim', cfg, NO_ENV)).toBe('cloud');
    expect(engineLocality('kimi', cfg, NO_ENV)).toBe('cloud');
    expect(engineLocality('grok', cfg, NO_ENV)).toBe('cloud');
  });

  it('claude and codex (paid seats) are cloud', () => {
    expect(engineLocality('claude', cfg, NO_ENV)).toBe('cloud');
    expect(engineLocality('codex', cfg, NO_ENV)).toBe('cloud');
  });

  it('an unknown engine is cloud — unknown must not be assumed free', () => {
    expect(engineLocality('some-future-engine', cfg, NO_ENV)).toBe('cloud');
  });

  it('an api-model redirected to loopback by its baseUrlEnv becomes local', () => {
    expect(
      engineLocality('openai-compat', cfg, { OPENAI_COMPAT_BASE_URL: 'http://localhost:8080/v1' }),
    ).toBe('local');
  });

  it('an api-model redirected OFF loopback by its baseUrlEnv becomes cloud', () => {
    expect(
      engineLocality('local-coder', cfg, { OLLAMA_BASE_URL: 'https://ollama.example.com/v1' }),
    ).toBe('cloud');
  });
});

describe('providerLocality', () => {
  it('ollama / lmstudio / llama-server are local', () => {
    expect(providerLocality('ollama')).toBe('local');
    expect(providerLocality('lmstudio')).toBe('local');
    expect(providerLocality('llama-server')).toBe('local');
  });
  it('anthropic / openai / moonshot are cloud', () => {
    expect(providerLocality('anthropic')).toBe('cloud');
    expect(providerLocality('openai')).toBe('cloud');
    expect(providerLocality('moonshot')).toBe('cloud');
  });
});

// ---------------------------------------------------------------------------
// 5. The verdict — refusal is named, not generic
// ---------------------------------------------------------------------------

describe('the permission verdict', () => {
  it('permits every engine when the mode is OFF', () => {
    for (const e of ['claude', 'codex', 'nim', 'kimi', 'grok', 'local-coder', 'builtin']) {
      expect(enginePermitted(e, openCfg(), NO_ENV).permitted).toBe(true);
    }
  });

  it('refuses a cloud engine when the mode is ON, naming the engine and the mode', () => {
    const v = enginePermitted('claude', localOnlyCfg(), NO_ENV);
    expect(v.permitted).toBe(false);
    expect(v.reason).toBeTruthy();
    // NAMES THE ENGINE
    expect(v.reason).toContain("'claude'");
    // NAMES THE MODE
    expect(v.reason).toContain('local-only');
    expect(v.reason).toContain('cfg.foundry.localOnly=true');
    // SAYS WHAT TO DO ABOUT IT
    expect(v.reason).toContain('cfg.foundry.localOnly=false');
    expect(v.mode.enabled).toBe(true);
  });

  it('still permits FREE engines when the mode is ON', () => {
    // Free, not merely local. `ashlrcode` and `aw` are local PROCESSES and were
    // permitted here until docs/LOCALITY-VS-SPEND.md separated the two axes —
    // see the next test and test/local-only-consumer-parity.test.ts.
    for (const e of ['builtin', 'local-coder', 'llama-server']) {
      const v = enginePermitted(e, localOnlyCfg(), NO_ENV);
      expect(v.permitted, `${e} should be permitted under local-only`).toBe(true);
      expect(v.reason).toBeNull();
    }
  });

  it('refuses the local CLI agents that can still spend', () => {
    // The hub hands every cli-agent spawn CLAUDE_CODE_OAUTH_TOKEN /
    // ANTHROPIC_AUTH_TOKEN and the config dirs holding subscription auth
    // (run/sandboxed-engine.ts:782 + its env builder), then controls nothing.
    // Running on this machine is not the same claim as costing nothing.
    for (const e of ['ashlrcode', 'aw']) {
      const v = enginePermitted(e, localOnlyCfg(), NO_ENV);
      expect(v.permitted, `${e} can spend and must be refused`).toBe(false);
      expect(v.reason).toContain(`'${e}'`);
      // ...while the LOCALITY axis still, correctly, calls them local.
      expect(engineLocality(e, localOnlyCfg(), NO_ENV)).toBe('local');
    }
  });

  it('refuses every cloud engine the hub can route to', () => {
    const cfg = localOnlyCfg();
    for (const e of ['claude', 'codex', 'nim', 'kimi', 'grok', 'hermes']) {
      expect(enginePermitted(e, cfg, NO_ENV).permitted, `${e} must be refused`).toBe(false);
    }
  });

  it("'openai-compat' follows its endpoint, not its name: local by default, refused when pointed off-box", () => {
    const cfg = localOnlyCfg();
    // Its registry default base URL is http://localhost:8000/v1 (a self-hosted
    // vLLM/Fireworks-style server), so by default it costs nothing and is allowed.
    expect(enginePermitted('openai-compat', cfg, NO_ENV).permitted).toBe(true);
    // Point it at a billed endpoint and the same engine id is refused.
    const v = enginePermitted('openai-compat', cfg, {
      OPENAI_COMPAT_BASE_URL: 'https://api.together.xyz/v1',
    });
    expect(v.permitted).toBe(false);
    expect(v.reason).toContain("'openai-compat'");
  });

  it('refuses cloud providers and cloud endpoints too', () => {
    const cfg = localOnlyCfg();
    expect(providerPermitted('anthropic', cfg, NO_ENV).permitted).toBe(false);
    expect(providerPermitted('ollama', cfg, NO_ENV).permitted).toBe(true);
    expect(endpointPermitted('https://api.moonshot.ai/v1', cfg, NO_ENV).permitted).toBe(false);
    expect(endpointPermitted('http://localhost:8080/v1', cfg, NO_ENV).permitted).toBe(true);
  });

  it('accepts a caller-supplied cloud classification (plugin providers)', () => {
    // A plugin provider id the module could never classify on its own.
    const v = cloudSubjectPermitted('provider', 'acme-plugin', localOnlyCfg(), NO_ENV);
    expect(v.permitted).toBe(false);
    expect(v.reason).toContain("'acme-plugin'");
  });

  it('assertPermitted throws a typed LocalOnlyRefusal carrying the verdict', () => {
    const v = enginePermitted('codex', localOnlyCfg(), NO_ENV);
    let caught: unknown;
    try {
      assertPermitted(v);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LocalOnlyRefusal);
    expect(isLocalOnlyRefusal(caught)).toBe(true);
    expect((caught as LocalOnlyRefusal).code).toBe('LOCAL_ONLY_REFUSED');
    expect((caught as LocalOnlyRefusal).verdict.subject.id).toBe('codex');
    expect((caught as LocalOnlyRefusal).message).toContain('codex');
  });

  it('assertPermitted is a no-op for a permitted verdict', () => {
    expect(() => assertPermitted(enginePermitted('builtin', localOnlyCfg(), NO_ENV))).not.toThrow();
  });

  it('isLocalOnlyRefusal rejects unrelated errors', () => {
    expect(isLocalOnlyRefusal(new Error('boom'))).toBe(false);
    expect(isLocalOnlyRefusal(null)).toBe(false);
    expect(isLocalOnlyRefusal('LOCAL_ONLY_REFUSED')).toBe(false);
  });

  it('localOnlyReasonTag is short, log-safe, and names the subject + source', () => {
    const tag = localOnlyReasonTag(enginePermitted('nim', localOnlyCfg(), NO_ENV));
    expect(tag).toContain('local-only(config)');
    expect(tag).toContain("'nim'");
    expect(tag.length).toBeLessThan(120);
  });
});

// ---------------------------------------------------------------------------
// 6. Bin → engine resolution (the spawnEngine gate)
// ---------------------------------------------------------------------------

describe('binPermitted / engineIdForBin', () => {
  const cfg = localOnlyCfg();

  it('resolves absolute bin paths back to their engine id', () => {
    expect(engineIdForBin('/opt/homebrew/bin/claude', cfg)).toBe('claude');
    expect(engineIdForBin('codex', cfg)).toBe('codex');
    // ashlrcode's real binary is 'ac'.
    expect(engineIdForBin('/usr/local/bin/ac', cfg)).toBe('ashlrcode');
  });

  it('returns undefined for a binary no engine claims', () => {
    expect(engineIdForBin('phantom', cfg)).toBeUndefined();
    expect(engineIdForBin('', cfg)).toBeUndefined();
  });

  it('refuses a cloud agent binary under local-only', () => {
    const v = binPermitted('/opt/homebrew/bin/claude', cfg);
    expect(v.permitted).toBe(false);
    expect(v.reason).toContain("'claude'");
  });

  it('refuses a SPENDABLE agent binary under local-only, however local it runs', () => {
    // This is the hole run/engines.ts:455 was standing in: `ac` resolved to
    // 'ashlrcode', 'ashlrcode' was local, the spawn was permitted — and the
    // very next thing the spawn did was hand it working paid credentials.
    expect(binPermitted('ac', cfg).permitted).toBe(false);
    expect(binPermitted('aw', cfg).permitted).toBe(false);
  });

  it('permits an unrecognised binary — it is not a hub-managed agent', () => {
    expect(binPermitted('phantom', cfg).permitted).toBe(true);
    expect(binPermitted('/bin/sh', cfg).permitted).toBe(true);
  });

  it('permits everything when the mode is off', () => {
    expect(binPermitted('claude', openCfg()).permitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Routing helpers
// ---------------------------------------------------------------------------

describe('filterPermittedEngines', () => {
  it('is an identity no-op when the mode is off', () => {
    const all = ['claude', 'codex', 'nim', 'local-coder', 'builtin'];
    expect(filterPermittedEngines(all, openCfg(), NO_ENV)).toEqual(all);
  });

  it('drops every cloud engine when the mode is on', () => {
    const all = ['claude', 'codex', 'nim', 'kimi', 'grok', 'local-coder', 'builtin'];
    expect(filterPermittedEngines(all, localOnlyCfg(), NO_ENV)).toEqual(['local-coder', 'builtin']);
  });
});

describe('permittedEnginesAtTier', () => {
  const MID: EngineId[] = ['local-coder' as EngineId, 'nim' as EngineId];
  const FRONTIER: EngineId[] = ['claude' as EngineId, 'codex' as EngineId, 'nim' as EngineId];

  it('with the mode off, both tiers are reachable', () => {
    expect(permittedEnginesAtTier('mid', MID, openCfg(), NO_ENV).length).toBeGreaterThan(0);
    expect(permittedEnginesAtTier('frontier', FRONTIER, openCfg(), NO_ENV).length).toBeGreaterThan(0);
  });

  it('with the mode on, the mid tier keeps local-coder and drops nim', () => {
    expect(permittedEnginesAtTier('mid', MID, localOnlyCfg(), NO_ENV)).toEqual(['local-coder']);
  });

  it('with the mode on, the FRONTIER tier is EMPTY — the cascade must terminate there', () => {
    expect(permittedEnginesAtTier('frontier', FRONTIER, localOnlyCfg(), NO_ENV)).toEqual([]);
  });

  it('builtin always serves the local tier', () => {
    expect(
      permittedEnginesAtTier('local', [ALWAYS_PERMITTED_ENGINE], localOnlyCfg(), NO_ENV),
    ).toEqual([ALWAYS_PERMITTED_ENGINE]);
  });
});

// ---------------------------------------------------------------------------
// 8. The operator snapshot (consumed by the Verse autonomy panel)
// ---------------------------------------------------------------------------

describe('localOnlyPolicySnapshot', () => {
  it('reports the mode and quotes the policy detail', () => {
    const snap = localOnlyPolicySnapshot(localOnlyCfg(), NO_ENV);
    expect(snap.enabled).toBe(true);
    expect(snap.source).toBe('config');
    expect(snap.detail).toContain('cfg.foundry.localOnly=true');
  });

  it('lists the refused engines WITH their refusal, even while the mode is off', () => {
    // A UI must be able to preview the impact before anyone commits.
    const snap = localOnlyPolicySnapshot(openCfg(), NO_ENV);
    expect(snap.enabled).toBe(false);
    const engines = snap.refuses.map((r) => r.engine);
    for (const cloud of ['claude', 'codex', 'nim', 'kimi', 'grok']) {
      expect(engines, `${cloud} missing from the refusal preview`).toContain(cloud);
    }
    // The panel must list what the DISPATCHER refuses, or "nothing can spend
    // money while this is on" is false in the one place anyone checks it.
    for (const spendable of ['ashlrcode', 'aw']) {
      expect(engines, `${spendable} must be listed as refused`).toContain(spendable);
    }
    for (const free of ['builtin', 'local-coder', 'llama-server']) {
      expect(engines, `${free} must not be listed as refused`).not.toContain(free);
    }
    expect(snap.refuses.find((r) => r.engine === 'claude')?.reason).toContain("'claude'");
  });

  it('is mutable when the mode comes from config (or is off)', () => {
    expect(localOnlyPolicySnapshot(openCfg(), NO_ENV).mutable).toBe(true);
    expect(localOnlyPolicySnapshot(localOnlyCfg(), NO_ENV).mutable).toBe(true);
  });

  it('is NOT mutable when the env pinned the mode — the switch would be a lie', () => {
    const snap = localOnlyPolicySnapshot(openCfg(), { [LOCAL_ONLY_ENV_VAR]: '1' });
    expect(snap.enabled).toBe(true);
    expect(snap.source).toBe('env');
    expect(snap.mutable).toBe(false);
  });

  it('is NOT mutable once the process has latched', () => {
    resolveLocalOnlyMode(localOnlyCfg(), NO_ENV);
    const snap = localOnlyPolicySnapshot(undefined, NO_ENV);
    expect(snap.source).toBe('latch');
    expect(snap.mutable).toBe(false);
  });

  it('surfaces the refused env-disable attempt in detail', () => {
    const snap = localOnlyPolicySnapshot(localOnlyCfg(), { [LOCAL_ONLY_ENV_VAR]: 'false' });
    expect(snap.enabled).toBe(true);
    expect(snap.detail).toMatch(/refused/i);
  });
});
