/**
 * Fixtures for the C5 git UI tests: a branch status and a PR, each overridable.
 */
import type { VerseGitPr } from '../../../data/api-types.js';
import type { GitStatusView } from './git-model.js';

export function status(over: Partial<GitStatusView> = {}): GitStatusView {
  return {
    root: '~/code/ashlr-hub',
    gitRoot: '~/code/ashlr-hub',
    name: 'ashlr-hub',
    branch: 'feat/branch-bar',
    upstream: 'origin/feat/branch-bar',
    base: 'main',
    ahead: 0,
    behind: 0,
    dirty: 0,
    conflicts: 0,
    diffstat: { files: 12, additions: 35_079, deletions: 1_074 },
    pr: null,
    prLookup: 'ok',
    prCheckCounts: null,
    suggested: 'create-pr',
    headSubject: 'feat: branch bar above the composer',
    headSha: 'a'.repeat(40),
    checkedAt: '2026-09-24T12:00:00.000Z',
    ...over,
  };
}

export function pr(over: Partial<VerseGitPr> = {}): VerseGitPr {
  return {
    number: 463,
    title: 'verse context orchestration',
    url: 'https://github.com/ashlrai/ashlr-hub/pull/463',
    state: 'open',
    checks: 'passing',
    mergeable: true,
    headSha: 'a'.repeat(40),
    baseRef: 'main',
    headRef: 'feat/branch-bar',
    ...over,
  };
}
