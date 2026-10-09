import { join } from 'node:path';
import { outcomeCanonical, outcomeDigest } from '../goals/outcome-types.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord, type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig, type ImmutablePrivateRecordWriteDisposition } from '../util/immutable-private-record-store.js';

/** Private evidence, not a telemetry event or an instruction to an agent. */
export interface TaskContextEventV1 {
  schemaVersion: 1;
  eventId: string;
  taskRef: string;
  source: { kind: 'phantom' | 'mail' | 'calendar' | 'document' | 'github' | 'project-memory';
    provider: string; accountRef: string; objectRef: string; revisionRef: string };
  sourceRefs: string[];
  occurredAt: string | null;
  observedAt: string;
  validFrom: string | null;
  validUntil: string | null;
  kind: 'upsert' | 'cancel';
  epistemic: 'recorded' | 'derived' | 'hypothesis';
  content: string;
  supersedes: string[];
}
export type TaskContextEventInput = Omit<TaskContextEventV1, 'schemaVersion' | 'eventId'>;
export interface TaskContextCoverage {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  stopReasons: string[];
}
export interface TaskContextEvidence extends TaskContextEventV1 {
  status: 'current' | 'superseded' | 'canceled' | 'expired' | 'conflicted';
  temporalResolution: 'known' | 'unknown';
  replacedBy: string[];
}
export interface TaskTemporalContextV1 {
  schemaVersion: 1;
  taskRef: string;
  asOf: string;
  observedThrough: string;
  coverage: TaskContextCoverage;
  current: TaskContextEvidence[];
  history: TaskContextEvidence[];
  conflicts: Array<{ kind: 'revision-conflict' | 'unlinked-revisions' | 'invalid-supersession' | 'missing-predecessor' |
    'unknown-effective-time' | 'supersession-cycle'; eventIds: string[]; alternatives?: TaskContextEventV1[] }>;
}

const EVENT_KEYS = ['schemaVersion', 'eventId', 'taskRef', 'source', 'sourceRefs', 'occurredAt', 'observedAt',
  'validFrom', 'validUntil', 'kind', 'epistemic', 'content', 'supersedes'];
const SOURCE_KEYS = ['kind', 'provider', 'accountRef', 'objectRef', 'revisionRef'];
const EVENT_ID = /^tce-[a-f0-9]{8}(?:\.[a-f0-9]{8}){7}$/;
const LIMIT = 100_000; // Local read admission; unrelated to agent concurrency or work budgets.

function closedRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => descriptors[key] && 'value' in descriptors[key]!);
}
function text(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /\p{Surrogate}/u.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 32 || code === 127) && ![9, 10, 13].includes(code)) return false;
  }
  return true;
}
function strings(value: unknown, max: number, count = 256): value is string[] {
  if (!Array.isArray(value) || value.length > count) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) => descriptors[index])
    .every(descriptor => descriptor && 'value' in descriptor && text(descriptor.value, max)) && new Set(value).size === value.length;
}

