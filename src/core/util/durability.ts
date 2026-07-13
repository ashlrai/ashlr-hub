import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  type BigIntStats,
} from 'node:fs';

export interface DirectoryDurabilityFs {
  lstatSync(path: string, options: { bigint: true }): BigIntStats;
  openSync(path: string, flags: number): number;
  fstatSync(fd: number, options: { bigint: true }): BigIntStats;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

export interface DirectoryDurabilityOptions {
  platform?: NodeJS.Platform;
  fs?: DirectoryDurabilityFs;
}

const DEFAULT_FS: DirectoryDurabilityFs = {
  lstatSync: (path, options) => lstatSync(path, options),
  openSync,
  fstatSync: (fd, options) => fstatSync(fd, options),
  fsyncSync,
  closeSync,
};

const WINDOWS_UNSUPPORTED_DIRECTORY_FD_CODES = new Set([
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EPERM',
]);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireNamedDirectory(path: string, fs: DirectoryDurabilityFs): BigIntStats {
  const named = fs.lstatSync(path, { bigint: true });
  if (named.isSymbolicLink() || !named.isDirectory()) {
    throw new Error(`durability path is not a named directory: ${path}`);
  }
  return named;
}

function mayIgnoreWindowsDirectoryFdError(error: unknown, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && WINDOWS_UNSUPPORTED_DIRECTORY_FD_CODES.has(errorCode(error) ?? '');
}

/**
 * Make a preceding rename/create durable at the directory-entry layer.
 *
 * File writes and file fsyncs remain the caller's responsibility. POSIX treats
 * every directory open, identity, and fsync failure as fatal. Windows first
 * validates the named directory, then tolerates only errors that mean directory
 * descriptors or their fsync operation are unsupported by the filesystem.
 */
export function fsyncDirectory(path: string, options: DirectoryDurabilityOptions = {}): void {
  const fs = options.fs ?? DEFAULT_FS;
  const platform = options.platform ?? process.platform;
  const named = requireNamedDirectory(path, fs);
  let fd: number | undefined;

  try {
    try {
      const flags = platform === 'win32'
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
      fd = fs.openSync(path, flags);
    } catch (error) {
      if (mayIgnoreWindowsDirectoryFdError(error, platform)) return;
      throw error;
    }

    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !sameIdentity(named, opened)) {
      throw new Error(`durability directory identity changed: ${path}`);
    }

    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (!mayIgnoreWindowsDirectoryFdError(error, platform)) throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
