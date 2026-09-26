/**
 * git.ts — lightweight Git introspection helpers.
 *
 * Rules:
 *  - Zero third-party deps; Node builtins only.
 *  - Never throw — return null / zero-filled values on any error.
 *  - Every execFileSync call gets a tight timeout (5 s) and stdio:'pipe'
 *    so a hung git never blocks the indexer.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { GitStatus } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 5_000; // ms

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+$/;

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

/**
 * `git()` without blocking the event loop: the same command, timeout and
 * output rules (trimmed stdout; null on a non-zero exit, a timeout, a spawn
 * failure or stdout over execFileSync's default 1 MiB), but the wait happens
 * in libuv instead of on the calling thread.
 *
 * WHY. A server calling these helpers per request (the Verse sidecar's
 * GET /api/verse/workspaces, up to seven git calls per root) must not freeze
 * while git works in a folder macOS guards with a privacy prompt (~/Desktop,
 * ~/Documents, removable volumes): execFileSync parks the whole process until
 * the prompt is answered or the timeout fires, once per call.
 *
 * The repo is named with `git -C <dir>` and the child starts in `/`, NOT with
 * `cwd: dir`: the spawn's chdir runs inside the parent's posix_spawn/fork
 * call, so a cwd behind a pending prompt would park the calling thread in
 * uv_spawn itself. `-C` moves that chdir into git, where waiting is harmless.
 * `-C` is git's documented equivalent of starting in that directory. Stdin is
 * closed at once, as execFileSync's is, so a command that would read it sees EOF.
 */
function gitAsync(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolvePromise) => {
    try {
      const child = execFile(
        'git',
        ['-C', resolvePath(cwd), ...args],
        { cwd: '/', timeout: GIT_TIMEOUT, encoding: 'utf8', maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) },
        (error, stdout) => resolvePromise(error ? null : String(stdout).trim()),
      );
      child.stdin?.end();
    } catch {
      resolvePromise(null);
    }
  });
}

