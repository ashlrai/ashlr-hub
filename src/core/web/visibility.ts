/**
 * core/web/visibility.ts — M262 real-time visibility layer.
 *
 * Aggregates four sections for the elite Fleet Dashboard god-view:
 *
 *   resourceGrid   — per-backend availability/usage/cost/latency/reset
 *   fleetActivity  — dispatches, merges, proposals, queue (24h window)
 *   costSavings    — today's spend by backend, ashlr-plugin lifetime savings,
 *                    $ saved by routing/cache, claude-budget-preserved indicator
 *   director       — latest Director digest, resource posture, escalations,
 *                    goals summary (read-only; sourced from director-context)
 *
 * Contract:
 *  - Never throws — every section degrades gracefully.
 *  - Read-only — no state mutations.
 *  - Lazily imports heavy modules so M210/M224/M242 tests that mock only their
 *    own sources stay valid.
 *  - All clock-sensitive values use the passed `now` param (test override).
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { realizedMergeOf } from '../inbox/realized-merge.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackendAvailability = 'open' | 'near' | 'throttled' | 'exhausted' | 'unknown';

export interface ResourceGridEntry {
  backend: string;
  availability: BackendAvailability;
  /** Used percentage 0–100, null when unknown. */
  usedPct: number | null;
  /** Window label (e.g. '5h', '7d') or null. */
  capWindow: string | null;
  /** Cost per 1M output tokens in USD, 0 for free/local. */
  costPerMTokenOut: number;
  /** p50 latency in ms, null when unknown. */
  p50LatencyMs: number | null;
  /** ISO timestamp when quota resets, null when unknown. */
  resetsAt: string | null;
  /** Human-readable reason/hint string. */
  reason: string;
}

export interface FleetActivity24h {
  /** Total dispatches across all backends in last 24h. */
  totalDispatches: number;
  /** Per-backend dispatch counts last 24h. */
  byBackend: { backend: string; count: number }[];
  /** Auto-merged proposals today. */
  mergedToday: number;
  /** Rejected proposals today. */
  rejectedToday: number;
  /** Pending (un-acted-upon) proposals right now. */
  proposalsPending: number;
  /** Proposals applied (lifetime total in ledger window). */
  proposalsApplied: number;
  /** Queue backlog items. */
  queueBacklog: number;
  /** Most recent merge titles (cap 5). */
  recentMergeTitles: string[];
}

export interface CostSavingsSummary {
  /** Today's USD spend aggregated from the decisions ledger. */
  todaySpendUsd: number;
  /** Per-backend today spend. */
  spendByBackend: { backend: string; costUsd: number }[];
  /** ashlr-plugin token savings lifetime (from ~/.ashlr/stats.json). */
  pluginSavingsLifetimeTokens: number;
  /** Approximate USD saved by plugin compression (at ~$3/M tokens). */
  pluginSavingsLifetimeUsd: number;
  /** USD saved by routing cheaper backends vs. always-frontier estimate. */
  routingSavedUsd: number;
  /** Cache hit rate across today's decisions (0–1). */
  cacheHitRate: number;
  /** True when fleet has headroom on Claude subscription (usedPct < 80). */
  claudeBudgetPreserved: boolean;
}

export interface DirectorState {
  /** Latest Director resource posture recommendation. */
  resourcePosture: string;
  /** Latest Telegram digest text (last 800 chars). */
  latestDigest: string | null;
  /** Top goal objective the Director is focusing on. */
  topGoalObjective: string | null;
  /** Number of active escalations needing Mason's attention. */
  escalationCount: number;
  /** Whether the director cycle is enabled in config. */
  directorEnabled: boolean;
  /** ISO timestamp of last director run (from decisions ledger), null if none. */
  lastRunAt: string | null;
}

export interface VisibilitySnapshot {
  generatedAt: string;
  resourceGrid: ResourceGridEntry[];
  fleetActivity: FleetActivity24h;
  costSavings: CostSavingsSummary;
  director: DirectorState;
}

