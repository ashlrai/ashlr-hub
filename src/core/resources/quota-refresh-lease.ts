/** Shared foreground quota ownership; a pending fence survives uncertain cleanup. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock,
  canonicalStartEpochSecond, verifiedProcessStartIdentity, type LocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, digest, inspectPrivateDirectory, privateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readResourceJson } from './pool-runtime.js';
import { readNativeBootIdentity, type NativeBootIdentity } from './native-boot-identity.js';
import type { ResourceCollectorRecoveryDiagnosis } from './console-types.js';

export type ResourceQuotaRefreshLeaseErrorCode = 'collector-owned' | 'reconciliation-required' |
  'collector-unavailable' | 'cleanup-unconfirmed' | 'cancelled';

/** Only verified pre-contact failures with confirmed lock cleanup permit a read-only fallback. */
export class ResourceQuotaRefreshLeaseError extends Error {
  readonly safeReadOnlyFallback: boolean;
  readonly recovery?: Readonly<ResourceCollectorRecoveryDiagnosis>;
  constructor(readonly code: ResourceQuotaRefreshLeaseErrorCode, message: string, recovery?: ResourceCollectorRecoveryDiagnosis) {
    super(message); this.name = 'ResourceQuotaRefreshLeaseError';
    this.safeReadOnlyFallback = ['collector-owned', 'reconciliation-required', 'collector-unavailable'].includes(code);
    if (recovery) this.recovery = Object.freeze({ reasonCode: recovery.reasonCode, markerVersion: recovery.markerVersion });
  }
}

const ACQUISITION_UNAVAILABLE = 'Resource quota collector already owned or unavailable; prior pending work requires operator reconciliation';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_MARKER_BYTES = 512;
const RECOVERY_RECEIPT = '.resource-quota-refresh-recovery.json';
const MAX_RECOVERY_BYTES = 2048;
const ACTIVITY_FILE = '.resource-quota-refresh-activity.json';
const MAX_ACTIVITY_BYTES = 1024;
type MarkerBase = { scope: 'codex-native-metadata' | 'native-connection-metadata'; state: 'pending'; startedAt: string };
type PendingMarker = MarkerBase & ({ schemaVersion: 1 } |
  { schemaVersion: 2; bootIdentity: NativeBootIdentity; ownerToken: string } |
  { schemaVersion: 3 | 4; bootIdentity: NativeBootIdentity; ownerToken: string; ownerPid: number });
