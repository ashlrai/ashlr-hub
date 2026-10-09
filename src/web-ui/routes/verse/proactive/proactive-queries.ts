import type { ProactiveProfile, ProactiveProfileInput, ProactiveProfilePatch, ProactiveProfilesResponse } from '../../../../core/proactive/types.js';
import { PROACTIVE_PROVIDERS, VERSE_PROACTIVE_AGENTS_PATH } from '../../../../core/proactive/types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const PROACTIVE_KEY = 'verse-proactive-agents';
function validProfile(value: unknown): value is ProactiveProfile {
  if (!value || typeof value !== 'object') return false;
  const row = value as ProactiveProfile;
  return typeof row.id === 'string' && !!row.id && Number.isSafeInteger(row.version) && row.version > 0 && !!row.identity
    && PROACTIVE_PROVIDERS.includes(row.identity.provider) && typeof row.identity.accountId === 'string' && !!row.identity.accountId
    && typeof row.identity.agentId === 'string' && !!row.identity.agentId && typeof row.displayName === 'string'
    && typeof row.responsibility === 'string' && !!row.avatar && /^#[a-fA-F0-9]{6}$/.test(row.avatar.color)
    && ['classic', 'round', 'pixel'].includes(row.avatar.variant) && !!row.computer
    && ['hosted', 'connected-local', 'unknown'].includes(row.computer.kind) && typeof row.computer.label === 'string'
    && (row.computer.providerComputerId === null || typeof row.computer.providerComputerId === 'string')
    && Array.isArray(row.services) && row.services.every(service => !!service && typeof service.id === 'string' && typeof service.label === 'string')
    && (row.fundingReference === null || !!row.fundingReference && ['subscription', 'promotional-api', 'unknown'].includes(row.fundingReference.kind)
      && row.fundingReference.accountId === row.identity.accountId && (row.fundingReference.poolId === null || typeof row.fundingReference.poolId === 'string'))
    && typeof row.enabled === 'boolean' && row.connection === 'configured' && row.lastRun === null
    && typeof row.createdAt === 'string' && typeof row.updatedAt === 'string' && !!row.operations
    && ['dispatch', 'status', 'cancel', 'result'].every(key => {
      const operation = row.operations[key as keyof typeof row.operations];
      return !!operation && ['unverified', 'unsupported'].includes(operation.state) && operation.verifiedAt === null && typeof operation.note === 'string';
    });
}
export const proactiveProfilesQuery: QueryDef<ProactiveProfilesResponse> = {
  key: PROACTIVE_KEY,
  async fetch(signal) {
    const result = await apiGet<ProactiveProfilesResponse>(VERSE_PROACTIVE_AGENTS_PATH, signal);
    if (!result || result.schemaVersion !== 1 || !Array.isArray(result.profiles) || !result.profiles.every(validProfile)
      || new Set(result.profiles.map(profile => profile.id)).size !== result.profiles.length) throw new Error('Agent profile records are incompatible. Update Phantom and refresh.');
    return result;
  },
};
async function write<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  invalidate(PROACTIVE_KEY);
  return result;
}
export async function createProactiveProfile(input: ProactiveProfileInput): Promise<ProactiveProfile> {
  const result = await write<{ profile: ProactiveProfile }>(VERSE_PROACTIVE_AGENTS_PATH, input);
  if (!validProfile(result?.profile) || result.profile.identity.provider !== input.identity.provider
    || result.profile.identity.accountId !== input.identity.accountId || result.profile.identity.agentId !== input.identity.agentId) {
    throw new Error('The new profile could not be confirmed. Refresh profiles before trying again.');
  }
  return result.profile;
}
export async function editProactiveProfile(id: string, patch: ProactiveProfilePatch): Promise<ProactiveProfile> {
  const result = await write<{ profile: ProactiveProfile }>(`${VERSE_PROACTIVE_AGENTS_PATH}/${encodeURIComponent(id)}`, patch);
  if (!validProfile(result?.profile) || result.profile.id !== id || result.profile.version !== patch.expectedVersion + 1) {
    throw new Error('The profile change could not be confirmed. Refresh before trying again.');
  }
  return result.profile;
}
export async function deleteProactiveProfile(id: string, expectedVersion: number): Promise<{ ok: true }> {
  const result = await write<{ ok: true }>(`${VERSE_PROACTIVE_AGENTS_PATH}/${encodeURIComponent(id)}/delete`, { expectedVersion });
  if (result?.ok !== true) throw new Error('Profile deletion could not be confirmed. Refresh before trying again.');
  return result;
}
