/**
 * state.ts — Daemon state persistence.
 *
 * Responsibilities:
 *  - daemonStatePath(): path to ~/.ashlr/daemon.json
 *  - loadDaemonState(): read + parse; NEVER throws; returns zeroed state on
 *    missing/corrupt file.
 *  - saveDaemonState(): atomic write (tmp + rename, POSIX-atomic); mkdir -p.
 *  - resetDayIfNeeded(): pure — if todayDate has rolled over, zero daily
 *    spend and update the date. Returns (possibly new) state; caller persists.
 *
 * No new runtime deps; node builtins only.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, hostname as osHostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DaemonState } from '../types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of tick history entries kept in daemon.json. */
const MAX_TICKS = 100;

/** Conservative stale-lock window used only after the recorded pid is gone. */
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
export const DAEMON_SPEND_GUARD_ITEM_CAPACITY = 64;
const MAX_SPEND_GUARD_ITEM_ID_BYTES = 512;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUDGET_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function ashlrDir(): string {
  return join(homedir(), '.ashlr');
}

/** Absolute path to the daemon state file. */
export function daemonStatePath(): string {
  return join(ashlrDir(), 'daemon.json');
}

/** Absolute path to the daemon spend-commit guard file. */
export function daemonSpendGuardPath(): string {
  return join(ashlrDir(), 'daemon.spend-guard.json');
}

/** Absolute path to the daemon singleton lock file. */
export function daemonLockPath(): string {
  return join(ashlrDir(), 'daemon.lock');
}

