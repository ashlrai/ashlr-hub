/** Durable mission decisions. Local records are evidence, never provider or delivery authority. */
import { isAbsolute, join, parse, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest } from '../universe/artifacts.js';
import { readImmutablePrivateRecords, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import type { ResourceEngineeringAutonomousSetupOptions } from './engineering-autonomous-setup.js';
import { validateResourceTask } from './pool-runtime.js';
import { parseResourceEngineeringSuccessorProposal } from './engineering-successor-store.js';
import { readEngineeringMissionInvocations } from './engineering-mission-invocations.js';
import { MISSION_MEASURED_FEEDBACK } from './engineering-mission-feedback.js';

export interface ResourceEngineeringMissionConfig {
  schemaVersion: 1; id: string;
  /** Existing private directory outside the project and resource ledger. */
  root: string;
  initial: { setup: ResourceEngineeringAutonomousSetupOptions; expectedPlanDigest: string };
  /** Original absolute deadline; restarts cannot renew it. */
  deadlineAt: string;
  /** Includes the initial scope, not additional scopes after it. */
  maxScopes: number;
  pollIntervalMs: number;
  /** Opt-in for NEW mission identities; omission preserves legacy proposal bytes. */
  proposalFeedback?: typeof MISSION_MEASURED_FEEDBACK;
}
export const missionHash = (value: unknown): string => digest(canonical(value));
export function missionData<T>(input: unknown): T {
  const text = canonicalEvidencePackJsonV3(input);
  if (text === null || Buffer.byteLength(text) > 512 * 1024) throw new Error('Invalid mission data');
  return JSON.parse(text) as T;
}
export function missionExact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const HASH = /^[a-f0-9]{64}$/;
export function validateResourceEngineeringMissionConfig(input: unknown): ResourceEngineeringMissionConfig {
  const config = missionData<ResourceEngineeringMissionConfig>(input);
  if (!missionExact(config, ['schemaVersion', 'id', 'root', 'initial', 'deadlineAt', 'maxScopes', 'pollIntervalMs',
    ...(Object.hasOwn(config ?? {}, 'proposalFeedback') ? ['proposalFeedback'] : [])]) ||
      Object.hasOwn(config ?? {}, 'proposalFeedback') && config.proposalFeedback !== MISSION_MEASURED_FEEDBACK ||
      config.schemaVersion !== 1 || typeof config.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.id) ||
      typeof config.root !== 'string' || !isAbsolute(config.root) || resolve(config.root) !== config.root || parse(config.root).root === config.root ||
      !missionExact(config.initial, ['setup', 'expectedPlanDigest']) || typeof config.initial.expectedPlanDigest !== 'string' || !HASH.test(config.initial.expectedPlanDigest) ||
      !missionExact(config.initial.setup, ['recipe', 'policy', 'output', 'resourceRuntime', 'workspace', 'projectsFile']) ||
      typeof config.deadlineAt !== 'string' || !Number.isFinite(Date.parse(config.deadlineAt)) || new Date(config.deadlineAt).toISOString() !== config.deadlineAt ||
      !Number.isSafeInteger(config.maxScopes) || config.maxScopes < 1 || config.maxScopes > 64 ||
      !Number.isSafeInteger(config.pollIntervalMs) || config.pollIntervalMs < 100 || config.pollIntervalMs > 60_000) throw new Error('Invalid mission configuration');
  return config;
}
export type MissionRecordKind = 'definition' | 'reserved' | 'prepared' | 'running' | 'settled' | 'proposal' | 'result' | 'finished';
export interface MissionRecord { id: string; kind: MissionRecordKind; index: number; payload: unknown }
const KINDS: MissionRecordKind[] = ['definition', 'reserved', 'prepared', 'running', 'settled', 'proposal', 'result', 'finished'];
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const isDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
function validPayload(kind: MissionRecordKind, value: unknown): boolean {
  switch (kind) {
    case 'definition': return missionExact(value, ['configDigest']) && isHash(value.configDigest);
    case 'reserved': return missionExact(value, ['setup']) && missionExact(value.setup,
      ['recipe', 'policy', 'output', 'resourceRuntime', 'workspace', 'projectsFile']);
    case 'prepared': return missionExact(value, ['planDigest']) && isHash(value.planDigest);
    case 'running': return missionExact(value, ['deadlineAt']) && isDate(value.deadlineAt);
    case 'proposal': {
      if (!missionExact(value, ['task', 'poolDigest']) || !isHash(value.poolDigest)) return false;
      const task = validateResourceTask(value.task);
      return task.mode === 'read-only' && canonical(task) === canonical(value.task);
    }
    case 'result':
      if (!missionExact(value, ['output', 'receiptDigest']) || !nonempty(value.output) || !isHash(value.receiptDigest)) return false;
      parseResourceEngineeringSuccessorProposal(value.output); return true;
    case 'finished': return missionExact(value, ['reason']) && ['stop-requested', 'scope-limit'].includes(value.reason as string);
    case 'settled': return missionExact(value, ['schemaVersion', 'scope', 'status', 'reasons', 'sampledAt',
      'executionAuthorized', 'effectsExecuted', 'providerContacted', 'evidenceDigest', 'tip', 'continuation']) &&
      value.schemaVersion === 1 && value.scope === 'predecessor-completion-evidence-only' && value.status === 'verified' &&
      Array.isArray(value.reasons) && value.reasons.length === 0 && isDate(value.sampledAt) &&
      value.executionAuthorized === false && value.effectsExecuted === false && value.providerContacted === false &&
      isHash(value.evidenceDigest) && ['eligible', 'stop-requested'].includes(value.continuation as string) &&
      missionExact(value.tip, ['enrollmentId', 'enrollmentDigest', 'projectId', 'commit']) &&
      identifier(value.tip.enrollmentId) && isHash(value.tip.enrollmentDigest) && identifier(value.tip.projectId) &&
      typeof value.tip.commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.tip.commit);
  }
}
export function missionRecord(kind: MissionRecordKind, index: number, payload: unknown): MissionRecord {
  return { id: `${String(index).padStart(3, '0')}-${kind}`, kind, index, payload: missionData(payload) };
}
function decode(input: unknown): MissionRecord | null {
  try {
    const row = missionData<MissionRecord>(input);
    if (!missionExact(row, ['id', 'kind', 'index', 'payload']) || !KINDS.includes(row.kind) ||
      !Number.isSafeInteger(row.index) || row.index < 0 || row.index > 64 ||
      (row.kind === 'definition') !== (row.index === 0) || row.id !== `${String(row.index).padStart(3, '0')}-${row.kind}` ||
      !validPayload(row.kind, row.payload)) return null;
    return row;
  } catch { return null; }
}
export function engineeringMissionRecordStore(root: string): ImmutablePrivateRecordStoreConfig<MissionRecord> {
  const codec = { parse: decode, serialize: (row: MissionRecord) => canonical(row) + '\n',
    recordId: (row: MissionRecord) => row.id, recordFileName: (row: MissionRecord) => row.id + '.json',
    isRecordFileName: (name: string) => /^\d{3}-(definition|reserved|prepared|running|settled|proposal|result|finished)\.json$/.test(name),
    stageToken: missionHash, equivalent: (a: MissionRecord, b: MissionRecord) => canonical(a) === canonical(b) };
  return { label: 'Engineering mission', anchorPath: root, rootPath: join(root, 'mission-events'), lockFileName: '.records.lock',
    maxRecordBytes: 512 * 1024, defaultMaxFiles: 449, hardMaxFiles: 449, defaultMaxBytes: 32 * 1024 * 1024, hardMaxBytes: 32 * 1024 * 1024,
    codecForRead: () => codec, codecForWrite: () => codec };
}
export function readEngineeringMissionRecords(config: ResourceEngineeringMissionConfig, allowMissing = false): MissionRecord[] {
  const read = readImmutablePrivateRecords(engineeringMissionRecordStore(config.root), { requireComplete: true });
  if (read.sourceState === 'missing' && allowMissing) return [];
  if (read.sourceState !== 'healthy' || !read.complete) throw new Error('Mission history unavailable');
  const rows = read.records;
  const definition = rows.find(row => row.kind === 'definition');
  if (canonical(definition) !== canonical(missionRecord('definition', 0, { configDigest: missionHash(config) }))) throw new Error('Mission definition changed');
  const reserved = rows.filter(row => row.kind === 'reserved').sort((a, b) => a.index - b.index);
  if (reserved.length > config.maxScopes || reserved.some((row, i) => row.index !== i + 1)) throw new Error('Mission scope reservations changed');
  for (const row of rows) {
    if (row.kind === 'definition') continue;
    if (!reserved.some(scope => scope.index === row.index)) throw new Error('Unreserved mission work');
    const has = (kind: MissionRecordKind, index = row.index) => rows.some(item => item.kind === kind && item.index === index);
    if (row.kind === 'reserved' && row.index > 1 && (!has('settled', row.index - 1) || !has('result', row.index - 1)) ||
        ['running', 'settled', 'proposal', 'result', 'finished'].includes(row.kind) && !has('prepared') ||
        ['settled', 'proposal', 'result', 'finished'].includes(row.kind) && !has('running') ||
        ['proposal', 'result', 'finished'].includes(row.kind) && !has('settled') || row.kind === 'result' && !has('proposal')) throw new Error('Mission history is incomplete');
  }
  const finished = rows.filter(row => row.kind === 'finished');
  if (finished.length > 1 || finished.some(row => reserved.some(scope => scope.index > row.index))) throw new Error('Work follows a terminal mission');
  return rows;
}

