/**
 * quota.ts — M46: per-backend rolling-window rate/quota ledger.
 *
 * Subscription frontier backends (Claude / Codex) are flat-fee but RATE-LIMITED
 * (not token-billed), so the fleet must throttle dispatches per backend. This
 * ledger records each dispatch and answers "how many in the last window?" and
 * "are we still under the configured cap?".
 *
 * Observation compatibility remains deliberately tolerant: load returns a fresh
 * empty ledger on missing/corrupt state and recordUse remains best-effort. The
 * authority-bearing reservation API is stricter:
 *  - One local-store lock serializes read/check/append publication.
 *  - Configured limits fail closed on ambiguous or unavailable persistence.
 *  - Reservation identities are hashed and idempotent across retries.
 *  - The replacement file and containing directory are fsynced before success.
 *  - mkdir -p the parent dir.
 *  - Bounded authority history (last 2000 events per known backend, max 30d).
 *  - Homedir re-resolved at call time so tests can relocate HOME.
 *
 * No new runtime deps; node builtins only. evalQuota mirrors evalBudget's
 * three-level (ok/warn/over) semantics with a null-cap-disabled path.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, EngineId } from '../types.js';
import {
  acquireLocalStoreLockWithOutcome,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from './local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of dispatch events retained in quota.json. */
const MAX_EVENTS = 2000;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_AUTHORITY_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_DISPATCH_ID_BYTES = 4_096;
const MAX_BATCH_RESERVATIONS = 64;
const RESERVATION_DOMAIN = 'ashlr:fleet-quota-reservation:v1';
const SHA256_RE = /^[a-f0-9]{64}$/;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes',
  'kimi', 'nim', 'opencode', 'grok',
]);
const MAX_AUTHORITY_EVENTS = MAX_EVENTS * ENGINE_IDS.size;

/** A single recorded backend dispatch. */
export interface FleetQuotaEvent {
  /** Backend that was dispatched. */
  backend: EngineId;
  /** ISO timestamp of the dispatch. */
  ts: string;
  /** Opaque idempotency identity for an authority-bearing reservation. */
  reservationIdHash?: string;
}

/** The persisted fleet quota ledger. */
export interface FleetQuota {
  /** Bounded list of recent dispatch events (oldest first). */
  events: FleetQuotaEvent[];
}

export interface FleetQuotaReservationRequest {
  backend: EngineId;
  dispatchId: string;
}

export interface FleetQuotaReservationReceipt {
  backend: EngineId;
  status: 'unlimited' | 'reserved';
  used: number;
  limit: number | null;
}

export type FleetQuotaReservationResult =
  | {
      kind: 'unlimited' | 'reserved';
      launchAuthorized: true;
      reservations: FleetQuotaReservationReceipt[];
    }
  | {
      kind: 'invalid' | 'duplicate' | 'conflict' | 'exhausted' | 'unavailable' | 'capacity';
      launchAuthorized: false;
      backend?: EngineId;
      used?: number;
      limit?: number;
      /** True means the durable reservation exists, but this call must not launch. */
      reservationConsumed?: boolean;
    };

export interface FleetQuotaReservationOptions {
  /** Bounded local lock wait. Defaults to 250ms. */
  lockWaitMs?: number;
}

export type FleetQuotaAuthorityHealth =
  | 'unlimited'
  | 'healthy'
  | 'invalid'
  | 'unavailable'
  | 'capacity';

interface QuotaDirectoryAuthority {
  path: string;
  dev: bigint;
  ino: bigint;
}

type BoundQuotaFile =
  | { found: false }
  | {
      found: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
      bytes: Buffer;
    };

interface LoadedStrictQuota {
  ledger: FleetQuota;
  destination: BoundQuotaFile;
}

interface FleetQuotaTestHooks {
  now?: () => number;
  releaseLock?: (lock: LocalStoreLock) => boolean;
}

let fleetQuotaTestHooks: FleetQuotaTestHooks | undefined;

/** Test-only fault injection; production callers must never configure this. */
export function setFleetQuotaTestHooksForTests(hooks?: FleetQuotaTestHooks): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('fleet quota test hooks are test-only');
  fleetQuotaTestHooks = hooks;
}

