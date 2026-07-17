import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PathLike } from 'node:fs';

const faults = vi.hoisted(() => ({
  assuranceCalls: [] as Array<{
    path: string;
    kind: string;
    mode: string;
    anchorPath: string | undefined;
  }>,
  candidateUnlinkPath: undefined as string | undefined,
  assuranceSideEffect: undefined as (() => void) | undefined,
  crashAfterGuardLinkFor: undefined as string | undefined,
  failCanonicalLstatPath: undefined as string | undefined,
  failCanonicalLstatCount: 0,
  replaceWhenElectionInstalledFor: undefined as string | undefined,
  replacementToken: 'successor-token',
  competingDeadGenerationFor: undefined as string | undefined,
  competingDeadGenerationPid: undefined as number | undefined,
  competingDeadGenerationLinkAttempts: 0,
  competingDeadGenerationToken: 'competing-dead-token',
  strandedGuardPath: undefined as string | undefined,
  installedPaths: new Set<string>(),
  events: [] as string[],
  fdPaths: new Map<number, string>(),
  failDirectoryFsyncFor: undefined as string | undefined,
  directoryFsyncErrorCode: 'EIO',
  failLstatOnceFor: undefined as string | undefined,
  rejectAssurance: undefined as ((path: string, kind: string, mode: string) => boolean) | undefined,
  shortWriteFor: undefined as 'main' | 'reclaim' | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    closeSync(fd: number): void {
      actual.closeSync(fd);
      faults.fdPaths.delete(fd);
    },
    fsyncSync(fd: number): void {
      const target = faults.fdPaths.get(fd);
      if (target === faults.failDirectoryFsyncFor) {
        throw Object.assign(new Error('injected directory fsync failure'), {
          code: faults.directoryFsyncErrorCode,
        });
      }
      actual.fsyncSync(fd);
    },
    linkSync(existingPath: PathLike, newPath: PathLike): void {
      const existing = String(existingPath);
      const installed = String(newPath);
      if (
        installed === faults.competingDeadGenerationFor && existing.endsWith('.candidate')
      ) {
        faults.competingDeadGenerationLinkAttempts += 1;
        if (faults.competingDeadGenerationLinkAttempts === 2) {
          actual.writeFileSync(installed, `${JSON.stringify({
            pid: faults.competingDeadGenerationPid,
            token: faults.competingDeadGenerationToken,
            startRef: '0'.repeat(64),
            startRefVerified: true,
            startRefSource: 'self-clock-epoch-second',
          })}\n`, { encoding: 'utf8', mode: 0o600 });
        }
      }
      actual.linkSync(existingPath, newPath);
      faults.installedPaths.add(installed);
      if (
        existing === faults.crashAfterGuardLinkFor &&
        installed.startsWith(`${existing}.unlink-`) && installed.endsWith('.guard')
      ) {
        const stranded = installed.replace(`.unlink-${process.pid}-`, '.unlink-2147483646-');
        actual.renameSync(installed, stranded);
        faults.strandedGuardPath = stranded;
        faults.crashAfterGuardLinkFor = undefined;
      }
      if (installed === `${faults.replaceWhenElectionInstalledFor}.reclaim.owner`) {
        actual.writeFileSync(faults.replaceWhenElectionInstalledFor!, `${JSON.stringify({
          pid: process.pid,
          token: faults.replacementToken,
        })}\n`, 'utf8');
      }
    },
    lstatSync(path: PathLike, ...args: unknown[]) {
      const target = String(path);
      if (target === faults.failLstatOnceFor) {
        faults.failLstatOnceFor = undefined;
        throw Object.assign(new Error('injected transient lstat failure'), { code: 'EIO' });
      }
      if (
        target === faults.failCanonicalLstatPath && faults.installedPaths.has(target) &&
        faults.failCanonicalLstatCount > 0
      ) {
        faults.failCanonicalLstatCount -= 1;
        throw Object.assign(new Error('injected post-install lstat failure'), { code: 'EIO' });
      }
      return (actual.lstatSync as (...params: unknown[]) => import('node:fs').Stats)(path, ...args);
    },
    openSync(path: PathLike, flags: number, mode?: number): number {
      const fd = actual.openSync(path, flags, mode);
      faults.fdPaths.set(fd, String(path));
      return fd;
    },
    unlinkSync(path: PathLike): void {
      const target = String(path);
      const canonical = faults.candidateUnlinkPath;
      if (
        canonical && faults.installedPaths.has(canonical) &&
        target.startsWith(`${canonical}.`) && target.endsWith('.candidate')
      ) {
        faults.candidateUnlinkPath = undefined;
        throw Object.assign(new Error('injected candidate unlink failure'), { code: 'EIO' });
      }
      actual.unlinkSync(path);
    },
    writeSync(fd: number, ...args: unknown[]): number {
      const target = faults.fdPaths.get(fd) ?? `fd:${fd}`;
      faults.events.push(`write:${target}`);
      const written = (actual.writeSync as (...params: unknown[]) => number)(fd, ...args);
      const isReclaim = target.includes('.reclaim.owner.');
      if ((faults.shortWriteFor === 'reclaim' && isReclaim) ||
        (faults.shortWriteFor === 'main' && !isReclaim && target.endsWith('.candidate'))) {
        faults.shortWriteFor = undefined;
        return Math.max(0, written - 1);
      }
      return written;
    },
  };
});

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath(
      target: string,
      kind: Parameters<typeof actual.assurePrivateStoragePath>[1],
      mode: Parameters<typeof actual.assurePrivateStoragePath>[2],
      options: Parameters<typeof actual.assurePrivateStoragePath>[3] = {},
    ) {
      faults.assuranceCalls.push({ path: target, kind, mode, anchorPath: options.anchorPath });
      faults.events.push(`assure:${mode}:${kind}:${target}`);
      const sideEffect = faults.assuranceSideEffect;
      faults.assuranceSideEffect = undefined;
      sideEffect?.();
      if (faults.rejectAssurance?.(target, kind, mode)) {
        return { ok: false, reason: 'injected-assurance-failure' };
      }
      return actual.assurePrivateStoragePath(target, kind, mode, options);
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  verifiedProcessStartIdentity,
  verifiedProcessStartRef,
  type ProcessStartIdentityRuntime,
} from '../src/core/fleet/local-store-lock.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';

