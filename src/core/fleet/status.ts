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
import type { AshlrConfig, EngineId, Proposal, WorkItem } from '../types.js';
import type { SharedQueueHealth } from './shared-store.js';
import type { AutonomyEvidencePack } from '../autonomy/evidence-pack.js';
import type { ResourceStrategyReport } from '../autonomy/resource-strategy.js';
import type { GuardHealthDiagnosis } from '../daemon/guard-health.js';
import type { EcosystemDoctorReport } from '../ecosystem/doctor.js';
import { listEnrolled } from '../sandbox/policy.js';

/** A single backend's recent activity + quota standing. */
export interface FleetBackendStatus {
  /** The backend id (e.g. 'builtin', 'claude', 'codex'). */
  backend: EngineId;
  /** Dispatches recorded for this backend in the recent window (last 24h). */
  dispatchesRecent: number;
  /** Quota standing: 'unlimited' when no rate limit is configured. */
  quota: 'ok' | 'warn' | 'over' | 'unlimited';
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
  trustBasis: 'tier' | 'verification';
  pending: number;
  preflightReady: number;
  needsVerification: number;
  knownVerificationFailed: number;
  blocked: number;
  byReason: Record<string, number>;
  recentBlockers: FleetAutoMergeBlockerSummary[];
}

export interface FleetQueueNextItem {
  id: string;
  title: string;
  repo: string;
  source: WorkItem['source'];
  score: number;
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
    next?: FleetQueueNextItem[];
    shared?: FleetSharedQueueStatus;
  };
  proposals: {
    pending: number;
    frontierPending: number;
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
  /** True when the global kill switch is engaged (fleet paused). */
  killed: boolean;
}

/** Recent window for dispatch + merge counting: the last 24 hours. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function enrolledExistingRepoSet(): Set<string> {
  try {
    return new Set(listEnrolled().map((repo) => resolve(repo)).filter((repo) => existsSync(repo)));
  } catch {
    return new Set();
  }
}

function isVisibleBacklogItem(item: WorkItem, enrolledRepos: Set<string>): boolean {
  if (enrolledRepos.size === 0) return false;
  return enrolledRepos.has(resolve(item.repo));
}

export function resolveAutonomyControlMode(cfg: AshlrConfig): FleetAutonomyControlMode {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  if (!foundry) return 'disabled';
  return foundry['autonomyControlLoop'] === false ? 'advisory' : 'executable';
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
  let recentTicks: Array<{ ts?: string; merged?: number; backends?: Record<string, number> }> = [];
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

  // ── queue (backlog size) ──────────────────────────────────────────────────
  let backlogItems = 0;
  let nextQueueItems: FleetQueueNextItem[] = [];
  try {
    // Status must be observational. A full buildBacklog() refresh can run
    // scanners, expand planning goals, persist ~/.ashlr/backlog.json, and audit.
    // Read the last persisted snapshot only; the daemon/backlog CLI owns refresh.
    const { loadBacklog } = await import('../portfolio/backlog.js');
    const backlog = loadBacklog();
    const enrolledRepos = enrolledExistingRepoSet();
    const items = (Array.isArray(backlog?.items) ? backlog.items : [])
      .filter((item): item is WorkItem => isVisibleBacklogItem(item, enrolledRepos));
    backlogItems = items.length;
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
      }
    }
  } catch {
    pending = 0;
    frontierPending = 0;
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
      ...(nextQueueItems.length > 0 ? { next: nextQueueItems } : {}),
      ...(sharedQueue !== undefined ? { shared: sharedQueue } : {}),
    },
    proposals: { pending, frontierPending, applied },
    merges: { recent: mergesRecent },
    autonomy,
    autonomyControlMode: resolveAutonomyControlMode(cfg),
    ...(autoMergeReadiness !== undefined ? { autoMergeReadiness } : {}),
    ...(guardHealth !== undefined ? { guardHealth } : {}),
    killed,
  };

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

  return status;
}

async function buildAutoMergeReadinessStatus(
  cfg: AshlrConfig,
  pendingProposals: Proposal[],
): Promise<FleetAutoMergeReadinessStatus> {
  const autoMerge = cfg.foundry?.autoMerge;
  const enabled = autoMerge?.enabled === true;
  const trustBasis: 'tier' | 'verification' =
    autoMerge?.trustBasis === 'verification' ? 'verification' : 'tier';
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

    if (trustBasis !== 'verification') {
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
