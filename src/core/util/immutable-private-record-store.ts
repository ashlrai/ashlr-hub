import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { fsyncDirectory } from './durability.js';
import { writePrivateFileAtomically } from './private-file-write.js';
import { assurePrivateStoragePath } from './private-storage.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_LOCK_WAIT_MS = 2_000;
const MAX_RECORD_BYTES_HARD_LIMIT = 1024 * 1024;
const MAX_FILES_HARD_LIMIT = 100_000;
const MAX_AGGREGATE_BYTES_HARD_LIMIT = 1024 * 1024 * 1024;
const ROOT_ENTRY_LIMIT = 8;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ImmutablePrivateRecordWriteDisposition =
  | 'recorded'
  | 'replayed'
  | 'conflicted'
  | 'invalid'
  | 'failed';

export type ImmutablePrivateRecordRecoveryDisposition =
  | 'clean'
  | 'recovered'
  | 'missing'
  | 'invalid'
  | 'failed';

export type ImmutablePrivateRecordReadStopReason =
  | 'codec-unavailable'
  | 'unsafe-storage'
  | 'invalid-options'
  | 'file-limit'
  | 'byte-limit'
  | 'invalid-file'
  | 'source-mutated'
  | 'io-error';

/**
 * Domain codecs own record meaning and authentication. `serialize` must return
 * the exact canonical bytes, including one trailing newline, accepted by
 * `parse`. The stage token must be deterministic and authenticated for the
 * record identity.
 */
export interface ImmutablePrivateRecordCodec<RecordType> {
  parse(value: unknown): RecordType | null;
  serialize(record: RecordType): string;
  recordId(record: RecordType): string;
  recordFileName(record: RecordType): string;
  isRecordFileName(fileName: string): boolean;
  stageToken(record: RecordType): string;
  equivalent(left: RecordType, right: RecordType): boolean;
  compare?(left: RecordType, right: RecordType): number;
}

export interface ImmutablePrivateRecordStoreConfig<RecordType> {
  /** Human-readable error context. It is never persisted. */
  label: string;
  /** Existing trusted directory containing `rootPath`. */
  anchorPath: string;
  /** Store root. The store owns exact-private `records/` and `staging/` children. */
  rootPath: string;
  /** Private lock filename placed directly under `rootPath`. */
  lockFileName: string;
  maxRecordBytes: number;
  defaultMaxFiles: number;
  hardMaxFiles: number;
  defaultMaxBytes: number;
  hardMaxBytes: number;
  codecForWrite(): ImmutablePrivateRecordCodec<RecordType> | null;
  codecForRead(): ImmutablePrivateRecordCodec<RecordType> | null;
}

export interface ImmutablePrivateRecordReadOptions {
  maxFiles?: number;
  maxBytes?: number;
  requireComplete?: boolean;
}

export interface ImmutablePrivateRecordReadResult<RecordType> {
  records: RecordType[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: ImmutablePrivateRecordReadStopReason[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  limitExceeded: boolean;
}

export interface ImmutablePrivateRecordPointReadResult<RecordType> {
  record: RecordType | null;
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  exactReadComplete: boolean;
  stopReasons: ImmutablePrivateRecordReadStopReason[];
  bytesRead: number;
}

interface ValidatedConfig<RecordType> {
  config: ImmutablePrivateRecordStoreConfig<RecordType>;
  anchorPath: string;
  rootPath: string;
  recordsPath: string;
  stagingPath: string;
  lockPath: string;
}

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

interface StoreDirectories<RecordType> extends ValidatedConfig<RecordType> {
  anchorIdentity: DirectoryIdentity;
  identities: readonly DirectoryIdentity[];
}

interface DirectorySnapshot {
  entries: string[];
  overflow: boolean;
}

function nestedWithin(anchor: string, target: string): boolean {
  const nested = relative(anchor, target);
  return nested === '' ||
    (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

function ownedByCurrentUser(stat: Pick<BigIntStats, 'uid'>): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function exactPrivateDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === BigInt(PRIVATE_DIRECTORY_MODE));
}

function exactPrivateFile(stat: BigIntStats, expectedLinks: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() &&
    stat.nlink === BigInt(expectedLinks) && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === BigInt(PRIVATE_FILE_MODE));
}

function sameIdentity(
  left: Pick<BigIntStats, 'dev' | 'ino'>,
  right: Pick<BigIntStats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safePathComponent(value: string): boolean {
  return value.length > 0 && value.length <= 255 &&
    basename(value) === value && value !== '.' && value !== '..' && !value.includes('\0');
}

function safeOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_TOKEN_RE.test(value);
}

function safePositiveInteger(value: number, hardLimit: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= hardLimit;
}

function validateConfig<RecordType>(
  config: ImmutablePrivateRecordStoreConfig<RecordType>,
): ValidatedConfig<RecordType> | null {
  if (typeof config.label !== 'string' || config.label.length < 1 || config.label.length > 120 ||
    !safePathComponent(config.lockFileName) ||
    !config.lockFileName.startsWith('.') || !config.lockFileName.endsWith('.lock') ||
    !safePositiveInteger(config.maxRecordBytes, MAX_RECORD_BYTES_HARD_LIMIT) ||
    !safePositiveInteger(config.defaultMaxFiles, MAX_FILES_HARD_LIMIT) ||
    !safePositiveInteger(config.hardMaxFiles, MAX_FILES_HARD_LIMIT) ||
    config.defaultMaxFiles > config.hardMaxFiles ||
    !safePositiveInteger(config.defaultMaxBytes, MAX_AGGREGATE_BYTES_HARD_LIMIT) ||
    !safePositiveInteger(config.hardMaxBytes, MAX_AGGREGATE_BYTES_HARD_LIMIT) ||
    config.defaultMaxBytes > config.hardMaxBytes ||
    config.maxRecordBytes > config.hardMaxBytes) return null;

  const anchorPath = resolve(config.anchorPath);
  const rootPath = resolve(config.rootPath);
  if (anchorPath === rootPath || !nestedWithin(anchorPath, rootPath) ||
    dirname(rootPath) !== anchorPath) return null;

  const recordsPath = join(rootPath, 'records');
  const stagingPath = join(rootPath, 'staging');
  const lockPath = join(rootPath, config.lockFileName);
  return { config, anchorPath, rootPath, recordsPath, stagingPath, lockPath };
}

function pinAnchor(path: string): DirectoryIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByCurrentUser(stat)) {
    throw new Error('unsafe immutable record store anchor');
  }
  return { path, dev: stat.dev, ino: stat.ino };
}

