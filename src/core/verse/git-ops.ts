/**
 * core/verse/git-ops.ts — the git and gh work behind the chat's branch bar and
 * Review pane (V3.10 unit C5; SPEC-310C §2 "Branch bar", §3 "Diff/Review";
 * wire shapes in workbench-types.ts §7).
 *
 * WHAT THIS IS FOR. An operator action, one click at a time: commit what the
 * chat changed, push it, open a PR, and merge it once GitHub says the checks
 * are green. It is NOT the fleet's merge path (that is Track B's authority
 * question, still open) — nothing here runs on a timer, and nothing here runs
 * without a request from the page.
 *
 * FOUR RULES THIS FILE ENFORCES RATHER THAN LEAVES TO THE UI
 *
 *  1. PUSH BEFORE PR. `gh pr create` refuses a branch the remote has never
 *     seen, and a PR opened from a stale push reviews code the operator did
 *     not mean to ship. `openPullRequest` pushes whenever the branch has no
 *     upstream or is ahead of it, and only then asks gh.
 *  2. MERGE ONLY WHAT WAS SEEN. `mergePullRequest` re-reads the PR from GitHub
 *     (never the cache) and refuses unless it is open, not a draft, every
 *     check passed, GitHub calls it mergeable, it is THIS root's branch, and
 *     its head is still the SHA the operator clicked on. The same SHA goes to
 *     `gh pr merge --match-head-commit`, so a push that lands between our read
 *     and GitHub's merge is refused by GitHub too. NEVER `--admin` (it
 *     bypasses branch protection) and never `--auto` (it would merge later,
 *     unseen). There is a test for both.
 *  3. ONE MUTATION PER REPO AT A TIME. A second POST while one runs, or while
 *     another process holds git's index lock, is a 409 (`GitBusyError`), not a
 *     queue: two commits racing on one index produce a commit nobody asked for.
 *  4. NOTHING BLOCKS THE SERVER. Every subprocess is async (spawn, not
 *     spawnSync) with VERSE_GIT_TIMEOUT_MS; the status read is cached
 *     VERSE_GIT_STATUS_CACHE_MS and never waits on the network — GitHub's
 *     answer is fetched in the background and reported as `prLookup:
 *     'pending'` until it lands (SPEC-310C budget: git status < 300 ms).
 *
 * HONESTY. `null` is unknown, never zero. A PR we could not look up is
 * `prLookup: 'unavailable'`, never "no PR". Git's and gh's own stderr never
 * reaches a response: failures are classified into fixed operator sentences
 * (a remote URL in stderr can carry a token), and everything returned still
 * passes sendJson → sanitizePublicJson.
 *
 * Reads run with GIT_OPTIONAL_LOCKS=0, so `git status` never takes the index
 * lock a running agent's own git commands may need.
 *
 * NODE-ONLY.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open as openFile, stat as statFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';

import { summarizeCheckRollup } from './github-repo.js';
import {
  VERSE_GIT_PATCH_MAX_BYTES,
  VERSE_GIT_STATUS_CACHE_MS,
  VERSE_GIT_TIMEOUT_MS,
  type VerseGitDiffFile,
  type VerseGitDiffResponse,
  type VerseGitDiffScope,
  type VerseGitDiffstat,
  type VerseGitFileStatus,
  type VerseGitPr,
  type VerseGitSuggestedAction,
  type VersePrChecks,
  type VersePrState,
  type VerseGitCheckCounts,
  type VerseGitPrLookup,
  type VerseGitStatusDetail,
} from './workbench-types.js';

// ===========================================================================
// Wire additions — contract now (workbench-types.ts §7 VerseGitStatusDetail):
// `prLookup` says whether `pr` is an answer (`pending`: GitHub not asked yet,
// the bar shows "Checking GitHub…"; `unavailable`: gh missing / signed out /
// offline / not GitHub — `pr: null` then means "could not look", not "no PR").
// These names stay as aliases so this module, git-api and the UI keep
// compiling against ONE definition.
// ===========================================================================

export type { VerseGitCheckCounts, VerseGitPrLookup } from './workbench-types.js';
/** GET /api/verse/git/status — the frozen VerseGitStatus plus the fields above. */
export type VerseGitStatusWire = VerseGitStatusDetail;

// ===========================================================================
// Runner (the seam every test fakes; nothing in the unit tests spawns)
// ===========================================================================

export type GitBinary = 'git' | 'gh';

export interface GitRunOptions {
  cwd: string;
  timeoutMs?: number;
  /** Stop reading (and kill the child) past this many stdout bytes; `truncated` says so. */
  maxStdoutBytes?: number;
}

export interface GitRunResult {
  /** Exit code; null when the child was killed (timeout, truncation) or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** The binary could not be started at all (ENOENT: gh not installed). */
  missing: boolean;
}

export type GitRunner = (bin: GitBinary, args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

const DEFAULT_MAX_STDOUT = 8 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

/**
 * The environment every git/gh child gets. Starts from the sidecar's own env
 * (gh's credential may BE `GH_TOKEN`, and git needs the operator's SSH agent
 * and credential helpers — this is the operator's own action on their own
 * repo), minus Ashlr's private settings, plus the switches that keep a child
 * from ever waiting on a prompt nobody can see.
 */
export function gitChildEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue;
    // The mutation token and every other ASHLR_* setting stay in the sidecar.
    if (/^ashlr_/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    // Reads never take the index lock a running agent may need (git ≥ 2.15).
    GIT_OPTIONAL_LOCKS: '0',
    // A commit or merge must never open an editor on a machine with no terminal.
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_SPINNER_DISABLED: '1',
    NO_COLOR: '1',
    // Stable English messages for the failure classifier below.
    LC_ALL: 'C',
  };
}

/** The production runner: async spawn, no shell, argv only, hard timeout, bounded output. */
export const defaultGitRunner: GitRunner = (bin, args, opts) =>
  new Promise<GitRunResult>((resolveRun) => {
    const timeoutMs = opts.timeoutMs ?? VERSE_GIT_TIMEOUT_MS;
    const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<GitRunResult, 'stdout' | 'stderr' | 'timedOut' | 'truncated'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        ...result,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: err,
        timedOut,
        truncated,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...args], {
        cwd: opts.cwd,
        env: gitChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolveRun({ code: null, stdout: '', stderr: '', timedOut: false, truncated: false, missing: true });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A git hook that ignores SIGTERM must not hold the route open forever.
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = maxStdout - outBytes;
      if (chunk.length > room) {
        out.push(chunk.subarray(0, Math.max(0, room)));
        outBytes = maxStdout;
        truncated = true;
        child.kill('SIGTERM');
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.length < MAX_STDERR) err += chunk.toString('utf8').slice(0, MAX_STDERR - err.length);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({ code: null, missing: e.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      finish({ code: truncated || timedOut ? null : code, missing: false });
    });
  });

