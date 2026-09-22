import type { ResourceConsoleEngineeringProfile, ResourceConsoleEngineeringObjective, ResourceConsoleEngineeringObjectivePlan,
  ResourceConsoleEngineeringObjectivePrepared } from '../../../core/resources/console-engineering-preparation-types.js';
import { engineeringEnrollment } from './engineering-fixture.test-support.js';

export function preparationProfile(projectId = 'default'): ResourceConsoleEngineeringProfile {
  return { id: `${projectId}-profile`, projectId, label: 'Reviewed parser cases', acceptance: 'All fixed parser cases must pass. No deployment is evaluated.',
    seedRevision: 'a'.repeat(40), metric: { name: 'correctness', direction: 'maximize', minImprovement: 1 },
    files: ['src/parser.ts'], contextFiles: ['test/cases.json'], allowedWorkerIds: ['codex-a'],
    trialBudget: { maxTrials: 2, maxDurationMs: 60_000, trialTimeoutMs: 10_000, maxParallel: 1 },
    campaignBudget: { maxGenerations: 2, maxDurationMs: 60_000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: 9000 } };
}
export function preparationInput(profile = preparationProfile()): ResourceConsoleEngineeringObjective {
  return { id: 'parser-fix', profileId: profile.id, name: 'Parser correction', objective: 'Fix escaped whitespace against the reviewed cases.' };
}
export function preparationPlan(input = preparationInput(), profile = preparationProfile()): ResourceConsoleEngineeringObjectivePlan {
  const { id: _profileId, label: _label, ...summary } = profile;
  return { ...summary, ...input, schemaVersion: 1, status: 'planned', profileDigest: 'b'.repeat(64), planDigest: 'c'.repeat(64),
    branch: `codex/${input.id}`, executionStarted: false, providerContacted: false };
}
export function preparationResult(plan = preparationPlan()): ResourceConsoleEngineeringObjectivePrepared {
  const enrollment = engineeringEnrollment(plan.projectId);
  enrollment.id = plan.id; enrollment.graphId = plan.id; enrollment.objective = plan.objective;
  enrollment.campaigns[0] = { id: plan.id, dependsOn: [], objective: plan.objective, branch: plan.branch,
    budget: plan.trialBudget, campaignBudget: plan.campaignBudget };
  return { plan, enrollment, disposition: 'created' };
}
