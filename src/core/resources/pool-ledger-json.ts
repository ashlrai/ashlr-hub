/**
 * Strict canonical JSON for the resource pool ledger (pool-state.json).
 *
 * WHY this exists instead of reusing canonicalEvidencePackJsonV3: the evidence-pack
 * serializer is a cryptographic contract sized for signed evidence (1 MiB, 16,384 JSON
 * values). The pool ledger is a different store whose writer and settlement-headroom
 * check admit up to 4 MiB and 4,096 receipts. Decoding the ledger through the evidence-pack
 * bounds (2026-09-10, 10f1909c) meant a ledger of a few hundred receipts (~20 values each)
 * was written successfully and then refused on the next read, bricking the pool until a
 * manual repair. The same trap was already found and fixed for the supervisor store
 * (pool-supervisor.ts assertStateData). This helper keeps the evidence-pack strictness
 * (plain, acyclic, finite, dense, data-only JSON with deterministic key order) and takes its
 * size limits from the ledger's own writer instead, so the evidence-pack contract stays frozen.
 */

export interface ResourceLedgerJsonBounds {
  /** Canonical UTF-8 byte ceiling; the caller accounts for any trailing newline. */
  maxBytes: number;
  /** Largest array (or object field count) the ledger's writer can legitimately produce. */
  maxContainerEntries: number;
  /** Nesting ceiling; the real ledger is < 10 deep, 32 matches the other resource stores. */
  maxDepth?: number;
}

interface Budget { nodes: number; readonly maxNodes: number; readonly maxDepth: number; readonly maxEntries: number }
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

class LedgerJsonError extends Error {}

function canonicalize(value: unknown, ancestors: Set<object>, depth: number, budget: Budget): Json {
  // Every JSON value serializes to at least one byte, so a node ceiling equal to the byte
  // ceiling can never refuse a ledger the byte check would admit. It only stops a huge
  // in-memory value (the offline migrator passes objects, not file bytes) before the
  // traversal does unbounded work.
  if (++budget.nodes > budget.maxNodes || depth > budget.maxDepth) throw new LedgerJsonError();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LedgerJsonError();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new LedgerJsonError();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > budget.maxEntries) throw new LedgerJsonError();
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes('length')) throw new LedgerJsonError();
      const output: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new LedgerJsonError();
        output.push(canonicalize(descriptor.value, ancestors, depth + 1, budget));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new LedgerJsonError();
    const names = Object.getOwnPropertyNames(value);
    if (names.length > budget.maxEntries) throw new LedgerJsonError();
    const output = Object.create(null) as Record<string, Json>;
    // Code-unit order, identical to the evidence-pack serializer, so a ledger's canonical
    // bytes do not depend on locale.
    for (const key of names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new LedgerJsonError();
      output[key] = canonicalize(descriptor.value, ancestors, depth + 1, budget);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Canonical JSON for a pool ledger value, or null when it is not strict JSON data or exceeds
 * the ledger's own bounds. Never throws on hostile input (getters that throw included).
 */
export function canonicalResourceLedgerJson(value: unknown, bounds: ResourceLedgerJsonBounds): string | null {
  const { maxBytes, maxContainerEntries, maxDepth = 32 } = bounds;
  if (![maxBytes, maxContainerEntries, maxDepth].every((limit) => Number.isSafeInteger(limit) && limit > 0)) return null;
  try {
    const json = JSON.stringify(canonicalize(value, new Set<object>(), 0,
      { nodes: 0, maxNodes: maxBytes, maxDepth, maxEntries: maxContainerEntries }));
    return Buffer.byteLength(json, 'utf8') <= maxBytes ? json : null;
  } catch {
    return null;
  }
}
