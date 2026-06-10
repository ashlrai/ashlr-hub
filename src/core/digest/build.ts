/**
 * core/digest/build.ts — M29 deterministic daily digest builder.
 *
 * buildDigest(cfg, opts) computes a deterministic DAILY DIGEST from the M13/M24
 * DashboardSnapshot (incl. its M29 `portfolio` section, populated by
 * core/dashboard.ts) plus day-over-day deltas vs the previous persisted digest
 * (loadPreviousDigest). An OPTIONAL LLM narrative is OFF unless opts.narrative
 * is explicitly set; when on it routes through getActiveClient — local-only
 * unless allowCloud + a key.
 *
 * HARD SAFETY INVARIANTS (M29) enforced here:
 *  - READ-ONLY AGGREGATION: reads ONLY buildSnapshot(cfg) (which itself only
 *    reads local state) + loadPreviousDigest() (local disk). Writes NOTHING —
 *    persistence is deliver.ts's job. Never mutates a repo, never writes config.
 *  - NO OUTWARD ACTION BY DEFAULT: building a digest makes ZERO non-localhost
 *    connections on the default path. Narrative is the only egress and only when
 *    opts.allowCloud + a cloud key; local providers are localhost-only.
 *  - ENROLLMENT-SCOPED: the portfolio's health/goals sub-sections are sourced
 *    from buildSnapshot, which is enrollment-scoped (empty enrollment => empty).
 *    buildDigest introduces NO new path scan of its own.
 *  - LOCAL-FIRST: all numeric aggregation + the headline are deterministic with
 *    NO model. Narrative is EXPLICITLY OPT-IN (opts.narrative); the default path
 *    constructs NO model at all (not even a reachable local one). When opted in,
 *    it routes through getActiveClient(cfg, { allowCloud }) — local-only unless
 *    allowCloud + a cloud key (mirror M26 reflect's `narrative` gate).
 *  - BOUNDED + NEVER-THROWS: every step is wrapped; a missing snapshot/portfolio
 *    degrades to a zeroed digest. List sizes are inherited from the snapshot's
 *    already-capped portfolio lists.
 */

import { buildSnapshot } from '../dashboard.js';
import { getActiveClient } from '../run/provider-client.js';
import { loadPreviousDigest } from './store.js';
import type {
  AshlrConfig,
  DigestOptions,
  DigestReport,
  DigestWindow,
  PortfolioSummary,
  PortfolioTodayDelta,
} from '../types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default cost/forecast window when none is supplied. */
const DEFAULT_WINDOW: DigestWindow = '7d';

// ---------------------------------------------------------------------------
// Empty / zeroed defaults (never-throws degradation targets)
// ---------------------------------------------------------------------------

/** A zeroed portfolio section used when the snapshot lacks one. */
function emptyPortfolio(window: DigestWindow): PortfolioSummary {
  // TODO(M29): single source of the empty PortfolioSummary; reused by both
  // buildDigest (degradation) and core/dashboard.ts (initial value).
  return {
    health: { reposScored: 0, averageScore: 0, averageGrade: 'F', worstRepos: [] },
    goalsInFlight: [],
    backlogTop: [],
    cost: { window, spentUsd: 0, localSavingsUsd: 0, projectedMonthlyUsd: 0 },
    effectiveness: null,
    today: emptyTodayDelta(),
  };
}

/** A null-filled "today" delta block (no prior digest to compare against). */
function emptyTodayDelta(): PortfolioTodayDelta {
  return {
    previousAt: null,
    pendingProposalsDelta: null,
    dirtyReposDelta: null,
    spendUsdDelta: null,
    healthScoreDelta: null,
    goalsInFlightDelta: null,
  };
}

// ---------------------------------------------------------------------------
// buildDigest
// ---------------------------------------------------------------------------

