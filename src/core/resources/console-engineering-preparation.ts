/** Host-pinned objective preparation on the existing engineering owner. No execution or queue mutation. */
import { isAbsolute, join, parse, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { validateResourceGenerationRuntime } from '../universe/resource-generation.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { readResourceJson } from './pool-runtime.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import { validateResourceConsoleEngineeringCatalog, type ResourceConsoleEngineeringOwner } from './console-engineering.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle, readPreparedResourceEngineeringBundle } from './engineering-preparation.js';
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
}
function records(root: string): ImmutablePrivateRecordStoreConfig<Registration> {
  const decode = (value: unknown): Registration | null => {
    try {
      if (!exact(value, ['schemaVersion', 'configDigest', 'request', 'planDigest', 'bundlePlanDigest', 'enrollmentDigest']) || value.schemaVersion !== 1 ||
        ![value.configDigest, value.planDigest, value.bundlePlanDigest, value.enrollmentDigest].every(v => typeof v === 'string' && HASH.test(v))) return null;
      validateResourceConsoleEngineeringObjective(value.request); return value as unknown as Registration;
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
  function materialize(input: unknown) {
    currentConfig(); const request = validateResourceConsoleEngineeringObjective(input);
    const profile = config.profiles.find(row => row.id === request.profileId);
    if (!profile) fail('NOT_FOUND', 'Engineering preparation profile was not found');
    const recipe = { ...profile.recipe, id: request.id, name: request.name, objective: request.objective,
      delivery: { ...profile.recipe.delivery, branch: `codex/${request.id}` } };
    const bundleOptions = { recipe, output: join(config.outputRoot, request.id), resourceRuntime: config.resourceRuntime,
      workspace: options.workspace, projectsFile: options.projectsFile };
    const bundlePlan = checkResourceEngineeringPreparation(bundleOptions);
    const plan: ResourceConsoleEngineeringObjectivePlan = { schemaVersion: 1, status: 'planned', ...request,
      profileDigest: hash(profile), projectId: recipe.projectId, seedRevision: bundlePlan.seedRevision, branch: recipe.delivery.branch,
      acceptance: profile.acceptance, metric: recipe.metric, files: recipe.generation.files, contextFiles: recipe.generation.contextFiles,
      allowedWorkerIds: recipe.generation.allowedWorkerIds, trialBudget: recipe.trialBudget, campaignBudget: recipe.campaignBudget,
      planDigest: hash({ contextDigest, profileDigest: hash(profile), request, bundlePlanDigest: bundlePlan.planDigest }), executionStarted: false, providerContacted: false };
    return { request, plan, bundleOptions, bundlePlan };
  }
  function committed(row: Registration) {
    const candidate = materialize(row.request);
    if (candidate.plan.planDigest !== row.planDigest || candidate.bundlePlan.planDigest !== row.bundlePlanDigest) fail('CONFLICT', 'Prepared objective evidence changed');
    const report = readPreparedResourceEngineeringBundle({ ...candidate.bundleOptions, expectedPlanDigest: row.bundlePlanDigest });
    if (report.enrollmentDigest !== row.enrollmentDigest) fail('CONFLICT', 'Prepared objective enrollment changed');
    const catalog = validateResourceConsoleEngineeringCatalog(readResourceJson(report.paths.engineering));
    return { candidate, report, catalog };
  }
  // Validate all profiles without initializing output, contacting workers or reading credentials.
  for (const profile of config.profiles) materialize({ id: profile.recipe.id, profileId: profile.id, name: profile.recipe.name, objective: profile.recipe.objective });
  // Validate the whole durable set before exposing any reconstructed enrollment.
  const restored = registrations().map(committed);
  if (restored.length) options.owner.register({ schemaVersion: 1, enrollments: restored.flatMap(row => row.catalog.enrollments) });
  return {
    profiles(projectId) {
      if (typeof projectId !== 'string' || !ID.test(projectId)) fail('INVALID_INPUT', 'Expected a registered project ID');
      currentConfig();
      return copy(config.profiles.filter(row => row.recipe.projectId === projectId).map(row => ({ id: row.id, label: row.label,
        acceptance: row.acceptance, projectId, seedRevision: row.recipe.seedRevision, metric: row.recipe.metric,
        files: row.recipe.generation.files, contextFiles: row.recipe.generation.contextFiles, allowedWorkerIds: row.recipe.generation.allowedWorkerIds,
        trialBudget: row.recipe.trialBudget, campaignBudget: row.recipe.campaignBudget })));
    },
    check(input) {
      const candidate = materialize(input); const saved = registrations().find(row => row.request.id === candidate.request.id);
      if (saved && saved.planDigest !== candidate.plan.planDigest || !saved && options.owner.catalog().some(row => row.id === candidate.request.id)) fail('CONFLICT', 'Objective identity is already in use');
      if (saved) committed(saved);
      return copy(candidate.plan);
    },
    prepare(input) {
      const value = copy<Record<string, unknown>>(input);
      if (!exact(value, ['id', 'profileId', 'name', 'objective', 'expectedPlanDigest']) || typeof value.expectedPlanDigest !== 'string' || !HASH.test(value.expectedPlanDigest)) fail('INVALID_INPUT', 'Expected a checked objective digest');
      const { expectedPlanDigest, ...request } = value;
      const candidate = materialize(request);
      if (expectedPlanDigest !== candidate.plan.planDigest) fail('CONFLICT', 'Objective plan changed; check it again');
      const prior = registrations(); const existing = prior.find(row => row.request.id === candidate.request.id);
      if (existing && existing.planDigest !== expectedPlanDigest || !existing && options.owner.catalog().some(row => row.id === candidate.request.id)) fail('CONFLICT', 'Objective identity is already in use');
      if (!existing && (prior.length >= 32 || options.owner.catalog().length >= 32)) fail('CONFLICT', 'Engineering enrollment capacity reached');
      const report = existing ? committed(existing).report : prepareResourceEngineeringBundle({ ...candidate.bundleOptions, expectedPlanDigest: candidate.bundlePlan.planDigest });
      const registration: Registration = { schemaVersion: 1, configDigest: contextDigest, request: candidate.request, planDigest: expectedPlanDigest,
        bundlePlanDigest: candidate.bundlePlan.planDigest, enrollmentDigest: report.enrollmentDigest };
      const verified = committed(registration); currentConfig();
      options.owner.checkRegistration(verified.catalog);
      // Exact completed replay is read-only, including the record store's lock/staging.
      if (!existing) {
        const written = writeImmutablePrivateRecord(store, registration, { prepublish: () => {
          try { currentConfig(); options.owner.checkRegistration(committed(registration).catalog); return true; }
          catch { return false; }
        } });
        if (!['recorded', 'replayed'].includes(written)) fail('UNAVAILABLE', 'Objective registration incomplete; inspect retained output before retrying');
      }
      const registered = options.owner.register(verified.catalog);
      const enrollment = registered.find(row => row.id === candidate.request.id && row.enrollmentDigest === report.enrollmentDigest);
      if (!enrollment) fail('UNAVAILABLE', 'Objective enrollment could not be confirmed');
      return copy({ plan: candidate.plan, enrollment, disposition: existing ? 'replayed' : report.disposition });
    },
  };
}
