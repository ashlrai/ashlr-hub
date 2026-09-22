/**
 * core/verse/github-repo.ts — per-root GitHub surfacing for Ashlr Verse
 * (docs/VERSE-WORKSPACES.md §2). READ-ONLY. NEVER THROWS.
 *
 * ── AUTH ───────────────────────────────────────────────────────────────────
 * The `gh` CLI owns its own credentials, exactly as core/integrations/github.ts
 * does. This module spawns the same binary with the same env hygiene and holds
 * NO token of its own. There is no second credential path here, and no code
 * path in this file reads, stores, or emits one.
 *
 * ── WHY IT SPAWNS `gh` AT ALL, GIVEN github.ts EXISTS ──────────────────────
 * github.ts does the hard part and this module reuses its conventions
 * verbatim (same binary, same 8 s timeout, same env, same never-throw
 * contract). It does not reuse its two list functions, for two reasons that
 * are contract-level rather than stylistic:
 *
 *   1. CI STATE. `listPrs()` requests `number,title,url,state,author` and
 *      `PrSummary` has no checks field; `githubStatus().ci` is repo-wide,
 *      derived from the last five *workflow runs*, and cannot say which PR is
 *      red. §2 asks for "open PRs and their CI state", which needs
 *      `statusCheckRollup` on the PR query. github.ts exports no runner to
 *      borrow (`runGh` is private), so the query is issued here.
 *   2. FAILURE vs EMPTY. `listPrs()`/`listIssues()` return `[]` both when gh
 *      fails and when nothing is open. An operator staring at an empty panel
 *      must be able to tell "nothing to do" from "could not look", so this
 *      module keeps gh's null and projects it as `prsAvailable` /
 *      `issuesAvailable`.
 *
 * Two `gh` calls per root, both list reads. Remote identity and default branch
 * come from core/git.ts and cost no network at all.
 *
 * ── NO URL LEAVES THIS MODULE ──────────────────────────────────────────────
 * `resolveGitHubOriginAuthorityDetails()` returns fetch/push URLs, and a
 * supported GitHub HTTPS transport may carry credentials in its userinfo. Only
 * `nameWithOwner` is read, so no remote URL can reach a response, a log, or an
 * SSE frame. `gh`'s own stderr is never surfaced either — a failure becomes a
 * fixed sentence, not a passthrough of whatever the tool printed.
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import { defaultBranch, isRepo, resolveGitHubOriginAuthority } from '../git.js';
import type {
  VerseGithubChecks,
  VerseGithubCheckState,
  VerseGithubIssue,
  VerseGithubPr,
  VerseGithubRemote,
  VerseGithubRepoSnapshot,
  VerseGithubSnapshot,
} from './github-types.js';

// ---------------------------------------------------------------------------
// Constants — mirrored from core/integrations/github.ts on purpose
// ---------------------------------------------------------------------------

const GH_BIN = 'gh';
const TIMEOUT_MS = 8_000;

/** gh refuses --limit outside 1..100 on issue list; PRs get the same bound. */
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const DEFAULT_PR_LIMIT = 20;
const DEFAULT_ISSUE_LIMIT = 20;

/** Refuse implausible JSON rather than walking it. Mirrors MAX_PR_VIEW_JSON_LENGTH's intent. */
const MAX_LIST_JSON_LENGTH = 512 * 1024;

const MAX_PATH_CHARS = 4_096;
const MAX_TITLE_CHARS = 256;
const MAX_URL_CHARS = 2_048;
const MAX_STATE_CHARS = 32;
const MAX_REF_CHARS = 256;
const MAX_AUTHOR_CHARS = 128;
const MAX_LABELS = 32;
const MAX_LABEL_CHARS = 128;
/** A rollup longer than this is summarised from the first N; GitHub caps well below. */
const MAX_ROLLUP_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Injection seam (tests use fixtures; nothing here ever reaches the network)
// ---------------------------------------------------------------------------

/** Run `gh` in `cwd`; trimmed stdout, or null on ANY failure. Never throws. */
export type VerseGithubGhRunner = (cwd: string, args: readonly string[]) => string | null;

