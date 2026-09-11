import type { ResourceConsoleEngineeringEnrollment as Enrollment, ResourceConsoleEngineeringJob as Job,
  ResourceConsoleEngineeringReadiness as Readiness, ResourceConsoleEngineeringReadinessReason as ReadinessReason } from '../../core/resources/console-engineering-types.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import { ApiError, apiGet, apiPost } from './client.js';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= max;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && new TextEncoder().encode(v).byteLength <= max &&
  ![...v].some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)) || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159);
const scope = 'fixed-evaluator-and-local-branch-only';
const invalid = () => new Error('Engineering evidence could not be verified. Refresh the enrolled plan before acting.');

export const engineeringReadinessReasons: Record<ReadinessReason, string> = {
  'already-running': 'This plan is already running. Follow its execution evidence or record a stop.',
  'already-completed': 'Delivery is already recorded. This plan will not run again.',
  'graph-terminal': 'The graph has settled. Review its execution evidence before enrolling new work.',
  'owner-unavailable': 'The console owner is unavailable or shutting down. Check the host and reconnect.',
  'owner-capacity': 'The console has reached its engineering concurrency limit. Refresh after a run drains.',
  'queue-paused': 'New work is paused. Resume the task queue when you intend to allow launches.',
  'project-unavailable': 'The registered project is disabled, missing or changed. Restore its registered binding before launching.',
  'global-kill-active': 'The host stop switch is active. Keep it in place until you intend to resume host execution.',
  'global-kill-unavailable': 'The host stop switch could not be verified. Inspect its local state before launching.',
  'graph-kill-active': 'This graph’s stop switch is active. Clear it only when you intend to resume this graph.',
  'graph-kill-unavailable': 'This graph’s stop switch could not be verified. Inspect its local state before launching.',
  'provenance-unavailable': 'The existing signing identity is unavailable. Restore the enrolled host identity; this check never creates one.',
  'runtime-pin-changed': 'The resource runtime no longer matches enrollment. Review the configuration and restore the pinned runtime.',
  'enrollment-pin-changed': 'Campaign or accounting configuration no longer matches enrollment. Review the drift; do not reset accounting history.',
  'graph-evidence-unavailable': 'Graph or ownership evidence is unavailable. Inspect the local history before taking further action.',
  'graph-ownership-unavailable': 'An existing graph execution lock prevents a new launch. Wait for its owner to release it, or inspect stale ownership; this check never removes locks.',
  'launch-cancelled': 'A durable stop is recorded for this plan. It cannot be relaunched.',
  'launch-unresolved': 'An accepted launch has no recoverable completed-work proof. It remains held; refreshing never repeats it.',
  'deadline-exhausted': 'The original execution deadline has expired. Restarting does not renew it.',
  'controller-already-enrolled': 'The controller already has an enrollment. Inspect its history; this plan cannot replace it.',
  'campaign-not-startable': 'A campaign has a recorded hold, exhausted budget or recovery requirement. Inspect its campaign evidence before launching.',
};

