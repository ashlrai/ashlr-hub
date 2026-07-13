import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunState } from '../src/core/types.js';
import { listRuns, loadRun, saveRun } from '../src/core/run/orchestrator.js';

const ABORT_TASK_ERROR = 'Aborted: run budget exceeded';
const CANCELLED_TASK_ERROR = 'Task cancelled.';
const CANCELLED_MARKER = '_ashlrCancelled';

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
  it('writes a parent-compatible abort while preserving caller and current-reader truth', () => {
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
    expect(raw).toMatchObject({ status: 'aborted', [CANCELLED_MARKER]: true });
    expect(raw['terminationReason']).toBeUndefined();
    expect(rawTasks[0]).toMatchObject({
      status: 'failed',
      error: ABORT_TASK_ERROR,
      [CANCELLED_MARKER]: true,
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

  it('rehydrates a raw zero-task cancellation marker through load and list', () => {
    const raw = {
      ...makeState('m338-raw-zero-task', {
        result: 'Run cancelled before execution.',
      }),
      [CANCELLED_MARKER]: true,
    };
    writeRaw(raw);

    expect(loadRun(raw.id)).toMatchObject({
      id: raw.id,
      status: 'aborted',
      terminationReason: 'cancelled',
      tasks: [],
    });
    expect(listRuns().find((run) => run.id === raw.id)?.terminationReason).toBe('cancelled');
  });

  it('requires exact markers and sentinels and keeps the encoding stable after another save', () => {
    const raw = {
      ...makeState('m338-adversarial', {
        terminationReason: 'error-exit',
        tasks: [
          {
            id: 'exact',
            goal: 'Exact task marker',
            deps: [],
            status: 'failed',
            error: ABORT_TASK_ERROR,
            [CANCELLED_MARKER]: true,
          },
          {
            id: 'unmarked',
            goal: 'Ordinary budget abort',
            deps: [],
            status: 'failed',
            error: ABORT_TASK_ERROR,
          },
          {
            id: 'wrong-error',
            goal: 'Marker cannot erase a genuine failure',
            deps: [],
            status: 'failed',
            error: 'Socket closed',
            [CANCELLED_MARKER]: true,
          },
          {
            id: 'wrong-status',
            goal: 'Marker cannot rewrite completed work',
            deps: [],
            status: 'done',
            result: ABORT_TASK_ERROR,
            [CANCELLED_MARKER]: true,
          },
        ],
      }),
      [CANCELLED_MARKER]: true,
    };
    writeRaw(raw);

    const loaded = loadRun(raw.id)!;
    expect(loaded.terminationReason).toBe('error-exit');
    expect(loaded.tasks.map((task) => task.error)).toEqual([
      CANCELLED_TASK_ERROR,
      ABORT_TASK_ERROR,
      'Socket closed',
      undefined,
    ]);

    saveRun(loaded);
    expect(loaded.terminationReason).toBe('error-exit');
    expect(loaded.tasks[0]!.error).toBe(CANCELLED_TASK_ERROR);

    const rewritten = JSON.parse(fs.readFileSync(runPath(raw.id), 'utf8')) as Record<string, unknown>;
    const rewrittenTasks = rewritten['tasks'] as Array<Record<string, unknown>>;
    expect(rewritten['terminationReason']).toBe('error-exit');
    expect(rewritten).not.toHaveProperty(CANCELLED_MARKER);
    expect(rewrittenTasks[0]).toMatchObject({
      error: ABORT_TASK_ERROR,
      [CANCELLED_MARKER]: true,
    });
    expect(rewrittenTasks[1]).not.toHaveProperty(CANCELLED_MARKER);
    expect(rewrittenTasks[2]).toMatchObject({ error: 'Socket closed' });
    expect(rewrittenTasks[2]).not.toHaveProperty(CANCELLED_MARKER);
    expect(rewrittenTasks[3]).not.toHaveProperty(CANCELLED_MARKER);
  });
});
