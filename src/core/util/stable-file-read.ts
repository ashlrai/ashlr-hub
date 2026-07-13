import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  assurePrivateStoragePath,
  assurePrivateStoragePaths,
} from './private-storage.js';

const READ_CHUNK_BYTES = 64 * 1024;

export type StableFileReadFailureReason =
  | 'unsafe-path'
  | 'unsafe-file'
  | 'per-file-byte-limit'
  | 'byte-limit'
  | 'changed-during-read'
  | 'io-error';

export interface StableFileReadOptions {
  anchorPath: string;
  maxFileBytes: number;
  remainingBytes: number;
  batchAssurance?: StableFileBatchAssurance;
}

export type StableFileReadResult =
  | { ok: true; text: string; bytesRead: number; mtimeMs: number }
  | { ok: false; reason: StableFileReadFailureReason };

export type StableDirectoryGuardFailureReason = StableFileReadFailureReason | 'missing';

export type StableDirectoryGuardResult =
  | { ok: true; finish: () => StableFileReadFailureReason | null }
  | { ok: false; reason: StableDirectoryGuardFailureReason };

declare const stableFileBatchAssuranceBrand: unique symbol;
export interface StableFileBatchAssurance {
  readonly [stableFileBatchAssuranceBrand]: true;
}

export type StableFileBatchAssuranceResult =
  | { ok: true; token: StableFileBatchAssurance }
  | { ok: false; reason: StableFileReadFailureReason };

const assuredBatchPaths = new WeakMap<StableFileBatchAssurance, Set<string>>();

