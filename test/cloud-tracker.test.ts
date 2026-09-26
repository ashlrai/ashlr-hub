/**
 * 3.11 cloud lane — delivery tracker (src/core/cloud/tracker.ts). `gh` is
 * injected (never the real CLI); tasks live under a relocated HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listCloudTasks, readCloudTask, writeCloudTask } from '../src/core/cloud/store.js';
import { CLOSED_REOPEN_WATCH_MS, EXPIRED_WATCH_MS, refreshCloudTasks, STALE_LAUNCH_MS } from '../src/core/cloud/tracker.js';
import { CLOUD_TASK_EXPIRY_MS, type CloudTaskV1 } from '../src/core/cloud/types.js';

let home: string;
let savedHome: string | undefined;
let savedAshlrHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  savedAshlrHome = process.env['ASHLR_HOME'];
  delete process.env['ASHLR_HOME'];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-tracker-')));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlrHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const T0 = Date.parse('2026-09-24T12:00:00.000Z');
const at = (ms: number): string => new Date(ms).toISOString();

function seed(suffix: string, state: CloudTaskV1['state'], patch: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  const id = `ct_20260924T1200_${suffix}`;
  const t: CloudTaskV1 = {
    v: 1, id, repo: 'ashlrai/ashlr-hub', baseBranch: 'master', branch: `ashlr-cloud/${id}`, title: 't', prompt: 'p',
    origin: 'operator', requestedBy: 'mason', seat: 'claude-a', sessionId: 'session_x', sessionUrl: 'https://claude.ai/code/session_x',
    state, stateReason: null, failure: null, createdAt: at(T0), launchedAt: at(T0), updatedAt: at(T0), pr: null, report: null,
    estimatedCostUsd: 3, backlogItemId: null, needsYouId: null, ...patch,
  };
  writeCloudTask(t);
  return t;
}

const REPORT = '```ashlr-cloud-report\n{"status":"done","summary":"Fixed.","testsRun":["npm test (3 passed)"],"risks":[]}\n```';
const ghPrRecord = (task: CloudTaskV1, state: 'OPEN' | 'MERGED' | 'CLOSED', body: string | null = REPORT, isDraft = true) => ({
  number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42', state, isDraft, title: '[ashlr-cloud] t', body,
  headRefName: task.branch, baseRefName: task.baseBranch,
  headRepository: { name: 'ashlr-hub' }, headRepositoryOwner: { login: 'ashlrai' }, isCrossRepository: false,
});
const ghPr = (task: CloudTaskV1, state: 'OPEN' | 'MERGED' | 'CLOSED', body: string | null = REPORT, isDraft = true) =>
  JSON.stringify([ghPrRecord(task, state, body, isDraft)]);

type Gh = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
function fakeGh(byBranch: Record<string, string | Error | { fail: true }>): { gh: Gh; calls: string[][] } {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    const branch = args[args.indexOf('--head') + 1]!;
    const answer = byBranch[branch] ?? '[]';
    if (answer instanceof Error) throw answer;
    if (typeof answer !== 'string') return { ok: false, stdout: '', stderr: 'HTTP 502' };
    return { ok: true, stdout: answer, stderr: '' };
  };
  return { gh, calls };
}

describe('refreshCloudTasks', () => {
  it('asks gh for the PR on each watched task\'s branch with the documented argv', async () => {
    const t = seed('aaaaaa', 'running');
    seed('bbbbbb', 'merged');
    seed('cccccc', 'failed', { sessionId: null, launchedAt: null });
    const { gh, calls } = fakeGh({});
    const res = await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) });
    expect(res).toEqual({ checked: 1, updated: 0 });
    expect(calls).toEqual([['pr', 'list', '--repo', 'ashlrai/ashlr-hub', '--head', t.branch, '--state', 'all',
      '--json', 'number,url,state,isDraft,title,body,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository',
      '--limit', '100']]);
  });

  it('running → pr-open with the PR and parsed report', async () => {
    const t = seed('aaaaaa', 'running');
    const { gh } = fakeGh({ [t.branch]: ghPr(t, 'OPEN') });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({
      state: 'pr-open',
      stateReason: 'Draft pull request #42 is open for review.',
      pr: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42', state: 'open', draft: true, title: '[ashlr-cloud] t' },
      deliveryPin: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42' },
      report: { status: 'done', summary: 'Fixed.', testsRun: ['npm test (3 passed)'], risks: [] },
    });
  });

  it('pr-open → merged and pr-open → closed', async () => {
    const a = seed('aaaaaa', 'pr-open');
    const b = seed('bbbbbb', 'pr-open');
    const { gh } = fakeGh({ [a.branch]: ghPr(a, 'MERGED', REPORT, false), [b.branch]: ghPr(b, 'CLOSED') });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 2, updated: 2 });
    expect(readCloudTask(a.id)).toMatchObject({ state: 'merged', stateReason: 'Pull request #42 was merged.', pr: { state: 'merged' } });
    expect(readCloudTask(b.id)).toMatchObject({ state: 'closed', stateReason: 'Pull request #42 was closed without merging.' });
  });

  it('rechecks a verified closed PR and returns its exact reopened identity to review', async () => {
    const t = seed('aaaaaa', 'pr-open');
    let answer = ghPr(t, 'CLOSED');
    const calls: string[][] = [];
    const gh: Gh = async (args) => { calls.push(args); return { ok: true, stdout: answer, stderr: '' }; };
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    const closed = readCloudTask(t.id)!;
    expect(closed).toMatchObject({ state: 'closed', pr: { number: 42, state: 'closed' }, deliveryPin: { number: 42 } });
    const closedAt = Date.parse(closed.updatedAt);

    answer = ghPr(t, 'OPEN', REPORT, false);
    expect(await refreshCloudTasks({ gh, now: () => new Date(closedAt + CLOSED_REOPEN_WATCH_MS - 1) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({
      state: 'pr-open', pr: { number: 42, state: 'open', draft: false },
      deliveryPin: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42' },
      stateReason: 'Pull request #42 is open for review.',
    });
    expect(calls).toHaveLength(2);
  });

  it('does not adopt a replacement PR or poll past the closed watch window', async () => {
    const t = seed('aaaaaa', 'pr-open');
    const { gh: close } = fakeGh({ [t.branch]: ghPr(t, 'CLOSED') });
    await refreshCloudTasks({ gh: close, now: () => new Date(T0 + HOUR) });
    const closed = readCloudTask(t.id)!;
    const closedAt = Date.parse(closed.updatedAt);
    const replacement = JSON.stringify([{ ...ghPrRecord(t, 'OPEN'), number: 43, url: 'https://github.com/ashlrai/ashlr-hub/pull/43' }]);
    const { gh, calls } = fakeGh({ [t.branch]: replacement });
    expect(await refreshCloudTasks({ gh, now: () => new Date(closedAt + HOUR) })).toEqual({ checked: 1, updated: 0 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'closed', pr: { number: 42, state: 'closed' }, deliveryPin: { number: 42 } });
    expect(await refreshCloudTasks({ gh, now: () => new Date(closedAt + CLOSED_REOPEN_WATCH_MS + 1) })).toEqual({ checked: 0, updated: 0 });
    expect(calls).toHaveLength(1);

    const dismissed = seed('bbbbbb', 'closed', { stateReason: 'Dismissed in Verse.' });
    expect(await refreshCloudTasks({ gh, now: () => new Date(closedAt + HOUR) })).toEqual({ checked: 1, updated: 0 });
    expect(calls).toHaveLength(2);
    expect(readCloudTask(dismissed.id)).toMatchObject({ state: 'closed', pr: null });
  });

  it('keeps an open PR current (ready for review, report edited) and writes nothing when nothing changed', async () => {
    const t = seed('aaaaaa', 'running');
    let answer = ghPr(t, 'OPEN');
    const gh: Gh = async () => ({ ok: true, stdout: answer, stderr: '' });
    await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 0 });
    answer = ghPr(t, 'OPEN', 'report removed', false);
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'pr-open', pr: { draft: false }, stateReason: 'Pull request #42 is open for review.', report: null });
  });

  it('accepts one exact task PR after an unrelated branch-name collision', async () => {
    const t = seed('aaaaaa', 'running');
    const unrelated = { ...ghPrRecord(t, 'OPEN'), number: 41, url: 'https://github.com/ashlrai/ashlr-hub/pull/41', baseRefName: 'release' };
    const { gh } = fakeGh({ [t.branch]: JSON.stringify([unrelated, ghPrRecord(t, 'OPEN')]) });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'pr-open', pr: { number: 42 } });
  });

  it('does not claim delivery or expiry from a mismatched or ambiguous PR lookup', async () => {
    const t = seed('aaaaaa', 'running');
    const exact = ghPrRecord(t, 'OPEN');
    const mismatches = [
      { ...exact, baseRefName: 'release' },
      { ...exact, headRefName: 'ashlr-cloud/other-task' },
      { ...exact, url: 'https://github.com/other/repo/pull/42' },
      { ...exact, headRepository: { name: 'other-repo' } },
      { ...exact, headRepositoryOwner: { login: 'someone-else' }, isCrossRepository: true },
    ];
    let answer = JSON.stringify(mismatches);
    const gh: Gh = async () => ({ ok: true, stdout: answer, stderr: '' });
    const late = () => new Date(T0 + CLOUD_TASK_EXPIRY_MS + HOUR);
    expect(await refreshCloudTasks({ gh, now: late })).toEqual({ checked: 1, updated: 0 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'running', pr: null, report: null });

    answer = JSON.stringify([exact, { ...exact, number: 43, url: 'https://github.com/ashlrai/ashlr-hub/pull/43' }]);
    expect(await refreshCloudTasks({ gh, now: late })).toEqual({ checked: 1, updated: 0 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'running', pr: null, report: null });
  });

  it('withdraws a previously shown PR and report when a valid lookup no longer verifies them', async () => {
    const t = seed('aaaaaa', 'running');
    let answer = ghPr(t, 'OPEN');
    const gh: Gh = async () => ({ ok: true, stdout: answer, stderr: '' });
    const late = () => new Date(T0 + CLOUD_TASK_EXPIRY_MS + HOUR);
    expect(await refreshCloudTasks({ gh, now: late })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'pr-open', pr: { number: 42 }, report: { summary: 'Fixed.' } });

    answer = JSON.stringify([{ ...ghPrRecord(t, 'OPEN'), baseRefName: 'release' }]);
    expect(await refreshCloudTasks({ gh, now: late })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({
      state: 'pr-open', pr: null, report: null,
      deliveryPin: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42' },
      stateReason: 'Previously recorded pull request could not be verified on GitHub.',
    });
    expect(await refreshCloudTasks({ gh, now: late })).toEqual({ checked: 1, updated: 0 });

    answer = '[]';
    expect(await refreshCloudTasks({ gh, now: late })).toEqual({ checked: 1, updated: 0 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'pr-open', pr: null, report: null });

    answer = ghPr(t, 'OPEN', null);
    expect(await refreshCloudTasks({ gh, now: late })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'pr-open', pr: { number: 42 }, report: null });
  });

  it('hides the last verified PR on GitHub failure or malformed data, retaining its pin', async () => {
    const t = seed('aaaaaa', 'running');
    const verified: Gh = async () => ({ ok: true, stdout: ghPr(t, 'OPEN'), stderr: '' });
    await refreshCloudTasks({ gh: verified, now: () => new Date(T0 + HOUR) });
    const failed: Gh = async () => ({ ok: false, stdout: '', stderr: 'HTTP 502' });
    const malformed: Gh = async () => ({ ok: true, stdout: '{', stderr: '' });
    expect(await refreshCloudTasks({ gh: failed, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({
      state: 'pr-open', pr: null, report: null,
      deliveryPin: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42' },
      stateReason: 'Pull request verification is unavailable; the previously verified delivery is hidden.',
    });
    expect(await refreshCloudTasks({ gh: malformed, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 0 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'pr-open', pr: null, report: null });
  });

  it('never silently replaces a pinned PR after an outage or restart', async () => {
    const t = seed('aaaaaa', 'running');
    let answer = ghPr(t, 'OPEN');
    const gh: Gh = async () => ({ ok: true, stdout: answer, stderr: '' });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)?.deliveryPin).toEqual({ number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42' });

    answer = '{';
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    answer = JSON.stringify([{ ...ghPrRecord(t, 'OPEN'), number: 43, url: 'https://github.com/ashlrai/ashlr-hub/pull/43' }]);
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({
      state: 'pr-open', pr: null, report: null,
      deliveryPin: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42' },
      stateReason: 'A different pull request was found; the previously verified delivery is hidden.',
    });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 0 });

    // The durable pin survives rereading the task and allows only the original.
    answer = ghPr(t, 'OPEN', null);
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'pr-open', pr: { number: 42 }, report: null });
  });

  it('backfills a legacy PR pin before hiding it on a failed lookup', async () => {
    const legacy = seed('aaaaaa', 'pr-open', {
      pr: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42', state: 'open', draft: true, title: 't' },
      report: { status: 'done', summary: 'Old claim.', testsRun: [], risks: [] },
    });
    expect(legacy.deliveryPin).toBeUndefined();
    const failed: Gh = async () => ({ ok: false, stdout: '', stderr: 'HTTP 502' });
    expect(await refreshCloudTasks({ gh: failed, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(legacy.id)).toMatchObject({
      state: 'pr-open', pr: null, report: null,
      deliveryPin: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42' },
    });
  });

  it('rotates a bounded lookup window so persistent unverified tasks cannot starve older tasks', async () => {
    const tasks = Array.from({ length: 60 }, (_, index) => seed(String(index).padStart(6, '0'), 'running'));
    const { gh, calls } = fakeGh(Object.fromEntries(tasks.map((task) => [task.branch, JSON.stringify([
      { ...ghPrRecord(task, 'OPEN'), baseRefName: 'other' },
    ])])));
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 50, updated: 0 });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 50, updated: 0 });
    expect(new Set(calls.map((args) => args[args.indexOf('--head') + 1])).size).toBe(60);
    expect(listCloudTasks().every((task) => task.state === 'running')).toBe(true);
  });

  it('treats malformed or full GitHub results as unknown rather than no PR', async () => {
    const t = seed('aaaaaa', 'running');
    const exact = ghPrRecord(t, 'OPEN');
    let answer = JSON.stringify([{ ...exact, body: undefined }]);
    const gh: Gh = async () => ({ ok: true, stdout: answer, stderr: '' });
    const late = () => new Date(T0 + CLOUD_TASK_EXPIRY_MS + HOUR);
    expect(await refreshCloudTasks({ gh, now: late })).toEqual({ checked: 1, updated: 0 });
    answer = JSON.stringify(Array.from({ length: 100 }, () => exact));
    expect(await refreshCloudTasks({ gh, now: late })).toEqual({ checked: 1, updated: 0 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'running', pr: null });
  });

  it('expires a running task with no PR after CLOUD_TASK_EXPIRY_MS, not before', async () => {
    const t = seed('aaaaaa', 'running');
    const { gh } = fakeGh({});
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + CLOUD_TASK_EXPIRY_MS - 1000) })).toEqual({ checked: 1, updated: 0 });
    expect(readCloudTask(t.id)!.state).toBe('running');
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + CLOUD_TASK_EXPIRY_MS + 1000) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'expired', stateReason: 'No pull request arrived within 6 hours. The session link still works.', sessionUrl: 'https://claude.ai/code/session_x' });
  });

  it('picks up a late PR on an expired task while it is still watched, then stops asking', async () => {
    const t = seed('aaaaaa', 'expired');
    const { gh, calls } = fakeGh({ [t.branch]: ghPr(t, 'OPEN') });
    await refreshCloudTasks({ gh, now: () => new Date(T0 + 10 * HOUR) });
    expect(readCloudTask(t.id)!.state).toBe('pr-open');

    const old = seed('bbbbbb', 'expired');
    calls.length = 0;
    await refreshCloudTasks({ gh, now: () => new Date(T0 + EXPIRED_WATCH_MS + HOUR) });
    expect(calls.some((c) => c.includes(old.branch))).toBe(false);
  });

  it('leaves tasks unchanged when gh fails, throws, or prints something unexpected', async () => {
    const a = seed('aaaaaa', 'running');
    const b = seed('bbbbbb', 'running');
    const c = seed('cccccc', 'running');
    const d = seed('dddddd', 'running');
    const { gh } = fakeGh({
      [a.branch]: { fail: true }, [b.branch]: new Error('spawn gh ENOENT'), [c.branch]: 'not json',
      [d.branch]: JSON.stringify([{ number: 1, url: 'https://evil.example/pr/1', state: 'OPEN' }]),
    });
    // Past the expiry: a failed lookup must not be read as "no PR".
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + CLOUD_TASK_EXPIRY_MS + HOUR) })).toEqual({ checked: 4, updated: 0 });
    expect(listCloudTasks().every((t) => t.state === 'running')).toBe(true);
  });

  it('fails a launch orphaned in queued/launching by a restart, and leaves a fresh one alone', async () => {
    const stale = seed('aaaaaa', 'launching', { sessionId: null, launchedAt: null });
    const fresh = seed('bbbbbb', 'queued', { sessionId: null, launchedAt: null, createdAt: at(T0 + STALE_LAUNCH_MS) });
    const { gh, calls } = fakeGh({});
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + STALE_LAUNCH_MS + 1000) })).toEqual({ checked: 0, updated: 1 });
    expect(readCloudTask(stale.id)).toMatchObject({ state: 'failed', failure: 'unknown', stateReason: 'The launch was interrupted before a cloud session started.' });
    expect(readCloudTask(fresh.id)!.state).toBe('queued');
    expect(calls).toEqual([]);
  });

  it('never overwrites a task that changed on disk during the refresh (e.g. dismissed)', async () => {
    const t = seed('aaaaaa', 'running');
    const gh: Gh = async () => {
      writeCloudTask({ ...readCloudTask(t.id)!, state: 'closed', stateReason: 'Dismissed in Verse.' });
      return { ok: true, stdout: ghPr(t, 'OPEN'), stderr: '' };
    };
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 0 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'closed', stateReason: 'Dismissed in Verse.' });
  });

  it('answers zero on an empty store', async () => {
    expect(await refreshCloudTasks({ gh: fakeGh({}).gh })).toEqual({ checked: 0, updated: 0 });
  });
});
