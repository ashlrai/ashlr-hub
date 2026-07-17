import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { endianness, homedir } from 'node:os';
import { fsyncDirectory as fsyncDirectoryEntry } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

const INIT_GRACE_MS = 1_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const PROCESS_START_PROBE_OPTIONS = Object.freeze({
  encoding: 'utf8' as const,
  timeout: 1_000,
  maxBuffer: 1_024,
  shell: false as const,
  windowsHide: true,
});
const WINDOWS_START_TIME_SCRIPT =
  '& { param([int]$TargetPid) (Get-Process -Id $TargetPid -ErrorAction Stop).StartTime.ToUniversalTime().Ticks }';

interface ProcessStartProbeResult {
  status: number | null;
  stdout: string | Buffer | null;
}

export interface ProcessStartIdentityRuntime {
  readonly platform: NodeJS.Platform;
  run(
    command: string,
    args: readonly string[],
    options: typeof PROCESS_START_PROBE_OPTIONS,
  ): ProcessStartProbeResult;
  readLinuxProcStat(pid: number): string | undefined;
  readLinuxBootTimeSeconds?(): number | undefined;
  readLinuxClockTicks?(): number | undefined;
}

export type ProcessStartIdentitySource =
  | 'self-clock-epoch-second'
  | 'ps-lstart'
  | 'linux-proc-start-ticks'
  | 'windows-start-ticks';

export interface VerifiedProcessStartIdentity {
  readonly source: ProcessStartIdentitySource;
  readonly ref: string;
  readonly epochSecond: number;
}

export interface LocalStoreLock {
  readonly path: string;
  readonly token: string;
  readonly dev: number;
  readonly ino: number;
}

const acquiredLocks = new WeakSet<object>();
const acquiredLockDirectories = new WeakMap<object, LockDirectory>();
const retainedReleases = new Map<string, LocalStoreLock>();

function acquiredLock(
  path: string,
  token: string,
  dev: number,
  ino: number,
  directory: LockDirectory,
): LocalStoreLock {
  const lock: LocalStoreLock = Object.freeze({ path, token, dev, ino });
  acquiredLocks.add(lock);
  acquiredLockDirectories.set(lock, directory);
  return lock;
}

function isAcquiredLock(lock: LocalStoreLock | null | undefined): lock is LocalStoreLock {
  return typeof lock === 'object' && lock !== null && acquiredLocks.has(lock);
}

function owned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

interface LockDirectory {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly anchor: LockAnchor;
  readonly exactPrivateStorage: boolean;
}

