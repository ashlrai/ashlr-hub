/** Pure archive projection/codec coverage, not runtime compaction or 257th-job admission. */
import { describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { decodeResourceConsoleState, type ResourceConsoleDurableState } from '../src/core/resources/pool-supervisor.js';
import { resourceConsoleTranscriptDigest } from '../src/core/resources/console-conversation.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { prepareResourceConsoleHistoryArchive, restoreResourceConsoleArchiveJob,
  validateResourceConsoleArchiveRecord, validateResourceConsoleArchiveText,
  type ResourceConsoleArchiveRecord } from '../src/core/resources/console-history-archive.js';

const workspace = '/private/fixture/archive-workspace';
const pool = validateResourcePool({ schemaVersion: 1, id: 'archive', workers: [{ id: 'local', provider: 'local',
  model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 10 }] });
const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'fixture', kind: 'local-chat',
  endpoint: 'http://127.0.0.1:1/v1' }], pool);
const configuration = { pool, bindings };
const options = { ...configuration, workspace, configHistory: [{ ...configuration, poolDigest: digest(canonical(configuration)) }] };
const scopeDigest = digest(canonical({ ...configuration, workspace }));
const at = '2026-09-13T00:00:00.000Z';
type Job = ResourceConsoleDurableState['jobs'][number];

function queued(id = 'queued'): Job {
  const input = { id, prompt: `private-prompt-${id}`, allowedWorkerIds: ['local'], mode: 'read-only' as const,
    timeoutMs: 1000, maxOutputTokens: 128, retainHistory: true as const };
  const { retainHistory: _consent, ...runtime } = input;
  return { id, state: 'queued', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['local'], mode: 'read-only',
    workerId: null, outcome: null, reason: null, taskDigest: digest(canonical({ ...runtime, schemaVersion: 1, cwd: workspace })),
    input, retainHistory: true, history: { prompt: input.prompt, output: null } };
}
function source(schemaVersion: ResourceConsoleDurableState['schemaVersion'] = 3): ResourceConsoleDurableState {
  const completed: Job = { ...queued('completed'), state: 'settled', workerId: 'local', outcome: 'completed', input: null,
    history: { prompt: 'private-prompt-completed', output: { text: 'private-output-completed', truncated: false } } };
  const cancelled: Job = { ...queued('cancelled'), state: 'cancelled', outcome: 'cancelled', reason: 'operator-cancelled', input: null };
  const jobs = [completed, cancelled, queued()];
  if (schemaVersion === 1) {
    for (const job of jobs) {
      delete job.retainHistory; delete job.history;
      if (job.input) delete job.input.retainHistory;
    }
  }
  return { schemaVersion, scopeDigest, paused: true, jobs,
    ...(schemaVersion === 4 ? { projects: [{ id: 'default', label: 'Default', workspace, dev: '1', ino: '2' }] } : {}),
    ...(schemaVersion >= 5 ? { originPoolDigest: options.configHistory[0]!.poolDigest } : {}) };
}
function entry() { return prepareResourceConsoleHistoryArchive(source(), options, ['completed']).entries[0]!; }
function rehash(record: ResourceConsoleArchiveRecord): ResourceConsoleArchiveRecord {
  const { id: _id, ...body } = record;
  return { ...body, id: digest(canonical(body)) };
}
function followupSource(): ResourceConsoleDurableState {
  const state = source();
  const parent = state.jobs[0]!;
  const child = state.jobs[1]!;
  Object.assign(child, { parent: { taskId: parent.id,
    expectedTranscriptDigest: resourceConsoleTranscriptDigest(scopeDigest, parent, parent.history!) },
  submissionDigest: digest('fixture-terminal-submission'), context: [{ taskId: parent.id,
    prompt: parent.history!.prompt, output: parent.history!.output, outcome: parent.outcome }] });
  return state;
}

