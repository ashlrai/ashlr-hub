import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const marker = '__ASHLR_VITEST_3_SPY_ON_COMPAT__';
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock(fileURLToPath(new URL('./fixtures/mock-compat-module.js', import.meta.url))); });

describe('worker mock compatibility', () => {
  it('installs its original once marker before modules load', () => {
    expect(Reflect.get(globalThis, marker)).toBe(true);
  });

  it('clears an existing method mock when it is spied on again', () => {
    const target = { method: vi.fn(() => 'value') };
    target.method();
    const spy = vi.spyOn(target, 'method');
    expect(spy).not.toHaveBeenCalled();
    expect(target.method()).toBe('value');
    expect(spy).toHaveBeenCalledOnce();
  });

  it.each(['get', 'set'] as const)('clears only the existing %s accessor mock', accessType => {
    const get = vi.fn(() => 'value');
    const set = vi.fn((_value: string) => undefined);
    const target = Object.defineProperty({ value: '' }, 'value', { get, set, configurable: true });
    get(); set('before');
    const spy = accessType === 'get'
      ? vi.spyOn(target, 'value', 'get')
      : vi.spyOn(target, 'value', 'set');
    expect(spy).not.toHaveBeenCalled();
    expect(accessType === 'get' ? set : get).toHaveBeenCalledOnce();
  });

  it('keeps the original wrappers when isolated setup is imported again', async () => {
    const spyOn = vi.spyOn; const doUnmock = vi.doUnmock;
    vi.resetModules();
    await import('../../vitest.config.mock-compat.js');
    expect(vi.spyOn).toBe(spyOn); expect(vi.doUnmock).toBe(doUnmock);
    expect(Reflect.get(globalThis, marker)).toBe(true);
  });

  it('unmocks and resets cached actual module identity', async () => {
    const first = await import('./fixtures/mock-compat-module.js');
    const mockIdentity = {};
    vi.doMock(fileURLToPath(new URL('./fixtures/mock-compat-module.js', import.meta.url)), () => ({ identity: mockIdentity }));
    expect((await import('./fixtures/mock-compat-module.js')).identity).toBe(mockIdentity);
    vi.doUnmock(fileURLToPath(new URL('./fixtures/mock-compat-module.js', import.meta.url)));
    const restored = await import('./fixtures/mock-compat-module.js');
    expect(restored.identity).not.toBe(mockIdentity);
    expect(restored.identity).not.toBe(first.identity);
  });
  it('preserves original root-relative unmock resolution for a caller elsewhere', async () => {
    const { mockAndRestoreIdentity } = await import('../worker-mock-compat-caller.js');
    const result = await mockAndRestoreIdentity();
    expect(result.mocked).toBe(result.mockIdentity);
    expect(result.restored).not.toBe(result.mockIdentity);
    expect(result.restored).not.toBe(result.first);
  });
});
