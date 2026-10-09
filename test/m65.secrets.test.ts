/** Environment credentials work without unsupported vault extraction. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveProviderKey, revealSecret, explainProviderKey } from '../src/core/integrations/secrets.js';
import type { AshlrConfig } from '../src/core/types.js';
const subprocess = vi.hoisted(() => vi.fn(() => { throw new Error('credential subprocess forbidden'); }));
vi.mock('node:child_process', () => ({ spawnSync: subprocess, execFileSync: subprocess, spawn: subprocess }));
const cfg = (enabled: boolean): AshlrConfig => ({ phantom: { enabled } }) as AshlrConfig;
const KEY = 'ASHLR_M65_TEST_KEY';
afterEach(() => { vi.unstubAllEnvs(); subprocess.mockClear(); });

describe('M65 existing environment resolution', () => {
  it.each([false, true])('preserves the exact valid environment value with enabled=%s', enabled => {
    vi.stubEnv(KEY, ' env-secret ');
    expect(resolveProviderKey(KEY, cfg(enabled))).toBe(' env-secret ');
    expect(explainProviderKey(KEY, cfg(enabled))).toBe('environment-supported');
    expect(subprocess).not.toHaveBeenCalled();
  });
  it.each([undefined, '', '  ', 'phm_placeholder_token', ' phm_placeholder_token '])('rejects missing/blank/placeholder %s', value => {
    vi.stubEnv(KEY, value);
    expect(resolveProviderKey(KEY, cfg(true))).toBeUndefined();
    expect(resolveProviderKey(KEY, cfg(false))).toBeUndefined();
    expect(subprocess).not.toHaveBeenCalled();
  });
  it('retains environment on-demand resolution without mutation or caching', () => {
    vi.stubEnv(KEY, 'first-key');
    expect(resolveProviderKey(KEY, cfg(true))).toBe('first-key');
    vi.stubEnv(KEY, 'second-key');
    expect(resolveProviderKey(KEY, cfg(true))).toBe('second-key');
    expect(process.env[KEY]).toBe('second-key');
  });
  it('empty names do not resolve', () => {
    expect(resolveProviderKey('', cfg(true))).toBeUndefined();
  });
  it('diagnostics contain only known reasons, not credential values', () => {
    vi.stubEnv(KEY, undefined);
    expect(explainProviderKey(KEY, cfg(false))).toBe('environment-missing');
    expect(explainProviderKey(KEY, cfg(true))).toBe('vault-transport-not-supported');
    vi.stubEnv(KEY, ' phm_placeholder_token ');
    expect(explainProviderKey(KEY, cfg(true))).toBe('placeholder-unusable');
  });
  it('keeps revealSecret inert even for an apparently managed name', () => {
    expect(revealSecret('ANTHROPIC_API_KEY')).toBeNull();
    expect(revealSecret('')).toBeNull();
    expect(subprocess).not.toHaveBeenCalled();
  });
});