function pinPrivateDirectory(path: string): DirectoryIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!exactPrivateDirectory(stat)) {
    throw new Error('unsafe immutable record store directory');
  }
  return { path, dev: stat.dev, ino: stat.ino };
}

function verifyDirectories<RecordType>(directories: StoreDirectories<RecordType>): void {
  const anchor = lstatSync(directories.anchorIdentity.path, { bigint: true });
  if (!anchor.isDirectory() || anchor.isSymbolicLink() || !ownedByCurrentUser(anchor) ||
    anchor.dev !== directories.anchorIdentity.dev || anchor.ino !== directories.anchorIdentity.ino) {
    throw new Error('immutable record store anchor changed');
  }
  for (const identity of directories.identities) {
    const stat = lstatSync(identity.path, { bigint: true });
    if (!exactPrivateDirectory(stat) || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new Error('immutable record store directory changed');
    }
  }
}

function assureDirectory(
  path: string,
  anchorPath: string,
  create: boolean,
): void {
  let created = false;
  if (!existsSync(path)) {
    if (!create) throw new Error('immutable record store directory missing');
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    created = true;
    if (process.platform !== 'win32') chmodSync(path, PRIVATE_DIRECTORY_MODE);
  }
  const stat = lstatSync(path, { bigint: true });
  if (!exactPrivateDirectory(stat)) throw new Error('unsafe immutable record store directory');
  const assurance = assurePrivateStoragePath(
    path,
    'directory',
    created ? 'secure-created' : 'inspect-existing',
    { anchorPath },
  );
  if (!assurance.ok) throw new Error(`unsafe immutable record store directory: ${assurance.reason}`);
  if (created) fsyncDirectory(dirname(path));
}

function loadDirectories<RecordType>(
  validated: ValidatedConfig<RecordType>,
  create: boolean,
): StoreDirectories<RecordType> {
  const anchorIdentity = pinAnchor(validated.anchorPath);
  assureDirectory(validated.rootPath, validated.anchorPath, create);
  assureDirectory(validated.recordsPath, validated.anchorPath, create);
  assureDirectory(validated.stagingPath, validated.anchorPath, create);
  const directories: StoreDirectories<RecordType> = {
    ...validated,
    anchorIdentity,
    identities: [
      pinPrivateDirectory(validated.rootPath),
      pinPrivateDirectory(validated.recordsPath),
      pinPrivateDirectory(validated.stagingPath),
    ],
  };
  verifyDirectories(directories);
  return directories;
}

function canonicalSerializedRecord<RecordType>(
  codec: ImmutablePrivateRecordCodec<RecordType>,
  record: RecordType,
  maxRecordBytes: number,
): string | null {
  try {
    const serialized = codec.serialize(record);
    const bytes = Buffer.from(serialized, 'utf8');
    if (serialized.length < 2 || !serialized.endsWith('\n') ||
      serialized.slice(0, -1).includes('\n') ||
      bytes.length > maxRecordBytes ||
      !bytes.equals(Buffer.from(bytes.toString('utf8'), 'utf8'))) return null;
    const parsed = codec.parse(JSON.parse(serialized));
    return parsed !== null && codec.serialize(parsed) === serialized ? serialized : null;
  } catch {
    return null;
  }
}

function recordPaths<RecordType>(
  directories: StoreDirectories<RecordType>,
  codec: ImmutablePrivateRecordCodec<RecordType>,
  record: RecordType,
): { target: string; stage: string; temporary: string } | null {
  try {
    const id = codec.recordId(record);
    const fileName = codec.recordFileName(record);
    const stageToken = codec.stageToken(record);
    if (!safeOpaqueToken(id) || !safeOpaqueToken(stageToken) ||
      !safePathComponent(fileName) || fileName.startsWith('.') ||
      !codec.isRecordFileName(fileName)) return null;
    const stageName = `.${id}.${stageToken}.stage`;
    if (!safePathComponent(stageName)) return null;
    const stage = join(directories.stagingPath, stageName);
    return {
      target: join(directories.recordsPath, fileName),
      stage,
      temporary: `${stage}.tmp`,
    };
  } catch {
    return null;
  }
}

