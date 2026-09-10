import type { ResourceConsoleEngineeringEnrollment, ResourceConsoleEngineeringJob } from '../../../core/resources/console-engineering-types.js';

export const engineeringEnrollment = (projectId = 'default'): ResourceConsoleEngineeringEnrollment => ({
  id: `${projectId}-build`, projectId, graphId: 'verified-graph', enrollmentDigest: 'a'.repeat(64), objective: 'Improve the integer evaluator',
  campaigns: [{ id: 'integer-campaign', dependsOn: [], objective: 'Produce a strictly improved integer', branch: 'codex/verified-integer',
    budget: { maxTrials: 3, maxDurationMs: 60_000, trialTimeoutMs: 10_000, maxParallel: 1 },
    campaignBudget: { maxGenerations: 2, maxModelRequests: 3, maxDurationMs: 60_000, maxStagnantGenerations: 2, maxReportedTokens: 9000 } }],
  budget: { maxParallel: 1, maxDurationMs: 60_000 }, acceptanceScope: 'fixed-evaluator-and-local-branch-only',
});
export const engineeringJob = (row = engineeringEnrollment(), patch: Partial<ResourceConsoleEngineeringJob> = {}): ResourceConsoleEngineeringJob => ({
  enrollmentId: row.id, projectId: row.projectId, graphId: row.graphId, enrollmentDigest: row.enrollmentDigest,
  state: 'ready', sourceState: 'missing', cancellable: false, launched: false, cancelled: false,
  definitionDigest: null, deadlineAt: null, nodes: [], reasons: [], acceptanceScope: row.acceptanceScope, ...patch,
});
