/**
 * Tests for src/core/verse/github-repo.ts — per-root GitHub surfacing for
 * Ashlr Verse (docs/VERSE-WORKSPACES.md §2).
 *
 * FULLY HERMETIC. The `gh` runner and the git probe are both injected, so no
 * test here spawns a subprocess, touches the network, or reads a real
 * repository. Every `gh` payload below is a fixture; the PR check-rollup
 * fixtures reproduce the two GraphQL variants gh actually emits (`CheckRun`
 * with status/conclusion, `StatusContext` with state).
 *
 * The load-bearing invariants:
 *   - unavailable (gh could not answer) is never collapsed into empty
 *   - a failing check outranks a queued one
 *   - no git remote URL can reach the snapshot, because a GitHub HTTPS
 *     transport may carry credentials in its userinfo
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseIssueList,
  parsePrList,
  readVerseGithubRepo,
  readVerseGithubSnapshot,
  summarizeCheckRollup,
  type VerseGithubGitProbe,
  type VerseGithubReadOptions,
} from '../src/core/verse/github-repo.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const REPO = '/tmp/fixture-repo';

/** github-repo.ts with comments stripped, for the source-level guards below. */
const READER_CODE = readFileSync(
  fileURLToPath(new URL('../src/core/verse/github-repo.ts', import.meta.url)),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

const githubGit: VerseGithubGitProbe = {
  isRepo: () => true,
  defaultBranch: () => 'main',
  nameWithOwner: () => 'ashlrai/ashlr-hub',
};

interface GhCall {
  cwd: string;
  args: readonly string[];
}

/** Record every gh invocation and answer from a fixture table by subcommand. */
function ghFrom(
  answers: { pr?: string | null; issue?: string | null },
  calls: GhCall[] = [],
): VerseGithubReadOptions['gh'] {
  return (cwd, args) => {
    calls.push({ cwd, args });
    const kind = args[0];
    if (kind === 'pr') return answers.pr ?? null;
    if (kind === 'issue') return answers.issue ?? null;
    return null;
  };
}

const PR_FIXTURE = JSON.stringify([
  {
    number: 406,
    title: 'Surface GitHub in Verse',
    url: 'https://github.com/ashlrai/ashlr-hub/pull/406',
    state: 'OPEN',
    author: { login: 'masonwyatt' },
    isDraft: false,
    headRefName: 'verse-github-surface',
    baseRefName: 'verse',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'unit' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', name: 'lint' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null, name: 'e2e' },
    ],
  },
  {
    number: 324,
    title: 'Draft with no checks',
    url: 'https://github.com/ashlrai/ashlr-hub/pull/324',
    state: 'OPEN',
    author: null,
    isDraft: true,
    headRefName: 'wip',
    baseRefName: 'master',
    statusCheckRollup: [],
  },
]);

const ISSUE_FIXTURE = JSON.stringify([
  {
    number: 12,
    title: 'Approvals should name the branch',
    url: 'https://github.com/ashlrai/ashlr-hub/issues/12',
    state: 'OPEN',
    author: { login: 'masonwyatt' },
    labels: [{ name: 'verse' }, { name: 'ux' }],
  },
]);

