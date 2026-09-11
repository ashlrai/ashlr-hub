/** Host-pinned objective preparation on the existing engineering owner. No execution or queue mutation. */
import { isAbsolute, join, parse, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, inspectPrivateDirectory, readArtifactSnapshot } from '../universe/artifacts.js';
import { validateResourceGenerationRuntime } from '../universe/resource-generation.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { decodeUtf8Excerpt } from '../util/utf8-excerpt.js';
import { readResourceJson } from './pool-runtime.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import { validateResourceConsoleEngineeringCatalog, type ResourceConsoleEngineeringOwner } from './console-engineering.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle, readPreparedResourceEngineeringBundle, readPreparedResourceEngineeringMetadata } from './engineering-preparation.js';
import type { ResourceEngineeringPreparationPlan } from './engineering-preparation-types.js';
import type { ResourceEngineeringSuccessorSource } from './engineering-preparation-types.js';
import { checkResourceEngineeringSuccessorPreparation, prepareResourceEngineeringSuccessorBundle, readResourceEngineeringSuccessorBundle, readResourceEngineeringSuccessorMetadata } from './engineering-successor-preparation.js';
import { campaignUniverse, readUniverseCampaign } from '../universe/campaign-store.js';
import { readCompletedCampaignDelivery } from '../universe/campaign-delivery-recovery.js';
import { validateUniverseCampaignDeliverySource } from '../universe/campaign-handoff.js';
import type { ResourceConsoleEngineeringObjective, ResourceConsoleEngineeringObjectivePlan, ResourceConsoleEngineeringObjectivePrepared,
  ResourceConsoleEngineeringPreparationConfig, ResourceConsoleEngineeringProfile } from './console-engineering-preparation-types.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/; const HASH = /^[a-f0-9]{64}$/;
function fail(code: ConstructorParameters<typeof ResourceSupervisorError>[0], message: string): never { throw new ResourceSupervisorError(code, message); }
function copy<T>(input: unknown): T {
  const text = canonicalEvidencePackJsonV3(input);
  if (text === null || Buffer.byteLength(text) > 1024 * 1024) fail('INVALID_INPUT', 'Invalid engineering preparation data');
  return JSON.parse(text) as T;
}
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max &&
  [...value].every(character => { const code = character.charCodeAt(0); return code === 9 || code === 10 || code === 13 || code >= 32 && code < 127 || code >= 160; });
const path = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && value === resolve(value) &&
  value !== parse(value).root && Buffer.byteLength(value) <= 4096 && [...value].every(character => {
    const code = character.charCodeAt(0); return code >= 32 && !(code >= 127 && code <= 159);
  });
const hash = (value: unknown) => digest(canonical(value));

