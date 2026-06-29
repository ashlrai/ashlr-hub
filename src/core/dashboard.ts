/**
 * core/dashboard.ts — M13 DashboardSnapshot aggregator.
 *
 * Builds a single bounded, read-only DashboardSnapshot by calling the
 * existing data-source modules. Called on every TUI refresh tick (~2s) and
 * by Raycast views; must be fast (<1s) and NEVER throw.
 *
 * MCP health strategy: discoverMcpServers() is synchronous and fast (file
 * reads only). probeServer() is async and spawns child processes — far too
 * slow to call on every tick. We use the discovered spec list as a
 * "last-known configured" proxy: each server is reported ok:true, tools:0
 * (configured but tool count unknown without probing). This keeps the
 * snapshot bounded and sub-second while still surfacing which servers are
 * configured.
 *
 * Genome strategy: we call loadGenome() directly (bounded, never-throws, no
 * child process) and derive entry + distinct-project counts from it. We do
 * NOT call genomeHealth() because it invokes probeEmbeddingsSync(), which
 * runs execFileSync('curl', ...) with a ~2.5s timeout — a synchronous child
 * spawn that would block the event loop (and thus keypress handling) on the
 * ~2s refresh tick. loadGenome keeps the snapshot sub-second and non-blocking.
 *
 * All partial failures degrade to zeroed/empty fields — snapshot is always
 * returned, never null.
 */

import { loadIndex } from './index-engine.js';
import { getToolsRegistry } from './tools-registry.js';
import { buildRollup } from './observability/rollup.js';
import { listRuns } from './run/orchestrator.js';
import { listSwarms } from './swarm/store.js';
import { discoverMcpServers } from './mcp-registry.js';
import { loadGenome } from './genome/store.js';
import type {
  AshlrConfig,
  DashboardSnapshot,
  PortfolioSummary,
  PortfolioHealthSummary,
  PortfolioGoalInFlight,
  PortfolioBacklogItem,
  PortfolioEffectiveness,
} from './types.js';
import { pendingCount as inboxPendingCount } from './inbox/store.js';
// M29: portfolio roll-up sources — all READ-ONLY + enrollment/index-scoped.
// quality/store.loadPreviousReport (M27) reads the latest PERSISTED HealthReport
// from ~/.ashlr/quality/ — a bounded file read, NO child process, NO network,
// NO scan; tick-safe (we never run the live scanners here, see buildPortfolio).
// listGoals/progressOf/nextActionableMilestone (M28) read
// ~/.ashlr/goals. loadBacklog (M22) reads ~/.ashlr/backlog.json (no scan; null
// when absent). buildForecast (M19) reads the local observability rollup.
// listReports (M26) reads the latest persisted reflection snapshot.
//
// These are imported LAZILY (dynamic import inside each sub-block below) rather
// than statically, so the portfolio sources never enter dashboard.ts's static
// module graph. This (a) keeps the base buildSnapshot path lean, and (b) avoids
// pulling a source's transitive module-load side effects (e.g. forecast.ts's
// top-level binding off observability/rollup.js) into every existing
// buildSnapshot test — those pre-M29 tests mock only the base sources, so a
// static import here would crash them at module-load before any try/catch runs.
// Each call below is wrapped in its own try/catch and degrades to its empty/
// zeroed default; NO new disk scan is introduced, the M13 index roll-up stands.
// M24: load daemon state for snapshot — bounded, never-throws
// Import is a lazy dynamic require so the module resolves only at runtime;
// if core/daemon/state.ts is absent (e.g. earlier milestone) it degrades to
// undefined via the try/catch below.
import { loadDaemonState } from './daemon/state.js';
import { getFrontierUsageSync } from './usage/frontier-usage.js';
import type { FrontierUsage } from './usage/frontier-usage.js';
import type { ProductionSummary, IntelligenceSummary } from './types.js';

// ---------------------------------------------------------------------------
// Caps — keep snapshot fast and memory-bounded
// ---------------------------------------------------------------------------

