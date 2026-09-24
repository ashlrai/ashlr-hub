/**
 * 3.10 server performance (unit A3) — GitHub panel caches.
 *
 * With the REAL runners (no injected probe), identity is cached behind a stat
 * fingerprint of the git files it reads, and the two `gh` list reads are
 * stale-while-revalidate with an async, deduplicated refresh. `gh` here is a
 * fake script on PATH that records each invocation, so nothing touches the
 * network; git is real, in a tmp dir.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateVerseGithubCache,
  readVerseGithubRepo,
  readVerseGithubRepoAsync,
  readVerseGithubSnapshotAsync,
} from '../src/core/verse/github-repo.js';

let tmp: string;
let repo: string;
let log: string;
let savedPath: string | undefined;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

function ghCalls(): string[] {
  try {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ashlr-a3-gh-'));
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', 'https://github.com/Acme/Widget.git']);
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  log = join(tmp, 'gh.log');
  const script = join(bin, 'gh');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo "$1 $2" >> '${log}'`,
    'if [ "$1" = "pr" ]; then',
    `  echo '[{"number":7,"title":"Fix it","url":"https://github.com/acme/widget/pull/7","state":"OPEN","isDraft":false,"author":{"login":"a"},"headRefName":"fix","baseRefName":"main","updatedAt":"2026-09-01T00:00:00Z","statusCheckRollup":[]}]'`,
    'else',
    "  echo '[]'",
    'fi',
  ].join('\n'));
  chmodSync(script, 0o755);
  savedPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
  invalidateVerseGithubCache();
});

afterEach(() => {
  process.env['PATH'] = savedPath;
  vi.useRealTimers();
  invalidateVerseGithubCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('GitHub identity cache', () => {
  it('re-resolves nameWithOwner only when the git config changes', () => {
    const first = readVerseGithubRepo(repo, { includeLists: false });
    expect(first.remote).toMatchObject({ state: 'github', nameWithOwner: 'acme/widget' });
    // Break git resolution entirely: a cached identity must still answer.
    const prev = process.env['PATH'];
    process.env['PATH'] = join(tmp, 'nothing-here');
    try {
      expect(readVerseGithubRepo(repo, { includeLists: false }).remote.nameWithOwner).toBe('acme/widget');
    } finally {
      process.env['PATH'] = prev;
    }
    git(['remote', 'set-url', 'origin', 'https://github.com/acme/other.git']);
    expect(readVerseGithubRepo(repo, { includeLists: false }).remote.nameWithOwner).toBe('acme/other');
  });
});

describe('gh list cache', () => {
  it('reads gh once, then serves the cached answer with its original observedAt', async () => {
    const a = readVerseGithubRepo(repo);
    expect(a.prsAvailable).toBe(true);
    expect(a.prs).toHaveLength(1);
    expect(ghCalls()).toHaveLength(2);
    const b = readVerseGithubRepo(repo);
    const c = await readVerseGithubRepoAsync(repo);
    expect(ghCalls()).toHaveLength(2);
    expect(b.observedAt).toBe(a.observedAt);
    expect(c.prs[0]!.number).toBe(7);
  });

  it('async reads share one in-flight gh pair', async () => {
    const [x, y] = await Promise.all([readVerseGithubRepoAsync(repo), readVerseGithubRepoAsync(repo)]);
    expect(x.prs).toHaveLength(1);
    expect(y.issuesAvailable).toBe(true);
    expect(ghCalls()).toHaveLength(2);
  });

  it('after the fresh window: serves the last answer and refreshes once in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    await readVerseGithubRepoAsync(repo);
    vi.setSystemTime(start + 61_000);
    const stale = await readVerseGithubRepoAsync(repo);
    expect(stale.prs).toHaveLength(1);
    await vi.waitFor(() => expect(ghCalls()).toHaveLength(4), { timeout: 5_000 });
  });

  it('past the max staleness, waits for a live read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    await readVerseGithubRepoAsync(repo);
    vi.setSystemTime(start + 11 * 60_000);
    await readVerseGithubRepoAsync(repo);
    expect(ghCalls()).toHaveLength(4);
  });

  it('an injected runner bypasses the cache entirely', () => {
    const gh = vi.fn(() => '[]');
    readVerseGithubRepo(repo, { gh });
    readVerseGithubRepo(repo, { gh });
    expect(gh).toHaveBeenCalledTimes(4);
    expect(ghCalls()).toHaveLength(0);
  });

  it('readVerseGithubSnapshotAsync de-duplicates roots and keeps order', async () => {
    const other = join(tmp, 'not-a-repo');
    mkdirSync(other);
    const snap = await readVerseGithubSnapshotAsync([repo, other, repo], { includeLists: false });
    expect(snap.repos.map((r) => r.remote.state)).toEqual(['github', 'not-a-repo']);
  });
});
