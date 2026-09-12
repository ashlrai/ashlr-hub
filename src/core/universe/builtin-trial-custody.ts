import { isAbsolute, join, resolve } from 'node:path';
import { types } from 'node:util';
import { canonical, digest } from './artifacts.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';

/** Execution custody only: these records never supply scores or selection evidence. */
export interface BuiltinTrialIntent {
  schemaVersion: 1;
  universeId: string;
  runId: string;
  trialId: string;
  startedAt: string;
  manifestDigest: string;
  comparatorDigest: string;
  evaluatorId: 'preparation-measurement-v1';
  evaluatorDigest: string;
  artifactPath: string;
  artifactDigest: string;
  scratchPath: string;
}
export interface BuiltinTrialCustodyRecord {
  id: string;
  kind: 'intent' | 'settlement';
  intent: BuiltinTrialIntent;
  settlement: null | { intentDigest: string; finishedAt: string; state: 'not-started' | 'group-exit-confirmed' };
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORDS = 4096;
const unavailable = (): Error => new Error('Built-in trial evaluator custody unavailable');
function own(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) throw unavailable();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function codec(directory: string): ImmutablePrivateRecordCodec<BuiltinTrialCustodyRecord> {
  return {
    parse(input) { try {
      const row = own(input, ['id', 'kind', 'intent', 'settlement']);
      const intent = own(row.intent, ['schemaVersion', 'universeId', 'runId', 'trialId', 'startedAt',
        'manifestDigest', 'comparatorDigest', 'evaluatorId', 'evaluatorDigest', 'artifactPath', 'artifactDigest', 'scratchPath']);
      if (intent.schemaVersion !== 1 || !matches(intent.universeId, /^[a-z0-9][a-z0-9_-]{0,63}$/) ||
        !matches(intent.runId, UUID) || !matches(intent.trialId, UUID) || !timestamp(intent.startedAt) ||
        !['manifestDigest', 'comparatorDigest', 'evaluatorDigest', 'artifactDigest'].every(key => matches(intent[key], HASH)) ||
        intent.evaluatorId !== 'preparation-measurement-v1' || join(directory, '..', intent.universeId) !== directory ||
        intent.artifactPath !== join(directory, 'artifacts', intent.runId, intent.trialId) ||
        intent.scratchPath !== join(directory, 'scratch', intent.runId, intent.trialId) ||
        typeof row.kind !== 'string' || !['intent', 'settlement'].includes(row.kind) || row.id !== `${intent.trialId}.${row.kind}`) return null;
      let settlement: BuiltinTrialCustodyRecord['settlement'] = null;
      if (row.kind === 'intent') { if (row.settlement !== null) return null; }
      else {
        const value = own(row.settlement, ['intentDigest', 'finishedAt', 'state']);
        if (value.intentDigest !== digest(canonical(intent)) || !timestamp(value.finishedAt) || value.finishedAt < intent.startedAt ||
          typeof value.state !== 'string' || !['not-started', 'group-exit-confirmed'].includes(value.state)) return null;
        settlement = value as unknown as NonNullable<BuiltinTrialCustodyRecord['settlement']>;
      }
      return { id: row.id as string, kind: row.kind as BuiltinTrialCustodyRecord['kind'],
        intent: intent as unknown as BuiltinTrialIntent, settlement };
    } catch { return null; } },
    serialize: value => `${canonical(value)}\n`, recordId: value => value.id, recordFileName: value => `${value.id}.json`,
    isRecordFileName: name => /^[a-f0-9-]{36}\.(intent|settlement)\.json$/.test(name),
    stageToken: value => digest(canonical(value)), equivalent: (a, b) => canonical(a) === canonical(b),
  };
}
function config(directory: string): ImmutablePrivateRecordStoreConfig<BuiltinTrialCustodyRecord> {
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory ||
    Buffer.byteLength(directory) > 4096 || [...directory].some(character => {
      const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
    })) throw unavailable();
  return { label: 'Built-in trial evaluator custody', anchorPath: directory, rootPath: join(directory, 'builtin-trial-custody'),
    lockFileName: '.records.lock', maxRecordBytes: 8192, defaultMaxFiles: MAX_RECORDS, hardMaxFiles: MAX_RECORDS,
    defaultMaxBytes: 32 * 1024 * 1024, hardMaxBytes: 32 * 1024 * 1024,
    codecForRead: () => codec(directory), codecForWrite: () => codec(directory) };
}
export function readBuiltinTrialCustody(directory: string): BuiltinTrialCustodyRecord[] {
  const result = readImmutablePrivateRecords(config(directory), { requireComplete: true });
  if (result.sourceState === 'missing' && !result.sourcePresent) return [];
  if (result.sourceState !== 'healthy' || !result.complete) throw unavailable();
  const intents = new Map(result.records.filter(row => row.kind === 'intent').map(row => [row.intent.trialId, row.intent]));
  for (const row of result.records) if (row.kind === 'settlement' &&
    canonical(intents.get(row.intent.trialId) ?? null) !== canonical(row.intent)) throw unavailable();
  return result.records;
}
export function assertBuiltinTrialEvaluatorsSettled(directory: string): void {
  const records = readBuiltinTrialCustody(directory);
  const settled = new Set(records.filter(row => row.kind === 'settlement').map(row => row.intent.trialId));
  if (records.some(row => row.kind === 'intent' && !settled.has(row.intent.trialId))) {
    throw new Error('Universe has an unresolved built-in trial evaluator; execution is held');
  }
}
export function writeBuiltinTrialCustody(directory: string, record: BuiltinTrialCustodyRecord, guard: () => void): void {
  const store = config(directory), captured = store.codecForWrite()!.parse(record);
  if (!captured || typeof guard !== 'function') throw unavailable();
  const rows = readBuiltinTrialCustody(directory);
  if (captured.kind === 'intent') {
    // Reserve the paired settlement before dispatch, including concurrent siblings.
    if (rows.some(row => row.intent.trialId === captured.intent.trialId) || rows.filter(row => row.kind === 'intent').length >= MAX_RECORDS / 2) throw unavailable();
    const reserved: BuiltinTrialCustodyRecord = { ...captured, kind: 'settlement', id: `${captured.intent.trialId}.settlement`,
      settlement: { intentDigest: digest(canonical(captured.intent)), finishedAt: '9999-12-31T23:59:59.999Z', state: 'group-exit-confirmed' } };
    if (Buffer.byteLength(store.codecForWrite()!.serialize(reserved)) > store.maxRecordBytes) throw unavailable();
  } else if (!rows.some(row => row.kind === 'intent' && canonical(row.intent) === canonical(captured.intent)) ||
    rows.some(row => row.id === captured.id)) throw unavailable();
  const disposition = writeImmutablePrivateRecord(store, captured, { prepublish: () => { guard(); return true; } });
  if (disposition !== 'recorded') throw unavailable();
}
