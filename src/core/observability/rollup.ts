/**
 * rollup.ts — build ActivityRollup from local usage events + git commit counts.
 *
 * Privacy: delegates to collectUsageEvents which reads METADATA ONLY.
 * Performance: skips files outside the window (mtime filtering in usage-source),
 *   git commit counts are cached per repo behind a stat fingerprint (see
 *   countCommitsSince), and request handlers read through getCachedRollup's
 *   stale-while-revalidate cache instead of recomputing. Never throws globally.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';

import type {
  AshlrConfig,
  ActivityRollup,
  ProjectActivity,
  DailyUsage,
  ModelUsage,
  UsageEvent,
} from '../types.js';
import { collectUsageEvents, dashNormalize } from './usage-source.js';
import { evalBudget } from './budget-alert.js';
import { estCostUsd } from '../run/budget.js';
import { loadIndex } from '../index-engine.js';
import type { AshlrIndex } from '../types.js';

// ---------------------------------------------------------------------------
// windowToMs
// ---------------------------------------------------------------------------

/**
 * Convert a window label to milliseconds.
 * Unknown labels fall back to 7d.
 */
export function windowToMs(window: string): number {
  switch (window) {
    case '1d':  return 86_400_000;
    case '7d':  return 7  * 86_400_000;
    case '30d': return 30 * 86_400_000;
    default:    return 7  * 86_400_000;
  }
}

// ---------------------------------------------------------------------------
// Git commit counting (best-effort, never throws)
// ---------------------------------------------------------------------------
//
// PERF (3.10): the rollup used to spawn one `git log --oneline --after=…` per
// indexed repo on EVERY call — 239 synchronous spawns (~2.5 s of frozen event
// loop) to produce counts that change only when someone commits. Each repo's
// committer timestamps for the widest window are now fetched once and kept,
// keyed on a cheap stat signature of the files a commit must touch (HEAD, the
// checked-out ref, packed-refs, logs/HEAD). A warm rollup costs ~5 stat calls
// per repo and zero spawns; counts for 1d/7d/30d are derived by filtering the
// cached timestamps, so they age correctly without a refetch.

const GIT_TIMEOUT = 5_000;
/** Widest window any caller asks for (windowToMs('30d')). */
const COMMIT_HISTORY_SPAN_MS = 30 * 86_400_000;
/** A repo whose git dir cannot be fingerprinted is refetched at most this often. */
const UNSIGNED_HISTORY_TTL_MS = 60_000;
/** Committer timestamps are ~11 bytes a line; 8 MiB is ~700k commits in a month. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** Parallel async `git log` spawns when warming many repos at once. */
const ASYNC_GIT_CONCURRENCY = 8;
/** Bound the cache so a pathological index cannot grow it without limit. */
const MAX_COMMIT_HISTORY_ENTRIES = 2_048;

interface CommitHistory {
  /** Stat fingerprint of the repo's git state; null = could not fingerprint. */
  signature: string | null;
  /** Earliest committer time (epoch ms) the fetch covered. */
  coversFromMs: number;
  fetchedAt: number;
  /** Committer times (epoch ms) of commits reachable from HEAD within the span. */
  times: number[];
}

const commitHistory = new Map<string, CommitHistory>();