/** Max recent runs to include in the snapshot. */
const MAX_RUNS = 8;

/** Max recent swarms to include in the snapshot. */
const MAX_SWARMS = 8;

// ── M29 portfolio caps (keep the org roll-up bounded + sub-second) ──────────

/** Max worst-scoring repos surfaced in the portfolio health summary. */
const MAX_WORST_REPOS = 5;

/** Max in-flight goals surfaced in the portfolio. */
const MAX_GOALS_IN_FLIGHT = 8;

/** Max top backlog items surfaced in the portfolio. */
const MAX_BACKLOG_TOP = 8;

/** Cost/forecast window used for the portfolio cost block (matches the 7d activity window). */
const PORTFOLIO_WINDOW = '7d' as const;

// ---------------------------------------------------------------------------
// M29: empty/zeroed portfolio defaults (never-throws degradation targets)
// ---------------------------------------------------------------------------

/** A zeroed health summary — the default on empty enrollment or M27 failure. */
function emptyPortfolioHealth(): PortfolioHealthSummary {
  return { reposScored: 0, averageScore: 0, averageGrade: 'F', worstRepos: [] };
}

/**
 * A fully zeroed/empty PortfolioSummary. Each sub-source overwrites its own
 * field on success; on failure the field keeps this default. The `today` delta
 * block is left null-filled here — the snapshot has no prior to diff against;
 * buildDigest fills it against loadPreviousDigest().
 */
function emptyPortfolio(): PortfolioSummary {
  return {
    health: emptyPortfolioHealth(),
    goalsInFlight: [],
    backlogTop: [],
    cost: { window: PORTFOLIO_WINDOW, spentUsd: 0, localSavingsUsd: 0, projectedMonthlyUsd: 0 },
    effectiveness: null,
    today: {
      previousAt: null,
      pendingProposalsDelta: null,
      dirtyReposDelta: null,
      spendUsdDelta: null,
      healthScoreDelta: null,
      goalsInFlightDelta: null,
    },
  };
}

// ---------------------------------------------------------------------------
// M29: portfolio aggregation — READ-ONLY org roll-up over already-local state.
//
// SAFETY: each sub-source is wrapped in its own try/catch (the buildSnapshot
// model) and degrades to its empty/zeroed default; the whole block can never
// fail the snapshot. The health source reads the latest PERSISTED snapshot only
// (no live scan); the goals source is ENROLLMENT-SCOPED (empty enrollment =>
// empty sections, NO portfolio disk scan). NOTHING here writes —
// no proposal apply/approve, no config write, no repo mutation, no outward call.
// ---------------------------------------------------------------------------

/**
 * Build the OPTIONAL portfolio section. Async only because each sub-source is
 * imported lazily (dynamic import); all the source reads themselves are
 * synchronous, bounded file reads — NO child process, NO network. NEVER throws.
 */