/** The git facts this module needs. Defaults to core/git.ts. */
export interface VerseGithubGitProbe {
  isRepo(path: string): boolean;
  defaultBranch(path: string): string;
  /** Lowercase `owner/name`, or null when origin does not resolve to one GitHub repo. */
  nameWithOwner(path: string): string | null;
}

export interface VerseGithubReadOptions {
  gh?: VerseGithubGhRunner;
  git?: VerseGithubGitProbe;
  /** 1..100, default 20. */
  prLimit?: number;
  /** 1..100, default 20. */
  issueLimit?: number;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Directory existence seam for tests. */
  isDirectory?: (path: string) => boolean;
}

const realGit: VerseGithubGitProbe = {
  isRepo: (path) => isRepo(path),
  defaultBranch: (path) => defaultBranch(path),
  nameWithOwner: (path) => resolveGitHubOriginAuthority(path),
};

/**
 * Same spawn shape as github.ts's private `runGh`: no shell, array args, tight
 * timeout, colourless non-interactive env. Returns null on spawn error
 * (including ENOENT when gh is absent), non-zero exit, or non-string stdout.
 */
const realGh: VerseGithubGhRunner = (cwd, args) => {
  try {
    const res = spawnSync(GH_BIN, [...args], {
      cwd,
      timeout: TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
      },
    });
    if (res.error) return null;
    if (res.status !== 0) return null;
    if (typeof res.stdout !== 'string') return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  if (raw.length > MAX_LIST_JSON_LENGTH) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/** gh nests author as `{ login }`; a ghost author is null. Mirrors listPrs(). */
function authorLogin(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, MAX_AUTHOR_CHARS);
  if (isRecord(value)) {
    const login = value['login'];
    if (typeof login === 'string') return login.slice(0, MAX_AUTHOR_CHARS);
  }
  return '';
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, value));
}

// ---------------------------------------------------------------------------
// Check rollup
// ---------------------------------------------------------------------------

const PENDING_CHECK_STATUSES = new Set([
  'in_progress',
  'queued',
  'waiting',
  'requested',
  'pending',
]);
const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
]);
const SUCCESS_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const PENDING_CONTEXT_STATES = new Set(['pending', 'expected']);
const FAILURE_CONTEXT_STATES = new Set(['failure', 'error']);

const UNKNOWN_CHECKS: VerseGithubChecks = {
  state: 'unknown',
  total: 0,
  passed: 0,
  failed: 0,
  pending: 0,
};

/**
 * Summarise one PR's `statusCheckRollup`.
 *
 * Handles both GraphQL variants gh emits: `CheckRun` (`status`/`conclusion`)
 * and `StatusContext` (`state`). Entries of neither shape are counted as
 * pending rather than silently dropped — an unrecognised check is not a
 * passing one.
 *
 * FAILING WINS OVER PENDING, deliberately diverging from
 * `resolveCiStatus()`'s first-match-wins scan in github.ts: that function
 * summarises the last five workflow *runs* of a repo, where "something is
 * running" is the useful headline. Here the operator is deciding whether to
 * touch a specific PR, and a red check must not be hidden behind a queued one.
 */
export function summarizeCheckRollup(rollup: unknown): VerseGithubChecks {
  if (!Array.isArray(rollup)) return { ...UNKNOWN_CHECKS };
  if (rollup.length === 0) {
    return { state: 'none', total: 0, passed: 0, failed: 0, pending: 0 };
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const entry of rollup.slice(0, MAX_ROLLUP_ENTRIES)) {
    if (!isRecord(entry)) {
      pending += 1;
      continue;
    }
    const status = typeof entry['status'] === 'string' ? entry['status'].toLowerCase() : '';
    const conclusion =
      typeof entry['conclusion'] === 'string' ? entry['conclusion'].toLowerCase() : '';
    const contextState = typeof entry['state'] === 'string' ? entry['state'].toLowerCase() : '';

    if (status) {
      if (PENDING_CHECK_STATUSES.has(status)) {
        pending += 1;
      } else if (FAILURE_CONCLUSIONS.has(conclusion)) {
        failed += 1;
      } else if (status === 'completed' && conclusion && !SUCCESS_CONCLUSIONS.has(conclusion)) {
        failed += 1;
      } else if (SUCCESS_CONCLUSIONS.has(conclusion)) {
        passed += 1;
      } else {
        // Completed with no conclusion yet, or a status gh has not documented.
        pending += 1;
      }
      continue;
    }

    if (contextState) {
      if (PENDING_CONTEXT_STATES.has(contextState)) pending += 1;
      else if (FAILURE_CONTEXT_STATES.has(contextState)) failed += 1;
      else if (contextState === 'success') passed += 1;
      else pending += 1;
      continue;
    }

    pending += 1;
  }

  const total = passed + failed + pending;
  let state: VerseGithubCheckState;
  if (total === 0) state = 'none';
  else if (failed > 0) state = 'failing';
  else if (pending > 0) state = 'pending';
  else state = 'passing';

  return { state, total, passed, failed, pending };
}

