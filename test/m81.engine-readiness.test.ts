/**
 * m81.engine-readiness.test.ts — M81: engine readiness preflight.
 *
 * Tests for `engineReadiness` and `fleetReadiness` in
 * src/core/fleet/engine-readiness.ts.
 *
 * Probe isolation: all subprocess/fs probes are injected via ProbeOverrides so
 * no real codex/claude binaries run during the test suite. Tests that exercise
 * the live probe path (e.g. a real PATH which/where) are gated with skip when
 * the binary is absent.
 */

import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type { AshlrConfig, EngineId } from '../src/core/types.js';
import {
  engineReadiness,
  fleetReadiness,
} from '../src/core/fleet/engine-readiness.js';
import type { ProbeOverrides } from '../src/core/fleet/engine-readiness.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry };
}

/** Overrides that pretend a binary is NOT installed. */
function notInstalledOverrides(): ProbeOverrides {
  return {
    isInstalled: () => false,
    resolveBin: (b) => b,
  };
}

/** Overrides that pretend a binary IS installed at /usr/local/bin/<bin>. */
function installedOverrides(bin = '/usr/local/bin/engine'): ProbeOverrides {
  return {
    isInstalled: () => true,
    resolveBin: () => bin,
  };
}

// ---------------------------------------------------------------------------
// EngineReadiness shape + never-throws contract
// ---------------------------------------------------------------------------