export interface DaemonLockOwner {
  pid: number;
  token: string;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface DaemonLock {
  path: string;
  token: string;
  pid: number;
}

export type AcquireDaemonLockResult =
  | { acquired: true; lock: DaemonLock; owner: DaemonLockOwner; replacedStale: boolean }
  | { acquired: false; path: string; owner: DaemonLockOwner | null; reason: 'busy' | 'io-error' };

export type LoadDaemonStateStrictResult =
  | { ok: true; state: DaemonState; fresh: boolean }
  | {
      ok: false;
      path: string;
      reason: 'malformed' | 'unreadable';
      error: string;
      diagnostic: DaemonStateRecoveryDiagnostic;
    };

export type DaemonStateDiagnosticCode =
  | 'invalid-json'
  | 'invalid-root'
  | 'running-invalid'
  | 'pid-invalid'
  | 'started-at-invalid'
  | 'last-tick-at-invalid'
  | 'budget-day-invalid'
  | 'spend-invalid'
  | 'items-processed-invalid'
  | 'ticks-invalid'
  | 'spend-accounting-shape-invalid'
  | 'spend-accounting-keys-invalid'
  | 'spend-accounting-day-invalid'
  | 'spend-accounting-id-invalid'
  | 'spend-accounting-exhaustion-invalid'
  | 'automatic-drain-flag-invalid'
  | 'state-recovery-in-progress'
  | 'unsafe-storage'
  | 'source-changed-during-read'
  | 'read-failed';

/** Metadata-only recovery guidance. It never authorizes or performs a write. */
export interface DaemonStateRecoveryDiagnostic {
  schemaVersion: 1;
  issueCodes: DaemonStateDiagnosticCode[];
  disposition: 'operator-inspection-required' | 'retry-read-required';
  sourceBytesPreserved: true;
  automaticRepairAllowed: false;
  mutationAuthorityGranted: false;
}

/** Durable recovery intent marker. Its presence keeps strict callers fail-closed. */
export function daemonStateRecoveryMarkerPath(): string {
  return join(ashlrDir(), 'control', 'daemon-state-recovery', 'active.json');
}

export type SaveDaemonStateResult =
  | { ok: true; path: string }
  | { ok: false; path: string; error: string };

export interface DaemonSpendGuard {
  schemaVersion: 2;
  accountingId: string;
  token: string;
  pid: number;
  hostname: string;
  armedAt: string;
  daemonStartedAt: string | null;
  budgetDay: string;
  dailyBudgetUsd: number;
  spentUsdAtArm: number;
  reservedUsd: number;
  exhaustBudgetDay: boolean;
  itemIds: string[];
}

/** Strict shape written by releases before the v2 accounting identity. */
export interface LegacyDaemonSpendGuard {
  token: string;
  pid: number;
  hostname: string;
  armedAt: string;
  itemIds: string[];
}

export interface ArmDaemonSpendGuardInput {
  itemIds: string[];
  daemonStartedAt: string | null;
  budgetDay: string;
  dailyBudgetUsd: number;
  spentUsdAtArm: number;
  reservedUsd: number;
  now?: Date;
}

export type AccountDaemonSpendGuardResult =
  | { ok: true; state: DaemonState; alreadyAccounted: boolean }
  | { ok: false; error: string };

export type ReadDaemonSpendGuardResult =
  | { exists: false; path: string }
  | {
      exists: true;
      path: string;
      guard: DaemonSpendGuard | null;
      legacyGuard: LegacyDaemonSpendGuard | null;
      malformed: boolean;
      error?: string;
    };

export type ArmDaemonSpendGuardResult =
  | { ok: true; path: string; guard: DaemonSpendGuard }
  | { ok: false; path: string; error: string };

export type ClearDaemonSpendGuardResult =
  | { ok: true; path: string; cleared: boolean }
  | { ok: false; path: string; error: string };

export type UpgradeLegacyDaemonSpendGuardResult =
  | { ok: true; path: string; guard: DaemonSpendGuard }
  | { ok: false; path: string; error: string };

// ---------------------------------------------------------------------------
// Zeroed default state
// ---------------------------------------------------------------------------

function freshState(): DaemonState {
  return {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks: [],
  };
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalBudgetDay(value: unknown): value is string {
  if (typeof value !== 'string' || !BUDGET_DAY_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function strictSpendGuardAccountingIssues(
  value: unknown,
  todayDate: unknown,
): DaemonStateDiagnosticCode[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['spend-accounting-shape-invalid'];
  }
  const row = value as Record<string, unknown>;
  const expectedKeys = row['budgetExhausted'] === undefined
    ? ['accountingId', 'budgetDay']
    : ['accountingId', 'budgetDay', 'budgetExhausted'];
  const keys = Object.keys(row).sort();
  const issues: DaemonStateDiagnosticCode[] = [];
  if (keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index])) {
    issues.push('spend-accounting-keys-invalid');
  }
  if (!canonicalBudgetDay(row['budgetDay']) || row['budgetDay'] !== todayDate) {
    issues.push('spend-accounting-day-invalid');
  }
  if (typeof row['accountingId'] !== 'string' || !UUID_RE.test(row['accountingId'])) {
    issues.push('spend-accounting-id-invalid');
  }
  if (row['budgetExhausted'] !== undefined && typeof row['budgetExhausted'] !== 'boolean') {
    issues.push('spend-accounting-exhaustion-invalid');
  }
  return issues;
}

export function daemonStateIssueCodes(value: unknown): DaemonStateDiagnosticCode[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['invalid-root'];
  const obj = value as Record<string, unknown>;
  const issues: DaemonStateDiagnosticCode[] = [];
  const pid = obj['pid'];
  if (typeof obj['running'] !== 'boolean') issues.push('running-invalid');
  if (!(typeof pid === 'number' || pid === null)) issues.push('pid-invalid');
  if (!(typeof obj['startedAt'] === 'string' || obj['startedAt'] === null)) {
    issues.push('started-at-invalid');
  }
  if (!(typeof obj['lastTickAt'] === 'string' || obj['lastTickAt'] === null)) {
    issues.push('last-tick-at-invalid');
  }
  if (!(typeof obj['todayDate'] === 'string' || obj['todayDate'] === null)) {
    issues.push('budget-day-invalid');
  }
  if (typeof obj['todaySpentUsd'] !== 'number' || !Number.isFinite(obj['todaySpentUsd'])) {
    issues.push('spend-invalid');
  }
  if (typeof obj['itemsProcessed'] !== 'number' || !Number.isFinite(obj['itemsProcessed'])) {
    issues.push('items-processed-invalid');
  }
  if (!Array.isArray(obj['ticks'])) issues.push('ticks-invalid');
  if (obj['spendGuardAccounting'] !== undefined) {
    issues.push(...strictSpendGuardAccountingIssues(obj['spendGuardAccounting'], obj['todayDate']));
  }
  if (obj['automaticDrainOrdinaryTurnDue'] !== undefined &&
    typeof obj['automaticDrainOrdinaryTurnDue'] !== 'boolean') {
    issues.push('automatic-drain-flag-invalid');
  }
  return issues;
}

function recoveryDiagnostic(
  issueCodes: DaemonStateDiagnosticCode[],
  disposition: DaemonStateRecoveryDiagnostic['disposition'] = 'operator-inspection-required',
): DaemonStateRecoveryDiagnostic {
  return {
    schemaVersion: 1,
    issueCodes: [...new Set(issueCodes)].slice(0, 16),
    disposition,
    sourceBytesPreserved: true,
    automaticRepairAllowed: false,
    mutationAuthorityGranted: false,
  };
}

function parseDaemonState(
  raw: string,
  opts?: { strict?: boolean; preserveOwnerIdentity?: boolean },
): DaemonState | null {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (opts?.strict === true) {
    if (daemonStateIssueCodes(obj).length > 0) return null;
  }
  const state: DaemonState = {
    running: typeof obj['running'] === 'boolean' ? obj['running'] : false,
    pid:
      typeof obj['pid'] === 'number'
      ? obj['pid']
      : obj['pid'] === null
        ? null
        : null,
    startedAt:
      typeof obj['startedAt'] === 'string' ? obj['startedAt'] : null,
    lastTickAt:
      typeof obj['lastTickAt'] === 'string' ? obj['lastTickAt'] : null,
    todayDate:
      typeof obj['todayDate'] === 'string' ? obj['todayDate'] : null,
    todaySpentUsd:
      typeof obj['todaySpentUsd'] === 'number' ? obj['todaySpentUsd'] : 0,
    itemsProcessed:
      typeof obj['itemsProcessed'] === 'number' ? obj['itemsProcessed'] : 0,
    spendGuardAccounting: (() => {
      const accounting = obj['spendGuardAccounting'];
      if (typeof accounting !== 'object' || accounting === null || Array.isArray(accounting)) return undefined;
      const row = accounting as Record<string, unknown>;
      return canonicalBudgetDay(row['budgetDay']) &&
        typeof row['accountingId'] === 'string' && UUID_RE.test(row['accountingId'])
        ? {
            budgetDay: row['budgetDay'],
            accountingId: row['accountingId'],
            ...(row['budgetExhausted'] === true ? { budgetExhausted: true } : {}),
          }
        : undefined;
    })(),
    ticks: Array.isArray(obj['ticks'])
      ? (obj['ticks'] as unknown[]).filter(
          (t): t is DaemonState['ticks'][number] =>
            typeof t === 'object' &&
            t !== null &&
            !Array.isArray(t) &&
            typeof (t as Record<string, unknown>)['ts'] === 'string',
        )
      : [],
    automaticDrainOrdinaryTurnDue:
      typeof obj['automaticDrainOrdinaryTurnDue'] === 'boolean'
        ? obj['automaticDrainOrdinaryTurnDue']
        : undefined,
    lastPulseExportAt:
      typeof obj['lastPulseExportAt'] === 'string' ? obj['lastPulseExportAt'] : undefined,
  };
  return opts?.preserveOwnerIdentity === true ? state : reconcileDaemonState(state);
}

function ownedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function safeDaemonStateFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1 &&
    ownedByCurrentUser(stat) && (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function safeDaemonStateRecoveryMarkerFile(path: string, stat: Stats): boolean {
  // Recovery records are atomically published with a no-clobber hard link from
  // a private fsynced temp, so the authenticated final may intentionally have
  // two links until evidence retirement.
  const safe = stat.isFile() && !stat.isSymbolicLink() &&
    ownedByCurrentUser(stat) && (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
  if (!safe || ![1, 2].includes(Number(stat.nlink))) return false;
  if (Number(stat.nlink) === 1) return true;
  try {
    return readdirSync(dirname(path)).some((name) => {
      if (!name.startsWith(`.${basename(path)}.`) || !name.endsWith('.tmp')) return false;
      const candidate = lstatSync(join(dirname(path), name));
      return candidate.isFile() && !candidate.isSymbolicLink() && Number(candidate.nlink) === 2 &&
        ownedByCurrentUser(candidate) &&
        (process.platform === 'win32' || (Number(candidate.mode) & 0o022) === 0) &&
        sameFile(candidate, stat);
    });
  } catch {
    return false;
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read and parse daemonStatePath(). NEVER throws.
 * Returns a fresh zeroed DaemonState when the file is missing or malformed.
 */
export function loadDaemonState(): DaemonState {
  const p = daemonStatePath();
  if (!existsSync(p)) return freshState();
  try {
    const raw = readFileSync(p, 'utf8');
    return parseDaemonState(raw) ?? freshState();
  } catch {
    // Corrupt JSON or any other read error — return zeroed state.
    return freshState();
  }
}

/**
 * Strictly read daemonStatePath(). Missing state is a valid fresh state; malformed
 * or unreadable state is returned as an error so spend-sensitive callers can
 * fail closed instead of treating a broken ledger as zero spend.
 */
export function loadDaemonStateStrict(
  opts: { preserveOwnerIdentity?: boolean } = {},
): LoadDaemonStateStrictResult {
  const recoveryMarker = daemonStateRecoveryMarkerPath();
  try {
    const marker = lstatSync(recoveryMarker);
    return {
      ok: false,
      path: recoveryMarker,
      reason: 'unreadable',
      error: safeDaemonStateRecoveryMarkerFile(recoveryMarker, marker)
        ? 'daemon state recovery is in progress'
        : 'daemon state recovery marker path is unsafe',
      diagnostic: recoveryDiagnostic([
        safeDaemonStateRecoveryMarkerFile(recoveryMarker, marker) ? 'state-recovery-in-progress' : 'unsafe-storage',
      ]),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        path: recoveryMarker,
        reason: 'unreadable',
        error: msg,
        diagnostic: recoveryDiagnostic(['read-failed'], 'retry-read-required'),
      };
    }
  }
  const p = daemonStatePath();
  let named: Stats;
  try {
    named = lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, state: freshState(), fresh: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      path: p,
      reason: 'unreadable',
      error: msg,
      diagnostic: recoveryDiagnostic(['read-failed'], 'retry-read-required'),
    };
  }
  if (!safeDaemonStateFile(named)) {
    return {
      ok: false,
      path: p,
      reason: 'unreadable',
      error: 'daemon state path is unsafe',
      diagnostic: recoveryDiagnostic(['unsafe-storage']),
    };
  }
  let fd: number | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(p, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!safeDaemonStateFile(opened) || !sameFile(named, opened)) {
      return {
        ok: false,
        path: p,
        reason: 'unreadable',
        error: 'daemon state identity changed',
        diagnostic: recoveryDiagnostic(['source-changed-during-read'], 'retry-read-required'),
      };
    }
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (!safeDaemonStateFile(after) || !sameFile(opened, after) ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs) {
      return {
        ok: false,
        path: p,
        reason: 'unreadable',
        error: 'daemon state changed while being read',
        diagnostic: recoveryDiagnostic(['source-changed-during-read'], 'retry-read-required'),
      };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return {
        ok: false,
        path: p,
        reason: 'malformed',
        error: 'daemon state contains invalid JSON',
        diagnostic: recoveryDiagnostic(['invalid-json']),
      };
    }
    const issueCodes = daemonStateIssueCodes(decoded);
    if (issueCodes.length > 0) {
      return {
        ok: false,
        path: p,
        reason: 'malformed',
        error: `daemon state failed strict validation: ${issueCodes.join(', ')}`,
        diagnostic: recoveryDiagnostic(issueCodes),
      };
    }
    const state = parseDaemonState(raw, {
      strict: true,
      preserveOwnerIdentity: opts.preserveOwnerIdentity === true,
    });
    if (!state) {
      return {
        ok: false,
        path: p,
        reason: 'malformed',
        error: 'daemon state failed strict validation',
        diagnostic: recoveryDiagnostic(['invalid-root']),
      };
    }
    return { ok: true, state, fresh: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = msg.includes('JSON') || msg.includes('Unexpected') || msg.includes('position')
      ? 'malformed'
      : 'unreadable';
    return {
      ok: false,
      path: p,
      reason,
      error: msg,
      diagnostic: recoveryDiagnostic(
        [reason === 'malformed' ? 'invalid-json' : 'read-failed'],
        reason === 'unreadable' ? 'retry-read-required' : 'operator-inspection-required',
      ),
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close after the read result is already known.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Save (atomic)
// ---------------------------------------------------------------------------

function ensureAshlrDirDurable(): string {
  const dir = ashlrDir();
  const created = !existsSync(dir);
  if (created) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Persist the new ~/.ashlr directory entry before relying on files in it.
    fsyncDirectory(dirname(dir));
  }
  return dir;
}

function writeAll(fd: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error('daemon persistence write made no progress');
    offset += written;
  }
}

/** File fsync -> atomic rename -> platform-aware parent directory fsync. */
function writeDurableReplacement(path: string, value: string): void {
  const dir = ensureAshlrDirDurable();
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    writeAll(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    published = true;
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (!published) {
      try { unlinkSync(tmp); } catch { /* absent or indeterminate temporary */ }
    }
  }
}

/** Exclusive target create with file and parent-directory persistence barriers. */
function writeDurableExclusive(path: string, value: string): void {
  const dir = ensureAshlrDirDurable();
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    writeAll(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve fail-closed guard evidence */ }
    }
  }
}

/**
 * Atomically write DaemonState to daemonStatePath() via tmp-file + rename
 * (POSIX-atomic). Creates ~/.ashlr if needed. Never throws.
 */
export function saveDaemonState(s: DaemonState): void {
  saveDaemonStateResult(s);
}

/** Like saveDaemonState(), but reports persistence failures to fail-closed callers. */
export function saveDaemonStateResult(s: DaemonState): SaveDaemonStateResult {
  const dest = daemonStatePath();
  try {
    // Bound ticks history before persisting.
    const bounded: DaemonState = {
      ...s,
      ticks: s.ticks.slice(-MAX_TICKS),
    };
    writeDurableReplacement(dest, JSON.stringify(bounded, null, 2) + '\n');
    return { ok: true, path: dest };
  } catch (err) {
    // Persistence failure must not crash the daemon — swallow silently.
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: dest, error: msg };
  }
}

function parseSpendGuard(raw: string): DaemonSpendGuard | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const expectedKeys = [
      'accountingId', 'armedAt', 'budgetDay', 'daemonStartedAt', 'dailyBudgetUsd', 'exhaustBudgetDay',
      'hostname', 'itemIds', 'pid', 'reservedUsd', 'schemaVersion', 'spentUsdAtArm', 'token',
    ].sort();
    const itemIds = obj['itemIds'];
    if (
      keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
      obj['schemaVersion'] !== 2 ||
      typeof obj['accountingId'] !== 'string' || !UUID_RE.test(obj['accountingId']) ||
      typeof obj['token'] !== 'string' || !UUID_RE.test(obj['token']) ||
      !Number.isSafeInteger(obj['pid']) || (obj['pid'] as number) <= 0 ||
      typeof obj['hostname'] !== 'string' || obj['hostname'].length === 0 || obj['hostname'].length > 255 ||
      !canonicalTimestamp(obj['armedAt']) ||
      !(obj['daemonStartedAt'] === null || canonicalTimestamp(obj['daemonStartedAt'])) ||
      (typeof obj['daemonStartedAt'] === 'string' &&
        Date.parse(obj['daemonStartedAt']) > Date.parse(obj['armedAt'])) ||
      !canonicalBudgetDay(obj['budgetDay']) || obj['budgetDay'] !== obj['armedAt'].slice(0, 10) ||
      typeof obj['dailyBudgetUsd'] !== 'number' || !Number.isFinite(obj['dailyBudgetUsd']) ||
      obj['dailyBudgetUsd'] <= 0 ||
      typeof obj['spentUsdAtArm'] !== 'number' || !Number.isFinite(obj['spentUsdAtArm']) ||
      obj['spentUsdAtArm'] < 0 || obj['spentUsdAtArm'] > obj['dailyBudgetUsd'] ||
      typeof obj['reservedUsd'] !== 'number' || !Number.isFinite(obj['reservedUsd']) || obj['reservedUsd'] < 0 ||
      obj['reservedUsd'] > obj['dailyBudgetUsd'] - obj['spentUsdAtArm'] ||
      typeof obj['exhaustBudgetDay'] !== 'boolean' ||
      !Array.isArray(itemIds) || itemIds.length > DAEMON_SPEND_GUARD_ITEM_CAPACITY ||
      !itemIds.every((id) => typeof id === 'string' && id.length > 0 &&
        Buffer.byteLength(id, 'utf8') <= MAX_SPEND_GUARD_ITEM_ID_BYTES) ||
      new Set(itemIds).size !== itemIds.length ||
      (itemIds.length === 0 && obj['reservedUsd'] !== 0)
    ) {
      return null;
    }
    return {
      schemaVersion: 2,
      accountingId: obj['accountingId'],
      token: obj['token'],
      pid: obj['pid'] as number,
      hostname: obj['hostname'],
      armedAt: obj['armedAt'],
      daemonStartedAt: obj['daemonStartedAt'] as string | null,
      budgetDay: obj['budgetDay'],
      dailyBudgetUsd: obj['dailyBudgetUsd'],
      spentUsdAtArm: obj['spentUsdAtArm'],
      reservedUsd: obj['reservedUsd'],
      exhaustBudgetDay: obj['exhaustBudgetDay'],
      itemIds: [...itemIds],
    };
  } catch {
    return null;
  }
}

