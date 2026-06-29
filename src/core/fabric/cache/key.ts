/**
 * key.ts — M249 / SPEC-INFERENCE-FABRIC Phase F2 part 1: RunCache key construction.
 *
 * Builds a git-source-aware cache key that guarantees:
 *   - Two keys collide ONLY when the source state is genuinely identical:
 *     same canonicalized goal, same tracked-file tree (repoTreeSha), same
 *     dirty worktree state (dirtyHash), same engine/model, same gate-relevant
 *     config slice.
 *   - Any source change (commit, checkout, merge, edit) produces a guaranteed
 *     miss — no stale diff can ever be served.
 *
 * SAFETY: pure functions, zero runtime deps (node:crypto + node:child_process).
 * Never throws — callers must handle the never-throw guarantee at their layer.
 *
 * SHADOW MODE ONLY (M249): these functions are called in shadow mode. The key
 * is computed and logged for measurement. No cached diff is ever served until
 * M250 (live short-circuit) is explicitly enabled by Mason.
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

import type { AshlrConfig, EngineId, EngineTier } from '../../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Schema version — bump to wholesale-invalidate all stored entries. */
const SCHEMA_VERSION = 1 as const;

/**
 * All inputs that participate in the cache key.
 *
 * Design rationale:
 *   - `repoTreeSha` (`git rev-parse HEAD:`) folds ALL tracked file contents into
 *     a single SHA. Any commit, checkout, merge, or edit that changes tracked
 *     files changes this hash → guaranteed miss.
 *   - `dirtyHash` (`sha256(git diff)`) captures uncommitted working-tree changes.
 *     A clean tree → 'clean'. Any uncommitted edit → a different hex hash.
 *     Together repoTreeSha + dirtyHash = the complete source state, tracked and
 *     untracked-but-modified.
 *   - Non-git directories are tolerated: repoTreeSha stays 'unknown' → misses
 *     always (safe, never a false hit).
 *   - `configEpoch` is a 16-char prefix of sha256 over the gate-relevant config
 *     slice (allowedBackends, scopeCap, judgeModel, testCmd). A config change
 *     that affects what the engine is asked to do invalidates prior entries.
 *   - `schemaVersion` allows wholesale invalidation when the key format changes.
 */
export interface CacheKeyInput {
  engine: EngineId;
  engineModel: string;       // resolveConcreteModel output — params matter
  goalCanonical: string;     // normalized: collapse whitespace, strip volatile ids
  repoTreeSha: string;       // `git rev-parse HEAD:` tree SHA
  dirtyHash: string;         // sha256(`git diff`) or 'clean'
  configEpoch: string;       // 16-char hex prefix of sha256 over gate config slice
  schemaVersion: typeof SCHEMA_VERSION;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a CacheKeyInput from runtime context.
 *
 * @param engine   - engine id (e.g. 'claude')
 * @param engineModel - full model string (e.g. 'claude:claude-opus-4-5')
 * @param _tier    - engine tier (unused in key, kept for call-site symmetry)
 * @param goal     - the goal string passed to the engine
 * @param cwd      - working directory / source repo
 * @param cfg      - ashlr config (for configEpoch)
 */
export function buildCacheKeyInput(
  engine: EngineId,
  engineModel: string,
  _tier: EngineTier,
  goal: string,
  cwd: string,
  cfg: AshlrConfig,
): CacheKeyInput {
  let repoTreeSha = 'unknown';
  let dirtyHash = 'clean';
  try {
    repoTreeSha = execSync('git rev-parse HEAD:', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const diff = execSync('git diff', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    dirtyHash = diff.length > 0
      ? createHash('sha256').update(diff).digest('hex')
      : 'clean';
  } catch {
    // Non-git dir or git unavailable → repoTreeSha stays 'unknown' → always misses.
    // This is the safe path: unknown source state → never a false hit.
  }

  return {
    engine,
    engineModel,
    goalCanonical: canonicalizeGoal(goal),
    repoTreeSha,
    dirtyHash,
    configEpoch: hashConfigSlice(cfg),
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Deterministic cache key from a CacheKeyInput.
 * Keys are sorted before serialization so insertion order never affects the hash.
 */
export function buildCacheKey(input: CacheKeyInput): string {
  return createHash('sha256')
    .update(JSON.stringify(input, Object.keys(input).sort() as (keyof CacheKeyInput)[]))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Normalize a goal string:
 *   - Collapse all whitespace sequences to a single space
 *   - Strip volatile identifiers: UUIDs, ISO timestamps, PR/issue numbers
 *   - Trim leading/trailing whitespace
 *
 * Two goals that differ only in volatile ids (e.g. a run-id in a task title)
 * resolve to the same canonical form → can share a cache entry for the same
 * source state.
 */
export function canonicalizeGoal(goal: string): string {
  return goal
    .replace(/\s+/g, ' ')
    // UUIDs (8-4-4-4-12)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
    // ISO timestamps (2024-01-01T00:00:00 prefix)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, 'TS')
    // bare dates (2024-01-01)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'DATE')
    // Unix epoch millis / large numeric ids (>= 10 digits)
    .replace(/\b\d{10,}\b/g, 'ID')
    .trim();
}

/**
 * Hash the gate-relevant config slice.
 * Returns a 16-char hex prefix (64 bits) — sufficient for collision resistance
 * in a per-repo JSONL with a 2000-entry cap.
 */
export function hashConfigSlice(cfg: AshlrConfig): string {
  const slice = {
    allowedBackends: (cfg.foundry as Record<string, unknown> | undefined)?.['allowedBackends'],
    scopeCap: (cfg.foundry as Record<string, unknown> | undefined)?.['scopeCap'],
    judgeModel: (cfg.foundry as Record<string, unknown> | undefined)?.['judgeModel'],
    testCmd: (cfg.foundry as Record<string, unknown> | undefined)?.['testCmd'],
  };
  return createHash('sha256').update(JSON.stringify(slice)).digest('hex').slice(0, 16);
}
