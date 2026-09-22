/** Read-only finite queue evidence. No owner, recovery, admission or clock renewal. */
import { lstatSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { readResourceJson } from './pool-runtime.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import type { ResourceConsoleEngineeringSupervisionConfig } from './console-engineering-supervisor-types.js';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ENGINEERING_SUPERVISION_STATE_MAX_BYTES = 128 * 1024;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' &&
  !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
function fail(code: ConstructorParameters<typeof ResourceSupervisorError>[0], message: string): never { throw new ResourceSupervisorError(code, message); }
function data<T>(value: unknown): T {
  const text = canonicalEvidencePackJsonV3(value);
  if (text === null || Buffer.byteLength(text) > ENGINEERING_SUPERVISION_STATE_MAX_BYTES) fail('INVALID_INPUT', 'Invalid engineering supervision data');
  return JSON.parse(text) as T;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateResourceConsoleEngineeringSupervisionConfig(value: unknown): ResourceConsoleEngineeringSupervisionConfig {
  const config = data<ResourceConsoleEngineeringSupervisionConfig>(value);
  const admission = config !== null && typeof config === 'object' && Object.hasOwn(config, 'maxEnrollments');
  const automatic = config !== null && typeof config === 'object' && Object.hasOwn(config, 'autoAdmitPrepared');
  if (!exact(config, ['schemaVersion', 'id', 'maxDurationMs', 'pollIntervalMs', 'maxConcurrent', 'maxAttemptsPerEnrollment', 'enrollments',
    ...(admission ? ['maxEnrollments'] : []), ...(automatic ? ['autoAdmitPrepared'] : [])]) ||
      config.schemaVersion !== 1 || typeof config.id !== 'string' || !ID.test(config.id) ||
      !integer(config.maxDurationMs, 1, 86_400_000) || !integer(config.pollIntervalMs, 100, 60_000) ||
      !integer(config.maxConcurrent, 1, 4) || !integer(config.maxAttemptsPerEnrollment, 1, 16) ||
      !Array.isArray(config.enrollments) || config.enrollments.length < (admission ? 0 : 1) || config.enrollments.length > 32 ||
      admission && (!integer(config.maxEnrollments, 1, 32) || config.maxEnrollments < config.enrollments.length) ||
      automatic && (!admission || config.autoAdmitPrepared !== true) ||
      config.enrollments.some(row => !exact(row, ['enrollmentId', 'expectedEnrollmentDigest']) ||
        typeof row.enrollmentId !== 'string' || !ID.test(row.enrollmentId) ||
        typeof row.expectedEnrollmentDigest !== 'string' || !HASH.test(row.expectedEnrollmentDigest)) ||
      new Set(config.enrollments.map(row => row.enrollmentId)).size !== config.enrollments.length) {
    fail('INVALID_INPUT', 'Invalid engineering supervision configuration');
  }
  return config;
}

export interface ResourceConsoleEngineeringSupervisionState {
  schemaVersion: 1; configDigest: string; createdAt: string; deadlineAt: string; writtenAt: string;
  paused: boolean; revision: number;
  entries: Array<{ enrollmentId: string; enrollmentDigest: string; attempts: number;
    lastEvidenceDigest: string | null; lastOutcome: 'attempting' | 'settled' | 'unavailable' | null }>;
}
export interface ResourceConsoleEngineeringSupervisionStateScope {
  config: ResourceConsoleEngineeringSupervisionConfig;
  /** Exact identity projection from independently verified registrations. */
  catalog: Array<{ id: string; enrollmentDigest: string }>;
}
function scope(input: ResourceConsoleEngineeringSupervisionStateScope): ResourceConsoleEngineeringSupervisionStateScope {
  const captured = data<ResourceConsoleEngineeringSupervisionStateScope>(input);
  if (!exact(captured, ['config', 'catalog'])) fail('INVALID_INPUT', 'Invalid engineering supervision state scope');
  const config = validateResourceConsoleEngineeringSupervisionConfig(captured.config);
  const catalog = captured.catalog;
  if (!Array.isArray(catalog) || catalog.length > 32 || catalog.some(row => !exact(row, ['id', 'enrollmentDigest']) ||
      typeof row.id !== 'string' || !ID.test(row.id) || typeof row.enrollmentDigest !== 'string' || !HASH.test(row.enrollmentDigest)) ||
      new Set(catalog.map(row => row.id)).size !== catalog.length) fail('INVALID_INPUT', 'Invalid engineering supervision state catalog');
  return { config, catalog };
}

export function validateResourceConsoleEngineeringSupervisionState(input: unknown,
  expected: ResourceConsoleEngineeringSupervisionStateScope): ResourceConsoleEngineeringSupervisionState {
  const { config, catalog } = scope(expected);
  const source = data<ResourceConsoleEngineeringSupervisionState>(input);
  if (!exact(source, ['schemaVersion', 'configDigest', 'createdAt', 'deadlineAt', 'writtenAt', 'paused', 'revision', 'entries']) ||
      source.schemaVersion !== 1 || source.configDigest !== digest(canonical(config)) || !timestamp(source.createdAt) || !timestamp(source.deadlineAt) ||
      !timestamp(source.writtenAt) || source.writtenAt < source.createdAt || Date.parse(source.deadlineAt) !== Date.parse(source.createdAt) + config.maxDurationMs ||
      typeof source.paused !== 'boolean' || !integer(source.revision, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(source.entries) ||
      source.entries.length < config.enrollments.length || source.entries.length > (config.maxEnrollments ?? config.enrollments.length) ||
      source.entries.some(row => !row || typeof row !== 'object') ||
      new Set(source.entries.map(row => row.enrollmentId)).size !== source.entries.length || source.entries.some((row, index) => {
        const expected = config.enrollments[index];
        return !exact(row, ['enrollmentId', 'enrollmentDigest', 'attempts', 'lastEvidenceDigest', 'lastOutcome']) ||
          typeof row.enrollmentId !== 'string' || !ID.test(row.enrollmentId) || typeof row.enrollmentDigest !== 'string' || !HASH.test(row.enrollmentDigest) ||
          expected !== undefined && (row.enrollmentId !== expected.enrollmentId || row.enrollmentDigest !== expected.expectedEnrollmentDigest) ||
          !catalog.some(value => value.id === row.enrollmentId && value.enrollmentDigest === row.enrollmentDigest) ||
          !integer(row.attempts, 0, config.maxAttemptsPerEnrollment) ||
          (row.lastEvidenceDigest !== null && (typeof row.lastEvidenceDigest !== 'string' || !HASH.test(row.lastEvidenceDigest))) ||
          ![null, 'attempting', 'settled', 'unavailable'].includes(row.lastOutcome) ||
          (row.attempts === 0 ? row.lastEvidenceDigest !== null || row.lastOutcome !== null : row.lastEvidenceDigest === null || row.lastOutcome === null);
      })) fail('CONFLICT', 'Engineering supervision configuration or state changed');
  return source;
}

/** Historical evidence only. An expired deadline is retained, never renewed.
 * Missing/unsafe state refuses; this function never enrolls an empty queue. */
export function readResourceConsoleEngineeringSupervisionState(input: ResourceConsoleEngineeringSupervisionStateScope & { root: string }): {
  state: ResourceConsoleEngineeringSupervisionState; stateDigest: string;
} {
  const captured = data<typeof input>(input);
  if (!exact(captured, ['root', 'config', 'catalog']) || typeof captured.root !== 'string' || captured.root.length > 4096 ||
      !isAbsolute(captured.root) || resolve(captured.root) !== captured.root || parse(captured.root).root === captured.root ||
      [...captured.root].some(char => { const code = char.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; })) {
    fail('INVALID_INPUT', 'Invalid engineering supervision scope');
  }
  const expected = scope({ config: captured.config, catalog: captured.catalog });
  const parent = join(captured.root, 'engineering-supervision'); const directory = join(parent, expected.config.id);
  try {
    const directories = [captured.root, parent, directory];
    const identities = directories.map(file => { inspectPrivateDirectory(file); return lstatSync(file, { bigint: true }); });
    const state = validateResourceConsoleEngineeringSupervisionState(readResourceJson(join(directory, 'state.json'), ENGINEERING_SUPERVISION_STATE_MAX_BYTES), expected);
    directories.forEach((file, index) => {
      inspectPrivateDirectory(file); const current = lstatSync(file, { bigint: true }); const before = identities[index]!;
      if (current.dev !== before.dev || current.ino !== before.ino || current.uid !== before.uid || current.mode !== before.mode) throw new Error();
    });
    return { state, stateDigest: digest(canonical(state)) };
  } catch { fail('UNAVAILABLE', 'Engineering supervision state unavailable'); }
}
