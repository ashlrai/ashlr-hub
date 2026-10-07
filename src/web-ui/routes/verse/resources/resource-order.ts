/** Presentation only: account IDs, never usage readings, determine rail order. */
import { useSyncExternalStore } from 'react';

export const RESOURCE_ORDER_KEY = 'ashlr.verse.resource-order.v1';
const STORAGE_BYTES = 64 * 1024;

function load(): readonly string[] {
  try {
    const text = localStorage.getItem(RESOURCE_ORDER_KEY);
    if (!text || text.length > STORAGE_BYTES || new TextEncoder().encode(text).length > STORAGE_BYTES) return [];
    const raw: unknown = JSON.parse(text);
    return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
  } catch { return []; }
}

let order = load();
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useResourceOrder(): readonly string[] {
  return useSyncExternalStore(subscribe, () => order, () => order);
}

/** Missing resources are ignored; new resources append in stable roster order. */
export function orderedResources<T extends { key: string }>(rows: readonly T[], saved: readonly string[]): T[] {
  const byId = new Map(rows.map(row => [row.key, row]));
  const result: T[] = [];
  for (const id of saved) {
    const row = byId.get(id);
    if (row) { result.push(row); byId.delete(id); }
  }
  for (const row of rows) if (byId.delete(row.key)) result.push(row);
  return result;
}

/** Reorder only the currently visible IDs; retain temporarily absent accounts. */
export function moveResource(ids: readonly string[], source: string, target: string): boolean {
  const from = ids.indexOf(source);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return false;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, source);
  const visible = new Set(ids);
  order = [...next, ...order.filter(id => !visible.has(id))];
  try {
    const raw = JSON.stringify(order);
    // A storage byte bound, never an account limit: choices still work in memory.
    if (new TextEncoder().encode(raw).length <= STORAGE_BYTES) localStorage.setItem(RESOURCE_ORDER_KEY, raw);
    else localStorage.removeItem(RESOURCE_ORDER_KEY);
  } catch { /* Storage may be unavailable. */ }
  for (const listener of [...listeners]) listener();
  return true;
}

/** Fresh-page storage behavior for tests. */
export function reloadResourceOrderForTest(): void {
  order = load();
  for (const listener of [...listeners]) listener();
}
