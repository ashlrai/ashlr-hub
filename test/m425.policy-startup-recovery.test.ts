import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recoverEnrollmentRegistry,
  type EnrollmentRegistryReadiness,
} from '../src/core/sandbox/policy.js';
import { assurePrivateStoragePath } from '../src/core/util/private-storage.js';

const policyModuleUrl = new URL('../src/core/sandbox/policy.ts', import.meta.url).href;
const children = new Set<ChildProcess>();
let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function registryBytes(repos: string[]): Buffer {
  return Buffer.from(`${JSON.stringify({ repos }, null, 2)}\n`, 'utf8');
}

function writeAuthorityFile(path: string, bytes: string | Buffer): void {
  writeFileSync(path, bytes, { mode: 0o600 });
  const assurance = assurePrivateStoragePath(
    path,
    'file',
    'secure-created',
    { anchorPath: join(home, '.ashlr') },
  );
  if (!assurance.ok) {
    throw new Error(`M425 fixture authority file setup failed: ${assurance.reason}`);
  }
}

function markerAuthentication(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update('ashlr:enrollment-transaction:v2\0')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function writeMarker(
  pid: number,
  before: Buffer | null,
  after: Buffer,
): { temp: string; backup: string; marker: string } {
  const nonce = randomBytes(16).toString('hex');
  const tempName = `.enrollment.${nonce}.tmp`;
  const backupName = `.enrollment.${nonce}.backup`;
  const payload = {
    version: 2,
    state: 'prepared',
    pid,
    startRef: '0'.repeat(64),
    startRefVerified: false,
    startRefSource: null,
    nonce,
    beforeDigest: before === null ? null : digest(before),
    afterDigest: digest(after),
    tempName,
    backupName,
  };
  const root = join(home, '.ashlr');
  const marker = join(root, 'enrollment.transaction');
  writeAuthorityFile(
    marker,
    `${JSON.stringify({ ...payload, authentication: markerAuthentication(payload) })}\n`,
  );
  return { temp: join(root, tempName), backup: join(root, backupName), marker };
}

function startOwner(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function deadOwnerPid(): Promise<number> {
  const child = await startOwner();
  const pid = child.pid!;
  child.kill('SIGKILL');
  await waitForExit(child);
  return pid;
}

function runReadiness(unknownPid?: number): EnrollmentRegistryReadiness {
  const processKillOverride = unknownPid === undefined
    ? ''
    : `
      const originalKill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid === ${unknownPid} && signal === 0) {
          throw Object.assign(new Error('owner state unavailable'), { code: 'EPERM' });
        }
        return originalKill(pid, signal);
      };
    `;
  const source = `
    ${processKillOverride}
    const { recoverEnrollmentRegistry } = await import(${JSON.stringify(policyModuleUrl)});
    const result = recoverEnrollmentRegistry({ waitMs: 1000 });
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ASHLR_HOME: join(home, '.ashlr'),
    },
    encoding: 'utf8',
    timeout: 8_000,
  });
  if (child.error) throw child.error;
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as EnrollmentRegistryReadiness;
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m425-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  const readiness = recoverEnrollmentRegistry({ waitMs: 1_000 });
  if (readiness.state !== 'ready' || readiness.reason !== 'missing-empty') {
    throw new Error(`M425 fixture authority setup failed: ${readiness.reason}`);
  }
});

afterEach(async () => {
  const running = [...children];
  for (const child of running) child.kill('SIGKILL');
  await Promise.all(running.map(waitForExit));
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M425 enrollment registry startup recovery', { timeout: 15_000 }, () => {
  it('commits a dead-owner installed transaction before exposing enrolled repos', async () => {
    const original = join(home, 'original');
    const committed = join(home, 'committed-before-crash');
    const before = registryBytes([original]);
    const after = registryBytes([original, committed]);
    const paths = writeMarker(await deadOwnerPid(), before, after);
    writeAuthorityFile(join(home, '.ashlr', 'enrollment.json'), after);
    writeAuthorityFile(paths.backup, before);

    expect(runReadiness()).toEqual({
      state: 'ready',
      recovered: true,
      repos: [original, committed],
      reason: 'registry-transaction-committed',
    });
    expect(existsSync(paths.marker)).toBe(false);
    expect(existsSync(paths.backup)).toBe(false);
  });

  it('refuses a live-owner transaction without exposing a healthy empty registry', async () => {
    const original = join(home, 'original');
    const before = registryBytes([original]);
    const after = registryBytes([original, join(home, 'crashed')]);
    writeAuthorityFile(join(home, '.ashlr', 'enrollment.json'), before);
    const owner = await startOwner();
    const paths = writeMarker(owner.pid!, before, after);
    writeAuthorityFile(paths.temp, after);

    const readiness = runReadiness();
    expect(readiness).toEqual({
      state: 'degraded',
      recovered: false,
      reason: 'registry-transaction-owner-alive',
    });
    expect('repos' in readiness).toBe(false);
    expect(existsSync(paths.marker)).toBe(true);
    expect(existsSync(paths.temp)).toBe(true);
  });

  it('refuses unknown owner state and preserves transaction artifacts', () => {
    const unknownPid = 2_147_483_646;
    const original = join(home, 'original');
    const before = registryBytes([original]);
    const after = registryBytes([original, join(home, 'crashed')]);
    writeAuthorityFile(join(home, '.ashlr', 'enrollment.json'), before);
    const paths = writeMarker(unknownPid, before, after);
    writeAuthorityFile(paths.temp, after);

    const readiness = runReadiness(unknownPid);
    expect(readiness).toEqual({
      state: 'degraded',
      recovered: false,
      reason: 'registry-transaction-owner-unknown',
    });
    expect('repos' in readiness).toBe(false);
    expect(existsSync(paths.marker)).toBe(true);
    expect(existsSync(paths.temp)).toBe(true);
  });

  it('distinguishes the healthy empty default from a malformed registry', () => {
    expect(runReadiness()).toEqual({
      state: 'ready',
      recovered: false,
      repos: [],
      reason: 'missing-empty',
    });

    writeAuthorityFile(join(home, '.ashlr', 'enrollment.json'), '{malformed}\n');
    const degraded = runReadiness();
    expect(degraded).toEqual({
      state: 'degraded',
      recovered: false,
      reason: 'unreadable-registry',
    });
    expect('repos' in degraded).toBe(false);
    expect(readFileSync(join(home, '.ashlr', 'enrollment.json'), 'utf8')).toBe('{malformed}\n');
  });
});
