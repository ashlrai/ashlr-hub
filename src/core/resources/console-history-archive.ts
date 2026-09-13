/** Terminal-history storage projection. This does not remove jobs or authorize dispatch. */
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest } from '../universe/artifacts.js';
import { MAX_RESOURCE_CONVERSATION_BYTES, resourceConsoleConversationPrompt,
  validateResourceConsoleContext, validateResourceConsoleParent } from './console-conversation.js';
import { decodeResourceConsoleState, type ResourceConsoleDurableState } from './console-state-codec.js';

type Job = ResourceConsoleDurableState['jobs'][number];
export type ResourceConsoleArchiveJobMetadata = Omit<Job, 'input' | 'history' | 'context'>;
export interface ResourceConsoleArchiveRecord {
  schemaVersion: 1;
  kind: 'resource-console-history-archive';
  /** Content identity, not an execution receipt or proof of source ownership. */
  id: string;
  scopeDigest: string;
  sourceStateDigest: string;
  sourceSchemaVersion: ResourceConsoleDurableState['schemaVersion'];
  position: number;
  job: ResourceConsoleArchiveJobMetadata;
  textDigest: string | null;
}
/** This payload must remain separately deletable. Never put it in immutable records. */
export interface ResourceConsoleArchiveText {
  history: NonNullable<Job['history']>;
  context: Job['context'] | null;
}
export interface ResourceConsoleHistoryArchivePlan {
  sourceStateDigest: string;
  scopeDigest: string;
  entries: Array<{ record: ResourceConsoleArchiveRecord; text: ResourceConsoleArchiveText | null }>;
  retainedJobIds: string[];
}
export const MAX_RESOURCE_CONSOLE_ARCHIVE_RECORD_BYTES = 16 * 1024;
export const MAX_RESOURCE_CONSOLE_ARCHIVE_TEXT_BYTES = 384 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OWNER = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(): never { throw new Error('Invalid resource console history archive'); }
const hash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Inspect descriptors before any serializer can call array methods or read an element. */
function assertArchiveData(value: unknown, ancestors = new Set<object>(), depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 100_000 || depth > 32) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) fail();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (array && (keys.length !== value.length + 1 || !Array.from({ length: value.length }, (_, index) =>
    Object.hasOwn(descriptors, index)).every(Boolean))) fail();
  ancestors.add(value);
  try {
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail();
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      assertArchiveData(descriptor.value, ancestors, depth + 1, budget);
    }
  } finally { ancestors.delete(value); }
}
function data<T>(value: unknown, maxBytes: number): T {
  assertArchiveData(value);
  const bytes = canonicalEvidencePackJsonV3(value);
  if (bytes === null || Buffer.byteLength(bytes) > maxBytes) fail();
  return JSON.parse(bytes) as T;
}

/** Closed structural codec only. Pool, graph and receipt validity require the source decoder. */
export function validateResourceConsoleArchiveRecord(value: unknown): ResourceConsoleArchiveRecord {
  const record = data<ResourceConsoleArchiveRecord>(value, MAX_RESOURCE_CONSOLE_ARCHIVE_RECORD_BYTES);
  if (!exact(record, ['schemaVersion', 'kind', 'id', 'scopeDigest', 'sourceStateDigest', 'sourceSchemaVersion', 'position', 'job', 'textDigest']) ||
    record.schemaVersion !== 1 || record.kind !== 'resource-console-history-archive' ||
    !hash(record.id) || !hash(record.scopeDigest) || !hash(record.sourceStateDigest) ||
    !Number.isSafeInteger(record.sourceSchemaVersion) || record.sourceSchemaVersion < 1 || record.sourceSchemaVersion > 7 ||
    !Number.isSafeInteger(record.position) || record.position < 0 || record.position >= 256 ||
    record.textDigest !== null && !hash(record.textDigest)) fail();
  const job = record.job;
  const optional = ['retainHistory', 'parent', 'submissionDigest', 'projectId', 'originPoolDigest',
    'executionOwnerId', 'executionDeadlineAt', 'recoveryOf'];
  if (!job || !exact(job, ['id', 'state', 'enqueuedAt', 'updatedAt', 'allowedWorkerIds', 'mode', 'workerId', 'outcome', 'reason', 'taskDigest',
    ...optional.filter(key => Object.hasOwn(job, key))]) || !identifier(job.id) ||
    !['settled', 'cancelled'].includes(job.state) || !date(job.enqueuedAt) || !date(job.updatedAt) || job.updatedAt < job.enqueuedAt ||
    !Array.isArray(job.allowedWorkerIds) || job.allowedWorkerIds.length < 1 || job.allowedWorkerIds.length > 32 ||
    job.allowedWorkerIds.some(id => !identifier(id)) || new Set(job.allowedWorkerIds).size !== job.allowedWorkerIds.length ||
    !['read-only', 'workspace-write'].includes(job.mode) ||
    !(job.workerId === null || identifier(job.workerId) && job.allowedWorkerIds.includes(job.workerId)) ||
    !(job.reason === null || typeof job.reason === 'string' && /^[a-z0-9-]{1,120}$/.test(job.reason)) || !hash(job.taskDigest)) fail();
  if (job.state === 'cancelled' ? job.workerId !== null || job.outcome !== 'cancelled'
    : job.workerId === null || !['completed', 'failed', 'timed-out', 'cancelled'].includes(String(job.outcome))) fail();
  if (Object.hasOwn(job, 'retainHistory') && (job.retainHistory !== true || record.sourceSchemaVersion < 2) ||
    record.textDigest !== null && job.retainHistory !== true) fail();
  if (Object.hasOwn(job, 'parent') !== Object.hasOwn(job, 'submissionDigest')) fail();
  if (job.parent !== undefined) {
    validateResourceConsoleParent(job.parent);
    if (record.sourceSchemaVersion < 3 || job.parent.taskId === job.id || !hash(job.submissionDigest)) fail();
  }
  if (Object.hasOwn(job, 'projectId') && (record.sourceSchemaVersion < 4 || !identifier(job.projectId) || job.projectId === 'default') ||
    Object.hasOwn(job, 'originPoolDigest') && (record.sourceSchemaVersion < 5 || !hash(job.originPoolDigest)) ||
    Object.hasOwn(job, 'executionOwnerId') && (record.sourceSchemaVersion < 6 || typeof job.executionOwnerId !== 'string' || !OWNER.test(job.executionOwnerId)) ||
    Object.hasOwn(job, 'executionDeadlineAt') && (job.executionOwnerId === undefined || !date(job.executionDeadlineAt)) ||
    Object.hasOwn(job, 'recoveryOf') && (record.sourceSchemaVersion !== 7 || !identifier(job.recoveryOf) || job.recoveryOf === job.id ||
      job.executionOwnerId === undefined || job.executionDeadlineAt === undefined || job.mode !== 'read-only' || job.parent !== undefined)) fail();
  const { id, ...body } = record;
  if (digest(canonical(body)) !== id) fail();
  return record;
}

