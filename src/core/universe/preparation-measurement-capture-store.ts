import { isAbsolute, join, resolve } from 'node:path';
import { types } from 'node:util';
import { canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import { parsePreparationMeasurementReport } from './preparation-measurement-report.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import type { PreparationMeasurementCapture, PreparationMeasurementCaptureIntent as Intent,
  PreparationMeasurementCaptureReceipt as Receipt, PreparationMeasurementCaptureRequest as Request } from './preparation-measurement-capture-types.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const unavailable = () => new Error('Preparation measurement capture evidence unavailable');
export function ownCaptureData(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) throw unavailable();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
const text = (value: unknown, maximum = 4096): value is string => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value) <= maximum && ![...value].some(character => {
    const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
  });
const hash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const path = (value: unknown): value is string => text(value) && isAbsolute(value) && resolve(value) === value;
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) throw unavailable();
  return Array.from({ length: value.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) throw unavailable();
    return entry.value;
  });
}
export function validatePreparationMeasurementCaptureRequest(input: unknown): Request {
  const value = ownCaptureData(input, ['root', 'universeId', 'captureId']);
  if (!path(value.root) || resolve(value.root, '..') === value.root ||
      typeof value.universeId !== 'string' || !ID.test(value.universeId) ||
      typeof value.captureId !== 'string' || !ID.test(value.captureId)) throw unavailable();
  return value as unknown as Request;
}
export function preparationCaptureDirectory(request: Request): string {
  inspectPrivateDirectory(request.root); inspectPrivateDirectory(join(request.root, 'universes'));
  return inspectPrivateDirectory(join(request.root, 'universes', request.universeId));
}
function intent(input: unknown): Intent {
  const value = ownCaptureData(input, ['schemaVersion', 'captureId', 'universeId', 'startedAt', 'deadlineAt', 'timeoutMs',
    'manifestDigest', 'comparatorDigest', 'artifact', 'evaluator']);
  if (value.schemaVersion !== 1 || typeof value.captureId !== 'string' || !ID.test(value.captureId) ||
    typeof value.universeId !== 'string' || !ID.test(value.universeId) || !timestamp(value.startedAt) || !timestamp(value.deadlineAt) ||
    !Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 1_800_000 ||
    Date.parse(value.deadlineAt) - Date.parse(value.startedAt) !== value.timeoutMs || !hash(value.manifestDigest) || !hash(value.comparatorDigest)) throw unavailable();
  const artifact = ownCaptureData(value.artifact, ['path', 'digest', 'revision']);
  if (!path(artifact.path) || !hash(artifact.digest) || typeof artifact.revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(artifact.revision)) throw unavailable();
  const evaluator = ownCaptureData(value.evaluator, ['id', 'digest', 'executableDigest', 'command', 'files', 'tools', 'git']);
  if (evaluator.id !== 'preparation-measurement-v1' || !hash(evaluator.digest) || !hash(evaluator.executableDigest)) throw unavailable();
  const command = array(evaluator.command, 8);
  if (!command.length || !path(command[0]) || command.some(item => !text(item))) throw unavailable();
  const files = array(evaluator.files, 32).map(input => {
    const file = ownCaptureData(input, ['name', 'path', 'digest']);
    if (!text(file.name, 128) || !/^[a-z0-9-]+\.mjs$/.test(file.name) || !path(file.path) || !hash(file.digest)) throw unavailable();
    return file;
  });
  const pin = (input: unknown) => {
    const result = ownCaptureData(input, ['path', 'digest']);
    if (!path(result.path) || !hash(result.digest)) throw unavailable(); return result;
  };
  const tools = array(evaluator.tools, 16).map(pin), git = pin(evaluator.git);
  if (!files.length || new Set(files.map(file => file.name)).size !== files.length || !tools.length ||
    new Set(tools.map(tool => tool.path)).size !== tools.length || !tools.some(tool => canonical(tool) === canonical(git))) throw unavailable();
  return { ...value, artifact, evaluator: { ...evaluator, command, files, tools, git } } as unknown as Intent;
}
function receipt(input: unknown, parent: Intent): Receipt {
  const value = ownCaptureData(input, ['schemaVersion', 'intentDigest', 'finishedAt', 'durationMs', 'outcome', 'reason',
    'processGroupSettlement', 'identityVerified', 'report']);
  if (value.schemaVersion !== 1 || value.intentDigest !== digest(canonical(parent)) || !timestamp(value.finishedAt) || Date.parse(value.finishedAt) < Date.parse(parent.startedAt) ||
    typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 || typeof value.identityVerified !== 'boolean' ||
    typeof value.processGroupSettlement !== 'string' || !['not-started', 'group-exit-confirmed', 'unconfirmed'].includes(value.processGroupSettlement)) throw unavailable();
  const pairs: Record<string, Array<string | null>> = { captured: [null], failed: ['execution-failed', 'invalid-report', 'integrity-changed'],
    cancelled: ['cancelled'], 'timed-out': ['deadline-reached'], held: ['settlement-unconfirmed'] };
  if (typeof value.outcome !== 'string' || !Object.hasOwn(pairs, value.outcome) || !pairs[value.outcome]!.includes(value.reason as string | null) ||
    (value.outcome === 'held') !== (value.processGroupSettlement === 'unconfirmed')) throw unavailable();
  let report: Receipt['report'] = null;
  if (value.report !== null) {
    const row = ownCaptureData(value.report, ['stdout', 'sha256', 'bytes', 'checksPassed']);
    if (typeof row.stdout !== 'string' || Buffer.byteLength(row.stdout) !== row.bytes || digest(row.stdout) !== row.sha256) throw unavailable();
    const parsed = parsePreparationMeasurementReport(row.stdout);
    if (parsed.checksPassed !== row.checksPassed) throw unavailable();
    report = row as unknown as NonNullable<Receipt['report']>;
  }
  if (value.outcome === 'captured' && (!report || value.identityVerified !== true || value.processGroupSettlement !== 'group-exit-confirmed')) throw unavailable();
  if (value.processGroupSettlement === 'not-started' && report || value.reason === 'invalid-report' && report ||
    value.reason === 'integrity-changed' && value.identityVerified) throw unavailable();
  return { ...value, report } as unknown as Receipt;
}
export interface PreparationCaptureRecord { id: string; kind: 'intent' | 'receipt'; intent: Intent; receipt: Receipt | null }
const codec: ImmutablePrivateRecordCodec<PreparationCaptureRecord> = {
  parse(input) { try {
    const row = ownCaptureData(input, ['id', 'kind', 'intent', 'receipt']), parent = intent(row.intent);
    if (typeof row.kind !== 'string' || !['intent', 'receipt'].includes(row.kind) || row.id !== `${parent.captureId}.${row.kind}` || row.kind === 'intent' && row.receipt !== null) return null;
    return { id: row.id as string, kind: row.kind as 'intent' | 'receipt', intent: parent,
      receipt: row.kind === 'intent' ? null : receipt(row.receipt, parent) };
  } catch { return null; } },
  serialize: value => `${canonical(value)}\n`, recordId: value => value.id,
  recordFileName: value => `${value.id}.json`, isRecordFileName: name => /^[a-z0-9][a-z0-9_-]{0,63}\.(intent|receipt)\.json$/.test(name),
  stageToken: value => digest(canonical(value)), equivalent: (a, b) => canonical(a) === canonical(b),
};
function config(directory: string): ImmutablePrivateRecordStoreConfig<PreparationCaptureRecord> {
  return { label: 'Preparation measurement capture', anchorPath: directory, rootPath: join(directory, 'preparation-measurements'),
    lockFileName: '.records.lock', maxRecordBytes: 256 * 1024, defaultMaxFiles: 128, hardMaxFiles: 128,
    defaultMaxBytes: 32 * 1024 * 1024, hardMaxBytes: 32 * 1024 * 1024, codecForRead: () => codec, codecForWrite: () => codec };
}
export function readPreparationCaptureRecords(directory: string): PreparationCaptureRecord[] {
  const result = readImmutablePrivateRecords(config(directory), { requireComplete: true });
  if (result.sourceState === 'missing' && !result.sourcePresent) return [];
  if (result.sourceState !== 'healthy' || !result.complete) throw unavailable();
  const intents = new Map<string, Intent>();
  for (const row of result.records) if (row.kind === 'intent') intents.set(row.intent.captureId, row.intent);
  for (const row of result.records) {
    if (row.intent.artifact.path !== join(directory, 'seed') || join(directory, '..', row.intent.universeId) !== directory ||
      row.kind === 'receipt' && canonical(intents.get(row.intent.captureId) ?? null) !== canonical(row.intent)) throw unavailable();
  }
  return result.records;
}
export function assertPreparationMeasurementsSettled(directory: string): void {
  const records = readPreparationCaptureRecords(directory);
  if (records.some(row => row.kind === 'intent' && !records.some(result => result.kind === 'receipt' && result.intent.captureId === row.intent.captureId &&
    result.receipt?.processGroupSettlement !== 'unconfirmed'))) throw new Error('Preparation measurement capture has an unresolved evaluator; execution is held');
}
export function writePreparationCaptureRecord(directory: string, value: PreparationCaptureRecord, guard: () => void): void {
  const disposition = writeImmutablePrivateRecord(config(directory), value, { prepublish: () => { guard(); return true; } });
  if (disposition !== 'recorded' && disposition !== 'replayed') throw unavailable();
}
/** Reserve worst-case JSON escaping for one complete 24 KiB diagnostic report. */
export function assertPreparationCaptureBudget(parent: Intent): void {
  if (Buffer.byteLength(canonical(parent)) + 24 * 1024 * 6 + 8192 > 256 * 1024) {
    throw new Error('Preparation measurement capture receipt capacity unavailable');
  }
}
export function projectPreparationCapture(records: PreparationCaptureRecord[], captureId: string): PreparationMeasurementCapture {
  const parent = records.find(row => row.kind === 'intent' && row.intent.captureId === captureId)?.intent ?? null;
  const result = records.find(row => row.kind === 'receipt' && row.intent.captureId === captureId)?.receipt ?? null;
  return structuredClone({ schemaVersion: 1, scope: 'diagnostic-only', state: !parent ? 'missing' :
    !result || result.processGroupSettlement === 'unconfirmed' ? 'held' : 'recorded', disposition: null, intent: parent, receipt: result });
}
