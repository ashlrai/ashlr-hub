/**
 * worked-ledger.ts — M85: per-item worked-outcome ledger.
 *
 * Tracks whether each WorkItem produced a real diff ('diff') or an empty run
 * ('empty') so the daemon can skip recently-declined items and avoid re-clogging
 * on work that has already been attempted with no result.
 *
 * Persistence discipline:
 *  - Atomic writes from exclusive, no-follow private temp files.
 *  - Every mutation is serialized and bound to one verified fleet directory.
 *  - Recovery replay additionally requires durable directory publication.
 *  - NEVER throws — load returns a fresh empty ledger on missing/corrupt file;
 *    record swallows any persistence error.
 *  - Ordinary recording securely creates missing private storage on first use.
 *  - Bounded history (last ~2000 entries).
 *  - Homedir re-resolved at call time so tests can relocate HOME.
 *
 * No new runtime deps; node builtins only.
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
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkItem } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  readDispatchProductionParents,
  type DispatchProductionParentIdentity,
} from './dispatch-production-ledger.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of outcome events retained in worked.json. */
const MAX_EVENTS = 2000;
const MAX_WORKED_LEDGER_BYTES = 2 * 1024 * 1024;

/** Default cooldown window: 6 hours in milliseconds. */
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const GENERATED_REPAIR_DISPATCH_BLOCKED_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * The outcome of a single item run or judge verdict.
 *
 * - 'diff'            — run produced a real diff (work done).
 * - 'empty'           — run produced no diff (nothing to do right now).
 * - 'judged-review'   — judge returned 'review' (needs human inspection).
 * - 'judged-noise'    — judge returned 'noise' (trivial / not worth it).
 * - 'judged-decline'  — judge returned 'harmful' or 'decline' (rejected).
 * - 'dispatch-blocked' — selected work did not reach an executor; retry later.
 *
 * Any judged-* outcome suppresses the item for the cooldown window the same
 * way 'empty' does, preventing the "CI is failing" re-clog loop.
 */
export type WorkedOutcome =
  | 'diff'
  | 'empty'
  | 'dispatch-blocked'
  | 'judged-review'
  | 'judged-noise'
  | 'judged-decline';

/** A single recorded item outcome. */
export interface WorkedEvent {
  /** The WorkItem id that was run. */
  itemId: string;
  /** Whether the run produced a real diff ('diff') or nothing ('empty'). */
  outcome: WorkedOutcome;
  /** ISO timestamp of the outcome. */
  ts: string;
  /** Rejected proposal already swept into this outcome, when applicable. */
  proposalId?: string;
  /** Exact shared-claim completion marker for indeterminate-commit readback. */
  claimCompletionId?: string;
}

/** The persisted worked ledger. */
export interface WorkedLedger {
  /** Bounded list of recent outcome events (oldest first). */
  events: WorkedEvent[];
}

export type WorkedOutcomeReplayResult =
  | 'recorded'
  | 'already-recorded'
  | 'dispatch-receipt-unavailable'
  | 'invalid'
  | 'persistence-failed';

export interface WorkedOutcomeReplay {
  itemId: string;
  outcome: WorkedOutcome;
  dispatchReceipt: DispatchProductionParentIdentity;
}

interface WorkedLedgerTestHooks {
  afterReplayLoad?: () => void;
  beforePublication?: (temporaryPath: string) => void;
  strictDirectoryDurability?: (directoryPath: string) => boolean;
}

let workedLedgerTestHooks: WorkedLedgerTestHooks | undefined;

export function _setWorkedLedgerHooksForTest(hooks: WorkedLedgerTestHooks | undefined): void {
  workedLedgerTestHooks = hooks;
}

export function isWorkedOutcome(outcome: unknown): outcome is WorkedOutcome {
  return (
    outcome === 'diff' ||
    outcome === 'empty' ||
    outcome === 'dispatch-blocked' ||
    outcome === 'judged-review' ||
    outcome === 'judged-noise' ||
    outcome === 'judged-decline'
  );
}

export function isSuppressibleWorkedOutcome(outcome: WorkedOutcome): boolean {
  return outcome === 'empty' ||
    outcome === 'dispatch-blocked' ||
    outcome === 'judged-review' ||
    outcome === 'judged-noise' ||
    outcome === 'judged-decline';
}

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function fleetDir(): string {
  return join(homedir(), '.ashlr', 'fleet');
}

/** Absolute path to the fleet worked ledger file. */
export function workedLedgerPath(): string {
  return join(fleetDir(), 'worked.json');
}

