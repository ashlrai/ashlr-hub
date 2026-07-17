import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';

const CHILD_TIMEOUT_MS = 12_000;
const LOCK_MODULE_URL = new URL('../src/core/fleet/local-store-lock.ts', import.meta.url).href;
const CHILD_SOURCE = String.raw`
  import { acquireLocalStoreLock } from ${JSON.stringify(LOCK_MODULE_URL)};

  const lock = acquireLocalStoreLock(process.env.LOCK_PATH, 0);
  if (!process.send) throw new Error('IPC unavailable');
  process.send({ acquired: lock !== null, lock });
  if (!lock) {
    process.disconnect();
  } else {
    setInterval(() => {}, 1_000);
  }
`;

let tmpDir: string;
const children = new Set<ChildProcess>();

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function spawnLockHolder(lockPath: string): {
  child: ChildProcess;
  ready: Promise<LocalStoreLock>;
} {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SOURCE],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOCK_PATH: lockPath },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  const ready = new Promise<LocalStoreLock>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Lock holder did not report readiness: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.once('message', (message: { acquired?: unknown; lock?: unknown }) => {
      clearTimeout(timer);
      if (message.acquired !== true || !message.lock) {
        reject(new Error(`Lock holder failed to acquire: ${stderr}`));
        return;
      }
      resolve(message.lock as LocalStoreLock);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  child.once('exit', () => children.delete(child));
  return { child, ready };
}

async function killHolder(child: ChildProcess): Promise<void> {
  const exited = waitForExit(child);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m414-local-lock-'));
});

afterEach(async () => {
  const active = [...children];
  for (const child of active) child.kill();
  await Promise.all(active.map(waitForExit));
  children.clear();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('local store lock unknown-owner recovery', () => {
  it('does not reclaim aged corrupt metadata while the owner process is alive', async () => {
    const lockPath = path.join(tmpDir, 'live-corrupt.lock');
    const holder = spawnLockHolder(lockPath);
    const ownerLock = await holder.ready;
    expect(holder.child.pid).toBeTypeOf('number');
    expect(() => process.kill(holder.child.pid!, 0)).not.toThrow();

    fs.writeFileSync(lockPath, '{corrupt owner metadata\n', 'utf8');
    const pastGrace = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath, pastGrace, pastGrace);
    const corrupted = fs.lstatSync(lockPath);
    expect(corrupted.dev).toBe(ownerLock.dev);
    expect(corrupted.ino).toBe(ownerLock.ino);
    expect(Date.now() - corrupted.mtimeMs).toBeGreaterThan(1_000);

    expect(acquireLocalStoreLock(lockPath, 50)).toBeNull();
    expect(() => process.kill(holder.child.pid!, 0)).not.toThrow();
    const retained = fs.lstatSync(lockPath);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({
      dev: ownerLock.dev,
      ino: ownerLock.ino,
    });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('{corrupt owner metadata\n');
    expect(fs.existsSync(`${lockPath}.reclaim.owner`)).toBe(false);
  });

  it('still reclaims a valid lock after its owner process is proven dead', async () => {
    const lockPath = path.join(tmpDir, 'dead-owner.lock');
    const holder = spawnLockHolder(lockPath);
    const deadLock = await holder.ready;
    await killHolder(holder.child);

    const successor = acquireLocalStoreLock(lockPath, 2_000);
    expect(successor).not.toBeNull();
    expect(successor?.token).not.toBe(deadLock.token);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({ token: successor?.token });
    releaseLocalStoreLock(successor);
  });

  it('recovers a dead canonical lock stranded with an unlink guard hardlink', async () => {
    const lockPath = path.join(tmpDir, 'dead-guarded-owner.lock');
    const holder = spawnLockHolder(lockPath);
    const deadLock = await holder.ready;
    const guard = `${lockPath}.unlink-${holder.child.pid}-${randomUUID()}.guard`;
    fs.linkSync(lockPath, guard);
    expect(fs.lstatSync(lockPath).nlink).toBe(2);
    await killHolder(holder.child);

    const successor = acquireLocalStoreLock(lockPath, 2_000);

    expect(successor).not.toBeNull();
    expect(successor?.token).not.toBe(deadLock.token);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({ token: successor?.token });
    expect(fs.existsSync(guard)).toBe(false);
    releaseLocalStoreLock(successor);
  });

  it('does not collapse an unlink guard while its canonical owner is live', async () => {
    const lockPath = path.join(tmpDir, 'live-guarded-owner.lock');
    const holder = spawnLockHolder(lockPath);
    await holder.ready;
    const guard = `${lockPath}.unlink-${holder.child.pid}-${randomUUID()}.guard`;
    fs.linkSync(lockPath, guard);

    expect(acquireLocalStoreLock(lockPath, 50)).toBeNull();
    expect(fs.lstatSync(lockPath).nlink).toBe(2);
    expect(fs.existsSync(guard)).toBe(true);
    expect(() => process.kill(holder.child.pid!, 0)).not.toThrow();
  });

  it('does not collapse an unlink guard for an unknown dead owner', async () => {
    const lockPath = path.join(tmpDir, 'unknown-guarded-owner.lock');
    const holder = spawnLockHolder(lockPath);
    await holder.ready;
    const guard = `${lockPath}.unlink-${holder.child.pid}-${randomUUID()}.guard`;
    fs.linkSync(lockPath, guard);
    fs.writeFileSync(lockPath, '{corrupt owner metadata\n', 'utf8');
    const pastGrace = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath, pastGrace, pastGrace);
    await killHolder(holder.child);

    expect(acquireLocalStoreLock(lockPath, 50)).toBeNull();
    expect(fs.lstatSync(lockPath).nlink).toBe(2);
    expect(fs.existsSync(guard)).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('{corrupt owner metadata\n');
  });

  it('does not reclaim a dead lock through an arbitrary hardlink alias', async () => {
    const lockPath = path.join(tmpDir, 'dead-arbitrary-alias.lock');
    const holder = spawnLockHolder(lockPath);
    await holder.ready;
    const alias = `${lockPath}.unrecognized-hardlink`;
    fs.linkSync(lockPath, alias);
    await killHolder(holder.child);

    expect(acquireLocalStoreLock(lockPath, 50)).toBeNull();
    expect(fs.lstatSync(lockPath).nlink).toBe(2);
    expect(fs.existsSync(alias)).toBe(true);
  });
});
