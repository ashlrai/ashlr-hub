/**
 * V3.10 unit C5 — git, review and PR operations behind the branch bar and the
 * Review pane (src/core/verse/git-ops.ts, worktrees.ts).
 *
 * Every git and gh call goes to an injected FAKE runner that answers from a
 * scripted repository and records the argv it was given. Nothing here starts
 * a process, touches a real repository, or reaches GitHub (SPEC-310C §7 C5:
 * "Fake git/gh"). The rules under test are the ones the spec names:
 * push happens before the PR is opened; merge is refused unless checks pass
 * and the head SHA matches; never `--admin`; a busy root returns 409; and the
 * suggested-action table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EMPTY_TREE_SHA,
  GitBusyError,
  GitOpError,
  PR_FRESH_MS,
  classifyGitFailure,
  commitChanges,
  gitChildEnv,
  isSafeBranchName,
  isSafeRepoPath,
  invalidateGitCaches,
  mergePullRequest,
  mergeRefusal,
  openPullRequest,
  parseGhPr,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainV2,
  pushBranch,
  readGitDiff,
  readGitStatus,
  suggestGitAction,
  type GitRunResult,
  type GitRunner,
  type SuggestInput,
} from '../src/core/verse/git-ops.js';
import { createWorktree, isValidWorktreeName, worktreeRepoSegment } from '../src/core/verse/worktrees.js';
import { VERSE_GIT_PATCH_MAX_BYTES, type VerseGitPr } from '../src/core/verse/workbench-types.js';

// ===========================================================================
// A scripted repository
// ===========================================================================

const REPO = '/work/ashlr-hub';
const HEAD_SHA = 'a'.repeat(40);
const MB_SHA = 'b'.repeat(40);

interface Call {
  bin: 'git' | 'gh';
  args: string[];
}

function ok(stdout = ''): GitRunResult {
  return { code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false };
}
function fail(stderr: string, code = 1): GitRunResult {
  return { code, stdout: '', stderr, timedOut: false, truncated: false, missing: false };
}

interface Scenario {
  porcelain: string[];
  originHead: string | null;
  refs: Set<string>;
  numstat: string;
  nameStatus: string;
  workingNumstat: string;
  workingNameStatus: string;
  revCount: number;
  subject: string;
  remotes: string;
  ghView: (selector: string) => GitRunResult;
  ghCreate: () => GitRunResult;
  ghMerge: () => GitRunResult;
  push: () => GitRunResult;
  commit: () => GitRunResult;
  patch: (args: string[]) => GitRunResult;
  indexLock: boolean;
}

function prJson(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    number: 463,
    title: 'verse context orchestration',
    url: 'https://github.com/ashlrai/ashlr-hub/pull/463',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    headRefOid: HEAD_SHA,
    baseRefName: 'main',
    headRefName: 'feat/bar',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    ...over,
  });
}

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    porcelain: [
      `# branch.oid ${HEAD_SHA}`,
      '# branch.head feat/bar',
      '# branch.upstream origin/feat/bar',
      '# branch.ab +0 -0',
    ],
    originHead: 'origin/main',
    refs: new Set(['origin/main', 'refs/remotes/origin/main']),
    numstat: ['10\t2\tsrc/a.ts', '0\t5\tsrc/b.ts', ''].join('\0'),
    nameStatus: ['M', 'src/a.ts', 'D', 'src/b.ts', ''].join('\0'),
    workingNumstat: '',
    workingNameStatus: '',
    revCount: 3,
    subject: 'feat: branch bar',
    remotes: 'origin\n',
    ghView: () => fail('no pull requests found for branch "feat/bar"'),
    ghCreate: () => ok('https://github.com/ashlrai/ashlr-hub/pull/464\n'),
    ghMerge: () => ok(''),
    push: () => ok(''),
    commit: () => ok('[feat/bar abc] msg'),
    patch: () => ok('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n'),
    indexLock: false,
    ...over,
  };
}

/** Strip the `-c key=value` read prefix git-ops puts on every read. */
function bare(args: readonly string[]): string[] {
  const out = [...args];
  while (out[0] === '-c') out.splice(0, 2);
  return out;
}

