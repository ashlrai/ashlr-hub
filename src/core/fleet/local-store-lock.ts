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
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { endianness } from 'node:os';

const INIT_GRACE_MS = 1_000;
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

function acquiredLock(path: string, token: string, dev: number, ino: number): LocalStoreLock {
  const lock: LocalStoreLock = Object.freeze({ path, token, dev, ino });
  acquiredLocks.add(lock);
  return lock;
}

function isAcquiredLock(lock: LocalStoreLock | null | undefined): lock is LocalStoreLock {
  return typeof lock === 'object' && lock !== null && acquiredLocks.has(lock);
}

function owned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
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
): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || !owned(opened.uid) || opened.dev !== expected.dev ||
      opened.ino !== expected.ino || opened.nlink !== expectedLinks ||
      opened.size < 2 || opened.size > 512
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

function safelyUnlink(
  path: string,
  expected: { dev: number; ino: number; token: string },
  allowedLinks: readonly number[] = [1],
): boolean {
  const guard = `${path}.unlink-${process.pid}-${randomUUID()}.guard`;
  let guarded = false;
  try {
    const current = lstatSync(path);
    if (
      current.isSymbolicLink() || !current.isFile() || !allowedLinks.includes(current.nlink) || !owned(current.uid) ||
      current.dev !== expected.dev || current.ino !== expected.ino
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
      stillCurrent.nlink !== pinnedLinks || !hasExpectedToken(guard, expected, pinnedLinks)
    ) return false;
    unlinkSync(path);
    const remaining = lstatSync(guard);
    return remaining.dev === expected.dev && remaining.ino === expected.ino && remaining.nlink === current.nlink;
  } catch { return false; }
  finally {
    if (guarded) { try { unlinkSync(guard); } catch { /* best effort; canonical path is fail-closed */ } }
  }
}

