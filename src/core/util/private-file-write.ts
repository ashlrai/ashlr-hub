import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { dirname } from 'node:path';
import { open, type FileHandle } from 'node:fs/promises';

import { fsyncDirectory } from './durability.js';
import { assurePrivateStoragePath } from './private-storage.js';

export interface PrivateFileWriteOptions {
  anchorPath: string;
  label: string;
}

function ownedByCurrentUser(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function safeRegularFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    ownedByCurrentUser(stat) && (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeExactPath(path: string, identity: BigIntStats | undefined): void {
  if (!identity) return;
  try {
    const installed = lstatSync(path, { bigint: true });
    if (safeRegularFile(installed) && sameIdentity(installed, identity)) unlinkSync(path);
  } catch {
    // The exact temporary is already gone or was replaced; never remove a replacement.
  }
}

/** Create, secure, identity-pin, write, and fsync an exclusive private file. */
export function writePrivateFileAtomically(
  temporaryPath: string,
  targetPath: string,
  value: string | Buffer,
  options: PrivateFileWriteOptions,
): void {
  let fd: number | undefined;
  let identity: BigIntStats | undefined;
  let published = false;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    identity = fstatSync(fd, { bigint: true });
    if (!safeRegularFile(identity) || identity.size !== 0n) {
      throw new Error(`${options.label} is not a safe empty regular file`);
    }

    const assurance = assurePrivateStoragePath(temporaryPath, 'file', 'secure-created', {
      anchorPath: options.anchorPath,
    });
    if (!assurance.ok) throw new Error(`${options.label} is unsafe: ${assurance.reason}`);

    const installed = lstatSync(temporaryPath, { bigint: true });
    const opened = fstatSync(fd, { bigint: true });
    if (!safeRegularFile(installed) || !safeRegularFile(opened) ||
      !sameIdentity(identity, installed) || !sameIdentity(identity, opened) ||
      installed.size !== 0n || opened.size !== 0n) {
      throw new Error(`${options.label} changed during creation`);
    }

    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new Error(`${options.label} write made no progress`);
      offset += written;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);

    const namedBeforePublish = lstatSync(temporaryPath, { bigint: true });
    const openedBeforePublish = fstatSync(fd, { bigint: true });
    if (!safeRegularFile(namedBeforePublish) || !safeRegularFile(openedBeforePublish) ||
      !sameIdentity(identity, namedBeforePublish) || !sameIdentity(identity, openedBeforePublish) ||
      namedBeforePublish.size !== BigInt(bytes.length) ||
      openedBeforePublish.size !== BigInt(bytes.length)) {
      throw new Error(`${options.label} changed before publication`);
    }

    renameSync(temporaryPath, targetPath);
    published = true;
    const installedTarget = lstatSync(targetPath, { bigint: true });
    const openedAfterPublish = fstatSync(fd, { bigint: true });
    if (!safeRegularFile(installedTarget) || !safeRegularFile(openedAfterPublish) ||
      !sameIdentity(identity, installedTarget) || !sameIdentity(identity, openedAfterPublish)) {
      throw new Error(`${options.label} changed during publication`);
    }
    fsyncDirectory(dirname(targetPath));
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort before exact cleanup */ }
      fd = undefined;
    }
    if (!published) removeExactPath(temporaryPath, identity);
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** Async data IO/fsync counterpart. Metadata checks retain the synchronous writer's
 * exact private-path/inode rules. A host-only fence runs after awaits, immediately
 * before the synchronous metadata rename, with no JS yield between fence and commit.
 * Bulk data writes and fsync stay asynchronous. This is not an atomic transaction
 * against unrelated filesystem writers; external path changes remain detectable races. */
export async function writePrivateFileAtomicallyAsync(
  temporaryPath: string, targetPath: string, value: string | Buffer,
  options: PrivateFileWriteOptions & { beforePublish: () => void },
): Promise<void> {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  let handle: FileHandle | undefined;
  let identity: BigIntStats | undefined;
  let published = false;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    identity = await handle.stat({ bigint: true });
    if (!safeRegularFile(identity) || identity.size !== 0n) throw new Error(`${options.label} is not a safe empty regular file`);
    if (!assurePrivateStoragePath(temporaryPath, 'file', 'secure-created', { anchorPath: options.anchorPath }).ok) {
      throw new Error(`${options.label} is unsafe`);
    }
    const installed = lstatSync(temporaryPath, { bigint: true });
    const opened = await handle.stat({ bigint: true });
    if (!safeRegularFile(installed) || !safeRegularFile(opened) || !sameIdentity(identity, installed) ||
      !sameIdentity(identity, opened) || installed.size !== 0n || opened.size !== 0n) throw new Error(`${options.label} changed during creation`);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (bytesWritten <= 0) throw new Error(`${options.label} write made no progress`);
      offset += bytesWritten;
    }
    await handle.chmod(0o600); await handle.sync();
    const fdBefore = await handle.stat({ bigint: true });
    // No JS yield after checking the named temporary and the host fence.
    const before = lstatSync(temporaryPath, { bigint: true });
    if (!safeRegularFile(before) || !safeRegularFile(fdBefore) || !sameIdentity(identity, before) ||
      !sameIdentity(identity, fdBefore) || before.size !== BigInt(bytes.length) || fdBefore.size !== BigInt(bytes.length)) {
      throw new Error(`${options.label} changed before publication`);
    }
    options.beforePublish();
    renameSync(temporaryPath, targetPath); published = true;
    const target = lstatSync(targetPath, { bigint: true }); const fdAfter = await handle.stat({ bigint: true });
    if (!safeRegularFile(target) || !safeRegularFile(fdAfter) || !sameIdentity(identity, target) || !sameIdentity(identity, fdAfter)) {
      throw new Error(`${options.label} changed during publication`);
    }
    // Same directory-entry durability contract as fsyncDirectory, with async fsync.
    const directory = dirname(targetPath); const named = lstatSync(directory, { bigint: true });
    if (!named.isDirectory() || named.isSymbolicLink()) throw new Error('Durability directory unavailable');
    let dir: FileHandle | undefined;
    try {
      dir = await open(directory, process.platform === 'win32' ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollow);
      const openedDir = await dir.stat({ bigint: true });
      if (!openedDir.isDirectory() || !sameIdentity(named, openedDir)) throw new Error('Durability directory identity changed');
      await dir.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !code || !['EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(code)) throw error;
    } finally { await dir?.close(); }
  } finally {
    try { await handle?.close(); }
    finally {
      if (!published && identity) {
        try {
          const installed = lstatSync(temporaryPath, { bigint: true });
          if (safeRegularFile(installed) && sameIdentity(installed, identity)) unlinkSync(temporaryPath);
        } catch { /* Never remove a replacement or a path whose identity is unknown. */ }
      }
    }
  }
}