// ---------------------------------------------------------------------------
// PR + issue parsing
// ---------------------------------------------------------------------------

const PR_JSON_FIELDS =
  'number,title,url,state,author,isDraft,headRefName,baseRefName,statusCheckRollup';
const ISSUE_JSON_FIELDS = 'number,title,url,state,author,labels';

/**
 * Parse `gh pr list --json <PR_JSON_FIELDS>` output.
 *
 * Malformed entries are DROPPED, not defaulted — the same choice
 * `listIssues()` makes and the opposite of `listPrs()`, which coerces a
 * missing number to 0. A PR row that cannot name its own number or URL is not
 * something an operator should be offered a link to.
 */
export function parsePrList(parsed: unknown): VerseGithubPr[] {
  if (!Array.isArray(parsed)) return [];
  const out: VerseGithubPr[] = [];
  for (const raw of parsed) {
    if (!isRecord(raw)) continue;
    const number = positiveInt(raw['number']);
    const title = boundedString(raw['title'], MAX_TITLE_CHARS);
    const url = boundedString(raw['url'], MAX_URL_CHARS);
    const state = boundedString(raw['state'], MAX_STATE_CHARS);
    if (number === null || title === null || url === null || state === null) continue;
    out.push({
      number,
      title,
      url,
      state: state.toLowerCase(),
      author: authorLogin(raw['author']),
      draft: raw['isDraft'] === true,
      headRefName: boundedString(raw['headRefName'], MAX_REF_CHARS),
      baseRefName: boundedString(raw['baseRefName'], MAX_REF_CHARS),
      checks: summarizeCheckRollup(raw['statusCheckRollup']),
    });
  }
  return out;
}

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value.slice(0, MAX_LABELS)) {
    const name = isRecord(raw) ? boundedString(raw['name'], MAX_LABEL_CHARS) : null;
    if (name) out.push(name);
  }
  return out;
}