// ---------------------------------------------------------------------------
// Fresh default
// ---------------------------------------------------------------------------

function freshLedger(): WorkedLedger {
  return { events: [] };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read and parse workedLedgerPath(). NEVER throws.
 * Returns a fresh empty ledger when the file is missing or malformed.
 */
export function loadWorkedLedger(): WorkedLedger {
  const p = workedLedgerPath();
  if (!existsSync(p)) return freshLedger();
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return freshLedger();
    }
    const obj = parsed as Record<string, unknown>;
    const events = Array.isArray(obj['events'])
      ? (obj['events'] as unknown[]).filter(
          (e): e is WorkedEvent =>
            typeof e === 'object' &&
            e !== null &&
            !Array.isArray(e) &&
            typeof (e as Record<string, unknown>)['itemId'] === 'string' &&
            typeof (e as Record<string, unknown>)['ts'] === 'string' &&
            isWorkedOutcome((e as Record<string, unknown>)['outcome']),
        )
        .map((e) => {
          const raw = e as unknown as Record<string, unknown>;
          return {
            itemId: e.itemId,
            outcome: e.outcome,
            ts: e.ts,
            ...(typeof raw['proposalId'] === 'string' ? { proposalId: raw['proposalId'] } : {}),
            ...(typeof raw['claimCompletionId'] === 'string'
              ? { claimCompletionId: raw['claimCompletionId'] }
              : {}),
          };
        })
      : [];
    return { events };
  } catch {
    // Corrupt JSON or any other read error — return a fresh empty ledger.
    return freshLedger();
  }
}

// ---------------------------------------------------------------------------
// Bound read + atomic publication — internal
// ---------------------------------------------------------------------------

interface WorkedDirectoryAuthority {
  path: string;
  dev: bigint;
  ino: bigint;
}

type WorkedDestinationSnapshot =
  | { state: 'missing' }
  | { state: 'present'; dev: bigint; ino: bigint; bytes: Buffer };

