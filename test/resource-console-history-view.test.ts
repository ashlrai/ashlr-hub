/** Real private archive reads; a >256 identity view is not 257th-task admission. */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { decodeResourceConsoleState, resourceConsoleRecoveryId, type ResourceConsoleDurableState } from '../src/core/resources/console-state-codec.js';
import { resourceConsoleConversationPrompt, resourceConsoleTranscriptDigest } from '../src/core/resources/console-conversation.js';
import { prepareResourceConsoleHistoryArchive } from '../src/core/resources/console-history-archive.js';
import { createResourceConsoleHistoryArchiveStore } from '../src/core/resources/console-history-archive-store.js';
import { readResourceConsoleHistoryView } from '../src/core/resources/console-history-view.js';

type Job = ResourceConsoleDurableState['jobs'][number];
type Ref = { source: 'current'; taskId: string } | { source: 'archive'; recordId: string };
type Descriptor = { schemaVersion: 1; kind: 'resource-console-history-descriptor';
  console: Omit<ResourceConsoleDurableState, 'jobs'>; currentJobs: Job[]; order: Ref[] };
const workspace = '/private/fixture/history-view-workspace';
const pool = validateResourcePool({ schemaVersion: 1, id: 'view', workers: [{ id: 'local', provider: 'local', model: 'fixture',
  maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 10 }] });
const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'fixture', kind: 'local-chat',
  endpoint: 'http://127.0.0.1:1/v1' }], pool);
const scopeDigest = digest(canonical({ pool, bindings, workspace }));
const poolDigest = digest(canonical({ pool, bindings }));
const decodeOptions = { pool, bindings, workspace, configHistory: [{ pool, bindings, poolDigest }] };
const at = '2026-09-13T00:00:00.000Z';
let base: string; let archiveRoot: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'console-history-view-')));
  archiveRoot = join(base, 'archive'); mkdirSync(archiveRoot, { mode: 0o700 });
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

function queued(id: string): Job {
  const input = { id, prompt: `private-prompt-${id}`, allowedWorkerIds: ['local'], mode: 'read-only' as const,
    timeoutMs: 1000, maxOutputTokens: 128, retainHistory: true as const };
  const { retainHistory: _retention, ...runtime } = input;
  return { id, state: 'queued', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['local'], mode: 'read-only',
    workerId: null, outcome: null, reason: null, taskDigest: digest(canonical({ ...runtime, schemaVersion: 1, cwd: workspace })),
    input, retainHistory: true, history: { prompt: input.prompt, output: null } };
}
function terminal(id: string): Job {
  return { ...queued(id), state: 'settled', workerId: 'local', outcome: 'completed', input: null,
    history: { prompt: `private-prompt-${id}`, output: { text: `private-output-${id}`, truncated: false } } };
}
function state(jobs: Job[]): ResourceConsoleDurableState {
  return { schemaVersion: 7, scopeDigest, originPoolDigest: poolDigest, paused: true, jobs };
}
function descriptor(currentJobs: Job[], order: Ref[]): Descriptor {
  const { jobs: _jobs, ...header } = state([]);
  return { schemaVersion: 1, kind: 'resource-console-history-descriptor', console: header, currentJobs, order };
}
function archive() { return createResourceConsoleHistoryArchiveStore({ root: archiveRoot, scopeDigest }); }
function stage(jobs: Job[], taskId: string): Ref & { source: 'archive' } {
  const value = state(jobs); expect(decodeResourceConsoleState(value, decodeOptions)).toEqual(value);
  const entry = prepareResourceConsoleHistoryArchive(value, decodeOptions, [taskId]).entries[0]!;
  expect(archive().stage(entry).status).toBe('staged');
  return { source: 'archive', recordId: entry.record.id };
}
function read(input: Descriptor) {
  return readResourceConsoleHistoryView(input, { ...decodeOptions, archiveRoot, expectedDescriptorDigest: digest(canonical(input)) });
}
/** Excludes access time; includes names, modes, identity and bytes to catch repairs/writes. */
function inventory(directory = archiveRoot): unknown {
  return readdirSync(directory).sort().map(name => {
    const path = join(directory, name); const stat = lstatSync(path, { bigint: true });
    return { name, mode: String(stat.mode), inode: String(stat.ino), modified: String(stat.mtimeNs),
      content: stat.isDirectory() ? inventory(path) : digest(readFileSync(path)) };
  });
}
function followup(parent: Job): Job {
  const child = queued('followup');
  const context = [{ taskId: parent.id, prompt: parent.history!.prompt, output: parent.history!.output, outcome: parent.outcome }];
  const parentRef = { taskId: parent.id, expectedTranscriptDigest: resourceConsoleTranscriptDigest(scopeDigest, parent, parent.history!) };
  const input = { ...child.input!, parent: parentRef };
  const { retainHistory: _retention, parent: _parent, ...runtime } = input;
  return { ...child, input, parent: parentRef, context,
    taskDigest: digest(canonical({ ...runtime, prompt: resourceConsoleConversationPrompt(input.prompt, context), schemaVersion: 1, cwd: workspace })),
    submissionDigest: digest(canonical({ domain: 'ashlr-resource-console-submission-v1', scopeDigest, input })) };
}

