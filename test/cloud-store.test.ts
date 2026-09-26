/**
 * 3.11 cloud lane — persistence (src/core/cloud/store.ts).
 *
 * Every test runs under a relocated HOME (a fresh temp dir per test, inside
 * the per-worker temp home test/setup provides). ASHLR_HOME is cleared unless
 * a test sets it on purpose.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  cloudBudgetPath,
  cloudHome,
  cloudTasksDir,
  listCloudTasks,
  newCloudTaskId,
  readCloudBudget,
  readCloudTask,
  updateCloudBudget,
  writeCloudTask,
} from '../src/core/cloud/store.js';
import { CLOUD_TASK_ID_PATTERN, DEFAULT_CLOUD_BUDGET, type CloudTaskV1 } from '../src/core/cloud/types.js';

let home: string;
let savedHome: string | undefined;
let savedAshlrHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  savedAshlrHome = process.env['ASHLR_HOME'];
  delete process.env['ASHLR_HOME'];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-')));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlrHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function task(id: string, createdAt: string, patch: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  return {
    v: 1, id, repo: 'ashlrai/ashlr-hub', baseBranch: 'master', branch: `ashlr-cloud/${id}`, title: 'Fix a thing',
    prompt: 'Fix the thing.', origin: 'operator', requestedBy: 'mason', seat: 'claude-a', sessionId: null, sessionUrl: null,
    state: 'queued', stateReason: null, failure: null, createdAt, launchedAt: null, updatedAt: createdAt, pr: null, report: null,
    estimatedCostUsd: 3, backlogItemId: null, needsYouId: null, ...patch,
  };
}

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe('paths', () => {
  it('resolves under HOME per call, and follows an absolute ASHLR_HOME', () => {
    expect(cloudHome()).toBe(path.join(home, '.ashlr', 'cloud'));
    const other = path.join(home, 'elsewhere');
    process.env['ASHLR_HOME'] = other;
    expect(cloudHome()).toBe(path.join(other, 'cloud'));
    // A relative ASHLR_HOME is not a home: fall back rather than write relative to the cwd.
    process.env['ASHLR_HOME'] = 'relative/dir';
    expect(cloudHome()).toBe(path.join(home, '.ashlr', 'cloud'));
  });
});

describe('tasks', () => {
  it('writes atomically with 0600 files in 0700 dirs and reads back', () => {
    const t = task('ct_20260924T2331_k3f9q2', '2026-09-24T23:31:00.000Z');
    writeCloudTask(t);
    const file = path.join(cloudTasksDir(), `${t.id}.json`);
    expect(mode(file)).toBe(0o600);
    expect(mode(cloudTasksDir())).toBe(0o700);
    expect(mode(cloudHome())).toBe(0o700);
    const back = readCloudTask(t.id);
    expect(back).toMatchObject({ id: t.id, state: 'queued', prompt: 'Fix the thing.' });
    // updatedAt is stamped by the write and mirrored onto the caller's object.
    expect(back!.updatedAt).toBe(t.updatedAt);
    expect(Date.parse(back!.updatedAt)).toBeGreaterThan(Date.parse('2026-09-24T23:31:00.000Z'));
    expect(fs.readdirSync(cloudTasksDir()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects invalid ids and malformed tasks', () => {
    expect(() => writeCloudTask(task('../escape', '2026-09-24T00:00:00.000Z'))).toThrow(/invalid id/);
    expect(() => writeCloudTask(task('ct_20260924T2331_k3f9q2', '2026-09-24T00:00:00.000Z', { branch: 'main' }))).toThrow(/malformed/);
    expect(readCloudTask('../../etc/passwd')).toBeNull();
  });

  it('reads legacy tasks without a delivery pin and validates a persisted pin', () => {
    const id = 'ct_20260924T2331_k3f9q2';
    const createdAt = '2026-09-24T23:31:00.000Z';
    writeCloudTask(task(id, createdAt));
    expect(readCloudTask(id)?.deliveryPin).toBeUndefined();
    const pinned = task(id, createdAt, {
      deliveryPin: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42' },
    });
    writeCloudTask(pinned);
    expect(readCloudTask(id)?.deliveryPin).toEqual(pinned.deliveryPin);
    expect(() => writeCloudTask(task(id, createdAt, {
      deliveryPin: { number: 42, url: 'https://github.com/other/repo/pull/42' },
    }))).toThrow(/malformed/);
    expect(() => writeCloudTask(task(id, createdAt, {
      deliveryPin: { number: 0, url: 'https://github.com/ashlrai/ashlr-hub/pull/0' },
    }))).toThrow(/malformed/);
  });

  it('lists newest first, skipping corrupt, foreign, mismatched and symlinked files, with a limit', () => {
    writeCloudTask(task('ct_20260920T0000_aaaaaa', '2026-09-20T00:00:00.000Z'));
    writeCloudTask(task('ct_20260922T0000_bbbbbb', '2026-09-22T00:00:00.000Z'));
    writeCloudTask(task('ct_20260921T0000_cccccc', '2026-09-21T00:00:00.000Z'));
    const dir = cloudTasksDir();
    fs.writeFileSync(path.join(dir, 'ct_20260923T0000_dddddd.json'), '{not json', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}', { mode: 0o600 });
    // A copy under another name claims a different id: skipped.
    fs.copyFileSync(path.join(dir, 'ct_20260920T0000_aaaaaa.json'), path.join(dir, 'ct_20260925T0000_eeeeee.json'));
    // A symlink planted at a task name is never followed.
    const outside = path.join(home, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(task('ct_20260926T0000_ffffff', '2026-09-26T00:00:00.000Z')));
    fs.symlinkSync(outside, path.join(dir, 'ct_20260926T0000_ffffff.json'));

    expect(listCloudTasks().map((t) => t.id)).toEqual([
      'ct_20260922T0000_bbbbbb', 'ct_20260921T0000_cccccc', 'ct_20260920T0000_aaaaaa',
    ]);
    expect(listCloudTasks(2)).toHaveLength(2);
    expect(listCloudTasks(0)).toEqual([]);
  });

  it('refuses a FIFO planted at a task name instead of hanging', () => {
    if (process.platform === 'win32') return;
    writeCloudTask(task('ct_20260920T0000_aaaaaa', '2026-09-20T00:00:00.000Z'));
    const fifo = path.join(cloudTasksDir(), 'ct_20260921T0000_bbbbbb.json');
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status !== 0) return;
    expect(readCloudTask('ct_20260921T0000_bbbbbb')).toBeNull();
    expect(listCloudTasks()).toHaveLength(1);
  });

  it('answers empty when nothing was ever written', () => {
    expect(listCloudTasks()).toEqual([]);
    expect(fs.existsSync(cloudHome())).toBe(false);
  });
});

describe('budget', () => {
  it('defaults when missing, corrupt, or from another schema version', () => {
    expect(readCloudBudget()).toMatchObject({ ...DEFAULT_CLOUD_BUDGET, selfImprove: { ...DEFAULT_CLOUD_BUDGET.selfImprove } });
    fs.mkdirSync(cloudHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cloudBudgetPath(), '{"v":1,', { mode: 0o600 });
    expect(readCloudBudget().creditsTotalUsd).toBe(250);
    fs.writeFileSync(cloudBudgetPath(), JSON.stringify({ v: 2, creditsTotalUsd: 5 }), { mode: 0o600 });
    expect(readCloudBudget().creditsTotalUsd).toBe(250);
  });

  it('reads a hand-edited file field by field', () => {
    fs.mkdirSync(cloudHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cloudBudgetPath(), JSON.stringify({
      v: 1, creditsTotalUsd: 100, estimatedCostPerSessionUsd: 'lots', maxConcurrent: -3,
      selfImprove: { enabled: false, repo: 'not a repo', maxPerDay: 2.9 },
    }), { mode: 0o600 });
    const b = readCloudBudget();
    expect(b.creditsTotalUsd).toBe(100);
    expect(b.estimatedCostPerSessionUsd).toBe(3);
    expect(b.maxConcurrent).toBe(1);
    expect(b.selfImprove).toEqual({ enabled: false, repo: 'ashlrai/ashlr-hub', maxPerDay: 2, reserveUsd: 40, maxOpenPrs: 3 });
  });

  it('clamps the self-improvement review backpressure to 1..50 (3.13)', () => {
    expect(updateCloudBudget({ selfImprove: { maxOpenPrs: 0 } }).selfImprove.maxOpenPrs).toBe(1);
    expect(updateCloudBudget({ selfImprove: { maxOpenPrs: 999 } }).selfImprove.maxOpenPrs).toBe(50);
    expect(updateCloudBudget({ selfImprove: { maxOpenPrs: 5 } }).selfImprove.maxOpenPrs).toBe(5);
    expect(readCloudBudget().selfImprove.maxOpenPrs).toBe(5);
  });

  it('updates a subset, clamps, persists 0600, and never takes v/updatedAt from the caller', () => {
    const before = Date.now();
    const next = updateCloudBudget({
      creditsTotalUsd: 300.456, creditsSpentAdjustmentUsd: -20, maxSessionsPerDay: 10_000,
      selfImprove: { enabled: false, reserveUsd: 25 },
      ...({ v: 9, updatedAt: '1999-01-01T00:00:00.000Z' } as object),
    });
    expect(next).toMatchObject({
      v: 1, creditsTotalUsd: 300.46, creditsSpentAdjustmentUsd: 0, maxSessionsPerDay: 500, maxConcurrent: 4,
      selfImprove: { enabled: false, repo: 'ashlrai/ashlr-hub', maxPerDay: 4, reserveUsd: 25 },
    });
    expect(Date.parse(next.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(mode(cloudBudgetPath())).toBe(0o600);
    expect(readCloudBudget()).toEqual(next);
    // A second update keeps what the first set.
    expect(updateCloudBudget({ maxConcurrent: 2 })).toMatchObject({ creditsTotalUsd: 300.46, maxConcurrent: 2, selfImprove: { enabled: false } });
  });
});

describe('ids', () => {
  it('stamps the UTC minute and 6 random base36 chars', () => {
    const id = newCloudTaskId(new Date('2026-09-24T23:31:59.999Z'));
    expect(id).toMatch(CLOUD_TASK_ID_PATTERN);
    expect(id.startsWith('ct_20260924T2331_')).toBe(true);
    const many = new Set(Array.from({ length: 200 }, () => newCloudTaskId(new Date())));
    expect(many.size).toBe(200);
  });
});
