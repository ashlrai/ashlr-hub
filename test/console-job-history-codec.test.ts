/** Pure mixed-history domain validation; no archive publication or runtime admission. */
import { describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import { resourceConsoleTranscriptDigest } from '../src/core/resources/console-conversation.js';
import { decodeResourceConsoleState, validateResourceConsoleJobHistory, resourceConsoleRecoveryId,
  MAX_RESOURCE_CONSOLE_HISTORY_JOBS, type ResourceConsoleDurableJob as Job,
  type ResourceConsoleDurableState, type ResourceConsoleJobHistoryInput } from '../src/core/resources/console-state-codec.js';

const workspace = '/private/fixture/console-history';
const pool = validateResourcePool({ schemaVersion: 1, id: 'history', workers: [{ id: 'local', provider: 'local',
  model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 10 }] });
const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'fixture', kind: 'local-chat',
  endpoint: 'http://127.0.0.1:1/v1' }], pool);
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const options = { pool, bindings, workspace, configHistory: [epoch] };
const scopeDigest = digest(canonical({ pool, bindings, workspace }));
const at = '2026-09-13T00:00:00.000Z';
const projects = [{ id: 'default', label: 'Default', workspace, dev: '1', ino: '2' }];
function job(id = 'task'): Job {
  return { id, state: 'settled', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['local'], mode: 'read-only',
    workerId: 'local', outcome: 'completed', reason: null, taskDigest: digest(id), input: null };
}
function input(jobs: Job[], sourceSchemaVersion: ResourceConsoleDurableState['schemaVersion'] = 7): ResourceConsoleJobHistoryInput {
  return { scopeDigest, originPoolDigest: epoch.poolDigest, projects,
    rows: jobs.map(job => ({ sourceSchemaVersion, job })) };
}

