import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

const calls = vi.hoisted(() => ({
  installed: vi.fn(() => false),
  builtin: vi.fn(() => { throw new Error('fixture builtin reached'); }),
  sandbox: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../src/core/run/engines.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/run/engines.js')>(),
  engineInstalled: calls.installed,
  spawnEngine: calls.spawn,
}));
vi.mock('../src/core/run/provider-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/run/provider-client.js')>(),
  getActiveClient: calls.builtin,
}));
vi.mock('../src/core/run/sandboxed-engine.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/run/sandboxed-engine.js')>(),
  runApiModelSandboxed: calls.sandbox,
}));
vi.mock('../src/core/util/execution-lease.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/util/execution-lease.js')>(),
  acquireExecutionAuthority: () => ({ ok: true, authority: {} }),
  beginExecutionAuthority: () => true,
  finishExecutionAuthority: () => {},
  abandonExecutionAuthority: () => {},
}));

import { runGoal } from '../src/core/run/orchestrator.js';

const cfg = {
  foundry: {
    allowedBackends: ['meta-muse', 'custom-api', 'local-coder', 'claude'],
    engines: {
      'custom-api': {
        id: 'custom-api', kind: 'api-model', tier: 'mid',
        api: {
          protocol: 'openai', envKey: 'FIXTURE_API_KEY',
          defaultBaseUrl: 'https://example.invalid/v1', defaultModel: 'fixture-model',
        },
      },
    },
  },
} as AshlrConfig;

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('explicit unavailable API routes', () => {
  it.each([
    ['meta-muse', 'MODEL_API_KEY'],
    ['custom-api', 'FIXTURE_API_KEY'],
  ])('refuses %s with an accurate missing-key error before any provider dispatch', async (engine, key) => {
    vi.stubEnv(key, '');
    await expect(runGoal('do not dispatch', cfg, { engine, sandboxEngine: true }))
      .rejects.toThrow(`required API key environment variable ${key} is missing; builtin fallback refused`);
    expect(calls.builtin).not.toHaveBeenCalled();
    expect(calls.sandbox).not.toHaveBeenCalled();
    expect(calls.spawn).not.toHaveBeenCalled();
  });

  it('refuses an unavailable local API endpoint without claiming a missing CLI binary', async () => {
    await expect(runGoal('do not dispatch', cfg, { engine: 'local-coder', sandboxEngine: true }))
      .rejects.toThrow('API endpoint is unavailable; builtin fallback refused');
    expect(calls.builtin).not.toHaveBeenCalled();
    expect(calls.sandbox).not.toHaveBeenCalled();
    expect(calls.spawn).not.toHaveBeenCalled();
  });

  it('also reports the missing API key when a sandbox is required', async () => {
    vi.stubEnv('MODEL_API_KEY', '');
    await expect(runGoal('do not dispatch', cfg, { engine: 'meta-muse', requireSandbox: true }))
      .rejects.toThrow('required API key environment variable MODEL_API_KEY is missing');
    expect(calls.builtin).not.toHaveBeenCalled();
    expect(calls.sandbox).not.toHaveBeenCalled();
  });

  it('preserves the legacy unavailable CLI fallback', async () => {
    await expect(runGoal('legacy fallback', cfg, { engine: 'claude', noMemory: true }))
      .rejects.toThrow('fixture builtin reached');
    expect(calls.builtin).toHaveBeenCalledOnce();
    expect(calls.sandbox).not.toHaveBeenCalled();
  });

  it('preserves default builtin selection without probing an external engine', async () => {
    await expect(runGoal('default route', cfg, { noMemory: true }))
      .rejects.toThrow('fixture builtin reached');
    expect(calls.builtin).toHaveBeenCalledOnce();
    expect(calls.installed).not.toHaveBeenCalled();
  });
});
