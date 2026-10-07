import { createHash } from 'node:crypto';
import type { OutcomeManagerState } from './outcome-manager-types.js';
import { isAbsolute, normalize } from 'node:path';
import type { EcosystemMissionGraphNodeV1, EcosystemMissionGraphV1 } from '../vision/mission-graph.js';

/** Local durable coordination evidence, not a signed grant or provider admission. */
export interface OutcomeScope {
  desiredOutcome: string;
  targetRepos: string[];
  acceptance: string[];
}
export interface OutcomeNodeBasis {
  scopeRevision: number;
  scopeDigest: string;
  planRevision: number;
  graphDigest: string;
  definition: EcosystemMissionGraphNodeV1;
  dependencies: string[];
}
export type OutcomeAttemptGeneration = `outcome:v1:${string}`;
export interface OutcomeAttempt {
  id: string;
  executionRepo: string;
  workItemId: string;
  generationId: OutcomeAttemptGeneration;
  /** Parent harness run; candidate runs retain their own provider identity. */
  runId: string | null;
  providerRunIds: string[];
  /** Exact selected terminal run, retained across restart. */
  terminalRunId: string | null;
  proposalId: string | null;
  state: 'claimed' | 'running' | 'proposed' | 'failed' | 'aborted' | 'complete';
}
export interface OutcomeNode {
  id: string;
  semanticDigest: string;
  basis: OutcomeNodeBasis;
  /** Durable idempotent goal materialization intent; the coordinator never writes a Goal. */
  materialization: { goalId: string; milestoneId: string; state: 'intent' | 'linked' };
  attempts: OutcomeAttempt[];
  humanApproval: { receiptDigest: string } | null;
  completion: { attemptId: string; proposalId: string; mergeIdentity: string } | null;
}
export interface OutcomeState {
  schemaVersion: 1 | 2;
  /** Present only in v2; old immutable v1 records retain their original bytes. */
  manager?: OutcomeManagerState;
  id: string;
  revision: number;
  scopeRevision: number;
  scope: OutcomeScope;
  scopeDigest: string;
  planRevision: number;
  graphDigest: string | null;
  graph: EcosystemMissionGraphV1 | null;
  activeNodeIds: string[];
  /** Historical nodes remain immutable in basis even when removed from the active plan. */
  nodes: Record<string, OutcomeNode>;
  paused: boolean;
}
export interface OutcomeRecord {
  schemaVersion: 1 | 2;
  revision: number;
  previousDigest: string | null;
  commandId: string;
  requestDigest: string;
  state: OutcomeState;
  digest: string;
}
export type OutcomeRead =
  | { sourceState: 'healthy'; state: OutcomeState; records: OutcomeRecord[] }
  | { sourceState: 'missing' | 'degraded'; state: null; records: OutcomeRecord[] };
export type OutcomeWrite =
  | { ok: true; disposition: 'recorded' | 'replayed'; state: OutcomeState }
  | { ok: false; reason: 'invalid' | 'conflict' | 'lock-conflict' | 'held' | 'unknown-source' | 'storage-failed' };

export function outcomeCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(outcomeCanonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${outcomeCanonical(item)}`).join(',')}}`;
}
export function outcomeDigest(value: unknown): string {
  return createHash('sha256').update(outcomeCanonical(value)).digest('hex');
}
export function outcomeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
/** Existing mission/Goal binding protocol identity grammar; not a workload limit. */
export function outcomeIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(value);
}
export function outcomeHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
/** The graph's existing wire objective is bounded to 4000 characters. Long user scope
 * remains intact in the durable outcome and producer context; only the host substitutes
 * a canonical identity reference for the graph transport. The reference binds ALL scope
 * text/targets/acceptance via scopeDigest, never a prefix or model-authored summary.
 * NFC mirrors the existing mission compiler for inline objectives. */
export function outcomeGraphObjective(state: Pick<OutcomeState, 'id' | 'scopeRevision' | 'scopeDigest' | 'scope'>): string {
  const inline = state.scope.desiredOutcome.normalize('NFC');
  return inline.length <= 4000 ? inline
    : `Immutable desired outcome scope: outcome-scope:v1:${state.id}:${state.scopeRevision}:${state.scopeDigest}. Full objective and acceptance remain in the saved outcome scope.`;
}
export function normalizeOutcomeScope(scope: OutcomeScope): OutcomeScope {
  if (!scope || typeof scope.desiredOutcome !== 'string' || !scope.desiredOutcome.trim() ||
      !Array.isArray(scope.targetRepos) || !scope.targetRepos.length ||
      scope.targetRepos.some(repo => typeof repo !== 'string' || !isAbsolute(repo) || repo.includes('\0') || normalize(repo) !== repo) ||
      !Array.isArray(scope.acceptance) || !scope.acceptance.length ||
      scope.acceptance.some(item => typeof item !== 'string' || !item.trim())) throw new Error('Invalid outcome scope');
  return { desiredOutcome: scope.desiredOutcome.trim(), targetRepos: [...new Set(scope.targetRepos)].sort(),
    acceptance: [...new Set(scope.acceptance.map(item => item.trim()))].sort() };
}