async function buildPortfolio(cfg: AshlrConfig): Promise<PortfolioSummary> {
  const portfolio = emptyPortfolio();

  // ── Health (M27) — TICK-SAFE: read the LATEST PERSISTED snapshot, never run
  //    the live scanners. computeReport() -> computeHealth() -> runScanners()
  //    spawns ~6 child processes PER ENROLLED REPO (rg/grep, `npm outdated`,
  //    `npm audit` — both NETWORK to the npm registry, `gh run list`, `find`).
  //    buildSnapshot is invoked on EVERY ~2s TUI refresh tick, so recomputing
  //    here would hammer the machine and silently break the "sub-1s / no child
  //    process spawns" snapshot contract AND invariant #4 (zero non-localhost
  //    connections on the default path). Instead we read the persisted
  //    HealthReport (a bounded file read; no child process, no network) —
  //    mirroring how the genome/MCP sections were made tick-safe. Empty / no
  //    prior snapshot => reposScored:0, worstRepos:[], NO scan. The live
  //    computeReport() is reserved for the on-demand `ashlr health` run.
  try {
    const { loadPreviousReport } = await import('./quality/store.js');
    const report = loadPreviousReport();
    const reposScored = report ? report.scores.length : 0;
    if (report && reposScored > 0) {
      // computeReport ranks scores worst-first; take the worst N defensively.
      const worst = [...report.scores].sort((a, b) => a.score - b.score).slice(0, MAX_WORST_REPOS);
      portfolio.health = {
        reposScored,
        averageScore: report.averageScore,
        averageGrade: report.averageGrade,
        worstRepos: worst.map((s) => ({ repo: s.repo, score: s.score, grade: s.grade })),
      };
    } else {
      portfolio.health = emptyPortfolioHealth();
    }
  } catch {
    portfolio.health = emptyPortfolioHealth();
  }

  // ── In-flight goals (M28) — active goals only, bounded; most-progressed first.
  try {
    const { listGoals } = await import('./goals/store.js');
    const { progressOf, nextActionableMilestone } = await import('./goals/advance.js');
    const active = listGoals({ status: 'active' });
    const inFlight: PortfolioGoalInFlight[] = [];
    for (const goal of active) {
      const progress = progressOf(goal);
      const next = nextActionableMilestone(goal);
      inFlight.push({
        goalId: goal.id,
        objective: goal.objective,
        status: goal.status,
        fractionDone: progress.fractionDone,
        proposed: progress.proposed,
        totalMilestones: progress.total,
        nextActionable: next ? next.title : null,
      });
    }
    inFlight.sort((a, b) => b.fractionDone - a.fractionDone);
    portfolio.goalsInFlight = inFlight.slice(0, MAX_GOALS_IN_FLIGHT);
  } catch {
    portfolio.goalsInFlight = [];
  }

  // ── Top backlog items (M22) — highest score first, bounded. null => empty.
  try {
    const { loadBacklog } = await import('./portfolio/backlog.js');
    const backlog = loadBacklog();
    if (backlog) {
      const top = [...backlog.items]
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_BACKLOG_TOP)
        .map<PortfolioBacklogItem>((item) => ({
          title: item.title,
          repo: item.repo ?? null,
          score: item.score,
        }));
      portfolio.backlogTop = top;
    }
  } catch {
    portfolio.backlogTop = [];
  }

  // ── Cost + forecast (M19) — buildForecast is synchronous + never-throws,
  //    but wrap defensively. Reads the local observability rollup only.
  try {
    const { buildForecast } = await import('./observability/forecast.js');
    const forecast = buildForecast(PORTFOLIO_WINDOW, cfg);
    portfolio.cost = {
      window: forecast.window,
      spentUsd: forecast.spentUsd,
      localSavingsUsd: forecast.localSavingsUsd,
      projectedMonthlyUsd: forecast.projectedMonthlyUsd,
    };
  } catch {
    portfolio.cost = { window: PORTFOLIO_WINDOW, spentUsd: 0, localSavingsUsd: 0, projectedMonthlyUsd: 0 };
  }

  // ── Effectiveness headline (M26) — latest reflection report, or null.
  try {
    const { listReports } = await import('./learn/store.js');
    const reports = listReports();
    const latest = reports[0];
    if (latest) {
      const eff: PortfolioEffectiveness = {
        successRate: latest.successRate,
        effectivenessDeltaPct: latest.delta?.effectivenessPct ?? null,
        headline: latest.delta?.headline ?? '',
      };
      portfolio.effectiveness = eff;
    }
  } catch {
    portfolio.effectiveness = null;
  }

  return portfolio;
}

// ---------------------------------------------------------------------------
// M224: buildProduction — READ-ONLY production scorecard
// ---------------------------------------------------------------------------

/** 24-hour window in ms. */
const PRODUCTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Max auto-merge titles to surface (keeps the panel compact). */
const MAX_MERGE_TITLES = 5;

/** Max active goals to surface in the production panel. */
const MAX_ACTIVE_GOALS = 6;

/** Number of days in the ships-per-day trend sparkline. */
const TREND_DAYS = 7;

