/** Pool-local JSON capture. Evidence-pack cryptographic budgets are intentionally unrelated. */
import { types } from 'node:util';

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_CONTAINER_ENTRIES = 4096;
const MAX_STRING_BYTES = 128 * 1024;
const MAX_KEY_BYTES = 256;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const invalid = (): never => { throw new Error('Invalid bounded resource ledger'); };

/** Detached, key-sorted canonical JSON with space reserved for the persisted newline.
 * Keep the prior depth/container/string/key ceilings. The node ceiling is the
 * domain byte ceiling: every JSON value consumes at least one byte, so this cannot
 * exclude a document fitting the ledger while still bounding traversal work.
 * Receipt count, schema, policies and the 16-epoch limit remain domain checks. */
export function captureResourcePoolStateJson(input: unknown): string {
  return capture(input, MAX_STATE_BYTES, 1);
}

/** History is embedded JSON, so its existing 2MiB bound excludes a newline.
 * Individual snapshots and the sixteen-epoch/additive rules remain policy checks. */
export function captureResourcePoolConfigHistoryJson(input: unknown): string {
  try { return capture(input, MAX_HISTORY_BYTES, 0); }
  catch { throw new Error('Invalid resource configuration history'); }
}

function capture(input: unknown, maxBytes: number, newlineBytes: 0 | 1): string {
  const ancestors = new Set<object>();
  let nodes = 0; let bytes = newlineBytes;
  const charge = (amount: number) => { bytes += amount; if (bytes > maxBytes) invalid(); };
  const string = (value: string, limit: number) => {
    if (Buffer.byteLength(value, 'utf8') > limit) invalid();
    charge(Buffer.byteLength(JSON.stringify(value), 'utf8'));
    return value;
  };
  const visit = (value: unknown, depth: number): Json => {
    if (++nodes > maxBytes || depth > MAX_DEPTH) return invalid();
    if (value === null || typeof value === 'boolean') { charge(value === null ? 4 : value ? 4 : 5); return value; }
    if (typeof value === 'string') return string(value, MAX_STRING_BYTES);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return invalid();
      charge(JSON.stringify(value).length); return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) return invalid();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) return invalid();
    ancestors.add(value);
    try {
      if (array) {
        const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_CONTAINER_ENTRIES ||
          keys.length !== length + 1) return invalid();
        charge(2 + Math.max(0, length - 1));
        const output: Json[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      if (keys.length > MAX_CONTAINER_ENTRIES) return invalid();
      charge(2 + Math.max(0, keys.length - 1));
      const output = Object.create(null) as { [key: string]: Json };
      for (const key of (keys as string[]).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
        string(key, MAX_KEY_BYTES); charge(1);
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally { ancestors.delete(value); }
  };
  try {
    const encoded = JSON.stringify(visit(input, 0));
    if (Buffer.byteLength(encoded, 'utf8') + newlineBytes !== bytes) return invalid();
    return encoded;
  } catch { return invalid(); }
}