// ---------------------------------------------------------------------------
// windowToMs — EXTENDS rollup's vocabulary with sub-day windows (local copy)
// ---------------------------------------------------------------------------

/**
 * Convert a window label to milliseconds. Extends rollup.ts's day-granularity
 * vocabulary with sub-day windows used by rate limits. Unknown labels fall back
 * to 1h (the most conservative useful default for rate caps).
 */
export function windowToMs(window: string): number {
  switch (window) {
    case '1m':  return 60_000;
    case '5m':  return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h':  return 3_600_000;
    case '5h':  return 5 * 3_600_000;
    case '1d':  return 86_400_000;
    case '7d':  return 7 * 86_400_000;
    case '30d': return 30 * 86_400_000;
    default:    return 3_600_000;
  }
}

function reservationWindowMs(window: string): number | null {
  switch (window) {
    case '1m': return 60_000;
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h': return 3_600_000;
    case '5h': return 5 * 3_600_000;
    case '1d': return 86_400_000;
    case '7d': return 7 * 86_400_000;
    case '30d': return 30 * 86_400_000;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function fleetDir(): string {
  return join(homedir(), '.ashlr', 'fleet');
}

/** Absolute path to the fleet quota ledger file. */
export function fleetQuotaPath(): string {
  return join(fleetDir(), 'quota.json');
}

/**
 * Private authority ledger. It is deliberately separate from quota.json:
 * quota.json remains backwards-compatible, best-effort operator telemetry,
 * while this file is the fail-closed idempotency/capacity boundary.
 */
export function fleetQuotaReservationPath(): string {
  return join(fleetDir(), 'quota-reservations.json');
}

/** Lock path used by the authority-bearing quota reservation transaction. */
export function fleetQuotaReservationLockPath(): string {
  return join(fleetDir(), '.quota-reservation.lock');
}

// ---------------------------------------------------------------------------
// Fresh default
// ---------------------------------------------------------------------------

function freshQuota(): FleetQuota {
  return { events: [] };
}

function ownedByCurrentUser(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function sameIdentity(
  left: Pick<BigIntStats, 'dev' | 'ino'>,
  right: Pick<BigIntStats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeQuotaDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === 0o700n);
}

function safeQuotaFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === 0o600n);
}

