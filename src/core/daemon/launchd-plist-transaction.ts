import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

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
  /** Validate external activation state after the plist snapshot and before any write. */
  preflight?: (state: { hasPrior: boolean }) => LaunchdCommandResult;
  unload: () => LaunchdCommandResult;
  load: () => LaunchdCommandResult;
  /** Restore the activation state captured before installation. Defaults to load(). */
  rollback?: () => LaunchdCommandResult;
  /** Restore activation state persisted by preflight after an interrupted process restarts. */
  recover?: (state: unknown) => LaunchdCommandResult;
  /** Test-only crash injection at each transaction boundary. */
  checkpointHook?: (checkpoint: LaunchdInstallCheckpoint) => void;
  lockWaitMs?: number;
}

export interface LaunchdPlistRemovalOptions {
  plistPath: string;
  trustedRoot: string;
  lockDir: string;
  unload: () => LaunchdCommandResult;
  lockWaitMs?: number;
}

function owned(stat: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function validateRegularTarget(filePath: string, label: string): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !owned(stat)) {
      throw new Error(`unsafe ${label}: expected a regular, singly-linked file at ${filePath}`);
    }
    return stat;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function readSnapshot(filePath: string): PlistSnapshot | undefined {
  const before = validateRegularTarget(filePath, 'active plist');
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

function assertOwnedTarget(filePath: string, expected: Pick<fs.Stats, 'dev' | 'ino'>): void {
  const current = validateRegularTarget(filePath, 'installed plist');
  if (!current || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`transaction no longer owns ${filePath}`);
  }
}

function assertExpectedTarget(
  filePath: string,
  expected: Pick<PlistSnapshot, 'dev' | 'ino'> | undefined,
): void {
  const current = validateRegularTarget(filePath, 'active plist');
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
): fs.Stats {
  const temporary = artifactPath(filePath, 'tmp');
  const created = writeExclusive(temporary, bytes, mode);
  try {
    if (expectedParent) assertParentIdentity(filePath, expectedParent);
    if (expected || requireMissing) assertExpectedTarget(filePath, expected);
    fs.renameSync(temporary, filePath);
    const installed = fs.lstatSync(filePath);
    if (
      installed.isSymbolicLink() || !installed.isFile() ||
      installed.dev !== created.dev || installed.ino !== created.ino
    ) {
      throw new Error(`atomic replacement ownership check failed for ${filePath}`);
    }
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
): void {
  const backupPath = `${plistPath}.bak`;
  validateRegularTarget(backupPath, 'plist backup');
  const temporary = artifactPath(plistPath, 'backup');
  const created = writeExclusive(temporary, prior.bytes, prior.mode);
  try {
    assertParentIdentity(plistPath, expectedParent);
    fs.renameSync(temporary, backupPath);
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
): void {
  const dir = path.dirname(plistPath);
  const prefix = `${path.basename(plistPath)}.rollback.`;
  assertParentIdentity(plistPath, expectedParent);
  const entries = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const filePath = path.join(dir, name);
      const stat = fs.lstatSync(filePath);
      return { filePath, stat };
    })
  const usable = entries
    .filter((entry) => entry.stat.isFile() && !entry.stat.isSymbolicLink() && entry.stat.nlink === 1 && owned(entry.stat))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || right.filePath.localeCompare(left.filePath));

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
      fs.ftruncateSync(fd, 0);
      fs.fchmodSync(fd, PRIVATE_FILE_MODE);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

function ensureTrustedParent(trustedRoot: string, plistPath: string): fs.Stats {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(plistPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`launchd plist must be below trusted root ${root}`);
  }

  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !owned(rootStat)) {
    throw new Error(`unsafe launchd trusted root ${root}`);
  }

  let current = root;
  for (const component of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !owned(stat)) {
        throw new Error(`unsafe launchd plist parent component ${current}`);
      }
    } catch (error) {
      if (!missing(error)) throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory() || !owned(created)) {
        throw new Error(`unsafe launchd plist parent component ${current}`);
      }
    }
  }
  return fs.lstatSync(path.dirname(target));
}