describe('resource console terminal history archive projection', () => {
  it.each([1, 2, 3, 4, 5, 6, 7] as const)('round-trips decoder-valid schema %i without changing the source or retention semantics', (schema) => {
    const state = source(schema); const before = canonical(state);
    expect(decodeResourceConsoleState(state, options)).toEqual(state);
    const plan = prepareResourceConsoleHistoryArchive(state, options, ['cancelled', 'completed']);
    expect(plan.sourceStateDigest).toBe(digest(before)); expect(plan.scopeDigest).toBe(scopeDigest);
    expect(plan.retainedJobIds).toEqual(['queued']);
    expect(plan.entries.map(({ record }) => [record.position, record.job.id, record.sourceSchemaVersion]))
      .toEqual([[0, 'completed', schema], [1, 'cancelled', schema]]);
    const restored = plan.entries.map(({ record, text }) => restoreResourceConsoleArchiveJob(record, text));
    expect(restored).toEqual(state.jobs.slice(0, 2));
    expect(decodeResourceConsoleState({ ...state, jobs: [...restored, state.jobs[2]] }, options)).toEqual(state);
    expect(canonical(state)).toBe(before);
  });

  it('keeps consented prompt/output/context solely in the separately deletable payload and binds both hashes', () => {
    const state = followupSource(); expect(decodeResourceConsoleState(state, options)).toEqual(state);
    const plan = prepareResourceConsoleHistoryArchive(state, options, ['cancelled']);
    const { record, text } = plan.entries[0]!;
    expect(record.job).not.toHaveProperty('input'); expect(record.job).not.toHaveProperty('history');
    expect(record.job).not.toHaveProperty('context');
    expect(canonical(record)).not.toContain('private-prompt'); expect(canonical(record)).not.toContain('private-output');
    expect(text).toEqual({ history: state.jobs[1]!.history, context: state.jobs[1]!.context });
    expect(record.textDigest).toBe(digest(canonical(text)));
    expect(rehash(record).id).toBe(record.id);
    expect(restoreResourceConsoleArchiveJob(record, text)).toEqual(state.jobs[1]);
    text!.history.prompt = 'mutated-copy';
    expect(state.jobs[1]!.history!.prompt).toBe('private-prompt-cancelled');
  });

  it('keeps already deleted history/context absent through projection and decoder restart', () => {
    const state = followupSource(); state.jobs[1]!.history = null; state.jobs[1]!.context = null;
    expect(decodeResourceConsoleState(state, options)).toEqual(state);
    const { record, text } = prepareResourceConsoleHistoryArchive(state, options, ['cancelled']).entries[0]!;
    expect(text).toBeNull(); expect(record.textDigest).toBeNull();
    expect(validateResourceConsoleArchiveText(null, record)).toBeNull();
    expect(restoreResourceConsoleArchiveJob(record, text)).toEqual(state.jobs[1]);
  });

  it('requires caller-proven deletion instead of treating missing text as a tombstone', () => {
    const state = followupSource();
    const { record, text } = prepareResourceConsoleHistoryArchive(state, options, ['cancelled']).entries[0]!;
    expect(() => validateResourceConsoleArchiveText(null, record)).toThrow();
    expect(() => restoreResourceConsoleArchiveJob(record, null)).toThrow();
    const restored = restoreResourceConsoleArchiveJob(record, null, { deleted: true });
    expect(restored).toEqual({ ...state.jobs[1], history: null, context: null });
    expect(decodeResourceConsoleState({ ...state, jobs: [state.jobs[0], restored, state.jobs[2]] }, options).jobs[1]).toEqual(restored);
    expect(() => restoreResourceConsoleArchiveJob(record, text, { deleted: true })).toThrow();
    const legacy = prepareResourceConsoleHistoryArchive(source(1), options, ['completed']).entries[0]!;
    expect(() => restoreResourceConsoleArchiveJob(legacy.record, null, { deleted: true })).toThrow();
  });

  it.each([[], ['unknown'], ['completed', 'completed'], ['completed', 'unknown'], ['queued'], new Array<string>(1)].map(ids => ({ ids })))('refuses empty, unknown, duplicate, active or sparse selections: $ids', ({ ids }) => {
    expect(() => prepareResourceConsoleHistoryArchive(source(), options, ids)).toThrow();
  });

  it.each(['dispatching', 'unresolved'] as const)('refuses selected %s work even if its state decodes', (stateName) => {
    const state = source(); const job = state.jobs[2]!; job.state = stateName;
    if (stateName === 'unresolved') job.input = null;
    expect(decodeResourceConsoleState(state, options)).toEqual(state);
    expect(() => prepareResourceConsoleHistoryArchive(state, options, [job.id])).toThrow();
  });

  it('validates the entire source before projecting a valid terminal subset', () => {
    const state = source(); state.jobs[2]!.taskDigest = '0'.repeat(64);
    expect(() => prepareResourceConsoleHistoryArchive(state, options, ['completed'])).toThrow();
    expect(() => prepareResourceConsoleHistoryArchive(source(), { ...options, workspace: '/private/wrong' }, ['completed'])).toThrow();
    const wrong = source(); wrong.jobs[0]!.input = queued().input;
    expect(() => prepareResourceConsoleHistoryArchive(wrong, options, ['completed'])).toThrow();
  });
});

