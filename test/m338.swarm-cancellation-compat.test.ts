import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SwarmRun, SwarmTaskRun } from '../src/core/types.js';
import {
  listSwarmsDetailed,
  listSwarms,
  loadSwarm,
  saveSwarm,
  swarmsDir,
} from '../src/core/swarm/store.js';

const TASK_CANCELLED_MARKER = '_ashlrCancelled';
const TASK_CANCELLED_SNAPSHOT_VERSION = 1;
const originalHome = process.env.HOME;
let tmpHome: string;

function makeRun(
  id: string,
  updatedAt = '2026-07-13T12:00:00.000Z',
): SwarmRun {
  const tasks: SwarmTaskRun[] = [
    {
      id: 'cancelled-task',
      phase: 'build',
      status: 'cancelled',
      result: 'Stale partial result.',
      usage: { tokensIn: 120, tokensOut: 45, steps: 2, estCostUsd: 0 },
      error: 'Interrupted after producing output.',
      signature: {
        alg: 'hmac-sha256',
        hash: 'content-hash',
        sig: 'content-signature',
        signer: 'local',
        ts: '2026-07-13T11:30:00.000Z',
      },
    },
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

function writeRaw(runId: string, value: unknown): void {
  fs.writeFileSync(
    path.join(swarmsDir(), `${runId}.json`),
    JSON.stringify(value, null, 2),
    'utf8',
  );
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
  it('sanitizes the legacy-visible pending task and privately snapshots current semantics', () => {
    const run = makeRun('raw-json');
    const callerSnapshot = structuredClone(run);

    saveSwarm(run);

    const persisted = readRaw(run.id);
    const tasks = persisted['tasks'] as Array<Record<string, unknown>>;
    expect(tasks[0]).toMatchObject({
      id: 'cancelled-task',
      status: 'pending',
      [TASK_CANCELLED_MARKER]: {
        version: TASK_CANCELLED_SNAPSHOT_VERSION,
        task: run.tasks[0],
      },
    });
    expect(tasks[0]).not.toHaveProperty('result');
    expect(tasks[0]).not.toHaveProperty('usage');
    expect(tasks[0]).not.toHaveProperty('error');
    expect(tasks[0]).not.toHaveProperty('signature');
    expect(tasks[1]).toMatchObject({ id: 'failed-task', status: 'failed' });
    expect(tasks[1]).not.toHaveProperty(TASK_CANCELLED_MARKER);
    expect(run).toEqual(callerSnapshot);
    expect(run.tasks[0]).not.toHaveProperty(TASK_CANCELLED_MARKER);
  });

  it('preserves the complete cancellation through modern load and list round trips', () => {
    const older = makeRun('older', '2026-07-13T12:00:00.000Z');
    const newer = makeRun('newer', '2026-07-13T13:00:00.000Z');
    saveSwarm(older);
    saveSwarm(newer);

    const loaded = loadSwarm(older.id)!;
    expect(loaded).toEqual(older);
    expect(loaded.tasks[0]).not.toHaveProperty(TASK_CANCELLED_MARKER);

    const listed = listSwarms();
    expect(listed.map((run) => run.id)).toEqual(['newer', 'older']);
    expect(listed).toEqual([newer, older]);
    expect(listed[0]!.tasks[0]).not.toHaveProperty(TASK_CANCELLED_MARKER);
    expect(listed[1]!.tasks[0]).not.toHaveProperty(TASK_CANCELLED_MARKER);

    const detailed = listSwarmsDetailed({ limit: 2 });
    expect(detailed.swarms).toEqual([newer, older]);
    expect(detailed).toMatchObject({
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      invalidFiles: 0,
      unreadableFiles: 0,
      oversizedFiles: 0,
    });
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
    expect(task[TASK_CANCELLED_MARKER]).toMatchObject({
      version: TASK_CANCELLED_SNAPSHOT_VERSION,
    });
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

  it('accepts legacy success and does not resurrect the cancellation snapshot', () => {
    const run = makeRun('legacy-success');
    saveSwarm(run);

    const persisted = readRaw(run.id);
    const task = (persisted['tasks'] as Array<Record<string, unknown>>)[0]!;
    task['status'] = 'done';
    task['result'] = 'Legacy reader completed the retry.';
    task['usage'] = {
      tokensIn: 30,
      tokensOut: 12,
      steps: 1,
      estCostUsd: 0,
    };
    task['signature'] = {
      alg: 'hmac-sha256',
      hash: 'legacy-hash',
      sig: 'legacy-signature',
      signer: 'local',
      ts: '2026-07-13T12:30:00.000Z',
    };
    writeRaw(run.id, persisted);

    const expectedTask = {
      id: 'cancelled-task',
      phase: 'build',
      status: 'done',
      result: 'Legacy reader completed the retry.',
      usage: {
        tokensIn: 30,
        tokensOut: 12,
        steps: 1,
        estCostUsd: 0,
      },
      signature: {
        alg: 'hmac-sha256',
        hash: 'legacy-hash',
        sig: 'legacy-signature',
        signer: 'local',
        ts: '2026-07-13T12:30:00.000Z',
      },
    };

    const loaded = loadSwarm(run.id)!;
    expect(loaded.tasks[0]).toEqual(expectedTask);
    expect(loaded.tasks[0]).not.toHaveProperty(TASK_CANCELLED_MARKER);
    expect(listSwarms().find((candidate) => candidate.id === run.id)?.tasks[0])
      .toEqual(expectedTask);

    saveSwarm(loaded);
    const rewrittenTask = (
      readRaw(run.id)['tasks'] as Array<Record<string, unknown>>
    )[0]!;
    expect(rewrittenTask).toEqual(expectedTask);
    expect(rewrittenTask).not.toHaveProperty(TASK_CANCELLED_MARKER);
  });
});
