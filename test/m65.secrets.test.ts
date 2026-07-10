/**
 * M65 — phantom-vault provider-key resolution.
 *
 * Hermetic + portable: works whether or not phantom is installed (CI has none).
 * A bogus secret name is never in any vault, so revealSecret returns null and
 * resolveProviderKey falls back to env — exercising both paths without a fixture.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveProviderKey, revealSecret } from '../src/core/integrations/secrets.js';
import type { AshlrConfig } from '../src/core/types.js';

const cfg = (phantomEnabled: boolean): AshlrConfig =>
  ({ phantom: { enabled: phantomEnabled } }) as AshlrConfig;

const KEY = `ASHLR_M65_TEST_${Math.random().toString(36).slice(2)}`;

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