function readRecordFile<RecordType>(
  path: string,
  codec: ImmutablePrivateRecordCodec<RecordType>,
  directories: StoreDirectories<RecordType>,
  expectedLinks = 1,
): RecordType | null {
  let fd: number | undefined;
  try {
    const assurance = assurePrivateStoragePath(
      path,
      'file',
      'inspect-existing',
      { anchorPath: directories.anchorPath },
    );
    if (!assurance.ok) return null;
    const before = lstatSync(path, { bigint: true });
    if (!exactPrivateFile(before, expectedLinks) ||
      before.size < 2n || before.size > BigInt(directories.config.maxRecordBytes)) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    if (!exactPrivateFile(opened, expectedLinks) ||
      !sameIdentity(before, opened) || before.size !== opened.size) return null;
    const size = Number(opened.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!exactPrivateFile(after, expectedLinks) ||
      !exactPrivateFile(namedAfter, expectedLinks) ||
      !sameIdentity(opened, after) || !sameIdentity(opened, namedAfter) ||
      opened.size !== after.size || opened.size !== namedAfter.size) return null;
    const finalAssurance = assurePrivateStoragePath(
      path,
      'file',
      'inspect-existing',
      { anchorPath: directories.anchorPath },
    );
    if (!finalAssurance.ok) return null;
    const text = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(text, 'utf8')) || !text.endsWith('\n') ||
      text.slice(0, -1).includes('\n')) return null;
    const record = codec.parse(JSON.parse(text));
    return record !== null && codec.serialize(record) === text ? record : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function recordsEquivalent<RecordType>(
  codec: ImmutablePrivateRecordCodec<RecordType>,
  left: RecordType,
  right: RecordType,
): boolean {
  try {
    return codec.recordId(left) === codec.recordId(right) && codec.equivalent(left, right);
  } catch {
    return false;
  }
}

function removeExactFile(
  path: string,
  identity: BigIntStats,
  directories: StoreDirectories<unknown>,
): boolean {
  try {
    const installed = lstatSync(path, { bigint: true });
    if (!sameIdentity(installed, identity) ||
      !exactPrivateFile(installed, Number(installed.nlink)) ||
      (installed.nlink !== 1n && installed.nlink !== 2n)) return false;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    verifyDirectories(directories);
    return true;
  } catch {
    return false;
  }
}

function fsyncExactFile(
  path: string,
  identity: BigIntStats,
  directories: StoreDirectories<unknown>,
): boolean {
  let fd: number | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !exactPrivateFile(opened, 1) ||
      !exactPrivateFile(named, 1) ||
      !sameIdentity(opened, identity) ||
      !sameIdentity(named, identity)
    ) return false;
    fsyncSync(fd);
    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (
      !exactPrivateFile(openedAfter, 1) ||
      !exactPrivateFile(namedAfter, 1) ||
      !sameIdentity(openedAfter, identity) ||
      !sameIdentity(namedAfter, identity)
    ) return false;
    verifyDirectories(directories);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function boundedDirectoryEntries(path: string, hardLimit: number): DirectorySnapshot {
  const directory = opendirSync(path);
  const entries: string[] = [];
  let overflow = false;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (entries.length >= hardLimit) {
        overflow = true;
        break;
      }
      entries.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  entries.sort();
  return { entries, overflow };
}

function snapshotsEqual(left: DirectorySnapshot, right: DirectorySnapshot): boolean {
  return left.overflow === right.overflow &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => entry === right.entries[index]);
}

function recoverInterruptedPublication<RecordType>(
  directories: StoreDirectories<RecordType>,
  codec: ImmutablePrivateRecordCodec<RecordType>,
  expected: RecordType,
  paths: { target: string; stage: string; temporary: string },
): 'none' | 'recovered' | 'conflicted' | 'failed' {
  try {
    verifyDirectories(directories);

    if (existsSync(paths.temporary)) {
      if (existsSync(paths.stage)) return 'failed';
      const temporaryIdentity = lstatSync(paths.temporary, { bigint: true });
      if (!exactPrivateFile(temporaryIdentity, 1)) return 'failed';
      const temporaryRecord = readRecordFile(paths.temporary, codec, directories);
      if (temporaryRecord === null) {
        return removeExactFile(paths.temporary, temporaryIdentity, directories)
          ? 'none'
          : 'failed';
      }
      if (!recordsEquivalent(codec, temporaryRecord, expected)) return 'conflicted';
      if (!fsyncExactFile(paths.temporary, temporaryIdentity, directories)) return 'failed';
      renameSync(paths.temporary, paths.stage);
      const installedStage = lstatSync(paths.stage, { bigint: true });
      if (!exactPrivateFile(installedStage, 1) ||
        !sameIdentity(installedStage, temporaryIdentity)) return 'failed';
      fsyncDirectory(directories.stagingPath);
    }

    if (!existsSync(paths.stage)) return 'none';
    const targetPresent = existsSync(paths.target);
    const expectedLinks = targetPresent ? 2 : 1;
    const stagedIdentity = lstatSync(paths.stage, { bigint: true });
    if (!exactPrivateFile(stagedIdentity, expectedLinks)) return 'failed';
    if (targetPresent) {
      const targetIdentity = lstatSync(paths.target, { bigint: true });
      if (!exactPrivateFile(targetIdentity, 2) ||
        !sameIdentity(stagedIdentity, targetIdentity)) return 'failed';
    }
    const stagedRecord = readRecordFile(paths.stage, codec, directories, expectedLinks);
    if (stagedRecord === null) return 'failed';
    if (!recordsEquivalent(codec, stagedRecord, expected)) return 'conflicted';

    if (!targetPresent) {
      linkSync(paths.stage, paths.target);
      const linkedStage = lstatSync(paths.stage, { bigint: true });
      const targetIdentity = lstatSync(paths.target, { bigint: true });
      if (!exactPrivateFile(linkedStage, 2) || !exactPrivateFile(targetIdentity, 2) ||
        !sameIdentity(linkedStage, stagedIdentity) ||
        !sameIdentity(linkedStage, targetIdentity)) return 'failed';
    }
    // Retry both directory barriers even when the target link survived a
    // previous failed fsync. The stage remains the durable recovery witness
    // until both namespace entries have been flushed successfully.
    fsyncDirectory(directories.recordsPath);
    fsyncDirectory(directories.stagingPath);

    const exactStage = lstatSync(paths.stage, { bigint: true });
    const exactTarget = lstatSync(paths.target, { bigint: true });
    if (!exactPrivateFile(exactStage, 2) || !exactPrivateFile(exactTarget, 2) ||
      !sameIdentity(exactStage, stagedIdentity) ||
      !sameIdentity(exactStage, exactTarget)) return 'failed';
    if (!removeExactFile(paths.stage, exactStage, directories)) return 'failed';
    verifyDirectories(directories);
    const recovered = readRecordFile(paths.target, codec, directories);
    return recovered !== null && recordsEquivalent(codec, recovered, expected)
      ? 'recovered'
      : 'failed';
  } catch {
    return 'failed';
  }
}