/**
 * Build the OPTIONAL production scorecard. All sources are READ-ONLY,
 * bounded, and lazily-imported (so pre-M224 tests that mock only the base
 * sources never crash). NEVER throws — any failure degrades to zeros/empty.
 */
async function buildProduction(generatedAt: string): Promise<ProductionSummary> {
  const now = Date.now();
  const since24h = now - PRODUCTION_WINDOW_MS;
  const todayDate = new Date().toISOString().slice(0, 10);

  const summary: ProductionSummary = {
    generatedAt,
    proposals24h: { pending: 0, applied: 0, rejected: 0, total: 0 },
    judgeVerdicts24h: { ship: 0, review: 0, noise: 0, harmful: 0, total: 0 },
    autoMergesToday: { count: 0, titles: [] },
    activeGoals: [],
    shipsPerDayTrend: [],
  };

  // ── Proposal counts over 24h + auto-merges today ─────────────────────────
  try {
    const { listProposals } = await import('./inbox/store.js');
    const all = listProposals();
    const recent = all.filter((p) => Date.parse(p.createdAt) >= since24h);
    for (const p of recent) {
      summary.proposals24h.total++;
      if (p.status === 'pending') summary.proposals24h.pending++;
      else if (p.status === 'applied') summary.proposals24h.applied++;
      else if (p.status === 'rejected') summary.proposals24h.rejected++;
    }
    // Auto-merges today: proposals whose createdAt is today + status 'applied'
    const mergedToday = all.filter(
      (p) => p.status === 'applied' && p.createdAt.slice(0, 10) === todayDate,
    );
    summary.autoMergesToday.count = mergedToday.length;
    summary.autoMergesToday.titles = mergedToday
      .slice(0, MAX_MERGE_TITLES)
      .map((p) => p.title);
  } catch {
    // Degrade to zeros.
  }

  // ── Judge verdict counts over 24h ────────────────────────────────────────
  try {
    const { readJudgeTraces } = await import('./fleet/judge-trace.js');
    const traces = readJudgeTraces({ sinceMs: since24h });
    for (const t of traces) {
      summary.judgeVerdicts24h.total++;
      if (t.verdict === 'ship') summary.judgeVerdicts24h.ship++;
      else if (t.verdict === 'review') summary.judgeVerdicts24h.review++;
      else if (t.verdict === 'noise') summary.judgeVerdicts24h.noise++;
      else if (t.verdict === 'harmful') summary.judgeVerdicts24h.harmful++;
    }
  } catch {
    // Degrade to zeros.
  }

  // ── Active goals + milestone counts ──────────────────────────────────────
  try {
    const { listGoals } = await import('./goals/store.js');
    const { progressOf } = await import('./goals/advance.js');
    const active = listGoals({ status: 'active' });
    const goalRows: ProductionSummary['activeGoals'] = [];
    for (const goal of active.slice(0, MAX_ACTIVE_GOALS)) {
      const prog = progressOf(goal);
      goalRows.push({
        goalId: goal.id,
        objective: goal.objective,
        totalMilestones: prog.total,
        doneMilestones: prog.done,
      });
    }
    summary.activeGoals = goalRows;
  } catch {
    // Degrade to empty.
  }

  // ── Ships-per-day trend (7 days, applied proposals by calendar date) ──────
  try {
    const { listProposals } = await import('./inbox/store.js');
    const allProposals = listProposals();
    const trendMs = TREND_DAYS * 24 * 60 * 60 * 1000;
    const trendSince = now - trendMs;
    const countByDate = new Map<string, number>();
    // Pre-fill all 7 days so missing days render as 0
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      countByDate.set(d, 0);
    }
    for (const p of allProposals) {
      if (p.status !== 'applied') continue;
      const createdMs = Date.parse(p.createdAt);
      if (isNaN(createdMs) || createdMs < trendSince) continue;
      const d = p.createdAt.slice(0, 10);
      if (countByDate.has(d)) countByDate.set(d, (countByDate.get(d) ?? 0) + 1);
    }
    summary.shipsPerDayTrend = Array.from(countByDate.entries()).map(([date, count]) => ({
      date,
      count,
    }));
  } catch {
    // Degrade to empty.
  }

  return summary;
}

