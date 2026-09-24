/**
 * 3.10 server performance (unit A3) — rollup caches.
 *
 * - Commit counts come from a per-repo committer-time history cached behind a
 *   stat fingerprint of HEAD / the branch ref / packed-refs / logs/HEAD: a warm
 *   rollup spawns NO git, a new commit invalidates exactly that repo, and the
 *   1d/7d/30d windows are answered by filtering the cached times.
 * - getCachedRollup is stale-while-revalidate, single-flight, keeps the last
 *   good value on a failed refresh, and re-evaluates the budget against the
 *   caller's config.
 *
 * Real git in a tmp dir; HOME is relocated by test/setup/home.ts. Usage
 * sources and the index are mocked so nothing outside the tmp dir is read.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityRollup, AshlrConfig } from '../src/core/types.js';

const indexState = vi.hoisted(() => ({ repos: [] as string[] }));

vi.mock('../src/core/observability/usage-source.js', () => ({
  collectUsageEvents: vi.fn(() => []),
  dashNormalize: (p: string) => p.replace(/-/g, '/'),
}));

vi.mock('../src/core/index-engine.js', () => ({
  loadIndex: vi.fn(() => ({
    version: 1,
    generatedAt: new Date().toISOString(),
    root: '/tmp',
    items: indexState.repos.map((path) => ({ kind: 'repo', path, name: path.split('/').pop() })),
  })),
}));

const rollup = await import('../src/core/observability/rollup.js');

function cfg(extra: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1, roots: [], editor: 'vscode', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {}, ...extra,
  } as AshlrConfig;
}

let tmp: string;
let savedPath: string | undefined;

function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    },
  });
}

function makeRepo(name: string, commits: number): string {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  for (let i = 0; i < commits; i++) commit(repo, `c${i}`);
  return repo;
}

function commit(repo: string, msg: string, env: Record<string, string> = {}): void {
  writeFileSync(join(repo, `${msg}.txt`), msg);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', msg], env);
}

/** Make `git` unresolvable: any spawn now fails, so a correct count proves the cache answered. */
function withoutGit<T>(fn: () => T): T {
  const prev = process.env['PATH'];
  process.env['PATH'] = join(tmp, 'no-bin');
  try {
    return fn();
  } finally {
    process.env['PATH'] = prev;
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ashlr-a3-rollup-'));
  savedPath = process.env['PATH'];
  rollup.invalidateRollupCache();
  indexState.repos = [];
});