function parseLegacySpendGuard(raw: string): LegacyDaemonSpendGuard | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const expectedKeys = ['armedAt', 'hostname', 'itemIds', 'pid', 'token'].sort();
    const itemIds = obj['itemIds'];
    if (
      keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
      typeof obj['token'] !== 'string' || obj['token'].length === 0 || obj['token'].length > 256 ||
      !Number.isSafeInteger(obj['pid']) || (obj['pid'] as number) <= 0 ||
      typeof obj['hostname'] !== 'string' || obj['hostname'].length === 0 || obj['hostname'].length > 255 ||
      !canonicalTimestamp(obj['armedAt']) ||
      !Array.isArray(itemIds) || itemIds.length === 0 ||
      itemIds.length > DAEMON_SPEND_GUARD_ITEM_CAPACITY ||
      !itemIds.every((id) => typeof id === 'string' && id.length > 0 &&
        Buffer.byteLength(id, 'utf8') <= MAX_SPEND_GUARD_ITEM_ID_BYTES) ||
      new Set(itemIds).size !== itemIds.length
    ) return null;
    return {
      token: obj['token'],
      pid: obj['pid'] as number,
      hostname: obj['hostname'],
      armedAt: obj['armedAt'],
      itemIds: [...itemIds],
    };
  } catch {
    return null;
  }
}

