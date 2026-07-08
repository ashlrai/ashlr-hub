/**
 * M49: fleet control plane + observability — read-only aggregation.
 *
 * `buildFleetStatus(cfg)` is a single READ-ONLY snapshot of the whole fleet:
 * the daemon's liveness + today's spend, per-backend recent dispatch counts and
 * quota status, the backlog queue size, the inbox proposal counts (pending /
 * frontier-pending / applied), recent auto-merges, and whether the global kill
 * switch is engaged.
 *
 * SAFETY: this NEVER mutates anything and NEVER throws. Every underlying source
 * is wrapped in its own try/catch with a sane fallback, so a single broken
 * source (corrupt daemon state, absent backlog, etc.) degrades only its own
 * slice — the rest of the snapshot still resolves. It adds NO capability: it
 * only reads what the daemon/quota/inbox/backlog modules already persist.
 */

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type {
  AshlrConfig,
  AutoMergeTrustBasis,
  DaemonDispatchTrace,
  DaemonTick,
  EngineId,
  Proposal,
  WorkItem,
} from '../types.js';
import type { SharedQueueHealth } from './shared-store.js';
import type { AutonomyEvidencePack } from '../autonomy/evidence-pack.js';
import type { ResourceStrategyReport } from '../autonomy/resource-strategy.js';
import type { GuardHealthDiagnosis } from '../daemon/guard-health.js';
import type { EcosystemDoctorReport } from '../ecosystem/doctor.js';
import type { BackendAvailability, BackendResourceState } from '../fabric/resource-monitor.js';
import { strategicTierOfRepo, type StrategicTier } from '../ecosystem/focus.js';
import { listEnrolled } from '../sandbox/policy.js';
import { loadQueuedAutonomyItems } from '../portfolio/queued-autonomy.js';
import { detectRepoExecutionProfile, type RepoPackageManager } from '../run/repo-profile.js';
import {
  readDispatchProductionYield,
  type DispatchProductionYieldSummary,
} from './dispatch-production-ledger.js';

export interface FleetBackendResourceStatus {
  availability: BackendAvailability | 'not-sensed';
  usedPct: number | null;
  cap: number | null;
  capUnit: BackendResourceState['capUnit'];
  capWindow: string | null;
  resetsAt: number | null;
  reason: string;
  snapshotAt: string | null;
}

/** A single backend's recent activity + quota standing. */
export interface FleetBackendStatus {
  /** The backend id (e.g. 'builtin', 'claude', 'codex'). */
  backend: EngineId;
  /** Dispatches recorded for this backend in the recent window (last 24h). */
  dispatchesRecent: number;
  /** Quota standing: 'unlimited' when no rate limit is configured. */
  quota: 'ok' | 'warn' | 'over' | 'unlimited';
  /** Resource availability for the allowed backend, when sensed or explicitly unsensed. */
  resource?: FleetBackendResourceStatus;
}

/** Shared filesystem queue health, when multi-machine queueing is enabled. */
export interface FleetSharedQueueStatus extends SharedQueueHealth {
  enabled: boolean;
  mode: 'filesystem';
  machineId: string;
}

export interface FleetAutonomyEvidenceSummary {
  proposalId: string;
  generatedAt: string;
  title: string;
  tier: string | null;
  action: string | null;
  allowed: boolean | null;
  target: AutonomyEvidencePack['target'];
  riskClass: AutonomyEvidencePack['riskClass'];
  verificationPassed: boolean;
  changedFiles: number;
  changedLines: number;
  reason: string | null;
}

export interface FleetAutonomyStatus {
  evidencePacks: number;
  latestAt: string | null;
  allowed: number;
  denied: number;
  byTier: Record<string, number>;
  recent: FleetAutonomyEvidenceSummary[];
}

export interface FleetAutonomyDirectionSummary {
  generatedAt: string;
  mode: ResourceStrategyReport['mode'];
  confidence: ResourceStrategyReport['confidence'];
  reasons: string[];
  recommendedActions: string[];
  resources: Pick<ResourceStrategyReport['resources'], 'posture' | 'constrained' | 'depleted'>;
  guardHealth: {
    blocked: boolean;
    blocks: number;
  };
  budgets: Pick<ResourceStrategyReport['budgets'], 'daemonBudgetLevel' | 'daemonSpentTodayUsd'>;
}

export type FleetAutonomyControlMode = 'disabled' | 'advisory' | 'executable';

export interface FleetAutoMergeBlockerSummary {
  proposalId: string;
  title: string;
  tier: string | null;
  reason: string;
  riskClass: string | null;
}

export interface FleetAutoMergeReadinessStatus {
  enabled: boolean;
  trustBasis: AutoMergeTrustBasis;
  pending: number;
  preflightReady: number;
  needsVerification: number;
  knownVerificationFailed: number;
  blocked: number;
  byReason: Record<string, number>;
  recentBlockers: FleetAutoMergeBlockerSummary[];
}

export interface FleetNextAction {
  id: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  label: string;
  detail: string;
  target?: string;
}

export type FleetAutonomyEffectivenessPhase =
  | 'control-blocked'
  | 'host-handoff'
  | 'merge-ready'
  | 'verification-needed'
  | 'merge-blocked'
  | 'proposal-starved'
  | 'idle';

