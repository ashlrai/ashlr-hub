import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SwarmRun, SwarmTaskRun } from '../src/core/types.js';
import {
  listSwarms,
  loadSwarm,
  saveSwarm,
  swarmsDir,
} from '../src/core/swarm/store.js';

const TASK_CANCELLED_MARKER = '_ashlrCancelled';
const originalHome = process.env.HOME;
let tmpHome: string;

function makeRun(
  id: string,
  updatedAt = '2026-07-13T12:00:00.000Z',
): SwarmRun {
  const tasks: SwarmTaskRun[] = [
    { id: 'cancelled-task', phase: 'build', status: 'cancelled' },
    { id: 'failed-task', phase: 'verify', status: 'failed', error: 'Tests failed.' },
  ];

  return {
    id,
    goal: 'Verify downgrade-safe cancellation persistence',
    specId: null,
    project: null,
    createdAt: '2026-07-13T11:00:00.000Z',
    updatedAt,
    budget: { maxTokens: 10_000, maxSteps: 20, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    parallel: 1,
    status: 'aborted',
    plan: {
      specId: null,
      goal: 'Verify downgrade-safe cancellation persistence',
      tasks: [
        { id: 'cancelled-task', phase: 'build', goal: 'Cancel explicitly', deps: [] },
        { id: 'failed-task', phase: 'verify', goal: 'Fail normally', deps: [] },
      ],
    },
    tasks,
    result: 'Swarm cancelled by its owner.',
  };
}

function readRaw(runId: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(swarmsDir(), `${runId}.json`), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m338-cancel-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe('swarm cancellation persistence compatibility', () => {
  it('writes cancelled tasks as pending with a boolean marker without mutating the caller', () => {
    const run = makeRun('raw-json');
    const callerSnapshot = structuredClone(run);

    saveSwarm(run);

    const persisted = readRaw(run.id);
    const tasks = persisted['tasks'] as Array<Record<string, unknown>>;
    expect(tasks[0]).toMatchObject({
      id: 'cancelled-task',
      status: 'pending',
      [TASK_CANCELLED_MARKER]: true,
    });
    expect(tasks[1]).toMatchObject({ id: 'failed-task', status: 'failed' });
    expect(tasks[1]).not.toHaveProperty(TASK_CANCELLED_MARKER);
    expect(run).toEqual(callerSnapshot);
    expect(run.tasks[0]).not.toHaveProperty(TASK_CANCELLED_MARKER);
  });

  it('rehydrates cancellation through both load and list and hides the durable marker', () => {
    const older = makeRun('older', '2026-07-13T12:00:00.000Z');
    const newer = makeRun('newer', '2026-07-13T13:00:00.000Z');
    saveSwarm(older);
    saveSwarm(newer);

    const loaded = loadSwarm(older.id)!;
    expect(loaded.tasks[0]!.status).toBe('cancelled');
    expect(loaded.tasks[0]).not.toHaveProperty(TASK_CANCELLED_MARKER);
    expect(loaded.tasks[1]!.status).toBe('failed');

    const listed = listSwarms();
    expect(listed.map((run) => run.id)).toEqual(['newer', 'older']);
    for (const run of listed) {
      expect(run.tasks[0]!.status).toBe('cancelled');
      expect(run.tasks[0]).not.toHaveProperty(TASK_CANCELLED_MARKER);
      expect(run.tasks[1]!.status).toBe('failed');
    }
  });

  it('uses a status recognized by a pre-cancellation reader', () => {
    const run = makeRun('legacy-reader');
    saveSwarm(run);

    const persisted = readRaw(run.id);
    const task = (persisted['tasks'] as Array<Record<string, unknown>>)[0]!;
    const legacyStatuses = new Set([
      'pending',
      'running',
      'done',
      'failed',
      'skipped',
    ]);

    expect(legacyStatuses.has(task['status'] as string)).toBe(true);
    expect(task['status']).toBe('pending');
    expect(task[TASK_CANCELLED_MARKER]).toBe(true);
  });

  it('is included by a pre-cancellation reader pending selector', () => {
    const run = makeRun('legacy-pending-selector');
    saveSwarm(run);

    const persisted = readRaw(run.id);
    const legacyPendingTasks = (persisted['tasks'] as Array<Record<string, unknown>>)
      .filter((candidate) => candidate['status'] === 'pending');
    expect(legacyPendingTasks.map((candidate) => candidate['id']))
      .toContain('cancelled-task');
  });
});
