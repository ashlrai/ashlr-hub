import { dirname } from 'node:path';
import { createTaskContextEvent, projectTaskTemporalContext, readTaskTemporalContext,
  taskContextTimestamp, type TaskContextCoverage, type TaskContextEventV1, type TaskTemporalContextV1 } from '../context/task-temporal-context.js';
import { readAgentActionsDetailed, type AgentActionEvent } from '../fleet/agent-action-ledger.js';
import { outcomeDirectory } from '../goals/outcome-runtime.js';
import { OutcomeStore } from '../goals/outcome-store.js';
import { outcomeCanonical, outcomeDigest, outcomeHash, outcomeIdentity } from '../goals/outcome-types.js';
import { readEnrollmentRegistry } from '../sandbox/policy.js';

export const LOCAL_CONTEXT_ACCOUNT = 'phantom-local';
/** Reversible typed identity survives secret scrubbing without exempting arbitrary 64-hex strings. */
export function outcomeTaskPublicId(nodeId: string): string {
  if (!outcomeHash(nodeId)) throw new Error('Invalid outcome task identity.');
  return `task-${nodeId.match(/.{8}/g)!.join('.')}`;
}
export function parseOutcomeTaskPublicId(value: unknown): string | null {
  return typeof value === 'string' && /^task-[a-f0-9]{8}(?:\.[a-f0-9]{8}){7}$/.test(value)
    ? value.slice(5).replaceAll('.', '') : null;
}
export interface OutcomeTaskContextRequest {
  outcomeId: string;
  taskId: string;
  asOf?: string;
  observedThrough?: string;
  maxEvents?: number;
}
export interface OutcomeTaskContextView extends TaskTemporalContextV1 {
  outcomeId: string;
  taskId: string;
  outcomeRevision: number;
  active: boolean;
  sources: Array<TaskContextCoverage & { source: 'outcome' | 'private-task-context' | 'agent-action-ledger' }>;
}
export type OutcomeTaskContextResult = { ok: true; context: OutcomeTaskContextView } |
  { ok: false; reason: 'invalid' | 'not-found' | 'unknown-source' | 'unenrolled' };

export function validOutcomeTaskContextRequest(value: unknown): value is OutcomeTaskContextRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as OutcomeTaskContextRequest;
  return Object.keys(input).every(key => ['outcomeId', 'taskId', 'asOf', 'observedThrough', 'maxEvents'].includes(key)) &&
    outcomeIdentity(input.outcomeId) && outcomeHash(input.taskId) &&
    (input.asOf === undefined || taskContextTimestamp(input.asOf) !== null) &&
    (input.observedThrough === undefined || taskContextTimestamp(input.observedThrough) !== null) &&
    (input.maxEvents === undefined || Number.isSafeInteger(input.maxEvents) && input.maxEvents >= 1 && input.maxEvents <= 100_000);
}
export function outcomeTaskContextRef(outcomeId: string, taskId: string): string {
  if (!outcomeIdentity(outcomeId) || !outcomeHash(taskId)) throw new Error('Invalid outcome task identity.');
  return `outcome:${outcomeId}:node:${outcomeTaskPublicId(taskId)}`;
}
function actionContext(event: AgentActionEvent, taskRef: string, observedAt: string): TaskContextEventV1 {
  const revisionRef = outcomeDigest(event).match(/.{8}/g)!.join('.');
  return createTaskContextEvent({ taskRef,
    source: { kind: 'phantom', provider: 'phantom', accountRef: LOCAL_CONTEXT_ACCOUNT,
      objectRef: `agent-action:${revisionRef}`, revisionRef },
    sourceRefs: [`phantom:agent-action:${revisionRef}`, ...(event.runId ? [`phantom:run:${event.runId}`] : []),
      ...(event.proposalId ? [`phantom:proposal:${event.proposalId}`] : [])],
    occurredAt: event.ts, observedAt, validFrom: null, validUntil: null, kind: 'upsert', epistemic: 'recorded',
    // These are already metadata-only action receipts. A receipt is evidence of its recorded state, not task completion.
    content: outcomeCanonical({ actor: event.actor, kind: event.kind, action: event.action, outcome: event.outcome,
      summary: event.summary, repo: event.repo ?? null, runId: event.runId ?? null, proposalId: event.proposalId ?? null }), supersedes: [] });
}

