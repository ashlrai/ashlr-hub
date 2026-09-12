import { createResourceEngineeringPreparationRegistry, validateResourceConsoleEngineeringObjective,
  validateResourceEngineeringAutomaticAdmission, type ResourceEngineeringAutomaticAdmission, type ResourceEngineeringAutomaticAdmissionCandidate, type ResourceEngineeringPreparationRegistration } from './engineering-preparation-registry.js';
export { validateResourceConsoleEngineeringObjective, validateResourceConsoleEngineeringPreparationConfig } from './engineering-preparation-registry.js';
/** Host-pinned objective preparation on the existing engineering owner. No execution or queue mutation. */
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical } from '../universe/artifacts.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import { type ResourceConsoleEngineeringOwner } from './console-engineering.js';
import type { ResourceEngineeringSuccessorSource } from './engineering-preparation-types.js';
import { checkResourceEngineeringSuccessorPreparation, prepareResourceEngineeringSuccessorBundle } from './engineering-successor-preparation.js';
import { readResourceEngineeringDeliveredSource, type ResourceEngineeringDeliveredSource } from './engineering-delivered-source.js';
import type { ResourceConsoleEngineeringObjective, ResourceConsoleEngineeringObjectivePlan, ResourceConsoleEngineeringObjectivePrepared,
  ResourceConsoleEngineeringPreparationConfig, ResourceConsoleEngineeringProfile } from './console-engineering-preparation-types.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function fail(code: ConstructorParameters<typeof ResourceSupervisorError>[0], message: string): never { throw new ResourceSupervisorError(code, message); }
function copy<T>(input: unknown): T {
  const text = canonicalEvidencePackJsonV3(input);
  if (text === null || Buffer.byteLength(text) > 1024 * 1024) fail('INVALID_INPUT', 'Invalid engineering preparation data');
  return JSON.parse(text) as T;
}
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export class ResourceEngineeringAutomaticAdmissionOwnershipError extends Error {
  constructor() { super('Automatic admission owner unavailable'); }
}

