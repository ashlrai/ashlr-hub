/** Pure host configuration checks: no key enrollment, filesystem or providers. */
import { describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateResourceGenerationRuntime } from '../src/core/universe/resource-generation.js';

const runtime = () => ({ schemaVersion: 1 as const, poolPath: '/private/controls/pool.json',
  bindingsPath: '/private/controls/bindings.json', observationsPath: '/private/controls/observations.json',
  root: '/private/ledger', workspace: '/private/transport' });

describe('explicit runtime archive key path', () => {
  it('preserves omitted legacy bytes and pins each explicit path in the existing whole-runtime digest', () => {
    const old = runtime(); const prior = canonical(old);
    expect(canonical(validateResourceGenerationRuntime(old))).toBe(prior);
    expect(Object.hasOwn(validateResourceGenerationRuntime(old), 'archiveKeyFile')).toBe(false);
    const first = { ...old, archiveKeyFile: '/private/ledger/archive.key' };
    const second = { ...old, archiveKeyFile: '/private/ledger/alternate.key' };
    expect(validateResourceGenerationRuntime(first)).toEqual(first);
    expect(digest(canonical(validateResourceGenerationRuntime(first)))).not.toBe(digest(prior));
    expect(digest(canonical(validateResourceGenerationRuntime(first)))).not.toBe(digest(canonical(validateResourceGenerationRuntime(second))));
  });
  it.each([undefined, null, 1, '', 'archive.key', '/', '/private/ledger', '/private/other/key',
    '/private/ledger/nested/key', '/private/ledger/../ledger/key', '/private/ledger/key/',
    '/private/ledger/secret\n', '/private/ledger/secret\u007f', '/private/ledger/' + 'a'.repeat(4096)])(
    'rejects malformed or non-direct key path %#', archiveKeyFile => {
      expect(() => validateResourceGenerationRuntime({ ...runtime(), archiveKeyFile })).toThrow();
    });
  it('rejects accessors, hidden properties, inherited options and proxies before invoking traps', () => {
    const trap = vi.fn(() => { throw new Error('not data'); });
    const accessor = Object.defineProperty(runtime(), 'archiveKeyFile', { enumerable: true, get: trap });
    const hidden = Object.defineProperty(runtime(), 'archiveKeyFile', { value: '/private/ledger/archive.key' });
    const inherited = Object.assign(Object.create({ archiveKeyFile: '/private/ledger/archive.key' }), runtime());
    for (const value of [accessor, hidden, inherited, new Proxy(runtime(), { getPrototypeOf: trap, ownKeys: trap })]) {
      expect(() => validateResourceGenerationRuntime(value)).toThrow();
    }
    expect(trap).not.toHaveBeenCalled();
  });
});
