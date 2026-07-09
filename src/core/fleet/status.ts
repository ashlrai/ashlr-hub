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
import { basename, resolve } from 'node:path';
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
import {
  detectRepoExecutionProfile,
  type RepoPackageManager,
  type RepoProjectKind,
} from '../run/repo-profile.js';
import { DEFAULT_COOLDOWN_MS, isSuppressibleWorkedOutcome, loadWorkedLedger } from './worked-ledger.js';
import {
  readDispatchProductionYield,
  type DispatchProductionYieldSummary,
} from './dispatch-production-ledger.js';
import {
  readAgentWorkspace,
  type AgentWorkspaceStatus,
} from './agent-action-ledger.js';
import {
  buildContextEfficiencyStatus,
  type FleetContextEfficiencyStatus,
} from './context-efficiency.js';

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
  productionVelocity: Pick<
    ResourceStrategyReport['productionVelocity'],
    'enabled' | 'profile' | 'fillQueueToSlots' | 'stalePendingTtlHours' | 'maxSlotsPerBackend' | 'caps' | 'flags'
  >;
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
  | 'cooldown-gated'
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
    | 'cooldown'
    | 'none';
  summary: string;
  counts: {
    backlogItems: number;
    eligibleBacklogItems?: number;
    cooldownItems?: number;
    pendingItems?: number;
    nextEligibleAt?: string | null;
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

export type FleetAutonomousShipReadinessVerdict = 'ready' | 'blocked' | 'degraded' | 'idle' | 'unknown';
export type FleetAutonomousShipReadinessConfidence = 'high' | 'medium' | 'low';
export type FleetReadinessSourceStatus = 'healthy' | 'degraded' | 'blocked' | 'unavailable' | 'unknown';
export type FleetReadinessFreshness = 'fresh' | 'stale' | 'unknown' | 'not-applicable';

export interface FleetReadinessSourceHealth {
  id: 'daemon' | 'guard' | 'auto-merge' | 'queue' | 'resources' | 'direction';
  label: string;
  status: FleetReadinessSourceStatus;
  badge: 'healthy' | 'degraded' | 'blocked' | 'unavailable' | 'unknown';
  freshness: FleetReadinessFreshness;
  observedAt: string | null;
  ageMs: number | null;
  detail: string;
}

export interface FleetAutonomousShipReadinessBlocker {
  id: string;
  label: string;
  detail: string;
  severity: FleetNextAction['priority'];
  source: FleetReadinessSourceHealth['id'] | 'fleet';
}

export interface FleetAutonomousShipReadinessStatus {
  verdict: FleetAutonomousShipReadinessVerdict;
  confidence: FleetAutonomousShipReadinessConfidence;
  freshness: {
    generatedAt: string;
    overall: Exclude<FleetReadinessFreshness, 'not-applicable'>;
    freshestAt: string | null;
    stalestAt: string | null;
    maxAgeMs: number | null;
    staleSources: number;
    unknownSources: number;
  };
  topBlocker: FleetAutonomousShipReadinessBlocker | null;
  primaryAction: FleetNextAction | null;
  sources: FleetReadinessSourceHealth[];
  sourceSummary: Record<FleetReadinessSourceStatus, number>;
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
  suppressedDispatches: number;
  diagnosticNoProposalDispatches: number;
  topReasons: FleetProposalProductionReasonSummary[];
  diagnosticTopReasons: FleetProposalProductionReasonSummary[];
  recentNoProposalDispatches: FleetProposalProductionDispatchSummary[];
  recentDiagnosticNoProposalDispatches: FleetProposalProductionDispatchSummary[];
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
    missingVerifyCommands?: Array<{
      repo: string;
      name: string;
      projectKinds: RepoProjectKind[];
      reason: string;
    }>;
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
    eligibleBacklogItems?: number;
    cooldownItems?: number;
    pendingItems?: number;
    nextEligibleAt?: string | null;
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
  /** Read-only Fleet OS verdict for whether autonomous shipping is ready now. */
  autonomousShipReadiness?: FleetAutonomousShipReadinessStatus;
  /** Read-only diagnosis of recent proposal production from daemon ticks. */
  proposalProduction?: FleetProposalProductionStatus;
  /** Durable 24h dispatch-production yield summary from the append-only ledger. */
  dispatchProduction?: DispatchProductionYieldSummary;
  /** Durable 24h agent-action global workspace summary from append-only telemetry. */
  workspace?: AgentWorkspaceStatus;
  /** Read-only context discipline signal for long-running multi-agent work. */
  contextEfficiency?: FleetContextEfficiencyStatus;
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

interface FleetQueueEligibility {
  eligibleItems: WorkItem[];
  cooldownItems: number;
  pendingItems: number;
  nextEligibleAt: string | null;
}

function isoFromMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function pendingItemIdsForQueue(items: WorkItem[], pendingProposals: Proposal[]): Set<string> {
  const pendingItemIds = new Set<string>();
  for (const prop of pendingProposals) {
    const haystack = `${prop.title} ${prop.summary}`;
    for (const item of items) {
      const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
      if (re.test(haystack)) pendingItemIds.add(item.id);
    }
  }
  return pendingItemIds;
}

function buildQueueEligibility(
  items: WorkItem[],
  pendingProposals: Proposal[],
  cfg: AshlrConfig,
): FleetQueueEligibility {
  const cooldownMs = configCooldownMs(cfg) ?? DEFAULT_COOLDOWN_MS;
  const nowMs = Date.now();
  const latestByItem = new Map<string, { tsMs: number; suppressible: boolean }>();
  for (const event of loadWorkedLedger().events) {
    const eventMs = Date.parse(event.ts);
    if (Number.isNaN(eventMs)) continue;
    const prior = latestByItem.get(event.itemId);
    if (prior === undefined || eventMs > prior.tsMs) {
      latestByItem.set(event.itemId, {
        tsMs: eventMs,
        suppressible: isSuppressibleWorkedOutcome(event.outcome),
      });
    }
  }

  const pendingItemIds = pendingItemIdsForQueue(items, pendingProposals);
  const eligibleItems: WorkItem[] = [];
  let cooldownItems = 0;
  let pendingItems = 0;
  let nextEligibleMs: number | null = null;

  for (const item of items) {
    if (pendingItemIds.has(item.id)) {
      pendingItems++;
      continue;
    }
    const last = latestByItem.get(item.id);
    const cooldownUntil = last && last.suppressible ? last.tsMs + cooldownMs : null;
    if (cooldownUntil !== null && cooldownUntil > nowMs) {
      cooldownItems++;
      if (nextEligibleMs === null || cooldownUntil < nextEligibleMs) {
        nextEligibleMs = cooldownUntil;
      }
      continue;
    }
    eligibleItems.push(item);
  }

  return {
    eligibleItems,
    cooldownItems,
    pendingItems,
    nextEligibleAt: isoFromMs(nextEligibleMs),
  };
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
  let queueSnapshotAt: string | null = null;
  let queueSourceStatus: FleetReadinessSourceStatus = 'unknown';
  let queueSourceDetail = 'backlog snapshot has not been read yet';

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
  let visibleQueueItems: WorkItem[] = [];
  let nextQueueItems: FleetQueueNextItem[] = [];
  let eligibleBacklogItems = 0;
  let cooldownItems = 0;
  let pendingItems = 0;
  let nextEligibleAt: string | null = null;
  let queueRepos: FleetQueueRepoCoverage | undefined;
  try {
    // Status must be observational. A full buildBacklog() refresh can run
    // scanners, expand planning goals, persist ~/.ashlr/backlog.json, and audit.
    // Read the last persisted snapshot only; the daemon/backlog CLI owns refresh.
    const { loadBacklog } = await import('../portfolio/backlog.js');
    const backlog = loadBacklog();
    queueSnapshotAt = typeof backlog?.generatedAt === 'string' ? backlog.generatedAt : null;
    const enrolledRaw = (() => {
      try {
        return listEnrolled().map((repo) => resolve(repo));
      } catch {
        return [] as string[];
      }
    })();
    const enrolledRepos = new Set(enrolledRaw.filter((repo) => existsSync(repo)));
    const queuedAutonomyItems = loadQueuedAutonomyItems();
    const items = mergeVisibleQueueItems(
      [
        ...(Array.isArray(backlog?.items) ? backlog.items : []),
        ...queuedAutonomyItems,
      ],
      enrolledRepos,
    );
    if (backlog) {
      queueSourceStatus = 'healthy';
      queueSourceDetail = `${items.length} visible cached queue item(s) from persisted backlog snapshot`;
    } else if (queuedAutonomyItems.length > 0) {
      queueSourceStatus = 'degraded';
      queueSourceDetail = 'persisted backlog snapshot unavailable; using queued self-heal/invent work only';
    } else {
      queueSourceStatus = 'unknown';
      queueSourceDetail = 'no persisted backlog snapshot or queued autonomy work is available';
    }
    visibleQueueItems = items;
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
  } catch {
    backlogItems = 0;
    visibleQueueItems = [];
    nextQueueItems = [];
    queueSnapshotAt = null;
    queueSourceStatus = 'unavailable';
    queueSourceDetail = 'queue source could not be read';
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

  try {
    const eligibility = buildQueueEligibility(visibleQueueItems, pendingProposals, cfg);
    eligibleBacklogItems = eligibility.eligibleItems.length;
    cooldownItems = eligibility.cooldownItems;
    pendingItems = eligibility.pendingItems;
    nextEligibleAt = eligibility.nextEligibleAt;
    nextQueueItems = eligibility.eligibleItems
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
    eligibleBacklogItems = backlogItems;
    cooldownItems = 0;
    pendingItems = 0;
    nextEligibleAt = null;
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
      eligibleBacklogItems,
      cooldownItems,
      pendingItems,
      nextEligibleAt,
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
    status.workspace = readAgentWorkspace({
      windowMs: RECENT_WINDOW_MS,
      limit: 1200,
      limitPerDimension: 8,
      recentLimit: 8,
    });
  } catch {
    // Optional history/analytics surface only.
  }
  try {
    const { genomeHubHealth } = await import('../genome/store.js');
    status.contextEfficiency = buildContextEfficiencyStatus(status, genomeHubHealth(), generatedAt, RECENT_WINDOW_MS);
  } catch {
    status.contextEfficiency = buildContextEfficiencyStatus(status, undefined, generatedAt, RECENT_WINDOW_MS);
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
  status.autonomousShipReadiness = buildAutonomousShipReadiness(status, {
    generatedAt,
    queueSnapshotAt,
    queueSourceStatus,
    queueSourceDetail,
  });

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
  const diagnosticReasons = new Map<string, number>();
  const recentNoProposalDispatches: FleetProposalProductionDispatchSummary[] = [];
  const recentDiagnosticNoProposalDispatches: FleetProposalProductionDispatchSummary[] = [];
  let selected = 0;
  let claimed = 0;
  let dispatched = 0;
  let skipped = 0;
  let errors = 0;
  let proposalsCreated = 0;
  let noProposalDispatches = 0;
  let suppressedDispatches = 0;

  const addReason = (reason: string, count = 1): void => {
    const key = reason.trim() || 'unknown';
    reasons.set(key, (reasons.get(key) ?? 0) + count);
    if (!isSuppressedProposalProductionReason(key)) {
      diagnosticReasons.set(key, (diagnosticReasons.get(key) ?? 0) + count);
    }
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
      let suppressedByReason = 0;
      for (const reason of production.reasons ?? []) {
        if (isSuppressedProposalProductionReason(reason.reason)) {
          suppressedByReason += reason.count;
        }
      }
      const suppressedByDispatch = knownNoProposalDispatches
        .filter(isSuppressedProposalProductionDispatch)
        .length;
      suppressedDispatches += Math.max(suppressedByReason, suppressedByDispatch);
      const sample = knownNoProposalDispatches.length > 0
        ? knownNoProposalDispatches
        : (tick.dispatches ?? []).filter((dispatch) => dispatch.dispatched).slice(0, production.noProposalDispatches);
      for (const dispatch of sample) {
        if (recentNoProposalDispatches.length >= 8) break;
        const summary = proposalProductionDispatchSummary(tick.ts, dispatch);
        recentNoProposalDispatches.push(summary);
        if (isSuppressedProposalProductionDispatch(dispatch)) {
          continue;
        }
        if (recentDiagnosticNoProposalDispatches.length < 8) {
          recentDiagnosticNoProposalDispatches.push(summary);
        }
      }
    } else {
      for (const reason of production.reasons ?? []) {
        if (isSuppressedProposalProductionReason(reason.reason)) {
          suppressedDispatches += reason.count;
        }
      }
    }
  }

  const diagnosticNoProposalDispatches = Math.max(0, noProposalDispatches - suppressedDispatches);
  return {
    windowHours: RECENT_WINDOW_MS / (60 * 60 * 1000),
    selected,
    claimed,
    dispatched,
    skipped,
    errors,
    proposalsCreated,
    noProposalDispatches,
    suppressedDispatches,
    diagnosticNoProposalDispatches,
    topReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    diagnosticTopReasons: [...diagnosticReasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    recentNoProposalDispatches,
    recentDiagnosticNoProposalDispatches,
  };
}

function isSuppressedProposalProductionReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? '').toLowerCase();
  return normalized.startsWith('proposal-disabled') ||
    normalized.includes('proposal filing disabled for this sandboxed attempt');
}

function isSuppressedProposalProductionDispatch(dispatch: DaemonDispatchTrace): boolean {
  return dispatch.production?.outcome === 'proposal-disabled' ||
    isSuppressedProposalProductionReason(dispatch.production?.reason) ||
    isSuppressedProposalProductionReason(dispatch.reason);
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
  const topReasons = production.diagnosticTopReasons.length > 0 ? production.diagnosticTopReasons : production.topReasons;
  const topReason = topReasons[0];
  const diagnosticNoProposalDispatches = production.diagnosticNoProposalDispatches ?? production.noProposalDispatches;
  if (production.errors > 0) {
    return `recent production saw ${production.errors} error(s)${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (diagnosticNoProposalDispatches > 0) {
    return `${diagnosticNoProposalDispatches} recent dispatch(es) produced no proposal${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (production.suppressedDispatches > 0) {
    return `${production.suppressedDispatches} recent dispatch(es) were suppressed by internal proposal filing policy`;
  }
  if (production.selected > 0 && production.dispatched === 0) {
    return `${production.selected} item(s) were selected but none dispatched${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (production.dispatched > 0 && production.proposalsCreated > 0) {
    return `${production.dispatched} dispatch(es) produced ${production.proposalsCreated} proposal(s)`;
  }
  return topReason ? `recent production top reason: ${topReason.reason}` : 'no recent proposal-production diagnosis is available';
}

const MIN_DISPATCH_YIELD_ACTION_ATTEMPTS = 3;
const LOW_DISPATCH_YIELD_ACTION_RATE = 0.2;

function formatActionPercent(rate: number): string {
  if (!Number.isFinite(rate)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`;
}

function dispatchYieldNextActionDetail(dispatchProduction: DispatchProductionYieldSummary): string | null {
  if (
    dispatchProduction.attempts < MIN_DISPATCH_YIELD_ACTION_ATTEMPTS ||
    dispatchProduction.proposalRate >= LOW_DISPATCH_YIELD_ACTION_RATE
  ) {
    return null;
  }
  const weakest = dispatchProduction.byBackend[0];
  const subject = weakest?.backend ?? weakest?.key ?? 'dispatches';
  const attempts = weakest?.attempts ?? dispatchProduction.attempts;
  const proposals = weakest?.proposalsCreated ?? dispatchProduction.proposalsCreated;
  const rate = weakest?.proposalRate ?? dispatchProduction.proposalRate;
  const topReason = weakest?.topReasons[0] ?? dispatchProduction.topReasons[0];
  const reason = topReason ? `; top reason: ${topReason.reason}` : '';
  return `${subject} proposal yield ${proposals}/${attempts} (${formatActionPercent(rate)})${reason}`;
}

function buildAutonomyEffectiveness(status: FleetStatus): FleetAutonomyEffectivenessStatus {
  const readiness = status.autoMergeReadiness;
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  const counts: FleetAutonomyEffectivenessStatus['counts'] = {
    backlogItems: status.queue.backlogItems,
    eligibleBacklogItems,
    cooldownItems: status.queue.cooldownItems ?? 0,
    pendingItems: status.queue.pendingItems ?? 0,
    nextEligibleAt: status.queue.nextEligibleAt ?? null,
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
  if (counts.pendingProposals === 0 && eligibleBacklogItems > 0) {
    const production = status.proposalProduction;
    const productionDetail = production ? proposalProductionDiagnosis(production) : null;
    const backlogDetail = eligibleBacklogItems === counts.backlogItems
      ? `${counts.backlogItems} backlog item(s) are available`
      : `${eligibleBacklogItems}/${counts.backlogItems} backlog item(s) are eligible now`;
    return {
      phase: 'proposal-starved',
      canAutoMergeNow: false,
      bottleneck: 'proposal-production',
      summary: productionDetail
        ? `${backlogDetail}, but there are no pending proposals for auto-merge; ${productionDetail}.`
        : `${backlogDetail}, but there are no pending proposals for auto-merge.`,
      counts,
    };
  }
  if (counts.pendingProposals === 0 && counts.backlogItems > 0 && eligibleBacklogItems === 0) {
    const nextEligible = counts.nextEligibleAt ? ` Next eligible at ${counts.nextEligibleAt}.` : '';
    return {
      phase: 'cooldown-gated',
      canAutoMergeNow: false,
      bottleneck: 'cooldown',
      summary: `No eligible backlog work is visible; ${counts.cooldownItems ?? 0} item(s) are cooling and ${counts.pendingItems ?? 0} already have pending proposals.${nextEligible}`,
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

  const contextEfficiency = status.contextEfficiency;
  const contextRisk = contextEfficiency?.risks.find((risk) => risk.severity === 'high' || risk.severity === 'medium');
  if (contextEfficiency && (contextEfficiency.posture === 'strained' || contextRisk)) {
    add({
      id: 'improve-context-efficiency',
      priority: 'medium',
      label: 'Improve context efficiency',
      detail: contextRisk?.detail ?? contextEfficiency.recommendations[0] ?? 'Context efficiency is degraded; inspect reflection, retrieval, and proposal-yield signals.',
    });
  }

  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  if (eligibleBacklogItems > 0 && !controlBlocked) {
    const dispatchYieldDetail = status.dispatchProduction
      ? dispatchYieldNextActionDetail(status.dispatchProduction)
      : null;
    if (dispatchYieldDetail) {
      const weakest = status.dispatchProduction?.byBackend[0];
      add({
        id: 'inspect-dispatch-yield',
        priority: 'medium',
        label: 'Inspect dispatch yield',
        detail: dispatchYieldDetail,
        ...(weakest?.backend ? { target: weakest.backend } : {}),
      });
    }
    const production = status.proposalProduction;
    const diagnosticNoProposalDispatches = production?.diagnosticNoProposalDispatches ?? production?.noProposalDispatches ?? 0;
    if (production && (production.errors > 0 || diagnosticNoProposalDispatches > 0 || (production.selected > 0 && production.dispatched === 0))) {
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
        : `${eligibleBacklogItems} backlog item(s) are eligible.`,
      ...(top?.repo ? { target: top.repo } : {}),
    });
  } else if (status.queue.backlogItems > 0 && !controlBlocked) {
    const cooling = status.queue.cooldownItems ?? 0;
    const pending = status.queue.pendingItems ?? 0;
    const nextEligible = status.queue.nextEligibleAt;
    if (cooling > 0 && eligibleBacklogItems === 0) {
      add({
        id: 'cooldown-gated-backlog',
        priority: 'medium',
        label: 'Review cooldown gate',
        detail: nextEligible
          ? `${status.queue.backlogItems} backlog item(s) are cooling; next eligible at ${nextEligible}. Decide whether to wait, lower cooldown policy, or dispatch a targeted high-value item.`
          : `${status.queue.backlogItems} backlog item(s) are visible but none are eligible. Decide whether to wait, inspect worked-ledger cooldowns, or dispatch a targeted high-value item.`,
      });
    }
    add({
      id: 'wait-for-backlog-eligibility',
      priority: 'low',
      label: 'Wait for backlog eligibility',
      detail: nextEligible
        ? `${status.queue.backlogItems} backlog item(s) are present, but ${cooling} are cooling and ${pending} already have pending proposals; next eligible at ${nextEligible}.`
        : `${status.queue.backlogItems} backlog item(s) are present, but none are currently eligible (${cooling} cooling, ${pending} pending).`,
    });
  }

  const missingVerify = status.queue.repos?.executionProfiles?.reposMissingVerifyCommands ?? 0;
  if (missingVerify > 0) {
    const missingRepos = status.queue.repos?.executionProfiles?.missingVerifyCommands ?? [];
    const sample = missingRepos.slice(0, 3).map((row) => row.name).join(', ');
    add({
      id: 'add-repo-verify-contracts',
      priority: 'low',
      label: 'Add repo verify contracts',
      detail: `${missingVerify} enrolled repo(s) have no detected verify commands.${sample ? ` First: ${sample}.` : ''}`,
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

interface AutonomousShipReadinessInputs {
  generatedAt: string;
  queueSnapshotAt: string | null;
  queueSourceStatus: FleetReadinessSourceStatus;
  queueSourceDetail: string;
}

const READINESS_DAEMON_STALE_MS = 30 * 60 * 1000;
const READINESS_QUEUE_STALE_MS = 24 * 60 * 60 * 1000;
const READINESS_STATUS_STALE_MS = 30 * 60 * 1000;

function readinessPriorityRank(priority: FleetNextAction['priority']): number {
  switch (priority) {
    case 'critical': return 0;
    case 'high': return 1;
    case 'medium': return 2;
    case 'low': return 3;
  }
}

function readinessFreshness(
  observedAt: string | null,
  staleMs: number,
): { freshness: FleetReadinessFreshness; ageMs: number | null } {
  if (!observedAt) return { freshness: 'unknown', ageMs: null };
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return { freshness: 'unknown', ageMs: null };
  const ageMs = Math.max(0, Date.now() - parsed);
  return { freshness: ageMs > staleMs ? 'stale' : 'fresh', ageMs };
}

function readinessBadge(status: FleetReadinessSourceStatus): FleetReadinessSourceHealth['badge'] {
  return status;
}

function readinessSource(
  id: FleetReadinessSourceHealth['id'],
  label: string,
  status: FleetReadinessSourceStatus,
  observedAt: string | null,
  staleMs: number,
  detail: string,
  opts?: { freshness?: FleetReadinessFreshness },
): FleetReadinessSourceHealth {
  const measured = opts?.freshness
    ? { freshness: opts.freshness, ageMs: null }
    : readinessFreshness(observedAt, staleMs);
  let effectiveStatus = status;
  if (measured.freshness === 'stale' && effectiveStatus === 'healthy') {
    effectiveStatus = 'degraded';
  } else if (measured.freshness === 'unknown' && effectiveStatus === 'healthy') {
    effectiveStatus = 'unknown';
  }
  return {
    id,
    label,
    status: effectiveStatus,
    badge: readinessBadge(effectiveStatus),
    freshness: measured.freshness,
    observedAt,
    ageMs: measured.ageMs,
    detail,
  };
}

function readinessBlocker(
  id: string,
  label: string,
  detail: string,
  severity: FleetNextAction['priority'],
  source: FleetAutonomousShipReadinessBlocker['source'],
): FleetAutonomousShipReadinessBlocker {
  return { id, label, detail, severity, source };
}

function resourceReadinessSource(status: FleetStatus, generatedAt: string): FleetReadinessSourceHealth {
  const backends = Array.isArray(status.backends) ? status.backends : [];
  if (backends.length === 0) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'unavailable',
      null,
      READINESS_STATUS_STALE_MS,
      'no allowed backends are visible in fleet status',
    );
  }

  const unavailable = new Set(['exhausted', 'throttled', 'unreachable']);
  const resources = backends.map((backend) => backend.resource).filter(Boolean);
  const hardBlocked = backends.filter((backend) => unavailable.has(String(backend.resource?.availability ?? 'unknown')));
  const notSensed = backends.filter((backend) => backend.resource?.availability === 'not-sensed');
  const unknown = backends.filter((backend) => backend.resource?.availability === 'unknown' || !backend.resource);
  const openish = backends.filter((backend) =>
    backend.resource?.availability === 'open' || backend.resource?.availability === 'near',
  );
  const latestObservedAt = resources
    .map((resource) => resource?.snapshotAt ?? null)
    .filter((ts): ts is string => typeof ts === 'string')
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? generatedAt;

  if (hardBlocked.length === backends.length) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'blocked',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      `all ${backends.length} backend resource signal(s) are constrained`,
    );
  }
  if (hardBlocked.length > 0) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'degraded',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      `${hardBlocked.length}/${backends.length} backend resource signal(s) are constrained`,
    );
  }
  if (openish.length === 0 && (notSensed.length > 0 || unknown.length > 0)) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'unknown',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      'backend capacity exists but no sensed open resource signal is available',
    );
  }
  if (notSensed.length > 0 || unknown.length > 0) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'degraded',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      `${notSensed.length + unknown.length}/${backends.length} backend resource signal(s) are unsensed or unknown`,
    );
  }
  return readinessSource(
    'resources',
    'Resource Signals',
    'healthy',
    latestObservedAt,
    READINESS_STATUS_STALE_MS,
    `${openish.length}/${backends.length} backend resource signal(s) are open or near capacity`,
  );
}

function shipReadinessSources(
  status: FleetStatus,
  inputs: AutonomousShipReadinessInputs,
): FleetReadinessSourceHealth[] {
  const daemonDetail = status.daemon.running
    ? `daemon running; last tick ${status.daemon.lastTickAt ?? 'unknown'}`
    : 'daemon is stopped';
  const daemonSource = readinessSource(
    'daemon',
    'Daemon',
    status.daemon.running ? 'healthy' : 'blocked',
    status.daemon.lastTickAt,
    READINESS_DAEMON_STALE_MS,
    daemonDetail,
  );

  const guardHealth = status.guardHealth;
  const guardSource = guardHealth
    ? readinessSource(
        'guard',
        'Guard Health',
        guardHealth.blocks.length > 0 ? 'blocked' : 'healthy',
        guardHealth.generatedAt,
        READINESS_STATUS_STALE_MS,
        guardHealth.blocks.length > 0
          ? guardHealth.blocks[0]?.detail ?? 'guard health is blocking autonomous work'
          : 'guard health is clear',
      )
    : readinessSource(
        'guard',
        'Guard Health',
        'unknown',
        null,
        READINESS_STATUS_STALE_MS,
        'guard health diagnosis is unavailable',
      );

  const readiness = status.autoMergeReadiness;
  const autoMergeSource = readiness
    ? readinessSource(
        'auto-merge',
        'Auto-Merge Gate',
        readiness.enabled ? 'healthy' : 'blocked',
        inputs.generatedAt,
        READINESS_STATUS_STALE_MS,
        readiness.enabled
          ? `${readiness.preflightReady} ready, ${readiness.needsVerification} need verification, ${readiness.blocked} blocked`
          : 'auto-merge is disabled',
      )
    : readinessSource(
        'auto-merge',
        'Auto-Merge Gate',
        'unavailable',
        null,
        READINESS_STATUS_STALE_MS,
        'auto-merge readiness source is unavailable',
      );

  const queueSource = readinessSource(
    'queue',
    'Queue Snapshot',
    inputs.queueSourceStatus,
    inputs.queueSnapshotAt,
    READINESS_QUEUE_STALE_MS,
    inputs.queueSourceDetail,
  );

  const resourcesSource = resourceReadinessSource(status, inputs.generatedAt);

  const direction = status.autonomyDirection;
  const directionSource = direction
    ? readinessSource(
        'direction',
        'Autonomy Direction',
        'healthy',
        direction.generatedAt,
        READINESS_STATUS_STALE_MS,
        `${direction.mode} recommendation with ${direction.confidence} confidence`,
      )
    : readinessSource(
        'direction',
        'Autonomy Direction',
        'unknown',
        null,
        READINESS_STATUS_STALE_MS,
        'autonomy direction summary is unavailable',
      );

  return [daemonSource, guardSource, autoMergeSource, queueSource, resourcesSource, directionSource];
}

function readinessSourceSummary(sources: FleetReadinessSourceHealth[]): Record<FleetReadinessSourceStatus, number> {
  const summary: Record<FleetReadinessSourceStatus, number> = {
    healthy: 0,
    degraded: 0,
    blocked: 0,
    unavailable: 0,
    unknown: 0,
  };
  for (const source of sources) summary[source.status]++;
  return summary;
}

function readinessFreshnessSummary(
  generatedAt: string,
  sources: FleetReadinessSourceHealth[],
): FleetAutonomousShipReadinessStatus['freshness'] {
  const observed = sources
    .map((source) => source.observedAt)
    .filter((ts): ts is string => typeof ts === 'string' && Number.isFinite(Date.parse(ts)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const ageValues = sources
    .map((source) => source.ageMs)
    .filter((age): age is number => typeof age === 'number' && Number.isFinite(age));
  const staleSources = sources.filter((source) => source.freshness === 'stale').length;
  const unknownSources = sources.filter((source) => source.freshness === 'unknown').length;
  return {
    generatedAt,
    overall: staleSources > 0 ? 'stale' : unknownSources > 0 ? 'unknown' : 'fresh',
    freshestAt: observed.length > 0 ? observed[observed.length - 1]! : null,
    stalestAt: observed.length > 0 ? observed[0]! : null,
    maxAgeMs: ageValues.length > 0 ? Math.max(...ageValues) : null,
    staleSources,
    unknownSources,
  };
}

function chooseReadinessBlocker(
  status: FleetStatus,
  sources: FleetReadinessSourceHealth[],
): FleetAutonomousShipReadinessBlocker | null {
  if (status.killed) {
    return readinessBlocker(
      'kill-switch',
      'Fleet paused',
      'The global kill switch is engaged, so autonomous shipping is paused.',
      'critical',
      'fleet',
    );
  }
  if (!status.daemon.running) {
    return readinessBlocker(
      'daemon-stopped',
      'Daemon stopped',
      'The daemon is stopped; no autonomous dispatch or merge drain can run.',
      'critical',
      'daemon',
    );
  }
  const guardBlock = status.guardHealth?.blocks?.[0];
  if (guardBlock) {
    return readinessBlocker('guard-block', 'Guard block', guardBlock.detail, 'critical', 'guard');
  }
  const readiness = status.autoMergeReadiness;
  if (!readiness) {
    return readinessBlocker(
      'auto-merge-readiness-unavailable',
      'Auto-merge status unavailable',
      'The auto-merge readiness source could not be read.',
      'high',
      'auto-merge',
    );
  }
  if (!readiness.enabled) {
    return readinessBlocker(
      'auto-merge-disabled',
      'Auto-merge disabled',
      'Autonomous shipping cannot drain proposals while auto-merge is disabled.',
      'high',
      'auto-merge',
    );
  }
  if ((status.proposals.awaitingHostMerge ?? 0) > 0) {
    return readinessBlocker(
      'host-handoff',
      'Host PR handoff',
      `${status.proposals.awaitingHostMerge} proposal(s) are waiting for host merge reconciliation.`,
      'high',
      'auto-merge',
    );
  }
  if (readiness.preflightReady > 0) {
    return null;
  }
  if (readiness.needsVerification > 0) {
    return readinessBlocker(
      'verification-needed',
      'Verification needed',
      `${readiness.needsVerification} proposal(s) need verification before autonomous ship can proceed.`,
      'high',
      'auto-merge',
    );
  }
  if (readiness.knownVerificationFailed > 0) {
    return readinessBlocker(
      'verification-failed',
      'Verification failed',
      `${readiness.knownVerificationFailed} proposal(s) have known verification failures.`,
      'medium',
      'auto-merge',
    );
  }
  if (readiness.blocked > 0) {
    const topReason = Object.entries(readiness.byReason)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return readinessBlocker(
      'merge-gate-blocked',
      'Merge gate blocked',
      topReason ? `${topReason[1]}x ${topReason[0]}` : `${readiness.blocked} proposal(s) are blocked.`,
      'medium',
      'auto-merge',
    );
  }
  const queueSource = sources.find((source) => source.id === 'queue');
  if (
    status.queue.backlogItems === 0 &&
    status.proposals.pending === 0 &&
    queueSource &&
    (queueSource.status === 'unknown' || queueSource.status === 'unavailable')
  ) {
    return readinessBlocker(
      'queue-source-unavailable',
      'Queue source unavailable',
      queueSource.detail,
      'medium',
      'queue',
    );
  }
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  if (status.queue.backlogItems > 0 && eligibleBacklogItems === 0 && status.proposals.pending === 0) {
    const cooling = status.queue.cooldownItems ?? 0;
    const pending = status.queue.pendingItems ?? 0;
    const nextEligible = status.queue.nextEligibleAt ? ` Next eligible at ${status.queue.nextEligibleAt}.` : '';
    return readinessBlocker(
      'backlog-cooldown-gated',
      'Backlog cooling',
      `Backlog exists, but no items are currently daemon-eligible (${cooling} cooling, ${pending} already covered by pending proposals).${nextEligible}`,
      'medium',
      'queue',
    );
  }
  const resourceSource = sources.find((source) => source.id === 'resources');
  if (resourceSource?.status === 'blocked' || resourceSource?.status === 'unavailable') {
    return readinessBlocker(
      'resources-blocked',
      'Resources blocked',
      resourceSource.detail,
      'medium',
      'resources',
    );
  }
  if (eligibleBacklogItems > 0 && status.proposals.pending === 0) {
    return readinessBlocker(
      'proposal-production-needed',
      'Proposal production needed',
      'Backlog work is visible, but there are no pending proposals ready to ship.',
      'medium',
      'queue',
    );
  }
  return null;
}

function readinessConfidence(summary: Record<FleetReadinessSourceStatus, number>): FleetAutonomousShipReadinessConfidence {
  if (summary.unavailable > 0 || summary.unknown > 0) return 'low';
  if (summary.degraded > 0) return 'medium';
  return 'high';
}

function readinessVerdict(
  status: FleetStatus,
  summary: Record<FleetReadinessSourceStatus, number>,
  topBlocker: FleetAutonomousShipReadinessBlocker | null,
): FleetAutonomousShipReadinessVerdict {
  if (topBlocker && readinessPriorityRank(topBlocker.severity) <= readinessPriorityRank('high')) {
    return 'blocked';
  }
  if (status.autoMergeReadiness?.preflightReady && status.autoMergeReadiness.preflightReady > 0) {
    return summary.degraded > 0 || summary.unavailable > 0 || summary.unknown > 0 ? 'degraded' : 'ready';
  }
  if (
    status.queue.backlogItems === 0 &&
    status.proposals.pending === 0 &&
    (status.proposals.awaitingHostMerge ?? 0) === 0
  ) {
    return summary.degraded > 0 || summary.unavailable > 0 || summary.unknown > 0 ? 'unknown' : 'idle';
  }
  return 'degraded';
}

function buildAutonomousShipReadiness(
  status: FleetStatus,
  inputs: AutonomousShipReadinessInputs,
): FleetAutonomousShipReadinessStatus {
  const sources = shipReadinessSources(status, inputs);
  const sourceSummary = readinessSourceSummary(sources);
  const topBlocker = chooseReadinessBlocker(status, sources);
  const primaryAction = (status.nextActions ?? [])[0] ?? null;
  return {
    verdict: readinessVerdict(status, sourceSummary, topBlocker),
    confidence: readinessConfidence(sourceSummary),
    freshness: readinessFreshnessSummary(inputs.generatedAt, sources),
    topBlocker,
    primaryAction,
    sources,
    sourceSummary,
  };
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
    productionVelocity: report.productionVelocity,
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
  const missingVerifyCommands: NonNullable<NonNullable<FleetQueueRepoCoverage['executionProfiles']>['missingVerifyCommands']> = [];

  for (const repo of enrolledRepos) {
    try {
      const profile = detectRepoExecutionProfile(repo);
      if (profile.projects.length > 0) reposWithProjects++;
      if (profile.verifyCommands.length > 0) reposWithVerifyCommands++;
      else {
        missingVerifyCommands.push({
          repo,
          name: basename(repo),
          projectKinds: [...new Set(profile.projects.map((project) => project.kind))].sort(),
          reason: profile.noVerifyReason ?? 'no detected verify commands',
        });
      }
      for (const project of profile.projects) {
        const repos = packageManagers.get(project.packageManager) ?? new Set<string>();
        repos.add(repo);
        packageManagers.set(project.packageManager, repos);
      }
    } catch {
      // Read-only observability only; a broken profile scan should not hide queue status.
      missingVerifyCommands.push({
        repo,
        name: basename(repo),
        projectKinds: [],
        reason: 'repo execution profile detection failed',
      });
    }
  }

  const result: NonNullable<FleetQueueRepoCoverage['executionProfiles']> = {
    reposWithProjects,
    reposWithVerifyCommands,
    reposMissingVerifyCommands: Math.max(0, enrolledRepos.size - reposWithVerifyCommands),
    packageManagers: [...packageManagers.entries()]
      .map(([manager, repos]) => ({ manager, repos: repos.size }))
      .sort((a, b) => b.repos - a.repos || a.manager.localeCompare(b.manager)),
  };
  if (missingVerifyCommands.length > 0) {
    result.missingVerifyCommands = missingVerifyCommands.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
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
