/**
 * data/api-types.ts — the ONLY place the web UI touches backend type
 * definitions. Everything here is a type-only re-export of the real
 * backend interfaces — never a hand-copied shape.
 *
 * Why this works: `import type` is fully erased by both tsc and esbuild/
 * Vite's transform, so importing straight from src/core/**.ts costs zero
 * runtime bytes and can never drift from the backend, unlike a generated
 * snapshot that goes stale the next time someone edits DashboardSnapshot.
 * The backend files themselves are off-limits to edit (owned by the API/
 * server work) but perfectly fine to read types from — that boundary is
 * about behavior, not about who's allowed to `import type` them.
 *
 * If `tsc --noEmit -p src/web-ui/tsconfig.json` ever fails because one of
 * these files pulls in something it shouldn't, that is a real signal: the
 * backend type surface changed in a way the frontend needs to know about,
 * not a bug in this file.
 */
export type {
  IntelligenceSummary,
  RunState,
  RunTask,
  RunStep,
  SwarmRun,
  SwarmPlan,
  SwarmTaskRun,
  SwarmTaskSpec,
  ActivityRollup,
  ProjectActivity,
  DailyUsage,
  ModelUsage,
  BudgetAlert,
  GenomeEntry,
  RecallHit,
  PortfolioSummary,
  PortfolioHealthSummary,
  PortfolioGoalInFlight,
  PortfolioBacklogItem,
  PortfolioCost,
  PortfolioEffectiveness,
  PortfolioTodayDelta,
} from '../../core/types.js';
export type {
  DashboardSnapshotWithSourceQuality as DashboardSnapshot,
  DashboardProductionSummary as ProductionSummary,
} from '../../core/dashboard.js';

/**
 * M335: per-model economics behind /api/models (GET returns
 * `{ window, models, bestOfNSource }`, i.e. ModelStatsReadResult plus the
 * echoed window). `bestOfNSource` is a real `{sourceState, complete, ...}`
 * shape — structurally compatible with SourceQuality below — so best-of-N
 * win-rate figures should be wrapped in <Epistemic quality={bestOfNSource}/>
 * when it isn't 'healthy'+complete.
 */
export type { ModelStats, ModelStatsReadResult, ModelStatsSourceQuality } from '../../core/fleet/model-stats.js';
// M331: DashboardSnapshot (above, from core/types.js) under-types `.production`
// as the base ProductionSummary — the richer per-field source-quality shape
// (judgeTraceSourceQuality / judgeFailureSourceQuality / activeGoalsSourceQuality)
// only exists on dashboard.ts's DashboardProductionSummary, which is what
// buildSnapshot()/GET /api/snapshot actually returns at runtime. Re-exported
// here so routes can type the richer shape without hand-copying it.
export type { DashboardProductionSummary } from '../../core/dashboard.js';

export type {
  ControlSnapshot,
  ControlDaemon,
  ControlSecurity,
  ControlSecurityFinding,
  ControlLogEntry,
  FleetActivitySnapshot,
  FleetMergeEvent,
  FleetTickEntry,
} from '../../core/web/control.js';
export type { VisibilitySnapshot } from '../../core/web/visibility.js';
/**
 * Proposal + decisions-ledger types for the inbox (proposal review) view.
 * `DecisionEntry`/`JudgeDecisionReasonCode` back the evidence panel — a
 * judge-parse-failure/judge-network-failure reason code is an infra
 * failure, NOT a considered judgment, and must render distinctly from a
 * real `judge-review` verdict (see routes/inbox/).
 */
export type {
  Proposal,
  ProposalStatus,
  ProposalKind,
  ProposalVerifyResult,
  DecisionEntry,
  JudgeDecisionReasonCode,
} from '../../core/types.js';
export type { PublicDaemonObservation, DaemonSourceQuality } from '../../core/daemon/public-observation.js';

/**
 * Journal / notification centre additions (M416): `FleetStatus.nextActions`
 * (priority-tagged next steps) and `.autonomousShipReadiness`
 * (verdict/topBlocker) are the SAME operator-attention data the legacy
 * public/app.js's "Needs you" / "Autonomous now" split reads
 * (buildOperatorBriefingModel, app.js:7438-7494) — reused here rather than
 * inventing a parallel priority scheme, per the brief's instruction to
 * ground notification priority in what the fleet already computes. Both
 * arrive already populated on `ControlSnapshot.fleet` from GET /api/control.
 */
export type { FleetStatus, FleetNextAction, FleetNextActionCommand, FleetAutonomousShipReadinessStatus } from '../../core/fleet/status.js';
export type { AgentWorkspaceRecentAction } from '../../core/fleet/agent-action-ledger.js';

/**
 * Structural shape shared by every "we might not actually know this"
 * field across the backend (daemon observation, control sections, goal
 * progress, …). Every real occurrence in src/core matches this shape —
 * `{ sourceState, complete, reason? }` — even though it isn't hoisted to
 * one named exported type on the backend. Modeled structurally here so the
 * epistemic-honesty primitive (see components/primitives/Epistemic.tsx)
 * can key off it wherever it appears without importing a dozen individual
 * one-off types.
 */
export interface SourceQuality {
  sourceState: 'healthy' | 'degraded' | 'missing' | 'unknown';
  complete: boolean;
  reason?: string;
}

/** The envelope every `snapshot` SSE frame carries (see api.ts handleSseEvents). */
export interface SnapshotEventPayload {
  dispatchEnabled: boolean;
  [key: string]: unknown;
}
