/**
 * core/integrations/github.ts — GitHub integration via the `gh` CLI.
 *
 * RULES:
 *  - READ-FIRST: githubStatus, listPrs, listIssues are read-only and NEVER throw.
 *    On any failure (gh missing, not authed, not a repo, malformed output) they
 *    return a safe empty/degraded shape.
 *  - NEVER handle, read, log, or print raw tokens. `gh` owns its own auth.
 *  - createPr is EXPLICIT + MUTATING. The CLI layer (cli/gh.ts) MUST gate it
 *    behind an explicit `ashlr gh pr create` + confirmation prompt before calling.
 *  - All spawns use spawnSync (no shell) with a tight timeout.
 */

import { spawnSync } from 'node:child_process';
import type { GithubStatus } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GH_BIN = 'gh';
const TIMEOUT_MS = 8_000; // ms — gh can be slow on first auth check

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A single PR summary (read-only list). */
export interface PrSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
}

/** A single issue summary (read-only list). */
export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
}

/** Options for creating a PR (EXPLICIT mutation only). */
export interface CreatePrOpts {
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

/** Result of a PR creation (EXPLICIT mutation only). */
export interface CreatePrResult {
  ok: boolean;
  url: string | null;
  detail: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a `gh` sub-command synchronously in `cwd`.
 * Returns trimmed stdout on success (exit 0), or null on any error.
 * NEVER throws.
 */
function runGh(cwd: string, args: string[]): string | null {
  try {
    const res = spawnSync(GH_BIN, args, {
      cwd,
      timeout: TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf8',
      // Suppress interactive prompts; gh is already authed via its own config.
      env: {
        ...process.env,
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
      },
    });
    // spawn error (e.g. ENOENT — gh not on PATH) or non-zero exit → null.
    if (res.error) return null;
    if (res.status !== 0) return null;
    return typeof res.stdout === 'string' ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON string safely. Returns null on any parse error.
 */
function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Determine CI status from the most recent workflow runs in cwd.
 * Uses `gh run list --limit 5 --json status,conclusion` and aggregates:
 *   - any 'in_progress' / 'queued' / 'waiting' → 'pending'
 *   - any 'failure' / 'cancelled' / 'timed_out' → 'failing'
 *   - all 'success' / 'skipped' / 'neutral' → 'passing'
 *   - no runs found → 'none'
 * NEVER throws.
 */
function resolveCiStatus(cwd: string): GithubStatus['ci'] {
  const raw = runGh(cwd, [
    'run',
    'list',
    '--limit',
    '5',
    '--json',
    'status,conclusion',
  ]);
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) return 'none';

  type RunEntry = { status?: string; conclusion?: string };
  const runs = parsed as RunEntry[];

  const IN_PROGRESS_STATUSES = new Set([
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

  for (const run of runs) {
    const status = (run.status ?? '').toLowerCase();
    const conclusion = (run.conclusion ?? '').toLowerCase();

    if (IN_PROGRESS_STATUSES.has(status)) return 'pending';
    if (FAILURE_CONCLUSIONS.has(conclusion)) return 'failing';
    // completed with non-success conclusion is also failing
    if (status === 'completed' && conclusion && !SUCCESS_CONCLUSIONS.has(conclusion)) {
      return 'failing';
    }
  }

  // If we get here all completed runs were success/skipped/neutral
  return 'passing';
}

// ---------------------------------------------------------------------------
// Public API — READ-ONLY (never throw)
// ---------------------------------------------------------------------------

/**
 * Read-only repo snapshot via `gh`. NEVER throws — degrades to a not-a-repo
 * shape when cwd is not a GitHub repo or gh is unavailable / not authed.
 */
export function githubStatus(cwd: string): GithubStatus {
  const NOT_A_REPO: GithubStatus = {
    isRepo: false,
    openPrs: 0,
    openIssues: 0,
    ci: 'none',
    repo: null,
  };

  // ── 1. Confirm it's a GitHub repo ────────────────────────────────────────
  const repoRaw = runGh(cwd, ['repo', 'view', '--json', 'nameWithOwner']);
  if (!repoRaw) return NOT_A_REPO;

  const repoParsed = safeJson(repoRaw);
  if (
    repoParsed === null ||
    typeof repoParsed !== 'object' ||
    Array.isArray(repoParsed)
  ) {
    return NOT_A_REPO;
  }
  const repoObj = repoParsed as Record<string, unknown>;
  const repoSlug =
    typeof repoObj['nameWithOwner'] === 'string'
      ? repoObj['nameWithOwner']
      : null;
  if (!repoSlug) return NOT_A_REPO;

  // ── 2. Open PR count ─────────────────────────────────────────────────────
  let openPrs = 0;
  {
    const raw = runGh(cwd, [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number',
    ]);
    const parsed = safeJson(raw);
    if (Array.isArray(parsed)) openPrs = parsed.length;
  }

  // ── 3. Open issue count ──────────────────────────────────────────────────
  let openIssues = 0;
  {
    const raw = runGh(cwd, [
      'issue',
      'list',
      '--state',
      'open',
      '--json',
      'number',
    ]);
    const parsed = safeJson(raw);
    if (Array.isArray(parsed)) openIssues = parsed.length;
  }

  // ── 4. CI status ─────────────────────────────────────────────────────────
  const ci = resolveCiStatus(cwd);

  return {
    isRepo: true,
    openPrs,
    openIssues,
    ci,
    repo: repoSlug,
  };
}

/**
 * List open PRs via `gh pr list`. NEVER throws — returns [] on any failure.
 */
export function listPrs(cwd: string): PrSummary[] {
  const raw = runGh(cwd, [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,url,state,author',
  ]);
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) return [];

  const results: PrSummary[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;

    const number = typeof obj['number'] === 'number' ? obj['number'] : 0;
    const title = typeof obj['title'] === 'string' ? obj['title'] : '';
    const url = typeof obj['url'] === 'string' ? obj['url'] : '';
    const state = typeof obj['state'] === 'string' ? obj['state'] : '';

    // author is a nested { login: string } object in gh's JSON output
    let author = '';
    if (obj['author'] !== null && typeof obj['author'] === 'object') {
      const a = obj['author'] as Record<string, unknown>;
      if (typeof a['login'] === 'string') author = a['login'];
    } else if (typeof obj['author'] === 'string') {
      author = obj['author'];
    }

    results.push({ number, title, url, state, author });
  }
  return results;
}

/**
 * List open issues via `gh issue list`. NEVER throws — returns [] on any failure.
 */
export function listIssues(cwd: string): IssueSummary[] {
  const raw = runGh(cwd, [
    'issue',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,url,state,author',
  ]);
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) return [];

  const results: IssueSummary[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;

    const number = typeof obj['number'] === 'number' ? obj['number'] : 0;
    const title = typeof obj['title'] === 'string' ? obj['title'] : '';
    const url = typeof obj['url'] === 'string' ? obj['url'] : '';
    const state = typeof obj['state'] === 'string' ? obj['state'] : '';

    let author = '';
    if (obj['author'] !== null && typeof obj['author'] === 'object') {
      const a = obj['author'] as Record<string, unknown>;
      if (typeof a['login'] === 'string') author = a['login'];
    } else if (typeof obj['author'] === 'string') {
      author = obj['author'];
    }

    results.push({ number, title, url, state, author });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API — EXPLICIT MUTATION (caller must gate behind confirm)
// ---------------------------------------------------------------------------

/**
 * EXPLICIT, MUTATING. Creates a PR via `gh pr create`.
 *
 * The CLI layer (cli/gh.ts) MUST gate this behind an explicit
 * `ashlr gh pr create` command + confirmation prompt — NEVER call this
 * automatically or from any read/status path.
 *
 * May reject on hard failures; ok:false + detail describes the error.
 */
export async function createPr(
  cwd: string,
  opts: CreatePrOpts,
): Promise<CreatePrResult> {
  const args: string[] = ['pr', 'create', '--title', opts.title];

  if (opts.body) {
    args.push('--body', opts.body);
  } else {
    // gh pr create requires --body or --fill; use --fill to generate from commits
    args.push('--fill');
  }
  if (opts.base) args.push('--base', opts.base);
  if (opts.head) args.push('--head', opts.head);
  if (opts.draft) args.push('--draft');

  // NOTE: `gh pr create` does NOT support `--json` (only `gh pr list/view` do).
  // On success it prints the created PR URL as plain text on stdout, which we
  // parse below. Passing `--json` here would make gh exit non-zero on every run.

  try {
    const res = spawnSync(GH_BIN, args, {
      cwd,
      timeout: 30_000, // network operation — allow more time
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
      },
    });

    if (res.error) {
      return { ok: false, url: null, detail: res.error.message };
    }
    if (res.status !== 0) {
      const stderr = typeof res.stderr === 'string' ? res.stderr.trim() : '';
      return { ok: false, url: null, detail: stderr || `gh pr create exited ${res.status}` };
    }

    const trimmed = typeof res.stdout === 'string' ? res.stdout.trim() : '';
    let url: string | null = null;

    // `gh pr create` prints the created PR URL as plain text on stdout. Scan
    // the output for the first https:// line (gh may emit other lines first).
    for (const line of trimmed.split('\n')) {
      const t = line.trim();
      if (t.startsWith('https://')) {
        url = t;
        break;
      }
    }

    return { ok: true, url, detail: url ? `PR created: ${url}` : 'PR created' };
  } catch (err) {
    const detail =
      err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, url: null, detail };
  }
}
