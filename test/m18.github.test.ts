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
  viewPr,
  listIssues,
  createPr,
  readBranchProtectionAttestation,
} from '../src/core/integrations/github.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpawn(
  stdout: string,
  status: number | null = 0,
  error?: Error,
  stderr = '',
): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr, status, signal: null, error };
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
const PR_VIEW_JSON = JSON.stringify({
  number: 42,
  title: 'Remote handoff',
  url: 'https://github.com/acme/my-repo/pull/42',
  state: 'MERGED',
  mergedAt: '2026-07-03T01:00:00Z',
  closed: true,
  closedAt: '2026-07-03T01:00:00Z',
  headRefName: 'ashlr/proposal-42',
  headRefOid: '0123456789abcdef0123456789abcdef01234567',
  baseRefName: 'main',
  mergeCommit: { oid: 'abc123def456' },
});
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

const PROTECTION_REPO_JSON = JSON.stringify({
  id: 'R_test',
  nameWithOwner: 'acme/my-repo',
  defaultBranchRef: { name: 'main' },
});
const PROTECTION_BRANCH_JSON = JSON.stringify({
  name: 'main',
  commit: { sha: 'a'.repeat(40) },
});

const VALID_CLASSIC_PROTECTION = {
  required_status_checks: {
    strict: true,
    enforcement_level: 'non_admins',
    contexts: ['build'],
    checks: [{ context: 'test', app_id: 42 }],
  },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: 1,
    require_last_push_approval: true,
    dismissal_restrictions: {
      users: [{ id: 10, login: 'ReleaseAdmin' }],
      teams: [{ id: 20, slug: 'Maintainers' }],
      apps: [{ id: 30, slug: 'policy-app' }],
    },
    bypass_pull_request_allowances: {
      users: [],
      teams: [{ id: 21, slug: 'Release' }],
      apps: [],
    },
  },
  restrictions: {
    users: [{ id: 11, login: 'Deployer' }],
    teams: [],
    apps: [{ id: 31, slug: 'deploy-app' }],
  },
  required_signatures: { enabled: true },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  block_creations: { enabled: true },
  required_conversation_resolution: { enabled: true },
  lock_branch: { enabled: false },
  allow_fork_syncing: { enabled: false },
};

const VALID_EFFECTIVE_RULE = {
  type: 'required_status_checks',
  ruleset_source_type: 'Repository',
  ruleset_source: 'acme/my-repo',
  ruleset_id: 700,
  parameters: {
    strict_required_status_checks_policy: true,
    do_not_enforce_on_create: false,
    required_status_checks: [{ context: 'verify', integration_id: 42 }],
  },
};

const VALID_RULESET_DETAIL = {
  id: 700,
  source_type: 'Repository',
  source: 'acme/my-repo',
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [
    { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' },
    { actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
  ],
  conditions: {
    ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['refs/heads/release/*'] },
  },
  rules: [{
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: 'verify', integration_id: 42 }],
    },
  }],
};

function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let protectionRead = 0;

async function readClassicProtection(classic: unknown) {
  protectionRead++;
  setSpawnSequence([
    makeSpawn(PROTECTION_REPO_JSON),
    makeSpawn(PROTECTION_BRANCH_JSON),
    makeSpawn(JSON.stringify(classic)),
    makeSpawn('[]'),
  ]);
  return readBranchProtectionAttestation(`/fake/protection-${protectionRead}`, 'main', {
    expectedNameWithOwner: 'acme/my-repo',
    forceFresh: true,
  });
}

async function readRulesetProtection(
  effective: unknown = [VALID_EFFECTIVE_RULE],
  detail: unknown = VALID_RULESET_DETAIL,
) {
  protectionRead++;
  setSpawnSequence([
    makeSpawn(PROTECTION_REPO_JSON),
    makeSpawn(PROTECTION_BRANCH_JSON),
    makeSpawn('', 1, undefined, 'HTTP 404: Not Found'),
    makeSpawn(JSON.stringify(effective)),
    makeSpawn(JSON.stringify(detail)),
  ]);
  return readBranchProtectionAttestation(`/fake/ruleset-${protectionRead}`, 'main', {
    expectedNameWithOwner: 'acme/my-repo',
    forceFresh: true,
  });
}

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
// viewPr — read-only PR detail
// ---------------------------------------------------------------------------