/** Journal projection, not a fresh delivery proof or a claim that an owner is alive. */
export function readResourceEngineeringMissionStatus(input: unknown, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('Invalid mission observation time');
  const config = validateResourceEngineeringMissionConfig(input);
  const rows = readEngineeringMissionRecords(config, true);
  const scopes = rows.filter(row => row.kind === 'reserved');
  const index = scopes.length;
  const order: MissionRecordKind[] = ['finished', 'result', 'proposal', 'settled', 'running', 'prepared', 'reserved'];
  const latest = order.find(kind => rows.some(row => row.index === index && row.kind === kind)) ?? 'not-started';
  const settled = rows.filter(row => row.kind === 'settled').sort((a, b) => a.index - b.index);
  const last = settled.at(-1)?.payload as { tip: { enrollmentId: string; enrollmentDigest: string; projectId: string; commit: string } } | undefined;
  const finished = rows.find(row => row.kind === 'finished')?.payload as { reason: string } | undefined;
  return { schemaVersion: 1, scope: 'recorded-mission-evidence-only', missionId: config.id, configDigest: missionHash(config),
    sampledAt: new Date(now).toISOString(), recordedPhase: latest, scopesReserved: scopes.length, scopesSettled: settled.length,
    maxScopes: config.maxScopes, deadlineAt: config.deadlineAt, remainingMs: Math.max(0, Date.parse(config.deadlineAt) - now),
    recordedCompletion: finished?.reason ?? null, recordedTip: last?.tip ?? null,
    invocations: readEngineeringMissionInvocations(config),
    ownerState: 'not-observed', deliveryState: 'not-revalidated', executionAuthorized: false, effectsExecuted: false, providerContacted: false };
}
