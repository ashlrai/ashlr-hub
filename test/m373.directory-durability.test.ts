import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fsyncDirectory,
  type DirectoryDurabilityFs,
} from '../src/core/util/durability.js';

let root: string;
let directory: string;
let namedStat: BigIntStats;

function codedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function fakeFs(overrides: Partial<DirectoryDurabilityFs> = {}): DirectoryDurabilityFs {
  return {
    lstatSync: vi.fn(() => namedStat),
    openSync: vi.fn(() => 41),
    fstatSync: vi.fn(() => namedStat),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ashlr-m372-durability-'));
  directory = join(root, 'directory');
  // A real directory stat keeps the fixture faithful to Node's Stats API.
  mkdirSync(directory);
  namedStat = lstatSync(directory, { bigint: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('M373 directory durability', () => {
  it('requires POSIX directory open, identity, fsync, and close to succeed', () => {
    const fs = fakeFs();

    fsyncDirectory(directory, { platform: 'linux', fs });

    expect(fs.lstatSync).toHaveBeenCalledWith(directory, { bigint: true });
    expect(fs.openSync).toHaveBeenCalledOnce();
    expect(fs.fstatSync).toHaveBeenCalledWith(41, { bigint: true });
    expect(fs.fsyncSync).toHaveBeenCalledWith(41);
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it.each(['EPERM', 'EINVAL'])(
    'tolerates Windows directory-open %s after validating the named directory',
    (code) => {
      const fs = fakeFs({ openSync: vi.fn(() => { throw codedError(code); }) });

      expect(() => fsyncDirectory(directory, { platform: 'win32', fs })).not.toThrow();
      expect(fs.lstatSync).toHaveBeenCalledWith(directory, { bigint: true });
      expect(fs.fsyncSync).not.toHaveBeenCalled();
    },
  );

  it.each(['EPERM', 'EINVAL'])(
    'tolerates Windows directory-fsync %s but still closes the descriptor',
    (code) => {
      const fs = fakeFs({ fsyncSync: vi.fn(() => { throw codedError(code); }) });

      expect(() => fsyncDirectory(directory, { platform: 'win32', fs })).not.toThrow();
      expect(fs.closeSync).toHaveBeenCalledWith(41);
    },
  );

  it('keeps POSIX directory fsync failures fail-closed', () => {
    const fs = fakeFs({ fsyncSync: vi.fn(() => { throw codedError('EPERM'); }) });

    expect(() => fsyncDirectory(directory, { platform: 'linux', fs })).toThrow('EPERM');
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it('does not suppress unrelated Windows I/O failures', () => {
    const fs = fakeFs({ fsyncSync: vi.fn(() => { throw codedError('EIO'); }) });

    expect(() => fsyncDirectory(directory, { platform: 'win32', fs })).toThrow('EIO');
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it.each([
    ['open', 'EACCES'],
    ['fstat', 'EPERM'],
    ['close', 'EPERM'],
  ])('does not suppress Windows %s %s failures', (operation, code) => {
    const error = codedError(code);
    const fs = fakeFs({
      ...(operation === 'open' ? { openSync: vi.fn(() => { throw error; }) } : {}),
      ...(operation === 'fstat' ? { fstatSync: vi.fn(() => { throw error; }) } : {}),
      ...(operation === 'close' ? { closeSync: vi.fn(() => { throw error; }) } : {}),
    });

    expect(() => fsyncDirectory(directory, { platform: 'win32', fs })).toThrow(code);
  });

  it('rejects descriptor identity changes on every platform', () => {
    const other = mkdtempSync(join(root, 'other-'));
    const fs = fakeFs({ fstatSync: vi.fn(() => lstatSync(other, { bigint: true })) });

    expect(() => fsyncDirectory(directory, { platform: 'win32', fs }))
      .toThrow('directory identity changed');
    expect(fs.fsyncSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it('rejects a named directory that differs from the caller-captured identity', () => {
    const fs = fakeFs();

    expect(() => fsyncDirectory(directory, {
      platform: 'win32',
      fs,
      expectedIdentity: { dev: namedStat.dev, ino: namedStat.ino + 1n },
    })).toThrow('directory identity changed');
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.fsyncSync).not.toHaveBeenCalled();
  });

  it('runs the caller hook after descriptor identity validation and immediately before fsync', () => {
    const order: string[] = [];
    const fs = fakeFs({
      fstatSync: vi.fn(() => {
        order.push('identity');
        return namedStat;
      }),
      fsyncSync: vi.fn(() => { order.push('fsync'); }),
    });

    fsyncDirectory(directory, {
      platform: 'linux',
      fs,
      expectedIdentity: { dev: namedStat.dev, ino: namedStat.ino },
      beforeFsync: () => order.push('hook'),
    });

    expect(order).toEqual(['identity', 'hook', 'fsync']);
  });

  it('compares identities without losing precision above Number.MAX_SAFE_INTEGER', () => {
    const impreciseIdentity = 2n ** 54n;
    const named = new Proxy(namedStat, {
      get(target, property, receiver) {
        if (property === 'ino') return impreciseIdentity;
        return Reflect.get(target, property, receiver);
      },
    });
    const opened = new Proxy(namedStat, {
      get(target, property, receiver) {
        if (property === 'ino') return impreciseIdentity + 1n;
        return Reflect.get(target, property, receiver);
      },
    });
    const fs = fakeFs({
      lstatSync: vi.fn(() => named),
      fstatSync: vi.fn(() => opened),
    });

    expect(Number(named.ino)).toBe(Number(opened.ino));
    expect(() => fsyncDirectory(directory, { platform: 'linux', fs }))
      .toThrow('directory identity changed');
    expect(fs.fsyncSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it('rejects a non-directory named path before attempting descriptor operations', () => {
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'fixture');
    const fs = fakeFs({ lstatSync: vi.fn(() => lstatSync(file, { bigint: true })) });

    expect(() => fsyncDirectory(file, { platform: 'win32', fs }))
      .toThrow('not a named directory');
    expect(fs.openSync).not.toHaveBeenCalled();
  });
});