function recoverStagingNamespace<RecordType>(
  directories: StoreDirectories<RecordType>,
  codec: ImmutablePrivateRecordCodec<RecordType>,
): { ok: boolean; recoveredRecords: Map<string, RecordType> } {
  const recoveredRecords = new Map<string, RecordType>();
  try {
    const snapshot = boundedDirectoryEntries(
      directories.stagingPath,
      directories.config.hardMaxFiles + 1,
    );
    if (snapshot.overflow) return { ok: false, recoveredRecords };
    for (const entry of snapshot.entries) {
      const path = join(directories.stagingPath, entry);
      const isTemporary = entry.endsWith('.stage.tmp');
      const isStage = !isTemporary && entry.endsWith('.stage');
      if (!safePathComponent(entry) || !entry.startsWith('.') || (!isTemporary && !isStage)) {
        return { ok: false, recoveredRecords };
      }
      const stat = lstatSync(path, { bigint: true });
      const expectedLinks = Number(stat.nlink);
      if ((expectedLinks !== 1 && expectedLinks !== 2) ||
        !exactPrivateFile(stat, expectedLinks)) return { ok: false, recoveredRecords };
      const record = readRecordFile(path, codec, directories, expectedLinks);
      if (record === null) {
        if (!isTemporary || expectedLinks !== 1 ||
          !removeExactFile(path, stat, directories)) return { ok: false, recoveredRecords };
        continue;
      }
      const paths = recordPaths(directories, codec, record);
      if (paths === null ||
        path !== (isTemporary ? paths.temporary : paths.stage)) {
        return { ok: false, recoveredRecords };
      }
      const id = codec.recordId(record);
      const recovery = recoverInterruptedPublication(directories, codec, record, paths);
      if (recovery === 'recovered') {
        recoveredRecords.set(id, record);
      } else if (recovery !== 'none') {
        return { ok: false, recoveredRecords };
      }
    }
    return { ok: true, recoveredRecords };
  } catch {
    return { ok: false, recoveredRecords };
  }
}

/**
 * Cleans the staging namespace without deciding that an uncommitted record
 * should become durable. One-link artifacts are discarded only after their
 * authenticated record and canonical path agree. A two-link stage may be
 * finalized only when its exact target link already exists.
 */
function recoverStagingNamespaceConservatively<RecordType>(
  directories: StoreDirectories<RecordType>,
  codec: ImmutablePrivateRecordCodec<RecordType>,
): { ok: boolean; finalizedRecords: number } {
  let finalizedRecords = 0;
  try {
    const snapshot = boundedDirectoryEntries(
      directories.stagingPath,
      directories.config.hardMaxFiles + 1,
    );
    if (snapshot.overflow) return { ok: false, finalizedRecords };
    for (const entry of snapshot.entries) {
      const path = join(directories.stagingPath, entry);
      const isTemporary = entry.endsWith('.stage.tmp');
      const isStage = !isTemporary && entry.endsWith('.stage');
      if (!safePathComponent(entry) || !entry.startsWith('.') || (!isTemporary && !isStage)) {
        return { ok: false, finalizedRecords };
      }
      const stat = lstatSync(path, { bigint: true });
      const links = Number(stat.nlink);
      if ((links !== 1 && links !== 2) || !exactPrivateFile(stat, links)) {
        return { ok: false, finalizedRecords };
      }
      const record = readRecordFile(path, codec, directories, links);
      if (record === null) return { ok: false, finalizedRecords };
      const paths = recordPaths(directories, codec, record);
      if (paths === null || path !== (isTemporary ? paths.temporary : paths.stage)) {
        return { ok: false, finalizedRecords };
      }

      if (links === 1) {
        if (!removeExactFile(path, stat, directories)) {
          return { ok: false, finalizedRecords };
        }
        continue;
      }

      if (isTemporary || !existsSync(paths.target)) {
        return { ok: false, finalizedRecords };
      }
      const target = lstatSync(paths.target, { bigint: true });
      if (!exactPrivateFile(target, 2) || !sameIdentity(stat, target)) {
        return { ok: false, finalizedRecords };
      }
      const targetRecord = readRecordFile(paths.target, codec, directories, 2);
      if (targetRecord === null || !recordsEquivalent(codec, targetRecord, record)) {
        return { ok: false, finalizedRecords };
      }
      fsyncDirectory(directories.recordsPath);
      fsyncDirectory(directories.stagingPath);
      if (!removeExactFile(path, stat, directories)) {
        return { ok: false, finalizedRecords };
      }
      const finalized = readRecordFile(paths.target, codec, directories);
      if (finalized === null || !recordsEquivalent(codec, finalized, record)) {
        return { ok: false, finalizedRecords };
      }
      finalizedRecords += 1;
    }
    return { ok: true, finalizedRecords };
  } catch {
    return { ok: false, finalizedRecords };
  }
}

