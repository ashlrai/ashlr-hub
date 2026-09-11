import type { ResourceConsoleEngineeringObjective as Objective, ResourceConsoleEngineeringProfile as Profile,
  ResourceConsoleEngineeringObjectivePlan as Plan, ResourceConsoleEngineeringObjectivePrepared as Prepared } from '../../core/resources/console-engineering-preparation-types.js';
import { clearMutationToken, getMutationToken, getReadClientProof, touchMutationHold } from './auth-store.js';
import { validWorkspaceEngineeringEnrollment } from './workspace-engineering.js';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && new TextEncoder().encode(v).byteLength <= max &&
  ![...v].some(c => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)) || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159);
const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const list = (v: unknown, valid: (value: unknown) => boolean, max = 128): v is string[] => Array.isArray(v) && v.length <= max &&
  Object.keys(v).length === v.length && Array.from(v).every(valid) && new Set(v).size === v.length;
const file = (v: unknown) => text(v, 512) && !v.includes('\\') && !v.includes(':') && !v.startsWith('/') &&
  [...v].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
  v.split('/').every(part => !!part && !['.', '..', '.git', '.ashlr'].includes(part));
const summaryKeys = ['seedRevision', 'metric', 'files', 'contextFiles', 'allowedWorkerIds', 'trialBudget', 'campaignBudget'];
function summary(v: Record<string, unknown>): boolean {
  return typeof v.seedRevision === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v.seedRevision) &&
    object(v.metric) && exact(v.metric, ['name', 'direction', 'minImprovement']) && text(v.metric.name, 120) &&
    ['maximize', 'minimize'].includes(String(v.metric.direction)) && typeof v.metric.minImprovement === 'number' && Number.isFinite(v.metric.minImprovement) && v.metric.minImprovement >= 0 &&
    list(v.files, file, 16) && v.files.length > 0 && list(v.contextFiles, file, 16) && list(v.allowedWorkerIds, id, 32) && v.allowedWorkerIds.length > 0 &&
    object(v.trialBudget) && exact(v.trialBudget, ['maxTrials', 'maxDurationMs', 'trialTimeoutMs', 'maxParallel']) &&
    integer(v.trialBudget.maxTrials, 1, 64) && integer(v.trialBudget.maxParallel, 1, 8) &&
    integer(v.trialBudget.maxDurationMs, 1, 86_400_000) && integer(v.trialBudget.trialTimeoutMs, 1, 900_000) &&
    object(v.campaignBudget) && exact(v.campaignBudget, ['maxGenerations', 'maxDurationMs', 'maxModelRequests', 'maxStagnantGenerations', 'maxReportedTokens']) &&
    integer(v.campaignBudget.maxGenerations, 1, 128) && integer(v.campaignBudget.maxDurationMs, 1, 86_400_000) &&
    integer(v.campaignBudget.maxModelRequests, 0, 8192) && integer(v.campaignBudget.maxStagnantGenerations, 1, 128) &&
    (v.campaignBudget.maxReportedTokens === null || integer(v.campaignBudget.maxReportedTokens, 1, Number.MAX_SAFE_INTEGER));
}
function profile(v: unknown): v is Profile {
  return object(v) && exact(v, ['id', 'label', 'acceptance', 'projectId', ...summaryKeys]) && id(v.id) && id(v.projectId) &&
    text(v.label, 120) && text(v.acceptance, 1024) && summary(v);
}
export function validEngineeringObjective(v: unknown): v is Objective {
  return object(v) && exact(v, ['id', 'profileId', 'name', 'objective']) && id(v.id) && id(v.profileId) && text(v.name, 120) && text(v.objective, 4000);
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
}
function checkedPlan(v: unknown, input: Objective, selected: Profile): v is Plan {
  if (!object(v) || !exact(v, ['schemaVersion', 'status', 'id', 'profileId', 'profileDigest', 'name', 'objective', 'projectId', 'planDigest',
    'branch', 'acceptance', ...summaryKeys, 'executionStarted', 'providerContacted']) || v.schemaVersion !== 1 || v.status !== 'planned' ||
    !validEngineeringObjective(input) || !profile(selected) || v.id !== input.id || v.profileId !== input.profileId || input.profileId !== selected.id ||
    v.name !== input.name || v.objective !== input.objective || v.projectId !== selected.projectId || !hash(v.profileDigest) || !hash(v.planDigest) ||
    v.branch !== `codex/${input.id}` || v.acceptance !== selected.acceptance || !summary(v) || v.executionStarted !== false || v.providerContacted !== false) return false;
  return summaryKeys.every(key => stable(v[key]) === stable(selected[key as keyof Profile]));
}
const invalid = () => new Error('Preparation evidence could not be verified. Refresh the profile and check the same objective again.');

