/** Browser-safe fixed-project adoption metadata. These are distinct measurements, never a user total. */
export const VERSE_ADOPTION_PATH = '/api/verse/adoption';
export const VERSE_ADOPTION_REFRESH_PATH = `${VERSE_ADOPTION_PATH}/refresh`;
export const ADOPTION_TARGET = Object.freeze({ repo: 'ashlrai/ashlr-hub', packageName: '@ashlr/hub' });
export type AdoptionSourceId = 'repository' | 'npm' | 'views' | 'clones' | 'release';
export type AdoptionReason = 'permission' | 'authentication' | 'not-found' | 'rate-limited' | 'unavailable' | 'invalid-response' | 'cancelled';
export interface AdoptionReading<T> {
  state: 'warming' | 'ready' | 'unavailable';
  value: T | null;
  observedAt: string | null;
  checkedAt: string | null;
  refreshing: boolean;
  stale: boolean;
  reason: AdoptionReason | null;
  retryAt: string | null;
}
export interface AdoptionRepository { repo: string; stars: number; forks: number }
export interface AdoptionDay { day: string; count: number | null }
export interface AdoptionNpm { packageName: string; start: string; end: string; days: AdoptionDay[]; complete: boolean; total: number | null }
export interface AdoptionTraffic { count: number; uniques: number; days: Array<{ day: string; count: number; uniques: number }>; window: 'provider-last-14-days-utc' }
export interface AdoptionReleaseAsset { id: number; name: string; count: number }
export interface AdoptionRelease { id: number; tag: string; publishedAt: string; assets: AdoptionReleaseAsset[]; coverage: 'latest-published-release-only' }
export interface AdoptionValues { repository: AdoptionRepository; npm: AdoptionNpm; views: AdoptionTraffic; clones: AdoptionTraffic; release: AdoptionRelease }
export type AdoptionSources = { [K in AdoptionSourceId]: AdoptionReading<AdoptionValues[K]> };
export interface AdoptionSnapshot { v: 1; target: typeof ADOPTION_TARGET; sources: AdoptionSources }
export const ADOPTION_SOURCE_IDS: readonly AdoptionSourceId[] = ['repository', 'npm', 'views', 'clones', 'release'];
export const ADOPTION_REASON_TEXT: Record<AdoptionReason, string> = {
  permission: 'This GitHub reading requires permission the current connection does not provide.',
  authentication: 'GitHub authentication is unavailable for this reading.',
  'not-found': 'The source did not report this package or published release.',
  'rate-limited': 'The source is rate limited; its retry deadline is respected.',
  unavailable: 'The source could not be read.',
  'invalid-response': 'The source returned incomplete or invalid metadata.',
  cancelled: 'This refresh was cancelled.',
};