function publishWithoutClobber<RecordType>(
  directories: StoreDirectories<RecordType>,
  paths: { target: string; stage: string; temporary: string },
  serialized: string,
): 'published' | 'exists' {
  let stagedIdentity: BigIntStats | undefined;
  let targetLinked = false;
  try {
    writePrivateFileAtomically(paths.temporary, paths.stage, serialized, {
      anchorPath: directories.anchorPath,
      label: `${directories.config.label} publication stage`,
    });
    stagedIdentity = lstatSync(paths.stage, { bigint: true });
    if (!exactPrivateFile(stagedIdentity, 1)) {
      throw new Error('unsafe immutable record publication stage');
    }
    try {
      linkSync(paths.stage, paths.target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw error;
    }
    targetLinked = true;
    const linkedStage = lstatSync(paths.stage, { bigint: true });
    const targetIdentity = lstatSync(paths.target, { bigint: true });
    if (!exactPrivateFile(linkedStage, 2) || !exactPrivateFile(targetIdentity, 2) ||
      !sameIdentity(stagedIdentity, linkedStage) ||
      !sameIdentity(linkedStage, targetIdentity)) {
      throw new Error('immutable record target changed during publication');
    }
    fsyncDirectory(directories.recordsPath);
    fsyncDirectory(directories.stagingPath);
    if (!removeExactFile(paths.stage, linkedStage, directories)) {
      throw new Error('immutable record stage could not be finalized');
    }
    stagedIdentity = undefined;
    targetLinked = false;
    const published = lstatSync(paths.target, { bigint: true });
    if (!exactPrivateFile(published, 1) || !sameIdentity(targetIdentity, published)) {
      throw new Error('immutable record target changed after publication');
    }
    return 'published';
  } finally {
    if (stagedIdentity !== undefined && !targetLinked) {
      removeExactFile(paths.stage, stagedIdentity, directories);
    }
  }
}

/**
 * Records one immutable canonical value. The store protects against crashes and
 * cooperative concurrent writers under one OS user; it is not an independent
 * verifier or a boundary against a malicious process running as that user.
 */
export function writeImmutablePrivateRecord<RecordType>(
  config: ImmutablePrivateRecordStoreConfig<RecordType>,
  record: RecordType,
  options: { lockWaitMs?: number; maxFiles?: number; maxBytes?: number } = {},
): ImmutablePrivateRecordWriteDisposition {
  const validated = validateConfig(config);
  if (validated === null) return 'invalid';
  const lockWaitMs = options.lockWaitMs === undefined
    ? MAX_LOCK_WAIT_MS
    : Number.isFinite(options.lockWaitMs)
      ? Math.max(0, Math.min(MAX_LOCK_WAIT_MS, Math.floor(options.lockWaitMs)))
      : null;
  if (lockWaitMs === null) return 'invalid';
  const maxFiles = options.maxFiles === undefined
    ? config.defaultMaxFiles
    : boundedLimit(options.maxFiles, config.defaultMaxFiles, config.hardMaxFiles);
  const maxBytes = options.maxBytes === undefined
    ? config.defaultMaxBytes
    : boundedLimit(options.maxBytes, config.defaultMaxBytes, config.hardMaxBytes);
  if (maxFiles === null || maxBytes === null) return 'invalid';

  let codec: ImmutablePrivateRecordCodec<RecordType> | null;
  try { codec = config.codecForWrite(); } catch { codec = null; }
  if (codec === null) return 'failed';
  const serialized = canonicalSerializedRecord(codec, record, config.maxRecordBytes);
  if (serialized === null) return 'invalid';

  let directories: StoreDirectories<RecordType>;
  try { directories = loadDirectories(validated, true); } catch { return 'failed'; }
  const paths = recordPaths(directories, codec, record);
  if (paths === null) return 'invalid';
  const lock = acquireLocalStoreLock(directories.lockPath, lockWaitMs, {
    anchorPath: directories.anchorPath,
    exactPrivateStorage: true,
  });
  if (lock === null) return 'failed';

  try {
    verifyDirectories(directories);
    const namespaceRecovery = recoverStagingNamespace(directories, codec);
    if (!namespaceRecovery.ok) return 'failed';
    const recordId = codec.recordId(record);
    const recovered = namespaceRecovery.recoveredRecords.get(recordId);
    if (recovered !== undefined) {
      return recordsEquivalent(codec, recovered, record) ? 'recorded' : 'conflicted';
    }
    const recovery = recoverInterruptedPublication(directories, codec, record, paths);
    if (recovery === 'recovered') return 'recorded';
    if (recovery === 'conflicted') return 'conflicted';
    if (recovery === 'failed') return 'failed';
    if (existsSync(paths.target)) {
      const existing = readRecordFile(paths.target, codec, directories);
      if (existing === null) return 'failed';
      return recordsEquivalent(codec, existing, record) ? 'replayed' : 'conflicted';
    }
    const before = boundedDirectoryEntries(directories.recordsPath, maxFiles + 1);
    if (before.overflow || before.entries.length >= maxFiles) return 'failed';
    let aggregateBytes = 0;
    for (const entry of before.entries) {
      if (!safePathComponent(entry) || !codec.isRecordFileName(entry)) return 'failed';
      const entryPath = join(directories.recordsPath, entry);
      const stat = lstatSync(entryPath, { bigint: true });
      if (!exactPrivateFile(stat, 1) || stat.size < 2n ||
        stat.size > BigInt(config.maxRecordBytes)) return 'failed';
      const existingRecord = readRecordFile(entryPath, codec, directories);
      if (existingRecord === null || codec.recordFileName(existingRecord) !== entry ||
        !safeOpaqueToken(codec.recordId(existingRecord))) return 'failed';
      aggregateBytes += Number(stat.size);
      if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > maxBytes) return 'failed';
    }
    if (aggregateBytes + Buffer.byteLength(serialized, 'utf8') > maxBytes) return 'failed';
    verifyDirectories(directories);
    const confirmed = boundedDirectoryEntries(directories.recordsPath, maxFiles + 1);
    if (!snapshotsEqual(before, confirmed)) return 'failed';
    const publication = publishWithoutClobber(directories, paths, serialized);
    if (publication === 'exists') {
      const existing = readRecordFile(paths.target, codec, directories);
      if (existing === null) return 'failed';
      return recordsEquivalent(codec, existing, record) ? 'replayed' : 'conflicted';
    }
    verifyDirectories(directories);
    const persisted = readRecordFile(paths.target, codec, directories);
    return persisted !== null && recordsEquivalent(codec, persisted, record)
      ? 'recorded'
      : 'failed';
  } catch {
    return 'failed';
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/**
 * Conservatively cleans authenticated interrupted publications without
 * accepting or publishing a caller-provided record. One-link stages are
 * uncommitted and removed; only cleanup of an already-linked exact target may
 * be finalized. The store lock serializes recovery with ordinary writers. A
 * missing store is reported without creating anything.
 */
export function recoverImmutablePrivateRecordStore<RecordType>(
  config: ImmutablePrivateRecordStoreConfig<RecordType>,
  options: { lockWaitMs?: number } = {},
): ImmutablePrivateRecordRecoveryDisposition {
  let validated: ValidatedConfig<RecordType> | null;
  try { validated = validateConfig(config); } catch { validated = null; }
  if (validated === null) return 'invalid';
  let lockWaitMs: number | null;
  try {
    lockWaitMs = options.lockWaitMs === undefined
      ? MAX_LOCK_WAIT_MS
      : Number.isFinite(options.lockWaitMs)
        ? Math.max(0, Math.min(MAX_LOCK_WAIT_MS, Math.floor(options.lockWaitMs)))
        : null;
  } catch {
    return 'invalid';
  }
  if (lockWaitMs === null) return 'invalid';
  if (!existsSync(validated.rootPath)) return 'missing';

  let codec: ImmutablePrivateRecordCodec<RecordType> | null;
  try { codec = config.codecForWrite(); } catch { codec = null; }
  if (codec === null) return 'failed';

  let directories: StoreDirectories<RecordType>;
  try { directories = loadDirectories(validated, false); } catch { return 'failed'; }
  const lock = acquireLocalStoreLock(directories.lockPath, lockWaitMs, {
    anchorPath: directories.anchorPath,
    exactPrivateStorage: true,
  });
  if (lock === null) return 'failed';

  try {
    verifyDirectories(directories);
    const recovery = recoverStagingNamespaceConservatively(directories, codec);
    if (!recovery.ok) return 'failed';
    verifyDirectories(directories);
    return recovery.finalizedRecords > 0 ? 'recovered' : 'clean';
  } catch {
    return 'failed';
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function emptyRead<RecordType>(
  sourceState: ImmutablePrivateRecordReadResult<RecordType>['sourceState'],
  overrides: Partial<ImmutablePrivateRecordReadResult<RecordType>> = {},
): ImmutablePrivateRecordReadResult<RecordType> {
  return {
    records: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState === 'healthy',
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    limitExceeded: false,
    ...overrides,
  };
}

function boundedLimit(value: number | undefined, fallback: number, hardMax: number): number | null {
  if (value === undefined) return fallback;
  return Number.isFinite(value)
    ? Math.max(0, Math.min(hardMax, Math.floor(value)))
    : null;
}

/**
 * Reads a stable, bounded snapshot without creating directories, keys, locks,
 * or cleanup writes. Any active/crashed writer or namespace anomaly degrades
 * the source; `requireComplete` withholds all records in that state.
 */
export function readImmutablePrivateRecords<RecordType>(
  config: ImmutablePrivateRecordStoreConfig<RecordType>,
  options: ImmutablePrivateRecordReadOptions = {},
): ImmutablePrivateRecordReadResult<RecordType> {
  const validated = validateConfig(config);
  if (validated === null) {
    return emptyRead('degraded', {
      sourcePresent: false,
      complete: false,
      stopReasons: ['invalid-options'],
      limitExceeded: true,
    });
  }
  if (!existsSync(validated.rootPath)) return emptyRead('missing', { sourcePresent: false });

  let codec: ImmutablePrivateRecordCodec<RecordType> | null;
  try { codec = config.codecForRead(); } catch { codec = null; }
  if (codec === null) {
    return emptyRead('degraded', {
      sourcePresent: true,
      complete: false,
      stopReasons: ['codec-unavailable'],
    });
  }

  let directories: StoreDirectories<RecordType>;
  try { directories = loadDirectories(validated, false); } catch {
    return emptyRead('degraded', {
      sourcePresent: true,
      complete: false,
      stopReasons: ['unsafe-storage'],
    });
  }
  const maxFiles = boundedLimit(options.maxFiles, config.defaultMaxFiles, config.hardMaxFiles);
  const maxBytes = boundedLimit(options.maxBytes, config.defaultMaxBytes, config.hardMaxBytes);
  if (maxFiles === null || maxBytes === null) {
    return emptyRead('degraded', {
      sourcePresent: true,
      complete: false,
      stopReasons: ['invalid-options'],
      limitExceeded: true,
    });
  }

  try {
    verifyDirectories(directories);
    const rootBefore = boundedDirectoryEntries(directories.rootPath, ROOT_ENTRY_LIMIT);
    const recordsBefore = boundedDirectoryEntries(
      directories.recordsPath,
      config.hardMaxFiles + 1,
    );
    const stagingBefore = boundedDirectoryEntries(directories.stagingPath, 3);
    const stopReasons = new Set<ImmutablePrivateRecordReadStopReason>();
    const allowedRootEntries = new Set([
      'records',
      'staging',
      config.lockFileName,
    ]);
    const writerActive = rootBefore.entries.includes(config.lockFileName);
    const unexpectedRoot = rootBefore.entries.filter((entry) => !allowedRootEntries.has(entry));
    const unexpectedRecords = recordsBefore.entries.filter(
      (entry) => !safePathComponent(entry) || entry.startsWith('.') ||
        !codec.isRecordFileName(entry),
    );
    if (rootBefore.overflow || recordsBefore.overflow) stopReasons.add('file-limit');
    if (writerActive || stagingBefore.entries.length > 0 || stagingBefore.overflow) {
      stopReasons.add('source-mutated');
    }
    if (unexpectedRoot.length > 0 || unexpectedRecords.length > 0 ||
      stagingBefore.entries.length > 0 || rootBefore.overflow) {
      stopReasons.add('invalid-file');
    }

    const files = recordsBefore.entries.filter(
      (entry) => safePathComponent(entry) && !entry.startsWith('.') &&
        codec.isRecordFileName(entry),
    );
    if (files.length > maxFiles || files.length > config.hardMaxFiles) {
      stopReasons.add('file-limit');
    }
    const selected = files.slice(0, maxFiles);
    const records: RecordType[] = [];
    const seenIds = new Set<string>();
    let filesRead = 0;
    let bytesRead = 0;
    let invalidFiles = unexpectedRoot.length + unexpectedRecords.length +
      stagingBefore.entries.length + (rootBefore.overflow ? 1 : 0) +
      (recordsBefore.overflow ? 1 : 0) + (stagingBefore.overflow ? 1 : 0);

    for (const fileName of selected) {
      const path = join(directories.recordsPath, fileName);
      let size: number;
      try {
        const stat = lstatSync(path, { bigint: true });
        size = Number(stat.size);
      } catch {
        invalidFiles += 1;
        stopReasons.add('io-error');
        continue;
      }
      if (!Number.isSafeInteger(size) || size < 2 || size > config.maxRecordBytes) {
        invalidFiles += 1;
        stopReasons.add('invalid-file');
        continue;
      }
      if (bytesRead + size > maxBytes) {
        stopReasons.add('byte-limit');
        break;
      }
      bytesRead += size;
      filesRead += 1;
      const record = readRecordFile(path, codec, directories);
      if (record === null) {
        invalidFiles += 1;
        stopReasons.add('invalid-file');
        continue;
      }
      let id: string;
      let expectedFileName: string;
      try {
        id = codec.recordId(record);
        expectedFileName = codec.recordFileName(record);
      } catch {
        invalidFiles += 1;
        stopReasons.add('invalid-file');
        continue;
      }
      if (!safeOpaqueToken(id) || expectedFileName !== fileName || seenIds.has(id)) {
        invalidFiles += 1;
        stopReasons.add('invalid-file');
        continue;
      }
      seenIds.add(id);
      records.push(record);
    }

    if (codec.compare !== undefined) records.sort(codec.compare);
    else records.sort((left, right) => {
      const leftId = codec.recordId(left);
      const rightId = codec.recordId(right);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });

    const rootAfter = boundedDirectoryEntries(directories.rootPath, ROOT_ENTRY_LIMIT);
    const recordsAfter = boundedDirectoryEntries(
      directories.recordsPath,
      config.hardMaxFiles + 1,
    );
    const stagingAfter = boundedDirectoryEntries(directories.stagingPath, 3);
    if (!snapshotsEqual(rootBefore, rootAfter) ||
      !snapshotsEqual(recordsBefore, recordsAfter) ||
      !snapshotsEqual(stagingBefore, stagingAfter)) {
      stopReasons.add('source-mutated');
    }
    verifyDirectories(directories);
    const degraded = stopReasons.size > 0;
    return {
      records: options.requireComplete === true && degraded ? [] : records,
      sourceState: degraded ? 'degraded' : 'healthy',
      sourcePresent: true,
      complete: !degraded,
      stopReasons: [...stopReasons],
      filesRead,
      bytesRead,
      invalidFiles,
      limitExceeded: stopReasons.has('file-limit') || stopReasons.has('byte-limit'),
    };
  } catch {
    return emptyRead('degraded', {
      sourcePresent: true,
      complete: false,
      stopReasons: ['io-error'],
    });
  }
}

/**
 * Reads one canonical immutable slot without enumerating the aggregate ledger.
 * This proves only the requested record. It makes no aggregate completeness,
 * file-count, denominator, or retention claim.
 */
export function readImmutablePrivateRecordPoint<RecordType>(
  config: ImmutablePrivateRecordStoreConfig<RecordType>,
  recordId: string,
  fileName: string,
): ImmutablePrivateRecordPointReadResult<RecordType> {
  const empty = (
    sourceState: 'missing' | 'healthy' | 'degraded',
    overrides: Partial<ImmutablePrivateRecordPointReadResult<RecordType>> = {},
  ): ImmutablePrivateRecordPointReadResult<RecordType> => ({
    record: null,
    sourceState,
    sourcePresent: sourceState !== 'missing',
    exactReadComplete: sourceState === 'healthy',
    stopReasons: [],
    bytesRead: 0,
    ...overrides,
  });
  const validated = validateConfig(config);
  if (
    validated === null ||
    !safeOpaqueToken(recordId) ||
    !safePathComponent(fileName) ||
    fileName.startsWith('.')
  ) {
    return empty('degraded', {
      sourcePresent: false,
      exactReadComplete: false,
      stopReasons: ['invalid-options'],
    });
  }
  if (!existsSync(validated.rootPath)) return empty('missing');
  let codec: ImmutablePrivateRecordCodec<RecordType> | null;
  try { codec = config.codecForRead(); } catch { codec = null; }
  if (codec === null) {
    return empty('degraded', {
      exactReadComplete: false,
      stopReasons: ['codec-unavailable'],
    });
  }
  if (!codec.isRecordFileName(fileName)) {
    return empty('degraded', {
      exactReadComplete: false,
      stopReasons: ['invalid-options'],
    });
  }
  let directories: StoreDirectories<RecordType>;
  try { directories = loadDirectories(validated, false); } catch {
    return empty('degraded', {
      exactReadComplete: false,
      stopReasons: ['unsafe-storage'],
    });
  }
  try {
    verifyDirectories(directories);
    const rootBefore = boundedDirectoryEntries(directories.rootPath, ROOT_ENTRY_LIMIT);
    const stagingBefore = boundedDirectoryEntries(directories.stagingPath, 3);
    const allowedRootEntries = new Set(['records', 'staging', config.lockFileName]);
    const unexpectedRoot = rootBefore.entries.some((entry) => !allowedRootEntries.has(entry));
    if (
      rootBefore.overflow ||
      rootBefore.entries.includes(config.lockFileName) ||
      stagingBefore.overflow ||
      stagingBefore.entries.length > 0 ||
      unexpectedRoot
    ) {
      return empty('degraded', {
        exactReadComplete: false,
        stopReasons: [
          'source-mutated',
          ...(rootBefore.overflow || stagingBefore.overflow || unexpectedRoot
            ? ['invalid-file' as const]
            : []),
        ],
      });
    }
    const path = join(directories.recordsPath, fileName);
    if (!existsSync(path)) {
      verifyDirectories(directories);
      return empty('healthy');
    }
    const stat = lstatSync(path, { bigint: true });
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 2 || size > config.maxRecordBytes) {
      return empty('degraded', {
        exactReadComplete: false,
        stopReasons: ['invalid-file'],
      });
    }
    const record = readRecordFile(path, codec, directories);
    if (
      record === null ||
      codec.recordId(record) !== recordId ||
      codec.recordFileName(record) !== fileName
    ) {
      return empty('degraded', {
        exactReadComplete: false,
        stopReasons: ['invalid-file'],
        bytesRead: size,
      });
    }
    const rootAfter = boundedDirectoryEntries(directories.rootPath, ROOT_ENTRY_LIMIT);
    const stagingAfter = boundedDirectoryEntries(directories.stagingPath, 3);
    if (
      !snapshotsEqual(rootBefore, rootAfter) ||
      !snapshotsEqual(stagingBefore, stagingAfter)
    ) {
      return empty('degraded', {
        exactReadComplete: false,
        stopReasons: ['source-mutated'],
        bytesRead: size,
      });
    }
    verifyDirectories(directories);
    return {
      record,
      sourceState: 'healthy',
      sourcePresent: true,
      exactReadComplete: true,
      stopReasons: [],
      bytesRead: size,
    };
  } catch {
    return empty('degraded', {
      exactReadComplete: false,
      stopReasons: ['io-error'],
    });
  }
}
