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
  listSwarmsDetailed,
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
    saveSwarm(loadSwarm(original.id)!);
    fs.rmSync(path.join(swarmsDir(), `${original.id}.json`));
    saveSwarm(makeRun('casesensitiveid'));
    expect(loadSwarm('casesensitiveid')).toBeNull();
    expect(saveSwarm(original)).toEqual({ ok: true, revision: 1 });
    expect(loadSwarm(original.id)).toEqual(original);
    expect(listSwarms().map((run) => run.id)).toEqual([original.id]);
  });

  it('does not mutate historical regular file or directory modes on read', () => {
    if (process.platform === 'win32') return;
    const original = makeRun('historical-mode');
    writeRecord(original.id, original);
    const persistedFile = path.join(swarmsDir(), `${original.id}.json`);
    fs.chmodSync(swarmsDir(), 0o755);
    fs.chmodSync(persistedFile, 0o644);

    expect(loadSwarm(original.id)).toEqual(original);
    expect(listSwarms()).toEqual([original]);
    expect(fs.statSync(swarmsDir()).mode & 0o777).toBe(0o755);
    expect(fs.statSync(persistedFile).mode & 0o777).toBe(0o644);
  });

  it('does not let malformed recent files starve older valid swarms', () => {
    const valid = makeRun('valid-after-malformed', {
      updatedAt: '2026-07-13T10:00:00.000Z',
    });
    writeRecord(valid.id, valid);

    for (let index = 0; index < 250; index += 1) {
      writeRecord(`malformed-${index.toString().padStart(3, '0')}`, '{');
    }

    const detailed = listSwarmsDetailed();
    expect(detailed.swarms.map((run) => run.id)).toContain(valid.id);
    expect(detailed.invalidFiles).toBe(250);
    expect(detailed.complete).toBe(true);
    expect(detailed.sourceState).toBe('degraded');
    expect(detailed.stopReasons).toContain('invalid-file');
    expect(listSwarms().map((run) => run.id)).toContain(valid.id);
  });

  it('samples beyond a full malformed candidate window to recover valid history', () => {
    const valid = makeRun('valid-beyond-candidate-window', {
      updatedAt: '2026-07-13T10:00:00.000Z',
    });
    writeRecord(valid.id, valid);
    const validMtime = new Date('2026-07-13T09:00:00.000Z');
    fs.utimesSync(path.join(swarmsDir(), `${valid.id}.json`), validMtime, validMtime);
    for (let index = 0; index < 513; index += 1) {
      const id = `candidate-flood-${index.toString().padStart(3, '0')}`;
      writeRecord(id, '{');
      const newer = new Date(Date.parse('2026-07-13T11:00:00.000Z') + index);
      const file = path.join(swarmsDir(), `${id}.json`);
      fs.utimesSync(file, newer, newer);
    }

    const detailed = listSwarmsDetailed({ limit: 1 });
    expect(detailed.swarms.map((run) => run.id)).toEqual([valid.id]);
    expect(detailed).toMatchObject({ complete: true, sourceState: 'degraded' });
    expect(detailed.stopReasons).toContain('invalid-file');
  });

  it('reports bounded candidate and byte work as incomplete', () => {
    for (let index = 0; index < 8; index += 1) {
      const id = `bounded-${index}`;
      writeRecord(id, makeRun(id, {
        updatedAt: `2026-07-13T12:00:0${index}.000Z`,
      }));
    }

    const candidateBounded = listSwarmsDetailed({
      limit: 8,
      maxCandidates: 3,
    });
    expect(candidateBounded.complete).toBe(false);
    expect(candidateBounded.filesRead).toBe(3);
    expect(candidateBounded.swarms).toHaveLength(3);
    expect(candidateBounded.stopReasons).toContain('candidate-limit');

    const byteBounded = listSwarmsDetailed({
      limit: 8,
      maxBytes: 1,
    });
    expect(byteBounded.complete).toBe(false);
    expect(byteBounded.bytesRead).toBe(0);
    expect(byteBounded.stopReasons).toContain('byte-limit');
  });

  it('applies the output limit only after validating candidates', () => {
    const invalidPaths: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      writeRecord(`invalid-${index}`, null);
      invalidPaths.push(path.join(swarmsDir(), `invalid-${index}.json`));
    }
    const older = makeRun('older-valid', {
      updatedAt: '2026-07-13T11:00:00.000Z',
    });
    const newer = makeRun('newer-valid', {
      updatedAt: '2026-07-13T13:00:00.000Z',
    });
    writeRecord(older.id, older);
    writeRecord(newer.id, newer);
    const malformedMtime = new Date('2026-07-13T14:00:00.000Z');
    for (const invalidPath of invalidPaths) {
      fs.utimesSync(invalidPath, malformedMtime, malformedMtime);
    }

    const detailed = listSwarmsDetailed({ limit: 2 });
    expect(detailed.swarms.map((run) => run.id)).toEqual([
      newer.id,
      older.id,
    ]);
    expect(detailed.invalidFiles).toBe(4);
  });

  it('reports directory enumeration limits without throwing', () => {
    for (let index = 0; index < 6; index += 1) {
      const id = `directory-bound-${index}`;
      writeRecord(id, makeRun(id));
    }

    const detailed = listSwarmsDetailed({ maxDirectoryEntries: 2 });
    expect(detailed.complete).toBe(false);
    expect(detailed.entriesExamined).toBe(2);
    expect(detailed.filesDiscovered).toBe(2);
    expect(detailed.stopReasons).toContain('directory-limit');
  });

  it('reports oversized records without allocating them into results', () => {
    const id = 'oversized-record';
    writeRecord(id, makeRun(id, { goal: 'x'.repeat(4_096) }));

    const detailed = listSwarmsDetailed({
      maxFileBytes: 512,
      maxBytes: 1_024,
    });
    expect(detailed.swarms).toEqual([]);
    expect(detailed.oversizedFiles).toBe(1);
    expect(detailed.complete).toBe(false);
    expect(detailed.stopReasons).toContain('per-file-byte-limit');
    expect(loadSwarm(id)).toEqual(makeRun(id, { goal: 'x'.repeat(4_096) }));
  });

  it('round-trips a valid direct-load record larger than the list projection cap', () => {
    const run = makeRun('large-direct-load', { goal: 'x'.repeat(2 * 1024 * 1024) });

    saveSwarm(run);

    expect(loadSwarm(run.id)).toEqual(run);
    expect(listSwarmsDetailed().oversizedFiles).toBe(1);
  });

  it('selects the semantic newest record even when filesystem mtimes are inverted', () => {
    const semanticNewest = makeRun('semantic-newest', {
      updatedAt: '2026-07-13T14:00:00.000Z',
    });
    const semanticOlder = makeRun('semantic-older', {
      updatedAt: '2026-07-13T13:00:00.000Z',
    });
    writeRecord(semanticNewest.id, semanticNewest);
    writeRecord(semanticOlder.id, semanticOlder);
    const newerMtime = new Date('2026-07-13T15:00:00.000Z');
    const olderMtime = new Date('2026-07-13T12:00:00.000Z');
    fs.utimesSync(path.join(swarmsDir(), `${semanticNewest.id}.json`), olderMtime, olderMtime);
    fs.utimesSync(path.join(swarmsDir(), `${semanticOlder.id}.json`), newerMtime, newerMtime);

    expect(listSwarmsDetailed({ limit: 1 }).swarms.map((run) => run.id)).toEqual([
      semanticNewest.id,
    ]);
  });

  it('sorts invalid persisted timestamps after valid semantic history', () => {
    writeRecord('a-invalid-time', makeRun('a-invalid-time', {
      createdAt: 'not-a-date',
      updatedAt: 'also-not-a-date',
    }));
    writeRecord('z-valid-time', makeRun('z-valid-time', {
      updatedAt: '2026-07-13T13:00:00.000Z',
    }));

    expect(listSwarmsDetailed({ limit: 2 }).swarms.map((run) => run.id)).toEqual([
      'z-valid-time',
      'a-invalid-time',
    ]);
  });

  it('rejects record symlinks without mutating their external targets', () => {
    if (process.platform === 'win32') return;
    const id = 'linked-record';
    const outside = path.join(tmpHome, 'external-sentinel.json');
    fs.mkdirSync(swarmsDir(), { recursive: true });
    fs.writeFileSync(outside, JSON.stringify(makeRun(id)), { mode: 0o644 });
    fs.symlinkSync(outside, path.join(swarmsDir(), `${id}.json`));

    expect(loadSwarm(id)).toBeNull();
    expect(listSwarmsDetailed()).toMatchObject({
      swarms: [],
      sourceState: 'degraded',
      unreadableFiles: 1,
      stopReasons: ['unsafe-file'],
    });
    expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(outside, 'utf8')).toBe(JSON.stringify(makeRun(id)));
  });
});

