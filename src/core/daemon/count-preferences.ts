/** Operator count preferences. Null removes a preference ceiling, not admission. */
import type { DaemonConfig } from '../types.js';

export function resolveCountPreference(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveDaemonCountPreferences(raw: Partial<DaemonConfig> = {}) {
  const total = resolveCountPreference(raw.concurrency?.total, 8);
  return {
    perTickItems: resolveCountPreference(raw.perTickItems, 3),
    parallel: resolveCountPreference(raw.parallel, 2),
    // Explicit null has the same precedence as an explicit numeric override.
    maxConcurrent: resolveCountPreference(raw.maxConcurrent, total),
    concurrency: {
      local: resolveCountPreference(raw.concurrency?.local, 2),
      cloud: resolveCountPreference(raw.concurrency?.cloud, 6),
      total,
    },
  };
}

/** Allocate only from finite admitted inventory; never use a sentinel width. */
export function countForInventory(preference: number | null, inventory: number): number {
  const available = Number.isSafeInteger(inventory) && inventory > 0 ? inventory : 0;
  return preference === null ? available : Math.min(preference, available);
}
