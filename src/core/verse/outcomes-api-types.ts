import type { OutcomeManagerProjection } from '../goals/outcome-manager.js';
import type { VerseManagerMessageReference } from './types.js';
import type { OutcomeScope } from '../goals/outcome-types.js';

export const OUTCOMES_PATH = '/api/verse/outcomes';
export const OUTCOME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
export type OutcomeStatus = 'waiting-plan' | 'queued' | 'running' | 'waiting-verification' | 'failed' | 'paused' | 'plan-verified';
export interface OutcomeTaskView {
  key: string;
  title: string;
  repo: string | null;
  state: 'pending' | 'claimed' | 'running' | 'proposed' | 'failed' | 'aborted' | 'complete' | 'approved';
  runId: string | null;
  controllerRunId: string | null;
  proposalId: string | null;
  mergeIdentity: string | null;
}
export interface OutcomeView {
  id: string;
  revision: number;
  scopeRevision: number;
  scope: OutcomeScope;
  status: OutcomeStatus;
  tasks: OutcomeTaskView[];
  manager?: OutcomeManagerProjection;
}
export interface OutcomesRead {
  v: 1;
  sourceState: 'healthy' | 'missing' | 'degraded';
  outcomes: OutcomeView[] | null;
  enrollment: { sourceState: 'healthy'; repos: string[] } | { sourceState: 'degraded'; repos: null };
}
export interface OutcomeMutationInput {
  commandId: string;
  expectedRevision: number;
  scope?: OutcomeScope;
}
export type OutcomeOperation =
  | { kind: 'read' }
  | { kind: 'start'; id: string; commandId: string; expectedRevision: number; scope: OutcomeScope }
  | { kind: 'edit'; id: string; commandId: string; expectedRevision: number; scope: OutcomeScope }
  | { kind: 'pause' | 'resume'; id: string; commandId: string; expectedRevision: number }
  | { kind: 'manager-configure'; id: string; commandId: string; expectedRevision: number; mode: 'interactive' | 'resident'; sessionId: string | null }
  | { kind: 'manager-interject'; id: string; commandId: string; expectedRevision: number; reference: VerseManagerMessageReference };
export type OutcomeOperationResult = OutcomesRead | {
  ok: true;
  disposition: 'recorded' | 'replayed';
  outcome: OutcomeView;
} | { ok: false; reason: 'invalid' | 'conflict' | 'held' | 'unknown-source' | 'storage-failed' | 'unenrolled' };
