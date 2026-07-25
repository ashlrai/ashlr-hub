import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';
import {
  hardenWindowsFileAuthority,
  validateWindowsFileAuthority,
  type WindowsFileAuthorityKind,
} from './windows-file-authority.js';

const PRIVATE_FILE_MODE = 0o600;
const ROLLBACK_RETENTION = 5;
const JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

export type LaunchdInstallPhase = 'prepared' | 'stopped' | 'replaced' | 'activated';
export type LaunchdInstallCheckpoint =
  | 'journal-prepared'
  | 'service-stopped'
  | 'journal-stopped'
  | 'plist-replaced'
  | 'journal-replaced'
  | 'service-activated'
  | 'journal-activated';

export interface LaunchdCommandResult {
  ok: boolean;
  stderr: string;
  recoveryState?: unknown;
}

interface PlistSnapshot {
  bytes: Buffer;
  mode: number;
  dev: number;
  ino: number;
}

interface LaunchdInstallJournal {
  schemaVersion: 1;
  plistPath: string;
  phase: LaunchdInstallPhase;
  hadPrior: boolean;
  priorBytesBase64?: string;
  priorMode?: number;
  priorSha256?: string;
  replacementSha256: string;
  recoveryState?: unknown;
}

export interface LaunchdPlistTransactionOptions {
  plistPath: string;
  trustedRoot: string;
  content: string;
  lockDir: string;
  /** Stable diagnostic label; defaults to launchd for compatibility. */
  operationLabel?: string;
  /** Validate external activation state after the plist snapshot and before any write. */
  preflight?: (state: { hasPrior: boolean }) => LaunchdCommandResult;
  unload: () => LaunchdCommandResult;
  load: () => LaunchdCommandResult;
  /** Recheck the requested external state at the final durable boundary. */
  verify?: () => LaunchdCommandResult;
  /** Restore the activation state captured before installation. Defaults to load(). */
  rollback?: () => LaunchdCommandResult;
  /** Restore activation state persisted by preflight after an interrupted process restarts. */
  recover?: (state: unknown) => LaunchdCommandResult;
  /** Reject invalid persisted activation state before the external service is stopped. */
  validateRecovery?: (state: unknown) => LaunchdCommandResult;
  /** Test-only crash injection at each transaction boundary. */
  checkpointHook?: (checkpoint: LaunchdInstallCheckpoint) => void;
  lockWaitMs?: number;
}

export interface LaunchdPlistRemovalOptions {
  plistPath: string;
  trustedRoot: string;
  lockDir: string;
  unload: () => LaunchdCommandResult;
  /** Reconcile and verify the manager after the service file is durably absent. */
  afterRemove?: () => LaunchdCommandResult;
  /** Restore the prior manager state after any post-unload failure restores the prior file. */
  recoverAfterFailedRemove?: () => LaunchdCommandResult;
  lockWaitMs?: number;
}

export interface ServiceFileTransactionLockOptions {
  filePath: string;
  trustedRoot: string;
  lockDir: string;
  lockWaitMs?: number;
}

