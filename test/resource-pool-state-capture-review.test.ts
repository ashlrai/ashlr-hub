/** Independent pure capture/domain boundary tests. No stores, workers or providers. */
import { describe, expect, it, vi } from 'vitest';
import { canonicalEvidencePackJsonV3 } from '../src/core/foundry/provenance.js';
import { captureResourcePoolStateJson } from '../src/core/resources/pool-state-capture.js';
import { decodeResourcePoolState } from '../src/core/resources/pool-runtime.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const MAX_BYTES = 4 * 1024 * 1024;
const pool: ResourcePool = { schemaVersion: 1, id: 'capture-review', workers: [{ id: 'local', provider: 'local', model: 'fixture',
  maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 2, taskWindowMs: 60_000, priority: 1 }] };
const bindings: ResourceBinding[] = [{ workerId: 'local', capacityKey: 'fixture', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }];
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const ledger = (): Record<string, unknown> => ({ schemaVersion: 1, poolDigest: epoch.poolDigest, attempts: [], observations: [] });

/** Each string stays below 128KiB raw UTF-8; the array tests total encoded bytes. */
function encodedArray(targetBytes: number): string[] {
  const chunk = 'é\n😀'.repeat(10_000);
  const chunkBytes = Buffer.byteLength(JSON.stringify(chunk));
  const result: string[] = []; let used = 2;
  while (targetBytes - used > chunkBytes + 4) {
    used += chunkBytes + (result.length ? 1 : 0); result.push(chunk);
  }
  const payloadBytes = targetBytes - used - (result.length ? 1 : 0) - 2;
  result.push('é'.repeat(Math.floor(payloadBytes / 2)) + (payloadBytes % 2 ? 'a' : ''));
  expect(Buffer.byteLength(JSON.stringify(result))).toBe(targetBytes);
  return result;
}

type Hostile = (hook: () => never) => unknown;
const hostile: Array<[string, Hostile]> = [
  ['root accessor', hook => Object.defineProperty({}, 'value', { enumerable: true, get: hook })],
  ['array index accessor', hook => Object.defineProperty([null], '0', { enumerable: true, get: hook })],
  ['toJSON method', hook => ({ toJSON: hook })],
  ['toJSON accessor', hook => Object.defineProperty({}, 'toJSON', { enumerable: true, get: hook })],
  ['inherited executable property', hook => Object.create({ get value() { return hook(); } })],
  ['array method override', hook => Object.assign([], { map: hook })],
  ['proxy traps', hook => new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook })],
  ['extra symbol', hook => ({ value: 1, [Symbol('private')]: hook })],
];

