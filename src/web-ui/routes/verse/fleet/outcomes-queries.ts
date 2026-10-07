import type { OutcomeOperationResult, OutcomeScope, OutcomesRead, OutcomeView } from './outcomes-types.js';
import { OUTCOMES_PATH, OUTCOME_ID_PATTERN } from '../../../../core/verse/outcomes-api-types.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { validManagerProjection } from '../multimodel/manager-queries.js';

export const OUTCOMES_KEY = 'verse-outcomes';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
function validOutcome(value: unknown): value is OutcomeView {
  if (!value || typeof value !== 'object') return false;
  const row = value as OutcomeView;
  return typeof row.id === 'string' && OUTCOME_ID_PATTERN.test(row.id) && Number.isSafeInteger(row.revision) && row.revision > 0
    && Number.isSafeInteger(row.scopeRevision) && row.scopeRevision > 0 && !!row.scope && typeof row.scope.desiredOutcome === 'string'
    && strings(row.scope.targetRepos) && strings(row.scope.acceptance)
    && ['waiting-plan', 'queued', 'running', 'waiting-verification', 'failed', 'paused', 'plan-verified'].includes(row.status)
    && (row.manager === undefined || validManagerProjection(row.manager))
    && Array.isArray(row.tasks) && row.tasks.every(task => !!task && typeof task.key === 'string' && typeof task.title === 'string'
      && (task.repo === null || typeof task.repo === 'string')
      && ['pending', 'claimed', 'running', 'proposed', 'failed', 'aborted', 'complete', 'approved'].includes(task.state)
      && [task.runId, task.controllerRunId, task.proposalId, task.mergeIdentity].every(id => id === null || typeof id === 'string'));
}
export const outcomesQuery: QueryDef<OutcomesRead> = {
  key: OUTCOMES_KEY,
  async fetch(signal) {
    const value = await apiGet<OutcomesRead>(OUTCOMES_PATH, signal);
    if (!value || value.v !== 1 || !['healthy', 'missing', 'degraded'].includes(value.sourceState) ||
        (value.sourceState === 'degraded' ? value.outcomes !== null : !Array.isArray(value.outcomes) || !value.outcomes.every(validOutcome)) || !value.enrollment ||
        !['healthy', 'degraded'].includes(value.enrollment.sourceState) ||
        (value.enrollment.sourceState === 'healthy' ? !strings(value.enrollment.repos) : value.enrollment.repos !== null)) throw new Error('Outcome records are unavailable.');
    return value;
  },
};

export async function writeOutcome(action: 'start' | 'edit' | 'pause' | 'resume' | 'manager-configure', id: string, commandId: string, expectedRevision: number, scope?: OutcomeScope): Promise<OutcomeOperationResult> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const body = { commandId, expectedRevision, ...(scope ? { scope } : {}), ...(action === 'start' ? { id } : {}),
    ...(action === 'manager-configure' ? { mode: 'resident', sessionId: null } : {}) };
  const result = await apiPost<OutcomeOperationResult>(action === 'start' ? `${OUTCOMES_PATH}/start` : `${OUTCOMES_PATH}/${encodeURIComponent(id)}/${action}`, body, token);
  if (!result || !('ok' in result) || result.ok !== true || !validOutcome(result.outcome) || result.outcome.id !== id ||
      action === 'manager-configure' && (result.outcome.manager?.sourceState !== 'healthy' || result.outcome.manager.enabled !== true ||
        result.outcome.manager.mode !== 'resident' || result.outcome.manager.sessionId !== null)) {
    throw new Error('The outcome write could not be confirmed. Refresh and retry with the same command.');
  }
  touchMutationHold();
  invalidate(OUTCOMES_KEY);
  return result;
}
