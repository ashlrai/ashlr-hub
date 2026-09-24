/**
 * The branch bar's and Review pane's words and decisions (unit C5), as a
 * table: labels per suggested action, disabled reasons, PR chip wording,
 * comment formatting.
 */
import { describe, expect, it } from 'vitest';
import {
  commentsToMessage,
  dedupeByRepo,
  defaultPrTitle,
  describeGitError,
  diffstatLabel,
  diffstatText,
  formatCount,
  groupFiles,
  hasBranchActivity,
  menuItems,
  prChip,
  primaryAction,
  type GitStatusView,
} from './git-model.js';
import { pr, status } from './git-fixtures.test-support.js';

describe('numbers', () => {
  it('groups digits and uses a real minus', () => {
    expect(formatCount(35079)).toBe('35,079');
    expect(diffstatText(35079, 1074)).toBe('+35,079 −1,074');
    expect(diffstatLabel(1, 3, 0)).toBe('1 file changed, 3 added, 0 removed');
  });
});

describe('primaryAction', () => {
  it.each([
    ['commit', { suggested: 'commit' as const, dirty: 3 }, 'Commit', 'Commit 3 changed files on feat/branch-bar.'],
    ['push (new branch)', { suggested: 'push' as const, upstream: null }, 'Push', 'Publish feat/branch-bar to origin.'],
    ['push (ahead)', { suggested: 'push' as const, ahead: 2 }, 'Push', 'Push 2 commits on feat/branch-bar to origin/feat/branch-bar.'],
    ['create PR', { suggested: 'create-pr' as const }, 'Create PR', 'Open a pull request from feat/branch-bar into main.'],
    ['merge', { suggested: 'merge' as const, pr: pr() }, 'Merge', 'Squash-merge #463 into main. Checks passed.'],
    ['view', { suggested: 'view-pr' as const, pr: pr({ state: 'merged' }) }, 'View PR', 'Open #463 on GitHub.'],
  ])('%s', (_l, over, label, disclosure) => {
    const a = primaryAction(status(over));
    expect(a?.label).toBe(label);
    expect(a?.disclosure).toBe(disclosure);
  });

  it('offers nothing for none, and never Merge without a PR', () => {
    expect(primaryAction(status({ suggested: 'none' }))).toBeNull();
    expect(primaryAction(status({ suggested: 'merge', pr: null }))).toBeNull();
  });
});

describe('menuItems', () => {
  const reason = (s: GitStatusView, id: string) => menuItems(s).find((m) => m.id === id)?.disabledReason;

  it('keeps every item, disabling with a reason', () => {
    const s = status();
    expect(menuItems(s).map((m) => m.id)).toEqual(['draft-pr', 'commit', 'push', 'open-github', 'copy-branch', 'review']);
    expect(reason(s, 'commit')).toBe('Nothing to commit');
    expect(reason(s, 'push')).toBe('Already pushed');
    expect(reason(s, 'open-github')).toBe('No pull request for this branch');
    expect(reason(s, 'draft-pr')).toBeNull();
    expect(reason(s, 'copy-branch')).toBeNull();
  });

  it('explains detached HEAD, conflicts, an open PR and an unreachable GitHub', () => {
    expect(reason(status({ branch: null, dirty: 2 }), 'commit')).toBe('HEAD is detached');
    expect(reason(status({ conflicts: 1, dirty: 2 }), 'commit')).toBe('Resolve the conflicts first');
    expect(reason(status({ pr: pr() }), 'draft-pr')).toBe('#463 is already open');
    expect(reason(status({ prLookup: 'unavailable' }), 'draft-pr')).toContain('GitHub is not reachable');
    expect(reason(status({ branch: 'main' }), 'draft-pr')).toBe('You are on main');
    expect(menuItems(status({ upstream: null })).find((m) => m.id === 'push')?.label).toBe('Publish branch');
  });
});