/**
 * Build a deterministic DigestReport for "today".
 *
 * Contract:
 *  - Async; NEVER throws — any failed step degrades to its zeroed default.
 *  - Default path (no allowCloud) makes ZERO non-localhost connections.
 *  - Deterministic given the same snapshot + prior digest.
 *
 * Steps (TODO bodies):
 *  1. snapshot = await buildSnapshot(cfg) (read-only; never throws).
 *  2. portfolio = snapshot.portfolio ?? emptyPortfolio(window).
 *  3. previous = loadPreviousDigest(generatedAt) — the prior day's digest.
 *  4. Compute portfolio.today deltas vs `previous` (pending/dirty/spend/health/
 *     goals); leave each null when there is no prior.
 *  5. Compose the deterministic `headline` (templated; no LLM).
 *  6. OPTIONAL narrative — ONLY when opts.narrative === true (else NO model is
 *     constructed). Then getActiveClient(cfg, { allowCloud }) opens a provider
 *     (local-only unless allowCloud + key); set narrative + narrativeLocal.
 *     On any model error keep the deterministic report (no narrative).
 */
export async function buildDigest(
  cfg: AshlrConfig,
  opts?: DigestOptions,
): Promise<DigestReport> {
  const window: DigestWindow = opts?.window ?? DEFAULT_WINDOW;
  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);

  // Step 1 — read-only snapshot (never throws; degrade to a zeroed digest).
  let portfolio: PortfolioSummary = emptyPortfolio(window);
  let repos = { total: 0, dirty: 0, stale: 0 };
  let pendingProposals = 0;
  let daemon: DigestReport['daemon'] = null;
  try {
    const snapshot = await buildSnapshot(cfg);
    portfolio = snapshot.portfolio ?? emptyPortfolio(window);
    repos = snapshot.repos;
    pendingProposals = snapshot.inbox.pending;
    daemon = snapshot.daemon
      ? { running: snapshot.daemon.running, todaySpentUsd: snapshot.daemon.todaySpentUsd }
      : null;
  } catch {
    // Degrade to zeroed digest.
  }

  // Steps 3-4 — day-over-day deltas vs the previous digest. The prior is loaded
  // strictly-before `generatedAt` so a freshly-saved current digest is never
  // compared against itself. Each delta is null when there is no prior to diff.
  try {
    const previous = loadPreviousDigest(generatedAt);
    portfolio.today = computeTodayDelta(
      { portfolio, repos, pendingProposals },
      previous,
    );
  } catch {
    portfolio.today = emptyTodayDelta();
  }

  // Step 5 — deterministic headline (templated; NO LLM).
  const headline = composeHeadline({ portfolio, repos, pendingProposals, window });

  // Step 6 — OPTIONAL narrative. EXPLICITLY OPT-IN (mirrors M26 reflect): no
  // model — local OR cloud — is ever constructed unless opts.narrative === true.
  // The DEFAULT `ashlr digest` path therefore makes ZERO model calls and ZERO
  // non-localhost connections, even when a local provider (Ollama/LM Studio)
  // happens to be running. When narrative IS requested, getActiveClient stays
  // local-first: it returns a localhost provider only, unless opts.allowCloud +
  // a cloud key. Any model error is swallowed (deterministic report preserved).
  let narrative: string | undefined;
  let narrativeLocal: boolean | undefined;
  if (opts?.narrative === true) {
    try {
      const client = await getActiveClient(cfg, { allowCloud: opts?.allowCloud ?? false });
      // ALLOWLIST (not denylist): only the known local providers count as local.
      const isLocal = client.id === 'ollama' || client.id === 'lmstudio';
      const res = await client.chat([
        {
          role: 'system',
          content:
            'You write a brief, factual daily engineering portfolio digest. ' +
            'Summarize the provided metadata in 2-3 sentences. Never invent facts ' +
            'or numbers beyond what is given.',
        },
        { role: 'user', content: buildNarrativePrompt({ portfolio, repos, pendingProposals, headline }) },
      ]);
      const text = (res.content ?? '').trim();
      if (text) {
        narrative = text;
        narrativeLocal = isLocal;
      }
    } catch {
      // No reachable provider / cloud refused without key / model error — keep
      // the deterministic report with no narrative.
    }
  }

  const report: DigestReport = {
    generatedAt,
    date,
    window,
    portfolio,
    repos,
    pendingProposals,
    daemon,
    headline,
  };
  if (narrative !== undefined) {
    report.narrative = narrative;
    report.narrativeLocal = narrativeLocal;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Deterministic helpers (pure — no I/O, no model)
// ---------------------------------------------------------------------------

/** Round to a fixed number of decimals to keep deltas deterministic + tidy. */
function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Compute the day-over-day `today` delta block for the current digest vs the
 * previous persisted digest. Each field is null when there is no prior to diff.
 * Pure function — deterministic given the same inputs.
 */
function computeTodayDelta(
  current: {
    portfolio: PortfolioSummary;
    repos: { total: number; dirty: number; stale: number };
    pendingProposals: number;
  },
  previous: DigestReport | null,
): PortfolioTodayDelta {
  if (previous === null) return emptyTodayDelta();
  return {
    previousAt: previous.generatedAt,
    pendingProposalsDelta: current.pendingProposals - previous.pendingProposals,
    dirtyReposDelta: current.repos.dirty - previous.repos.dirty,
    spendUsdDelta: round(
      current.portfolio.cost.spentUsd - previous.portfolio.cost.spentUsd,
    ),
    healthScoreDelta: round(
      current.portfolio.health.averageScore - previous.portfolio.health.averageScore,
    ),
    goalsInFlightDelta:
      current.portfolio.goalsInFlight.length - previous.portfolio.goalsInFlight.length,
  };
}

/**
 * Compose the deterministic, always-present headline. Templated — NO LLM.
 * Summarizes the org view: repos, health, in-flight goals, pending proposals,
 * and spend over the window.
 */
function composeHeadline(input: {
  portfolio: PortfolioSummary;
  repos: { total: number; dirty: number; stale: number };
  pendingProposals: number;
  window: DigestWindow;
}): string {
  const { portfolio, repos, pendingProposals, window } = input;
  const parts: string[] = [];
  parts.push(`${repos.total} repo${repos.total === 1 ? '' : 's'}`);
  parts.push(`${repos.dirty} dirty`);
  if (portfolio.health.reposScored > 0) {
    parts.push(
      `health ${portfolio.health.averageGrade} (${round(portfolio.health.averageScore, 0)})`,
    );
  }
  parts.push(
    `${portfolio.goalsInFlight.length} goal${portfolio.goalsInFlight.length === 1 ? '' : 's'} in flight`,
  );
  parts.push(`${pendingProposals} pending`);
  parts.push(`$${round(portfolio.cost.spentUsd)} spent (${window})`);
  return parts.join(' · ');
}

/** Build the (bounded, metadata-only) prompt for the optional narrative. */
function buildNarrativePrompt(input: {
  portfolio: PortfolioSummary;
  repos: { total: number; dirty: number; stale: number };
  pendingProposals: number;
  headline: string;
}): string {
  const { portfolio, repos, pendingProposals, headline } = input;
  const goals = portfolio.goalsInFlight
    .slice(0, 5)
    .map((g) => `- ${g.objective} (${Math.round(g.fractionDone * 100)}%)`)
    .join('\n');
  return [
    `Headline: ${headline}`,
    `Repos: ${repos.total} total, ${repos.dirty} dirty, ${repos.stale} stale.`,
    `Health: ${portfolio.health.reposScored} scored, avg ${round(portfolio.health.averageScore, 0)} (${portfolio.health.averageGrade}).`,
    `Pending proposals: ${pendingProposals}.`,
    `Spend (${portfolio.cost.window}): $${round(portfolio.cost.spentUsd)}; projected monthly $${round(portfolio.cost.projectedMonthlyUsd)}.`,
    goals ? `Goals in flight:\n${goals}` : 'No goals in flight.',
  ].join('\n');
}