/** Normalize one supported GitHub transport URL to lowercase owner/repo. */
function canonicalGitHubDestination(remote: string): string | null {
  const match =
    remote.match(/^https:\/\/(?:[^/?#@]+@)?github\.com(?::443)?\/([^/?#]+)\/([^/?#]+)$/i) ??
    remote.match(/^git@github\.com:([^/?#:]+)\/([^/?#]+)$/i) ??
    remote.match(/^ssh:\/\/git@github\.com(?::22)?\/([^/?#]+)\/([^/?#]+)$/i);
  if (!match?.[1] || !match[2]) return null;

  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!GITHUB_OWNER_RE.test(owner) || !repo || !GITHUB_REPO_RE.test(repo) ||
      repo === '.' || repo === '..') {
    return null;
  }
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function gitUrls(output: string | null): string[] | null {
  if (!output) return null;
  const urls = output.split(/\r?\n/);
  return urls.length > 0 && urls.every((url) => url.length > 0) ? urls : null;
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

/** {@link isRepo} with the stat off the event loop. Never rejects. */
export async function isRepoAsync(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

// The commands getGitStatus runs, shared with getGitStatusAsync so both ask
// git exactly the same questions.
const STATUS_BRANCH_ARGS: readonly string[] = ['rev-parse', '--abbrev-ref', 'HEAD'];
const STATUS_PORCELAIN_ARGS: readonly string[] = ['status', '--porcelain'];
const STATUS_REV_COUNT_ARGS: readonly string[] = ['rev-list', '--left-right', '--count', '@{u}...HEAD'];
const STATUS_LAST_COMMIT_ARGS: readonly string[] = ['log', '-1', '--format=%cI'];

/**
 * Returns a GitStatus snapshot for the repo at `repoPath`, or null when the
 * path is not a repo or git is unavailable.
 */
export function getGitStatus(repoPath: string): GitStatus | null {
  if (!isRepo(repoPath)) return null;

  // --- branch ---
  const branchRaw = git(repoPath, [...STATUS_BRANCH_ARGS]);
  if (branchRaw === null) return null; // git not available / not a real repo
  return gitStatusFrom(
    branchRaw,
    git(repoPath, [...STATUS_PORCELAIN_ARGS]),
    git(repoPath, [...STATUS_REV_COUNT_ARGS]),
    git(repoPath, [...STATUS_LAST_COMMIT_ARGS]),
  );
}

/**
 * {@link getGitStatus} without blocking the event loop (see `gitAsync`): the
 * same four git commands and the same answer. After the branch read succeeds
 * the other three run concurrently; they are independent reads. Never rejects.
 */
export async function getGitStatusAsync(repoPath: string, signal?: AbortSignal): Promise<GitStatus | null> {
  if (!(await isRepoAsync(repoPath))) return null;
  const branchRaw = await gitAsync(repoPath, STATUS_BRANCH_ARGS, signal);
  if (branchRaw === null) return null; // git not available / not a real repo
  const [porcelain, revCount, lastCommit] = await Promise.all([
    gitAsync(repoPath, STATUS_PORCELAIN_ARGS, signal),
    gitAsync(repoPath, STATUS_REV_COUNT_ARGS, signal),
    gitAsync(repoPath, STATUS_LAST_COMMIT_ARGS, signal),
  ]);
  return gitStatusFrom(branchRaw, porcelain, revCount, lastCommit);
}

/** The GitStatus four git outputs describe (a null output: that command failed). */
function gitStatusFrom(
  branchRaw: string,
  porcelain: string | null,
  revCount: string | null,
  lastCommitRaw: string | null,
): GitStatus {
  const branch = branchRaw || 'HEAD'; // detached HEAD shows 'HEAD'

  // --- dirty (number of changed lines in porcelain output) ---
  const dirty =
    porcelain === null || porcelain === ''
      ? 0
      : porcelain.split('\n').filter(Boolean).length;

  // --- ahead / behind upstream ---
  let ahead = 0;
  let behind = 0;
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
  const lastCommit = lastCommitRaw || null;

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
  const fromOrigin = originHeadBranch(git(repoPath, [...ORIGIN_HEAD_ARGS]));
  if (fromOrigin) return fromOrigin;
  return currentBranchOrMain(git(repoPath, [...STATUS_BRANCH_ARGS]));
}

/** {@link defaultBranch} without blocking the event loop (see `gitAsync`): same commands, same answer. Never rejects. */
export async function defaultBranchAsync(repoPath: string, signal?: AbortSignal): Promise<string> {
  const fromOrigin = originHeadBranch(await gitAsync(repoPath, ORIGIN_HEAD_ARGS, signal));
  if (fromOrigin) return fromOrigin;
  return currentBranchOrMain(await gitAsync(repoPath, STATUS_BRANCH_ARGS, signal));
}

const ORIGIN_HEAD_ARGS: readonly string[] = ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'];

/** e.g. "origin/main" → "main"; null when there is no usable origin/HEAD. */
function originHeadBranch(sym: string | null): string | null {
  if (!sym) return null;
  const slash = sym.indexOf('/');
  const name = slash >= 0 ? sym.slice(slash + 1) : sym;
  return name || null;
}

function currentBranchOrMain(cur: string | null): string {
  if (cur && cur !== 'HEAD') return cur;
  return 'main';
}

/**
 * Resolve the sole GitHub owner/repo authorized by every `origin` fetch and
 * effective push URL. Git applies fetch URLs as push destinations when no
 * pushurl is configured, so both views are read through `remote get-url`.
 *
 * Returns a lowercase `owner/repo` only when every URL is a supported GitHub
 * HTTPS or SSH URL and all URLs identify the same repository. Missing,
 * malformed, unsupported, or divergent destinations fail closed to null.
 */
export function resolveGitHubOriginAuthority(repoPath: string): string | null {
  return resolveGitHubOriginAuthorityDetails(repoPath)?.nameWithOwner ?? null;
}

export interface GitHubOriginAuthority {
  nameWithOwner: string;
  fetchUrls: string[];
  pushUrls: string[];
  pushUrl: string;
}

/** Resolve the canonical identity and one exact effective push transport. */
export function resolveGitHubOriginAuthorityDetails(repoPath: string): GitHubOriginAuthority | null {
  // A resolved URL can be rewritten again when fed back to another git command.
  // Refuse every rewrite rule instead of trying to reason about chained config.
  const rewriteRules = git(repoPath, [...ORIGIN_REWRITE_RULE_ARGS]);
  if (rewriteRules) return null;
  return originAuthorityFrom(
    git(repoPath, [...ORIGIN_FETCH_URL_ARGS]),
    git(repoPath, [...ORIGIN_PUSH_URL_ARGS]),
  );
}

// The commands resolveGitHubOriginAuthorityDetails runs, shared with its async twin.
const ORIGIN_REWRITE_RULE_ARGS: readonly string[] = [
  'config', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$',
];
const ORIGIN_FETCH_URL_ARGS: readonly string[] = ['remote', 'get-url', '--all', 'origin'];
const ORIGIN_PUSH_URL_ARGS: readonly string[] = ['remote', 'get-url', '--push', '--all', 'origin'];

/**
 * {@link resolveGitHubOriginAuthority} without blocking the event loop (see
 * `gitAsync`): the same three git commands and the same fail-closed answer.
 * The two URL reads run concurrently once the rewrite-rule check has passed.
 * Never rejects.
 */
export async function resolveGitHubOriginAuthorityAsync(repoPath: string, signal?: AbortSignal): Promise<string | null> {
  const rewriteRules = await gitAsync(repoPath, ORIGIN_REWRITE_RULE_ARGS, signal);
  if (rewriteRules) return null;
  const [fetchOut, pushOut] = await Promise.all([
    gitAsync(repoPath, ORIGIN_FETCH_URL_ARGS, signal),
    gitAsync(repoPath, ORIGIN_PUSH_URL_ARGS, signal),
  ]);
  return originAuthorityFrom(fetchOut, pushOut)?.nameWithOwner ?? null;
}

/** The authority two `remote get-url --all` outputs describe, or null (fail closed). */
function originAuthorityFrom(fetchOut: string | null, pushOut: string | null): GitHubOriginAuthority | null {
  const fetchUrls = gitUrls(fetchOut);
  const pushUrls = gitUrls(pushOut);
  if (!fetchUrls || !pushUrls) return null;

  const destinations = new Set<string>();
  for (const remote of [...fetchUrls, ...pushUrls]) {
    const destination = canonicalGitHubDestination(remote);
    if (!destination) return null;
    destinations.add(destination);
  }
  const nameWithOwner = destinations.size === 1 ? destinations.values().next().value : undefined;
  const pushUrl = pushUrls[0];
  return nameWithOwner && pushUrl
    ? { nameWithOwner, fetchUrls: [...fetchUrls], pushUrls: [...pushUrls], pushUrl }
    : null;
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