afterEach(() => {
  process.env['PATH'] = savedPath;
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

describe('commit-count cache', () => {
  it('a warm rollup answers from the cache without spawning git', () => {
    const a = makeRepo('a', 3);
    const b = makeRepo('b', 2);
    indexState.repos = [a, b];
    expect(rollup.buildRollup('7d', cfg()).totals.commits).toBe(5);
    // git is now unreachable — a spawn would return 0 commits.
    expect(withoutGit(() => rollup.buildRollup('7d', cfg()).totals.commits)).toBe(5);
  });

  it('a new commit invalidates exactly that repo', async () => {
    const a = makeRepo('a', 1);
    const b = makeRepo('b', 1);
    indexState.repos = [a, b];
    expect(await rollup.warmCommitCounts([a, b], Date.now() - 7 * 86_400_000)).toBe(2);
    expect(await rollup.warmCommitCounts([a, b], Date.now() - 7 * 86_400_000)).toBe(0);
    commit(a, 'next');
    expect(await rollup.warmCommitCounts([a, b], Date.now() - 7 * 86_400_000)).toBe(1);
    expect(rollup.buildRollup('7d', cfg()).totals.commits).toBe(3);
  });

  it('fingerprint changes on commit, checkout, and reset but not on a plain read', () => {
    const a = makeRepo('a', 2);
    const s1 = rollup.gitStateSignature(a);
    expect(s1).not.toBeNull();
    git(a, ['log', '--oneline']);
    expect(rollup.gitStateSignature(a)).toBe(s1);
    commit(a, 'x');
    const s2 = rollup.gitStateSignature(a);
    expect(s2).not.toBe(s1);
    git(a, ['checkout', '-q', '-b', 'feature']);
    const s3 = rollup.gitStateSignature(a);
    expect(s3).not.toBe(s2);
    git(a, ['reset', '-q', '--hard', 'HEAD~1']);
    expect(rollup.gitStateSignature(a)).not.toBe(s3);
  });

  it('counts per window by filtering cached committer times', () => {
    const a = makeRepo('a', 0);
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    commit(a, 'old', { GIT_COMMITTER_DATE: tenDaysAgo, GIT_AUTHOR_DATE: tenDaysAgo });
    commit(a, 'new');
    indexState.repos = [a];
    expect(rollup.buildRollup('30d', cfg()).totals.commits).toBe(2);
    // Served from the same cached history (30 d span) — no refetch needed.
    expect(withoutGit(() => rollup.buildRollup('7d', cfg()).totals.commits)).toBe(1);
    expect(withoutGit(() => rollup.buildRollup('1d', cfg()).totals.commits)).toBe(1);
  });

  it('fingerprints a linked worktree (.git file form) and sees its own commits', () => {
    const a = makeRepo('a', 1);
    const wt = join(tmp, 'wt');
    git(a, ['worktree', 'add', '-q', '-b', 'wt-branch', wt]);
    const before = rollup.gitStateSignature(wt);
    expect(before).not.toBeNull();
    commit(wt, 'in-worktree');
    expect(rollup.gitStateSignature(wt)).not.toBe(before);
    indexState.repos = [wt];
    expect(rollup.buildRollup('7d', cfg()).totals.commits).toBe(2);
  });

  it('a non-repo in the index counts 0 and is not respawned while unchanged', () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    indexState.repos = [plain];
    expect(rollup.buildRollup('7d', cfg()).totals.commits).toBe(0);
    expect(rollup.gitStateSignature(plain)).toBeNull();
  });
});

describe('getCachedRollup (stale-while-revalidate)', () => {
  function fakeRollup(tokensIn: number): ActivityRollup {
    return {
      window: '7d',
      since: new Date().toISOString(),
      totals: { tokensIn, tokensOut: 0, estCostUsd: tokensIn / 1000, sessions: 1, commits: 0 },
      byProject: [], byDay: [], byModel: [],
      budget: { level: 'ok', window: '7d', spentUsd: 0, capUsd: null, spentTokens: 0, capTokens: null, message: '' },
    } as unknown as ActivityRollup;
  }

  it('cold callers share one computation; fresh reads do not recompute', async () => {
    let calls = 0;
    const compute = vi.fn(async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return fakeRollup(calls); });
    const [a, b] = await Promise.all([
      rollup.getCachedRollup('7d', cfg(), { compute }),
      rollup.getCachedRollup('7d', cfg(), { compute }),
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(a.rollup.totals.tokensIn).toBe(1);
    expect(b.stale).toBe(false);
    const c = await rollup.getCachedRollup('7d', cfg(), { compute });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(c.rollup.totals.tokensIn).toBe(1);
  });

  it('serves stale immediately after the TTL and refreshes once in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    let n = 0;
    const compute = vi.fn(async () => fakeRollup(++n));
    await rollup.getCachedRollup('7d', cfg(), { compute });
    vi.setSystemTime(start + rollup.ROLLUP_CACHE_TTL_MS + 1);
    const stale = await rollup.getCachedRollup('7d', cfg(), { compute });
    expect(stale.stale).toBe(true);
    expect(stale.rollup.totals.tokensIn).toBe(1);
    expect(stale.ageMs).toBeGreaterThanOrEqual(rollup.ROLLUP_CACHE_TTL_MS);
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    const fresh = await rollup.getCachedRollup('7d', cfg(), { compute });
    expect(fresh.rollup.totals.tokensIn).toBe(2);
    expect(fresh.stale).toBe(false);
  });

  it('waits for a recompute once the value is older than the max staleness', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    let n = 0;
    const compute = vi.fn(async () => fakeRollup(++n));
    await rollup.getCachedRollup('7d', cfg(), { compute });
    vi.setSystemTime(start + rollup.ROLLUP_CACHE_MAX_STALE_MS + 1);
    const r = await rollup.getCachedRollup('7d', cfg(), { compute });
    expect(r.stale).toBe(false);
    expect(r.rollup.totals.tokensIn).toBe(2);
  });

  it('keeps the last good value when a refresh fails, and throws only when there is none', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    await expect(rollup.getCachedRollup('30d', cfg(), { compute: async () => { throw new Error('boom'); } }))
      .rejects.toThrow('boom');
    await rollup.getCachedRollup('30d', cfg(), { compute: async () => fakeRollup(7) });
    vi.setSystemTime(start + rollup.ROLLUP_CACHE_MAX_STALE_MS + 1);
    const r = await rollup.getCachedRollup('30d', cfg(), { compute: async () => { throw new Error('boom'); } });
    expect(r.stale).toBe(true);
    expect(r.rollup.totals.tokensIn).toBe(7);
  });

  it('re-evaluates the budget with the caller config instead of caching the verdict', async () => {
    const compute = async (): Promise<ActivityRollup> => fakeRollup(10_000_000); // $10k est.
    const open = await rollup.getCachedRollup('7d', cfg(), { compute });
    expect(open.rollup.budget.capUsd).toBeNull();
    const capped = await rollup.getCachedRollup('7d', cfg({ telemetry: { budgetUsd: 1 } } as Partial<AshlrConfig>), { compute });
    expect(capped.rollup.totals.tokensIn).toBe(10_000_000);
    expect(capped.rollup.budget.capUsd).toBe(1);
  });

  it('keys on HOME so a relocated home never reads another home’s numbers', async () => {
    const prev = process.env['HOME'];
    const compute1 = async (): Promise<ActivityRollup> => fakeRollup(1);
    const compute2 = async (): Promise<ActivityRollup> => fakeRollup(2);
    await rollup.getCachedRollup('7d', cfg(), { compute: compute1 });
    process.env['HOME'] = join(tmp, 'other-home');
    try {
      const r = await rollup.getCachedRollup('7d', cfg(), { compute: compute2 });
      expect(r.rollup.totals.tokensIn).toBe(2);
    } finally {
      process.env['HOME'] = prev;
    }
  });

  it('buildRollupAsync warms commit counts with async spawns, then matches buildRollup', async () => {
    const a = makeRepo('a', 4);
    indexState.repos = [a];
    const asyncResult = await rollup.buildRollupAsync('7d', cfg());
    expect(asyncResult.totals.commits).toBe(4);
    expect(withoutGit(() => rollup.buildRollup('7d', cfg()).totals.commits)).toBe(4);
  });
});
