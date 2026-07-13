import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string, fs: typeof import('node:fs')) => void),
  beforeRead: undefined as undefined | ((path: string, fs: typeof import('node:fs')) => void),
  failFstat: false,
  openedPath: '',
  closes: 0,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync(path: import('node:fs').PathLike, ...args: unknown[]) {
      race.beforeOpen?.(String(path), actual);
      race.openedPath = String(path);
      return (actual.openSync as (...params: unknown[]) => number)(path, ...args);
    },
    readSync(fd: number, ...args: unknown[]) {
      const hook = race.beforeRead;
      race.beforeRead = undefined;
      hook?.(race.openedPath, actual);
      return (actual.readSync as (...params: unknown[]) => number)(fd, ...args);
    },
    fstatSync(fd: number, ...args: unknown[]) {
      if (race.failFstat) {
        race.failFstat = false;
        throw new Error('injected fstat failure');
      }
      return (actual.fstatSync as (...params: unknown[]) => import('node:fs').Stats)(fd, ...args);
    },
    closeSync(fd: number) {
      race.closes += 1;
      actual.closeSync(fd);
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  openStableDirectoryGuard,
  readStableRegularFile,
} from '../src/core/util/stable-file-read.js';

let root: string;
let anchor: string;

function recordPath(name = 'record.json'): string {
  return path.join(anchor, name);
}

function read(file = recordPath(), maxFileBytes = 1_024, remainingBytes = 1_024) {
  return readStableRegularFile(file, { anchorPath: anchor, maxFileBytes, remainingBytes });
}

beforeEach(() => {
  race.beforeOpen = undefined;
  race.beforeRead = undefined;
  race.failFstat = false;
  race.openedPath = '';
  race.closes = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-stable-read-'));
  anchor = path.join(root, 'records');
  fs.mkdirSync(anchor, { mode: 0o700 });
});

afterEach(() => {
  race.beforeOpen = undefined;
  race.beforeRead = undefined;
  race.failFstat = false;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readStableRegularFile', () => {
  it('returns a stable regular file and exact byte accounting', () => {
    const text = '{"status":"ready"}\n';
    fs.writeFileSync(recordPath(), text, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(recordPath(), 0o644);
    const modeBefore = fs.statSync(recordPath()).mode;

    const result = read();

    expect(result).toMatchObject({
      ok: true,
      text,
      bytesRead: Buffer.byteLength(text),
    });
    if (result.ok) expect(result.mtimeMs).toBeGreaterThan(0);
    expect(fs.statSync(recordPath()).mode).toBe(modeBefore);
    expect(race.closes).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic and hard-linked records', () => {
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, 'outside', { mode: 0o600 });
    fs.symlinkSync(outside, recordPath('symbolic.json'));
    fs.linkSync(outside, recordPath('hard.json'));

    expect(read(recordPath('symbolic.json'))).toEqual({ ok: false, reason: 'unsafe-file' });
    expect(read(recordPath('hard.json'))).toEqual({ ok: false, reason: 'unsafe-file' });
    expect(race.closes).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rejects group or world-writable paths', () => {
    fs.writeFileSync(recordPath(), 'record', { mode: 0o600 });
    fs.chmodSync(recordPath(), 0o666);
    expect(read()).toEqual({ ok: false, reason: 'unsafe-file' });

    fs.chmodSync(recordPath(), 0o600);
    fs.chmodSync(anchor, 0o777);
    expect(read()).toEqual({ ok: false, reason: 'unsafe-path' });
    expect(race.closes).toBe(0);
  });

  it('rejects oversized and sparse records before allocation', () => {
    fs.writeFileSync(recordPath('oversized.json'), '12345', { mode: 0o600 });
    fs.writeFileSync(recordPath('sparse.json'), '', { mode: 0o600 });
    fs.truncateSync(recordPath('sparse.json'), 16 * 1024 * 1024);

    expect(read(recordPath('oversized.json'), 4, 100)).toEqual({
      ok: false,
      reason: 'per-file-byte-limit',
    });
    expect(read(recordPath('oversized.json'), 100, 4)).toEqual({
      ok: false,
      reason: 'byte-limit',
    });
    expect(read(recordPath('sparse.json'), 1_024, 1_024)).toEqual({
      ok: false,
      reason: 'per-file-byte-limit',
    });
    expect(race.closes).toBe(0);
  });

  it('rejects lexical and resolved path escapes', () => {
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, 'outside', { mode: 0o600 });

    expect(read(outside)).toEqual({ ok: false, reason: 'unsafe-path' });

    const linkedParent = path.join(anchor, 'linked-parent');
    fs.symlinkSync(root, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    expect(read(path.join(linkedParent, 'outside.json'))).toEqual({
      ok: false,
      reason: 'unsafe-path',
    });
  });

  it('detects a same-size replacement between path inspection and open', () => {
    fs.writeFileSync(recordPath(), 'first', { mode: 0o600 });
    const replacement = path.join(root, 'replacement.json');
    fs.writeFileSync(replacement, 'other', { mode: 0o600 });
    race.beforeOpen = (openedPath, actual) => {
      race.beforeOpen = undefined;
      actual.renameSync(openedPath, path.join(root, 'original.json'));
      actual.renameSync(replacement, openedPath);
    };

    expect(read()).toEqual({ ok: false, reason: 'changed-during-read' });
    expect(race.closes).toBe(1);
  });

  it('detects growth while reading without allocating the grown size', () => {
    fs.writeFileSync(recordPath(), 'start', { mode: 0o600 });
    race.beforeRead = (openedPath, actual) => actual.appendFileSync(openedPath, '-growth');

    expect(read()).toEqual({ ok: false, reason: 'changed-during-read' });
    expect(race.closes).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('detects an ancestor replacement before open', () => {
    fs.writeFileSync(recordPath(), 'first', { mode: 0o600 });
    race.beforeOpen = (openedPath, actual) => {
      race.beforeOpen = undefined;
      actual.renameSync(anchor, path.join(root, 'original-records'));
      actual.mkdirSync(anchor, { mode: 0o700 });
      actual.writeFileSync(openedPath, 'other', { mode: 0o600 });
    };

    expect(read()).toEqual({ ok: false, reason: 'changed-during-read' });
    expect(race.closes).toBe(1);
  });

  it('closes the single opened descriptor exactly once after failure', () => {
    fs.writeFileSync(recordPath(), 'record', { mode: 0o600 });
    race.failFstat = true;

    expect(read()).toEqual({ ok: false, reason: 'changed-during-read' });
    expect(race.closes).toBe(1);
  });
});

describe('openStableDirectoryGuard', () => {
  it.skipIf(process.platform === 'win32')('holds one descriptor and detects directory rebinding', () => {
    const guard = openStableDirectoryGuard(anchor, { anchorPath: root });
    expect(guard.ok).toBe(true);
    expect(race.closes).toBe(0);

    fs.renameSync(anchor, path.join(root, 'original-records'));
    fs.mkdirSync(anchor, { mode: 0o700 });

    expect(guard.ok && guard.finish()).toBe('changed-during-read');
    expect(race.closes).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('rejects a writable store before enumeration', () => {
    fs.chmodSync(anchor, 0o777);

    expect(openStableDirectoryGuard(anchor, { anchorPath: root })).toEqual({
      ok: false,
      reason: 'unsafe-path',
    });
    expect(race.closes).toBe(0);
  });
});