/** Validate response identity before a displayed digest can become launch input. */
export function validWorkspaceEngineeringEnrollment(v: unknown): v is Enrollment {
  if (!object(v) || !exact(v, ['id', 'projectId', 'graphId', 'enrollmentDigest', 'objective', 'campaigns', 'budget', 'acceptanceScope',
    ...(Object.hasOwn(v, 'allowPendingContinuation') ? ['allowPendingContinuation'] : [])]) ||
    Object.hasOwn(v, 'allowPendingContinuation') && v.allowPendingContinuation !== true ||
    !id(v.id) || v.id !== v.id.toLowerCase() || !id(v.projectId) || v.projectId !== v.projectId.toLowerCase() || !id(v.graphId) || !hash(v.enrollmentDigest) || !text(v.objective, 8192) || v.acceptanceScope !== scope ||
    !object(v.budget) || !exact(v.budget, ['maxParallel', 'maxDurationMs']) || !integer(v.budget.maxParallel, 8) || !integer(v.budget.maxDurationMs, 86_400_000) ||
    !Array.isArray(v.campaigns) || v.campaigns.length < 1 || v.campaigns.length > 64) return false;
  const known = new Set<string>();
  for (const c of v.campaigns) {
    if (!object(c) || !exact(c, ['id', 'dependsOn', 'objective', 'branch', 'budget', 'campaignBudget']) || !id(c.id) || known.has(c.id) ||
      !text(c.objective, 8192) || !text(c.branch, 1024) || !c.branch.startsWith('codex/') ||
      !Array.isArray(c.dependsOn) || c.dependsOn.length >= 64 || !c.dependsOn.every(id) || new Set(c.dependsOn).size !== c.dependsOn.length ||
      !object(c.budget) || !exact(c.budget, ['maxTrials', 'maxDurationMs', 'trialTimeoutMs', 'maxParallel']) ||
      !Object.values(c.budget).every((n) => integer(n)) || !object(c.campaignBudget) ||
      !exact(c.campaignBudget, ['maxGenerations', 'maxDurationMs', 'maxModelRequests', 'maxStagnantGenerations', 'maxReportedTokens']) ||
      !integer(c.campaignBudget.maxGenerations, 128) || !integer(c.campaignBudget.maxDurationMs, 86_400_000) ||
      !(c.campaignBudget.maxModelRequests === 0 || integer(c.campaignBudget.maxModelRequests, 8192)) || !integer(c.campaignBudget.maxStagnantGenerations, 128) ||
      !(c.campaignBudget.maxReportedTokens === null || integer(c.campaignBudget.maxReportedTokens))) return false;
    known.add(c.id);
  }
  const campaigns = v.campaigns as Enrollment['campaigns'];
  if (campaigns.some((c) => c.dependsOn.some((dep) => !known.has(dep) || dep === c.id))) return false;
  // Validate acyclicity without reprioritizing the caller's declared order.
  const visited = new Set<string>();
  for (let i = 0; i < campaigns.length; i++) for (const c of campaigns) if (c.dependsOn.every((dep) => visited.has(dep))) visited.add(c.id);
  return visited.size === known.size;
}
const enrollment = validWorkspaceEngineeringEnrollment;

export async function listWorkspaceEngineering(signal?: AbortSignal): Promise<Enrollment[]> {
  const value = await apiGet<unknown>('/api/resources/engineering', signal);
  if (signal?.aborted) throw new Error('Engineering read was cancelled.');
  if (!Array.isArray(value) || value.length > 32 || !value.every(enrollment) || new Set(value.map((v) => v.id)).size !== value.length) throw invalid();
  return value;
}

function job(value: unknown, selected: Enrollment): Job {
  if (!object(value) || !exact(value, ['enrollmentId', 'projectId', 'graphId', 'enrollmentDigest', 'state', 'sourceState', 'cancellable', 'launched', 'cancelled', 'definitionDigest', 'deadlineAt', 'nodes', 'reasons', 'acceptanceScope']) ||
    value.enrollmentId !== selected.id || value.projectId !== selected.projectId || value.graphId !== selected.graphId || value.enrollmentDigest !== selected.enrollmentDigest ||
    !['ready', 'running', 'completed', 'incomplete', 'stopped', 'unavailable'].includes(String(value.state)) ||
    !['missing', 'healthy', 'degraded'].includes(String(value.sourceState)) || value.acceptanceScope !== scope ||
    typeof value.cancellable !== 'boolean' || typeof value.launched !== 'boolean' || typeof value.cancelled !== 'boolean' ||
    !(value.definitionDigest === null || hash(value.definitionDigest)) ||
    !(value.deadlineAt === null || typeof value.deadlineAt === 'string' && Number.isFinite(Date.parse(value.deadlineAt)) && new Date(value.deadlineAt).toISOString() === value.deadlineAt) ||
    !Array.isArray(value.nodes) || value.nodes.length > 128 || !Array.isArray(value.reasons) || value.reasons.length > 128 ||
    !value.reasons.every((r) => text(r, 1024))) throw invalid();
  const nodes = new Set<string>();
  for (const n of value.nodes) {
    if (!object(n) || !exact(n, ['id', 'kind', 'state', 'artifactDigest']) || !id(n.id) || nodes.has(n.id) ||
      n.kind !== 'deliver' || !['pending', 'unresolved', 'completed', 'rejected'].includes(String(n.state)) ||
      !(n.artifactDigest === null || hash(n.artifactDigest)) || n.state === 'completed' && !hash(n.artifactDigest)) throw invalid();
    nodes.add(n.id);
  }
  if (value.state === 'completed' && (value.sourceState !== 'healthy' || !value.launched || !hash(value.definitionDigest) ||
    value.nodes.length === 0 || (value.nodes as Job['nodes']).some((n) => n.state !== 'completed'))) throw invalid();
  return value as unknown as Job;
}

