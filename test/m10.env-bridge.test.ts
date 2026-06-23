/**
 * M10 env-bridge tests — hermetic, no network, no filesystem writes.
 *
 * Covers the config -> env projection (core/env-bridge.ts):
 *  - correct mapping of endpoints / provider chain / model / paths / flags
 *  - empty/undefined sources are omitted (no blank keys)
 *  - opts.provider / opts.model override / supply values
 *  - SECURITY INVARIANT: NO secret-shaped keys are ever emitted, and base-env
 *    secret values are preserved (never stripped) but also never added by us
 *  - withToolEnv merges over the base env, ashlr keys winning on collision
 */

import { describe, it, expect } from 'vitest';
import { buildToolEnv, withToolEnv } from '../src/core/env-bridge.js';
import { CONFIG_PATH, CONFIG_DIR } from '../src/core/config.js';
import { join, delimiter } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(over?: Partial<AshlrConfig>): AshlrConfig {
  return {
    version: 1,
    roots: ['/home/u/Desktop/github', '/home/u/Desktop'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['lmstudio', 'ollama', 'anthropic'],
    },
    telemetry: {},
    tools: {},
    ...over,
  };
}

/** Patterns that must NEVER appear as keys the bridge emits. */
const SECRET_KEY_RE = /(_API_KEY|_SECRET|_TOKEN|PASSWORD|^ANTHROPIC_|^OPENAI_API|^GEMINI_|^COHERE_|^GROQ_)/i;

// ---------------------------------------------------------------------------
// buildToolEnv — mappings
// ---------------------------------------------------------------------------

describe('buildToolEnv — endpoint mappings', () => {
  it('maps ollama URL to OLLAMA_HOST + OLLAMA_BASE_URL', () => {
    const env = buildToolEnv(makeConfig());
    expect(env['OLLAMA_HOST']).toBe('http://localhost:11434');
    expect(env['OLLAMA_BASE_URL']).toBe('http://localhost:11434');
  });

  it('maps lmstudio URL to LM_STUDIO_URL + OPENAI_BASE_URL (endpoint, never key)', () => {
    const env = buildToolEnv(makeConfig());
    expect(env['LM_STUDIO_URL']).toBe('http://localhost:1234');
    expect(env['OPENAI_BASE_URL']).toBe('http://localhost:1234');
  });

  it('omits endpoint keys when the source URL is empty/whitespace', () => {
    const env = buildToolEnv(
      makeConfig({
        models: { lmstudio: '   ', ollama: '', providerChain: ['ollama'] },
      }),
    );
    expect(env['OLLAMA_HOST']).toBeUndefined();
    expect(env['OLLAMA_BASE_URL']).toBeUndefined();
    expect(env['LM_STUDIO_URL']).toBeUndefined();
    expect(env['OPENAI_BASE_URL']).toBeUndefined();
  });
});

describe('buildToolEnv — provider chain + active provider', () => {
  it('sets ASHLR_LLM_PROVIDER to providerChain[0] by default', () => {
    const env = buildToolEnv(makeConfig());
    expect(env['ASHLR_LLM_PROVIDER']).toBe('lmstudio');
  });

  it('opts.provider overrides the chain head', () => {
    const env = buildToolEnv(makeConfig(), { provider: 'ollama' });
    expect(env['ASHLR_LLM_PROVIDER']).toBe('ollama');
  });

  it('joins the full provider chain into ASHLR_PROVIDER_CHAIN (CSV)', () => {
    const env = buildToolEnv(makeConfig());
    expect(env['ASHLR_PROVIDER_CHAIN']).toBe('lmstudio,ollama,anthropic');
  });

  it('omits ASHLR_PROVIDER_CHAIN when the chain is empty', () => {
    const env = buildToolEnv(
      makeConfig({ models: { lmstudio: 'x', ollama: 'y', providerChain: [] } }),
    );
    expect(env['ASHLR_PROVIDER_CHAIN']).toBeUndefined();
    expect(env['ASHLR_LLM_PROVIDER']).toBeUndefined();
  });
});

