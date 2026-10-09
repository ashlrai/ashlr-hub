import type { QueryEntry } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import type { OptionalRead } from '../usage/usage-queries.js';

const UNAVAILABLE = 'Usage collection status is unavailable.';

/** Only source-defined reasons become copy; raw diagnostics may contain private data. */
function reasonNotice(reason: string | null): string | null {
  switch (reason) {
    case 'collector-unavailable':
      return 'Usage collection is unavailable. Readings may be historical.';
    case 'collector-start-failed':
      return 'Usage collection could not start. Readings may be historical.';
    case 'collector-not-running':
      return 'Usage collection is not running in this app. Readings may be historical.';
    case 'accounts-pool-unavailable':
      return 'Account collection setup is unavailable. Readings may be historical.';
    case 'accounts-collection-not-configured':
      return 'Usage collection is not configured for these accounts. Readings may be historical.';
    case 'reconciliation-required':
      return 'Earlier usage collection needs review before it can restart. Readings may be historical.';
    case 'cleanup-unconfirmed':
      return 'Previous usage collection could not be confirmed stopped. Readings may be historical.';
    case 'cancelled':
      return 'Usage collection was cancelled. Readings may be historical.';
    default:
      return null;
  }
}

/** Collection ownership is separate from account sign-in, quota and Fleet authority. */
export function collectionNotice(read: QueryEntry<OptionalRead>): string | null {
  if (read.error !== undefined || read.status === 'error') {
    return read.error instanceof ApiError && read.error.status === 401
      ? 'Usage collection status is unavailable · sign in again.' : UNAVAILABLE;
  }
  if (read.status === 'idle' || read.status === 'loading') return null;
  const raw = read.data?.available ? read.data.raw : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return UNAVAILABLE;
  const collector = (raw as Record<string, unknown>).collector;
  if (!collector || typeof collector !== 'object' || Array.isArray(collector)) return UNAVAILABLE;
  const { mode, state, owner, reasonCode } = collector as Record<string, unknown>;
  if (typeof mode !== 'string' || !['owned', 'read-only', 'unconfigured'].includes(mode) ||
    typeof state !== 'string' || !['running', 'suspended', 'blocked', 'stopped'].includes(state) ||
    typeof owner !== 'string' || !['this-server', 'another-collector', 'none'].includes(owner) ||
    !(reasonCode === null || typeof reasonCode === 'string') ||
    (mode === 'owned' && owner !== 'this-server') ||
    (mode === 'unconfigured' && owner !== 'none') ||
    (mode === 'read-only' && owner === 'this-server')) return UNAVAILABLE;

  let text: string | null;
  if (mode === 'read-only' && owner === 'another-collector') {
    text = 'Another Phantom process owns usage collection; this view depends on its shared readings.';
  } else if (mode === 'read-only' && state === 'suspended' && owner === 'none' && reasonCode === 'connection-polling-paused') {
    text = 'Usage collection is paused while idle.';
  } else if (state === 'blocked' || mode === 'read-only' || mode === 'owned' && reasonCode !== null) {
    text = reasonNotice(reasonCode) ?? 'Usage collection is held. Readings may be historical; Chat sign-in and Fleet permission are separate.';
  } else if (mode === 'unconfigured' || state === 'stopped') {
    text = reasonNotice(reasonCode) ?? 'Native usage collection is unavailable. Last readings may still be shown.';
  } else if (state === 'suspended') {
    text = 'Usage collection is paused while idle.';
  } else {
    // Running collection does not establish that any provider returned quota.
    text = null;
  }
  if (read.status === 'refreshing') return text
    ? `Last collection status · ${text} Checking again…` : 'Checking usage collection status…';
  return text;
}
