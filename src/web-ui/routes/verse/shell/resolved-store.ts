/**
 * routes/verse/shell/resolved-store.ts — which Needs-you items were just
 * acted on, so every list hides them at once (optimistic) until a poll no
 * longer lists them, or 60 s pass.
 *
 * Split out of needs-you-actions.ts, which re-exports all of it, so a
 * surface that only COUNTS what is waiting (the phone app's tab badge, at
 * first paint) does not download the action runner and the row model.
 */
import { useSyncExternalStore } from 'react';

/** How long an acted-on item stays hidden while the server catches up. */
export const RESOLVED_HIDE_MS = 60_000;

let resolved = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function markResolved(id: string, at: number = Date.now()): void {
  resolved = new Map(resolved).set(id, at);
  emit();
}

/** Drop marks the server has caught up with (the id is gone) or that are too old. */
export function pruneResolved(liveIds: ReadonlySet<string>, now: number = Date.now()): void {
  let changed = false;
  const next = new Map(resolved);
  for (const [id, at] of next) {
    if (!liveIds.has(id) || now - at > RESOLVED_HIDE_MS) {
      next.delete(id);
      changed = true;
    }
  }
  if (changed) {
    resolved = next;
    emit();
  }
}

export function useResolvedIds(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => resolved,
    () => resolved,
  );
}

export function resetResolvedForTest(): void {
  resolved = new Map();
  emit();
}
