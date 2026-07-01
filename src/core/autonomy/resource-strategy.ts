/**
 * Read-only resource-aware autonomous direction report.
 *
 * This module is advisory only: it reads existing health/status/outcome signals
 * and recommends an operating mode. It never dispatches work, runs merge logic,
 * writes ledgers, or changes policy.
 */

import type { AshlrConfig, EngineId } from '../types.js';
import type { GuardHealthDiagnosis } from '../daemon/guard-health.js';
import type { FleetStatus } from '../fleet/status.js';
import type {
  BackendAvailability,
  BackendResourceState,
  ResourceSnapshot,
} from '../fabric/resource-monitor.js';
import type { OutcomeRecord } from './outcome-records.js';
import type { EcosystemDoctorCheck, EcosystemDoctorReport } from '../ecosystem/doctor.js';

export type AutonomousDirectionMode =
  | 'pause'
  | 'local-only'
  | 'verify-only'
  | 'backlog-build'
  | 'auto-merge-ready';

export type ResourcePosture = 'open' | 'constrained' | 'depleted' | 'unknown';
export type EcosystemPosture = 'pass' | 'warn' | 'fail';
export type ReportConfidence = 'low' | 'medium' | 'high';

export interface ResourceStrategyBackend {
  backend: EngineId;
  availability: BackendAvailability | 'not-sensed';
  quota: FleetStatus['backends'][number]['quota'] | 'unknown';
  dispatchesRecent: number;
  usedPct: number | null;
  cap: number | null;
  capUnit: BackendResourceState['capUnit'];
  capWindow: string | null;
  resetsAt: number | null;
  reason: string;
}

export interface ResourceStrategyOutcome {
  proposalId: string;
  status: OutcomeRecord['proposal']['status'];
  title: string;
  lastActivityAt: string;
  verificationPassed: boolean | null;
  policyAllowed: boolean | null;
  policyAction: string | null;
  riskClass: string | null;
}

export interface ResourceStrategyBudgetSummary {
  daemonDailyBudgetUsd: number | null;
  daemonSpentTodayUsd: number;
  daemonBudgetLevel: 'ok' | 'near' | 'over' | 'unconfigured';
  telemetryBudgetUsd: number | null;
  telemetryBudgetTokens: number | null;
  telemetryBudgetWindow: '1d' | '7d' | '30d' | null;
  telemetryGovAction: 'warn' | 'block' | null;
  rateLimits: Array<{ backend: string; window: string; max: number }>;
  claudeResource: {
    weeklyMessageCap: number | null;
    weeklyTokenBudget: number | null;
    weeklyCostBudgetUsd: number | null;
    protectPct: number | null;
    window: string | null;
  };
}

export interface ResourceStrategyReport {
  version: 1;
  generatedAt: string;
  mode: AutonomousDirectionMode;
  confidence: ReportConfidence;
  reasons: string[];
  recommendedActions: string[];
  guardHealth: {
    blocked: boolean;
    blocks: Array<{ id: string; detail: string; path: string }>;
  };
  fleet: {
    killed: boolean;
    daemonRunning: boolean;
    lastTickAt: string | null;
    backlogItems: number;
    pendingProposals: number;
    frontierPending: number;
    appliedProposals: number;
    recentMerges: number;
    autonomyAllowed: number;
    autonomyDenied: number;
  };
  resources: {
    posture: ResourcePosture;
    constrained: number;
    depleted: number;
    backends: ResourceStrategyBackend[];
  };
  outcomes: {
    records: number;
    readyEvidence: number;
    verificationFailures: number;
    recent: ResourceStrategyOutcome[];
  };
  ecosystem: {
    posture: EcosystemPosture;
    summary: EcosystemDoctorReport['summary'];
    topChecks: Array<Pick<EcosystemDoctorCheck, 'id' | 'label' | 'status' | 'detail' | 'repo'>>;
  };
  budgets: ResourceStrategyBudgetSummary;
}

export interface ResourceStrategyReadDeps {
  buildFleetStatus?: (cfg: AshlrConfig) => Promise<FleetStatus>;
  getResourceSnapshot?: (cfg: AshlrConfig) => Promise<ResourceSnapshot>;
  listOutcomeRecords?: (opts?: { limit?: number }) => OutcomeRecord[];
  runEcosystemDoctor?: (opts?: { root?: string; deep?: boolean; now?: Date }) => Promise<EcosystemDoctorReport>;
  diagnoseGuardHealth?: () => GuardHealthDiagnosis;
}

