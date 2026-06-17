/**
 * git.ts — lightweight Git introspection helpers.
 *
 * Rules:
 *  - Zero third-party deps; Node builtins only.
 *  - Never throw — return null / zero-filled values on any error.
 *  - Every execFileSync call gets a tight timeout (5 s) and stdio:'pipe'
 *    so a hung git never blocks the indexer.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GitStatus } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 5_000; // ms

/**
 * Run a git command inside `cwd`. Returns trimmed stdout or null on error.
 */
function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return out.trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when `dir` is the root of a git repository.
 * Accepts both standard `.git/` directories and git worktrees / submodules
 * where `.git` is a plain file containing a `gitdir:` pointer.
 */
export function isRepo(dir: string): boolean {
  const gitEntry = join(dir, '.git');
  if (!existsSync(gitEntry)) return false;
  // Accept both directory and file (worktree / submodule)
  const st = statSync(gitEntry, { throwIfNoEntry: false });
  return st !== undefined; // exists as either file or dir
}

/**
 * Returns a GitStatus snapshot for the repo at `repoPath`, or null when the
 * path is not a repo or git is unavailable.
 */
export function getGitStatus(repoPath: string): GitStatus | null {
  if (!isRepo(repoPath)) return null;

  // --- branch ---
  const branchRaw = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRaw === null) return null; // git not available / not a real repo
  const branch = branchRaw || 'HEAD'; // detached HEAD shows 'HEAD'

  // --- dirty (number of changed lines in porcelain output) ---
  const porcelain = git(repoPath, ['status', '--porcelain']);
  const dirty =
    porcelain === null || porcelain === ''
      ? 0
      : porcelain.split('\n').filter(Boolean).length;

  // --- ahead / behind upstream ---
  let ahead = 0;
  let behind = 0;
  const revCount = git(repoPath, [
    'rev-list',
    '--left-right',
    '--count',
    '@{u}...HEAD',
  ]);
  if (revCount !== null) {
    // Output is "<behind>\t<ahead>" (left=upstream, right=HEAD)
    const parts = revCount.split(/\s+/);
    if (parts.length >= 2) {
      behind = parseInt(parts[0] ?? '0', 10) || 0;
      ahead = parseInt(parts[1] ?? '0', 10) || 0;
    }
  }
  // If no upstream is configured, revCount is null → ahead/behind stay 0.

  // --- last commit ISO timestamp ---
  const lastCommit = git(repoPath, ['log', '-1', '--format=%cI']) || null;

  return { branch, dirty, ahead, behind, lastCommit };
}

/**
 * Resolve the repository's default branch name (the integration target for an
 * auto-merge). Resolution order:
 *   1. `git symbolic-ref --short refs/remotes/origin/HEAD` → strip `origin/`.
 *      This is the remote's authoritative default branch when a remote exists.
 *   2. `git rev-parse --abbrev-ref HEAD` → the currently checked-out branch.
 *   3. Final fallback: 'main'.
 *
 * Never throws (each git() call already swallows errors with a 5s timeout). A
 * detached HEAD yields 'HEAD' from step 2, which we treat as unresolved and fall
 * through to 'main'.
 */
export function defaultBranch(repoPath: string): string {
  const sym = git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) {
    // e.g. "origin/main" → "main"
    const slash = sym.indexOf('/');
    const name = slash >= 0 ? sym.slice(slash + 1) : sym;
    if (name) return name;
  }

  const cur = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (cur && cur !== 'HEAD') return cur;

  return 'main';
}

/**
 * Parses the `origin` remote URL of the repo at `repoPath` and extracts the
 * GitHub org (or user) name. Returns `{ remote, org }` where either may be
 * null when unavailable or not a recognised GitHub URL.
 *
 * Handles both HTTPS and SSH remote formats:
 *   https://github.com/<org>/<repo>.git
 *   git@github.com:<org>/<repo>.git
 */
export function getRemoteOrg(repoPath: string): {
  remote: string | null;
  org: string | null;
} {
  const remote = git(repoPath, ['remote', 'get-url', 'origin']);
  if (!remote) return { remote: null, org: null };

  // HTTPS: https://github.com/org/repo(.git)?
  const httpsMatch = remote.match(
    /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\//i,
  );
  if (httpsMatch) {
    return { remote, org: httpsMatch[1] ?? null };
  }

  // SSH: git@github.com:org/repo(.git)?
  const sshMatch = remote.match(/^git@github\.com:([^/]+)\//i);
  if (sshMatch) {
    return { remote, org: sshMatch[1] ?? null };
  }

  // Remote exists but is not GitHub (e.g. local path, other host)
  return { remote, org: null };
}
