/** Native metadata tools share the UI store and its stale-write checks. */
import { getProactiveProfilesStore, ProactiveProfileError } from './profiles.js';
import { PROACTIVE_PROVIDERS, type ProactiveProfile } from './types.js';
import { scrubSecrets } from '../knowledge/index.js';

function args(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ProactiveProfileError('INVALID_INPUT', 'Unexpected proactive profile tool argument.');
}
function summary(profile: ProactiveProfile) {
  return {
    id: profile.id, version: profile.version, identity: profile.identity, displayName: profile.displayName,
    avatar: profile.avatar, responsibility: profile.responsibility.slice(0, 240),
    serviceCount: profile.services.length, computer: profile.computer, fundingReference: profile.fundingReference,
    enabled: profile.enabled, connection: profile.connection, operations: profile.operations, lastRun: profile.lastRun,
  };
}
export async function listProactiveProfiles(value: Record<string, unknown>): Promise<unknown> {
  args(value, ['accountId', 'provider', 'offset', 'limit']);
  if (value['accountId'] !== undefined && (typeof value['accountId'] !== 'string' || value['accountId'].length > 256)) throw new ProactiveProfileError('INVALID_INPUT', 'Invalid account filter.');
  if (value['provider'] !== undefined && !PROACTIVE_PROVIDERS.includes(value['provider'] as typeof PROACTIVE_PROVIDERS[number])) throw new ProactiveProfileError('INVALID_INPUT', 'Invalid provider filter.');
  const offset = value['offset'] ?? 0, limit = value['limit'] ?? 10;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new ProactiveProfileError('INVALID_INPUT', 'Use a nonnegative offset and a limit from 1 to 50.');
  const all = (await getProactiveProfilesStore().list()).profiles.filter(profile =>
    (value['accountId'] === undefined || profile.identity.accountId === value['accountId']) &&
    (value['provider'] === undefined || profile.identity.provider === value['provider']));
  const profiles = all.slice(Number(offset), Number(offset) + Number(limit)).map(summary);
  const page = () => {
    const nextOffset = Number(offset) + profiles.length;
    return { schemaVersion: 1, profiles, total: all.length, nextOffset: nextOffset < all.length ? nextOffset : null };
  };
  // Match native serialization exactly: scrub the full pretty-JSON envelope before measuring UTF-8 bytes.
  // Individual summaries fit this existing transport allowance; shrinking the page preserves honest continuation.
  const bytes = () => Buffer.byteLength(scrubSecrets(JSON.stringify(page(), null, 2)), 'utf8');
  while (profiles.length > 1 && bytes() > 32 * 1024) profiles.pop();
  if (bytes() > 32 * 1024) throw new ProactiveProfileError('UNAVAILABLE', 'A proactive profile summary cannot fit the native reply.');
  return page();
}
export async function createProactiveProfile(value: Record<string, unknown>): Promise<unknown> {
  args(value, ['profile']); return { profile: summary(await getProactiveProfilesStore().create(value['profile'])) };
}
export async function updateProactiveProfile(value: Record<string, unknown>): Promise<unknown> {
  args(value, ['id', 'patch']);
  if (typeof value['id'] !== 'string') throw new ProactiveProfileError('INVALID_INPUT', 'Profile ID is required.');
  return { profile: summary(await getProactiveProfilesStore().update(value['id'], value['patch'])) };
}
export async function deleteProactiveProfile(value: Record<string, unknown>): Promise<unknown> {
  args(value, ['id', 'expectedVersion']);
  if (typeof value['id'] !== 'string') throw new ProactiveProfileError('INVALID_INPUT', 'Profile ID is required.');
  await getProactiveProfilesStore().remove(value['id'], value['expectedVersion'] as number); return { ok: true };
}
