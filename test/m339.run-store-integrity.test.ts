import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunState } from '../src/core/types.js';
import {
  listRuns,
  listRunsDetailed,
  loadRun,
  saveRun,
} from '../src/core/run/orchestrator.js';

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

  it('does not mutate historical file or directory modes while reading', () => {
    if (process.platform === 'win32') return;
    const state = makeState('historical-mode');
    writeNamed(`${state.id}.json`, state);
    fs.chmodSync(runsDir(), 0o755);
    fs.chmodSync(runPath(state.id), 0o644);

    expect(loadRun(state.id)?.id).toBe(state.id);
    expect(listRuns().map((run) => run.id)).toContain(state.id);
    expect(fs.statSync(runsDir()).mode & 0o777).toBe(0o755);
    expect(fs.statSync(runPath(state.id)).mode & 0o777).toBe(0o644);
  });

  it('does not let malformed newer files consume the valid run limit', () => {
    const older = makeState('valid-older', {
      createdAt: '2026-07-13T11:00:00.000Z',
      updatedAt: '2026-07-13T11:00:00.000Z',
    });
    writeNamed(`${older.id}.json`, older);
    const newestMtime = Date.now() + 60_000;
    for (let index = 0; index < 8; index += 1) {
      const file = path.join(runsDir(), `malformed-${index}.json`);
      fs.writeFileSync(file, '{', 'utf8');
      const newer = new Date(newestMtime + index * 1_000);
      fs.utimesSync(file, newer, newer);
    }

    const detailed = listRunsDetailed({ limit: 1, maxCandidates: 16 });

    expect(detailed.runs.map((run) => run.id)).toEqual([older.id]);
    expect(detailed.invalidFiles).toBe(8);
    expect(detailed.filesRead).toBe(9);
    expect(detailed.sourceState).toBe('degraded');
  });

  it('samples beyond a full malformed candidate window to recover valid history', () => {
    const valid = makeState('valid-beyond-candidate-window', {
      updatedAt: '2026-07-13T10:00:00.000Z',
    });
    writeNamed(`${valid.id}.json`, valid);
    const validMtime = new Date('2026-07-13T09:00:00.000Z');
    fs.utimesSync(runPath(valid.id), validMtime, validMtime);
    for (let index = 0; index < 513; index += 1) {
      const file = path.join(runsDir(), `candidate-flood-${index.toString().padStart(3, '0')}.json`);
      fs.writeFileSync(file, '{', 'utf8');
      const newer = new Date(Date.parse('2026-07-13T11:00:00.000Z') + index);
      fs.utimesSync(file, newer, newer);
    }

    const detailed = listRunsDetailed({ limit: 1 });
    expect(detailed.runs.map((run) => run.id)).toEqual([valid.id]);
    expect(detailed).toMatchObject({ complete: true, sourceState: 'degraded' });
    expect(detailed.stopReasons).toContain('invalid-file');
  });

  it('reports bounded directory and candidate scans as incomplete', () => {
    for (let index = 0; index < 6; index += 1) {
      const id = `bounded-${index}`;
      writeNamed(`${id}.json`, makeState(id, {
        updatedAt: new Date(Date.parse('2026-07-13T13:00:00.000Z') + index).toISOString(),
      }));
    }

    const directoryLimited = listRunsDetailed({ limit: 6, maxDirectoryEntries: 2 });
    expect(directoryLimited).toMatchObject({
      complete: false,
      entriesExamined: 2,
      sourceState: 'degraded',
    });
    expect(directoryLimited.stopReasons).toContain('directory-limit');

    const candidateLimited = listRunsDetailed({ limit: 6, maxCandidates: 2 });
    expect(candidateLimited).toMatchObject({
      complete: false,
      filesDiscovered: 6,
      filesRead: 2,
      sourceState: 'degraded',
    });
    expect(candidateLimited.stopReasons).toContain('candidate-limit');
  });

  it('keeps the compatibility wrapper bounded by the default result limit', () => {
    for (let index = 0; index < 205; index += 1) {
      const id = `default-bound-${index.toString().padStart(3, '0')}`;
      writeNamed(`${id}.json`, makeState(id));
    }

    expect(listRuns()).toHaveLength(200);
    expect(listRunsDetailed()).toMatchObject({
      complete: true,
      filesDiscovered: 205,
      filesRead: 205,
      runs: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
    });
  });

  it('round-trips a valid direct-load record larger than the list projection cap', () => {
    const state = makeState('large-direct-load', { result: 'x'.repeat(2 * 1024 * 1024) });

    saveRun(state);

    expect(loadRun(state.id)?.result).toBe(state.result);
    expect(listRunsDetailed().oversizedFiles).toBe(1);
  });

  it('enforces per-file and aggregate byte limits without consuming result slots', () => {
    writeNamed('oversized.json', {
      ...makeState('oversized'),
      result: 'x'.repeat(4_096),
    });
    writeNamed('small.json', makeState('small', {
      updatedAt: '2026-07-13T12:59:00.000Z',
    }));
    const oversizedMtime = new Date(Date.now() + 60_000);
    fs.utimesSync(runPath('oversized'), oversizedMtime, oversizedMtime);

    const oversized = listRunsDetailed({ limit: 1, maxFileBytes: 1_024, maxBytes: 8_192 });
    expect(oversized.runs.map((run) => run.id)).toEqual(['small']);
    expect(oversized.oversizedFiles).toBe(1);
    expect(oversized.stopReasons).toContain('per-file-byte-limit');

    const aggregateLimited = listRunsDetailed({ limit: 2, maxFileBytes: 8_192, maxBytes: 1 });
    expect(aggregateLimited).toMatchObject({
      runs: [],
      bytesRead: 0,
      complete: false,
      sourceState: 'degraded',
    });
    expect(aggregateLimited.stopReasons).toContain('byte-limit');
  });

  it('sorts valid results by semantic freshness with a deterministic id tie-break', () => {
    writeNamed('z-last.json', makeState('z-last', {
      createdAt: '2026-07-13T13:00:00.000Z',
      updatedAt: '2026-07-13T13:01:00.000Z',
    }));
    writeNamed('a-first.json', makeState('a-first', {
      createdAt: '2026-07-13T13:00:00.000Z',
      updatedAt: '2026-07-13T13:01:00.000Z',
    }));
    writeNamed('older.json', makeState('older', {
      createdAt: '2026-07-13T12:00:00.000Z',
      updatedAt: '2026-07-13T12:00:00.000Z',
    }));

    expect(listRunsDetailed({ limit: 3 }).runs.map((run) => run.id)).toEqual([
      'a-first',
      'z-last',
      'older',
    ]);
  });

  it('selects the semantic newest record even when filesystem mtimes are inverted', () => {
    const semanticNewest = makeState('semantic-newest', {
      updatedAt: '2026-07-13T14:00:00.000Z',
    });
    const semanticOlder = makeState('semantic-older', {
      updatedAt: '2026-07-13T13:00:00.000Z',
    });
    writeNamed(`${semanticNewest.id}.json`, semanticNewest);
    writeNamed(`${semanticOlder.id}.json`, semanticOlder);
    const newerMtime = new Date('2026-07-13T15:00:00.000Z');
    const olderMtime = new Date('2026-07-13T12:00:00.000Z');
    fs.utimesSync(runPath(semanticNewest.id), olderMtime, olderMtime);
    fs.utimesSync(runPath(semanticOlder.id), newerMtime, newerMtime);

    expect(listRunsDetailed({ limit: 1 }).runs.map((run) => run.id)).toEqual([
      semanticNewest.id,
    ]);
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
  it('refuses a linked Ashlr state root on read and write paths', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m339-root-outside-'));
    const externalRuns = path.join(outside, 'runs');
    fs.mkdirSync(externalRuns, { recursive: true });
    fs.writeFileSync(
      path.join(externalRuns, 'external.json'),
      JSON.stringify(makeState('external')),
      'utf8',
    );
    fs.symlinkSync(outside, path.join(tmpHome, '.ashlr'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(loadRun('external')).toBeNull();
      expect(listRunsDetailed()).toMatchObject({
        runs: [],
        sourceState: 'degraded',
        stopReasons: expect.arrayContaining(['unsafe-path']),
      });
      expect(() => saveRun(makeState('escape-root'))).toThrow(/state root/);
      expect(fs.existsSync(path.join(externalRuns, 'escape-root.json'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

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