function fakeGit(s: Scenario, toplevel: string | null = REPO) {
  const calls: Call[] = [];
  const runner: GitRunner = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    if (bin === 'gh') {
      const [cmd, sub, selector] = args;
      if (cmd === 'pr' && sub === 'view') return s.ghView(selector ?? '');
      if (cmd === 'pr' && sub === 'create') return s.ghCreate();
      if (cmd === 'pr' && sub === 'merge') return s.ghMerge();
      return fail('unknown gh');
    }
    const a = bare(args);
    switch (a[0]) {
      case 'rev-parse':
        if (a[1] === '--show-toplevel') return toplevel ? ok(`${toplevel}\n`) : fail('fatal: not a git repository', 128);
        if (a[1] === '--git-path') return ok('.git/index.lock\n');
        if (a[1] === '--verify') {
          const ref = (a[3] ?? '').replace(/\^\{commit\}$/, '');
          return s.refs.has(ref) || ref === 'HEAD' ? ok(`${HEAD_SHA}\n`) : fail('', 1);
        }
        return fail('?');
      case 'status':
        return ok(s.porcelain.join('\0') + '\0');
      case 'log':
        return ok(`${s.subject}\n`);
      case 'symbolic-ref':
        return s.originHead ? ok(`${s.originHead}\n`) : fail('', 1);
      case 'merge-base':
        return ok(`${MB_SHA}\n`);
      case 'rev-list':
        return ok(`${s.revCount}\n`);
      case 'diff': {
        if (a.includes('--numstat')) return ok(a.includes(MB_SHA) ? s.numstat : s.workingNumstat);
        if (a.includes('--name-status')) return ok(a.includes(MB_SHA) ? s.nameStatus : s.workingNameStatus);
        return s.patch(a);
      }
      case 'remote':
        return ok(s.remotes);
      case 'add':
        return ok('');
      case 'commit':
        return s.commit();
      case 'push':
        return s.push();
      case 'show-ref':
        return s.refs.has(a[3] ?? '') ? ok('') : fail('', 1);
      case 'worktree':
        return ok('');
      default:
        return fail(`unexpected git ${a.join(' ')}`);
    }
  };
  let now = 1_000_000;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const opts = {
    runner,
    now: clock.now,
    countUntracked: async () => ({ lines: 7, binary: false }),
    exists: (p: string) => s.indexLock && p.endsWith('index.lock'),
  };
  return { calls, runner, clock, opts };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => invalidateGitCaches());
afterEach(() => invalidateGitCaches());

// ===========================================================================
// Parsers
// ===========================================================================

describe('parsePorcelainV2', () => {
  it('reads branch, upstream, ahead/behind and every kind of entry', () => {
    const raw = [
      `# branch.oid ${HEAD_SHA}`,
      '# branch.head feat/with space',
      '# branch.upstream origin/feat/with space',
      '# branch.ab +3 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts',
      'src/old.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
      '? notes/todo.md',
      '1 D. N... 100644 000000 000000 aaa 000 src/gone.ts',
      '',
    ].join('\0');
    const s = parsePorcelainV2(raw);
    expect(s.branch).toBe('feat/with space');
    expect(s.oid).toBe(HEAD_SHA);
    expect(s.upstream).toBe('origin/feat/with space');
    expect([s.ahead, s.behind]).toEqual([3, 1]);
    expect(s.conflicts).toBe(1);
    expect(s.changed).toEqual([
      { path: 'src/a b.ts', oldPath: null, status: 'M', untracked: false },
      { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'R', untracked: false },
      { path: 'src/conflict.ts', oldPath: null, status: 'U', untracked: false },
      { path: 'notes/todo.md', oldPath: null, status: 'A', untracked: true },
      { path: 'src/gone.ts', oldPath: null, status: 'D', untracked: false },
    ]);
  });

  it('knows a detached HEAD and an unborn branch', () => {
    const s = parsePorcelainV2(['# branch.oid (initial)', '# branch.head (detached)', ''].join('\0'));
    expect(s.branch).toBeNull();
    expect(s.oid).toBeNull();
    expect(s.upstream).toBeNull();
  });
});

describe('numstat and name-status', () => {
  it('parses renames, binaries and plain files', () => {
    const raw = ['4\t1\tsrc/a.ts', '-\t-\tlogo.png', '2\t2\t', 'src/old.ts', 'src/new.ts', ''].join('\0');
    expect(parseNumstatZ(raw)).toEqual([
      { path: 'src/a.ts', oldPath: null, additions: 4, deletions: 1, binary: false },
      { path: 'logo.png', oldPath: null, additions: 0, deletions: 0, binary: true },
      { path: 'src/new.ts', oldPath: 'src/old.ts', additions: 2, deletions: 2, binary: false },
    ]);
    const names = parseNameStatusZ(['M', 'src/a.ts', 'R087', 'src/old.ts', 'src/new.ts', 'A', 'x', 'U', 'y', 'T', 'z', ''].join('\0'));
    expect(names.get('src/a.ts')).toEqual({ status: 'M', oldPath: null });
    expect(names.get('src/new.ts')).toEqual({ status: 'R', oldPath: 'src/old.ts' });
    expect(names.get('x')?.status).toBe('A');
    expect(names.get('y')?.status).toBe('U');
    expect(names.get('z')?.status).toBe('M');
  });
});