function statPart(path: string): string {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

/**
 * Resolve the git dir and common dir for a working tree. Handles the `.git`
 * FILE form (worktrees, submodules). Returns null for anything unexpected —
 * the caller then falls back to a short TTL instead of guessing.
 */
function resolveGitDirs(repoPath: string): { gitDir: string; commonDir: string } | null {
  try {
    const dotGit = join(repoPath, '.git');
    const st = lstatSync(dotGit);
    let gitDir: string;
    if (st.isDirectory()) {
      gitDir = dotGit;
    } else if (st.isFile()) {
      const text = readFileSync(dotGit, 'utf8').trim();
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (!m) return null;
      gitDir = isAbsolute(m[1]!) ? m[1]! : resolvePath(repoPath, m[1]!);
    } else {
      return null;
    }
    let commonDir = gitDir;
    try {
      const rel = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
      if (rel) commonDir = isAbsolute(rel) ? rel : resolvePath(gitDir, rel);
    } catch {
      // Not a linked worktree: the git dir is its own common dir.
    }
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

/**
 * Fingerprint every file a new commit, checkout, reset or rebase of HEAD must
 * rewrite. `git log` with no revision walks HEAD only, so these are exactly
 * the inputs its answer depends on (plus the clock, handled by filtering).
 * Exported for tests.
 */
export function gitStateSignature(repoPath: string): string | null {
  const dirs = resolveGitDirs(repoPath);
  if (!dirs) return null;
  let head: string;
  try {
    head = readFileSync(join(dirs.gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  const parts = [head, statPart(join(dirs.gitDir, 'HEAD')), statPart(join(dirs.gitDir, 'logs', 'HEAD'))];
  const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
  if (ref) {
    // A branch ref lives loose in the common dir, or packed; watch both.
    parts.push(statPart(join(dirs.commonDir, ref)));
  }
  parts.push(statPart(join(dirs.commonDir, 'packed-refs')));
  return parts.join('|');
}

function parseCommitTimes(out: string): number[] {
  const times: number[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    times.push(Number(trimmed) * 1000);
  }
  return times;
}

function gitLogArgs(fromMs: number): string[] {
  return ['log', '--format=%ct', `--after=${new Date(fromMs).toISOString()}`];
}

function historyIsFresh(entry: CommitHistory | undefined, signature: string | null, sinceMs: number, now: number): boolean {
  if (!entry) return false;
  if (entry.coversFromMs > sinceMs) return false;
  if (signature === null || entry.signature === null) {
    return now - entry.fetchedAt < UNSIGNED_HISTORY_TTL_MS;
  }
  return entry.signature === signature;
}

function storeHistory(repoPath: string, entry: CommitHistory): void {
  if (!commitHistory.has(repoPath) && commitHistory.size >= MAX_COMMIT_HISTORY_ENTRIES) {
    // Oldest-inserted first: Map iteration order is insertion order.
    const oldest = commitHistory.keys().next().value;
    if (oldest !== undefined) commitHistory.delete(oldest);
  }
  commitHistory.set(repoPath, entry);
}

function countFrom(entry: CommitHistory, sinceMs: number): number {
  let n = 0;
  for (const t of entry.times) if (t > sinceMs) n++;
  return n;
}

/** Earliest instant a fetch should cover so every supported window is answerable. */
function fetchFromMs(sinceMs: number, now: number): number {
  return Math.min(sinceMs, now - COMMIT_HISTORY_SPAN_MS);
}

/**
 * Count commits in `repoPath` with committer date after sinceMs (the same
 * predicate as `git log --after`). Returns 0 on any error (git unavailable,
 * not a repo, timeout, etc.). Served from the fingerprinted cache when the
 * repo has not changed; otherwise ONE synchronous `git log` refills it.
 */
function countCommitsSince(repoPath: string, sinceMs: number): number {
  try {
    if (!existsSync(repoPath)) return 0;
    const now = Date.now();
    const signature = gitStateSignature(repoPath);
    const cached = commitHistory.get(repoPath);
    if (historyIsFresh(cached, signature, sinceMs, now)) return countFrom(cached!, sinceMs);
    const from = fetchFromMs(sinceMs, now);
    let times: number[] = [];
    try {
      const out = execFileSync('git', gitLogArgs(from), {
        cwd: repoPath, timeout: GIT_TIMEOUT, stdio: 'pipe', encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER,
      });
      times = parseCommitTimes(out);
    } catch {
      // Not a repo / no commits / git missing: remember "0" under the same
      // fingerprint so a non-repo in the index is not respawned every call.
      times = [];
    }
    const entry: CommitHistory = { signature, coversFromMs: from, fetchedAt: now, times };
    storeHistory(repoPath, entry);
    return countFrom(entry, sinceMs);
  } catch {
    return 0;
  }
}

function execFileText(file: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolveText) => {
    try {
      execFile(file, args, {
        cwd, timeout: GIT_TIMEOUT, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
      }, (err, stdout) => {
        resolveText(err ? null : String(stdout));
      });
    } catch {
      resolveText(null);
    }
  });
}

/**
 * Refill the commit-history cache for every stale repo with ASYNC spawns
 * (bounded concurrency), so a following synchronous buildRollup() finds a
 * warm cache and spawns nothing. Never throws. Returns how many repos were
 * actually refetched (for tests and the perf benchmark).
 */
export async function warmCommitCounts(repoPaths: readonly string[], sinceMs: number): Promise<number> {
  const now = Date.now();
  const pending: Array<{ repoPath: string; signature: string | null }> = [];
  for (const repoPath of new Set(repoPaths)) {
    try {
      if (!existsSync(repoPath)) continue;
      const signature = gitStateSignature(repoPath);
      if (historyIsFresh(commitHistory.get(repoPath), signature, sinceMs, now)) continue;
      pending.push({ repoPath, signature });
    } catch {
      // A repo that cannot even be stat'ed simply stays cold.
    }
  }
  const from = fetchFromMs(sinceMs, now);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const job = pending[cursor++]!;
      const out = await execFileText('git', gitLogArgs(from), job.repoPath);
      storeHistory(job.repoPath, {
        signature: job.signature,
        coversFromMs: from,
        fetchedAt: now,
        times: out === null ? [] : parseCommitTimes(out),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(ASYNC_GIT_CONCURRENCY, pending.length) }, worker));
  return pending.length;
}

/** Drop every cached commit history (tests; `ashlr index` rebuilds). */
export function invalidateCommitCountCache(): void {
  commitHistory.clear();
}

// ---------------------------------------------------------------------------
// Cost estimation — map model id to a provider key for estCostUsd()
// ---------------------------------------------------------------------------

/**
 * Derive a provider key from a model id so estCostUsd() can match it.
 *
 * Examples:
 *   'claude-3-5-sonnet-20241022' -> 'claude'
 *   'gpt-4o'                     -> 'gpt'
 *   'gemini-1.5-pro'             -> 'gemini'
 *   'ollama/llama3'              -> 'ollama'
 *   unknown                      -> model id as-is (budget fallback applies)
 */
export function modelToProviderKey(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('claude'))  return 'claude';
  if (m.startsWith('gpt'))     return 'gpt';
  if (m.startsWith('gemini'))  return 'gemini';
  if (m.startsWith('mistral')) return 'mistral';
  if (m.startsWith('cohere'))  return 'cohere';
  if (m.includes('ollama'))    return 'ollama';
  if (m.includes('lmstudio'))  return 'lmstudio';
  // Pass through: estCostUsd will fallback to conservative $3/$15
  return model;
}

/**
 * Local (zero-cost) provider keys. A model whose `modelToProviderKey` lands in
 * this set is served by a LOCAL backend and costs $0. Shared with forecast.ts so
 * the local/cloud split stays consistent across rollup and savings computation.
 */
export const LOCAL_PROVIDER_KEYS: ReadonlySet<string> = new Set(['ollama', 'lmstudio']);

/** True when `model` is served by a local provider (cost $0). */
export function isLocalProviderModel(model: string): boolean {
  return LOCAL_PROVIDER_KEYS.has(modelToProviderKey(model));
}

// ---------------------------------------------------------------------------
// buildRollup
// ---------------------------------------------------------------------------

type IndexedRepo = AshlrIndex['items'][number];

/** Indexed repos matching the optional project filter — the commit-count set. */
function indexedRepos(index: AshlrIndex, projectFilter: string | undefined): IndexedRepo[] {
  const repos: IndexedRepo[] = [];
  for (const item of index.items) {
    if (item.kind !== 'repo') continue;
    if (projectFilter) {
      const matches =
        item.path === projectFilter ||
        item.name === projectFilter ||
        item.path.includes(projectFilter);
      if (!matches) continue;
    }
    repos.push(item);
  }
  return repos;
}

export function buildRollup(
  window: '1d' | '7d' | '30d',
  cfg: AshlrConfig,
  opts?: { project?: string },
): ActivityRollup {
  const now = Date.now();
  const sinceMs = now - windowToMs(window);
  const sinceIso = new Date(sinceMs).toISOString();

  // ── Collect usage events ─────────────────────────────────────────────────
  let events: UsageEvent[] = [];
  try {
    events = collectUsageEvents(sinceMs);
  } catch {
    // partial data ok
  }

  // ── Load the index ONCE ───────────────────────────────────────────────────
  // Reused for (a) reconciling mangled transcript paths to real repo paths and
  // (b) git commit counting — avoids the previous double loadIndex().
  let index: AshlrIndex | null = null;
  try {
    index = loadIndex();
  } catch {
    // missing index is fine — degrade to best-effort decode + no commits
  }

  // Build a lookup from the dash-normalized form of each indexed repo path to
  // its REAL path. Transcript events carry a LOSSY decode (every '-' became
  // '/'), but dashNormalize collapses both the real and the lossy form to the
  // same key, so we can recover the correct real path for dashed repo names.
  const realByNorm = new Map<string, string>();
  if (index) {
    for (const item of index.items) {
      if (item.kind !== 'repo') continue;
      realByNorm.set(dashNormalize(item.path), item.path);
    }
  }

  // Reconcile each event's (possibly mangled) project path to the real index
  // path so token activity joins the git-commit activity on the SAME key and
  // by-project labels/--project matching work for dashed repos. Falls back to
  // the original decode when there is no index match.
  if (realByNorm.size > 0) {
    for (const ev of events) {
      if (!ev.project) continue;
      const real = realByNorm.get(dashNormalize(ev.project));
      if (real) ev.project = real;
    }
  }

  // ── Optional project filter ──────────────────────────────────────────────
  const projectFilter = opts?.project?.trim();
  if (projectFilter) {
    events = events.filter((e) => {
      if (!e.project) return false;
      return (
        e.project === projectFilter ||
        basename(e.project) === projectFilter ||
        e.project.includes(projectFilter)
      );
    });
  }

  // ── Aggregation maps ─────────────────────────────────────────────────────

  // project key -> ProjectActivity accumulator
  const projectMap = new Map<string, {
    sessions: Set<string>;  // session file paths (for distinct count)
    tokensIn: number;
    tokensOut: number;
    estCostUsd: number;
    lastActive: string | null;
  }>();

  // YYYY-MM-DD -> DailyUsage accumulator
  const dayMap = new Map<string, {
    tokensIn: number;
    tokensOut: number;
    estCostUsd: number;
    sessions: Set<string>;
    cacheRead: number;
    cacheWrite: number;
  }>();

  // model id -> ModelUsage accumulator
  const modelMap = new Map<string, {
    tokensIn: number;
    tokensOut: number;
    estCostUsd: number;
    calls: number;
    cacheRead: number;
    cacheWrite: number;
  }>();

  // Grand totals
  let totalTokensIn  = 0;
  let totalTokensOut = 0;
  let totalCost      = 0;
  // Track distinct session files globally for totals.sessions
  const allSessions = new Set<string>();

  for (const ev of events) {
    const cost = estCostUsd(modelToProviderKey(ev.model), ev.tokensIn, ev.tokensOut);

    // Grand totals
    totalTokensIn  += ev.tokensIn;
    totalTokensOut += ev.tokensOut;
    totalCost      += cost;

    // Session key: for 'claude' events the session file is implicit per-event
    // grouping; we use (project + day) as a session proxy when we don't have
    // the actual filename, but usage-source may embed it in model/ts combos.
    // For simplicity, use a session key = project + ISO-day to count sessions.
    const day = ev.ts.slice(0, 10); // YYYY-MM-DD
    const sessionKey = `${ev.project ?? '__none__'}::${day}`;
    allSessions.add(sessionKey);

    // ── Per-project ────────────────────────────────────────────────────────
    const proj = ev.project ?? '__unknown__';
    if (!projectMap.has(proj)) {
      projectMap.set(proj, { sessions: new Set(), tokensIn: 0, tokensOut: 0, estCostUsd: 0, lastActive: null });
    }
    const pa = projectMap.get(proj)!;
    pa.sessions.add(sessionKey);
    pa.tokensIn  += ev.tokensIn;
    pa.tokensOut += ev.tokensOut;
    pa.estCostUsd += cost;
    if (pa.lastActive === null || ev.ts > pa.lastActive) {
      pa.lastActive = ev.ts;
    }

    // ── Per-day ────────────────────────────────────────────────────────────
    if (!dayMap.has(day)) {
      dayMap.set(day, { tokensIn: 0, tokensOut: 0, estCostUsd: 0, sessions: new Set(), cacheRead: 0, cacheWrite: 0 });
    }
    const du = dayMap.get(day)!;
    du.tokensIn  += ev.tokensIn;
    du.tokensOut += ev.tokensOut;
    du.estCostUsd += cost;
    du.sessions.add(sessionKey);
    du.cacheRead  += ev.cacheRead;
    du.cacheWrite += ev.cacheWrite;

    // ── Per-model ──────────────────────────────────────────────────────────
    const modelKey = ev.model || 'unknown';
    if (!modelMap.has(modelKey)) {
      modelMap.set(modelKey, { tokensIn: 0, tokensOut: 0, estCostUsd: 0, calls: 0, cacheRead: 0, cacheWrite: 0 });
    }
    const mu = modelMap.get(modelKey)!;
    mu.tokensIn  += ev.tokensIn;
    mu.tokensOut += ev.tokensOut;
    mu.estCostUsd += cost;
    mu.calls++;
    mu.cacheRead  += ev.cacheRead;
    mu.cacheWrite += ev.cacheWrite;
  }

  // ── Git commit counts (single pass) ──────────────────────────────────────
  // For each indexed repo matching the (optional) project filter, count commits
  // within the window EXACTLY ONCE. Derive totalCommits by summing the map, and
  // seed commit-only project buckets in the same pass. Reuses the index loaded
  // above — no second loadIndex(), no second countCommitsSince() per repo.
  const commitsByProject = new Map<string, number>();
  let totalCommits = 0;

  if (index) {
    for (const item of indexedRepos(index, projectFilter)) {
      const repoCommits = countCommitsSince(item.path, sinceMs);
      if (repoCommits <= 0) continue;

      commitsByProject.set(item.path, repoCommits);
      totalCommits += repoCommits;

      // Seed a minimal project entry for commit-only repos (no token events),
      // carrying lastActive from the repo's last commit. Token-active repos
      // already have an entry keyed on the reconciled real path.
      if (!projectMap.has(item.path)) {
        projectMap.set(item.path, {
          sessions: new Set(),
          tokensIn: 0,
          tokensOut: 0,
          estCostUsd: 0,
          lastActive: item.git?.lastCommit ?? null,
        });
      }
    }
  }

  // ── Freeze byProject ─────────────────────────────────────────────────────
  const byProject: ProjectActivity[] = [];
  for (const [proj, pa] of projectMap.entries()) {
    byProject.push({
      project: proj,
      sessions: pa.sessions.size,
      commits: commitsByProject.get(proj) ?? 0,
      tokensIn: pa.tokensIn,
      tokensOut: pa.tokensOut,
      estCostUsd: pa.estCostUsd,
      lastActive: pa.lastActive,
    });
  }
  // Sort by cost desc, then tokens desc
  byProject.sort((a, b) =>
    b.estCostUsd !== a.estCostUsd
      ? b.estCostUsd - a.estCostUsd
      : (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut),
  );

  // ── Freeze byDay (ascending) ──────────────────────────────────────────────
  const byDay: DailyUsage[] = [];
  for (const [day, du] of dayMap.entries()) {
    const dayCacheHitRate = (du.tokensIn + du.cacheRead) > 0
      ? du.cacheRead / (du.tokensIn + du.cacheRead)
      : 0;
    byDay.push({
      day,
      tokensIn: du.tokensIn,
      tokensOut: du.tokensOut,
      estCostUsd: du.estCostUsd,
      sessions: du.sessions.size,
      cacheRead: du.cacheRead,
      cacheWrite: du.cacheWrite,
      cacheHitRate: dayCacheHitRate,
    });
  }
  byDay.sort((a, b) => a.day.localeCompare(b.day));

  // ── Freeze byModel (desc by cost) ────────────────────────────────────────
  const byModel: ModelUsage[] = [];
  for (const [model, mu] of modelMap.entries()) {
    const modelCacheHitRate = (mu.tokensIn + mu.cacheRead) > 0
      ? mu.cacheRead / (mu.tokensIn + mu.cacheRead)
      : 0;
    byModel.push({
      model,
      tokensIn: mu.tokensIn,
      tokensOut: mu.tokensOut,
      estCostUsd: mu.estCostUsd,
      calls: mu.calls,
      cacheRead: mu.cacheRead,
      cacheWrite: mu.cacheWrite,
      cacheHitRate: modelCacheHitRate,
    });
  }
  byModel.sort((a, b) =>
    b.estCostUsd !== a.estCostUsd
      ? b.estCostUsd - a.estCostUsd
      : (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut),
  );

  // ── Budget alert ──────────────────────────────────────────────────────────
  const budget = evalBudget(
    { spentUsd: totalCost, spentTokens: totalTokensIn + totalTokensOut },
    cfg,
    window,
  );

  return {
    window,
    since: sinceIso,
    totals: {
      tokensIn:   totalTokensIn,
      tokensOut:  totalTokensOut,
      estCostUsd: totalCost,
      sessions:   allSessions.size,
      commits:    totalCommits,
    },
    byProject,
    byDay,
    byModel,
    budget,
  };
}

// ---------------------------------------------------------------------------
// Async + cached entry points for request handlers
// ---------------------------------------------------------------------------

/**
 * buildRollup, but the only expensive part it controls — one `git log` per
 * stale repo — runs as async, bounded-concurrency spawns first, so the
 * synchronous pass that follows finds a warm commit cache. Usage-event
 * collection (usage-source.ts) is still synchronous; request paths that must
 * never block go through getCachedRollup, whose refresh can be handed to the
 * read-projection worker. Never throws.
 */
export async function buildRollupAsync(
  window: '1d' | '7d' | '30d',
  cfg: AshlrConfig,
  opts?: { project?: string },
): Promise<ActivityRollup> {
  try {
    const index = loadIndex();
    if (index) {
      const repos = indexedRepos(index, opts?.project?.trim() || undefined).map((item) => item.path);
      await warmCommitCounts(repos, Date.now() - windowToMs(window));
    }
  } catch {
    // A cold cache just means buildRollup pays for the spawns itself.
  }
  return buildRollup(window, cfg, opts);
}

/** Fresh for this long; then served stale while one refresh runs. */
export const ROLLUP_CACHE_TTL_MS = 60_000;
/** Older than this, a caller waits for a recompute instead of reading stale. */
export const ROLLUP_CACHE_MAX_STALE_MS = 10 * 60_000;

export interface CachedRollup {
  rollup: ActivityRollup;
  /** True when older than ROLLUP_CACHE_TTL_MS (a refresh is in flight). */
  stale: boolean;
  /** Milliseconds since the rollup was computed. */
  ageMs: number;
}

interface RollupCacheEntry {
  value: ActivityRollup | null;
  computedAt: number;
  inFlight: Promise<ActivityRollup> | null;
}

const rollupCache = new Map<string, RollupCacheEntry>();

/**
 * Key on everything that relocates the sources collectUsageEvents reads, so
 * a relocated HOME (tests, `ashlr` under another user) never reads another
 * home's cached numbers.
 */
function rollupCacheKey(window: string, project: string | undefined): string {
  return JSON.stringify([
    window,
    project ?? '',
    homedir(),
    process.env['ASHLR_HOME'] ?? '',
    process.env['CLAUDE_PROJECTS_DIR'] ?? '',
    process.env['CODEX_HOME'] ?? '',
  ]);
}

/**
 * Re-evaluate the budget against the CALLER's config: the cached token and
 * cost totals are config-independent, the budget verdict is not, and a cap
 * edited a second ago must show up now rather than after the TTL.
 */
function withCurrentBudget(rollup: ActivityRollup, cfg: AshlrConfig): ActivityRollup {
  try {
    return {
      ...rollup,
      budget: evalBudget(
        { spentUsd: rollup.totals.estCostUsd, spentTokens: rollup.totals.tokensIn + rollup.totals.tokensOut },
        cfg,
        rollup.window,
      ),
    };
  } catch {
    return rollup;
  }
}

/**
 * Stale-while-revalidate rollup for request handlers.
 *   - cold: await one computation (single-flight across concurrent callers);
 *   - fresh (< TTL): return immediately;
 *   - stale (< MAX_STALE): return immediately with `stale: true` and start
 *     one background refresh;
 *   - older: wait for a refresh (serving hour-old numbers as current is a lie).
 * `compute` defaults to buildRollupAsync; the Verse server passes a
 * read-projection-worker reader so the refresh never runs on the request
 * thread at all. A failed refresh keeps the last good value. Throws only when
 * there is no value at all and the computation fails.
 */
export async function getCachedRollup(
  window: '1d' | '7d' | '30d',
  cfg: AshlrConfig,
  opts: { project?: string; compute?: () => Promise<ActivityRollup> } = {},
): Promise<CachedRollup> {
  const project = opts.project?.trim() || undefined;
  const key = rollupCacheKey(window, project);
  let entry = rollupCache.get(key);
  if (!entry) {
    entry = { value: null, computedAt: 0, inFlight: null };
    rollupCache.set(key, entry);
  }
  const compute = opts.compute ?? (() => buildRollupAsync(window, cfg, project ? { project } : undefined));
  const current = entry;
  const refresh = (): Promise<ActivityRollup> => {
    if (current.inFlight) return current.inFlight;
    current.inFlight = compute()
      .then((value) => {
        current.value = value;
        current.computedAt = Date.now();
        return value;
      })
      .finally(() => {
        current.inFlight = null;
      });
    return current.inFlight;
  };

  const now = Date.now();
  if (current.value === null || now - current.computedAt > ROLLUP_CACHE_MAX_STALE_MS) {
    try {
      const value = await refresh();
      return { rollup: withCurrentBudget(value, cfg), stale: false, ageMs: 0 };
    } catch (err) {
      if (current.value === null) throw err;
      return { rollup: withCurrentBudget(current.value, cfg), stale: true, ageMs: Date.now() - current.computedAt };
    }
  }
  const ageMs = now - current.computedAt;
  if (ageMs >= ROLLUP_CACHE_TTL_MS) {
    void refresh().catch(() => { /* keep serving the last good value */ });
    return { rollup: withCurrentBudget(current.value, cfg), stale: true, ageMs };
  }
  return { rollup: withCurrentBudget(current.value, cfg), stale: false, ageMs };
}

/** Drop cached rollups and commit histories (tests; after a reindex). */
export function invalidateRollupCache(): void {
  rollupCache.clear();
  invalidateCommitCountCache();
}