// ---------------------------------------------------------------------------
// M242: buildIntelligence — READ-ONLY fleet intelligence aggregation
// ---------------------------------------------------------------------------

/** Max anti-playbook lessons to surface (newest first). */
const MAX_ANTI_PLAYBOOKS = 5;

/** Max routing score rows to surface. */
const MAX_ROUTING_SCORES = 20;

/** Max recent event-bus entries to surface. */
const MAX_RECENT_EVENTS = 20;

/** Task classes to build routing scores for (covers the common cases). */
const SCORE_TASK_CLASSES = ['issue', 'todo', 'lint', 'test', 'ci', 'dep', '*'];

/**
 * Build the OPTIONAL fleet intelligence section.
 * Sources: decisions ledger (M119/M240), genome hub (M235), worked ledger.
 * ALL READ-ONLY. NEVER throws — any failure degrades to empty arrays.
 * Lazily imported so pre-M242 tests that mock only base sources stay valid.
 */
async function buildIntelligence(generatedAt: string): Promise<IntelligenceSummary> {
  const summary: IntelligenceSummary = {
    generatedAt,
    routingScores: [],
    antiPlaybooks: [],
    engineScorecards: [],
    recentEvents: [],
  };

  // ── M240: Learned routing scores ──────────────────────────────────────────
  try {
    const { buildEngineScores } = await import('./run/learned-router.js');
    const seen = new Set<string>();
    const rows: IntelligenceSummary['routingScores'] = [];
    for (const taskClass of SCORE_TASK_CLASSES) {
      const scoreMap = buildEngineScores(taskClass);
      for (const s of scoreMap.values()) {
        const rowKey = `${s.key}::${taskClass}`;
        if (seen.has(rowKey)) continue;
        seen.add(rowKey);
        rows.push({
          key: s.key,
          engine: s.engine,
          model: s.model,
          taskClass,
          score: s.score,
          samples: s.samples,
          trend: s.score > 0.55 ? 'promoted' : s.score < 0.45 ? 'demoted' : 'neutral',
        });
      }
    }
    // Sort: promoted first, then by score desc
    rows.sort((a, b) => b.score - a.score);
    summary.routingScores = rows.slice(0, MAX_ROUTING_SCORES);
  } catch {
    // Degrade to empty.
  }

  // ── M235: Anti-playbook lessons from genome hub ───────────────────────────
  try {
    // loadGenome accepts any AshlrConfig-shaped object; we pass a stub so
    // buildIntelligence has no dependency on the caller's live config.
    const { loadGenome } = await import('./genome/store.js');
    const stubCfg = { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] as string[] }, telemetry: {}, tools: {} } as import('./types.js').AshlrConfig;
    const entries = loadGenome(stubCfg);
    const antiPlaybookEntries = entries
      .filter((e) => Array.isArray(e.tags) && e.tags.includes('m235:anti-playbook'))
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, MAX_ANTI_PLAYBOOKS);
    summary.antiPlaybooks = antiPlaybookEntries.map((e) => ({
      id: e.id,
      title: e.title,
      snippet: (e.text ?? '').slice(0, 200),
      ts: e.ts,
    }));
  } catch {
    // Degrade to empty.
  }

  // ── Per-engine scorecards from decisions ledger (24h) ────────────────────
  try {
    const { readDecisions } = await import('./fleet/decisions-ledger.js');
    const since24h = Date.now() - 24 * 60 * 60 * 1000;
    const decisions = readDecisions({ sinceMs: since24h });
    const acc = new Map<string, { ship: number; review: number; noise: number; harmful: number }>();
    for (const d of decisions) {
      if (d.action !== 'judged') continue;
      const eng = (d.engine as string | undefined) ?? 'unknown';
      if (!acc.has(eng)) acc.set(eng, { ship: 0, review: 0, noise: 0, harmful: 0 });
      const slot = acc.get(eng)!;
      const v = (d.verdict ?? '').toLowerCase();
      if (v === 'ship' || v === 'applied' || v === 'approved') slot.ship++;
      else if (v === 'review') slot.review++;
      else if (v === 'noise' || v === 'trivial') slot.noise++;
      else if (v === 'harmful' || v === 'decline' || v === 'rejected') slot.harmful++;
    }
    summary.engineScorecards = Array.from(acc.entries()).map(([engine, counts]) => {
      const total = counts.ship + counts.review + counts.noise + counts.harmful;
      return { engine, ...counts, total, shipRate: total > 0 ? counts.ship / total : 0 };
    }).sort((a, b) => b.shipRate - a.shipRate);
  } catch {
    // Degrade to empty.
  }

  // ── M241: Recent fleet events inferred from decisions ledger ─────────────
  // The event-bus (M241) fires in-memory handlers; lifecycle milestones are
  // captured as merged/rejected/escalated decisions. We surface those as
  // glanceable events: 'merge:shipped', 'regression:detected', 'goal:done'.
  try {
    const { readDecisions } = await import('./fleet/decisions-ledger.js');
    const since72h = Date.now() - 72 * 60 * 60 * 1000;
    const decisions = readDecisions({ sinceMs: since72h, limit: 200 });
    // Map lifecycle actions to event-bus kind labels.
    const EVENT_ACTIONS = new Set(['merged', 'rejected', 'escalated']);
    const actionToKind: Record<string, string> = {
      merged:    'merge:shipped',
      rejected:  'judge:rejected',
      escalated: 'regression:detected',
    };
    const eventEntries = decisions
      .filter((d) => EVENT_ACTIONS.has(d.action))
      .slice(0, MAX_RECENT_EVENTS);
    summary.recentEvents = eventEntries.map((d) => ({
      kind: actionToKind[d.action] ?? d.action,
      detail: d.reason ?? d.detail ?? '',
      ts: d.ts,
    }));
  } catch {
    // Degrade to empty.
  }

  return summary;
}

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