describe('parseGhPr', () => {
  it('maps state, draft, mergeability and the check rollup', () => {
    const open = parseGhPr(JSON.parse(prJson()))!;
    expect(open.pr).toMatchObject({ number: 463, state: 'open', checks: 'passing', mergeable: true, headSha: HEAD_SHA, baseRef: 'main', headRef: 'feat/bar' });
    expect(open.counts).toEqual({ total: 2, passed: 2, failed: 0, pending: 0 });
    expect(parseGhPr(JSON.parse(prJson({ isDraft: true })))!.pr.state).toBe('draft');
    expect(parseGhPr(JSON.parse(prJson({ state: 'MERGED' })))!.pr.state).toBe('merged');
    expect(parseGhPr(JSON.parse(prJson({ mergeable: 'UNKNOWN' })))!.pr.mergeable).toBeNull();
    expect(parseGhPr(JSON.parse(prJson({ mergeable: 'CONFLICTING' })))!.pr.mergeable).toBe(false);
    const failing = parseGhPr(JSON.parse(prJson({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }] })))!;
    expect(failing.pr.checks).toBe('failing');
    expect(parseGhPr(JSON.parse(prJson({ statusCheckRollup: [] })))!.pr.checks).toBe('none');
  });

  it('refuses a payload that cannot name its number and https URL', () => {
    expect(parseGhPr({ number: 1, url: 'javascript:alert(1)' })).toBeNull();
    expect(parseGhPr({ url: 'https://github.com/x' })).toBeNull();
    expect(parseGhPr(null)).toBeNull();
  });
});

// ===========================================================================
// The suggested-action table (SPEC-310C §2)
// ===========================================================================

describe('suggestGitAction', () => {
  const pr = (over: Partial<VerseGitPr> = {}): VerseGitPr => ({
    number: 1, title: 't', url: 'https://github.com/o/r/pull/1', state: 'open', checks: 'passing',
    mergeable: true, headSha: HEAD_SHA, baseRef: 'main', headRef: 'feat/bar', ...over,
  });
  const base: SuggestInput = {
    branch: 'feat/bar', base: 'main', dirty: 0, conflicts: 0, upstream: 'origin/feat/bar', ahead: 0,
    shipFiles: 3, commitsAheadOfBase: 2, pr: null, prLookup: 'ok',
  };
  const rows: Array<[string, Partial<SuggestInput>, ReturnType<typeof suggestGitAction>]> = [
    ['detached HEAD', { branch: null, dirty: 4 }, 'none'],
    ['conflicts block everything', { conflicts: 1, dirty: 3 }, 'none'],
    ['uncommitted work → commit', { dirty: 2 }, 'commit'],
    ['dirty wins over an open PR', { dirty: 1, pr: pr() }, 'commit'],
    ['new branch, never pushed → push', { upstream: null }, 'push'],
    ['ahead of upstream → push', { ahead: 2 }, 'push'],
    ['ahead of upstream with an open PR → push first', { ahead: 1, pr: pr() }, 'push'],
    ['green, mergeable, open PR → merge', { pr: pr() }, 'merge'],
    ['checks pending → view', { pr: pr({ checks: 'pending' }) }, 'view-pr'],
    ['checks failing → view', { pr: pr({ checks: 'failing' }) }, 'view-pr'],
    ['no checks at all → view (never merge unverified)', { pr: pr({ checks: 'none' }) }, 'view-pr'],
    ['mergeability unknown → view', { pr: pr({ mergeable: null }) }, 'view-pr'],
    ['conflicting PR → view', { pr: pr({ mergeable: false }) }, 'view-pr'],
    ['draft PR → view', { pr: pr({ state: 'draft' }) }, 'view-pr'],
    ['merged PR → view', { pr: pr({ state: 'merged' }) }, 'view-pr'],
    ['pushed, commits ahead of base, no PR → create', {}, 'create-pr'],
    ['GitHub not asked yet → none, never a guess', { prLookup: 'pending' }, 'none'],
    ['GitHub unreachable → none', { prLookup: 'unavailable' }, 'none'],
    ['on the base branch, clean and pushed → none', { branch: 'main' }, 'none'],
    ['on the base branch with unpushed commits → push', { branch: 'main', ahead: 1 }, 'push'],
    ['nothing ahead of base → none', { shipFiles: 0, commitsAheadOfBase: 0 }, 'none'],
    ['empty new branch with no upstream → none', { upstream: null, commitsAheadOfBase: 0, shipFiles: 0 }, 'none'],
  ];
  it.each(rows)('%s', (_label, over, expected) => {
    expect(suggestGitAction({ ...base, ...over })).toBe(expected);
  });
});

