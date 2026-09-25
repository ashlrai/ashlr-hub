/**
 * Isolated launch checkouts (unit C1): `<cloudHome>/checkouts/<owner>__<name>`,
 * a shallow single-branch clone of https://github.com/<owner>/<name>.git
 * using the operator's normal git credentials. Before each launch:
 * `git fetch --depth 1 origin <branch>` then `git checkout -B <branch>
 * FETCH_HEAD` with upstream set, so the CLI sees a pushed branch. Never
 * touches the operator's own clones or fleet mirrors. Serialise per path.
 *
 * WHY a checkout of our own: `claude --cloud` clones the cwd's origin at the
 * cwd's CURRENT branch. Launching from the operator's working copy would pin
 * the session to whatever branch they happen to have checked out (possibly
 * unpushed); a private checkout pinned to the requested base makes the
 * session start exactly where the task says.
 */
import { lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { defaultGitRunner } from '../verse/git-ops.js';
import { CLOUD_REPO_PATTERN, cloudHome, ensureCloudDirectory } from './store.js';

export type CloudCheckoutResult =
  | { ok: true; path: string }
  | { ok: false; failure: 'no-remote' | 'checkout-failed'; message: string };

export interface CloudCheckoutDeps {
  git?: (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  originUrlFor?: (repo: string) => string;
}

export const CLOUD_CHECKOUTS_DIR = 'checkouts';
const CLONE_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Per-key mutex
// ---------------------------------------------------------------------------

/**
 * In-process FIFO mutex keyed by string. Two `--cloud` runs (or a fetch and
 * a launch) in one folder would race on the checked-out branch, so every
 * user of a folder queues here. The map entry is dropped when the last
 * waiter finishes, so it never grows with the number of repos ever used.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** True while any caller holds or waits for `key` (tests, diagnostics). */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}

const checkoutMutex = new KeyedMutex();

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * A branch name git accepts that also cannot be read as an option or escape
 * the ref namespace. Stricter than check-ref-format on purpose: base
 * branches are human names like `main` or `v3110-cloud`.
 */
export function isSafeBranchName(branch: string): boolean {
  return typeof branch === 'string'
    && branch.length > 0 && branch.length <= 200
    && /^[A-Za-z0-9._/-]+$/.test(branch)
    && !branch.startsWith('-') && !branch.startsWith('/') && !branch.endsWith('/')
    && !branch.endsWith('.') && !branch.endsWith('.lock')
    && !branch.includes('..') && !branch.includes('//') && !branch.includes('/.');
}

/** Lower-cased: GitHub names are case-insensitive, and so is the default macOS filesystem — one repo, one folder, one lock. */
export function cloudCheckoutPath(repo: string): string {
  const [owner, name] = repo.toLowerCase().split('/');
  return join(cloudHome(), CLOUD_CHECKOUTS_DIR, `${owner}__${name}`);
}

const defaultOriginUrl = (repo: string): string => `https://github.com/${repo}.git`;

async function defaultGit(args: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await defaultGitRunner('git', args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  return { ok: result.code === 0 && !result.timedOut, stdout: result.stdout, stderr: result.missing ? 'git is not installed' : result.stderr };
}

/** git's words for "that repo or branch is not on GitHub (or not reachable with these credentials)". */
function isMissingRemote(stderr: string): boolean {
  return /couldn't find remote ref|remote branch .* not found|repository not found|could not read from remote repository|could not read username|authentication failed|does not appear to be a git repository/i.test(stderr);
}

function failed(repo: string, branch: string, stderr: string): CloudCheckoutResult {
  if (isMissingRemote(stderr)) {
    return { ok: false, failure: 'no-remote', message: `Couldn't find branch ${branch} of ${repo} on GitHub. Check the repo name, that the branch is pushed, and that git can reach it.` };
  }
  return { ok: false, failure: 'checkout-failed', message: `Couldn't prepare a checkout of ${repo} at ${branch} for the cloud launch.` };
}

function isGitCheckout(path: string): boolean {
  try {
    const dir = lstatSync(path);
    if (!dir.isDirectory() || dir.isSymbolicLink()) return false;
    return lstatSync(join(path, '.git')).isDirectory();
  } catch {
    return false;
  }
}

async function prepare(repo: string, branch: string, deps: CloudCheckoutDeps): Promise<CloudCheckoutResult> {
  const git = deps.git ?? defaultGit;
  const url = (deps.originUrlFor ?? defaultOriginUrl)(repo);
  let parent: string;
  try {
    parent = ensureCloudDirectory(CLOUD_CHECKOUTS_DIR);
  } catch {
    return { ok: false, failure: 'checkout-failed', message: "Couldn't create the private folder for cloud checkouts." };
  }
  const path = cloudCheckoutPath(repo);

  if (!isGitCheckout(path)) {
    // Anything else at our own path is a clone that died half-way (or was
    // tampered with); it is ours to replace, and git refuses a non-empty target.
    try { rmSync(path, { recursive: true, force: true }); } catch { /* clone below reports it */ }
    const clone = await git(['clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', branch, '--', url, path], { cwd: parent, timeoutMs: CLONE_TIMEOUT_MS });
    if (!clone.ok) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
      return failed(repo, branch, clone.stderr);
    }
  }

  const steps: string[][] = [
    // The origin URL is re-asserted every time so a checkout can never launch
    // against a remote other than the one the task names.
    ['remote', 'set-url', 'origin', url],
    // A single-branch clone only maps its first branch to a remote-tracking
    // ref; git refuses an upstream (and cannot resolve @{u}) for any other
    // base until the remote's fetch refspec covers it.
    ['remote', 'set-branches', 'origin', '*'],
    // An explicit refspec keeps a remote-tracking ref even in a single-branch
    // clone, which is what the upstream below points at.
    ['fetch', '--depth', '1', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    ['checkout', '--force', '-B', branch, 'FETCH_HEAD'],
    ['branch', `--set-upstream-to=origin/${branch}`, branch],
    // Nothing a previous launch left behind may ride along into the next session.
    ['clean', '-ffdx'],
  ];
  for (const args of steps) {
    const step = await git(args, { cwd: path, timeoutMs: args[0] === 'fetch' ? CLONE_TIMEOUT_MS : GIT_TIMEOUT_MS });
    if (!step.ok) return failed(repo, branch, step.stderr);
  }
  return { ok: true, path };
}

export async function ensureCloudCheckout(repo: string, branch: string, deps: CloudCheckoutDeps = {}): Promise<CloudCheckoutResult> {
  if (typeof repo !== 'string' || !CLOUD_REPO_PATTERN.test(repo)) {
    return { ok: false, failure: 'checkout-failed', message: 'The repo must look like owner/name.' };
  }
  if (!isSafeBranchName(branch)) {
    return { ok: false, failure: 'checkout-failed', message: `"${String(branch).slice(0, 80)}" isn't a branch name the cloud lane accepts.` };
  }
  return checkoutMutex.run(cloudCheckoutPath(repo), async () => {
    try {
      return await prepare(repo, branch, deps);
    } catch {
      return { ok: false, failure: 'checkout-failed', message: `Couldn't prepare a checkout of ${repo} at ${branch} for the cloud launch.` };
    }
  });
}