/**
 * Aggregate a DashboardSnapshot from all hub data sources.
 *
 * Calls: loadIndex, getToolsRegistry, buildRollup('7d'), listRuns,
 * listSwarms, discoverMcpServers, loadGenome.
 *
 * Contract:
 *  - Async (callers can await without blocking the event loop for I/O).
 *  - NEVER throws — any failure degrades its field to zero/empty.
 *  - Fast: all underlying calls are synchronous file reads + no child
 *    process spawns (MCP probing is skipped; genome embedding probe is
 *    skipped). Sub-1s on typical machines.
 */
export async function buildSnapshot(cfg: AshlrConfig): Promise<DashboardSnapshot> {
  const generatedAt = new Date().toISOString();

  // ── Repos roll-up (from index) ──────────────────────────────────────────
  let reposTotal = 0;
  let reposDirty = 0;
  let reposStale = 0;

  try {
    const index = loadIndex();
    if (index) {
      for (const item of index.items) {
        if (item.kind !== 'repo') continue;
        reposTotal++;
        if ((item.git?.dirty ?? 0) > 0) reposDirty++;
        if (!item.active) reposStale++;
      }
    }
  } catch {
    // Degrade to zeros.
  }

  // ── Tools roll-up ────────────────────────────────────────────────────────
  let toolsInstalled = 0;
  let toolsTotal = 0;

  try {
    const registry = getToolsRegistry();
    toolsInstalled = registry.installedCount;
    toolsTotal = registry.tools.length;
  } catch {
    // Degrade to zeros.
  }

  // ── Activity roll-up (7d observability) ─────────────────────────────────
  let activitySessions = 0;
  let activityTokens = 0;
  let activityCostUsd = 0;
  let activityCommits = 0;

  try {
    const rollup = buildRollup('7d', cfg);
    activitySessions = rollup.totals.sessions;
    activityTokens = rollup.totals.tokensIn + rollup.totals.tokensOut;
    activityCostUsd = rollup.totals.estCostUsd;
    activityCommits = rollup.totals.commits;
  } catch {
    // Degrade to zeros.
  }

  // ── Recent runs ─────────────────────────────────────────────────────────
  const runs: DashboardSnapshot['runs'] = [];

  try {
    const allRuns = listRuns();
    for (const run of allRuns.slice(0, MAX_RUNS)) {
      runs.push({
        id: run.id,
        goal: run.goal,
        status: run.status,
        tokens: (run.usage?.tokensIn ?? 0) + (run.usage?.tokensOut ?? 0),
      });
    }
  } catch {
    // Degrade to empty array.
  }

  // ── Recent swarms ────────────────────────────────────────────────────────
  const swarms: DashboardSnapshot['swarms'] = [];

  try {
    const allSwarms = listSwarms();
    for (const swarm of allSwarms.slice(0, MAX_SWARMS)) {
      // Compute burndown from per-task execution state.
      const tasksDone = swarm.tasks.filter(
        (t) => t.status === 'done' || t.status === 'skipped',
      ).length;
      const tasksTotal = swarm.tasks.length;

      // Current phase: the phase of the first running task, or the last
      // non-pending phase seen (i.e. the most advanced phase in progress).
      let currentPhase: string | undefined;
      const runningTask = swarm.tasks.find((t) => t.status === 'running');
      if (runningTask) {
        currentPhase = runningTask.phase;
      } else {
        // Pick the phase of the most recently completed/failed task.
        for (let i = swarm.tasks.length - 1; i >= 0; i--) {
          const t = swarm.tasks[i]!;
          if (t.status === 'done' || t.status === 'failed') {
            currentPhase = t.phase;
            break;
          }
        }
      }

      swarms.push({
        id: swarm.id,
        goal: swarm.goal,
        status: swarm.status,
        tasksDone,
        tasksTotal,
        ...(currentPhase !== undefined ? { phase: currentPhase } : {}),
      });
    }
  } catch {
    // Degrade to empty array.
  }

  // ── MCP servers (discovered, not probed) ─────────────────────────────────
  // We use the fast synchronous discovery path only. Each configured server
  // is reported ok:true (configured = likely functional), tools:0 (unknown
  // without spawning). This keeps the snapshot sub-second.
  const mcp: DashboardSnapshot['mcp'] = [];

  try {
    const registry = discoverMcpServers();
    for (const server of registry.servers) {
      mcp.push({
        name: server.name,
        ok: true,
        tools: 0,
      });
    }
  } catch {
    // Degrade to empty array.
  }

  // ── Genome roll-up ───────────────────────────────────────────────────────
  // Use the probe-free loadGenome() (bounded, never-throws, no child
  // process) rather than genomeHealth(), which would synchronously spawn
  // curl to probe Ollama embeddings and block the refresh/keypress loop.
  let genomeEntries = 0;
  let genomeProjects = 0;

  try {
    const entries = loadGenome(cfg);
    genomeEntries = entries.length;
    const projectSet = new Set<string>();
    for (const e of entries) {
      if (e.project) projectSet.add(e.project);
    }
    genomeProjects = projectSet.size;
  } catch {
    // Degrade to zeros.
  }

  // ── Inbox roll-up (M23) ──────────────────────────────────────────────────
  // pendingCount() is bounded, synchronous, never-throws — returns 0 on any
  // error. We wrap defensively anyway since snapshot must never throw.
  let inboxPending = 0;

  try {
    inboxPending = inboxPendingCount();
  } catch {
    // Degrade to 0.
  }


  // ── Daemon roll-up (M24) ─────────────────────────────────────────────────
  // loadDaemonState() is bounded, synchronous, never-throws — returns a
  // fresh zeroed state on missing/corrupt file. We wrap defensively anyway.
  // We reuse inboxPendingCount() already computed above for pendingProposals.
  let daemonRunning = false;
  let daemonSpentUsd = 0;

  try {
    const ds = loadDaemonState();
    daemonRunning = ds.running;
    daemonSpentUsd = ds.todaySpentUsd;
  } catch {
    // Degrade to zeroed fields — daemon not yet initialised.
  }

  // ── M194 frontier usage roll-up ──────────────────────────────────────────
  // getFrontierUsageSync reads the quota ledger + codex session files +
  // observability rollup — all bounded, synchronous, never-throws. Wrapped
  // defensively so a broken usage source cannot affect the base snapshot.
  let frontierUsage: FrontierUsage | undefined;
  try {
    frontierUsage = getFrontierUsageSync(cfg);
  } catch {
    // Leave undefined — absent => "not populated".
    frontierUsage = undefined;
  }

  // ── M29 portfolio roll-up (OPTIONAL org view) ────────────────────────────
  // Runs after all base sections. READ-ONLY aggregation, enrollment-scoped,
  // never-throws — buildPortfolio wraps every sub-source and degrades to its
  // empty/zeroed default. We still wrap the whole call defensively so the base
  // snapshot (and all pre-M29 producers/tests) is unaffected on any failure.
  let portfolio: PortfolioSummary | undefined;
  try {
    portfolio = await buildPortfolio(cfg);
  } catch {
    // Leave portfolio undefined — absent => "not populated", base snapshot intact.
    portfolio = undefined;
  }

  // ── M224 production scorecard (OPTIONAL) ─────────────────────────────────
  // READ-ONLY: inbox proposals + judge traces + goals. All sub-sources are
  // lazily imported and individually try/catch'd inside buildProduction.
  // Absent on pre-M224 producers/tests so they stay valid.
  let production: ProductionSummary | undefined;
  try {
    production = await buildProduction(generatedAt);
  } catch {
    production = undefined;
  }

  // ── M242 fleet intelligence (OPTIONAL) ───────────────────────────────────
  // READ-ONLY: decisions ledger (M240 routing scores, M241 events, engine
  // scorecards) + genome hub (M235 anti-playbooks). Lazily imported.
  // Absent on pre-M242 producers/tests so they stay valid.
  let intelligence: IntelligenceSummary | undefined;
  try {
    intelligence = await buildIntelligence(generatedAt);
  } catch {
    intelligence = undefined;
  }

  return {
    generatedAt,
    repos: {
      total: reposTotal,
      dirty: reposDirty,
      stale: reposStale,
    },
    tools: {
      installed: toolsInstalled,
      total: toolsTotal,
    },
    activity: {
      sessions: activitySessions,
      tokens: activityTokens,
      estCostUsd: activityCostUsd,
      commits: activityCommits,
    },
    runs,
    swarms,
    mcp,
    genome: {
      entries: genomeEntries,
      projects: genomeProjects,
    },
    inbox: {
      pending: inboxPending,
    },
    // M24: daemon status — READ-ONLY surface; absent == not running / no spend.
    daemon: {
      running: daemonRunning,
      todaySpentUsd: daemonSpentUsd,
      pendingProposals: inboxPending,
    },
    // M29: OPTIONAL portfolio section — omitted entirely when the roll-up
    // could not be built, so existing producers/tests (which never set it)
    // stay valid and `portfolio === undefined` reads as "not populated".
    ...(portfolio !== undefined ? { portfolio } : {}),
    // M194: OPTIONAL frontier usage section — omitted when not populated so
    // pre-M194 tests (which never set it) stay valid.
    ...(frontierUsage !== undefined ? { frontierUsage } : {}),
    // M224: OPTIONAL production scorecard — omitted when not populated so
    // pre-M224 tests (which never set it) stay valid.
    ...(production !== undefined ? { production } : {}),
    // M242: OPTIONAL fleet intelligence — omitted when not populated so
    // pre-M242 tests (which never set it) stay valid.
    ...(intelligence !== undefined ? { intelligence } : {}),
  };
}
