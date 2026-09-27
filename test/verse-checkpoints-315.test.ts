/**
 * 3.15 workbench — per-turn checkpoints (src/core/verse/checkpoints.ts) on
 * REAL temp repositories: snapshots of modified/untracked/deleted/renamed/
 * binary files, restores, hunk reverts, three-way previews, bounded size —
 * and, after every operation, proof that the operator's index, stash list,
 * branches and HEAD are byte-for-byte what they were.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CheckpointError,
  checkpointRefName,
  deleteCheckpointRefs,
  diffCheckpoints,
  hunkHash,
  listCheckpointRefs,
  mergeThreeWay,
  parsePatchHunks,
  patchBetween,
  readCheckpointManifest,
  refSegment,
  rejectHunkOnDisk,
  revertHunk,
  rootIdFor,
  setCheckpointRef,
  snapshotWorkingTree,
  writePathsFromCheckpoint,
} from '../src/core/verse/checkpoints.js';

/** Fixture setup uses plain git on purpose: the TEST builds the world, checkpoints operate on it. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

/** Everything the operator owns in .git that checkpoints must never change. */
function operatorState(repo: string): string {
  const index = join(repo, '.git', 'index');
  return JSON.stringify({
    index: existsSync(index) ? readFileSync(index).toString('base64') : null,
    head: readFileSync(join(repo, '.git', 'HEAD'), 'utf8'),
    heads: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes'),
    stash: git(repo, 'stash', 'list'),
    stashRef: git(repo, 'for-each-ref', 'refs/stash'),
    staged: git(repo, 'diff', '--cached', '--name-status'),
  });
}

let root: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'verse-ck-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  writeFileSync(join(repo, 'keep.txt'), 'keep\n');
  writeFileSync(join(repo, 'gone.txt'), 'will be deleted\n');
  writeFileSync(join(repo, 'old-name.txt'), 'rename me please\nline two\nline three\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n*.log\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (p: string) => readFileSync(join(repo, p), 'utf8');

describe('snapshotWorkingTree', () => {
  it('captures modified, staged, untracked, deleted files and skips ignored ones — without touching index, stash, branches or HEAD', async () => {
    writeFileSync(join(repo, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
    writeFileSync(join(repo, 'keep.txt'), 'staged change\n');
    git(repo, 'add', 'keep.txt');
    writeFileSync(join(repo, 'keep.txt'), 'unstaged on top\n');
    rmSync(join(repo, 'gone.txt'));
    mkdirSync(join(repo, 'new', 'deep'), { recursive: true });
    writeFileSync(join(repo, 'new', 'deep', 'n.txt'), 'untracked\n');
    mkdirSync(join(repo, 'ignored'));
    writeFileSync(join(repo, 'ignored', 'secret.txt'), 'never captured\n');
    writeFileSync(join(repo, 'debug.log'), 'ignored too\n');
    git(repo, 'stash', 'list');
    const before = operatorState(repo);

    const snap = await snapshotWorkingTree(repo);
    expect(snap.skipped).toEqual([]);
    expect(operatorState(repo)).toBe(before);

    const files = git(repo, 'ls-tree', '-r', '--name-only', snap.commit).trim().split('\n').sort();
    expect(files).toEqual(['.gitignore', 'a.txt', 'keep.txt', 'new/deep/n.txt', 'old-name.txt']);
    expect(git(repo, 'show', `${snap.commit}:keep.txt`)).toBe('unstaged on top\n');
    expect(git(repo, 'show', `${snap.commit}:a.txt`).startsWith('ONE\n')).toBe(true);
    // Parent is HEAD; the commit is unreferenced until a ref is set.
    expect(git(repo, 'rev-parse', `${snap.commit}^`).trim()).toBe(git(repo, 'rev-parse', 'HEAD').trim());
    expect(git(repo, 'for-each-ref', 'refs/ashlr')).toBe('');
  });

  it('works on an unborn branch (no HEAD yet)', async () => {
    const fresh = join(root, 'fresh');
    mkdirSync(fresh);
    git(fresh, 'init', '-q');
    writeFileSync(join(fresh, 'x.txt'), 'x\n');
    const snap = await snapshotWorkingTree(fresh);
    expect(snap.head).toBeNull();
    expect(git(fresh, 'show', `${snap.commit}:x.txt`)).toBe('x\n');
    expect(existsSync(join(fresh, '.git', 'index'))).toBe(false);
  });

  it('bounds size: a file over the per-file cap is skipped and named in the manifest', async () => {
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(4096, 7));
    writeFileSync(join(repo, 'small.txt'), 'small\n');
    const snap = await snapshotWorkingTree(repo, { maxFileBytes: 1024 });
    expect(snap.skipped).toEqual([{ path: 'big.bin', reason: 'too-large' }]);
    const manifest = await readCheckpointManifest(repo, snap.commit);
    expect(manifest?.skipped).toEqual([{ path: 'big.bin', reason: 'too-large' }]);
    expect(git(repo, 'ls-tree', '-r', '--name-only', snap.commit)).not.toContain('big.bin');
  });

  it('refuses outright past the changed-path cap', async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    await expect(snapshotWorkingTree(repo, { maxChangedPaths: 3 })).rejects.toBeInstanceOf(CheckpointError);
  });

  it('is not a repository → unavailable', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    await expect(snapshotWorkingTree(plain)).rejects.toMatchObject({ code: 'VERSE_CHECKPOINT_UNAVAILABLE' });
  });
});

