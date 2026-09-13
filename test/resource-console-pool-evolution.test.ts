/** Pure epoch migration: no filesystem, transport, enrollment, or account effects. */
import { describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { decodeResourceConsoleState, previewResourceConsolePoolEvolution,
  type ResourceConsoleDurableState } from '../src/core/resources/pool-supervisor.js';
import { resourceConsoleConversationPrompt, resourceConsoleTranscriptDigest } from '../src/core/resources/console-conversation.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';

const workspace = '/private/fixture/workspace';
const pool = validateResourcePool({ schemaVersion: 1, id: 'epochs', workers: [{ id: 'old', provider: 'local', model: 'old-model',
  maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 10 }] });
const bindings = validateResourceBindings([{ workerId: 'old', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
const nextPool = validateResourcePool({ ...pool, workers: [...pool.workers, { ...pool.workers[0]!, id: 'new', model: 'new-model' }] });
const nextBindings = validateResourceBindings([...bindings, { ...bindings[0]!, workerId: 'new' }], nextPool);
const from = { pool, bindings }; const to = { pool: nextPool, bindings: nextBindings };
const configHistory = [from, to].map((value) => ({ ...value, poolDigest: digest(canonical(value)) }));
const scope = (value = from) => digest(canonical({ ...value, workspace }));
const options = { workspace, from, to, configHistory };
const current = { ...to, workspace, configHistory };
const at = '2026-09-10T00:00:00.000Z';
function task(id: string, worker = 'old'): ResourceConsoleTaskInput {
  return { id, prompt: `prompt ${id}`, allowedWorkerIds: [worker], mode: 'read-only', timeoutMs: 1000,
    maxOutputTokens: 128, retainHistory: true };
}
function queued(input = task('queued')): ResourceConsoleDurableState['jobs'][number] {
  const { retainHistory: _consent, ...runtime } = input;
  return { id: input.id, state: 'queued', enqueuedAt: at, updatedAt: at, allowedWorkerIds: [...input.allowedWorkerIds],
    mode: input.mode, workerId: null, outcome: null, reason: null, input, taskDigest: digest(canonical({ ...runtime,
      schemaVersion: 1, cwd: workspace })), retainHistory: true, history: { prompt: input.prompt, output: null } };
}
function source(): ResourceConsoleDurableState {
  const first = queued(task('first'));
  return { schemaVersion: 3, scopeDigest: scope(), paused: true, jobs: [{ ...first, state: 'settled', input: null,
    workerId: 'old', outcome: 'completed', history: { prompt: 'prompt first', output: { text: 'answer', truncated: false } } }, queued()] };
}

describe('console pool epochs', () => {
  it('preserves schema6 owner and deadline records through additive pool evolution', () => {
    const state = source(); state.schemaVersion = 6; state.originPoolDigest = configHistory[0]!.poolDigest;
    Object.assign(state.jobs[1]!, { executionOwnerId: '12345678-1234-4123-8123-123456789abc', executionDeadlineAt: at });
    const before = canonical(state);
    const next = previewResourceConsolePoolEvolution(state, options)!;
    expect(next.schemaVersion).toBe(6); expect(next.jobs).toEqual(state.jobs);
    expect(decodeResourceConsoleState(next, current)).toEqual(next);
    expect(canonical(state)).toBe(before);
  });
  it.each([1, 2, 3, 4] as const)('leaves schema%i byte-compatible before explicit evolution', (schemaVersion) => {
    const state: ResourceConsoleDurableState = { schemaVersion, scopeDigest: scope(), paused: true, jobs: [],
      ...(schemaVersion === 4 ? { projects: [{ id: 'default', label: 'Default', workspace, dev: '1', ino: '2' }] } : {}) };
    const before = canonical(state);
    expect(canonical(decodeResourceConsoleState(state, { ...from, workspace }))).toBe(before);
    const migrated = previewResourceConsolePoolEvolution(state, options)!;
    expect(migrated).toMatchObject({ schemaVersion: 5, scopeDigest: scope(), paused: true, originPoolDigest: configHistory[0]!.poolDigest });
    expect(migrated.projects).toEqual(state.projects); expect(canonical(state)).toBe(before);
  });
  it('preserves exact historical jobs, allowlists, hashes and retained text without mutation', () => {
    const state = source(); const before = canonical(state);
    const next = previewResourceConsolePoolEvolution(state, options)!;
    expect(next.jobs).toEqual(state.jobs); expect(next.jobs[1]!.allowedWorkerIds).toEqual(['old']);
    expect(next.jobs[0]).not.toHaveProperty('originPoolDigest');
    next.jobs[0]!.history!.prompt = 'mutated copy'; expect(canonical(state)).toBe(before);
  });
  it('validates a new-epoch follow-up against its original-epoch transcript and its own current submission', () => {
    const state = previewResourceConsolePoolEvolution(source(), options)!;
    const parent = state.jobs[0]!;
    const expectedTranscriptDigest = resourceConsoleTranscriptDigest(scope(), parent, parent.history!);
    const input = { ...task('child', 'new'), parent: { taskId: parent.id, expectedTranscriptDigest } };
    const context = [{ taskId: parent.id, prompt: parent.history!.prompt, output: parent.history!.output, outcome: parent.outcome }];
    const child = queued(input); const { retainHistory: _consent, parent: _parent, ...runtime } = input;
    Object.assign(child, { originPoolDigest: configHistory[1]!.poolDigest, parent: input.parent, context,
      taskDigest: digest(canonical({ ...runtime, prompt: resourceConsoleConversationPrompt(input.prompt, context), schemaVersion: 1, cwd: workspace })),
      submissionDigest: digest(canonical({ domain: 'ashlr-resource-console-submission-v1', scopeDigest: scope(to), input })) });
    state.jobs.push(child);
    expect(decodeResourceConsoleState(state, current)).toEqual(state);
    const wrong = structuredClone(state); wrong.jobs.at(-1)!.originPoolDigest = configHistory[0]!.poolDigest;
    expect(() => decodeResourceConsoleState(wrong, current)).toThrow();
    const parentRehashed = structuredClone(state);
    parentRehashed.jobs.at(-1)!.parent!.expectedTranscriptDigest = resourceConsoleTranscriptDigest(scope(to), parent, parent.history!);
    expect(() => decodeResourceConsoleState(parentRehashed, current)).toThrow();
  });
  it.each(['dispatching', 'unresolved'] as const)('refuses migration with %s work', (state) => {
    const value = source(); value.jobs[1]!.state = state;
    if (state === 'unresolved') value.jobs[1]!.input = null;
    expect(() => previewResourceConsolePoolEvolution(value, options)).toThrow('Settle unresolved');
  });
  it('requires verified bounded history and exact origin configuration rather than arbitrary old scope hashes', () => {
    const state = previewResourceConsolePoolEvolution(source(), options)!;
    expect(() => decodeResourceConsoleState(state, { ...to, workspace })).toThrow();
    expect(() => decodeResourceConsoleState(state, { ...current, configHistory: [configHistory[1]!] })).toThrow();
    const corrupt = structuredClone(configHistory); corrupt[0]!.pool.workers[0]!.model = 'forged';
    expect(() => decodeResourceConsoleState(state, { ...current, configHistory: corrupt })).toThrow();
    expect(() => decodeResourceConsoleState({ ...state, originPoolDigest: 'a'.repeat(64) }, current)).toThrow();
    const invalid = structuredClone(state); Object.assign(invalid.jobs[0]!, { originPoolDigest: null });
    expect(() => decodeResourceConsoleState(invalid, current)).toThrow();
    expect(() => decodeResourceConsoleState(state, { ...current, workspace: '/private/other' })).toThrow();
    expect(previewResourceConsolePoolEvolution(null, options)).toBeNull();
  });
  it('keeps deletion permanent and supports a second explicit evolution without changing the original anchor', () => {
    const state = source(); state.jobs[0]!.history = null;
    const first = previewResourceConsolePoolEvolution(state, options)!;
    const thirdPool = validateResourcePool({ ...nextPool, workers: [...nextPool.workers, { ...pool.workers[0]!, id: 'third' }] });
    const third = { pool: thirdPool, bindings: validateResourceBindings([...nextBindings, { ...bindings[0]!, workerId: 'third' }], thirdPool) };
    const history = [...configHistory, { ...third, poolDigest: digest(canonical(third)) }];
    const second = previewResourceConsolePoolEvolution(first, { workspace, from: to, to: third, configHistory: history })!;
    expect(second).toEqual(first); expect(second.jobs[0]!.history).toBeNull();
  });
});
