import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';

import { assurePrivateStoragePath } from './private-storage.js';

export interface PrivateFileWriteOptions {
  anchorPath: string;
  label: string;
}

function ownedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function safeRegularFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    ownedByCurrentUser(stat) && (process.platform === 'win32' || (stat.mode & 0o022) === 0);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeExactPath(path: string, identity: Stats | undefined): void {
  if (!identity) return;
  try {
    const installed = lstatSync(path);
    if (safeRegularFile(installed) && sameIdentity(installed, identity)) unlinkSync(path);
  } catch {
    // The exact temporary is already gone or was replaced; never remove a replacement.
  }
}

/** Create, secure, identity-pin, write, and fsync an exclusive private file. */
export function writePrivateFileExclusive(
  path: string,
  value: string | Buffer,
  options: PrivateFileWriteOptions,
): void {
  let fd: number | undefined;
  let identity: Stats | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    identity = fstatSync(fd);
    if (!safeRegularFile(identity) || identity.size !== 0) {
      throw new Error(`${options.label} is not a safe empty regular file`);
    }

    const assurance = assurePrivateStoragePath(path, 'file', 'secure-created', {
      anchorPath: options.anchorPath,
    });
    if (!assurance.ok) throw new Error(`${options.label} is unsafe: ${assurance.reason}`);

    const installed = lstatSync(path);
    const opened = fstatSync(fd);
    if (!safeRegularFile(installed) || !safeRegularFile(opened) ||
      !sameIdentity(identity, installed) || !sameIdentity(identity, opened) ||
      installed.size !== 0 || opened.size !== 0) {
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
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort before exact cleanup */ }
      fd = undefined;
    }
    removeExactPath(path, identity);
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}