describe('closed archive codecs', () => {
  it('returns detached validated record and text copies', () => {
    const { record, text } = entry();
    const copy = validateResourceConsoleArchiveRecord(record);
    const payload = validateResourceConsoleArchiveText(text, record)!;
    copy.job.allowedWorkerIds.push('other'); payload.history.output!.text = 'changed';
    expect(record.job.allowedWorkerIds).toEqual(['local']); expect(text!.history.output!.text).toBe('private-output-completed');
  });

  it.each(['input', 'history', 'context', 'unknown'])('rejects forbidden metadata key %s even with recomputed identity', (key) => {
    const { record } = entry(); Object.assign(record.job, { [key]: null });
    expect(() => validateResourceConsoleArchiveRecord(rehash(record))).toThrow();
  });

  it('rejects unknown envelope/text keys and identity or payload drift', () => {
    const { record, text } = entry();
    expect(() => validateResourceConsoleArchiveRecord({ ...record, unknown: true })).toThrow();
    expect(() => validateResourceConsoleArchiveRecord({ ...record, position: 1 })).toThrow();
    expect(() => validateResourceConsoleArchiveText({ ...text, unknown: true }, record)).toThrow();
    const changed = structuredClone(text)!; changed.history.output!.text = 'forged';
    expect(() => validateResourceConsoleArchiveText(changed, record)).toThrow();
    const deleted = source(); deleted.jobs[0]!.history = null;
    const noText = prepareResourceConsoleHistoryArchive(deleted, options, ['completed']).entries[0]!;
    expect(() => validateResourceConsoleArchiveText(text, noText.record)).toThrow();
  });

  it.each([{ position: -1 }, { position: 256 }, { position: 0.5 }, { sourceSchemaVersion: 8 },
    { scopeDigest: 'bad' }, { sourceStateDigest: 'bad' }, { textDigest: 'bad' }])('rejects malformed metadata despite a recomputed content identity: %j', (change) => {
    expect(() => validateResourceConsoleArchiveRecord(rehash({ ...entry().record, ...change } as ResourceConsoleArchiveRecord))).toThrow();
  });

  it('rejects getter-bearing source, selections, record, text and deletion options without invoking getters', () => {
    let calls = 0;
    const getter = () => { calls++; return 'private'; };
    const state = source(); Object.defineProperty(state.jobs[0]!, 'reason', { enumerable: true, get: getter });
    expect(() => prepareResourceConsoleHistoryArchive(state, options, ['completed'])).toThrow();
    expect(calls, 'source accessor').toBe(0);
    const ids = ['completed']; Object.defineProperty(ids, '0', { enumerable: true, get: getter });
    expect(() => prepareResourceConsoleHistoryArchive(source(), options, ids)).toThrow();
    expect(calls, 'selection accessor').toBe(0);
    const { record, text } = entry();
    const badRecord = structuredClone(record); Object.defineProperty(badRecord.job, 'reason', { enumerable: true, get: getter });
    expect(() => validateResourceConsoleArchiveRecord(badRecord)).toThrow();
    expect(calls, 'record accessor').toBe(0);
    Object.defineProperty(text!.history, 'prompt', { enumerable: true, get: getter });
    expect(() => validateResourceConsoleArchiveText(text, record)).toThrow();
    expect(calls, 'text accessor').toBe(0);
    const deletion = Object.defineProperty({}, 'deleted', { enumerable: true, get: getter });
    expect(() => restoreResourceConsoleArchiveJob(record, null, deletion)).toThrow();
    expect(calls).toBe(0);
  });

  it('refuses inherited array hooks and nested element accessors before serialization', () => {
    let calls = 0;
    const selected = ['completed'];
    Object.setPrototypeOf(selected, { map() { calls++; return ['completed']; } });
    expect(() => prepareResourceConsoleHistoryArchive(source(), options, selected)).toThrow();
    const { record } = entry();
    Object.defineProperty(record.job.allowedWorkerIds, '0', { enumerable: true, get() { calls++; return 'local'; } });
    expect(() => validateResourceConsoleArchiveRecord(record)).toThrow();
    expect(calls).toBe(0);
  });
});
