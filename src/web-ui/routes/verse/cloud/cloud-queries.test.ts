/**
 * cloud-queries — the overview read is optional (404 is "not in this build",
 * never a crash), 401 still propagates, and every write carries the token,
 * re-reads the overview, and turns a 200 `ok: false` launch into the
 * server's own sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { ApiError } from '../../../data/client.js';
import { evictAll, getQuerySnapshot, runQuery } from '../../../data/cache.js';
import {
  CLOUD_KEY,
  CloudLaunchRefusedError,
  CloudLockedError,
  cloudQuery,
  dismissCloudTask,
  launchCloudTask,
  narrowCloudOverview,
  refreshCloudTasks,
  runCloudImprove,
  updateCloudBudget,
} from './cloud-queries.js';
import { json, overview, stubCloudFetch, task } from './cloud-fixtures.test-support.js';

const TOKEN = 'b'.repeat(64);

beforeEach(() => {
  evictAll();
  clearMutationToken();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
});

describe('the overview read', () => {
  it('answers the narrowed overview', async () => {
    const body = overview({ tasks: [task('running')] });
    stubCloudFetch(body);
    const read = await cloudQuery.fetch();
    expect(read).toEqual({ value: body, available: true, reason: null });
  });

  it('turns a 404 into "not in this build", and an unknown shape into "nothing shown"', async () => {
    stubCloudFetch(null);
    expect(await cloudQuery.fetch()).toEqual({ value: null, available: false, reason: 'The cloud lane is not in this build yet.' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ tasks: 'nope' })));
    const odd = await cloudQuery.fetch();
    expect(odd.value).toBeNull();
    expect(odd.available).toBe(true);
    expect(odd.reason).toMatch(/shape this version does not recognise/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await cloudQuery.fetch()).reason).toBe('The cloud lane could not be reached.');
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 503)));
    expect((await cloudQuery.fetch()).reason).toBe('The cloud lane failed to load on the server.');
  });

  it('lets an expired read session through as the error it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized' }, 401)));
    await expect(cloudQuery.fetch()).rejects.toBeInstanceOf(ApiError);
  });

  it('narrows structurally: seat, budget numbers and gates, task ids, backlog items', () => {
    const good = overview();
    expect(narrowCloudOverview(good)).toBe(good);
    expect(narrowCloudOverview({ ...good, seat: null })).toBeNull();
    expect(narrowCloudOverview({ ...good, budget: { ...good.budget, sessionsToday: '3' } })).toBeNull();
    expect(narrowCloudOverview({ ...good, budget: { ...good.budget, canLaunch: undefined } })).toBeNull();
    expect(narrowCloudOverview({ ...good, tasks: [{ state: 'running' }] })).toBeNull();
    expect(narrowCloudOverview({ ...good, backlog: { items: null } })).toBeNull();
    expect(narrowCloudOverview([])).toBeNull();
  });
});

describe('writes', () => {
  it('refuse without the mutation token, before anything is sent', async () => {
    const { posted } = stubCloudFetch(overview());
    await expect(launchCloudTask({ repo: 'a/b', prompt: 'x', origin: 'operator' })).rejects.toBeInstanceOf(CloudLockedError);
    await expect(updateCloudBudget({ maxConcurrent: 2 })).rejects.toBeInstanceOf(CloudLockedError);
    expect(posted).toEqual([]);
  });

  it('launch posts the request with the token and re-reads the overview', async () => {
    setMutationToken(TOKEN);
    const launched = task('running');
    const { posted, fetchMock } = stubCloudFetch(overview(), { post: () => json({ ok: true, task: launched, error: null, failure: null }) });
    await runQuery(CLOUD_KEY, () => cloudQuery.fetch());
    fetchMock.mockClear();
    const res = await launchCloudTask({ repo: 'ashlrai/ashlr-hub', baseBranch: 'master', prompt: 'Fix it.', origin: 'chat' });
    expect(res.task).toEqual(launched);
    expect(posted).toEqual([{ url: '/api/verse/cloud/launch', body: { repo: 'ashlrai/ashlr-hub', baseBranch: 'master', prompt: 'Fix it.', origin: 'chat' } }]);
    const [, init] = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect((init as RequestInit).headers).toMatchObject({ 'x-ashlr-token': TOKEN });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/verse/cloud' && (i as RequestInit).method === 'GET')).toBe(true));
    expect(getQuerySnapshot(CLOUD_KEY).data).toBeTruthy();
  });

  it('turns a 200 refusal into its sentence and failure code', async () => {
    setMutationToken(TOKEN);
    stubCloudFetch(overview(), { post: () => json({ ok: false, task: null, error: '20 of 20 sessions used today.', failure: 'budget' }) });
    const err = await launchCloudTask({ repo: 'a/b', prompt: 'x', origin: 'operator' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudLaunchRefusedError);
    expect((err as CloudLaunchRefusedError).message).toBe('20 of 20 sessions used today.');
    expect((err as CloudLaunchRefusedError).failure).toBe('budget');
    stubCloudFetch(overview(), { post: () => json({ ok: false }) });
    await expect(launchCloudTask({ repo: 'a/b', prompt: 'x', origin: 'operator' })).rejects.toThrow('The cloud session was not started, and the server sent no reason.');
  });

  it('keeps a 4xx refusal as an ApiError carrying the server sentence', async () => {
    setMutationToken(TOKEN);
    stubCloudFetch(overview(), { post: () => json({ ok: false, error: 'Repo must look like owner/name.', failure: null }, 400) });
    const err = await launchCloudTask({ repo: 'a/b', prompt: 'x', origin: 'operator' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).detail).toBe('Repo must look like owner/name.');
  });

  it('improve, refresh, budget and dismiss hit their routes', async () => {
    setMutationToken(TOKEN);
    const done = task('running');
    const { posted } = stubCloudFetch(overview(), {
      post: (url) => (url.endsWith('/improve') ? json({ launched: [done], skipped: [{ itemId: 'x', reason: 'claimed' }] }) : json({ ok: true })),
    });
    expect(await runCloudImprove({ count: 2 })).toEqual({ launched: [done], skipped: [{ itemId: 'x', reason: 'claimed' }] });
    await refreshCloudTasks();
    await updateCloudBudget({ selfImprove: { enabled: false } });
    await dismissCloudTask(done.id);
    expect(posted).toEqual([
      { url: '/api/verse/cloud/improve', body: { count: 2 } },
      { url: '/api/verse/cloud/refresh', body: {} },
      { url: '/api/verse/cloud/budget', body: { selfImprove: { enabled: false } } },
      { url: `/api/verse/cloud/tasks/${done.id}/dismiss`, body: {} },
    ]);
  });

  it('never splices an id that is not a task id into a path', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubCloudFetch(overview());
    await expect(dismissCloudTask('../budget')).rejects.toThrow('That task id is not one Verse issued, so nothing was sent.');
    expect(posted).toEqual([]);
  });

  it('reads a malformed improve answer as nothing launched', async () => {
    setMutationToken(TOKEN);
    stubCloudFetch(overview(), { post: () => json({}) });
    expect(await runCloudImprove()).toEqual({ launched: [], skipped: [] });
  });
});