let tmpDir: string;
const DEFINITELY_ABSENT_PID = 2_147_483_647;
const DEFINITELY_ABSENT_CREATOR_PID = 2_147_483_646;
const semanticPrivateStorageRunner: PrivateStorageRunner = (invocation) => {
  const request = JSON.parse(invocation.input) as { nonce: string; operation: string; mode?: string };
  return {
    status: 0,
    stdout: JSON.stringify({
      nonce: request.nonce,
      operation: request.operation,
      ok: true,
      reason: request.mode === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
    }),
  };
};

function writeProvablyStaleLock(
  lockPath: string,
  token = 'stale-token',
  pid = DEFINITELY_ABSENT_PID,
): void {
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid,
    token,
    startRef: '0'.repeat(64),
    startRefVerified: true,
    startRefSource: 'self-clock-epoch-second',
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}

function exitedChildPid(): number {
  const child = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.pid))'],
    { encoding: 'utf8', windowsHide: true },
  );
  const pid = Number(child.stdout);
  expect(child.status).toBe(0);
  expect(Number.isSafeInteger(pid)).toBe(true);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

beforeEach(() => {
  faults.assuranceCalls.length = 0;
  faults.assuranceSideEffect = undefined;
  faults.candidateUnlinkPath = undefined;
  faults.crashAfterGuardLinkFor = undefined;
  faults.failCanonicalLstatPath = undefined;
  faults.failCanonicalLstatCount = 0;
  faults.replaceWhenElectionInstalledFor = undefined;
  faults.replacementToken = 'successor-token';
  faults.competingDeadGenerationFor = undefined;
  faults.competingDeadGenerationPid = undefined;
  faults.competingDeadGenerationLinkAttempts = 0;
  faults.competingDeadGenerationToken = 'competing-dead-token';
  faults.strandedGuardPath = undefined;
  faults.installedPaths.clear();
  faults.events.length = 0;
  faults.fdPaths.clear();
  faults.failDirectoryFsyncFor = undefined;
  faults.directoryFsyncErrorCode = 'EIO';
  faults.failLstatOnceFor = undefined;
  faults.rejectAssurance = undefined;
  faults.shortWriteFor = undefined;
  _setPrivateStorageTestControlForTest(
    PRIVATE_STORAGE_TEST_CONTROL,
    process.platform === 'win32' ? { runner: semanticPrivateStorageRunner } : undefined,
  );
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m416-lock-handoff-'));
});

