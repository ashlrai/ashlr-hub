import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonical, defaultUniverseRoot, digest, inspectPrivateDirectory } from './artifacts.js';
import { validateUniverseCampaignDeliveryPlan } from './campaign-delivery.js';
import { validateUniversePortfolioDefinition } from './portfolio-plan.js';
import type { PortfolioControllerEnrollment, PortfolioControllerEvent, PortfolioControllerPin,
  UniversePortfolioControllerOutcome, UniversePortfolioControllerControl, UniversePortfolioControllerControlReceipt } from './portfolio-controller-types.js';
import type { UniverseStoreOptions } from './types.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const DISPATCH_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
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
function sequence(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < MAX_EVENTS; }

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
  } else if (value.kind === 'control') {
    if (value.action === 'drain') {
      if (!exact(value, [...shared, 'action'])) return null;
    } else if (value.action !== 'resume' || !exact(value, [...shared, 'action', 'drainSequence']) || !sequence(value.drainSequence)) return null;
  } else if (value.kind === 'drained') {
    if (!exact(value, [...shared, 'drainSequence']) || !sequence(value.drainSequence)) return null;
  } else if (value.kind === 'intent') {
    const hasDispatch = Object.hasOwn(value, 'dispatchId');
    if (!exact(value, [...shared, 'campaignId', ...(hasDispatch ? ['dispatchId'] : [])]) || !id(value.campaignId) ||
        hasDispatch && (typeof value.dispatchId !== 'string' || !DISPATCH_ID.test(value.dispatchId))) return null;
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
  const dispatchIds = new Set<string>();
  const intentEvents = new Map<string, Extract<PortfolioControllerEvent, { kind: 'intent' }>>();
  const settlements = new Map<string, Extract<PortfolioControllerEvent, { kind: 'settled' }>>();
  for (const item of pins.values()) states.set(item.campaignId, { campaignId: item.campaignId, state: item.initialState,
    attempted: false, reasonCode: item.reasonCode, campaignDigest: item.campaignDigest, deliveryDigest: null });
  let highWaterAt = first.at;
  let control: UniversePortfolioControllerControl | undefined;
  for (const [index, event] of records.entries()) {
    if (!parse(event) || event.sequence !== index || event.at < highWaterAt) throw new Error('Controller event history is invalid');
    highWaterAt = event.at;
    if (index === 0) continue;
    if (event.kind === 'created') throw new Error('Controller registration cannot be replaced');
    if (event.kind === 'observed') continue;
    if (event.kind === 'control') {
      if (event.action === 'drain') {
        if (control?.mode === 'drain') throw new Error('Controller drain is already requested');
        control = { mode: 'drain', sequence: event.sequence, requestedAt: event.at, acknowledgedAt: null };
      } else {
        if (control?.mode !== 'drain' || control.sequence !== event.drainSequence || control.acknowledgedAt === null) {
          throw new Error('Controller resume requires the exact acknowledged drain');
        }
        control = { mode: 'open', sequence: event.sequence, requestedAt: event.at, acknowledgedAt: null };
      }
      continue;
    }
    if (event.kind === 'drained') {
      if (control?.mode !== 'drain' || control.sequence !== event.drainSequence || control.acknowledgedAt !== null ||
          [...states.values()].some((item) => item.state === 'in-flight')) throw new Error('Controller drain acknowledgement is not admissible');
      control = { ...control, acknowledgedAt: event.at };
      continue;
    }
    const campaignId = event.kind === 'intent' ? event.campaignId : event.outcome.campaignId;
    const current = states.get(campaignId);
    const pinned = pins.get(campaignId);
    if (!current || !pinned) throw new Error('Controller event names an unenrolled campaign');
    if (event.kind === 'intent') {
      if (control?.mode === 'drain') throw new Error('Controller history admits work after drain');
      if (current.state !== 'pending' || intents.has(campaignId) || event.at >= first.enrollment.deadlineAt ||
          event.dispatchId !== undefined && (pinned.dispatch !== 'campaign' || dispatchIds.has(event.dispatchId)) ||
          [...states.values()].filter((item) => item.state === 'in-flight').length >= first.enrollment.definition.maxParallel ||
          portfolioControllerPrerequisites(first.enrollment, campaignId).some((dependency) => states.get(dependency)?.state !== 'completed')) {
        throw new Error('Controller dispatch intent is not admissible');
      }
      intents.add(campaignId);
      intentEvents.set(campaignId, event);
      if (event.dispatchId !== undefined) dispatchIds.add(event.dispatchId);
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
  return { first, highWaterAt, pins, intents, intentEvents, settlements, states, ...(control ? { control } : {}) };
}

export function readPortfolioControllerEvents(directory: string): PortfolioControllerEvent[] {
  inspectPrivateDirectory(directory);
  const result = readImmutablePrivateRecords(config(directory), { requireComplete: true });
  if (!result.complete || result.sourceState !== 'healthy') throw new Error('Controller evidence is unavailable');
  const records = result.records.sort((a, b) => a.sequence - b.sequence);
  foldPortfolioController(records);
  return records;
}

export class PortfolioControllerTransactionBusyError extends Error {}
export class PortfolioControllerDrainError extends Error {}

const transactions = new Set<string>();

/** Short non-reentrant transaction. Never retain this lock over asynchronous work. */
export function withPortfolioControllerTransaction<T>(directory: string, operation: () => T): T {
  inspectPrivateDirectory(directory);
  if (transactions.has(directory)) throw new Error('Controller transactions must not nest');
  const acquired = acquireLocalStoreLockWithOutcome(join(directory, '.control.lock'), 0,
    { anchorPath: directory, exactPrivateStorage: true });
  if (acquired.state === 'contended') throw new PortfolioControllerTransactionBusyError('Controller transaction is busy');
  if (acquired.state !== 'acquired') throw new Error('Controller transaction ownership unavailable');
  transactions.add(directory);
  let result: T;
  let released = false;
  try {
    if (!ownsLocalStoreLock(acquired.lock)) throw new Error('Controller transaction ownership lost');
    result = operation();
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
      throw new Error('Controller transactions must be synchronous');
    }
    if (!ownsLocalStoreLock(acquired.lock)) throw new Error('Controller transaction ownership lost');
  } finally {
    transactions.delete(directory);
    released = releaseLocalStoreLock(acquired.lock);
  }
  if (!released) throw new Error('Controller transaction ownership release failed');
  return result;
}

function assertExpectedRecords(records: PortfolioControllerEvent[], expected: PortfolioControllerEvent[]): void {
  if (records.length < expected.length || canonical(records.slice(0, expected.length)) !== canonical(expected) ||
      records.slice(expected.length).some((event) => event.kind !== 'control')) {
    throw new Error('Controller ledger changed outside owner control');
  }
}

/** Accept only valid owner controls appended after the caller's unchanged checkpoint. */
export function refreshPortfolioControllerEvents(directory: string, expected: PortfolioControllerEvent[]): PortfolioControllerEvent[] {
  return withPortfolioControllerTransaction(directory, () => {
    const records = readPortfolioControllerEvents(directory);
    assertExpectedRecords(records, expected);
    return records;
  });
}

type EventInput<T = PortfolioControllerEvent> = T extends PortfolioControllerEvent ? Omit<T, 'id' | 'sequence'> : never;

function appendUnlocked(directory: string, records: PortfolioControllerEvent[], input: EventInput,
  beforeIntent?: (records: readonly PortfolioControllerEvent[]) => void): PortfolioControllerEvent[] {
  // Only refusal of a new admission is a drain outcome. An already-invalid
  // history remains an evidence failure, never a successfully observed drain.
  if (input.kind === 'intent' && records.length && foldPortfolioController(records).control?.mode === 'drain') {
    throw new PortfolioControllerDrainError('Controller admission is drained');
  }
  if (beforeIntent !== undefined) {
    if (input.kind !== 'intent' || typeof beforeIntent !== 'function') throw new Error('Controller intent check is invalid');
    const checked: unknown = beforeIntent(records);
    if (checked !== null && (typeof checked === 'object' || typeof checked === 'function') && 'then' in checked) {
      void Promise.resolve(checked).catch(() => undefined);
      throw new Error('Controller intent check must be synchronous');
    }
    if (checked !== undefined) throw new Error('Controller intent check must return no value');
  }
  const event = { ...input, sequence: records.length, id: String(records.length).padStart(8, '0') } as PortfolioControllerEvent;
  const next = [...records, event];
  const folded = foldPortfolioController(next);
  // Admission/observation must not consume the final owner's drain and ACK
  // slots. A resume must establish this reserve again before reopening work.
  const controlReserve = folded.control?.mode === 'drain' ? folded.control.acknowledgedAt === null ? 1 : 0 : 2;
  const settlementReserve = [...folded.states.values()].reduce((count, item) =>
    count + (item.state === 'pending' ? 2 : item.state === 'in-flight' ? 1 : 0), 0);
  const bytes = next.reduce((count, row) => count + Buffer.byteLength(codec.serialize(row)), 0);
  const fits = (reserve: number): boolean => next.length + reserve <= MAX_EVENTS && bytes + reserve * EVENT_BYTES <= MAX_BYTES;
  // Legacy histories did not reserve control headroom. Never strand their
  // already-admitted settlement; this exception cannot admit any new work.
  const legacySettlement = input.kind === 'settled' && folded.control === undefined;
  if (!fits(settlementReserve + controlReserve) && !(legacySettlement && fits(settlementReserve))) {
    throw new Error('Controller evidence capacity exhausted');
  }
  const disposition = writeImmutablePrivateRecord(config(directory), event);
  if (disposition !== 'recorded' && disposition !== 'replayed') throw new Error('Controller event could not be durably recorded');
  return next;
}

/** Execution events require the caller's lifetime execution lease. Owner controls
 * share only this short transaction; final intent admission sees their exact order. */
export function appendPortfolioControllerEvent(directory: string, input: EventInput,
  options: { expectedRecords?: PortfolioControllerEvent[];
    /** Internal synchronous evidence check under the short lock, after drain refusal. */
    beforeIntent?: (records: readonly PortfolioControllerEvent[]) => void } = {}): PortfolioControllerEvent[] {
  return withPortfolioControllerTransaction(directory, () => {
    let records: PortfolioControllerEvent[];
    // Only creation may initialize an absent ledger. A missing nested directory
    // or damaged existing history must never become a fresh registration.
    let missing = false;
    try { lstatSync(join(directory, 'ledger')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing = true; }
    if (missing) {
      if (input.kind !== 'created') throw new Error('Controller registration is missing');
      records = [];
    } else records = readPortfolioControllerEvents(directory);
    if (options.expectedRecords) assertExpectedRecords(records, options.expectedRecords);
    return appendUnlocked(directory, records, input, options.beforeIntent);
  });
}

/** Persist a named control without acquiring execution ownership or starting work. */
export function requestUniversePortfolioControllerControl(controllerId: string, action: 'drain' | 'resume',
  options: UniverseStoreOptions & { expectedDrainSequence?: number } = {}): UniversePortfolioControllerControlReceipt {
  if (action !== 'drain' && action !== 'resume' || action === 'resume' && !sequence(options.expectedDrainSequence) ||
      action === 'drain' && options.expectedDrainSequence !== undefined) throw new Error('Invalid controller control request');
  const root = resolve(options.root ?? defaultUniverseRoot());
  const directory = portfolioControllerDirectory(controllerId, { root });
  inspectPrivateDirectory(root); inspectPrivateDirectory(join(root, 'portfolios')); inspectPrivateDirectory(directory);
  return withPortfolioControllerTransaction(directory, () => {
    const records = readPortfolioControllerEvents(directory);
    const folded = foldPortfolioController(records);
    if (folded.first.enrollment.definition.id !== controllerId) throw new Error('Controller identity changed');
    const current = folded.control;
    const lastControl = current === undefined ? undefined : records[current.sequence];
    const repeated = action === 'drain' ? current?.mode === 'drain' : current?.mode === 'open' &&
      lastControl?.kind === 'control' && lastControl.action === 'resume' && lastControl.drainSequence === options.expectedDrainSequence;
    if (repeated && current) return { schemaVersion: 1, controllerId, action, changed: false,
      sequence: current.sequence, requestedAt: current.requestedAt };
    const at = new Date().toISOString();
    const next = appendUnlocked(directory, records, action === 'drain' ? { kind: 'control', action, at } :
      { kind: 'control', action, at, drainSequence: options.expectedDrainSequence! });
    const event = next.at(-1)!;
    return { schemaVersion: 1, controllerId, action, changed: true, sequence: event.sequence, requestedAt: event.at };
  });
}