describe('prChip', () => {
  it('pairs every state with a word', () => {
    expect(prChip(pr(), { total: 9, passed: 9, failed: 0, pending: 0 })).toMatchObject({ state: 'Open', checks: '9/9 checks passed', tone: 'success' });
    expect(prChip(pr({ checks: 'failing' }), { total: 9, passed: 7, failed: 2, pending: 0 })).toMatchObject({ checks: '2 of 9 checks failing', tone: 'danger' });
    expect(prChip(pr({ checks: 'pending' }), { total: 9, passed: 3, failed: 0, pending: 6 })).toMatchObject({ checks: '6 of 9 checks running', tone: 'running' });
    expect(prChip(pr({ checks: 'unknown' }), null).checks).toBe('checks —');
    expect(prChip(pr({ mergeable: false }), null)).toMatchObject({ checks: 'checks passed, conflicts', tone: 'danger' });
    expect(prChip(pr({ state: 'merged' }), null)).toMatchObject({ state: 'Merged', checks: null, tone: 'merged' });
    expect(prChip(pr({ state: 'draft' }), null).state).toBe('Draft');
    expect(prChip(pr(), null).label).toBe('Pull request #463, verse context orchestration, Open, checks passed');
  });
});

describe('rows', () => {
  it('shows a row only when there is something to do or see', () => {
    expect(hasBranchActivity(status({ diffstat: { files: 0, additions: 0, deletions: 0 } }))).toBe(false);
    expect(hasBranchActivity(status({ diffstat: { files: 0, additions: 0, deletions: 0 }, dirty: 1 }))).toBe(true);
    expect(hasBranchActivity(status({ diffstat: { files: 0, additions: 0, deletions: 0 }, pr: pr({ state: 'draft' }) }))).toBe(true);
    expect(hasBranchActivity(status({ diffstat: { files: 0, additions: 0, deletions: 0 }, pr: pr({ state: 'merged' }) }))).toBe(false);
  });

  it('gives two roots in one repository one row', () => {
    const a = status({ root: '~/r' });
    const b = status({ root: '~/r/packages/web' });
    const c = status({ root: '~/other', gitRoot: '~/other', name: 'other' });
    expect(dedupeByRepo([a, b, c]).map((s) => s.root)).toEqual(['~/r', '~/other']);
  });
});

describe('defaultPrTitle', () => {
  it('prefers the last commit subject, else the branch made readable', () => {
    expect(defaultPrTitle(status())).toBe('feat: branch bar above the composer');
    expect(defaultPrTitle(status({ headSubject: null, branch: 'feat/branch-bar' }))).toBe('Branch bar');
    expect(defaultPrTitle(status({ headSubject: null, branch: null }))).toBe('');
  });
});

describe('groupFiles', () => {
  it('groups by directory in path order', () => {
    const f = (path: string) => ({ path, oldPath: null, status: 'M' as const, additions: 1, deletions: 0, binary: false });
    const groups = groupFiles([f('src/b.ts'), f('README.md'), f('src/a.ts'), f('src/x/y.ts')]);
    expect(groups.map((g) => [g.dir, g.files.map((x) => x.name)])).toEqual([
      ['', ['README.md']],
      ['src', ['a.ts', 'b.ts']],
      ['src/x', ['y.ts']],
    ]);
  });
});

describe('commentsToMessage', () => {
  it('writes path:line: note, sorted, multi-line notes indented, removed lines said', () => {
    const text = commentsToMessage([
      { id: '2', path: 'src/b.ts', line: 9, side: 'new', note: 'rename this' },
      { id: '1', path: 'src/a.ts', line: 40, side: 'new', note: 'guard null\nand log it' },
      { id: '3', path: 'src/a.ts', line: 3, side: 'old', note: 'why was this removed?' },
    ]);
    expect(text).toBe([
      'src/a.ts:3 (removed line): why was this removed?',
      'src/a.ts:40: guard null',
      '  and log it',
      'src/b.ts:9: rename this',
    ].join('\n'));
  });
});

describe('describeGitError', () => {
  it('prefers the server’s sentence and never leaks a raw message', () => {
    expect(describeGitError({ status: 409, detail: 'Checks are still running on this PR.' })).toBe('Checks are still running on this PR.');
    expect(describeGitError({ name: 'DispatchDisabledError', status: 404 })).toContain('read-only');
    expect(describeGitError({ name: 'VerseMutationLockedError' })).toContain('mutation token');
    expect(describeGitError(new Error('spawn /Users/op/secret ENOENT'))).not.toContain('/Users');
  });
});