type VisibilityDecision = {
  ts?: string | number;
  proposalId?: string;
  action?: string;
  labelBasis?: string;
  engine?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheHit?: boolean;
  detail?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs(override?: number): number {
  return override ?? Date.now();
}

function decisionTimestampMs(d: { ts?: string | number }): number | null {
  if (typeof d.ts === 'number') return Number.isFinite(d.ts) ? d.ts : null;
  if (typeof d.ts === 'string') {
    const parsed = Date.parse(d.ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isSince(d: { ts?: string | number }, sinceMs: number): boolean {
  const ts = decisionTimestampMs(d);
  return ts === null ? true : ts >= sinceMs;
}

async function readVisibilityDecisions(
  cfg: unknown,
  opts: { sinceMs?: number; limit?: number },
): Promise<VisibilityDecision[]> {
  const injected = (cfg as { __visibilityDecisions?: VisibilityDecision[] } | undefined)?.__visibilityDecisions;
  if (Array.isArray(injected)) {
    const since = opts.sinceMs ?? 0;
    const limit = opts.limit ?? Infinity;
    return injected.filter((d) => isSince(d, since)).slice(0, limit);
  }

  const { readDecisions } = await import('../fleet/decisions-ledger.js');
  return readDecisions(opts) as VisibilityDecision[];
}

async function readCompleteVisibilityDecisions(cfg: unknown): Promise<VisibilityDecision[] | null> {
  const injected = (cfg as { __visibilityDecisions?: VisibilityDecision[] } | undefined)?.__visibilityDecisions;
  if (Array.isArray(injected)) return [...injected];
  const { readDecisionsDetailed } = await import('../fleet/decisions-ledger.js');
  const result = readDecisionsDetailed({ requireComplete: true });
  return result.complete && result.sourceState !== 'degraded'
    ? result.decisions as VisibilityDecision[]
    : null;
}

/** Read and sum all tokensSaved across sessions in ~/.ashlr/stats.json. */
function readPluginSavings(): { tokens: number; usd: number } {
  try {
    const p = join(homedir(), '.ashlr', 'stats.json');
    if (!existsSync(p)) return { tokens: 0, usd: 0 };
    const raw = readFileSync(p, 'utf8');
    const data = JSON.parse(raw) as {
      sessions?: Record<string, { tokensSaved?: number }>;
    };
    if (!data.sessions || typeof data.sessions !== 'object') return { tokens: 0, usd: 0 };
    let total = 0;
    for (const s of Object.values(data.sessions)) {
      total += s.tokensSaved ?? 0;
    }
    // Approximate USD at Claude input pricing: $3 / 1M tokens
    const usd = (total / 1_000_000) * 3;
    return { tokens: total, usd };
  } catch {
    return { tokens: 0, usd: 0 };
  }
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

async function buildResourceGrid(cfg: unknown): Promise<ResourceGridEntry[]> {
  try {
    const { getResourceSnapshot } = await import('../fabric/resource-monitor.js');
    const snap = await getResourceSnapshot(cfg);
    return snap.backends.map((b) => ({
      backend: b.backend,
      availability: (b.availability as BackendAvailability) ?? 'unknown',
      usedPct: b.usedPct ?? null,
      capWindow: (b as { capWindow?: string | null }).capWindow ?? null,
      costPerMTokenOut: (b as { costPerMTokenOut?: number }).costPerMTokenOut ?? 0,
      p50LatencyMs: (b as { p50LatencyMs?: number | null }).p50LatencyMs ?? null,
      resetsAt: b.resetsAt != null
        ? (typeof b.resetsAt === 'number'
          ? new Date(b.resetsAt * 1000).toISOString()
          : String(b.resetsAt))
        : null,
      reason: b.reason ?? '',
    }));
  } catch {
    return [];
  }
}

async function buildFleetActivity24h(_cfg: unknown, nowOverride?: number): Promise<FleetActivity24h> {
  const blank: FleetActivity24h = {
    totalDispatches: 0,
    byBackend: [],
    mergedToday: 0,
    rejectedToday: 0,
    proposalsPending: 0,
    proposalsApplied: 0,
    queueBacklog: 0,
    recentMergeTitles: [],
  };

  try {
    const since24h = nowMs(nowOverride) - 24 * 60 * 60 * 1000;

    // Decisions ledger: dispatches/merges/rejects per backend
    let mergedToday = 0;
    let rejectedToday = 0;
    const backendCounts: Record<string, number> = {};
    try {
      const decisions = await readCompleteVisibilityDecisions(_cfg);
      const { listProposalsDetailed } = await import('../inbox/store.js');
      const proposalRead = listProposalsDetailed({ requireComplete: true });
      if (!decisions || !proposalRead.complete || proposalRead.sourceState === 'degraded') {
        throw new Error('realized activity sources are incomplete');
      }
      const observedAtByProposal = new Map<string, number>();
      const now = nowMs(nowOverride);
      for (const proposal of proposalRead.proposals) {
        const merge = realizedMergeOf(proposal);
        const observedAt = merge?.source === 'github-host'
          ? merge.reconciliation.observedAt
          : merge?.observedAt;
        const observedMs = Date.parse(observedAt ?? '');
        if (Number.isFinite(observedMs) && observedMs >= since24h && observedMs <= now) {
          observedAtByProposal.set(proposal.id, observedMs);
        }
      }
      const countedMergedProposals = new Set<string>();
      for (const d of decisions) {
        const canonicalMerge = d.action === 'merged' &&
          d.labelBasis === 'realized-merge-v1' &&
          !!d.proposalId &&
          observedAtByProposal.has(d.proposalId) &&
          !countedMergedProposals.has(d.proposalId);
        if (d.action === 'merged') {
          if (!canonicalMerge) continue;
          countedMergedProposals.add(d.proposalId!);
          mergedToday++;
        } else if (!isSince(d, since24h)) {
          continue;
        }
        const eng = (d.engine as string | undefined) ?? 'unknown';
        backendCounts[eng] = (backendCounts[eng] ?? 0) + 1;
        if (d.action === 'rejected') rejectedToday++;
      }
    } catch { /* degrade */ }

    const byBackend = Object.entries(backendCounts)
      .map(([backend, count]) => ({ backend, count }))
      .sort((a, b) => b.count - a.count);

    const totalDispatches = byBackend.reduce((s, e) => s + e.count, 0);

    // Fleet status: proposals pending/applied, queue backlog
    let proposalsPending = 0;
    let proposalsApplied = 0;
    let queueBacklog = 0;
    try {
      const { buildFleetStatus } = await import('../fleet/status.js');
      const fs = await buildFleetStatus(_cfg as import('../types.js').AshlrConfig);
      proposalsPending = (fs as { proposals?: { pending?: number } }).proposals?.pending ?? 0;
      proposalsApplied = (fs as { proposals?: { applied?: number } }).proposals?.applied ?? 0;
      queueBacklog = (fs as { queue?: { backlogItems?: number } }).queue?.backlogItems ?? 0;
    } catch { /* degrade */ }

    // Recent merge titles from inbox store
    let recentMergeTitles: string[] = [];
    try {
      const { listProposalsDetailed } = await import('../inbox/store.js');
      const proposalRead = listProposalsDetailed({ requireComplete: true });
      if (!proposalRead.complete || proposalRead.sourceState === 'degraded') {
        throw new Error('proposal source is incomplete');
      }
      const now = nowMs(nowOverride);
      const merged = proposalRead.proposals
        .filter((proposal) => proposal.status === 'applied')
        .map((proposal) => {
          const merge = realizedMergeOf(proposal);
          const observedAt = merge?.source === 'github-host'
            ? merge.reconciliation.observedAt
            : merge?.observedAt;
          return { proposal, observedMs: Date.parse(observedAt ?? '') };
        })
        .filter((entry) => Number.isFinite(entry.observedMs) && entry.observedMs <= now)
        .sort((a, b) => b.observedMs - a.observedMs);
      recentMergeTitles = merged
        .slice(0, 5)
        .map(({ proposal }) => proposal.title ?? proposal.id);
    } catch { /* degrade */ }

    return {
      totalDispatches,
      byBackend,
      mergedToday,
      rejectedToday,
      proposalsPending,
      proposalsApplied,
      queueBacklog,
      recentMergeTitles,
    };
  } catch {
    return blank;
  }
}

async function buildCostSavings(_cfg: unknown, nowOverride?: number): Promise<CostSavingsSummary> {
  const blank: CostSavingsSummary = {
    todaySpendUsd: 0,
    spendByBackend: [],
    pluginSavingsLifetimeTokens: 0,
    pluginSavingsLifetimeUsd: 0,
    routingSavedUsd: 0,
    cacheHitRate: 0,
    claudeBudgetPreserved: true,
  };

  try {
    const since24h = nowMs(nowOverride) - 24 * 60 * 60 * 1000;
    const pluginSavings = readPluginSavings();

    // Today's spend from decisions ledger
    let todaySpendUsd = 0;
    const spendByBackendMap: Record<string, number> = {};
    let cacheReadTokens = 0;
    let totalTokensIn = 0;
    let frontierHypotheticalSpend = 0;
    let localActualSpend = 0;

    try {
      const decisions = await readVisibilityDecisions(_cfg, { sinceMs: since24h });
      for (const d of decisions) {
        if (!isSince(d, since24h)) continue;
        const cost = (d as { costUsd?: number }).costUsd ?? 0;
        const eng = (d.engine as string | undefined) ?? 'unknown';
        todaySpendUsd += cost;
        spendByBackendMap[eng] = (spendByBackendMap[eng] ?? 0) + cost;
        // Cache hit rate
        if ((d as { cacheHit?: boolean }).cacheHit && (d as { tokensIn?: number }).tokensIn) {
          cacheReadTokens += (d as { tokensIn?: number }).tokensIn!;
        }
        totalTokensIn += (d as { tokensIn?: number }).tokensIn ?? 0;
        // Routing savings: frontier vs local
        const isFrontier = ['claude', 'codex', 'gpt-4', 'gpt-4o'].some((k) =>
          eng.toLowerCase().startsWith(k),
        );
        if (!isFrontier) {
          // Estimate what frontier would have cost (claude rate: $3/M in, $15/M out)
          const hypothetical =
            (((d as { tokensIn?: number }).tokensIn ?? 0) / 1_000_000) * 3 +
            (((d as { tokensOut?: number }).tokensOut ?? 0) / 1_000_000) * 15;
          frontierHypotheticalSpend += hypothetical;
          localActualSpend += cost;
        }
      }
    } catch { /* degrade */ }

    const spendByBackend = Object.entries(spendByBackendMap)
      .map(([backend, costUsd]) => ({ backend, costUsd }))
      .sort((a, b) => b.costUsd - a.costUsd);

    const cacheHitRate =
      totalTokensIn + cacheReadTokens > 0
        ? cacheReadTokens / (totalTokensIn + cacheReadTokens)
        : 0;

    const routingSavedUsd = Math.max(0, frontierHypotheticalSpend - localActualSpend);

    // Claude budget: check resource snapshot
    let claudeBudgetPreserved = true;
    try {
      const { getResourceSnapshot } = await import('../fabric/resource-monitor.js');
      const snap = await getResourceSnapshot(_cfg);
      const claudeBackend = snap.backends.find((b) => b.backend === 'claude');
      if (claudeBackend) {
        claudeBudgetPreserved = (claudeBackend.usedPct ?? 0) < 80;
      }
    } catch { /* degrade */ }

    return {
      todaySpendUsd,
      spendByBackend,
      pluginSavingsLifetimeTokens: pluginSavings.tokens,
      pluginSavingsLifetimeUsd: pluginSavings.usd,
      routingSavedUsd,
      cacheHitRate,
      claudeBudgetPreserved,
    };
  } catch {
    return blank;
  }
}

async function buildDirectorState(cfg: AshlrConfig): Promise<DirectorState> {
  const blank: DirectorState = {
    resourcePosture: 'unknown',
    latestDigest: null,
    topGoalObjective: null,
    escalationCount: 0,
    directorEnabled: false,
    lastRunAt: null,
  };

  try {
    const directorEnabled = !!(
      cfg &&
      typeof cfg === 'object' &&
      'comms' in cfg &&
      (cfg as { comms?: { director?: boolean } }).comms?.director === true
    );

    let resourcePosture = 'unknown';
    let topGoalObjective: string | null = null;
    let lastRunAt: string | null = null;
    let escalationCount = 0;

    // Read latest director context (resource posture, goals) — read-only
    try {
      const { buildDirectorContext } = await import('../comms/director-context.js');
      const ctx = await buildDirectorContext(cfg);
      resourcePosture = (ctx as { resourcePosture?: string }).resourcePosture ?? 'unknown';
      topGoalObjective =
        (ctx as { goals?: { active?: { objective?: string }[] } }).goals?.active?.[0]?.objective ?? null;
    } catch { /* degrade */ }

    // Read latest digest from decisions ledger (director entries)
    let latestDigest: string | null = null;
    try {
      const recent = await readVisibilityDecisions(cfg, { limit: 50 });
      const directorEntry = recent.find(
        (d) => (d.action as string) === 'director-digest' ||
          (typeof d.detail === 'string' && d.detail.startsWith('Fleet brief')),
      );
      if (directorEntry) {
        latestDigest = directorEntry.detail
          ? String(directorEntry.detail).slice(0, 800)
          : null;
        lastRunAt = directorEntry.ts != null ? String(directorEntry.ts) : null;
      }
    } catch { /* degrade */ }

    // Escalations: count requests needing a decision
    try {
      const { listRequests } = await import('../comms/requests.js');
      const reqs = listRequests() as { kind: string }[];
      escalationCount = reqs.filter((r) => r.kind === 'decision-needed').length;
    } catch { /* degrade */ }

    return {
      resourcePosture,
      latestDigest,
      topGoalObjective,
      escalationCount,
      directorEnabled,
      lastRunAt,
    };
  } catch {
    return blank;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the full M262 visibility snapshot.
 *
 * Each section degrades gracefully; never throws.
 */
export async function buildVisibilitySnapshot(
  cfg: AshlrConfig,
  _nowOverride?: number,
): Promise<VisibilitySnapshot> {
  const generatedAt = new Date(nowMs(_nowOverride)).toISOString();

  const [resourceGrid, fleetActivity, costSavings, director] = await Promise.all([
    buildResourceGrid(cfg).catch(() => [] as ResourceGridEntry[]),
    buildFleetActivity24h(cfg, _nowOverride).catch(() => ({
      totalDispatches: 0,
      byBackend: [],
      mergedToday: 0,
      rejectedToday: 0,
      proposalsPending: 0,
      proposalsApplied: 0,
      queueBacklog: 0,
      recentMergeTitles: [],
    } as FleetActivity24h)),
    buildCostSavings(cfg, _nowOverride).catch(() => ({
      todaySpendUsd: 0,
      spendByBackend: [],
      pluginSavingsLifetimeTokens: 0,
      pluginSavingsLifetimeUsd: 0,
      routingSavedUsd: 0,
      cacheHitRate: 0,
      claudeBudgetPreserved: true,
    } as CostSavingsSummary)),
    buildDirectorState(cfg).catch(() => ({
      resourcePosture: 'unknown',
      latestDigest: null,
      topGoalObjective: null,
      escalationCount: 0,
      directorEnabled: false,
      lastRunAt: null,
    } as DirectorState)),
  ]);

  return { generatedAt, resourceGrid, fleetActivity, costSavings, director };
}
