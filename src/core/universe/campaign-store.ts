import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import {
  readImmutablePrivateRecordPoint, readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { canonical, defaultUniverseRoot, digest, ensureUniverseRoot, inspectPrivateDirectory, privateDirectory } from './artifacts.js';
import { projectUniverse, scheduledVariants, universePath } from './store.js';
import type {
  UniverseCampaignDefinition, UniverseCampaignStep, UniverseCampaignSummary, UniverseStoreOptions, UniverseSummary,
} from './types.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_EVENTS = 2_048;
export type CampaignOwner = { pid: number; startRef: string };
type SettledState = 'paused' | 'stopped' | 'completed' | 'interrupted' | 'failed';
export type CampaignEventInput =
  { kind: 'created'; definition: UniverseCampaignDefinition; definitionDigest: string; manifestDigest: string; comparatorDigest: string; at: string } |
  { kind: 'started'; at: string; deadlineAt: string; owner: CampaignOwner } |
  { kind: 'step'; at: string; ordinal: number; runId: string; generation: number; variantIds: string[]; reservedModelRequests: number } |
  { kind: 'control'; at: string; action: 'pause' | 'stop' } |
  { kind: 'settled'; at: string; state: SettledState; reason: string };
export type CampaignEvent = CampaignEventInput & { id: string; sequence: number };
type CreatedEvent = Extract<CampaignEvent, { kind: 'created' }>;
type StepEvent = Extract<CampaignEvent, { kind: 'step' }>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function integer(value: unknown, low: number, high: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;
}
function iso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function identifier(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }

export function validateUniverseCampaignDefinition(value: unknown): UniverseCampaignDefinition {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'universeId', 'budget', 'feedback']) ||
      value.schemaVersion !== 1 || !identifier(value.id) || !identifier(value.universeId) || typeof value.feedback !== 'boolean' ||
      !object(value.budget) || !exact(value.budget, ['maxGenerations', 'maxDurationMs', 'maxModelRequests', 'maxStagnantGenerations', 'maxReportedTokens']) ||
      !integer(value.budget.maxGenerations, 1, 128) || !integer(value.budget.maxDurationMs, 1, 86_400_000) ||
      !integer(value.budget.maxModelRequests, 0, 8_192) || !integer(value.budget.maxStagnantGenerations, 1, 128) ||
      !(value.budget.maxReportedTokens === null || integer(value.budget.maxReportedTokens, 1, Number.MAX_SAFE_INTEGER))) {
    throw new Error('Invalid Universe campaign: bounded identity, generation/time/request/stagnation budgets and explicit feedback required');
  }
  return JSON.parse(canonical(value)) as UniverseCampaignDefinition;
}

function parseEvent(value: unknown): CampaignEvent | null {
  if (!object(value) || !integer(value.sequence, 0, MAX_EVENTS - 1) || value.id !== String(value.sequence).padStart(8, '0') || !iso(value.at)) return null;
  const shared = ['id', 'sequence', 'kind', 'at'];
  if (value.kind === 'created') {
    try {
      const definition = validateUniverseCampaignDefinition(value.definition);
      if (value.sequence !== 0 || !exact(value, [...shared, 'definition', 'definitionDigest', 'manifestDigest', 'comparatorDigest']) ||
          value.definitionDigest !== digest(canonical(definition)) || !hash(value.manifestDigest) || !hash(value.comparatorDigest)) return null;
    } catch { return null; }
  } else if (value.kind === 'started') {
    if (!exact(value, [...shared, 'deadlineAt', 'owner']) || !iso(value.deadlineAt) || !object(value.owner) ||
        !exact(value.owner, ['pid', 'startRef']) || !integer(value.owner.pid, 1, 2 ** 31 - 1) ||
        typeof value.owner.startRef !== 'string' || value.owner.startRef.length < 1 || value.owner.startRef.length > 64) return null;
  } else if (value.kind === 'step') {
    if (!exact(value, [...shared, 'ordinal', 'runId', 'generation', 'variantIds', 'reservedModelRequests']) ||
        !integer(value.ordinal, 1, 128) || typeof value.runId !== 'string' || !UUID.test(value.runId) ||
        !integer(value.generation, 1, 10_000) || !Array.isArray(value.variantIds) || value.variantIds.length < 1 || value.variantIds.length > 64 ||
        !value.variantIds.every(identifier) || new Set(value.variantIds).size !== value.variantIds.length ||
        !integer(value.reservedModelRequests, 0, value.variantIds.length)) return null;
  } else if (value.kind === 'control') {
    if (!exact(value, [...shared, 'action']) || !['pause', 'stop'].includes(String(value.action))) return null;
  } else if (value.kind === 'settled') {
    if (!exact(value, [...shared, 'state', 'reason']) || !['paused', 'stopped', 'completed', 'interrupted', 'failed'].includes(String(value.state)) ||
        typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1_024 || value.reason.includes('\0')) return null;
  } else return null;
  return value as unknown as CampaignEvent;
}

