/** Versioned console storage projection. Only the owning supervisor publishes the active root. */
import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { assertStateHeadroom, decodeResourceConsoleState, MAX_STATE_BYTES, ResourceSupervisorError,
  type ResourceConsoleDurableJob as Job, type ResourceConsoleDurableState as State,
  type ResourceConsoleJobValidationOptions } from './console-state-codec.js';
import { assertResourceConsoleArchiveData, validateResourceConsoleArchiveRecord, validateResourceConsoleArchiveText,
  type ResourceConsoleHistoryArchivePlan } from './console-history-archive.js';
import { createResourceConsoleHistoryArchiveStore } from './console-history-archive-store.js';
import { readResourceConsoleHistoryView, type ResourceConsoleHistoryDescriptor } from './console-history-view.js';

export type ResourceConsoleStoredState = State | ResourceConsoleHistoryDescriptor;
export type ResourceConsoleStorageOptions = ResourceConsoleJobValidationOptions & { root: string };
export interface ResourceConsoleStorageView {
  readonly source: ResourceConsoleStoredState;
  readonly sourceDigest: string;
  /** Writable hot projection only; archived parents mean it is not a standalone legacy document. */
  readonly hotState: State;
  /** Detached, ordered read projection. Never serialize this as legacy state. */
  readonly jobs: readonly Job[];
  readonly archivedRecords: ReadonlyMap<string, string>;
  getJob(id: string): Job | undefined;
  /** Archive freshness only; callers must separately bind the active root and owner. */
  isCurrent(): boolean;
}
type Capture = { sourceJson: string; optionsJson: string; hotState: State;
  jobs: readonly Job[]; archivedRecords: Array<[string, string]> };
const captures = new WeakMap<ResourceConsoleStorageView, Capture>();
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function fail(): never { throw new ResourceSupervisorError('UNAVAILABLE', 'Resource console storage unavailable'); }
function present(file: string): boolean {
  try { lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return fail();
  }
}
function synchronousGuard(callback: () => void): () => void {
  if (typeof callback !== 'function') fail();
  return () => {
    const result: unknown = callback();
    if (result instanceof Promise) void result.catch(() => {});
    if (result !== undefined) fail();
  };
}
export function resourceConsoleArchiveRoot(root: string): string { return join(root, 'resource-console-history'); }
function captureOptions(options: ResourceConsoleStorageOptions) {
  assertResourceConsoleArchiveData(options);
  const { root, ...validation } = structuredClone(options);
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) fail();
  const keys = Object.keys(validation);
  if (keys.length !== (Object.hasOwn(validation, 'configHistory') ? 4 : 3) ||
    !['pool', 'bindings', 'workspace'].every(key => Object.hasOwn(validation, key))) fail();
  return { root, validation };
}
function isDescriptor(source: ResourceConsoleStoredState): source is ResourceConsoleHistoryDescriptor {
  return Object.hasOwn(source, 'kind');
}
function headroom(source: ResourceConsoleStoredState, hot: State): void {
  const extra = Buffer.byteLength(canonical(source)) - Buffer.byteLength(canonical(hot));
  // The reference envelope shares the existing 4MiB file with future output.
  // Add exactly its canonical byte overhead to the hot reservation calculation.
  assertStateHeadroom(hot, Math.max(0, extra));
}