function boundedByteLimit(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isContained(anchorPath: string, candidatePath: string): boolean {
  const nested = relative(anchorPath, candidatePath);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(nested);
}

function ownedByCurrentUser(stat: BigIntStats): boolean {
  return process.platform === 'win32' || typeof process.getuid !== 'function'
    || stat.uid === BigInt(process.getuid());
}

function protectedFromOtherUsers(stat: BigIntStats): boolean {
  return process.platform === 'win32' || (stat.mode & 0o022n) === 0n;
}

function safeDirectory(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && ownedByCurrentUser(stat)
    && protectedFromOtherUsers(stat);
}

function safeFile(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n
    && ownedByCurrentUser(stat) && protectedFromOtherUsers(stat);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function windowsAssuranceReason(reason: string): StableFileReadFailureReason {
  return reason.includes('anchor') || reason.includes('ancestor')
    ? 'unsafe-path'
    : 'unsafe-file';
}

/** Batch the expensive Windows owner/ACL checks once for a bounded list scan. */
export function assureStableRegularFiles(
  paths: string[],
  anchorPath: string,
): StableFileBatchAssuranceResult {
  const assurance = assurePrivateStoragePaths(paths, { anchorPath });
  if (!assurance.ok) return { ok: false, reason: windowsAssuranceReason(assurance.reason) };
  const token = {} as StableFileBatchAssurance;
  assuredBatchPaths.set(token, new Set(paths.map((candidate) => resolve(candidate))));
  return { ok: true, token };
}

function consumeBatchAssurance(
  token: StableFileBatchAssurance | undefined,
  filePath: string,
): boolean {
  if (!token) return false;
  const paths = assuredBatchPaths.get(token);
  if (!paths?.delete(filePath)) return false;
  if (paths.size === 0) assuredBatchPaths.delete(token);
  return true;
}

/**
 * Hold and verify a trusted store directory around a separate bounded
 * `opendir` traversal. POSIX keeps a no-follow descriptor open; Windows uses
 * the owner/reparse adapter and the same before/after identity fence.
 */
export function openStableDirectoryGuard(
  directoryPath: string,
  options: { anchorPath: string },
): StableDirectoryGuardResult {
  let fd: number | undefined;
  let inspected = false;
  try {
    const anchorPath = resolve(options.anchorPath);
    const resolvedDirectoryPath = resolve(directoryPath);
    if (!isContained(anchorPath, resolvedDirectoryPath)) {
      return { ok: false, reason: 'unsafe-path' };
    }

    let anchorBefore: BigIntStats;
    let directoryBefore: BigIntStats;
    try {
      anchorBefore = lstatSync(anchorPath, { bigint: true });
      directoryBefore = lstatSync(resolvedDirectoryPath, { bigint: true });
    } catch (error) {
      return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'io-error' };
    }
    inspected = true;
    if (!safeDirectory(anchorBefore) || !safeDirectory(directoryBefore)) {
      return { ok: false, reason: 'unsafe-path' };
    }

    const realAnchorBefore = realpathSync(anchorPath);
    const realDirectoryBefore = realpathSync(resolvedDirectoryPath);
    if (!isContained(realAnchorBefore, realDirectoryBefore) ||
      basename(realDirectoryBefore) !== basename(resolvedDirectoryPath)) {
      return { ok: false, reason: 'unsafe-path' };
    }

    if (process.platform === 'win32') {
      const assurance = assurePrivateStoragePath(
        resolvedDirectoryPath,
        'directory',
        'inspect-owned',
        { anchorPath },
      );
      if (!assurance.ok) {
        return { ok: false, reason: windowsAssuranceReason(assurance.reason) };
      }
    } else {
      const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
      const directoryOnly = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
      fd = openSync(resolvedDirectoryPath, fsConstants.O_RDONLY | noFollow | directoryOnly);
      const opened = fstatSync(fd, { bigint: true });
      if (!safeDirectory(opened) || !sameIdentity(directoryBefore, opened)) {
        closeSync(fd);
        fd = undefined;
        return { ok: false, reason: 'changed-during-read' };
      }
    }

    let finished = false;
    return {
      ok: true,
      finish: () => {
        if (finished) return 'changed-during-read';
        finished = true;
        try {
          const openedAfter = fd === undefined ? directoryBefore : fstatSync(fd, { bigint: true });
          const anchorAfter = lstatSync(anchorPath, { bigint: true });
          const directoryAfter = lstatSync(resolvedDirectoryPath, { bigint: true });
          const windowsStable = process.platform !== 'win32' || assurePrivateStoragePath(
            resolvedDirectoryPath,
            'directory',
            'inspect-owned',
            { anchorPath },
          ).ok;
          const stable = sameSnapshot(anchorBefore, anchorAfter)
            && sameSnapshot(directoryBefore, directoryAfter)
            && sameSnapshot(directoryBefore, openedAfter)
            && realAnchorBefore === realpathSync(anchorPath)
            && realDirectoryBefore === realpathSync(resolvedDirectoryPath)
            && safeDirectory(anchorAfter)
            && safeDirectory(directoryAfter)
            && windowsStable;
          return stable ? null : 'changed-during-read';
        } catch {
          return 'changed-during-read';
        } finally {
          if (fd !== undefined) {
            try { closeSync(fd); } catch { /* best-effort close */ }
            fd = undefined;
          }
        }
      },
    };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort close */ }
    }
    return { ok: false, reason: inspected ? 'changed-during-read' : 'io-error' };
  }
}

/**
 * Read one owner-controlled regular file without mutating it. The returned text
 * is bound to the inode opened and to stable anchor/parent directory snapshots.
 */
