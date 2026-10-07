import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveryGit } from '../src/core/universe/delivery-git.js';
import { canonical, digest, MAX_ARTIFACT_BYTES } from '../src/core/universe/artifacts.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const roots: string[] = [];
afterEach(() => { vi.mocked(spawnSync).mockRestore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function blobOid(data: Buffer, algorithm = 'sha1'): string {
  return createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest('hex');
}
function result(stdout: Buffer): ReturnType<typeof spawnSync> {
  return { pid: 1, output: [null, stdout, Buffer.alloc(0)], stdout, stderr: Buffer.alloc(0), status: 0, signal: null };
}
function fixture(format: 'sha1' | 'sha256' = 'sha1') {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'universe-git-write-'))); roots.push(repo);
  const git = (args: string[], input?: string) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    encoding: 'utf8', input, timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q', `--object-format=${format}`]);
  for (const [path, text] of [['keep', 'seed\n'], ['duplicate', 'seed\n'], ['edit', 'before\n'], ['remove', 'gone\n'], ['mode', '#!/bin/sh\nexit 0\n']]) {
    writeFileSync(join(repo, path!), text!);
  }
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed']);
  const helper = deliveryGit(repo);
  const snapshot = helper.readEntries(helper.entries(git(['rev-parse', 'HEAD'])));
  return { repo, git, helper, snapshot };
}
function writes(): unknown[][] {
  return vi.mocked(spawnSync).mock.calls.filter((call) => call[1]?.includes('hash-object') && call[1].includes('-w'));
}