export function readDaemonSpendGuard(): ReadDaemonSpendGuardResult {
  const p = daemonSpendGuardPath();
  if (!existsSync(p)) return { exists: false, path: p };
  try {
    const raw = readFileSync(p, 'utf8');
    const guard = parseSpendGuard(raw);
    const legacyGuard = guard ? null : parseLegacySpendGuard(raw);
    return { exists: true, path: p, guard, legacyGuard, malformed: guard === null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exists: true, path: p, guard: null, legacyGuard: null, malformed: true, error: msg };
  }
}

export function armDaemonSpendGuard(input: ArmDaemonSpendGuardInput): ArmDaemonSpendGuardResult {
  const p = daemonSpendGuardPath();
  try {
    const armedAt = (input.now ?? new Date()).toISOString();
    const guard: DaemonSpendGuard = {
      schemaVersion: 2,
      accountingId: randomUUID(),
      token: randomUUID(),
      pid: process.pid,
      hostname: osHostname(),
      armedAt,
      daemonStartedAt: input.daemonStartedAt,
      budgetDay: input.budgetDay,
      dailyBudgetUsd: input.dailyBudgetUsd,
      spentUsdAtArm: input.spentUsdAtArm,
      reservedUsd: input.reservedUsd,
      exhaustBudgetDay: false,
      itemIds: [...input.itemIds],
    };
    if (!parseSpendGuard(`${JSON.stringify(guard)}\n`)) {
      return { ok: false, path: p, error: 'invalid daemon spend guard input' };
    }
    writeDurableExclusive(p, JSON.stringify(guard, null, 2) + '\n');
    return { ok: true, path: p, guard };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: p, error: msg };
  }
}