function read(opts: Partial<VerseGithubReadOptions> = {}) {
  return readVerseGithubRepo(REPO, {
    git: githubGit,
    isDirectory: () => true,
    now: () => new Date('2026-09-22T12:00:00.000Z'),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Check rollup
// ---------------------------------------------------------------------------

describe('summarizeCheckRollup', () => {
  it('reports none for an empty rollup and unknown when gh sent no rollup at all', () => {
    expect(summarizeCheckRollup([])).toEqual({
      state: 'none', total: 0, passed: 0, failed: 0, pending: 0,
    });
    // The distinction matters: "this PR has no checks" is a fact,
    // "gh told us nothing" is an absence, and the UI must not equate them.
    expect(summarizeCheckRollup(undefined).state).toBe('unknown');
    expect(summarizeCheckRollup(null).state).toBe('unknown');
    expect(summarizeCheckRollup('nope').state).toBe('unknown');
  });

  it('counts a failing check ahead of a pending one', () => {
    const checks = summarizeCheckRollup([
      { __typename: 'CheckRun', status: 'QUEUED' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    expect(checks).toEqual({ state: 'failing', total: 3, passed: 1, failed: 1, pending: 1 });
  });

  it('treats skipped and neutral as passing, and a completed run with an undocumented conclusion as failing', () => {
    expect(summarizeCheckRollup([
      { status: 'COMPLETED', conclusion: 'SKIPPED' },
      { status: 'COMPLETED', conclusion: 'NEUTRAL' },
    ]).state).toBe('passing');
    expect(summarizeCheckRollup([
      { status: 'COMPLETED', conclusion: 'STALE' },
    ]).state).toBe('failing');
  });

  it('reads the StatusContext variant gh emits for commit statuses', () => {
    expect(summarizeCheckRollup([
      { __typename: 'StatusContext', context: 'ci/circleci', state: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'ci/other', state: 'PENDING' },
    ])).toEqual({ state: 'pending', total: 2, passed: 1, failed: 0, pending: 1 });

    expect(summarizeCheckRollup([
      { __typename: 'StatusContext', context: 'ci/circleci', state: 'ERROR' },
    ]).state).toBe('failing');
  });

  it('counts an unrecognisable entry as pending rather than dropping it', () => {
    // An entry we cannot classify is emphatically not a passing one.
    const checks = summarizeCheckRollup([{ __typename: 'Something' }, 42]);
    expect(checks).toEqual({ state: 'pending', total: 2, passed: 0, failed: 0, pending: 2 });
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parsePrList / parseIssueList', () => {
  it('drops entries that cannot name their own number, title, url or state', () => {
    const prs = parsePrList([
      { number: 0, title: 't', url: 'https://x', state: 'OPEN' },
      { number: 1, title: '', url: 'https://x', state: 'OPEN' },
      { number: 2, title: 't', url: '', state: 'OPEN' },
      { number: 3, title: 't', url: 'https://x', state: '' },
      'not an object',
      { number: 5, title: 't', url: 'https://x', state: 'OPEN' },
    ]);
    expect(prs.map((p) => p.number)).toEqual([5]);
    expect(parsePrList('nope')).toEqual([]);
    expect(parseIssueList(null)).toEqual([]);
  });

  it('normalises a ghost author to an empty string rather than null', () => {
    const [pr] = parsePrList([
      { number: 1, title: 't', url: 'https://x', state: 'OPEN', author: null },
    ]);
    expect(pr?.author).toBe('');
  });

  it('keeps only well-formed label names', () => {
    const [issue] = parseIssueList([
      {
        number: 1, title: 't', url: 'https://x', state: 'OPEN',
        labels: [{ name: 'ok' }, { name: '' }, 'bare', { nope: 1 }],
      },
    ]);
    expect(issue?.labels).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

describe('readVerseGithubRepo', () => {
  it('surfaces the remote, the default branch, open PRs with CI state, and issues', () => {
    const calls: GhCall[] = [];
    const snap = read({ gh: ghFrom({ pr: PR_FIXTURE, issue: ISSUE_FIXTURE }, calls) });

    expect(snap.remote).toEqual({
      state: 'github',
      nameWithOwner: 'ashlrai/ashlr-hub',
      defaultBranch: 'main',
    });
    expect(snap.prsAvailable).toBe(true);
    expect(snap.issuesAvailable).toBe(true);
    expect(snap.observedAt).toBe('2026-09-22T12:00:00.000Z');
    expect(snap.name).toBe('fixture-repo');

    expect(snap.prs).toHaveLength(2);
    expect(snap.prs[0]).toMatchObject({
      number: 406,
      state: 'open',
      author: 'masonwyatt',
      draft: false,
      headRefName: 'verse-github-surface',
      baseRefName: 'verse',
    });
    expect(snap.prs[0]?.checks).toEqual({
      state: 'failing', total: 3, passed: 1, failed: 1, pending: 1,
    });
    expect(snap.prs[1]).toMatchObject({ number: 324, draft: true, author: '' });
    expect(snap.prs[1]?.checks.state).toBe('none');

    expect(snap.issues).toEqual([
      {
        number: 12,
        title: 'Approvals should name the branch',
        url: 'https://github.com/ashlrai/ashlr-hub/issues/12',
        state: 'open',
        author: 'masonwyatt',
        labels: ['verse', 'ux'],
      },
    ]);
    expect(snap.detail).toBe('2 open pull requests, 1 open issue');
  });

  it('asks gh for statusCheckRollup, which listPrs() does not request', () => {
    const calls: GhCall[] = [];
    read({ gh: ghFrom({ pr: PR_FIXTURE, issue: ISSUE_FIXTURE }, calls) });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.cwd).toBe(REPO);
    expect(calls[0]?.args).toEqual([
      'pr', 'list', '--state', 'open', '--limit', '20', '--json',
      'number,title,url,state,author,isDraft,headRefName,baseRefName,statusCheckRollup',
    ]);
    expect(calls[1]?.args).toEqual([
      'issue', 'list', '--state', 'open', '--limit', '20', '--json',
      'number,title,url,state,author,labels',
    ]);
  });

  it('clamps the requested limits into gh\'s accepted 1..100 range', () => {
    const wide: GhCall[] = [];
    read({ gh: ghFrom({ pr: '[]', issue: '[]' }, wide), prLimit: 5_000, issueLimit: 0 });
    expect(wide[0]?.args).toContain('100');
    expect(wide[1]?.args).toContain('1');
  });

  it('separates "could not look" from "nothing open"', () => {
    const blind = read({ gh: ghFrom({ pr: null, issue: null }) });
    expect(blind.prsAvailable).toBe(false);
    expect(blind.issuesAvailable).toBe(false);
    expect(blind.prs).toEqual([]);
    expect(blind.detail).toMatch(/gh could not answer/);

    const empty = read({ gh: ghFrom({ pr: '[]', issue: '[]' }) });
    expect(empty.prsAvailable).toBe(true);
    expect(empty.issuesAvailable).toBe(true);
    expect(empty.detail).toBe('0 open pull requests, 0 open issues');

    const half = read({ gh: ghFrom({ pr: PR_FIXTURE, issue: null }) });
    expect(half.prsAvailable).toBe(true);
    expect(half.issuesAvailable).toBe(false);
    expect(half.detail).toBe('2 open pull requests, issues unavailable');
  });

  it('treats a non-array gh payload as unavailable, not as an empty list', () => {
    const snap = read({ gh: ghFrom({ pr: '{"message":"Bad credentials"}', issue: 'not json' }) });
    expect(snap.prsAvailable).toBe(false);
    expect(snap.issuesAvailable).toBe(false);
  });

  it('degrades without calling gh at all when the root is not a GitHub repo', () => {
    const calls: GhCall[] = [];
    const gh = ghFrom({ pr: PR_FIXTURE, issue: ISSUE_FIXTURE }, calls);

    const notADir = read({ gh, isDirectory: () => false });
    expect(notADir.remote.state).toBe('not-a-repo');
    expect(notADir.detail).toBe('not a directory');

    const notGit = read({ gh, git: { ...githubGit, isRepo: () => false } });
    expect(notGit.remote.state).toBe('not-a-repo');
    expect(notGit.detail).toBe('not a git repository');

    const notGithub = read({ gh, git: { ...githubGit, nameWithOwner: () => null } });
    expect(notGithub.remote).toEqual({
      state: 'not-github',
      nameWithOwner: null,
      // The local default branch is still knowable and still useful.
      defaultBranch: 'main',
    });

    expect(calls).toHaveLength(0);
  });

  it('answers identity only, without invoking gh, when lists are not requested', () => {
    const calls: GhCall[] = [];
    const snap = read({
      gh: ghFrom({ pr: PR_FIXTURE, issue: ISSUE_FIXTURE }, calls),
      includeLists: false,
    });
    expect(calls).toHaveLength(0);
    expect(snap.remote).toEqual({
      state: 'github', nameWithOwner: 'ashlrai/ashlr-hub', defaultBranch: 'main',
    });
    expect(snap.listsRequested).toBe(false);
    expect(snap.prsAvailable).toBe(false);
    expect(snap.detail).toBe('pull requests and issues not requested for this root');
  });

  it('marks a full read as one that actually asked gh', () => {
    const snap = read({ gh: ghFrom({ pr: '[]', issue: '[]' }) });
    expect(snap.listsRequested).toBe(true);
  });

  it('refuses a relative or absurd path without touching the disk', () => {
    expect(readVerseGithubRepo('relative/path', { git: githubGit }).detail)
      .toBe('path is not absolute');
    expect(readVerseGithubRepo('/' + 'x'.repeat(5_000), { git: githubGit }).detail)
      .toBe('invalid path');
  });

  it('never throws when the git probe does', () => {
    const exploding: VerseGithubGitProbe = {
      isRepo: () => { throw new Error('git exploded'); },
      defaultBranch: () => { throw new Error('git exploded'); },
      nameWithOwner: () => { throw new Error('git exploded'); },
    };
    expect(() => read({ gh: ghFrom({}), git: exploding })).not.toThrow();
    expect(read({ gh: ghFrom({}), git: exploding }).remote.state).toBe('not-a-repo');
  });
});

describe('readVerseGithubSnapshot', () => {
  it('reads each root once, in order', () => {
    const calls: GhCall[] = [];
    const snap = readVerseGithubSnapshot(['/tmp/a', '/tmp/b', '/tmp/a'], {
      gh: ghFrom({ pr: '[]', issue: '[]' }, calls),
      git: githubGit,
      isDirectory: () => true,
    });
    expect(snap.repos.map((r) => r.path)).toEqual(['/tmp/a', '/tmp/b']);
    expect(calls.map((c) => c.cwd)).toEqual(['/tmp/a', '/tmp/a', '/tmp/b', '/tmp/b']);
  });
});

// ---------------------------------------------------------------------------
// Credential containment
// ---------------------------------------------------------------------------

describe('no remote URL reaches the snapshot', () => {
  it('reads repository identity only as owner/name, never as a URL', () => {
    // core/git.ts accepts `https://<userinfo>@github.com/o/r` as a supported
    // transport, so a push URL can carry a token. If this module ever starts
    // reading one, this test is the thing that notices.
    const snap = read({ gh: ghFrom({ pr: PR_FIXTURE, issue: ISSUE_FIXTURE }) });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('@github.com');
    expect(serialized).not.toContain('git@');
    expect(serialized).not.toContain('x-access-token');
    for (const match of serialized.match(/https:\/\/[^"]+/g) ?? []) {
      // The only URLs present are the ones gh minted for PRs and issues.
      expect(match).toMatch(/^https:\/\/github\.com\/ashlrai\/ashlr-hub\/(pull|issues)\/\d+$/);
    }
  });

  it('does not reference the URL-bearing half of core/git.ts', () => {
    // Source-level guard: resolveGitHubOriginAuthorityDetails() returns
    // fetchUrls/pushUrls/pushUrl. Only the URL-free resolver may be imported.
    // Comments are stripped first — this module's own header explains the rule
    // by naming the forbidden symbols, and that prose is not a reference.
    expect(READER_CODE).not.toContain('resolveGitHubOriginAuthorityDetails');
    expect(READER_CODE).toContain('resolveGitHubOriginAuthority');
    expect(READER_CODE).not.toContain('pushUrl');
    expect(READER_CODE).not.toContain('fetchUrls');
  });

  it('never forwards gh stderr, which can echo a token-bearing remote', () => {
    expect(READER_CODE).not.toContain('res.stderr');
  });
});
