/**
 * index.ts — M249 / RunCache barrel export.
 *
 * Public seam for the RunCache module. Consumers import from this path only.
 */

export { buildCacheKey, buildCacheKeyInput, canonicalizeGoal, hashConfigSlice } from './key.js';
export type { CacheKeyInput } from './key.js';

export { lookup, write, recordOutcome, sweep, _clearIndexCache } from './store.js';
export type { CacheEntry, CacheEngineTier } from './store.js';