export interface ResourceStrategyOptions {
  maxOutcomes?: number;
  maxChecks?: number;
  ecosystemRoot?: string;
  now?: Date;
  deps?: ResourceStrategyReadDeps;
}

export interface ResourceStrategyDaemonPlan {
  mode: AutonomousDirectionMode;
  allowDispatch: boolean;
  forceLocalOnly: boolean;
  runAutoMergeMaintenance: boolean;
  reason: string;
}

const DEFAULT_MAX_OUTCOMES = 8;
const DEFAULT_MAX_CHECKS = 8;
const CLOUD_BACKENDS = new Set<string>(['claude', 'codex', 'nim', 'kimi', 'ashlrcode', 'opencode', 'hermes']);
const LOCAL_BACKENDS = new Set<string>(['builtin', 'local-coder', 'ollama']);
const HARD_STOP_AVAILABILITY = new Set<BackendAvailability>(['exhausted', 'throttled', 'unreachable']);

function cap(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function budgetLevel(spent: number, capUsd: number | null): ResourceStrategyBudgetSummary['daemonBudgetLevel'] {
  if (capUsd === null || capUsd <= 0) return 'unconfigured';
  if (spent >= capUsd) return 'over';
  if (spent >= capUsd * 0.85) return 'near';
  return 'ok';
}

function summarizeBudgets(cfg: AshlrConfig, fleet: FleetStatus): ResourceStrategyBudgetSummary {
  const foundry = cfg.foundry as (NonNullable<AshlrConfig['foundry']> & Record<string, unknown>) | undefined;
  const daemonDailyBudgetUsd = finiteNumber(cfg.daemon?.dailyBudgetUsd);
  const limits = foundry?.limits ?? {};
  const rateLimits = Object.entries(limits)
    .flatMap(([backend, limit]) => {
      const max = finiteNumber((limit as { max?: unknown } | undefined)?.max);
      const window = (limit as { window?: unknown } | undefined)?.window;
      if (max === null || typeof window !== 'string') return [];
      return [{ backend, window, max }];
    })
    .slice(0, 12);
  const claudeResource = foundry?.claudeResource;
  const claude = claudeResource && typeof claudeResource === 'object'
    ? claudeResource as Record<string, unknown>
    : {};

  return {
    daemonDailyBudgetUsd,
    daemonSpentTodayUsd: fleet.daemon.todaySpentUsd,
    daemonBudgetLevel: budgetLevel(fleet.daemon.todaySpentUsd, daemonDailyBudgetUsd),
    telemetryBudgetUsd: finiteNumber(cfg.telemetry?.budgetUsd),
    telemetryBudgetTokens: finiteNumber(cfg.telemetry?.budgetTokens),
    telemetryBudgetWindow: cfg.telemetry?.budgetWindow ?? null,
    telemetryGovAction: cfg.telemetry?.govAction ?? null,
    rateLimits,
    claudeResource: {
      weeklyMessageCap: finiteNumber(claude['weeklyMessageCap']),
      weeklyTokenBudget: finiteNumber(claude['weeklyTokenBudget']),
      weeklyCostBudgetUsd: finiteNumber(claude['weeklyCostBudgetUsd']),
      protectPct: finiteNumber(claude['protectPct']),
      window: typeof claude['window'] === 'string' ? claude['window'] : null,
    },
  };
}

function fallbackGuard(fleet: FleetStatus, depsGuard?: GuardHealthDiagnosis): GuardHealthDiagnosis {
  return depsGuard ?? fleet.guardHealth ?? { generatedAt: fleet.generatedAt, blocked: false, blocks: [] };
}

function joinBackends(fleet: FleetStatus, resources: ResourceSnapshot, max: number): ResourceStrategyBackend[] {
  const byResource = new Map(resources.backends.map((state) => [state.backend, state]));
  const backendIds = new Set<EngineId>();
  for (const backend of fleet.backends) backendIds.add(backend.backend);
  for (const state of resources.backends) backendIds.add(state.backend);

  return [...backendIds].slice(0, max).map((backend) => {
    const fleetBackend = fleet.backends.find((value) => value.backend === backend);
    const state = byResource.get(backend);
    return {
      backend,
      availability: state?.availability ?? 'not-sensed',
      quota: fleetBackend?.quota ?? 'unknown',
      dispatchesRecent: fleetBackend?.dispatchesRecent ?? 0,
      usedPct: state?.usedPct ?? null,
      cap: state?.cap ?? null,
      capUnit: state?.capUnit ?? null,
      capWindow: state?.capWindow ?? null,
      resetsAt: state?.resetsAt ?? null,
      reason: state?.reason ?? 'no resource snapshot for backend',
    };
  });
}

function resourcePosture(backends: ResourceStrategyBackend[]): ResourceStrategyReport['resources'] {
  const sensed = backends.filter((backend) => backend.availability !== 'not-sensed');
  const constrained = sensed.filter((backend) =>
    backend.availability === 'near' || HARD_STOP_AVAILABILITY.has(backend.availability as BackendAvailability),
  ).length;
  const depleted = sensed.filter((backend) =>
    HARD_STOP_AVAILABILITY.has(backend.availability as BackendAvailability),
  ).length;
  const unknown = sensed.filter((backend) => backend.availability === 'unknown').length;

  let posture: ResourcePosture = 'unknown';
  if (sensed.length > 0) {
    if (depleted === sensed.length) posture = 'depleted';
    else if (constrained > 0) posture = 'constrained';
    else if (unknown > 0) posture = 'unknown';
    else posture = 'open';
  }

  return { posture, constrained, depleted, backends };
}

function summarizeOutcomes(records: OutcomeRecord[], max: number): ResourceStrategyReport['outcomes'] {
  let readyEvidence = 0;
  let verificationFailures = 0;
  const recent = records.slice(0, max).map((record): ResourceStrategyOutcome => {
    const latestEvidence = record.evidencePacks[0];
    const verificationPassed = latestEvidence?.verification.passed ?? record.proposal.verifyResult?.passed ?? null;
    const policyAllowed = latestEvidence?.policy?.allowed ?? null;
    if (verificationPassed === true && policyAllowed === true) readyEvidence++;
    if (verificationPassed === false || record.proposal.verifyResult?.passed === false) verificationFailures++;
    return {
      proposalId: record.proposal.id,
      status: record.proposal.status,
      title: record.proposal.title,
      lastActivityAt: record.lastActivityAt,
      verificationPassed,
      policyAllowed,
      policyAction: latestEvidence?.policy?.action ?? null,
      riskClass: latestEvidence?.riskClass ?? record.proposal.riskClass ?? null,
    };
  });

  return {
    records: records.length,
    readyEvidence,
    verificationFailures,
    recent,
  };
}

function ecosystemPosture(report: EcosystemDoctorReport): EcosystemPosture {
  if (report.summary.fail > 0) return 'fail';
  if (report.summary.warn > 0) return 'warn';
  return 'pass';
}

function summarizeEcosystem(report: EcosystemDoctorReport, max: number): ResourceStrategyReport['ecosystem'] {
  const topChecks = report.checks
    .filter((check) => check.status !== 'pass')
    .concat(report.checks.filter((check) => check.status === 'pass'))
    .slice(0, max)
    .map((check) => ({
      id: check.id,
      label: check.label,
      status: check.status,
      detail: check.detail,
      ...(check.repo ? { repo: check.repo } : {}),
    }));

  return {
    posture: ecosystemPosture(report),
    summary: report.summary,
    topChecks,
  };
}

function hasOpenLocal(backends: ResourceStrategyBackend[]): boolean {
  return backends.some((backend) =>
    LOCAL_BACKENDS.has(backend.backend) &&
    (backend.availability === 'open' || backend.availability === 'near' || backend.availability === 'unknown'),
  );
}

function cloudConstrained(backends: ResourceStrategyBackend[]): boolean {
  const cloud = backends.filter((backend) => CLOUD_BACKENDS.has(backend.backend));
  return cloud.length > 0 && cloud.every((backend) =>
    backend.availability === 'not-sensed' ||
    backend.availability === 'unknown' ||
    HARD_STOP_AVAILABILITY.has(backend.availability as BackendAvailability),
  );
}

function recommendMode(
  cfg: AshlrConfig,
  guard: GuardHealthDiagnosis,
  fleet: FleetStatus,
  resources: ResourceStrategyReport['resources'],
  outcomes: ResourceStrategyReport['outcomes'],
  ecosystem: ResourceStrategyReport['ecosystem'],
  budgets: ResourceStrategyBudgetSummary,
): { mode: AutonomousDirectionMode; confidence: ReportConfidence; reasons: string[]; recommendedActions: string[] } {
  const reasons: string[] = [];
  const actions: string[] = [];

  if (fleet.killed) reasons.push('kill switch is engaged');
  if (guard.blocked) reasons.push(`guard health has ${guard.blocks.length} blocking issue(s)`);
  if (budgets.daemonBudgetLevel === 'over') reasons.push('daemon daily budget is exhausted');
  if (resources.posture === 'depleted') reasons.push('all sensed resource backends are depleted');

  if (reasons.length > 0) {
    actions.push('keep autonomous dispatch paused until guards and budgets are green');
    actions.push('repair guard-health blocks before widening autonomy');
    return { mode: 'pause', confidence: 'high', reasons, recommendedActions: actions };
  }

  const localOpen = hasOpenLocal(resources.backends);
  const cloudHeld = cloudConstrained(resources.backends);
  if ((cloudHeld || budgets.daemonBudgetLevel === 'near') && localOpen) {
    if (cloudHeld) reasons.push('cloud/frontier resources are constrained or unknown while local capacity is available');
    if (budgets.daemonBudgetLevel === 'near') reasons.push('daemon spend is near its configured daily cap');
    actions.push('prefer local or builtin engines for new work');
    actions.push('reserve frontier calls for verification and human-approved proposals');
    return { mode: 'local-only', confidence: cloudHeld ? 'medium' : 'high', reasons, recommendedActions: actions };
  }

  const autoMergeEnabled = cfg.foundry?.autoMerge?.enabled === true;
  if (autoMergeEnabled && outcomes.readyEvidence > 0 && ecosystem.posture !== 'fail') {
    reasons.push(`${outcomes.readyEvidence} recent outcome record(s) have verified allowed evidence`);
    actions.push('review ready evidence and allow existing merge gates to decide');
    actions.push('do not widen merge authority from this advisory report');
    return { mode: 'auto-merge-ready', confidence: 'medium', reasons, recommendedActions: actions };
  }

  if (fleet.proposals.pending > 0 || outcomes.verificationFailures > 0 || ecosystem.posture === 'fail') {
    if (fleet.proposals.pending > 0) reasons.push(`${fleet.proposals.pending} pending proposal(s) need verification or review`);
    if (outcomes.verificationFailures > 0) reasons.push(`${outcomes.verificationFailures} recent outcome record(s) failed verification`);
    if (ecosystem.posture === 'fail') reasons.push('ecosystem doctor reports failing checks');
    actions.push('focus on verification, triage, and repair before generating more proposals');
    return { mode: 'verify-only', confidence: 'high', reasons, recommendedActions: actions };
  }

  if (fleet.queue.backlogItems > 0) {
    reasons.push(`${fleet.queue.backlogItems} backlog item(s) are available and no hard stop is active`);
    actions.push('build backlog proposals within configured caps');
    actions.push('keep report read-only until dispatch policy explicitly consumes it');
    return { mode: 'backlog-build', confidence: 'medium', reasons, recommendedActions: actions };
  }

  reasons.push('no hard stop is active and no pending backlog pressure is visible');
  actions.push('scan for high-value backlog sources before dispatching new work');
  return { mode: 'backlog-build', confidence: 'low', reasons, recommendedActions: actions };
}

async function defaultFleetStatus(cfg: AshlrConfig): Promise<FleetStatus> {
  const { buildFleetStatus } = await import('../fleet/status.js');
  return buildFleetStatus(cfg);
}

async function defaultResourceSnapshot(cfg: AshlrConfig): Promise<ResourceSnapshot> {
  const { getResourceSnapshot } = await import('../fabric/resource-monitor.js');
  return getResourceSnapshot(cfg);
}

async function defaultOutcomeRecordsAsync(limit: number): Promise<OutcomeRecord[]> {
  const { listOutcomeRecords } = await import('./outcome-records.js');
  return listOutcomeRecords({
    limit,
    deps: {
      loadWorkedLedger: () => ({ events: [] }),
    },
  });
}

async function defaultEcosystemDoctor(options: { root?: string; deep?: boolean; now?: Date }): Promise<EcosystemDoctorReport> {
  const { runEcosystemDoctor } = await import('../ecosystem/doctor.js');
  return runEcosystemDoctor(options);
}

async function fallbackEcosystem(now: Date, root: string | undefined): Promise<EcosystemDoctorReport> {
  return {
    generatedAt: now.toISOString(),
    root: root ?? process.cwd(),
    summary: { pass: 0, warn: 1, fail: 0, total: 1, repos: 0 },
    checks: [{
      id: 'ecosystem-doctor',
      label: 'Ecosystem doctor',
      status: 'warn',
      detail: 'ecosystem doctor unavailable',
    }],
    repos: [],
  };
}

/**
 * Build a bounded, read-only advisory report for autonomous operating mode.
 */
export async function buildResourceStrategyReport(
  cfg: AshlrConfig,
  opts: ResourceStrategyOptions = {},
): Promise<ResourceStrategyReport> {
  const now = opts.now ?? new Date();
  const maxOutcomes = cap(opts.maxOutcomes, DEFAULT_MAX_OUTCOMES);
  const maxChecks = cap(opts.maxChecks, DEFAULT_MAX_CHECKS);
  const deps = opts.deps ?? {};

  const fleet = await (deps.buildFleetStatus ?? defaultFleetStatus)(cfg);
  const resources = await (deps.getResourceSnapshot ?? defaultResourceSnapshot)(cfg);
  const records = deps.listOutcomeRecords
    ? deps.listOutcomeRecords({ limit: maxOutcomes })
    : await defaultOutcomeRecordsAsync(maxOutcomes);
  const doctor = deps.runEcosystemDoctor
    ? await deps.runEcosystemDoctor({ root: opts.ecosystemRoot, deep: false, now })
    : await defaultEcosystemDoctor({ root: opts.ecosystemRoot, deep: false, now }).catch(() =>
        fallbackEcosystem(now, opts.ecosystemRoot),
      );
  const explicitGuard = deps.diagnoseGuardHealth?.();
  const guard = fallbackGuard(fleet, explicitGuard);

  const joinedBackends = joinBackends(fleet, resources, 12);
  const resourceSummary = resourcePosture(joinedBackends);
  const outcomeSummary = summarizeOutcomes(records, maxOutcomes);
  const ecosystemSummary = summarizeEcosystem(doctor, maxChecks);
  const budgetSummary = summarizeBudgets(cfg, fleet);
  const recommendation = recommendMode(
    cfg,
    guard,
    fleet,
    resourceSummary,
    outcomeSummary,
    ecosystemSummary,
    budgetSummary,
  );

  return {
    version: 1,
    generatedAt: now.toISOString(),
    mode: recommendation.mode,
    confidence: recommendation.confidence,
    reasons: recommendation.reasons.slice(0, 8),
    recommendedActions: recommendation.recommendedActions.slice(0, 8),
    guardHealth: {
      blocked: guard.blocked,
      blocks: guard.blocks.slice(0, maxChecks).map((block) => ({
        id: block.id,
        detail: block.detail,
        path: block.path,
      })),
    },
    fleet: {
      killed: fleet.killed,
      daemonRunning: fleet.daemon.running,
      lastTickAt: fleet.daemon.lastTickAt,
      backlogItems: fleet.queue.backlogItems,
      pendingProposals: fleet.proposals.pending,
      frontierPending: fleet.proposals.frontierPending,
      appliedProposals: fleet.proposals.applied,
      recentMerges: fleet.merges.recent,
      autonomyAllowed: fleet.autonomy?.allowed ?? 0,
      autonomyDenied: fleet.autonomy?.denied ?? 0,
    },
    resources: resourceSummary,
    outcomes: outcomeSummary,
    ecosystem: ecosystemSummary,
    budgets: budgetSummary,
  };
}

/**
 * Convert the advisory report into a tiny daemon policy. This is pure so the
 * opt-in daemon control loop can be tested independently from the readers.
 */
export function resourceStrategyToDaemonPlan(report: ResourceStrategyReport): ResourceStrategyDaemonPlan {
  const reason = report.reasons[0] ?? `resource strategy recommended ${report.mode}`;
  switch (report.mode) {
    case 'pause':
      return {
        mode: report.mode,
        allowDispatch: false,
        forceLocalOnly: false,
        runAutoMergeMaintenance: false,
        reason,
      };
    case 'verify-only':
    case 'auto-merge-ready':
      return {
        mode: report.mode,
        allowDispatch: false,
        forceLocalOnly: false,
        runAutoMergeMaintenance: true,
        reason,
      };
    case 'local-only':
      return {
        mode: report.mode,
        allowDispatch: true,
        forceLocalOnly: true,
        runAutoMergeMaintenance: true,
        reason,
      };
    case 'backlog-build':
      return {
        mode: report.mode,
        allowDispatch: true,
        forceLocalOnly: false,
        runAutoMergeMaintenance: true,
        reason,
      };
  }
}