type ActivityReservation = { id: string; phase: 'ready' | 'preparing' | 'registered'; pgid: number | null };
type ActivityRecord = {
  ownerToken: string; markerDigest: string; pending: { dev: string; ino: string }; sequence: number;
} & ({ schemaVersion: 1; reservations: string[] } | { schemaVersion: 2; reservations: ActivityReservation[] });

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function validBoot(value: unknown): value is NativeBootIdentity {
  return exact(value, ['machineDigest', 'bootId']) && typeof value.machineDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.machineDigest) && typeof value.bootId === 'string' && UUID.test(value.bootId) &&
    value.bootId !== '00000000-0000-0000-0000-000000000000';
}
function currentBoot(): NativeBootIdentity | null {
  try { const value = readNativeBootIdentity(); return validBoot(value) ? { ...value } : null; }
  catch { return null; }
}
function validMarker(value: unknown): value is PendingMarker {
  if (!value || typeof value !== 'object') return false;
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (!exact(value, version === 1 ? ['schemaVersion', 'scope', 'state', 'startedAt'] : version === 3 || version === 4 ?
    ['schemaVersion', 'scope', 'state', 'startedAt', 'bootIdentity', 'ownerToken', 'ownerPid'] :
    ['schemaVersion', 'scope', 'state', 'startedAt', 'bootIdentity', 'ownerToken']) ||
    (version !== 1 && version !== 2 && version !== 3 && version !== 4) ||
    typeof value.scope !== 'string' || !['codex-native-metadata', 'native-connection-metadata'].includes(value.scope) ||
    value.state !== 'pending' || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) ||
    new Date(value.startedAt).toISOString() !== value.startedAt) return false;
  return version === 1 || validBoot(value.bootIdentity) && typeof value.ownerToken === 'string' && UUID.test(value.ownerToken) &&
    (version === 2 || Number.isSafeInteger(value.ownerPid) && Number(value.ownerPid) > 0);
}
function privateMarkerStat(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(MAX_MARKER_BYTES) &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === 0o600n);
}
function sameMarker(before: BigIntStats, after: BigIntStats): boolean {
  return privateMarkerStat(before) && privateMarkerStat(after) && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
function readPendingMarker(path: string): { marker: PendingMarker; stat: BigIntStats; recordDigest: string } {
  const before = lstatSync(path, { bigint: true });
  if (!privateMarkerStat(before)) throw new Error();
  const marker: unknown = readResourceJson(path, MAX_MARKER_BYTES);
  const after = lstatSync(path, { bigint: true });
  if (!validMarker(marker) || !sameMarker(before, after)) throw new Error();
  return { marker, stat: after, recordDigest: digest(canonical(marker)) };
}

function privateActivityStat(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(MAX_ACTIVITY_BYTES) &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === 0o600n);
}
function sameActivity(before: BigIntStats, after: BigIntStats): boolean {
  return privateActivityStat(before) && privateActivityStat(after) && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
function readActivity(path: string): { record: ActivityRecord; stat: BigIntStats; recordDigest: string } {
  const before = lstatSync(path, { bigint: true });
  if (!privateActivityStat(before)) throw new Error();
  const value: unknown = readResourceJson(path, MAX_ACTIVITY_BYTES);
  const after = lstatSync(path, { bigint: true });
  if (!sameActivity(before, after) || !exact(value, ['schemaVersion', 'ownerToken', 'markerDigest', 'pending', 'sequence', 'reservations']) ||
      (value.schemaVersion !== 1 && value.schemaVersion !== 2) || typeof value.ownerToken !== 'string' || !UUID.test(value.ownerToken) ||
      typeof value.markerDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.markerDigest) ||
      !exact(value.pending, ['dev', 'ino']) || ![value.pending.dev, value.pending.ino].every((item) => typeof item === 'string' && /^\d+$/.test(item)) ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || !Array.isArray(value.reservations) || value.reservations.length > 2 ||
      value.reservations.some((item) => value.schemaVersion === 1
        ? typeof item !== 'string' || !UUID.test(item)
        : !exact(item, ['id', 'phase', 'pgid']) || typeof item.id !== 'string' || !UUID.test(item.id) ||
          typeof item.phase !== 'string' || !['ready', 'preparing', 'registered'].includes(item.phase) ||
          (item.phase === 'registered' ? !Number.isSafeInteger(item.pgid) || Number(item.pgid) <= 0 : item.pgid !== null)) ||
      new Set(value.reservations.map((item) => value.schemaVersion === 1 ? item : (item as ActivityReservation).id)).size !== value.reservations.length) throw new Error();
  return { record: value as unknown as ActivityRecord, stat: after, recordDigest: digest(canonical(value)) };
}
function ownerAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function activityMatches(activity: ActivityRecord, previous: ReturnType<typeof readPendingMarker>): boolean {
  return (previous.marker.schemaVersion === 3 && activity.schemaVersion === 1 || previous.marker.schemaVersion === 4 && activity.schemaVersion === 2) &&
    activity.ownerToken === previous.marker.ownerToken &&
    activity.markerDigest === previous.recordDigest && activity.pending.dev === previous.stat.dev.toString() &&
    activity.pending.ino === previous.stat.ino.toString();
}

/** Signal zero is observation only: a recycled/present group or any non-ESRCH error blocks recovery. */
function activityRecoveryBlocker(activity: ActivityRecord): ResourceCollectorRecoveryDiagnosis['reasonCode'] | null {
  if (activity.schemaVersion === 1) return activity.reservations.length === 0 ? null : 'legacy-active-work-unverifiable';
  for (const reservation of activity.reservations) {
    if (reservation.phase === 'preparing') return 'command-registration-incomplete';
    if (reservation.phase === 'ready') continue;
    try { process.kill(-reservation.pgid!, 0); return 'process-group-not-confirmed-absent'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'process-group-not-confirmed-absent'; }
  }
  return null;
}