/** Require an explicit offset. Local clock strings and invalid calendar dates remain unknown, never guessed. */
export function taskContextTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , offset] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const monthDays = m >= 1 && m <= 12 ? new Date(Date.UTC(y < 100 ? y + 400 : y, m, 0)).getUTCDate() : 0;
  if (d < 1 || d > monthDays || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (offset !== 'Z' && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59))) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function identity(event: Pick<TaskContextEventV1, 'taskRef' | 'source' | 'kind'>): string {
  return `tce-${outcomeDigest([event.taskRef, event.source, event.kind]).match(/.{8}/g)!.join('.')}`;
}
function payload(event: TaskContextEventV1): string {
  // At-least-once delivery preserves the first observation; a later identical read is not a new fact.
  const { observedAt: _observedAt, ...rest } = event;
  return outcomeCanonical(rest);
}
export function parseTaskContextEvent(value: unknown): TaskContextEventV1 | null {
  try {
    if (!closedRecord(value, EVENT_KEYS) || value.schemaVersion !== 1 || !text(value.taskRef, 256) ||
        typeof value.eventId !== 'string' || !EVENT_ID.test(value.eventId) || !closedRecord(value.source, SOURCE_KEYS)) return null;
    const source = value.source;
    if (!['phantom', 'mail', 'calendar', 'document', 'github', 'project-memory'].includes(source.kind as string) ||
        !text(source.provider, 128) || !text(source.accountRef, 256) || !text(source.objectRef, 2048) || !text(source.revisionRef, 256) ||
        !strings(value.sourceRefs, 2048) || !strings(value.supersedes, 80) || value.supersedes.some(id => !EVENT_ID.test(id)) ||
        !['upsert', 'cancel'].includes(value.kind as string) || !['recorded', 'derived', 'hypothesis'].includes(value.epistemic as string) ||
        !text(value.content, 128 * 1024)) return null;
    const dates = ['occurredAt', 'validFrom', 'validUntil'] as const;
    if (dates.some(key => value[key] !== null && taskContextTimestamp(value[key]) === null) || taskContextTimestamp(value.observedAt) === null) return null;
    const event = { ...value, source: { ...source }, sourceRefs: [...value.sourceRefs], supersedes: [...value.supersedes],
      occurredAt: value.occurredAt === null ? null : taskContextTimestamp(value.occurredAt),
      validFrom: value.validFrom === null ? null : taskContextTimestamp(value.validFrom),
      validUntil: value.validUntil === null ? null : taskContextTimestamp(value.validUntil),
      observedAt: taskContextTimestamp(value.observedAt)! } as TaskContextEventV1;
    if (identity(event) !== event.eventId || event.supersedes.includes(event.eventId) ||
        (event.validFrom !== null && event.validUntil !== null && event.validUntil <= event.validFrom)) return null;
    return event;
  } catch { return null; }
}
export function createTaskContextEvent(input: TaskContextEventInput): TaskContextEventV1 {
  const event = parseTaskContextEvent({ ...input, schemaVersion: 1, eventId: identity(input) });
  if (!event) throw new Error('Invalid task context evidence.');
  return event;
}
const codec: ImmutablePrivateRecordCodec<TaskContextEventV1> = {
  parse: parseTaskContextEvent, serialize: event => `${outcomeCanonical(event)}\n`, recordId: event => event.eventId,
  recordFileName: event => `${event.eventId}.json`, isRecordFileName: name => /^tce-[a-f0-9]{8}(?:\.[a-f0-9]{8}){7}\.json$/.test(name),
  stageToken: event => outcomeDigest(event), equivalent: (a, b) => payload(a) === payload(b),
  compare: (a, b) => a.observedAt.localeCompare(b.observedAt) || a.eventId.localeCompare(b.eventId),
};
function config(root: string, taskRef: string): ImmutablePrivateRecordStoreConfig<TaskContextEventV1> {
  return { label: 'Private task context', anchorPath: root, rootPath: join(root, `task-context-${outcomeDigest(taskRef)}`),
    lockFileName: '.records.lock', maxRecordBytes: 1024 * 1024,
    defaultMaxFiles: 1000, hardMaxFiles: LIMIT, defaultMaxBytes: 16 * 1024 * 1024, hardMaxBytes: 1024 * 1024 * 1024,
    codecForWrite: () => codec, codecForRead: () => codec };
}

/** Internal connector boundary only. Authorization must bind task + source account + object, and is rechecked before publication. */
export function appendTaskContextEvent(input: { root: string; event: TaskContextEventV1;
  stillAuthorized: (event: TaskContextEventV1) => boolean }): ImmutablePrivateRecordWriteDisposition {
  const event = parseTaskContextEvent(input.event);
  if (!event) return 'invalid';
  try {
    if (!input.stillAuthorized(event)) return 'invalid';
    return writeImmutablePrivateRecord(config(input.root, event.taskRef), event, { prepublish: () => input.stillAuthorized(event) });
  } catch { return 'failed'; }
}
export interface TaskContextQuery {
  taskRef: string;
  /** Explicit authorized account scope; an empty list does not mean all accounts. */
  accountRefs: string[];
  asOf?: string;
  observedThrough?: string;
  maxEvents?: number;
}
function query(input: TaskContextQuery): Required<TaskContextQuery> {
  const now = new Date().toISOString();
  const asOf = input.asOf === undefined ? now : taskContextTimestamp(input.asOf);
  const observedThrough = input.observedThrough === undefined ? now : taskContextTimestamp(input.observedThrough);
  const maxEvents = input.maxEvents ?? 1000;
  if (!text(input.taskRef, 256) || !strings(input.accountRefs, 256, LIMIT) || !asOf || !observedThrough ||
      !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > LIMIT) throw new Error('Invalid task context query.');
  return { taskRef: input.taskRef, accountRefs: input.accountRefs, asOf, observedThrough, maxEvents };
}
function objectKey(event: TaskContextEventV1): string {
  const { revisionRef: _revisionRef, ...source } = event.source;
  return outcomeCanonical([event.taskRef, source]);
}