// Pre-reservation releases wrote best-effort telemetry with the caller's
// normal umask (commonly 0755/0644). Accept that owned, non-writable-by-others
// shape only for a read-only first-use migration; new authority state remains
// exact-private 0700/0600.
function safeLegacyQuotaDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function safeLegacyQuotaFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function pinQuotaDirectory(): QuotaDirectoryAuthority | null {
  try {
    const path = fleetDir();
    const stat = lstatSync(path, { bigint: true });
    return safeQuotaDirectory(stat) ? { path, dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function stableQuotaDirectory(authority: QuotaDirectoryAuthority): boolean {
  try {
    const stat = lstatSync(authority.path, { bigint: true });
    return safeQuotaDirectory(stat) && sameIdentity(authority, stat);
  } catch {
    return false;
  }
}

function pinLegacyQuotaDirectory(): QuotaDirectoryAuthority | null {
  try {
    const path = fleetDir();
    const stat = lstatSync(path, { bigint: true });
    return safeLegacyQuotaDirectory(stat) ? { path, dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function stableLegacyQuotaDirectory(authority: QuotaDirectoryAuthority): boolean {
  try {
    const stat = lstatSync(authority.path, { bigint: true });
    return safeLegacyQuotaDirectory(stat) && sameIdentity(authority, stat);
  } catch {
    return false;
  }
}

function prospectiveQuotaDirectoryAvailable(): boolean {
  try {
    const dir = fleetDir();
    if (existsSync(dir)) {
      const stat = lstatSync(dir, { bigint: true });
      return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat);
    }
    const parent = join(homedir(), '.ashlr');
    if (!existsSync(parent)) return true;
    const stat = lstatSync(parent, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat);
  } catch {
    return false;
  }
}

function strictQuotaEvent(value: unknown): FleetQuotaEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(',');
  if (keys !== 'backend,ts' && keys !== 'backend,reservationIdHash,ts') return null;
  const backend = row['backend'];
  const ts = row['ts'];
  const reservationIdHash = row['reservationIdHash'];
  if (typeof backend !== 'string' || !ENGINE_IDS.has(backend as EngineId) ||
    typeof ts !== 'string' || !Number.isFinite(Date.parse(ts)) ||
    new Date(Date.parse(ts)).toISOString() !== ts ||
    (reservationIdHash !== undefined &&
      (typeof reservationIdHash !== 'string' || !SHA256_RE.test(reservationIdHash)))) return null;
  return {
    backend: backend as EngineId,
    ts,
    ...(typeof reservationIdHash === 'string' ? { reservationIdHash } : {}),
  };
}

function parseStrictQuota(
  bytes: Buffer,
  maxEvents = MAX_EVENTS,
  maxBytes = MAX_LEDGER_BYTES,
): FleetQuota | null {
  if (bytes.length > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (Object.keys(row).join(',') !== 'events' || !Array.isArray(row['events']) ||
      row['events'].length > maxEvents) return null;
    const events: FleetQuotaEvent[] = [];
    for (const value of row['events']) {
      const event = strictQuotaEvent(value);
      if (!event) return null;
      events.push(event);
    }
    return { events };
  } catch {
    return null;
  }
}

function readBoundQuotaFile(authority: QuotaDirectoryAuthority): BoundQuotaFile | null {
  if (!stableQuotaDirectory(authority)) return null;
  const path = fleetQuotaReservationPath();
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!safeQuotaFile(opened) || opened.size > BigInt(MAX_AUTHORITY_LEDGER_BYTES) ||
      !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: homedir() }).ok) return null;
    const named = lstatSync(path, { bigint: true });
    if (!safeQuotaFile(named) || !sameIdentity(opened, named)) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!safeQuotaFile(openedAfter) || !safeQuotaFile(namedAfter) ||
      !sameIdentity(opened, openedAfter) || !sameIdentity(openedAfter, namedAfter) ||
      openedAfter.size !== opened.size || openedAfter.mtimeNs !== opened.mtimeNs ||
      openedAfter.ctimeNs !== opened.ctimeNs || !stableQuotaDirectory(authority)) return null;
    return {
      found: true,
      bytes,
      dev: openedAfter.dev,
      ino: openedAfter.ino,
      size: openedAfter.size,
      mtimeNs: openedAfter.mtimeNs,
      ctimeNs: openedAfter.ctimeNs,
    };
  } catch (error) {
    return fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      stableQuotaDirectory(authority)
      ? { found: false }
      : null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function readBoundLegacyQuotaFile(authority: QuotaDirectoryAuthority): BoundQuotaFile | null {
  if (!stableLegacyQuotaDirectory(authority)) return null;
  const path = fleetQuotaPath();
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!safeLegacyQuotaFile(opened) || opened.size > BigInt(MAX_LEDGER_BYTES) ||
      !assurePrivateStoragePath(path, 'file', 'inspect-owned', { anchorPath: homedir() }).ok) return null;
    const named = lstatSync(path, { bigint: true });
    if (!safeLegacyQuotaFile(named) || !sameIdentity(opened, named)) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!safeLegacyQuotaFile(openedAfter) || !safeLegacyQuotaFile(namedAfter) ||
      !sameIdentity(opened, openedAfter) || !sameIdentity(openedAfter, namedAfter) ||
      openedAfter.size !== opened.size || openedAfter.mtimeNs !== opened.mtimeNs ||
      openedAfter.ctimeNs !== opened.ctimeNs || !stableLegacyQuotaDirectory(authority)) return null;
    return {
      found: true,
      bytes,
      dev: openedAfter.dev,
      ino: openedAfter.ino,
      size: openedAfter.size,
      mtimeNs: openedAfter.mtimeNs,
      ctimeNs: openedAfter.ctimeNs,
    };
  } catch (error) {
    return fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      stableLegacyQuotaDirectory(authority)
      ? { found: false }
      : null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function loadStrictQuota(authority: QuotaDirectoryAuthority): LoadedStrictQuota | null {
  const destination = readBoundQuotaFile(authority);
  if (destination === null) return null;
  if (!destination.found) {
    // Upgrade compatibility: seed the first authority transaction from the
    // existing attempt ledger so active-window usage cannot be forgotten.
    const legacy = readBoundLegacyQuotaFile(authority);
    if (legacy === null) return null;
    if (!legacy.found) return { ledger: freshQuota(), destination };
    const ledger = parseStrictQuota(legacy.bytes);
    return ledger ? { ledger, destination } : null;
  }
  const ledger = parseStrictQuota(
    destination.bytes,
    MAX_AUTHORITY_EVENTS,
    MAX_AUTHORITY_LEDGER_BYTES,
  );
  return ledger ? { ledger, destination } : null;
}

function loadQuotaForAuthorityInspection(): FleetQuota | null {
  if (existsSync(fleetQuotaReservationPath())) {
    const authority = pinQuotaDirectory();
    return authority ? loadStrictQuota(authority)?.ledger ?? null : null;
  }
  if (!existsSync(fleetDir())) return prospectiveQuotaDirectoryAvailable() ? freshQuota() : null;
  const authority = pinLegacyQuotaDirectory();
  if (!authority) return null;
  const legacy = readBoundLegacyQuotaFile(authority);
  if (legacy === null) return null;
  if (!legacy.found) return freshQuota();
  return parseStrictQuota(legacy.bytes);
}

function sameDestination(left: BoundQuotaFile, right: BoundQuotaFile | null): boolean {
  if (right === null || left.found !== right.found) return false;
  if (!left.found || !right.found) return true;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.bytes.equals(right.bytes);
}

function saveQuotaReservation(
  ledger: FleetQuota,
  authority: QuotaDirectoryAuthority,
  expected: BoundQuotaFile,
): boolean {
  const bytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  if (ledger.events.length > MAX_AUTHORITY_EVENTS ||
    bytes.length > MAX_AUTHORITY_LEDGER_BYTES) return false;
  const tmp = join(authority.path, `.quota-${process.pid}-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let tmpIdentity: BigIntStats | undefined;
  let published = false;
  try {
    if (!stableQuotaDirectory(authority)) return false;
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    tmpIdentity = fstatSync(fd, { bigint: true });
    if (!safeQuotaFile(tmpIdentity) || tmpIdentity.size !== 0n ||
      !assurePrivateStoragePath(tmp, 'file', 'secure-created', { anchorPath: homedir() }).ok) return false;
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return false;
      offset += count;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const flushed = fstatSync(fd, { bigint: true });
    const named = lstatSync(tmp, { bigint: true });
    if (!safeQuotaFile(flushed) || !safeQuotaFile(named) ||
      !sameIdentity(tmpIdentity, flushed) || !sameIdentity(flushed, named) ||
      flushed.size !== BigInt(bytes.length) || !stableQuotaDirectory(authority) ||
      !sameDestination(expected, readBoundQuotaFile(authority))) return false;
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, fleetQuotaReservationPath());
    published = true;
    fsyncDirectory(authority.path, { expectedIdentity: authority });
    const installed = readBoundQuotaFile(authority);
    return installed !== null && installed.found && sameIdentity(tmpIdentity, installed) &&
      installed.size === BigInt(bytes.length) && installed.bytes.equals(bytes) &&
      stableQuotaDirectory(authority);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (!published && tmpIdentity && stableQuotaDirectory(authority)) {
      try {
        const named = lstatSync(tmp, { bigint: true });
        if (safeQuotaFile(named) && sameIdentity(named, tmpIdentity)) unlinkSync(tmp);
      } catch { /* best effort exact-temp cleanup */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read and parse fleetQuotaPath(). NEVER throws.
 * Returns a fresh empty ledger when the file is missing or malformed.
 */
export function loadFleetQuota(): FleetQuota {
  const p = fleetQuotaPath();
  if (!existsSync(p)) return freshQuota();
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return freshQuota();
    }
    const obj = parsed as Record<string, unknown>;
    const events = Array.isArray(obj['events'])
      ? (obj['events'] as unknown[]).filter(
          (e): e is FleetQuotaEvent =>
            typeof e === 'object' &&
            e !== null &&
            !Array.isArray(e) &&
            typeof (e as Record<string, unknown>)['backend'] === 'string' &&
            typeof (e as Record<string, unknown>)['ts'] === 'string',
        )
      : [];
    return { events };
  } catch {
    // Corrupt JSON or any other read error — return a fresh empty ledger.
    return freshQuota();
  }
}

// ---------------------------------------------------------------------------
// Record a dispatch (compatibility/operator telemetry only)
// ---------------------------------------------------------------------------

/**
 * Append an actual dispatch-attempt event for `backend` (ts = now) and
 * persist. Never throws. This is intentionally not launch authority; the
 * strict reservation ledger above is separate so legacy 0644 telemetry files
 * cannot block or overwrite authority state.
 */
export function recordUse(backend: EngineId): void {
  let acquired: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  try {
    if (!ENGINE_IDS.has(backend)) return;
    const dir = fleetDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    acquired = acquireLocalStoreLockWithOutcome(fleetQuotaReservationLockPath(), 250, {
      anchorPath: homedir(),
      exactPrivateStorage: true,
    });
    if (acquired.state !== 'acquired') return;
    const ledger = loadFleetQuota();
    ledger.events.push({ backend, ts: new Date().toISOString() });
    const bounded = { events: ledger.events.slice(-MAX_EVENTS) };
    const destination = fleetQuotaPath();
    const temporary = `${destination}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(bounded, null, 2)}\n`, 'utf8');
    renameSync(temporary, destination);
  } catch {
    // Never throws.
  } finally {
    if (acquired?.state === 'acquired') {
      try { releaseLocalStoreLock(acquired.lock); } catch { /* telemetry only */ }
    }
  }
}

function reservationIdHash(dispatchId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([RESERVATION_DOMAIN, dispatchId]))
    .digest('hex');
}

function validReservationIdentity(backend: EngineId, dispatchId: string): boolean {
  return ENGINE_IDS.has(backend) && typeof dispatchId === 'string' && dispatchId.length > 0 &&
    Buffer.byteLength(dispatchId, 'utf8') <= MAX_DISPATCH_ID_BYTES;
}

interface NormalizedQuotaRequest {
  backend: EngineId;
  hash: string;
  limit: { max: number; windowMs: number } | null;
}

function configuredReservationLimit(
  cfg: AshlrConfig,
  backend: EngineId,
): { max: number; windowMs: number } | null | 'invalid' {
  const configured = cfg?.foundry?.limits?.[backend];
  if (!configured) return null;
  const windowMs = typeof configured.window === 'string'
    ? reservationWindowMs(configured.window)
    : null;
  if (windowMs === null || !Number.isSafeInteger(configured.max) ||
    configured.max <= 0 || configured.max > MAX_EVENTS) return 'invalid';
  return { max: configured.max, windowMs };
}

function compactReservationEvents(
  events: readonly FleetQuotaEvent[],
  _cfg: AshlrConfig,
  nowMs: number,
): FleetQuotaEvent[] {
  const maximumWindowMs = reservationWindowMs('30d')!;
  const retained = events.filter((event) => {
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts)) return false;
    return ts >= nowMs - maximumWindowMs;
  });
  retained.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  const byBackend = new Map<EngineId, FleetQuotaEvent[]>();
  for (const event of retained) {
    const rows = byBackend.get(event.backend) ?? [];
    rows.push(event);
    if (rows.length > MAX_EVENTS) rows.shift();
    byBackend.set(event.backend, rows);
  }
  return [...byBackend.values()].flat().sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
}

function reserveLimitedQuotaUsesLocked(
  normalized: NormalizedQuotaRequest[],
  limited: NormalizedQuotaRequest[],
  cfg: AshlrConfig,
  authority: QuotaDirectoryAuthority,
  loaded: LoadedStrictQuota,
): FleetQuotaReservationResult {
  try {
    fsyncDirectory(authority.path, { expectedIdentity: authority });
  } catch {
    return { kind: 'unavailable', launchAuthorized: false };
  }
  if (!stableQuotaDirectory(authority)) return { kind: 'unavailable', launchAuthorized: false };

  const nowMs = fleetQuotaTestHooks?.now?.() ?? Date.now();
  const compactedEvents = compactReservationEvents(loaded.ledger.events, cfg, nowMs);
  const byHash = new Map(compactedEvents.flatMap((event) =>
    event.reservationIdHash ? [[event.reservationIdHash, event.backend] as const] : []));
  for (const request of normalized) {
    const existingBackend = byHash.get(request.hash);
    if (existingBackend !== undefined) {
      return {
        kind: existingBackend === request.backend ? 'duplicate' : 'conflict',
        launchAuthorized: false,
        backend: request.backend,
      };
    }
  }

  const usage = new Map<EngineId, number>();
  const requestedByBackend = new Map<EngineId, number>();
  for (const request of limited) {
    requestedByBackend.set(request.backend, (requestedByBackend.get(request.backend) ?? 0) + 1);
  }
  for (const request of limited) {
    if (usage.has(request.backend)) continue;
    const limit = request.limit!;
    const cutoff = nowMs - limit.windowMs;
    const used = compactedEvents.reduce((count, event) =>
      event.backend === request.backend && Date.parse(event.ts) >= cutoff ? count + 1 : count, 0);
    usage.set(request.backend, used);
    if (used + (requestedByBackend.get(request.backend) ?? 0) > limit.max) {
      return {
        kind: 'exhausted', launchAuthorized: false, backend: request.backend,
        used, limit: limit.max,
      };
    }
  }
  const ts = new Date(nowMs).toISOString();
  const next: FleetQuota = {
    events: compactReservationEvents([
      ...compactedEvents,
      ...limited.map(({ backend, hash }) => ({ backend, ts, reservationIdHash: hash })),
    ], cfg, nowMs),
  };
  if (!saveQuotaReservation(next, authority, loaded.destination)) {
    return { kind: 'unavailable', launchAuthorized: false };
  }
  return {
    kind: 'reserved',
    launchAuthorized: true,
    reservations: normalized.map(({ backend, limit }) => {
      if (!limit) return { backend, status: 'unlimited' as const, used: 0, limit: null };
      return {
        backend,
        status: 'reserved' as const,
        used: (usage.get(backend) ?? 0) + (requestedByBackend.get(backend) ?? 0),
        limit: limit.max,
      };
    }),
  };
}

/**
 * Atomically reserve a complete set of configured backend dispatches before
 * any provider contact. The set is all-or-nothing.
 *
 * An absent limit remains truly unlimited and does not touch local storage;
 * this quota boundary therefore makes no replay/idempotency claim for that
 * backend. Execution ownership remains a separate authority.
 * Configured limits require an unambiguous private ledger, exclusive mutation
 * lock, and durable publication. Duplicate and cross-backend identity reuse are
 * explicit no-launch results: replay safety belongs to the execution authority,
 * not to this quota ledger.
 * This function never throws.
 */
function reserveFleetQuotaUsesInternal(
  requests: readonly FleetQuotaReservationRequest[],
  cfg: AshlrConfig,
  options: FleetQuotaReservationOptions = {},
): FleetQuotaReservationResult {
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_BATCH_RESERVATIONS) {
    return { kind: 'invalid', launchAuthorized: false };
  }
  if (options.lockWaitMs !== undefined && !Number.isFinite(options.lockWaitMs)) {
    return { kind: 'invalid', launchAuthorized: false };
  }
  const inputHashes = new Map<string, EngineId>();
  const normalized: NormalizedQuotaRequest[] = [];
  for (const request of requests as readonly FleetQuotaReservationRequest[]) {
    if (!request || !validReservationIdentity(request.backend, request.dispatchId)) {
      return { kind: 'invalid', launchAuthorized: false };
    }
    const hash = reservationIdHash(request.dispatchId);
    const priorBackend = inputHashes.get(hash);
    if (priorBackend !== undefined) {
      return {
        kind: priorBackend === request.backend ? 'duplicate' : 'conflict',
        launchAuthorized: false,
        backend: request.backend,
      };
    }
    inputHashes.set(hash, request.backend);
    const limit = configuredReservationLimit(cfg, request.backend);
    if (limit === null) {
      normalized.push({ backend: request.backend, hash, limit: null });
      continue;
    }
    if (limit === 'invalid') {
      return { kind: 'invalid', launchAuthorized: false, backend: request.backend };
    }
    normalized.push({ backend: request.backend, hash, limit });
  }
  const limited = normalized.filter((request) => request.limit !== null);
  if (limited.length === 0) {
    return {
      kind: 'unlimited',
      launchAuthorized: true,
      reservations: normalized.map(({ backend }) => ({
        backend, status: 'unlimited', used: 0, limit: null,
      })),
    };
  }
  const waitMs = options.lockWaitMs === undefined
    ? 250
    : Math.max(0, Math.min(2_000, Math.floor(options.lockWaitMs)));
  const acquired = acquireLocalStoreLockWithOutcome(fleetQuotaReservationLockPath(), waitMs, {
    anchorPath: homedir(),
    exactPrivateStorage: true,
  });
  if (acquired.state !== 'acquired') return { kind: 'unavailable', launchAuthorized: false };
  let result: FleetQuotaReservationResult;
  try {
    const authority = pinQuotaDirectory();
    if (!authority) result = { kind: 'unavailable', launchAuthorized: false };
    else {
      const loaded = loadStrictQuota(authority);
      result = loaded
        ? reserveLimitedQuotaUsesLocked(normalized, limited, cfg, authority, loaded)
        : { kind: 'unavailable', launchAuthorized: false };
    }
  } catch {
    result = { kind: 'unavailable', launchAuthorized: false };
  }
  const released = (fleetQuotaTestHooks?.releaseLock ?? releaseLocalStoreLock)(acquired.lock);
  if (!released) {
    return {
      kind: 'unavailable',
      launchAuthorized: false,
      ...(result.kind === 'reserved' ? { reservationConsumed: true } : {}),
    };
  }
  return result;
}

export function reserveFleetQuotaUses(
  requests: readonly FleetQuotaReservationRequest[],
  cfg: AshlrConfig,
  options: FleetQuotaReservationOptions = {},
): FleetQuotaReservationResult {
  try {
    return reserveFleetQuotaUsesInternal(requests, cfg, options);
  } catch {
    return { kind: 'invalid', launchAuthorized: false };
  }
}

/** Single-dispatch convenience wrapper over the atomic batch transaction. */
export function reserveFleetQuotaUse(
  backend: EngineId,
  cfg: AshlrConfig,
  dispatchId: string,
  options: FleetQuotaReservationOptions = {},
): FleetQuotaReservationResult {
  return reserveFleetQuotaUses([{ backend, dispatchId }], cfg, options);
}

interface FleetQuotaAuthorityEvaluation {
  health: FleetQuotaAuthorityHealth;
  standing: 'ok' | 'warn' | 'over' | 'unlimited';
}

function evaluateFleetQuotaAuthority(
  backend: EngineId,
  cfg: AshlrConfig,
  now?: number,
): FleetQuotaAuthorityEvaluation {
  try {
    const limit = configuredReservationLimit(cfg, backend);
    if (limit === null) return { health: 'unlimited', standing: 'unlimited' };
    if (limit === 'invalid') return { health: 'invalid', standing: 'over' };
    const ledger = loadQuotaForAuthorityInspection();
    if (!ledger) return { health: 'unavailable', standing: 'over' };
    const nowMs = now ?? fleetQuotaTestHooks?.now?.() ?? Date.now();
    const compacted = compactReservationEvents(ledger.events, cfg, nowMs);
    if (compacted.length > MAX_AUTHORITY_EVENTS) {
      return { health: 'capacity', standing: 'over' };
    }
    const cutoff = nowMs - limit.windowMs;
    const used = compacted.reduce((count, event) =>
      event.backend === backend && Date.parse(event.ts) >= cutoff ? count + 1 : count, 0);
    return {
      health: 'healthy',
      standing: used >= limit.max ? 'over' : used >= limit.max * 0.8 ? 'warn' : 'ok',
    };
  } catch {
    return { health: 'unavailable', standing: 'over' };
  }
}

/** Read-only conservative health projection for operator/status surfaces. */
export function inspectFleetQuotaAuthority(
  backend: EngineId,
  cfg: AshlrConfig,
  now?: number,
): FleetQuotaAuthorityHealth {
  return evaluateFleetQuotaAuthority(backend, cfg, now).health;
}

/**
 * Quota standing derived from reserved authority slots, not attempt telemetry.
 * This intentionally counts conservative pre-effect reservations that may not
 * have reached a provider: those slots still consume the configured window.
 */
export function evalFleetQuotaAuthority(
  backend: EngineId,
  cfg: AshlrConfig,
  now?: number,
): 'ok' | 'warn' | 'over' | 'unlimited' {
  return evaluateFleetQuotaAuthority(backend, cfg, now).standing;
}

// ---------------------------------------------------------------------------
// Window counting
// ---------------------------------------------------------------------------

/**
 * Count events for `backend` whose ts is within the last `windowMs`
 * (ts >= now - windowMs). Reads the ledger internally; `now` is injectable for
 * deterministic tests (defaults to Date.now()).
 */
export function usesInWindow(
  backend: EngineId,
  windowMs: number,
  now?: number,
): number {
  const nowMs = now ?? Date.now();
  const cutoff = nowMs - windowMs;
  const q = loadFleetQuota();
  let count = 0;
  for (const ev of q.events) {
    if (ev.backend !== backend) continue;
    const t = Date.parse(ev.ts);
    if (Number.isNaN(t)) continue;
    if (t >= cutoff) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Limit check
// ---------------------------------------------------------------------------

/**
 * True when `backend` is still UNDER its configured rate limit (or unlimited).
 *
 * Mirrors evalBudget's null-cap-disabled logic: when no
 * cfg.foundry.limits[backend] is configured, the backend is unlimited ⇒ always
 * within limit. Healthy configured state follows reservation standing so a
 * consumed slot can route to an eligible peer. Invalid, unavailable, or
 * capacity-ambiguous authority deliberately remains advisory-eligible here so
 * the final provider-effect reservation returns the structured fail-closed
 * refusal instead of silently capability-downgrading to builtin. `now` is
 * injectable for tests.
 */
export function withinLimit(
  backend: EngineId,
  cfg: AshlrConfig,
  now?: number,
): boolean {
  const limit = cfg.foundry?.limits?.[backend];
  if (!limit) return true; // no cap configured ⇒ unlimited
  const evaluation = evaluateFleetQuotaAuthority(backend, cfg, now);
  if (evaluation.health !== 'healthy') return true;
  return evaluation.standing !== 'over';
}

// ---------------------------------------------------------------------------
// Three-level quota evaluation (mirrors evalBudget)
// ---------------------------------------------------------------------------

/**
 * Evaluate a backend's rate-limit status as 'ok' | 'warn' | 'over', mirroring
 * evalBudget: 'over' at >= 100% of the cap, 'warn' at >= 80%, else 'ok'. When no
 * cap is configured the backend is unlimited ⇒ always 'ok'. `now` is injectable.
 */
export function evalQuota(
  backend: EngineId,
  cfg: AshlrConfig,
  now?: number,
): 'ok' | 'warn' | 'over' {
  const limit = cfg.foundry?.limits?.[backend];
  if (!limit) return 'ok';
  const windowMs = reservationWindowMs(limit.window);
  if (windowMs === null || !Number.isSafeInteger(limit.max) ||
    limit.max <= 0 || limit.max > MAX_EVENTS) return 'over';
  const used = usesInWindow(backend, windowMs, now);
  if (used >= limit.max) return 'over';
  if (used >= limit.max * 0.8) return 'warn';
  return 'ok';
}
