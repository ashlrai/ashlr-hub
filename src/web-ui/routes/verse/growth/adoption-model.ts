import { ADOPTION_REASON_TEXT, ADOPTION_SOURCE_IDS, ADOPTION_TARGET, type AdoptionSnapshot, type AdoptionReading, type AdoptionValues, type AdoptionSourceId } from '../../../../core/verse/adoption-types.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const stamp = (v: unknown) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
/** Server mismatch remains unknown instead of throwing a render or inventing a count. */
export function narrowAdoption(raw: unknown): AdoptionSnapshot | null {
  if (!record(raw) || raw['v'] !== 1 || !record(raw['target']) || raw['target']['repo'] !== ADOPTION_TARGET.repo || raw['target']['packageName'] !== ADOPTION_TARGET.packageName || !record(raw['sources'])) return null;
  for (const id of ADOPTION_SOURCE_IDS) {
    const reading = raw['sources'][id];
    if (!record(reading) || !['warming', 'ready', 'unavailable'].includes(String(reading['state'])) || typeof reading['refreshing'] !== 'boolean' || typeof reading['stale'] !== 'boolean' || !stamp(reading['observedAt']) || !stamp(reading['checkedAt']) || !stamp(reading['retryAt']) || (reading['reason'] !== null && !Object.hasOwn(ADOPTION_REASON_TEXT, String(reading['reason'])))) return null;
    const v = reading['value'];
    if (v === null) { if (reading['state'] === 'ready' || reading['observedAt'] !== null) return null; continue; }
    if (!record(v) || reading['state'] !== 'ready' || reading['observedAt'] === null) return null;
    if (id === 'repository') { if (v['repo'] !== ADOPTION_TARGET.repo || !count(v['stars']) || !count(v['forks'])) return null; }
    else if (id === 'npm') {
      if (v['packageName'] !== ADOPTION_TARGET.packageName || !day(v['start']) || !day(v['end']) || !Array.isArray(v['days']) || v['days'].length !== 30 || typeof v['complete'] !== 'boolean' || (v['total'] !== null && !count(v['total']))) return null;
      const expectedStart = Date.parse(v['start']);
      for (let i = 0; i < v['days'].length; i += 1) {
        const d = v['days'][i];
        if (!record(d) || !day(d['day']) || Date.parse(d['day']) !== expectedStart + i * 86_400_000 || (d['count'] !== null && !count(d['count']))) return null;
      }
      if ((v['days'].at(-1) as Record<string, unknown>)['day'] !== v['end']) return null;
      const complete = v['days'].every((d: Record<string, unknown>) => d['count'] !== null);
      const sum = complete ? v['days'].reduce((n: number, d: Record<string, unknown>) => n + Number(d['count']), 0) : null;
      if (v['complete'] !== complete || v['total'] !== sum || (sum !== null && !count(sum))) return null;
    } else if (id === 'views' || id === 'clones') {
      if (!count(v['count']) || !count(v['uniques']) || v['uniques'] > v['count'] || v['window'] !== 'provider-last-14-days-utc' || !Array.isArray(v['days']) || v['days'].length > 15) return null;
      const seen = new Set<string>();
      for (const d of v['days']) { if (!record(d) || !day(d['day']) || seen.has(d['day']) || !count(d['count']) || !count(d['uniques']) || d['uniques'] > d['count']) return null; seen.add(d['day']); }
      const sorted = [...seen].sort();
      if (sorted.length > 1 && Date.parse(sorted.at(-1)!) - Date.parse(sorted[0]!) > 14 * 86_400_000) return null;
      if (v['days'].reduce((n: number, d: Record<string, unknown>) => n + Number(d['count']), 0) !== v['count']) return null;
    } else {
      if (!count(v['id']) || v['id'] === 0 || !text(v['tag']) || typeof v['publishedAt'] !== 'string' || !stamp(v['publishedAt']) || v['coverage'] !== 'latest-published-release-only' || !Array.isArray(v['assets'])) return null;
      const seen = new Set<number>();
      for (const a of v['assets']) { if (!record(a) || !count(a['id']) || a['id'] === 0 || seen.has(a['id']) || !text(a['name']) || !count(a['count'])) return null; seen.add(a['id']); }
    }
  }
  return raw as unknown as AdoptionSnapshot;
}
export function adoptionStatus<K extends AdoptionSourceId>(reading: AdoptionReading<AdoptionValues[K]> | undefined, unavailable: string): ChartStatus {
  if (!reading) return { kind: 'unknown', reason: unavailable };
  if (reading.value !== null) return { kind: 'ready' };
  return reading.state === 'warming' ? { kind: 'loading' } : { kind: 'unknown', reason: reading.reason ? ADOPTION_REASON_TEXT[reading.reason] : 'No reading reported.' };
}
export function adoptionSourceNote(reading: AdoptionReading<unknown> | undefined): string {
  if (!reading) return 'No compatible adoption reading.';
  const observed = reading.observedAt ? `Observed ${new Date(reading.observedAt).toLocaleString()}.` : 'Not yet observed.';
  const reason = reading.reason ? ` ${ADOPTION_REASON_TEXT[reading.reason]}` : '';
  const retry = reading.retryAt ? ` Next permitted attempt after ${new Date(reading.retryAt).toLocaleString()}.` : '';
  return `${reading.stale ? 'Stale reading. ' : ''}${observed}${reading.refreshing ? ' Refreshing.' : ''}${reason}${retry}`;
}
/** Fill only gaps between provider-returned dates; unknown never becomes zero. */
export function trafficDays(days: Array<{ day: string; count: number }>): Array<{ day: string; count: number | null }> {
  if (days.length === 0) return [];
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const map = new Map(sorted.map((d) => [d.day, d.count]));
  const start = Date.parse(sorted[0]!.day), end = Date.parse(sorted.at(-1)!.day);
  return Array.from({ length: (end - start) / 86_400_000 + 1 }, (_, i) => {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    return { day, count: map.get(day) ?? null };
  });
}