describe('hidden refs', () => {
  it('lives under refs/ashlr/checkpoints only, and never in the branch list', async () => {
    const snap = await snapshotWorkingTree(repo);
    const ref = checkpointRefName('chat_1', 'turn-1', rootIdFor(repo), 'pre');
    expect(ref).toBe(`refs/ashlr/checkpoints/chat_1/turn-1/${rootIdFor(repo)}/pre`);
    const before = operatorState(repo);
    await setCheckpointRef(repo, ref, snap.commit);
    expect(operatorState(repo)).toBe(before);
    expect(git(repo, 'branch', '--list')).toBe('* main\n');
    const refs = await listCheckpointRefs(repo, 'refs/ashlr/checkpoints/chat_1');
    expect([...refs.values()]).toEqual([snap.commit]);
    expect(await deleteCheckpointRefs(repo, 'refs/ashlr/checkpoints/chat_1')).toBe(1);
    expect(git(repo, 'for-each-ref', 'refs/ashlr')).toBe('');
  });

  it('sanitizes odd ids into safe ref segments', () => {
    expect(refSegment('abc-123_X')).toBe('abc-123_X');
    expect(refSegment('../../heads/main')).toMatch(/^h[0-9a-f]{40}$/);
    expect(refSegment('a b')).toMatch(/^h[0-9a-f]{40}$/);
    expect(() => checkpointRefName('x', 'y', 'z', 'pre')).not.toThrow();
  });
});

describe('restore (writePathsFromCheckpoint)', () => {
  it('restores modified, deleted, renamed, binary, executable and symlinked files; removes files the checkpoint lacks', async () => {
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 0, 9]));
    writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(repo, 'run.sh'), 0o755);
    symlinkSync('keep.txt', join(repo, 'link'));
    const pre = await snapshotWorkingTree(repo);
    const before = operatorState(repo);

    // The "agent": edit, delete, rename, rewrite binary, drop exec bit, retarget link, add files.
    writeFileSync(join(repo, 'a.txt'), 'rewritten\n');
    rmSync(join(repo, 'gone.txt'));
    git(repo, 'mv', 'old-name.txt', 'new-name.txt');
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([9, 9, 9]));
    chmodSync(join(repo, 'run.sh'), 0o644);
    rmSync(join(repo, 'link'));
    symlinkSync('a.txt', join(repo, 'link'));
    mkdirSync(join(repo, 'made', 'here'), { recursive: true });
    writeFileSync(join(repo, 'made', 'here', 'new.txt'), 'agent file\n');
    const post = await snapshotWorkingTree(repo);

    const changes = await diffCheckpoints(repo, pre.commit, post.commit);
    const byPath = new Map(changes.map((c) => [c.path, c]));
    expect(byPath.get('new-name.txt')).toMatchObject({ status: 'R', oldPath: 'old-name.txt' });
    expect(byPath.get('gone.txt')).toMatchObject({ status: 'D' });
    expect(byPath.get('made/here/new.txt')).toMatchObject({ status: 'A' });
    expect(byPath.get('bin.dat')).toMatchObject({ binary: true });

    const stagedAfterAgent = operatorState(repo);
    const paths = ['a.txt', 'gone.txt', 'old-name.txt', 'new-name.txt', 'bin.dat', 'run.sh', 'link', 'made/here/new.txt'];
    const out = await writePathsFromCheckpoint(repo, pre.commit, paths);
    expect(out.deleted.sort()).toEqual(['made/here/new.txt', 'new-name.txt']);
    expect(read('a.txt')).toBe('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
    expect(read('gone.txt')).toBe('will be deleted\n');
    expect(read('old-name.txt')).toBe('rename me please\nline two\nline three\n');
    expect(existsSync(join(repo, 'new-name.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'bin.dat'))).toEqual(Buffer.from([0, 1, 2, 3, 255, 0, 9]));
    expect(lstatSync(join(repo, 'run.sh')).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(repo, 'link'))).toBe('keep.txt');
    // Emptied directories the agent created are pruned.
    expect(existsSync(join(repo, 'made'))).toBe(false);
    // The index is exactly as the agent's `git mv` left it: restore never touches it.
    expect(operatorState(repo)).toBe(stagedAfterAgent);
    expect(before).not.toBe(stagedAfterAgent);
  });

  it('never deletes a directory, and refuses paths outside the repo or inside .git', async () => {
    const pre = await snapshotWorkingTree(repo);
    mkdirSync(join(repo, 'dir'));
    writeFileSync(join(repo, 'dir', 'user.txt'), 'mine\n');
    const out = await writePathsFromCheckpoint(repo, pre.commit, ['dir']);
    expect(out.leftAlone).toEqual(['dir']);
    expect(read('dir/user.txt')).toBe('mine\n');
    await expect(writePathsFromCheckpoint(repo, pre.commit, ['../escape.txt'])).rejects.toMatchObject({ code: 'VERSE_INVALID' });
    await expect(writePathsFromCheckpoint(repo, pre.commit, ['.git/config'])).rejects.toMatchObject({ code: 'VERSE_INVALID' });
  });

  it('refuses to write through a symlinked directory that leaves the repository', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'victim.txt'), 'outside\n');
    const pre = await snapshotWorkingTree(repo);
    symlinkSync(outside, join(repo, 'escape'));
    await expect(writePathsFromCheckpoint(repo, pre.commit, ['escape/victim.txt'])).rejects.toMatchObject({ code: 'VERSE_INVALID' });
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('outside\n');
  });
});

