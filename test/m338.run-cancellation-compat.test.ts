import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunState } from '../src/core/types.js';
import { listRuns, loadRun, saveRun } from '../src/core/run/orchestrator.js';

const ABORT_TASK_ERROR = 'Aborted: run budget exceeded';
const CANCELLED_TASK_ERROR = 'Task cancelled.';
const CANCELLED_MARKER = '_ashlrCancelled';
const CANCELLED_MARKER_VERSION = 1;

let previousHome: string | undefined;
let tmpHome: string;

function runsDir(): string {
  return path.join(tmpHome, '.ashlr', 'runs');
}

function runPath(id: string): string {
  return path.join(runsDir(), `${id}.json`);
}

function makeState(id: string, overrides: Partial<RunState> = {}): RunState {
  const now = '2026-07-13T12:00:00.000Z';
  return {
    id,
    goal: 'Persist explicit cancellation compatibly',
    engine: 'builtin',
    provider: 'ollama',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 10, tokensOut: 5, steps: 2, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status: 'aborted',
    ...overrides,
  };
}

function writeRaw(state: unknown): void {
  const id = (state as { id: string }).id;
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.writeFileSync(runPath(id), JSON.stringify(state, null, 2), 'utf8');
}

function readRaw(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(runPath(id), 'utf8')) as Record<string, unknown>;
}

type LegacyOutcome = 'success' | 'failure' | 'budget-abort';

function simulateLegacyResume(id: string, outcome: LegacyOutcome): Record<string, unknown> {
  const raw = readRaw(id);
  const tasks = raw['tasks'] as Array<Record<string, unknown>>;

  raw['status'] = 'running';
  raw['updatedAt'] = '2026-07-13T12:01:00.000Z';
  for (const task of tasks) {
    if (task['status'] === 'running' ||
        (task['status'] === 'failed' && task['error'] === ABORT_TASK_ERROR)) {
      task['status'] = 'pending';
      delete task['error'];
    }
  }

  const task = tasks[0]!;
  raw['updatedAt'] = '2026-07-13T12:02:00.000Z';
  if (outcome === 'success') {
    raw['status'] = 'done';
    raw['result'] = 'Legacy reader completed the retry.';
    task['status'] = 'done';
    task['result'] = 'Legacy task completed.';
  } else if (outcome === 'failure') {
    raw['status'] = 'failed';
    raw['result'] = 'Legacy retry failed.';
    task['status'] = 'failed';
    task['error'] = 'Provider returned 500';
  } else {
    raw['status'] = 'aborted';
    raw['result'] = 'Run budget exceeded.';
    task['status'] = 'failed';
    task['error'] = ABORT_TASK_ERROR;
  }

  writeRaw(raw);
  return raw;
}

