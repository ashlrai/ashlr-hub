/** Verified owner-free history projection, never a writable legacy state or dispatch grant. */
import { canonical, digest } from '../universe/artifacts.js';
import { assertStateHeadroom, decodeResourceConsoleState, validateResourceConsoleJobHistory,
  type ResourceConsoleDurableJob, type ResourceConsoleDurableState } from './console-state-codec.js';
import { assertResourceConsoleArchiveData, restoreResourceConsoleArchiveJob } from './console-history-archive.js';
import { createResourceConsoleHistoryArchiveStore } from './console-history-archive-store.js';
import { resourcePoolConfigSnapshot } from './pool-evolution-policy.js';

type DecodeOptions = Parameters<typeof decodeResourceConsoleState>[1];
export interface ResourceConsoleHistoryDescriptor {
  schemaVersion: 1;
  kind: 'resource-console-history-descriptor';
  console: Omit<ResourceConsoleDurableState, 'jobs'>;
  currentJobs: ResourceConsoleDurableJob[];
  /** Explicit total order, including every hot job exactly once; never directory enumeration. */
  order: Array<{ source: 'current'; taskId: string } | { source: 'archive'; recordId: string }>;
}
export interface ResourceConsoleHistoryView {
  descriptorDigest: string;
  archiveProofDigest: string;
  identityDigest: string;
  currentJobIds: readonly string[];
  jobCount: number;
  archiveCount: number;
  getJob(id: string): ResourceConsoleDurableJob | undefined;
  /** Archive freshness only. The caller must separately recheck its source descriptor. */
  isCurrent(): boolean;
}
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_DESCRIPTOR_BYTES = 8 * 1024 * 1024;
function fail(): never { throw new Error('Resource console history view unavailable'); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function readResourceConsoleHistoryView(input: unknown, options: DecodeOptions & {
  archiveRoot: string; expectedDescriptorDigest: string;
}): ResourceConsoleHistoryView {
  // Validate descriptors before serialization, indexing or reading any archive file.
  assertResourceConsoleArchiveData(input); assertResourceConsoleArchiveData(options);
  if (!exact(options, ['pool', 'bindings', 'workspace', 'archiveRoot', 'expectedDescriptorDigest',
    ...(Object.hasOwn(options, 'configHistory') ? ['configHistory'] : [])]) ||
    typeof options.expectedDescriptorDigest !== 'string' || !HASH.test(options.expectedDescriptorDigest) ||
    typeof options.archiveRoot !== 'string') fail();
  const { archiveRoot, expectedDescriptorDigest, ...validation } = structuredClone(options);
  const bytes = canonical(input);
  if (Buffer.byteLength(bytes) > MAX_DESCRIPTOR_BYTES || digest(bytes) !== expectedDescriptorDigest) fail();
  const descriptor = JSON.parse(bytes) as ResourceConsoleHistoryDescriptor;
  if (!exact(descriptor, ['schemaVersion', 'kind', 'console', 'currentJobs', 'order']) || descriptor.schemaVersion !== 1 ||
    descriptor.kind !== 'resource-console-history-descriptor' || !descriptor.console || typeof descriptor.console !== 'object' ||
    Object.hasOwn(descriptor.console, 'jobs') || !Array.isArray(descriptor.currentJobs) || descriptor.currentJobs.length > 256 ||
    !Array.isArray(descriptor.order) || descriptor.order.length > 4352) fail();
  const { jobs: _empty, ...header } = decodeResourceConsoleState({ ...descriptor.console, jobs: [] }, validation);
  const current = new Map<string, ResourceConsoleDurableJob>();
  for (const job of descriptor.currentJobs) {
    if (!job || typeof job.id !== 'string' || !ID.test(job.id) || current.has(job.id)) fail();
    current.set(job.id, job);
  }
  const hotSeen = new Set<string>(); const archiveSeen = new Set<string>(); const archiveIds: string[] = [];
  for (const row of descriptor.order) {
    if (row?.source === 'current' && exact(row, ['source', 'taskId'])) {
      if (typeof row.taskId !== 'string' || !current.has(row.taskId) || hotSeen.has(row.taskId)) fail();
      hotSeen.add(row.taskId);
    } else if (row?.source === 'archive' && exact(row, ['source', 'recordId'])) {
      if (typeof row.recordId !== 'string' || !HASH.test(row.recordId) || archiveSeen.has(row.recordId)) fail();
      archiveSeen.add(row.recordId); archiveIds.push(row.recordId);
    } else fail();
  }
  if (hotSeen.size !== current.size || archiveIds.length > 4096) fail();
  const snapshot = createResourceConsoleHistoryArchiveStore({ root: archiveRoot, scopeDigest: header.scopeDigest }).readSnapshot(archiveIds);
  if (snapshot.status !== 'complete' || snapshot.entries.length !== archiveIds.length) fail();
  const archived = new Map(snapshot.entries.map((entry, index) => {
    if (entry.record.id !== archiveIds[index] || entry.record.scopeDigest !== header.scopeDigest || entry.textState === 'unavailable') fail();
    return [entry.record.id, { sourceSchemaVersion: entry.record.sourceSchemaVersion,
      job: restoreResourceConsoleArchiveJob(entry.record, entry.text, entry.textState === 'deleted' ? { deleted: true } : {}) }] as const;
  }));
  const rows = descriptor.order.map(row => row.source === 'current'
    ? { sourceSchemaVersion: header.schemaVersion, job: current.get(row.taskId)! } : archived.get(row.recordId)!);
  const history = validateResourceConsoleJobHistory({ scopeDigest: header.scopeDigest,
    originPoolDigest: header.originPoolDigest ?? resourcePoolConfigSnapshot(validation.pool, validation.bindings).poolDigest,
    ...(header.projects ? { projects: header.projects } : {}), rows }, validation);
  // Historical payloads do not consume the hot file's settlement reserve. Its
  // own jobs retain the original 4MiB guarantee before any future writer uses it.
  assertStateHeadroom({ ...header, jobs: descriptor.currentJobs });
  if (!snapshot.isCurrent()) fail();
  const identityDigest = digest(canonical({ domain: 'ashlr-console-history-view-v1',
    descriptorDigest: expectedDescriptorDigest, archiveProofDigest: snapshot.proofDigest }));
  const currentJobIds = Object.freeze([...current.keys()]);
  return Object.freeze({ descriptorDigest: expectedDescriptorDigest, archiveProofDigest: snapshot.proofDigest,
    identityDigest, currentJobIds, jobCount: history.jobs.length, archiveCount: archiveIds.length,
    getJob(id: string) {
      if (typeof id !== 'string' || !ID.test(id) || !snapshot.isCurrent()) fail();
      return history.getJob(id);
    },
    isCurrent: snapshot.isCurrent,
  });
}