function owned(stat: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function trustedDirectory(stat: fs.Stats): boolean {
  const safePosixMode = process.platform === 'win32' || (stat.mode & 0o022) === 0;
  return !stat.isSymbolicLink() && stat.isDirectory() && owned(stat) && safePosixMode;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function assertWindowsFileAuthority(
  filePath: string,
  kind: WindowsFileAuthorityKind,
  trustedRoot: string,
  mode: 'validate' | 'harden' = 'validate',
): void {
  if (process.platform !== 'win32') return;
  const result = mode === 'harden'
    ? hardenWindowsFileAuthority(filePath, kind, { anchorPath: trustedRoot })
    : validateWindowsFileAuthority(filePath, kind, { anchorPath: trustedRoot });
  if (!result.ok) {
    throw new Error(`unsafe Windows ${kind} authority: ${result.reason}`);
  }
}

function validateRegularTarget(
  filePath: string,
  label: string,
  trustedRoot?: string,
): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !owned(stat)) {
      throw new Error(`unsafe ${label}: expected a regular, singly-linked file at ${filePath}`);
    }
    if (trustedRoot) assertWindowsFileAuthority(filePath, 'file', trustedRoot);
    return stat;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function readSnapshot(filePath: string, trustedRoot?: string): PlistSnapshot | undefined {
  const before = validateRegularTarget(filePath, 'active plist', trustedRoot);
  if (!before) return undefined;

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
    ) {
      throw new Error(`unsafe active plist: changed while opening ${filePath}`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error(`short read from active plist ${filePath}`);
      offset += read;
    }
    return { bytes, mode: PRIVATE_FILE_MODE, dev: opened.dev, ino: opened.ino };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function artifactPath(plistPath: string, kind: 'tmp' | 'rollback' | 'backup'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nonce = randomBytes(16).toString('hex');
  return `${plistPath}.${kind}.${timestamp}.${process.pid}.${nonce}`;
}

function writeExclusive(filePath: string, bytes: Buffer, mode: number): fs.Stats {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written === 0) throw new Error(`short write to transaction artifact ${filePath}`);
      offset += written;
    }
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    return fs.fstatSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function unlinkIfOwned(filePath: string, expected: Pick<fs.Stats, 'dev' | 'ino'>): void {
  const current = fs.lstatSync(filePath);
  if (
    current.isSymbolicLink() || !current.isFile() || current.dev !== expected.dev || current.ino !== expected.ino
  ) {
    throw new Error(`transaction no longer owns ${filePath}`);
  }
  fs.unlinkSync(filePath);
}

function assertOwnedTarget(
  filePath: string,
  expected: Pick<fs.Stats, 'dev' | 'ino'>,
  trustedRoot?: string,
): void {
  const current = validateRegularTarget(filePath, 'installed plist', trustedRoot);
  if (!current || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`transaction no longer owns ${filePath}`);
  }
}

function assertExpectedTarget(
  filePath: string,
  expected: Pick<PlistSnapshot, 'dev' | 'ino'> | undefined,
  trustedRoot?: string,
): void {
  const current = validateRegularTarget(filePath, 'active plist', trustedRoot);
  if (!expected) {
    if (current) throw new Error(`active plist appeared during transaction: ${filePath}`);
    return;
  }
  if (!current || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`active plist changed during transaction: ${filePath}`);
  }
}

function atomicReplace(
  filePath: string,
  bytes: Buffer,
  mode: number,
  expected?: Pick<PlistSnapshot, 'dev' | 'ino'>,
  requireMissing = false,
  expectedParent?: Pick<fs.Stats, 'dev' | 'ino'>,
  trustedRoot?: string,
): fs.Stats {
  const temporary = artifactPath(filePath, 'tmp');
  const created = writeExclusive(temporary, bytes, mode);
  try {
    if (expectedParent) assertParentIdentity(filePath, expectedParent);
    if (expected || requireMissing) assertExpectedTarget(filePath, expected, trustedRoot);
    fs.renameSync(temporary, filePath);
    const installed = fs.lstatSync(filePath);
    if (
      installed.isSymbolicLink() || !installed.isFile() ||
      installed.dev !== created.dev || installed.ino !== created.ino
    ) {
      throw new Error(`atomic replacement ownership check failed for ${filePath}`);
    }
    fsyncParent(filePath, expectedParent);
    return installed;
  } finally {
    try {
      const remaining = fs.lstatSync(temporary);
      if (remaining.dev === created.dev && remaining.ino === created.ino) fs.unlinkSync(temporary);
    } catch { /* best-effort cleanup; never mask the transaction result */ }
  }
}