export interface ResourceNativeProcessGroupLifecycle {
  prepare(): { spawned(pgid: number): void; settled(receipt: 'not-started' | 'group-exit-confirmed'): void };
}
export interface ResourceNativeActivity {
  settle(): void;
  processGroupLifecycle: ResourceNativeProcessGroupLifecycle;
}

export interface ResourceQuotaRefreshLease {
  assertOwnership(): void;
  /** Private, verified identity. Available only after durable contact fencing. */
  identity(): ResourceQuotaRefreshOwner;
  /** Publish durably before the first native metadata contact. */
  markPending(): void;
  /** Reserve durably before invocation; settle only after verified native teardown. */
  beginNativeActivity(): ResourceNativeActivity;
  /** The caller must await native teardown before requesting marker removal. */
  close(preservePending?: boolean): void;
}

export interface ResourceQuotaRefreshOwner {
  lock: { token: string; dev: string; ino: string; pid: number; startRef: string; startRefSource: string };
  pending: { dev: string; ino: string; recordDigest: string };
}

/** Inspect without acquiring/reclaiming a lease or contacting a provider. */
export function inspectResourceQuotaRefreshOwner(root: string): ResourceQuotaRefreshOwner {
  try {
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root === parse(root).root) throw new Error();
    inspectPrivateDirectory(root);
    const lockPath = join(root, '.resource-quota-refresh.lock');
    const pendingPath = join(root, '.resource-quota-refresh-pending.json');
    const lockBefore = lstatSync(lockPath, { bigint: true });
    const pendingBefore = lstatSync(pendingPath, { bigint: true });
    const lock = readResourceJson(lockPath, 512) as Record<string, unknown>;
    const marker = readPendingMarker(pendingPath).marker;
    if (!exact(lock, ['pid', 'token', 'startRef', 'startRefVerified', 'startRefSource']) ||
      !Number.isSafeInteger(lock.pid) || Number(lock.pid) < 1 || typeof lock.token !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(lock.token) || typeof lock.startRef !== 'string' || lock.startRefVerified !== true ||
      typeof lock.startRefSource !== 'string' || marker.schemaVersion !== 1 && marker.ownerToken !== lock.token ||
      (marker.schemaVersion === 3 || marker.schemaVersion === 4) && marker.ownerPid !== lock.pid) throw new Error();
    process.kill(Number(lock.pid), 0);
    const recordedStart = canonicalStartEpochSecond(lock.startRef, lock.startRefSource);
    const observedStart = verifiedProcessStartIdentity(Number(lock.pid));
    if (recordedStart === undefined || !observedStart || Math.abs(recordedStart - observedStart.epochSecond) > 1) throw new Error();
    const lockAfter = lstatSync(lockPath, { bigint: true });
    const pendingAfter = lstatSync(pendingPath, { bigint: true });
    for (const [before, after] of [[lockBefore, lockAfter], [pendingBefore, pendingAfter]] as const) {
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error();
    }
    return Object.freeze({ lock: Object.freeze({ token: lock.token, dev: lockAfter.dev.toString(), ino: lockAfter.ino.toString(),
      pid: Number(lock.pid), startRef: lock.startRef, startRefSource: lock.startRefSource }),
    pending: Object.freeze({ dev: pendingAfter.dev.toString(), ino: pendingAfter.ino.toString(), recordDigest: digest(canonical(marker)) }) });
  } catch { throw new Error('Resource quota collector identity unavailable'); }
}