/** Replace one exact recognized v1 guard with a crash-recoverable v2 guard. */
export function upgradeLegacyDaemonSpendGuard(
  expected: LegacyDaemonSpendGuard,
  input: Omit<ArmDaemonSpendGuardInput, 'itemIds' | 'now'>,
): UpgradeLegacyDaemonSpendGuardResult {
  const p = daemonSpendGuardPath();
  try {
    const current = readDaemonSpendGuard();
    if (!current.exists || !current.legacyGuard ||
      JSON.stringify(current.legacyGuard) !== JSON.stringify(expected)) {
      return { ok: false, path: p, error: 'legacy spend guard changed before upgrade' };
    }
    const guard: DaemonSpendGuard = {
      schemaVersion: 2,
      accountingId: randomUUID(),
      token: randomUUID(),
      pid: expected.pid,
      hostname: expected.hostname,
      armedAt: expected.armedAt,
      daemonStartedAt: input.daemonStartedAt,
      budgetDay: input.budgetDay,
      dailyBudgetUsd: input.dailyBudgetUsd,
      spentUsdAtArm: input.spentUsdAtArm,
      reservedUsd: input.reservedUsd,
      exhaustBudgetDay: true,
      itemIds: [...expected.itemIds],
    };
    if (!parseSpendGuard(`${JSON.stringify(guard)}\n`)) {
      return { ok: false, path: p, error: 'legacy spend guard upgrade evidence is invalid' };
    }
    writeDurableReplacement(p, JSON.stringify(guard, null, 2) + '\n');
    return { ok: true, path: p, guard };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: p, error: msg };
  }
}