export interface FleetAutonomyEffectivenessStatus {
  phase: FleetAutonomyEffectivenessPhase;
  canAutoMergeNow: boolean;
  bottleneck:
    | 'control'
    | 'host-handoff'
    | 'merge-drain'
    | 'verification'
    | 'merge-gate'
    | 'proposal-production'
    | 'none';
  summary: string;
  counts: {
    backlogItems: number;
    pendingProposals: number;
    frontierPending: number;
    awaitingHostMerge: number;
    preflightReady: number;
    needsVerification: number;
    blocked: number;
    knownVerificationFailed: number;
    recentMerges: number;
  };
}

export interface FleetProposalProductionReasonSummary {
  reason: string;
  count: number;
}

export interface FleetProposalProductionDispatchSummary {
  ts: string;
  itemId: string;
  title: string;
  repo: string;
  source: WorkItem['source'];
  backend: EngineId | null;
  productionOutcome?: string;
  reason: string;
}

export interface FleetProposalProductionStatus {
  windowHours: number;
  selected: number;
  claimed: number;
  dispatched: number;
  skipped: number;
  errors: number;
  proposalsCreated: number;
  noProposalDispatches: number;
  topReasons: FleetProposalProductionReasonSummary[];
  recentNoProposalDispatches: FleetProposalProductionDispatchSummary[];
}

export interface FleetQueueNextItem {
  id: string;
  title: string;
  repo: string;
  source: WorkItem['source'];
  score: number;
}

export interface FleetQueueRepoCoverage {
  enrolled: number;
  existing: number;
  withBacklog: number;
  silent: number;
  executionProfiles?: {
    reposWithProjects: number;
    reposWithVerifyCommands: number;
    reposMissingVerifyCommands: number;
    packageManagers: Array<{ manager: RepoPackageManager; repos: number }>;
  };
  top: Array<{ repo: string; items: number }>;
  byTier: Array<{ tier: StrategicTier; repos: number; items: number }>;
}

/** One whole-fleet read-only snapshot. */
export interface FleetStatus {
  /** ISO timestamp this snapshot was generated. */
  generatedAt: string;
  daemon: {
    running: boolean;
    lastTickAt: string | null;
    todaySpentUsd: number;
  };
  backends: FleetBackendStatus[];
  queue: {
    backlogItems: number;
    repos?: FleetQueueRepoCoverage;
    next?: FleetQueueNextItem[];
    shared?: FleetSharedQueueStatus;
  };
  proposals: {
    pending: number;
    frontierPending: number;
    awaitingHostMerge?: number;
    applied: number;
  };
  merges: {
    recent: number;
  };
  autonomy?: FleetAutonomyStatus;
  /** Effective autonomy control authority for daemon dispatch decisions. */
  autonomyControlMode: FleetAutonomyControlMode;
  /** Read-only static readiness summary for pending auto-merge candidates. */
  autoMergeReadiness?: FleetAutoMergeReadinessStatus;
  /** Read-only resource-aware autonomous operating recommendation. */
  autonomyDirection?: FleetAutonomyDirectionSummary;
  /** Read-only diagnosis of guard state that can block autonomous work. */
  guardHealth?: GuardHealthDiagnosis;
  /** Ranked read-only operator/agent actions derived from the snapshot. */
  nextActions?: FleetNextAction[];
  /** Read-only explanation of whether the autonomous loop can merge right now. */
  autonomyEffectiveness?: FleetAutonomyEffectivenessStatus;
  /** Read-only diagnosis of recent proposal production from daemon ticks. */
  proposalProduction?: FleetProposalProductionStatus;
  /** Durable 24h dispatch-production yield summary from the append-only ledger. */
  dispatchProduction?: DispatchProductionYieldSummary;
  /** True when the global kill switch is engaged (fleet paused). */
  killed: boolean;
}

/** Recent window for dispatch + merge counting: the last 24 hours. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function isVisibleBacklogItem(item: WorkItem, enrolledRepos: Set<string>): boolean {
  if (enrolledRepos.size === 0) return false;
  return enrolledRepos.has(resolve(item.repo));
}

function mergeVisibleQueueItems(items: WorkItem[], enrolledRepos: Set<string>): WorkItem[] {
  const seen = new Set<string>();
  const merged: WorkItem[] = [];
  for (const item of items) {
    if (!isVisibleBacklogItem(item, enrolledRepos)) continue;
    const key = `${resolve(item.repo)}\0${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function resolveAutonomyControlMode(cfg: AshlrConfig): FleetAutonomyControlMode {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  if (!foundry) return 'disabled';
  return foundry['autonomyControlLoop'] === false ? 'advisory' : 'executable';
}

function backendResourceStatus(
  state: BackendResourceState | undefined,
  fallbackReason = 'no resource sensor reported this allowed backend',
): FleetBackendResourceStatus {
  if (!state) {
    return {
      availability: 'not-sensed',
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: null,
      reason: fallbackReason,
      snapshotAt: null,
    };
  }
  return {
    availability: state.availability,
    usedPct: state.usedPct,
    cap: state.cap,
    capUnit: state.capUnit,
    capWindow: state.capWindow,
    resetsAt: state.resetsAt,
    reason: state.reason,
    snapshotAt: state.snapshotAt,
  };
}

async function attachBackendResources(backends: FleetBackendStatus[], cfg: AshlrConfig): Promise<void> {
  const byBackend = new Map<EngineId, BackendResourceState>();
  let fallbackReason = 'no resource sensor reported this allowed backend';
  try {
    const { getResourceSnapshot } = await import('../fabric/resource-monitor.js');
    const snapshot = await getResourceSnapshot(cfg);
    for (const state of snapshot.backends) byBackend.set(state.backend, state);
  } catch {
    fallbackReason = 'resource snapshot unavailable';
  }
  for (const backend of backends) {
    backend.resource = backendResourceStatus(byBackend.get(backend.backend), fallbackReason);
  }
}

/**
 * Build a read-only snapshot of the fleet. Async because the backlog scan is
 * async. NEVER throws — each source is independently guarded.
 */