describe('shared console job history codec', () => {
  it.each([1, 2, 3, 4, 5, 6, 7] as const)('preserves legacy schema %i row validation and detached identity', schemaVersion => {
    const jobs = [job()];
    const state: ResourceConsoleDurableState = { schemaVersion, scopeDigest, paused: true, jobs,
      ...(schemaVersion === 4 ? { projects } : {}),
      ...(schemaVersion >= 5 ? { originPoolDigest: epoch.poolDigest } : {}) };
    const view = validateResourceConsoleJobHistory(input(jobs, schemaVersion), options);
    expect(view.jobs).toEqual(decodeResourceConsoleState(state, options).jobs);
    expect(view).not.toHaveProperty('schemaVersion');
    const first = view.getJob('task')!; first.reason = 'changed';
    expect(view.getJob('task')!.reason).toBeNull();
    jobs[0]!.reason = 'changed-source';
    expect(view.jobs[0]!.reason).toBeNull();
    expect(view.getJob('absent')).toBeUndefined();
  });

  it('accepts 4352 identities without widening the 256-job legacy state', () => {
    const jobs = Array.from({ length: MAX_RESOURCE_CONSOLE_HISTORY_JOBS }, (_, index) => job(`task-${index}`));
    expect(validateResourceConsoleJobHistory(input(jobs), options).jobs).toHaveLength(4352);
    expect(() => decodeResourceConsoleState({ schemaVersion: 1, scopeDigest, paused: true, jobs: jobs.slice(0, 257) }, options)).toThrow();
    expect(() => validateResourceConsoleJobHistory(input([...jobs, job('overflow')]), options)).toThrow();
  });

  it('rejects total history bytes before decoding malformed large rows', () => {
    const text = 'x'.repeat(1024 * 1024);
    const value = input(Array.from({ length: 65 }, (_, index) => ({ ...job(`task-${index}`), history: { prompt: text, output: null } })));
    expect(() => validateResourceConsoleJobHistory(value, options)).toThrow('exceeds its limit');
  });

  it.each(['root', 'row', 'job', 'array', 'inherited-array', 'sparse'] as const)('rejects hostile %s data without invoking supplied code', kind => {
    const getter = vi.fn(() => 7); const value = input([job()]);
    if (kind === 'root') Object.defineProperty(value, 'rows', { enumerable: true, get: getter });
    if (kind === 'row') Object.defineProperty(value.rows[0], 'sourceSchemaVersion', { enumerable: true, get: getter });
    if (kind === 'job') Object.defineProperty(value.rows[0]!.job, 'id', { enumerable: true, get: getter });
    if (kind === 'array') Object.defineProperty(value.rows, '0', { enumerable: true, get: getter });
    if (kind === 'inherited-array') Object.setPrototypeOf(value.rows, { get map() { return getter(); } });
    if (kind === 'sparse') value.rows = new Array(1);
    expect(() => validateResourceConsoleJobHistory(value, options)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });

  it('rejects duplicate identities and source schema feature downgrades', () => {
    expect(() => validateResourceConsoleJobHistory(input([job(), job()]), options)).toThrow();
    const retained = { ...job(), retainHistory: true as const, history: null };
    expect(() => validateResourceConsoleJobHistory(input([retained], 1), options)).toThrow();
    const origin = { ...job(), originPoolDigest: epoch.poolDigest };
    expect(() => validateResourceConsoleJobHistory(input([origin], 3), options)).toThrow();
  });

  it('uses the verified original epoch for old rows and explicit admission epochs for new rows', () => {
    const nextPool = validateResourcePool({ ...pool, workers: [...pool.workers, { ...pool.workers[0]!, id: 'added' }] });
    const nextBindings = validateResourceBindings([...bindings, { ...bindings[0]!, workerId: 'added', capacityKey: 'added',
      endpoint: 'http://127.0.0.1:2/v1' }], nextPool);
    const nextEpoch = resourcePoolConfigSnapshot(nextPool, nextBindings);
    const nextOptions = { pool: nextPool, bindings: nextBindings, workspace, configHistory: [epoch, nextEpoch] };
    const value = input([job('old')], 1);
    value.rows.push({ sourceSchemaVersion: 7, job: { ...job('new'), allowedWorkerIds: ['added'], workerId: 'added',
      originPoolDigest: nextEpoch.poolDigest } });
    expect(validateResourceConsoleJobHistory(value, nextOptions).jobs).toHaveLength(2);
    (value.rows[0]!.job as Job).allowedWorkerIds = ['added']; (value.rows[0]!.job as Job).workerId = 'added';
    expect(() => validateResourceConsoleJobHistory(value, nextOptions)).toThrow();
    expect(() => validateResourceConsoleJobHistory({ ...input([job()]), originPoolDigest: nextEpoch.poolDigest }, nextOptions)).toThrow('origin epoch');
  });

  it('joins parent/context across the former hot-store boundary and refuses reordered or mismatched evidence', () => {
    const parent: Job = { ...job('parent'), retainHistory: true, history: { prompt: 'prior request', output: { text: 'prior output', truncated: false } } };
    const child: Job = { ...job('child'), retainHistory: true, history: { prompt: 'next request', output: null },
      parent: { taskId: parent.id, expectedTranscriptDigest: resourceConsoleTranscriptDigest(scopeDigest, parent, parent.history!) },
      submissionDigest: digest('submission'), context: [{ taskId: parent.id, prompt: parent.history!.prompt,
        output: parent.history!.output, outcome: parent.outcome }] };
    const middle = Array.from({ length: 256 }, (_, index) => job(`middle-${index}`));
    expect(validateResourceConsoleJobHistory(input([parent, ...middle, child]), options).getJob('child')).toEqual(child);
    expect(() => validateResourceConsoleJobHistory(input([child, parent]), options)).toThrow();
    child.context![0]!.prompt = 'changed';
    expect(() => validateResourceConsoleJobHistory(input([parent, child]), options)).toThrow('pinned parent');
  });

  it('preserves the original 256-member recovery-chain ceiling independently of total history capacity', () => {
    const root: Job = { ...job('root'), state: 'cancelled', outcome: 'cancelled', workerId: null,
      reason: 'task-owner-unavailable', executionOwnerId: '00000000-0000-4000-8000-000000000001', executionDeadlineAt: at };
    const jobs = [root];
    for (let index = 1; index < 257; index++) {
      const prior = jobs.at(-1)!;
      jobs.push({ ...root, id: resourceConsoleRecoveryId(prior), recoveryOf: prior.id });
    }
    expect(validateResourceConsoleJobHistory(input(jobs.slice(0, 256)), options).jobs).toHaveLength(256);
    expect(() => validateResourceConsoleJobHistory(input(jobs), options)).toThrow('recovery chain');
    expect(() => validateResourceConsoleJobHistory(input([jobs[1]!, jobs[0]!]), options)).toThrow('recovery edge');
  });
});

