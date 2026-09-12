/** Shared owner-free objective registration. Execution owners supply additional live publication checks. */
import { isAbsolute, join, parse, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { validateResourceGenerationRuntime } from '../universe/resource-generation.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { readResourceJson } from './pool-runtime.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import { validateResourceConsoleEngineeringCatalog, type ResourceConsoleEngineeringCatalog } from './console-engineering.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle, readPreparedResourceEngineeringBundle, readPreparedResourceEngineeringMetadata } from './engineering-preparation.js';
import type { ResourceEngineeringPreparationPlan, ResourceEngineeringSuccessorSource } from './engineering-preparation-types.js';
import { readResourceEngineeringSuccessorBundle, readResourceEngineeringSuccessorMetadata } from './engineering-successor-preparation.js';
import { validateUniverseCampaignDeliverySource } from '../universe/campaign-handoff.js';
import type { ResourceConsoleEngineeringObjective, ResourceConsoleEngineeringObjectivePlan, ResourceConsoleEngineeringPreparationConfig } from './console-engineering-preparation-types.js';

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
export interface ResourceEngineeringPreparationRegistration {
  schemaVersion: 1; configDigest: string; request: ResourceConsoleEngineeringObjective;
  planDigest: string; bundlePlanDigest: string; enrollmentDigest: string;
  source?: ResourceEngineeringSuccessorSource;
  automaticAdmission?: ResourceEngineeringAutomaticAdmission;
}
export interface ResourceEngineeringAutomaticAdmission {
  schemaVersion: 1; supervisionId: string; configDigest: string; deadlineAt: string;
}
export interface ResourceEngineeringAutomaticAdmissionCandidate {
  enrollmentId: string; expectedEnrollmentDigest: string;
  reason: 'binding-changed' | 'evidence-unavailable' | 'verification-pending' | null;
}
export function validateResourceEngineeringAutomaticAdmission(input: unknown): ResourceEngineeringAutomaticAdmission {
  const value = copy<ResourceEngineeringAutomaticAdmission>(input);
  if (!exact(value, ['schemaVersion', 'supervisionId', 'configDigest', 'deadlineAt']) || value.schemaVersion !== 1 ||
      typeof value.supervisionId !== 'string' || !ID.test(value.supervisionId) || typeof value.configDigest !== 'string' || !HASH.test(value.configDigest) ||
      typeof value.deadlineAt !== 'string' || !Number.isFinite(Date.parse(value.deadlineAt)) || new Date(value.deadlineAt).toISOString() !== value.deadlineAt) {
    fail('INVALID_INPUT', 'Invalid automatic admission binding');
  }
  return value;
}
function decodeRegistration(value: unknown): ResourceEngineeringPreparationRegistration | null {
    try {
      if (!exact(value, ['schemaVersion', 'configDigest', 'request', 'planDigest', 'bundlePlanDigest', 'enrollmentDigest',
        ...(Object.hasOwn(value ?? {}, 'source') ? ['source'] : []), ...(Object.hasOwn(value ?? {}, 'automaticAdmission') ? ['automaticAdmission'] : [])]) || value.schemaVersion !== 1 ||
        ![value.configDigest, value.planDigest, value.bundlePlanDigest, value.enrollmentDigest].every(v => typeof v === 'string' && HASH.test(v))) return null;
      validateResourceConsoleEngineeringObjective(value.request);
      if (Object.hasOwn(value, 'source')) validateUniverseCampaignDeliverySource(value.source);
      if (Object.hasOwn(value, 'automaticAdmission')) {
        if (Object.hasOwn(value, 'source')) return null;
        validateResourceEngineeringAutomaticAdmission(value.automaticAdmission);
      }
      return value as unknown as ResourceEngineeringPreparationRegistration;
    } catch { return null; }
}
function records(root: string): ImmutablePrivateRecordStoreConfig<ResourceEngineeringPreparationRegistration> {
  const codec = { parse: decodeRegistration, serialize: (value: ResourceEngineeringPreparationRegistration) => canonical(value) + '\n', recordId: (value: ResourceEngineeringPreparationRegistration) => value.request.id,
    recordFileName: (value: ResourceEngineeringPreparationRegistration) => `${value.request.id}.json`, isRecordFileName: (name: string) => /^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name),
    stageToken: hash, equivalent: (a: ResourceEngineeringPreparationRegistration, b: ResourceEngineeringPreparationRegistration) => canonical(a) === canonical(b) };
  return { label: 'Engineering objective registration', anchorPath: root, rootPath: join(root, 'console-engineering-preparations'),
    lockFileName: '.records.lock', maxRecordBytes: 16 * 1024, defaultMaxFiles: 32, hardMaxFiles: 32,
    defaultMaxBytes: 512 * 1024, hardMaxBytes: 512 * 1024, codecForRead: () => codec, codecForWrite: () => codec };
}
export function readResourceEngineeringPreparationRegistrations(root: string): ResourceEngineeringPreparationRegistration[] {
  const result = readImmutablePrivateRecords(records(root), { requireComplete: true });
  if (result.sourceState === 'degraded' || result.sourceState !== 'missing' && !result.complete) fail('UNAVAILABLE', 'Objective registration history is unavailable');
  return result.records;
}
export function createResourceEngineeringPreparationRegistry(input: {
  configFile: string; config: ResourceConsoleEngineeringPreparationConfig; root: string; workspace: string; projectsFile: string;
  poolFile: string; bindingsFile: string; observationsFile: string; quotaConfigFile?: string;
}) {
  // Capture caller-owned options without invoking accessors. Later mutation must
  // not redirect a checked objective away from its pinned console context.
  const required = ['configFile', 'config', 'root', 'workspace', 'projectsFile', 'poolFile', 'bindingsFile', 'observationsFile'];
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
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(config);
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
    const rows = readResourceEngineeringPreparationRegistrations(options.root);
    if (rows.some(row => row.configDigest !== contextDigest)) fail('CONFLICT', 'Objective registration context changed');
    return rows;
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
  function committed(row: ResourceEngineeringPreparationRegistration, input: unknown = row.request, metadataOnly = false) {
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
  function publish(registration: ResourceEngineeringPreparationRegistration, beforePublication: (catalog: ResourceConsoleEngineeringCatalog) => void) {
    const captured = copy<ResourceEngineeringPreparationRegistration>(registration);
    if (!decodeRegistration(captured) || captured.configDigest !== contextDigest) fail('CONFLICT', 'Objective registration context changed');
    const verified = committed(captured); currentConfig(); beforePublication(verified.catalog);
    const written = writeImmutablePrivateRecord(store, captured, { prepublish: () => {
      // Each writer boundary still reconstructs the entire bundle proof and
      // invokes the live owner's check. Only unused commissioning diagnostics
      // and command suggestions are omitted; the initial returned report stays
      // unchanged. No proof survives from one publication boundary to the next.
      try { currentConfig(); beforePublication(committed(captured, captured.request, true).catalog); return true; } catch { return false; }
    } });
    if (!['recorded', 'replayed'].includes(written)) fail('UNAVAILABLE', 'Objective registration incomplete; inspect retained output before retrying');
    return verified;
  }
  return { config, contextDigest, currentConfig, registrations, objective, planned, materialize, successorOptions, committed, publish,
    prepare(input: unknown, guards: { beforeNew(id: string, priorCount: number): void; beforePublication(catalog: ResourceConsoleEngineeringCatalog): void }, automaticAdmission?: ResourceEngineeringAutomaticAdmission) {
      const admission = automaticAdmission === undefined ? undefined : validateResourceEngineeringAutomaticAdmission(automaticAdmission);
      const value = copy<Record<string, unknown>>(input);
      if (!exact(value, ['id', 'profileId', 'name', 'objective', 'expectedPlanDigest']) || typeof value.expectedPlanDigest !== 'string' || !HASH.test(value.expectedPlanDigest)) fail('INVALID_INPUT', 'Expected a checked objective digest');
      const { expectedPlanDigest, ...request } = value;
      const incoming = validateResourceConsoleEngineeringObjective(request);
      const prior = registrations(); const existing = prior.find(row => row.request.id === incoming.id);
      if (existing) {
        if (admission && existing.automaticAdmission && canonical(admission) !== canonical(existing.automaticAdmission)) fail('CONFLICT', 'Automatic admission belongs to another supervision budget');
        // The bundle reader still performs both fresh pin captures and receipt
        // verification. Do not cache this result across calls or publication gates.
        const verified = committed(existing, incoming);
        if (expectedPlanDigest !== verified.candidate.plan.planDigest) fail('CONFLICT', 'Objective plan changed; check it again');
        currentConfig(); guards.beforePublication(verified.catalog);
        return { plan: verified.candidate.plan, catalog: verified.catalog, enrollmentDigest: verified.report.enrollmentDigest, disposition: 'replayed' as const };
      }
      const candidate = materialize(incoming);
      if (expectedPlanDigest !== candidate.plan.planDigest) fail('CONFLICT', 'Objective plan changed; check it again');
      if (prior.length >= 32) fail('CONFLICT', 'Engineering enrollment capacity reached');
      guards.beforeNew(candidate.request.id, prior.length);
      const report = prepareResourceEngineeringBundle({ ...candidate.bundleOptions, expectedPlanDigest: candidate.bundlePlan.planDigest });
      const registration: ResourceEngineeringPreparationRegistration = { schemaVersion: 1, configDigest: contextDigest, request: candidate.request, planDigest: expectedPlanDigest,
        bundlePlanDigest: candidate.bundlePlan.planDigest, enrollmentDigest: report.enrollmentDigest,
        ...(admission ? { automaticAdmission: admission } : {}) };
      const verified = publish(registration, guards.beforePublication);
      return { plan: candidate.plan, catalog: verified.catalog, enrollmentDigest: report.enrollmentDigest, disposition: report.disposition };
    },
  };
}