describe('viewPr — read-only PR detail', () => {
  it('parses PR detail and merge commit metadata', () => {
    setSpawnAlways(makeSpawn(PR_VIEW_JSON));

    const pr = viewPr('/fake/cwd', 'https://github.com/acme/my-repo/pull/42');

    expect(pr).toEqual({
      number: 42,
      url: 'https://github.com/acme/my-repo/pull/42',
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      closed: true,
      closedAt: '2026-07-03T01:00:00Z',
      headRefName: 'ashlr/proposal-42',
      headRefOid: '0123456789abcdef0123456789abcdef01234567',
      baseRefName: 'main',
      mergeCommitOid: 'abc123def456',
    });
  });

  it('uses gh pr view with an explicit read-only json field list', () => {
    const calls: Array<{ cmd: unknown; args: unknown }> = [];
    _spawnSyncImpl = (cmd: unknown, args: unknown) => {
      calls.push({ cmd, args });
      return makeSpawn(PR_VIEW_JSON);
    };

    viewPr('/fake/cwd', 'ashlr/proposal-42');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('gh');
    expect(calls[0]?.args).toEqual([
      'pr',
      'view',
      'ashlr/proposal-42',
      '--json',
      'number,url,state,mergedAt,closed,closedAt,headRefName,headRefOid,baseRefName,mergeCommit',
    ]);
  });

  it('pins an explicit repository instead of trusting ambient gh context', () => {
    const calls: string[][] = [];
    let observedEnv: NodeJS.ProcessEnv | undefined;
    _spawnSyncImpl = (_cmd: unknown, args: unknown, options: unknown) => {
      if (Array.isArray(args)) calls.push(args as string[]);
      observedEnv = (options as { env?: NodeJS.ProcessEnv })?.env;
      return makeSpawn(PR_VIEW_JSON);
    };

    expect(viewPr('/fake/cwd', 'ashlr/proposal-42', { repo: 'acme/my-repo' })).not.toBeNull();
    expect(calls[0]).toEqual([
      'pr', 'view', 'ashlr/proposal-42', '--repo', 'acme/my-repo', '--json',
      'number,url,state,mergedAt,closed,closedAt,headRefName,headRefOid,baseRefName,mergeCommit',
    ]);
    expect(observedEnv?.['GH_HOST']).toBe('github.com');
    expect(viewPr('/fake/cwd', '42', { repo: '../other' })).toBeNull();
  });

  it('returns null when gh exits non-zero', () => {
    setSpawnAlways(makeSpawn('', 1));
    expect(viewPr('/fake/cwd', '42')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    setSpawnAlways(makeSpawn('not json'));
    expect(viewPr('/fake/cwd', '42')).toBeNull();
  });

  it('never throws on unexpected spawn errors', () => {
    _spawnSyncImpl = () => { throw new Error('boom'); };
    expect(() => viewPr('/fake/cwd', '42')).not.toThrow();
    expect(viewPr('/fake/cwd', '42')).toBeNull();
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

describe('listIssues — bounded labeled mode and strict rows', () => {
  const validIssue = {
    number: 10,
    title: 'Bug report',
    url: 'https://github.com/acme/my-repo/issues/10',
    state: 'OPEN',
    author: { login: 'carol' },
    labels: [{ name: 'bug' }],
  };

  it('preserves the exact legacy argv and five-field output shape', () => {
    const calls: string[][] = [];
    _spawnSyncImpl = (_cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) calls.push(args as string[]);
      return makeSpawn(JSON.stringify([validIssue]));
    };

    const issues = listIssues('/fake/cwd');

    expect(calls).toEqual([[
      'issue', 'list', '--state', 'open', '--json', 'number,title,url,state,author',
    ]]);
    expect(issues).toEqual([{
      number: 10,
      title: 'Bug report',
      url: 'https://github.com/acme/my-repo/issues/10',
      state: 'OPEN',
      author: 'carol',
    }]);
    expect(issues[0]).not.toHaveProperty('labels');
  });

  it('requests and normalizes nested labels with an explicit limit', () => {
    const calls: string[][] = [];
    _spawnSyncImpl = (_cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) calls.push(args as string[]);
      return makeSpawn(JSON.stringify([validIssue]));
    };

    const issues = listIssues('/fake/cwd', { limit: 100, includeLabels: true });

    expect(calls).toEqual([[
      'issue', 'list', '--state', 'open', '--limit', '100', '--json',
      'number,title,url,state,author,labels',
    ]]);
    expect(issues[0]?.labels).toEqual(['bug']);
  });

  it('accepts object, string, and null authors', () => {
    setSpawnAlways(makeSpawn(JSON.stringify([
      validIssue,
      { ...validIssue, number: 11, author: 'direct-author' },
      { ...validIssue, number: 12, author: null },
    ])));

    expect(listIssues('/fake/cwd', { includeLabels: true }).map((issue) => issue.author))
      .toEqual(['carol', 'direct-author', '']);
  });

  it.each([
    ['non-positive number', { number: 0 }],
    ['fractional number', { number: 1.5 }],
    ['blank title', { title: '   ' }],
    ['oversized title', { title: 'x'.repeat(257) }],
    ['blank URL', { url: '' }],
    ['oversized URL', { url: `https://example.com/${'x'.repeat(2_100)}` }],
    ['non-open state', { state: 'closed' }],
    ['malformed author', { author: { login: 42 } }],
    ['missing labels', { labels: undefined }],
    ['malformed label', { labels: [{ name: '' }] }],
  ])('rejects a %s row without poisoning a valid sibling', (_label, override) => {
    setSpawnAlways(makeSpawn(JSON.stringify([{ ...validIssue, ...override }, validIssue])));

    const issues = listIssues('/fake/cwd', { limit: 100, includeLabels: true });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(10);
  });

  it.each([0, 101, 1.5, Number.NaN])('rejects invalid limit %s before spawning', (limit) => {
    const spawn = vi.fn(() => makeSpawn(JSON.stringify([validIssue])));
    _spawnSyncImpl = spawn;
    expect(listIssues('/fake/cwd', { limit, includeLabels: true })).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([null, [], { includeLabels: 'true' }])(
    'rejects malformed options %# before spawning',
    (options) => {
      const spawn = vi.fn(() => makeSpawn(JSON.stringify([validIssue])));
      _spawnSyncImpl = spawn;
      expect(listIssues('/fake/cwd', options as unknown as { includeLabels?: boolean })).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('caps labeled results at 100 accepted rows after malformed rows are skipped', () => {
    const rows = [
      { ...validIssue, number: 0 },
      ...Array.from({ length: 110 }, (_unused, index) => ({
        ...validIssue,
        number: index + 1,
        url: `https://github.com/acme/my-repo/issues/${index + 1}`,
      })),
    ];
    setSpawnAlways(makeSpawn(JSON.stringify(rows)));

    const issues = listIssues('/fake/cwd', { limit: 100, includeLabels: true });

    expect(issues).toHaveLength(100);
    expect(issues[0]?.number).toBe(1);
    expect(issues[99]?.number).toBe(100);
  });

  it('locally preserves the legacy 30-row population cap', () => {
    setSpawnAlways(makeSpawn(JSON.stringify(Array.from({ length: 35 }, (_unused, index) => ({
      ...validIssue,
      number: index + 1,
      url: `https://github.com/acme/my-repo/issues/${index + 1}`,
    })))));
    expect(listIssues('/fake/cwd')).toHaveLength(30);
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

// ---------------------------------------------------------------------------
// Branch-protection canonical policy snapshots
// ---------------------------------------------------------------------------

describe('readBranchProtectionAttestation — canonical policy snapshot', () => {
  it('captures every merge-critical classic protection semantic canonically', async () => {
    const attestation = await readClassicProtection(VALID_CLASSIC_PROTECTION);

    expect(attestation.ok).toBe(true);
    expect(attestation.policySnapshot).toEqual({
      schemaVersion: 1,
      classic: {
        requiredStatusChecks: {
          strict: true,
          enforcementLevel: 'non_admins',
          checks: [
            { context: 'build', appId: null },
            { context: 'test', appId: '42' },
          ],
        },
        enforceAdmins: true,
        requiredPullRequestReviews: {
          dismissStaleReviews: true,
          requireCodeOwnerReviews: true,
          requiredApprovingReviewCount: 1,
          requireLastPushApproval: true,
          dismissalRestrictions: {
            users: [{ id: '10', name: 'releaseadmin' }],
            teams: [{ id: '20', name: 'maintainers' }],
            apps: [{ id: '30', name: 'policy-app' }],
          },
          bypassPullRequestAllowances: {
            users: [],
            teams: [{ id: '21', name: 'release' }],
            apps: [],
          },
        },
        pushRestrictions: {
          users: [{ id: '11', name: 'deployer' }],
          teams: [],
          apps: [{ id: '31', name: 'deploy-app' }],
        },
        requiredSignatures: true,
        requiredLinearHistory: true,
        allowForcePushes: false,
        allowDeletions: false,
        blockCreations: true,
        requiredConversationResolution: true,
        lockBranch: false,
        allowForkSyncing: false,
      },
      rulesets: [],
    });
  });

  it('changes the snapshot for each critical classic policy change', async () => {
    const baseline = await readClassicProtection(VALID_CLASSIC_PROTECTION);
    const baselineJson = JSON.stringify(baseline.policySnapshot);
    const mutations: Array<(fixture: typeof VALID_CLASSIC_PROTECTION) => void> = [
      (fixture) => { fixture.required_status_checks.strict = false; },
      (fixture) => { fixture.enforce_admins.enabled = false; },
      (fixture) => { fixture.required_pull_request_reviews.required_approving_review_count = 2; },
      (fixture) => { fixture.required_pull_request_reviews.bypass_pull_request_allowances.teams[0].id = 22; },
      (fixture) => { fixture.allow_force_pushes.enabled = true; },
      (fixture) => { fixture.allow_deletions.enabled = true; },
      (fixture) => { fixture.required_conversation_resolution.enabled = false; },
    ];

    for (const mutate of mutations) {
      const fixture = cloneFixture(VALID_CLASSIC_PROTECTION);
      mutate(fixture);
      const changed = await readClassicProtection(fixture);
      expect(changed.available).toBe(true);
      expect(JSON.stringify(changed.policySnapshot)).not.toBe(baselineJson);
    }
  });

  it('fails closed on malformed classic semantics and actors', async () => {
    const malformedStrict = cloneFixture(VALID_CLASSIC_PROTECTION);
    (malformedStrict.required_status_checks as Record<string, unknown>)['strict'] = 'true';
    const strictResult = await readClassicProtection(malformedStrict);
    expect(strictResult).toMatchObject({ ok: false, available: false, policySnapshot: null });

    const malformedActor = cloneFixture(VALID_CLASSIC_PROTECTION);
    (malformedActor.required_pull_request_reviews.dismissal_restrictions.users[0] as
      unknown as Record<string, unknown>)['id'] = 'not-an-id';
    const actorResult = await readClassicProtection(malformedActor);
    expect(actorResult).toMatchObject({ ok: false, available: false, policySnapshot: null });
  });

  it('captures complete effective rule parameters, conditions, and bypass actors', async () => {
    const calls: string[][] = [];
    const responses = [
      makeSpawn(PROTECTION_REPO_JSON),
      makeSpawn(PROTECTION_BRANCH_JSON),
      makeSpawn('', 1, undefined, 'HTTP 404: Not Found'),
      makeSpawn(JSON.stringify([VALID_EFFECTIVE_RULE])),
      makeSpawn(JSON.stringify(VALID_RULESET_DETAIL)),
    ];
    let index = 0;
    _spawnSyncImpl = (_cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) calls.push(args as string[]);
      return responses[index++] ?? makeSpawn('', 1);
    };

    protectionRead++;
    const attestation = await readBranchProtectionAttestation(
      `/fake/ruleset-detail-${protectionRead}`,
      'main',
      { expectedNameWithOwner: 'acme/my-repo', forceFresh: true },
    );

    expect(attestation.ok).toBe(true);
    expect(calls[4]).toEqual([
      'api',
      'repos/acme/my-repo/rulesets/700?includes_parents=true',
    ]);
    expect(attestation.policySnapshot?.rulesets).toEqual([{
      id: '700',
      sourceType: 'Repository',
      source: 'acme/my-repo',
      target: 'branch',
      enforcement: 'active',
      bypassActors: [
        { actorId: null, actorType: 'OrganizationAdmin', bypassMode: 'always' },
        { actorId: '5', actorType: 'RepositoryRole', bypassMode: 'pull_request' },
      ],
      conditions: {
        ref_name: {
          exclude: ['refs/heads/release/*'],
          include: ['~DEFAULT_BRANCH'],
        },
      },
      rules: [{
        type: 'required_status_checks',
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: 'verify', integration_id: 42 }],
          strict_required_status_checks_policy: true,
        },
      }],
    }]);
  });

  it('changes the snapshot for critical effective rule, bypass, and condition changes', async () => {
    const baseline = await readRulesetProtection();
    const baselineJson = JSON.stringify(baseline.policySnapshot);

    const strictRule = cloneFixture(VALID_EFFECTIVE_RULE);
    strictRule.parameters.strict_required_status_checks_policy = false;
    const strictDetail = cloneFixture(VALID_RULESET_DETAIL);
    strictDetail.rules[0].parameters.strict_required_status_checks_policy = false;
    const strictResult = await readRulesetProtection([strictRule], strictDetail);
    expect(JSON.stringify(strictResult.policySnapshot)).not.toBe(baselineJson);

    const bypassDetail = cloneFixture(VALID_RULESET_DETAIL);
    bypassDetail.bypass_actors[0].actor_id = 6;
    const bypassResult = await readRulesetProtection([VALID_EFFECTIVE_RULE], bypassDetail);
    expect(JSON.stringify(bypassResult.policySnapshot)).not.toBe(baselineJson);

    const conditionDetail = cloneFixture(VALID_RULESET_DETAIL);
    conditionDetail.conditions.ref_name.exclude.push('refs/heads/hotfix/*');
    const conditionResult = await readRulesetProtection([VALID_EFFECTIVE_RULE], conditionDetail);
    expect(JSON.stringify(conditionResult.policySnapshot)).not.toBe(baselineJson);
  });

  it('fails closed on unsupported, incomplete, or inconsistent active rulesets', async () => {
    const unsupported = cloneFixture(VALID_EFFECTIVE_RULE);
    unsupported.type = 'future_merge_authority_rule';
    const unsupportedResult = await readRulesetProtection([unsupported]);
    expect(unsupportedResult).toMatchObject({ ok: false, available: false, policySnapshot: null });

    const hiddenBypass = cloneFixture(VALID_RULESET_DETAIL) as Record<string, unknown>;
    delete hiddenBypass['bypass_actors'];
    const hiddenBypassResult = await readRulesetProtection([VALID_EFFECTIVE_RULE], hiddenBypass);
    expect(hiddenBypassResult).toMatchObject({ ok: false, available: false, policySnapshot: null });

    const mismatchedDetail = cloneFixture(VALID_RULESET_DETAIL);
    mismatchedDetail.rules[0].parameters.strict_required_status_checks_policy = false;
    const mismatchResult = await readRulesetProtection([VALID_EFFECTIVE_RULE], mismatchedDetail);
    expect(mismatchResult).toMatchObject({ ok: false, available: false, policySnapshot: null });
  });
});