// ===========================================================================
// Errors — every refusal is a code, an HTTP status and ONE operator sentence
// ===========================================================================

export type GitOpErrorCode =
  | 'VERSE_INVALID'
  | 'VERSE_GIT_NOT_A_REPO'
  | 'VERSE_GIT_BUSY'
  | 'VERSE_GIT_REFUSED'
  | 'VERSE_GIT_FAILED'
  | 'VERSE_GIT_TIMEOUT'
  | 'VERSE_GIT_GH_UNAVAILABLE';

const ERROR_HTTP: Record<GitOpErrorCode, 400 | 404 | 409 | 502 | 503 | 504> = {
  VERSE_INVALID: 400,
  VERSE_GIT_NOT_A_REPO: 404,
  VERSE_GIT_BUSY: 409,
  VERSE_GIT_REFUSED: 409,
  VERSE_GIT_FAILED: 502,
  VERSE_GIT_TIMEOUT: 504,
  VERSE_GIT_GH_UNAVAILABLE: 503,
};

export class GitOpError extends Error {
  readonly code: GitOpErrorCode;
  readonly status: number;
  constructor(code: GitOpErrorCode, message: string) {
    super(message);
    this.name = 'GitOpError';
    this.code = code;
    this.status = ERROR_HTTP[code];
  }
}

/** A second mutation on the same repo, or another process holding git's index lock. */
export class GitBusyError extends GitOpError {
  constructor(message = 'Git is busy in this repository. Try again when the current operation finishes.') {
    super('VERSE_GIT_BUSY', message);
    this.name = 'GitBusyError';
  }
}

/**
 * Turn a failed git/gh run into ONE fixed sentence. stderr is matched, never
 * returned: it can carry a remote URL with a token in its userinfo, a hook's
 * output full of absolute paths, or a stack trace.
 */
export function classifyGitFailure(action: string, result: GitRunResult): GitOpError {
  if (result.timedOut) {
    return new GitOpError('VERSE_GIT_TIMEOUT', `${action} took longer than ${Math.round(VERSE_GIT_TIMEOUT_MS / 1000)} s and was stopped.`);
  }
  if (result.missing) {
    return new GitOpError('VERSE_GIT_GH_UNAVAILABLE', `${action} needs a command that is not installed on this Mac.`);
  }
  const e = result.stderr.toLowerCase();
  const refused = (message: string) => new GitOpError('VERSE_GIT_REFUSED', message);
  if (e.includes('index.lock') || e.includes('another git process')) return new GitBusyError();
  if (/non-fast-forward|fetch first|\[rejected\]|updates were rejected/.test(e)) {
    return refused('The remote has commits this branch does not. Pull or rebase first, then push again.');
  }
  if (e.includes('protected branch') || e.includes('gh006')) return refused('The remote refused the push: this branch is protected.');
  if (/authentication failed|permission denied|could not read username|403|access denied/.test(e)) {
    return refused(`${action} was refused: the remote did not accept your credentials.`);
  }
  if (/does not appear to be a git repository|no such remote|no configured push destination/.test(e)) {
    return refused('This repository has no remote named origin to push to.');
  }
  if (/could not resolve host|network is unreachable|connection timed out|unable to access/.test(e)) {
    return new GitOpError('VERSE_GIT_FAILED', `${action} could not reach the remote. Check the network and try again.`);
  }
  if (e.includes('hook') && (e.includes('pre-commit') || e.includes('commit-msg') || e.includes('pre-push'))) {
    return refused(`${action} was stopped by a git hook in this repository. Run it in the terminal to see why.`);
  }
  if (e.includes('please tell me who you are') || e.includes('empty ident')) {
    return refused('Git does not know your name and email yet. Set user.name and user.email, then commit again.');
  }
  if (e.includes('nothing to commit') || e.includes('no changes added')) return refused('There is nothing to commit.');
  if (e.includes('gh auth login') || e.includes('not logged in') || e.includes('authentication required')) {
    return new GitOpError('VERSE_GIT_GH_UNAVAILABLE', 'GitHub CLI is signed out. Run `gh auth login`, then try again.');
  }
  if (e.includes('head branch was modified') || (e.includes('head commit') && e.includes('match'))) {
    return refused('The PR received new commits after you looked at it. Review the new head, then merge again.');
  }
  if (e.includes('merge conflict') || e.includes('not mergeable')) return refused('GitHub says this PR cannot be merged cleanly.');
  if (e.includes('required status check') || e.includes('review required') || e.includes('base branch policy')) {
    return refused('GitHub’s branch rules block this merge (a required check or review is missing).');
  }
  return new GitOpError('VERSE_GIT_FAILED', `${action} failed${result.code === null ? '' : ` (exit ${result.code})`}.`);
}

// ===========================================================================
// Parsing — pure, exported for the tests
// ===========================================================================

export interface PorcelainStatus {
  /** null on a detached HEAD. */
  branch: string | null;
  /** null on an unborn branch. */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Changed entries, tracked and untracked (the bar's `dirty`). */
  changed: Array<{ path: string; oldPath: string | null; status: VerseGitFileStatus; untracked: boolean }>;
  conflicts: number;
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. The v2 format is documented
 * as stable for scripts, NUL-separated (no quoting of odd file names), and
 * carries branch, upstream and ahead/behind in the same read.
 */
export function parsePorcelainV2(raw: string): PorcelainStatus {
  const out: PorcelainStatus = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, changed: [], conflicts: 0 };
  const records = raw.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec === '') continue;
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') out.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.oid') out.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.upstream') out.upstream = value || null;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          out.ahead = Number(m[1]);
          out.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = rec[0];
    if (kind === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = rec.split(' ');
      const xy = parts[1] ?? '..';
      const path = parts.slice(8).join(' ');
      out.changed.push({ path, oldPath: null, status: statusFromXY(xy), untracked: false });
    } else if (kind === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const parts = rec.split(' ');
      const path = parts.slice(9).join(' ');
      const oldPath = records[i + 1] ?? null;
      i += 1;
      out.changed.push({ path, oldPath, status: 'R', untracked: false });
    } else if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = rec.split(' ');
      out.changed.push({ path: parts.slice(10).join(' '), oldPath: null, status: 'U', untracked: false });
      out.conflicts += 1;
    } else if (kind === '?') {
      out.changed.push({ path: rec.slice(2), oldPath: null, status: 'A', untracked: true });
    }
    // '!' (ignored) never asked for.
  }
  return out;
}

function statusFromXY(xy: string): VerseGitFileStatus {
  if (xy.includes('D')) return 'D';
  if (xy.includes('A')) return 'A';
  if (xy.includes('R') || xy.includes('C')) return 'R';
  return 'M';
}

