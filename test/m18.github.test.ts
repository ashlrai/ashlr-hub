/**
 * M18 — hermetic tests for src/core/integrations/github.ts
 *
 * Mocks node:child_process so no real `gh` binary is invoked.
 *
 * Invariants verified:
 *   - githubStatus parses gh JSON output correctly
 *   - githubStatus degrades gracefully when not a repo / not authed / gh absent
 *   - githubStatus NEVER throws — always returns GithubStatus shape
 *   - listPrs parses pr list JSON, returns [] on any failure
 *   - listIssues parses issue list JSON, returns [] on any failure
 *   - createPr is EXPLICIT (mutating) — NEVER called by any read path
 *   - no raw tokens are logged or returned
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test.
// vi.mock is hoisted by vitest.
// ---------------------------------------------------------------------------

let _spawnSyncImpl: (...args: unknown[]) => SpawnSyncReturns<string>;

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => _spawnSyncImpl(...args),
  execFileSync: () => { throw new Error('execFileSync not expected'); },
}));

// Import module under test AFTER mock is registered.
import {
  githubStatus,
  listPrs,
  listIssues,
  createPr,
} from '../src/core/integrations/github.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpawn(
  stdout: string,
  status: number | null = 0,
  error?: Error,
): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr: '', status, signal: null, error };
}

function spawnNotFound(): SpawnSyncReturns<string> {
  return makeSpawn('', null, Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
}

/** Simulate a gh call sequence; last response is repeated if exhausted. */
function setSpawnSequence(responses: SpawnSyncReturns<string>[]): void {
  let idx = 0;
  _spawnSyncImpl = () => {
    const res = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return res;
  };
}

/** Always return the given result. */
function setSpawnAlways(res: SpawnSyncReturns<string>): void {
  _spawnSyncImpl = () => res;
}

// JSON payloads that gh outputs
const REPO_VIEW_JSON = JSON.stringify({ nameWithOwner: 'acme/my-repo' });
const PR_LIST_JSON = JSON.stringify([
  { number: 1, title: 'Fix bug', url: 'https://github.com/acme/my-repo/pull/1', state: 'OPEN', author: { login: 'alice' } },
  { number: 2, title: 'Add feature', url: 'https://github.com/acme/my-repo/pull/2', state: 'OPEN', author: { login: 'bob' } },
]);
const ISSUE_LIST_JSON = JSON.stringify([
  { number: 10, title: 'Bug report', url: 'https://github.com/acme/my-repo/issues/10', state: 'OPEN', author: { login: 'carol' } },
]);
const RUN_LIST_PASSING_JSON = JSON.stringify([
  { status: 'completed', conclusion: 'success' },
  { status: 'completed', conclusion: 'success' },
]);
const RUN_LIST_FAILING_JSON = JSON.stringify([
  { status: 'completed', conclusion: 'failure' },
]);
const RUN_LIST_PENDING_JSON = JSON.stringify([
  { status: 'in_progress', conclusion: null },
]);
const RUN_LIST_EMPTY_JSON = JSON.stringify([]);

// ---------------------------------------------------------------------------
// githubStatus — happy path (is a repo, prs, issues, ci)
// ---------------------------------------------------------------------------

describe('githubStatus — happy path: linked repo with open PRs and issues', () => {
  beforeEach(() => {
    // Call order: repo view → pr list → issue list → run list
    setSpawnSequence([
      makeSpawn(REPO_VIEW_JSON),
      makeSpawn(PR_LIST_JSON),
      makeSpawn(ISSUE_LIST_JSON),
      makeSpawn(RUN_LIST_PASSING_JSON),
    ]);
  });

  it('returns isRepo:true', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.isRepo).toBe(true);
  });

  it('returns the repo nameWithOwner', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.repo).toBe('acme/my-repo');
  });

  it('returns correct openPrs count', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.openPrs).toBe(2);
  });

  it('returns correct openIssues count', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.openIssues).toBe(1);
  });

  it('returns ci:passing when all runs succeed', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.ci).toBe('passing');
  });
});

// ---------------------------------------------------------------------------
// githubStatus — ci states
// ---------------------------------------------------------------------------

describe('githubStatus — ci:failing when a run has failed conclusion', () => {
  beforeEach(() => {
    setSpawnSequence([
      makeSpawn(REPO_VIEW_JSON),
      makeSpawn(PR_LIST_JSON),
      makeSpawn(ISSUE_LIST_JSON),
      makeSpawn(RUN_LIST_FAILING_JSON),
    ]);
  });

  it('returns ci:failing', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.ci).toBe('failing');
  });
});

