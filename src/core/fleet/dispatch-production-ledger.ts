/**
 * dispatch-production-ledger.ts — append-only proposal-production outcome stream.
 *
 * Writes metadata-only rows to ~/.ashlr/dispatch-production/YYYY-MM-DD.jsonl
 * (or $ASHLR_HOME/dispatch-production). This is history/analytics, not the
 * cooldown ledger: never truncate, never rewrite, never throw.
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  DaemonDispatchProductionOutcome,
  EngineId,
  EngineTier,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  ProductionAttemptShape,
  RunActionCounts,
  RouteSnapshot,
  RunEventSummary,
  WorkItem,
} from '../types.js';
import { causalMetadata } from '../learning/causal.js';
import {
  addProductionAttemptShape,
  emptyProductionAttemptShape,
  hasProductionAttemptShape,
  productionAttemptShapeFromSignals,
} from '../learning/attempt-shape.js';
import { scrubSecrets } from '../util/scrub.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type DispatchProductionBasis =
  | 'run-proposal-outcome'
  | 'pending-proposal-delta'
  | 'best-of-n-summary'
  | 'unknown';

export interface DispatchProductionEvent {
  schemaVersion: 1;
  ts: string;
  machineId?: string;
  itemId: string;
  source: WorkItem['source'];
  repo: string;
  title: string;
  backend: EngineId | null;
  tier: EngineTier | null;
  model?: string | null;
  assignedBy: string;
  routeReason: string;
  outcome: DaemonDispatchProductionOutcome;
  proposalCreated: boolean;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  spentUsd: number;
  diffFiles?: number;
  diffLines?: number;
  reason?: string;
  basis: DispatchProductionBasis;
}

export interface DispatchProductionReasonCount {
  reason: string;
  count: number;
}

export interface DispatchProductionOutcomeCounts {
  proposalCreated: number;
  emptyDiff: number;
  gateBlocked: number;
  engineFailed: number;
  sandboxFailed: number;
  proposalCaptureError: number;
  proposalDisabled: number;
  unknown: number;
}

export interface DispatchProductionYieldBucket {
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  repo?: string;
  model?: string | null;
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts?: RunActionCounts;
  attemptShape?: ProductionAttemptShape;
  topReasons: DispatchProductionReasonCount[];
}

export interface DispatchProductionYieldSummary {
  windowHours: number;
  attempts: number;
  events: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts?: RunActionCounts;
  attemptShape?: ProductionAttemptShape;
  topReasons: DispatchProductionReasonCount[];
  byBackend: DispatchProductionYieldBucket[];
  bySource: DispatchProductionYieldBucket[];
  byRepo: DispatchProductionYieldBucket[];
  byBackendModel: DispatchProductionYieldBucket[];
}

export function dispatchProductionDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root =
    typeof configuredHome === 'string' && configuredHome.trim() !== ''
      ? configuredHome
      : join(homedir(), '.ashlr');
  return join(root, 'dispatch-production');
}

function eventDateString(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString().slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

function eventTimestamp(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function stripSecrets(value: string): string {
  return scrubSecrets(value);
}

function boundedText(value: string, max: number): string {
  const stripped = stripSecrets(value);
  return stripped.length > max ? `${stripped.slice(0, max - 3)}...` : stripped;
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return boundedText(value, max);
}

function boundedNullableText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return boundedOptionalText(value, max);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function sanitizeEvent(event: DispatchProductionEvent): DispatchProductionEvent {
  const ts = eventTimestamp(event.ts);
  const machineId = boundedOptionalText(event.machineId, 120);
  const itemId = boundedText(event.itemId, 240) || 'unknown';
  const source = boundedText(event.source, 80) as WorkItem['source'];
  const repo = boundedText(event.repo, 500) || 'unknown';
  const title = boundedText(event.title, 160) || 'untitled';
  const backend = boundedNullableText(event.backend, 80) as EngineId | null | undefined;
  const tier = boundedNullableText(event.tier, 40) as EngineTier | null | undefined;
  const model = boundedNullableText(event.model, 160) as string | null | undefined;
  const assignedBy = boundedText(event.assignedBy, 80) || 'unknown';
  const routeReason = boundedText(event.routeReason, 240) || 'unknown';
  const proposalId = boundedOptionalText(event.proposalId, 160);
  const runId = boundedOptionalText(event.runId, 160);
  const trajectoryId = boundedOptionalText(event.trajectoryId, 240);
  const routerPolicyVersion = boundedOptionalText(event.routerPolicyVersion, 80);
  const learningEpoch = boundedOptionalText(event.learningEpoch, 40);
  const outcome = boundedText(event.outcome, 80) as DaemonDispatchProductionOutcome;
  const basis = boundedText(event.basis, 80) as DispatchProductionBasis;
  const reason = boundedOptionalText(event.reason, 240);
  const diffFiles = finiteNonNegative(event.diffFiles);
  const diffLines = finiteNonNegative(event.diffLines);
  const spentUsd = finiteNonNegative(event.spentUsd) ?? 0;
  const causal = causalMetadata({
    ts,
    itemId,
    proposalId,
    runId,
    trajectoryId,
    routeSnapshot: event.routeSnapshot,
    runEventSummary: event.runEventSummary,
    evidenceOutcome: event.evidenceOutcome,
    learningSource: event.learningSource ?? 'daemon-dispatch',
    labelBasis: event.labelBasis ?? 'dispatch-outcome',
    routerPolicyVersion,
    learningEpoch,
  });
  return {
    schemaVersion: 1,
    ts,
    ...(machineId ? { machineId } : {}),
    itemId,
    source,
    repo,
    title,
    backend: backend ?? null,
    tier: tier ?? null,
    ...(model !== undefined ? { model } : {}),
    assignedBy,
    routeReason,
    outcome,
    proposalCreated: Boolean(event.proposalCreated),
    ...(proposalId ? { proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...causal,
    spentUsd,
    ...(diffFiles !== undefined ? { diffFiles } : {}),
    ...(diffLines !== undefined ? { diffLines } : {}),
    ...(reason ? { reason } : {}),
    basis,
  };
}

function isDispatchProductionEvent(value: unknown): value is DispatchProductionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['schemaVersion'] === 1 &&
    typeof obj['ts'] === 'string' &&
    typeof obj['itemId'] === 'string' &&
    typeof obj['source'] === 'string' &&
    typeof obj['repo'] === 'string' &&
    typeof obj['title'] === 'string' &&
    typeof obj['assignedBy'] === 'string' &&
    typeof obj['routeReason'] === 'string' &&
    typeof obj['outcome'] === 'string' &&
    typeof obj['proposalCreated'] === 'boolean' &&
    typeof obj['spentUsd'] === 'number' &&
    typeof obj['basis'] === 'string'
  );
}

export function recordDispatchProduction(
  input: DispatchProductionEvent | DispatchProductionEvent[],
): void {
  try {
    const events = Array.isArray(input) ? input : [input];
    if (events.length === 0) return;
    const dir = dispatchProductionDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const event of events) {
      try {
        const record = sanitizeEvent(event);
        appendFileSync(join(dir, `${eventDateString(record.ts)}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
      } catch {
        // Skip only this record; later records in the batch still get a chance.
      }
    }
  } catch {
    // Telemetry/history must never fail dispatch.
  }
}

export function readDispatchProductionEvents(opts?: {
  sinceMs?: number;
  limit?: number;
  maxFiles?: number;
}): DispatchProductionEvent[] {
  try {
    const dir = dispatchProductionDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl'))
      .sort()
      .reverse();
    const cap = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : Infinity;
    const maxFiles = opts?.maxFiles !== undefined && opts.maxFiles > 0 ? Math.floor(opts.maxFiles) : Infinity;
    const out: DispatchProductionEvent[] = [];
    let datedFilesRead = 0;
    let looseFilesRead = 0;
    for (const file of files) {
      if (out.length >= cap) break;
      if (opts?.sinceMs !== undefined && !fileMayContainSince(file, opts.sinceMs)) continue;
      const isDatedFile = DATE_LEDGER_FILE_RE.test(file);
      if (isDatedFile) {
        if (datedFilesRead >= maxFiles) continue;
        datedFilesRead++;
      } else {
        if (looseFilesRead >= 3) continue;
        looseFilesRead++;
      }
      let raw: string;
      try {
        raw = readFileSync(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n').reverse()) {
        if (out.length >= cap) break;
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isDispatchProductionEvent(parsed)) continue;
          if (opts?.sinceMs !== undefined) {
            const eventMs = Date.parse(parsed.ts);
            if (Number.isFinite(eventMs) && eventMs < opts.sinceMs) continue;
          }
          out.push(sanitizeEvent(parsed));
        } catch {
          // Malformed lines are skipped.
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function fileMayContainSince(file: string, sinceMs: number): boolean {
  const match = DATE_LEDGER_FILE_RE.exec(file);
  if (!match) return true;
  const endOfDayMs = Date.parse(`${match[1]}T23:59:59.999Z`);
  return !Number.isFinite(endOfDayMs) || endOfDayMs >= sinceMs;
}

function emptyOutcomeCounts(): DispatchProductionOutcomeCounts {
  return {
    proposalCreated: 0,
    emptyDiff: 0,
    gateBlocked: 0,
    engineFailed: 0,
    sandboxFailed: 0,
    proposalCaptureError: 0,
    proposalDisabled: 0,
    unknown: 0,
  };
}

const RUN_ACTION_COUNT_KEYS = [
  'sandboxCreated',
  'spawnAttempts',
  'transientRetries',
  'proposalCaptureAttempts',
  'completenessGateRuns',
  'verifyRepairAttempts',
  'modelSteps',
  'toolSteps',
  'totalSteps',
  'diffFiles',
  'diffLines',
  'proposalCreated',
  'proposalBlocked',
  'proposalDisabled',
] as const satisfies readonly (keyof RunActionCounts)[];

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function addRunActionCounts(target: RunActionCounts, source: RunActionCounts | undefined): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  const record = source as Record<string, unknown>;
  for (const key of RUN_ACTION_COUNT_KEYS) {
    const value = nonNegativeInteger(record[key]);
    if (value === undefined || value <= 0) continue;
    target[key] = Math.min((target[key] ?? 0) + value, Number.MAX_SAFE_INTEGER);
  }
}

function hasRunActionCounts(counts: RunActionCounts): boolean {
  return RUN_ACTION_COUNT_KEYS.some((key) => (counts[key] ?? 0) > 0);
}

function incrementOutcome(
  counts: DispatchProductionOutcomeCounts,
  outcome: DaemonDispatchProductionOutcome,
): void {
  switch (outcome) {
    case 'proposal-created':
      counts.proposalCreated++;
      break;
    case 'empty-diff':
      counts.emptyDiff++;
      break;
    case 'gate-blocked':
      counts.gateBlocked++;
      break;
    case 'engine-failed':
      counts.engineFailed++;
      break;
    case 'sandbox-failed':
      counts.sandboxFailed++;
      break;
    case 'proposal-capture-error':
      counts.proposalCaptureError++;
      break;
    case 'proposal-disabled':
      counts.proposalDisabled++;
      break;
    default:
      counts.unknown++;
      break;
  }
}

function sortedReasons(reasons: Map<string, number>, limit: number): DispatchProductionReasonCount[] {
  return [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

interface MutableYieldBucket {
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  repo?: string;
  model?: string | null;
  attempts: number;
  proposalsCreated: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts: RunActionCounts;
  attemptShape: ProductionAttemptShape;
  reasons: Map<string, number>;
}

function touchBucket(
  buckets: Map<string, MutableYieldBucket>,
  key: string,
  fields: Omit<Partial<MutableYieldBucket>, 'key' | 'attempts' | 'proposalsCreated' | 'spentUsd' | 'outcomes' | 'reasons'>,
): MutableYieldBucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      key,
      ...fields,
      attempts: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      outcomes: emptyOutcomeCounts(),
      actionCounts: {},
      attemptShape: emptyProductionAttemptShape(),
      reasons: new Map(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function addToBucket(bucket: MutableYieldBucket, event: DispatchProductionEvent): void {
  bucket.attempts++;
  if (event.proposalCreated) bucket.proposalsCreated++;
  bucket.spentUsd += Number.isFinite(event.spentUsd) ? event.spentUsd : 0;
  incrementOutcome(bucket.outcomes, event.outcome);
  addRunActionCounts(bucket.actionCounts, event.runEventSummary?.actionCounts);
  addProductionAttemptShape(bucket.attemptShape, productionAttemptShapeFromSignals({
    outcome: event.outcome,
    proposalCreated: event.proposalCreated,
    actionCounts: event.runEventSummary?.actionCounts,
  }));
  const reason = event.reason ?? event.routeReason ?? event.outcome;
  bucket.reasons.set(reason, (bucket.reasons.get(reason) ?? 0) + 1);
}

function finalizeBucket(bucket: MutableYieldBucket): DispatchProductionYieldBucket {
  const proposalsCreated = bucket.proposalsCreated;
  const attempts = bucket.attempts;
  return {
    key: bucket.key,
    ...(bucket.backend !== undefined ? { backend: bucket.backend } : {}),
    ...(bucket.source !== undefined ? { source: bucket.source } : {}),
    ...(bucket.repo !== undefined ? { repo: bucket.repo } : {}),
    ...(bucket.model !== undefined ? { model: bucket.model } : {}),
    attempts,
    proposalsCreated,
    noProposal: Math.max(0, attempts - proposalsCreated),
    proposalRate: attempts > 0 ? proposalsCreated / attempts : 0,
    spentUsd: bucket.spentUsd,
    outcomes: bucket.outcomes,
    ...(hasRunActionCounts(bucket.actionCounts) ? { actionCounts: bucket.actionCounts } : {}),
    ...(hasProductionAttemptShape(bucket.attemptShape) ? { attemptShape: bucket.attemptShape } : {}),
    topReasons: sortedReasons(bucket.reasons, 5),
  };
}

function sortedBuckets(buckets: Map<string, MutableYieldBucket>, limit: number): DispatchProductionYieldBucket[] {
  return [...buckets.values()]
    .map(finalizeBucket)
    .sort(
      (a, b) =>
        b.noProposal - a.noProposal ||
        a.proposalRate - b.proposalRate ||
        b.attempts - a.attempts ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}

export function summarizeDispatchProductionYield(
  events: DispatchProductionEvent[],
  opts?: {
    windowHours?: number;
    limitPerDimension?: number;
  },
): DispatchProductionYieldSummary | undefined {
  const limit = opts?.limitPerDimension !== undefined && opts.limitPerDimension > 0
    ? Math.floor(opts.limitPerDimension)
    : 8;
  if (events.length === 0) return undefined;

  const byBackend = new Map<string, MutableYieldBucket>();
  const bySource = new Map<string, MutableYieldBucket>();
  const byRepo = new Map<string, MutableYieldBucket>();
  const byBackendModel = new Map<string, MutableYieldBucket>();
  const topReasons = new Map<string, number>();
  const overall = emptyOutcomeCounts();
  const actionCounts: RunActionCounts = {};
  const attemptShape = emptyProductionAttemptShape();
  let proposalsCreated = 0;
  let spentUsd = 0;

  for (const event of events) {
    if (event.proposalCreated) proposalsCreated++;
    spentUsd += Number.isFinite(event.spentUsd) ? event.spentUsd : 0;
    incrementOutcome(overall, event.outcome);
    addRunActionCounts(actionCounts, event.runEventSummary?.actionCounts);
    addProductionAttemptShape(attemptShape, productionAttemptShapeFromSignals({
      outcome: event.outcome,
      proposalCreated: event.proposalCreated,
      actionCounts: event.runEventSummary?.actionCounts,
    }));
    const reason = event.reason ?? event.routeReason ?? event.outcome;
    topReasons.set(reason, (topReasons.get(reason) ?? 0) + 1);

    const backendKey = event.backend ?? 'unknown';
    addToBucket(touchBucket(byBackend, backendKey, { backend: event.backend }), event);

    const sourceKey = event.source;
    addToBucket(touchBucket(bySource, sourceKey, { source: event.source }), event);

    const repoKey = event.repo;
    addToBucket(touchBucket(byRepo, repoKey, { repo: event.repo }), event);

    const modelKey = `${event.backend ?? 'unknown'}:${event.model ?? 'default'}`;
    addToBucket(touchBucket(byBackendModel, modelKey, { backend: event.backend, model: event.model ?? null }), event);
  }

  const total = events.length;
  return {
    windowHours: opts?.windowHours ?? 24,
    attempts: total,
    events: total,
    proposalsCreated,
    noProposal: Math.max(0, total - proposalsCreated),
    proposalRate: total > 0 ? proposalsCreated / total : 0,
    spentUsd,
    outcomes: overall,
    ...(hasRunActionCounts(actionCounts) ? { actionCounts } : {}),
    ...(hasProductionAttemptShape(attemptShape) ? { attemptShape } : {}),
    topReasons: sortedReasons(topReasons, limit),
    byBackend: sortedBuckets(byBackend, limit),
    bySource: sortedBuckets(bySource, limit),
    byRepo: sortedBuckets(byRepo, limit),
    byBackendModel: sortedBuckets(byBackendModel, limit),
  };
}

export function readDispatchProductionYield(opts?: {
  windowMs?: number;
  limit?: number;
  limitPerDimension?: number;
}): DispatchProductionYieldSummary | undefined {
  const windowMs = opts?.windowMs ?? 24 * 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;
  const maxFiles = Math.max(1, Math.ceil(windowMs / DAY_MS) + 1);
  const events = readDispatchProductionEvents({
    sinceMs,
    limit: opts?.limit ?? 1000,
    maxFiles,
  });
  return summarizeDispatchProductionYield(events, {
    windowHours: windowMs / (60 * 60 * 1000),
    limitPerDimension: opts?.limitPerDimension,
  });
}