export async function readWorkspaceEngineering(selected: Enrollment, signal?: AbortSignal): Promise<Job> {
  if (!enrollment(selected)) throw invalid();
  const value = await apiGet<unknown>(`/api/resources/engineering/${selected.id}`, signal);
  if (signal?.aborted) throw new Error('Engineering read was cancelled.');
  return job(value, selected);
}

/** Advisory local evidence, never a capability or promise of worker capacity. */
export async function readWorkspaceEngineeringReadiness(selected: Enrollment, signal?: AbortSignal): Promise<Readiness> {
  if (!enrollment(selected)) throw invalid();
  const value = await apiGet<unknown>(`/api/resources/engineering/${selected.id}/readiness`, signal);
  if (signal?.aborted) throw new Error('Engineering read was cancelled.');
  if (!object(value) || !exact(value, ['schemaVersion', 'enrollmentId', 'enrollmentDigest', 'sampledAt', 'status', 'action', 'reasons', 'scope', 'effectsExecuted', 'providerContacted']) ||
    value.schemaVersion !== 1 || value.enrollmentId !== selected.id || value.enrollmentDigest !== selected.enrollmentDigest ||
    value.scope !== 'local-admission-check-only' || value.effectsExecuted !== false || value.providerContacted !== false ||
    typeof value.sampledAt !== 'string' || !Number.isFinite(Date.parse(value.sampledAt)) || new Date(value.sampledAt).toISOString() !== value.sampledAt ||
    !['ready', 'blocked', 'not-applicable'].includes(String(value.status)) || !['launch', 'reconcile', 'continue', 'none'].includes(String(value.action)) ||
    value.action === 'continue' && selected.allowPendingContinuation !== true ||
    value.action === 'reconcile' && selected.allowPendingContinuation === true ||
    !Array.isArray(value.reasons) || value.reasons.length > Object.keys(engineeringReadinessReasons).length ||
    !value.reasons.every((reason) => typeof reason === 'string' && Object.hasOwn(engineeringReadinessReasons, reason)) ||
    new Set(value.reasons).size !== value.reasons.length ||
    (value.status === 'ready' ? value.action === 'none' || value.reasons.length !== 0 : value.action !== 'none' || value.reasons.length === 0)) throw invalid();
  return value as unknown as Readiness;
}

/** Only explicit UI events reach this function. A lost response never triggers a retry. */
export async function controlWorkspaceEngineering(selected: Enrollment, action: 'start' | 'cancel', signal?: AbortSignal): Promise<Job> {
  if (!enrollment(selected)) throw invalid();
  const token = getMutationToken();
  if (!token) throw new Error('Unlock controls to manage engineering runs.');
  try {
    const value = await apiPost<unknown>(action === 'start' ? '/api/resources/engineering/start' : `/api/resources/engineering/${selected.id}/cancel`,
      action === 'start' ? { enrollmentId: selected.id, expectedEnrollmentDigest: selected.enrollmentDigest } : {}, token, signal);
    if (signal?.aborted || getMutationToken() !== token) throw new Error('Control response was interrupted. Refresh evidence; the run may already have changed.');
    const result = job(value, selected); touchMutationHold(); return result;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401 && getMutationToken() === token) clearMutationToken();
    if (cause instanceof ApiError && cause.status === 404) throw new Error('Engineering enrollment is unavailable. Refresh the catalog before acting.');
    throw cause;
  }
}
