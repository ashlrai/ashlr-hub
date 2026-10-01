/** Lazy, read-only display of account-bound credit evidence. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getVerseAccountCollector, verseCollectorLive } from './accounts.js';
import { resolveAccountsRoot } from './seats.js';
import { normalizeCreditIdentitySnapshots, normalizeInvalidatedAccountIds } from '../resources/credit-pool-snapshot.js';
import type { ReadProjectionReader } from '../web/read-projections.js';
import { validResourceAccountIdentityWitness, type ResourceAccountIdentitySnapshot } from '../resources/account-identity-witness.js';
import { sendJson } from '../web/api.js';
import type { VerseApiContext } from './verse-api.js';
import { CREDIT_POOLS_PATH, type CreditPoolsRead } from './credit-pools-api-types.js';

const REFRESH_MS = 30_000;
interface Entry { key: string; value: CreditPoolsRead; at: number; pending: Promise<void> | null; failed: boolean }
let cache = new WeakMap<ReadProjectionReader, Entry>();
export function _resetCreditPoolsCacheForTest(): void { cache = new WeakMap(); }

/** Pure in-memory collector access only: no touch, IO, acquisition or native probe. */
interface IdentityInput { identitySnapshots: ResourceAccountIdentitySnapshot[]; invalidatedAccountIds: string[]; revision: number | null }
function snapshots(ctx: VerseApiContext): IdentityInput {
  const collector = getVerseAccountCollector();
  if (!collector || collector.accountsRoot !== resolveAccountsRoot(ctx.cfg)) return { identitySnapshots: [], invalidatedAccountIds: [], revision: null };
  const revision = collector.identitySnapshotRevision?.() ?? null;
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error('Invalid identity revision');
  return { identitySnapshots: verseCollectorLive(collector) ? normalizeCreditIdentitySnapshots(collector.identityWitnessesSnapshot?.() ?? []).filter(s => validResourceAccountIdentityWitness(s.witness)) : [],
    invalidatedAccountIds: normalizeInvalidatedAccountIds(collector.invalidatedIdentityAccountIdsSnapshot?.() ?? []), revision };
}
function refresh(reader: ReadProjectionReader, entry: Entry, input: IdentityInput, ctx: VerseApiContext): void {
  if (entry.pending) return;
  const key = entry.key;
  entry.pending = Promise.resolve().then(() => reader.read('credit-pools', { identitySnapshots: input.identitySnapshots, invalidatedAccountIds: input.invalidatedAccountIds })).then(pools => {
    if (entry.key !== key) return;
    const latestKey = JSON.stringify([resolveAccountsRoot(ctx.cfg), snapshots(ctx)]);
    if (latestKey !== key) {
      entry.key = latestKey; entry.value = { v: 1, state: 'warming', refreshedAt: null, pools: null }; entry.at = 0; entry.failed = false; return;
    }
    entry.value = { v: 1, state: 'current', refreshedAt: new Date().toISOString(), pools };
    entry.at = Date.now(); entry.failed = false;
  }, () => { if (entry.key === key) { entry.at = Date.now(); entry.failed = true; } }).catch(() => { entry.at = Date.now(); entry.failed = true; entry.value = { v: 1, state: 'unavailable', refreshedAt: null, pools: null }; }).finally(() => { entry.pending = null; });
}
/** The server read-session gate authenticates before this handler. */
export async function handleCreditPoolsApi(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (path !== CREDIT_POOLS_PATH) return false;
  if (method !== 'GET') { sendJson(res, 404, { error: 'Credit pools are read only.' }); return true; }
  try {
    const url = new URL(req.url ?? path, 'http://localhost');
    if (url.search) { sendJson(res, 400, { error: 'Credit pools do not accept query parameters.' }); return true; }
  } catch { sendJson(res, 400, { error: 'Invalid query string.' }); return true; }
  const reader = ctx.readProjections;
  if (!reader) { sendJson(res, 200, { v: 1, state: 'unavailable', refreshedAt: null, pools: null } satisfies CreditPoolsRead); return true; }
  let input: IdentityInput;
  try { input = snapshots(ctx); }
  catch { sendJson(res, 200, { v: 1, state: 'unavailable', refreshedAt: null, pools: null } satisfies CreditPoolsRead); return true; }
  // A changed/expired native identity invalidates the old amounts immediately,
  // including while an older worker read is still pending. The key never leaves this module.
  const key = JSON.stringify([resolveAccountsRoot(ctx.cfg), input]);
  let entry = cache.get(reader);
  if (!entry) {
    entry = { key, value: { v: 1, state: 'warming', refreshedAt: null, pools: null }, at: 0, pending: null, failed: false };
    cache.set(reader, entry);
  } else if (entry.key !== key) {
    entry.key = key; entry.value = { v: 1, state: 'warming', refreshedAt: null, pools: null };
    entry.at = 0; entry.failed = false;
  }
  const age = Date.now() - entry.at;
  const stale = age < 0 || age >= REFRESH_MS;
  if (!entry.at || stale) refresh(reader, entry, input, ctx);
  const state = entry.value.pools === null ? entry.failed ? 'unavailable' : 'warming' : stale || entry.failed ? 'stale' : 'current';
  sendJson(res, 200, { ...entry.value, state } satisfies CreditPoolsRead); return true;
}
