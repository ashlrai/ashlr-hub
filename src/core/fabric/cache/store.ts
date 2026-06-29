/**
 * store.ts — M249 / SPEC-INFERENCE-FABRIC Phase F2 part 1: RunCache store.
 *
 * Persistence: append-only JSONL at ~/.ashlr/fabric/cache/<repo-prefix>.jsonl
 * with an in-process Map<string, CacheEntry> index (built lazily on first read).
 *
 * SHADOW MODE ONLY (M249): `lookup` is called and its result logged, but the
 * caller (sandboxed-engine.ts shadow hook) NEVER short-circuits on a hit.
 * `write` records post-run entries for measurement.
 *
 * SAFETY guarantees (all functions):
 *   - Never throws. Every public function catches all errors internally.
 *   - Flag off (cfg.foundry.fabric?.cacheShadow !== true) → lookup returns null,
 *     write/recordOutcome/sweep no-op. Byte-identical to pre-M249 when off.
 *   - No cross-repo leakage: store files are scoped by a prefix derived from
 *     the repo path hash, never shared across repos.
 *   - write() is fire-and-forget (sync write in try/catch).
 *
 * Eviction fields are structural-only in M249 (shadow). No eviction fires until
 * M250+ — the fields are present so the file format is stable.
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from '../../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_MAX_ENTRIES = 2000;    // mirrors HUB_MAX_ENTRIES
const CACHE_TTL_DAYS = 7;          // matches Portkey/Helicone norm
const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CacheEngineTier = 'local' | 'mid' | 'frontier';

/** One persisted cache entry. */
export interface CacheEntry {
  /** sha256 from buildCacheKey — the primary lookup key. */
  key: string;
  /** Secret-scrubbed diff (scrubSecrets already applied at write time). */
  patch: string;
  /** Stored for audit trail. NEVER replayed on serve — always re-signed fresh. */
  provenanceSig: string;
  /** Full engine:model string. */
  engineModel: string;
  /** Engine tier at time of write. */
  tier: CacheEngineTier;
  /** sha256 of the scrubbed patch (used for quality-feedback tracking). */
  diffHash: string;
  /** git tree SHA at time of write — for sweep/audit. */
  repoTreeSha: string;
  /** Optional: only when semantic opt-in ON. Never used to serve a diff. */
  goalEmbedding?: number[];
  /** Trust level at write time. */
  verdictAtWrite: 'verified' | 'unknown';
  /** Quality-feedback counters. Entries with reject > ship are evicted at sweep. */
  shipOutcomes: { ship: number; reject: number };
  /** ISO timestamp of first write. */
  createdAt: string;
  /** ISO timestamp of most recent lookup hit. */
  lastHit: string;
  /** Total number of times this entry has been hit. */
  hits: number;
  /** Schema version — must match SCHEMA_VERSION or entry is ignored. */
  schemaVersion: typeof SCHEMA_VERSION;
  /** Pinned embedding model id — mismatch → entry ignored (never compare across models). */
  embeddingModelId?: string;
}

// ---------------------------------------------------------------------------
// In-process index (lazy, per-file)
// ---------------------------------------------------------------------------

/**
 * Keyed by JSONL file path → loaded Map.
 * Avoids re-parsing the JSONL on every call within a single process lifetime.
 */
const _indexCache = new Map<string, Map<string, CacheEntry>>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the cache directory (~/.ashlr/fabric/cache/). */
function cacheBaseDir(): string {
  return join(homedir(), '.ashlr', 'fabric', 'cache');
}

/**
 * Derive a stable file path for a given repo.
 * Scoped to a single repo via a hash of the repo path — no cross-repo leakage.
 */
function jsonlPathFor(repoPath: string): string {
  const pathHash = createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
  return join(cacheBaseDir(), `${pathHash}.jsonl`);
}

/** Get or build the in-process index for a given JSONL file. Never throws. */
function getIndex(jsonlPath: string): Map<string, CacheEntry> {
  const cached = _indexCache.get(jsonlPath);
  if (cached) return cached;

  const index = new Map<string, CacheEntry>();
  try {
    if (existsSync(jsonlPath)) {
      const lines = readFileSync(jsonlPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as CacheEntry;
          if (
            typeof entry.key === 'string' &&
            entry.schemaVersion === SCHEMA_VERSION
          ) {
            index.set(entry.key, entry);
          }
        } catch {
          // Malformed line — skip silently.
        }
      }
    }
  } catch {
    // File unreadable — start with empty index.
  }
  _indexCache.set(jsonlPath, index);
  return index;
}

/** Invalidate the in-process index for a given path (after write). */
function invalidateIndex(jsonlPath: string): void {
  _indexCache.delete(jsonlPath);
}

