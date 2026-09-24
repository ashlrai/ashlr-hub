/**
 * core/verse/worktrees.ts — "Isolate in worktree" for a new chat (V3.10 unit
 * C5; SPEC-310C §2 "Worktrees", P1).
 *
 * A chat that should not touch the operator's checkout gets its own git
 * worktree at `~/.ashlr-worktrees/<repo>/<name>` on a new branch
 * `verse/<name>`, started from the repository's current HEAD. The chat then
 * opens with that directory as its project — so its edits, its branch bar and
 * its PR are its own, while the object store is shared (no second clone).
 *
 * WHY THIS LOCATION. Outside the repository (a worktree inside the work tree
 * shows up as untracked noise in every `git status`), outside `~/.ashlr` (the
 * workspace-root guard refuses anything under it, so a chat could not open
 * there), and under the home directory the guard does allow. The directory is
 * created 0700: it holds a copy of the operator's source.
 *
 * REFUSES rather than reuses: an existing directory or an existing
 * `verse/<name>` branch is a 409 — silently attaching a new chat to someone
 * else's half-finished worktree is exactly the surprise isolation exists to
 * prevent. Uncommitted changes in the source checkout are NOT carried over
 * (git worktrees start from a commit); the dialog says so.
 *
 * NODE-ONLY.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  GitOpError,
  defaultGitRunner,
  resolveGitRoot,
  withRepoLock,
  type GitOpsOptions,
} from './git-ops.js';
import { VERSE_WORKTREE_BRANCH_PREFIX, type VerseGitWorktreeResponse } from './workbench-types.js';

/** A worktree name: a short slug, safe as both a directory and a branch segment. */
export const WORKTREE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

export function isValidWorktreeName(name: unknown): name is string {
  return typeof name === 'string' && WORKTREE_NAME_RE.test(name) && !name.endsWith('.lock') && !name.includes('..');
}

/** `~/.ashlr-worktrees` for the CURRENT home (a relocated HOME in tests is honoured). */
export function worktreesHome(): string {
  return join(homedir(), '.ashlr-worktrees');
}

/** The repository folder name as a path segment (never empty, never `..`). */
export function worktreeRepoSegment(gitRoot: string): string {
  const raw = basename(gitRoot).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return raw.length > 0 ? raw.slice(0, 64) : 'repo';
}

export interface WorktreeOptions extends GitOpsOptions {
  /** Test seam: does this path exist? */
  pathExists?: (path: string) => boolean;
  /** Test seam: create the parent directory (mode 0700). */
  makeDir?: (path: string) => Promise<void>;
}

async function defaultMakeDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask; the top directory must be private regardless.
  await chmod(worktreesHome(), 0o700).catch(() => { /* best effort on the top level */ });
}

/** POST /api/verse/git/worktree */
export async function createWorktree(root: string, name: string, opts: WorktreeOptions = {}): Promise<VerseGitWorktreeResponse> {
  if (!isValidWorktreeName(name)) {
    throw new GitOpError('VERSE_INVALID', 'A worktree name is 1–63 letters, digits, dots, dashes or underscores.');
  }
  const run = opts.runner ?? defaultGitRunner;
  const exists = opts.pathExists ?? existsSync;
  const makeDir = opts.makeDir ?? defaultMakeDir;
  const gitRoot = await resolveGitRoot(root, opts);
  if (!gitRoot) throw new GitOpError('VERSE_GIT_NOT_A_REPO', 'This folder is not a git repository.');

  const branch = `${VERSE_WORKTREE_BRANCH_PREFIX}${name}`;
  const parent = join(worktreesHome(), worktreeRepoSegment(gitRoot));
  const path = join(parent, name);

  await withRepoLock(gitRoot, async () => {
    if (exists(path)) throw new GitOpError('VERSE_GIT_REFUSED', `A worktree named ${name} already exists for this repository. Pick another name.`);
    const head = await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: gitRoot });
    if (head.code !== 0) throw new GitOpError('VERSE_GIT_REFUSED', 'This repository has no commits yet, so there is nothing to start a worktree from.');
    const taken = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: gitRoot });
    if (taken.code === 0) throw new GitOpError('VERSE_GIT_REFUSED', `The branch ${branch} already exists. Pick another name.`);
    await makeDir(parent);
    const added = await run('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], { cwd: gitRoot });
    if (added.code !== 0) {
      throw new GitOpError(added.timedOut ? 'VERSE_GIT_TIMEOUT' : 'VERSE_GIT_FAILED', 'Git could not create the worktree.');
    }
  }, opts);
  return { path, branch };
}
