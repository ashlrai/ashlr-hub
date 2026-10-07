/** Real task-store/tracker/dismiss/launch integration; every provider and key operation is fake. */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { devinBudgetView, devinTaskAcuHeadroom, devinTaskAcuUsed } from '../src/core/devin/budget.js';
import type { DevinSession } from '../src/core/devin/client.js';
import { terminateDevinChat } from '../src/core/devin/chat.js';
import { DEVIN_IDLE_REFRESH_EVERY_MS, DEVIN_REFRESH_EVERY_MS, dismissDevinTask, setDevinApiDepsForTest,
  startDevinScheduler, stopDevinScheduler } from '../src/core/devin/devin-api.js';
import * as config from '../src/core/config.js';
import { storeDevinKey } from '../src/core/devin/secret.js';
import { launchDevinTask, resetDevinStatusCacheForTest } from '../src/core/devin/service.js';
import { devinHome, readDevinTask, updateDevinBudget, writeDevinConnection, writeDevinTask } from '../src/core/devin/store.js';
import { refreshDevinTasks, resetDevinTrackerCursorForTest } from '../src/core/devin/tracker.js';
import { DEFAULT_DEVIN_BUDGET, DEVIN_TASK_EXPIRY_MS, type DevinBudgetV1, type DevinTaskV1 } from '../src/core/devin/types.js';
import { fakeDevin, FAKE_KEY, FAKE_ORG } from './helpers/fake-devin.js';
import { fakeKeychain } from './helpers/fake-keychain.js';

const now = new Date(2026, 9, 2, 12);
const repo = 'ashlrai/devin-exposure-fixture';
const id = 'dv_20261002T1200_000001';
const task = (patch: Partial<DevinTaskV1> = {}): DevinTaskV1 => ({
  v: 1, id, repo, baseBranch: 'main', branch: `ashlr-devin/${id}`, title: 'Exposure', prompt: 'Existing work',
  origin: 'operator', requestedBy: 'mason', sessionId: 'devin-exposure',
  sessionUrl: 'https://app.devin.ai/sessions/devin-exposure', state: 'running', stateReason: null, failure: null,
  createdAt: now.toISOString(), launchedAt: now.toISOString(), updatedAt: now.toISOString(),
  session: { status: 'running', statusDetail: 'working', acusConsumed: 2, prUrls: [], readAt: now.toISOString() },
  maxAcu: 10, devinMode: 'normal', pr: null, headSha: null, report: null, backlogItemId: null, ...patch,
});
const budget = (patch: Partial<DevinBudgetV1> = {}): DevinBudgetV1 => ({
  ...DEFAULT_DEVIN_BUDGET, acuBudgetTotal: 100, maxAcuPerDay: 100, updatedAt: now.toISOString(), ...patch,
});
const session = (patch: Partial<DevinSession> = {}): DevinSession => ({
  sessionId: 'devin-exposure', url: 'https://app.devin.ai/sessions/devin-exposure', status: 'running',
  statusDetail: 'working', acusConsumed: 2, pullRequests: [], tags: [], title: null, structuredOutput: null, ...patch,
});

beforeEach(() => {
  rmSync(devinHome(), { recursive: true, force: true });
  resetDevinTrackerCursorForTest();
  resetDevinStatusCacheForTest();
});