export async function buildFleetStatus(cfg: AshlrConfig): Promise<FleetStatus> {
  const generatedAt = new Date().toISOString();

  // ── daemon ────────────────────────────────────────────────────────────────
  let daemon: FleetStatus['daemon'] = {
    running: false,
    lastTickAt: null,
    todaySpentUsd: 0,
  };
  // Recent ticks are reused for merge counting below.
  let recentTicks: DaemonTick[] = [];
  try {
    const { loadDaemonState } = await import('../daemon/state.js');
    const ds = loadDaemonState();
    daemon = {
      running: ds.running === true,
      lastTickAt: ds.lastTickAt ?? null,
      todaySpentUsd: typeof ds.todaySpentUsd === 'number' ? ds.todaySpentUsd : 0,
    };
    recentTicks = Array.isArray(ds.ticks) ? ds.ticks : [];
  } catch {
    // leave fallback
  }

  // ── backends ────────────────────────────────────────────────────────────────
  const allowed: EngineId[] = cfg.foundry?.allowedBackends ?? ['builtin'];
  const backends: FleetBackendStatus[] = [];
  for (const backend of allowed) {
    let dispatchesRecent = 0;
    let quota: FleetBackendStatus['quota'] = 'unlimited';
    try {
      const { usesInWindow, evalQuota } = await import('./quota.js');
      // Prefer the quota ledger (authoritative for rate-limit accounting).
      dispatchesRecent = usesInWindow(backend, RECENT_WINDOW_MS);
      // Quota standing: 'unlimited' when no limit is configured for this backend.
      const limit = cfg.foundry?.limits?.[backend];
      quota = limit ? evalQuota(backend, cfg) : 'unlimited';
    } catch {
      // Ledger unavailable — fall back to summing recent tick.backends counts.
      try {
        dispatchesRecent = sumRecentBackend(recentTicks, backend);
      } catch {
        dispatchesRecent = 0;
      }
      quota = 'unlimited';
    }
    backends.push({ backend, dispatchesRecent, quota });
  }
  try {
    await attachBackendResources(backends, cfg);
  } catch {
    // Optional observability only; backend rows remain useful without resources.
  }

  // ── queue (backlog size) ──────────────────────────────────────────────────
  let backlogItems = 0;
  let nextQueueItems: FleetQueueNextItem[] = [];
  let queueRepos: FleetQueueRepoCoverage | undefined;
  try {
    // Status must be observational. A full buildBacklog() refresh can run
    // scanners, expand planning goals, persist ~/.ashlr/backlog.json, and audit.
    // Read the last persisted snapshot only; the daemon/backlog CLI owns refresh.
    const { loadBacklog } = await import('../portfolio/backlog.js');
    const backlog = loadBacklog();
    const enrolledRaw = (() => {
      try {
        return listEnrolled().map((repo) => resolve(repo));
      } catch {
        return [] as string[];
      }
    })();
    const enrolledRepos = new Set(enrolledRaw.filter((repo) => existsSync(repo)));
    const items = mergeVisibleQueueItems(
      [
        ...(Array.isArray(backlog?.items) ? backlog.items : []),
        ...loadQueuedAutonomyItems(),
      ],
      enrolledRepos,
    );
    backlogItems = items.length;
    const byRepo = new Map<string, number>();
    const byTier = new Map<StrategicTier, { repos: Set<string>; items: number }>();
    for (const item of items) {
      const key = resolve(item.repo);
      byRepo.set(key, (byRepo.get(key) ?? 0) + 1);
      const tier = strategicTierOfRepo(key);
      const tierRow = byTier.get(tier) ?? { repos: new Set<string>(), items: 0 };
      tierRow.repos.add(key);
      tierRow.items++;
      byTier.set(tier, tierRow);
    }
    queueRepos = {
      enrolled: enrolledRaw.length,
      existing: enrolledRepos.size,
      withBacklog: byRepo.size,
      silent: Math.max(0, enrolledRepos.size - byRepo.size),
      executionProfiles: buildRepoExecutionCoverage(enrolledRepos),
      byTier: (['core-fleet', 'force-multiplier', 'inventory', 'supporting'] as StrategicTier[])
        .flatMap((tier) => {
          const row = byTier.get(tier);
          return row ? [{ tier, repos: row.repos.size, items: row.items }] : [];
        }),
      top: [...byRepo.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([repo, itemCount]) => ({ repo, items: itemCount })),
    };
    nextQueueItems = items
      .slice()
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 5)
      .map((item) => ({
        id: item.id,
        title: item.title,
        repo: item.repo,
        source: item.source,
        score: item.score,
      }));
  } catch {
    backlogItems = 0;
    nextQueueItems = [];
  }

  let sharedQueue: FleetSharedQueueStatus | undefined;
  try {
    sharedQueue = await buildSharedQueueStatus(cfg);
  } catch {
    sharedQueue = undefined;
  }

  // ── proposals (pending / frontier-pending / applied) ──────────────────────
  let pending = 0;
  let frontierPending = 0;
  let awaitingHostMerge = 0;
  let applied = 0;
  const pendingProposals: Proposal[] = [];
  try {
    const { listProposals } = await import('../inbox/store.js');
    const all = listProposals();
    for (const p of all) {
      if (p.status === 'pending') {
        pending++;
        pendingProposals.push(p);
        if (p.engineTier === 'frontier') frontierPending++;
      } else if (p.status === 'applied') {
        applied++;
      } else if (p.status === 'awaiting-host-merge') {
        awaitingHostMerge++;
      }
    }
  } catch {
    pending = 0;
    frontierPending = 0;
    awaitingHostMerge = 0;
    applied = 0;
  }

  // ── merges (recent auto-merges across recent ticks) ───────────────────────
  let mergesRecent = 0;
  try {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    for (const t of recentTicks) {
      if (typeof t.merged !== 'number' || t.merged <= 0) continue;
      const ts = t.ts ? Date.parse(t.ts) : NaN;
      // Count when within the recent window, or when the tick has no parseable
      // timestamp (be inclusive rather than silently drop a real merge).
      if (Number.isNaN(ts) || ts >= cutoff) mergesRecent += t.merged;
    }
  } catch {
    mergesRecent = 0;
  }

  // ── kill switch ───────────────────────────────────────────────────────────
  let killed = false;
  try {
    const { killSwitchOn } = await import('../sandbox/policy.js');
    killed = killSwitchOn() === true;
  } catch {
    killed = false;
  }

  // ── guard health / state repair UX ──────────────────────────────────────
  let guardHealth: GuardHealthDiagnosis | undefined;
  try {
    const { diagnoseGuardHealth } = await import('../daemon/guard-health.js');
    guardHealth = diagnoseGuardHealth();
  } catch {
    guardHealth = undefined;
  }

  // ── autonomy evidence packs ──────────────────────────────────────────────
  let autonomy: FleetAutonomyStatus = {
    evidencePacks: 0,
    latestAt: null,
    allowed: 0,
    denied: 0,
    byTier: {},
    recent: [],
  };
  try {
    const { listAutonomyEvidencePacks } = await import('../autonomy/evidence-pack.js');
    autonomy = buildAutonomyStatus(listAutonomyEvidencePacks(200));
  } catch {
    // leave fallback
  }

  let autoMergeReadiness: FleetAutoMergeReadinessStatus | undefined;
  try {
    autoMergeReadiness = await buildAutoMergeReadinessStatus(cfg, pendingProposals);
  } catch {
    autoMergeReadiness = undefined;
  }

  const status: FleetStatus = {
    generatedAt,
    daemon,
    backends,
    queue: {
      backlogItems,
      ...(queueRepos !== undefined ? { repos: queueRepos } : {}),
      ...(nextQueueItems.length > 0 ? { next: nextQueueItems } : {}),
      ...(sharedQueue !== undefined ? { shared: sharedQueue } : {}),
    },
    proposals: { pending, frontierPending, ...(awaitingHostMerge > 0 ? { awaitingHostMerge } : {}), applied },
    merges: { recent: mergesRecent },
    autonomy,
    autonomyControlMode: resolveAutonomyControlMode(cfg),
    ...(autoMergeReadiness !== undefined ? { autoMergeReadiness } : {}),
    ...(guardHealth !== undefined ? { guardHealth } : {}),
    killed,
  };
  const proposalProduction = buildProposalProductionStatus(recentTicks);
  if (proposalProduction) status.proposalProduction = proposalProduction;
  try {
    const dispatchProduction = readDispatchProductionYield({
      windowMs: RECENT_WINDOW_MS,
      limit: 1200,
      limitPerDimension: 8,
    });
    if (dispatchProduction) status.dispatchProduction = dispatchProduction;
  } catch {
    // Optional history/analytics surface only. Fleet status must stay read-only
    // and available even when the append-only ledger is absent or corrupt.
  }

  try {
    const { buildResourceStrategyReport } = await import('../autonomy/resource-strategy.js');
    const report = await buildResourceStrategyReport(cfg, {
      maxOutcomes: 3,
      maxChecks: 3,
      deps: {
        buildFleetStatus: async () => status,
        runEcosystemDoctor: async (opts) => lightweightEcosystemReport(opts?.now, opts?.root),
        ...(guardHealth !== undefined ? { diagnoseGuardHealth: () => guardHealth } : {}),
      },
    });
    status.autonomyDirection = buildAutonomyDirectionSummary(report);
  } catch {
    // Optional advisory surface only. Fleet status remains available if any
    // strategy signal source is unavailable.
  }

  status.autonomyEffectiveness = buildAutonomyEffectiveness(status);
  status.nextActions = buildNextActions(status);

  return status;
}

