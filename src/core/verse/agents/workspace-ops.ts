/**
 * core/verse/agents/workspace-ops.ts — an agent's git worktree: create it,
 * seed it with the gitignored files it needs, snapshot it before it goes,
 * remove it, and bring it back.
 *
 * WHERE. `~/.ashlr-worktrees/<repo>/<slug>` on branch `verse/<slug>` — the
 * same Verse-managed place and branch prefix "Isolate in worktree" uses
 * (worktrees.ts `createWorktree`, which this calls), so an agent workspace
 * and an isolated chat are one kind of thing on disk.
 *
 * SNAPSHOT-BEFORE-DELETE. Removing a worktree throws away whatever the agent
 * left uncommitted. So before a worktree goes (Archive, auto-cleanup past the
 * cap, merged) its whole state — commits AND uncommitted/untracked files — is
 * written as one commit (`git add -A` in the worktree's own index, then
 * `commit-tree` on HEAD) and pinned by a PRIVATE ref,
 * `refs/ashlr/verse-archive/<slug>`: never pushed (it is not under refs/heads
 * or refs/tags), never garbage-collected while the ref exists. Restore makes
 * the branch again at the archived head, adds the worktree back, and lays the
 * snapshot's files over it as uncommitted changes — exactly as they were.
 *
 * Every git call goes through git-ops' runner (the no-prompt env, a hard
 * timeout, bounded output) under the repo lock, so it cannot collide with a
 * commit or push the branch bar is making in the same repository.
 *
 * NODE-ONLY. Async I/O only (these run behind request handlers).
 */
import { access, copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  GitOpError,
  defaultGitRunner,
  resolveGitRoot,
  withRepoLock,
  type GitOpsOptions,
  type GitRunner,
} from '../git-ops.js';
import { createWorktree, isValidWorktreeName, worktreeRepoSegment, worktreesHome } from '../worktrees.js';
import { VERSE_WORKTREE_BRANCH_PREFIX } from '../workbench-types.js';
import { isSafeCopyPath } from './workspace-config.js';
import type { AgentArchiveRecord, AgentWorkspaceRecord } from './types.js';

/** Private namespace for archive snapshots — never pushed, never a branch. */
export const ARCHIVE_REF_PREFIX = 'refs/ashlr/verse-archive/';

/** Identity for snapshot commits (a machine commit, not the operator's authorship). */
const SNAPSHOT_IDENTITY = ['-c', 'user.name=Phantom', '-c', 'user.email=verse@ashlr.invalid'] as const;