describe('Universe delivery verified blob reuse', () => {
  it.each(['sha1', 'sha256'] as const)('reuses existing %s objects and writes only distinct edits while preserving the dirty checkout and refs', (format) => {
    const f = fixture(format);
    const bytes = Buffer.from([0, 255, 10, 128]);
    const snapshot = f.snapshot.filter((entry) => !['remove', 'keep'].includes(entry.path)).map((entry) => ({ ...entry,
      data: entry.path === 'edit' ? Buffer.from('after\n') : entry.data, executable: entry.path === 'mode' }));
    snapshot.push({ path: 'moved', data: Buffer.from('seed\n'), executable: false },
      { path: 'binary', data: bytes, executable: false }, { path: 'nested/copy', data: Buffer.from(bytes), executable: true });
    writeFileSync(join(f.repo, 'edit'), 'staged\n'); f.git(['add', 'edit']); writeFileSync(join(f.repo, 'edit'), 'unstaged\n');
    const index = readFileSync(join(f.repo, '.git', 'index')); const refs = f.git(['show-ref']);
    vi.mocked(spawnSync).mockClear();
    const tree = f.helper.writeTree(snapshot);
    expect(writes()).toHaveLength(2);
    for (const call of writes()) expect(call[1]).toEqual(expect.arrayContaining(['--stdin', '--no-filters']));
    const stored = f.helper.readEntries(f.helper.entries(tree));
    expect(stored.map((entry) => entry.path).sort()).toEqual(snapshot.map((entry) => entry.path).sort());
    for (const entry of snapshot) expect(stored.find((item) => item.path === entry.path)).toEqual(entry);
    expect(f.helper.treeDigest(tree)).toBe(digest(canonical(snapshot.map(({ path, executable, data }) => ({
      path, executable, size: data.length, digest: digest(data),
    })).sort((a, b) => a.path.localeCompare(b.path)))));
    expect(tree).toHaveLength(format === 'sha1' ? 40 : 64);
    expect(f.git(['show-ref'])).toBe(refs); expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'edit'), 'utf8')).toBe('unstaged\n');
  });

  it('verifies an unchanged tree without writing any blob', () => {
    const f = fixture(); vi.mocked(spawnSync).mockClear();
    expect(f.helper.writeTree(f.snapshot)).toBe(f.git(['rev-parse', 'HEAD^{tree}']));
    expect(writes()).toHaveLength(0);
    expect(vi.mocked(spawnSync).mock.calls.filter((call) => call[1]?.includes('--batch'))).toHaveLength(1);
  });

  it.each(['wrong-oid', 'wrong-type', 'wrong-size', 'duplicate-row', 'missing-newline', 'extra-row'])(
    'rejects malformed batch-check %s before object writes or branch changes', async (kind) => {
      const f = fixture(); const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const unique = [...new Map(f.snapshot.map((entry) => [blobOid(entry.data), entry])).entries()];
      const rows = unique.map(([oid, entry]) => `${oid} blob ${entry.data.length}`);
      const bad = [...rows];
      if (kind === 'wrong-oid') bad[0] = `${'a'.repeat(40)} blob ${unique[0]![1].data.length}`;
      if (kind === 'wrong-type') bad[0] = bad[0]!.replace(' blob ', ' tree ');
      if (kind === 'wrong-size') bad[0] = `${unique[0]![0]} blob 999999999999999999999`;
      if (kind === 'duplicate-row') bad[0] = bad[1]!;
      if (kind === 'extra-row') bad.push(bad[0]!);
      const output = Buffer.from(bad.join('\n') + (kind === 'missing-newline' ? '' : '\n'));
      const refs = f.git(['show-ref']); vi.mocked(spawnSync).mockClear();
      vi.mocked(spawnSync).mockImplementation((...args) => args[1]?.some((arg) => arg.startsWith('--batch-check='))
        ? result(output) : real.spawnSync(...args));
      expect(() => f.helper.writeTree(f.snapshot)).toThrow(/batch check/);
      expect(writes()).toHaveLength(0); expect(f.git(['show-ref'])).toBe(refs);
    });

  it('refuses substituted existing blob bytes before writing new content', async () => {
    const f = fixture(); const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const snapshot = [...f.snapshot, { path: 'new', data: Buffer.from('new\n'), executable: false }];
    const refs = f.git(['show-ref']); vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockImplementation((...args) => args[1]?.includes('--batch')
      ? result(Buffer.from(`${blobOid(f.snapshot[0]!.data)} blob ${f.snapshot[0]!.data.length}\n${'x'.repeat(f.snapshot[0]!.data.length)}\n`))
      : real.spawnSync(...args));
    expect(() => f.helper.writeTree(snapshot)).toThrow(/identity|incomplete/);
    expect(writes()).toHaveLength(0); expect(f.git(['show-ref'])).toBe(refs);
  });

  it('requires the exact locally derived OID from every missing-object write', async () => {
    const f = fixture(); const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const refs = f.git(['show-ref']);
    vi.mocked(spawnSync).mockImplementation((...args) => args[1]?.includes('hash-object') && args[1].includes('-w')
      ? result(Buffer.from('a'.repeat(40) + '\n')) : real.spawnSync(...args));
    expect(() => f.helper.writeTree([{ path: 'new', data: Buffer.from('new\n'), executable: false }])).toThrow(/written blob identity/);
    expect(f.git(['show-ref'])).toBe(refs);
  });

  it('rejects an inconsistent empty-object format probe without writing objects', async () => {
    const f = fixture(); vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValue(result(Buffer.from('a'.repeat(64) + '\n')));
    expect(() => f.helper.writeTree(f.snapshot)).toThrow(/object format/);
    expect(writes()).toHaveLength(0);
  });

  it('counts duplicate destination bytes and entry limits before invoking Git', () => {
    const f = fixture(); const data = Buffer.alloc(MAX_ARTIFACT_BYTES / 2 + 1);
    vi.mocked(spawnSync).mockClear();
    expect(() => f.helper.writeTree([{ path: 'a', data, executable: false }, { path: 'b', data, executable: false }])).toThrow(/byte envelope/);
    expect(() => f.helper.writeTree(Array.from({ length: 8193 }, (_, index) => ({ path: `file-${index}`, data: Buffer.alloc(0), executable: false })))).toThrow(/entry limit/);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
