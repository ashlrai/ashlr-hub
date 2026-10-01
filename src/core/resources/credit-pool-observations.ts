import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomic } from '../verse/preferences.js';
import { sameResourceAccountIdentity, validResourceAccountIdentityWitness, type ResourceAccountIdentityWitness } from './account-identity-witness.js';
import type { CreditPoolObservation, CreditPoolReadView, CreditPoolRowView } from './credit-pool-types.js';

export const CREDIT_POOL_FILE = 'credit-pools.json';
export const CREDIT_POOL_MAX_BYTES = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function iso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}
function decimal(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && value.length <= 64 &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
}
function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length > CREDIT_POOL_MAX_BYTES / 2) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys.every(key => key === 'length' || typeof key === 'string' &&
    /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < value.length && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function greater(a: string, b: string): boolean {
  const parts = [a.split('.'), b.split('.')];
  const scale = Math.max(parts[0]![1]?.length ?? 0, parts[1]![1]?.length ?? 0);
  const ints = parts.map(row => BigInt(row[0]! + (row[1] ?? '').padEnd(scale, '0')));
  return ints[0]! > ints[1]!;
}
function copyWitness(value: ResourceAccountIdentityWitness): ResourceAccountIdentityWitness {
  return { provider: value.provider, accountId: value.accountId, accountDigest: value.accountDigest, profileDigest: value.profileDigest,
    generation: value.generation, observedAt: value.observedAt, expiresAt: value.expiresAt, source: value.source };
}
function witness(value: unknown): value is ResourceAccountIdentityWitness {
  // Validate historical capture evidence at its original time, not as a new login.
  return object(value) && exact(value, ['provider', 'accountId', 'accountDigest', 'profileDigest', 'generation', 'observedAt', 'expiresAt', 'source']) &&
    iso(value.observedAt) && validResourceAccountIdentityWitness(value, Date.parse(value.observedAt));
}
const same = sameResourceAccountIdentity;
function fresh(value: ResourceAccountIdentityWitness, nowMs: number): boolean {
  return object(value) && validResourceAccountIdentityWitness(value, nowMs);
}

/** Strict whole-record validation; no getters, defaults, guessed composition or date normalization. */
export function parseCreditPoolObservation(value: unknown, nowMs: number): CreditPoolObservation | null {
  try {
    if (!Number.isFinite(nowMs) || !object(value) || !exact(value, ['v', 'poolId', 'kind', 'accountId', 'provider', 'amount', 'total',
      'unit', 'surface', 'capturedAt', 'expiresAt', 'expiryKind', 'source', 'capture']) || value.v !== 1 ||
      typeof value.poolId !== 'string' || !ID.test(value.poolId) || typeof value.accountId !== 'string' || !ID.test(value.accountId) ||
      !decimal(value.amount) || !decimal(value.total) || !iso(value.capturedAt) || Date.parse(value.capturedAt) > nowMs ||
      !(value.expiresAt === null || iso(value.expiresAt)) ||
      !(typeof value.expiryKind === 'string' && ['fixed', 'rolling-release', 'unknown'].includes(value.expiryKind)) ||
      (value.expiryKind === 'unknown') !== (value.expiresAt === null) ||
      value.expiresAt !== null && Date.parse(value.expiresAt as string) <= Date.parse(value.capturedAt) ||
      !object(value.source) || !exact(value.source, ['kind', 'adapter']) ||
      !object(value.capture) || !exact(value.capture, ['before', 'after']) || !witness(value.capture.before) || !witness(value.capture.after)) return null;
    const before = value.capture.before; const after = value.capture.after; const captureMs = Date.parse(value.capturedAt);
    if (before.source !== 'native-account-checked' || after.source !== 'native-account-checked' || !same(before, after) ||
      before.generation !== after.generation || before.provider !== value.provider || before.accountId !== value.accountId ||
      Date.parse(before.observedAt) > captureMs || captureMs > Date.parse(after.observedAt) ||
      Date.parse(after.observedAt) >= Date.parse(before.expiresAt) || Date.parse(after.observedAt) > nowMs) return null;
    if (value.kind === 'gifted-cloud' || value.kind === 'purchased-usage') {
      if (value.provider !== 'claude' || value.unit !== 'USD' || value.source.kind !== 'verified-manual' || value.source.adapter !== 'claude-account-ui' ||
        value.surface !== (value.kind === 'gifted-cloud' ? 'cloud-session' : 'over-plan-usage') || value.expiryKind === 'rolling-release') return null;
    } else if (value.kind === 'subscription-allowance') {
      const adapter = value.provider === 'claude' ? 'claude-usage' : value.provider === 'codex' ? 'codex-rate-limits' : value.provider === 'grok' ? 'grok-usage' : null;
      if (value.unit !== 'percent' || value.surface !== 'subscription' || value.source.kind !== 'native-metadata' || value.source.adapter !== adapter ||
        value.total !== null || value.amount !== null && greater(value.amount as string, '100')) return null;
    } else return null;
    if (value.amount !== null && value.total !== null && greater(value.amount as string, value.total as string)) return null;
    return { v: 1, poolId: value.poolId, kind: value.kind, accountId: value.accountId, provider: before.provider,
      amount: value.amount, total: value.total, unit: value.unit, surface: value.surface, capturedAt: value.capturedAt,
      expiresAt: value.expiresAt, expiryKind: value.expiryKind, source: { kind: value.source.kind, adapter: value.source.adapter },
      capture: { before: copyWitness(before), after: copyWitness(after) } } as CreditPoolObservation;
  } catch { return null; }
}
function key(value: CreditPoolObservation): string { return `${value.provider}:${value.accountId}:${value.poolId}`; }

function load(root: string, nowMs: number): { state: CreditPoolReadView['sourceState']; observations: CreditPoolObservation[] } {
  try {
    inspectPrivateDirectory(root);
    const path = join(root, CREDIT_POOL_FILE);
    if (!existsSync(path)) { try { lstatSync(path); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', observations: [] }; } }
    const stat = lstatSync(path);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) return { state: 'unavailable', observations: [] };
    const read = readStableRegularFile(path, { anchorPath: root, maxFileBytes: CREDIT_POOL_MAX_BYTES, remainingBytes: CREDIT_POOL_MAX_BYTES });
    if (!read.ok) return { state: 'unavailable', observations: [] };
    const raw: unknown = JSON.parse(read.text);
    if (!object(raw) || !exact(raw, ['v', 'observations']) || raw.v !== 1 || !dense(raw.observations)) return { state: 'unavailable', observations: [] };
    const observations: CreditPoolObservation[] = []; const keys = new Set<string>();
    for (const item of raw.observations) {
      const row = parseCreditPoolObservation(item, nowMs);
      if (!row || keys.has(key(row))) return { state: 'unavailable', observations: [] };
      keys.add(key(row)); observations.push(row);
    }
    return { state: 'healthy', observations };
  } catch { return { state: 'unavailable', observations: [] }; }
}

/** No directories, providers, profiles, credentials, schedulers or history scans are touched. */
export function readCreditPoolObservations(options: {
  root: string; currentWitnesses: readonly ResourceAccountIdentityWitness[]; nowMs: number;
}): CreditPoolReadView {
  const loaded = load(options.root, options.nowMs);
  return projectCreditPoolObservations(loaded.observations, options.currentWitnesses, options.nowMs, loaded.state);
}
export function projectCreditPoolObservations(observations: readonly CreditPoolObservation[], current: readonly ResourceAccountIdentityWitness[],
  nowMs: number, sourceState: CreditPoolReadView['sourceState'] = 'healthy'): CreditPoolReadView {
  try {
    if (!Number.isFinite(nowMs) || !dense(observations) || !dense(current)) return { v: 1, sourceState: 'unavailable', rows: [] };
    const rows: CreditPoolRowView[] = []; const seen = new Set<string>();
    const identities = new Map<string, ResourceAccountIdentityWitness | null>();
    for (const value of current) {
      if (!witness(value)) continue;
      const id = `${value.provider}:${value.accountId}`;
      identities.set(id, identities.has(id) ? null : value);
    }
    for (const raw of observations) {
      const row = parseCreditPoolObservation(raw, nowMs);
      if (!row || seen.has(key(row))) return { v: 1, sourceState: 'unavailable', rows: [] };
      seen.add(key(row));
      const candidate = identities.get(`${row.provider}:${row.accountId}`);
      const active = candidate && fresh(candidate, nowMs) ? candidate : null;
      const identityState = !active ? 'unknown' : same(active, row.capture.after) ? 'matched' : 'mismatch';
      const visible = identityState === 'matched';
      rows.push({ poolId: row.poolId, accountId: row.accountId, provider: row.provider, kind: row.kind,
        amount: visible ? row.amount : null, total: visible ? row.total : null, unit: row.unit, surface: row.surface,
        capturedAt: row.capturedAt, expiresAt: row.expiresAt, expiryKind: row.expiryKind, source: { ...row.source }, identityState,
        evidenceState: !visible ? identityState === 'mismatch' ? 'identity-mismatch' : 'identity-unknown'
          : row.source.kind === 'verified-manual' ? 'recorded' : active?.source === 'native-account-checked' && fresh(row.capture.after, nowMs) &&
            (row.expiresAt === null || Date.parse(row.expiresAt) > nowMs) ? 'current-native' : 'stale-native',
        expiryState: row.expiresAt === null ? 'unknown' : Date.parse(row.expiresAt) <= nowMs ? 'expired' : 'upcoming' });
    }
    return { v: 1, sourceState, rows };
  } catch { return { v: 1, sourceState: 'unavailable', rows: [] }; }
}

/** Internal capture primitive only: no ingestion route/CLI exists. Requires a live caller-owned identity fence. */
export function writeCreditPoolObservation(value: unknown, options: {
  root: string; nowMs: number; readCurrentWitness: () => ResourceAccountIdentityWitness | null;
}): void {
  const row = parseCreditPoolObservation(value, options.nowMs);
  if (!row) throw new Error('Credit observation invalid');
  inspectPrivateDirectory(options.root);
  const original = options.readCurrentWitness();
  if (!original || original.source !== 'native-account-checked' || !fresh(original, options.nowMs) || !same(original, row.capture.after) || original.generation !== row.capture.after.generation) throw new Error('Credit observation identity unavailable');
  const lock = acquireLocalStoreLock(join(options.root, '.credit-pools.lock'), 0, { anchorPath: options.root, exactPrivateStorage: true });
  if (!lock) throw new Error('Credit observation store busy');
  try {
    const existing = load(options.root, options.nowMs);
    if (existing.state === 'unavailable') throw new Error('Credit observation store unavailable');
    const previous = existing.observations.find(item => key(item) === key(row));
    if (previous && (Date.parse(previous.capturedAt) > Date.parse(row.capturedAt) ||
      previous.capturedAt === row.capturedAt && JSON.stringify(previous) !== JSON.stringify(row))) throw new Error('Credit observation replay conflict');
    const observations = existing.observations.filter(item => key(item) !== key(row)); observations.push(row);
    const text = JSON.stringify({ v: 1, observations }) + '\n';
    if (Buffer.byteLength(text) > CREDIT_POOL_MAX_BYTES) throw new Error('Credit observation byte limit');
    const latest = options.readCurrentWitness();
    if (!latest || latest.source !== 'native-account-checked' || !fresh(latest, options.nowMs) || !same(original, latest) || latest.generation !== original.generation ||
      !ownsLocalStoreLock(lock)) throw new Error('Credit observation identity changed');
    inspectPrivateDirectory(options.root);
    writePrivateFileAtomic(join(options.root, CREDIT_POOL_FILE), text);
  } finally { releaseLocalStoreLock(lock); }
}
