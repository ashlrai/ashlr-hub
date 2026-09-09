import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonical, defaultUniverseRoot, digest, inspectPrivateDirectory } from './artifacts.js';
import { validateUniverseCampaignDeliveryPlan } from './campaign-delivery.js';
import { validateUniversePortfolioDefinition } from './portfolio-plan.js';
import type { PortfolioControllerEnrollment, PortfolioControllerEvent, PortfolioControllerPin,
  UniversePortfolioControllerOutcome } from './portfolio-controller-types.js';
import type { UniverseStoreOptions } from './types.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_EVENTS = 512;
const MAX_BYTES = 4 * 1024 * 1024;
const EVENT_BYTES = 4_096;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) => typeof key === 'string' &&
    keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function reason(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value); }

function pin(value: unknown): value is PortfolioControllerPin {
  return object(value) && exact(value, ['campaignId', 'universeId', 'definitionDigest', 'manifestDigest', 'comparatorDigest',
    'campaignDigest', 'recordsDigest', 'initialState', 'dispatch', 'reasonCode']) && id(value.campaignId) && id(value.universeId) &&
    ['definitionDigest', 'manifestDigest', 'comparatorDigest', 'campaignDigest', 'recordsDigest'].every((key) => hash(value[key])) &&
    ['pending', 'completed', 'held'].includes(String(value.initialState)) && ['campaign', 'delivery', 'none'].includes(String(value.dispatch)) &&
    (value.initialState === 'pending' ? value.dispatch !== 'none' : value.dispatch === 'none') && reason(value.reasonCode);
}

function enrollment(value: unknown): value is PortfolioControllerEnrollment {
  if (!object(value) || !exact(value, ['definition', 'deliveryPlan', 'definitionDigest', 'pins', 'deadlineAt']) ||
      !Array.isArray(value.pins) || !value.pins.every(pin) || !iso(value.deadlineAt)) return false;
  try {
    const definition = validateUniversePortfolioDefinition(value.definition);
    const ids = definition.tasks.map((task) => task.campaignId);
    if (value.definitionDigest !== digest(canonical(definition)) || value.pins.length !== ids.length ||
        value.pins.some((item, index) => item.campaignId !== ids[index]) || new Set(value.pins.map((item) => item.universeId)).size !== ids.length) return false;
    const delivery = value.deliveryPlan === null ? null : validateUniverseCampaignDeliveryPlan(value.deliveryPlan, ids);
    return value.pins.every((item) => {
      const planned = delivery?.deliveries.some((row) => row.campaignId === item.campaignId);
      return (item.dispatch !== 'delivery' || planned) && !(item.initialState === 'completed' && planned);
    });
  } catch { return false; }
}

function outcome(value: unknown): value is UniversePortfolioControllerOutcome {
  return object(value) && exact(value, ['campaignId', 'state', 'attempted', 'reasonCode', 'campaignDigest', 'deliveryDigest']) &&
    id(value.campaignId) && ['completed', 'held'].includes(String(value.state)) && typeof value.attempted === 'boolean' &&
    reason(value.reasonCode) && hash(value.campaignDigest) && (value.deliveryDigest === null || hash(value.deliveryDigest));
}

function parse(value: unknown): PortfolioControllerEvent | null {
  if (!object(value) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || Number(value.sequence) >= MAX_EVENTS ||
      value.id !== String(value.sequence).padStart(8, '0') || !iso(value.at)) return null;
  const shared = ['id', 'sequence', 'at', 'kind'];
  if (value.kind === 'created') {
    if (!exact(value, [...shared, 'enrollment']) || value.sequence !== 0 || !enrollment(value.enrollment) ||
        Date.parse(value.enrollment.deadlineAt) !== Date.parse(value.at) + value.enrollment.definition.maxDurationMs) return null;
  } else if (value.kind === 'observed') {
    if (!exact(value, shared)) return null;
  } else if (value.kind === 'intent') {
    if (!exact(value, [...shared, 'campaignId']) || !id(value.campaignId)) return null;
  } else if (value.kind === 'settled') {
    if (!exact(value, [...shared, 'outcome', 'recordsDigest']) || !outcome(value.outcome) || !hash(value.recordsDigest)) return null;
  } else return null;
  if (Buffer.byteLength(canonical(value)) > (value.kind === 'created' ? 128 * 1024 : EVENT_BYTES - 1)) return null;
  return value as unknown as PortfolioControllerEvent;
}

const codec: ImmutablePrivateRecordCodec<PortfolioControllerEvent> = {
  parse, serialize: (value) => `${canonical(value)}\n`, recordId: (value) => value.id,
  recordFileName: (value) => `${value.id}.json`, isRecordFileName: (name) => /^\d{8}\.json$/.test(name),
  stageToken: (value) => digest(canonical(value)), equivalent: (a, b) => canonical(a) === canonical(b),
  compare: (a, b) => a.sequence - b.sequence,
};
function config(directory: string): ImmutablePrivateRecordStoreConfig<PortfolioControllerEvent> {
  return { label: 'Universe portfolio controller', anchorPath: directory, rootPath: join(directory, 'ledger'), lockFileName: '.records.lock',
    maxRecordBytes: 128 * 1024 + 1, defaultMaxFiles: MAX_EVENTS, hardMaxFiles: MAX_EVENTS,
    defaultMaxBytes: MAX_BYTES, hardMaxBytes: MAX_BYTES, codecForRead: () => codec, codecForWrite: () => codec };
}

export function portfolioControllerDirectory(controllerId: string, options: UniverseStoreOptions = {}): string {
  if (!id(controllerId)) throw new Error('Invalid Universe portfolio controller id');
  return join(resolve(options.root ?? defaultUniverseRoot()), 'portfolios', controllerId);
}