const codec: ImmutablePrivateRecordCodec<CampaignEvent> = {
  parse: parseEvent, serialize: (value) => `${canonical(value)}\n`, recordId: (value) => value.id,
  recordFileName: (value) => `${value.id}.json`, isRecordFileName: (name) => /^\d{8}\.json$/.test(name),
  stageToken: (value) => digest(canonical(value)), equivalent: (a, b) => canonical(a) === canonical(b),
  compare: (a, b) => a.sequence - b.sequence,
};
function config(directory: string): ImmutablePrivateRecordStoreConfig<CampaignEvent> {
  return { label: 'Universe campaign', anchorPath: directory, rootPath: join(directory, 'ledger'), lockFileName: '.records.lock',
    maxRecordBytes: 32 * 1024, defaultMaxFiles: MAX_EVENTS, hardMaxFiles: MAX_EVENTS,
    defaultMaxBytes: 8 * 1024 * 1024, hardMaxBytes: 8 * 1024 * 1024, codecForRead: () => codec, codecForWrite: () => codec };
}
export function campaignDirectory(id: string, options: UniverseStoreOptions = {}): string {
  if (!identifier(id)) throw new Error('Invalid Universe campaign id');
  return join(resolve(options.root ?? defaultUniverseRoot()), 'campaigns', id);
}
export function terminalCampaign(state: UniverseCampaignSummary['state']): boolean {
  return state === 'stopped' || state === 'completed' || state === 'failed';
}