/** One explicit private root, shared by console and bounded metadata collectors. */
export async function acquireResourceQuotaRefreshLease(root: string,
  options: { waitMs?: number; signal?: AbortSignal; scope?: 'codex-native-metadata' | 'native-connection-metadata'; trackNativeActivity?: boolean } = {}): Promise<ResourceQuotaRefreshLease> {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root === parse(root).root ||
      root.length > 4096 || [...root].some((character) => character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)) {
    throw new Error('Invalid resource quota collector root');
  }
  const waitMs = options.waitMs === undefined ? 0 : options.waitMs;
  const signal = options.signal;
  const scope = options.scope ?? 'codex-native-metadata';
  if (options.trackNativeActivity !== undefined && typeof options.trackNativeActivity !== 'boolean') throw new Error('Invalid native activity tracking');
  if (!['codex-native-metadata', 'native-connection-metadata'].includes(scope)) throw new Error('Invalid collector scope');
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
    throw new Error('Invalid resource quota collector wait budget');
  }
  const deadline = waitMs > 0 ? performance.now() + waitMs : null;
  let failureCode: ResourceQuotaRefreshLeaseErrorCode = 'collector-unavailable';
  let recoveryStarted = false;
  let recovery: ResourceCollectorRecoveryDiagnosis | undefined;
  const assertActive = (): void => {
    if (signal?.aborted) throw new ResourceQuotaRefreshLeaseError('cancelled', ACQUISITION_UNAVAILABLE);
    if (deadline !== null && performance.now() >= deadline) throw new ResourceQuotaRefreshLeaseError(failureCode, ACQUISITION_UNAVAILABLE);
  };
  let lock: LocalStoreLock | null = null;
  const pendingPath = join(root, '.resource-quota-refresh-pending.json');
  const activityPath = join(root, ACTIVITY_FILE);
  try {
    assertActive();
    privateDirectory(root);
    const lockPath = join(root, '.resource-quota-refresh.lock');
    const lockOptions = { anchorPath: root, exactPrivateStorage: true };
    if (deadline === null) {
      const attempt = acquireLocalStoreLockWithOutcome(lockPath, 500, lockOptions);
      lock = attempt.lock;
      failureCode = attempt.state === 'contended' ? 'collector-owned' : 'collector-unavailable';
    }
    else {
      for (;;) {
        assertActive();
        const attempt = acquireLocalStoreLockWithOutcome(lockPath, 0, lockOptions);
        lock = attempt.lock;
        failureCode = attempt.state === 'contended' ? 'collector-owned' : 'collector-unavailable';
        // Acquisition performs synchronous identity checks. A late acquisition
        // is released by the catch below, before it may publish a contact marker.
        assertActive();
        if (lock) break;
        if (attempt.state !== 'contended') throw new Error();
        // Only a verified live owner is waitable. Yield so a same-process owner
        // can finish; do not block its cleanup with a longer synchronous wait.
        await delay(Math.min(250, Math.max(1, Math.ceil(deadline - performance.now()))),
          undefined, { signal });
      }
    }
    assertActive();
    if (!lock) throw new Error();
    let pendingExists = true;
    try { lstatSync(pendingPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') pendingExists = false; else throw error; }
    if (pendingExists) {
      failureCode = 'reconciliation-required';
      recovery = { reasonCode: 'pending-evidence-unavailable', markerVersion: null };
      const previous = readPendingMarker(pendingPath);
      recovery.markerVersion = previous.marker.schemaVersion;
      if (previous.marker.schemaVersion === 1) { recovery.reasonCode = 'legacy-owner-evidence-missing'; throw new Error(); }
      const boot = currentBoot();
      assertActive();
      if (!boot) { recovery.reasonCode = 'boot-identity-unavailable'; throw new Error(); }
      if (previous.marker.bootIdentity.machineDigest !== boot.machineDigest) { recovery.reasonCode = 'machine-identity-mismatch'; throw new Error(); }
      const sameBoot = previous.marker.bootIdentity.bootId === boot.bootId;
      let priorActivity: ReturnType<typeof readActivity> | undefined;
      if (sameBoot) {
        if (previous.marker.schemaVersion !== 3 && previous.marker.schemaVersion !== 4) {
          recovery.reasonCode = 'same-boot-owner-evidence-missing'; throw new Error();
        }
        if (!ownerAbsent(previous.marker.ownerPid)) { recovery.reasonCode = 'owner-not-confirmed-absent'; throw new Error(); }
        recovery.reasonCode = 'activity-evidence-unavailable';
        priorActivity = readActivity(activityPath);
        if (!activityMatches(priorActivity.record, previous)) throw new Error();
        const blocker = activityRecoveryBlocker(priorActivity.record);
        if (blocker) { recovery.reasonCode = blocker; throw new Error(); }
      }
      recovery.reasonCode = 'recovery-confirmation-failed';
      if (!ownsLocalStoreLock(lock)) throw new ResourceQuotaRefreshLeaseError('cleanup-unconfirmed', ACQUISITION_UNAVAILABLE);
      // A prior boot cannot retain a local native child. On the same boot,
      // only a dead owner's exact settled/registered-group witness grants recovery.
      // Preparing is deliberately unrecoverable: the owner may have died after
      // spawning native work but before publishing its process group.
      // Preserve authorization BEFORE unlink; neither case claims a provider
      // observation or a successful result from an abandoned metadata call.
      const receipt = JSON.stringify({ schemaVersion: 1, state: 'authorized-before-unlink',
        reason: sameBoot ? priorActivity?.record.schemaVersion === 2 && priorActivity.record.reservations.some((item) => item.phase === 'registered')
          ? 'same-boot-verified-groups-absent-dead-owner' : 'same-boot-verified-idle-dead-owner' : 'same-machine-different-boot',
        markerDigest: previous.recordDigest, pending: { dev: previous.stat.dev.toString(), ino: previous.stat.ino.toString() },
        marker: previous.marker, bootIdentity: boot, authorizedAt: new Date().toISOString(),
        ...(priorActivity ? { activity: { dev: priorActivity.stat.dev.toString(), ino: priorActivity.stat.ino.toString(),
          recordDigest: priorActivity.recordDigest, record: priorActivity.record } } : {}) }) + '\n';
      if (Buffer.byteLength(receipt, 'utf8') > MAX_RECOVERY_BYTES) throw new Error();
      const receiptPath = join(root, RECOVERY_RECEIPT);
      // A single bounded latest receipt avoids an unbounded recovery directory.
      try {
        const existing = lstatSync(receiptPath, { bigint: true });
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n || existing.size > BigInt(MAX_RECOVERY_BYTES) ||
            typeof process.getuid === 'function' && existing.uid !== BigInt(process.getuid()) ||
            process.platform !== 'win32' && (existing.mode & 0o777n) !== 0o600n) throw new Error();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      recoveryStarted = true;
      writePrivateFileAtomically(`${receiptPath}.${randomUUID()}.tmp`, receiptPath, receipt,
        { anchorPath: root, label: 'Quota collector recovery receipt' });
      assertActive();
      const confirmedBoot = currentBoot();
      if (!confirmedBoot || canonical(confirmedBoot) !== canonical(boot) || !ownsLocalStoreLock(lock)) throw new Error();
      const current = readPendingMarker(pendingPath);
      if (!sameMarker(previous.stat, current.stat) || previous.recordDigest !== current.recordDigest) throw new Error();
      if (priorActivity) {
        const confirmedActivity = readActivity(activityPath);
        if (!sameActivity(priorActivity.stat, confirmedActivity.stat) || priorActivity.recordDigest !== confirmedActivity.recordDigest ||
          (previous.marker.schemaVersion !== 3 && previous.marker.schemaVersion !== 4) || !ownerAbsent(previous.marker.ownerPid) ||
          activityRecoveryBlocker(confirmedActivity.record) !== null) throw new Error();
      }
      assertActive();
      unlinkSync(pendingPath); fsyncDirectory(root);
      assertActive();
    }
  } catch (error) {
    let released = false;
    try { released = lock ? releaseLocalStoreLock(lock) : true; } catch { /* Cleanup remains unconfirmed. */ }
    const code = !released || recoveryStarted ? 'cleanup-unconfirmed' : signal?.aborted ? 'cancelled' :
      error instanceof ResourceQuotaRefreshLeaseError ? error.code : failureCode;
    throw new ResourceQuotaRefreshLeaseError(code, released
      ? ACQUISITION_UNAVAILABLE : 'Resource quota collector unavailable: acquisition cleanup unconfirmed',
    code === 'cancelled' ? undefined : recovery);
  }

  let pending: { dev: bigint; ino: bigint; record: string } | null = null;
  let activity: ReturnType<typeof readActivity> | null = null;
  const reservations = new Map<string, ActivityReservation>();
  let poisoned = false;
  let closed = false; let closeError: ResourceQuotaRefreshLeaseError | null = null;
  function assertOwnership(): void {
    if (poisoned || closed || !ownsLocalStoreLock(lock)) {
      if (options.trackNativeActivity) poisoned = true;
      throw new Error('Quota collection ownership lost');
    }
    if (!pending) return;
    try {
      const stat = lstatSync(pendingPath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.dev !== pending.dev || stat.ino !== pending.ino ||
          typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) ||
          process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o600n ||
          JSON.stringify(readResourceJson(pendingPath, 512)) !== pending.record) throw new Error();
      if (activity) {
        const current = readActivity(activityPath);
        if (!sameActivity(activity.stat, current.stat) || activity.recordDigest !== current.recordDigest) throw new Error();
      }
    } catch { if (options.trackNativeActivity) poisoned = true; throw new Error('Quota collection marker changed'); }
  }
  function writeActivity(record: ActivityRecord): void {
    assertOwnership();
    // A stale safe sidecar may be replaced, but it never authorizes this marker:
    // every record binds the immutable marker identity and unique owner token.
    if (!activity) {
      try { readActivity(activityPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const bytes = canonical(record) + '\n';
    if (Buffer.byteLength(bytes) > MAX_ACTIVITY_BYTES) throw new Error();
    writePrivateFileAtomically(`${activityPath}.${randomUUID()}.tmp`, activityPath, bytes,
      { anchorPath: root, label: 'Quota collector native activity' });
    const installed = readActivity(activityPath);
    if (installed.recordDigest !== digest(canonical(record))) throw new Error();
    activity = installed;
    assertOwnership();
  }
  function markPending(): void {
    assertOwnership();
    let fd: number | undefined;
    try {
      fd = openSync(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      // A failed publication remains fenced. Do not infer successful native
      // cleanup or remove an unverified marker after a write/fsync failure.
      const bootIdentity = currentBoot();
      const marker: PendingMarker = bootIdentity
        ? options.trackNativeActivity
          ? { schemaVersion: 4, scope, state: 'pending', startedAt: new Date().toISOString(), bootIdentity, ownerToken: lock!.token, ownerPid: process.pid }
          : { schemaVersion: 2, scope, state: 'pending', startedAt: new Date().toISOString(), bootIdentity, ownerToken: lock!.token }
        : { schemaVersion: 1, scope, state: 'pending', startedAt: new Date().toISOString() };
      const record = JSON.stringify(marker);
      if (Buffer.byteLength(record + '\n', 'utf8') > MAX_MARKER_BYTES) throw new Error();
      writeFileSync(fd, record + '\n'); fsyncSync(fd); fsyncDirectory(root); assertOwnership();
      const stat = fstatSync(fd, { bigint: true }); pending = { dev: stat.dev, ino: stat.ino, record };
      assertOwnership();
      if (marker.schemaVersion === 4) writeActivity({ schemaVersion: 2, ownerToken: lock!.token,
        markerDigest: digest(canonical(marker)), pending: { dev: stat.dev.toString(), ino: stat.ino.toString() },
        sequence: 0, reservations: [] });
    } catch { if (options.trackNativeActivity) poisoned = true; throw new ResourceQuotaRefreshLeaseError('cleanup-unconfirmed', 'Resource quota collector pending marker unavailable'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function writeReservations(next: ActivityReservation[]): void {
    if (activity) {
      if (activity.record.schemaVersion !== 2 || !Number.isSafeInteger(activity.record.sequence + 1)) throw new Error();
      writeActivity({ ...activity.record, sequence: activity.record.sequence + 1, reservations: next });
    }
  }
  function beginNativeActivity(): ResourceNativeActivity {
    let id: string;
    try {
      assertOwnership();
      if (!options.trackNativeActivity || !pending || reservations.size >= 2) throw new Error();
      id = randomUUID();
      const reservation: ActivityReservation = { id, phase: 'ready', pgid: null };
      writeReservations([...reservations.values(), reservation]);
      reservations.set(id, reservation);
    } catch { poisoned = true; throw new ResourceQuotaRefreshLeaseError('cleanup-unconfirmed', 'Native activity reservation unavailable'); }
    let settled = false;
    function transition(expected: ActivityReservation['phase'], next: ActivityReservation): void {
      assertOwnership();
      if (settled || reservations.get(id)?.phase !== expected) throw new Error();
      writeReservations([...reservations.values()].map((item) => item.id === id ? next : item));
      reservations.set(id, next);
    }
    const processGroupLifecycle: ResourceNativeProcessGroupLifecycle = Object.freeze({ prepare() {
      try { transition('ready', { id, phase: 'preparing', pgid: null }); }
      catch { poisoned = true; throw new ResourceQuotaRefreshLeaseError('cleanup-unconfirmed', 'Native process preparation unavailable'); }
      let registered = false; let completed = false;
      return Object.freeze({ spawned(pgid: number): void {
        try {
          if (completed || registered || !Number.isSafeInteger(pgid) || pgid < 1) throw new Error();
          transition('preparing', { id, phase: 'registered', pgid }); registered = true;
        } catch { poisoned = true; throw new ResourceQuotaRefreshLeaseError('cleanup-unconfirmed', 'Native process registration unavailable'); }
      }, settled(receipt: 'not-started' | 'group-exit-confirmed'): void {
        try {
          if (completed || receipt !== (registered ? 'group-exit-confirmed' : 'not-started')) throw new Error();
          transition(registered ? 'registered' : 'preparing', { id, phase: 'ready', pgid: null }); completed = true;
        } catch { poisoned = true; throw new ResourceQuotaRefreshLeaseError('cleanup-unconfirmed', 'Native process settlement unavailable'); }
      } });
    } });
    return Object.freeze({ processGroupLifecycle, settle(): void {
      if (settled) return;
      try {
        assertOwnership();
        if (reservations.get(id)?.phase !== 'ready') throw new Error();
        writeReservations([...reservations.values()].filter((value) => value.id !== id));
        reservations.delete(id); settled = true;
      } catch { poisoned = true; throw new ResourceQuotaRefreshLeaseError('cleanup-unconfirmed', 'Native activity settlement unavailable'); }
    } });
  }
  function identity(): ResourceQuotaRefreshOwner {
    assertOwnership();
    if (!pending) throw new Error('Resource quota collector identity unavailable');
    const owner = inspectResourceQuotaRefreshOwner(root);
    if (owner.lock.token !== lock!.token || owner.lock.dev !== lock!.dev.toString() || owner.lock.ino !== lock!.ino.toString() ||
      owner.pending.dev !== pending.dev.toString() || owner.pending.ino !== pending.ino.toString() ||
      owner.pending.recordDigest !== digest(canonical(JSON.parse(pending.record)))) throw new Error('Resource quota collector identity unavailable');
    assertOwnership();
    return owner;
  }
  function close(preservePending = false): void {
    if (closed) { if (closeError) throw closeError; return; }
    try {
      assertOwnership();
      if (!preservePending && reservations.size > 0) throw new Error('Native activity remains unsettled');
      if (!preservePending && pending) {
        unlinkSync(pendingPath); fsyncDirectory(root); pending = null;
      }
    } catch { closeError = new ResourceQuotaRefreshLeaseError('cleanup-unconfirmed', 'Resource quota collector shutdown uncertain'); }
    finally {
      closed = true;
      let released = false;
      try { released = releaseLocalStoreLock(lock); } catch { /* Preserve the fixed typed cleanup failure. */ }
      if (!released) closeError ??= new ResourceQuotaRefreshLeaseError('cleanup-unconfirmed', 'Resource quota collector shutdown uncertain');
    }
    if (closeError) throw closeError;
  }
  return Object.freeze({ assertOwnership, identity, markPending, beginNativeActivity, close });
}
