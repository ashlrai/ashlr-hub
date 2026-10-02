/** Optional historical display cache. It cannot supply current capacity, credits or authentication. */
import { randomInt, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { writePrivateFileAtomicallyAsync } from '../util/private-file-write.js';
import { validResetProvenance } from '../routing/reset-pressure.js';
import { readResourceJson } from './pool-runtime.js';
import { readResourceAccountLocalEpoch, resourceAccountProfileDigest, resourceIdentityInstant, validResourceAccountIdentityWitness,
  type ResourceAccountIdentityWitness, type ResourceAccountLocalEpoch, type ResourceAccountIdentitySnapshot } from './account-identity-witness.js';
import type { ResourceConnectionConfig } from './connection-monitor.js';
import type { ResourceAccountConnection, ResourceConnectionQuotaWindow } from './connection-types.js';
import type { ResourceLastKnownUsage } from './reading-cache-types.js';

export const RESOURCE_READING_CACHE_FILENAME = '.resource-last-known-readings.json';
export const RESOURCE_READING_CACHE_MAX_BYTES = 2 * 1024 * 1024;
type Account = ResourceConnectionConfig['accounts'][number];
interface CachedReading {
  accountId: string; provider: Account['provider']; accountDigest: string; profileDigest: string;
  epochDigest: string | null; displayIdentityDigest?: string; observedAt: string; expiresAt: string; windows: ResourceConnectionQuotaWindow[];
}
export interface ResourceReadingCache {
  captureEpoch(account: Account): ResourceAccountLocalEpoch | null;
  remember(account: Account, row: ResourceAccountConnection, accountHint: string, before: ResourceAccountLocalEpoch | null): void;
  invalidate(account: Account): void;
  lastKnown(account: Account): ResourceLastKnownUsage | null;
  witness(account: Account, nowMs?: number): ResourceAccountIdentityWitness | null;
  /** Pure memory only; worker must recheck local identity metadata before use. */
  identityWitnessesSnapshot(): ResourceAccountIdentitySnapshot[];
  invalidatedIdentityAccountIdsSnapshot(): string[];
  identitySnapshotRevision(): number;
  flush(): Promise<void>;
}
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
}
function exact(v: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(k => Object.hasOwn(v, k)) && Reflect.ownKeys(v).every(k => typeof k === 'string' &&
    [...required, ...optional].includes(k) && 'value' in Object.getOwnPropertyDescriptor(v, k)!);
}
function hash(v: unknown): v is string { return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v); }
function text(v: unknown, bytes: number): v is string { return typeof v === 'string' && Buffer.byteLength(v) <= bytes &&
  [...v].every(c => { const code = c.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); }); }
function dense(v: unknown, max: number): v is unknown[] {
  return Array.isArray(v) && v.length <= max && Reflect.ownKeys(v).length === v.length + 1 &&
    Array.from({ length: v.length }, (_, i) => i).every(i => Object.hasOwn(v, i) && 'value' in Object.getOwnPropertyDescriptor(v, i)!);
}
function windows(value: unknown): ResourceConnectionQuotaWindow[] {
  if (!dense(value, 8)) throw new Error();
  const ids = new Set<string>();
  for (const v of value) {
    if (!record(v) || !exact(v, ['id', 'usedPercent', 'resetsAt'], ['limitReached', 'nativeReport', 'resetProvenance']) ||
      typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.id) || ids.has(v.id) ||
      !(v.usedPercent === null || typeof v.usedPercent === 'number' && Number.isFinite(v.usedPercent) && v.usedPercent >= 0 && v.usedPercent <= 100) ||
      !(v.resetsAt === null || resourceIdentityInstant(v.resetsAt)) ||
      Object.hasOwn(v, 'limitReached') && (v.limitReached !== true || v.usedPercent !== 100)) throw new Error();
    if (Object.hasOwn(v, 'nativeReport') && (!record(v.nativeReport) || !exact(v.nativeReport, ['source', 'resetDescription']) ||
      typeof v.nativeReport.source !== 'string' || !['claude-usage', 'claude-usage-structured'].includes(v.nativeReport.source) ||
      !(v.nativeReport.resetDescription === null || text(v.nativeReport.resetDescription, 512)))) throw new Error();
    if (Object.hasOwn(v, 'resetProvenance') && (!record(v.resetProvenance) ||
      !exact(v.resetProvenance, ['kind', 'at', 'description', 'source'], ['plan', 'startsAt']) || !validResetProvenance(v.resetProvenance) ||
      !(v.resetProvenance.description === null || text(v.resetProvenance.description, 512)) ||
      !(v.resetProvenance.source === null || text(v.resetProvenance.source, 120)))) throw new Error();
    ids.add(v.id);
  }
  return structuredClone(value) as ResourceConnectionQuotaWindow[];
}
/** This digest qualifies historical quota display only. It never replaces the
 * stricter file epoch used by native/financial identity witnesses. */