/** `git diff -z --name-status -M`: `M\0p\0`, `R100\0old\0new\0`, `A\0p\0`, `D\0p\0`, `U\0p\0`, `T\0p\0`. */
export function parseNameStatusZ(raw: string): Map<string, { status: VerseGitFileStatus; oldPath: string | null }> {
  const out = new Map<string, { status: VerseGitFileStatus; oldPath: string | null }>();
  const f = raw.split('\0');
  let i = 0;
  while (i < f.length) {
    const code = f[i] ?? '';
    if (code === '') {
      i += 1;
      continue;
    }
    const letter = code[0]!;
    if (letter === 'R' || letter === 'C') {
      const oldPath = f[i + 1] ?? '';
      const path = f[i + 2] ?? '';
      if (path) out.set(path, { status: letter === 'R' ? 'R' : 'A', oldPath: letter === 'R' ? oldPath : null });
      i += 3;
      continue;
    }
    const path = f[i + 1] ?? '';
    const status: VerseGitFileStatus =
      letter === 'A' ? 'A' : letter === 'D' ? 'D' : letter === 'U' ? 'U' : 'M';
    if (path) out.set(path, { status, oldPath: null });
    i += 2;
  }
  return out;
}

export interface NumstatEntry {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * `git diff -z --numstat -M`: `adds\tdels\tpath\0`, or for a rename
 * `adds\tdels\t\0old\0new\0`; a binary file reports `-\t-`.
 */
export function parseNumstatZ(raw: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  const f = raw.split('\0');
  let i = 0;
  while (i < f.length) {
    const rec = f[i] ?? '';
    if (rec === '') {
      i += 1;
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) {
      i += 1;
      continue;
    }
    const binary = m[1] === '-' || m[2] === '-';
    const additions = binary ? 0 : Number(m[1]);
    const deletions = binary ? 0 : Number(m[2]);
    if (m[3] === '') {
      out.push({ path: f[i + 2] ?? '', oldPath: f[i + 1] ?? null, additions, deletions, binary });
      i += 3;
    } else {
      out.push({ path: m[3]!, oldPath: null, additions, deletions, binary });
      i += 1;
    }
  }
  return out.filter((e) => e.path !== '');
}

/** gh's `pr view --json` payload → the wire PR. Null when it cannot name its own number and URL. */
export function parseGhPr(raw: unknown): { pr: VerseGitPr; counts: VerseGitCheckCounts } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const number = typeof r['number'] === 'number' && Number.isInteger(r['number']) && r['number'] > 0 ? r['number'] : null;
  const url = typeof r['url'] === 'string' && /^https:\/\//.test(r['url']) ? r['url'].slice(0, 2048) : null;
  if (number === null || url === null) return null;
  const rawState = typeof r['state'] === 'string' ? r['state'].toUpperCase() : '';
  let state: VersePrState;
  if (rawState === 'MERGED') state = 'merged';
  else if (rawState === 'CLOSED') state = 'closed';
  else state = r['isDraft'] === true ? 'draft' : 'open';
  const summary = summarizeCheckRollup(r['statusCheckRollup']);
  const mergeableRaw = typeof r['mergeable'] === 'string' ? r['mergeable'].toUpperCase() : '';
  const mergeable = mergeableRaw === 'MERGEABLE' ? true : mergeableRaw === 'CONFLICTING' ? false : null;
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const headSha = typeof r['headRefOid'] === 'string' && /^[0-9a-f]{7,64}$/i.test(r['headRefOid']) ? r['headRefOid'].toLowerCase() : null;
  return {
    pr: {
      number,
      title: str(r['title'], 256),
      url,
      state,
      checks: summary.state as VersePrChecks,
      mergeable,
      headSha,
      baseRef: str(r['baseRefName'], 256),
      headRef: str(r['headRefName'], 256),
    },
    counts: { total: summary.total, passed: summary.passed, failed: summary.failed, pending: summary.pending },
  };
}

export const GH_PR_FIELDS = 'number,title,url,state,isDraft,mergeable,headRefOid,baseRefName,headRefName,statusCheckRollup';

// ===========================================================================
// The suggested next action (SPEC-310C §2) — pure, table-tested
// ===========================================================================

export interface SuggestInput {
  branch: string | null;
  base: string | null;
  dirty: number;
  conflicts: number;
  upstream: string | null;
  ahead: number;
  /** Files this branch ships against base (committed or not). */
  shipFiles: number;
  /** Commits on HEAD that base does not have; null when there is no base to compare with. */
  commitsAheadOfBase: number | null;
  pr: VerseGitPr | null;
  prLookup: VerseGitPrLookup;
}

/**
 * The branch bar's ONE primary button. The ladder is the order the work has
 * to happen in — commit, then push, then open the PR, then merge — so the
 * button always names the next thing that is actually possible:
 *
 *   detached HEAD or conflicts ............................ none
 *   uncommitted changes ................................... commit
 *   no upstream, or commits the remote lacks .............. push
 *   an open PR: green checks + mergeable + not a draft .... merge
 *   an open, draft, merged or closed PR ................... view-pr
 *   on the base branch itself ............................. none
 *   GitHub not asked yet / unreachable .................... none (never guess "no PR")
 *   commits the base lacks, no PR ......................... create-pr
 *   otherwise ............................................. none
 */
export function suggestGitAction(s: SuggestInput): VerseGitSuggestedAction {
  if (s.branch === null) return 'none';
  if (s.conflicts > 0) return 'none';
  if (s.dirty > 0) return 'commit';
  const onBase = s.base !== null && s.branch === s.base;
  if (s.upstream === null) {
    // Nothing to publish yet: an empty new branch, or a local-only base.
    const hasWork = onBase ? s.ahead > 0 : (s.commitsAheadOfBase ?? 1) > 0;
    if (hasWork) return 'push';
  } else if (s.ahead > 0) {
    return 'push';
  }
  if (s.pr) {
    if (s.pr.state === 'open' && s.pr.checks === 'passing' && s.pr.mergeable === true) return 'merge';
    return 'view-pr';
  }
  if (onBase) return 'none';
  if (s.prLookup !== 'ok') return 'none';
  if ((s.commitsAheadOfBase ?? 0) > 0 || s.shipFiles > 0) return 'create-pr';
  return 'none';
}

// ===========================================================================
// Repository reads
// ===========================================================================

export interface GitOpsOptions {
  runner?: GitRunner;
  now?: () => number;
  /** Test seam: line-count an untracked file (default reads it, ≤ UNTRACKED_READ_BYTES). */
  countUntracked?: (absPath: string) => Promise<{ lines: number; binary: boolean }>;
  /** Test seam for index.lock detection. */
  exists?: (absPath: string) => boolean;
}

