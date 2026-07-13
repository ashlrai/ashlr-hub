import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunState } from '../src/core/types.js';
import { listRuns, loadRun, saveRun } from '../src/core/run/orchestrator.js';

let previousHome: string | undefined;
let tmpHome: string;

function runsDir(): string {
  return path.join(tmpHome, '.ashlr', 'runs');
}

function runPath(id: string): string {
  return path.join(runsDir(), `${id}.json`);
}

function makeState(id: string, overrides: Partial<RunState> = {}): RunState {
  const now = '2026-07-13T13:00:00.000Z';
  return {
    id,
    goal: 'Harden run persistence integrity',
    engine: 'builtin',
    provider: 'ollama',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 10, tokensOut: 5, steps: 2, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status: 'running',
    ...overrides,
  };
}

function writeNamed(name: string, value: unknown): void {
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.writeFileSync(path.join(runsDir(), name), JSON.stringify(value), 'utf8');
}

beforeEach(() => {
  previousHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m339-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('run-store read integrity', () => {
  it('rejects malformed top-level and task shapes through load and list', () => {
    const malformed: Array<[string, unknown]> = [
      ['null-record', null],
      ['array-record', []],
      ['missing-tasks', { id: 'missing-tasks' }],
      ['object-tasks', { id: 'object-tasks', tasks: {} }],
      ['invalid-task', { id: 'invalid-task', tasks: [null] }],
    ];
    for (const [id, value] of malformed) writeNamed(`${id}.json`, value);

    for (const [id] of malformed) expect(loadRun(id)).toBeNull();
    expect(listRuns()).toEqual([]);
  });

  it('requires the embedded run id to match the requested id and filename', () => {
    const mismatched = makeState('embedded-id');
    writeNamed('file-id.json', mismatched);

    expect(loadRun('file-id')).toBeNull();
    expect(listRuns()).toEqual([]);
  });

  it('rejects case-folded aliases and prevents case-variant id collisions', () => {
    const original = makeState('CaseSensitiveId');
    writeNamed('CaseSensitiveId.json', original);

    expect(loadRun('casesensitiveid')).toBeNull();
    expect(() => saveRun(makeState('casesensitiveid'))).toThrow(/collides/);
    saveRun(original);
    fs.rmSync(runPath(original.id));
    expect(() => saveRun(makeState('casesensitiveid'))).toThrow(/collides/);
    saveRun(original);
    expect(loadRun(original.id)?.id).toBe(original.id);
    expect(listRuns().map((run) => run.id)).toEqual([original.id]);
  });

  it('migrates historical regular files and directories to private modes on read', () => {
    if (process.platform === 'win32') return;
    const state = makeState('historical-mode');
    writeNamed(`${state.id}.json`, state);
    fs.chmodSync(runsDir(), 0o755);
    fs.chmodSync(runPath(state.id), 0o644);

    expect(loadRun(state.id)?.id).toBe(state.id);
    expect(fs.statSync(runsDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(runPath(state.id)).mode & 0o777).toBe(0o600);
  });

  it('preserves cancellation markers through validated load and list paths', () => {
    const state = makeState('cancelled-roundtrip', {
      status: 'aborted',
      terminationReason: 'cancelled',
      tasks: [{
        id: 'cancelled-task',
        goal: 'Interrupted work',
        deps: [],
        status: 'failed',
        error: 'Task cancelled.',
      }],
    });

    saveRun(state);

    expect(loadRun(state.id)).toMatchObject({
      id: state.id,
      terminationReason: 'cancelled',
      tasks: [{ error: 'Task cancelled.' }],
    });
    expect(listRuns()).toMatchObject([{
      id: state.id,
      terminationReason: 'cancelled',
      tasks: [{ error: 'Task cancelled.' }],
    }]);
  });
});

describe('run-store write integrity', () => {
  it('refuses a linked store directory instead of escaping the state root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m339-outside-'));
    fs.mkdirSync(path.dirname(runsDir()), { recursive: true });
    fs.symlinkSync(outside, runsDir(), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(() => saveRun(makeState('escape'))).toThrow(/run store/);
      expect(loadRun('escape')).toBeNull();
      expect(listRuns()).toEqual([]);
      expect(fs.existsSync(path.join(outside, 'escape.json'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not share the legacy predictable sidecar and installs a private file', () => {
    const state = makeState('unique-temp');
    const legacyTmp = `${runPath(state.id)}.tmp`;
    fs.mkdirSync(runsDir(), { recursive: true });
    fs.writeFileSync(legacyTmp, 'leave-me-alone', 'utf8');

    saveRun(state);

    expect(loadRun(state.id)?.id).toBe(state.id);
    expect(fs.readFileSync(legacyTmp, 'utf8')).toBe('leave-me-alone');
    expect(
      fs.readdirSync(runsDir()).filter((name) => name.startsWith(`.${state.id}.json.`)),
    ).toEqual([]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(runsDir()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(runPath(state.id)).mode & 0o777).toBe(0o600);
    }
  });

  it('cleans its randomized sidecar when the atomic rename fails', () => {
    const state = makeState('rename-failure');
    fs.mkdirSync(runPath(state.id), { recursive: true });

    expect(() => saveRun(state)).toThrow();
    expect(state.trajectoryId).toBeUndefined();
    expect(state.runEventSummary).toBeUndefined();
    expect(
      fs.readdirSync(runsDir()).filter((name) => name.startsWith(`.${state.id}.json.`)),
    ).toEqual([]);
  });
});