function claudeDisplayIdentityDigest(profileDigest: string, accountDigest: string): string {
  return digest(canonical(['claude-historical-display-identity-v1', profileDigest, accountDigest]));
}
function displayIdentityMatches(row: CachedReading, current: ResourceAccountLocalEpoch | null): boolean {
  return row.provider === 'claude' && row.displayIdentityDigest !== undefined && current !== null &&
    current.profileDigest === row.profileDigest && current.accountDigest === row.accountDigest &&
    claudeDisplayIdentityDigest(current.profileDigest, current.accountDigest) === row.displayIdentityDigest;
}
function checked(value: unknown): CachedReading[] {
  if (!record(value) || !exact(value, ['schemaVersion', 'scope', 'readings']) || value.schemaVersion !== 1 ||
    value.scope !== 'historical-display-only' || !dense(value.readings, Math.floor(RESOURCE_READING_CACHE_MAX_BYTES / 2))) throw new Error();
  const ids = new Set<string>();
  return value.readings.map(v => {
    if (!record(v) || !exact(v, ['accountId', 'provider', 'accountDigest', 'profileDigest', 'epochDigest', 'observedAt', 'expiresAt', 'windows'], ['displayIdentityDigest']) ||
      typeof v.accountId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.accountId) || ids.has(v.accountId) ||
      typeof v.provider !== 'string' || !['codex', 'claude', 'grok'].includes(v.provider) || !hash(v.accountDigest) || !hash(v.profileDigest) ||
      !(v.epochDigest === null || hash(v.epochDigest)) ||
      Object.hasOwn(v, 'displayIdentityDigest') && (v.provider !== 'claude' || !hash(v.displayIdentityDigest) ||
        v.displayIdentityDigest !== claudeDisplayIdentityDigest(v.profileDigest as string, v.accountDigest as string)) || !resourceIdentityInstant(v.observedAt) || !resourceIdentityInstant(v.expiresAt) ||
      Date.parse(v.observedAt) > Date.now() || Date.parse(v.expiresAt) <= Date.parse(v.observedAt) || Date.parse(v.expiresAt) - Date.parse(v.observedAt) > 60_000) throw new Error();
    ids.add(v.accountId);
    return { ...v, windows: windows(v.windows) } as unknown as CachedReading;
  });
}

/** Public projection refuses additional fields instead of leaking private cache bindings. */
export function normalizeResourceLastKnownUsage(value: unknown): ResourceLastKnownUsage | null {
  try {
    if (!record(value) || !exact(value, ['observedAt', 'expiresAt', 'windows', 'source', 'identitySource']) ||
      !resourceIdentityInstant(value.observedAt) || !resourceIdentityInstant(value.expiresAt) ||
      Date.parse(value.observedAt) > Date.now() || Date.parse(value.expiresAt) <= Date.parse(value.observedAt) ||
      Date.parse(value.expiresAt) - Date.parse(value.observedAt) > 60_000 || value.source !== 'native-account-checked-history' ||
      typeof value.identitySource !== 'string' || !['native-account-checked', 'native-account-checked-local-epoch', 'native-account-checked-display-identity'].includes(value.identitySource)) return null;
    return { observedAt: value.observedAt, expiresAt: value.expiresAt, windows: windows(value.windows),
      source: 'native-account-checked-history', identitySource: value.identitySource as ResourceLastKnownUsage['identitySource'] };
  } catch { return null; }
}

/** Worker-only read projection of persisted historical identity continuity. No
 * collector ownership, publication or native work is acquired by this reader. */
export function readResourceHistoricalIdentityWitnesses(options: { root: string; accountsRoot: string; accounts: readonly Account[];
  readEpoch?: (account: Account) => ResourceAccountLocalEpoch | null; nowMs?: number }): ResourceAccountIdentityWitness[] {
  try {
    const store = createResourceReadingCache({ ...options, assertOwnership: () => { throw new Error('Read-only historical projection'); } });
    return options.accounts.flatMap(a => { const w = store.witness(a, options.nowMs); return w ? [w] : []; });
  } catch { return []; }
}

/** All rows fit a byte-bounded document, never an account tier. Unsafe existing files
 * are left intact. Writes are deferred/coalesced after sample completion, not awaited
 * by native workers. This is a single-owner writer, not a cross-process CAS store. */