/** PID reuse or an unavailable start probe must never imply permission to steal a live owner. */
export function campaignOwnerAlive(owner: CampaignOwner): boolean {
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function readCampaignEvents(directory: string): CampaignEvent[] {
  inspectPrivateDirectory(directory);
  const result = readImmutablePrivateRecords(config(directory), { requireComplete: true });
  if (!result.complete || result.sourceState !== 'healthy') throw new Error(`Campaign evidence unavailable: ${result.stopReasons.join(', ') || result.sourceState}`);
  const records = result.records.sort((a, b) => a.sequence - b.sequence);
  foldCampaignEvents(records);
  return records;
}

export function foldCampaignEvents(records: CampaignEvent[]): {
  created: CreatedEvent; state: UniverseCampaignSummary['state']; reason: string | null;
  owner: CampaignOwner | null; startedAt: string | null; deadlineAt: string | null; finishedAt: string | null; steps: StepEvent[];
} {
  const created = records[0];
  if (!created || created.kind !== 'created' || records.some((event, index) => event.sequence !== index || !parseEvent(event))) {
    throw new Error('Campaign event sequence contains invalid records, duplicates, or gaps');
  }
  let state: UniverseCampaignSummary['state'] = 'ready';
  let reason: string | null = null;
  let owner: CampaignOwner | null = null;
  let startedAt: string | null = null;
  let deadlineAt: string | null = null;
  let finishedAt: string | null = null;
  const steps: StepEvent[] = [];
  let reserved = 0;
  for (const event of records.slice(1)) {
    if (terminalCampaign(state)) throw new Error('Campaign terminal history cannot be extended');
    if (event.kind === 'started') {
      if (!['ready', 'paused', 'interrupted'].includes(state)) throw new Error('Campaign session started from an invalid state');
      if (startedAt === null) {
        startedAt = event.at;
        deadlineAt = new Date(Date.parse(event.at) + created.definition.budget.maxDurationMs).toISOString();
      }
      if (event.deadlineAt !== deadlineAt) throw new Error('Campaign deadline cannot be reset on resume');
      state = 'running'; owner = event.owner; reason = null; finishedAt = null;
    } else if (event.kind === 'step') {
      if (state !== 'running' || !owner || event.ordinal !== steps.length + 1 ||
          steps.some((step) => step.runId === event.runId) || event.ordinal > created.definition.budget.maxGenerations ||
          reserved + event.reservedModelRequests > created.definition.budget.maxModelRequests) throw new Error('Campaign dispatch exceeds its identity or reserved budget');
      steps.push(event); reserved += event.reservedModelRequests;
    } else if (event.kind === 'control') {
      if (state === 'stop-requested') throw new Error('A stop request cannot be replaced');
      state = event.action === 'stop' ? 'stop-requested' : 'pause-requested';
      reason = event.action === 'stop' ? 'Stop requested by owner' : 'Pause requested by owner';
    } else if (event.kind === 'settled') {
      if ((state === 'stop-requested' && event.state !== 'stopped') ||
          (state === 'pause-requested' && event.state !== 'paused' && event.state !== 'stopped')) throw new Error('Campaign settlement ignored a durable control request');
      state = event.state; reason = event.reason; owner = null; finishedAt = event.at;
    } else throw new Error('Campaign definition cannot be replaced');
  }
  return { created, state, reason, owner, startedAt, deadlineAt, finishedAt, steps };
}

/** Short transaction lock is separate from the entire campaign execution lease. */
export function appendCampaignEvent(directory: string, input: CampaignEventInput): CampaignEvent[] {
  inspectPrivateDirectory(directory);
  const lock = acquireLocalStoreLock(join(directory, '.control.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
  if (!lock) throw new Error('Campaign control transaction is busy');
  try {
    let records: CampaignEvent[] = [];
    try { lstatSync(join(directory, 'ledger')); records = readCampaignEvents(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (records.length >= MAX_EVENTS) throw new Error('Campaign evidence capacity exhausted');
    const event = { ...input, sequence: records.length, id: String(records.length).padStart(8, '0') } as CampaignEvent;
    const next = [...records, event];
    foldCampaignEvents(next);
    const disposition = writeImmutablePrivateRecord(config(directory), event);
    if (!['recorded', 'replayed'].includes(disposition)) throw new Error(`Campaign evidence write ${disposition}`);
    return next;
  } finally { releaseLocalStoreLock(lock); }
}

export function projectCampaign(records: CampaignEvent[], universe: UniverseSummary): UniverseCampaignSummary {
  const folded = foldCampaignEvents(records);
  const { created } = folded;
  const reasons: string[] = [];
  if (universe.sourceState !== 'healthy') reasons.push(...universe.reasons);
  if (universe.manifest.id !== created.definition.universeId || universe.manifestDigest !== created.manifestDigest ||
      universe.comparatorDigest !== created.comparatorDigest) reasons.push('Campaign pinned Universe identity changed');
  const alive = folded.owner !== null && campaignOwnerAlive(folded.owner);
  const state = folded.state === 'running' && !alive ? 'interrupted' : folded.state;
  const latestSession = [...records].reverse().find((event) => event.kind === 'started')?.sequence ?? -1;
  let recordedTokens = 0;
  let usageComplete = true;
  let stagnantGenerations = 0;
  const steps: UniverseCampaignStep[] = folded.steps.map((step, index) => {
    const scheduled = scheduledVariants(universe.manifest, step.generation).slice(0, step.variantIds.length);
    if (canonical(scheduled.map((variant) => variant.id)) !== canonical(step.variantIds) ||
        scheduled.filter((variant) => !!variant.generation).length !== step.reservedModelRequests) reasons.push('Campaign step does not match its reserved variant schedule');
    const run = universe.runs.find((item) => item.id === step.runId);
    const previous = folded.steps[index - 1];
    if (previous) {
      const previousRun = universe.runs.find((item) => item.id === previous.runId);
      if (step.generation !== previous.generation + (previousRun ? 1 : 0)) reasons.push('Campaign generation sequence contains unexpected interleaving');
    }
    if (run && (run.generation !== step.generation || run.campaign?.id !== created.definition.id ||
        run.campaign?.ordinal !== step.ordinal || run.campaign?.definitionDigest !== created.definitionDigest ||
        Boolean(run.feedbackEnabled) !== created.definition.feedback ||
        new Set(run.trials.map((trial) => trial.variantId)).size !== run.trials.length ||
        run.trials.some((trial) => !step.variantIds.includes(trial.variantId)) ||
        (run.status === 'completed' && run.trials.length !== step.variantIds.length))) reasons.push('Campaign run does not match its durable step intent');
    if (!run && universe.runs.some((item) => item.generation === step.generation && !folded.steps.some((later) =>
      later.ordinal > step.ordinal && later.generation === step.generation && later.runId === item.id &&
      item.campaign?.id === created.definition.id && item.campaign?.ordinal === later.ordinal &&
      item.campaign?.definitionDigest === created.definitionDigest))) reasons.push('Another run occupied a reserved campaign generation');
    const admissions = run?.status === 'completed' ? run.trials.filter((trial) => trial.selected && trial.delta === null).length : 0;
    const improvements = run?.status === 'completed' ? run.trials.filter((trial) => trial.selected && trial.delta !== null && trial.delta > 0).length : 0;
    if (run?.status === 'completed') stagnantGenerations = admissions + improvements > 0 ? 0 : stagnantGenerations + 1;
    for (const trial of run?.trials ?? []) {
      if (trial.generation?.usage.state === 'reported') recordedTokens += trial.generation.usage.inputTokens! + trial.generation.usage.outputTokens!;
    }
    if (step.reservedModelRequests > 0 && (!run || run.status !== 'completed' || run.trials.length !== step.variantIds.length ||
        run.trials.some((trial) => trial.generation?.requestStarted && trial.generation.usage.state !== 'reported'))) usageComplete = false;
    return { ordinal: step.ordinal, runId: step.runId, generation: step.generation, variantIds: step.variantIds,
      reservedModelRequests: step.reservedModelRequests, createdAt: step.at,
      state: run?.status ?? (alive && folded.state === 'running' && step.sequence > latestSession && index === folded.steps.length - 1 ? 'pending' : 'interrupted'),
      trialCount: run?.trials.length ?? 0, passedTrials: run?.trials.filter((trial) => trial.status === 'passed').length ?? 0,
      admissions, improvements, tokensUsed: run?.tokensUsed ?? null };
  });
  if (!Number.isSafeInteger(recordedTokens)) { reasons.push('Campaign token accounting exceeds safe integer bounds'); usageComplete = false; recordedTokens = 0; }
  if (universe.runs.some((run) => run.campaign?.id === created.definition.id && !steps.some((step) => step.runId === run.id))) reasons.push('Campaign has run evidence without a durable step intent');
  return { definition: created.definition, definitionDigest: created.definitionDigest, manifestDigest: created.manifestDigest,
    comparatorDigest: created.comparatorDigest, createdAt: created.at, state,
    reason: state === 'interrupted' && folded.state === 'running' ? 'Campaign owner exited before settlement' : folded.reason,
    startedAt: folded.startedAt, deadlineAt: folded.deadlineAt, finishedAt: folded.finishedAt, steps,
    progress: { attempts: steps.length, completedRuns: steps.filter((step) => step.state === 'completed').length,
      interruptedRuns: steps.filter((step) => step.state === 'interrupted').length,
      reservedModelRequests: steps.reduce((sum, step) => sum + step.reservedModelRequests, 0),
      reportedTokens: usageComplete ? recordedTokens : null, recordedTokens, usageComplete,
      admissions: steps.reduce((sum, step) => sum + step.admissions, 0), improvements: steps.reduce((sum, step) => sum + step.improvements, 0), stagnantGenerations },
    owner: alive ? folded.owner : null, sourceState: reasons.length ? 'degraded' : 'healthy', reasons };
}

export function campaignUniverse(summary: Pick<UniverseCampaignSummary, 'definition'>, options: UniverseStoreOptions = {}): UniverseSummary {
  return projectUniverse(universePath(resolve(options.root ?? defaultUniverseRoot()), summary.definition.universeId));
}

export function readUniverseCampaign(id: string, options: UniverseStoreOptions = {}): UniverseCampaignSummary {
  const directory = campaignDirectory(id, options);
  inspectPrivateDirectory(directory);
  try {
    const records = readCampaignEvents(directory);
    const created = foldCampaignEvents(records).created;
    if (created.definition.id !== id) throw new Error('Campaign definition id does not match its storage slot');
    return projectCampaign(records, campaignUniverse(created, options));
  } catch (error) {
    // A damaged history is never a fresh campaign with a fresh resource budget.
    const first = readImmutablePrivateRecordPoint(config(directory), '00000000', '00000000.json').record;
    if (first?.kind !== 'created' || first.definition.id !== id) throw error;
    const emptyUniverse: UniverseSummary = { manifest: { id: first.definition.universeId } as UniverseSummary['manifest'],
      manifestDigest: first.manifestDigest, comparatorDigest: first.comparatorDigest, runs: [], elites: [], activeRun: null, sourceState: 'healthy', reasons: [] };
    const summary = projectCampaign([first], emptyUniverse);
    return { ...summary, state: 'failed', reason: 'Campaign evidence is degraded', sourceState: 'degraded',
      reasons: [error instanceof Error ? error.message : 'Campaign evidence unavailable'],
      progress: { ...summary.progress, reportedTokens: null, usageComplete: false } };
  }
}

export function readUniverseCampaigns(options: UniverseStoreOptions = {}): {
  campaigns: UniverseCampaignSummary[]; sourceState: 'missing' | 'healthy' | 'degraded'; reasons: string[];
} {
  const directory = join(resolve(options.root ?? defaultUniverseRoot()), 'campaigns');
  const campaigns: UniverseCampaignSummary[] = [];
  const reasons: string[] = [];
  try {
    try { lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { campaigns, sourceState: 'missing', reasons }; throw error; }
    inspectPrivateDirectory(directory);
    const names = readdirSync(directory).sort();
    if (names.length > 64) throw new Error('Campaign inventory limit exceeded');
    for (const id of names) {
      try { const summary = readUniverseCampaign(id, options); campaigns.push(summary); if (summary.sourceState !== 'healthy') reasons.push(`${id}: ${summary.reasons.join('; ')}`); }
      catch (error) { reasons.push(`${id}: ${error instanceof Error ? error.message : 'Unreadable campaign'}`); }
    }
  } catch (error) { reasons.push(error instanceof Error ? error.message : 'Campaign inventory unavailable'); }
  return { campaigns, sourceState: reasons.length ? 'degraded' : 'healthy', reasons };
}

export function initUniverseCampaign(input: UniverseCampaignDefinition, options: UniverseStoreOptions = {}): UniverseCampaignSummary {
  const definition = validateUniverseCampaignDefinition(input);
  const root = resolve(options.root ?? defaultUniverseRoot());
  const universe = projectUniverse(universePath(root, definition.universeId));
  if (universe.sourceState !== 'healthy') throw new Error('Cannot create a campaign for degraded Universe evidence');
  const definitionDigest = digest(canonical(definition));
  ensureUniverseRoot(root);
  privateDirectory(join(root, 'campaigns'));
  const directory = privateDirectory(campaignDirectory(definition.id, { root }));
  try {
    lstatSync(join(directory, 'ledger'));
    const existing = readUniverseCampaign(definition.id, { root });
    if (existing.sourceState !== 'healthy') throw new Error('Existing campaign evidence is degraded');
    if (existing.definitionDigest !== definitionDigest || existing.manifestDigest !== universe.manifestDigest || existing.comparatorDigest !== universe.comparatorDigest) {
      throw new Error('Campaign definition is immutable; choose a new campaign id');
    }
    return existing;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  appendCampaignEvent(directory, { kind: 'created', definition, definitionDigest, manifestDigest: universe.manifestDigest,
    comparatorDigest: universe.comparatorDigest, at: new Date().toISOString() });
  return readUniverseCampaign(definition.id, { root });
}

export function requestUniverseCampaignControl(id: string, action: 'pause' | 'stop', options: UniverseStoreOptions = {}): UniverseCampaignSummary {
  if (action !== 'pause' && action !== 'stop') throw new Error('Invalid campaign control action');
  const summary = readUniverseCampaign(id, options);
  if (summary.sourceState !== 'healthy') throw new Error('Cannot control degraded campaign evidence');
  if (terminalCampaign(summary.state) || summary.state === 'stop-requested' || (action === 'pause' && ['paused', 'pause-requested'].includes(summary.state))) return summary;
  const directory = campaignDirectory(id, options);
  const records = appendCampaignEvent(directory, { kind: 'control', action, at: new Date().toISOString() });
  const currentOwner = foldCampaignEvents(records).owner;
  if (!currentOwner || !campaignOwnerAlive(currentOwner)) {
    appendCampaignEvent(directory, { kind: 'settled', state: action === 'stop' ? 'stopped' : 'paused',
      at: new Date().toISOString(), reason: action === 'stop' ? 'Stopped by owner' : 'Paused by owner' });
  }
  return readUniverseCampaign(id, options);
}
