/** Real private storage adapter tests. Fixture root publication is not supervisor admission. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { readResourceJson } from '../src/core/resources/pool-runtime.js';
import { assertStateHeadroom, decodeResourceConsoleState, type ResourceConsoleDurableState } from '../src/core/resources/console-state-codec.js';
import { resourceConsoleConversationPrompt, resourceConsoleTranscriptDigest } from '../src/core/resources/console-conversation.js';
import { createResourceConsoleHistoryArchiveStore } from '../src/core/resources/console-history-archive-store.js';
import { compactResourceConsoleStorage, deleteResourceConsoleStoredHistory, prepareResourceConsoleStorage, readResourceConsoleStorage,
  resourceConsoleArchiveRoot, type ResourceConsoleStorageView } from '../src/core/resources/console-state-storage.js';

type Job = ResourceConsoleDurableState['jobs'][number];
const workspace = '/private/fixture/state-storage-workspace';
const pool = validateResourcePool({ schemaVersion: 1, id: 'storage', workers: [{ id: 'local', provider: 'local', model: 'fixture',
  maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 10 }] });
const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'fixture', kind: 'local-chat',
  endpoint: 'http://127.0.0.1:1/v1' }], pool);
const poolDigest = digest(canonical({ pool, bindings }));
const scopeDigest = digest(canonical({ pool, bindings, workspace }));
const decodeOptions = { pool, bindings, workspace, configHistory: [{ pool, bindings, poolDigest }] };
const at = '2026-09-13T00:00:00.000Z';
let base: string; let root: string; let statePath: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'console-state-storage-')));
  root = join(base, 'runtime'); mkdirSync(root, { mode: 0o700 }); statePath = join(root, 'resource-console-state.json');
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });
const options = () => ({ ...decodeOptions, root });
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
function state(jobs: Job[], schemaVersion: ResourceConsoleDurableState['schemaVersion'] = 7): ResourceConsoleDurableState {
  const copied = structuredClone(jobs);
  if (schemaVersion === 1) for (const job of copied) { delete job.retainHistory; delete job.history; if (job.input) delete job.input.retainHistory; }
  return { schemaVersion, scopeDigest, paused: true, jobs: copied,
    ...(schemaVersion >= 5 ? { originPoolDigest: poolDigest } : {}),
    ...(schemaVersion === 4 ? { projects: [{ id: 'default', label: 'Default', workspace, dev: '1', ino: '2' }] } : {}) };
}
function persistFixture(source: ResourceConsoleStorageView['source']): void {
  writeFileSync(statePath, `${canonical(source)}\n`, { mode: 0o600 });
}
function initial(value: ResourceConsoleDurableState): ResourceConsoleStorageView {
  expect(decodeResourceConsoleState(value, decodeOptions)).toEqual(value); persistFixture(value);
  return readResourceConsoleStorage(readResourceJson(statePath), options());
}
/** The production caller owns the CAS and console lease; this fixture supplies only an exact source CAS. */
function guardFor(view: ResourceConsoleStorageView): () => void {
  const expected = view.sourceDigest;
  return () => { if (digest(canonical(readResourceJson(statePath))) !== expected) throw new Error('Fixture source changed'); };
}
function archive() { return createResourceConsoleHistoryArchiveStore({ root: resourceConsoleArchiveRoot(root), scopeDigest }); }
function disk(path = root): unknown {
  const stat = lstatSync(path, { bigint: true });
  return { ino: String(stat.ino), dev: String(stat.dev), mode: String(stat.mode), modified: String(stat.mtimeNs), changed: String(stat.ctimeNs),
    content: stat.isDirectory() ? readdirSync(path).sort().map(name => [name, disk(join(path, name))]) : digest(readFileSync(path)) };
}
function followup(parent: Job, id = 'child'): Job {
  const child = queued(id);
  const context = [...(parent.context ?? []), { taskId: parent.id, prompt: parent.history!.prompt,
    output: parent.history!.output, outcome: parent.outcome }];
  const parentRef = { taskId: parent.id,
    expectedTranscriptDigest: resourceConsoleTranscriptDigest(scopeDigest, parent, parent.history!, parent.context) };
  const input = { ...child.input!, parent: parentRef };
  const { retainHistory: _retention, parent: _parent, ...runtime } = input;
  return { ...child, input, parent: parentRef, context,
    taskDigest: digest(canonical({ ...runtime, prompt: resourceConsoleConversationPrompt(input.prompt, context), schemaVersion: 1, cwd: workspace })),
    submissionDigest: digest(canonical({ domain: 'ashlr-resource-console-submission-v1', scopeDigest, input })) };
}