export function createResourceReadingCache(options: { root: string; accountsRoot: string; accounts: readonly Account[];
  assertOwnership: () => void; ownershipIdentity?: () => string; readEpoch?: (account: Account) => ResourceAccountLocalEpoch | null; generation?: number }): ResourceReadingCache {
  inspectPrivateDirectory(options.root);
  const file = join(options.root, RESOURCE_READING_CACHE_FILENAME);
  const roster = new Map(options.accounts.map(a => [a.id, structuredClone(a)]));
  const generation = options.generation ?? randomInt(1, 2 ** 48 - 1);
  if (!Number.isSafeInteger(generation) || generation < 1 || roster.size !== options.accounts.length) throw new Error('Invalid historical reading cache configuration');
  const rows = new Map<string, CachedReading>();
  const native = new Map<string, ResourceAccountIdentityWitness>();
  const invalidated = new Set<string>();
  let identityRevision = 0;
  let writable = true;
  try { for (const row of checked(readResourceJson(file, RESOURCE_READING_CACHE_MAX_BYTES))) if (roster.has(row.accountId)) rows.set(row.accountId, row); }
  catch { try { lstatSync(file); writable = false; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') writable = false; } }
  const readEpoch = options.readEpoch ?? ((account: Account) => readResourceAccountLocalEpoch(options.accountsRoot, account));
  const belongs = (a: Account): boolean => {
    const own = roster.get(a.id);
    return own !== undefined && resourceAccountProfileDigest(own) === resourceAccountProfileDigest(a);
  };
  const epoch = (a: Account): ResourceAccountLocalEpoch | null => {
    try {
      if (!belongs(a)) return null;
      const result = readEpoch(a);
      return result && result.profileDigest === resourceAccountProfileDigest(a) && hash(result.epochDigest) &&
        (result.accountDigest === undefined || hash(result.accountDigest)) ? result : null;
    } catch { return null; }
  };
  let pending: Promise<void> | null = null;
  let revision = 0;
  let queuedOwner: string | null = null;
  const checkTarget = (): void => {
    inspectPrivateDirectory(options.root);
    try { checked(readResourceJson(file, RESOURCE_READING_CACHE_MAX_BYTES)); }
    catch { try { lstatSync(file); throw new Error(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  };
  const schedule = (): void => {
    revision++;
    try { queuedOwner = options.ownershipIdentity?.() ?? null; } catch { queuedOwner = null; return; }
    if (pending || !writable) return;
    pending = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      const targetRevision = revision;
      const targetOwner = queuedOwner;
      try {
        options.assertOwnership();
        if (options.ownershipIdentity && (targetOwner === null || options.ownershipIdentity() !== targetOwner)) throw new Error();
        // Don't silently replace a newly unsafe, malformed, or oversized target.
        checkTarget();
        const bytes = canonical({ schemaVersion: 1, scope: 'historical-display-only', readings: [...rows.values()] }) + '\n';
        if (Buffer.byteLength(bytes) > RESOURCE_READING_CACHE_MAX_BYTES) throw new Error();
        options.assertOwnership();
        const captured = [...rows.values()];
        await writePrivateFileAtomicallyAsync(`${file}.${randomUUID()}.tmp`, file, bytes, {
          anchorPath: options.root, label: 'Historical resource readings', beforePublish() {
            options.assertOwnership();
            if (revision !== targetRevision || options.ownershipIdentity && options.ownershipIdentity() !== targetOwner) throw new Error();
            checkTarget();
            for (const row of captured) {
              const a = roster.get(row.accountId)!;
              if (row.epochDigest !== null || row.displayIdentityDigest !== undefined) {
                const current = epoch(a);
                if (row.displayIdentityDigest !== undefined && !displayIdentityMatches(row, current) ||
                  row.displayIdentityDigest === undefined && (!current || current.epochDigest !== row.epochDigest ||
                    current.accountDigest !== undefined && current.accountDigest !== row.accountDigest)) {
                  rows.delete(row.accountId); native.delete(row.accountId); invalidated.add(row.accountId); identityRevision++; revision++; throw new Error();
                }
                if (row.epochDigest !== null && current?.epochDigest !== row.epochDigest) {
                  // Settings may change without changing Claude's checked account.
                  // Keep history but discard strict native proof, then serialize again.
                  row.epochDigest = null; identityRevision++; revision++; throw new Error();
                }
              }
            }
          },
        });
      } catch { /* Optional display evidence: never interfere with current collection or rewrite corrupt files. */ }
      finally { pending = null; if (revision !== targetRevision) schedule(); }
    });
  };
  const witness = (a: Account, nowMs = Date.now()): ResourceAccountIdentityWitness | null => {
    if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > Date.now() || !belongs(a)) return null;
    const row = rows.get(a.id); if (!row || Date.parse(row.observedAt) > nowMs || row.profileDigest !== resourceAccountProfileDigest(a) || row.provider !== a.provider) return null;
    const local = epoch(a);
    if (row.epochDigest !== null && (!local || local.epochDigest !== row.epochDigest ||
      local.accountDigest !== undefined && local.accountDigest !== row.accountDigest)) return null;
    const live = native.get(a.id);
    if (live && validResourceAccountIdentityWitness(live, nowMs)) return structuredClone(live);
    if (row.epochDigest === null || !local) return null;
    // A worker uses its captured projection clock, never a later invented native observation.
    const now = nowMs;
    return { provider: a.provider, accountId: a.id, accountDigest: row.accountDigest, profileDigest: row.profileDigest, generation,
      observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), source: 'native-account-checked-local-epoch' };
  };
  return {
    captureEpoch: epoch,
    remember(a, row, hint, before) {
      try {
        options.assertOwnership();
        if (!belongs(a) || row.id !== a.id || row.provider !== a.provider || row.state !== 'observed' || row.authentication !== 'signed-in' ||
          !hash(hint) || a.expectedAccountHint !== undefined && a.expectedAccountHint !== hint ||
          !resourceIdentityInstant(row.observedAt) || !resourceIdentityInstant(row.expiresAt) || Date.parse(row.observedAt) > Date.now() ||
          Date.parse(row.expiresAt) <= Date.now() || Date.parse(row.expiresAt) - Date.parse(row.observedAt) > 60_000) return;
        const after = epoch(a);
        const stable = before && after && canonical(before) === canonical(after) &&
          (after.accountDigest === undefined || after.accountDigest === hint) ? after.epochDigest : null;
        const previous = rows.get(a.id);
        const preserve = row.windows.length === 0 && previous?.accountDigest === hint && previous.profileDigest === resourceAccountProfileDigest(a);
        const record: CachedReading = { accountId: a.id, provider: a.provider, accountDigest: hint, profileDigest: resourceAccountProfileDigest(a),
          epochDigest: stable, observedAt: row.observedAt, expiresAt: row.expiresAt, windows: windows(row.windows),
          ...(a.provider === 'claude' && before?.profileDigest === resourceAccountProfileDigest(a) &&
            before.accountDigest === hint && after?.accountDigest === hint ? {
              displayIdentityDigest: claudeDisplayIdentityDigest(resourceAccountProfileDigest(a), hint),
            } : {}) };
        if (preserve) { record.observedAt = previous.observedAt; record.expiresAt = previous.expiresAt; record.windows = previous.windows; }
        rows.set(a.id, record);
        native.set(a.id, { provider: a.provider, accountId: a.id, accountDigest: hint, profileDigest: record.profileDigest, generation,
          observedAt: row.observedAt, expiresAt: row.expiresAt, source: 'native-account-checked' });
        invalidated.delete(a.id); identityRevision++;
        schedule();
      } catch { /* A malformed result or lost ownership cannot create historical evidence. */ }
    },
    invalidate(a) {
      if (!belongs(a)) return;
      native.delete(a.id); invalidated.add(a.id); identityRevision++; if (rows.delete(a.id)) schedule();
    },
    witness,
    identityWitnessesSnapshot() {
      const result: ResourceAccountIdentitySnapshot[] = [];
      for (const [id, w] of native) {
        if (!validResourceAccountIdentityWitness(w)) continue;
        const row = rows.get(id);
        if (!row || row.accountDigest !== w.accountDigest || row.profileDigest !== w.profileDigest) continue;
        result.push({ witness: structuredClone(w), localEpoch: row.epochDigest === null ? null : {
          profileDigest: row.profileDigest, epochDigest: row.epochDigest,
          ...(w.provider === 'claude' ? { accountDigest: row.accountDigest } : {}),
        } });
      }
      return result;
    },
    invalidatedIdentityAccountIdsSnapshot: () => [...invalidated],
    identitySnapshotRevision: () => identityRevision,
    lastKnown(a) {
      const current = witness(a); const row = rows.get(a.id);
      if (!row || Date.parse(row.observedAt) > Date.now() || !belongs(a) ||
        row.profileDigest !== resourceAccountProfileDigest(a)) return null;
      // Never expose this fallback through witness() or financial snapshots.
      if (!current && !displayIdentityMatches(row, epoch(a))) return null;
      return { observedAt: row.observedAt, expiresAt: row.expiresAt, windows: structuredClone(row.windows),
        source: 'native-account-checked-history', identitySource: current?.source ?? 'native-account-checked-display-identity' };
    },
    async flush() { while (pending) await pending; },
  };
}
