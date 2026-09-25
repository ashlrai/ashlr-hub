/**
 * 3.11 cloud lane — delivery tracker (src/core/cloud/tracker.ts). `gh` is
 * injected (never the real CLI); tasks live under a relocated HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listCloudTasks, readCloudTask, writeCloudTask } from '../src/core/cloud/store.js';
import { EXPIRED_WATCH_MS, refreshCloudTasks, STALE_LAUNCH_MS } from '../src/core/cloud/tracker.js';
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
const ghPr = (state: 'OPEN' | 'MERGED' | 'CLOSED', body: string | null = REPORT, isDraft = true) =>
  JSON.stringify([{ number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42', state, isDraft, title: '[ashlr-cloud] t', body }]);

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
      '--json', 'number,url,state,isDraft,title,body', '--limit', '1']]);
  });

  it('running → pr-open with the PR and parsed report', async () => {
    const t = seed('aaaaaa', 'running');
    const { gh } = fakeGh({ [t.branch]: ghPr('OPEN') });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    expect(readCloudTask(t.id)).toMatchObject({
      state: 'pr-open',
      stateReason: 'Draft pull request #42 is open for review.',
      pr: { number: 42, url: 'https://github.com/ashlrai/ashlr-hub/pull/42', state: 'open', draft: true, title: '[ashlr-cloud] t' },
      report: { status: 'done', summary: 'Fixed.', testsRun: ['npm test (3 passed)'], risks: [] },
    });
  });

  it('pr-open → merged and pr-open → closed', async () => {
    const a = seed('aaaaaa', 'pr-open');
    const b = seed('bbbbbb', 'pr-open');
    const { gh } = fakeGh({ [a.branch]: ghPr('MERGED', REPORT, false), [b.branch]: ghPr('CLOSED') });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 2, updated: 2 });
    expect(readCloudTask(a.id)).toMatchObject({ state: 'merged', stateReason: 'Pull request #42 was merged.', pr: { state: 'merged' } });
    expect(readCloudTask(b.id)).toMatchObject({ state: 'closed', stateReason: 'Pull request #42 was closed without merging.' });
  });

  it('keeps an open PR current (ready for review, report edited) and writes nothing when nothing changed', async () => {
    const t = seed('aaaaaa', 'running');
    let answer = ghPr('OPEN');
    const gh: Gh = async () => ({ ok: true, stdout: answer, stderr: '' });
    await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) });
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 0 });
    answer = ghPr('OPEN', 'report removed', false);
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 1 });
    // Marked ready; the last good report is kept when the body loses it.
    expect(readCloudTask(t.id)).toMatchObject({ state: 'pr-open', pr: { draft: false }, stateReason: 'Pull request #42 is open for review.', report: { summary: 'Fixed.' } });
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
    const { gh, calls } = fakeGh({ [t.branch]: ghPr('OPEN') });
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
      return { ok: true, stdout: ghPr('OPEN'), stderr: '' };
    };
    expect(await refreshCloudTasks({ gh, now: () => new Date(T0 + HOUR) })).toEqual({ checked: 1, updated: 0 });
    expect(readCloudTask(t.id)).toMatchObject({ state: 'closed', stateReason: 'Dismissed in Verse.' });
  });

  it('answers zero on an empty store', async () => {
    expect(await refreshCloudTasks({ gh: fakeGh({}).gh })).toEqual({ checked: 0, updated: 0 });
  });
});