export interface ResourceConsoleEngineeringPreparationOwner {
  profiles(projectId: string): ResourceConsoleEngineeringProfile[];
  check(input: unknown): ResourceConsoleEngineeringObjectivePlan;
  prepare(input: unknown): ResourceConsoleEngineeringObjectivePrepared;
  /** Host-only authorization, never taken from an objective HTTP body. */
  prepareAutomatically(input: unknown, binding: ResourceEngineeringAutomaticAdmission): ResourceConsoleEngineeringObjectivePrepared;
  pendingAutomaticAdmissions(binding: ResourceEngineeringAutomaticAdmission,
    admitted: Array<{ enrollmentId: string; enrollmentDigest: string }>, preferredEnrollmentId?: string): ResourceEngineeringAutomaticAdmissionCandidate[];
  /** Private host capability: derive lineage only from this owner's prepared, delivered enrollment. */
  successorSource(id: string, expectedEnrollmentDigest: string): ResourceEngineeringDeliveredSource | null;
  /** Private host capability, never accepted by the ordinary browser preparation route. */
  prepareSuccessor(input: ResourceConsoleEngineeringObjective & { source: ResourceEngineeringSuccessorSource }): Promise<ResourceConsoleEngineeringObjectivePrepared>;
}
export function createResourceConsoleEngineeringPreparation(input: {
  configFile: string; config: ResourceConsoleEngineeringPreparationConfig; root: string; workspace: string; projectsFile: string;
  poolFile: string; bindingsFile: string; observationsFile: string; quotaConfigFile?: string;
  owner: ResourceConsoleEngineeringOwner;
}): ResourceConsoleEngineeringPreparationOwner {
  // Capture caller-owned options without invoking accessors. Later mutation must
  // not redirect a checked objective away from its pinned console context.
  const required = ['configFile', 'config', 'root', 'workspace', 'projectsFile', 'poolFile', 'bindingsFile', 'observationsFile', 'owner'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'Invalid engineering preparation options');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || ![...required, 'quotaConfigFile'].includes(key)) ||
    required.some(key => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) fail('INVALID_INPUT', 'Invalid engineering preparation options');
  const options = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as typeof input;
  const { owner: _owner, ...registryOptions } = options;
  const registry = createResourceEngineeringPreparationRegistry(registryOptions);
  const { config, contextDigest, currentConfig, registrations, objective, planned, materialize, successorOptions, committed } = registry;
  // Validate all profiles without initializing output, contacting workers or reading credentials.
  for (const profile of config.profiles) materialize({ id: profile.recipe.id, profileId: profile.id, name: profile.recipe.name, objective: profile.recipe.objective });
  // Validate the whole durable set before exposing any reconstructed enrollment.
  const restored = registrations().flatMap(row => {
    try { return [committed(row)]; }
    catch (error) {
      // Only explicitly obligated ordinary rows may remain held outside the map.
      // Configured/already-admitted queue entries still require a catalog member.
      if (row.automaticAdmission && !row.source) return [];
      throw error;
    }
  });
  if (restored.length) options.owner.register({ schemaVersion: 1, enrollments: restored.flatMap(row => row.catalog.enrollments) });
  let automaticCursor = '';
  function prepare(input: unknown, binding?: ResourceEngineeringAutomaticAdmission) {
    const prepared = registry.prepare(input, {
      beforeNew(id) {
        if (options.owner.catalog().some(row => row.id === id)) fail('CONFLICT', 'Objective identity is already in use');
        if (options.owner.catalog().length >= 32) fail('CONFLICT', 'Engineering enrollment capacity reached');
      },
      beforePublication: catalog => { options.owner.checkRegistration(catalog); },
    }, binding);
    const enrollment = options.owner.register(prepared.catalog).find(row =>
      row.id === prepared.plan.id && row.enrollmentDigest === prepared.enrollmentDigest);
    if (!enrollment) fail('UNAVAILABLE', 'Objective enrollment could not be confirmed');
    return copy<ResourceConsoleEngineeringObjectivePrepared>({ plan: prepared.plan, enrollment, disposition: prepared.disposition });
  }
  return {
    prepare,
    prepareAutomatically(input, binding) { return prepare(input, validateResourceEngineeringAutomaticAdmission(binding)); },
    pendingAutomaticAdmissions(input, admittedInput, preferredEnrollmentId) {
      const binding = validateResourceEngineeringAutomaticAdmission(input);
      const admitted = copy<typeof admittedInput>(admittedInput);
      if (preferredEnrollmentId !== undefined && (typeof preferredEnrollmentId !== 'string' || !ID.test(preferredEnrollmentId))) fail('INVALID_INPUT', 'Invalid preferred automatic enrollment');
      if (!Array.isArray(admitted) || admitted.length > 32 || admitted.some(row => !exact(row, ['enrollmentId', 'enrollmentDigest']) ||
          typeof row.enrollmentId !== 'string' || !ID.test(row.enrollmentId) || typeof row.enrollmentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.enrollmentDigest)) ||
          new Set(admitted.map(row => row.enrollmentId)).size !== admitted.length) fail('INVALID_INPUT', 'Invalid admitted enrollment evidence');
      currentConfig();
      const rows = registrations().filter(row => row.automaticAdmission?.supervisionId === binding.supervisionId).sort((a, b) => a.request.id.localeCompare(b.request.id));
      const eligible = rows.filter(row => canonical(row.automaticAdmission) === canonical(binding) && !admitted.some(item => item.enrollmentId === row.request.id));
      const selected = eligible.find(row => row.request.id === preferredEnrollmentId) ?? eligible.find(row => row.request.id.localeCompare(automaticCursor) > 0) ?? eligible[0];
      // One fresh proof per pass; a stale first row cannot monopolize retries.
      if (selected) automaticCursor = selected.request.id;
      return rows.flatMap((row): ResourceEngineeringAutomaticAdmissionCandidate[] => {
        const candidate = { enrollmentId: row.request.id, expectedEnrollmentDigest: row.enrollmentDigest };
        if (canonical(row.automaticAdmission) !== canonical(binding)) return [{ ...candidate, reason: 'binding-changed' }];
        const existing = admitted.find(item => item.enrollmentId === row.request.id);
        if (existing) {
          if (existing.enrollmentDigest !== row.enrollmentDigest) return [{ ...candidate, reason: 'binding-changed' }];
          return [];
        }
        if (row !== selected) return [{ ...candidate, reason: 'verification-pending' }];
        let verified: ReturnType<typeof committed>;
        try { verified = committed(row, row.request, true); }
        catch { return [{ ...candidate, reason: 'evidence-unavailable' }]; }
        // An ownership/transport fault is not a stale bundle and must not retry.
        try {
          const catalog = options.owner.catalog();
          if (!catalog.some(item => item.id === row.request.id && item.enrollmentDigest === row.enrollmentDigest)) options.owner.register(verified.catalog);
        }
        catch { throw new ResourceEngineeringAutomaticAdmissionOwnershipError(); }
        return [{ ...candidate, reason: null }];
      });
    },
    successorSource(id, expectedEnrollmentDigest) {
      try {
        if (options.owner.snapshot(id).state !== 'completed') return null;
        return readResourceEngineeringDeliveredSource(registry, id, expectedEnrollmentDigest);
      } catch { return null; }
    },
    async prepareSuccessor(input) {
      const value = copy<ResourceConsoleEngineeringObjective & { source: ResourceEngineeringSuccessorSource }>(input);
      if (!exact(value, ['id', 'profileId', 'name', 'objective', 'source'])) fail('INVALID_INPUT', 'Invalid successor objective');
      const { source, ...request } = value;
      const candidate = objective(request); const previous = registrations();
      const existing = previous.find(row => row.request.id === candidate.request.id);
      if (existing) {
        if (!existing.source || canonical(existing.source) !== canonical(source)) fail('CONFLICT', 'Successor source changed');
        const verified = committed(existing, request); currentConfig();
        options.owner.checkRegistration(verified.catalog);
        const enrollment = options.owner.register(verified.catalog).find(row => row.id === request.id && row.enrollmentDigest === verified.report.enrollmentDigest);
        if (!enrollment) fail('UNAVAILABLE', 'Successor enrollment could not be confirmed');
        return copy({ plan: verified.candidate.plan, enrollment, disposition: 'replayed' });
      }
      if (previous.length >= 32 || options.owner.catalog().length >= 32 || options.owner.catalog().some(row => row.id === request.id)) {
        fail('CONFLICT', 'Successor identity or capacity unavailable');
      }
      const bundleOptions = successorOptions(candidate, source);
      const plan = planned(candidate, checkResourceEngineeringSuccessorPreparation(bundleOptions));
      const report = await prepareResourceEngineeringSuccessorBundle({ ...bundleOptions, expectedPlanDigest: plan.bundlePlan.planDigest });
      const registration: ResourceEngineeringPreparationRegistration = { schemaVersion: 1, configDigest: contextDigest, request: plan.request,
        planDigest: plan.plan.planDigest, bundlePlanDigest: report.planDigest, enrollmentDigest: report.enrollmentDigest, source };
      const verified = registry.publish(registration, catalog => { options.owner.checkRegistration(catalog); });
      const enrollment = options.owner.register(verified.catalog).find(row => row.id === request.id && row.enrollmentDigest === report.enrollmentDigest);
      if (!enrollment) fail('UNAVAILABLE', 'Successor enrollment could not be confirmed');
      return copy({ plan: verified.candidate.plan, enrollment, disposition: report.disposition });
    },
    profiles(projectId) {
      if (typeof projectId !== 'string' || !ID.test(projectId)) fail('INVALID_INPUT', 'Expected a registered project ID');
      currentConfig();
      return copy(config.profiles.filter(row => row.recipe.projectId === projectId).map(row => ({ id: row.id, label: row.label,
        acceptance: row.acceptance, projectId, seedRevision: row.recipe.seedRevision, metric: row.recipe.metric,
        files: row.recipe.generation.files, contextFiles: row.recipe.generation.contextFiles, allowedWorkerIds: row.recipe.generation.allowedWorkerIds,
        trialBudget: row.recipe.trialBudget, campaignBudget: row.recipe.campaignBudget })));
    },
    check(input) {
      const request = validateResourceConsoleEngineeringObjective(input);
      const saved = registrations().find(row => row.request.id === request.id);
      if (saved) return copy(committed(saved, request).candidate.plan);
      const candidate = materialize(request);
      if (options.owner.catalog().some(row => row.id === request.id)) fail('CONFLICT', 'Objective identity is already in use');
      return copy(candidate.plan);
    },
  };
}
