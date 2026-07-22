/**
 * M65 — phantom-vault provider-key resolution.
 *
 * Hermetic + portable: works whether or not phantom is installed (CI has none).
 * A bogus secret name is never in any vault, so revealSecret returns null and
 * resolveProviderKey falls back to env — exercising both paths without a fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});
import { resolveProviderKey, revealSecret } from '../src/core/integrations/secrets.js';
import type { AshlrConfig } from '../src/core/types.js';

const cfg = (phantomEnabled: boolean, projectDir?: string): AshlrConfig =>
  ({ phantom: { enabled: phantomEnabled, ...(projectDir ? { projectDir } : {}) } }) as AshlrConfig;

const KEY = `ASHLR_M65_TEST_${Math.random().toString(36).slice(2)}`;

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: '', error: undefined });
});

afterEach(() => {
  delete process.env[KEY];
});

describe('M65 — resolveProviderKey', () => {
  it('phantom OFF → returns the env value', () => {
    process.env[KEY] = 'env-secret';
    expect(resolveProviderKey(KEY, cfg(false))).toBe('env-secret');
  });

  it('phantom OFF + env absent → undefined', () => {
    expect(resolveProviderKey(KEY, cfg(false))).toBeUndefined();
  });

  it('uses an explicit configured fallback before the environment', () => {
    process.env[KEY] = 'env-secret';
    expect(resolveProviderKey(KEY, cfg(false), { configuredValue: 'config-secret' })).toBe('config-secret');
  });

  it('prefers a Phantom vault value over config and environment', () => {
    process.env[KEY] = 'env-secret';
    spawnSyncMock.mockImplementation((_command, args: string[]) => {
      if (args[0] === '--version') {
        return { status: 0, stdout: 'phantom 1.0.0\n', stderr: '', error: undefined };
      }
      if (args[0] === 'reveal' && args[1] === KEY) {
        return { status: 0, stdout: 'vault-secret\n', stderr: '', error: undefined };
      }
      return { status: 1, stdout: '', stderr: '', error: undefined };
    });

    expect(resolveProviderKey(KEY, cfg(true, '/private/ashlr-phantom'), {
      configuredValue: 'config-secret',
    })).toBe('vault-secret');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'phantom',
      ['reveal', KEY, '--yes', '--quiet'],
      expect.objectContaining({ cwd: '/private/ashlr-phantom', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  });

  it('fails closed on a relative Phantom project directory', () => {
    process.env[KEY] = 'env-fallback';
    expect(resolveProviderKey(KEY, cfg(true, 'relative/vault'))).toBe('env-fallback');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a phantom placeholder configured fallback', () => {
    expect(resolveProviderKey(KEY, cfg(false), {
      configuredValue: ' phm_placeholder_token_for_test ',
    })).toBeUndefined();
  });

  it('rejects every Phantom-prefixed value using Phantom core semantics', () => {
    process.env[KEY] = 'phm_placeholder with unexpected suffix';
    expect(resolveProviderKey(KEY, cfg(false))).toBeUndefined();
  });

  it('empty env-var name → undefined', () => {
    expect(resolveProviderKey('', cfg(true))).toBeUndefined();
  });

  it('phantom ON but key not phantom-managed → falls back to env (never throws)', () => {
    process.env[KEY] = 'env-fallback';
    // The random KEY is not in any vault, so revealSecret() is null → env wins.
    // (Holds whether phantom is installed or not — the bogus name never resolves.)
    expect(resolveProviderKey(KEY, cfg(true))).toBe('env-fallback');
  });

  it('phantom OFF + env contains phantom placeholder token → undefined', () => {
    process.env[KEY] = 'phm_placeholder_token_for_test';
    expect(resolveProviderKey(KEY, cfg(false))).toBeUndefined();
  });

  it('phantom ON + vault absent + env contains phantom placeholder token → undefined', () => {
    process.env[KEY] = ' phm_placeholder_token_for_test ';
    expect(resolveProviderKey(KEY, cfg(true))).toBeUndefined();
  });

  it('phantom ON, nothing anywhere → undefined', () => {
    expect(resolveProviderKey(KEY, cfg(true))).toBeUndefined();
  });
});

describe('M65 — revealSecret', () => {
  it('returns null for a nonexistent secret and never throws', () => {
    expect(revealSecret(`ASHLR_NOT_A_SECRET_${Date.now()}`)).toBeNull();
  });
});