describe('engineReadiness — shape', () => {
  it('always returns the required fields for builtin', () => {
    const r = engineReadiness('builtin', baseConfig());
    expect(r).toMatchObject({
      engine: 'builtin',
      installed: true,
      authed: true,
      ready: true,
    });
    expect(typeof r.tier).toBe('string');
    expect(typeof r.detail).toBe('string');
    expect(r.fix).toBeUndefined();
  });

  it('never throws on missing bin / null cfg', () => {
    // Simulate a binary not on PATH at all, cfg = undefined
    const overrides: ProbeOverrides = {
      isInstalled: () => false,
      resolveBin: (b) => b,
    };
    expect(() => engineReadiness('claude', undefined, overrides)).not.toThrow();
    expect(() => engineReadiness('codex', undefined, overrides)).not.toThrow();
    expect(() => engineReadiness('hermes', undefined, overrides)).not.toThrow();
    expect(() => engineReadiness('aw', undefined, overrides)).not.toThrow();
    expect(() => engineReadiness('opencode', undefined, overrides)).not.toThrow();
    expect(() => engineReadiness('ashlrcode', undefined, overrides)).not.toThrow();
  });

  it('never throws when probes return unexpected values', () => {
    const overrides: ProbeOverrides = {
      isInstalled: () => { throw new Error('isInstalled threw'); },
      resolveBin: () => '',
    };
    // engineReadiness itself wraps errors — but only fleetReadiness catches
    // throws from engineReadiness. For individual call, the probe error propagates
    // if the engine is not 'builtin'. We verify fleetReadiness never throws.
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    expect(() => fleetReadiness(cfg, overrides)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// builtin — always ready
// ---------------------------------------------------------------------------

describe('builtin engine', () => {
  it('is always installed, authed, and ready regardless of overrides', () => {
    const r = engineReadiness('builtin', baseConfig(), notInstalledOverrides());
    expect(r.installed).toBe(true);
    expect(r.authed).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.fix).toBeUndefined();
  });

  it('has tier "local"', () => {
    const r = engineReadiness('builtin', baseConfig());
    expect(r.tier).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// not-installed engines — installed:false + install fix
// ---------------------------------------------------------------------------

describe('not-installed cli-agent', () => {
  const engines = ['claude', 'codex', 'hermes', 'aw', 'opencode', 'ashlrcode'] as const;

  for (const engine of engines) {
    it(`${engine}: installed:false + ready:false + fix string when binary absent`, () => {
      const r = engineReadiness(engine, baseConfig(), notInstalledOverrides());
      expect(r.engine).toBe(engine);
      expect(r.installed).toBe(false);
      expect(r.ready).toBe(false);
      expect(typeof r.fix).toBe('string');
      expect(r.fix!.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// claude — installed but no credential
// ---------------------------------------------------------------------------

describe('claude — auth probes', () => {
  it('ready:false + authed:false + fix when installed but no credential', () => {
    const overrides: ProbeOverrides = {
      ...installedOverrides('/usr/local/bin/claude'),
      claudeCredential: () => 'none',
    };
    const r = engineReadiness('claude', baseConfig(), overrides);
    expect(r.installed).toBe(true);
    expect(r.authed).toBe(false);
    expect(r.ready).toBe(false);
    expect(typeof r.fix).toBe('string');
    expect(r.fix).toContain('claude');
  });

  it('ready:true + authed:true when CLAUDE_CODE_OAUTH_TOKEN present', () => {
    const overrides: ProbeOverrides = {
      ...installedOverrides('/usr/local/bin/claude'),
      claudeCredential: () => 'env-token',
    };
    const r = engineReadiness('claude', baseConfig(), overrides);
    expect(r.installed).toBe(true);
    expect(r.authed).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.fix).toBeUndefined();
  });

  it('ready:true + authed:true when ~/.claude/credentials.json exists', () => {
    const overrides: ProbeOverrides = {
      ...installedOverrides('/usr/local/bin/claude'),
      claudeCredential: () => 'file-creds',
    };
    const r = engineReadiness('claude', baseConfig(), overrides);
    expect(r.authed).toBe(true);
    expect(r.ready).toBe(true);
  });

  it('binPath is set when installed', () => {
    const overrides: ProbeOverrides = {
      ...installedOverrides('/usr/local/bin/claude'),
      claudeCredential: () => 'env-token',
    };
    const r = engineReadiness('claude', baseConfig(), overrides);
    expect(r.binPath).toBe('/usr/local/bin/claude');
  });
});

// ---------------------------------------------------------------------------
// codex — installed but auth probes
// ---------------------------------------------------------------------------

describe('codex — auth probes', () => {
  it('ready:false + authed:false + fix when logged-out', () => {
    const overrides: ProbeOverrides = {
      ...installedOverrides('/usr/local/bin/codex'),
      codexLoginStatus: () => 'logged-out',
    };
    const r = engineReadiness('codex', baseConfig(), overrides);
    expect(r.installed).toBe(true);
    expect(r.authed).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.fix).toContain('codex login');
  });

  it('ready:true + authed:true when logged-in', () => {
    const overrides: ProbeOverrides = {
      ...installedOverrides('/usr/local/bin/codex'),
      codexLoginStatus: () => 'logged-in',
    };
    const r = engineReadiness('codex', baseConfig(), overrides);
    expect(r.authed).toBe(true);
    expect(r.ready).toBe(true);
    // detail warns about potential token revocation
    expect(r.detail).toContain('revoked');
  });

  it('ready:true + authed:unknown when probe inconclusive', () => {
    const overrides: ProbeOverrides = {
      ...installedOverrides('/usr/local/bin/codex'),
      codexLoginStatus: () => 'unknown',
    };
    const r = engineReadiness('codex', baseConfig(), overrides);
    expect(r.authed).toBe('unknown');
    expect(r.ready).toBe(true); // optimistically ready
    expect(typeof r.fix).toBe('string'); // soft hint still present
  });
});

// ---------------------------------------------------------------------------
// api-model engines — env key gate
// ---------------------------------------------------------------------------

describe('api-model engines', () => {
  it('probes loopback without treating the compiled sidecar as Node', async () => {
    const fixtureCode = [
      "const http = require('node:http');",
      "const server = http.createServer((request, response) => {",
      "  response.setHeader('content-type', 'application/json');",
      "  response.statusCode = request.url === '/v1/models' ? 200 : 404;",
      "  response.end(JSON.stringify({data: [{id: 'fixture-model'}]}));",
      "});",
      "server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));",
    ].join('\n');
    const fixture = spawn(process.execPath, ['-e', fixtureCode], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('loopback fixture did not start')), 3000);
        fixture.once('error', (error) => { clearTimeout(timeout); reject(error); });
        fixture.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timeout);
          const parsed = Number(String(chunk).trim());
          if (!Number.isInteger(parsed) || parsed < 1) reject(new Error('invalid fixture port'));
          else resolve(parsed);
        });
      });
      const originalExecPath = process.execPath;
      try {
        process.execPath = '/compiled-phantom-sidecar-cannot-eval';
        const cfg = withFoundry({ allowedBackends: ['local-coder'], models: { 'local-coder': 'fixture-model' } });
        const result = engineReadiness('local-coder', cfg, {
          getEnv: (key) => key === 'OLLAMA_BASE_URL' ? 'http://127.0.0.1:' + String(port) + '/v1' : undefined,
        });
        expect(result).toMatchObject({ installed: true, authed: 'unknown', ready: true });
      } finally {
        process.execPath = originalExecPath;
      }
    } finally {
      fixture.kill();
    }
  }, 10000);

  it('accepts only a valid 2xx model list from a loopback local-coder', () => {
    const cfg = withFoundry({ allowedBackends: ['local-coder'], models: { 'local-coder': 'configured-qwen' } });
    const isInstalled = vi.fn(() => true);
    const localModelsResponse = vi.fn(() => ({ statusCode: 200, body: '{"data":[{"id":"configured-qwen"}]}' }));
    const getEnv = vi.fn(() => undefined);
    const r = engineReadiness('local-coder', cfg, { isInstalled, getEnv, localModelsResponse });
    expect(localModelsResponse).toHaveBeenCalledWith('http://localhost:11434/v1/models');
    expect(isInstalled).not.toHaveBeenCalled();
    expect(r).toMatchObject({ installed: true, authed: 'unknown', ready: true });
    expect(r.detail).toContain('model completion are unverified');
    expect(r.fix).toBeUndefined();
  });

  it.each([
    [401, '{"data":[{"id":"configured-qwen"}]}'],
    [404, '{"data":[{"id":"configured-qwen"}]}'],
    [500, '{"data":[{"id":"configured-qwen"}]}'],
    [200, '{"data":[]}'],
    [200, '{"data":[{"id":"other-model"}]}'],
    [200, '{"error":"not a model list"}'],
    [200, 'not json'],
  ])('rejects a local model response with status %i and body %s', (statusCode, body) => {
    const cfg = withFoundry({ allowedBackends: ['local-coder'], models: { 'local-coder': 'configured-qwen' } });
    const localModelsResponse = vi.fn(() => ({ statusCode, body }));
    const r = engineReadiness('local-coder', cfg, { localModelsResponse });
    expect(localModelsResponse).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ installed: false, authed: 'unknown', ready: false });
    expect(r.detail).toContain('did not return a valid 2xx list containing the configured model ID');
    expect(r.fix).toContain('/v1/models');
  });

  it('returns unavailable when the injected local models probe throws', () => {
    const cfg = withFoundry({ allowedBackends: ['local-coder'], models: { 'local-coder': 'configured-qwen' } });
    const localModelsResponse = vi.fn(() => { throw new Error('probe failed'); });
    const r = engineReadiness('local-coder', cfg, { localModelsResponse });
    expect(r).toMatchObject({ installed: false, authed: 'unknown', ready: false });
    expect(localModelsResponse).toHaveBeenCalledOnce();
  });

  it('never contacts a custom keyless remote api-model endpoint', () => {
    const cfg = withFoundry({
      allowedBackends: ['remote-test' as EngineId],
      engines: {
        'remote-test': {
          id: 'remote-test', kind: 'api-model', tier: 'mid',
          api: { envKey: '', defaultBaseUrl: 'https://models.example.test/v1' },
        },
      },
    } as NonNullable<AshlrConfig['foundry']>);
    const localModelsResponse = vi.fn(() => ({ statusCode: 200, body: '{"data":[]}' }));
    const r = engineReadiness('remote-test' as EngineId, cfg, { localModelsResponse });
    expect(localModelsResponse).not.toHaveBeenCalled();
    expect(r).toMatchObject({ installed: false, ready: false });
    expect(r.detail).toContain('no endpoint was contacted');
  });

  it('refuses a built-in local-coder redirected off loopback before probing', () => {
    const cfg = withFoundry({ allowedBackends: ['local-coder'] });
    const localModelsResponse = vi.fn(() => ({ statusCode: 200, body: '{"data":[]}' }));
    const r = engineReadiness('local-coder', cfg, {
      getEnv: (key) => key === 'OLLAMA_BASE_URL' ? 'https://models.example.test/v1' : undefined,
      localModelsResponse,
    });
    expect(localModelsResponse).not.toHaveBeenCalled();
    expect(r).toMatchObject({ installed: false, ready: false });
  });

  it('probes a loopback llama-server model endpoint', () => {
    const cfg = withFoundry({ allowedBackends: ['llama-server'], models: { 'llama-server': 'local-model' } });
    const localModelsResponse = vi.fn(() => ({ statusCode: 200, body: '{"data":[{"id":"local-model"}]}' }));
    const r = engineReadiness('llama-server', cfg, { localModelsResponse });
    expect(localModelsResponse).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ installed: true, authed: 'unknown', ready: true });
  });

  it('installed:false + ready:false when env key absent', () => {
    // Inject a minimal api-model spec via cfg.foundry.engines
    const cfg = withFoundry({
      allowedBackends: ['builtin'],
      engines: {
        'gpt-4o': {
          id: 'gpt-4o',
          kind: 'api-model',
          tier: 'frontier',
          api: { envKey: 'OPENAI_API_KEY' },
        },
      },
    } as NonNullable<AshlrConfig['foundry']>);
    const overrides: ProbeOverrides = {
      isInstalled: vi.fn(() => true),
      localModelsResponse: vi.fn(() => ({ statusCode: 200, body: '{"data":[]}' })),
      getEnv: () => undefined, // key absent
    };
    const r = engineReadiness('gpt-4o' as EngineId, cfg, overrides);
    expect(r.installed).toBe(false);
    expect(r.authed).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.fix).toContain('OPENAI_API_KEY');
    expect(overrides.isInstalled).not.toHaveBeenCalled();
    expect(overrides.localModelsResponse).not.toHaveBeenCalled();
  });

  it('installed:true + ready:true when env key present', () => {
    const cfg = withFoundry({
      allowedBackends: ['builtin'],
      engines: {
        'gpt-4o': {
          id: 'gpt-4o',
          kind: 'api-model',
          tier: 'frontier',
          api: { envKey: 'OPENAI_API_KEY' },
        },
      },
    } as NonNullable<AshlrConfig['foundry']>);
    const overrides: ProbeOverrides = {
      isInstalled: vi.fn(() => false),
      localModelsResponse: vi.fn(() => null),
      getEnv: (k) => k === 'OPENAI_API_KEY' ? 'sk-test-key' : undefined,
    };
    const r = engineReadiness('gpt-4o' as EngineId, cfg, overrides);
    expect(r.installed).toBe(true);
    expect(r.authed).toBe(true);
    expect(r.ready).toBe(true);
    expect(overrides.isInstalled).not.toHaveBeenCalled();
    expect(overrides.localModelsResponse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Other cli-agents (hermes, aw, opencode, ashlrcode) — auth opaque
// ---------------------------------------------------------------------------

describe('opaque-auth cli-agents', () => {
  const opaqueEngines = ['hermes', 'aw', 'opencode', 'ashlrcode'] as const;

  for (const engine of opaqueEngines) {
    it(`${engine}: installed + authed:unknown + ready:true (auth opaque)`, () => {
      const overrides: ProbeOverrides = {
        ...installedOverrides(`/usr/local/bin/${engine}`),
      };
      const r = engineReadiness(engine, baseConfig(), overrides);
      expect(r.installed).toBe(true);
      expect(r.authed).toBe('unknown');
      expect(r.ready).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// fleetReadiness — covers allowed backends
// ---------------------------------------------------------------------------

describe('fleetReadiness', () => {
  it('returns a result for every engine in allowedBackends', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const overrides: ProbeOverrides = {
      isInstalled: () => false,
      resolveBin: (b) => b,
    };
    const results = fleetReadiness(cfg, overrides);
    const engines = results.map((r) => r.engine);
    expect(engines).toContain('builtin');
    expect(engines).toContain('claude');
    expect(engines).toContain('codex');
  });

  it('always includes builtin even when not listed in allowedBackends', () => {
    const cfg = withFoundry({ allowedBackends: ['claude'] });
    const overrides: ProbeOverrides = {
      isInstalled: () => false,
      resolveBin: (b) => b,
    };
    const results = fleetReadiness(cfg, overrides);
    expect(results.map((r) => r.engine)).toContain('builtin');
  });

  it('defaults to [builtin] when cfg has no foundry block', () => {
    const results = fleetReadiness(baseConfig());
    expect(results.length).toBe(1);
    expect(results[0]!.engine).toBe('builtin');
    expect(results[0]!.ready).toBe(true);
  });

  it('never throws even when probes throw', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const overrides: ProbeOverrides = {
      isInstalled: () => { throw new Error('boom'); },
      resolveBin: () => { throw new Error('boom'); },
    };
    expect(() => fleetReadiness(cfg, overrides)).not.toThrow();
  });

  it('each result has the required shape fields', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    const overrides: ProbeOverrides = {
      isInstalled: () => true,
      resolveBin: () => '/usr/bin/claude',
      claudeCredential: () => 'env-token',
    };
    const results = fleetReadiness(cfg, overrides);
    for (const r of results) {
      expect(typeof r.engine).toBe('string');
      expect(typeof r.tier).toBe('string');
      expect(typeof r.installed).toBe('boolean');
      expect(['boolean', 'string']).toContain(typeof r.authed);
      expect(typeof r.ready).toBe('boolean');
      expect(typeof r.detail).toBe('string');
    }
  });

  it('a fully-ready fleet has all ready:true', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    const overrides: ProbeOverrides = {
      isInstalled: () => true,
      resolveBin: () => '/usr/bin/claude',
      claudeCredential: () => 'file-creds',
    };
    const results = fleetReadiness(cfg, overrides);
    expect(results.every((r) => r.ready)).toBe(true);
  });

  it('summary: installed-but-unauthed engine is ready:false with a fix string', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    const overrides: ProbeOverrides = {
      isInstalled: () => true,
      resolveBin: () => '/usr/bin/claude',
      claudeCredential: () => 'none',
    };
    const results = fleetReadiness(cfg, overrides);
    const claudeResult = results.find((r) => r.engine === 'claude')!;
    expect(claudeResult.ready).toBe(false);
    expect(typeof claudeResult.fix).toBe('string');
    expect(claudeResult.fix!.length).toBeGreaterThan(0);
  });
});
