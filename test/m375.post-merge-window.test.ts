import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectPostMergeWindow,
  type PostMergeGitInvocation,
  type PostMergeGitRunner,
  type PostMergeWindowInput,
} from '../src/core/fleet/post-merge-window.js';

const MERGE_DATE = '2026-01-01T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_MS = 7 * DAY_MS;
const OBSERVED_AT_MS = Date.parse('2026-01-10T00:00:00.000Z');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'm375',
  GIT_AUTHOR_EMAIL: 'm375@test',
  GIT_COMMITTER_NAME: 'm375',
  GIT_COMMITTER_EMAIL: 'm375@test',
};

interface Fixture {
  repo: string;
  base: string;
  merge: string;
  branch: string;
  mergedPath: string;
}

const dirs: string[] = [];

function g(repo: string, args: string[], date?: string): string {
  const env = date
    ? { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    : GIT_ENV;
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    env,
  });
}

function commit(repo: string, message: string, date: string, allowEmpty = false): string {
  g(repo, ['commit', '--quiet', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message], date);
  return g(repo, ['rev-parse', 'HEAD']).trim();
}

function repoWithMerge(mergedPath = 'file.ts'): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'ashlr-m375-'));
  dirs.push(repo);
  execFileSync('git', ['init', '--quiet', repo], { stdio: 'pipe' });
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  g(repo, ['add', '-A']);
  const base = commit(repo, 'init', '2025-12-31T00:00:00.000Z');
  writeFileSync(join(repo, mergedPath), 'merged\n');
  g(repo, ['add', '-A']);
  const merge = commit(repo, 'ashlr: auto-merge proposal p-375', MERGE_DATE);
  return {
    repo,
    base,
    merge,
    branch: g(repo, ['branch', '--show-current']).trim(),
    mergedPath,
  };
}

function change(fixture: Fixture, message: string, date: string, content = 'changed\n'): string {
  writeFileSync(join(fixture.repo, fixture.mergedPath), content);
  g(fixture.repo, ['add', '-A']);
  return commit(fixture.repo, message, date);
}

function input(fixture: Fixture, overrides: Partial<PostMergeWindowInput> = {}): PostMergeWindowInput {
  return {
    repo: fixture.repo,
    mergeCommit: fixture.merge,
    observedAtMs: OBSERVED_AT_MS,
    followUpWindowMs: WINDOW_MS,
    ...overrides,
  };
}

