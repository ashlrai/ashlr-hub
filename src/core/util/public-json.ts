import { homedir } from 'node:os';
import { types as utilTypes } from 'node:util';

import { scrubSecrets } from './scrub.js';

export interface PublicJsonLimits {
  /** Maximum number of traversed values, including primitive leaves. */
  maxNodes: number;
  /** Maximum nesting below the root value. */
  maxDepth: number;
  /** Maximum own keys an individual object may expose. */
  maxContainerKeys: number;
  /** Maximum logical length accepted for an array, including holes. */
  maxArrayLength: number;
  /** Maximum UTF-8 bytes accepted for one pre-scrub string or key. */
  maxStringBytes: number;
  /** Maximum UTF-8 bytes in the final JSON representation. */
  maxOutputBytes: number;
}

const DEFAULT_LIMITS: Readonly<PublicJsonLimits> = Object.freeze({
  maxNodes: 50_000,
  maxDepth: 64,
  maxContainerKeys: 20_000,
  maxArrayLength: 20_000,
  maxStringBytes: 256 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
});

export type PublicJsonFailureReason =
  | 'array-limit'
  | 'container-limit'
  | 'depth-limit'
  | 'inspection-failed'
  | 'key-collision'
  | 'node-limit'
  | 'output-limit'
  | 'string-limit';

/**
 * A deliberately detail-free failure. Values, keys and exception prose from
 * the inspected graph must never cross the public API boundary.
 */
export class PublicJsonSanitizationError extends Error {
  readonly code = 'PUBLIC_JSON_SANITIZATION_FAILED';

  constructor(readonly reason: PublicJsonFailureReason) {
    super(`public JSON sanitization failed: ${reason}`);
    this.name = 'PublicJsonSanitizationError';
  }
}

function homeCandidates(): string[] {
  const homes = [homedir(), process.env.HOME, process.env.USERPROFILE]
    .filter((value): value is string => typeof value === 'string' && value.length > 1);
  return Array.from(new Set(homes)).sort((a, b) => b.length - a.length);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizedLimits(overrides: Partial<PublicJsonLimits> | undefined): PublicJsonLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`invalid public JSON limit: ${key}`);
    }
  }
  return limits;
}

function scrubPublicString(input: string, homes: string[]): string {
  let out = input;
  for (const home of homes) {
    out = out.split(home).join('~');
  }
  out = scrubSecrets(out);
  for (const home of homes) {
    out = out.split(home).join('~');
  }
  return out;
}

const OMIT = Symbol('omit-public-json-value');

/**
 * Convert arbitrary local read-model data into a detached public dashboard/API
 * payload.
 *
 * Only own, enumerable data properties are traversed. Getters, setters,
 * symbols, inherited properties and non-enumerable properties are omitted
 * without reading them. Traversal and output are bounded; a typed, detail-free
 * error is thrown when the graph cannot be inspected safely or represented
 * within those bounds. Existing HTTP/SSE callers already contain that failure:
 * JSON responses fall back to a small 500 and an unsafe SSE frame is dropped.
 */