// ===========================================================================
// Status
// ===========================================================================

describe('readGitStatus', () => {
  it('reports the branch against its base, untracked files included, and never waits on GitHub', async () => {
    const s = scenario({
      porcelain: [...scenario().porcelain, '? notes/new.md'],
    });
    const f = fakeGit(s);
    const status = await readGitStatus(`${REPO}/src`, f.opts);
    expect(status.root).toBe(`${REPO}/src`);
    expect(status.gitRoot).toBe(REPO);
    expect(status.name).toBe('ashlr-hub');
    expect(status.base).toBe('main');
    expect(status.dirty).toBe(1);
    // 10+0 tracked additions + 7 lines of the untracked file; 2+5 deletions.
    expect(status.diffstat).toEqual({ files: 3, additions: 17, deletions: 7 });
    expect(status.prLookup).toBe('pending');
    expect(status.pr).toBeNull();
    expect(status.suggested).toBe('commit');
    expect(status.headSubject).toBe('feat: branch bar');
    // The PR lookup was started, in the background.
    expect(f.calls.some((c) => c.bin === 'gh' && c.args.slice(0, 2).join(' ') === 'pr view')).toBe(true);
  });

  it('suggests Create PR once GitHub answers "no PR", and caches for 5 s', async () => {
    const f = fakeGit(scenario());
    const first = await readGitStatus(REPO, f.opts);
    expect(first.suggested).toBe('none');
    expect(first.prLookup).toBe('pending');
    await flush();
    const callsBefore = f.calls.length;
    const second = await readGitStatus(REPO, f.opts);
    expect(second.prLookup).toBe('ok');
    expect(second.pr).toBeNull();
    expect(second.suggested).toBe('create-pr');
    // Served from cache: no git ran for the second read.
    expect(f.calls.slice(callsBefore).filter((c) => c.bin === 'git')).toEqual([]);
    f.clock.advance(5_001);
    await readGitStatus(REPO, f.opts);
    expect(f.calls.slice(callsBefore).some((c) => c.bin === 'git' && bare(c.args)[0] === 'status')).toBe(true);
  });

  it('suggests Merge for a green, mergeable PR and measures against the PR’s base', async () => {
    const f = fakeGit(scenario({ ghView: () => ok(prJson({ baseRefName: 'develop' })), refs: new Set(['origin/main', 'refs/remotes/origin/main', 'origin/develop']) }));
    await readGitStatus(REPO, f.opts);
    await flush();
    f.clock.advance(5_001);
    const status = await readGitStatus(REPO, f.opts);
    expect(status.pr?.number).toBe(463);
    expect(status.base).toBe('develop');
    expect(status.suggested).toBe('merge');
    expect(status.prCheckCounts).toEqual({ total: 2, passed: 2, failed: 0, pending: 0 });
  });

  it('says "unavailable", not "no PR", when gh cannot answer', async () => {
    const f = fakeGit(scenario({ ghView: () => fail('HTTP 401: Bad credentials (https://api.github.com/graphql)') }));
    await readGitStatus(REPO, f.opts);
    await flush();
    const status = await readGitStatus(REPO, f.opts);
    expect(status.prLookup).toBe('unavailable');
    expect(status.suggested).toBe('none');
  });

  it('re-asks GitHub after PR_FRESH_MS without blocking the read', async () => {
    const f = fakeGit(scenario());
    await readGitStatus(REPO, f.opts);
    await flush();
    const views = () => f.calls.filter((c) => c.bin === 'gh').length;
    const before = views();
    f.clock.advance(PR_FRESH_MS + 1);
    await readGitStatus(REPO, f.opts);
    expect(views()).toBe(before + 1);
  });

  it('a folder outside any repository is VERSE_GIT_NOT_A_REPO', async () => {
    const f = fakeGit(scenario(), null);
    await expect(readGitStatus('/tmp/plain', f.opts)).rejects.toMatchObject({ code: 'VERSE_GIT_NOT_A_REPO', status: 404 });
  });
});

// ===========================================================================
// Diff
// ===========================================================================