afterEach(() => {
  faults.assuranceCalls.length = 0;
  faults.assuranceSideEffect = undefined;
  faults.candidateUnlinkPath = undefined;
  faults.crashAfterGuardLinkFor = undefined;
  faults.failCanonicalLstatPath = undefined;
  faults.replaceWhenElectionInstalledFor = undefined;
  faults.competingDeadGenerationFor = undefined;
  faults.competingDeadGenerationPid = undefined;
  faults.competingDeadGenerationLinkAttempts = 0;
  faults.strandedGuardPath = undefined;
  faults.events.length = 0;
  faults.fdPaths.clear();
  faults.failDirectoryFsyncFor = undefined;
  faults.directoryFsyncErrorCode = 'EIO';
  faults.failLstatOnceFor = undefined;
  faults.rejectAssurance = undefined;
  faults.shortWriteFor = undefined;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
  }
});

describe('local store lock installation handoff', () => {
  it('refuses authority without artifacts when the self clock is unavailable', () => {
    const lockPath = path.join(tmpDir, 'self-clock-unavailable.lock');
    const now = vi.spyOn(Date, 'now').mockReturnValue(Number.NaN);
    try {
      expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps generic lock acquisition independent of private-storage assurance', () => {
    const lockPath = path.join(tmpDir, 'generic-structural.lock');

    const lock = acquireLocalStoreLock(lockPath, 0);

    expect(lock).not.toBeNull();
    expect(faults.assuranceCalls).toEqual([]);
    expect(releaseLocalStoreLock(lock)).toBe(true);
    expect(faults.assuranceCalls).toEqual([]);
  });

  it('retains exact storage opt-in through ownership and release', () => {
    const lockPath = path.join(tmpDir, 'exact-inspection-retained.lock');
    const lock = acquireLocalStoreLock(lockPath, 0, {
      anchorPath: tmpDir,
      exactPrivateStorage: true,
    });
    expect(lock).not.toBeNull();
    const installed = fs.lstatSync(lockPath);
    const installedBytes = fs.readFileSync(lockPath);
    faults.rejectAssurance = (_target, _kind, mode) => mode === 'inspect-existing';

    expect(ownsLocalStoreLock(lock)).toBe(false);
    expect(releaseLocalStoreLock(lock)).toBe(false);

    const retained = fs.lstatSync(lockPath);
    expect({ dev: retained.dev, ino: retained.ino, nlink: retained.nlink }).toEqual({
      dev: installed.dev,
      ino: installed.ino,
      nlink: 1,
    });
    expect(fs.readFileSync(lockPath)).toEqual(installedBytes);
    expect(JSON.parse(installedBytes.toString('utf8'))).toMatchObject({ token: lock?.token });

    faults.rejectAssurance = undefined;
    expect(releaseLocalStoreLock(lock)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('secures a fresh directory and candidate before writing lock payload bytes', () => {
    const lockDir = path.join(tmpDir, 'fresh-locks');
    const lockPath = path.join(lockDir, 'ordered.lock');

    const lock = acquireLocalStoreLock(lockPath, 0, {
      anchorPath: tmpDir,
      exactPrivateStorage: true,
    });

    expect(lock).not.toBeNull();
    const directoryAssurance = `assure:secure-created:directory:${lockDir}`;
    const candidateCall = faults.assuranceCalls.find((call) =>
      call.kind === 'file' && call.mode === 'secure-created' && call.path.endsWith('.candidate'));
    expect(candidateCall).toMatchObject({ anchorPath: tmpDir });
    const candidateAssurance = `assure:secure-created:file:${candidateCall?.path}`;
    const candidateWrite = `write:${candidateCall?.path}`;
    expect(faults.events.indexOf(directoryAssurance)).toBeGreaterThanOrEqual(0);
    expect(faults.events.indexOf(candidateAssurance)).toBeGreaterThan(
      faults.events.indexOf(directoryAssurance),
    );
    expect(faults.events.indexOf(candidateWrite)).toBeGreaterThan(
      faults.events.indexOf(candidateAssurance),
    );
    expect(faults.assuranceCalls).toContainEqual({
      path: lockDir,
      kind: 'directory',
      mode: 'secure-created',
      anchorPath: tmpDir,
    });
    releaseLocalStoreLock(lock);
  });

  it('leaves no payload or authority when fresh candidate assurance fails', () => {
    const lockPath = path.join(tmpDir, 'candidate-assurance-failure.lock');
    faults.rejectAssurance = (_target, kind, mode) => kind === 'file' && mode === 'secure-created';

    expect(acquireLocalStoreLock(lockPath, 0, {
      anchorPath: tmpDir,
      exactPrivateStorage: true,
    })).toBeNull();

    const candidate = faults.assuranceCalls.find((call) => call.mode === 'secure-created')?.path;
    expect(candidate).toMatch(/\.candidate$/);
    expect(faults.events).not.toContain(`write:${candidate}`);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.candidate'))).toEqual([]);
  });

  it('exactly inspects an existing directory and canonical lock before trusting ownership', () => {
    const lockPath = path.join(tmpDir, 'existing-canonical.lock');
    writeProvablyStaleLock(lockPath);
    const before = fs.readFileSync(lockPath);
    faults.rejectAssurance = (target, kind, mode) =>
      target === lockPath && kind === 'file' && mode === 'inspect-existing';

    expect(acquireLocalStoreLock(lockPath, 0, {
      anchorPath: tmpDir,
      exactPrivateStorage: true,
    })).toBeNull();

    expect(faults.assuranceCalls).toContainEqual({
      path: tmpDir,
      kind: 'directory',
      mode: 'inspect-existing',
      anchorPath: tmpDir,
    });
    expect(faults.assuranceCalls).toContainEqual({
      path: lockPath,
      kind: 'file',
      mode: 'inspect-existing',
      anchorPath: tmpDir,
    });
    expect(fs.readFileSync(lockPath)).toEqual(before);
    expect(fs.existsSync(`${lockPath}.reclaim.owner`)).toBe(false);
  });

  it('fails closed when reclaim-election candidate assurance is unavailable', () => {
    const lockPath = path.join(tmpDir, 'reclaim-assurance-failure.lock');
    writeProvablyStaleLock(lockPath);
    const stale = fs.lstatSync(lockPath);
    faults.rejectAssurance = (target, kind, mode) =>
      target.includes('.reclaim.owner.') && kind === 'file' && mode === 'secure-created';

    expect(acquireLocalStoreLock(lockPath, 0, { exactPrivateStorage: true })).toBeNull();

    const retained = fs.lstatSync(lockPath);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({ dev: stale.dev, ino: stale.ino });
    expect(faults.assuranceCalls.some((call) =>
      call.path.includes('.reclaim.owner.') && call.mode === 'secure-created')).toBe(true);
    expect(fs.existsSync(`${lockPath}.reclaim.owner`)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.candidate'))).toEqual([]);
  });

  it('recovers a retained same-process release after a transient path failure', () => {
    const lockPath = path.join(tmpDir, 'release-transient-failure.lock');
    const lock = acquireLocalStoreLock(lockPath, 0);
    expect(lock).not.toBeNull();
    faults.failLstatOnceFor = lockPath;

    expect(releaseLocalStoreLock(lock)).toBe(false);

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({ token: lock?.token });
    const successor = acquireLocalStoreLock(lockPath, 100);
    expect(successor).not.toBeNull();
    expect(successor?.token).not.toBe(lock?.token);
    expect(releaseLocalStoreLock(successor)).toBe(true);
  });

  it('does not return authority when canonical handoff cannot be directory-durable', () => {
    const lockPath = path.join(tmpDir, 'directory-fsync-failure.lock');
    faults.failDirectoryFsyncFor = tmpDir;

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.candidate'))).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'accepts only the shared Windows unsupported-directory-fsync semantics',
    () => {
      const lockPath = path.join(tmpDir, 'windows-unsupported-directory-fsync.lock');
      faults.failDirectoryFsyncFor = tmpDir;
      faults.directoryFsyncErrorCode = 'EPERM';

      const lock = acquireLocalStoreLock(lockPath, 0);

      expect(lock).not.toBeNull();
      expect(releaseLocalStoreLock(lock)).toBe(true);
    },
  );

  it('bounds live-owner contention without repeating exact storage assurance', () => {
    const lockPath = path.join(tmpDir, 'bounded-live-contention.lock');
    const anchorPath = tmpDir;
    const holder = acquireLocalStoreLock(lockPath, 0, { anchorPath });
    expect(holder).not.toBeNull();
    faults.assuranceCalls.length = 0;
    const started = performance.now();

    expect(acquireLocalStoreLock(lockPath, 30, { anchorPath })).toBeNull();

    expect(performance.now() - started).toBeLessThan(200);
    expect(faults.assuranceCalls).toEqual([]);
    expect(releaseLocalStoreLock(holder)).toBe(true);
  });

  it('rejects a trusted-anchor replacement during directory assurance', () => {
    const trusted = path.join(tmpDir, 'trusted-anchor');
    const displaced = path.join(tmpDir, 'trusted-anchor.displaced');
    const lockDir = path.join(trusted, 'locks');
    const lockPath = path.join(lockDir, 'anchor-replacement.lock');
    fs.mkdirSync(trusted, { mode: 0o700 });
    faults.assuranceSideEffect = () => {
      fs.renameSync(trusted, displaced);
      fs.mkdirSync(trusted, { mode: 0o700 });
    };

    expect(acquireLocalStoreLock(lockPath, 0, {
      anchorPath: trusted,
      exactPrivateStorage: true,
    })).toBeNull();

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(path.join(displaced, 'locks'))).toEqual([]);
  });

  it('identity-cleans a secured main candidate after a short write', () => {
    const lockPath = path.join(tmpDir, 'main-short-write.lock');
    faults.shortWriteFor = 'main';

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.candidate'))).toEqual([]);
  });

  it('identity-cleans a secured reclaim candidate after a short write', () => {
    const lockPath = path.join(tmpDir, 'reclaim-short-write.lock');
    writeProvablyStaleLock(lockPath);
    const stale = fs.lstatSync(lockPath);
    faults.shortWriteFor = 'reclaim';

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();

    const retained = fs.lstatSync(lockPath);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({ dev: stale.dev, ino: stale.ino });
    expect(fs.existsSync(`${lockPath}.reclaim.owner`)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.candidate'))).toEqual([]);
  });

  it('treats a probe-source switch as unknown instead of a dead process', () => {
    let psAvailable = true;
    let procReads = 0;
    const expectedEpoch = Math.floor(Date.parse('Tue Jul 14 06:00:00 2026') / 1_000);
    const runtime: ProcessStartIdentityRuntime = {
      platform: 'linux',
      run() {
        return psAvailable
          ? { status: 0, stdout: 'Tue Jul 14 06:00:00 2026\n' }
          : { status: null, stdout: null };
      },
      readLinuxProcStat: (pid) => {
        procReads += 1;
        return `${pid} (node) S ${Array(18).fill('0').join(' ')} 424242\n`;
      },
      readLinuxBootTimeSeconds: () => expectedEpoch - 4_242,
      readLinuxClockTicks: () => 100,
    };
    const acquired = verifiedProcessStartIdentity(731, { runtime });
    expect(acquired).toMatchObject({ source: 'ps-lstart' });

    psAvailable = false;
    const switched = verifiedProcessStartIdentity(731, { runtime });
    expect(switched).toMatchObject({ source: 'linux-proc-start-ticks' });
    expect(switched?.ref).toBe(acquired?.ref);
    expect(procReads).toBe(1);

    expect(verifiedProcessStartIdentity(731, {
      runtime,
      requiredSource: acquired!.source,
    })).toBeUndefined();
    expect(procReads).toBe(1);
  });

  it('falls back to bounded fixed-argv /bin/ps on Darwin', () => {
    const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const runtime: ProcessStartIdentityRuntime = {
      platform: 'darwin',
      run(command, args, options) {
        calls.push({ command, args, options });
        return command === '/bin/ps'
          ? { status: 0, stdout: 'Tue Jul 14 06:00:00 2026\n' }
          : { status: null, stdout: null };
      },
      readLinuxProcStat: () => {
        throw new Error('Darwin must not inspect /proc');
      },
    };

    expect(verifiedProcessStartIdentity(812, { runtime })).toMatchObject({
      source: 'ps-lstart',
      ref: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: 'ps', args: ['-o', 'lstart=', '-p', '812'] },
      { command: '/bin/ps', args: ['-o', 'lstart=', '-p', '812'] },
    ]);
    for (const call of calls) {
      expect(call.options).toMatchObject({
        timeout: 1_000,
        maxBuffer: 1_024,
        shell: false,
        windowsHide: true,
      });
    }
  });

  it('never reclaims a live owner solely because its start identity differs', () => {
    const lockPath = path.join(tmpDir, 'live-mismatched-start.lock');
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: process.pid,
      token: 'live-owner',
      startRef: '0'.repeat(64),
      startRefVerified: true,
      startRefSource: 'self-clock-epoch-second',
    })}\n`, { encoding: 'utf8', mode: 0o600 });

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: process.pid,
      token: 'live-owner',
    });
  });

  it('retains live ownership across wall-clock jumps', () => {
    const lockPath = path.join(tmpDir, 'clock-jump.lock');
    const lock = acquireLocalStoreLock(lockPath, 0);
    expect(lock).not.toBeNull();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    try {
      expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();
      expect(ownsLocalStoreLock(lock)).toBe(true);
    } finally {
      now.mockRestore();
      releaseLocalStoreLock(lock);
    }
  });

  it('creates authority from self-clock identity when both Darwin probes fail', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runtime: ProcessStartIdentityRuntime = {
      platform: 'darwin',
      run(command, args) {
        calls.push({ command, args });
        return { status: null, stdout: null };
      },
      readLinuxProcStat: () => {
        throw new Error('Darwin must not inspect /proc');
      },
    };
    const lockPath = path.join(tmpDir, 'unverified-refused.lock');

    expect(verifiedProcessStartIdentity(process.pid, { runtime })).toBeUndefined();
    expect(calls).toEqual([
      { command: 'ps', args: ['-o', 'lstart=', '-p', String(process.pid)] },
      { command: '/bin/ps', args: ['-o', 'lstart=', '-p', String(process.pid)] },
    ]);
    const lock = acquireLocalStoreLock(lockPath, 0);
    expect(lock).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
      startRefVerified: true,
      startRefSource: 'self-clock-epoch-second',
    });
    releaseLocalStoreLock(lock);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('uses bounded proc start ticks when ps is unavailable', () => {
    const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const runtime: ProcessStartIdentityRuntime = {
      platform: 'linux',
      run(command, args, options) {
        calls.push({ command, args, options });
        return { status: null, stdout: null };
      },
      readLinuxProcStat: (pid) =>
        `${pid} (node worker) S ${Array(18).fill('0').join(' ')} 424242\n`,
      readLinuxBootTimeSeconds: () => 1_700_000_000,
      readLinuxClockTicks: () => 100,
    };

    const first = verifiedProcessStartRef(731, runtime);
    runtime.readLinuxProcStat = (pid) =>
      `${pid} (node worker) S ${Array(18).fill('0').join(' ')} 424342\n`;
    const reused = verifiedProcessStartRef(731, runtime);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reused).toMatch(/^[a-f0-9]{64}$/);
    expect(reused).not.toBe(first);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: 'ps',
      args: ['-o', 'lstart=', '-p', '731'],
      options: { timeout: 1_000, maxBuffer: 1_024, shell: false },
    });
  });

  it('uses fixed bounded PowerShell argv for Windows process identity', () => {
    let startTicks = '638881234567890000';
    const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const runtime: ProcessStartIdentityRuntime = {
      platform: 'win32',
      run(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, stdout: `${startTicks}\r\n` };
      },
      readLinuxProcStat: () => {
        throw new Error('Windows must not inspect /proc');
      },
    };

    const first = verifiedProcessStartRef(912, runtime);
    startTicks = '638881234577890000';
    const reused = verifiedProcessStartRef(912, runtime);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reused).not.toBe(first);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe('powershell.exe');
      expect(call.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
      expect(call.args.at(-1)).toBe('912');
      expect(call.args.at(-2)).not.toContain('912');
      expect(call.options).toMatchObject({
        timeout: 1_000,
        maxBuffer: 1_024,
        shell: false,
        windowsHide: true,
      });
    }
  });

  it('reclaims a proven-dead canonical lock with a zero wait budget', () => {
    const lockPath = path.join(tmpDir, 'zero-wait-dead-owner.lock');
    const staleToken = 'zero-wait-stale-token';
    writeProvablyStaleLock(lockPath, staleToken, exitedChildPid());

    const lock = acquireLocalStoreLock(lockPath, 0);

    expect(lock).not.toBeNull();
    expect(lock?.token).not.toBe(staleToken);
    expect(ownsLocalStoreLock(lock)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: process.pid,
      token: lock?.token,
    });
    expect(releaseLocalStoreLock(lock)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('spends the zero-wait reclaim allowance on only one canonical installation attempt', () => {
    const lockPath = path.join(tmpDir, 'zero-wait-dead-churn.lock');
    const competingPid = exitedChildPid();
    writeProvablyStaleLock(lockPath, 'first-dead-token', exitedChildPid());
    faults.competingDeadGenerationFor = lockPath;
    faults.competingDeadGenerationPid = competingPid;

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();

    expect(faults.competingDeadGenerationLinkAttempts).toBe(2);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: competingPid,
      token: faults.competingDeadGenerationToken,
    });
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.candidate'))).toEqual([]);
  });

  it('does not unlink a new ownership generation that keeps the observed inode', () => {
    const lockPath = path.join(tmpDir, 'token-reuse.lock');
    writeProvablyStaleLock(lockPath);
    const stale = fs.lstatSync(lockPath);
    faults.replaceWhenElectionInstalledFor = lockPath;

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();

    const retained = fs.lstatSync(lockPath);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({ dev: stale.dev, ino: stale.ino });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: process.pid,
      token: faults.replacementToken,
    });
    expect(fs.existsSync(`${lockPath}.reclaim.owner`)).toBe(false);
  });

  it('does not collapse a stranded guard after an in-place ownership ABA', () => {
    const lockPath = path.join(tmpDir, 'guarded-token-reuse.lock');
    writeProvablyStaleLock(lockPath);
    const guard = `${lockPath}.unlink-${process.pid}-${randomUUID()}.guard`;
    fs.linkSync(lockPath, guard);
    const stale = fs.lstatSync(lockPath);
    faults.replaceWhenElectionInstalledFor = lockPath;

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();

    const retained = fs.lstatSync(lockPath);
    expect({ dev: retained.dev, ino: retained.ino, nlink: retained.nlink }).toEqual({
      dev: stale.dev,
      ino: stale.ino,
      nlink: 2,
    });
    expect(fs.existsSync(guard)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: process.pid,
      token: faults.replacementToken,
    });
    expect(fs.existsSync(`${lockPath}.reclaim.owner`)).toBe(false);
  });

  it('recovers when a reclaimer crashes after linking its guard but before canonical unlink', () => {
    const lockPath = path.join(tmpDir, 'crashed-reclaimer-guard.lock');
    writeProvablyStaleLock(lockPath);
    const stale = fs.lstatSync(lockPath);
    faults.crashAfterGuardLinkFor = lockPath;

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();

    const guard = faults.strandedGuardPath;
    expect(guard).toMatch(new RegExp(
      `^${lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.unlink-${DEFINITELY_ABSENT_CREATOR_PID}-.*\\.guard$`,
    ));
    expect(fs.lstatSync(lockPath).nlink).toBe(2);
    expect(guard && fs.lstatSync(guard).ino).toBe(stale.ino);
    const staleToken = JSON.parse(fs.readFileSync(lockPath, 'utf8')).token as string;

    const successor = acquireLocalStoreLock(lockPath, 2_000);

    expect(successor).not.toBeNull();
    expect(successor?.token).not.toBe(staleToken);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({ token: successor?.token });
    expect(guard && fs.existsSync(guard)).toBe(false);
    releaseLocalStoreLock(successor);
  });

  it('does not collapse an authenticated guard while its reclaimer PID is live', () => {
    const lockPath = path.join(tmpDir, 'live-reclaimer-guard.lock');
    writeProvablyStaleLock(lockPath);
    const guard = `${lockPath}.unlink-${process.pid}-${randomUUID()}.guard`;
    fs.linkSync(lockPath, guard);

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();
    expect(fs.lstatSync(lockPath).nlink).toBe(2);
    expect(fs.existsSync(guard)).toBe(true);
  });

  it('does not collapse an authenticated guard when reclaimer liveness is unknown', () => {
    const lockPath = path.join(tmpDir, 'unknown-reclaimer-guard.lock');
    writeProvablyStaleLock(lockPath);
    const guard = `${lockPath}.unlink-${DEFINITELY_ABSENT_CREATOR_PID}-${randomUUID()}.guard`;
    fs.linkSync(lockPath, guard);
    const actualKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === DEFINITELY_ABSENT_CREATOR_PID) {
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      }
      return actualKill(pid, signal);
    });
    try {
      expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();
    } finally {
      kill.mockRestore();
    }

    expect(fs.lstatSync(lockPath).nlink).toBe(2);
    expect(fs.existsSync(guard)).toBe(true);
  });

  it('returns valid ownership when candidate cleanup initially fails after installation', () => {
    const lockPath = path.join(tmpDir, 'candidate-cleanup.lock');
    faults.candidateUnlinkPath = lockPath;

    const lock = acquireLocalStoreLock(lockPath, 0);

    expect(lock).not.toBeNull();
    expect(ownsLocalStoreLock(lock)).toBe(true);
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.candidate'))).toEqual([]);
    releaseLocalStoreLock(lock);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('rolls back the exact canonical lock when post-install validation remains unavailable', () => {
    const lockPath = path.join(tmpDir, 'validation-failure.lock');
    faults.failCanonicalLstatPath = lockPath;
    faults.failCanonicalLstatCount = 2;

    expect(acquireLocalStoreLock(lockPath, 0)).toBeNull();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.candidate'))).toEqual([]);
  });

  it('recovers a reclaim election when its candidate cleanup initially fails', () => {
    const lockPath = path.join(tmpDir, 'election-cleanup.lock');
    const electionPath = `${lockPath}.reclaim.owner`;
    writeProvablyStaleLock(lockPath);
    faults.candidateUnlinkPath = electionPath;

    const lock = acquireLocalStoreLock(lockPath, 2_000);

    expect(lock).not.toBeNull();
    expect(ownsLocalStoreLock(lock)).toBe(true);
    expect(fs.existsSync(electionPath)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.candidate'))).toEqual([]);
    releaseLocalStoreLock(lock);
  });
});