describe('githubStatus — ci:pending when runs are in_progress', () => {
  beforeEach(() => {
    setSpawnSequence([
      makeSpawn(REPO_VIEW_JSON),
      makeSpawn(PR_LIST_JSON),
      makeSpawn(ISSUE_LIST_JSON),
      makeSpawn(RUN_LIST_PENDING_JSON),
    ]);
  });

  it('returns ci:pending', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.ci).toBe('pending');
  });
});

describe('githubStatus — ci:none when run list is empty', () => {
  beforeEach(() => {
    setSpawnSequence([
      makeSpawn(REPO_VIEW_JSON),
      makeSpawn(PR_LIST_JSON),
      makeSpawn(ISSUE_LIST_JSON),
      makeSpawn(RUN_LIST_EMPTY_JSON),
    ]);
  });

  it('returns ci:none', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.ci).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// githubStatus — not a repo (gh repo view fails)
// ---------------------------------------------------------------------------

describe('githubStatus — not a git/gh repo', () => {
  beforeEach(() => {
    // gh repo view exits non-zero for non-repos
    setSpawnAlways(makeSpawn('', 1));
  });

  it('does not throw', () => {
    expect(() => githubStatus('/not/a/repo')).not.toThrow();
  });

  it('returns isRepo:false', () => {
    const s = githubStatus('/not/a/repo');
    expect(s.isRepo).toBe(false);
  });

  it('returns repo:null', () => {
    const s = githubStatus('/not/a/repo');
    expect(s.repo).toBeNull();
  });

  it('returns openPrs:0', () => {
    const s = githubStatus('/not/a/repo');
    expect(s.openPrs).toBe(0);
  });

  it('returns openIssues:0', () => {
    const s = githubStatus('/not/a/repo');
    expect(s.openIssues).toBe(0);
  });

  it('returns ci:none', () => {
    const s = githubStatus('/not/a/repo');
    expect(s.ci).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// githubStatus — gh binary not found (ENOENT)
// ---------------------------------------------------------------------------

describe('githubStatus — gh binary not on PATH', () => {
  beforeEach(() => {
    setSpawnAlways(spawnNotFound());
  });

  it('does not throw when gh is missing', () => {
    expect(() => githubStatus('/any/path')).not.toThrow();
  });

  it('returns isRepo:false when gh is missing', () => {
    const s = githubStatus('/any/path');
    expect(s.isRepo).toBe(false);
  });

  it('returns safe GithubStatus shape', () => {
    const s = githubStatus('/any/path');
    expect(typeof s.isRepo).toBe('boolean');
    expect(typeof s.openPrs).toBe('number');
    expect(typeof s.openIssues).toBe('number');
    expect(['passing', 'failing', 'pending', 'none']).toContain(s.ci);
  });
});

// ---------------------------------------------------------------------------
// githubStatus — not authenticated (gh returns auth error JSON)
// ---------------------------------------------------------------------------

describe('githubStatus — not authenticated (gh returns error)', () => {
  beforeEach(() => {
    // gh returns non-zero + error output when not logged in
    setSpawnAlways(makeSpawn('{"message":"Not Found"}', 1));
  });

  it('does not throw', () => {
    expect(() => githubStatus('/fake/cwd')).not.toThrow();
  });

  it('degrades to not-a-repo shape', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.isRepo).toBe(false);
    expect(s.repo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// githubStatus — malformed JSON output
// ---------------------------------------------------------------------------

describe('githubStatus — malformed JSON from gh', () => {
  beforeEach(() => {
    setSpawnAlways(makeSpawn('this is not json at all!!!'));
  });

  it('does not throw on malformed output', () => {
    expect(() => githubStatus('/fake/cwd')).not.toThrow();
  });

  it('returns safe defaults on malformed output', () => {
    const s = githubStatus('/fake/cwd');
    expect(s.openPrs).toBe(0);
    expect(s.openIssues).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// githubStatus — spawnSync throws unexpectedly
// ---------------------------------------------------------------------------

describe('githubStatus — spawnSync throws internally', () => {
  beforeEach(() => {
    _spawnSyncImpl = () => { throw new Error('unexpected OS error'); };
  });

  it('does not propagate the thrown error', () => {
    expect(() => githubStatus('/any/path')).not.toThrow();
  });

  it('returns isRepo:false', () => {
    const s = githubStatus('/any/path');
    expect(s.isRepo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// githubStatus — shape invariant: always returns GithubStatus
// ---------------------------------------------------------------------------

describe('githubStatus — always returns a valid GithubStatus shape', () => {
  it('shape is correct on success', () => {
    setSpawnSequence([
      makeSpawn(REPO_VIEW_JSON),
      makeSpawn(PR_LIST_JSON),
      makeSpawn(ISSUE_LIST_JSON),
      makeSpawn(RUN_LIST_EMPTY_JSON),
    ]);
    const s = githubStatus('/fake/cwd');
    expect(typeof s.isRepo).toBe('boolean');
    expect(typeof s.openPrs).toBe('number');
    expect(typeof s.openIssues).toBe('number');
    expect(['passing', 'failing', 'pending', 'none']).toContain(s.ci);
    expect(s.repo === null || typeof s.repo === 'string').toBe(true);
  });

  it('shape is correct on failure', () => {
    setSpawnAlways(makeSpawn('', 1));
    const s = githubStatus('/fake/cwd');
    expect(typeof s.isRepo).toBe('boolean');
    expect(typeof s.openPrs).toBe('number');
    expect(typeof s.openIssues).toBe('number');
    expect(['passing', 'failing', 'pending', 'none']).toContain(s.ci);
    expect(s.repo === null || typeof s.repo === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listPrs — happy path
// ---------------------------------------------------------------------------

describe('listPrs — happy path', () => {
  beforeEach(() => {
    setSpawnAlways(makeSpawn(PR_LIST_JSON));
  });

  it('returns an array of PR summaries', () => {
    const prs = listPrs('/fake/cwd');
    expect(Array.isArray(prs)).toBe(true);
    expect(prs.length).toBe(2);
  });

  it('each PR has number, title, url, state, author fields', () => {
    const prs = listPrs('/fake/cwd');
    for (const pr of prs) {
      expect(typeof pr.number).toBe('number');
      expect(typeof pr.title).toBe('string');
      expect(typeof pr.url).toBe('string');
      expect(typeof pr.state).toBe('string');
      expect(typeof pr.author).toBe('string');
    }
  });

  it('first PR number is 1', () => {
    const prs = listPrs('/fake/cwd');
    expect(prs[0].number).toBe(1);
  });

  it('second PR title is correct', () => {
    const prs = listPrs('/fake/cwd');
    expect(prs[1].title).toBe('Add feature');
  });
});

// ---------------------------------------------------------------------------
// listPrs — failure paths always return []
// ---------------------------------------------------------------------------

describe('listPrs — returns [] on any failure', () => {
  it('returns [] when gh is not found', () => {
    setSpawnAlways(spawnNotFound());
    expect(listPrs('/fake/cwd')).toEqual([]);
  });

  it('returns [] when gh exits non-zero', () => {
    setSpawnAlways(makeSpawn('', 1));
    expect(listPrs('/fake/cwd')).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    setSpawnAlways(makeSpawn('not json'));
    expect(listPrs('/fake/cwd')).toEqual([]);
  });

  it('never throws on any failure', () => {
    _spawnSyncImpl = () => { throw new Error('boom'); };
    expect(() => listPrs('/fake/cwd')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listIssues — happy path
// ---------------------------------------------------------------------------

describe('listIssues — happy path', () => {
  beforeEach(() => {
    setSpawnAlways(makeSpawn(ISSUE_LIST_JSON));
  });

  it('returns an array of issue summaries', () => {
    const issues = listIssues('/fake/cwd');
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBe(1);
  });

  it('issue has required fields', () => {
    const issues = listIssues('/fake/cwd');
    const issue = issues[0];
    expect(typeof issue.number).toBe('number');
    expect(typeof issue.title).toBe('string');
    expect(typeof issue.url).toBe('string');
    expect(typeof issue.state).toBe('string');
    expect(typeof issue.author).toBe('string');
  });

  it('issue number is 10', () => {
    const issues = listIssues('/fake/cwd');
    expect(issues[0].number).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// listIssues — failure paths always return []
// ---------------------------------------------------------------------------

describe('listIssues — returns [] on any failure', () => {
  it('returns [] when gh is not found', () => {
    setSpawnAlways(spawnNotFound());
    expect(listIssues('/fake/cwd')).toEqual([]);
  });

  it('returns [] when gh exits non-zero', () => {
    setSpawnAlways(makeSpawn('', 1));
    expect(listIssues('/fake/cwd')).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    setSpawnAlways(makeSpawn('not json'));
    expect(listIssues('/fake/cwd')).toEqual([]);
  });

  it('never throws on any failure', () => {
    _spawnSyncImpl = () => { throw new Error('boom'); };
    expect(() => listIssues('/fake/cwd')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// EXPLICIT mutation invariant — createPr is NOT imported/called by read paths
// ---------------------------------------------------------------------------

describe('createPr — explicit mutation contract: not called by read paths', () => {
  it('githubStatus does not call createPr (module has no auto-mutation)', () => {
    // We verify that calling githubStatus (a read path) does NOT invoke any
    // mutation. The fact that spawnSync is called is fine (read-only gh commands).
    // We track invocations and assert no `gh pr create` was constructed.
    const calls: string[] = [];
    _spawnSyncImpl = (cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) {
        calls.push([cmd, ...args].filter(Boolean).join(' '));
      }
      return makeSpawn('{}', 0);
    };
    githubStatus('/fake/cwd');
    // None of the spawned commands should be a `gh pr create`
    const createCalls = calls.filter(c => c.includes('pr create'));
    expect(createCalls).toHaveLength(0);
  });

  it('listPrs does not call createPr', () => {
    const calls: string[] = [];
    _spawnSyncImpl = (cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) {
        calls.push([cmd, ...args].filter(Boolean).join(' '));
      }
      return makeSpawn('[]', 0);
    };
    listPrs('/fake/cwd');
    const createCalls = calls.filter(c => c.includes('pr create'));
    expect(createCalls).toHaveLength(0);
  });

  it('listIssues does not call createPr', () => {
    const calls: string[] = [];
    _spawnSyncImpl = (cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) {
        calls.push([cmd, ...args].filter(Boolean).join(' '));
      }
      return makeSpawn('[]', 0);
    };
    listIssues('/fake/cwd');
    const createCalls = calls.filter(c => c.includes('pr create'));
    expect(createCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No raw token leakage — read paths never return token-shaped values
// ---------------------------------------------------------------------------

describe('createPr — does NOT pass the unsupported `--json` flag (regression)', () => {
  // Regression guard: `gh pr create` does NOT support `--json` (only
  // `gh pr list/view` do). Passing it makes gh exit non-zero on every run,
  // so createPr would always report ok:false even when a PR is created.
  it('constructs `pr create` without a `--json` flag', async () => {
    const calls: string[][] = [];
    _spawnSyncImpl = (_cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) calls.push(args as string[]);
      return makeSpawn('https://github.com/acme/my-repo/pull/42', 0);
    };
    await createPr('/fake/cwd', { title: 'My PR' });
    expect(calls.length).toBe(1);
    const argv = calls[0];
    expect(argv.slice(0, 2)).toEqual(['pr', 'create']);
    expect(argv).not.toContain('--json');
  });

  it('parses the plain-text PR URL from gh stdout on success', async () => {
    _spawnSyncImpl = () =>
      makeSpawn('https://github.com/acme/my-repo/pull/42', 0);
    const res = await createPr('/fake/cwd', { title: 'My PR' });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://github.com/acme/my-repo/pull/42');
  });

  it('finds the URL even when gh emits preamble lines before it', async () => {
    _spawnSyncImpl = () =>
      makeSpawn(
        'Warning: 3 uncommitted changes\nhttps://github.com/acme/my-repo/pull/99\n',
        0,
      );
    const res = await createPr('/fake/cwd', { title: 'My PR' });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://github.com/acme/my-repo/pull/99');
  });

  it('uses --fill when no body is supplied (no --json)', async () => {
    const calls: string[][] = [];
    _spawnSyncImpl = (_cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) calls.push(args as string[]);
      return makeSpawn('https://github.com/acme/my-repo/pull/7', 0);
    };
    await createPr('/fake/cwd', { title: 'No body PR' });
    const argv = calls[0];
    expect(argv).toContain('--fill');
    expect(argv).not.toContain('--json');
  });

  it('returns ok:false with stderr detail when gh exits non-zero', async () => {
    _spawnSyncImpl = () => makeSpawn('', 1, undefined as unknown as Error);
    const res = await createPr('/fake/cwd', { title: 'My PR' });
    expect(res.ok).toBe(false);
  });
});

describe('githubStatus — no token leakage in returned data', () => {
  it('serialized status does not contain token-pattern values', () => {
    setSpawnSequence([
      makeSpawn(REPO_VIEW_JSON),
      makeSpawn(PR_LIST_JSON),
      makeSpawn(ISSUE_LIST_JSON),
      makeSpawn(RUN_LIST_PASSING_JSON),
    ]);
    const s = githubStatus('/fake/cwd');
    const json = JSON.stringify(s);
    // Should not contain token-shaped strings (long hex/base64 secrets)
    expect(json).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
    expect(json).not.toMatch(/Bearer [a-zA-Z0-9._-]{20,}/);
  });
});