describe('resource console active-state storage adapter', () => {
  it('rejects non-string lookup IDs without invoking their coercion hooks', () => {
    const view = initial(state([terminal('old')])); let calls = 0;
    const id = { toString() { calls++; return 'old'; } };
    expect(() => view.getJob(id as unknown as string)).toThrow();
    expect(calls).toBe(0); expect(view.getJob('old')?.id).toBe('old');
  });

  it.each([1, 2, 3, 4, 5, 6, 7] as const)('reads legacy schema%i without writing or altering its source/provenance', schema => {
    const source = state([terminal('old'), queued('pending')], schema); persistFixture(source); const before = canonical(disk());
    const view = readResourceConsoleStorage(readResourceJson(statePath), options());
    expect(view.source).toEqual(source); expect(view.hotState).toEqual(source); expect(view.jobs).toEqual(source.jobs);
    expect(view.sourceDigest).toBe(digest(canonical(source))); expect(view.archivedRecords.size).toBe(0);
    expect(view.getJob('old')).toEqual(source.jobs[0]); expect(view.isCurrent()).toBe(true); expect(canonical(disk())).toBe(before);
  });

  it.each([1, 2, 3, 4, 5, 6, 7] as const)('stages schema%i selected records while preserving the old active root and exact hot positions', schema => {
    const source = state([terminal('first'), terminal('second'), queued('pending')], schema); const before = initial(source);
    const activeBytes = readFileSync(statePath, 'utf8'); let guards = 0; const cas = guardFor(before);
    const next = compactResourceConsoleStorage(before, ['second', 'first'], options(), () => { guards++; cas(); });
    expect(guards).toBeGreaterThan(1); expect(readFileSync(statePath, 'utf8')).toBe(activeBytes);
    expect(next.source).toMatchObject({ schemaVersion: 1, kind: 'resource-console-history-descriptor' });
    expect(next.jobs).toEqual(source.jobs); expect(next.hotState.jobs).toEqual([source.jobs[2]]);
    expect(next.archivedRecords.size).toBe(2); expect(next.getJob('pending')).toEqual(source.jobs[2]);
    for (const [index, id] of ['first', 'second'].entries()) {
      const record = archive().read(next.archivedRecords.get(id)!);
      expect(record.status).toBe('staged'); expect(record.record).toMatchObject({ sourceSchemaVersion: schema,
        sourceStateDigest: before.sourceDigest, position: index, job: { id } });
    }
    // Standalone staged data is not adopted by the unchanged legacy root.
    expect(readResourceConsoleStorage(readResourceJson(statePath), options()).archivedRecords.size).toBe(0);
    persistFixture(next.source); const reopened = readResourceConsoleStorage(readResourceJson(statePath), options());
    expect(reopened.jobs).toEqual(source.jobs); expect(reopened.sourceDigest).toBe(next.sourceDigest);
    expect(reopened.hotState.jobs).toEqual(next.hotState.jobs); expect(reopened.isCurrent()).toBe(true);
  });

  it('rejects invalid/nonterminal selections and a failed source guard before creating any archive storage', () => {
    const view = initial(state([terminal('done'), queued('pending')]));
    const before = canonical(disk());
    for (const ids of [['pending'], ['missing'], ['done', 'done'], ['../bad'], new Array<string>(1)]) {
      expect(() => compactResourceConsoleStorage(view, ids, options(), guardFor(view))).toThrow();
      expect(canonical(disk())).toBe(before);
    }
    expect(() => compactResourceConsoleStorage(view, ['done'], options(), () => { throw new Error('Fixture ownership lost'); })).toThrow('Fixture ownership lost');
    expect(canonical(disk())).toBe(before);
    persistFixture({ ...view.hotState, paused: false }); const changed = canonical(disk());
    expect(() => compactResourceConsoleStorage(view, ['done'], options(), guardFor(view))).toThrow('Fixture source changed');
    expect(canonical(disk())).toBe(changed);
  });

  it('refuses altered source/view captures and unknown scope without archive writes', () => {
    const view = initial(state([terminal('done')])); const before = canonical(disk());
    const changed = { ...view, source: { ...view.hotState, paused: false } };
    expect(() => compactResourceConsoleStorage(changed, ['done'], options(), guardFor(view))).toThrow();
    expect(() => prepareResourceConsoleStorage(view.hotState, changed, options())).toThrow();
    expect(() => readResourceConsoleStorage(view.source, { ...options(), workspace: '/private/fixture/other' })).toThrow();
    expect(canonical(disk())).toBe(before);
  });

  it('prepares appended hot work without removing or duplicating previous current/archived identities', () => {
    const source = state([terminal('old'), terminal('hot')]); const previous = initial(source);
    const compacted = compactResourceConsoleStorage(previous, ['old'], options(), guardFor(previous)); persistFixture(compacted.source);
    const nextHot = { ...compacted.hotState, jobs: [...compacted.hotState.jobs, queued('new')] };
    const before = canonical(disk()); const next = prepareResourceConsoleStorage(nextHot, compacted, options());
    expect(next.jobs.map(job => job.id)).toEqual(['old', 'hot', 'new']);
    expect(next.archivedRecords.get('old')).toBe(compacted.archivedRecords.get('old'));
    expect(next.hotState.jobs).toEqual(nextHot.jobs); expect(canonical(disk())).toBe(before);
    expect(() => prepareResourceConsoleStorage({ ...nextHot, jobs: [queued('new')] }, compacted, options())).toThrow();
    expect(() => prepareResourceConsoleStorage({ ...nextHot, jobs: [...nextHot.jobs, terminal('old')] }, compacted, options())).toThrow();
    expect(canonical(disk())).toBe(before);
  });

  it('rotates a terminal child whose parent is already archived, preserving its captured context and global order', () => {
    const parent = terminal('parent'); const child = followup(parent); const first = initial(state([parent, child]));
    const compacted = compactResourceConsoleStorage(first, ['parent'], options(), guardFor(first)); persistFixture(compacted.source);
    expect(() => decodeResourceConsoleState(compacted.hotState, decodeOptions)).toThrow();
    const finishedChild: Job = { ...child, input: null, state: 'settled', workerId: 'local', outcome: 'completed',
      history: { prompt: child.history!.prompt, output: { text: 'child-result', truncated: false } } };
    const settled = prepareResourceConsoleStorage({ ...compacted.hotState, jobs: [finishedChild] }, compacted, options());
    persistFixture(settled.source);
    const second = compactResourceConsoleStorage(settled, ['child'], options(), guardFor(settled));
    expect(second.jobs).toEqual([parent, finishedChild]); expect(second.hotState.jobs).toEqual([]);
    expect(second.archivedRecords.get('parent')).toBe(compacted.archivedRecords.get('parent'));
    expect(archive().read(second.archivedRecords.get('child')!).record).toMatchObject({ sourceSchemaVersion: 7,
      sourceStateDigest: settled.sourceDigest, position: 0 });
    persistFixture(second.source); const reopened = readResourceConsoleStorage(readResourceJson(statePath), options());
    expect(reopened.getJob('child')).toEqual(finishedChild); expect(reopened.jobs.map(job => job.id)).toEqual(['parent', 'child']);
  });

  it('charges descriptor references against hot settlement headroom rather than only the legacy hot projection', () => {
    const first = initial(state([terminal('old')]));
    const compacted = compactResourceConsoleStorage(first, ['old'], options(), guardFor(first)); persistFixture(compacted.source);
    const hot = state([...Array.from({ length: 10 }, (_, index) => queued(`pending-${index}`)), terminal('filler')]);
    const filler = hot.jobs.at(-1)!;
    // Maximize a valid existing output within the legacy headroom calculation.
    // At its exact boundary, the descriptor envelope/order must still be charged.
    let low = 0; let high = 64 * 1024;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2); filler.history!.output!.text = '\u0001'.repeat(middle);
      try { assertStateHeadroom(hot); low = middle; } catch { high = middle - 1; }
    }
    filler.history!.output!.text = '\u0001'.repeat(low);
    expect(low).toBeGreaterThan(0); expect(low).toBeLessThan(64 * 1024);
    expect(decodeResourceConsoleState(hot, decodeOptions)).toEqual(hot);
    const before = canonical(disk()); expect(() => prepareResourceConsoleStorage(hot, compacted, options())).toThrow();
    expect(canonical(disk())).toBe(before);
    filler.history!.output!.text = '';
    expect(prepareResourceConsoleStorage(hot, compacted, options()).jobs).toHaveLength(12);
  });

  it('invalidates stale views on deletion and rejects record loss without treating it as missing history', () => {
    const first = initial(state([terminal('old'), terminal('hot')]));
    const compacted = compactResourceConsoleStorage(first, ['old'], options(), guardFor(first)); persistFixture(compacted.source);
    const recordId = compacted.archivedRecords.get('old')!; archive().deleteText(recordId);
    expect(compacted.isCurrent()).toBe(false); const before = canonical(disk());
    expect(() => prepareResourceConsoleStorage(compacted.hotState, compacted, options())).toThrow();
    expect(() => compactResourceConsoleStorage(compacted, ['hot'], options(), guardFor(compacted))).toThrow();
    expect(canonical(disk())).toBe(before);
    const deleted = readResourceConsoleStorage(readResourceJson(statePath), options());
    expect(deleted.getJob('old')).toMatchObject({ retainHistory: true, history: null });
    unlinkSync(join(resourceConsoleArchiveRoot(root), 'metadata', 'records', `${recordId}.json`));
    expect(deleted.isCurrent()).toBe(false); const damaged = canonical(disk());
    expect(() => readResourceConsoleStorage(readResourceJson(statePath), options())).toThrow();
    expect(canonical(disk())).toBe(damaged);
  });

  it('deletes orphan archive text after failed compaction before returning a hot-text removal proposal', () => {
    const previous = initial(state([terminal('old')])); const activeBytes = readFileSync(statePath, 'utf8');
    const metadata = join(resourceConsoleArchiveRoot(root), 'metadata', 'records'); const cas = guardFor(previous);
    expect(() => compactResourceConsoleStorage(previous, ['old'], options(), () => {
      cas(); if (existsSync(metadata) && readdirSync(metadata).length) throw new Error('Fixture interrupted after staging');
    })).toThrow('Fixture interrupted after staging');
    expect(readFileSync(statePath, 'utf8')).toBe(activeBytes);
    const recordId = readdirSync(metadata)[0]!.replace(/\.json$/, '');
    expect(archive().read(recordId)).toMatchObject({ textState: 'available' });
    expect(previous.isCurrent()).toBe(false);
    const recovered = readResourceConsoleStorage(readResourceJson(statePath), options());
    const deleted = deleteResourceConsoleStoredHistory(recovered, 'old', options(), guardFor(recovered));
    expect(readFileSync(statePath, 'utf8')).toBe(activeBytes); // Caller has not published the proposed root yet.
    expect(deleted.getJob('old')).toMatchObject({ retainHistory: true, history: null });
    expect(archive().read(recordId)).toMatchObject({ textState: 'deleted', text: null });
    expect(readdirSync(join(resourceConsoleArchiveRoot(root), 'texts'))).toEqual([]);
    persistFixture(deleted.source);
    const reopened = readResourceConsoleStorage(readResourceJson(statePath), options());
    const compacted = compactResourceConsoleStorage(reopened, ['old'], options(), guardFor(reopened));
    expect(compacted.getJob('old')).toMatchObject({ retainHistory: true, history: null });
    expect(archive().read(compacted.archivedRecords.get('old')!)).toMatchObject({ textState: 'deleted', text: null });
    expect(readdirSync(join(resourceConsoleArchiveRoot(root), 'texts'))).toEqual([]);
  });

  it('refuses asynchronous ownership guards before any archive publication', () => {
    const previous = initial(state([terminal('old')])); const before = canonical(disk());
    expect(() => compactResourceConsoleStorage(previous, ['old'], options(), async () => {})).toThrow();
    expect(canonical(disk())).toBe(before);
    expect(() => deleteResourceConsoleStoredHistory(previous, 'old', options(), async () => { throw new Error('Fixture async refusal'); })).toThrow();
    expect(canonical(disk())).toBe(before);
  });

  it('suppresses hot plaintext after a committed archive tombstone even when the owning source guard fails before root cleanup', () => {
    const previous = initial(state([terminal('old')])); const originalBytes = readFileSync(statePath, 'utf8');
    const metadata = join(resourceConsoleArchiveRoot(root), 'metadata', 'records'); const cas = guardFor(previous);
    expect(() => compactResourceConsoleStorage(previous, ['old'], options(), () => {
      cas(); if (existsSync(metadata) && readdirSync(metadata).length) throw new Error('Fixture compaction interrupted');
    })).toThrow();
    const tombstones = join(resourceConsoleArchiveRoot(root), 'tombstones', 'records');
    expect(previous.isCurrent()).toBe(false);
    const recovered = readResourceConsoleStorage(readResourceJson(statePath), options());
    expect(() => deleteResourceConsoleStoredHistory(recovered, 'old', options(), () => {
      cas(); if (existsSync(tombstones) && readdirSync(tombstones).length) throw new Error('Fixture deletion root not published');
    })).toThrow('Fixture deletion root not published');
    expect(readFileSync(statePath, 'utf8')).toBe(originalBytes);
    expect(originalBytes).toContain('private-output-old'); // Demonstrate the dangerous retained old root really exists.
    const before = canonical(disk()); const reopened = readResourceConsoleStorage(readResourceJson(statePath), options());
    expect(reopened.sourceDigest).toBe(previous.sourceDigest); expect(reopened.source).toEqual(previous.source);
    expect(reopened.getJob('old')).toMatchObject({ retainHistory: true, history: null });
    expect(reopened.hotState.jobs[0]).toMatchObject({ history: null }); expect(reopened.isCurrent()).toBe(true);
    expect(canonical(disk())).toBe(before); // Observation suppresses text; only the owner may persist cleanup.
  });

  it('captures the incoming options before an ownership guard can redirect the archive root', () => {
    const previous = initial(state([terminal('old')])); const supplied = options(); const otherRoot = join(base, 'other');
    mkdirSync(otherRoot, { mode: 0o700 }); const cas = guardFor(previous); const expected = previous.getJob('old');
    const next = compactResourceConsoleStorage(previous, ['old'], supplied, () => { cas(); supplied.root = otherRoot; });
    expect(next.archivedRecords.size).toBe(1); expect(next.getJob('old')).toEqual(expected);
    expect(archive().read(next.archivedRecords.get('old')!)).toMatchObject({ textState: 'available' });
    expect(readdirSync(otherRoot)).toEqual([]);
  });
});