export function validateResourceConsoleArchiveText(value: unknown, input: ResourceConsoleArchiveRecord): ResourceConsoleArchiveText | null {
  const record = validateResourceConsoleArchiveRecord(input);
  if (record.textDigest === null) { if (value !== null) fail(); return null; }
  const text = data<ResourceConsoleArchiveText>(value, MAX_RESOURCE_CONSOLE_ARCHIVE_TEXT_BYTES);
  if (!exact(text, ['history', 'context']) || !exact(text.history, ['prompt', 'output']) ||
    typeof text.history.prompt !== 'string' || !text.history.prompt.trim() || text.history.prompt.includes('\0') ||
    Buffer.byteLength(text.history.prompt) > 32 * 1024) fail();
  const output = text.history.output;
  if (output !== null && (!exact(output, ['text', 'truncated']) || typeof output.text !== 'string' ||
    Buffer.byteLength(output.text) > 64 * 1024 || typeof output.truncated !== 'boolean' ||
    record.job.state !== 'settled' || record.job.outcome !== 'completed')) fail();
  if (record.job.parent) {
    validateResourceConsoleContext(text.context, record.job.id, record.job.parent.taskId);
    if (Buffer.byteLength(resourceConsoleConversationPrompt(text.history.prompt, text.context!)) > MAX_RESOURCE_CONVERSATION_BYTES) fail();
  } else if (text.context !== null) fail();
  if (digest(canonical(text)) !== record.textDigest) fail();
  return text;
}

/** Caller must prove any deletion tombstone. This projection itself grants no custody. */
export function restoreResourceConsoleArchiveJob(input: ResourceConsoleArchiveRecord,
  value: ResourceConsoleArchiveText | null, options: { deleted?: true } = {}): Job {
  const record = validateResourceConsoleArchiveRecord(input);
  const deletion = data<{ deleted?: true }>(options, 64);
  if (!exact(deletion, Object.hasOwn(deletion ?? {}, 'deleted') ? ['deleted'] : []) ||
    Object.hasOwn(deletion, 'deleted') && deletion.deleted !== true) fail();
  if (deletion.deleted && (value !== null || record.job.retainHistory !== true)) fail();
  const text = deletion.deleted ? null : validateResourceConsoleArchiveText(value, record);
  return { ...record.job, input: null,
    ...(record.job.retainHistory ? { history: text?.history ?? null } : {}),
    ...(record.job.parent ? { context: text?.context ?? null } : {}) };
}

/** Full source validation precedes selection; no partial state is emitted for publication. */
export function prepareResourceConsoleHistoryArchive(value: unknown,
  options: Parameters<typeof decodeResourceConsoleState>[1], taskIds: string[]): ResourceConsoleHistoryArchivePlan {
  const state = decodeResourceConsoleState(value, options);
  const selected = data<string[]>(taskIds, 32 * 1024);
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 256 ||
    selected.some(id => !identifier(id)) || new Set(selected).size !== selected.length) fail();
  const sourceStateDigest = digest(canonical(state));
  const ids = new Set(selected);
  const entries: ResourceConsoleHistoryArchivePlan['entries'] = [];
  state.jobs.forEach((job, position) => {
    if (!ids.has(job.id)) return;
    if (!['settled', 'cancelled'].includes(job.state) || job.input !== null) fail();
    const { input: _input, history, context, ...metadata } = job;
    const text = history ? { history, context: context ?? null } : null;
    const body = { schemaVersion: 1 as const, kind: 'resource-console-history-archive' as const,
      scopeDigest: state.scopeDigest, sourceStateDigest, sourceSchemaVersion: state.schemaVersion,
      position, job: metadata, textDigest: text === null ? null : digest(canonical(text)) };
    const record = validateResourceConsoleArchiveRecord({ ...body, id: digest(canonical(body)) });
    entries.push({ record, text: validateResourceConsoleArchiveText(text, record) });
  });
  if (entries.length !== selected.length) fail();
  return { sourceStateDigest, scopeDigest: state.scopeDigest, entries,
    retainedJobIds: state.jobs.filter(job => !ids.has(job.id)).map(job => job.id) };
}
