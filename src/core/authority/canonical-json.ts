/**
 * Canonical JSON — the one byte encoding every signed or hash-chained
 * authority record uses (V3.10 Track B, unit B-U1).
 *
 *   - object keys sorted by UTF-16 code unit (Array.prototype.sort's order);
 *   - no whitespace;
 *   - `undefined`, function and symbol values dropped from objects (and
 *     written as `null` inside arrays), exactly as JSON.stringify does;
 *   - strings and numbers escaped / formatted by JSON.stringify, so '/' is
 *     NOT escaped (Swift's JSONEncoder escapes it — the custody helper keeps
 *     its own canonicalizer and the shared contract test pins the bytes);
 *   - non-finite numbers, cycles and non-JSON values (bigint) are errors.
 *
 * WHY A LEAF MODULE: this is the exact algorithm activation-permit.ts has
 * used for M461 permits (`canonicalizeDaemonActivationValue`, which now
 * re-exports it). Keeping it here with ZERO imports lets the grant verifier,
 * the ledger and the surface digest share it without importing
 * activation-permit.ts — which would close an import cycle (activation-permit
 * asks the standing policy whether live conductors may run). It is also a
 * leaf of the authority surface: it can never widen the closure.
 *
 * BROWSER-SAFE: pure, no imports.
 */

function canonicalJsonValue(value: unknown, stack: Set<object>): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value !== 'object') throw new Error('canonical JSON rejects unsupported values');
  if (stack.has(value)) throw new Error('canonical JSON rejects cycles');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJsonValue(entry, stack) ?? 'null').join(',')}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => {
        const encoded = canonicalJsonValue((value as Record<string, unknown>)[key], stack);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      });
    return `{${entries.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

/** The canonical encoding of `value`. Throws for a value JSON cannot represent exactly. */
export function canonicalJson(value: unknown): string {
  const encoded = canonicalJsonValue(value, new Set());
  if (encoded === undefined) throw new Error('canonical JSON requires a value');
  return encoded;
}
