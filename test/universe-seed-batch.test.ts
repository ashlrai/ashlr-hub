import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, canonical, digest, materializeSeed, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_ENTRIES } from '../src/core/universe/artifacts.js';
import { parseGitBlobBatch } from '../src/core/universe/git-blob-batch.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
const roots: string[] = [];
afterEach(() => {
  vi.mocked(execFileSync).mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'universe-seed-batch-')));
  roots.push(value); return value;
}
function oid(data: Buffer, algorithm = 'sha1') {
  return createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest('hex');
}
function frame(data: Buffer, id = oid(data)) {
  return Buffer.concat([Buffer.from(`${id} blob ${data.length}\n`), data, Buffer.from('\n')]);
}
function inventory(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? readdirSync(path).sort().map(name => [name, inventory(join(path, name))])
    : [stat.mode, digest(readFileSync(path))];
}

describe('seed batch materialization', () => {
  it.each(['sha1', 'sha256'])('materializes 128 %s files with two Git calls, exact bytes/modes and unchanged dirty source', (format) => {
    const base = root(); const repo = join(base, 'repo'); mkdirSync(repo);
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
    git(['init', '-q', `--object-format=${format}`]);
    const expected = Array.from({ length: 128 }, (_, index) => ({
      path: index === 0 ? 'space and\ttab.bin' : `file-${index}`,
      data: index === 0 ? Buffer.from([0, 255, 10, 128, 13, 10]) : Buffer.from(index % 2 ? 'duplicate\n' : `value-${index}\n`),
      executable: index === 1,
    }));
    for (const entry of expected) {
      writeFileSync(join(repo, entry.path), entry.data); chmodSync(join(repo, entry.path), entry.executable ? 0o700 : 0o600);
    }
    git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed']);
    const revision = git(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'file-2'), 'staged'); git(['add', 'file-2']);
    writeFileSync(join(repo, 'file-2'), 'unstaged');
    const before = inventory(repo); const output = join(base, 'seed');
    vi.mocked(execFileSync).mockClear();
    const result = materializeSeed({ repo, revision }, output);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]![1]).toEqual(expect.arrayContaining(['ls-tree', '-rz', '--full-tree', revision]));
    expect(calls[1]![1]).toEqual(expect.arrayContaining(['cat-file', '--batch']));
    expect(calls[1]![2]).toMatchObject({ timeout: 30_000, maxBuffer: MAX_ARTIFACT_BYTES + 4 * 1024 * 1024 });
    const input = calls[1]![2]!.input as string;
    expect(input.trim().split('\n')).toHaveLength(128);
    expect(input).not.toContain('file-');
    for (const entry of expected) {
      const target = join(output, entry.path);
      expect(readFileSync(target)).toEqual(entry.data);
      expect(lstatSync(target).mode & 0o777).toBe(entry.executable ? 0o700 : 0o600);
      expect(lstatSync(target).nlink).toBe(1);
    }
    expect(result).toBe(digest(canonical(expected.map(entry => ({ path: entry.path, executable: entry.executable,
      size: entry.data.length, digest: digest(entry.data) })).sort((a, b) => a.path.localeCompare(b.path)))));
    expect(result).toBe(artifactDigest(output)); expect(inventory(repo)).toEqual(before);
    expect(() => materializeSeed({ repo, revision }, output)).toThrow();
    expect(artifactDigest(output)).toBe(result);
  });

  it('keeps the empty tree contract without starting an empty batch', () => {
    const output = join(root(), 'seed'); vi.mocked(execFileSync).mockReturnValue(Buffer.alloc(0));
    expect(materializeSeed({ repo: '/unused', revision: 'a'.repeat(40) }, output)).toBe(digest('[]'));
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it.each(['symlink', 'submodule', 'newline', 'metadata', 'too-many'])('retains seed tree refusal: %s', (kind) => {
    const output = join(root(), 'seed'); const id = 'a'.repeat(40);
    const tree = { symlink: `120000 blob ${id}\tlink\0`, submodule: `160000 commit ${id}\tmodule\0`,
      newline: `100644 blob ${id}\tline\nbreak\0`, metadata: `100644 blob ${id}\t.git/config\0`,
      'too-many': Array.from({ length: MAX_ARTIFACT_ENTRIES + 1 }, (_, i) => `100644 blob ${id}\tf-${i}\0`).join('') }[kind]!;
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(tree));
    expect(() => materializeSeed({ repo: '/unused', revision: id }, output)).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(1); expect(existsSync(output)).toBe(false);
  });

  it('validates the entire batch before creating seed files', () => {
    const output = join(root(), 'seed'); const data = Buffer.from('valid'); const id = oid(data);
    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(`100644 blob ${id}\ta\0` + `100644 blob ${id}\tb\0`))
      .mockReturnValueOnce(Buffer.concat([frame(data), Buffer.from(`${id} blob ${MAX_ARTIFACT_BYTES + 1}\n`)]));
    expect(() => materializeSeed({ repo: '/unused', revision: id }, output)).toThrow();
    expect(existsSync(output)).toBe(false);
  });

  it.each(['timeout', 'nonzero-exit', 'output-limit'])('does not materialize failed Git output: %s', (reason) => {
    const output = join(root(), 'seed'); const id = 'a'.repeat(40);
    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(`100644 blob ${id}\ta\0`))
      .mockImplementationOnce(() => { throw new Error(reason); });
    expect(() => materializeSeed({ repo: '/unused', revision: id }, output)).toThrow(reason);
    expect(existsSync(output)).toBe(false);
  });
});

describe('shared raw Git blob batch parser', () => {
  it.each(['wrong-id', 'type', 'leading-zero', 'unsafe-size', 'short-body', 'delimiter', 'missing-row', 'trailing', 'changed-content', 'order'])(
    'refuses malformed or substituted evidence: %s', (kind) => {
      const data = Buffer.from([0, 10, 255]); const id = oid(data); const valid = frame(data);
      const invalid = { 'wrong-id': frame(data, 'a'.repeat(40)), type: Buffer.from(`${id} tree 3\nabc\n`),
        'leading-zero': Buffer.from(`${id} blob 03\nabc\n`), 'unsafe-size': Buffer.from(`${id} blob 9007199254740992\n`),
        'short-body': valid.subarray(0, valid.length - 2), delimiter: Buffer.concat([valid.subarray(0, -1), Buffer.from('!')]),
        'missing-row': Buffer.alloc(0), trailing: Buffer.concat([valid, Buffer.from('\n')]),
        'changed-content': Buffer.from(`${id} blob 3\nabc\n`), order: frame(Buffer.from('different')) }[kind]!;
      expect(() => parseGitBlobBatch(invalid, [id], 100)).toThrow();
    });
  it('counts duplicate destinations, accepts the exact cap, and preserves binary framing and empty blobs', () => {
    const data = Buffer.from([0, 10, 255]); const empty = Buffer.alloc(0);
    const frames = Buffer.concat([frame(data), frame(empty), frame(data)]); const ids = [oid(data), oid(empty), oid(data)];
    expect(parseGitBlobBatch(frames, ids, 6)).toEqual([data, empty, data]);
    expect(() => parseGitBlobBatch(frames, ids, 5)).toThrow(/byte envelope/);
    expect(() => parseGitBlobBatch(Buffer.alloc(0), [], -1)).toThrow();
    expect(() => parseGitBlobBatch(frame(data), ['a'.repeat(41)], 6)).toThrow(/identity/);
  });
});