function buildProposalProductionStatus(ticks: DaemonTick[]): FleetProposalProductionStatus | undefined {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent = ticks.filter((tick) => {
    if (!tick.proposalProduction) return false;
    const ts = Date.parse(tick.ts);
    return Number.isNaN(ts) || ts >= cutoff;
  });
  if (recent.length === 0) return undefined;

  const reasons = new Map<string, number>();
  const recentNoProposalDispatches: FleetProposalProductionDispatchSummary[] = [];
  let selected = 0;
  let claimed = 0;
  let dispatched = 0;
  let skipped = 0;
  let errors = 0;
  let proposalsCreated = 0;
  let noProposalDispatches = 0;

  const addReason = (reason: string, count = 1): void => {
    const key = reason.trim() || 'unknown';
    reasons.set(key, (reasons.get(key) ?? 0) + count);
  };

  for (const tick of recent) {
    const production = tick.proposalProduction;
    if (!production) continue;
    selected += production.selected;
    claimed += production.claimed;
    dispatched += production.dispatched;
    skipped += production.skipped;
    errors += production.errors;
    proposalsCreated += production.proposalsCreated;
    noProposalDispatches += production.noProposalDispatches;
    for (const reason of production.reasons ?? []) {
      addReason(reason.reason, reason.count);
    }
    if (production.noProposalDispatches > 0 && recentNoProposalDispatches.length < 8) {
      const knownNoProposalDispatches = (tick.dispatches ?? []).filter((dispatch) =>
        dispatch.dispatched &&
        dispatch.production !== undefined &&
        dispatch.production.outcome !== 'proposal-created',
      );
      const sample = knownNoProposalDispatches.length > 0
        ? knownNoProposalDispatches
        : (tick.dispatches ?? []).filter((dispatch) => dispatch.dispatched).slice(0, production.noProposalDispatches);
      for (const dispatch of sample) {
        if (recentNoProposalDispatches.length >= 8) break;
        recentNoProposalDispatches.push(proposalProductionDispatchSummary(tick.ts, dispatch));
      }
    }
  }

  return {
    windowHours: RECENT_WINDOW_MS / (60 * 60 * 1000),
    selected,
    claimed,
    dispatched,
    skipped,
    errors,
    proposalsCreated,
    noProposalDispatches,
    topReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    recentNoProposalDispatches,
  };
}