interface LockAnchor {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

function privateMode(stat: Pick<Stats, 'mode'>, expected: number): boolean {
  return process.platform === 'win32' || (stat.mode & 0o777) === expected;
}

function sameFile(left: Pick<Stats, 'dev' | 'ino'>, right: Pick<Stats, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function nestedWithin(anchor: string, target: string): boolean {
  const nested = relative(anchor, target);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

function pinTrustedAnchor(lockDirectory: string, requestedAnchor?: string): LockAnchor | null {
  try {
    const absoluteDirectory = resolve(lockDirectory);
    const home = resolve(homedir());
    const root = parse(absoluteDirectory).root;
    const anchorPath = requestedAnchor === undefined
      ? absoluteDirectory !== home && nestedWithin(home, absoluteDirectory) ? home : root
      : resolve(requestedAnchor);
    if (!nestedWithin(anchorPath, absoluteDirectory)) return null;
    const stat = lstatSync(anchorPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    if (anchorPath !== root && !owned(stat.uid)) return null;
    return { path: anchorPath, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function stableAnchor(anchor: LockAnchor): boolean {
  try {
    const stat = lstatSync(anchor.path);
    return !stat.isSymbolicLink() && stat.isDirectory() && sameFile(stat, anchor);
  } catch {
    return false;
  }
}

function stableDirectory(directory: LockDirectory): boolean {
  try {
    const stat = lstatSync(directory.path);
    return stat.isDirectory() && !stat.isSymbolicLink() && owned(stat.uid) &&
      privateMode(stat, PRIVATE_DIRECTORY_MODE) && sameFile(stat, directory) &&
      stableAnchor(directory.anchor);
  } catch {
    return false;
  }
}

function releaseDirectoryState(directory: LockDirectory): 'stable' | 'retry' | 'lost' {
  try {
    const anchorBefore = lstatSync(directory.anchor.path);
    if (!sameFile(anchorBefore, directory.anchor)) return 'lost';
    if (anchorBefore.isSymbolicLink() || !anchorBefore.isDirectory()) return 'retry';
    const before = lstatSync(directory.path);
    if (!sameFile(before, directory)) return 'lost';
    if (before.isSymbolicLink() || !before.isDirectory() || !owned(before.uid) ||
      !privateMode(before, PRIVATE_DIRECTORY_MODE)) return 'retry';
    if (directory.exactPrivateStorage && !assurePrivateStoragePath(
      directory.path,
      'directory',
      'inspect-existing',
      { anchorPath: directory.anchor.path },
    ).ok) return 'retry';
    const anchorAfter = lstatSync(directory.anchor.path);
    const after = lstatSync(directory.path);
    if (!sameFile(anchorAfter, directory.anchor) || !sameFile(after, directory)) return 'lost';
    return !anchorAfter.isSymbolicLink() && anchorAfter.isDirectory() &&
      !after.isSymbolicLink() && after.isDirectory() && owned(after.uid) &&
      privateMode(after, PRIVATE_DIRECTORY_MODE)
      ? 'stable'
      : 'retry';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'lost' : 'retry';
  }
}

function fsyncDirectory(path: string): boolean {
  try {
    fsyncDirectoryEntry(path);
    return true;
  } catch {
    return false;
  }
}

function assureLockDirectory(
  path: string,
  anchor: LockAnchor,
  exactPrivateStorage: boolean,
): LockDirectory | null {
  try {
    if (!stableAnchor(anchor) || !nestedWithin(anchor.path, path)) return null;
    let created = false;
    if (!existsSync(path)) {
      const firstCreated = mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      created = firstCreated !== undefined;
    }
    const initial = lstatSync(path);
    if (
      initial.isSymbolicLink() || !initial.isDirectory() || !owned(initial.uid)
    ) return null;
    if (created || process.platform !== 'win32') chmodSync(path, PRIVATE_DIRECTORY_MODE);
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() || !before.isDirectory() || !owned(before.uid) ||
      !privateMode(before, PRIVATE_DIRECTORY_MODE) || !sameFile(initial, before)
    ) return null;
    if (exactPrivateStorage && !assurePrivateStoragePath(
      path,
      'directory',
      created ? 'secure-created' : 'inspect-existing',
      { anchorPath: anchor.path },
    ).ok) return null;
    const after = lstatSync(path);
    if (
      after.isSymbolicLink() || !after.isDirectory() || !owned(after.uid) ||
      !privateMode(after, PRIVATE_DIRECTORY_MODE) || !sameFile(before, after)
    ) return null;
    if (!stableAnchor(anchor) || (created && !fsyncDirectory(dirname(path)))) return null;
    const directory = { path, dev: after.dev, ino: after.ino, anchor, exactPrivateStorage };
    return stableDirectory(directory) ? directory : null;
  } catch {
    return null;
  }
}

function inspectExistingLockFile(
  path: string,
  allowedLinks: readonly number[] = [1, 2],
  directory?: LockDirectory,
): Stats | null {
  try {
    const anchor = directory?.anchor ?? pinTrustedAnchor(dirname(path));
    if (!anchor || !stableAnchor(anchor) || !nestedWithin(anchor.path, path)) return null;
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() || !before.isFile() || !owned(before.uid) ||
      !privateMode(before, PRIVATE_FILE_MODE) || !allowedLinks.includes(before.nlink)
    ) return null;
    if ((directory?.exactPrivateStorage ?? false) && !assurePrivateStoragePath(
      path,
      'file',
      'inspect-existing',
      { anchorPath: anchor.path },
    ).ok) return null;
    const after = lstatSync(path);
    return !after.isSymbolicLink() && after.isFile() && owned(after.uid) &&
      privateMode(after, PRIVATE_FILE_MODE) && allowedLinks.includes(after.nlink) &&
      sameFile(before, after) && before.size === after.size &&
      stableAnchor(anchor) && (directory === undefined || stableDirectory(directory))
      ? after
      : null;
  } catch {
    return null;
  }
}

function secureFreshCandidate(
  path: string,
  fd: number,
  opened: Stats,
  directory: LockDirectory,
): boolean {
  try {
    if (!stableDirectory(directory)) return false;
    fchmodSync(fd, PRIVATE_FILE_MODE);
    const before = fstatSync(fd);
    const namedBefore = lstatSync(path);
    if (
      !before.isFile() || before.nlink !== 1 || before.size !== 0 || !owned(before.uid) ||
      !privateMode(before, PRIVATE_FILE_MODE) || !sameFile(opened, before) ||
      namedBefore.isSymbolicLink() || !namedBefore.isFile() || namedBefore.nlink !== 1 ||
      namedBefore.size !== 0 || !owned(namedBefore.uid) || !privateMode(namedBefore, PRIVATE_FILE_MODE) ||
      !sameFile(before, namedBefore)
    ) return false;
    if (directory.exactPrivateStorage && !assurePrivateStoragePath(
      path,
      'file',
      'secure-created',
      { anchorPath: directory.anchor.path },
    ).ok) return false;
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    return after.isFile() && after.nlink === 1 && after.size === 0 && owned(after.uid) &&
      privateMode(after, PRIVATE_FILE_MODE) && sameFile(before, after) &&
      namedAfter.isFile() && !namedAfter.isSymbolicLink() && namedAfter.nlink === 1 &&
      namedAfter.size === 0 && owned(namedAfter.uid) && privateMode(namedAfter, PRIVATE_FILE_MODE) &&
      sameFile(after, namedAfter) && stableDirectory(directory);
  } catch {
    return false;
  }
}

function readLinuxProcStat(pid: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(`/proc/${pid}/stat`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const bytes = Buffer.alloc(4_097);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    if (read < 1 || read > 4_096) return undefined;
    return bytes.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function readBoundedFile(path: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const bytes = Buffer.alloc(maxBytes + 1);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    return read >= 1 && read <= maxBytes ? bytes.subarray(0, read) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function readLinuxBootTimeSeconds(): number | undefined {
  const value = readBoundedFile('/proc/stat', 1024 * 1024)?.toString('utf8')
    .match(/^btime\s+(\d+)$/m)?.[1];
  const seconds = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function readLinuxClockTicks(): number | undefined {
  const auxv = readBoundedFile('/proc/self/auxv', 16 * 1024);
  if (!auxv) return undefined;
  const wordBytes = process.arch === 'ia32' || process.arch === 'arm' ? 4 : 8;
  const entryBytes = wordBytes * 2;
  const littleEndian = endianness() === 'LE';
  for (let offset = 0; offset + entryBytes <= auxv.length; offset += entryBytes) {
    const type = wordBytes === 8
      ? Number(littleEndian ? auxv.readBigUInt64LE(offset) : auxv.readBigUInt64BE(offset))
      : littleEndian ? auxv.readUInt32LE(offset) : auxv.readUInt32BE(offset);
    if (type === 0) break;
    if (type !== 17) continue; // AT_CLKTCK
    const valueOffset = offset + wordBytes;
    const ticks = wordBytes === 8
      ? Number(littleEndian ? auxv.readBigUInt64LE(valueOffset) : auxv.readBigUInt64BE(valueOffset))
      : littleEndian ? auxv.readUInt32LE(valueOffset) : auxv.readUInt32BE(valueOffset);
    return Number.isSafeInteger(ticks) && ticks > 0 && ticks <= 1_000_000 ? ticks : undefined;
  }
  return undefined;
}

const processStartIdentityRuntime: ProcessStartIdentityRuntime = {
  platform: process.platform,
  run(command, args, options) {
    return spawnSync(command, [...args], options);
  },
  readLinuxProcStat,
  readLinuxBootTimeSeconds,
  readLinuxClockTicks,
};

function commandOutput(
  runtime: ProcessStartIdentityRuntime,
  command: string,
  args: readonly string[],
): string | undefined {
  try {
    const result = runtime.run(command, args, PROCESS_START_PROBE_OPTIONS);
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function linuxProcStartTime(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(') ');
  if (commandEnd < 2) return undefined;
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const startTime = fields[19];
  return fields.length >= 20 && typeof startTime === 'string' && /^\d+$/.test(startTime)
    ? startTime
    : undefined;
}

function canonicalStartIdentity(
  source: ProcessStartIdentitySource,
  epochSecond: number,
): VerifiedProcessStartIdentity | undefined {
  if (!Number.isSafeInteger(epochSecond) || epochSecond < 0 ||
    epochSecond > Math.floor(Date.now() / 1_000) + 86_400) return undefined;
  return {
    source,
    epochSecond,
    ref: BigInt(epochSecond).toString(16).padStart(64, '0'),
  };
}

export function canonicalStartEpochSecond(
  ref: string,
  source: unknown,
): number | undefined {
  if (source !== 'self-clock-epoch-second' || !/^[a-f0-9]{64}$/.test(ref)) return undefined;
  try {
    const epochSecond = Number(BigInt(`0x${ref}`));
    return canonicalStartIdentity('self-clock-epoch-second', epochSecond)?.epochSecond;
  } catch {
    return undefined;
  }
}

export function currentProcessStartIdentity(
  nowMs = Date.now(),
  uptimeSeconds = process.uptime(),
): VerifiedProcessStartIdentity | undefined {
  if (!Number.isFinite(nowMs) || !Number.isFinite(uptimeSeconds) ||
    nowMs < 0 || uptimeSeconds < 0) return undefined;
  return canonicalStartIdentity(
    'self-clock-epoch-second',
    Math.floor((nowMs - uptimeSeconds * 1_000) / 1_000),
  );
}

/** Return a verified, source-tagged process-start identity or undefined on uncertainty. */
export function verifiedProcessStartIdentity(
  pid: number,
  options: {
    runtime?: ProcessStartIdentityRuntime;
    requiredSource?: ProcessStartIdentitySource;
  } = {},
): VerifiedProcessStartIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  const runtime = options.runtime ?? processStartIdentityRuntime;
  const requiredSource = options.requiredSource;
  if (runtime.platform === 'win32') {
    if (requiredSource !== undefined && requiredSource !== 'windows-start-ticks') return undefined;
    const value = commandOutput(runtime, 'powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_START_TIME_SCRIPT,
      String(pid),
    ]);
    if (!value || !/^\d+$/.test(value)) return undefined;
    try {
      const unixTicks = BigInt(value) - 621_355_968_000_000_000n;
      return unixTicks >= 0
        ? canonicalStartIdentity('windows-start-ticks', Number(unixTicks / 10_000_000n))
        : undefined;
    } catch {
      return undefined;
    }
  }

  if (requiredSource === undefined || requiredSource === 'ps-lstart') {
    let psValue = commandOutput(runtime, 'ps', ['-o', 'lstart=', '-p', String(pid)]);
    if (!psValue && runtime.platform === 'darwin') {
      psValue = commandOutput(runtime, '/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    }
    if (psValue) {
      const startMs = Date.parse(psValue);
      if (Number.isFinite(startMs)) {
        return canonicalStartIdentity('ps-lstart', Math.floor(startMs / 1_000));
      }
    }
    if (requiredSource === 'ps-lstart') return undefined;
  }

  if (runtime.platform !== 'linux' ||
    (requiredSource !== undefined && requiredSource !== 'linux-proc-start-ticks')) return undefined;

  try {
    const startTicks = Number(linuxProcStartTime(runtime.readLinuxProcStat(pid) ?? ''));
    const bootTime = runtime.readLinuxBootTimeSeconds?.();
    const clockTicks = runtime.readLinuxClockTicks?.();
    return Number.isSafeInteger(startTicks) && startTicks >= 0 && bootTime !== undefined &&
      clockTicks !== undefined
      ? canonicalStartIdentity(
          'linux-proc-start-ticks',
          Math.floor(bootTime + startTicks / clockTicks),
        )
      : undefined;
  } catch {
    return undefined;
  }
}

export function verifiedProcessStartRef(
  pid: number,
  runtime: ProcessStartIdentityRuntime = processStartIdentityRuntime,
): string | undefined {
  return verifiedProcessStartIdentity(pid, { runtime })?.ref;
}

interface AuthorityStartIdentity {
  ref: string;
  verified: true;
  source: ProcessStartIdentitySource;
}

let ownStartIdentity: AuthorityStartIdentity | undefined;
function currentStartIdentity(
): AuthorityStartIdentity | null {
  if (ownStartIdentity === undefined) {
    const observed = currentProcessStartIdentity();
    if (!observed) return null;
    ownStartIdentity = { ref: observed.ref, source: observed.source, verified: true };
  }
  return ownStartIdentity ?? null;
}

function hasExpectedToken(
  path: string,
  expected: { dev: number; ino: number; token: string },
  expectedLinks: number,
  directory: LockDirectory,
  exactInspection = true,
): boolean {
  let fd: number | undefined;
  try {
    const named = exactInspection
      ? inspectExistingLockFile(path, [expectedLinks], directory)
      : lstatSync(path);
    if (!named || named.isSymbolicLink() || !named.isFile() || !owned(named.uid) ||
      !privateMode(named, PRIVATE_FILE_MODE) || named.nlink !== expectedLinks ||
      !sameFile(named, expected) || !stableDirectory(directory)) return false;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || !owned(opened.uid) || opened.dev !== expected.dev ||
      opened.ino !== expected.ino || opened.nlink !== expectedLinks ||
      !privateMode(opened, PRIVATE_FILE_MODE) || opened.size < 2 || opened.size > 512
    ) return false;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return false;
    const owner = JSON.parse(bytes.toString('utf8')) as { token?: unknown };
    return owner.token === expected.token;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function removeEmptyCandidate(
  path: string,
  expected: Pick<Stats, 'dev' | 'ino'>,
  directory: LockDirectory,
): boolean {
  try {
    if (!stableDirectory(directory)) return false;
    const current = lstatSync(path);
    if (
      current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || current.size !== 0 ||
      !owned(current.uid) || !privateMode(current, PRIVATE_FILE_MODE) || !sameFile(current, expected)
    ) return false;
    unlinkSync(path);
    return fsyncDirectory(dirname(path)) && stableDirectory(directory);
  } catch {
    return false;
  }
}

function removeSecuredCandidate(
  path: string,
  expected: Pick<Stats, 'dev' | 'ino'>,
  directory: LockDirectory,
): boolean {
  try {
    const current = inspectExistingLockFile(path, [1], directory);
    if (!current || !sameFile(current, expected) || !stableDirectory(directory)) return false;
    unlinkSync(path);
    return fsyncDirectory(dirname(path)) && stableDirectory(directory);
  } catch {
    return false;
  }
}

function collapsePublishedCandidate(
  canonical: string,
  candidate: string,
  expected: { dev: number; ino: number; token: string },
  directory: LockDirectory,
): boolean {
  try {
    if (!hasExpectedToken(candidate, expected, 2, directory) ||
      !hasExpectedToken(canonical, expected, 2, directory)) {
      return false;
    }
    const candidateBefore = lstatSync(candidate);
    const canonicalBefore = lstatSync(canonical);
    if (
      !sameFile(candidateBefore, expected) || !sameFile(canonicalBefore, expected) ||
      candidateBefore.nlink !== 2 || canonicalBefore.nlink !== 2
    ) return false;
    unlinkSync(candidate);
    return hasExpectedToken(canonical, expected, 1, directory) &&
      fsyncDirectory(dirname(canonical)) && stableDirectory(directory);
  } catch {
    return false;
  }
}

function safelyUnlink(
  path: string,
  expected: { dev: number; ino: number; token: string },
  directory: LockDirectory,
  allowedLinks: readonly number[] = [1],
  exactInspection = true,
): boolean {
  const guard = `${path}.unlink-${process.pid}-${randomUUID()}.guard`;
  let guarded = false;
  let removed = false;
  let guardRemoved = true;
  try {
    const current = exactInspection
      ? inspectExistingLockFile(path, allowedLinks, directory)
      : lstatSync(path);
    if (!current) return false;
    if (
      current.isSymbolicLink() || !current.isFile() || !owned(current.uid) ||
      !privateMode(current, PRIVATE_FILE_MODE) || !allowedLinks.includes(current.nlink) ||
      current.dev !== expected.dev || current.ino !== expected.ino || !stableDirectory(directory)
    ) return false;
    // Pin this exact inode under a unique name before removing the requested
    // path. The elevated link count makes cooperating contenders fail closed.
    linkSync(path, guard);
    guarded = true;
    const pinned = lstatSync(guard);
    const stillCurrent = lstatSync(path);
    const pinnedLinks = current.nlink + 1;
    if (
      pinned.dev !== expected.dev || pinned.ino !== expected.ino || pinned.nlink !== pinnedLinks ||
      stillCurrent.dev !== expected.dev || stillCurrent.ino !== expected.ino ||
      stillCurrent.nlink !== pinnedLinks ||
      !hasExpectedToken(guard, expected, pinnedLinks, directory, exactInspection)
    ) return false;
    unlinkSync(path);
    const remaining = lstatSync(guard);
    removed = remaining.dev === expected.dev && remaining.ino === expected.ino &&
      remaining.nlink === current.nlink &&
      hasExpectedToken(guard, expected, current.nlink, directory, exactInspection);
  } catch { removed = false; }
  finally {
    if (guarded) {
      try { unlinkSync(guard); }
      catch { guardRemoved = false; }
    }
  }
  return removed && guardRemoved && fsyncDirectory(dirname(path)) && stableDirectory(directory);
}

function settleCanonicalInstallation(
  path: string,
  candidate: string,
  expected: LocalStoreLock,
  directory: LockDirectory,
): LocalStoreLock | null {
  try {
    const candidateStat = lstatSync(candidate);
    if (
      !candidateStat.isSymbolicLink() && candidateStat.isFile() && owned(candidateStat.uid) &&
      candidateStat.dev === expected.dev && candidateStat.ino === expected.ino
    ) collapsePublishedCandidate(path, candidate, expected, directory);
  } catch { /* candidate may already be gone */ }

  if (ownsLocalStoreLock(expected) && fsyncDirectory(dirname(path)) && stableDirectory(directory)) {
    return expected;
  }
  if (safelyUnlink(path, expected, directory, [1, 2])) {
    try {
      const candidateStat = lstatSync(candidate);
      if (sameFile(candidateStat, expected)) safelyUnlink(candidate, expected, directory);
    } catch { /* candidate already absent */ }
    return null;
  }
  if (ownsLocalStoreLock(expected) && fsyncDirectory(dirname(path)) && stableDirectory(directory)) {
    return expected;
  }

  try {
    const current = lstatSync(path);
    if (current.dev !== expected.dev || current.ino !== expected.ino) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  }
  throw new Error(`unable to reconcile installed local store lock: ${path}`);
}

function collapseLockAlias(
  path: string,
  expected: { dev: number; ino: number; token: string },
  names: readonly string[],
  directory: LockDirectory,
): boolean {
  const dir = dirname(path);
  try {
    if (!hasExpectedToken(path, expected, 2, directory)) return false;
    for (const name of names) {
      const alias = join(dir, name);
      const stat = lstatSync(alias);
      if (
        stat.isSymbolicLink() || !stat.isFile() || !owned(stat.uid) ||
        stat.dev !== expected.dev || stat.ino !== expected.ino || stat.nlink !== 2 ||
        !hasExpectedToken(alias, expected, 2, directory)
      ) continue;
      const canonical = lstatSync(path);
      const confirmedAlias = lstatSync(alias);
      if (
        canonical.dev !== expected.dev || canonical.ino !== expected.ino || canonical.nlink !== 2 ||
        confirmedAlias.dev !== expected.dev || confirmedAlias.ino !== expected.ino ||
        confirmedAlias.nlink !== 2
      ) return false;
      unlinkSync(alias);
      const installed = lstatSync(path);
      return installed.dev === expected.dev && installed.ino === expected.ino && installed.nlink === 1 &&
        hasExpectedToken(path, expected, 1, directory) && fsyncDirectory(dir) &&
        stableDirectory(directory);
    }
  } catch { /* uncertain two-link state remains fail-closed */ }
  return false;
}

function collapseInstalledCandidate(
  path: string,
  expected: { dev: number; ino: number; token: string; pid: number },
  directory: LockDirectory,
): boolean {
  const candidate = `${basename(path)}.${expected.pid}.${expected.token}.candidate`;
  return collapseLockAlias(path, expected, [candidate], directory);
}

function unlinkGuardCreatorPid(canonicalBasename: string, name: string): number | undefined {
  const prefix = `${canonicalBasename}.unlink-`;
  const suffix = '.guard';
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return undefined;
  const identity = name.slice(prefix.length, -suffix.length);
  const match = identity.match(
    /^([1-9]\d*)-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i,
  );
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function collapseAbandonedUnlinkGuard(
  path: string,
  expected: { dev: number; ino: number; token: string },
  directory: LockDirectory,
): boolean {
  const canonicalBasename = basename(path);
  const dir = dirname(path);
  try {
    if (!hasExpectedToken(path, expected, 2, directory)) return false;
    for (const name of readdirSync(dir)) {
      const creatorPid = unlinkGuardCreatorPid(canonicalBasename, name);
      if (creatorPid === undefined) continue;
      const guard = join(dir, name);
      const stat = lstatSync(guard);
      if (
        stat.isSymbolicLink() || !stat.isFile() || !owned(stat.uid) || stat.nlink !== 2 ||
        stat.dev !== expected.dev || stat.ino !== expected.ino
      ) continue;
      if (!hasExpectedToken(guard, expected, 2, directory) || !isProcessProvablyDead(creatorPid)) {
        return false;
      }
      // collapseLockAlias repeats the inode/link/token checks after the death
      // probe, so a renamed alias or in-place ownership ABA fails closed.
      return collapseLockAlias(path, expected, [name], directory);
    }
    return false;
  } catch {
    return false;
  }
}

function ownerState(
  path: string,
  expected: { dev: number; ino: number; mtimeMs: number },
  directory: LockDirectory,
): { state: 'alive' | 'dead' | 'initializing' | 'unknown'; token?: string; pid?: number } {
  let fd: number | undefined;
  try {
    const named = inspectExistingLockFile(path, [1, 2], directory);
    if (!named || !sameFile(named, expected)) {
      return { state: Date.now() - expected.mtimeMs < INIT_GRACE_MS ? 'initializing' : 'unknown' };
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || opened.nlink < 1 || opened.nlink > 2 || !owned(opened.uid) ||
      opened.dev !== expected.dev || opened.ino !== expected.ino ||
      !privateMode(opened, PRIVATE_FILE_MODE) || opened.size < 2 || opened.size > 512
    ) return { state: Date.now() - expected.mtimeMs < INIT_GRACE_MS ? 'initializing' : 'unknown' };
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return { state: 'unknown' };
    const owner = JSON.parse(bytes.toString('utf8')) as {
      pid?: unknown; token?: unknown; startRef?: unknown; startRefVerified?: unknown;
      startRefSource?: unknown;
    };
    if (
      !Number.isInteger(owner.pid) || Number(owner.pid) < 1 ||
      typeof owner.token !== 'string' || owner.token.length < 1 || owner.token.length > 64
    ) return { state: Date.now() - expected.mtimeMs < INIT_GRACE_MS ? 'initializing' : 'unknown' };
    const pid = Number(owner.pid);
    try { process.kill(pid, 0); }
    catch (error) {
      return {
        state: (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive',
        token: owner.token,
        pid,
      };
    }
    // A start-time mismatch is not proof of death. Wall-clock corrections,
    // suspend/resume, and timezone-ambiguous ps output can all move an epoch
    // estimate while the owner is still alive. Reclaim only after ESRCH; PID
    // reuse may delay recovery until the replacement process exits, but cannot
    // steal authority from a live process.
    return { state: 'alive', token: owner.token, pid };
  } catch {
    return { state: Date.now() - expected.mtimeMs < INIT_GRACE_MS ? 'initializing' : 'unknown' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function contendedOwnerState(path: string): 'absent' | 'alive' | 'dead' | 'initializing' | 'unknown' {
  let fd: number | undefined;
  let observed: Stats | undefined;
  try {
    observed = lstatSync(path);
    if (
      observed.isSymbolicLink() || !observed.isFile() || !owned(observed.uid) ||
      !privateMode(observed, PRIVATE_FILE_MODE) || observed.nlink < 1 || observed.nlink > 2
    ) return 'unknown';
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || !owned(opened.uid) || !privateMode(opened, PRIVATE_FILE_MODE) ||
      opened.dev !== observed.dev || opened.ino !== observed.ino ||
      opened.nlink < 1 || opened.nlink > 2 || opened.size < 2 || opened.size > 512
    ) return Date.now() - observed.mtimeMs < INIT_GRACE_MS ? 'initializing' : 'unknown';
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return 'unknown';
    const owner = JSON.parse(bytes.toString('utf8')) as { pid?: unknown; token?: unknown };
    if (!Number.isInteger(owner.pid) || Number(owner.pid) < 1 ||
      typeof owner.token !== 'string' || owner.token.length < 1 || owner.token.length > 64) {
      return Date.now() - observed.mtimeMs < INIT_GRACE_MS ? 'initializing' : 'unknown';
    }
    try {
      process.kill(Number(owner.pid), 0);
      return 'alive';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive';
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && observed === undefined
      ? 'absent'
      : 'unknown';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function acquireReclaimElection(
  path: string,
  start: AuthorityStartIdentity,
  directory: LockDirectory,
): LocalStoreLock | null {
  const ownerPath = `${path}.reclaim.owner`;
  const token = randomUUID();
  const candidate = `${ownerPath}.${process.pid}.${token}.candidate`;
  let fd: number | undefined;
  let candidateIdentity: Stats | undefined;
  let candidateSecured = false;
  let installedLock: LocalStoreLock | undefined;
  let election: LocalStoreLock | null = null;
  try {
    fd = openSync(
      candidate,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    candidateIdentity = opened;
    if (!secureFreshCandidate(candidate, fd, opened, directory)) return null;
    candidateSecured = true;
    const bytes = Buffer.from(`${JSON.stringify({
      pid: process.pid,
      token,
      startRef: start.ref,
      startRefVerified: start.verified,
      startRefSource: start.source,
    })}\n`, 'utf8');
    const writtenBytes = writeSync(fd, bytes);
    if (writtenBytes !== bytes.length) return null;
    fchmodSync(fd, PRIVATE_FILE_MODE);
    fsyncSync(fd);
    const written = fstatSync(fd);
    if (
      !written.isFile() || written.nlink !== 1 || written.size !== bytes.length ||
      !sameFile(written, opened) || !privateMode(written, PRIVATE_FILE_MODE)
    ) return null;
    closeSync(fd);
    fd = undefined;
    if (!hasExpectedToken(candidate, { ...opened, token }, 1, directory) ||
      !stableDirectory(directory)) return null;

    try {
      linkSync(candidate, ownerPath);
      installedLock = acquiredLock(ownerPath, token, opened.dev, opened.ino, directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const current = inspectExistingLockFile(ownerPath, [1, 2], directory);
      if (!current) return null;
      const owner = ownerState(ownerPath, {
        dev: current.dev,
        ino: current.ino,
        mtimeMs: current.mtimeMs,
      }, directory);
      // Age is never proof that a live owner disappeared. Corrupt or
      // temporarily unreadable ownership remains fail-closed for operator repair.
      if (owner.state !== 'dead' || !owner.token) return null;
      // The token closes the inode-reuse ABA window after the stale observation.
      if (!safelyUnlink(ownerPath, { ...current, token: owner.token }, directory, [1, 2])) return null;
      linkSync(candidate, ownerPath);
      installedLock = acquiredLock(ownerPath, token, opened.dev, opened.ino, directory);
    }
    if (!collapsePublishedCandidate(ownerPath, candidate, { ...opened, token }, directory)) {
      throw new Error('unsafe reclaim election handoff');
    }
    const installed = inspectExistingLockFile(ownerPath, [1], directory);
    if (!installed || !sameFile(installed, opened) ||
      !hasExpectedToken(ownerPath, { ...opened, token }, 1, directory)) {
      throw new Error('unsafe installed reclaim election');
    }
    if (!installedLock) return null;
    election = installedLock;
    return election;
  } catch {
    if (installedLock) {
      election = settleCanonicalInstallation(ownerPath, candidate, installedLock, directory);
      return election;
    }
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (!election && !installedLock && candidateIdentity) {
      if (candidateSecured) removeSecuredCandidate(candidate, candidateIdentity, directory);
      else removeEmptyCandidate(candidate, candidateIdentity, directory);
    }
  }
}

export function acquireLocalStoreLock(
  path: string,
  waitMs = 2_000,
  options: { anchorPath?: string; exactPrivateStorage?: boolean } = {},
): LocalStoreLock | null {
  const start = currentStartIdentity();
  if (!start) return null;
  const deadline = performance.now() + waitMs;
  const retained = retainedReleases.get(path);
  if (retained && !releaseLocalStoreLock(retained)) return null;
  const dir = dirname(path);
  const anchor = pinTrustedAnchor(dir, options.anchorPath);
  if (!anchor) return null;

  const token = randomUUID();
  let directory: LockDirectory | null = null;
  let sawContention = false;
  let authorityAttempted = false;
  let postDeadReclaimInstallAvailable = false;
  let postDeadReclaimInstallConsumed = false;
  while (true) {
    const observedState = contendedOwnerState(path);
    if (observedState !== 'absent' && observedState !== 'dead') {
      sawContention = true;
      if (performance.now() >= deadline) return null;
      Atomics.wait(SLEEP, 0, 0, 10);
      continue;
    }
    if (observedState === 'dead') sawContention = true;
    const mayInstallAfterDeadReclaim =
      postDeadReclaimInstallAvailable && observedState === 'absent';
    if (sawContention && performance.now() >= deadline &&
      (observedState !== 'dead' || authorityAttempted) && !mayInstallAfterDeadReclaim) return null;
    if (!directory) {
      directory = assureLockDirectory(dir, anchor, options.exactPrivateStorage === true);
      if (!directory) return null;
      if (sawContention && performance.now() >= deadline &&
        (observedState !== 'dead' || authorityAttempted) && !mayInstallAfterDeadReclaim) return null;
    }
    authorityAttempted = true;

    let fd: number | undefined;
    let candidateIdentity: Stats | undefined;
    let candidateSecured = false;
    let installedLock: LocalStoreLock | undefined;
    let usedPostDeadReclaimInstall = false;
    const candidate = `${path}.${process.pid}.${token}.candidate`;
    try {
      fd = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(fd);
      candidateIdentity = stat;
      if (!secureFreshCandidate(candidate, fd, stat, directory)) throw new Error('unsafe local store lock');
      candidateSecured = true;
      const bytes = Buffer.from(`${JSON.stringify({
        pid: process.pid,
        token,
        startRef: start.ref,
        startRefVerified: start.verified,
        startRefSource: start.source,
      })}\n`, 'utf8');
      const writtenBytes = writeSync(fd, bytes);
      if (writtenBytes !== bytes.length) throw new Error('short local store lock write');
      fchmodSync(fd, PRIVATE_FILE_MODE);
      fsyncSync(fd);
      const written = fstatSync(fd);
      if (
        !written.isFile() || written.nlink !== 1 || written.size !== bytes.length ||
        !sameFile(written, stat) || !privateMode(written, PRIVATE_FILE_MODE)
      ) throw new Error('unsafe written local store lock');
      closeSync(fd);
      fd = undefined;
      if (!hasExpectedToken(candidate, { ...stat, token }, 1, directory) ||
        !stableDirectory(directory)) {
        throw new Error('unsafe persisted local store lock');
      }
      usedPostDeadReclaimInstall = postDeadReclaimInstallAvailable;
      if (usedPostDeadReclaimInstall) {
        postDeadReclaimInstallAvailable = false;
        postDeadReclaimInstallConsumed = true;
      }
      linkSync(candidate, path);
      installedLock = acquiredLock(path, token, stat.dev, stat.ino, directory);
      if (!collapsePublishedCandidate(path, candidate, { ...stat, token }, directory)) {
        throw new Error('unsafe local store lock handoff');
      }
      const linked = inspectExistingLockFile(path, [1], directory);
      if (!linked || !sameFile(linked, stat) ||
        !hasExpectedToken(path, { ...stat, token }, 1, directory)) {
        throw new Error('unsafe installed local store lock');
      }
      return installedLock;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
      if (installedLock) return settleCanonicalInstallation(path, candidate, installedLock, directory);
      if (candidateIdentity) {
        if (candidateSecured) removeSecuredCandidate(candidate, candidateIdentity, directory);
        else removeEmptyCandidate(candidate, candidateIdentity, directory);
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (usedPostDeadReclaimInstall && performance.now() >= deadline) return null;
      try {
        const stat = inspectExistingLockFile(path, [1, 2], directory);
        if (!stat) {
          if (performance.now() >= deadline) return null;
          Atomics.wait(SLEEP, 0, 0, 10);
          continue;
        }
        if (!stableDirectory(directory)) return null;
        const owner = ownerState(
          path,
          { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs },
          directory,
        );
        if (owner.state === 'dead' && owner.token) {
          const election = acquireReclaimElection(path, start, directory);
          if (election) {
            try {
              const installed = inspectExistingLockFile(path, [1, 2], directory);
              if (
                !installed || installed.dev !== stat.dev || installed.ino !== stat.ino ||
                !stableDirectory(directory)
              ) return null;
              const confirmedOwner = ownerState(path, {
                dev: installed.dev,
                ino: installed.ino,
                mtimeMs: installed.mtimeMs,
              }, directory);
              if (
                confirmedOwner.state !== 'dead' || confirmedOwner.token !== owner.token ||
                confirmedOwner.pid === undefined
              ) return null;
              const expected = { ...installed, token: owner.token, pid: confirmedOwner.pid };
              if (installed.nlink === 2 &&
                !collapseInstalledCandidate(path, expected, directory) &&
                !collapseAbandonedUnlinkGuard(path, expected, directory)) return null;
              const reclaimable = inspectExistingLockFile(path, [1], directory);
              if (
                !reclaimable || reclaimable.dev !== stat.dev || reclaimable.ino !== stat.ino
              ) return null;
              const finalOwner = ownerState(path, {
                dev: reclaimable.dev,
                ino: reclaimable.ino,
                mtimeMs: reclaimable.mtimeMs,
              }, directory);
              if (finalOwner.state !== 'dead' || finalOwner.token !== owner.token) return null;
              if (!safelyUnlink(path, { ...stat, token: owner.token }, directory)) return null;
              if (!postDeadReclaimInstallConsumed) postDeadReclaimInstallAvailable = true;
              continue;
            } finally {
              releaseLocalStoreLock(election);
            }
          }
        }
      } catch { /* changing path; retry within bounded deadline */ }
      if (performance.now() >= deadline) return null;
      Atomics.wait(SLEEP, 0, 0, 10);
    }
  }
}

export function ownsLocalStoreLock(lock: LocalStoreLock | null | undefined): boolean {
  if (!isAcquiredLock(lock)) return false;
  const directory = acquiredLockDirectories.get(lock);
  if (!directory || !stableDirectory(directory)) return false;
  let fd: number | undefined;
  try {
    const stat = inspectExistingLockFile(lock.path, [1], directory);
    if (!stat || stat.dev !== lock.dev || stat.ino !== lock.ino) return false;
    fd = openSync(lock.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      opened.dev !== lock.dev || opened.ino !== lock.ino || opened.nlink !== 1 ||
      !privateMode(opened, PRIVATE_FILE_MODE) || opened.size < 2 || opened.size > 512
    ) return false;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return false;
    const owner = JSON.parse(bytes.toString('utf8')) as { token?: unknown };
    return owner.token === lock.token;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export function releaseLocalStoreLock(lock: LocalStoreLock | null | undefined): boolean {
  if (!isAcquiredLock(lock)) return false;
  const directory = acquiredLockDirectories.get(lock);
  if (!directory) return false;
  const directoryState = releaseDirectoryState(directory);
  if (directoryState !== 'stable') {
    if (directoryState === 'retry') retainedReleases.set(lock.path, lock);
    else retainedReleases.delete(lock.path);
    return false;
  }
  let fd: number | undefined;
  try {
    const stat = lstatSync(lock.path);
    if (stat.dev !== lock.dev || stat.ino !== lock.ino) {
      retainedReleases.delete(lock.path);
      return false;
    }
    if (
      stat.isSymbolicLink() || !stat.isFile() || !owned(stat.uid) || stat.nlink !== 1 ||
      !privateMode(stat, PRIVATE_FILE_MODE)
    ) return false;
    fd = openSync(lock.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      opened.dev !== lock.dev || opened.ino !== lock.ino || opened.nlink !== 1 ||
      !privateMode(opened, PRIVATE_FILE_MODE) || opened.size < 2 || opened.size > 512
    ) return false;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return false;
    const owner = JSON.parse(bytes.toString('utf8')) as { token?: unknown };
    if (owner.token !== lock.token) return false;
    const released = safelyUnlink(lock.path, lock, directory, [1], false);
    if (released) retainedReleases.delete(lock.path);
    else {
      try {
        const remaining = lstatSync(lock.path);
        if (sameFile(remaining, lock)) retainedReleases.set(lock.path, lock);
        else retainedReleases.delete(lock.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' &&
          fsyncDirectory(dirname(lock.path)) && stableDirectory(directory)) {
          retainedReleases.delete(lock.path);
        }
      }
    }
    return released;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' &&
      fsyncDirectory(dirname(lock.path)) && stableDirectory(directory)) {
      retainedReleases.delete(lock.path);
      return true;
    }
    retainedReleases.set(lock.path, lock);
    return false;
  }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export function canRetryLocalStoreLockRelease(
  lock: LocalStoreLock | null | undefined,
): boolean {
  return isAcquiredLock(lock) && retainedReleases.get(lock.path) === lock;
}