describe('joined console history view', () => {
  it('reads an empty descriptor from an existing empty private root without initializing storage', () => {
    const input = descriptor([], []); const before = canonical(inventory());
    const view = read(input);
    expect(view.jobCount).toBe(0); expect(view.archiveCount).toBe(0); expect(view.currentJobIds).toEqual([]);
    expect(view.descriptorDigest).toBe(digest(canonical(input)));
    expect(view.archiveProofDigest).toMatch(/^[a-f0-9]{64}$/); expect(view.identityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(view.getJob('missing')).toBeUndefined(); expect(view.isCurrent()).toBe(true);
    expect(canonical(inventory())).toBe(before); expect(readdirSync(archiveRoot)).toEqual([]);
  });

  it('preserves pending settlement headroom independently of the historical identity count', () => {
    const old = terminal('archived'); const ref = stage([old], old.id);
    const pending = Array.from({ length: 256 }, (_, index) => queued(`pending-${index}`));
    const input = descriptor(pending, [ref, ...pending.map(job => ({ source: 'current' as const, taskId: job.id }))]);
    const before = canonical(inventory());
    expect(() => decodeResourceConsoleState(state(pending), decodeOptions)).toThrow('Resource supervisor state capacity reached');
    expect(() => read(input)).toThrow('Resource supervisor state capacity reached');
    const small = pending.slice(0, 2);
    expect(decodeResourceConsoleState(state(small), decodeOptions).jobs).toEqual(small);
    const view = read(descriptor(small, [ref, ...small.map(job => ({ source: 'current' as const, taskId: job.id }))]));
    expect(view.jobCount).toBe(3); expect(view.archiveCount).toBe(1);
    expect(view.currentJobIds).toEqual(small.map(job => job.id));
    for (const job of [old, ...small]) expect(view.getJob(job.id)).toEqual(job);
    expect(view.isCurrent()).toBe(true); expect(canonical(inventory())).toBe(before);
  });

  it('reads 257 exact identities after reopen without weakening legacy state or current-job bounds or writing files', () => {
    const old = terminal('archived'); const ref = stage([old], old.id);
    const current = Array.from({ length: 256 }, (_, index) => terminal(`current-${index}`));
    expect(decodeResourceConsoleState(state(current), decodeOptions).jobs).toHaveLength(256);
    expect(() => decodeResourceConsoleState(state([old, ...current]), decodeOptions)).toThrow();
    const input = descriptor(current, [ref, ...current.map(job => ({ source: 'current' as const, taskId: job.id }))]);
    const before = canonical(inventory()); const view = read(input); const reopened = read(structuredClone(input));
    expect(view.jobCount).toBe(257); expect(view.archiveCount).toBe(1);
    expect(view.currentJobIds).toEqual(current.map(job => job.id));
    expect(view.descriptorDigest).toBe(digest(canonical(input)));
    expect(view.archiveProofDigest).toMatch(/^[a-f0-9]{64}$/); expect(view.identityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(reopened.identityDigest).toBe(view.identityDigest); expect(reopened.archiveProofDigest).toBe(view.archiveProofDigest);
    for (const job of [old, ...current]) expect(view.getJob(job.id)).toEqual(job);
    expect(view.getJob('missing')).toBeUndefined(); expect(view.isCurrent()).toBe(true);
    expect(canonical(inventory())).toBe(before);
    const overflow = [...current, terminal('overflow')];
    expect(() => read(descriptor(overflow, overflow.map(job => ({ source: 'current', taskId: job.id }))))).toThrow();
  });

  it('resolves an archived parent for a current queued follow-up and preserves captured context after parent deletion', () => {
    const parent = terminal('parent'); const child = followup(parent);
    expect(decodeResourceConsoleState(state([parent, child]), decodeOptions).jobs).toEqual([parent, child]);
    const ref = stage([parent], parent.id);
    const input = descriptor([child], [ref, { source: 'current', taskId: child.id }]);
    const view = read(input); expect(view.getJob(child.id)).toEqual(child);
    archive().deleteText(ref.recordId);
    expect(view.isCurrent()).toBe(false);
    const deleted = read(input); expect(deleted.getJob(parent.id)).toEqual({ ...parent, history: null });
    expect(deleted.getJob(child.id)).toEqual(child); expect(deleted.isCurrent()).toBe(true);
    expect(() => read({ ...input, order: [...input.order].reverse() })).toThrow();
    const wrong = structuredClone(input); wrong.currentJobs[0]!.parent!.expectedTranscriptDigest = digest('wrong-parent');
    expect(() => read(wrong)).toThrow();
  });

  it('validates recovery across the archive boundary without changing the original deadline or ownership', () => {
    const prior: Job = { ...queued('abandoned'), input: null, state: 'cancelled', outcome: 'cancelled', reason: 'task-owner-unavailable',
      executionOwnerId: '12345678-1234-4123-8123-123456789abc', executionDeadlineAt: at };
    const child: Job = { ...queued(resourceConsoleRecoveryId(prior)), recoveryOf: prior.id,
      executionOwnerId: '22345678-1234-4123-8123-123456789abc', executionDeadlineAt: at };
    expect(decodeResourceConsoleState(state([prior, child]), decodeOptions).jobs).toEqual([prior, child]);
    const ref = stage([prior], prior.id); const input = descriptor([child], [ref, { source: 'current', taskId: child.id }]);
    expect(read(input).getJob(child.id)).toEqual(child);
    for (const change of [{ executionDeadlineAt: '2026-09-13T00:00:01.000Z' }, { recoveryOf: 'missing' }, { id: 'wrong-child' }]) {
      const altered = structuredClone(input); Object.assign(altered.currentJobs[0]!, change);
      altered.order[1] = { source: 'current', taskId: altered.currentJobs[0]!.id };
      expect(() => read(altered)).toThrow();
    }
  });

  it('uses explicit order rather than per-snapshot positions and never adopts unused staged records', () => {
    const first = terminal('first'); const second = terminal('second');
    const a = stage([first], first.id); const b = stage([second], second.id);
    stage([terminal('unused')], 'unused');
    expect(archive().read(a.recordId).record!.position).toBe(0);
    expect(archive().read(b.recordId).record!.position).toBe(0);
    const view = read(descriptor([], [b, a]));
    expect(view.jobCount).toBe(2); expect(view.archiveCount).toBe(2);
    expect(view.getJob('first')).toEqual(first); expect(view.getJob('second')).toEqual(second);
    expect(view.getJob('unused')).toBeUndefined();
    expect(view.descriptorDigest).not.toBe(read(descriptor([], [a, b])).descriptorDigest);
  });

  it('refuses duplicate or conflicting task identities across current and archive records', () => {
    const job = terminal('same'); const ref = stage([job], job.id);
    for (const current of [job, { ...job, taskDigest: digest('conflict') }]) {
      expect(() => read(descriptor([current], [ref, { source: 'current', taskId: current.id }]))).toThrow();
    }
    expect(() => read(descriptor([], [ref, ref]))).toThrow();
    expect(() => read(descriptor([job], [{ source: 'current', taskId: job.id }, { source: 'current', taskId: job.id }]))).toThrow();
  });

  it('refuses missing or extra current identities, missing archive metadata and wrong descriptor pins without repairs', () => {
    const job = terminal('present'); const ref = stage([job], job.id);
    const before = canonical(inventory());
    expect(() => read(descriptor([queued('hot')], [ref]))).toThrow();
    expect(() => read(descriptor([], [{ source: 'current', taskId: 'missing' }]))).toThrow();
    expect(() => read(descriptor([], [{ source: 'archive', recordId: digest('missing') }]))).toThrow();
    const input = descriptor([], [ref]);
    expect(() => readResourceConsoleHistoryView(input, { ...decodeOptions, archiveRoot, expectedDescriptorDigest: digest('wrong') })).toThrow();
    expect(() => readResourceConsoleHistoryView(input, { ...decodeOptions, workspace: '/private/wrong', archiveRoot,
      expectedDescriptorDigest: digest(canonical(input)) })).toThrow();
    expect(canonical(inventory())).toBe(before);
  });

  it('refuses unavailable retained text without turning loss into deletion or a partial view', () => {
    const job = terminal('lost'); const ref = stage([job], job.id);
    const input = descriptor([terminal('hot')], [ref, { source: 'current', taskId: 'hot' }]);
    const view = read(input);
    unlinkSync(join(archiveRoot, 'texts', `${digest(canonical({ scopeDigest, jobId: job.id }))}.json`));
    const before = canonical(inventory());
    expect(view.isCurrent()).toBe(false); expect(() => read(input)).toThrow();
    expect(canonical(inventory())).toBe(before);
    expect(archive().read(ref.recordId)).toMatchObject({ status: 'staged', text: null, textState: 'unavailable' });
  });

  it('refuses live archive ownership contention without reclaiming the lock', () => {
    const ref = stage([terminal('archived')], 'archived');
    const lock = acquireLocalStoreLock(join(archiveRoot, '.archive.lock'), 0, { anchorPath: archiveRoot, exactPrivateStorage: true });
    expect(lock).not.toBeNull();
    try {
      const before = canonical(inventory()); expect(() => read(descriptor([], [ref]))).toThrow();
      expect(canonical(inventory())).toBe(before);
    } finally { expect(releaseLocalStoreLock(lock)).toBe(true); }
  });

  it('returns detached jobs and rejects descriptor accessors without executing them or writing files', () => {
    const job = terminal('archived'); const ref = stage([job], job.id); const input = descriptor([], [ref]);
    const view = read(input); const copy = view.getJob(job.id)!; copy.history!.prompt = 'changed';
    expect(view.getJob(job.id)).toEqual(job);
    let calls = 0; const bad = structuredClone(input); const expectedDescriptorDigest = digest(canonical(bad));
    Object.defineProperty(bad.order, '0', { enumerable: true, get() { calls++; return ref; } });
    const before = canonical(inventory());
    expect(() => readResourceConsoleHistoryView(bad, { ...decodeOptions, archiveRoot, expectedDescriptorDigest })).toThrow();
    expect(calls).toBe(0); expect(canonical(inventory())).toBe(before);
  });

  it('rejects sparse references and unknown envelope keys', () => {
    const input = descriptor([], []);
    expect(() => read({ ...input, order: new Array<Ref>(1) })).toThrow();
    expect(() => readResourceConsoleHistoryView({ ...input, unknown: true }, { ...decodeOptions, archiveRoot,
      expectedDescriptorDigest: digest(canonical({ ...input, unknown: true })) })).toThrow();
  });
});