describe('independent pool capture review', () => {
  it('accepts exactly 4MiB including the final newline with escaped and multibyte strings', () => {
    const input = encodedArray(MAX_BYTES - 1);
    const captured = captureResourcePoolStateJson(input);
    expect(captured).toBe(JSON.stringify(input));
    expect(Buffer.byteLength(captured + '\n')).toBe(MAX_BYTES);
    expect(captured).toContain('\\n'); expect(captured).toContain('😀');
  });
  it('refuses a document whose JSON alone is 4MiB because the newline exceeds the bound', () => {
    const input = encodedArray(MAX_BYTES);
    expect(() => captureResourcePoolStateJson(input)).toThrow('Invalid bounded resource ledger');
  });
  it('charges escaping rather than only raw string bytes', () => {
    const input = Array.from({ length: 11 }, () => '\u0000'.repeat(64 * 1024));
    expect(input.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0)).toBeLessThan(MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(MAX_BYTES);
    expect(() => captureResourcePoolStateJson(input)).toThrow('Invalid bounded resource ledger');
  });
  it('preserves prior numeric-key ordering, null-prototype records and negative-zero encoding', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      z: -0, '10': 'ten', '2': 'two', '01': 'leading', A: 'upper', a: 'lower', nested: { b: 2, a: 1 },
    });
    Object.defineProperty(input, '__proto__', { enumerable: true, value: 'ordinary-data' });
    const old = canonicalEvidencePackJsonV3(input);
    expect(old).not.toBeNull(); expect(captureResourcePoolStateJson(input)).toBe(old);
    expect(captureResourcePoolStateJson({ '10': 'ten', '2': 'two', '01': 'leading', z: -0 }))
      .toBe('{"2":"two","10":"ten","01":"leading","z":0}');
    expect(Object.is(input.z, -0)).toBe(true); expect(Object.getPrototypeOf(input)).toBeNull();
  });
  it('expands a shared alias without treating it as an ancestor cycle or mutating it', () => {
    const shared = { z: -0, a: ['é', '\n'] }; const input = { right: shared, left: shared };
    const captured = captureResourcePoolStateJson(input);
    expect(captured).toBe(canonicalEvidencePackJsonV3(input));
    expect(captured).toBe(captureResourcePoolStateJson({ left: structuredClone(shared), right: structuredClone(shared) }));
    const detached = JSON.parse(captured) as { left: unknown; right: unknown };
    expect(detached.left).toEqual(detached.right); expect(detached.left).not.toBe(detached.right);
    expect(input.left).toBe(shared); expect(input.right).toBe(shared); expect(Object.is(shared.z, -0)).toBe(true);
  });
  it('rejects actual ancestor cycles', () => {
    const object: Record<string, unknown> = {}; object.self = object;
    const array: unknown[] = []; array.push(array);
    expect(() => captureResourcePoolStateJson(object)).toThrow('Invalid bounded resource ledger');
    expect(() => captureResourcePoolStateJson(array)).toThrow('Invalid bounded resource ledger');
  });
  it.each(hostile)('rejects %s without invoking any supplied hook', (_name, make) => {
    const hook = vi.fn((): never => { throw new Error('Must never execute input'); });
    expect(() => captureResourcePoolStateJson(make(hook))).toThrow('Invalid bounded resource ledger');
    expect(hook).not.toHaveBeenCalled();
  });
  it('rejects sparse, extra-key, non-enumerable and revoked-proxy containers', () => {
    const sparse = [null, null]; delete sparse[0];
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const input of [sparse, Object.assign([], { extra: 1 }),
      Object.defineProperty({}, 'hidden', { value: 1 }), revoked.proxy]) {
      expect(() => captureResourcePoolStateJson(input)).toThrow('Invalid bounded resource ledger');
    }
  });
  it('still refuses a byte-valid non-ledger rather than granting domain validity', () => {
    const input = { extra: 'ordinary data' };
    expect(captureResourcePoolStateJson(input)).toBe('{"extra":"ordinary data"}');
    expect(() => decodeResourcePoolState(input, pool, bindings)).toThrow();
    expect(decodeResourcePoolState(ledger(), pool, bindings).attempts).toEqual([]);
  });
  it.each(['attempts-property', 'attempt-index', 'observation-property', 'nested-receipt', 'toJSON', 'proxy'] as const)(
    'rejects dangerous %s at the real pool decoder boundary without running hooks', kind => {
      const hook = vi.fn((): never => { throw new Error('Must never execute ledger input'); });
      let input = ledger();
      if (kind === 'attempts-property') Object.defineProperty(input, 'attempts', { enumerable: true, get: hook });
      if (kind === 'attempt-index') input.attempts = Object.defineProperty([null], '0', { enumerable: true, get: hook });
      if (kind === 'observation-property') input.observations = [Object.defineProperty({}, 'workerId', { enumerable: true, get: hook })];
      if (kind === 'nested-receipt') input.attempts = [{ nativeProcess: Object.defineProperty({}, 'signal', { enumerable: true, get: hook }) }];
      if (kind === 'toJSON') input.toJSON = hook;
      if (kind === 'proxy') input = new Proxy(input, { ownKeys: hook, getPrototypeOf: hook, get: hook });
      expect(() => decodeResourcePoolState(input, pool, bindings)).toThrow('Invalid bounded resource ledger');
      expect(hook).not.toHaveBeenCalled();
    });
});
