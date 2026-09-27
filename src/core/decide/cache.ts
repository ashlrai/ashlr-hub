/**
 * decide/cache.ts — input-hash cache for Jev answers.
 *
 * Keyed by sha256(kind, model, question schema, salt, state). The same stderr,
 * the same PR title or the same operator message classified twice costs one
 * call, not two. Only SUCCESSFUL answer sets are cached — a timeout or a 429 is
 * a statement about the transport at that moment, not about the input.
 *
 * In-memory and bounded on purpose: the daemon is long-lived (where repeats
 * actually happen), a disk cache would be one more place classified text could
 * leak through its hash-adjacent metadata, and a CLI process that restarts
 * simply pays for one call again.
 */

import { createHash } from 'node:crypto';
import type { TypeSafeOk } from '../classify/typesafe-client.js';

const MAX_ENTRIES = 1_000;
const TTL_MS = 6 * 60 * 60 * 1000;

interface Entry {
  readonly at: number;
  readonly result: TypeSafeOk;
}

const entries = new Map<string, Entry>();

export function cacheKey(parts: readonly string[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(String(p.length));
    h.update(':');
    h.update(p);
  }
  return h.digest('hex');
}

export function cacheGet(key: string, now: number = Date.now()): TypeSafeOk | undefined {
  const hit = entries.get(key);
  if (!hit) return undefined;
  if (now - hit.at > TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  // Refresh recency (Map preserves insertion order → cheap LRU).
  entries.delete(key);
  entries.set(key, hit);
  return hit.result;
}

export function cacheSet(key: string, result: TypeSafeOk, now: number = Date.now()): void {
  entries.delete(key);
  entries.set(key, { at: now, result });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function cacheSize(): number {
  return entries.size;
}

export function clearDecisionCache(): void {
  entries.clear();
}
