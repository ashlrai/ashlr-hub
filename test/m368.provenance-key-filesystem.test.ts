import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({
  beforeKeyOpen: undefined as undefined | ((path: string, fs: typeof import('node:fs')) => void),
  beforeKeyLink: undefined as undefined | ((path: string, fs: typeof import('node:fs')) => void),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    // Exercise the lstat/fstat fallback used on platforms without O_NOFOLLOW.
    constants: { ...actual.constants, O_NOFOLLOW: undefined },
    openSync(path: import('node:fs').PathLike, ...args: unknown[]) {
      if (String(path).endsWith('/provenance.key')) race.beforeKeyOpen?.(String(path), actual);
      return (actual.openSync as (...params: unknown[]) => number)(path, ...args);
    },
    linkSync(existingPath: import('node:fs').PathLike, newPath: import('node:fs').PathLike) {
      if (String(newPath).endsWith('/provenance.key')) {
        race.beforeKeyLink?.(String(newPath), actual);
      }
      return actual.linkSync(existingPath, newPath);
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadExistingProvenanceKey,
  loadExistingProvenanceKeyReadOnly,
  loadOrCreateKey,
} from '../src/core/foundry/provenance.js';

const originalHome = process.env.HOME;
let tmpHome: string;

function makeStorage(directoryMode = 0o755): string {
  const keyDir = path.join(tmpHome, '.ashlr', 'foundry');
  fs.mkdirSync(keyDir, { recursive: true, mode: directoryMode });
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(tmpHome, '.ashlr'), directoryMode);
    fs.chmodSync(keyDir, directoryMode);
  }
  return path.join(keyDir, 'provenance.key');
}

function writeOpaqueKey(keyPath: string, length = 32): void {
  fs.writeFileSync(keyPath, randomBytes(length), { mode: 0o600 });
}

function expectBothLoadersToReject(pattern: RegExp): void {
  expect(() => loadExistingProvenanceKey()).toThrow(pattern);
  expect(() => loadOrCreateKey()).toThrow(pattern);
}

beforeEach(() => {
  race.beforeKeyOpen = undefined;
  race.beforeKeyLink = undefined;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-provenance-fs-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  race.beforeKeyOpen = undefined;
  race.beforeKeyLink = undefined;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('provenance key filesystem boundary', () => {
  it.skipIf(process.platform === 'win32')('accepts owner-controlled 0755 production directories', () => {
    const keyPath = makeStorage(0o755);
    writeOpaqueKey(keyPath);

    expect(loadExistingProvenanceKey()).toHaveLength(32);
    expect(loadOrCreateKey()).toHaveLength(32);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked storage directory in both paths', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-provenance-target-'));
    try {
      fs.symlinkSync(target, path.join(tmpHome, '.ashlr'));
      expectBothLoadersToReject(/unsafe storage directory/i);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked key in both paths', () => {
    const keyPath = makeStorage();
    const target = path.join(tmpHome, 'outside-key');
    writeOpaqueKey(target);
    fs.symlinkSync(target, keyPath);

    expectBothLoadersToReject(/symbolic link/i);
  });

  it.skipIf(process.platform === 'win32')('rejects group-writable home and storage parents', () => {
    const keyPath = makeStorage();
    writeOpaqueKey(keyPath);
    fs.chmodSync(path.join(tmpHome, '.ashlr'), 0o775);
    expectBothLoadersToReject(/unsafe permissions.*directory/i);

    fs.chmodSync(path.join(tmpHome, '.ashlr'), 0o755);
    fs.chmodSync(tmpHome, 0o770);
    expectBothLoadersToReject(/unsafe permissions.*directory/i);
  });

  it.skipIf(process.platform === 'win32')('rejects a hard-linked key in both paths', () => {
    const keyPath = makeStorage();
    writeOpaqueKey(keyPath);
    fs.linkSync(keyPath, path.join(tmpHome, 'second-link'));

    expectBothLoadersToReject(/exactly one link/i);
  });

  it('recovers the unique private installer temp link left by a crash', () => {
    const keyPath = makeStorage();
    writeOpaqueKey(keyPath);
    const installerTemp = `${keyPath}.123.${'a'.repeat(24)}.tmp`;
    fs.linkSync(keyPath, installerTemp);

    expect(loadExistingProvenanceKey()).toHaveLength(32);
    expect(fs.lstatSync(keyPath).nlink).toBe(1);
    expect(fs.existsSync(installerTemp)).toBe(false);
  });

  it('strict read-only loading refuses recovery-required state without mutation', () => {
    const keyPath = makeStorage();
    writeOpaqueKey(keyPath);
    const installerTemp = `${keyPath}.123.${'b'.repeat(24)}.tmp`;
    fs.linkSync(keyPath, installerTemp);

    expect(() => loadExistingProvenanceKeyReadOnly()).toThrow(/exactly one link/i);
    expect(fs.lstatSync(keyPath).nlink).toBe(2);
    expect(fs.existsSync(installerTemp)).toBe(true);
  });

  it.each([0, 31, 33])('rejects an existing %i-byte key without replacing it', (length) => {
    const keyPath = makeStorage();
    writeOpaqueKey(keyPath, length);
    const inode = fs.lstatSync(keyPath).ino;

    expectBothLoadersToReject(/invalid length.*exactly 32 bytes/i);
    expect(fs.lstatSync(keyPath).ino).toBe(inode);
    expect(fs.lstatSync(keyPath).size).toBe(length);
  });

  it('ignores an attacker-controlled legacy fixed temp path during atomic creation', () => {
    const keyPath = makeStorage();
    const target = path.join(tmpHome, 'temp-target');
    fs.writeFileSync(target, 'marker', { mode: 0o600 });
    fs.symlinkSync(target, `${keyPath}.tmp`);

    expect(loadOrCreateKey()).toHaveLength(32);
    expect(fs.lstatSync(`${keyPath}.tmp`).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(target).size).toBe('marker'.length);
  });

  it('rejects replacement between lstat and open even without O_NOFOLLOW', () => {
    const keyPath = makeStorage();
    writeOpaqueKey(keyPath);
    const replacement = path.join(tmpHome, 'replacement-key');
    writeOpaqueKey(replacement);
    let raced = false;
    race.beforeKeyOpen = (openedPath, actual) => {
      if (raced || openedPath !== keyPath) return;
      raced = true;
      actual.renameSync(keyPath, path.join(tmpHome, 'original-key'));
      actual.renameSync(replacement, keyPath);
    };

    expect(() => loadExistingProvenanceKey()).toThrow(/replaced while opening/i);
    expect(raced).toBe(true);
  });

  it('does not clobber a competing key created at the atomic install point', () => {
    const keyPath = makeStorage();
    let raced = false;
    race.beforeKeyLink = (linkedPath, actual) => {
      if (raced || linkedPath !== keyPath) return;
      raced = true;
      actual.writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    };

    expect(loadOrCreateKey()).toHaveLength(32);
    expect(raced).toBe(true);
    const installed = fs.lstatSync(keyPath);
    expect(installed.size).toBe(32);
    expect(installed.nlink).toBe(1);
  });
});