describe('readGitDiff', () => {
  it('lists the working scope against HEAD and the branch scope against the merge base', async () => {
    const s = scenario({ workingNumstat: ['1\t1\tsrc/a.ts', ''].join('\0'), workingNameStatus: ['M', 'src/a.ts', ''].join('\0') });
    const f = fakeGit(s);
    const working = await readGitDiff(REPO, 'working', null, f.opts);
    expect(working.files.map((x) => [x.path, x.status, x.additions])).toEqual([['src/a.ts', 'M', 1]]);
    expect(working.patch).toBeNull();
    expect(f.calls.some((c) => bare(c.args)[0] === 'diff' && c.args.includes(HEAD_SHA))).toBe(true);
    const branch = await readGitDiff(REPO, 'branch', null, f.opts);
    expect(branch.base).toBe('main');
    expect(branch.files.map((x) => `${x.status} ${x.path}`)).toEqual(['M src/a.ts', 'D src/b.ts']);
  });

  it('diffs an unborn branch against the empty tree', async () => {
    const f = fakeGit(scenario({ porcelain: ['# branch.oid (initial)', '# branch.head main'] }));
    await readGitDiff(REPO, 'working', null, f.opts);
    expect(f.calls.some((c) => c.args.includes(EMPTY_TREE_SHA))).toBe(true);
  });

  it('serves a patch only for a file the scope lists', async () => {
    const f = fakeGit(scenario());
    const d = await readGitDiff(REPO, 'branch', 'src/a.ts', f.opts);
    expect(d.patch?.path).toBe('src/a.ts');
    expect(d.patch?.truncated).toBe(false);
    await expect(readGitDiff(REPO, 'branch', 'etc/passwd', f.opts)).rejects.toMatchObject({ code: 'VERSE_GIT_REFUSED' });
    await expect(readGitDiff(REPO, 'branch', '../secrets', f.opts)).rejects.toMatchObject({ code: 'VERSE_INVALID' });
  });

  it('caps a patch at 256 KB, on a line boundary, and says so', async () => {
    const line = `+${'x'.repeat(99)}\n`;
    const big = 'diff --git a/src/a.ts b/src/a.ts\n' + line.repeat(3000);
    const f = fakeGit(scenario({
      patch: () => ({ ...ok(big.slice(0, VERSE_GIT_PATCH_MAX_BYTES + 1)), code: null, truncated: true }),
    }));
    const d = await readGitDiff(REPO, 'branch', 'src/a.ts', f.opts);
    expect(d.patch?.truncated).toBe(true);
    expect(Buffer.byteLength(d.patch!.text)).toBeLessThanOrEqual(VERSE_GIT_PATCH_MAX_BYTES);
    expect(d.patch!.text.endsWith('\n')).toBe(true);
    const patchCall = f.calls.find((c) => bare(c.args)[0] === 'diff' && c.args.includes('--no-color'));
    expect(patchCall?.args).toContain('--');
  });

  it('shows an untracked file with --no-index (exit 1 is success there)', async () => {
    const f = fakeGit(scenario({
      porcelain: [...scenario().porcelain, '? notes/new.md'],
      patch: (a) => (a.includes('--no-index') ? { ...ok('--- /dev/null\n+++ b/notes/new.md\n@@ -0,0 +1 @@\n+hi\n'), code: 1 } : ok('')),
    }));
    const d = await readGitDiff(REPO, 'working', 'notes/new.md', f.opts);
    expect(d.patch?.text).toContain('+hi');
  });
});

// ===========================================================================
// Mutations
// ===========================================================================

function gitOps(calls: Call[]): string[] {
  return calls.filter((c) => c.bin === 'git').map((c) => bare(c.args)[0]!);
}