/** Parse `gh issue list --json <ISSUE_JSON_FIELDS>`. Malformed entries dropped. */
export function parseIssueList(parsed: unknown): VerseGithubIssue[] {
  if (!Array.isArray(parsed)) return [];
  const out: VerseGithubIssue[] = [];
  for (const raw of parsed) {
    if (!isRecord(raw)) continue;
    const number = positiveInt(raw['number']);
    const title = boundedString(raw['title'], MAX_TITLE_CHARS);
    const url = boundedString(raw['url'], MAX_URL_CHARS);
    const state = boundedString(raw['state'], MAX_STATE_CHARS);
    if (number === null || title === null || url === null || state === null) continue;
    out.push({
      number,
      title,
      url,
      state: state.toLowerCase(),
      author: authorLogin(raw['author']),
      labels: parseLabels(raw['labels']),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

function realIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function emptySnapshot(
  path: string,
  remote: VerseGithubRemote,
  observedAt: string,
  detail: string,
): VerseGithubRepoSnapshot {
  return {
    path,
    name: basename(path) || path,
    remote,
    prs: [],
    issues: [],
    prsAvailable: false,
    issuesAvailable: false,
    observedAt,
    detail,
  };
}

/**
 * Read one workspace root. Never throws, never returns a remote URL, and never
 * mutates anything — the only subprocesses are `git` reads via core/git.ts and
 * two `gh` list reads.
 */
export function readVerseGithubRepo(
  path: string,
  opts: VerseGithubReadOptions = {},
): VerseGithubRepoSnapshot {
  const now = opts.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const gh = opts.gh ?? realGh;
  const git = opts.git ?? realGit;
  const isDirectory = opts.isDirectory ?? realIsDirectory;
  const prLimit = clampLimit(opts.prLimit, DEFAULT_PR_LIMIT);
  const issueLimit = clampLimit(opts.issueLimit, DEFAULT_ISSUE_LIMIT);

  const notARepo: VerseGithubRemote = {
    state: 'not-a-repo',
    nameWithOwner: null,
    defaultBranch: null,
  };

  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_CHARS) {
    return emptySnapshot(typeof path === 'string' ? path : '', notARepo, observedAt, 'invalid path');
  }
  if (!isAbsolute(path)) {
    return emptySnapshot(path, notARepo, observedAt, 'path is not absolute');
  }
  if (!isDirectory(path)) {
    return emptySnapshot(path, notARepo, observedAt, 'not a directory');
  }

  let repoIsGit = false;
  try {
    repoIsGit = git.isRepo(path);
  } catch {
    repoIsGit = false;
  }
  if (!repoIsGit) {
    return emptySnapshot(path, notARepo, observedAt, 'not a git repository');
  }

  let branch: string | null = null;
  try {
    branch = git.defaultBranch(path);
  } catch {
    branch = null;
  }

  let nameWithOwner: string | null = null;
  try {
    nameWithOwner = git.nameWithOwner(path);
  } catch {
    nameWithOwner = null;
  }

  if (!nameWithOwner) {
    return emptySnapshot(
      path,
      { state: 'not-github', nameWithOwner: null, defaultBranch: branch },
      observedAt,
      'origin does not resolve to a single GitHub repository',
    );
  }

  const remote: VerseGithubRemote = {
    state: 'github',
    nameWithOwner,
    defaultBranch: branch,
  };

  const prRaw = runList(gh, path, 'pr', PR_JSON_FIELDS, prLimit);
  const issueRaw = runList(gh, path, 'issue', ISSUE_JSON_FIELDS, issueLimit);

  const prsAvailable = prRaw !== null;
  const issuesAvailable = issueRaw !== null;
  const prs = prsAvailable ? parsePrList(prRaw) : [];
  const issues = issuesAvailable ? parseIssueList(issueRaw) : [];

  return {
    path,
    name: basename(path) || path,
    remote,
    prs,
    issues,
    prsAvailable,
    issuesAvailable,
    observedAt,
    detail: describe(prsAvailable, issuesAvailable, prs.length, issues.length),
  };
}

/** One `gh <kind> list` read. Null (not []) when gh could not answer. */
function runList(
  gh: VerseGithubGhRunner,
  cwd: string,
  kind: 'pr' | 'issue',
  fields: string,
  limit: number,
): unknown {
  const raw = gh(cwd, [
    kind,
    'list',
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    fields,
  ]);
  if (raw === null) return null;
  const parsed = safeJson(raw);
  // gh answered but the payload is not a list: treat as unavailable rather
  // than as "nothing open", which would be a lie the UI cannot detect.
  return Array.isArray(parsed) ? parsed : null;
}

function describe(
  prsAvailable: boolean,
  issuesAvailable: boolean,
  prCount: number,
  issueCount: number,
): string {
  if (!prsAvailable && !issuesAvailable) {
    return 'gh could not answer — it may be missing, unauthenticated, or offline';
  }
  const parts: string[] = [];
  parts.push(prsAvailable ? `${prCount} open pull request${prCount === 1 ? '' : 's'}` : 'pull requests unavailable');
  parts.push(issuesAvailable ? `${issueCount} open issue${issueCount === 1 ? '' : 's'}` : 'issues unavailable');
  return parts.join(', ');
}

/** Read several roots in order, de-duplicated by path. Never throws. */
export function readVerseGithubSnapshot(
  paths: readonly string[],
  opts: VerseGithubReadOptions = {},
): VerseGithubSnapshot {
  const now = opts.now ?? (() => new Date());
  const seen = new Set<string>();
  const repos: VerseGithubRepoSnapshot[] = [];
  for (const path of paths) {
    if (typeof path !== 'string' || seen.has(path)) continue;
    seen.add(path);
    repos.push(readVerseGithubRepo(path, opts));
  }
  return { repos, observedAt: now().toISOString() };
}