afterEach(() => {
  stopDevinScheduler();
  setDevinApiDepsForTest(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('remote exposure is independent from local delivery visibility', () => {
  it.each(['expired', 'closed', 'failed', 'merged'] as const)('keeps actual usage and remaining cap for local %s', (state) => {
    const view = devinBudgetView([task({ state })], budget(), now);
    expect(view).toMatchObject({ acuUsed: 2, reportedAcuUsed: 2, unconfirmedAcuExposure: 8, acuInFlight: 8, acuToday: 10, running: 1 });
  });

  it('ages a provider-running task locally, then preserves exposure through dismissal and the expired watch horizon', async () => {
    const createdAt = new Date(now.getTime() - DEVIN_TASK_EXPIRY_MS - 1).toISOString();
    writeDevinTask(task({ createdAt, launchedAt: createdAt }));
    const getSession = vi.fn(async () => session());
    const gh = vi.fn(async () => ({ ok: true as const, stdout: '[]', stderr: '' }));
    expect(await refreshDevinTasks({ client: { orgId: FAKE_ORG, client: { getSession } }, gh, now: () => now })).toMatchObject({ checked: 1, updated: 1 });
    expect(readDevinTask(id)).toMatchObject({ state: 'expired', session: { status: 'running', acusConsumed: 2 } });
    expect(devinBudgetView([readDevinTask(id)!], budget(), now)).toMatchObject({ acuUsed: 2, acuInFlight: 8 });
    expect(dismissDevinTask(id, now).ok).toBe(true);
    expect(devinBudgetView([readDevinTask(id)!], budget(), now)).toMatchObject({ acuUsed: 2, acuInFlight: 8 });
    const later = new Date(now.getTime() + 49 * 60 * 60 * 1000);
    getSession.mockRejectedValueOnce(new Error('provider unavailable'));
    expect(await refreshDevinTasks({ client: { orgId: FAKE_ORG, client: { getSession } }, gh, now: () => later })).toMatchObject({ checked: 1, updated: 0 });
    expect(devinBudgetView([readDevinTask(id)!], budget(), later)).toMatchObject({ acuUsed: 2, acuInFlight: 8, acuToday: 8 });
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it.each(['MERGED', 'CLOSED'] as const)('preserves exposure when a verified GitHub PR becomes %s while the provider still runs', async (state) => {
    writeDevinTask(task());
    const pr = { number: 9, url: `https://github.com/${repo}/pull/9`, state, isDraft: false, title: 'Delivered', body: null,
      headRefName: task().branch, baseRefName: 'main', headRepository: { name: 'devin-exposure-fixture' },
      headRepositoryOwner: { login: 'ashlrai' }, isCrossRepository: false, headRefOid: 'f'.repeat(40) };
    await refreshDevinTasks({ client: { orgId: FAKE_ORG, client: { getSession: vi.fn(async () => session()) } },
      gh: vi.fn(async () => ({ ok: true as const, stdout: JSON.stringify([pr]), stderr: '' })), now: () => now });
    expect(readDevinTask(id)?.state).toBe(state === 'MERGED' ? 'merged' : 'closed');
    expect(devinBudgetView([readDevinTask(id)!], budget(), now)).toMatchObject({ acuUsed: 2, acuInFlight: 8 });
  });

  it.each(['network', 'unparsed'] as const)('dismissal never erases an ID-less %s reservation or doubles it', (failure) => {
    const unknown = task({ state: 'failed', failure, sessionId: null, session: null, sessionUrl: null });
    writeDevinTask(unknown);
    expect(devinTaskAcuUsed(unknown)).toBe(10);
    const dismissed = dismissDevinTask(id, now);
    expect(dismissed.ok).toBe(true);
    const after = readDevinTask(id)!;
    expect(after).toMatchObject({ state: 'closed', failure, sessionId: null, session: null });
    expect(devinBudgetView([after], budget(), now)).toMatchObject({ acuUsed: 10, reportedAcuUsed: 0,
      unconfirmedAcuExposure: 10, estimatedUsdUsed: 0, acuInFlight: 0, acuToday: 10, sessionsToday: 1 });
    expect(devinTaskAcuHeadroom(after)).toBe(0);
    expect(dismissDevinTask(id, now)).toMatchObject({ ok: true, task: after });
  });

  it('keeps a previous-day uncertain launch in today’s admission bound without inventing today’s session or provider reading', () => {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const unknown = task({ state: 'closed', failure: 'network', sessionId: null, session: null, createdAt: yesterday, launchedAt: null });
    const view = devinBudgetView([unknown], budget({ maxAcuPerDay: 15 }), now);
    expect(view).toMatchObject({ acuUsed: 10, acuInFlight: 0, acuToday: 10, sessionsToday: 0 });
    expect(view.canLaunch).toMatchObject({ ok: false, reason: expect.stringMatching(/daily cap/) });
    expect(unknown.session).toBeNull();
  });

  it('holds suspended capacity despite a local close, and running/finished is not terminal proof', () => {
    for (const snapshot of [session({ status: 'suspended' }), session({ statusDetail: 'finished' })]) {
      const input = task({ state: 'closed', session: { status: snapshot.status, statusDetail: snapshot.statusDetail,
        acusConsumed: 2, prUrls: [], readAt: now.toISOString() } });
      const view = devinBudgetView([input], budget(), now);
      expect(view).toMatchObject({ acuUsed: 2, acuInFlight: 8 });
      expect(view.running).toBe(snapshot.status === 'suspended' ? 0 : 1);
    }
  });

  it.each(['exit', 'error'] as const)('releases remaining exposure only for observed literal %s, preserving exact actual usage', (status) => {
    const input = task({ state: 'running', session: { status, statusDetail: null, acusConsumed: 3, prUrls: [], readAt: now.toISOString() } });
    expect(devinBudgetView([input], budget(), now)).toMatchObject({ acuUsed: 3, acuInFlight: 0, running: 0 });
    input.session!.acusConsumed = null;
    expect(devinBudgetView([input], budget(), now)).toMatchObject({ acuUsed: 10, acuInFlight: 0, running: 0 });
  });

  it('never clamps a genuine reading above its requested cap or invents usage for a definite pre-create failure', () => {
    expect(devinTaskAcuUsed(task({ session: { status: 'exit', statusDetail: null, acusConsumed: 12.5, prUrls: [], readAt: now.toISOString() } }))).toBe(12.5);
    const refused = task({ state: 'closed', failure: 'auth', sessionId: null, session: null });
    expect(devinBudgetView([refused], budget(), now)).toMatchObject({ acuUsed: 0, acuInFlight: 0, sessionsToday: 0 });
    const unread = task({ state: 'expired', session: null });
    expect(devinBudgetView([unread], budget(), now)).toMatchObject({ acuUsed: 10, acuInFlight: 0 });
  });

  it('reports numeric readings and operator adjustment separately from held exposure and prices only the reported portion', () => {
    const inputs = [task(), task({ sessionId: null, session: null, state: 'failed', failure: 'network' }),
      task({ state: 'expired', session: { status: 'exit', statusDetail: null, acusConsumed: null, prUrls: [], readAt: now.toISOString() } })];
    const view = devinBudgetView(inputs, budget({ acuSpentAdjustment: 1.25, usdPerAcu: 2 }), now);
    expect(view).toMatchObject({ acuUsed: 23.25, reportedAcuUsed: 3.25, unconfirmedAcuExposure: 28,
      acuInFlight: 8, estimatedUsdUsed: 6.5 });
    expect(view.reportedAcuUsed! + view.unconfirmedAcuExposure!).toBe(view.acuUsed + view.acuInFlight);
    expect(view.estimateNote).toContain('plus your usage adjustment');
    expect(view.estimateNote).toContain('not a total invoice');
    expect(view.estimateNote).toContain('not an observed usage reading');
    expect(inputs[1]!.session).toBeNull();
  });

  it.each([
    { status: 204, ok: true }, { status: 404, ok: true }, { status: 410, ok: true },
    { status: 200, throws: true, ok: false },
  ])('keeps exposure without a final usage receipt after a terminate response %#', async ({ status, throws, ok }) => {
    const api = fakeDevin();
    const keys = fakeKeychain();
    await storeDevinKey(FAKE_KEY, { run: keys.run, platform: 'darwin' });
    writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Fixture', keyStore: 'keychain', connectedAt: now.toISOString() });
    writeDevinTask(task());
    api.forced.push({ status, ...(throws ? { throws } : {}) });
    const result = await terminateDevinChat(id, { keyStore: { run: keys.run, platform: 'darwin' }, fetch: api.fetch, sleep: async () => undefined });
    expect(result.ok).toBe(ok);
    expect(api.requests.map(request => request.method)).toEqual(['DELETE']);
    expect(devinBudgetView([readDevinTask(id)!], budget(), now)).toMatchObject({ reportedAcuUsed: 2, unconfirmedAcuExposure: 8,
      acuUsed: 2, acuInFlight: 8 });
  });
});

describe('resident idle observation', () => {
  it('observes an old closed hold beyond 200 settled tasks on the existing idle cadence, without a manual refresh or provider mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(config, 'loadConfigReadOnly').mockReturnValue({ devin: { enabled: true } } as never);
    const provider = fakeDevin();
    const keys = fakeKeychain();
    await storeDevinKey(FAKE_KEY, { run: keys.run, platform: 'darwin' });
    writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Fixture', keyStore: 'keychain', connectedAt: now.toISOString() });
    const old = new Date(now.getTime() - 50 * 60 * 60 * 1000).toISOString();
    writeDevinTask(task({ state: 'closed', createdAt: old, launchedAt: old, session: null }));
    for (let index = 0; index < 201; index += 1) {
      const settledId = `dv_20261002T1200_${(index + 2).toString(36).padStart(6, '0')}`;
      writeDevinTask(task({ id: settledId, branch: `ashlr-devin/${settledId}`, state: 'closed', sessionId: `devin-complete-${index}`,
        session: { status: 'exit', statusDetail: null, acusConsumed: 3, prUrls: [], readAt: now.toISOString() } }));
    }
    const gh = vi.fn(async () => ({ ok: true as const, stdout: '[]', stderr: '' }));
    const consumptionPath = `/v3/organizations/${FAKE_ORG}/consumption/daily`;
    // The owned metadata scheduler runs independently of session observation.
    // Route its valid report separately so it cannot consume a session fixture.
    const fetch: typeof provider.fetch = async (url, init) => {
      if (new URL(url).pathname === consumptionPath) {
        provider.forced.unshift({ status: 200, body: { total_acus: 0, consumption_by_date: [] } });
      }
      return provider.fetch(url, init);
    };
    setDevinApiDepsForTest({ service: { keyStore: { run: keys.run, platform: 'darwin' }, fetch,
      sleep: async () => undefined, now: () => new Date(), config: () => ({ enabled: true }), gh } });
    const observation = { session_id: 'devin-exposure', url: task().sessionUrl, status: 'suspended',
      status_detail: 'inactivity', acus_consumed: 2, pull_requests: [], tags: [] };
    provider.sessions.set('devin-exposure', observation);
    expect(startDevinScheduler({})).toBe(true);
    await vi.advanceTimersByTimeAsync(DEVIN_REFRESH_EVERY_MS);
    expect(provider.requests.map(request => [request.method, request.path])).toEqual([
      ['GET', consumptionPath],
      ['GET', `/v3/organizations/${FAKE_ORG}/sessions/devin-exposure`],
    ]);
    expect(readDevinTask(id)).toMatchObject({ state: 'closed', session: { status: 'suspended', acusConsumed: 2 } });
    expect(devinBudgetView([readDevinTask(id)!], budget(), new Date())).toMatchObject({ reportedAcuUsed: 2, unconfirmedAcuExposure: 8 });
    await vi.advanceTimersByTimeAsync(DEVIN_IDLE_REFRESH_EVERY_MS - DEVIN_REFRESH_EVERY_MS);
    expect(provider.requests.filter(request => request.path.includes('/sessions/'))).toHaveLength(1);
    expect(provider.requests.filter(request => request.path === consumptionPath)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(DEVIN_REFRESH_EVERY_MS);
    expect(provider.requests.map(request => [request.method, request.path])).toEqual([
      ['GET', consumptionPath],
      ['GET', `/v3/organizations/${FAKE_ORG}/sessions/devin-exposure`],
      ['GET', consumptionPath],
      ['GET', consumptionPath],
      ['GET', `/v3/organizations/${FAKE_ORG}/sessions/devin-exposure`],
    ]);
    expect(provider.requests.every(request => request.method === 'GET')).toBe(true);
    expect(gh).not.toHaveBeenCalled();
  });
});

describe('real launch admission with unresolved remote exposure', () => {
  it.each(['expired', 'closed', 'merged', 'failed'] as const)('refuses a replacement session before POST for local %s still running remotely', async (state) => {
    const api = fakeDevin();
    const keys = fakeKeychain();
    await storeDevinKey(FAKE_KEY, { run: keys.run, platform: 'darwin' });
    writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Fixture', keyStore: 'keychain', connectedAt: now.toISOString() });
    updateDevinBudget({ acuBudgetTotal: 15, maxAcuPerDay: 100, pauseAtFraction: 1, maxAcuPerSession: 10 });
    writeDevinTask(task({ state }));
    const result = await launchDevinTask({ repo, prompt: 'New work', origin: 'operator', baseBranch: 'main' }, {
      keyStore: { run: keys.run, platform: 'darwin' }, fetch: api.fetch, sleep: async () => undefined,
      config: () => ({ enabled: true }), policy: () => null, now: () => now,
      gh: vi.fn(async () => ({ ok: false as const, stdout: '', stderr: 'Not used' })),
    });
    expect(result).toMatchObject({ ok: false, failure: 'budget', error: expect.stringMatching(/free after running sessions/) });
    expect(api.requests.filter(request => request.method === 'POST' || request.method === 'DELETE')).toEqual([]);
    expect(readDevinTask(id)).toMatchObject({ state, session: { acusConsumed: 2 } });
  });
});