describe('commit', () => {
  const dirty = () => scenario({ porcelain: [...scenario().porcelain, '1 .M N... 100644 100644 100644 a b src/a.ts', '? notes/new.md'] });

  it('stages everything and commits with the message as one argv entry', async () => {
    const f = fakeGit(dirty());
    await commitChanges(REPO, { message: '--amend; rm -rf /' }, f.opts);
    const add = f.calls.find((c) => bare(c.args)[0] === 'add')!;
    const commit = f.calls.find((c) => bare(c.args)[0] === 'commit')!;
    expect(bare(add.args)).toEqual(['add', '-A']);
    expect(bare(commit.args)).toEqual(['commit', '-m', '--amend; rm -rf /']);
  });

  it('commits only the chosen paths, and only paths that are current changes', async () => {
    const f = fakeGit(dirty());
    await commitChanges(REPO, { message: 'x', paths: ['notes/new.md'] }, f.opts);
    expect(bare(f.calls.find((c) => bare(c.args)[0] === 'commit')!.args)).toEqual(['commit', '-m', 'x', '--', 'notes/new.md']);
    await expect(commitChanges(REPO, { message: 'x', paths: ['src/unchanged.ts'] }, fakeGit(dirty()).opts)).rejects.toMatchObject({ code: 'VERSE_INVALID' });
  });

  it('refuses a detached HEAD, conflicts and an empty tree', async () => {
    const detached = scenario({ porcelain: ['# branch.oid x', '# branch.head (detached)', '1 .M N... 1 1 1 a b f'] });
    await expect(commitChanges(REPO, { message: 'x' }, fakeGit(detached).opts)).rejects.toMatchObject({ code: 'VERSE_GIT_REFUSED' });
    const conflicted = scenario({ porcelain: [...scenario().porcelain, 'u UU N... 1 1 1 1 a b c f'] });
    await expect(commitChanges(REPO, { message: 'x' }, fakeGit(conflicted).opts)).rejects.toMatchObject({ code: 'VERSE_GIT_REFUSED' });
    await expect(commitChanges(REPO, { message: 'x' }, fakeGit(scenario()).opts)).rejects.toThrow('nothing to commit');
  });

  it('turns a failing hook into one sentence, never its output', async () => {
    const f = fakeGit(scenario({
      porcelain: dirty().porcelain,
      commit: () => fail('husky - pre-commit hook exited with code 1 (error)\n/Users/op/secret/path/file.ts: lint failed'),
    }));
    const err = await commitChanges(REPO, { message: 'x' }, f.opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitOpError);
    expect((err as Error).message).toContain('git hook');
    expect((err as Error).message).not.toContain('/Users/op');
  });
});

describe('push', () => {
  it('publishes a new branch with -u origin HEAD and never forces', async () => {
    const f = fakeGit(scenario({ porcelain: [`# branch.oid ${HEAD_SHA}`, '# branch.head feat/bar'] }));
    await pushBranch(REPO, f.opts);
    const push = f.calls.find((c) => bare(c.args)[0] === 'push')!;
    expect(bare(push.args)).toEqual(['push', '-u', 'origin', 'HEAD']);
    for (const c of f.calls) expect(c.args.join(' ')).not.toMatch(/--force|-f\b|\+HEAD/);
  });

  it('pushes to the upstream when there is one, and refuses when nothing is ahead', async () => {
    const ahead = scenario({ porcelain: [...scenario().porcelain.slice(0, 3), '# branch.ab +2 -0'] });
    const f = fakeGit(ahead);
    await pushBranch(REPO, f.opts);
    expect(bare(f.calls.find((c) => bare(c.args)[0] === 'push')!.args)).toEqual(['push']);
    await expect(pushBranch(REPO, fakeGit(scenario()).opts)).rejects.toThrow('already pushed');
  });

  it('refuses without an origin remote', async () => {
    const f = fakeGit(scenario({ porcelain: [`# branch.oid ${HEAD_SHA}`, '# branch.head feat/bar'], remotes: 'upstream\n' }));
    await expect(pushBranch(REPO, f.opts)).rejects.toThrow('no remote named origin');
  });

  it('classifies a rejected push without echoing the remote URL', async () => {
    const f = fakeGit(scenario({
      porcelain: [`# branch.oid ${HEAD_SHA}`, '# branch.head feat/bar'],
      push: () => fail(' ! [rejected] HEAD -> feat/bar (fetch first)\nerror: failed to push some refs to https://x-access-token:ghs_SECRET@github.com/o/r.git'),
    }));
    const err = (await pushBranch(REPO, f.opts).catch((e: unknown) => e)) as GitOpError;
    expect(err.code).toBe('VERSE_GIT_REFUSED');
    expect(err.message).toContain('Pull or rebase');
    expect(err.message).not.toContain('ghs_SECRET');
  });
});