/** An untracked file past this size is counted as one file with unknown lines (binary-like). */
const UNTRACKED_READ_BYTES = 1024 * 1024;
/** More untracked files than this are listed, but only the first N are line-counted. */
const UNTRACKED_COUNT_LIMIT = 400;
/** `git hash-object -t tree /dev/null` — diff an unborn branch against nothing. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function defaultCountUntracked(absPath: string): Promise<{ lines: number; binary: boolean }> {
  try {
    const info = await statFile(absPath);
    if (!info.isFile()) return { lines: 0, binary: true };
    if (info.size > UNTRACKED_READ_BYTES) return { lines: 0, binary: true };
    const handle = await openFile(absPath, 'r');
    try {
      const buf = Buffer.alloc(info.size);
      await handle.read(buf, 0, info.size, 0);
      if (buf.subarray(0, 8192).includes(0)) return { lines: 0, binary: true };
      if (info.size === 0) return { lines: 0, binary: false };
      let lines = 0;
      for (const byte of buf) if (byte === 10) lines += 1;
      // A last line with no newline is still a line (git counts it too).
      if (buf[buf.length - 1] !== 10) lines += 1;
      return { lines, binary: false };
    } finally {
      await handle.close();
    }
  } catch {
    return { lines: 0, binary: true };
  }
}

/** Context every git call in one request shares. */
interface Ctx {
  run: GitRunner;
  now: () => number;
  countUntracked: (absPath: string) => Promise<{ lines: number; binary: boolean }>;
  exists: (absPath: string) => boolean;
}

function ctxOf(opts: GitOpsOptions): Ctx {
  return {
    run: opts.runner ?? defaultGitRunner,
    now: opts.now ?? Date.now,
    countUntracked: opts.countUntracked ?? defaultCountUntracked,
    exists: opts.exists ?? existsSync,
  };
}

/** Prefix for every read: no colour, no path quoting, no pager. */
const GIT_READ = ['-c', 'core.quotepath=off', '-c', 'color.ui=false'] as const;

async function git(ctx: Ctx, cwd: string, args: readonly string[], maxStdoutBytes?: number): Promise<GitRunResult> {
  return ctx.run('git', [...GIT_READ, ...args], { cwd, ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }) });
}

const TOPLEVEL_TTL_MS = 60_000;
const topLevelCache = new Map<string, { at: number; value: string | null }>();

/** The repository's top level for `root`, or null when `root` is not inside a git work tree. */
export async function resolveGitRoot(root: string, opts: GitOpsOptions = {}): Promise<string | null> {
  const ctx = ctxOf(opts);
  const hit = topLevelCache.get(root);
  if (hit && ctx.now() - hit.at < TOPLEVEL_TTL_MS) return hit.value;
  const res = await git(ctx, root, ['rev-parse', '--show-toplevel']);
  const value = res.code === 0 && res.stdout.trim() && isAbsolute(res.stdout.trim()) ? resolvePath(res.stdout.trim()) : null;
  boundedSet(topLevelCache, root, { at: ctx.now(), value });
  return value;
}

async function requireGitRoot(root: string, ctx: Ctx, opts: GitOpsOptions): Promise<string> {
  const top = await resolveGitRoot(root, { ...opts, runner: ctx.run, now: ctx.now });
  if (!top) throw new GitOpError('VERSE_GIT_NOT_A_REPO', 'This folder is not a git repository.');
  return top;
}

interface BaseInfo {
  /** Branch name a PR would target ("main"); null when none could be found. */
  base: string | null;
  /** The ref to diff against ("origin/main", or "main" when there is no remote copy). */
  ref: string | null;
}

const BASE_TTL_MS = 60_000;
const baseCache = new Map<string, { at: number; value: BaseInfo }>();

/**
 * Where a PR from this repo would land: `origin/HEAD` (the remote's default
 * branch) when it is set, else the first of origin/main, origin/master,
 * main, master that exists. Cached a minute — it changes about never.
 */
