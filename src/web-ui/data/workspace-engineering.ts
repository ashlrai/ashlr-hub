import type { ResourceConsoleEngineeringEnrollment as Enrollment, ResourceConsoleEngineeringJob as Job } from '../../core/resources/console-engineering-types.js';
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

/** Validate response identity before a displayed digest can become launch input. */
function enrollment(v: unknown): v is Enrollment {
  if (!object(v) || !exact(v, ['id', 'projectId', 'graphId', 'enrollmentDigest', 'objective', 'campaigns', 'budget', 'acceptanceScope']) ||
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
