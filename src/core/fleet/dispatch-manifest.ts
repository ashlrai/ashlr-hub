/**
 * dispatch-manifest.ts - append-only concurrent dispatch intent ledger.
 *
 * Records the bounded plan built before concurrent dispatch starts. This is
 * forensic intent only: it is not a queue, lease, retry source, or merge gate.
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonDispatchManifestSummary, EngineId, WorkItem } from '../types.js';
import type { DispatchPlan } from '../fabric/concurrent-dispatch.js';
import { scrubSecrets } from '../util/scrub.js';

const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_ITEMS = 24;
const MAX_TEXT = {
  machineId: 120,
  itemId: 240,
  repo: 500,
  title: 160,
  reason: 240,
  model: 160,
};

export interface DispatchManifestAssignment {
  itemId: string;
  attemptId?: string;
  source: WorkItem['source'];
  repo: string;
  title: string;
  backend: EngineId;
  routeReason?: string;
  model?: string | null;
}

export interface DispatchManifestUnassigned {
  itemId: string;
  reason: 'no-slots';
}

export interface DispatchManifestEvent {
  schemaVersion: 1;
  manifestId: string;
  ts: string;
  machineId?: string;
  mode: 'concurrent';
  dryRun: boolean;
  claimedItemIds: string[];
  assignments: DispatchManifestAssignment[];
  unassigned: DispatchManifestUnassigned[];
  slots: Record<string, number>;
  backendCounts: Record<string, number>;
  resourceSnapshotAt?: string;
  counts: {
    claimed: number;
    assigned: number;
    unassigned: number;
  };
}

export interface BuildDispatchManifestEventInput {
  ts: string;
  machineId?: string;
  plan: DispatchPlan;
  routeReasons?: ReadonlyMap<string, string>;
  routeModels?: ReadonlyMap<string, string | null>;
  attemptIds?: ReadonlyMap<string, string>;
  resourceSnapshotAt?: string;
  dryRun?: boolean;
}

export interface ReadDispatchManifestEventsOptions {
  limit?: number;
}

export function dispatchManifestDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root =
    typeof configuredHome === 'string' && configuredHome.trim() !== ''
      ? configuredHome
      : join(homedir(), '.ashlr');
  return join(root, 'dispatch-manifests');
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

function boundedText(value: unknown, max: number, fallback = ''): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const scrubbed = scrubSecrets(text);
  const trimmed = scrubbed.trim();
  const chosen = trimmed.length > 0 ? trimmed : fallback;
  return chosen.length > max ? `${chosen.slice(0, max - 3)}...` : chosen;
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return boundedText(value, max);
}

function boundedNullableText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return boundedOptionalText(value, max);
}

function sanitizeSlots(slots: ReadonlyMap<EngineId, number> | Record<string, number>): Record<string, number> {
  const entries = slots instanceof Map ? [...slots.entries()] : Object.entries(slots);
  const out: Record<string, number> = {};
  for (const [backend, value] of entries) {
    const key = boundedText(backend, 80);
    if (!key) continue;
    out[key] = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }
  return out;
}

function assignmentBackendCounts(assignments: Array<{ backend: EngineId | string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const assignment of assignments) {
    const backend = boundedText(assignment.backend, 80, 'builtin');
    if (!backend) continue;
    out[backend] = (out[backend] ?? 0) + 1;
  }
  return out;
}

function sanitizeBackendCounts(counts: Record<string, number> | undefined): Record<string, number> {
  if (!counts) return {};
  const out: Record<string, number> = {};
  for (const [backend, count] of Object.entries(counts)) {
    const key = boundedText(backend, 80, 'builtin');
    if (!key) continue;
    out[key] = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  }
  return out;
}

export function buildDispatchManifestEvent(input: BuildDispatchManifestEventInput): DispatchManifestEvent {
  const ts = eventTimestamp(input.ts);
  const claimedItemIds = input.plan.assignments
    .map((assignment) => assignment.item.id)
    .concat(input.plan.unassigned.map((item) => item.id));
  const assignments = input.plan.assignments.slice(0, MAX_ITEMS).map((assignment) => {
    const item = assignment.item;
    const routeReason = boundedOptionalText(input.routeReasons?.get(item.id), MAX_TEXT.reason);
    const model = boundedNullableText(input.routeModels?.get(item.id), MAX_TEXT.model);
    const attemptId = boundedOptionalText(input.attemptIds?.get(item.id), 160);
    return {
      itemId: boundedText(item.id, MAX_TEXT.itemId, 'unknown'),
      ...(attemptId ? { attemptId } : {}),
      source: boundedText(item.source, 80, 'unknown') as WorkItem['source'],
      repo: boundedText(item.repo, MAX_TEXT.repo, 'unknown'),
      title: boundedText(item.title ?? item.id, MAX_TEXT.title, 'untitled'),
      backend: boundedText(assignment.backend, 80, 'builtin') as EngineId,
      ...(routeReason ? { routeReason } : {}),
      ...(model !== undefined ? { model } : {}),
    };
  });
  const unassigned = input.plan.unassigned.slice(0, MAX_ITEMS).map((item) => ({
    itemId: boundedText(item.id, MAX_TEXT.itemId, 'unknown'),
    reason: 'no-slots' as const,
  }));

  return sanitizeDispatchManifestEvent({
    schemaVersion: 1,
    manifestId: `dm-${ts.replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    ts,
    ...(input.machineId ? { machineId: input.machineId } : {}),
    mode: 'concurrent',
    dryRun: input.dryRun === true,
    claimedItemIds: claimedItemIds.map((itemId) => boundedText(itemId, MAX_TEXT.itemId, 'unknown')).slice(0, MAX_ITEMS),
    assignments,
    unassigned,
    slots: sanitizeSlots(input.plan.slotsMap),
    backendCounts: assignmentBackendCounts(input.plan.assignments),
    ...(input.resourceSnapshotAt ? { resourceSnapshotAt: eventTimestamp(input.resourceSnapshotAt) } : {}),
    counts: {
      claimed: claimedItemIds.length,
      assigned: input.plan.assignments.length,
      unassigned: input.plan.unassigned.length,
    },
  });
}

export function sanitizeDispatchManifestEvent(event: DispatchManifestEvent): DispatchManifestEvent {
  const ts = eventTimestamp(event.ts);
  const manifestId = boundedText(event.manifestId, 120, `dm-${ts.replace(/[^0-9]/g, '').slice(0, 14)}`);
  const machineId = boundedOptionalText(event.machineId, MAX_TEXT.machineId);
  const claimedItemIds = Array.isArray(event.claimedItemIds)
    ? event.claimedItemIds.map((itemId) => boundedText(itemId, MAX_TEXT.itemId, 'unknown')).slice(0, MAX_ITEMS)
    : [];
  const assignments = Array.isArray(event.assignments)
    ? event.assignments.slice(0, MAX_ITEMS).map((assignment) => ({
        itemId: boundedText(assignment.itemId, MAX_TEXT.itemId, 'unknown'),
        ...(boundedOptionalText(assignment.attemptId, 160)
          ? { attemptId: boundedOptionalText(assignment.attemptId, 160) }
          : {}),
        source: boundedText(assignment.source, 80, 'unknown') as WorkItem['source'],
        repo: boundedText(assignment.repo, MAX_TEXT.repo, 'unknown'),
        title: boundedText(assignment.title, MAX_TEXT.title, 'untitled'),
        backend: boundedText(assignment.backend, 80, 'builtin') as EngineId,
        ...(boundedOptionalText(assignment.routeReason, MAX_TEXT.reason)
          ? { routeReason: boundedOptionalText(assignment.routeReason, MAX_TEXT.reason) }
          : {}),
        ...(boundedNullableText(assignment.model, MAX_TEXT.model) !== undefined
          ? { model: boundedNullableText(assignment.model, MAX_TEXT.model) }
          : {}),
      }))
    : [];
  const unassigned = Array.isArray(event.unassigned)
    ? event.unassigned.slice(0, MAX_ITEMS).map((item) => ({
        itemId: boundedText(item.itemId, MAX_TEXT.itemId, 'unknown'),
        reason: 'no-slots' as const,
      }))
    : [];
  const claimed = typeof event.counts?.claimed === 'number' && Number.isFinite(event.counts.claimed)
    ? Math.max(0, Math.floor(event.counts.claimed))
    : claimedItemIds.length;
  const assigned = typeof event.counts?.assigned === 'number' && Number.isFinite(event.counts.assigned)
    ? Math.max(0, Math.floor(event.counts.assigned))
    : assignments.length;
  const unassignedCount = typeof event.counts?.unassigned === 'number' && Number.isFinite(event.counts.unassigned)
    ? Math.max(0, Math.floor(event.counts.unassigned))
    : unassigned.length;

  return {
    schemaVersion: 1,
    manifestId,
    ts,
    ...(machineId ? { machineId } : {}),
    mode: 'concurrent',
    dryRun: event.dryRun === true,
    claimedItemIds,
    assignments,
    unassigned,
    slots: sanitizeSlots(event.slots),
    backendCounts: Object.keys(sanitizeBackendCounts(event.backendCounts)).length > 0
      ? sanitizeBackendCounts(event.backendCounts)
      : assignmentBackendCounts(assignments),
    ...(event.resourceSnapshotAt ? { resourceSnapshotAt: eventTimestamp(event.resourceSnapshotAt) } : {}),
    counts: {
      claimed,
      assigned,
      unassigned: unassignedCount,
    },
  };
}

export function dispatchManifestSummary(event: DispatchManifestEvent, recorded: boolean): DaemonDispatchManifestSummary {
  return {
    schemaVersion: 1,
    manifestId: event.manifestId,
    ts: event.ts,
    mode: event.mode,
    recorded,
    claimed: event.counts.claimed,
    assigned: event.counts.assigned,
    unassigned: event.counts.unassigned,
    backends: event.backendCounts,
    ...(event.resourceSnapshotAt ? { resourceSnapshotAt: event.resourceSnapshotAt } : {}),
  };
}

export function recordDispatchManifest(
  eventOrEvents: DispatchManifestEvent | DispatchManifestEvent[],
): DaemonDispatchManifestSummary | undefined {
  try {
    const events = (Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents])
      .map(sanitizeDispatchManifestEvent);
    if (events.length === 0) return undefined;
    const dir = dispatchManifestDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const byDate = new Map<string, DispatchManifestEvent[]>();
    for (const event of events) {
      const date = eventDateString(event.ts);
      byDate.set(date, [...(byDate.get(date) ?? []), event]);
    }
    for (const [date, rows] of byDate.entries()) {
      appendFileSync(
        join(dir, `${date}.jsonl`),
        rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
        'utf8',
      );
    }
    return dispatchManifestSummary(events[0]!, true);
  } catch {
    const first = Array.isArray(eventOrEvents) ? eventOrEvents[0] : eventOrEvents;
    return first ? dispatchManifestSummary(sanitizeDispatchManifestEvent(first), false) : undefined;
  }
}

export function readDispatchManifestEvents(opts: ReadDispatchManifestEventsOptions = {}): DispatchManifestEvent[] {
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 100)));
  try {
    const dir = dispatchManifestDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((file) => DATE_LEDGER_FILE_RE.test(file))
      .sort()
      .reverse();
    const events: DispatchManifestEvent[] = [];
    for (const file of files) {
      const raw = readFileSync(join(dir, file), 'utf8');
      for (const line of raw.split('\n').filter(Boolean).reverse()) {
        try {
          events.push(sanitizeDispatchManifestEvent(JSON.parse(line) as DispatchManifestEvent));
          if (events.length >= limit) return events;
        } catch {
          // Ignore malformed rows; append-only history should stay readable.
        }
      }
    }
    return events;
  } catch {
    return [];
  }
}