function replaceBackup(
  plistPath: string,
  prior: PlistSnapshot,
  expectedParent: Pick<fs.Stats, 'dev' | 'ino'>,
  trustedRoot: string,
): void {
  const backupPath = `${plistPath}.bak`;
  validateRegularTarget(backupPath, 'plist backup', trustedRoot);
  const temporary = artifactPath(plistPath, 'backup');
  const created = writeExclusive(temporary, prior.bytes, prior.mode);
  try {
    assertParentIdentity(plistPath, expectedParent);
    fs.renameSync(temporary, backupPath);
    fsyncParent(backupPath, expectedParent);
  } finally {
    try {
      const remaining = fs.lstatSync(temporary);
      if (remaining.dev === created.dev && remaining.ino === created.ino) fs.unlinkSync(temporary);
    } catch { /* best-effort cleanup; never mask the backup result */ }
  }
}

function retainRecentRollbacks(
  plistPath: string,
  expectedParent: Pick<fs.Stats, 'dev' | 'ino'>,
  trustedRoot: string,
): void {
  const dir = path.dirname(plistPath);
  const prefix = `${path.basename(plistPath)}.rollback.`;
  assertParentIdentity(plistPath, expectedParent);
  const entries = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const filePath = path.join(dir, name);
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        assertWindowsFileAuthority(filePath, 'file', trustedRoot);
      }
      return { filePath, stat };
    })
  const usable = entries
    .filter((entry) => entry.stat.isFile() && !entry.stat.isSymbolicLink() && entry.stat.nlink === 1 && owned(entry.stat))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || right.filePath.localeCompare(left.filePath));

  let removed = false;
  for (const entry of usable.slice(ROLLBACK_RETENTION)) {
    assertParentIdentity(plistPath, expectedParent);
    let fd: number | undefined;
    try {
      fd = fs.openSync(entry.filePath, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || !owned(opened) ||
          opened.dev !== entry.stat.dev || opened.ino !== entry.stat.ino) {
        throw new Error(`rollback artifact changed during retention: ${entry.filePath}`);
      }
      unlinkIfOwned(entry.filePath, opened);
      removed = true;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (removed) fsyncParent(plistPath, expectedParent);
}

function ensureTrustedParent(trustedRoot: string, plistPath: string): fs.Stats {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(plistPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`launchd plist must be below trusted root ${root}`);
  }

  const rootStat = fs.lstatSync(root);
  if (!trustedDirectory(rootStat)) {
    throw new Error(`unsafe launchd trusted root ${root}`);
  }
  assertWindowsFileAuthority(root, 'directory', root);

  let current = root;
  for (const component of relative.split(path.sep).slice(0, -1)) {
    const parentPath = current;
    const parent = fs.lstatSync(parentPath);
    if (!trustedDirectory(parent)) {
      throw new Error(`unsafe launchd plist parent component ${parentPath}`);
    }
    current = path.join(parentPath, component);
    try {
      const stat = fs.lstatSync(current);
      if (!trustedDirectory(stat)) {
        throw new Error(`unsafe launchd plist parent component ${current}`);
      }
      assertWindowsFileAuthority(current, 'directory', root);
    } catch (error) {
      if (!missing(error)) throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const created = fs.lstatSync(current);
      if (!trustedDirectory(created)) {
        throw new Error(`unsafe launchd plist parent component ${current}`);
      }
      assertWindowsFileAuthority(current, 'directory', root, 'harden');
      fsyncDirectory(parentPath, {
        expectedIdentity: { dev: BigInt(parent.dev), ino: BigInt(parent.ino) },
      });
    }
  }
  return fs.lstatSync(path.dirname(target));
}

function assertParentIdentity(plistPath: string, expected: Pick<fs.Stats, 'dev' | 'ino'>): void {
  const parent = fs.lstatSync(path.dirname(plistPath));
  if (!trustedDirectory(parent) ||
      parent.dev !== expected.dev || parent.ino !== expected.ino) {
    throw new Error(`launchd plist parent changed during transaction: ${path.dirname(plistPath)}`);
  }
}

function lockPath(lockDir: string, plistPath: string): string {
  const key = createHash('sha256').update(plistPath).digest('hex').slice(0, 24);
  return path.join(lockDir, `launchd-plist-${key}.lock`);
}