interface LoadedWorkedLedger {
  ledger: WorkedLedger;
  destination: WorkedDestinationSnapshot;
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

function safeWorkedDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function safeWorkedFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function pinWorkedDirectory(): WorkedDirectoryAuthority | null {
  try {
    const path = fleetDir();
    const stat = lstatSync(path, { bigint: true });
    return safeWorkedDirectory(stat) ? { path, dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function missingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function pinSafeDirectory(path: string): WorkedDirectoryAuthority | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return safeWorkedDirectory(stat) ? { path, dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function createOrPinPrivateChild(
  parent: WorkedDirectoryAuthority,
  name: string,
): WorkedDirectoryAuthority | null {
  if (!name || name === '.' || name === '..' || name.includes(sep) ||
    !stableWorkedDirectory(parent)) return null;
  const path = join(parent.path, name);
  let created = false;
  try {
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    const child = pinSafeDirectory(path);
    if (child === null || !stableWorkedDirectory(parent)) return null;
    if (process.platform !== 'win32') {
      const realParent = realpathSync(parent.path);
      if (realpathSync(dirname(path)) !== realParent ||
        realpathSync(path) !== join(realParent, name)) return null;
    }
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      path,
      'directory',
      created ? 'secure-created' : 'inspect-owned',
      { anchorPath: parent.path },
    ).ok) return null;
    if (created) fsyncDirectory(parent.path, { expectedIdentity: parent });
    return stableWorkedDirectory(parent) && stableWorkedDirectory(child) ? child : null;
  } catch {
    return null;
  }
}

function ensureWorkedDirectoryForOrdinaryWrite(): boolean {
  try {
    const home = homedir();
    if (!isAbsolute(home) || resolve(home) !== home) return false;
    let anchorPath = home;
    const missingComponents: string[] = ['.ashlr', 'fleet'];
    while (true) {
      const anchor = pinSafeDirectory(anchorPath);
      if (anchor !== null) {
        let authority = anchor;
        const nested = relative(anchor.path, home);
        if (nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested)) return false;
        const components = [
          ...(nested === '' ? [] : nested.split(sep)),
          ...missingComponents,
        ];
        for (const component of components) {
          const child = createOrPinPrivateChild(authority, component);
          if (child === null) return false;
          authority = child;
        }
        return authority.path === fleetDir() && stableWorkedDirectory(authority);
      }
      try {
        lstatSync(anchorPath, { bigint: true });
      } catch (error) {
        if (!missingPath(error)) return false;
        const parent = dirname(anchorPath);
        if (parent === anchorPath) return false;
        anchorPath = parent;
        continue;
      }
      // Existing unsafe components include symlinks, reparse points, foreign
      // ownership, and group/world-writable directories. Never mutate them.
      return false;
    }
  } catch {
    return false;
  }
}

function stableWorkedDirectory(authority: WorkedDirectoryAuthority): boolean {
  try {
    const stat = lstatSync(authority.path, { bigint: true });
    return safeWorkedDirectory(stat) && sameIdentity(authority, stat);
  } catch {
    return false;
  }
}

function strictFsyncWorkedDirectory(authority: WorkedDirectoryAuthority): boolean {
  const injected = workedLedgerTestHooks?.strictDirectoryDurability;
  if (injected) return injected(authority.path) && stableWorkedDirectory(authority);
  let fd: number | undefined;
  try {
    if (!stableWorkedDirectory(authority)) return false;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const directory = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
    fd = openSync(authority.path, fsConstants.O_RDONLY | noFollow | directory);
    const opened = fstatSync(fd, { bigint: true });
    if (!safeWorkedDirectory(opened) || !sameIdentity(authority, opened)) return false;
    fsyncSync(fd);
    return stableWorkedDirectory(authority);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function readBoundWorkedFile(
  authority: WorkedDirectoryAuthority,
): { found: false } | { found: true; bytes: Buffer; dev: bigint; ino: bigint } | null {
  if (!stableWorkedDirectory(authority)) return null;
  const path = join(authority.path, 'worked.json');
  let named: BigIntStats;
  try {
    named = lstatSync(path, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && stableWorkedDirectory(authority)
      ? { found: false }
      : null;
  }
  if (!safeWorkedFile(named) || named.size > BigInt(MAX_WORKED_LEDGER_BYTES)) return null;
  let fd: number | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    if (!safeWorkedFile(opened) || !sameIdentity(named, opened) ||
      opened.size > BigInt(MAX_WORKED_LEDGER_BYTES)) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!safeWorkedFile(openedAfter) || !safeWorkedFile(namedAfter) ||
      !sameIdentity(opened, openedAfter) || !sameIdentity(openedAfter, namedAfter) ||
      openedAfter.size !== opened.size || openedAfter.mtimeNs !== opened.mtimeNs ||
      openedAfter.ctimeNs !== opened.ctimeNs ||
      !stableWorkedDirectory(authority)) return null;
    return { found: true, bytes, dev: opened.dev, ino: opened.ino };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function parseWorkedLedger(raw: string, strict: boolean): WorkedLedger | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const ledgerRecord = parsed as Record<string, unknown>;
    if (!Array.isArray(ledgerRecord['events']) ||
      (strict && Object.keys(ledgerRecord).some((key) => key !== 'events'))) return null;
    const events: WorkedEvent[] = [];
    for (const event of ledgerRecord['events']) {
      if (typeof event !== 'object' || event === null || Array.isArray(event)) {
        if (strict) return null;
        continue;
      }
      const record = event as Record<string, unknown>;
      if ((strict && Object.keys(record).some((key) =>
        key !== 'itemId' && key !== 'outcome' && key !== 'ts' &&
        key !== 'proposalId' && key !== 'claimCompletionId')) ||
        typeof record['itemId'] !== 'string' || typeof record['ts'] !== 'string' ||
        !isWorkedOutcome(record['outcome']) ||
        (record['proposalId'] !== undefined && typeof record['proposalId'] !== 'string') ||
        (record['claimCompletionId'] !== undefined && typeof record['claimCompletionId'] !== 'string')) {
        if (strict) return null;
        continue;
      }
      events.push({
        itemId: record['itemId'],
        outcome: record['outcome'],
        ts: record['ts'],
        ...(typeof record['proposalId'] === 'string' ? { proposalId: record['proposalId'] } : {}),
        ...(typeof record['claimCompletionId'] === 'string'
          ? { claimCompletionId: record['claimCompletionId'] }
          : {}),
      });
    }
    if (strict && events.length > MAX_EVENTS) return null;
    return { events };
  } catch {
    return null;
  }
}

function loadBoundWorkedLedger(
  authority: WorkedDirectoryAuthority,
  strict: boolean,
): LoadedWorkedLedger | null {
  const loaded = readBoundWorkedFile(authority);
  if (loaded === null) return null;
  if (!loaded.found) {
    return { ledger: freshLedger(), destination: { state: 'missing' } };
  }
  const ledger = parseWorkedLedger(loaded.bytes.toString('utf8'), strict) ??
    (strict ? null : freshLedger());
  return ledger === null ? null : {
    ledger,
    destination: {
      state: 'present',
      dev: loaded.dev,
      ino: loaded.ino,
      bytes: loaded.bytes,
    },
  };
}

function destinationMatchesSnapshot(
  authority: WorkedDirectoryAuthority,
  expected: WorkedDestinationSnapshot,
): boolean {
  const current = readBoundWorkedFile(authority);
  if (current === null) return false;
  if (expected.state === 'missing') return !current.found;
  return current.found && current.dev === expected.dev && current.ino === expected.ino &&
    current.bytes.equals(expected.bytes);
}

function exactWorkedTemporary(
  authority: WorkedDirectoryAuthority,
  path: string,
  identity: BigIntStats,
  fd: number,
  expectedSize: number,
): boolean {
  try {
    if (!stableWorkedDirectory(authority)) return false;
    const named = lstatSync(path, { bigint: true });
    const opened = fstatSync(fd, { bigint: true });
    return safeWorkedFile(named) && safeWorkedFile(opened) &&
      sameIdentity(identity, named) && sameIdentity(identity, opened) &&
      opened.size === BigInt(expectedSize) && stableWorkedDirectory(authority);
  } catch {
    return false;
  }
}

function cleanupExactWorkedTemporary(
  authority: WorkedDirectoryAuthority,
  path: string | undefined,
  identity: BigIntStats | undefined,
): void {
  if (!path || !identity || !stableWorkedDirectory(authority)) return;
  try {
    const named = lstatSync(path, { bigint: true });
    if (safeWorkedFile(named) && sameIdentity(named, identity)) unlinkSync(path);
  } catch {
    // The exact temporary is gone or the authority path changed; do not chase it.
  }
}

/** Publish under one pinned directory identity. Replay additionally requires strict directory fsync. */
function saveWorkedLedger(
  ledger: WorkedLedger,
  authority: WorkedDirectoryAuthority,
  requireStrictDurability: boolean,
  expectedDestination: WorkedDestinationSnapshot,
): boolean {
  let temporaryPath: string | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let writeFd: number | undefined;
  let readFd: number | undefined;
  let published = false;
  try {
    if (!stableWorkedDirectory(authority) ||
      (requireStrictDurability && !strictFsyncWorkedDirectory(authority))) return false;
    const bounded: WorkedLedger = { events: ledger.events.slice(-MAX_EVENTS) };
    const bytes = Buffer.from(`${JSON.stringify(bounded, null, 2)}\n`, 'utf8');
    if (bytes.length > MAX_WORKED_LEDGER_BYTES) return false;
    temporaryPath = join(authority.path, `.worked-${process.pid}-${randomUUID()}.tmp`);
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    writeFd = openSync(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    temporaryIdentity = fstatSync(writeFd, { bigint: true });
    if (!safeWorkedFile(temporaryIdentity) || temporaryIdentity.size !== 0n) return false;
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(writeFd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return false;
      offset += count;
    }
    fchmodSync(writeFd, 0o600);
    fsyncSync(writeFd);
    if (!exactWorkedTemporary(
      authority, temporaryPath, temporaryIdentity, writeFd, bytes.length,
    )) return false;
    workedLedgerTestHooks?.beforePublication?.(temporaryPath);
    if (!destinationMatchesSnapshot(authority, expectedDestination) ||
      !exactWorkedTemporary(
        authority, temporaryPath, temporaryIdentity, writeFd, bytes.length,
      )) return false;
    const targetPath = join(authority.path, 'worked.json');
    renameSync(temporaryPath, targetPath);
    published = true;
    const installed = lstatSync(targetPath, { bigint: true });
    if (!safeWorkedFile(installed) || !sameIdentity(temporaryIdentity, installed) ||
      !stableWorkedDirectory(authority)) return false;
    readFd = openSync(targetPath, fsConstants.O_RDONLY | noFollow);
    const openedInstalled = fstatSync(readFd, { bigint: true });
    if (!safeWorkedFile(openedInstalled) || !sameIdentity(installed, openedInstalled) ||
      openedInstalled.size !== BigInt(bytes.length)) return false;
    const readback = Buffer.alloc(bytes.length);
    let readOffset = 0;
    while (readOffset < readback.length) {
      const count = readSync(
        readFd, readback, readOffset, readback.length - readOffset, readOffset,
      );
      if (count <= 0) return false;
      readOffset += count;
    }
    const installedAfterReadback = lstatSync(targetPath, { bigint: true });
    if (!readback.equals(bytes) || !safeWorkedFile(installedAfterReadback) ||
      !sameIdentity(installed, installedAfterReadback) ||
      !stableWorkedDirectory(authority)) return false;
    if (requireStrictDurability) {
      if (!strictFsyncWorkedDirectory(authority)) return false;
    } else {
      fsyncDirectory(authority.path, { expectedIdentity: authority });
      if (!stableWorkedDirectory(authority)) return false;
    }
    const installedAfterDurability = lstatSync(targetPath, { bigint: true });
    if (!safeWorkedFile(installedAfterDurability) ||
      !sameIdentity(installed, installedAfterDurability) ||
      !stableWorkedDirectory(authority)) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (readFd !== undefined) { try { closeSync(readFd); } catch { /* best effort */ } }
    if (writeFd !== undefined) { try { closeSync(writeFd); } catch { /* best effort */ } }
    if (!published) cleanupExactWorkedTemporary(authority, temporaryPath, temporaryIdentity);
  }
}

function expectedWorkedOutcomeForDispatch(outcome: string): WorkedOutcome | null {
  if (outcome === 'proposal-created') return 'diff';
  if (outcome === 'empty-diff' || outcome === 'gate-blocked' ||
    outcome === 'engine-failed' || outcome === 'sandbox-failed' ||
    outcome === 'proposal-capture-error' || outcome === 'unknown') return 'empty';
  return null;
}

const WORKED_REPLAY_KEYS = new Set(['itemId', 'outcome', 'dispatchReceipt']);
const DISPATCH_RECEIPT_KEYS = new Set([
  'ts', 'itemId', 'repo', 'outcome', 'attemptId',
  'source', 'backend', 'tier', 'objectiveHash',
]);

function exactPlainRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string' || !allowedKeys.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
    });
}

function boundedReplayText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value.trim() === value && scrubSecrets(value) === value &&
    ![...value].some((char) => char.charCodeAt(0) < 32);
}

function canonicalReplayTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function validateWorkedOutcomeReplay(value: unknown): WorkedOutcomeReplay | null {
  try {
    if (!exactPlainRecord(value, WORKED_REPLAY_KEYS) ||
      !hasOwn(value, 'itemId') || !hasOwn(value, 'outcome') ||
      !hasOwn(value, 'dispatchReceipt') ||
      !boundedReplayText(value['itemId'], 240) || !isWorkedOutcome(value['outcome'])) return null;
    const receipt = value['dispatchReceipt'];
    if (!exactPlainRecord(receipt, DISPATCH_RECEIPT_KEYS) ||
      !hasOwn(receipt, 'ts') || !hasOwn(receipt, 'itemId') || !hasOwn(receipt, 'repo') ||
      !hasOwn(receipt, 'outcome') || !hasOwn(receipt, 'attemptId') ||
      !canonicalReplayTimestamp(receipt['ts']) ||
      !boundedReplayText(receipt['itemId'], 240) ||
      !boundedReplayText(receipt['repo'], 4_096) ||
      !boundedReplayText(receipt['outcome'], 80) ||
      !boundedReplayText(receipt['attemptId'], 240) ||
      (hasOwn(receipt, 'source') && !boundedReplayText(receipt['source'], 80)) ||
      (hasOwn(receipt, 'backend') && receipt['backend'] !== null &&
        !boundedReplayText(receipt['backend'], 160)) ||
      (hasOwn(receipt, 'tier') && receipt['tier'] !== null &&
        !boundedReplayText(receipt['tier'], 80)) ||
      (hasOwn(receipt, 'objectiveHash') && !boundedReplayText(receipt['objectiveHash'], 160))) {
      return null;
    }
    const normalizedReceipt = {
      ts: receipt['ts'],
      itemId: receipt['itemId'],
      repo: receipt['repo'],
      outcome: receipt['outcome'],
      attemptId: receipt['attemptId'],
      ...(hasOwn(receipt, 'source') ? { source: receipt['source'] } : {}),
      ...(hasOwn(receipt, 'backend') ? { backend: receipt['backend'] } : {}),
      ...(hasOwn(receipt, 'tier') ? { tier: receipt['tier'] } : {}),
      ...(hasOwn(receipt, 'objectiveHash') ? { objectiveHash: receipt['objectiveHash'] } : {}),
    } as DispatchProductionParentIdentity;
    return {
      itemId: value['itemId'],
      outcome: value['outcome'],
      dispatchReceipt: normalizedReceipt,
    };
  } catch {
    return null;
  }
}

