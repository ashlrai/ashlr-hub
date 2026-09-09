import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveryGit, type GitTreeEntry } from '../src/core/universe/delivery-git.js';
import { canonical, digest, MAX_ARTIFACT_BYTES } from '../src/core/universe/artifacts.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const roots: string[] = [];
afterEach(() => {
  vi.mocked(spawnSync).mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function blobOid(data: Buffer, algorithm = 'sha1'): string {
  return createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest('hex');
}
function batch(data: Buffer, oid = blobOid(data)): Buffer {
  return Buffer.concat([Buffer.from(`${oid} blob ${data.length}\n`), data, Buffer.from('\n')]);
}
function result(stdout: Buffer): ReturnType<typeof spawnSync> {
  return { pid: 1, output: [null, stdout, Buffer.alloc(0)], stdout, stderr: Buffer.alloc(0), status: 0, signal: null };
}
function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'universe-git-entries-')));
  roots.push(repo);
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'same\n');
  writeFileSync(join(repo, 'b.txt'), 'same\n');
  mkdirSync(join(repo, 'nested'));
  writeFileSync(join(repo, 'nested', 'script'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(repo, 'nested', 'script'), 0o700);
  writeFileSync(join(repo, 'binary'), Buffer.from([0, 255, 10, 128]));
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed']);
  return { repo, git, helper: deliveryGit(repo) };
}
function inventory(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? readdirSync(path).sort().map((name) => [name, inventory(join(path, name))])
    : [stat.mode, readFileSync(path).toString('base64')];
}

describe('Universe delivery Git entry reads', () => {
  it('reads binary bytes and modes in caller order through one batch without changing Git or the dirty checkout', () => {
    const f = fixture();
    const entries = f.helper.entries(f.git(['rev-parse', 'HEAD'])).reverse();
    writeFileSync(join(f.repo, 'a.txt'), 'staged\n'); f.git(['add', 'a.txt']);
    writeFileSync(join(f.repo, 'a.txt'), 'unstaged\n');
    const before = inventory(f.repo);
    vi.mocked(spawnSync).mockClear();
    const snapshots = f.helper.readEntries(entries);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnSync).mock.calls[0]![1]).toEqual(expect.arrayContaining(['cat-file', '--batch']));
    expect(snapshots.map(({ path }) => path)).toEqual(entries.map(({ path }) => path));
    expect(snapshots.find(({ path }) => path === 'binary')!.data).toEqual(Buffer.from([0, 255, 10, 128]));
    expect(snapshots.find(({ path }) => path === 'nested/script')!.executable).toBe(true);
    const first = snapshots.find(({ path }) => path === 'a.txt')!;
    const second = snapshots.find(({ path }) => path === 'b.txt')!;
    expect(first.data.toString()).toBe('same\n');
    first.data.fill(0);
    expect(second.data.toString()).toBe('same\n');
    expect(inventory(f.repo)).toEqual(before);
  });

  it('preserves the established tree digest while sharing the batch parser', () => {
    const f = fixture(); const tree = f.git(['rev-parse', 'HEAD']);
    const snapshots = f.helper.readEntries(f.helper.entries(tree));
    const expected = digest(canonical(snapshots.map(({ path, executable, data }) => ({
      path, executable, size: data.length, digest: digest(data),
    })).sort((a, b) => a.path.localeCompare(b.path))));
    expect(f.helper.treeDigest(tree)).toBe(expected);
  });

  it('returns an empty snapshot without invoking Git', () => {
    const f = fixture(); vi.mocked(spawnSync).mockClear();
    expect(f.helper.readEntries([])).toEqual([]);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    '../escape', '/absolute', 'back\\slash', '.GIT/config', '.ashlr/state', 'con.txt', 'trailing.',
    'bad\nname', 'bad\u0085name', 'cafe\u0301.txt', `${'a/'.repeat(32)}file`,
  ])('rejects unsupported path %j before reading blobs', (path) => {
    const f = fixture(); vi.mocked(spawnSync).mockClear();
    expect(() => f.helper.readEntries([{ path, oid: 'a'.repeat(40), executable: false }])).toThrow();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    ['file', 'file'], ['file', 'file/child'], ['Foo', 'foo/child'], ['Dir/a', 'dir/b'],
  ])('rejects duplicate and colliding paths %j before reading blobs', (...paths) => {
    const f = fixture(); vi.mocked(spawnSync).mockClear();
    expect(() => f.helper.readEntries(paths.map((path) => ({ path, oid: 'a'.repeat(40), executable: false })))).toThrow();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('rejects malformed entry data, sparse arrays, accessors and excess entries without invoking them', () => {
    const f = fixture(); const entry = { path: 'file', oid: 'a'.repeat(40), executable: false };
    const getter = vi.fn(() => 'file');
    const accessor = { ...entry }; Object.defineProperty(accessor, 'path', { get: getter });
    const inputs = [[{ ...entry, executable: 1 }], [{ ...entry, oid: 'HEAD' }], [accessor],
      Array(1), Array.from({ length: 8_193 }, (_, index) => ({ ...entry, path: `file-${index}` }))];
    vi.mocked(spawnSync).mockClear();
    for (const input of inputs) expect(() => f.helper.readEntries(input as GitTreeEntry[])).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each(['wrong-oid', 'wrong-type', 'invalid-size', 'short-body', 'missing-newline', 'extra-row', 'missing-row', 'changed-bytes'])(
    'rejects malformed or substituted batch evidence: %s', (failure) => {
    const f = fixture(); const data = Buffer.from('ok'); const oid = blobOid(data);
    const valid = batch(data);
    const invalid = {
      'wrong-oid': batch(data, 'a'.repeat(40)),
      'wrong-type': Buffer.from(`${oid} tree 2\nok\n`),
      'invalid-size': Buffer.from(`${oid} blob 02\nok\n`),
      'short-body': Buffer.from(`${oid} blob 3\nok\n`),
      'missing-newline': valid.subarray(0, valid.length - 1),
      'extra-row': Buffer.concat([valid, valid]),
      'missing-row': Buffer.alloc(0),
      'changed-bytes': Buffer.from(`${oid} blob 2\nno\n`),
    }[failure]!;
    vi.mocked(spawnSync).mockReturnValue(result(invalid));
    expect(() => f.helper.readEntries([{ path: 'file', oid, executable: false }])).toThrow();
    });

  it('checks batch order and SHA256 object identities', () => {
    const f = fixture(); const a = Buffer.from('first'); const b = Buffer.from('second');
    const entries = [{ path: 'a', oid: blobOid(a), executable: false }, { path: 'b', oid: blobOid(b), executable: false }];
    vi.mocked(spawnSync).mockReturnValue(result(Buffer.concat([batch(b), batch(a)])));
    expect(() => f.helper.readEntries(entries)).toThrow(/identity/);
    const oid = blobOid(a, 'sha256');
    vi.mocked(spawnSync).mockReturnValue(result(batch(a, oid)));
    expect(f.helper.readEntries([{ path: 'sha256', oid, executable: false }])[0]!.data).toEqual(a);
  });

  it('counts duplicate blob bytes against the combined 64 MiB envelope', () => {
    const f = fixture(); const data = Buffer.alloc(MAX_ARTIFACT_BYTES / 2 + 1, 1); const oid = blobOid(data);
    const row = batch(data);
    vi.mocked(spawnSync).mockReturnValue(result(Buffer.concat([row, row])));
    expect(() => f.helper.readEntries([{ path: 'a', oid, executable: false }, { path: 'b', oid, executable: false }]))
      .toThrow(/byte envelope/);
  });
});
