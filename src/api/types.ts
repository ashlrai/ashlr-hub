/**
 * api/types.ts — the PUBLIC type surface of @ashlr/hub (M33).
 *
 * Curated re-exports only: everything here is part of the published contract
 * (`import type { … } from '@ashlr/hub/types'`). Internals stay unexported —
 * add types deliberately, never wholesale.
 */

export type {
  // Config + index
  AshlrConfig,
  AshlrIndex,
  IndexedItem,
  ItemKind,
  GitStatus,
  // Runs + swarms
  RunState,
  RunTask,
  RunUsage,
  RunBudget,
  RunOptions,
  RunEstimate,
  PercentileTriple,
  SwarmRun,
  SwarmPlan,
  // Genome
  GenomeEntry,
  RecallHit,
  LearnInput,
  // Portfolio intelligence
  Backlog,
  WorkItem,
  WorkSource,
  HealthScore,
  HealthReport,
  HealthDimensionScore,
  HealthScoreError,
  ClampedHealthScore,
  AskResult,
  ImpactResult,
  KnowledgeGraph,
  // Approval inbox + audit
  Proposal,
  ProposalKind,
  ProposalStatus,
  ApplyResult,
  AuditEntry,
  // Observability
  ActivityRollup,
  // Dashboard + web
  DashboardSnapshot,
  WebServerOptions,
  // M31 agent-native surface
  OrientResult,
  NativeToolDef,
  NativeToolSafety,
  // Notifications
  NotifyTarget,
} from '../core/types.js';

export type {
  SeamId,
  SeamImpl,
  SeamCloud,
  SeamStatus,
  SeamRegistry,
} from '../core/seams/types.js';

export type {
  ExternalSkillAuditEntry,
  ExternalSkillAuditIssue,
  ExternalSkillAuditIssueCode,
  ExternalSkillCollision,
  ExternalSkillAuditReport,
  ExternalSkillPromotionBlocker,
} from '../core/fleet/external-skill-audit.js';