/**
 * Replay a worked outcome only after its immutable dispatch receipt is proven.
 * The receipt timestamp is the replay timestamp. The operation is idempotent
 * by item timestamp and never rewrites on an unreadable ledger or when an
 * equal/newer outcome already exists.
 */
export function replayWorkedOutcomeAfterDispatchReceipt(
  input: WorkedOutcomeReplay,
): WorkedOutcomeReplayResult {
  const replay = validateWorkedOutcomeReplay(input);
  if (replay === null) return 'invalid';
  const receipt = replay.dispatchReceipt;
  if (replay.itemId !== receipt.itemId ||
    expectedWorkedOutcomeForDispatch(receipt.outcome) !== replay.outcome) return 'invalid';
  if (readDispatchProductionParents([receipt])[0] !== 'found') {
    return 'dispatch-receipt-unavailable';
  }
  const existingAuthority = pinWorkedDirectory();
  if (existingAuthority === null) return 'persistence-failed';
  const lock = acquireLocalStoreLock(`${workedLedgerPath()}.lock`, 2_000, {
    anchorPath: homedir(),
    exactPrivateStorage: true,
  });
  if (!lock) return 'persistence-failed';
  try {
    const authority = pinWorkedDirectory();
    if (authority === null || !sameIdentity(existingAuthority, authority) ||
      !strictFsyncWorkedDirectory(authority)) {
      return 'persistence-failed';
    }
    const loaded = loadBoundWorkedLedger(authority, true);
    if (loaded === null) return 'persistence-failed';
    workedLedgerTestHooks?.afterReplayLoad?.();
    const candidateMs = Date.parse(receipt.ts);
    for (const event of loaded.ledger.events) {
      if (event.itemId !== replay.itemId) continue;
      const eventMs = Date.parse(event.ts);
      if (!Number.isFinite(eventMs)) return 'persistence-failed';
      if (eventMs >= candidateMs) return 'already-recorded';
    }
    loaded.ledger.events.push({ itemId: replay.itemId, outcome: replay.outcome, ts: receipt.ts });
    return saveWorkedLedger(loaded.ledger, authority, true, loaded.destination)
      ? 'recorded'
      : 'persistence-failed';
  } catch {
    return 'persistence-failed';
  } finally {
    releaseLocalStoreLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Record an outcome
// ---------------------------------------------------------------------------

/**
 * Append an outcome event for `itemId` and persist. Never throws.
 *
 * @param itemId   - The WorkItem id.
 * @param outcome  - 'diff' when the run produced a real diff; 'empty' when not.
 * @param ts       - Optional ISO timestamp; defaults to now. Injectable for tests.
 */
export function recordOutcome(
  itemId: string,
  outcome: WorkedOutcome,
  ts?: string,
): boolean {
  return recordOutcomeEvent(itemId, outcome, ts);
}

function recordOutcomeEvent(
  itemId: string,
  outcome: WorkedOutcome,
  ts?: string,
  proposalId?: string,
): boolean {
  if (!ensureWorkedDirectoryForOrdinaryWrite()) return false;
  const lock = acquireLocalStoreLock(`${workedLedgerPath()}.lock`, 2_000, {
    anchorPath: homedir(),
    exactPrivateStorage: true,
  });
  if (!lock) return false;
  try {
    const authority = pinWorkedDirectory();
    if (authority === null) return false;
    const loaded = loadBoundWorkedLedger(authority, false);
    if (loaded === null) return false;
    loaded.ledger.events.push({
      itemId,
      outcome,
      ts: ts ?? new Date().toISOString(),
      ...(proposalId ? { proposalId } : {}),
    });
    return saveWorkedLedger(loaded.ledger, authority, false, loaded.destination);
  } catch {
    // Never throws.
    return false;
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function proposalAlreadySwept(proposalId: string): boolean {
  try {
    return loadWorkedLedger().events.some((event) => event.proposalId === proposalId);
  } catch {
    return false;
  }
}

function sweptProposalMarkerItemId(proposalId: string): string {
  return `__swept_proposal__:${proposalId}`;
}

function recordSweptProposalOutcome(
  itemId: string,
  outcome: WorkedOutcome,
  proposalId: string,
  ts: string | undefined,
  record: (
    itemId: string,
    outcome: WorkedOutcome,
    ts?: string,
    workItemGenerationId?: string,
  ) => void,
  workItemGenerationId?: string,
): void {
  if (record === recordOutcome) {
    recordOutcomeEvent(itemId, outcome, ts, proposalId);
    return;
  }
  record(itemId, outcome, ts, workItemGenerationId);
  recordOutcomeEvent(sweptProposalMarkerItemId(proposalId), outcome, ts, proposalId);
}

// ---------------------------------------------------------------------------
// Cooldown check
// ---------------------------------------------------------------------------

/**
 * Returns true when the item's LAST recorded outcome was 'empty' AND that
 * outcome occurred within the last `cooldownMs` milliseconds.
 *
 * - Returns false (not declined) when the item has no recorded outcome.
 * - Returns false when the last outcome was 'diff' (real work was done).
 * - Returns false when the last suppressible outcome is older than cooldownMs.
 * - Suppressible outcomes: 'empty', 'judged-review', 'judged-noise', 'judged-decline'.
 * - `now` is injectable for deterministic tests (defaults to Date.now()).
 * - NEVER throws.
 */
export function recentlyDeclined(
  itemId: string,
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
  now?: number,
): boolean {
  try {
    return workedEventIsCooling(
      latestWorkedEventForKeys(loadWorkedLedger().events, [itemId]),
      cooldownMs,
      now,
    );
  } catch {
    // Never throws — fail open (not declined).
    return false;
  }
}

export function latestWorkedEvent(itemId: string): WorkedEvent | undefined {
  try {
    return latestWorkedEventForKeys(loadWorkedLedger().events, [itemId]);
  } catch {
    return undefined;
  }
}

export function latestWorkedEventForKeys(
  events: readonly WorkedEvent[],
  itemIds: readonly string[],
): WorkedEvent | undefined {
  const keys = new Set(itemIds);
  let latest: WorkedEvent | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (!keys.has(event.itemId)) continue;
    const eventMs = Date.parse(event.ts);
    if (!Number.isFinite(eventMs)) continue;
    // Equal timestamps resolve to the later append, matching ledger order.
    if (eventMs >= latestMs) {
      latest = event;
      latestMs = eventMs;
    }
  }
  return latest;
}

export function workedEventIsCooling(
  event: WorkedEvent | undefined,
  cooldownMs: number,
  now?: number,
): boolean {
  if (!event || !isSuppressibleWorkedOutcome(event.outcome)) return false;
  const eventMs = Date.parse(event.ts);
  if (!Number.isFinite(eventMs)) return false;
  const elapsedMs = (now ?? Date.now()) - eventMs;
  return elapsedMs >= 0 && elapsedMs < cooldownMs;
}

// ---------------------------------------------------------------------------
// M220: Judge-verdict feedback — recordVerdict + sweepJudgedProposals
// ---------------------------------------------------------------------------

/**
 * Map a raw judge verdict string to a WorkedOutcome decline class.
 * Returns undefined when the verdict should NOT suppress the item
 * (e.g. 'ship' — real work passed the judge).
 */
export function verdictToOutcome(
  verdict: string,
): 'judged-review' | 'judged-noise' | 'judged-decline' | undefined {
  switch (verdict.toLowerCase()) {
    case 'review': return 'judged-review';
    case 'noise':
    case 'trivial':
    case 'skip':
    case 'ignore': return 'judged-noise';
    case 'harmful':
    case 'dangerous':
    case 'reject':
    case 'rejected':
    case 'block':
    case 'decline': return 'judged-decline';
    default: return undefined; // 'ship' or unknown → do not suppress
  }
}

/**
 * Record a judge verdict for `itemId`. Convenience wrapper over recordOutcome.
 *
 * - verdict='ship'    → ignored (ship is positive; item should stay selectable)
 * - verdict='review'  → records 'judged-review'
 * - verdict='noise'   → records 'judged-noise'
 * - verdict='harmful' → records 'judged-decline'
 * - Never throws.
 *
 * @param itemId  - The WorkItem id the proposal was generated from.
 * @param verdict - The raw verdict string from ManagerVerdict.verdict.
 * @param ts      - Optional ISO timestamp; defaults to now. Injectable for tests.
 */
export function recordVerdict(itemId: string, verdict: string, ts?: string): void {
  try {
    const outcome = verdictToOutcome(verdict);
    if (outcome === undefined) return; // 'ship' or unknown — do not suppress
    recordOutcome(itemId, outcome, ts);
  } catch {
    // Never throws.
  }
}

/**
 * Build a STABLE signature for an item used to match it across scanner ticks.
 *
 * The scanner generates item IDs as `repoBasename:source:sha1(discriminator)`
 * (see scanners.ts makeId). If the discriminator changes between ticks (e.g.
 * a CI scanner that includes a timestamp), the ledger would never match.
 *
 * To guard against ID drift we ALSO key on `repo + normalised title`, which is
 * invariant across ticks for the same real issue. sweepJudgedProposals tries
 * the item.id first (exact), then falls back to the stable signature.
 *
 * Normalisation: lowercase, collapse whitespace, strip punctuation.
 */
export function stableItemSig(repo: string, title: string): string {
  const repoName = basename(repo);
  const normTitle = title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  return `${repoName}::${normTitle}`;
}

/**
 * M220: Sweep judged proposals back into the worked ledger.
 *
 * Called once per tick (BEFORE selection) to feed judge verdicts back so items
 * whose proposals were judged 'review', 'noise', or 'harmful'/'decline' are
 * suppressed for the cooldown window and not re-proposed every tick.
 *
 * Matching strategy (ID-stability):
 *  1. Prefer proposal.workItemId when present; it is the causal source item.
 *  2. Otherwise scan `backlogItems` for a match.
 *  3. Primary key: item.id appears as a token in `prop.title + ' ' + prop.summary`
 *     (same regex logic as pendingItemIds in loop.ts — exact word boundary).
 *  4. Fallback key: stableItemSig(item.repo, item.title) matches
 *     stableItemSig(prop.repo ?? '', prop.title) — handles fresh scanner IDs.
 *  5. Only the FIRST match is recorded to avoid double-counting.
 *
 * A proposal is "judged-decline-class" when its status is 'rejected' (the
 * manager sets status='rejected' for noise/harmful when applyRejects=true).
 * The `decisionReason` carries the raw verdict when available.
 *
 * @param judgedProposals - Proposals to sweep (caller filters by status).
 * @param backlogItems    - Current tick's full backlog.
 * @param ts              - Optional ISO timestamp; defaults to now. Injectable for tests.
 * @returns               - Number of items that had a verdict recorded.
 */
export function sweepJudgedProposals(
  judgedProposals: ReadonlyArray<{
    id: string;
    title: string;
    summary: string;
    repo: string | null;
    status: string;
    decisionReason?: string;
    workItemId?: string;
    workItemGenerationId?: string;
  }>,
  backlogItems: ReadonlyArray<WorkItem>,
  ts?: string,
  record: (
    itemId: string,
    outcome: WorkedOutcome,
    ts?: string,
    workItemGenerationId?: string,
  ) => void = recordOutcome,
): number {
  let recorded = 0;
  try {
    // Build stable-sig index of backlog items for O(n) fallback lookup.
    const sigIndex = new Map<string, WorkItem>();
    for (const item of backlogItems) {
      const sig = stableItemSig(item.repo, item.title);
      if (!sigIndex.has(sig)) sigIndex.set(sig, item);
    }

    for (const prop of judgedProposals) {
      if (proposalAlreadySwept(prop.id)) continue;

      // Determine the verdict outcome from the proposal.
      // For rejected proposals: decisionReason may carry the raw verdict.
      // When absent, treat as 'judged-decline' (the manager only rejects noise/harmful).
      let outcome: WorkedOutcome;
      if (prop.status === 'rejected') {
        const rawVerdict = prop.decisionReason ?? 'harmful';
        outcome = verdictToOutcome(rawVerdict) ?? 'judged-decline';
      } else {
        // Non-rejected proposals are not a decline signal — skip.
        continue;
      }

      if (prop.workItemId) {
        recordSweptProposalOutcome(
          prop.workItemId,
          outcome,
          prop.id,
          ts,
          record,
          prop.workItemGenerationId,
        );
        recorded++;
        continue;
      }

      // Try primary match: item.id as exact token in the proposal text.
      const haystack = `${prop.title} ${prop.summary}`;
      let matched: WorkItem | undefined;
      for (const item of backlogItems) {
        const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
        if (re.test(haystack)) {
          matched = item;
          break;
        }
      }

      // Fallback: stable-sig match (repo + normalised title).
      if (!matched) {
        const propSig = stableItemSig(prop.repo ?? '', prop.title);
        matched = sigIndex.get(propSig);
      }

      if (!matched) continue;

      recordSweptProposalOutcome(
        matched.id,
        outcome,
        prop.id,
        ts,
        record,
        prop.workItemGenerationId,
      );
      recorded++;
    }
  } catch {
    // Never throws.
  }
  return recorded;
}