export interface WorkspaceOpsOptions extends GitOpsOptions {
  /** Test seam: does this path exist (async)? */
  probePath?: (path: string) => Promise<boolean>;
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runnerOf(opts: WorkspaceOpsOptions): GitRunner {
  return opts.runner ?? defaultGitRunner;
}

async function gitOk(run: GitRunner, cwd: string, args: readonly string[], what: string): Promise<string> {
  const res = await run('git', args, { cwd });
  if (res.code !== 0) {
    throw new GitOpError(res.timedOut ? 'VERSE_GIT_TIMEOUT' : 'VERSE_GIT_FAILED', `${what} failed.`);
  }
  return res.stdout.trim();
}

export interface CreatedWorkspace {
  workspace: Omit<AgentWorkspaceRecord, 'portBase' | 'portCount'>;
  /** Copy entries that were copied / skipped (missing in the main checkout, or already present). */
  copied: string[];
  skipped: string[];
}

/**
 * Make the agent's worktree. The slug is made unique against existing
 * worktree directories AND `verse/*` branches (so two agents titled the same
 * get `fix-login` and `fix-login-2`), then worktrees.ts creates it from HEAD.
 */
export async function createAgentWorkspace(
  root: string,
  desiredName: string,
  copy: readonly string[],
  opts: WorkspaceOpsOptions = {},
): Promise<CreatedWorkspace> {
  const run = runnerOf(opts);
  const exists = opts.probePath ?? defaultPathExists;
  const gitRoot = await resolveGitRoot(root, opts);
  if (!gitRoot) throw new GitOpError('VERSE_GIT_NOT_A_REPO', 'This folder is not a git repository.');
  if (!isValidWorktreeName(desiredName)) throw new GitOpError('VERSE_INVALID', 'A workspace name is 1–63 letters, digits, dots, dashes or underscores.');

  const parent = join(worktreesHome(), worktreeRepoSegment(gitRoot));
  const branches = await run('git', ['for-each-ref', '--format=%(refname:short)', `refs/heads/${VERSE_WORKTREE_BRANCH_PREFIX}`], { cwd: gitRoot });
  const taken = new Set(branches.code === 0 ? branches.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []);
  // First free slug: no directory there and no `verse/<slug>` branch (fix-login, fix-login-2, …).
  let name: string | null = null;
  for (let i = 1; i <= 200 && name === null; i += 1) {
    const candidate = i === 1 ? desiredName : `${desiredName.slice(0, 56)}-${i}`;
    if (!taken.has(`${VERSE_WORKTREE_BRANCH_PREFIX}${candidate}`) && !(await exists(join(parent, candidate)))) name = candidate;
  }
  if (name === null) throw new GitOpError('VERSE_GIT_REFUSED', 'Too many workspaces share this name. Pick another name.');

  const { probePath: _probe, ...worktreeOpts } = opts;
  const created = await createWorktree(gitRoot, name, worktreeOpts);
  const baseSha = await run('git', ['rev-parse', 'HEAD'], { cwd: created.path });

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const entry of copy) {
    if (!isSafeCopyPath(entry)) {
      skipped.push(entry);
      continue;
    }
    const from = join(gitRoot, entry);
    const to = join(created.path, entry);
    try {
      const info = await lstat(from);
      // Regular files only: a symlink could point anywhere on this Mac.
      if (!info.isFile()) {
        skipped.push(entry);
        continue;
      }
      if (await exists(to)) {
        skipped.push(entry);
        continue;
      }
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      copied.push(entry);
    } catch {
      skipped.push(entry);
    }
  }

  return {
    workspace: {
      rootPath: gitRoot,
      path: created.path,
      branch: created.branch,
      name,
      baseSha: baseSha.code === 0 && /^[0-9a-f]{7,64}$/.test(baseSha.stdout.trim()) ? baseSha.stdout.trim() : null,
    },
    copied,
    skipped,
  };
}

/**
 * Pin the worktree's whole state under `refs/ashlr/verse-archive/<slug>`.
 * Returns the snapshot and the head it sits on; `sha === headSha` when there
 * was nothing uncommitted. Null when the worktree is already gone.
 */
export async function snapshotWorkspace(
  ws: Pick<AgentWorkspaceRecord, 'path' | 'rootPath' | 'name'>,
  opts: WorkspaceOpsOptions = {},
): Promise<{ ref: string; sha: string; headSha: string } | null> {
  const run = runnerOf(opts);
  const exists = opts.probePath ?? defaultPathExists;
  if (!(await exists(ws.path))) return null;
  const head = await run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: ws.path });
  if (head.code !== 0) return null;
  const headSha = head.stdout.trim();
  // The worktree's own index: it is about to be removed, so staging everything costs nothing.
  await gitOk(run, ws.path, ['add', '-A', '--', '.'], 'Staging the workspace for its snapshot');
  const tree = await gitOk(run, ws.path, ['write-tree'], 'Writing the snapshot tree');
  const headTree = await gitOk(run, ws.path, ['rev-parse', `${headSha}^{tree}`], 'Reading the head tree');
  let sha = headSha;
  if (tree !== headTree) {
    sha = await gitOk(
      run,
      ws.path,
      [...SNAPSHOT_IDENTITY, 'commit-tree', tree, '-p', headSha, '-m', `verse: snapshot of ${ws.name} before archive`],
      'Writing the snapshot commit',
    );
  }
  const ref = `${ARCHIVE_REF_PREFIX}${ws.name}`;
  await gitOk(run, ws.rootPath, ['update-ref', ref, sha], 'Pinning the snapshot');
  return { ref, sha, headSha };
}

/**
 * Snapshot, then remove the worktree (and, when asked, its branch — the
 * commits stay reachable through the snapshot ref). Idempotent: a worktree
 * that is already gone is only pruned.
 */
