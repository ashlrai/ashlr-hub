import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PathLike } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SwarmRun } from '../src/core/types.js';

const renameState = vi.hoisted(() => ({
  fail: false,
  sources: [] as string[],
  existedAtRename: [] as boolean[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync(oldPath: PathLike, newPath: PathLike): void {
      renameState.sources.push(String(oldPath));
      renameState.existedAtRename.push(actual.existsSync(oldPath));
      if (renameState.fail) throw new Error('injected rename failure');
      actual.renameSync(oldPath, newPath);
    },
  };
});

import {
  listSwarms,
  loadSwarm,
  saveSwarm,
  swarmsDir,
} from '../src/core/swarm/store.js';

const originalHome = process.env.HOME;
let tmpHome: string;

function makeRun(id: string, overrides: Partial<SwarmRun> = {}): SwarmRun {
  const goal = overrides.goal ?? 'Protect swarm persistence integrity';
  return {
    id,
    goal,
    specId: null,
    project: null,
    createdAt: '2026-07-13T12:00:00.000Z',
    updatedAt: '2026-07-13T12:30:00.000Z',
    budget: { maxTokens: 10_000, maxSteps: 20, allowCloud: false },
    usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
    parallel: 1,
    status: 'running',
    plan: {
      specId: null,
      goal,
      tasks: [
        { id: 'build-1', phase: 'build', goal: 'Implement safely', deps: [] },
      ],
    },
    tasks: [{ id: 'build-1', phase: 'build', status: 'pending' }],
    ...overrides,
  };
}

function writeRecord(fileId: string, value: unknown): void {
  fs.mkdirSync(swarmsDir(), { recursive: true });
  fs.writeFileSync(
    path.join(swarmsDir(), `${fileId}.json`),
    JSON.stringify(value, null, 2),
    'utf8',
  );
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m339-store-'));
  process.env.HOME = tmpHome;
  renameState.fail = false;
  renameState.sources.length = 0;
  renameState.existedAtRename.length = 0;
});

