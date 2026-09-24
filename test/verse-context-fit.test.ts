/**
 * test/verse-context-fit.test.ts — how big the reachable code is, in tokens
 * (GET /api/verse/context-fit). Zero spend: git + stat only.
 *
 * Defended here:
 *  1. WHAT COUNTS. Tracked text files only (git ls-files); binaries, >1 MB
 *     files, symlinks and untracked files are skipped; a non-git folder falls
 *     back to a bounded walk that skips node_modules & co.
 *  2. HONESTY. `estimator: 'bytes/4'`; `truncated` whenever a file or time cap
 *     trips (the figure is then a floor); `sampledAt` is the time the numbers
 *     were MEASURED, even when served from cache.
 *  3. CACHE. 60 s per root + HEAD sha: a new commit re-measures at once.
 *  4. VALIDATION. Absolute existing directories only, ≤ 8 roots.
 *  5. HARDENING. A repo-local fsmonitor hook never runs.
 *
 * Real git against tmp repos; HOME is relocated by test/setup/home.ts, so the
 * developer's global git config is not read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONTEXT_FIT_CACHE_TTL_MS,
  CONTEXT_FIT_MAX_FILE_BYTES,
  clearContextFitCache,
  estimateContextFit,
  gitArgs,
  isContextFitBinaryPath,
  isContextFitSkippedPath,
} from '../src/core/verse/context-fit.js';
import { VerseServiceError } from '../src/core/verse/preferences.js';

let tmp: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function makeRepo(name: string, files: Record<string, string | Buffer>): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init', '--allow-empty');
  return dir;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'verse-fit-')));
  clearContextFitCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearContextFitCache();
});

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VerseServiceError);
  expect((caught as VerseServiceError).code).toBe('VERSE_INVALID');
}

describe('counting', () => {
  it('counts tracked text files and estimates bytes/4', async () => {
    const repo = makeRepo('repo', {
      'src/a.ts': 'a'.repeat(1000),
      'src/b.ts': 'b'.repeat(2001),
      'README.md': 'r'.repeat(99),
      'logo.png': Buffer.alloc(5000, 1),        // binary extension
      'fonts/x.woff2': Buffer.alloc(5000, 1),   // binary extension
      'data/huge.json': 'x'.repeat(CONTEXT_FIT_MAX_FILE_BYTES + 1), // over 1 MB
      'package-lock.json': 'l'.repeat(9000),   // lockfile
      'crates/x/Cargo.lock': 'l'.repeat(9000), // lockfile, nested
    });
    symlinkSync('src/a.ts', join(repo, 'link.ts'));
    git(repo, 'add', 'link.ts');
    git(repo, 'commit', '-q', '-m', 'link');
    writeFileSync(join(repo, 'untracked.ts'), 'u'.repeat(50_000));

    const fit = await estimateContextFit([repo]);
    expect(fit.estimator).toBe('bytes/4');
    expect(fit.roots).toEqual([{ path: repo, files: 3, bytes: 3100, estTokens: 775, truncated: false }]);
    expect(fit.totalEstTokens).toBe(775);
    expect(Number.isNaN(Date.parse(fit.sampledAt))).toBe(false);
  });

  it('rounds tokens up', async () => {
    const repo = makeRepo('repo', { 'a.txt': 'abcde' });
    const fit = await estimateContextFit([repo]);
    expect(fit.roots[0]).toMatchObject({ files: 1, bytes: 5, estTokens: 2 });
  });

  it('skips a tracked file deleted from the working tree', async () => {
    const repo = makeRepo('repo', { 'keep.ts': 'k'.repeat(40), 'gone.ts': 'g'.repeat(400) });
    rmSync(join(repo, 'gone.ts'));
    const fit = await estimateContextFit([repo]);
    expect(fit.roots[0]).toMatchObject({ files: 1, bytes: 40 });
  });

  it('marks the root truncated when the file cap trips (the figure is a floor)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i += 1) files[`f${i}.ts`] = 'x'.repeat(10);
    const repo = makeRepo('repo', files);
    const fit = await estimateContextFit([repo], { maxFiles: 10 });
    expect(fit.roots[0]).toMatchObject({ files: 10, bytes: 100, truncated: true });
  });

  it('marks the root truncated when the time cap trips', async () => {
    const repo = makeRepo('repo', { 'a.ts': 'x' });
    const fit = await estimateContextFit([repo], { timeoutMs: 1 });
    expect(fit.roots[0].truncated).toBe(true);
  });

  it('walks a non-git folder, skipping heavy generated directories and symlinks', async () => {
    const dir = join(tmp, 'plain');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.py'), 'p'.repeat(400));
    writeFileSync(join(dir, 'notes.md'), 'n'.repeat(40));
    writeFileSync(join(dir, 'photo.jpg'), Buffer.alloc(1000));
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'd'.repeat(10_000));
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'b'.repeat(10_000));
    symlinkSync(join(dir, 'src'), join(dir, 'loop'));
    const fit = await estimateContextFit([dir]);
    expect(fit.roots[0]).toEqual({ path: dir, files: 2, bytes: 440, estTokens: 110, truncated: false });
  });

  it('sums several roots and de-duplicates spellings of the same root', async () => {
    const a = makeRepo('a', { 'x.ts': 'x'.repeat(400) });
    const b = makeRepo('b', { 'y.ts': 'y'.repeat(800) });
    const alias = join(tmp, 'alias-a');
    symlinkSync(a, alias);
    const fit = await estimateContextFit([a, b, alias]);
    expect(fit.roots.map((r) => r.path)).toEqual([a, b]);
    expect(fit.totalEstTokens).toBe(300);
  });

  it('classifies binary paths by extension (case-insensitively) and lockfiles by name', () => {
    expect(isContextFitSkippedPath('web/package-lock.json')).toBe(true);
    expect(isContextFitSkippedPath('go.sum')).toBe(true);
    expect(isContextFitSkippedPath('src/lock.ts')).toBe(false);
    expect(isContextFitBinaryPath('a/B.PNG')).toBe(true);
    expect(isContextFitBinaryPath('model.gguf')).toBe(true);
    expect(isContextFitBinaryPath('src/index.ts')).toBe(false);
    expect(isContextFitBinaryPath('Makefile')).toBe(false);
  });
});

describe('cache', () => {
  it('serves a repeat within 60 s from cache, with the ORIGINAL sampledAt', async () => {
    const repo = makeRepo('repo', { 'a.ts': 'a'.repeat(400) });
    let t = Date.parse('2026-09-23T12:00:00.000Z');
    const now = (): Date => new Date(t);
    const first = await estimateContextFit([repo], { now });
    writeFileSync(join(repo, 'a.ts'), 'a'.repeat(4000)); // uncommitted edit
    t += 30_000;
    const second = await estimateContextFit([repo], { now });
    expect(second).toEqual(first);
    expect(second.sampledAt).toBe('2026-09-23T12:00:00.000Z');

    t += CONTEXT_FIT_CACHE_TTL_MS; // expired
    const third = await estimateContextFit([repo], { now });
    expect(third.roots[0].bytes).toBe(4000);
    expect(third.sampledAt).toBe(new Date(t).toISOString());
  });

  it('re-measures immediately after a new commit (HEAD is in the key)', async () => {
    const repo = makeRepo('repo', { 'a.ts': 'a'.repeat(400) });
    const first = await estimateContextFit([repo]);
    writeFileSync(join(repo, 'b.ts'), 'b'.repeat(400));
    git(repo, 'add', 'b.ts');
    git(repo, 'commit', '-q', '-m', 'b');
    const second = await estimateContextFit([repo]);
    expect(first.roots[0].files).toBe(1);
    expect(second.roots[0].files).toBe(2);
  });

  it('reports the OLDEST part\'s sampledAt when roots were measured at different times', async () => {
    const a = makeRepo('a', { 'x.ts': 'x' });
    const b = makeRepo('b', { 'y.ts': 'y' });
    let t = Date.parse('2026-09-23T12:00:00.000Z');
    const now = (): Date => new Date(t);
    await estimateContextFit([a], { now });
    t += 10_000;
    const both = await estimateContextFit([a, b], { now });
    expect(both.sampledAt).toBe('2026-09-23T12:00:00.000Z');
  });
});

describe('validation', () => {
  it('rejects empty, relative, missing, file and too many roots', async () => {
    await expectInvalid(estimateContextFit([]));
    await expectInvalid(estimateContextFit(['relative/dir']));
    await expectInvalid(estimateContextFit([join(tmp, 'missing')]));
    const file = join(tmp, 'file.txt');
    writeFileSync(file, 'x');
    await expectInvalid(estimateContextFit([file]));
    const many = Array.from({ length: 9 }, (_, i) => {
      const dir = join(tmp, `d${i}`);
      mkdirSync(dir);
      return dir;
    });
    await expectInvalid(estimateContextFit(many));
  });
});

describe('hardening', () => {
  it('never runs a repository-local fsmonitor hook', async () => {
    const repo = makeRepo('repo', { 'a.ts': 'x' });
    const marker = join(tmp, 'fsmonitor-ran');
    const hook = join(tmp, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    git(repo, 'config', 'core.fsmonitor', hook);
    await estimateContextFit([repo]);
    expect(existsSync(marker)).toBe(false);

    // Control: the same hook DOES run for an unhardened git that consults the
    // index, so the assertion above is not vacuous.
    git(repo, 'status', '--porcelain');
    expect(existsSync(marker)).toBe(true);
  });

  it('passes the hardening config ahead of the subcommand', () => {
    expect(gitArgs('/r', ['ls-files'])).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-C', '/r', 'ls-files']);
  });
});