export function validateResourceConsoleEngineeringPreparationConfig(input: unknown): ResourceConsoleEngineeringPreparationConfig {
  const config = copy<ResourceConsoleEngineeringPreparationConfig>(input);
  if (!exact(config, ['schemaVersion', 'outputRoot', 'resourceRuntime', 'profiles']) || config.schemaVersion !== 1 ||
    !path(config.outputRoot) || !path(config.resourceRuntime) || !Array.isArray(config.profiles) ||
    config.profiles.length < 1 || config.profiles.length > 16 || config.profiles.some(row =>
      !exact(row, ['id', 'label', 'acceptance', 'recipe']) || typeof row.id !== 'string' || !ID.test(row.id) ||
      !text(row.label, 120) || !text(row.acceptance, 1024) || !row.recipe || typeof row.recipe !== 'object' ||
      typeof row.recipe.seedRevision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.recipe.seedRevision)) ||
    new Set(config.profiles.map(row => row.id)).size !== config.profiles.length) fail('INVALID_INPUT', 'Invalid engineering preparation profiles');
  return config;
}
export function validateResourceConsoleEngineeringObjective(input: unknown): ResourceConsoleEngineeringObjective {
  const request = copy<ResourceConsoleEngineeringObjective>(input);
  if (!exact(request, ['id', 'profileId', 'name', 'objective']) || ![request.id, request.profileId].every(value => typeof value === 'string' && ID.test(value)) ||
    !text(request.name, 120) || !text(request.objective, 4000)) fail('INVALID_INPUT', 'Expected a profile, unique objective ID, name and bounded objective');
  return request;
}
interface Registration {
  schemaVersion: 1; configDigest: string; request: ResourceConsoleEngineeringObjective;
  planDigest: string; bundlePlanDigest: string; enrollmentDigest: string;
  source?: ResourceEngineeringSuccessorSource;
}
function records(root: string): ImmutablePrivateRecordStoreConfig<Registration> {
  const decode = (value: unknown): Registration | null => {
    try {
      if (!exact(value, ['schemaVersion', 'configDigest', 'request', 'planDigest', 'bundlePlanDigest', 'enrollmentDigest',
        ...(Object.hasOwn(value ?? {}, 'source') ? ['source'] : [])]) || value.schemaVersion !== 1 ||
        ![value.configDigest, value.planDigest, value.bundlePlanDigest, value.enrollmentDigest].every(v => typeof v === 'string' && HASH.test(v))) return null;
      validateResourceConsoleEngineeringObjective(value.request);
      if (Object.hasOwn(value, 'source')) validateUniverseCampaignDeliverySource(value.source);
      return value as unknown as Registration;
    } catch { return null; }
  };
  const codec = { parse: decode, serialize: (value: Registration) => canonical(value) + '\n', recordId: (value: Registration) => value.request.id,
    recordFileName: (value: Registration) => `${value.request.id}.json`, isRecordFileName: (name: string) => /^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name),
    stageToken: hash, equivalent: (a: Registration, b: Registration) => canonical(a) === canonical(b) };
  return { label: 'Engineering objective registration', anchorPath: root, rootPath: join(root, 'console-engineering-preparations'),
    lockFileName: '.records.lock', maxRecordBytes: 16 * 1024, defaultMaxFiles: 32, hardMaxFiles: 32,
    defaultMaxBytes: 512 * 1024, hardMaxBytes: 512 * 1024, codecForRead: () => codec, codecForWrite: () => codec };
}
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
  for (const key of ['configFile', 'root', 'workspace', 'projectsFile', 'poolFile', 'bindingsFile', 'observationsFile'] as const) {
    if (!path(options[key])) fail('INVALID_INPUT', 'Invalid engineering preparation path');
  }
  if (options.quotaConfigFile !== undefined && !path(options.quotaConfigFile)) fail('INVALID_INPUT', 'Invalid engineering preparation path');
  const config = validateResourceConsoleEngineeringPreparationConfig(options.config);
  const configDigest = hash(config); const store = records(options.root);
  const contextDigest = hash({ outputRoot: config.outputRoot, resourceRuntime: config.resourceRuntime, root: options.root,
    workspace: options.workspace, projectsFile: options.projectsFile, poolFile: options.poolFile, bindingsFile: options.bindingsFile,
    observationsFile: options.observationsFile, quotaConfigFile: options.quotaConfigFile ?? null });
  inspectPrivateDirectory(config.outputRoot);
  const runtime = validateResourceGenerationRuntime(readResourceJson(config.resourceRuntime));
  if (runtime.root !== options.root || runtime.poolPath !== options.poolFile || runtime.bindingsPath !== options.bindingsFile ||
    runtime.observationsPath !== options.observationsFile || runtime.quotaConfigPath !== options.quotaConfigFile) fail('CONFLICT', 'Preparation must use this console resource ledger');
  function currentConfig() {
    if (hash(validateResourceConsoleEngineeringPreparationConfig(readResourceJson(options.configFile))) !== configDigest) fail('CONFLICT', 'Preparation profiles changed; restart with reviewed configuration');
  }
  function registrations() {
    const result = readImmutablePrivateRecords(store, { requireComplete: true });
    if (result.sourceState === 'degraded' || result.sourceState !== 'missing' && !result.complete) fail('UNAVAILABLE', 'Objective registration history is unavailable');
    if (result.records.some(row => row.configDigest !== contextDigest)) fail('CONFLICT', 'Objective registration context changed');
    return result.records;
  }
  function objective(input: unknown) {
    currentConfig(); const request = validateResourceConsoleEngineeringObjective(input);
    const profile = config.profiles.find(row => row.id === request.profileId);
    if (!profile) fail('NOT_FOUND', 'Engineering preparation profile was not found');
    const recipe = { ...profile.recipe, id: request.id, name: request.name, objective: request.objective,
      delivery: { ...profile.recipe.delivery, branch: `codex/${request.id}` } };
    const bundleOptions = { recipe, output: join(config.outputRoot, request.id), resourceRuntime: config.resourceRuntime,
      workspace: options.workspace, projectsFile: options.projectsFile };
    return { request, profile, recipe, bundleOptions };
  }
  function planned(candidate: ReturnType<typeof objective>, bundlePlan: Pick<ResourceEngineeringPreparationPlan, 'planDigest' | 'seedRevision'>) {
    const { request, profile, recipe, bundleOptions } = candidate;
    const plan: ResourceConsoleEngineeringObjectivePlan = { schemaVersion: 1, status: 'planned', ...request,
      profileDigest: hash(profile), projectId: recipe.projectId, seedRevision: bundlePlan.seedRevision, branch: recipe.delivery.branch,
      acceptance: profile.acceptance, metric: recipe.metric, files: recipe.generation.files, contextFiles: recipe.generation.contextFiles,
      allowedWorkerIds: recipe.generation.allowedWorkerIds, trialBudget: recipe.trialBudget, campaignBudget: recipe.campaignBudget,
      planDigest: hash({ contextDigest, profileDigest: hash(profile), request, bundlePlanDigest: bundlePlan.planDigest }), executionStarted: false, providerContacted: false };
    return { request, plan, bundleOptions, bundlePlan };
  }
  function materialize(input: unknown) {
    const candidate = objective(input);
    return planned(candidate, checkResourceEngineeringPreparation(candidate.bundleOptions));
  }
  function successorOptions(candidate: ReturnType<typeof objective>, source: ResourceEngineeringSuccessorSource) {
    const { seedRevision: _seed, ...recipe } = candidate.recipe;
    return { ...candidate.bundleOptions, recipe, source };
  }
  function committed(row: Registration, input: unknown = row.request, metadataOnly = false) {
    const source = objective(input);
    // Reuse only this call's verified bundle, never substitute a saved objective
    // for a different incoming request that happens to reuse its ID or digest.
    if (canonical(source.request) !== canonical(row.request)) fail('CONFLICT', 'Objective identity is already in use');
    // Source proof needs verified plan/enrollment metadata, not a separately
    // constructed commissioning report. Both readers retain the same fresh
    // captures, receipt checks and final source guard; public replay is unchanged.
    const report = row.source
      ? (metadataOnly ? readResourceEngineeringSuccessorMetadata : readResourceEngineeringSuccessorBundle)(
        { ...successorOptions(source, row.source), expectedPlanDigest: row.bundlePlanDigest })
      : (metadataOnly ? readPreparedResourceEngineeringMetadata : readPreparedResourceEngineeringBundle)(
        { ...source.bundleOptions, expectedPlanDigest: row.bundlePlanDigest });
    const candidate = planned(source, report);
    if (candidate.plan.planDigest !== row.planDigest || candidate.bundlePlan.planDigest !== row.bundlePlanDigest) fail('CONFLICT', 'Prepared objective evidence changed');
    if (report.enrollmentDigest !== row.enrollmentDigest) fail('CONFLICT', 'Prepared objective enrollment changed');
    const catalog = validateResourceConsoleEngineeringCatalog(readResourceJson(report.paths.engineering));
    return { candidate, report, catalog };
  }
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
      const registration: Registration = { schemaVersion: 1, configDigest: contextDigest, request: plan.request,
        planDigest: plan.plan.planDigest, bundlePlanDigest: report.planDigest, enrollmentDigest: report.enrollmentDigest, source };
      const verified = committed(registration); currentConfig(); options.owner.checkRegistration(verified.catalog);
      const written = writeImmutablePrivateRecord(store, registration, { prepublish: () => {
        try { currentConfig(); options.owner.checkRegistration(committed(registration).catalog); return true; } catch { return false; }
      } });
      if (!['recorded', 'replayed'].includes(written)) fail('UNAVAILABLE', 'Successor registration incomplete; inspect retained output');
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
      const value = copy<Record<string, unknown>>(input);
      if (!exact(value, ['id', 'profileId', 'name', 'objective', 'expectedPlanDigest']) || typeof value.expectedPlanDigest !== 'string' || !HASH.test(value.expectedPlanDigest)) fail('INVALID_INPUT', 'Expected a checked objective digest');
      const { expectedPlanDigest, ...request } = value;
      const incoming = validateResourceConsoleEngineeringObjective(request);
      const prior = registrations(); const existing = prior.find(row => row.request.id === incoming.id);
      if (existing) {
        // The bundle reader still performs both fresh pin captures and receipt
        // verification. Do not cache this result across calls or publication gates.
        const verified = committed(existing, incoming);
        if (expectedPlanDigest !== verified.candidate.plan.planDigest) fail('CONFLICT', 'Objective plan changed; check it again');
        currentConfig(); options.owner.checkRegistration(verified.catalog);
        const registered = options.owner.register(verified.catalog);
        const enrollment = registered.find(row => row.id === incoming.id && row.enrollmentDigest === verified.report.enrollmentDigest);
        if (!enrollment) fail('UNAVAILABLE', 'Objective enrollment could not be confirmed');
        return copy({ plan: verified.candidate.plan, enrollment, disposition: 'replayed' });
      }
      const candidate = materialize(incoming);
      if (expectedPlanDigest !== candidate.plan.planDigest) fail('CONFLICT', 'Objective plan changed; check it again');
      if (options.owner.catalog().some(row => row.id === candidate.request.id)) fail('CONFLICT', 'Objective identity is already in use');
      if (prior.length >= 32 || options.owner.catalog().length >= 32) fail('CONFLICT', 'Engineering enrollment capacity reached');
      const report = prepareResourceEngineeringBundle({ ...candidate.bundleOptions, expectedPlanDigest: candidate.bundlePlan.planDigest });
      const registration: Registration = { schemaVersion: 1, configDigest: contextDigest, request: candidate.request, planDigest: expectedPlanDigest,
        bundlePlanDigest: candidate.bundlePlan.planDigest, enrollmentDigest: report.enrollmentDigest };
      const verified = committed(registration); currentConfig();
      options.owner.checkRegistration(verified.catalog);
      const written = writeImmutablePrivateRecord(store, registration, { prepublish: () => {
        try { currentConfig(); options.owner.checkRegistration(committed(registration).catalog); return true; }
        catch { return false; }
      } });
      if (!['recorded', 'replayed'].includes(written)) fail('UNAVAILABLE', 'Objective registration incomplete; inspect retained output before retrying');
      const registered = options.owner.register(verified.catalog);
      const enrollment = registered.find(row => row.id === candidate.request.id && row.enrollmentDigest === report.enrollmentDigest);
      if (!enrollment) fail('UNAVAILABLE', 'Objective enrollment could not be confirmed');
      return copy({ plan: candidate.plan, enrollment, disposition: report.disposition });
    },
  };
}