/** A precompleted intermediate cannot sever a planned ancestor delivery gate. */
export function portfolioControllerPrerequisites(enrolled: PortfolioControllerEnrollment, campaignId: string): string[] {
  const tasks = new Map(enrolled.definition.tasks.map((task) => [task.campaignId, task]));
  const result = new Set(tasks.get(campaignId)!.dependsOn);
  const deliveryIds = new Set(enrolled.deliveryPlan?.deliveries.map((row) => row.campaignId));
  const visited = new Set<string>();
  const pending = [...result];
  while (pending.length) {
    const next = pending.pop()!;
    if (visited.has(next)) continue;
    visited.add(next);
    if (deliveryIds.has(next)) result.add(next);
    pending.push(...tasks.get(next)!.dependsOn);
  }
  return [...result];
}

export function foldPortfolioController(records: PortfolioControllerEvent[]) {
  const first = records[0];
  if (!first || first.kind !== 'created') throw new Error('Controller registration is missing');
  const states = new Map<string, UniversePortfolioControllerOutcome>();
  const pins = new Map(first.enrollment.pins.map((item) => [item.campaignId, item]));
  const intents = new Set<string>();
  const settlements = new Map<string, Extract<PortfolioControllerEvent, { kind: 'settled' }>>();
  for (const item of pins.values()) states.set(item.campaignId, { campaignId: item.campaignId, state: item.initialState,
    attempted: false, reasonCode: item.reasonCode, campaignDigest: item.campaignDigest, deliveryDigest: null });
  let highWaterAt = first.at;
  for (const [index, event] of records.entries()) {
    if (!parse(event) || event.sequence !== index || event.at < highWaterAt) throw new Error('Controller event history is invalid');
    highWaterAt = event.at;
    if (index === 0) continue;
    if (event.kind === 'created') throw new Error('Controller registration cannot be replaced');
    if (event.kind === 'observed') continue;
    const campaignId = event.kind === 'intent' ? event.campaignId : event.outcome.campaignId;
    const current = states.get(campaignId);
    const pinned = pins.get(campaignId);
    if (!current || !pinned) throw new Error('Controller event names an unenrolled campaign');
    if (event.kind === 'intent') {
      if (current.state !== 'pending' || intents.has(campaignId) || event.at >= first.enrollment.deadlineAt ||
          [...states.values()].filter((item) => item.state === 'in-flight').length >= first.enrollment.definition.maxParallel ||
          portfolioControllerPrerequisites(first.enrollment, campaignId).some((dependency) => states.get(dependency)?.state !== 'completed')) {
        throw new Error('Controller dispatch intent is not admissible');
      }
      intents.add(campaignId);
      states.set(campaignId, { ...current, state: 'in-flight', attempted: pinned.dispatch === 'campaign', reasonCode: 'reconciliation-required' });
    } else {
      if (current.state !== 'in-flight' || settlements.has(campaignId) || event.outcome.attempted !== current.attempted ||
          event.outcome.state === 'completed' && first.enrollment.deliveryPlan?.deliveries.some((row) => row.campaignId === campaignId) && event.outcome.deliveryDigest === null ||
          event.outcome.deliveryDigest !== null && !first.enrollment.deliveryPlan?.deliveries.some((row) => row.campaignId === campaignId)) {
        throw new Error('Controller settlement does not match dispatch intent');
      }
      settlements.set(campaignId, event); states.set(campaignId, event.outcome);
    }
  }
  return { first, highWaterAt, pins, intents, settlements, states };
}

export function readPortfolioControllerEvents(directory: string): PortfolioControllerEvent[] {
  inspectPrivateDirectory(directory);
  const result = readImmutablePrivateRecords(config(directory), { requireComplete: true });
  if (!result.complete || result.sourceState !== 'healthy') throw new Error('Controller evidence is unavailable');
  const records = result.records.sort((a, b) => a.sequence - b.sequence);
  foldPortfolioController(records);
  return records;
}

/** Called only under the controller execution lease; every effect has settlement capacity reserved. */
export function appendPortfolioControllerEvent(directory: string,
  input: Omit<Extract<PortfolioControllerEvent, { kind: 'created' }>, 'id' | 'sequence'> |
    Omit<Extract<PortfolioControllerEvent, { kind: 'observed' }>, 'id' | 'sequence'> |
    Omit<Extract<PortfolioControllerEvent, { kind: 'intent' }>, 'id' | 'sequence'> |
    Omit<Extract<PortfolioControllerEvent, { kind: 'settled' }>, 'id' | 'sequence'>): PortfolioControllerEvent[] {
  let records: PortfolioControllerEvent[] = [];
  try { lstatSync(join(directory, 'ledger')); records = readPortfolioControllerEvents(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const event = { ...input, sequence: records.length, id: String(records.length).padStart(8, '0') } as PortfolioControllerEvent;
  const next = [...records, event];
  const folded = foldPortfolioController(next);
  const reserved = [...folded.states.values()].reduce((count, item) => count + (item.state === 'pending' ? 2 : item.state === 'in-flight' ? 1 : 0), 0);
  if (next.length + reserved > MAX_EVENTS || next.reduce((bytes, row) => bytes + Buffer.byteLength(codec.serialize(row)), 0) + reserved * EVENT_BYTES > MAX_BYTES) {
    throw new Error('Controller evidence capacity exhausted');
  }
  const disposition = writeImmutablePrivateRecord(config(directory), event);
  if (disposition !== 'recorded' && disposition !== 'replayed') throw new Error('Controller event could not be durably recorded');
  return next;
}
