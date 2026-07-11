import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  type Stats,
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
let namedStat: Stats;

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
  namedStat = lstatSync(directory);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('M373 directory durability', () => {
  it('requires POSIX directory open, identity, fsync, and close to succeed', () => {
    const fs = fakeFs();

    fsyncDirectory(directory, { platform: 'linux', fs });

    expect(fs.lstatSync).toHaveBeenCalledWith(directory);
    expect(fs.openSync).toHaveBeenCalledOnce();
    expect(fs.fstatSync).toHaveBeenCalledWith(41);
    expect(fs.fsyncSync).toHaveBeenCalledWith(41);
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it.each(['EPERM', 'EINVAL'])(
    'tolerates Windows directory-open %s after validating the named directory',
    (code) => {
      const fs = fakeFs({ openSync: vi.fn(() => { throw codedError(code); }) });

      expect(() => fsyncDirectory(directory, { platform: 'win32', fs })).not.toThrow();
      expect(fs.lstatSync).toHaveBeenCalledWith(directory);
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
    const fs = fakeFs({ fstatSync: vi.fn(() => lstatSync(other)) });

    expect(() => fsyncDirectory(directory, { platform: 'win32', fs }))
      .toThrow('directory identity changed');
    expect(fs.fsyncSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it('rejects a non-directory named path before attempting descriptor operations', () => {
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'fixture');
    const fs = fakeFs({ lstatSync: vi.fn(() => lstatSync(file)) });

    expect(() => fsyncDirectory(file, { platform: 'win32', fs }))
      .toThrow('not a named directory');
    expect(fs.openSync).not.toHaveBeenCalled();
  });
});
