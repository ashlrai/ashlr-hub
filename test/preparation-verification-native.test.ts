import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ lstatSync: vi.fn(), fstatSync: vi.fn(), realpathSync: vi.fn(),
  openSync: vi.fn(), readSync: vi.fn(), closeSync: vi.fn() }));
vi.mock('node:fs', () => ({ ...io, constants: { O_RDONLY: 0, O_NOFOLLOW: 256, O_NONBLOCK: 4 } }));
import { assertPreparationGit, resolvePreparationGit } from '../scripts/evaluators/preparation-verification-native.mjs';

const first = '/Library/Developer/CommandLineTools/usr/bin/git';
const second = '/Applications/Xcode.app/Contents/Developer/usr/bin/git';
function stat(file: boolean, ino: number) {
  return { dev: 1n, ino: BigInt(ino), size: file ? 3n : 0n, mode: file ? 0o100755n : 0o40755n,
    uid: 0n, gid: 0n, nlink: 1n, mtimeNs: 1n, ctimeNs: 1n,
    isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false };
}
let files: Map<string, ReturnType<typeof stat>>, bytes: Buffer, selected: string;
function add(path: string) {
  files.set(path, stat(true, files.size + 1));
  for (let current = dirname(path); ; current = dirname(current)) {
    if (!files.has(current)) files.set(current, stat(false, files.size + 1));
    if (current === dirname(current)) break;
  }
}
const missing = () => Object.assign(new Error('private missing path'), { code: 'ENOENT' });
beforeEach(() => {
  vi.resetAllMocks(); files = new Map(); bytes = Buffer.from('git'); selected = first;
  add(first); add(second);
  io.lstatSync.mockImplementation((path: string) => { const value = files.get(path); if (!value) throw missing(); return { ...value }; });
  io.fstatSync.mockImplementation(() => ({ ...files.get(selected)! }));
  io.realpathSync.mockImplementation((path: string) => path);
  io.openSync.mockImplementation((path: string) => { selected = path; return 9; });
  io.closeSync.mockImplementation(() => undefined);
  io.readSync.mockImplementation((_fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    bytes.copy(buffer, offset, position, position + length));
});

describe('closed preparation native Git identity (mock filesystem only)', () => {
  it('selects and hashes the first location with bounded nofollow descriptor reads', () => {
    expect(resolvePreparationGit()).toEqual({ path: first, digest: createHash('sha256').update(bytes).digest('hex') });
    expect(io.openSync).toHaveBeenCalledWith(first, 260);
    expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(9);
    expect(io.lstatSync.mock.calls.some(([path]) => path === second)).toBe(false);
  });
  it('falls back only for a genuinely missing path', () => {
    files.delete(first); expect(resolvePreparationGit().path).toBe(second);
    expect(io.openSync).toHaveBeenCalledExactlyOnceWith(second, 260);
  });
  it('allows a genuinely missing developer directory', () => {
    files.delete('/Library/Developer'); expect(resolvePreparationGit().path).toBe(second);
  });
  it.each(['EACCES', 'EPERM', 'ENOTDIR'])('never falls back on %s', code => {
    io.lstatSync.mockImplementation(() => { throw Object.assign(new Error('private'), { code }); });
    expect(() => resolvePreparationGit()).toThrow('Preparation Git unavailable or changed'); expect(io.openSync).not.toHaveBeenCalled();
  });
  it.each(['file-owner', 'directory-owner', 'file-writable', 'directory-writable', 'symlink', 'directory-symlink',
    'nonexecutable', 'hardlinked', 'empty', 'oversized', 'not-file'] as const)('rejects unsafe existing %s without fallback', kind => {
    const file = files.get(first)!, parent = files.get(dirname(first))!;
    if (kind === 'file-owner') file.uid = 501n;
    if (kind === 'directory-owner') parent.uid = 501n;
    if (kind === 'file-writable') file.mode |= 0o020n;
    if (kind === 'directory-writable') parent.mode |= 0o002n;
    if (kind === 'symlink') file.isSymbolicLink = () => true;
    if (kind === 'directory-symlink') parent.isSymbolicLink = () => true;
    if (kind === 'nonexecutable') file.mode = 0o100644n;
    if (kind === 'hardlinked') file.nlink = 2n;
    if (kind === 'empty') file.size = 0n;
    if (kind === 'oversized') file.size = 256n * 1024n * 1024n + 1n;
    if (kind === 'not-file') file.isFile = () => false;
    expect(() => resolvePreparationGit()).toThrow('Preparation Git unavailable or changed');
    expect(io.openSync).not.toHaveBeenCalled();
    expect(io.lstatSync.mock.calls.some(([path]) => path === second)).toBe(false);
  });
  it('checks unsafe ancestors before considering a missing leaf', () => {
    files.delete(first); files.get('/Library')!.uid = 501n;
    expect(() => resolvePreparationGit()).toThrow(); expect(io.openSync).not.toHaveBeenCalled();
  });
  it('refuses a noncanonical path', () => {
    io.realpathSync.mockReturnValue('/untrusted/git'); expect(() => resolvePreparationGit()).toThrow();
    expect(io.openSync).not.toHaveBeenCalled();
  });
  it('refuses a changed descriptor and always closes it', () => {
    io.fstatSync.mockImplementation(() => ({ ...files.get(first)!, ino: 99n }));
    expect(() => resolvePreparationGit()).toThrow(); expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(9);
  });
  it.each(['content-growth', 'short-read', 'ancestor-replacement', 'leaf-replacement', 'read-error'] as const)(
    'refuses %s during reading and closes custody', kind => {
      if (kind === 'content-growth') bytes = Buffer.from('larger');
      if (kind === 'short-read') bytes = Buffer.from('g');
      if (kind === 'read-error') io.readSync.mockImplementation(() => { throw new Error('private read error'); });
      if (kind === 'ancestor-replacement' || kind === 'leaf-replacement') {
        const normal = io.readSync.getMockImplementation()!;
        io.readSync.mockImplementation((...args) => {
          const result = normal(...args); files.get(kind === 'leaf-replacement' ? first : dirname(first))!.ino++;
          return result;
        });
      }
      expect(() => resolvePreparationGit()).toThrow('Preparation Git unavailable or changed');
      expect(io.closeSync).toHaveBeenCalledExactlyOnceWith(9);
    });
  it('rechecks pinned bytes and rejects changed selection', () => {
    const pin = resolvePreparationGit(); expect(() => assertPreparationGit(pin)).not.toThrow();
    bytes = Buffer.from('new'); expect(() => assertPreparationGit(pin)).toThrow();
    bytes = Buffer.from('git'); files.delete(first); expect(() => assertPreparationGit(pin)).toThrow();
  });
  it('rejects a formerly selected second location when the first appears', () => {
    files.delete(first); const pin = resolvePreparationGit(); add(first);
    expect(() => assertPreparationGit(pin)).toThrow();
  });
  it('refuses a preferred installation appearing during fallback inspection', () => {
    files.delete(first); const normal = io.readSync.getMockImplementation()!;
    io.readSync.mockImplementation((...args) => { const result = normal(...args); add(first); return result; });
    expect(() => resolvePreparationGit()).toThrow('Preparation Git unavailable or changed');
  });
  it('does not invoke pin accessors', () => {
    const get = vi.fn(() => first); expect(() => assertPreparationGit({ get path() { return get(); }, digest: 'a'.repeat(64) })).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it('does not invoke proxy reflection traps', () => {
    const trap = vi.fn(() => Object.prototype);
    expect(() => assertPreparationGit(new Proxy({}, { getPrototypeOf: trap }))).toThrow();
    expect(trap).not.toHaveBeenCalled(); expect(io.openSync).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { path: '/usr/bin/git', digest: 'a'.repeat(64) },
    { path: first, digest: 'x' }, { path: first, digest: 'a'.repeat(64), extra: true }])('refuses malformed or nonclosed pin %#', pin => {
    expect(() => assertPreparationGit(pin)).toThrow(); expect(io.openSync).not.toHaveBeenCalled();
  });
});