function lockReleaseFailure(lock: { path: string; dev: number; ino: number }): string | undefined {
  try {
    const remaining = fs.lstatSync(lock.path);
    if (remaining.dev === lock.dev && remaining.ino === lock.ino) {
      return `failed to release launchd plist transaction lock ${lock.path}`;
    }
  } catch (error) {
    if (!missing(error)) return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export function withServiceFileTransactionLock<T>(
  options: ServiceFileTransactionLockOptions,
  action: () => T,
): T {
  ensureTrustedParent(options.trustedRoot, options.filePath);
  const transactionLockPath = lockPath(options.lockDir, options.filePath);
  ensureTrustedParent(options.trustedRoot, transactionLockPath);
  const lock = acquireLocalStoreLock(transactionLockPath, options.lockWaitMs ?? 2_000);
  if (!lock) throw new Error(`could not acquire service-file transaction lock for ${options.filePath}`);

  let result: T | undefined;
  let actionFailure: unknown;
  let actionFailed = false;
  let releaseFailure: string | undefined;
  try {
    assertWindowsFileAuthority(lock.path, 'file', options.trustedRoot, 'harden');
    result = action();
  } catch (error) {
    actionFailed = true;
    actionFailure = error;
  } finally {
    releaseLocalStoreLock(lock);
    releaseFailure = lockReleaseFailure(lock);
  }
  if (actionFailed) throw actionFailure;
  if (releaseFailure) throw new Error(releaseFailure);
  return result as T;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function journalPath(lockDir: string, plistPath: string): string {
  const key = createHash('sha256').update(plistPath).digest('hex').slice(0, 24);
  return path.join(lockDir, `launchd-plist-${key}.journal.json`);
}

function fsyncParent(
  filePath: string,
  expectedParent?: Pick<fs.Stats, 'dev' | 'ino'>,
): void {
  fsyncDirectory(path.dirname(filePath), expectedParent
    ? { expectedIdentity: { dev: BigInt(expectedParent.dev), ino: BigInt(expectedParent.ino) } }
    : {});
}

function parseJournal(bytes: Buffer, expectedPlistPath: string): LaunchdInstallJournal {
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('launchd transaction journal exceeds size limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid launchd transaction journal JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid launchd transaction journal: expected object');
  }
  const value = parsed as Record<string, unknown>;
  const phases: LaunchdInstallPhase[] = ['prepared', 'stopped', 'replaced', 'activated'];
  if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION || value.plistPath !== expectedPlistPath ||
      typeof value.hadPrior !== 'boolean' || typeof value.replacementSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.replacementSha256) ||
      typeof value.phase !== 'string' || !phases.includes(value.phase as LaunchdInstallPhase)) {
    throw new Error('invalid launchd transaction journal fields');
  }
  if (value.hadPrior) {
    if (typeof value.priorBytesBase64 !== 'string' || typeof value.priorSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.priorSha256) || !Number.isInteger(value.priorMode)) {
      throw new Error('invalid launchd transaction journal prior snapshot');
    }
    const priorBytes = Buffer.from(value.priorBytesBase64, 'base64');
    if (priorBytes.toString('base64') !== value.priorBytesBase64 || digest(priorBytes) !== value.priorSha256) {
      throw new Error('launchd transaction journal prior snapshot digest mismatch');
    }
  } else if (value.priorBytesBase64 !== undefined || value.priorSha256 !== undefined || value.priorMode !== undefined) {
    throw new Error('invalid launchd transaction journal: unexpected prior snapshot');
  }
  return value as unknown as LaunchdInstallJournal;
}