/** Every route needs explicit control authority; browser Origin is supplied by fetch. */
async function request(path: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock controls to review or prepare an engineering objective.');
  try {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', 'x-ashlr-token': token, 'x-ashlr-read-client': getReadClientProof() },
      body: JSON.stringify(input) });
    if (response.status === 401 && getMutationToken() === token) clearMutationToken();
    if (!response.ok) throw new Error();
    const serialized = await response.text();
    if (signal?.aborted || getMutationToken() !== token || new TextEncoder().encode(serialized).byteLength > 512 * 1024) throw new Error();
    const value: unknown = JSON.parse(serialized); touchMutationHold(); return value;
  } catch {
    throw new Error('Preparation request was not confirmed. Refresh enrolled plans and reconcile this same objective before trying new work.');
  }
}
export async function listEngineeringProfiles(projectId: string, signal?: AbortSignal): Promise<Profile[]> {
  if (!id(projectId)) throw invalid();
  const value = await request('/api/resources/engineering/profiles', { projectId }, signal);
  if (!object(value) || !exact(value, ['profiles']) || !Array.isArray(value.profiles) || value.profiles.length > 16 ||
    !value.profiles.every(v => profile(v) && v.projectId === projectId) || new Set(value.profiles.map(v => v.id)).size !== value.profiles.length) throw invalid();
  return value.profiles as Profile[];
}
export async function checkEngineeringObjective(input: Objective, selected: Profile, signal?: AbortSignal): Promise<Plan> {
  if (!validEngineeringObjective(input) || !profile(selected) || input.profileId !== selected.id) throw invalid();
  const captured = { ...input };
  const value = await request('/api/resources/engineering/prepare/check', captured, signal);
  if (!checkedPlan(value, captured, selected)) throw invalid();
  return value;
}
export async function prepareEngineeringObjective(input: Objective, selected: Profile, plan: Plan, signal?: AbortSignal): Promise<Prepared> {
  if (!checkedPlan(plan, input, selected)) throw invalid();
  const expected = stable(plan);
  const value = await request('/api/resources/engineering/prepare', { ...input, expectedPlanDigest: plan.planDigest }, signal);
  if (!object(value) || !exact(value, ['plan', 'enrollment', 'disposition']) || !['created', 'replayed'].includes(String(value.disposition)) ||
    !checkedPlan(value.plan, input, selected) || stable(value.plan) !== expected || !validWorkspaceEngineeringEnrollment(value.enrollment) ||
    value.enrollment.id !== input.id || value.enrollment.projectId !== selected.projectId || value.enrollment.graphId !== input.id ||
    value.enrollment.campaigns.length !== 1 || value.enrollment.campaigns[0]?.branch !== plan.branch ||
    value.enrollment.campaigns[0]?.id !== plan.id || value.enrollment.campaigns[0]?.dependsOn.length !== 0 ||
    stable(value.enrollment.campaigns[0]?.budget) !== stable(plan.trialBudget) ||
    stable(value.enrollment.campaigns[0]?.campaignBudget) !== stable(plan.campaignBudget)) throw invalid();
  return value as unknown as Prepared;
}