describe('open a PR', () => {
  it('pushes BEFORE gh pr create, then returns the PR it opened', async () => {
    let created = false;
    const s = scenario({
      porcelain: [`# branch.oid ${HEAD_SHA}`, '# branch.head feat/bar'],
      ghView: () => (created ? ok(prJson({ number: 464 })) : fail('no pull requests found for branch "feat/bar"')),
      ghCreate: () => {
        created = true;
        return ok('https://github.com/ashlrai/ashlr-hub/pull/464\n');
      },
    });
    const f = fakeGit(s);
    const result = await openPullRequest(REPO, { title: 'Branch bar', body: 'why', draft: true }, f.opts);
    const order = f.calls.map((c) => (c.bin === 'gh' ? `gh ${c.args[1]}` : `git ${bare(c.args)[0]}`));
    const pushAt = order.indexOf('git push');
    const createAt = order.indexOf('gh create');
    expect(pushAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(pushAt);
    const create = f.calls.find((c) => c.bin === 'gh' && c.args[1] === 'create')!;
    expect(create.args).toEqual(['pr', 'create', '--title', 'Branch bar', '--body', 'why', '--base', 'main', '--head', 'feat/bar', '--draft']);
    expect(result.pr.number).toBe(464);
  });

  it('does not push a branch the remote already has, and returns an existing open PR instead of a second one', async () => {
    const f = fakeGit(scenario({ ghView: () => ok(prJson()) }));
    const result = await openPullRequest(REPO, { title: 'x' }, f.opts);
    expect(result.pr.number).toBe(463);
    expect(gitOps(f.calls)).not.toContain('push');
    expect(f.calls.some((c) => c.bin === 'gh' && c.args[1] === 'create')).toBe(false);
  });

  it('refuses on the base branch and on a detached HEAD', async () => {
    const onMain = scenario({ porcelain: [`# branch.oid ${HEAD_SHA}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0'] });
    await expect(openPullRequest(REPO, { title: 'x' }, fakeGit(onMain).opts)).rejects.toThrow('on main itself');
    const detached = scenario({ porcelain: [`# branch.oid ${HEAD_SHA}`, '# branch.head (detached)'] });
    await expect(openPullRequest(REPO, { title: 'x' }, fakeGit(detached).opts)).rejects.toThrow('detached');
  });
});

describe('merge', () => {
  const view = (over: Partial<Record<string, unknown>>) => () => ok(prJson(over));

  it('squash-merges with --match-head-commit, re-reading GitHub first — and never --admin or --auto', async () => {
    const f = fakeGit(scenario({ ghView: view({}) }));
    const result = await mergePullRequest(REPO, { number: 463, headSha: HEAD_SHA }, f.opts);
    const merge = f.calls.find((c) => c.bin === 'gh' && c.args[1] === 'merge')!;
    expect(merge.args).toEqual(['pr', 'merge', '463', '--squash', '--match-head-commit', HEAD_SHA]);
    for (const c of f.calls) {
      expect(c.args).not.toContain('--admin');
      expect(c.args).not.toContain('--auto');
    }
    const viewIndex = f.calls.findIndex((c) => c.bin === 'gh' && c.args[1] === 'view');
    expect(viewIndex).toBeLessThan(f.calls.indexOf(merge));
    expect(result.pr.number).toBe(463);
  });

  const refusals: Array<[string, Partial<Record<string, unknown>>, string, string]> = [
    ['checks pending', { statusCheckRollup: [{ status: 'IN_PROGRESS' }] }, HEAD_SHA, 'still running'],
    ['checks failing', { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }, HEAD_SHA, 'failing'],
    ['no checks at all', { statusCheckRollup: [] }, HEAD_SHA, 'No passing checks'],
    ['mergeability unknown', { mergeable: 'UNKNOWN' }, HEAD_SHA, 'still working out'],
    ['conflicts', { mergeable: 'CONFLICTING' }, HEAD_SHA, 'conflicts'],
    ['a draft', { isDraft: true }, HEAD_SHA, 'draft'],
    ['already merged', { state: 'MERGED' }, HEAD_SHA, 'already merged'],
    ['another branch’s PR', { headRefName: 'someone/else' }, HEAD_SHA, 'not this branch'],
    ['a head the operator never saw', {}, 'c'.repeat(40), 'new commits'],
  ];
  it.each(refusals)('refuses %s', async (_label, over, sha, message) => {
    const f = fakeGit(scenario({ ghView: view(over) }));
    await expect(mergePullRequest(REPO, { number: 463, headSha: sha }, f.opts)).rejects.toThrow(message);
    expect(f.calls.some((c) => c.bin === 'gh' && c.args[1] === 'merge')).toBe(false);
  });

  it('mergeRefusal is null only for the one safe shape', () => {
    const pr = parseGhPr(JSON.parse(prJson()))!.pr;
    expect(mergeRefusal(pr, 'feat/bar', HEAD_SHA.toUpperCase())).toBeNull();
    expect(mergeRefusal(pr, null, HEAD_SHA)).not.toBeNull();
  });
});

describe('busy root', () => {
  it('refuses a second mutation while the first runs (409, not a queue)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = scenario({ porcelain: [...scenario().porcelain, '1 .M N... 1 1 1 a b src/a.ts'] });
    const f = fakeGit(s);
    const slow: GitRunner = async (bin, args, o) => {
      if (bare(args)[0] === 'commit') await gate;
      return f.runner(bin, args, o);
    };
    const first = commitChanges(REPO, { message: 'one' }, { ...f.opts, runner: slow });
    await flush();
    const second = await commitChanges(REPO, { message: 'two' }, { ...f.opts, runner: slow }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(GitBusyError);
    expect((second as GitOpError).status).toBe(409);
    release();
    await first;
  });

  it('refuses while another process holds the index lock', async () => {
    const f = fakeGit(scenario({ indexLock: true, porcelain: [...scenario().porcelain, '1 .M N... 1 1 1 a b src/a.ts'] }));
    await expect(commitChanges(REPO, { message: 'x' }, f.opts)).rejects.toBeInstanceOf(GitBusyError);
    expect(gitOps(f.calls)).not.toContain('commit');
  });
});

// ===========================================================================
// Small rules
// ===========================================================================

describe('guards', () => {
  it('repo paths: relative, no .., no option-looking names', () => {
    for (const p of ['src/a.ts', 'a b/c.md', '.github/workflows/ci.yml']) expect(isSafeRepoPath(p)).toBe(true);
    for (const p of ['', '/etc/passwd', '../x', 'a/../../b', '-rf', 'C:\\x', 'a\0b']) expect(isSafeRepoPath(p)).toBe(false);
  });

  it('branch names', () => {
    for (const b of ['main', 'release/3.10', 'feat/x-y_z']) expect(isSafeBranchName(b)).toBe(true);
    for (const b of ['', '-x', 'a..b', 'a b', 'x.lock', 'a~1', 'a:b', 'a@{u}']) expect(isSafeBranchName(b)).toBe(false);
  });

  it('child env drops ASHLR_* and never lets git or gh prompt', () => {
    const env = gitChildEnv({ ASHLR_TOKEN: 'secret', Ashlr_Home: '/x', PATH: '/usr/bin', GH_TOKEN: 'gho_x' });
    expect(env['ASHLR_TOKEN']).toBeUndefined();
    expect(env['Ashlr_Home']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
    // gh's own credential is the operator's, for the operator's action.
    expect(env['GH_TOKEN']).toBe('gho_x');
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'true' });
  });

  it('classifies timeouts and a missing binary', () => {
    const t = classifyGitFailure('Pushing', { code: null, stdout: '', stderr: '', timedOut: true, truncated: false, missing: false });
    expect(t.code).toBe('VERSE_GIT_TIMEOUT');
    expect(t.status).toBe(504);
    const m = classifyGitFailure('Opening the PR', { code: null, stdout: '', stderr: '', timedOut: false, truncated: false, missing: true });
    expect(m.code).toBe('VERSE_GIT_GH_UNAVAILABLE');
  });
});

// ===========================================================================
// Worktrees
// ===========================================================================

describe('createWorktree', () => {
  let home: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env['HOME'];
    home = mkdtempSync(join(tmpdir(), 'c5-wt-'));
    process.env['HOME'] = home;
  });
  afterEach(() => {
    process.env['HOME'] = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('adds ~/.ashlr-worktrees/<repo>/<name> on verse/<name>, from HEAD', async () => {
    const f = fakeGit(scenario());
    const made: string[] = [];
    const out = await createWorktree(REPO, 'fix-login', { ...f.opts, pathExists: () => false, makeDir: async (p) => { made.push(p); } });
    expect(out).toEqual({ path: join(home, '.ashlr-worktrees', 'ashlr-hub', 'fix-login'), branch: 'verse/fix-login' });
    expect(made).toEqual([join(home, '.ashlr-worktrees', 'ashlr-hub')]);
    const add = f.calls.find((c) => bare(c.args)[0] === 'worktree')!;
    expect(bare(add.args)).toEqual(['worktree', 'add', '-b', 'verse/fix-login', out.path, 'HEAD']);
  });

  it('refuses an existing directory or branch, and a bad name', async () => {
    const f = fakeGit(scenario());
    await expect(createWorktree(REPO, 'x', { ...f.opts, pathExists: () => true, makeDir: async () => {} })).rejects.toThrow('already exists');
    const taken = fakeGit(scenario({ refs: new Set(['origin/main', 'refs/heads/verse/x']) }));
    await expect(createWorktree(REPO, 'x', { ...taken.opts, pathExists: () => false, makeDir: async () => {} })).rejects.toThrow('verse/x already exists');
    await expect(createWorktree(REPO, '../escape', f.opts)).rejects.toMatchObject({ code: 'VERSE_INVALID' });
    expect(isValidWorktreeName('a'.repeat(64))).toBe(false);
    expect(isValidWorktreeName('fix.lock')).toBe(false);
    expect(worktreeRepoSegment('/x/..hidden repo')).toBe('hidden-repo');
  });
});