/**
 * Charge one exact v2 guard identity at most once for its UTC budget day.
 * This is pure: callers must persist the returned state while holding daemon
 * ownership before clearing the guard.
 */
export function accountDaemonSpendGuard(
  state: DaemonState,
  guard: DaemonSpendGuard,
  spentUsd: number,
): AccountDaemonSpendGuardResult {
  if (!Number.isFinite(spentUsd) || spentUsd < 0) {
    return { ok: false, error: 'spend guard accounting amount is invalid' };
  }
  if (state.todayDate !== guard.budgetDay) {
    return { ok: false, error: 'spend guard budget day does not match daemon state' };
  }
  if (state.startedAt !== guard.daemonStartedAt) {
    return { ok: false, error: 'spend guard daemon identity does not match daemon state' };
  }
  const accounting = state.spendGuardAccounting;
  if (accounting && accounting.budgetDay !== guard.budgetDay) {
    return { ok: false, error: 'spend guard accounting day conflicts with daemon state' };
  }
  if (accounting?.accountingId === guard.accountingId) {
    return { ok: true, state, alreadyAccounted: true };
  }
  if (state.todaySpentUsd !== guard.spentUsdAtArm) {
    return { ok: false, error: 'spend guard prior accounting total does not match daemon state' };
  }
  const todaySpentUsd = state.todaySpentUsd + spentUsd;
  if (!Number.isFinite(todaySpentUsd) || todaySpentUsd < state.todaySpentUsd) {
    return { ok: false, error: 'spend guard accounting total is invalid' };
  }
  return {
    ok: true,
    alreadyAccounted: false,
    state: {
      ...state,
      todaySpentUsd,
      spendGuardAccounting: {
        budgetDay: guard.budgetDay,
        accountingId: guard.accountingId,
        ...(guard.exhaustBudgetDay ? { budgetExhausted: true } : {}),
      },
    },
  };
}