function proposalProductionDispatchSummary(
  ts: string,
  dispatch: DaemonDispatchTrace,
): FleetProposalProductionDispatchSummary {
  return {
    ts,
    itemId: dispatch.itemId,
    title: dispatch.title,
    repo: dispatch.repo,
    source: dispatch.source,
    backend: dispatch.backend,
    ...(dispatch.production?.outcome ? { productionOutcome: dispatch.production.outcome } : {}),
    reason: dispatch.production?.reason ?? dispatch.skipReason ?? dispatch.reason,
  };
}

function proposalProductionDiagnosis(production: FleetProposalProductionStatus): string {
  const topReason = production.topReasons[0];
  if (production.errors > 0) {
    return `recent production saw ${production.errors} error(s)${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (production.noProposalDispatches > 0) {
    return `${production.noProposalDispatches} recent dispatch(es) produced no proposal${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (production.selected > 0 && production.dispatched === 0) {
    return `${production.selected} item(s) were selected but none dispatched${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (production.dispatched > 0 && production.proposalsCreated > 0) {
    return `${production.dispatched} dispatch(es) produced ${production.proposalsCreated} proposal(s)`;
  }
  return topReason ? `recent production top reason: ${topReason.reason}` : 'no recent proposal-production diagnosis is available';
}

function buildAutonomyEffectiveness(status: FleetStatus): FleetAutonomyEffectivenessStatus {
  const readiness = status.autoMergeReadiness;
  const counts: FleetAutonomyEffectivenessStatus['counts'] = {
    backlogItems: status.queue.backlogItems,
    pendingProposals: status.proposals.pending,
    frontierPending: status.proposals.frontierPending,
    awaitingHostMerge: status.proposals.awaitingHostMerge ?? 0,
    preflightReady: readiness?.preflightReady ?? 0,
    needsVerification: readiness?.needsVerification ?? 0,
    blocked: readiness?.blocked ?? 0,
    knownVerificationFailed: readiness?.knownVerificationFailed ?? 0,
    recentMerges: status.merges.recent,
  };
  const firstGuardBlock = status.guardHealth?.blocks?.[0];
  if (status.killed || !status.daemon.running || firstGuardBlock) {
    const reason = status.killed
      ? 'kill switch is engaged'
      : !status.daemon.running
        ? 'daemon is stopped'
        : firstGuardBlock?.detail ?? 'guard is blocking';
    return {
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      summary: `Autonomy is control-blocked: ${reason}.`,
      counts,
    };
  }
  if (counts.awaitingHostMerge > 0) {
    return {
      phase: 'host-handoff',
      canAutoMergeNow: false,
      bottleneck: 'host-handoff',
      summary: `${counts.awaitingHostMerge} proposal(s) are waiting for host PR merge confirmation.`,
      counts,
    };
  }
  if (readiness?.enabled && counts.preflightReady > 0) {
    return {
      phase: 'merge-ready',
      canAutoMergeNow: true,
      bottleneck: 'merge-drain',
      summary: `${counts.preflightReady} proposal(s) are preflight-ready for the auto-merge drain.`,
      counts,
    };
  }
  if (readiness?.enabled && counts.needsVerification > 0) {
    return {
      phase: 'verification-needed',
      canAutoMergeNow: false,
      bottleneck: 'verification',
      summary: `${counts.needsVerification} proposal(s) need verification before judge or merge spend.`,
      counts,
    };
  }
  if (readiness?.enabled && counts.blocked > 0) {
    const topReason = Object.entries(readiness.byReason)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    return {
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      summary: topReason
        ? `${counts.blocked} proposal(s) are blocked at the merge gate; top blocker: ${topReason}.`
        : `${counts.blocked} proposal(s) are blocked at the merge gate.`,
      counts,
    };
  }
  if (counts.pendingProposals === 0 && counts.backlogItems > 0) {
    const production = status.proposalProduction;
    const productionDetail = production ? proposalProductionDiagnosis(production) : null;
    return {
      phase: 'proposal-starved',
      canAutoMergeNow: false,
      bottleneck: 'proposal-production',
      summary: productionDetail
        ? `${counts.backlogItems} backlog item(s) are available, but there are no pending proposals for auto-merge; ${productionDetail}.`
        : `${counts.backlogItems} backlog item(s) are available, but there are no pending proposals for auto-merge.`,
      counts,
    };
  }
  return {
    phase: 'idle',
    canAutoMergeNow: false,
    bottleneck: 'none',
    summary: counts.recentMerges > 0
      ? `No pending merge work is visible; ${counts.recentMerges} auto-merge(s) landed in the last 24h.`
      : 'No pending proposals or backlog work are visible.',
    counts,
  };
}

function buildNextActions(status: FleetStatus): FleetNextAction[] {
  const actions: FleetNextAction[] = [];
  const add = (action: FleetNextAction): void => {
    if (actions.some((existing) => existing.id === action.id)) return;
    actions.push(action);
  };

  if (status.killed) {
    add({
      id: 'resume-fleet',
      priority: 'critical',
      label: 'Resume fleet',
      detail: 'The global kill switch is engaged, so no autonomous dispatch can run.',
    });
  }

  if (!status.daemon.running) {
    add({
      id: 'start-daemon',
      priority: 'critical',
      label: 'Start daemon',
      detail: 'The daemon is stopped; the fleet cannot drain backlog or proposals.',
    });
  }

  const firstGuardBlock = status.guardHealth?.blocks?.[0];
  if (firstGuardBlock) {
    add({
      id: 'repair-guard',
      priority: 'critical',
      label: 'Repair guard block',
      detail: firstGuardBlock.detail,
      target: firstGuardBlock.path,
    });
  }
  const controlBlocked = status.killed || !status.daemon.running || Boolean(firstGuardBlock);

  const awaitingHostMerge = status.proposals.awaitingHostMerge ?? 0;
  if (awaitingHostMerge > 0) {
    add({
      id: 'reconcile-host-prs',
      priority: 'high',
      label: 'Reconcile host PRs',
      detail: `${awaitingHostMerge} proposal(s) are waiting for GitHub/host merge confirmation.`,
    });
  }

  const readiness = status.autoMergeReadiness;
  if (readiness?.enabled && !controlBlocked) {
    if (readiness.preflightReady > 0) {
      add({
        id: 'drain-ready-auto-merges',
        priority: 'high',
        label: 'Drain ready auto-merges',
        detail: `${readiness.preflightReady} pending proposal(s) have cheap preflight-ready evidence.`,
      });
    }
    if (readiness.needsVerification > 0) {
      add({
        id: 'verify-pending-proposals',
        priority: 'high',
        label: 'Verify pending proposals',
        detail: `${readiness.needsVerification} proposal(s) need verification before judge or merge spend.`,
      });
    }
    if (readiness.knownVerificationFailed > 0) {
      add({
        id: 'repair-verification-failures',
        priority: 'medium',
        label: 'Repair failed proposals',
        detail: `${readiness.knownVerificationFailed} proposal(s) have known verification failures.`,
      });
    }
    if (readiness.blocked > 0 && readiness.preflightReady === 0 && readiness.needsVerification === 0) {
      const topReason = Object.entries(readiness.byReason)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      add({
        id: 'inspect-auto-merge-blockers',
        priority: 'medium',
        label: 'Inspect merge blockers',
        detail: topReason ? `${topReason[1]}x ${topReason[0]}` : `${readiness.blocked} proposal(s) are blocked.`,
      });
    }
  }

  const constrained = status.backends.find((backend) => {
    const availability = backend.resource?.availability;
    return availability === 'exhausted' || availability === 'throttled' || availability === 'unreachable';
  });
  if (constrained?.resource) {
    add({
      id: `resource-${constrained.backend}`,
      priority: constrained.resource.availability === 'exhausted' ? 'high' : 'medium',
      label: `Route around ${constrained.backend}`,
      detail: constrained.resource.reason,
      target: constrained.backend,
    });
  }

  if (status.queue.backlogItems > 0 && !controlBlocked) {
    const production = status.proposalProduction;
    if (production && (production.errors > 0 || production.noProposalDispatches > 0 || (production.selected > 0 && production.dispatched === 0))) {
      add({
        id: 'inspect-proposal-production',
        priority: production.errors > 0 ? 'high' : 'medium',
        label: 'Inspect proposal production',
        detail: proposalProductionDiagnosis(production),
      });
    }
    const top = status.queue.next?.[0];
    add({
      id: 'build-backlog',
      priority: 'medium',
      label: 'Build backlog proposals',
      detail: top
        ? `Start with ${top.title}`
        : `${status.queue.backlogItems} backlog item(s) are available.`,
      ...(top?.repo ? { target: top.repo } : {}),
    });
  }

  const missingVerify = status.queue.repos?.executionProfiles?.reposMissingVerifyCommands ?? 0;
  if (missingVerify > 0) {
    add({
      id: 'add-repo-verify-contracts',
      priority: 'low',
      label: 'Add repo verify contracts',
      detail: `${missingVerify} enrolled repo(s) have no detected verify commands.`,
    });
  }

  if (actions.length === 0) {
    add({
      id: 'refresh-backlog',
      priority: 'low',
      label: 'Refresh backlog',
      detail: 'No immediate blockers or ready work are visible in the current snapshot.',
    });
  }

  const priorityRank: Record<FleetNextAction['priority'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  return actions
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.id.localeCompare(b.id))
    .slice(0, 6);
}

async function buildAutoMergeReadinessStatus(
  cfg: AshlrConfig,
  pendingProposals: Proposal[],
): Promise<FleetAutoMergeReadinessStatus> {
  const autoMerge = cfg.foundry?.autoMerge;
  const enabled = autoMerge?.enabled === true;
  const trustBasis: AutoMergeTrustBasis =
    autoMerge?.trustBasis === 'verification' || autoMerge?.trustBasis === 'evidence'
      ? autoMerge.trustBasis
      : 'tier';
  const maxRisk = autoMerge?.maxRisk ?? 'low';

  const byReason: Record<string, number> = {};
  const recentBlockers: FleetAutoMergeBlockerSummary[] = [];
  let preflightReady = 0;
  let needsVerification = 0;
  let knownVerificationFailed = 0;
  let blocked = 0;

  const {
    classifyRisk,
    evaluateBranchAuthority,
    evaluateAutoMergeReadinessPreflight,
    evaluateMergeAuthority,
    mergeTargetForTier,
  } = await import('../inbox/merge.js');
  const { hashDiff } = await import('../foundry/provenance.js');
  const riskOrder: Record<string, number> = { low: 0, medium: 1, high: 2 };

  const noteBlocker = (proposal: Proposal, reason: string, riskClass: string | null): void => {
    blocked++;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (recentBlockers.length < 8) {
      recentBlockers.push({
        proposalId: proposal.id,
        title: proposal.title,
        tier: proposal.engineTier ?? null,
        reason,
        riskClass,
      });
    }
  };

  for (const proposal of pendingProposals) {
    let riskClass: string | null = null;

    if (!enabled) {
      noteBlocker(proposal, 'auto-merge disabled', riskClass);
      continue;
    }
    if (proposal.kind !== 'patch' && proposal.kind !== 'pr') {
      noteBlocker(proposal, `proposal kind '${proposal.kind}' is not mergeable`, riskClass);
      continue;
    }
    if (!proposal.diff?.trim()) {
      noteBlocker(proposal, 'proposal has no diff', riskClass);
      continue;
    }
    if (!proposal.repo) {
      noteBlocker(proposal, 'proposal has no repo', riskClass);
      continue;
    }
    if (proposal.verifyResult?.passed === false) {
      knownVerificationFailed++;
      const failed = proposal.verifyResult.failed?.filter(Boolean).join('; ');
      noteBlocker(
        proposal,
        failed ? `known verification failure: ${failed}` : 'known verification failure',
        riskClass,
      );
      continue;
    }

    const readiness = evaluateAutoMergeReadinessPreflight(proposal, cfg);
    if (!readiness.ready) {
      noteBlocker(proposal, readiness.reason ?? 'not ready for auto-merge', riskClass);
      continue;
    }

    if (trustBasis === 'tier') {
      const target = mergeTargetForTier(proposal.engineTier);
      const authority =
        target === 'main'
          ? evaluateMergeAuthority(proposal, cfg)
          : target === 'branch'
            ? evaluateBranchAuthority(proposal, cfg)
            : { authorized: false, reason: `engineTier '${proposal.engineTier ?? 'unset'}' is proposal-only` };
      if (!authority.authorized) {
        noteBlocker(proposal, `merge authority denied: ${authority.reason}`, riskClass);
        continue;
      }
    }

    if (!proposal.engineModel) {
      noteBlocker(proposal, 'provenance check failed: missing engineModel', riskClass);
      continue;
    }
    if (!proposal.engineTier) {
      noteBlocker(proposal, 'provenance check failed: missing engineTier', riskClass);
      continue;
    }
    if (!proposal.diffHash) {
      noteBlocker(proposal, 'provenance check failed: missing diffHash', riskClass);
      continue;
    }
    if (!proposal.provenanceSig) {
      noteBlocker(proposal, 'provenance check failed: missing provenanceSig', riskClass);
      continue;
    }
    if (hashDiff(proposal.diff) !== proposal.diffHash) {
      noteBlocker(proposal, 'provenance check failed: diff hash mismatch', riskClass);
      continue;
    }

    riskClass = classifyRisk(proposal);
    if ((riskOrder[riskClass] ?? Number.POSITIVE_INFINITY) > (riskOrder[maxRisk] ?? 0)) {
      noteBlocker(proposal, `risk class '${riskClass}' exceeds maxRisk '${maxRisk}'`, riskClass);
      continue;
    }

    if (trustBasis === 'verification' && proposal.verifyResult?.passed !== true) {
      needsVerification++;
      continue;
    }

    if (trustBasis === 'evidence') {
      const verify = proposal.verifyResult;
      const hasBaseBinding =
        verify?.passed === true &&
        typeof verify.baseBranch === 'string' &&
        verify.baseBranch.length > 0 &&
        typeof verify.baseHead === 'string' &&
        verify.baseHead.length > 0;
      const hasCurrentDiffBinding =
        hasBaseBinding &&
        typeof verify.diffHash === 'string' &&
        verify.diffHash === hashDiff(proposal.diff);
      if (!hasCurrentDiffBinding) {
        needsVerification++;
        continue;
      }
    }

    preflightReady++;
  }

  return {
    enabled,
    trustBasis,
    pending: pendingProposals.length,
    preflightReady,
    needsVerification,
    knownVerificationFailed,
    blocked,
    byReason,
    recentBlockers,
  };
}

function lightweightEcosystemReport(now: Date | undefined, root: string | undefined): EcosystemDoctorReport {
  return {
    generatedAt: (now ?? new Date()).toISOString(),
    root: root ?? process.cwd(),
    summary: { pass: 0, warn: 1, fail: 0, total: 1, repos: 0 },
    checks: [{
      id: 'ecosystem-doctor',
      label: 'Ecosystem doctor',
      status: 'warn',
      detail: 'skipped in fleet status summary; run `ashlr fleet direction` for full report',
    }],
    repos: [],
  };
}

function buildAutonomyDirectionSummary(report: ResourceStrategyReport): FleetAutonomyDirectionSummary {
  return {
    generatedAt: report.generatedAt,
    mode: report.mode,
    confidence: report.confidence,
    reasons: report.reasons.slice(0, 3),
    recommendedActions: report.recommendedActions.slice(0, 3),
    resources: {
      posture: report.resources.posture,
      constrained: report.resources.constrained,
      depleted: report.resources.depleted,
    },
    guardHealth: {
      blocked: report.guardHealth.blocked,
      blocks: report.guardHealth.blocks.length,
    },
    budgets: {
      daemonBudgetLevel: report.budgets.daemonBudgetLevel,
      daemonSpentTodayUsd: report.budgets.daemonSpentTodayUsd,
    },
  };
}

function buildAutonomyStatus(packs: AutonomyEvidencePack[]): FleetAutonomyStatus {
  const byTier: Record<string, number> = {};
  let allowed = 0;
  let denied = 0;
  let latestAt: string | null = null;

  for (const pack of packs) {
    if (latestAt === null || Date.parse(pack.generatedAt) > Date.parse(latestAt)) {
      latestAt = pack.generatedAt;
    }
    const tier = pack.policy?.tier ?? 'unknown';
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    if (pack.policy?.allowed === true) allowed++;
    else if (pack.policy?.allowed === false) denied++;
  }

  return {
    evidencePacks: packs.length,
    latestAt,
    allowed,
    denied,
    byTier,
    recent: packs.slice(0, 8).map((pack) => ({
      proposalId: pack.proposal.id,
      generatedAt: pack.generatedAt,
      title: pack.proposal.title,
      tier: pack.policy?.tier ?? null,
      action: pack.policy?.action ?? null,
      allowed: pack.policy?.allowed ?? null,
      target: pack.target,
      riskClass: pack.riskClass,
      verificationPassed: pack.verification.passed,
      changedFiles: pack.diff.files.length,
      changedLines: pack.diff.changedLines,
      reason: pack.policy?.reason ?? null,
    })),
  };
}

async function buildSharedQueueStatus(cfg: AshlrConfig): Promise<FleetSharedQueueStatus | undefined> {
  const sq = cfg.fleet?.sharedQueue;
  if (sq?.mode !== 'filesystem' || !sq.path || sq.path.trim().length === 0) {
    return undefined;
  }

  const path = sq.path;
  const machineId = sq.machineId && sq.machineId.trim().length > 0 ? sq.machineId : hostname();
  const leaseMs =
    typeof sq.leaseMs === 'number' && Number.isFinite(sq.leaseMs) && sq.leaseMs > 0
      ? Math.floor(sq.leaseMs)
      : 5 * 60 * 1000;
  const cooldownMs = configCooldownMs(cfg);

  try {
    const { SharedStore } = await import('./shared-store.js');
    const store = new SharedStore(path, leaseMs);
    const health = store.readHealth({ machineId, ...(cooldownMs !== undefined ? { cooldownMs } : {}) });
    return {
      enabled: true,
      mode: 'filesystem',
      machineId,
      ...health,
    };
  } catch {
    return {
      enabled: true,
      mode: 'filesystem',
      path,
      machineId,
      leaseMs,
      readable: false,
      activeClaims: 0,
      ownedClaims: 0,
      expiredClaims: 0,
      reclaimableClaims: 0,
      claimsByMachine: [],
      nextLeaseExpiryAt: null,
      oldestExpiredMs: null,
      workedEvents: 0,
      cooldownItems: 0,
      usageEntries: 0,
      lock: { present: false, ageMs: null, stale: false },
    };
  }
}

function buildRepoExecutionCoverage(enrolledRepos: ReadonlySet<string>): NonNullable<FleetQueueRepoCoverage['executionProfiles']> {
  let reposWithProjects = 0;
  let reposWithVerifyCommands = 0;
  const packageManagers = new Map<RepoPackageManager, Set<string>>();

  for (const repo of enrolledRepos) {
    try {
      const profile = detectRepoExecutionProfile(repo);
      if (profile.projects.length > 0) reposWithProjects++;
      if (profile.verifyCommands.length > 0) reposWithVerifyCommands++;
      for (const project of profile.projects) {
        const repos = packageManagers.get(project.packageManager) ?? new Set<string>();
        repos.add(repo);
        packageManagers.set(project.packageManager, repos);
      }
    } catch {
      // Read-only observability only; a broken profile scan should not hide queue status.
    }
  }

  return {
    reposWithProjects,
    reposWithVerifyCommands,
    reposMissingVerifyCommands: Math.max(0, enrolledRepos.size - reposWithVerifyCommands),
    packageManagers: [...packageManagers.entries()]
      .map(([manager, repos]) => ({ manager, repos: repos.size }))
      .sort((a, b) => b.repos - a.repos || a.manager.localeCompare(b.manager)),
  };
}

function configCooldownMs(cfg: AshlrConfig): number | undefined {
  const daemon = (cfg as { daemon?: Record<string, unknown> }).daemon;
  const value = daemon?.['cooldownMs'];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Sum `tick.backends[backend]` across recent ticks (within RECENT_WINDOW_MS).
 * Pure fallback for when the quota ledger is unavailable.
 */
function sumRecentBackend(
  ticks: Array<{ ts?: string; backends?: Record<string, number> }>,
  backend: EngineId,
): number {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  let sum = 0;
  for (const t of ticks) {
    const n = t.backends?.[backend];
    if (typeof n !== 'number' || n <= 0) continue;
    const ts = t.ts ? Date.parse(t.ts) : NaN;
    if (Number.isNaN(ts) || ts >= cutoff) sum += n;
  }
  return sum;
}