export function sanitizePublicJson(
  value: unknown,
  limitOverrides?: Partial<PublicJsonLimits>,
): unknown {
  const homes = homeCandidates();
  const limits = normalizedLimits(limitOverrides);
  const active = new WeakSet<object>();
  let nodes = 0;
  let estimatedOutputBytes = 0;

  function fail(reason: PublicJsonFailureReason): never {
    throw new PublicJsonSanitizationError(reason);
  }

  function countNode(depth: number): void {
    if (depth > limits.maxDepth) fail('depth-limit');
    nodes += 1;
    if (nodes > limits.maxNodes) fail('node-limit');
  }

  function consumeOutputBytes(bytes: number): void {
    estimatedOutputBytes += bytes;
    if (estimatedOutputBytes > limits.maxOutputBytes) fail('output-limit');
  }

  function jsonStringBytes(value: string): number {
    return utf8Bytes(JSON.stringify(value));
  }

  function scrubBounded(input: string, chargeOutput = true): string {
    if (utf8Bytes(input) > limits.maxStringBytes) fail('string-limit');
    const scrubbed = scrubPublicString(input, homes);
    if (utf8Bytes(scrubbed) > limits.maxStringBytes) fail('string-limit');
    if (chargeOutput) consumeOutputBytes(jsonStringBytes(scrubbed));
    return scrubbed;
  }

  function ownKeys(current: object): (string | symbol)[] {
    try {
      const keys = Reflect.ownKeys(current);
      if (keys.length > limits.maxContainerKeys) fail('container-limit');
      return keys;
    } catch (error) {
      if (error instanceof PublicJsonSanitizationError) throw error;
      return fail('inspection-failed');
    }
  }

  function ownDescriptor(current: object, key: PropertyKey): PropertyDescriptor {
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined) fail('inspection-failed');
      return descriptor;
    } catch (error) {
      if (error instanceof PublicJsonSanitizationError) throw error;
      return fail('inspection-failed');
    }
  }

  function visit(current: unknown, depth: number, inArray: boolean): unknown | typeof OMIT {
    countNode(depth);

    if (typeof current === 'string') return scrubBounded(current);
    if (typeof current === 'bigint') return scrubBounded(current.toString());
    if (current === null) {
      consumeOutputBytes(4);
      return current;
    }
    if (typeof current === 'boolean') {
      consumeOutputBytes(current ? 4 : 5);
      return current;
    }
    if (typeof current === 'number') {
      const normalized = Number.isFinite(current) ? current : null;
      consumeOutputBytes(utf8Bytes(JSON.stringify(normalized)));
      return normalized;
    }
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
      if (inArray) consumeOutputBytes(4);
      return inArray ? null : OMIT;
    }
    if (typeof current !== 'object') return inArray ? null : OMIT;

    // A Proxy can run arbitrary user code from ownKeys/getOwnPropertyDescriptor
    // traps and can change its answers between operations. There is no safe
    // descriptor-only projection of an untrusted Proxy, so reject it before
    // invoking any trap.
    if (utilTypes.isProxy(current)) return fail('inspection-failed');

    if (utilTypes.isDate(current)) {
      try {
        return scrubBounded(Date.prototype.toISOString.call(current));
      } catch {
        return fail('inspection-failed');
      }
    }

    if (active.has(current)) return scrubBounded('[Circular]');
    active.add(current);
    try {
      if (Array.isArray(current)) {
        consumeOutputBytes(2);
        let length: number;
        try {
          length = current.length;
        } catch {
          return fail('inspection-failed');
        }
        if (!Number.isSafeInteger(length) || length < 0 || length > limits.maxArrayLength) {
          return fail('array-limit');
        }

        const keys = ownKeys(current);
        const descriptors = new Map<number, PropertyDescriptor>();
        for (const key of keys) {
          if (typeof key !== 'string' || key === 'length') continue;
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) continue;
          const descriptor = ownDescriptor(current, key);
          if (descriptor.enumerable === true && 'value' in descriptor) descriptors.set(index, descriptor);
        }

        const out = new Array<unknown>(length);
        // JSON.stringify consults an inherited toJSON before array elements.
        // Detach the new array before writing or sizing it so a poisoned
        // Array.prototype cannot execute or replace the public projection.
        Object.setPrototypeOf(out, null);
        for (let index = 0; index < length; index += 1) {
          if (index > 0) consumeOutputBytes(1);
          const descriptor = descriptors.get(index);
          if (descriptor === undefined) {
            consumeOutputBytes(4);
            out[index] = null;
          } else {
            out[index] = visit(descriptor.value, depth + 1, true);
          }
        }
        return out;
      }

      consumeOutputBytes(2);
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let included = 0;
      for (const key of ownKeys(current)) {
        if (typeof key !== 'string') continue;
        const descriptor = ownDescriptor(current, key);
        if (descriptor.enumerable !== true || !('value' in descriptor)) continue;
        const publicKey = scrubBounded(key, false);
        const nested = visit(descriptor.value, depth + 1, false);
        if (nested !== OMIT) {
          if (Object.hasOwn(out, publicKey)) fail('key-collision');
          // Omitted fields do not exist in the encoded object, so charge the
          // key token only after the nested value is known to be retained.
          consumeOutputBytes(jsonStringBytes(publicKey) + (included === 0 ? 1 : 2));
          included += 1;
          out[publicKey] = nested;
        }
      }
      return out;
    } finally {
      active.delete(current);
    }
  }

  const sanitized = visit(value, 0, false);
  const detached = sanitized === OMIT ? undefined : sanitized;
  try {
    const encoded = JSON.stringify(detached ?? null);
    if (utf8Bytes(encoded) > limits.maxOutputBytes) fail('output-limit');
  } catch (error) {
    if (error instanceof PublicJsonSanitizationError) throw error;
    fail('inspection-failed');
  }
  return detached;
}