/** Exact admitted task boundary. No inbox reads, storage writes, global memory import or provider calls. */
export function readOutcomeTaskContext(input: OutcomeTaskContextRequest): OutcomeTaskContextResult {
  if (!validOutcomeTaskContextRequest(input)) return { ok: false, reason: 'invalid' };
  try {
    const taskRef = outcomeTaskContextRef(input.outcomeId, input.taskId);
    const now = new Date().toISOString();
    const query = { taskRef, accountRefs: [LOCAL_CONTEXT_ACCOUNT], asOf: input.asOf, observedThrough: input.observedThrough, maxEvents: input.maxEvents };
    // Validate query fields before filesystem reads, even when the outcome is absent.
    projectTaskTemporalContext({ ...query, events: [], sourceState: 'missing', complete: false });
    const enrollment = readEnrollmentRegistry();
    if (enrollment.state !== 'ready') return { ok: false, reason: 'unknown-source' };
    const directory = outcomeDirectory(input.outcomeId);
    const read = new OutcomeStore(directory).read();
    if (read.sourceState === 'missing') return { ok: false, reason: 'not-found' };
    if (read.sourceState !== 'healthy' || read.state.id !== input.outcomeId) return { ok: false, reason: 'unknown-source' };
    const state = read.state;
    const node = Object.hasOwn(state.nodes, input.taskId) ? state.nodes[input.taskId] : undefined;
    if (!node) return { ok: false, reason: 'not-found' };
    if (state.scope.targetRepos.some(repo => !enrollment.repos.includes(repo)) ||
        node.basis.definition.repo !== null && !enrollment.repos.includes(node.basis.definition.repo) ||
        node.attempts.some(attempt => !enrollment.repos.includes(attempt.executionRepo))) return { ok: false, reason: 'unenrolled' };
    const privateContext = readTaskTemporalContext({ ...query, root: dirname(dirname(directory)) });
    const runIds = new Set(node.attempts.flatMap(attempt => attempt.providerRunIds));
    const proposalIds = new Set(node.attempts.flatMap(attempt => attempt.proposalId ? [attempt.proposalId] : []));
    const attempts = node.attempts;
    const actions = readAgentActionsDetailed({ inspectionOnly: true, limit: input.maxEvents ?? 1000, stopAfterLimit: true,
      filter: event => !!event.repo && attempts.some(attempt => attempt.executionRepo === event.repo &&
        (event.itemId === attempt.workItemId || !!event.runId && runIds.has(event.runId) ||
          !!event.proposalId && proposalIds.has(event.proposalId))) });
    const record = createTaskContextEvent({ taskRef,
      source: { kind: 'phantom', provider: 'phantom', accountRef: LOCAL_CONTEXT_ACCOUNT,
        objectRef: taskRef, revisionRef: `${state.revision}` },
      sourceRefs: [`phantom:outcome:${state.id}:revision:${state.revision}`, `phantom:task:${outcomeTaskPublicId(node.id)}`],
      // Outcome revisions do not store creation/observation timestamps. The read time cannot repair that history.
      occurredAt: null, observedAt: now, validFrom: null, validUntil: null, kind: 'upsert', epistemic: 'recorded',
      content: outcomeCanonical({ desiredOutcome: state.scope.desiredOutcome, task: node.basis.definition,
        active: state.activeNodeIds.includes(node.id), attempts: node.attempts, completion: node.completion }), supersedes: [] });
    const sources: OutcomeTaskContextView['sources'] = [
      { source: 'outcome', sourceState: 'healthy', complete: true, stopReasons: [] },
      { source: 'private-task-context', ...privateContext.coverage },
      { source: 'agent-action-ledger', sourceState: actions.sourceState,
        complete: actions.sourceState === 'healthy' && actions.complete, stopReasons: actions.stopReasons },
    ];
    const privateEvents = [...privateContext.current, ...privateContext.history].map(({ status: _status,
      temporalResolution: _resolution, replacedBy: _replacedBy, ...event }) => event);
    const events = [record, ...privateEvents, ...actions.events.map(event => actionContext(event, taskRef, now))];
    const projected = projectTaskTemporalContext({ ...query, events,
      sourceState: sources.some(source => source.sourceState === 'degraded') ? 'degraded' : 'healthy',
      complete: sources.every(source => source.complete),
      stopReasons: sources.flatMap(source => source.sourceState === 'missing' ? [`${source.source}:missing`] : source.stopReasons.map(reason => `${source.source}:${reason}`)) });
    // Do not return a mixed current snapshot after a concurrent scope change or enrollment revocation.
    const latest = new OutcomeStore(directory).read();
    const latestEnrollment = readEnrollmentRegistry();
    if (latest.sourceState !== 'healthy' || latest.state.revision !== state.revision || latestEnrollment.state !== 'ready' ||
        state.scope.targetRepos.some(repo => !latestEnrollment.repos.includes(repo)) ||
        node.basis.definition.repo !== null && !latestEnrollment.repos.includes(node.basis.definition.repo) ||
        node.attempts.some(attempt => !latestEnrollment.repos.includes(attempt.executionRepo))) return { ok: false, reason: 'unknown-source' };
    return { ok: true, context: { ...projected, outcomeId: state.id, taskId: outcomeTaskPublicId(node.id),
      outcomeRevision: state.revision, active: state.activeNodeIds.includes(node.id), sources } };
  } catch { return { ok: false, reason: 'unknown-source' }; }
}