export function clearDaemonSpendGuard(token: string): ClearDaemonSpendGuardResult {
  const p = daemonSpendGuardPath();
  const current = readDaemonSpendGuard();
  if (!current.exists) return { ok: true, path: p, cleared: false };
  if (!current.guard || current.guard.token !== token) {
    return { ok: false, path: p, error: 'spend guard token mismatch or malformed guard' };
  }
  try {
    unlinkSync(p);
    fsyncDirectory(dirname(p));
    return { ok: true, path: p, cleared: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: p, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Daemon singleton lock (cross-process, same machine)
// ---------------------------------------------------------------------------

function makeLockOwner(token: string, nowIso: string): DaemonLockOwner {
  return {
    pid: process.pid,
    token,
    hostname: osHostname(),
    acquiredAt: nowIso,
    heartbeatAt: nowIso,
  };
}

function parseLockOwner(raw: string): DaemonLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj['pid'] !== 'number' ||
      typeof obj['token'] !== 'string' ||
      typeof obj['hostname'] !== 'string' ||
      typeof obj['acquiredAt'] !== 'string' ||
      typeof obj['heartbeatAt'] !== 'string'
    ) {
      return null;
    }
    return {
      pid: obj['pid'],
      token: obj['token'],
      hostname: obj['hostname'],
      acquiredAt: obj['acquiredAt'],
      heartbeatAt: obj['heartbeatAt'],
    };
  } catch {
    return null;
  }
}

export function readDaemonLockOwner(): DaemonLockOwner | null {
  try {
    return parseLockOwner(readFileSync(daemonLockPath(), 'utf8'));
  } catch {
    return null;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code !== 'ESRCH';
  }
}

function lockIsSafelyStale(owner: DaemonLockOwner | null, _staleMs: number): boolean {
  if (!owner || !Number.isFinite(owner.pid) || owner.pid <= 0) return true;
  if (pidExists(owner.pid)) return false;
  return true;
}

function writeNewLock(path: string, owner: DaemonLockOwner): void {
  writeFileSync(path, JSON.stringify(owner, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
}

interface DaemonLockSnapshot {
  dev: number;
  ino: number;
  raw: string;
  owner: DaemonLockOwner | null;
}

function readDaemonLockSnapshot(path: string): DaemonLockSnapshot | null {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const raw = readFileSync(path, 'utf8');
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) return null;
    return { dev: after.dev, ino: after.ino, raw, owner: parseLockOwner(raw) };
  } catch {
    return null;
  }
}

function sameDaemonLockSnapshot(
  expected: DaemonLockSnapshot,
  current: DaemonLockSnapshot | null,
): boolean {
  return current !== null &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.raw === expected.raw &&
    current.owner?.token === expected.owner?.token;
}

function daemonLockMutationPath(path: string): string {
  return `${path}.mutation.lock`;
}

/**
 * Acquire the same-machine daemon singleton lock.
 *
 * Uses an O_EXCL create so independent `ashlr daemon start` processes cannot
 * both enter the operator loop. A dead-owner lock is reclaimed immediately once
 * the recorded pid is gone; a live pid is always treated as busy to fail closed
 * for slow or stuck live daemons.
 */
export function acquireDaemonLock(opts?: { staleMs?: number }): AcquireDaemonLockResult {
  const path = daemonLockPath();
  const dir = ashlrDir();
  const staleMs = Math.max(0, opts?.staleMs ?? DEFAULT_LOCK_STALE_MS);
  const token = randomUUID();
  const owner = makeLockOwner(token, new Date().toISOString());
  const mutationLock = acquireLocalStoreLock(daemonLockMutationPath(path));
  if (!mutationLock) {
    return { acquired: false, path, owner: readDaemonLockOwner(), reason: 'busy' };
  }

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeNewLock(path, owner);
    return { acquired: true, lock: { path, token, pid: process.pid }, owner, replacedStale: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'EEXIST') {
      return { acquired: false, path, owner: null, reason: 'io-error' };
    }

    const snapshot = readDaemonLockSnapshot(path);
    const existing = snapshot?.owner ?? readDaemonLockOwner();
    if (!snapshot || !lockIsSafelyStale(existing, staleMs)) {
      return { acquired: false, path, owner: existing, reason: 'busy' };
    }

    const current = readDaemonLockSnapshot(path);
    if (!sameDaemonLockSnapshot(snapshot, current)) {
      return { acquired: false, path, owner: current?.owner ?? readDaemonLockOwner(), reason: 'busy' };
    }

    try {
      unlinkSync(path);
      writeNewLock(path, owner);
      return { acquired: true, lock: { path, token, pid: process.pid }, owner, replacedStale: true };
    } catch (reclaimErr) {
      const reclaimCode = (reclaimErr as NodeJS.ErrnoException | undefined)?.code;
      return {
        acquired: false,
        path,
        owner: readDaemonLockOwner(),
        reason: reclaimCode === 'EEXIST' ? 'busy' : 'io-error',
      };
    }
  } finally {
    releaseLocalStoreLock(mutationLock);
  }
}