export function projectTaskTemporalContext(input: TaskContextQuery & { events: readonly TaskContextEventV1[];
  sourceState: TaskContextCoverage['sourceState']; complete: boolean; stopReasons?: string[] }): TaskTemporalContextV1 {
  const q = query(input);
  const conflicts: TaskTemporalContextV1['conflicts'] = [];
  const byId = new Map<string, TaskContextEventV1>();
  const conflicting = new Set<string>();
  let invalid = false;
  for (const raw of input.events) {
    const event = parseTaskContextEvent(raw);
    if (!event) { invalid = true; continue; }
    if (event.taskRef !== q.taskRef || !q.accountRefs.includes(event.source.accountRef) || event.observedAt > q.observedThrough) continue;
    const previous = byId.get(event.eventId);
    if (previous && payload(previous) !== payload(event)) {
      conflicting.add(event.eventId); conflicts.push({ kind: 'revision-conflict', eventIds: [event.eventId], alternatives: [previous, event] });
    } else if (!previous || event.observedAt < previous.observedAt) byId.set(event.eventId, event);
  }
  const evidence = new Map<string, TaskContextEvidence>();
  for (const event of byId.values()) {
    const effective = event.validFrom ?? event.occurredAt;
    if (effective !== null && effective > q.asOf) continue;
    evidence.set(event.eventId, { ...event, status: conflicting.has(event.eventId) ? 'conflicted' :
      event.validUntil !== null && event.validUntil <= q.asOf ? 'expired' : event.kind === 'cancel' ? 'canceled' : 'current',
    temporalResolution: effective === null ? 'unknown' : 'known', replacedBy: [] });
  }
  const links = new Map<string, string[]>();
  for (const event of evidence.values()) {
    if (event.epistemic === 'hypothesis' || event.status === 'conflicted') continue;
    for (const id of event.supersedes) {
      const previous = evidence.get(id);
      if (!previous) { conflicts.push({ kind: 'missing-predecessor', eventIds: [event.eventId, id] }); continue; }
      if (objectKey(previous) !== objectKey(event)) { conflicts.push({ kind: 'invalid-supersession', eventIds: [event.eventId, id] }); continue; }
      if (event.temporalResolution === 'unknown') { conflicts.push({ kind: 'unknown-effective-time', eventIds: [event.eventId, id] }); continue; }
      if (previous.temporalResolution === 'known' && (event.validFrom ?? event.occurredAt)! < (previous.validFrom ?? previous.occurredAt)!) {
        conflicts.push({ kind: 'invalid-supersession', eventIds: [event.eventId, id] }); continue;
      }
      links.set(event.eventId, [...(links.get(event.eventId) ?? []), id]);
    }
  }
  // Detect cycles before applying any relationship; neither participant becomes a silent winner.
  const cycleIds = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  // Use an explicit stack so a long, valid revision chain cannot exhaust the JavaScript call stack.
  for (const start of links.keys()) {
    if (visited.has(start)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    visiting.add(start);
    while (stack.length) {
      const frame = stack.at(-1)!;
      const predecessor = (links.get(frame.id) ?? [])[frame.next++];
      if (predecessor === undefined) { visiting.delete(frame.id); visited.add(frame.id); stack.pop(); continue; }
      if (visiting.has(predecessor)) {
        stack.slice(stack.findIndex(item => item.id === predecessor)).forEach(item => cycleIds.add(item.id));
      } else if (!visited.has(predecessor)) { visiting.add(predecessor); stack.push({ id: predecessor, next: 0 }); }
    }
  }
  if (cycleIds.size) conflicts.push({ kind: 'supersession-cycle', eventIds: [...cycleIds].sort() });
  for (const id of cycleIds) evidence.get(id)!.status = 'conflicted';
  for (const [id, predecessors] of links) {
    if (cycleIds.has(id)) continue;
    const event = evidence.get(id)!;
    for (const predecessor of predecessors) {
      const previous = evidence.get(predecessor)!;
      if (previous.status === 'conflicted') continue;
      previous.replacedBy.push(id);
      previous.status = event.kind === 'cancel' ? 'canceled' : 'superseded';
    }
  }
  const current = [...evidence.values()].filter(event => ['current', 'conflicted'].includes(event.status));
  const objects = new Map<string, TaskContextEvidence[]>();
  for (const event of current.filter(item => item.epistemic !== 'hypothesis')) {
    const key = objectKey(event); objects.set(key, [...(objects.get(key) ?? []), event]);
  }
  for (const events of objects.values()) {
    if (events.length > 1 && new Set(events.map(event => outcomeCanonical([event.kind, event.content]))).size > 1) {
      events.forEach(event => { event.status = 'conflicted'; });
      conflicts.push({ kind: 'unlinked-revisions', eventIds: events.map(event => event.eventId).sort() });
    }
  }
  const ordered = [...evidence.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.eventId.localeCompare(b.eventId));
  const limited = ordered.length > q.maxEvents;
  const selected = ordered.slice(0, q.maxEvents);
  return { schemaVersion: 1, taskRef: q.taskRef, asOf: q.asOf, observedThrough: q.observedThrough,
    coverage: { sourceState: invalid ? 'degraded' : input.sourceState,
      complete: input.sourceState === 'healthy' && input.complete && !invalid && !limited,
      stopReasons: [...new Set([...(input.stopReasons ?? []), ...(invalid ? ['invalid-event'] : []), ...(limited ? ['event-limit'] : [])])] },
    current: selected.filter(event => ['current', 'conflicted'].includes(event.status)),
    history: selected.filter(event => !['current', 'conflicted'].includes(event.status)), conflicts };
}

/** Observation never initializes storage or acquires a writer lock. */
export function readTaskTemporalContext(input: TaskContextQuery & { root: string }): TaskTemporalContextV1 {
  const q = query(input);
  const read = readImmutablePrivateRecords(config(input.root, q.taskRef), { maxFiles: q.maxEvents });
  return projectTaskTemporalContext({ ...q, events: read.records, sourceState: read.sourceState,
    complete: read.complete, stopReasons: read.stopReasons });
}