async function resolveBase(ctx: Ctx, gitRoot: string): Promise<BaseInfo> {
  const hit = baseCache.get(gitRoot);
  if (hit && ctx.now() - hit.at < BASE_TTL_MS) return hit.value;
  let value: BaseInfo = { base: null, ref: null };
  const head = await git(ctx, gitRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const headRef = head.code === 0 ? head.stdout.trim() : '';
  if (headRef.startsWith('origin/') && headRef.length > 'origin/'.length) {
    value = { base: headRef.slice('origin/'.length), ref: headRef };
  } else {
    for (const [ref, base] of [
      ['refs/remotes/origin/main', 'main'],
      ['refs/remotes/origin/master', 'master'],
      ['refs/heads/main', 'main'],
      ['refs/heads/master', 'master'],
    ] as const) {
      const probe = await git(ctx, gitRoot, ['rev-parse', '--verify', '--quiet', ref]);
      if (probe.code === 0) {
        value = { base, ref: ref.replace(/^refs\/(?:remotes|heads)\//, '') };
        break;
      }
    }
  }
  boundedSet(baseCache, gitRoot, { at: ctx.now(), value });
  return value;
}

/** A ref for `base` to diff against, preferring the remote's copy. */
async function refForBase(ctx: Ctx, gitRoot: string, base: string): Promise<string | null> {
  for (const ref of [`origin/${base}`, base]) {
    const probe = await git(ctx, gitRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (probe.code === 0) return ref;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PR lookup cache (network; never on the status path's critical path)
// ---------------------------------------------------------------------------

/** A PR answer younger than this is used as is. */
export const PR_FRESH_MS = 20_000;
/** Older than fresh but younger than this: served while one background re-read runs. */
const PR_STALE_MS = 10 * 60_000;

interface PrEntry {
  at: number;
  lookup: 'ok' | 'unavailable';
  pr: VerseGitPr | null;
  counts: VerseGitCheckCounts | null;
}

const prCache = new Map<string, PrEntry>();
const prInFlight = new Map<string, Promise<PrEntry>>();

function prKey(gitRoot: string, branch: string): string {
  return `${gitRoot}\0${branch}`;
}

/**
 * Ask gh for the PR whose head is `branch` (the most recent one, merged and
 * closed included — so the bar can say "Merged ✓"). "No PR" is an answer
 * (`ok`, null); anything else gh could not do is `unavailable`.
 */
async function fetchBranchPr(ctx: Ctx, gitRoot: string, branch: string): Promise<PrEntry> {
  const res = await ctx.run('gh', ['pr', 'view', branch, '--json', GH_PR_FIELDS], { cwd: gitRoot, maxStdoutBytes: 1024 * 1024 });
  const at = ctx.now();
  if (res.code === 0) {
    try {
      const parsed = parseGhPr(JSON.parse(res.stdout));
      if (parsed) return { at, lookup: 'ok', pr: parsed.pr, counts: parsed.counts };
    } catch {
      /* fall through: an unreadable answer is not "no PR" */
    }
    return { at, lookup: 'unavailable', pr: null, counts: null };
  }
  if (/no pull requests found/i.test(res.stderr)) return { at, lookup: 'ok', pr: null, counts: null };
  return { at, lookup: 'unavailable', pr: null, counts: null };
}

function refreshPr(ctx: Ctx, gitRoot: string, branch: string): Promise<PrEntry> {
  const key = prKey(gitRoot, branch);
  const running = prInFlight.get(key);
  if (running) return running;
  const job = fetchBranchPr(ctx, gitRoot, branch)
    .then((entry) => {
      boundedSet(prCache, key, entry);
      return entry;
    })
    .finally(() => prInFlight.delete(key));
  prInFlight.set(key, job);
  return job;
}

/** The cached PR answer for `branch`, kicking off a refresh when it is stale or missing. Never waits on gh. */
function cachedPr(ctx: Ctx, gitRoot: string, branch: string): PrEntry | 'pending' {
  const entry = prCache.get(prKey(gitRoot, branch));
  const age = entry ? ctx.now() - entry.at : Infinity;
  if (age >= PR_FRESH_MS) void refreshPr(ctx, gitRoot, branch).catch(() => { /* next read retries */ });
  if (!entry || age >= PR_STALE_MS) return 'pending';
  return entry;
}

// ---------------------------------------------------------------------------
// Diff listing (shared by status's ± counts and the Review pane's file tree)
// ---------------------------------------------------------------------------

interface Listing {
  files: VerseGitDiffFile[];
  base: string | null;
}

async function listChanges(
  ctx: Ctx,
  gitRoot: string,
  ref: string,
  untracked: readonly string[],
): Promise<VerseGitDiffFile[]> {
  const [numstat, names] = await Promise.all([
    git(ctx, gitRoot, ['diff', '-z', '--numstat', '-M', ref, '--']),
    git(ctx, gitRoot, ['diff', '-z', '--name-status', '-M', ref, '--']),
  ]);
  if (numstat.code !== 0 || names.code !== 0) throw classifyGitFailure('Reading the diff', numstat.code !== 0 ? numstat : names);
  const statusByPath = parseNameStatusZ(names.stdout);
  const files: VerseGitDiffFile[] = [];
  const seen = new Set<string>();
  for (const entry of parseNumstatZ(numstat.stdout)) {
    const named = statusByPath.get(entry.path);
    seen.add(entry.path);
    files.push({
      path: entry.path,
      oldPath: entry.oldPath ?? named?.oldPath ?? null,
      status: named?.status ?? (entry.oldPath ? 'R' : 'M'),
      additions: entry.additions,
      deletions: entry.deletions,
      binary: entry.binary,
    });
  }
  // Untracked files are not in `git diff`; they ship all the same.
  let counted = 0;
  for (const path of untracked) {
    if (seen.has(path)) continue;
    seen.add(path);
    let lines = 0;
    let binary = false;
    if (counted < UNTRACKED_COUNT_LIMIT) {
      counted += 1;
      const measured = await ctx.countUntracked(join(gitRoot, path));
      lines = measured.lines;
      binary = measured.binary;
    }
    files.push({ path, oldPath: null, status: 'A', additions: lines, deletions: 0, binary });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

function diffstatOf(files: readonly VerseGitDiffFile[]): VerseGitDiffstat {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}

async function readPorcelain(ctx: Ctx, gitRoot: string): Promise<PorcelainStatus> {
  const res = await git(ctx, gitRoot, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  if (res.code !== 0) throw classifyGitFailure('Reading git status', res);
  return parsePorcelainV2(res.stdout);
}

/** The merge base of HEAD and `ref`, or null (unrelated histories, unborn HEAD). */
async function mergeBase(ctx: Ctx, gitRoot: string, ref: string): Promise<string | null> {
  const res = await git(ctx, gitRoot, ['merge-base', 'HEAD', ref]);
  const sha = res.stdout.trim();
  return res.code === 0 && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
}

async function countCommits(ctx: Ctx, gitRoot: string, range: string): Promise<number | null> {
  const res = await git(ctx, gitRoot, ['rev-list', '--count', range]);
  const n = Number(res.stdout.trim());
  return res.code === 0 && Number.isInteger(n) && n >= 0 ? n : null;
}

async function headSubject(ctx: Ctx, gitRoot: string): Promise<string | null> {
  const res = await git(ctx, gitRoot, ['log', '-1', '--format=%s']);
  const subject = res.stdout.trim();
  return res.code === 0 && subject ? subject.slice(0, 256) : null;
}

/** Every file the scope covers, and the base it was measured against. */
async function listScope(ctx: Ctx, gitRoot: string, scope: VerseGitDiffScope, porcelain: PorcelainStatus): Promise<Listing & { mergeBaseSha: string | null; baseRef: string | null }> {
  const untracked = porcelain.changed.filter((c) => c.untracked).map((c) => c.path);
  if (scope === 'working') {
    const ref = porcelain.oid ?? EMPTY_TREE_SHA;
    return { files: await listChanges(ctx, gitRoot, ref, untracked), base: null, mergeBaseSha: null, baseRef: null };
  }
  const base = await resolveBase(ctx, gitRoot);
  const mb = base.ref && porcelain.oid ? await mergeBase(ctx, gitRoot, base.ref) : null;
  // No base to compare with (no main/master, unrelated histories): the branch
  // scope honestly collapses to "what is uncommitted".
  const ref = mb ?? porcelain.oid ?? EMPTY_TREE_SHA;
  return { files: await listChanges(ctx, gitRoot, ref, untracked), base: base.base, mergeBaseSha: mb, baseRef: base.ref };
}

// ---------------------------------------------------------------------------
// Status (cached VERSE_GIT_STATUS_CACHE_MS, one computation in flight per repo)
// ---------------------------------------------------------------------------

const statusCache = new Map<string, { at: number; value: VerseGitStatusWire }>();
const statusInFlight = new Map<string, Promise<VerseGitStatusWire>>();

/**
 * GET /api/verse/git/status for one root. `root` is echoed back as asked
 * (the page keys its rows by it); everything else describes the repository
 * that contains it.
 */
export async function readGitStatus(root: string, opts: GitOpsOptions & { fresh?: boolean } = {}): Promise<VerseGitStatusWire> {
  const ctx = ctxOf(opts);
  const gitRoot = await requireGitRoot(root, ctx, opts);
  const hit = statusCache.get(gitRoot);
  if (!opts.fresh && hit && ctx.now() - hit.at < VERSE_GIT_STATUS_CACHE_MS) {
    return withPr(ctx, { ...hit.value, root });
  }
  let job = statusInFlight.get(gitRoot);
  if (!job) {
    job = computeStatus(ctx, gitRoot).finally(() => statusInFlight.delete(gitRoot));
    statusInFlight.set(gitRoot, job);
  }
  const value = await job;
  boundedSet(statusCache, gitRoot, { at: ctx.now(), value });
  return { ...value, root };
}

/** Re-attach the latest PR answer to a cached status (it may have landed since). */
function withPr(ctx: Ctx, status: VerseGitStatusWire): VerseGitStatusWire {
  if (status.branch === null) return status;
  const entry = cachedPr(ctx, status.gitRoot, status.branch);
  const pr = entry === 'pending' ? null : entry.pr;
  const prLookup: VerseGitPrLookup = entry === 'pending' ? 'pending' : entry.lookup;
  if (prLookup === status.prLookup && pr === status.pr) return status;
  const next: VerseGitStatusWire = { ...status, pr, prLookup, prCheckCounts: entry === 'pending' ? null : entry.counts };
  next.suggested = suggestGitAction(suggestInputFor(next, statusShipCommits.get(status.gitRoot) ?? null));
  return next;
}

/** Commits ahead of base per repo, remembered so a cached status can be re-suggested without git. */
const statusShipCommits = new Map<string, number | null>();

function suggestInputFor(s: VerseGitStatusWire, commitsAheadOfBase: number | null): SuggestInput {
  return {
    branch: s.branch,
    base: s.base,
    dirty: s.dirty,
    conflicts: s.conflicts,
    upstream: s.upstream,
    ahead: s.ahead,
    shipFiles: s.diffstat.files,
    commitsAheadOfBase,
    pr: s.pr,
    prLookup: s.prLookup,
  };
}

async function computeStatus(ctx: Ctx, gitRoot: string): Promise<VerseGitStatusWire> {
  const [porcelain, subject] = await Promise.all([readPorcelain(ctx, gitRoot), headSubject(ctx, gitRoot)]);
  const listing = await listScope(ctx, gitRoot, 'branch', porcelain);

  const prEntry = porcelain.branch ? cachedPr(ctx, gitRoot, porcelain.branch) : 'pending';
  const pr = prEntry === 'pending' ? null : prEntry.pr;
  const prLookup: VerseGitPrLookup = porcelain.branch === null ? 'unavailable' : prEntry === 'pending' ? 'pending' : prEntry.lookup;

  // A PR decides the base: the bar must measure against what the PR targets.
  let base = listing.base;
  let files = listing.files;
  let commitsAheadOfBase: number | null = null;
  if (pr && pr.baseRef && pr.baseRef !== base) {
    const ref = await refForBase(ctx, gitRoot, pr.baseRef);
    if (ref) {
      base = pr.baseRef;
      const mb = porcelain.oid ? await mergeBase(ctx, gitRoot, ref) : null;
      if (mb) {
        files = await listChanges(ctx, gitRoot, mb, porcelain.changed.filter((c) => c.untracked).map((c) => c.path));
        commitsAheadOfBase = await countCommits(ctx, gitRoot, `${mb}..HEAD`);
      }
    }
  } else if (listing.mergeBaseSha) {
    commitsAheadOfBase = await countCommits(ctx, gitRoot, `${listing.mergeBaseSha}..HEAD`);
  }
  statusShipCommits.set(gitRoot, commitsAheadOfBase);

  const status: VerseGitStatusWire = {
    root: gitRoot,
    gitRoot,
    name: basename(gitRoot),
    branch: porcelain.branch,
    upstream: porcelain.upstream,
    base,
    ahead: porcelain.ahead,
    behind: porcelain.behind,
    dirty: porcelain.changed.length,
    conflicts: porcelain.conflicts,
    diffstat: diffstatOf(files),
    pr,
    prLookup,
    prCheckCounts: prEntry === 'pending' ? null : prEntry.counts,
    suggested: 'none',
    headSubject: subject,
    headSha: porcelain.oid,
    checkedAt: new Date(ctx.now()).toISOString(),
  };
  status.suggested = suggestGitAction(suggestInputFor(status, commitsAheadOfBase));
  return status;
}

/** Drop every cached answer for a repo (after a mutation, or for tests with no argument). */
export function invalidateGitCaches(gitRoot?: string): void {
  if (gitRoot === undefined) {
    statusCache.clear();
    statusInFlight.clear();
    prCache.clear();
    prInFlight.clear();
    baseCache.clear();
    topLevelCache.clear();
    statusShipCommits.clear();
    return;
  }
  statusCache.delete(gitRoot);
  baseCache.delete(gitRoot);
  for (const key of [...prCache.keys()]) if (key.startsWith(`${gitRoot}\0`)) prCache.delete(key);
}

// ---------------------------------------------------------------------------
// Diff (the Review pane)
// ---------------------------------------------------------------------------

/**
 * A file path the page may ask a patch for: relative, no `..` segment, no NUL,
 * no leading dash (it could read as an option even after `--`-less callers).
 * The route ALSO requires it to be in the scope's own file list, so the diff
 * route can never be used to read an arbitrary file.
 */
export function isSafeRepoPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return false;
  if (path.includes('\0') || path.startsWith('/') || path.startsWith('-') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]/).some((seg) => seg === '..');
}

/** GET /api/verse/git/diff?root=&scope=working|branch[&file=] */
export async function readGitDiff(
  root: string,
  scope: VerseGitDiffScope,
  file: string | null,
  opts: GitOpsOptions = {},
): Promise<VerseGitDiffResponse & { patchBytes: number | null }> {
  const ctx = ctxOf(opts);
  const gitRoot = await requireGitRoot(root, ctx, opts);
  if (file !== null && !isSafeRepoPath(file)) throw new GitOpError('VERSE_INVALID', 'file must be a path inside the repository.');
  const porcelain = await readPorcelain(ctx, gitRoot);
  const listing = await listScope(ctx, gitRoot, scope, porcelain);
  let patch: VerseGitDiffResponse['patch'] = null;
  let patchBytes: number | null = null;
  if (file !== null) {
    const entry = listing.files.find((f) => f.path === file);
    if (!entry) throw new GitOpError('VERSE_GIT_REFUSED', 'That file has no changes in this view any more.');
    const untracked = porcelain.changed.some((c) => c.untracked && c.path === file);
    const ref = scope === 'working' ? porcelain.oid ?? EMPTY_TREE_SHA : listing.mergeBaseSha ?? porcelain.oid ?? EMPTY_TREE_SHA;
    const args = untracked
      // `--no-index` exits 1 when the files differ — which, for /dev/null, they always do.
      ? ['diff', '--no-index', '--no-color', '--', '/dev/null', file]
      : ['diff', '--no-color', '-M', ref, '--', ...(entry.oldPath ? [entry.oldPath] : []), file];
    // One byte over the cap tells us the patch was cut, without reading megabytes to find out.
    const res = await git(ctx, gitRoot, args, VERSE_GIT_PATCH_MAX_BYTES + 1);
    if (!res.truncated && res.code !== 0 && !(untracked && res.code === 1)) throw classifyGitFailure('Reading the patch', res);
    const bytes = Buffer.byteLength(res.stdout, 'utf8');
    const truncated = res.truncated || bytes > VERSE_GIT_PATCH_MAX_BYTES;
    let text = res.stdout;
    if (truncated) {
      // Cut on a line boundary so the parser never sees half a line.
      text = Buffer.from(res.stdout, 'utf8').subarray(0, VERSE_GIT_PATCH_MAX_BYTES).toString('utf8');
      const nl = text.lastIndexOf('\n');
      if (nl > 0) text = text.slice(0, nl + 1);
    }
    patch = { path: file, text, truncated };
    patchBytes = bytes;
  }
  return { root, scope, base: listing.base, files: listing.files, patch, patchBytes };
}

// ===========================================================================
// Mutations
// ===========================================================================

const rootLocks = new Set<string>();

/**
 * Run `fn` holding this repository's mutation lock. Refuses (409) instead of
 * queueing — see rule 3 — and also when another process holds git's own
 * index lock (a terminal `git rebase`, an agent's commit).
 */
export async function withRepoLock<T>(gitRoot: string, fn: () => Promise<T>, opts: GitOpsOptions = {}): Promise<T> {
  const ctx = ctxOf(opts);
  if (rootLocks.has(gitRoot)) throw new GitBusyError('Another git action is still running in this repository.');
  rootLocks.add(gitRoot);
  try {
    const lockPath = await git(ctx, gitRoot, ['rev-parse', '--git-path', 'index.lock']);
    const rel = lockPath.stdout.trim();
    if (lockPath.code === 0 && rel && ctx.exists(isAbsolute(rel) ? rel : join(gitRoot, rel))) {
      throw new GitBusyError('Another git process is working in this repository (its index is locked). Try again when it finishes.');
    }
    return await fn();
  } finally {
    rootLocks.delete(gitRoot);
    invalidateGitCaches(gitRoot);
  }
}

async function mutate(ctx: Ctx, gitRoot: string, action: string, args: readonly string[]): Promise<GitRunResult> {
  const res = await ctx.run('git', args, { cwd: gitRoot });
  if (res.code !== 0) throw classifyGitFailure(action, res);
  return res;
}

export interface CommitInput {
  message: string;
  /** Repo-relative paths; absent = every change. Each must be a current change. */
  paths?: readonly string[];
}

/** POST /api/verse/git/commit */
export async function commitChanges(root: string, input: CommitInput, opts: GitOpsOptions = {}): Promise<VerseGitStatusWire> {
  const ctx = ctxOf(opts);
  const gitRoot = await requireGitRoot(root, ctx, opts);
  await withRepoLock(gitRoot, async () => {
    const porcelain = await readPorcelain(ctx, gitRoot);
    if (porcelain.branch === null) throw new GitOpError('VERSE_GIT_REFUSED', 'HEAD is detached. Switch to a branch before committing.');
    if (porcelain.conflicts > 0) throw new GitOpError('VERSE_GIT_REFUSED', 'Resolve the merge conflicts before committing.');
    if (porcelain.changed.length === 0) throw new GitOpError('VERSE_GIT_REFUSED', 'There is nothing to commit.');
    let paths: string[] | null = null;
    if (input.paths !== undefined) {
      const known = new Set<string>();
      for (const c of porcelain.changed) {
        known.add(c.path);
        if (c.oldPath) known.add(c.oldPath);
      }
      paths = [];
      for (const p of input.paths) {
        if (!isSafeRepoPath(p) || !known.has(p)) throw new GitOpError('VERSE_INVALID', 'Every path must be one of the current changes.');
        paths.push(p);
      }
      if (paths.length === 0) throw new GitOpError('VERSE_INVALID', 'Choose at least one file to commit.');
    }
    await mutate(ctx, gitRoot, 'Staging', paths ? ['add', '-A', '--', ...paths] : ['add', '-A']);
    // With paths: commit ONLY those (`--only` is git's default for a pathspec),
    // so something the operator staged earlier by hand is not swept in.
    await mutate(ctx, gitRoot, 'Committing', paths ? ['commit', '-m', input.message, '--', ...paths] : ['commit', '-m', input.message]);
  }, opts);
  return readGitStatus(root, { ...opts, fresh: true });
}

/** Push HEAD: `-u origin HEAD` for a branch the remote has never seen, else to its upstream. Never forced. */
async function pushHead(ctx: Ctx, gitRoot: string, porcelain: PorcelainStatus): Promise<void> {
  if (porcelain.branch === null) throw new GitOpError('VERSE_GIT_REFUSED', 'HEAD is detached. Switch to a branch before pushing.');
  if (porcelain.oid === null) throw new GitOpError('VERSE_GIT_REFUSED', 'This branch has no commits to push yet.');
  if (porcelain.upstream === null) {
    const remotes = await git(ctx, gitRoot, ['remote']);
    if (!remotes.stdout.split('\n').map((r) => r.trim()).includes('origin')) {
      throw new GitOpError('VERSE_GIT_REFUSED', 'This repository has no remote named origin to push to.');
    }
    await mutate(ctx, gitRoot, 'Pushing', ['push', '-u', 'origin', 'HEAD']);
  } else {
    await mutate(ctx, gitRoot, 'Pushing', ['push']);
  }
}

/** POST /api/verse/git/push */
export async function pushBranch(root: string, opts: GitOpsOptions = {}): Promise<VerseGitStatusWire> {
  const ctx = ctxOf(opts);
  const gitRoot = await requireGitRoot(root, ctx, opts);
  await withRepoLock(gitRoot, async () => {
    const porcelain = await readPorcelain(ctx, gitRoot);
    if (porcelain.upstream !== null && porcelain.ahead === 0) {
      throw new GitOpError('VERSE_GIT_REFUSED', 'Everything on this branch is already pushed.');
    }
    await pushHead(ctx, gitRoot, porcelain);
  }, opts);
  return readGitStatus(root, { ...opts, fresh: true });
}

export interface PrInput {
  title: string;
  body?: string;
  draft?: boolean;
  base?: string;
}

/** A branch name git would accept (the subset we pass to gh as --base). */
export function isSafeBranchName(name: string): boolean {
  return typeof name === 'string'
    && name.length > 0 && name.length <= 255
    && !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.lock')
    && !name.includes('..') && !name.includes('@{') && !name.includes('//')
    && !/[\s~^:?*[\\]/.test(name)
    // Control characters (NUL..US, DEL) — git refuses them in a ref name.
    && ![...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
}

async function freshPr(ctx: Ctx, gitRoot: string, selector: string): Promise<{ pr: VerseGitPr; counts: VerseGitCheckCounts } | null> {
  const res = await ctx.run('gh', ['pr', 'view', selector, '--json', GH_PR_FIELDS], { cwd: gitRoot, maxStdoutBytes: 1024 * 1024 });
  if (res.code !== 0) {
    if (/no pull requests found/i.test(res.stderr)) return null;
    throw classifyGitFailure('Reading the PR from GitHub', res);
  }
  try {
    return parseGhPr(JSON.parse(res.stdout));
  } catch {
    throw new GitOpError('VERSE_GIT_FAILED', 'GitHub answered with something that is not a PR.');
  }
}

/**
 * POST /api/verse/git/pr — push first (rule 1), then open the PR. Idempotent:
 * when the branch already has an OPEN PR, that PR is returned instead of
 * failing on gh's "already exists".
 */
export async function openPullRequest(root: string, input: PrInput, opts: GitOpsOptions = {}): Promise<{ status: VerseGitStatusWire; pr: VerseGitPr }> {
  const ctx = ctxOf(opts);
  const gitRoot = await requireGitRoot(root, ctx, opts);
  let pr: VerseGitPr | null = null;
  await withRepoLock(gitRoot, async () => {
    const porcelain = await readPorcelain(ctx, gitRoot);
    const branch = porcelain.branch;
    if (branch === null) throw new GitOpError('VERSE_GIT_REFUSED', 'HEAD is detached. Switch to a branch before opening a PR.');
    const baseInfo = await resolveBase(ctx, gitRoot);
    const base = input.base ?? baseInfo.base;
    if (base === null) throw new GitOpError('VERSE_GIT_REFUSED', 'Could not tell which branch the PR should target. Choose a base branch.');
    if (!isSafeBranchName(base)) throw new GitOpError('VERSE_INVALID', 'base must be a branch name.');
    if (branch === base) throw new GitOpError('VERSE_GIT_REFUSED', `You are on ${base} itself. Create a branch for this work first.`);

    const existing = await freshPr(ctx, gitRoot, branch);
    if (existing && (existing.pr.state === 'open' || existing.pr.state === 'draft')) {
      pr = existing.pr;
      return;
    }
    // Rule 1: the remote must have exactly what HEAD has before gh is asked.
    if (porcelain.upstream === null || porcelain.ahead > 0) await pushHead(ctx, gitRoot, porcelain);

    const args = ['pr', 'create', '--title', input.title, '--body', input.body ?? '', '--base', base, '--head', branch];
    if (input.draft) args.push('--draft');
    const created = await ctx.run('gh', args, { cwd: gitRoot });
    if (created.code !== 0 && !/already exists/i.test(created.stderr)) throw classifyGitFailure('Opening the PR', created);
    const read = await freshPr(ctx, gitRoot, branch);
    if (!read) throw new GitOpError('VERSE_GIT_FAILED', 'GitHub accepted the PR but did not return it yet. Refresh in a moment.');
    pr = read.pr;
    boundedSet(prCache, prKey(gitRoot, branch), { at: ctx.now(), lookup: 'ok', pr: read.pr, counts: read.counts });
  }, opts);
  await invalidateGithubPanel();
  const status = await readGitStatus(root, { ...opts, fresh: true });
  return { status, pr: pr! };
}

export interface MergeInput {
  number: number;
  headSha: string;
}

/** Everything that must hold before a merge — pure, so the refusal table is testable on its own. */
export function mergeRefusal(pr: VerseGitPr, branch: string | null, headSha: string): string | null {
  if (branch === null || pr.headRef !== branch) return 'That PR is not this branch’s PR.';
  if (pr.state === 'merged') return 'This PR is already merged.';
  if (pr.state === 'closed') return 'This PR is closed.';
  if (pr.state === 'draft') return 'This PR is a draft. Mark it ready for review on GitHub first.';
  if (pr.checks === 'failing') return 'Checks are failing on this PR.';
  if (pr.checks === 'pending') return 'Checks are still running on this PR.';
  if (pr.checks !== 'passing') return 'No passing checks are reported for this PR’s head, so Verse will not merge it. Merge on GitHub if that is intended.';
  if (pr.mergeable === false) return 'GitHub says this PR has conflicts with its base.';
  if (pr.mergeable === null) return 'GitHub is still working out whether this PR can merge. Try again in a moment.';
  if (pr.headSha === null || pr.headSha.toLowerCase() !== headSha.toLowerCase()) {
    return 'The PR received new commits after you looked at it. Review the new head, then merge again.';
  }
  return null;
}

/** POST /api/verse/git/pr/merge — rule 2. Squash merge, never --admin, never --auto. */
export async function mergePullRequest(root: string, input: MergeInput, opts: GitOpsOptions = {}): Promise<{ status: VerseGitStatusWire; pr: VerseGitPr }> {
  const ctx = ctxOf(opts);
  const gitRoot = await requireGitRoot(root, ctx, opts);
  let merged: VerseGitPr | null = null;
  await withRepoLock(gitRoot, async () => {
    const porcelain = await readPorcelain(ctx, gitRoot);
    const read = await freshPr(ctx, gitRoot, String(input.number));
    if (!read) throw new GitOpError('VERSE_GIT_REFUSED', 'GitHub has no such PR for this repository.');
    const refusal = mergeRefusal(read.pr, porcelain.branch, input.headSha);
    if (refusal) throw new GitOpError('VERSE_GIT_REFUSED', refusal);
    const args = ['pr', 'merge', String(input.number), '--squash', '--match-head-commit', read.pr.headSha!];
    const res = await ctx.run('gh', args, { cwd: gitRoot });
    if (res.code !== 0) throw classifyGitFailure('Merging', res);
    const after = await freshPr(ctx, gitRoot, String(input.number)).catch(() => null);
    merged = after?.pr ?? { ...read.pr, state: 'merged' };
    if (porcelain.branch) {
      boundedSet(prCache, prKey(gitRoot, porcelain.branch), { at: ctx.now(), lookup: 'ok', pr: merged, counts: after?.counts ?? read.counts });
    }
  }, opts);
  await invalidateGithubPanel();
  const status = await readGitStatus(root, { ...opts, fresh: true });
  return { status, pr: merged! };
}

/** The read-only GitHub panel caches PR lists; a PR we just opened or merged must show there too. */
async function invalidateGithubPanel(): Promise<void> {
  try {
    const mod = await import('./github-repo.js');
    mod.invalidateVerseGithubCache();
  } catch {
    /* the panel refreshes on its own schedule */
  }
}

// ===========================================================================
// Small utilities
// ===========================================================================

const CACHE_MAX = 256;

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