const realRunner: PostMergeGitRunner = (invocation) => {
  const result = spawnSync('git', invocation.args, {
    cwd: invocation.repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: invocation.timeoutMs,
    maxBuffer: invocation.maxOutputBytes,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ETIMEDOUT' ? 'timeout' : code === 'ENOBUFS' ? 'output-limit' : 'git-error' };
  }
  if (result.status !== 0) return { ok: false, reason: 'git-error', exitCode: result.status ?? undefined };
  return { ok: true, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '') };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('M375 complete post-merge window inspector', () => {
  it('returns a complete clean snapshot for an unchanged head', () => {
    const fixture = repoWithMerge();

    expect(inspectPostMergeWindow(input(fixture))).toEqual({
      state: 'complete',
      mergeCommit: fixture.merge,
      observedHead: fixture.merge,
      mergeTimeMs: Date.parse(MERGE_DATE),
      windowStartedAtMs: Date.parse(MERGE_DATE),
      followUpWindowEndMs: Date.parse(MERGE_DATE) + WINDOW_MS,
      windowElapsed: true,
      commitsInspected: 0,
      adverse: null,
    });
  });

  it('detects a generated revert as deterministic evidence', () => {
    const fixture = repoWithMerge();
    g(fixture.repo, ['revert', '--no-edit', fixture.merge], '2026-01-02T00:00:00.000Z');
    const revert = g(fixture.repo, ['rev-parse', 'HEAD']).trim();

    expect(inspectPostMergeWindow(input(fixture))).toMatchObject({
      state: 'complete',
      adverse: {
        outcome: 'reverted',
        basis: 'git-revert-reference',
        confidence: 'deterministic',
        commit: revert,
      },
    });
  });

  it('gives a deterministic revert precedence over an earlier overlapping fix', () => {
    const fixture = repoWithMerge();
    change(fixture, 'fix: repair the merge', '2026-01-02T00:00:00.000Z');
    const revert = commit(
      fixture.repo,
      `revert: record rollback\n\nThis reverts commit ${fixture.merge}.`,
      '2026-01-09T00:00:00.000Z',
      true,
    );

    expect(inspectPostMergeWindow(input(fixture))).toMatchObject({
      state: 'complete',
      adverse: { outcome: 'reverted', commit: revert },
    });
  });

  it('detects the oldest overlapping fix inside the closed follow-up window', () => {
    const fixture = repoWithMerge();
    const atBoundary = new Date(Date.parse(MERGE_DATE) + WINDOW_MS).toISOString();
    const firstFix = change(fixture, 'fix: boundary repair', atBoundary, 'fixed once\n');
    change(fixture, 'hotfix: another repair', atBoundary, 'fixed twice\n');

    expect(inspectPostMergeWindow(input(fixture))).toMatchObject({
      state: 'complete',
      adverse: {
        outcome: 'followed-up',
        basis: 'overlapping-fix',
        confidence: 'heuristic',
        commit: firstFix,
      },
    });
  });

  it('ignores an overlapping fix after the closed window', () => {
    const fixture = repoWithMerge();
    change(fixture, 'fix: too late', '2026-01-09T00:00:00.000Z');

    expect(inspectPostMergeWindow(input(fixture))).toMatchObject({
      state: 'complete',
      commitsInspected: 1,
      adverse: null,
    });
  });

  it('uses an authoritative host merge time for stability-window completion', () => {
    const fixture = repoWithMerge();
    const hostMergedAtMs = Date.parse('2026-01-02T00:00:00.000Z');

    expect(inspectPostMergeWindow(input(fixture, {
      observedAtMs: hostMergedAtMs + WINDOW_MS - 1,
      windowStartedAtMs: hostMergedAtMs,
    }))).toMatchObject({
      state: 'complete',
      windowStartedAtMs: hostMergedAtMs,
      windowElapsed: false,
    });
    expect(inspectPostMergeWindow(input(fixture, {
      observedAtMs: hostMergedAtMs + WINDOW_MS,
      windowStartedAtMs: hostMergedAtMs,
    }))).toMatchObject({
      state: 'complete',
      windowStartedAtMs: hostMergedAtMs,
      windowElapsed: true,
    });
  });

  it('still detects a deterministic revert after the heuristic window', () => {
    const fixture = repoWithMerge();
    const revert = commit(
      fixture.repo,
      `revert: late rollback\n\nThis reverts commit ${fixture.merge}.`,
      '2026-01-09T00:00:00.000Z',
      true,
    );

    expect(inspectPostMergeWindow(input(fixture))).toMatchObject({
      state: 'complete',
      adverse: { outcome: 'reverted', commit: revert },
    });
  });

  it('does not mistake fix-flavored unrelated paths for follow-up evidence', () => {
    const fixture = repoWithMerge();
    writeFileSync(join(fixture.repo, 'other.txt'), 'other\n');
    g(fixture.repo, ['add', '-A']);
    commit(fixture.repo, 'fix: unrelated path', '2026-01-02T00:00:00.000Z');

    expect(inspectPostMergeWindow(input(fixture))).toMatchObject({ state: 'complete', adverse: null });
  });

  it('preserves newline-prefixed and 40-hex paths without header ambiguity', () => {
    for (const mergedPath of ['\nodd name', 'a'.repeat(40)]) {
      const fixture = repoWithMerge(mergedPath);
      change(fixture, 'fix: exact path identity', '2026-01-02T00:00:00.000Z');
      expect(inspectPostMergeWindow(input(fixture))).toMatchObject({
        state: 'complete',
        adverse: { outcome: 'followed-up' },
      });
    }
  });

  it('compares a real merge commit to its first parent', () => {
    const fixture = repoWithMerge();
    g(fixture.repo, ['checkout', '--quiet', '-b', 'feature']);
    writeFileSync(join(fixture.repo, 'feature.ts'), 'feature\n');
    g(fixture.repo, ['add', '-A']);
    commit(fixture.repo, 'feat: branch work', '2026-01-02T00:00:00.000Z');
    g(fixture.repo, ['checkout', '--quiet', fixture.branch]);
    writeFileSync(join(fixture.repo, 'main.ts'), 'main\n');
    g(fixture.repo, ['add', '-A']);
    commit(fixture.repo, 'feat: concurrent main work', '2026-01-02T00:00:00.000Z');
    g(fixture.repo, ['merge', '--quiet', '--no-ff', 'feature', '-m', 'ashlr: host merge'], '2026-01-03T00:00:00.000Z');
    const merge = g(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const mergeFixture = { ...fixture, merge, mergedPath: 'feature.ts' };
    const fix = change(mergeFixture, 'fix: repair merged branch file', '2026-01-04T00:00:00.000Z');

    expect(inspectPostMergeWindow(input(mergeFixture, {
      observedAtMs: Date.parse('2026-01-12T00:00:00.000Z'),
    }))).toMatchObject({
      state: 'complete',
      adverse: { outcome: 'followed-up', commit: fix },
    });
  });

  it('does not treat a longer revert-reference line as deterministic evidence', () => {
    const fixture = repoWithMerge();
    commit(
      fixture.repo,
      `docs: mention rollback\n\nThis reverts commit ${fixture.merge}0.`,
      '2026-01-02T00:00:00.000Z',
      true,
    );

    expect(inspectPostMergeWindow(input(fixture))).toMatchObject({ state: 'complete', adverse: null });
  });

  it('reads all commits in a busy history without a count cap', () => {
    const fixture = repoWithMerge();
    const fix = change(fixture, 'fix: buried repair', '2026-01-02T00:00:00.000Z');
    for (let index = 0; index < 55; index += 1) {
      commit(fixture.repo, `chore: filler ${index}`, '2026-01-03T00:00:00.000Z', true);
    }

    expect(inspectPostMergeWindow(input(fixture))).toMatchObject({
      state: 'complete',
      commitsInspected: 56,
      adverse: { outcome: 'followed-up', commit: fix },
    });
  }, 30_000);

  it('rejects malformed SHA inputs before invoking Git', () => {
    let calls = 0;
    const runGit: PostMergeGitRunner = () => {
      calls += 1;
      return { ok: false, reason: 'git-error' };
    };
    const fixture = repoWithMerge();

    expect(inspectPostMergeWindow(input(fixture, { mergeCommit: fixture.merge.toUpperCase() }), { runGit }))
      .toEqual({ state: 'inconclusive', reason: 'invalid-input' });
    expect(inspectPostMergeWindow(input(fixture, { mergeCommit: fixture.merge.slice(0, 39) }), { runGit }))
      .toEqual({ state: 'inconclusive', reason: 'invalid-input' });
    expect(calls).toBe(0);
  });

  it('rejects relative repositories and unbounded windows before invoking Git', () => {
    let calls = 0;
    const runGit: PostMergeGitRunner = () => {
      calls += 1;
      return { ok: false, reason: 'git-error' };
    };
    const fixture = repoWithMerge();

    expect(inspectPostMergeWindow(input(fixture, { repo: 'relative/repo' }), { runGit }))
      .toEqual({ state: 'inconclusive', reason: 'invalid-input' });
    expect(inspectPostMergeWindow(input(fixture, { followUpWindowMs: 366 * DAY_MS }), { runGit }))
      .toEqual({ state: 'inconclusive', reason: 'invalid-input' });
    expect(calls).toBe(0);
  });

  it('distinguishes a missing merge from a non-ancestor merge', () => {
    const fixture = repoWithMerge();
    expect(inspectPostMergeWindow(input(fixture, { mergeCommit: 'f'.repeat(40) }))).toMatchObject({
      state: 'inconclusive', reason: 'merge-missing', observedHead: fixture.merge,
    });

    g(fixture.repo, ['checkout', '--quiet', '-b', 'divergent', fixture.base]);
    const divergent = commit(fixture.repo, 'divergent', '2026-01-02T00:00:00.000Z', true);
    g(fixture.repo, ['checkout', '--quiet', fixture.branch]);
    expect(inspectPostMergeWindow(input(fixture, { mergeCommit: divergent }))).toMatchObject({
      state: 'inconclusive', reason: 'merge-not-ancestor', observedHead: fixture.merge,
    });
  });

  it('preserves a merge-lookup infrastructure failure instead of claiming the commit is missing', () => {
    const fixture = repoWithMerge();
    let calls = 0;
    const runGit: PostMergeGitRunner = () => {
      calls += 1;
      return calls === 1
        ? { ok: true, stdout: Buffer.from(`${fixture.merge}\n`) }
        : { ok: false, reason: 'git-error' };
    };

    expect(inspectPostMergeWindow(input(fixture), { runGit })).toEqual({
      state: 'inconclusive', reason: 'git-error', observedHead: fixture.merge,
    });
  });

  it('binds every history read to the captured immutable head', () => {
    const fixture = repoWithMerge();
    change(fixture, 'fix: captured', '2026-01-02T00:00:00.000Z');
    const capturedHead = g(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const calls: PostMergeGitInvocation[] = [];
    const runGit: PostMergeGitRunner = (invocation) => {
      calls.push(invocation);
      return realRunner(invocation);
    };

    expect(inspectPostMergeWindow(input(fixture), { runGit })).toMatchObject({ state: 'complete' });
    const history = calls.find((call) => call.args[0] === 'log');
    expect(history?.args).toContain(`${fixture.merge}..${capturedHead}`);
    expect(history?.args).not.toContain(`${fixture.merge}..HEAD`);
    expect(calls).toHaveLength(7);
    expect(calls.map((call) => call.maxOutputBytes)).toEqual([
      64 * 1024,
      64 * 1024,
      64 * 1024,
      64 * 1024,
      512 * 1024,
      2 * 1024 * 1024,
      64 * 1024,
    ]);
    expect(calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 15_000)).toBe(true);
  });

  it('fails closed when HEAD moves during inspection', () => {
    const fixture = repoWithMerge();
    let moved = false;
    const runGit: PostMergeGitRunner = (invocation) => {
      const result = realRunner(invocation);
      if (!moved && invocation.args[0] === 'log') {
        moved = true;
        commit(fixture.repo, 'chore: concurrent movement', '2026-01-02T00:00:00.000Z', true);
      }
      return result;
    };

    expect(inspectPostMergeWindow(input(fixture), { runGit })).toMatchObject({
      state: 'inconclusive', reason: 'head-moved', observedHead: fixture.merge,
    });
  });

  it.each([
    ['timeout', 'timeout'],
    ['output-limit', 'output-limit'],
    ['git-error', 'git-error'],
  ] as const)('preserves the explicit %s failure reason', (_name, reason) => {
    const fixture = repoWithMerge();
    const runGit: PostMergeGitRunner = () => ({ ok: false, reason });
    expect(inspectPostMergeWindow(input(fixture), { runGit })).toEqual({
      state: 'inconclusive', reason,
    });
  });

  it('enforces output caps even against a non-conforming injected runner', () => {
    const fixture = repoWithMerge();
    const runGit: PostMergeGitRunner = (invocation) => invocation.args[0] === 'log'
      ? { ok: true, stdout: Buffer.alloc(invocation.maxOutputBytes + 1) }
      : realRunner(invocation);

    expect(inspectPostMergeWindow(input(fixture), { runGit })).toMatchObject({
      state: 'inconclusive', reason: 'output-limit', observedHead: fixture.merge,
    });
  });

  it('fails closed on malformed NUL history framing', () => {
    const fixture = repoWithMerge();
    const runGit: PostMergeGitRunner = (invocation) => invocation.args[0] === 'log'
      ? { ok: true, stdout: Buffer.from('not-a-framed-history\0') }
      : realRunner(invocation);

    expect(inspectPostMergeWindow(input(fixture), { runGit })).toMatchObject({
      state: 'inconclusive', reason: 'malformed-output', observedHead: fixture.merge,
    });
  });

  it('reports clock skew instead of asserting a complete window', () => {
    const fixture = repoWithMerge();
    expect(inspectPostMergeWindow(input(fixture, {
      observedAtMs: Date.parse('2025-12-31T23:59:59.000Z'),
    }))).toMatchObject({
      state: 'inconclusive', reason: 'clock-skew', observedHead: fixture.merge,
    });
  });
});