function settleCanonicalInstallation(
  path: string,
  candidate: string,
  expected: LocalStoreLock,
): LocalStoreLock | null {
  try {
    const candidateStat = lstatSync(candidate);
    if (
      !candidateStat.isSymbolicLink() && candidateStat.isFile() && owned(candidateStat.uid) &&
      candidateStat.dev === expected.dev && candidateStat.ino === expected.ino
    ) safelyUnlink(candidate, expected, [2]);
  } catch { /* candidate may already be gone */ }

  if (ownsLocalStoreLock(expected)) return expected;
  if (safelyUnlink(path, expected, [1, 2])) {
    safelyUnlink(candidate, expected);
    return null;
  }
  if (ownsLocalStoreLock(expected)) return expected;

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
): boolean {
  const dir = dirname(path);
  try {
    if (!hasExpectedToken(path, expected, 2)) return false;
    for (const name of names) {
      const alias = join(dir, name);
      const stat = lstatSync(alias);
      if (
        stat.isSymbolicLink() || !stat.isFile() || !owned(stat.uid) ||
        stat.dev !== expected.dev || stat.ino !== expected.ino || stat.nlink !== 2 ||
        !hasExpectedToken(alias, expected, 2)
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
        hasExpectedToken(path, expected, 1);
    }
  } catch { /* uncertain two-link state remains fail-closed */ }
  return false;
}

function collapseInstalledCandidate(
  path: string,
  expected: { dev: number; ino: number; token: string; pid: number },
): boolean {
  const candidate = `${basename(path)}.${expected.pid}.${expected.token}.candidate`;
  return collapseLockAlias(path, expected, [candidate]);
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
): boolean {
  const canonicalBasename = basename(path);
  const dir = dirname(path);
  try {
    if (!hasExpectedToken(path, expected, 2)) return false;
    for (const name of readdirSync(dir)) {
      const creatorPid = unlinkGuardCreatorPid(canonicalBasename, name);
      if (creatorPid === undefined) continue;
      const guard = join(dir, name);
      const stat = lstatSync(guard);
      if (
        stat.isSymbolicLink() || !stat.isFile() || !owned(stat.uid) || stat.nlink !== 2 ||
        stat.dev !== expected.dev || stat.ino !== expected.ino
      ) continue;
      if (!hasExpectedToken(guard, expected, 2) || !isProcessProvablyDead(creatorPid)) {
        return false;
      }
      // collapseLockAlias repeats the inode/link/token checks after the death
      // probe, so a renamed alias or in-place ownership ABA fails closed.
      return collapseLockAlias(path, expected, [name]);
    }
    return false;
  } catch {
    return false;
  }
}

function ownerState(
  path: string,
  expected: { dev: number; ino: number; mtimeMs: number },
): { state: 'alive' | 'dead' | 'initializing' | 'unknown'; token?: string; pid?: number } {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || opened.nlink < 1 || opened.nlink > 2 || !owned(opened.uid) ||
      opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size < 2 || opened.size > 512
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

function acquireReclaimElection(path: string, start: AuthorityStartIdentity): LocalStoreLock | null {
  const ownerPath = `${path}.reclaim.owner`;
  const token = randomUUID();
  const candidate = `${ownerPath}.${process.pid}.${token}.candidate`;
  let fd: number | undefined;
  let installedLock: LocalStoreLock | undefined;
  let election: LocalStoreLock | null = null;
  try {
    fd = openSync(
      candidate,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !owned(opened.uid)) return null;
    const bytes = Buffer.from(`${JSON.stringify({
      pid: process.pid,
      token,
      startRef: start.ref,
      startRefVerified: start.verified,
      startRefSource: start.source,
    })}\n`, 'utf8');
    if (writeSync(fd, bytes) !== bytes.length) return null;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const candidateStat = lstatSync(candidate);
    if (
      candidateStat.isSymbolicLink() || !candidateStat.isFile() || candidateStat.nlink !== 1 ||
      !owned(candidateStat.uid) || candidateStat.dev !== opened.dev || candidateStat.ino !== opened.ino
    ) return null;

    try {
      linkSync(candidate, ownerPath);
      installedLock = acquiredLock(ownerPath, token, opened.dev, opened.ino);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const current = lstatSync(ownerPath);
      if (
        current.isSymbolicLink() || !current.isFile() || !owned(current.uid) ||
        current.nlink < 1 || current.nlink > 2
      ) return null;
      const owner = ownerState(ownerPath, {
        dev: current.dev,
        ino: current.ino,
        mtimeMs: current.mtimeMs,
      });
      // Age is never proof that a live owner disappeared. Corrupt or
      // temporarily unreadable ownership remains fail-closed for operator repair.
      if (owner.state !== 'dead' || !owner.token) return null;
      // The token closes the inode-reuse ABA window after the stale observation.
      if (!safelyUnlink(ownerPath, { ...current, token: owner.token }, [1, 2])) return null;
      linkSync(candidate, ownerPath);
      installedLock = acquiredLock(ownerPath, token, opened.dev, opened.ino);
    }
    unlinkSync(candidate);
    const installed = lstatSync(ownerPath);
    if (
      installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 1 ||
      !owned(installed.uid) || installed.dev !== opened.dev || installed.ino !== opened.ino
    ) return null;
    if (!installedLock) return null;
    election = installedLock;
    return election;
  } catch {
    if (installedLock) {
      election = settleCanonicalInstallation(ownerPath, candidate, installedLock);
      return election;
    }
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (!election && !installedLock) { try { unlinkSync(candidate); } catch { /* best effort */ } }
  }
}

export function acquireLocalStoreLock(
  path: string,
  waitMs = 2_000,
): LocalStoreLock | null {
  const start = currentStartIdentity();
  if (!start) return null;
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !owned(stat.uid)) return null;
    chmodSync(dir, 0o700);
  } catch { return null; }

  const token = randomUUID();
  const deadline = performance.now() + waitMs;
  while (true) {
    let fd: number | undefined;
    let installedLock: LocalStoreLock | undefined;
    const candidate = `${path}.${process.pid}.${token}.candidate`;
    try {
      fd = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || !owned(stat.uid)) throw new Error('unsafe local store lock');
      const bytes = Buffer.from(`${JSON.stringify({
        pid: process.pid,
        token,
        startRef: start.ref,
        startRefVerified: start.verified,
        startRefSource: start.source,
      })}\n`, 'utf8');
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('short local store lock write');
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      linkSync(candidate, path);
      installedLock = acquiredLock(path, token, stat.dev, stat.ino);
      unlinkSync(candidate);
      const linked = lstatSync(path);
      if (
        linked.isSymbolicLink() || !linked.isFile() || linked.nlink !== 1 || !owned(linked.uid) ||
        linked.dev !== stat.dev || linked.ino !== stat.ino
      ) throw new Error('unsafe installed local store lock');
      return installedLock;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
      if (installedLock) return settleCanonicalInstallation(path, candidate, installedLock);
      try { if (existsSync(candidate)) unlinkSync(candidate); } catch { /* best effort */ }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile() || !owned(stat.uid) || stat.nlink < 1 || stat.nlink > 2) return null;
        const owner = ownerState(path, { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs });
        if (owner.state === 'dead' && owner.token) {
          const election = acquireReclaimElection(path, start);
          if (election) {
            try {
              const installed = lstatSync(path);
              if (
                installed.dev !== stat.dev || installed.ino !== stat.ino ||
                installed.isSymbolicLink() || !installed.isFile() || !owned(installed.uid) ||
                installed.nlink < 1 || installed.nlink > 2
              ) return null;
              const confirmedOwner = ownerState(path, {
                dev: installed.dev,
                ino: installed.ino,
                mtimeMs: installed.mtimeMs,
              });
              if (
                confirmedOwner.state !== 'dead' || confirmedOwner.token !== owner.token ||
                confirmedOwner.pid === undefined
              ) return null;
              const expected = { ...installed, token: owner.token, pid: confirmedOwner.pid };
              if (installed.nlink === 2 &&
                !collapseInstalledCandidate(path, expected) &&
                !collapseAbandonedUnlinkGuard(path, expected)) return null;
              const reclaimable = lstatSync(path);
              if (
                reclaimable.dev !== stat.dev || reclaimable.ino !== stat.ino || reclaimable.nlink !== 1
              ) return null;
              const finalOwner = ownerState(path, {
                dev: reclaimable.dev,
                ino: reclaimable.ino,
                mtimeMs: reclaimable.mtimeMs,
              });
              if (finalOwner.state !== 'dead' || finalOwner.token !== owner.token) return null;
              if (!safelyUnlink(path, { ...stat, token: owner.token })) return null;
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
  let fd: number | undefined;
  try {
    const stat = lstatSync(lock.path);
    if (
      stat.dev !== lock.dev || stat.ino !== lock.ino || stat.isSymbolicLink() ||
      !stat.isFile() || stat.nlink !== 1 || !owned(stat.uid)
    ) return false;
    fd = openSync(lock.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      opened.dev !== lock.dev || opened.ino !== lock.ino || opened.nlink !== 1 ||
      opened.size < 2 || opened.size > 512
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

export function releaseLocalStoreLock(lock: LocalStoreLock | null | undefined): void {
  if (!isAcquiredLock(lock)) return;
  let fd: number | undefined;
  try {
    const stat = lstatSync(lock.path);
    if (stat.dev !== lock.dev || stat.ino !== lock.ino || stat.isSymbolicLink() || !stat.isFile()) return;
    fd = openSync(lock.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== lock.dev || opened.ino !== lock.ino || opened.size < 2 || opened.size > 512) return;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return;
    const owner = JSON.parse(bytes.toString('utf8')) as { token?: unknown };
    if (owner.token === lock.token) safelyUnlink(lock.path, lock);
  } catch { /* uncertain ownership remains fail-closed */ }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}