/** Update the heartbeat for the current lock owner; returns false if ownership was lost. */
export function heartbeatDaemonLock(lock: DaemonLock): boolean {
  const mutationLock = acquireLocalStoreLock(daemonLockMutationPath(lock.path));
  if (!mutationLock) return false;
  try {
    const current = readDaemonLockOwner();
    if (!current || current.pid !== lock.pid || current.token !== lock.token) return false;
    const next: DaemonLockOwner = { ...current, heartbeatAt: new Date().toISOString() };
    const tmp = `${lock.path}.${lock.token}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, lock.path);
    return true;
  } catch {
    return false;
  } finally {
    releaseLocalStoreLock(mutationLock);
  }
}

/** Release the daemon lock only if this process still owns the same token. */
export function releaseDaemonLock(lock: DaemonLock): boolean {
  const mutationLock = acquireLocalStoreLock(daemonLockMutationPath(lock.path));
  if (!mutationLock) return false;
  try {
    const snapshot = readDaemonLockSnapshot(lock.path);
    const current = snapshot?.owner;
    if (!snapshot || !current || current.pid !== lock.pid || current.token !== lock.token) {
      return false;
    }
    if (!sameDaemonLockSnapshot(snapshot, readDaemonLockSnapshot(lock.path))) return false;
    unlinkSync(lock.path);
    return true;
  } catch {
    return false;
  } finally {
    releaseLocalStoreLock(mutationLock);
  }
}

// ---------------------------------------------------------------------------
// Daily budget reset
// ---------------------------------------------------------------------------

/**
 * If s.todayDate differs from today's YYYY-MM-DD, return a copy with
 * todayDate set to today and todaySpentUsd reset to 0 (daily budget reset).
 * itemsProcessed and ticks are preserved.
 *
 * Pure-ish: returns the (possibly new) state; caller is responsible for
 * persisting via saveDaemonState().
 */
export function resetDayIfNeeded(s: DaemonState): DaemonState {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (s.todayDate === today) return s;
  return {
    ...s,
    todayDate: today,
    todaySpentUsd: 0,
    spendGuardAccounting: undefined,
  };
}

// ---------------------------------------------------------------------------
// Stale-daemon reconciliation (H5 — OBSERVABILITY-ONLY liveness check)
// ---------------------------------------------------------------------------

/**
 * READ-ONLY liveness reconcile. If `s.running === true` but the recorded `pid`
 * is NOT alive — `process.kill(pid, 0)` throws `ESRCH` (no such process) — flip
 * `running` to false and `pid` to null so `daemon status` reports a dead daemon
 * as stopped. Otherwise return `s` unchanged.
 *
 * HONEST BOUND (pid reuse): this reports a dead daemon as live ONLY in the rare
 * case where the OS recycled the recorded pid for an unrelated live process
 * (then `process.kill(pid,0)` succeeds and we leave the state unchanged) —
 * inherent to pid-0 liveness. In every other case it is truthful. It is
 * conservative-toward-alive (it NEVER force-flips a genuinely running daemon
 * off), and since it changes no spend/guard the residual false-positive is an
 * observability nicety only, never a safety issue.
 *
 * OBSERVABILITY-ONLY by construction: it touches NO spend accounting
 * (`todaySpentUsd` / `itemsProcessed` / `ticks` are preserved byte-for-byte),
 * NO guard (kill switch / enrollment / sandbox are unaffected), and adds NO
 * capability. It only makes the persisted running/pid pair truthful.
 *
 * Liveness rules (conservative — NEVER destroy a real running daemon's state):
 *  - `running !== true` or `pid` not a number => nothing to reconcile => unchanged.
 *  - `process.kill(pid, 0)` succeeds => process alive => unchanged.
 *  - throws `ESRCH` => process is GONE => flip to { running:false, pid:null }.
 *  - throws `EPERM` (exists but not signalable by us) => process EXISTS => alive
 *    => unchanged (do NOT flip).
 *  - any other/unexpected error => treat as alive => unchanged.
 *
 * Pure-ish: returns the (possibly new) state; caller persists via
 * saveDaemonState(). Never throws.
 */
export function reconcileDaemonState(s: DaemonState): DaemonState {
  if (s.running !== true || typeof s.pid !== 'number') {
    return s;
  }
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(s.pid, 0);
    // No throw => the process exists and is signalable => treat as alive.
    return s;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ESRCH') {
      // No such process — the daemon is dead. Flip to a truthful stopped state.
      return { ...s, running: false, pid: null };
    }
    // EPERM (exists, not ours) or any other error => conservatively alive.
    return s;
  }
}
