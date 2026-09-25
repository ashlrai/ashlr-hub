/**
 * 3.11 cloud lane, unit C2 — `/api/verse/cloud*` (src/core/cloud/cloud-api.ts).
 *
 * Drives the real handler through a real http server (so the mutation gate,
 * body cap and sendJson sanitizer are the production ones) under a relocated
 * HOME. The cloud core (unit C1) is replaced by module mocks: nothing here
 * spawns `claude`, runs `gh`, or launches (and pays for) a cloud session.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { CloudBudgetV1, CloudBudgetView, CloudLaunchResponse, CloudOverviewResponse, CloudTaskV1 } from '../src/core/cloud/types.js';
import { DEFAULT_CLOUD_BUDGET } from '../src/core/cloud/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const core = vi.hoisted(() => ({
  tasks: new Map<string, unknown>(),
  cloudOverview: vi.fn(),
  launchCloudTask: vi.fn(),
  runSelfImprove: vi.fn(),
  refreshCloudTasks: vi.fn(),
  updateCloudBudget: vi.fn(),
  cloudBudgetView: vi.fn(),
  writes: [] as unknown[],
}));

vi.mock('../src/core/cloud/service.js', () => ({
  cloudOverview: core.cloudOverview,
  launchCloudTask: core.launchCloudTask,
  runSelfImprove: core.runSelfImprove,
  cloudSeatStatus: () => ({ id: 'claude-a', ready: true, reason: null }),
}));
vi.mock('../src/core/cloud/store.js', () => ({
  listCloudTasks: () => [...core.tasks.values()],
  readCloudTask: (id: string) => core.tasks.get(id) ?? null,
  writeCloudTask: (task: { id: string }) => {
    core.writes.push(task);
    core.tasks.set(task.id, task);
  },
  updateCloudBudget: core.updateCloudBudget,
  readCloudBudget: () => ({ ...DEFAULT_CLOUD_BUDGET, updatedAt: '2026-09-25T12:00:00.000Z' }),
}));
vi.mock('../src/core/cloud/tracker.js', () => ({ refreshCloudTasks: core.refreshCloudTasks }));
vi.mock('../src/core/cloud/budget.js', () => ({ cloudBudgetView: core.cloudBudgetView }));

const { handleCloudApi, cloudSchedulerRunning } = await import('../src/core/cloud/cloud-api.js');

const TOKEN = 'cloud-test-mutation-token';
let home: string;
let savedHome: string | undefined;
let server: http.Server;
let base: string;
let ctx: VerseApiContext;

function task(over: Partial<CloudTaskV1> = {}): CloudTaskV1 {
  const id = over.id ?? 'ct_20260925T1200_abc123';
  return {
    v: 1,
    id,
    repo: 'ashlrai/ashlr-hub',
    baseBranch: 'main',
    branch: `ashlr-cloud/${id}`,
    title: 'Fix the flaky test',
    prompt: 'Fix the flaky test.',
    origin: 'operator',
    requestedBy: 'mason',
    seat: 'claude-a',
    sessionId: 'session_01abc',
    sessionUrl: 'https://claude.ai/code/session_01abc',
    state: 'running',
    stateReason: null,
    failure: null,
    createdAt: '2026-09-25T12:00:00.000Z',
    launchedAt: '2026-09-25T12:00:05.000Z',
    updatedAt: '2026-09-25T12:00:05.000Z',
    pr: null,
    report: null,
    estimatedCostUsd: 3,
    backlogItemId: null,
    needsYouId: null,
    ...over,
  };
}

function budgetView(budget: CloudBudgetV1): CloudBudgetView {
  return {
    creditsTotalUsd: budget.creditsTotalUsd,
    estimatedSpentUsd: 3,
    estimatedRemainingUsd: budget.creditsTotalUsd - 3,
    sessionsToday: 1,
    selfImproveToday: 0,
    running: 1,
    canLaunch: { ok: true, reason: null },
    canSelfImprove: { ok: true, reason: null },
    estimateNote: 'Estimated at $3 per session — Claude doesn\'t expose the credit balance. Check it on claude.ai and adjust here.',
    balanceUrl: 'https://claude.ai/settings/usage',
    budget,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleCloudApi(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'fallthrough' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-cloud-api-'));
  process.env['HOME'] = home;
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  core.tasks.clear();
  core.writes.length = 0;
  for (const fn of [core.cloudOverview, core.launchCloudTask, core.runSelfImprove, core.refreshCloudTasks, core.updateCloudBudget, core.cloudBudgetView]) {
    fn.mockReset();
  }
  core.cloudBudgetView.mockImplementation((_tasks: unknown, budget: CloudBudgetV1) => budgetView(budget));
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function get<T>(p: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function post<T>(p: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe('module posture', () => {
  it('never starts the background scheduler under a test runner', () => {
    expect(cloudSchedulerRunning()).toBe(false);
  });

  it('declines every path outside /api/verse/cloud without writing', async () => {
    const { status, body } = await get<{ error: string }>('/api/verse/cloudy');
    expect(status).toBe(404);
    expect(body.error).toBe('fallthrough');
    expect((await get<{ error: string }>('/api/verse/budget')).body.error).toBe('fallthrough');
  });

  it('claims unknown sub-paths under its prefix with a plain 404', async () => {
    const { status, body } = await get<{ error: string }>('/api/verse/cloud/nope');
    expect(status).toBe(404);
    expect(body.error).not.toBe('fallthrough');
  });
});

describe('GET /api/verse/cloud', () => {
  it('serves the overview from the service', async () => {
    const overview: CloudOverviewResponse = {
      generatedAt: '2026-09-25T12:00:00.000Z',
      seat: { id: 'claude-a', ready: true, reason: null },
      budget: budgetView({ ...DEFAULT_CLOUD_BUDGET, updatedAt: '2026-09-25T12:00:00.000Z' }),
      tasks: [task()],
      backlog: { items: [], nextUp: null },
    };
    core.cloudOverview.mockResolvedValue(overview);
    const { status, body } = await get<CloudOverviewResponse>('/api/verse/cloud');
    expect(status).toBe(200);
    expect(body).toEqual(overview);
  });

  it('rejects any query parameter', async () => {
    const { status, body } = await get<{ error: string; code: string }>('/api/verse/cloud?all=1');
    expect(status).toBe(400);
    expect(body).toEqual({ code: 'VERSE_INVALID', error: 'Unknown query parameter: all.' });
    expect(core.cloudOverview).not.toHaveBeenCalled();
  });

  it('never forwards a service error (it can quote a checkout path)', async () => {
    core.cloudOverview.mockRejectedValue(new Error(`ENOENT ${home}/.ashlr/cloud/checkouts/x`));
    const { status, body } = await get<{ error: string }>('/api/verse/cloud');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'cloud request failed' });
  });

  it('scrubs the home path out of anything the service returns', async () => {
    core.cloudOverview.mockResolvedValue({ note: `${home}/.ashlr/cloud/tasks` });
    const { body } = await get<{ note: string }>('/api/verse/cloud');
    expect(body.note).not.toContain(home);
    expect(body.note.startsWith('~')).toBe(true);
  });

  it('is a 404 for other verbs on the overview path', async () => {
    const { status } = await post('/api/verse/cloud', {});
    expect(status).toBe(404);
  });
});

describe('POST gates', () => {
  it('is 404 when the server does not allow dispatch', async () => {
    ctx = { ...ctx, allowDispatch: false };
    const { status } = await post('/api/verse/cloud/refresh', {});
    expect(status).toBe(404);
    expect(core.refreshCloudTasks).not.toHaveBeenCalled();
  });

  it('needs the mutation token', async () => {
    const { status } = await post('/api/verse/cloud/refresh', {}, { 'x-ashlr-token': 'wrong' });
    expect(status).toBe(401);
  });

  it('needs a JSON content type', async () => {
    const { status } = await post('/api/verse/cloud/refresh', '{}', { 'content-type': 'text/plain' });
    expect(status).toBe(415);
  });

  it('bounds the body (4 KiB outside launch)', async () => {
    const { status, body } = await post<{ code: string }>('/api/verse/cloud/budget', { creditsTotalUsd: 1, pad: 'x'.repeat(5_000) });
    expect(status).toBe(413);
    expect(body.code).toBe('VERSE_TOO_LARGE');
  });

  it('rejects malformed JSON and non-object bodies', async () => {
    expect((await post('/api/verse/cloud/refresh', '{nope')).status).toBe(400);
    expect((await post('/api/verse/cloud/refresh', '[1]')).status).toBe(400);
  });

  it('rejects a GET on a POST route', async () => {
    expect((await get('/api/verse/cloud/launch')).status).toBe(404);
  });

  it('rejects query parameters on POST routes', async () => {
    const { status } = await post('/api/verse/cloud/refresh?x=1', {});
    expect(status).toBe(400);
  });
});

describe('POST /api/verse/cloud/launch', () => {
  const launched: CloudLaunchResponse = { ok: true, task: task(), error: null, failure: null };

  it('launches with the validated request', async () => {
    core.launchCloudTask.mockResolvedValue(launched);
    const { status, body } = await post<CloudLaunchResponse>('/api/verse/cloud/launch', {
      repo: 'ashlrai/ashlr-hub', baseBranch: 'v3110-cloud', title: '  Fix it  ', prompt: 'Fix the flaky test.', origin: 'chat',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(core.launchCloudTask).toHaveBeenCalledWith({
      repo: 'ashlrai/ashlr-hub', baseBranch: 'v3110-cloud', title: 'Fix it', prompt: 'Fix the flaky test.', origin: 'chat',
    });
  });

  it('defaults the origin to operator', async () => {
    core.launchCloudTask.mockResolvedValue(launched);
    await post('/api/verse/cloud/launch', { repo: 'ashlrai/ashlr-hub', prompt: 'Do it.' });
    expect(core.launchCloudTask).toHaveBeenCalledWith({ repo: 'ashlrai/ashlr-hub', prompt: 'Do it.', origin: 'operator' });
  });

  it('accepts a 20 000-character multibyte prompt (over the 64 KiB default cap)', async () => {
    core.launchCloudTask.mockResolvedValue(launched);
    const prompt = '界'.repeat(20_000);
    const { status } = await post('/api/verse/cloud/launch', { repo: 'ashlrai/ashlr-hub', prompt });
    expect(status).toBe(200);
    expect(core.launchCloudTask.mock.calls[0]![0].prompt).toBe(prompt);
  });

  it.each([
    [{ prompt: 'x' }, 'Repo must look like owner/name.'],
    [{ repo: 'https://github.com/ashlrai/ashlr-hub', prompt: 'x' }, 'Repo must look like owner/name.'],
    [{ repo: 'ashlrai/ashlr-hub; rm -rf ~', prompt: 'x' }, 'Repo must look like owner/name.'],
    [{ repo: 'ashlrai/ashlr-hub', prompt: '   ' }, 'Describe the task to run.'],
    [{ repo: 'ashlrai/ashlr-hub', prompt: 42 }, 'Describe the task to run.'],
    [{ repo: 'ashlrai/ashlr-hub', prompt: 'x', baseBranch: '--upload-pack=evil' }, 'Base branch is not a valid branch name.'],
    [{ repo: 'ashlrai/ashlr-hub', prompt: 'x', baseBranch: 'a..b' }, 'Base branch is not a valid branch name.'],
    [{ repo: 'ashlrai/ashlr-hub', prompt: 'x', baseBranch: 'x.lock' }, 'Base branch is not a valid branch name.'],
    [{ repo: 'ashlrai/ashlr-hub', prompt: 'x', origin: 'leader' }, 'Origin must be one of: chat, operator, cli.'],
    [{ repo: 'ashlrai/ashlr-hub', prompt: 'x', title: 't'.repeat(201) }, 'Title must be text of at most 200 characters.'],
    [{ repo: 'ashlrai/ashlr-hub', prompt: 'x', seat: 'claude-b' }, 'Unknown field seat.'],
  ])('400s bad input %j', async (body, error) => {
    const res = await post<{ error: string; code: string }>('/api/verse/cloud/launch', body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'VERSE_INVALID', error });
    expect(core.launchCloudTask).not.toHaveBeenCalled();
  });

  it('answers a refusal with 409 and the full response body', async () => {
    const refused: CloudLaunchResponse = { ok: false, task: null, error: '20 of 20 cloud sessions used today.', failure: 'budget' };
    core.launchCloudTask.mockResolvedValue(refused);
    const { status, body } = await post<CloudLaunchResponse>('/api/verse/cloud/launch', { repo: 'ashlrai/ashlr-hub', prompt: 'x' });
    expect(status).toBe(409);
    expect(body).toEqual(refused);
  });

  it('answers a failed launch with 409 and the failed task', async () => {
    const failed: CloudLaunchResponse = {
      ok: false,
      task: task({ state: 'failed', failure: 'auth', stateReason: 'The Claude seat is not signed in with a claude.ai account.' }),
      error: 'The Claude seat is not signed in with a claude.ai account.',
      failure: 'auth',
    };
    core.launchCloudTask.mockResolvedValue(failed);
    const { status, body } = await post<CloudLaunchResponse>('/api/verse/cloud/launch', { repo: 'ashlrai/ashlr-hub', prompt: 'x' });
    expect(status).toBe(409);
    expect(body.failure).toBe('auth');
    expect(body.task?.state).toBe('failed');
  });
});

describe('POST /api/verse/cloud/budget', () => {
  it('passes a validated update to the store and answers the budget view', async () => {
    core.updateCloudBudget.mockImplementation((update: Partial<CloudBudgetV1>) => ({
      ...DEFAULT_CLOUD_BUDGET, ...update, selfImprove: { ...DEFAULT_CLOUD_BUDGET.selfImprove, ...update.selfImprove }, updatedAt: '2026-09-25T12:00:00.000Z',
    }));
    const update = {
      creditsTotalUsd: 300,
      creditsSpentAdjustmentUsd: 12.5,
      estimatedCostPerSessionUsd: 2.5,
      maxConcurrent: 2,
      maxSessionsPerDay: 10,
      selfImprove: { enabled: false, repo: 'ashlrai/other', maxPerDay: 1, reserveUsd: 60 },
    };
    const { status, body } = await post<CloudBudgetView>('/api/verse/cloud/budget', update);
    expect(status).toBe(200);
    expect(core.updateCloudBudget).toHaveBeenCalledWith(update);
    expect(body.creditsTotalUsd).toBe(300);
    expect(body.budget.selfImprove.enabled).toBe(false);
  });

  it.each([
    [{}, 'Nothing to update.'],
    [{ creditsTotalUsd: -1 }, 'creditsTotalUsd can\'t be negative.'],
    [{ creditsTotalUsd: '250' }, 'creditsTotalUsd must be a number.'],
    [{ creditsTotalUsd: 5e6 }, 'creditsTotalUsd is too large.'],
    [{ maxSessionsPerDay: 2.5 }, 'maxSessionsPerDay must be a whole number.'],
    [{ selfImprove: true }, 'selfImprove must be an object.'],
    [{ selfImprove: { enabled: 'yes' } }, 'selfImprove.enabled must be true or false.'],
    [{ selfImprove: { repo: 'nope' } }, 'selfImprove.repo must look like owner/name.'],
    [{ selfImprove: { extra: 1 } }, 'Unknown field selfImprove.extra.'],
    [{ selfImprove: {} }, 'Nothing to update.'],
    [{ updatedAt: 'now' }, 'Unknown field updatedAt.'],
  ])('400s %j without writing', async (body, error) => {
    const res = await post<{ error: string }>('/api/verse/cloud/budget', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(core.updateCloudBudget).not.toHaveBeenCalled();
  });
});

describe('POST /api/verse/cloud/refresh', () => {
  it('runs the tracker and answers its counts', async () => {
    core.refreshCloudTasks.mockResolvedValue({ checked: 3, updated: 1 });
    const { status, body } = await post('/api/verse/cloud/refresh', {});
    expect(status).toBe(200);
    expect(body).toEqual({ checked: 3, updated: 1 });
  });

  it('joins a refresh already in flight instead of starting a second sweep', async () => {
    let release!: (v: { checked: number; updated: number }) => void;
    core.refreshCloudTasks.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const a = post('/api/verse/cloud/refresh', {});
    const b = post('/api/verse/cloud/refresh', {});
    await vi.waitFor(() => expect(core.refreshCloudTasks).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    release({ checked: 2, updated: 0 });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body).toEqual({ checked: 2, updated: 0 });
    expect(rb.body).toEqual({ checked: 2, updated: 0 });
    expect(core.refreshCloudTasks).toHaveBeenCalledTimes(1);
  });

  it('rejects any body key', async () => {
    expect((await post('/api/verse/cloud/refresh', { force: true })).status).toBe(400);
  });
});

describe('POST /api/verse/cloud/improve', () => {
  it('runs the operator path (auto: false) with the count', async () => {
    core.runSelfImprove.mockResolvedValue({ launched: [task()], skipped: [] });
    const { status, body } = await post<{ launched: CloudTaskV1[] }>('/api/verse/cloud/improve', { count: 2 });
    expect(status).toBe(200);
    expect(body.launched).toHaveLength(1);
    expect(core.runSelfImprove).toHaveBeenCalledWith({ count: 2, auto: false });
  });

  it('defaults to one item', async () => {
    core.runSelfImprove.mockResolvedValue({ launched: [], skipped: [] });
    await post('/api/verse/cloud/improve', {});
    expect(core.runSelfImprove).toHaveBeenCalledWith({ count: 1, auto: false });
  });

  it.each([0, 6, 1.5, '2', null])('400s count %j', async (count) => {
    const res = await post<{ error: string }>('/api/verse/cloud/improve', { count });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Count must be a whole number from 1 to 5.');
    expect(core.runSelfImprove).not.toHaveBeenCalled();
  });
});

describe('POST /api/verse/cloud/tasks/<id>/dismiss', () => {
  const id = 'ct_20260925T1200_abc123';
  const dismissPath = `/api/verse/cloud/tasks/${id}/dismiss`;

  it('marks the task closed with the plain reason, and never touches GitHub', async () => {
    core.tasks.set(id, task({ state: 'pr-open', pr: { number: 7, url: 'https://github.com/ashlrai/ashlr-hub/pull/7', state: 'open', draft: true, title: 't' } }));
    const { status, body } = await post<{ ok: boolean; task: CloudTaskV1 }>(dismissPath, {});
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.task.state).toBe('closed');
    expect(body.task.stateReason).toBe('Dismissed in Verse.');
    expect(core.writes).toHaveLength(1);
    expect((core.writes[0] as CloudTaskV1).pr?.state).toBe('open');
    expect(core.refreshCloudTasks).not.toHaveBeenCalled();
  });

  it.each(['running', 'failed', 'expired'] as const)('dismisses a %s task', async (state) => {
    core.tasks.set(id, task({ state }));
    expect((await post(dismissPath, {})).status).toBe(200);
  });

  it('is idempotent for a task already closed', async () => {
    core.tasks.set(id, task({ state: 'closed', stateReason: 'PR closed without merge.' }));
    const { status, body } = await post<{ task: CloudTaskV1 }>(dismissPath, {});
    expect(status).toBe(200);
    expect(body.task.stateReason).toBe('PR closed without merge.');
    expect(core.writes).toHaveLength(0);
  });

  it('refuses a merged task', async () => {
    core.tasks.set(id, task({ state: 'merged' }));
    const { status, body } = await post<{ error: string }>(dismissPath, {});
    expect(status).toBe(409);
    expect(body.error).toBe('This task was merged; there is nothing to dismiss.');
    expect(core.writes).toHaveLength(0);
  });

  it.each(['queued', 'launching'] as const)('refuses a %s task (the launch would overwrite it)', async (state) => {
    core.tasks.set(id, task({ state }));
    expect((await post(dismissPath, {})).status).toBe(409);
  });

  it('404s an unknown task', async () => {
    const { status, body } = await post<{ error: string }>(dismissPath, {});
    expect(status).toBe(404);
    expect(body.error).toBe('No cloud task with that id.');
  });

  it('400s an id that is not a task id', async () => {
    const res = await post<{ error: string }>('/api/verse/cloud/tasks/..%2F..%2Fbudget/dismiss', {});
    expect(res.status).toBe(400);
    expect((await post('/api/verse/cloud/tasks/ct_bad/dismiss', {})).status).toBe(400);
  });

  it('rejects a body with keys', async () => {
    core.tasks.set(id, task());
    expect((await post(dismissPath, { reason: 'x' })).status).toBe(400);
    expect(core.writes).toHaveLength(0);
  });
});
