import { createResourceEngineeringPreparationRegistry, validateResourceConsoleEngineeringObjective,
  type ResourceEngineeringPreparationRegistration } from './engineering-preparation-registry.js';
export { validateResourceConsoleEngineeringObjective, validateResourceConsoleEngineeringPreparationConfig } from './engineering-preparation-registry.js';
/** Host-pinned objective preparation on the existing engineering owner. No execution or queue mutation. */
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, readArtifactSnapshot } from '../universe/artifacts.js';
import { decodeUtf8Excerpt } from '../util/utf8-excerpt.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import { type ResourceConsoleEngineeringOwner } from './console-engineering.js';
import type { ResourceEngineeringSuccessorSource } from './engineering-preparation-types.js';
import { checkResourceEngineeringSuccessorPreparation, prepareResourceEngineeringSuccessorBundle } from './engineering-successor-preparation.js';
import { campaignUniverse, readUniverseCampaign } from '../universe/campaign-store.js';
import { readCompletedCampaignDelivery } from '../universe/campaign-delivery-recovery.js';
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
const hash = (value: unknown) => digest(canonical(value));

export interface ResourceConsoleEngineeringPreparationOwner {
  profiles(projectId: string): ResourceConsoleEngineeringProfile[];
  check(input: unknown): ResourceConsoleEngineeringObjectivePlan;
  prepare(input: unknown): ResourceConsoleEngineeringObjectivePrepared;
  /** Private host capability: derive lineage only from this owner's prepared, delivered enrollment. */
  successorSource(id: string, expectedEnrollmentDigest: string): {
    source: ResourceEngineeringSuccessorSource; projectId: string; commit: string; objective: string; context: string;
  } | null;
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
  const restored = registrations().map(row => committed(row));
  if (restored.length) options.owner.register({ schemaVersion: 1, enrollments: restored.flatMap(row => row.catalog.enrollments) });
  return {
    successorSource(id, expectedEnrollmentDigest) {
      try {
        const row = registrations().find(item => item.request.id === id && item.enrollmentDigest === expectedEnrollmentDigest);
        if (!row || options.owner.snapshot(id).state !== 'completed') return null;
        const verified = committed(row, row.request, true); const enrollment = verified.catalog.enrollments[0];
        if (verified.catalog.enrollments.length !== 1 || !enrollment || enrollment.id !== id ||
          enrollment.host.definition.tasks.length !== 1 || enrollment.host.deliveryPlan.deliveries.length !== 1) return null;
        const campaignId = enrollment.host.definition.tasks[0]!.campaignId;
        const target = enrollment.host.deliveryPlan.deliveries[0]!;
        if (target.campaignId !== campaignId) return null;
        const campaign = readUniverseCampaign(campaignId, { root: enrollment.host.root });
        const receipt = readCompletedCampaignDelivery(campaign, target, { root: enrollment.host.root });
        if (!receipt) return null;
        const universe = campaignUniverse(campaign, { root: enrollment.host.root });
        const trial = universe.runs.find(run => run.id === receipt.runId)?.trials.find(item => item.id === receipt.trialId);
        if (universe.sourceState !== 'healthy' || !trial?.artifact || trial.artifact.digest !== receipt.artifactDigest) return null;
        const artifact = readArtifactSnapshot(trial.artifact.path);
        if (artifact.digest !== receipt.artifactDigest) return null;
        // Stable measured evidence and declared source bytes, not the mutable
        // project checkout or a volatile polling timestamp. Truncation is explicit.
        const seed = campaign.seedEvaluation?.result?.measurement;
        const observed = { metric: universe.manifest.metric, seed: seed ? { passed: seed.passed, score: seed.score } : null,
          delivered: { score: trial.score, deltaFromParent: trial.delta, artifactDigest: receipt.artifactDigest },
          files: [] as Array<{ path: string; text: string; truncated: boolean }>, omittedFiles: 0 };
        const allowed = new Set([...verified.candidate.plan.files, ...verified.candidate.plan.contextFiles]);
        for (const file of artifact.entries.filter(file => allowed.has(file.path))) {
          if (observed.files.length >= 4) { observed.omittedFiles++; continue; }
          try {
            const excerpt = decodeUtf8Excerpt(file.data, 1600);
            const value = excerpt.text;
            if (value.includes('\0')) throw new Error('Binary source');
            const item = { path: file.path, ...excerpt };
            if (Buffer.byteLength(canonical({ ...observed, files: [...observed.files, item] })) > 4096) { observed.omittedFiles++; continue; }
            observed.files.push(item);
          } catch { observed.omittedFiles++; }
        }
        const { campaignId: _campaign, ...delivery } = target;
        return copy({ source: { root: enrollment.host.root, campaignId, expectedDefinitionDigest: campaign.definitionDigest,
          expectedManifestDigest: campaign.manifestDigest, expectedComparatorDigest: campaign.comparatorDigest,
          delivery, expectedDeliveryDigest: hash(receipt) }, projectId: enrollment.projectId,
          commit: receipt.commit, objective: row.request.objective, context: canonical(observed) });
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
    prepare(input) {
      const prepared = registry.prepare(input, {
        beforeNew(id) {
          if (options.owner.catalog().some(row => row.id === id)) fail('CONFLICT', 'Objective identity is already in use');
          if (options.owner.catalog().length >= 32) fail('CONFLICT', 'Engineering enrollment capacity reached');
        },
        beforePublication: catalog => { options.owner.checkRegistration(catalog); },
      });
      const enrollment = options.owner.register(prepared.catalog).find(row =>
        row.id === prepared.plan.id && row.enrollmentDigest === prepared.enrollmentDigest);
      if (!enrollment) fail('UNAVAILABLE', 'Objective enrollment could not be confirmed');
      return copy({ plan: prepared.plan, enrollment, disposition: prepared.disposition });
    },
  };
}