function readJournal(filePath: string, expectedPlistPath: string, trustedRoot?: string): {
  journal: LaunchdInstallJournal;
  stat: fs.Stats;
} | undefined {
  const before = validateRegularTarget(filePath, 'launchd transaction journal', trustedRoot);
  if (!before) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size > MAX_JOURNAL_BYTES) {
      throw new Error(`unsafe launchd transaction journal at ${filePath}`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`short read from launchd transaction journal ${filePath}`);
      offset += count;
    }
    return { journal: parseJournal(bytes, expectedPlistPath), stat: opened };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeJournal(
  filePath: string,
  journal: LaunchdInstallJournal,
  parent: Pick<fs.Stats, 'dev' | 'ino'>,
  expected?: Pick<fs.Stats, 'dev' | 'ino'>,
  trustedRoot?: string,
): fs.Stats {
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8');
  if (bytes.length > MAX_JOURNAL_BYTES) {
    throw new Error('launchd transaction journal exceeds size limit');
  }
  const written = atomicReplace(
    filePath,
    bytes,
    PRIVATE_FILE_MODE,
    expected,
    !expected,
    parent,
    trustedRoot,
  );
  fsyncParent(filePath);
  return written;
}

function removeJournal(filePath: string, expected: Pick<fs.Stats, 'dev' | 'ino'>): void {
  unlinkIfOwned(filePath, expected);
  fsyncParent(filePath);
}

function restoreInterruptedTransaction(
  options: LaunchdPlistTransactionOptions,
  parent: Pick<fs.Stats, 'dev' | 'ino'>,
  filePath: string,
  pending: { journal: LaunchdInstallJournal; stat: fs.Stats },
  validateBeforeUnload = true,
): void {
  const operation = options.operationLabel ?? 'launchd';
  const beforeStop = validateBeforeUnload
    ? readSnapshot(options.plistPath, options.trustedRoot)
    : undefined;
  const beforeStopSha = beforeStop ? digest(beforeStop.bytes) : undefined;
  if (validateBeforeUnload && pending.journal.hadPrior) {
    if (
      !beforeStop ||
      (beforeStopSha !== pending.journal.priorSha256 &&
        beforeStopSha !== pending.journal.replacementSha256)
    ) {
      throw new Error('launchd transaction recovery rejected an interleaved plist');
    }
  } else if (validateBeforeUnload && beforeStop && beforeStopSha !== pending.journal.replacementSha256) {
    throw new Error('launchd transaction recovery rejected an interleaved first-install plist');
  }
  if (options.validateRecovery) {
    const validation = options.validateRecovery(pending.journal.recoveryState);
    if (!validation.ok) {
      throw new Error(
        `${operation} transaction recovery rejected persisted activation state: ` +
        `${validation.stderr.trim() || 'invalid recovery state'}`,
      );
    }
  }

  const stopped = options.unload();
  if (!stopped.ok) {
    const originalDiskStateIntact = pending.journal.hadPrior
      ? beforeStopSha === pending.journal.priorSha256
      : beforeStop === undefined;
    if (originalDiskStateIntact) {
      const activation = restoreActivationAfterUncertainStop(options, pending.journal);
      if (activation?.ok) {
        removeJournal(filePath, pending.stat);
        throw new Error(
          `${operation} transaction recovery could not stop active service: ` +
          `${stopped.stderr.trim() || 'exit non-zero'}; prior activation state was restored`,
        );
      }
      if (activation) {
        throw new Error(
          `${operation} transaction recovery could not stop active service: ` +
          `${stopped.stderr.trim() || 'exit non-zero'}; activation recovery failed: ` +
          `${activation.stderr.trim() || 'exit non-zero'}`,
        );
      }
    }
    throw new Error(
      `${operation} transaction recovery could not stop active service: ${stopped.stderr.trim() || 'exit non-zero'}`,
    );
  }

  const current = readSnapshot(options.plistPath, options.trustedRoot);
  if (validateBeforeUnload && (
    (beforeStop === undefined && current !== undefined) ||
    (beforeStop !== undefined && (
      current === undefined ||
      current.dev !== beforeStop.dev ||
      current.ino !== beforeStop.ino ||
      digest(current.bytes) !== beforeStopSha
    ))
  )) {
    throw new Error('launchd transaction recovery rejected a service file changed while stopping');
  }
  const currentSha = current ? digest(current.bytes) : undefined;
  if (pending.journal.hadPrior) {
    const priorBytes = Buffer.from(pending.journal.priorBytesBase64!, 'base64');
    if (currentSha !== pending.journal.priorSha256) {
      if (!current || currentSha !== pending.journal.replacementSha256) {
        throw new Error('launchd transaction recovery rejected an interleaved plist');
      }
      atomicReplace(
        options.plistPath,
        priorBytes,
        pending.journal.priorMode ?? PRIVATE_FILE_MODE,
        current,
        false,
        parent,
        options.trustedRoot,
      );
    }
  } else if (current) {
    if (currentSha !== pending.journal.replacementSha256) {
      throw new Error('launchd transaction recovery rejected an interleaved first-install plist');
    }
    unlinkIfOwned(options.plistPath, current);
    fsyncParent(options.plistPath);
  }

  const activation = options.recover
    ? options.recover(pending.journal.recoveryState)
    : pending.journal.hadPrior
      ? (options.rollback ?? options.load)()
      : options.rollback?.();
  if (activation && !activation.ok) {
    throw new Error(
      `${operation} transaction recovery could not restore activation: ${activation.stderr.trim() || 'exit non-zero'}`,
    );
  }
  removeJournal(filePath, pending.stat);
}