beforeEach(() => {
  previousHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m338-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('explicit run cancellation persistence compatibility', () => {
  it('round-trips current cancellation while preserving caller truth and old statuses', () => {
    const state = makeState('m338-mixed-round-trip', {
      result: 'Run cancelled.',
      terminationReason: 'cancelled',
      tasks: [
        {
          id: 'cancelled-task',
          goal: 'Interrupted work',
          deps: [],
          status: 'failed',
          error: CANCELLED_TASK_ERROR,
        },
        {
          id: 'budget-task',
          goal: 'Previously budget-aborted work',
          deps: [],
          status: 'failed',
          error: ABORT_TASK_ERROR,
        },
        {
          id: 'real-failure',
          goal: 'Genuine failure',
          deps: [],
          status: 'failed',
          error: 'Provider returned 500',
        },
      ],
    });

    saveRun(state);

    expect(state.terminationReason).toBe('cancelled');
    expect(state).not.toHaveProperty(CANCELLED_MARKER);
    expect(state.tasks[0]).toMatchObject({ error: CANCELLED_TASK_ERROR });
    expect(state.tasks[0]).not.toHaveProperty(CANCELLED_MARKER);

    const rawText = fs.readFileSync(runPath(state.id), 'utf8');
    const raw = JSON.parse(rawText) as Record<string, unknown>;
    const rawTasks = raw['tasks'] as Array<Record<string, unknown>>;
    expect(rawText).not.toContain('"terminationReason": "cancelled"');
    expect(raw).toMatchObject({
      status: 'aborted',
      [CANCELLED_MARKER]: {
        version: CANCELLED_MARKER_VERSION,
        epoch: state.updatedAt,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(raw['terminationReason']).toBeUndefined();
    expect(rawTasks[0]).toMatchObject({
      status: 'failed',
      error: ABORT_TASK_ERROR,
      [CANCELLED_MARKER]: raw[CANCELLED_MARKER],
    });
    expect(rawTasks[1]).toMatchObject({ status: 'failed', error: ABORT_TASK_ERROR });
    expect(rawTasks[1]).not.toHaveProperty(CANCELLED_MARKER);
    expect(rawTasks[2]).toMatchObject({ error: 'Provider returned 500' });

    const loaded = loadRun(state.id)!;
    expect(loaded.terminationReason).toBe('cancelled');
    expect(loaded.tasks[0]).toMatchObject({ error: CANCELLED_TASK_ERROR });
    expect(loaded.tasks[1]).toMatchObject({ error: ABORT_TASK_ERROR });

    const listed = listRuns().find((run) => run.id === state.id)!;
    expect(listed.terminationReason).toBe('cancelled');
    expect(listed.tasks.map((task) => task.error)).toEqual([
      CANCELLED_TASK_ERROR,
      ABORT_TASK_ERROR,
      'Provider returned 500',
    ]);
  });

  it('rehydrates a current zero-task cancellation through load and list', () => {
    const state = makeState('m338-raw-zero-task', {
      result: 'Run cancelled before execution.',
      terminationReason: 'cancelled',
    });
    saveRun(state);

    expect(loadRun(state.id)).toMatchObject({
      id: state.id,
      status: 'aborted',
      terminationReason: 'cancelled',
      tasks: [],
    });
    expect(listRuns().find((run) => run.id === state.id)?.terminationReason).toBe('cancelled');
  });

  it.each([
    ['success', 'done', undefined],
    ['failure', 'failed', 'Provider returned 500'],
    ['budget-abort', 'failed', ABORT_TASK_ERROR],
  ] as const)(
    'treats a legacy %s resume outcome as authoritative',
    (outcome, taskStatus, taskError) => {
      const state = makeState(`m338-legacy-${outcome}`, {
        result: 'Run cancelled.',
        terminationReason: 'cancelled',
        tasks: [{
          id: 'cancelled-task',
          goal: 'Interrupted work',
          deps: [],
          status: 'failed',
          error: CANCELLED_TASK_ERROR,
        }],
      });
      saveRun(state);
      simulateLegacyResume(state.id, outcome);

      const loaded = loadRun(state.id)!;
      expect(loaded.terminationReason).toBeUndefined();
      expect(loaded.tasks[0]).toMatchObject({ status: taskStatus });
      expect(loaded.tasks[0]!.error).toBe(taskError);
      expect(loaded).not.toHaveProperty(CANCELLED_MARKER);
      expect(loaded.tasks[0]).not.toHaveProperty(CANCELLED_MARKER);

      saveRun(loaded);
      const rewritten = readRaw(state.id);
      const rewrittenTask = (rewritten['tasks'] as Array<Record<string, unknown>>)[0]!;
      expect(rewritten).not.toHaveProperty(CANCELLED_MARKER);
      expect(rewrittenTask).not.toHaveProperty(CANCELLED_MARKER);
      expect(rewrittenTask['error']).toBe(taskError);
    },
  );

  it('rejects boolean and copied markers, even when the epoch is unchanged', () => {
    const source = makeState('m338-marker-source', {
      terminationReason: 'cancelled',
      tasks: [{
        id: 'cancelled-task',
        goal: 'Interrupted work',
        deps: [],
        status: 'failed',
        error: CANCELLED_TASK_ERROR,
      }],
    });
    saveRun(source);
    const sourceRaw = readRaw(source.id);
    const sourceTask = (sourceRaw['tasks'] as Array<Record<string, unknown>>)[0]!;

    const poisoned = makeState('m338-marker-poisoning', {
      tasks: [{
        id: 'budget-task',
        goal: 'A different run hit its budget',
        deps: [],
        status: 'failed',
        error: ABORT_TASK_ERROR,
      }],
    }) as RunState & Record<string, unknown>;
    const poisonedTask = poisoned.tasks[0]! as RunState['tasks'][number] & Record<string, unknown>;
    poisoned[CANCELLED_MARKER] = sourceRaw[CANCELLED_MARKER];
    poisonedTask[CANCELLED_MARKER] = sourceTask[CANCELLED_MARKER];
    writeRaw(poisoned);

    const copiedMarkerLoad = loadRun(poisoned.id)!;
    expect(copiedMarkerLoad.terminationReason).toBeUndefined();
    expect(copiedMarkerLoad.tasks[0]!.error).toBe(ABORT_TASK_ERROR);
    expect(copiedMarkerLoad).not.toHaveProperty(CANCELLED_MARKER);
    expect(copiedMarkerLoad.tasks[0]).not.toHaveProperty(CANCELLED_MARKER);

    poisoned[CANCELLED_MARKER] = true;
    poisonedTask[CANCELLED_MARKER] = true;
    writeRaw(poisoned);
    const booleanMarkerLoad = loadRun(poisoned.id)!;
    expect(booleanMarkerLoad.terminationReason).toBeUndefined();
    expect(booleanMarkerLoad.tasks[0]!.error).toBe(ABORT_TASK_ERROR);
    expect(booleanMarkerLoad).not.toHaveProperty(CANCELLED_MARKER);
    expect(booleanMarkerLoad.tasks[0]).not.toHaveProperty(CANCELLED_MARKER);
  });
});