export async function archiveWorkspace(
  ws: AgentWorkspaceRecord,
  reason: AgentArchiveRecord['reason'],
  opts: WorkspaceOpsOptions & { deleteBranch?: boolean; now?: () => number } = {},
): Promise<AgentArchiveRecord> {
  const run = runnerOf(opts);
  let snap: Awaited<ReturnType<typeof snapshotWorkspace>> = null;
  let branchDeleted = false;
  await withRepoLock(ws.rootPath, async () => {
    snap = await snapshotWorkspace(ws, opts);
    const removed = await run('git', ['worktree', 'remove', '--force', ws.path], { cwd: ws.rootPath });
    // A worktree already deleted by hand is not a failure: its stale registration is pruned below.
    if (removed.code !== 0 && (await (opts.probePath ?? defaultPathExists)(ws.path))) {
      throw new GitOpError('VERSE_GIT_FAILED', 'Git could not remove the workspace. Close anything running in it and try again.');
    }
    await run('git', ['worktree', 'prune'], { cwd: ws.rootPath });
    if (opts.deleteBranch) {
      const del = await run('git', ['branch', '-D', ws.branch], { cwd: ws.rootPath });
      branchDeleted = del.code === 0;
    }
  }, opts);
  const s = snap as { ref: string; sha: string; headSha: string } | null;
  return {
    at: new Date((opts.now ?? Date.now)()).toISOString(),
    ref: s?.ref ?? null,
    sha: s?.sha ?? null,
    headSha: s?.headSha ?? null,
    reason,
    branchDeleted,
  };
}

/**
 * Bring an archived workspace back where it was: the branch at its archived
 * head (made again if it was deleted), the worktree at the same path, and the
 * snapshot's uncommitted files laid back over it — unstaged, as they were.
 */
export async function restoreWorkspace(
  ws: AgentWorkspaceRecord,
  archive: AgentArchiveRecord,
  opts: WorkspaceOpsOptions = {},
): Promise<void> {
  const run = runnerOf(opts);
  const exists = opts.probePath ?? defaultPathExists;
  if (!archive.sha || !archive.headSha) throw new GitOpError('VERSE_GIT_REFUSED', 'This agent was archived without a snapshot, so there is nothing to restore.');
  if (await exists(ws.path)) throw new GitOpError('VERSE_GIT_REFUSED', 'Something already exists where this workspace lived. Move it aside, then restore.');
  await withRepoLock(ws.rootPath, async () => {
    const snapOk = await run('git', ['cat-file', '-e', `${archive.sha}^{commit}`], { cwd: ws.rootPath });
    if (snapOk.code !== 0) throw new GitOpError('VERSE_GIT_REFUSED', 'The snapshot is no longer in this repository, so the workspace cannot be restored.');
    const branchExists = (await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${ws.branch}`], { cwd: ws.rootPath })).code === 0;
    await mkdir(dirname(ws.path), { recursive: true, mode: 0o700 });
    const args = branchExists
      ? ['worktree', 'add', ws.path, ws.branch]
      : ['worktree', 'add', '-b', ws.branch, ws.path, archive.headSha!];
    const added = await run('git', args, { cwd: ws.rootPath });
    if (added.code !== 0) throw new GitOpError(added.timedOut ? 'VERSE_GIT_TIMEOUT' : 'VERSE_GIT_FAILED', 'Git could not recreate the workspace.');
    if (archive.sha !== archive.headSha) {
      await gitOk(run, ws.path, ['checkout', archive.sha!, '--', '.'], 'Laying the snapshot back');
      await gitOk(run, ws.path, ['reset', '-q'], 'Unstaging the restored changes');
    }
  }, opts);
}

/** Delete an archive's private snapshot ref (after a merge nothing is left to restore). */
export async function dropSnapshotRef(rootPath: string, ref: string, opts: WorkspaceOpsOptions = {}): Promise<void> {
  if (!ref.startsWith(ARCHIVE_REF_PREFIX)) return;
  await runnerOf(opts)('git', ['update-ref', '-d', ref], { cwd: rootPath });
}