describe('swarm store atomic replacement', () => {
  it('refuses a linked Ashlr state root on read and write paths', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m339-root-outside-'));
    const externalSwarms = path.join(outside, 'swarms');
    fs.mkdirSync(externalSwarms, { recursive: true });
    fs.writeFileSync(
      path.join(externalSwarms, 'external.json'),
      JSON.stringify(makeRun('external')),
      'utf8',
    );
    fs.symlinkSync(outside, path.join(tmpHome, '.ashlr'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(loadSwarm('external')).toBeNull();
      expect(listSwarmsDetailed()).toMatchObject({
        swarms: [],
        sourceState: 'degraded',
        stopReasons: expect.arrayContaining(['unsafe-path']),
      });
      saveSwarm(makeRun('escape-root'));
      expect(fs.existsSync(path.join(externalSwarms, 'escape-root.json'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

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
    const committed = structuredClone(original);

    renameState.sources.length = 0;
    renameState.existedAtRename.length = 0;
    renameState.fail = true;

    original.goal = 'Uncommitted update one';
    original.updatedAt = '2026-07-13T13:00:00.000Z';
    expect(saveSwarm(original)).toEqual({ ok: false, reason: 'unavailable' });
    original.goal = 'Uncommitted update two';
    original.updatedAt = '2026-07-13T13:30:00.000Z';
    expect(saveSwarm(original)).toEqual({ ok: false, reason: 'unavailable' });

    expect(loadSwarm(original.id)).toEqual(committed);
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

  it('rejects stale same-id terminal rollback and advances a private revision', () => {
    const original = makeRun('generation-cas');
    expect(saveSwarm(original)).toEqual({ ok: true, revision: 1 });
    const winner = loadSwarm(original.id)!;
    const stale = loadSwarm(original.id)!;

    winner.status = 'done';
    winner.result = 'Authoritative completion';
    winner.updatedAt = '2026-07-13T15:00:00.000Z';
    expect(saveSwarm(winner)).toEqual({ ok: true, revision: 2 });

    stale.status = 'running';
    stale.updatedAt = '2026-07-13T16:00:00.000Z';
    expect(saveSwarm(stale)).toEqual({ ok: false, reason: 'conflict' });
    expect(loadSwarm(original.id)).toMatchObject({
      status: 'done',
      result: 'Authoritative completion',
    });
    const raw = JSON.parse(
      fs.readFileSync(path.join(swarmsDir(), `${original.id}.json`), 'utf8'),
    );
    expect(raw['_ashlrPersistence']).toEqual({ schemaVersion: 1, revision: 2 });
    expect(loadSwarm(original.id)).not.toHaveProperty('_ashlrPersistence');
  });

  it('detects a lock-unaware writer even when it preserves the revision marker', () => {
    const run = makeRun('legacy-writer-conflict');
    saveSwarm(run);
    const stale = loadSwarm(run.id)!;
    const file = path.join(swarmsDir(), `${run.id}.json`);
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    legacy.status = 'done';
    legacy.result = 'Written by a lock-unaware older process';
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2), { mode: 0o600 });

    stale.status = 'aborted';
    expect(saveSwarm(stale)).toEqual({ ok: false, reason: 'conflict' });
    expect(loadSwarm(run.id)).toMatchObject({
      status: 'done',
      result: 'Written by a lock-unaware older process',
    });
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