describe('buildToolEnv — model name', () => {
  it('sets ASHLR_MODEL + AC_MODEL when a model is supplied', () => {
    const env = buildToolEnv(makeConfig(), { model: 'qwen2.5-coder:7b' });
    expect(env['ASHLR_MODEL']).toBe('qwen2.5-coder:7b');
    expect(env['AC_MODEL']).toBe('qwen2.5-coder:7b');
  });

  it('omits model keys when no model is known', () => {
    const env = buildToolEnv(makeConfig());
    expect(env['ASHLR_MODEL']).toBeUndefined();
    expect(env['AC_MODEL']).toBeUndefined();
  });
});

describe('buildToolEnv — flags + paths', () => {
  it('always sets ASHLR_LOCAL_FIRST=1', () => {
    expect(buildToolEnv(makeConfig())['ASHLR_LOCAL_FIRST']).toBe('1');
  });

  it('sets ASHLR_CONFIG to the unified config path', () => {
    expect(buildToolEnv(makeConfig())['ASHLR_CONFIG']).toBe(CONFIG_PATH);
  });

  it('sets ASHLR_GENOME_DIR under the config dir', () => {
    expect(buildToolEnv(makeConfig())['ASHLR_GENOME_DIR']).toBe(join(CONFIG_DIR, 'genome'));
  });

  it('delimiter-joins roots into ASHLR_ROOTS', () => {
    // env-bridge joins with path.delimiter (':' POSIX, ';' Windows) so drive
    // letters survive on win32 — assert against the platform delimiter, not ':'.
    expect(buildToolEnv(makeConfig())['ASHLR_ROOTS']).toBe(
      ['/home/u/Desktop/github', '/home/u/Desktop'].join(delimiter),
    );
  });

  it('omits ASHLR_ROOTS when there are no roots', () => {
    expect(buildToolEnv(makeConfig({ roots: [] }))['ASHLR_ROOTS']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SECURITY INVARIANT — no secret-shaped keys are ever emitted
// ---------------------------------------------------------------------------

describe('buildToolEnv — security invariant (no secret keys)', () => {
  it('never emits a secret-shaped env key', () => {
    const env = buildToolEnv(makeConfig(), { provider: 'anthropic', model: 'm' });
    const offending = Object.keys(env).filter((k) => SECRET_KEY_RE.test(k));
    expect(offending).toEqual([]);
  });

  it('is pure and deterministic — never throws, never reads network', () => {
    expect(() => buildToolEnv(makeConfig())).not.toThrow();
    expect(buildToolEnv(makeConfig())).toEqual(buildToolEnv(makeConfig()));
  });
});

// ---------------------------------------------------------------------------
// withToolEnv — merge semantics
// ---------------------------------------------------------------------------

describe('withToolEnv — merge over base env', () => {
  it('preserves unrelated base-env keys (including pre-existing secrets)', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-DO-NOT-TOUCH',
    };
    const merged = withToolEnv(makeConfig(), base);
    // We must NOT strip a secret that the parent already had; we just never add one.
    expect(merged['ANTHROPIC_API_KEY']).toBe('sk-ant-DO-NOT-TOUCH');
    expect(merged['PATH']).toBe('/usr/bin');
    // ...and we DID add our non-secret keys on top.
    expect(merged['ASHLR_LOCAL_FIRST']).toBe('1');
    expect(merged['OLLAMA_HOST']).toBe('http://localhost:11434');
  });

  it('ashlr keys win over colliding base keys', () => {
    const base: NodeJS.ProcessEnv = { OLLAMA_HOST: 'http://stale:1' };
    const merged = withToolEnv(makeConfig(), base);
    expect(merged['OLLAMA_HOST']).toBe('http://localhost:11434');
  });

  it('does not introduce any secret-shaped key beyond what the base already had', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const merged = withToolEnv(makeConfig(), base, { provider: 'anthropic' });
    const added = Object.keys(merged).filter((k) => !(k in base));
    const offending = added.filter((k) => SECRET_KEY_RE.test(k));
    expect(offending).toEqual([]);
  });
});
