import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({
  establishPrivateRoot: null as (() => void) | null,
  secureAuthorityFile: null as ((path: string) => void) | null,
  enrollmentPath: '',
  killPath: '',
  installedRegistry: false,
  failPostInstall: false,
  postInstallFailed: false,
  failRollback: false,
  raceKillCreate: false,
  raceKillBytes: 'kill switch active\n',
  failKillDirectorySync: false,
  failMarkerTempWrite: false,
  markerTempWriteFailed: false,
  failProcessIdentity: false,
  openPaths: new Map<number, string>(),
  durabilityEvents: [] as string[],
}));

vi.mock('../src/core/fleet/local-store-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/local-store-lock.js')>();
  return {
    ...actual,
    verifiedProcessStartIdentity(
      ...args: Parameters<typeof actual.verifiedProcessStartIdentity>
    ): ReturnType<typeof actual.verifiedProcessStartIdentity> {
      return faults.failProcessIdentity ? undefined : actual.verifiedProcessStartIdentity(...args);
    },
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync(path: import('node:fs').PathLike, ...args: unknown[]): number {
      const named = String(path);
      const flags = Number(args[0]);
      if (faults.raceKillCreate && named === faults.killPath &&
        (flags & actual.constants.O_CREAT) !== 0 && (flags & actual.constants.O_EXCL) !== 0) {
        faults.raceKillCreate = false;
        actual.writeFileSync(named, faults.raceKillBytes, { mode: 0o600 });
        if (!faults.secureAuthorityFile) throw new Error('authority file assurer unavailable');
        faults.secureAuthorityFile(named);
        faults.durabilityEvents.push('racer-created-kill');
        const error = new Error('injected concurrent sentinel create') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      const fd = (actual.openSync as (...params: unknown[]) => number)(path, ...args);
      faults.openPaths.set(fd, named);
      return fd;
    },
    closeSync(fd: number): void {
      actual.closeSync(fd);
      faults.openPaths.delete(fd);
    },
    fsyncSync(fd: number): void {
      const path = faults.openPaths.get(fd);
      if (path === faults.killPath) faults.durabilityEvents.push('fsync-kill-file');
      if (path === join(faults.killPath, '..')) {
        faults.durabilityEvents.push('fsync-kill-directory');
        if (faults.failKillDirectorySync) {
          faults.failKillDirectorySync = false;
          const error = new Error('injected kill directory sync failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
      }
      actual.fsyncSync(fd);
    },
    writeSync(fd: number, ...args: unknown[]): number {
      const named = faults.openPaths.get(fd) ?? '';
      if (faults.failMarkerTempWrite && !faults.markerTempWriteFailed &&
        /\.enrollment\.transaction\.[a-f0-9]{32}\.tmp$/.test(named)) {
        faults.markerTempWriteFailed = true;
        const partialArgs = [...args];
        partialArgs[2] = Math.min(Number(partialArgs[2]), 8);
        (actual.writeSync as (...params: unknown[]) => number)(fd, ...partialArgs);
        const error = new Error('injected partial marker temp write') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return (actual.writeSync as (...params: unknown[]) => number)(fd, ...args);
    },
    lstatSync(path: import('node:fs').PathLike, ...args: unknown[]) {
      const named = String(path);
      if (faults.failPostInstall && faults.installedRegistry && !faults.postInstallFailed &&
        named === faults.enrollmentPath) {
        faults.postInstallFailed = true;
        const error = new Error('injected post-install readback failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return (actual.lstatSync as (...params: unknown[]) => unknown)(path, ...args);
    },
    renameSync(source: import('node:fs').PathLike, destination: import('node:fs').PathLike): void {
      const from = String(source);
      const to = String(destination);
      if (faults.failRollback && from.endsWith('.backup') && to === faults.enrollmentPath) {
        const error = new Error('injected rollback failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      actual.renameSync(source, destination);
      if (from.endsWith('.tmp') && to === faults.enrollmentPath) faults.installedRegistry = true;
    },
  };
});

vi.mock('../src/core/sandbox/mutation-fence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/mutation-fence.js')>();
  faults.establishPrivateRoot = () => {
    const fence = actual.acquireOutwardMutationFence();
    try {
      if (!actual.ownsOutwardMutationFence(fence)) {
        throw new Error('production outward mutation fence unavailable');
      }
    } finally {
      actual.releaseOutwardMutationFence(fence);
    }
  };
  return {
    ...actual,
    acquireOutwardMutationFence: () => ({ path: 'm415-fence', token: 'owned', dev: 1, ino: 1 }),
    ownsOutwardMutationFence: () => true,
    releaseOutwardMutationFence: () => undefined,
  };
});

import * as fs from 'node:fs';
import {
  assertMayMutate,
  canonicalEnrollmentPath,
  enroll,
  isEnrolled,
  listEnrolled,
  setKill,
} from '../src/core/sandbox/policy.js';
import { assurePrivateStoragePath } from '../src/core/util/private-storage.js';

const policyModuleUrl = new URL('../src/core/sandbox/policy.ts', import.meta.url).href;
let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

function secureInjectedAuthorityFile(path: string): void {
  const authorityRoot = process.env.ASHLR_HOME;
  if (!authorityRoot) throw new Error('ASHLR_HOME unavailable for authority file assurance');
  const assurance = assurePrivateStoragePath(
    path,
    'file',
    'secure-created',
    { anchorPath: authorityRoot },
  );
  if (!assurance.ok) {
    throw new Error(`could not secure injected authority file: ${assurance.reason}`);
  }
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = join(tmpdir(), `ashlr-m415-${process.pid}-${randomUUID()}`);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  faults.enrollmentPath = join(home, '.ashlr', 'enrollment.json');
  faults.killPath = join(home, '.ashlr', 'KILL');
  faults.installedRegistry = false;
  faults.failPostInstall = false;
  faults.postInstallFailed = false;
  faults.failRollback = false;
  faults.raceKillCreate = false;
  faults.raceKillBytes = 'kill switch active\n';
  faults.failKillDirectorySync = false;
  faults.failMarkerTempWrite = false;
  faults.markerTempWriteFailed = false;
  faults.failProcessIdentity = false;
  faults.openPaths.clear();
  faults.durabilityEvents.length = 0;
  faults.secureAuthorityFile = secureInjectedAuthorityFile;
  if (!faults.establishPrivateRoot) throw new Error('private root initializer unavailable');
  faults.establishPrivateRoot();
  faults.openPaths.clear();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M415 policy durability races', () => {
  it('enrolls from self-clock identity when external process probes are unavailable', () => {
    faults.failProcessIdentity = true;

    const repo = join(home, 'self-clock-enrolled');
    expect(enroll(repo)).toEqual({
      ok: true,
      changed: true,
      quiesced: true,
      reason: 'enrolled',
    });
    expect(JSON.parse(fs.readFileSync(faults.enrollmentPath, 'utf8'))).toEqual({
      repos: [canonicalEnrollmentPath(repo)],
    });
    expect(fs.existsSync(join(home, '.ashlr', 'enrollment.transaction'))).toBe(false);
    expect(fs.readdirSync(join(home, '.ashlr')).filter((name) =>
      name.startsWith('.enrollment.'))).toEqual([]);
  });

  it('never exposes a canonical partial marker when marker temp writing fails', () => {
    faults.failMarkerTempWrite = true;

    expect(enroll(join(home, 'must-not-enroll'))).toMatchObject({
      ok: false,
      changed: false,
      reason: 'registry-transaction-unavailable',
    });
    expect(faults.markerTempWriteFailed).toBe(true);
    expect(fs.existsSync(join(home, '.ashlr', 'enrollment.transaction'))).toBe(false);
    expect(fs.existsSync(faults.enrollmentPath)).toBe(false);
    expect(fs.readdirSync(join(home, '.ashlr')).filter((name) =>
      name.startsWith('.enrollment.transaction.'))).toEqual([]);
  });

  describe('failed permissive install recovery', () => {
    let originalRepo: string;

    beforeEach(() => {
      originalRepo = join(home, 'original-repo');
      fs.writeFileSync(
        faults.enrollmentPath,
        `${JSON.stringify({ repos: [originalRepo] }, null, 2)}\n`,
        { mode: 0o600 },
      );
      secureInjectedAuthorityFile(faults.enrollmentPath);
    });

    it('keeps a failed permissive install non-authoritative when rollback also fails', () => {
      const newlyEnrolledRepo = join(home, 'newly-enrolled-repo');
      faults.failPostInstall = true;
      faults.failRollback = true;

      const result = enroll(newlyEnrolledRepo);

      expect(result).toMatchObject({ ok: false, changed: false, quiesced: false });
      expect(faults.postInstallFailed).toBe(true);
      expect(fs.existsSync(join(home, '.ashlr', 'enrollment.transaction'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(faults.enrollmentPath, 'utf8'))).toEqual({
        repos: [originalRepo, canonicalEnrollmentPath(newlyEnrolledRepo)],
      });
      expect(listEnrolled()).toEqual([]);
      expect(isEnrolled(newlyEnrolledRepo)).toBe(false);
      expect(() => assertMayMutate(newlyEnrolledRepo)).toThrow(/not enrolled/i);

      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `import { isEnrolled, listEnrolled } from ${JSON.stringify(policyModuleUrl)};` +
            `process.stdout.write(JSON.stringify({ repos: listEnrolled(), enrolled: isEnrolled(${JSON.stringify(newlyEnrolledRepo)}) }));`,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr') },
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      if (child.error) throw child.error;
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ repos: [], enrolled: false });
    });
  });

  it('syncs and validates a concurrently-created sentinel before reporting success', () => {
    faults.raceKillCreate = true;

    const result = setKill(true);

    expect(result).toEqual({
      ok: true,
      changed: false,
      quiesced: true,
      reason: 'already-active',
    });
    expect(fs.readFileSync(faults.killPath, 'utf8')).toBe('kill switch active\n');
    expect(faults.durabilityEvents.slice(0, 3)).toEqual([
      'racer-created-kill',
      'fsync-kill-file',
      'fsync-kill-directory',
    ]);
  });

  it('rejects same-length content from a concurrently-created sentinel', () => {
    faults.raceKillCreate = true;
    faults.raceKillBytes = 'kill switch activf\n';

    expect(setKill(true)).toEqual({
      ok: false,
      changed: false,
      quiesced: false,
      reason: 'invalid-kill-sentinel',
    });
    expect(faults.durabilityEvents).toEqual(['racer-created-kill']);
  });

  it('does not report raced sentinel success when directory durability fails', () => {
    faults.raceKillCreate = true;
    faults.failKillDirectorySync = true;

    expect(setKill(true)).toEqual({
      ok: false,
      changed: false,
      quiesced: false,
      reason: 'kill-sentinel-sync-failed',
    });
    expect(faults.durabilityEvents).toEqual([
      'racer-created-kill',
      'fsync-kill-file',
      'fsync-kill-directory',
    ]);
  });
});
