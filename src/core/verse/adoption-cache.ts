/** One owned fixed-project metadata cache. Reads never cause collection. */
import { ADOPTION_SOURCE_IDS, ADOPTION_TARGET, type AdoptionSnapshot, type AdoptionSourceId, type AdoptionReading, type AdoptionValues } from './adoption-types.js';
import { adoptionTransport, readAdoptionSource, type AdoptionTransport, type AdoptionResult } from './adoption-reader.js';

const SOURCE_TTL: Record<AdoptionSourceId, number> = { repository: 15 * 60_000, npm: 6 * 60 * 60_000, views: 15 * 60_000, clones: 15 * 60_000, release: 15 * 60_000 };
function empty(): AdoptionSnapshot {
  const warming = () => ({ state: 'warming' as const, value: null, observedAt: null, checkedAt: null, refreshing: false, stale: false, reason: null, retryAt: null });
  return { v: 1, target: ADOPTION_TARGET, sources: { repository: warming(), npm: warming(), views: warming(), clones: warming(), release: warming() } };
}
export interface AdoptionCacheDeps { transport?: AdoptionTransport; now?: () => number; read?: typeof readAdoptionSource }
export function createAdoptionCache(deps: AdoptionCacheDeps = {}) {
  let snapshot = empty(), generation = 0;
  const flights = new Map<AdoptionSourceId, { promise: Promise<void>; controller: AbortController }>();
  const now = deps.now ?? Date.now, read = deps.read ?? readAdoptionSource;
  function peek(): AdoptionSnapshot {
    const result = structuredClone(snapshot), current = now();
    for (const id of ADOPTION_SOURCE_IDS) {
      const reading = result.sources[id];
      if (reading.observedAt && current - Date.parse(reading.observedAt) >= SOURCE_TTL[id]) reading.stale = true;
    }
    return result;
  }
  async function refreshSource<K extends AdoptionSourceId>(id: K, force: boolean): Promise<void> {
    const current = now(), previous = snapshot.sources[id];
    if (previous.retryAt && Date.parse(previous.retryAt) > current) return;
    const existing = flights.get(id); if (existing) return existing.promise;
    if (!force && previous.reason === null && previous.checkedAt && current - Date.parse(previous.checkedAt) < SOURCE_TTL[id]) return;
    const controller = new AbortController(), captured = generation;
    snapshot.sources[id].refreshing = true;
    const promise = (async () => {
      let result: AdoptionResult<AdoptionValues[K]>;
      try { result = await read(id, deps.transport ?? adoptionTransport, controller.signal, now); }
      catch { result = { ok: false, reason: 'unavailable', retryAt: null }; }
      if (captured !== generation || controller.signal.aborted) return;
      const checkedAt = new Date(now()).toISOString();
      const before = snapshot.sources[id];
      const next: AdoptionReading<AdoptionValues[K]> = result.ok
        ? { state: 'ready', value: result.value, observedAt: checkedAt, checkedAt, refreshing: false, stale: false, reason: null, retryAt: null }
        : {
          state: before.value === null ? 'unavailable' : 'ready', value: before.value,
          observedAt: before.observedAt, checkedAt, refreshing: false, stale: before.value !== null,
          reason: result.reason,
          retryAt: new Date(Math.max(now() + (result.reason === 'rate-limited' ? 5 * 60_000 : 60_000), result.retryAt ?? 0)).toISOString(),
        };
      // K maps to the matching fixed source; no source can overwrite another source's value.
      (snapshot.sources[id] as AdoptionReading<AdoptionValues[K]>) = next;
    })().finally(() => { if (flights.get(id)?.controller === controller) flights.delete(id); });
    flights.set(id, { promise, controller });
    return promise;
  }
  async function refresh(force = false): Promise<void> { await Promise.all(ADOPTION_SOURCE_IDS.map((id) => refreshSource(id, force))); }
  async function reset(): Promise<void> {
    generation += 1;
    const pending = [...flights.values()]; flights.clear(); snapshot = empty();
    for (const flight of pending) flight.controller.abort();
    await Promise.allSettled(pending.map((flight) => flight.promise));
  }
  return { peek, refresh, reset };
}
export const adoptionCache = createAdoptionCache();
let owners = 0, timer: ReturnType<typeof setInterval> | null = null;
/** Listener owns scheduling, not GET handlers or React cards. Last owner cancels and drains requests. */
export function startOwnedAdoptionCollector(): () => Promise<void> {
  owners += 1;
  if (owners === 1) {
    void adoptionCache.refresh();
    timer = setInterval(() => { void adoptionCache.refresh(); }, 60_000); timer.unref();
  }
  let closed = false;
  return async () => {
    if (closed) return; closed = true; owners -= 1;
    if (owners === 0) { if (timer) clearInterval(timer); timer = null; await adoptionCache.reset(); }
  };
}