/** Decode the persisted union; constructing a view never creates or repairs files. */
export function readResourceConsoleStorage(value: unknown, options: ResourceConsoleStorageOptions): ResourceConsoleStorageView {
  const { root, validation } = captureOptions(options);
  // Match the legacy decoder's node ceiling; descriptor envelopes impose their
  // own tighter projection checks after this accessor-safe capture.
  assertResourceConsoleArchiveData(value, new Set(), 0, { nodes: 0 }, MAX_STATE_BYTES);
  const sourceJson = canonical(value);
  if (Buffer.byteLength(sourceJson) > MAX_STATE_BYTES) {
    throw new ResourceSupervisorError('CAPACITY', 'Resource supervisor state capacity reached');
  }
  const source = JSON.parse(sourceJson) as ResourceConsoleStoredState;
  const sourceDigest = digest(sourceJson);
  let hotState: State; let jobs: readonly Job[]; let fresh: () => boolean;
  const archivedRecords = new Map<string, string>();
  if (isDescriptor(source)) {
    const history = readResourceConsoleHistoryView(source, { ...validation,
      archiveRoot: resourceConsoleArchiveRoot(root), expectedDescriptorDigest: sourceDigest });
    hotState = { ...structuredClone(source.console), jobs: structuredClone(source.currentJobs) };
    jobs = history.getJobs(); fresh = history.isCurrent;
    source.order.forEach((row, index) => { if (row.source === 'archive') archivedRecords.set(jobs[index]!.id, row.recordId); });
  } else {
    hotState = decodeResourceConsoleState(source, validation);
    jobs = structuredClone(hotState.jobs); fresh = () => true;
  }
  // A tombstone may have committed just before an interrupted hot-file rewrite.
  // Suppress that text immediately on reads; the owning startup persists the
  // sanitized hot projection. The original source bytes/digest remain exact.
  const archiveRoot = resourceConsoleArchiveRoot(root);
  const graphFresh = fresh;
  if (present(archiveRoot)) {
    const store = createResourceConsoleHistoryArchiveStore({ root: archiveRoot, scopeDigest: hotState.scopeDigest });
    const snapshot = store.readSnapshot([]);
    if (snapshot.status !== 'complete') fail();
    const deleted = new Set<string>();
    for (const job of hotState.jobs) {
      if (job.retainHistory !== true) continue;
      const status = store.readTaskDeletionState(job.id, job.taskDigest);
      if (status === 'unavailable') fail();
      if (status === 'deleted') {
        if (!['settled', 'cancelled'].includes(job.state)) fail();
        deleted.add(job.id); job.history = null; if (job.parent) job.context = null;
      }
    }
    if (deleted.size) jobs = jobs.map(job => deleted.has(job.id)
      ? { ...job, history: null, ...(job.parent ? { context: null } : {}) } : job);
    fresh = () => graphFresh() && snapshot.isCurrent();
    if (!fresh()) fail();
  } else fresh = () => graphFresh() && !present(archiveRoot);
  if (isDescriptor(source)) {
    if (Buffer.byteLength(sourceJson + '\n') > MAX_STATE_BYTES) throw new ResourceSupervisorError('CAPACITY', 'Resource supervisor state capacity reached');
    headroom(source, hotState);
  }
  const byId = new Map(jobs.map(job => [job.id, structuredClone(job)]));
  const view: ResourceConsoleStorageView = Object.freeze({ source, sourceDigest, hotState, jobs: structuredClone(jobs),
    archivedRecords, getJob(id: string) {
      if (typeof id !== 'string' || !ID.test(id) || !view.isCurrent()) fail();
      const job = byId.get(id); return job === undefined ? undefined : structuredClone(job);
    }, isCurrent() {
      try { assertResourceConsoleArchiveData(source, new Set(), 0, { nodes: 0 }, MAX_STATE_BYTES); return canonical(source) === sourceJson && fresh(); }
      catch { return false; }
    } });
  captures.set(view, { sourceJson, optionsJson: canonical(options), hotState: structuredClone(hotState),
    jobs: structuredClone(jobs), archivedRecords: [...archivedRecords] });
  return view;
}

function original(previous: ResourceConsoleStorageView, options: ResourceConsoleStorageOptions): ResourceConsoleStorageView {
  const captured = captures.get(previous);
  if (!captured || captured.optionsJson !== canonical(options) || !previous.isCurrent()) fail();
  // Reuse only our private, already validated capture after its entire source
  // and archive snapshot pass freshness. Public arrays/maps are never trusted.
  // Reopening every historical record here repeated disk scans on each write.
  return { ...previous, source: JSON.parse(captured.sourceJson) as ResourceConsoleStoredState,
    hotState: structuredClone(captured.hotState), jobs: structuredClone(captured.jobs),
    archivedRecords: new Map(captured.archivedRecords) };
}
function descriptor(next: State, prior: ResourceConsoleStorageView): ResourceConsoleHistoryDescriptor {
  const { jobs, ...header } = structuredClone(next);
  const ids = new Set(jobs.map(job => job.id));
  if (prior.hotState.jobs.some(job => !ids.has(job.id))) fail();
  const old = isDescriptor(prior.source) ? prior.source.order : prior.hotState.jobs.map(job => ({ source: 'current' as const, taskId: job.id }));
  const before = new Set(prior.jobs.map(job => job.id));
  return { schemaVersion: 1, kind: 'resource-console-history-descriptor', console: header,
    currentJobs: jobs, order: [...structuredClone(old), ...jobs.filter(job => !before.has(job.id)).map(job => ({ source: 'current' as const, taskId: job.id }))] };
}
/** Ordinary hot-state update. Archive membership cannot change through this path. */
export function prepareResourceConsoleStorage(next: State, previous: ResourceConsoleStorageView | null,
  options: ResourceConsoleStorageOptions): ResourceConsoleStorageView {
  const captured = captureOptions(options); options = { root: captured.root, ...captured.validation };
  assertResourceConsoleArchiveData(next, new Set(), 0, { nodes: 0 }, MAX_STATE_BYTES);
  if (!previous) return readResourceConsoleStorage(next, options);
  const prior = original(previous, options);
  if (prior.hotState.jobs.some(job => !next.jobs.some(row => row.id === job.id))) fail();
  return readResourceConsoleStorage(isDescriptor(prior.source) ? descriptor(next, prior) : next, options);
}