afterEach(() => {
  renameState.fail = false;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe('swarm store record integrity', () => {
  it('rejects an embedded id that does not match the requested id or filename', () => {
    const valid = makeRun('valid-record');
    saveSwarm(valid);
    writeRecord('forged-file', makeRun('embedded-other-id'));

    expect(loadSwarm('forged-file')).toBeNull();
    expect(listSwarms().map((run) => run.id)).toEqual(['valid-record']);
  });

  it('applies the same minimal shape and task validation to load and list', () => {
    const valid = makeRun('valid-shape');
    saveSwarm(valid);

    const invalidRecords: Array<[string, unknown]> = [
      ['null-record', null],
      ['array-record', []],
      ['missing-tasks', { ...makeRun('missing-tasks'), tasks: undefined }],
      ['object-tasks', { ...makeRun('object-tasks'), tasks: {} }],
      ['primitive-task', { ...makeRun('primitive-task'), tasks: ['bad'] }],
      ['null-task', { ...makeRun('null-task'), tasks: [null] }],
    ];

    for (const [id, record] of invalidRecords) writeRecord(id, record);

    for (const [id] of invalidRecords) expect(loadSwarm(id)).toBeNull();
    expect(listSwarms().map((run) => run.id)).toEqual(['valid-shape']);
  });

  it('rejects case-folded aliases and prevents case-variant id collisions', () => {
    const original = makeRun('CaseSensitiveId');
    writeRecord(original.id, original);

    expect(loadSwarm('casesensitiveid')).toBeNull();
    saveSwarm(makeRun('casesensitiveid'));
    saveSwarm(original);
    fs.rmSync(path.join(swarmsDir(), `${original.id}.json`));
    saveSwarm(makeRun('casesensitiveid'));
    expect(loadSwarm('casesensitiveid')).toBeNull();
    saveSwarm(original);
    expect(loadSwarm(original.id)).toEqual(original);
    expect(listSwarms().map((run) => run.id)).toEqual([original.id]);
  });

  it('migrates historical regular files and directories to private modes on read', () => {
    if (process.platform === 'win32') return;
    const original = makeRun('historical-mode');
    writeRecord(original.id, original);
    const persistedFile = path.join(swarmsDir(), `${original.id}.json`);
    fs.chmodSync(swarmsDir(), 0o755);
    fs.chmodSync(persistedFile, 0o644);

    expect(loadSwarm(original.id)).toEqual(original);
    expect(fs.statSync(swarmsDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(persistedFile).mode & 0o777).toBe(0o600);
  });
});

describe('swarm store atomic replacement', () => {
  it('refuses a linked store directory instead of escaping the state root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m339-outside-'));
    fs.mkdirSync(path.dirname(swarmsDir()), { recursive: true });
    fs.symlinkSync(outside, swarmsDir(), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      saveSwarm(makeRun('escape'));
      expect(loadSwarm('escape')).toBeNull();
      expect(listSwarms()).toEqual([]);
      expect(fs.existsSync(path.join(outside, 'escape.json'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not share or overwrite the legacy predictable sidecar', () => {
    const run = makeRun('unique-temp');
    const target = path.join(swarmsDir(), `${run.id}.json`);
    const legacyTmp = `${target}.tmp`;
    fs.mkdirSync(swarmsDir(), { recursive: true });
    fs.writeFileSync(legacyTmp, 'leave-me-alone', 'utf8');

    saveSwarm(run);

    expect(loadSwarm(run.id)).toEqual(run);
    expect(fs.readFileSync(legacyTmp, 'utf8')).toBe('leave-me-alone');
    expect(renameState.sources).toHaveLength(1);
    expect(renameState.sources[0]).not.toBe(legacyTmp);
    if (process.platform !== 'win32') {
      expect(fs.statSync(swarmsDir()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it('preserves the last valid record and cleans unique sibling temps on failure', () => {
    const original = makeRun('replace-failure', { goal: 'Last valid goal' });
    saveSwarm(original);

    renameState.sources.length = 0;
    renameState.existedAtRename.length = 0;
    renameState.fail = true;

    saveSwarm({
      ...original,
      goal: 'Uncommitted update one',
      updatedAt: '2026-07-13T13:00:00.000Z',
    });
    saveSwarm({
      ...original,
      goal: 'Uncommitted update two',
      updatedAt: '2026-07-13T13:30:00.000Z',
    });

    expect(loadSwarm(original.id)).toEqual(original);
    expect(renameState.existedAtRename).toEqual([true, true]);
    expect(new Set(renameState.sources).size).toBe(2);

    const target = path.join(swarmsDir(), `${original.id}.json`);
    for (const source of renameState.sources) {
      expect(path.dirname(source)).toBe(path.dirname(target));
      expect(source).not.toBe(`${target}.tmp`);
      expect(path.basename(source)).toMatch(
        /^replace-failure\.json\.\d+\.[0-9a-f]{24}\.tmp$/,
      );
      expect(fs.existsSync(source)).toBe(false);
    }
    expect(fs.readdirSync(swarmsDir()).filter((file) => file.endsWith('.tmp')))
      .toEqual([]);
  });
});

describe('swarm store cancellation compatibility', () => {
  it('retains the private snapshot encoding through validated load and list', () => {
    const cancelled = makeRun('cancelled-record', {
      status: 'aborted',
      tasks: [{
        id: 'build-1',
        phase: 'build',
        status: 'cancelled',
        result: 'Partial output kept only in the current-reader snapshot.',
        error: 'Cancelled by owner.',
      }],
    });

    saveSwarm(cancelled);

    const raw = JSON.parse(
      fs.readFileSync(
        path.join(swarmsDir(), `${cancelled.id}.json`),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const persistedTask = (
      raw['tasks'] as Array<Record<string, unknown>>
    )[0]!;

    expect(persistedTask['status']).toBe('pending');
    expect(persistedTask).not.toHaveProperty('result');
    expect(persistedTask).not.toHaveProperty('error');
    expect(persistedTask['_ashlrCancelled']).toMatchObject({
      version: 1,
      task: cancelled.tasks[0],
    });
    expect(loadSwarm(cancelled.id)).toEqual(cancelled);
    expect(listSwarms()).toEqual([cancelled]);
  });
});
