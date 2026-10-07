/** Manager coordination metadata. These records never grant contact or merge authority. */
import { isAbsolute, normalize } from 'node:path';
import { outcomeDigest, outcomeHash, outcomeToken, type OutcomeState } from './outcome-types.js';

export function isOutcomeManagerWorkItem(item: { id: string; tags: readonly string[] }): boolean {
  return item.tags.includes('outcome-manager') || item.id.startsWith('outcome-manager:');
}

export type OutcomeManagerIntent = 'plan' | 'review' | 'replan';
export interface OutcomeManagerRoute {
  engine: string;
  seatId: string;
  model: string;
  tier: 'frontier';
}
export interface OutcomeManagerBasis {
  scopeRevision: number;
  scopeDigest: string;
  planRevision: number;
  graphDigest: string | null;
  conversationRevision: number;
  evidenceDigest: string;
}
export interface OutcomeManagerStage {
  id: string;
  intent: OutcomeManagerIntent;
  basis: OutcomeManagerBasis;
  basisDigest: string;
  executionRepo: string;
  workItemId: string;
  generationId: `outcome:v1:${string}`;
  route: OutcomeManagerRoute;
  runId: string;
  providerRunIds: string[];
  state: 'running' | 'succeeded' | 'failed' | 'aborted' | 'stale';
  terminalRunId: string | null;
  resultDigest: string | null;
  resultKind: 'plan-applied' | 'review-recorded' | null;
  proposalId: string | null;
  appliedPlanRevision: number | null;
  appliedGraphDigest: string | null;
  settledBasisDigest: string | null;
  failureReason: 'invalid-result' | 'plan-refused' | 'run-failed' | null;
}
export interface OutcomeManagerState {
  schemaVersion: 1;
  mode: 'interactive' | 'resident';
  sessionId: string | null;
  conversationRevision: number;
  /** References to the existing private conversation, not copied user text. */
  interjections: Array<{ sessionId: string; messageId: string; eventSeq: number; revision: number }>;
  stages: OutcomeManagerStage[];
}
const exact = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const routeToken = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export function validOutcomeManagerRoute(route: OutcomeManagerRoute): boolean {
  return !!route && exact(route, ['engine', 'seatId', 'model', 'tier']) &&
    routeToken(route.engine) &&
    routeToken(route.seatId) && routeToken(route.model) && route.tier === 'frontier';
}
export function managerGeneration(outcomeId: string, stageId: string): OutcomeManagerStage['generationId'] {
  return `outcome:v1:${outcomeDigest(['manager-stage', outcomeId, stageId])}`;
}
export function managerWorkItemId(outcomeId: string, basisDigest: string): string {
  return `outcome-manager:${outcomeId}:${basisDigest}`;
}
/** Plan/review scope includes actual work evidence; manager journal churn itself is excluded. */
export function outcomeManagerBasis(state: OutcomeState): OutcomeManagerBasis {
  const evidence = state.activeNodeIds.map(id => {
    const node = state.nodes[id]!;
    const attempt = node.attempts.at(-1);
    return { id, attemptId: attempt?.id ?? null, state: attempt?.state ?? null,
      terminalRunId: attempt?.terminalRunId ?? null, proposalId: attempt?.proposalId ?? null,
      completion: node.completion, humanApproval: node.humanApproval };
  });
  return { scopeRevision: state.scopeRevision, scopeDigest: state.scopeDigest,
    planRevision: state.planRevision, graphDigest: state.graphDigest,
    conversationRevision: state.manager?.conversationRevision ?? 0,
    evidenceDigest: outcomeDigest({ work: evidence, managerFailure: state.manager?.stages.filter(stage =>
      ['failed', 'aborted', 'stale'].includes(stage.state) && stage.basis.scopeDigest === state.scopeDigest).at(-1)?.id ?? null }) };
}
export function validOutcomeManagerState(value: OutcomeManagerState, state: OutcomeState): boolean {
  if (!value || !exact(value, ['schemaVersion', 'mode', 'sessionId', 'conversationRevision', 'interjections', 'stages']) ||
      value.schemaVersion !== 1 || !['interactive', 'resident'].includes(value.mode) ||
      !(value.sessionId === null || outcomeToken(value.sessionId)) ||
      value.mode === 'interactive' && value.sessionId === null || !integer(value.conversationRevision) ||
      !Array.isArray(value.interjections) || !Array.isArray(value.stages)) return false;
  if (value.interjections.length !== value.conversationRevision || value.interjections.some((item, i) =>
    !item || !exact(item, ['sessionId', 'messageId', 'eventSeq', 'revision']) || item.sessionId !== value.sessionId ||
    !outcomeToken(item.sessionId) || !outcomeToken(item.messageId) || !integer(item.eventSeq) || item.eventSeq < 1 || item.revision !== i + 1 ||
    i > 0 && item.eventSeq <= value.interjections[i - 1]!.eventSeq ||
    value.interjections.slice(0, i).some(previous => previous.messageId === item.messageId))) return false;
  const ids = new Set<string>();
  for (const stage of value.stages) {
    const basis = stage?.basis;
    if (!stage || !exact(stage, ['id', 'intent', 'basis', 'basisDigest', 'executionRepo', 'workItemId', 'generationId',
        'route', 'runId', 'providerRunIds', 'state', 'terminalRunId', 'resultDigest', 'resultKind', 'proposalId',
        'appliedPlanRevision', 'appliedGraphDigest', 'settledBasisDigest', 'failureReason']) || !outcomeHash(stage.id) || ids.has(stage.id) ||
        !['plan', 'review', 'replan'].includes(stage.intent) || !basis ||
        !exact(basis, ['scopeRevision', 'scopeDigest', 'planRevision', 'graphDigest', 'conversationRevision', 'evidenceDigest']) ||
        !integer(basis.scopeRevision) || basis.scopeRevision < 1 || basis.scopeRevision > state.scopeRevision ||
        !outcomeHash(basis.scopeDigest) || !integer(basis.planRevision) || basis.planRevision > state.planRevision ||
        !(basis.graphDigest === null || outcomeHash(basis.graphDigest)) || !integer(basis.conversationRevision) ||
        basis.conversationRevision > value.conversationRevision || !outcomeHash(basis.evidenceDigest) ||
        outcomeDigest(basis) !== stage.basisDigest || stage.workItemId !== managerWorkItemId(state.id, stage.basisDigest) ||
        stage.generationId !== managerGeneration(state.id, stage.id) || !isAbsolute(stage.executionRepo) ||
        normalize(stage.executionRepo) !== stage.executionRepo || stage.executionRepo.includes('\0') ||
        !validOutcomeManagerRoute(stage.route) || !outcomeToken(stage.runId) || !Array.isArray(stage.providerRunIds) ||
        !stage.providerRunIds.includes(stage.runId) || stage.providerRunIds.some(id => !outcomeToken(id)) ||
        new Set(stage.providerRunIds).size !== stage.providerRunIds.length ||
        !['running', 'succeeded', 'failed', 'aborted', 'stale'].includes(stage.state) ||
        !(stage.terminalRunId === null || stage.providerRunIds.includes(stage.terminalRunId)) ||
        !(stage.resultDigest === null || outcomeHash(stage.resultDigest)) ||
        !(stage.proposalId === null || outcomeToken(stage.proposalId))) return false;
    if (stage.state === 'failed' ? !['invalid-result', 'plan-refused', 'run-failed'].includes(stage.failureReason!)
        : stage.failureReason !== null) return false;
    if (stage.state === 'running' && (stage.terminalRunId !== null || stage.resultDigest !== null || stage.resultKind !== null ||
        stage.proposalId !== null || stage.appliedPlanRevision !== null || stage.appliedGraphDigest !== null || stage.settledBasisDigest !== null)) return false;
    if (stage.state !== 'running' && stage.terminalRunId === null) return false;
    if (stage.state === 'succeeded') {
      if (!outcomeHash(stage.settledBasisDigest) || !outcomeHash(stage.resultDigest) || !['plan-applied', 'review-recorded'].includes(stage.resultKind!)) return false;
      if (stage.resultKind === 'plan-applied' ? !integer(stage.appliedPlanRevision) || stage.appliedPlanRevision < 1 ||
          stage.appliedPlanRevision > state.planRevision || !outcomeHash(stage.appliedGraphDigest) :
          stage.appliedPlanRevision !== null || stage.appliedGraphDigest !== null) return false;
    } else if (stage.resultKind !== null || stage.appliedPlanRevision !== null || stage.appliedGraphDigest !== null || stage.settledBasisDigest !== null) return false;
    ids.add(stage.id);
  }
  return true;
}