describe('hunks', () => {
  const patch = [
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,3 +1,3 @@',
    ' a',
    '-b',
    '+B',
    ' c',
    '@@ -8,2 +8,3 @@ fn ctx',
    ' h',
    ' i',
    '+j',
    '',
  ].join('\n');

  it('parses hunks with stable content hashes', () => {
    const hunks = parsePatchHunks(patch);
    expect(hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([[1, 3, 1, 3], [8, 2, 8, 3]]);
    expect(hunks[1]!.hash).toBe(hunkHash('@@ -8,2 +8,3 @@', [' h', ' i', '+j']));
    expect(new Set(hunks.map((h) => h.hash)).size).toBe(2);
  });

  it('reverts exactly one hunk, and refuses when the file moved on', () => {
    const current = 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n';
    const [h1, h2] = parsePatchHunks(patch);
    expect(revertHunk(current, h1!)).toBe('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n');
    expect(revertHunk(current, h2!)).toBe('a\nB\nc\nd\ne\nf\ng\nh\ni\n');
    expect(revertHunk('a\nX\nc\n', h1!)).toBeNull();
  });

  it('handles "No newline at end of file"', () => {
    const p = ['@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b', ''].join('\n');
    const [h] = parsePatchHunks(p);
    expect(revertHunk('a\nb\n', h!)).toBe('a\nb');
  });

  it('rejects one hunk on disk against a real checkpoint', async () => {
    const pre = await snapshotWorkingTree(repo);
    writeFileSync(join(repo, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n');
    const now = await snapshotWorkingTree(repo);
    const p = await patchBetween(repo, pre.commit, now.commit, 'a.txt', null);
    const hunks = parsePatchHunks(p.raw);
    expect(hunks).toHaveLength(2);
    const before = operatorState(repo);
    await rejectHunkOnDisk({ gitRoot: repo, base: pre.commit, now: now.commit, path: 'a.txt', oldPath: null, hash: hunks[1]!.hash });
    expect(read('a.txt')).toBe('ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
    expect(operatorState(repo)).toBe(before);
    // The same hunk again is stale, never misapplied.
    const again = await snapshotWorkingTree(repo);
    await expect(rejectHunkOnDisk({ gitRoot: repo, base: pre.commit, now: again.commit, path: 'a.txt', oldPath: null, hash: hunks[1]!.hash }))
      .rejects.toMatchObject({ code: 'VERSE_CHECKPOINT_STALE' });
  });
});

describe('three-way merge preview', () => {
  it('merges cleanly when the later edit and the agent edit do not overlap', async () => {
    const pre = Buffer.from('1\n2\n3\n4\n5\n6\n7\n8\n');
    const agent = Buffer.from('1\nAGENT\n3\n4\n5\n6\n7\n8\n');
    const user = Buffer.from('1\nAGENT\n3\n4\n5\n6\n7\nUSER\n');
    const m = await mergeThreeWay(user, agent, pre);
    expect(m).toMatchObject({ clean: true, conflicts: 0 });
    expect(m.text).toBe('1\n2\n3\n4\n5\n6\n7\nUSER\n');
  });

  it('reports conflicts with markers when they overlap, and refuses binary', async () => {
    const m = await mergeThreeWay(Buffer.from('a\nUSER\nc\n'), Buffer.from('a\nAGENT\nc\n'), Buffer.from('a\nb\nc\n'));
    expect(m.clean).toBe(false);
    expect(m.text).toContain('<<<<<<< on disk now');
    expect(m.text).toContain('>>>>>>> checkpoint');
    expect(await mergeThreeWay(Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.from([0, 3]))).toMatchObject({ clean: false, text: null });
  });
});