/** Stage selected terminal rows. Capacity changes only after the caller publishes the returned root. */
export function compactResourceConsoleStorage(previous: ResourceConsoleStorageView, taskIds: string[],
  options: ResourceConsoleStorageOptions, guard: () => void): ResourceConsoleStorageView {
  const captured = captureOptions(options); options = { root: captured.root, ...captured.validation };
  assertResourceConsoleArchiveData(taskIds);
  if (typeof guard !== 'function' || !Array.isArray(taskIds) || !taskIds.length || taskIds.length > 256 ||
    taskIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(taskIds).size !== taskIds.length) fail();
  guard = synchronousGuard(guard);
  const prior = original(previous, options);
  const selected = new Set(taskIds);
  if (prior.archivedRecords.size + selected.size > 4096) throw new ResourceSupervisorError('CAPACITY', 'Resource console archive capacity reached');
  const entries: ResourceConsoleHistoryArchivePlan['entries'] = [];
  prior.hotState.jobs.forEach((job, position) => {
    if (!selected.has(job.id)) return;
    if (!['settled', 'cancelled'].includes(job.state) || job.input !== null) fail();
    const { input: _input, history, context, ...metadata } = job;
    const text = history ? { history, context: context ?? null } : null;
    const body = { schemaVersion: 1 as const, kind: 'resource-console-history-archive' as const,
      scopeDigest: prior.hotState.scopeDigest, sourceStateDigest: prior.sourceDigest,
      sourceSchemaVersion: prior.hotState.schemaVersion, position, job: metadata,
      textDigest: text === null ? null : digest(canonical(text)) };
    const record = validateResourceConsoleArchiveRecord({ ...body, id: digest(canonical(body)) });
    entries.push({ record, text: validateResourceConsoleArchiveText(text, record) });
  });
  if (entries.length !== selected.size) fail();
  const next = descriptor(prior.hotState, prior);
  const recordIds = new Map(entries.map(entry => [entry.record.job.id, entry.record.id]));
  next.currentJobs = next.currentJobs.filter(job => !selected.has(job.id));
  next.order = next.order.map(row => row.source === 'current' && selected.has(row.taskId)
    ? { source: 'archive', recordId: recordIds.get(row.taskId)! } : row);
  if (Buffer.byteLength(canonical(next) + '\n') > MAX_STATE_BYTES) throw new ResourceSupervisorError('CAPACITY', 'Resource supervisor state capacity reached');
  guard();
  inspectPrivateDirectory(options.root);
  const archiveRoot = resourceConsoleArchiveRoot(options.root);
  if (!present(archiveRoot)) { guard(); mkdirSync(archiveRoot, { mode: 0o700 }); fsyncDirectory(options.root); }
  const store = createResourceConsoleHistoryArchiveStore({ root: archiveRoot, scopeDigest: prior.hotState.scopeDigest });
  for (const entry of entries) { guard(); store.stage(entry); guard(); }
  // Our own staging changes inventory timestamps. Re-read both logical sources
  // rather than accepting that mutation as permission to change earlier history.
  const old = readResourceConsoleStorage(prior.source, options);
  if (canonical(old.jobs) !== canonical(prior.jobs)) fail();
  const result = readResourceConsoleStorage(next, options);
  if (canonical(result.jobs) !== canonical(prior.jobs)) fail();
  guard(); if (!result.isCurrent()) fail(); return result;
}

/** Delete archive copies (including unpublished staging) before proposing hot-text removal. */
export function deleteResourceConsoleStoredHistory(previous: ResourceConsoleStorageView, id: string,
  options: ResourceConsoleStorageOptions, guard: () => void): ResourceConsoleStorageView {
  const captured = captureOptions(options); options = { root: captured.root, ...captured.validation };
  if (typeof guard !== 'function' || typeof id !== 'string' || !ID.test(id)) fail();
  guard = synchronousGuard(guard);
  const prior = original(previous, options); const job = prior.jobs.find(row => row.id === id);
  if (!job || !['settled', 'cancelled'].includes(job.state)) fail();
  guard();
  const root = resourceConsoleArchiveRoot(options.root);
  if (present(root)) {
    createResourceConsoleHistoryArchiveStore({ root, scopeDigest: prior.hotState.scopeDigest }).deleteTaskText(id, job.taskDigest);
    guard();
  }
  const refreshed = readResourceConsoleStorage(prior.source, options);
  const hot = structuredClone(refreshed.hotState);
  const current = hot.jobs.find(row => row.id === id);
  if (current?.history) { current.history = null; if (current.parent) current.context = null; }
  const result = prepareResourceConsoleStorage(hot, refreshed, options);
  guard(); if (!result.isCurrent()) fail(); return result;
}