function restoreActivationAfterUncertainStop(
  options: LaunchdPlistTransactionOptions,
  journal: LaunchdInstallJournal,
): LaunchdCommandResult | undefined {
  return options.recover
    ? options.recover(journal.recoveryState)
    : journal.hadPrior
      ? (options.rollback ?? options.load)()
      : options.rollback?.();
}

export function installLaunchdPlistTransaction(options: LaunchdPlistTransactionOptions): void {
  const operation = options.operationLabel ?? 'launchd';
  const transactionFileLabel = options.operationLabel ? `${operation} service-file` : 'launchd plist';
  const unloadLabel = options.operationLabel ? `${operation} transaction unload` : 'launchctl unload';
  const activationLabel = options.operationLabel ? `${operation} transaction activation` : 'launchctl load';
  const parent = ensureTrustedParent(options.trustedRoot, options.plistPath);
  const transactionLockPath = lockPath(options.lockDir, options.plistPath);
  ensureTrustedParent(options.trustedRoot, transactionLockPath);
  const pendingJournalPath = journalPath(options.lockDir, options.plistPath);
  const journalParent = ensureTrustedParent(options.trustedRoot, pendingJournalPath);
  const lock = acquireLocalStoreLock(transactionLockPath, options.lockWaitMs ?? 2_000);
  if (!lock) throw new Error(`could not acquire ${transactionFileLabel} transaction lock for ${options.plistPath}`);

  let releaseFailure: string | undefined;
  try {
    assertWindowsFileAuthority(lock.path, 'file', options.trustedRoot, 'harden');
    const interrupted = readJournal(pendingJournalPath, options.plistPath, options.trustedRoot);
    if (interrupted) {
      restoreInterruptedTransaction(options, parent, pendingJournalPath, interrupted);
    }

    const prior = readSnapshot(options.plistPath, options.trustedRoot);
    validateRegularTarget(`${options.plistPath}.bak`, 'plist backup', options.trustedRoot);
    let recoveryState: unknown;
    if (options.preflight) {
      const preflight = options.preflight({ hasPrior: !!prior });
      if (!preflight.ok) {
        throw new Error(
          `${operation} transaction preflight failed: ${preflight.stderr.trim() || 'exit non-zero'}`,
        );
      }
      recoveryState = preflight.recoveryState;
    }

    const replacementBytes = Buffer.from(options.content, 'utf8');
    let journal: LaunchdInstallJournal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      plistPath: options.plistPath,
      phase: 'prepared',
      hadPrior: !!prior,
      ...(prior
        ? {
            priorBytesBase64: prior.bytes.toString('base64'),
            priorMode: prior.mode,
            priorSha256: digest(prior.bytes),
          }
        : {}),
      replacementSha256: digest(replacementBytes),
      ...(recoveryState === undefined ? {} : { recoveryState }),
    };
    let journalStat = writeJournal(
      pendingJournalPath,
      journal,
      journalParent,
      undefined,
      options.trustedRoot,
    );
    options.checkpointHook?.('journal-prepared');

    const advance = (phase: LaunchdInstallPhase): void => {
      journal = { ...journal, phase };
      journalStat = writeJournal(
        pendingJournalPath,
        journal,
        journalParent,
        journalStat,
        options.trustedRoot,
      );
      options.checkpointHook?.(`journal-${phase}` as LaunchdInstallCheckpoint);
    };
    const recoverAndThrow = (failure: string): never => {
      const onDisk = readJournal(pendingJournalPath, options.plistPath, options.trustedRoot);
      if (!onDisk || onDisk.stat.dev !== journalStat.dev || onDisk.stat.ino !== journalStat.ino) {
        throw new Error(`${failure}; recovery rejected an interleaved journal`);
      }
      try {
        restoreInterruptedTransaction(options, parent, pendingJournalPath, onDisk, false);
      } catch (error) {
        throw new Error(
          `${failure}; recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const restored = journal.hadPrior
        ? 'prior plist and activation state were restored'
        : (options.recover || options.rollback)
          ? 'first-install plist was removed and activation state restored'
          : 'first-install plist was removed';
      throw new Error(`${failure}; ${restored}`);
    };

    if (prior) {
      assertParentIdentity(options.plistPath, parent);
      replaceBackup(options.plistPath, prior, parent, options.trustedRoot);
      const rollbackPath = artifactPath(options.plistPath, 'rollback');
      assertParentIdentity(options.plistPath, parent);
      writeExclusive(rollbackPath, prior.bytes, prior.mode);
      fsyncParent(rollbackPath, parent);
      retainRecentRollbacks(options.plistPath, parent, options.trustedRoot);
    }

    const initialUnload = options.unload();
    if (!initialUnload.ok) {
      const unloadFailure = initialUnload.stderr.trim() || 'exit non-zero';
      const activation = restoreActivationAfterUncertainStop(options, journal);
      if (activation && !activation.ok) {
        throw new Error(
          `${unloadLabel} failed: ${unloadFailure}; activation recovery failed: ` +
          `${activation.stderr.trim() || 'exit non-zero'}`,
        );
      }
      removeJournal(pendingJournalPath, journalStat);
      throw new Error(`${unloadLabel} failed: ${unloadFailure}; prior activation state was restored`);
    }
    options.checkpointHook?.('service-stopped');
    advance('stopped');

    const installed = (() => {
      try {
        return atomicReplace(
          options.plistPath,
          replacementBytes,
          prior?.mode ?? PRIVATE_FILE_MODE,
          prior,
          !prior,
          parent,
          options.trustedRoot,
        );
      } catch (error) {
        return recoverAndThrow(`launchd plist replacement failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    options.checkpointHook?.('plist-replaced');
    advance('replaced');

    // launchctl accepts only a pathname. These checks bind cooperative callers;
    // a hostile same-UID process is outside this boundary and can invoke launchctl directly.
    assertParentIdentity(options.plistPath, parent);
    assertOwnedTarget(options.plistPath, installed, options.trustedRoot);
    const loaded = options.load();
    try {
      assertParentIdentity(options.plistPath, parent);
      assertOwnedTarget(options.plistPath, installed, options.trustedRoot);
    } catch (error) {
      recoverAndThrow(
        `active plist changed during launchctl load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!loaded.ok) {
      const loadFailure = loaded.stderr.trim() || 'exit non-zero';
      recoverAndThrow(`${activationLabel} failed: ${loadFailure}`);
    }
    options.checkpointHook?.('service-activated');
    advance('activated');
    if (options.verify) {
      const verified = options.verify();
      if (!verified.ok) {
        recoverAndThrow(
          `service final verification failed: ${verified.stderr.trim() || 'exit non-zero'}`,
        );
      }
    }
    try {
      assertParentIdentity(options.plistPath, parent);
      assertOwnedTarget(options.plistPath, installed, options.trustedRoot);
    } catch (error) {
      recoverAndThrow(
        `service file changed during final verification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    removeJournal(pendingJournalPath, journalStat);
  } finally {
    releaseLocalStoreLock(lock);
    releaseFailure = lockReleaseFailure(lock);
  }
  if (releaseFailure) throw new Error(releaseFailure);
}

export function removeLaunchdPlistTransaction(options: LaunchdPlistRemovalOptions): void {
  const parent = ensureTrustedParent(options.trustedRoot, options.plistPath);
  const transactionLockPath = lockPath(options.lockDir, options.plistPath);
  ensureTrustedParent(options.trustedRoot, transactionLockPath);
  const lock = acquireLocalStoreLock(transactionLockPath, options.lockWaitMs ?? 2_000);
  if (!lock) throw new Error(`could not acquire launchd plist transaction lock for ${options.plistPath}`);
  let releaseFailure: string | undefined;
  try {
    assertWindowsFileAuthority(lock.path, 'file', options.trustedRoot, 'harden');
    const prior = readSnapshot(options.plistPath, options.trustedRoot);
    const unloaded = options.unload();
    if (!unloaded.ok) {
      throw new Error(
        `launchctl unload failed: ${unloaded.stderr.trim() || 'exit non-zero'}; plist retained`,
      );
    }
    try {
      assertParentIdentity(options.plistPath, parent);
      if (prior) {
        const current = readSnapshot(options.plistPath, options.trustedRoot);
        if (
          !current ||
          current.dev !== prior.dev ||
          current.ino !== prior.ino ||
          !current.bytes.equals(prior.bytes)
        ) {
          throw new Error(`active plist changed during removal: ${options.plistPath}`);
        }
        fs.unlinkSync(options.plistPath);
        fsyncParent(options.plistPath);
      }
      if (options.afterRemove) {
        const finalized = options.afterRemove();
        if (!finalized.ok) {
          throw new Error(
            `service removal finalization failed: ${finalized.stderr.trim() || 'exit non-zero'}`,
          );
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      try {
        assertParentIdentity(options.plistPath, parent);
        const current = readSnapshot(options.plistPath, options.trustedRoot);
        if (prior) {
          if (!current) {
            atomicReplace(
              options.plistPath,
              prior.bytes,
              prior.mode,
              undefined,
              true,
              parent,
              options.trustedRoot,
            );
            fsyncParent(options.plistPath);
          } else if (
            current.dev !== prior.dev ||
            current.ino !== prior.ino ||
            !current.bytes.equals(prior.bytes)
          ) {
            throw new Error('service file identity or bytes changed during failed removal');
          }
        } else if (current) {
          throw new Error('service file appeared during failed removal');
        }
      } catch (recoveryError) {
        throw new Error(
          `${failure}; service file recovery failed: ` +
          `${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }

      let managerRestored = false;
      if (options.recoverAfterFailedRemove) {
        let recovered: LaunchdCommandResult;
        try {
          recovered = options.recoverAfterFailedRemove();
        } catch (recoveryError) {
          throw new Error(
            `${failure}; ${prior ? 'service file restored' : 'no prior service file existed'}; ` +
            `manager recovery failed: ` +
            `${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          );
        }
        if (!recovered.ok) {
          throw new Error(
            `${failure}; ${prior ? 'service file restored' : 'no prior service file existed'}; ` +
            `manager recovery failed: ${recovered.stderr.trim() || 'exit non-zero'}`,
          );
        }
        managerRestored = true;
      }
      throw new Error(
        `${failure}; ${prior ? 'service file restored' : 'no prior service file existed'}` +
        `${managerRestored ? '; manager state restored' : ''}`,
      );
    }
  } finally {
    releaseLocalStoreLock(lock);
    releaseFailure = lockReleaseFailure(lock);
  }
  if (releaseFailure) throw new Error(releaseFailure);
}