export function readStableRegularFile(
  filePath: string,
  options: StableFileReadOptions,
): StableFileReadResult {
  const maxFileBytes = boundedByteLimit(options.maxFileBytes);
  const remainingBytes = boundedByteLimit(options.remainingBytes);
  if (maxFileBytes === null || remainingBytes === null) return { ok: false, reason: 'io-error' };

  let fd: number | undefined;
  let pathInspected = false;
  try {
    const anchorPath = resolve(options.anchorPath);
    const resolvedFilePath = resolve(filePath);
    const parentPath = dirname(resolvedFilePath);
    if (!isContained(anchorPath, resolvedFilePath)) return { ok: false, reason: 'unsafe-path' };

    const anchorBefore = lstatSync(anchorPath, { bigint: true });
    const parentBefore = lstatSync(parentPath, { bigint: true });
    if (!safeDirectory(anchorBefore) || !safeDirectory(parentBefore)) {
      return { ok: false, reason: 'unsafe-path' };
    }

    const realAnchorBefore = realpathSync(anchorPath);
    const realParentBefore = realpathSync(parentPath);
    const realCandidatePath = resolve(realParentBefore, basename(resolvedFilePath));
    if (!isContained(realAnchorBefore, realCandidatePath) ||
      (realParentBefore !== realAnchorBefore && !isContained(realAnchorBefore, realParentBefore))) {
      return { ok: false, reason: 'unsafe-path' };
    }

    const pathBefore = lstatSync(resolvedFilePath, { bigint: true });
    if (!safeFile(pathBefore)) return { ok: false, reason: 'unsafe-file' };
    pathInspected = true;
    const realFileBefore = realpathSync(resolvedFilePath);
    if (dirname(realFileBefore) !== realParentBefore ||
      basename(realFileBefore) !== basename(resolvedFilePath)) {
      return { ok: false, reason: 'unsafe-path' };
    }

    if (process.platform === 'win32' &&
      !consumeBatchAssurance(options.batchAssurance, resolvedFilePath)) {
      const assurance = assurePrivateStoragePath(resolvedFilePath, 'file', 'inspect-owned', {
        anchorPath,
      });
      if (!assurance.ok) return { ok: false, reason: windowsAssuranceReason(assurance.reason) };
    }

    if (pathBefore.size > BigInt(maxFileBytes)) {
      return { ok: false, reason: 'per-file-byte-limit' };
    }
    if (pathBefore.size > BigInt(remainingBytes)) return { ok: false, reason: 'byte-limit' };

    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(resolvedFilePath, fsConstants.O_RDONLY | noFollow);
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!sameIdentity(pathBefore, openedBefore)) return { ok: false, reason: 'changed-during-read' };
    if (!safeFile(openedBefore)) return { ok: false, reason: 'unsafe-file' };
    if (openedBefore.size > BigInt(maxFileBytes)) {
      return { ok: false, reason: 'per-file-byte-limit' };
    }
    if (openedBefore.size > BigInt(remainingBytes)) return { ok: false, reason: 'byte-limit' };

    const expectedBytes = Number(openedBefore.size);
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead < expectedBytes) {
      const length = Math.min(READ_CHUNK_BYTES, expectedBytes - bytesRead);
      const chunk = Buffer.allocUnsafe(length);
      const count = readSync(fd, chunk, 0, length, bytesRead);
      if (count <= 0) return { ok: false, reason: 'changed-during-read' };
      chunks.push(count === length ? chunk : chunk.subarray(0, count));
      bytesRead += count;
    }

    const growthProbe = Buffer.allocUnsafe(1);
    if (readSync(fd, growthProbe, 0, 1, expectedBytes) !== 0) {
      return { ok: false, reason: 'changed-during-read' };
    }

    const openedAfter = fstatSync(fd, { bigint: true });
    let pathAfter: BigIntStats;
    let anchorAfter: BigIntStats;
    let parentAfter: BigIntStats;
    let realAnchorAfter: string;
    let realParentAfter: string;
    let realFileAfter: string;
    try {
      pathAfter = lstatSync(resolvedFilePath, { bigint: true });
      anchorAfter = lstatSync(anchorPath, { bigint: true });
      parentAfter = lstatSync(parentPath, { bigint: true });
      realAnchorAfter = realpathSync(anchorPath);
      realParentAfter = realpathSync(parentPath);
      realFileAfter = realpathSync(resolvedFilePath);
    } catch {
      return { ok: false, reason: 'changed-during-read' };
    }

    if (
      bytesRead !== expectedBytes
      || !sameSnapshot(openedBefore, openedAfter)
      || !sameSnapshot(openedAfter, pathAfter)
      || !sameSnapshot(anchorBefore, anchorAfter)
      || !sameSnapshot(parentBefore, parentAfter)
      || realAnchorBefore !== realAnchorAfter
      || realParentBefore !== realParentAfter
      || realFileBefore !== realFileAfter
      || !safeFile(pathAfter)
      || !safeDirectory(anchorAfter)
      || !safeDirectory(parentAfter)
    ) return { ok: false, reason: 'changed-during-read' };

    return {
      ok: true,
      text: Buffer.concat(chunks, bytesRead).toString('utf8'),
      bytesRead,
      mtimeMs: Number(openedAfter.mtimeNs) / 1_000_000,
    };
  } catch {
    return { ok: false, reason: pathInspected ? 'changed-during-read' : 'io-error' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort close after observational read */ }
    }
  }
}