function assertParentIdentity(plistPath: string, expected: Pick<fs.Stats, 'dev' | 'ino'>): void {
  const parent = fs.lstatSync(path.dirname(plistPath));
  if (parent.isSymbolicLink() || !parent.isDirectory() || !owned(parent) ||
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

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function journalPath(lockDir: string, plistPath: string): string {
  const key = createHash('sha256').update(plistPath).digest('hex').slice(0, 24);
  return path.join(lockDir, `launchd-plist-${key}.journal.json`);
}

function fsyncParent(filePath: string): void {
  const fd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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

function readJournal(filePath: string, expectedPlistPath: string): {
  journal: LaunchdInstallJournal;
  stat: fs.Stats;
} | undefined {
  const before = validateRegularTarget(filePath, 'launchd transaction journal');
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
): fs.Stats {
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8');
  if (bytes.length > MAX_JOURNAL_BYTES) {
    throw new Error('launchd transaction journal exceeds size limit');
  }
  const written = atomicReplace(filePath, bytes, PRIVATE_FILE_MODE, expected, !expected, parent);
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
): void {
  const stopped = options.unload();
  if (!stopped.ok) {
    throw new Error(
      `launchd transaction recovery could not stop active service: ${stopped.stderr.trim() || 'exit non-zero'}`,
    );
  }

  const current = readSnapshot(options.plistPath);
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
      `launchd transaction recovery could not restore activation: ${activation.stderr.trim() || 'exit non-zero'}`,
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
  const parent = ensureTrustedParent(options.trustedRoot, options.plistPath);
  const transactionLockPath = lockPath(options.lockDir, options.plistPath);
  ensureTrustedParent(options.trustedRoot, transactionLockPath);
  const pendingJournalPath = journalPath(options.lockDir, options.plistPath);
  const journalParent = ensureTrustedParent(options.trustedRoot, pendingJournalPath);
  const lock = acquireLocalStoreLock(transactionLockPath, options.lockWaitMs ?? 2_000);
  if (!lock) throw new Error(`could not acquire launchd plist transaction lock for ${options.plistPath}`);

  let releaseFailure: string | undefined;
  try {
    const interrupted = readJournal(pendingJournalPath, options.plistPath);
    if (interrupted) {
      restoreInterruptedTransaction(options, parent, pendingJournalPath, interrupted);
    }

    const prior = readSnapshot(options.plistPath);
    validateRegularTarget(`${options.plistPath}.bak`, 'plist backup');
    let recoveryState: unknown;
    if (options.preflight) {
      const preflight = options.preflight({ hasPrior: !!prior });
      if (!preflight.ok) {
        throw new Error(
          `launchd transaction preflight failed: ${preflight.stderr.trim() || 'exit non-zero'}`,
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
    let journalStat = writeJournal(pendingJournalPath, journal, journalParent);
    options.checkpointHook?.('journal-prepared');

    const advance = (phase: LaunchdInstallPhase): void => {
      journal = { ...journal, phase };
      journalStat = writeJournal(pendingJournalPath, journal, journalParent, journalStat);
      options.checkpointHook?.(`journal-${phase}` as LaunchdInstallCheckpoint);
    };
    const recoverAndThrow = (failure: string): never => {
      const onDisk = readJournal(pendingJournalPath, options.plistPath);
      if (!onDisk || onDisk.stat.dev !== journalStat.dev || onDisk.stat.ino !== journalStat.ino) {
        throw new Error(`${failure}; recovery rejected an interleaved journal`);
      }
      try {
        restoreInterruptedTransaction(options, parent, pendingJournalPath, onDisk);
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
      replaceBackup(options.plistPath, prior, parent);
      const rollbackPath = artifactPath(options.plistPath, 'rollback');
      assertParentIdentity(options.plistPath, parent);
      writeExclusive(rollbackPath, prior.bytes, prior.mode);
      retainRecentRollbacks(options.plistPath, parent);
    }

    const initialUnload = options.unload();
    if (!initialUnload.ok) {
      const unloadFailure = initialUnload.stderr.trim() || 'exit non-zero';
      const activation = restoreActivationAfterUncertainStop(options, journal);
      if (activation && !activation.ok) {
        throw new Error(
          `launchctl unload failed: ${unloadFailure}; activation recovery failed: ` +
          `${activation.stderr.trim() || 'exit non-zero'}`,
        );
      }
      removeJournal(pendingJournalPath, journalStat);
      throw new Error(`launchctl unload failed: ${unloadFailure}; prior activation state was restored`);
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
    assertOwnedTarget(options.plistPath, installed);
    const loaded = options.load();
    try {
      assertParentIdentity(options.plistPath, parent);
      assertOwnedTarget(options.plistPath, installed);
    } catch (error) {
      recoverAndThrow(
        `active plist changed during launchctl load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!loaded.ok) {
      const loadFailure = loaded.stderr.trim() || 'exit non-zero';
      recoverAndThrow(`launchctl load failed: ${loadFailure}`);
    }
    options.checkpointHook?.('service-activated');
    advance('activated');
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
    const prior = readSnapshot(options.plistPath);
    const unloaded = options.unload();
    if (!unloaded.ok) {
      throw new Error(
        `launchctl unload failed: ${unloaded.stderr.trim() || 'exit non-zero'}; plist retained`,
      );
    }
    assertParentIdentity(options.plistPath, parent);
    if (prior) {
      const current = validateRegularTarget(options.plistPath, 'active plist');
      if (!current || current.dev !== prior.dev || current.ino !== prior.ino) {
        throw new Error(`active plist changed during removal: ${options.plistPath}`);
      }
      fs.unlinkSync(options.plistPath);
    }
  } finally {
    releaseLocalStoreLock(lock);
    releaseFailure = lockReleaseFailure(lock);
  }
  if (releaseFailure) throw new Error(releaseFailure);
}
