/**
 * rollup.ts — build ActivityRollup from local usage events + git commit counts.
 *
 * Privacy: delegates to collectUsageEvents which reads METADATA ONLY.
 * Performance: skips files outside the window (mtime filtering in usage-source),
 *   git log --since is bounded per-repo, never throws globally.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

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

const GIT_TIMEOUT = 5_000;

/**
 * Count commits in `repoPath` with author date >= sinceMs.
 * Returns 0 on any error (git unavailable, not a repo, timeout, etc.).
 */
function countCommitsSince(repoPath: string, sinceMs: number): number {
  try {
    if (!existsSync(repoPath)) return 0;
    const since = new Date(sinceMs).toISOString();
    const out = execFileSync(
      'git',
      ['log', '--oneline', `--after=${since}`],
      { cwd: repoPath, timeout: GIT_TIMEOUT, stdio: 'pipe', encoding: 'utf8' },
    );
    return out.trim() === '' ? 0 : out.trim().split('\n').length;
  } catch {
    return 0;
  }
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
    for (const item of index.items) {
      if (item.kind !== 'repo') continue;

      // Apply project filter to repos
      if (projectFilter) {
        const matches =
          item.path === projectFilter ||
          item.name === projectFilter ||
          item.path.includes(projectFilter);
        if (!matches) continue;
      }

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