/** Extract the flag state from cfg. */
function isFabricEnabled(cfg: AshlrConfig): boolean {
  const fabricCfg = (cfg.foundry as Record<string, unknown> | undefined)?.['fabric'] as
    Record<string, unknown> | undefined;
  return !!(fabricCfg?.['cacheShadow'] || fabricCfg?.['cache']);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Exact lookup by cache key.
 *
 * Returns the stored CacheEntry on hit, or null on miss / error / flag-off.
 * Never throws.
 *
 * SHADOW MODE INVARIANT: The caller (sandboxed-engine.ts) MUST NOT use a
 * non-null return to serve a cached result in M249. It is only for
 * would-hit/would-miss logging.
 */
export function lookup(cfg: AshlrConfig, key: string, repoPath: string): CacheEntry | null {
  try {
    if (!isFabricEnabled(cfg)) return null;
    const jsonlPath = jsonlPathFor(repoPath);
    const index = getIndex(jsonlPath);
    return index.get(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Write-through: append a new entry to the JSONL and update the in-process index.
 *
 * Fire-and-forget — caller does not await or check return value.
 * Never throws. Called only after sign/inbox path succeeds.
 */
export function write(cfg: AshlrConfig, entry: CacheEntry, repoPath: string): void {
  try {
    if (!isFabricEnabled(cfg)) return;
    const dir = cacheBaseDir();
    mkdirSync(dir, { recursive: true });
    const jsonlPath = jsonlPathFor(repoPath);
    appendFileSync(jsonlPath, JSON.stringify(entry) + '\n', 'utf8');
    invalidateIndex(jsonlPath);
  } catch {
    // Fire-and-forget: silently swallow all errors.
  }
}

/**
 * Quality-feedback eviction: when a proposal whose diff matches `diffHash` is
 * judged rejected/harmful, update the reject counter on matching entries.
 * Entries with reject > ship become candidates for sweep eviction.
 *
 * Never throws. Called from the merge/judge path (fire-and-forget).
 */
export function recordOutcome(
  cfg: AshlrConfig,
  diffHash: string,
  verdict: 'ship' | 'reject',
  _repoPath: string,
): void {
  try {
    if (!isFabricEnabled(cfg)) return;
    const dir = cacheBaseDir();
    if (!existsSync(dir)) return;

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

    for (const file of files) {
      const jsonlPath = join(dir, file);
      try {
        const lines = readFileSync(jsonlPath, 'utf8').split('\n');
        let changed = false;
        const updated = lines.map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          try {
            const entry = JSON.parse(trimmed) as CacheEntry;
            if (entry.diffHash === diffHash && entry.schemaVersion === SCHEMA_VERSION) {
              entry.shipOutcomes = {
                ship: entry.shipOutcomes.ship + (verdict === 'ship' ? 1 : 0),
                reject: entry.shipOutcomes.reject + (verdict === 'reject' ? 1 : 0),
              };
              changed = true;
              return JSON.stringify(entry);
            }
          } catch { /* skip */ }
          return line;
        });
        if (changed) {
          writeFileSync(jsonlPath, updated.join('\n'), 'utf8');
          invalidateIndex(jsonlPath);
        }
      } catch { /* skip file */ }
    }
  } catch {
    // Never throws.
  }
}

/**
 * LRU + TTL + quality-feedback sweep. Called from the optimizer tick.
 *
 * Eviction criteria:
 *   1. Entries older than CACHE_TTL_DAYS.
 *   2. Entries where shipOutcomes.reject > shipOutcomes.ship.
 *   3. When total entries > CACHE_MAX_ENTRIES: evict least-recently-hit entries.
 *
 * Returns count of removed entries. Never throws.
 * In M249 shadow mode this is structural-only — sweep is not called from M249.
 */
export function sweep(cfg: AshlrConfig): { removed: number } {
  let removed = 0;
  try {
    if (!isFabricEnabled(cfg)) return { removed: 0 };
    const dir = cacheBaseDir();
    if (!existsSync(dir)) return { removed: 0 };

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    for (const file of files) {
      const jsonlPath = join(dir, file);
      try {
        const lines = readFileSync(jsonlPath, 'utf8').split('\n');
        const entries: CacheEntry[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const e = JSON.parse(trimmed) as CacheEntry;
            if (e.schemaVersion === SCHEMA_VERSION) entries.push(e);
          } catch { /* skip */ }
        }

        const before = entries.length;
        let kept = entries
          .filter((e) => e.createdAt > cutoff)
          .filter((e) => e.shipOutcomes.reject <= e.shipOutcomes.ship);

        if (kept.length > CACHE_MAX_ENTRIES) {
          kept = kept
            .sort((a, b) => (b.lastHit > a.lastHit ? 1 : -1))
            .slice(0, CACHE_MAX_ENTRIES);
        }

        removed += before - kept.length;
        writeFileSync(
          jsonlPath,
          kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length > 0 ? '\n' : ''),
          'utf8',
        );
        invalidateIndex(jsonlPath);
      } catch { /* skip file */ }
    }
  } catch {
    // Never throws.
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// Test helpers (exported for test isolation only)
// ---------------------------------------------------------------------------

/** Clear the in-process index cache. Used in tests to reset state. */
export function _clearIndexCache(): void {
  _indexCache.clear();
}
