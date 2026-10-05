/**
 * 3.15 — `/api/verse/devin*` (src/core/devin/devin-api.ts) through a real
 * http server, so the mutation gate, strict bodies and the sendJson
 * sanitizer are the production ones. The Devin API, the Keychain and `gh`
 * are fakes injected through setDevinApiDepsForTest; files live in the
 * worker's isolated ASHLR_HOME.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDevinApi, setDevinApiDepsForTest, startDevinScheduler, stopDevinScheduler } from '../src/core/devin/devin-api.js';
import { storeDevinKey } from '../src/core/devin/secret.js';
import { resetDevinStatusCacheForTest, refreshDevinConsumption, peekDevinConsumption, resetDevinConsumptionForTest, connectDevin, disconnectDevin, launchDevinTask, type DevinServiceDeps } from '../src/core/devin/service.js';
import { devinHome, writeDevinConnection, devinConsumptionConnectionPath } from '../src/core/devin/store.js';
import { findGithubPrUrls, readDismissedDevinCliPrs, recordDevinCliPrs } from '../src/core/devin/cli-prs.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { FAKE_KEY, FAKE_ORG, fakeDevin, type FakeDevin } from './helpers/fake-devin.js';
import { fakeKeychain, type FakeKeychain } from './helpers/fake-keychain.js';
import { repoPolicy, standingPolicy } from './helpers/fleet-github-310b.js';
import * as displayPolicy from '../src/core/verse/display-standing-policy.js';

const TOKEN = 'devin-test-mutation-token-0123456789';
const REPO = 'ashlrai/devin-canary';
let server: http.Server;
let base: string;
let ctx: VerseApiContext;
let api: FakeDevin;
let keychain: FakeKeychain;

function serviceDeps(): DevinServiceDeps {
  return {
    keyStore: { run: keychain.run, platform: 'darwin' },
    fetch: api.fetch,
    sleep: async () => undefined,
    gh: async (args) => (args[0] === 'repo' ? { ok: true, stdout: 'main\n', stderr: '' } : { ok: true, stdout: '[]', stderr: '' }),
    config: () => ({ enabled: true }),
    policy: () => null,
    // The machine's Devin CLI install paths are not the test's business.
    cliProbe: async () => ({ state: 'ready' }),
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleDevinApi(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
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
  setDevinApiDepsForTest(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  rmSync(devinHome(), { recursive: true, force: true });
  api = fakeDevin();
  keychain = fakeKeychain();
  resetDevinStatusCacheForTest();
  setDevinApiDepsForTest({ service: serviceDeps() });
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  await storeDevinKey(FAKE_KEY, { run: keychain.run, platform: 'darwin' });
  writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Ashlr Verse', keyStore: 'keychain', connectedAt: new Date().toISOString() });
});

async function get(p: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, text: await res.text() };
}

async function post(p: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('/api/verse/devin', () => {
  it('describes the installed grant from a desktop sidecar without authorizing a fleet launch', async () => {
    const basePolicy = standingPolicy([repoPolicy(REPO)]);
    const policy = standingPolicy(basePolicy.repos, {
      engines: [...basePolicy.engines, 'devin'],
      spend: { ...basePolicy.spend, seats: { ...basePolicy.spend.seats,
        devin: { seatId: 'devin', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer'] },
      } },
    });
    const display = vi.spyOn(displayPolicy, 'displayStandingPolicy').mockReturnValue(policy);
    const deps = serviceDeps();
    delete deps.policy;
    deps.config = () => ({ enabled: true, fleet: true });
    setDevinApiDepsForTest({ service: deps });
    const response = await get('/api/verse/devin');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).status.fleet).toMatchObject({ ready: true, word: 'Ready' });
    expect(display).toHaveBeenCalledTimes(1);
    expect(api.requests).toHaveLength(0);

    // A read-only display policy must never flow into the action's defaults.
    const launch = await launchDevinTask({ origin: 'fleet', repo: REPO, prompt: 'Do not run.' }, deps);
    expect(launch).toMatchObject({ ok: false, error: expect.stringContaining('No standing grant') });
    expect(display).toHaveBeenCalledTimes(1);
    expect(api.requests).toHaveLength(0);
  });

  it('preserves an explicitly injected missing policy instead of substituting display authority', async () => {
    const display = vi.spyOn(displayPolicy, 'displayStandingPolicy');
    setDevinApiDepsForTest({ service: { ...serviceDeps(), config: () => ({ enabled: true, fleet: true }) } });
    const response = await get('/api/verse/devin');
    expect(JSON.parse(response.text).status.fleet.ready).toBe(false);
    expect(display).not.toHaveBeenCalled();
    expect(api.requests).toHaveLength(0);
  });

  it('retains the installed display reason when the fleet is held', async () => {
    vi.spyOn(displayPolicy, 'displayStandingPolicy').mockReturnValue(null);
    vi.spyOn(displayPolicy, 'displayStandingPolicyReadiness').mockReturnValue({ policy: null, grantState: 'paused', reason: 'The authority code changed.' });
    const deps = serviceDeps(); delete deps.policy;
    deps.config = () => ({ enabled: true, fleet: true });
    setDevinApiDepsForTest({ service: deps });
    expect(JSON.parse((await get('/api/verse/devin')).text).status.fleet)
      .toMatchObject({ ready: false, detail: 'The effective standing policy is held: The authority code changed.' });
    expect(api.requests).toHaveLength(0);
  });

  it('GET answers the overview (status with Chat/Fleet verdicts, ACU budget) and never the key', async () => {
    const { status, text } = await get('/api/verse/devin');
    expect(status).toBe(200);
    const body = JSON.parse(text) as { status: Record<string, unknown>; budget: Record<string, unknown>; tasks: unknown[] };
    expect(body.status).toMatchObject({ state: 'ready', connected: true, orgId: FAKE_ORG, chat: { word: 'Ready' } }); // 3.15: Devin is a chat seat
    expect(body.budget).toMatchObject({ acuBudgetTotal: 50, canLaunch: { ok: true } });
    expect(body.status.selfIdentity).toBeUndefined();
    expect(text).not.toContain(FAKE_KEY);
  });

  it('malformed optional stored observation leaves legacy readiness unchanged and unknown', async () => {
    const legacy = writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Display', keyStore: 'keychain',
      connectedAt: '2026-10-05T12:00:00.000Z' });
    writeFileSync(join(devinHome(), 'connection.json'), JSON.stringify({ ...legacy, selfIdentity: { userId: 'cog_do_not_expose' } }), { mode: 0o600 });
    const calls = api.requests.length;
    const reply = await get('/api/verse/devin'); expect(reply.status).toBe(200);
    const status = JSON.parse(reply.text).status;
    expect(status).toMatchObject({ state: 'ready', connected: true }); expect(status.selfIdentity).toBeUndefined();
    expect(reply.text).not.toContain('cog_do_not_expose'); expect(api.requests).toHaveLength(calls);
  });

  it('GET returns cached /self presence facts without IDs or another provider read', async () => {
    writeDevinConnection({ orgId: FAKE_ORG, principal: 'pat_user', principalName: 'Display', keyStore: 'keychain',
      connectedAt: '2026-10-05T12:00:00.000Z', selfIdentity: { source: 'devin-v3-self', observedAt: '2026-10-05T12:00:00.000Z',
        principal: 'pat_user', serviceUserId: null, userId: 'user-private-1', apiKeyId: 'key-private-2', orgId: 'org-reported', devinSessionsOrgId: 'org-session' } });
    const calls = api.requests.length;
    const reply = await get('/api/verse/devin'); expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text).status).toMatchObject({ state: 'ready', selfIdentity: { source: 'devin-v3-self', principal: 'pat_user',
      hasUserId: true, hasApiKeyId: true, hasDevinSessionsOrgId: true } });
    for (const value of ['user-private-1', 'key-private-2', 'org-reported', 'org-session']) expect(reply.text).not.toContain(value);
    expect(api.requests).toHaveLength(calls);
  });

  it('GET consumption is cache-only and the strict authenticated refresh reads only its connected organization', async () => {
    const wire = { total_acus: 7.25, consumption_by_date: [{ date: 123, acus: 7.25, acus_by_product: { devin: 7.25 } }] };
    const initial = JSON.parse((await get('/api/verse/devin')).text);
    expect(initial.consumption).toMatchObject({ state: 'not-checked', report: null });
    expect(api.requests.filter(r => r.path.includes('/consumption/'))).toHaveLength(0);
    const path = '/api/verse/devin/consumption/refresh';
    expect((await post(path, {}, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect((await post(path, { orgId: 'other' })).status).toBe(400);
    expect((await post(`${path}?x=1`, {})).status).toBe(400);
    ctx.allowDispatch = false;
    expect((await post(path, {})).status).toBe(404); // the shared disabled-dispatch gate hides mutation routes
    ctx.allowDispatch = true;
    expect(api.requests.filter(r => r.path.includes('/consumption/'))).toHaveLength(0);
    api.forced.push({ status: 200, body: wire });
    const refreshed = await post(path, {});
    expect(refreshed).toMatchObject({ status: 200, body: { consumption: { state: 'ready', report: { totalAcus: 7.25 } } } });
    const readback = JSON.parse((await get('/api/verse/devin')).text);
    expect(readback.consumption).toEqual(refreshed.body.consumption);
    expect(api.requests.filter(r => r.path.includes('/consumption/'))).toMatchObject([{ method: 'GET', path: `/v3/organizations/${FAKE_ORG}/consumption/daily` }]);
    expect(api.requests.filter(r => r.method !== 'GET')).toHaveLength(0);
    expect(JSON.stringify(readback)).not.toContain(FAKE_KEY);
  });

  it('a consumption permission refusal does not mark valid session access unreachable', async () => {
    await get('/api/verse/devin'); // establish the independent session-health evidence
    api.forced.push({ status: 403, body: { detail: `secret ${FAKE_KEY}` } });
    const result = await post('/api/verse/devin/consumption/refresh', {});
    expect(result).toMatchObject({ status: 200, body: { consumption: { state: 'unavailable', report: null, error: { code: 'forbidden' } } } });
    const readback = JSON.parse((await get('/api/verse/devin')).text);
    expect(readback.status.state).toBe('ready');
    expect(readback.consumption.error.reason).toContain('ViewOrgConsumption');
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it('fences the actual asynchronous Keychain seam when the same organization is rebound', async () => {
    let entered!: () => void; let release!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const deps = serviceDeps();
    deps.keyStore = { platform: 'darwin', run: async (args, stdin) => {
      if (args[0] === 'find-generic-password' && args.includes('-w')) { entered(); await wait; }
      return keychain.run(args, stdin);
    } };
    const pending = refreshDevinConsumption(deps);
    await admitted;
    writeDevinConnection({ orgId: FAKE_ORG, principal: 'service_user', principalName: 'Rebound', keyStore: 'keychain', connectedAt: '2026-10-05T02:00:00Z' });
    release(); await pending;
    expect(api.requests).toHaveLength(0);
    expect(peekDevinConsumption().report).toBeNull();
  });

  it.each(['connect', 'disconnect'] as const)('blocks consumption throughout an awaited %s Keychain mutation', async operation => {
    let entered!: () => void; let release!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const deps = serviceDeps();
    const replacementKey = 'cog_replacementKey_abcdefghijklmnopqrst';
    const replacementOrg = 'org-replacement';
    const replacement = fakeDevin({ key: replacementKey, orgId: replacementOrg });
    if (operation === 'connect') deps.fetch = replacement.fetch;
    deps.keyStore = { platform: 'darwin', run: async (args, stdin) => {
      const result = await keychain.run(args, stdin); // the key changes before the awaited process returns
      if (args[0] === (operation === 'connect' ? '-i' : 'delete-generic-password')) { entered(); await wait; }
      return result;
    } };
    let oldEntered!: () => void; let oldRelease!: () => void;
    const oldStarted = new Promise<void>(resolve => { oldEntered = resolve; });
    const oldWait = new Promise<void>(resolve => { oldRelease = resolve; });
    api.forced.push({ status: 200, body: { total_acus: 999, consumption_by_date: [] } });
    const oldRead = refreshDevinConsumption({ ...serviceDeps(), fetch: async (url, init) => {
      const response = await api.fetch(url, init); oldEntered(); await oldWait; return response;
    } });
    await oldStarted;
    const transition = operation === 'connect'
      ? connectDevin({ key: replacementKey, orgId: replacementOrg }, deps) : disconnectDevin(deps);
    await admitted;
    const conflicting = operation === 'connect' ? disconnectDevin(serviceDeps()) : connectDevin({ key: replacementKey, orgId: replacementOrg }, { ...serviceDeps(), fetch: replacement.fetch });
    await expect(conflicting).rejects.toThrow(/connection change/);
    expect((await refreshDevinConsumption(serviceDeps(), true)).report).toBeNull();
    expect(api.requests).toHaveLength(1); // only the old read admitted before the transition
    oldRelease(); await oldRead;
    expect(peekDevinConsumption().report).toBeNull();
    expect(replacement.requests.filter(r => r.path.includes('/consumption/'))).toHaveLength(0);
    release(); await transition;
    if (operation === 'connect') {
      replacement.forced.push({ status: 200, body: { total_acus: 1.5, consumption_by_date: [] } });
      expect((await refreshDevinConsumption(deps)).report?.totalAcus).toBe(1.5);
      expect(replacement.requests.at(-1)?.path).toBe(`/v3/organizations/${replacementOrg}/consumption/daily`);
    } else expect(peekDevinConsumption().report).toBeNull();
  });

  it('an ambiguous failed Keychain write stays held after the consumption reader restarts', async () => {
    const replacementKey = 'cog_replacementKey_abcdefghijklmnopqrst';
    const replacement = fakeDevin({ key: replacementKey, orgId: 'org-replacement' });
    const deps = { ...serviceDeps(), fetch: replacement.fetch, keyStore: { platform: 'darwin' as const,
      run: async (args: string[], stdin: string | null) => {
        const result = await keychain.run(args, stdin);
        return args[0] === '-i' ? { ...result, code: 1 } : result;
      } } };
    await expect(connectDevin({ key: replacementKey, orgId: 'org-replacement' }, deps)).rejects.toThrow();
    expect(keychain.items.get('ai.ashlr.devin/api-key')).toBe(replacementKey);
    resetDevinConsumptionForTest(); // simulate a newly created reader: no memory-only authority survives
    expect((await refreshDevinConsumption(serviceDeps(), true))).toMatchObject({ state: 'unavailable', report: null, error: { code: 'not-connected' } });
    expect(api.requests).toHaveLength(0);
    expect(replacement.requests.filter(r => r.path.includes('/consumption/'))).toHaveLength(0);
    await connectDevin({ key: replacementKey, orgId: 'org-replacement' }, { ...serviceDeps(), fetch: replacement.fetch });
    replacement.forced.push({ status: 200, body: { total_acus: 1, consumption_by_date: [] } });
    expect((await refreshDevinConsumption({ ...serviceDeps(), fetch: replacement.fetch })).report?.totalAcus).toBe(1);
  });

  it('never trusts a corrupt or publicly writable transition marker as confirmed', async () => {
    writeFileSync(devinConsumptionConnectionPath(), 'unexpected\n', { mode: 0o600 });
    expect(peekDevinConsumption().state).toBe('unavailable');
    writeFileSync(devinConsumptionConnectionPath(), 'settled\n');
    if (process.platform !== 'win32') {
      chmodSync(devinConsumptionConnectionPath(), 0o644);
      expect((await refreshDevinConsumption(serviceDeps(), true)).state).toBe('unavailable');
      expect(api.requests).toHaveLength(0);
    }
  });

  it('refuses Keychain mutation if the private transition marker cannot be published', async () => {
    mkdirSync(devinConsumptionConnectionPath());
    const before = keychain.calls.filter(call => call.args[0] === '-i').length;
    await expect(connectDevin({ key: FAKE_KEY, orgId: FAKE_ORG }, serviceDeps())).rejects.toThrow();
    expect(keychain.calls.filter(call => call.args[0] === '-i')).toHaveLength(before);
    expect(peekDevinConsumption()).toMatchObject({ state: 'unavailable', report: null });
    expect(api.requests.filter(r => r.path.includes('/consumption/'))).toHaveLength(0);
  });

  it('the owned scheduler reads connected metadata at startup without Fleet or active sessions', async () => {
    api.forced.push({ status: 200, body: { total_acus: 0, consumption_by_date: [] } });
    try {
      expect(startDevinScheduler({ NODE_ENV: 'test' })).toBe(false);
      expect(startDevinScheduler({})).toBe(true);
      await vi.waitFor(() => expect(peekDevinConsumption().state).toBe('ready'));
      expect(api.requests).toMatchObject([{ method: 'GET', path: `/v3/organizations/${FAKE_ORG}/consumption/daily` }]);
    } finally { stopDevinScheduler(); }
  });

  it('rejects any query, and POSTs without the token or with unknown fields', async () => {
    expect((await get('/api/verse/devin?x=1')).status).toBe(400);
    const noToken = await fetch(`${base}/api/verse/devin/launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: REPO, prompt: 'x' }) });
    expect([401, 403]).toContain(noToken.status);
    expect((await post('/api/verse/devin/launch', { repo: REPO, prompt: 'x', apiKey: FAKE_KEY })).status).toBe(400);
    expect(api.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('launches a session (200) and a refusal keeps the full body (409)', async () => {
    const ok = await post('/api/verse/devin/launch', { repo: REPO, prompt: 'Add a helper', origin: 'chat' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, task: { state: 'running', repo: REPO, baseBranch: 'main' } });
    await post('/api/verse/devin/budget', { acuBudgetTotal: 0 });
    const refused = await post('/api/verse/devin/launch', { repo: REPO, prompt: 'Again', origin: 'chat' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ ok: false, failure: 'budget' });
  });

  it('budget updates are strict and clamped by the store', async () => {
    expect((await post('/api/verse/devin/budget', { maxAcuPerSession: 2.5 })).status).toBe(400);
    const res = await post('/api/verse/devin/budget', { acuBudgetTotal: 80, pauseAtFraction: 0.2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ acuBudgetTotal: 80, budget: { pauseAtFraction: 0.5 } });
  });

  it('HTTP budget counts round-trip beyond the old ceilings and reject unsafe counts before persistence', async () => {
    const counts = { maxConcurrent: 64, maxSessionsPerDay: 999, fleetMaxConcurrent: 1_000_001, fleetMaxSessionsPerDay: Number.MAX_SAFE_INTEGER };
    expect(await post('/api/verse/devin/budget', counts)).toMatchObject({ status: 200, body: { budget: counts } });
    for (const field of Object.keys(counts)) {
      expect((await post('/api/verse/devin/budget', { [field]: Number.MAX_SAFE_INTEGER + 1 })).status).toBe(400);
      expect((await post('/api/verse/devin/budget', { [field]: 1.5 })).status).toBe(400);
    }
    expect(await post('/api/verse/devin/budget', { maxAcuPerSession: 2_000 })).toMatchObject({ status: 200, body: { budget: { ...counts, maxAcuPerSession: 1_000 } } });
    expect((await post('/api/verse/devin/budget', { acuBudgetTotal: 1_000_001 })).status).toBe(400);
  });

  it('task routes validate ids; there is no route that takes a key', async () => {
    expect((await post('/api/verse/devin/tasks/../../x/dismiss', {})).status).toBe(404);
    expect((await post('/api/verse/devin/tasks/ct_20260925T1200_abc123/dismiss', {})).status).toBe(400);
    expect((await post('/api/verse/devin/tasks/dv_20260925T1200_abc123/land', { headSha: 'x' })).status).toBe(400);
    expect((await post('/api/verse/devin/connect', { key: FAKE_KEY })).status).toBe(404);
    expect((await post('/api/verse/devin/key', { key: FAKE_KEY })).status).toBe(404);
  });

  it('a Devin CLI chat’s PR: dismiss is strict, 404s an unknown PR, and takes it out of Needs-you (3.15)', async () => {
    const chat = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    recordDevinCliPrs(chat, findGithubPrUrls('https://github.com/ashlrai/devin-canary/pull/4'));
    const url = `/api/verse/devin/cli-prs/${chat}/4/dismiss`;
    expect((await post(url, {}, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect((await post(url, { force: true })).status).toBe(400);
    expect((await post(`/api/verse/devin/cli-prs/${chat}/5/dismiss`, {})).status).toBe(404);
    expect((await post('/api/verse/devin/cli-prs/../x/4/dismiss', {})).status).toBe(404);
    const ok = await post(url, {});
    expect(ok).toMatchObject({ status: 200, body: { ok: true } });
    expect(readDismissedDevinCliPrs().size).toBe(1);
    expect(JSON.parse((await get('/api/verse/devin')).text).cli).toEqual({ state: 'ready', usage: 'not-reported' });
  });

  it('declines paths outside its prefix without writing', async () => {
    expect(JSON.parse((await get('/api/verse/devinx')).text)).toEqual({ error: 'fallthrough' });
    expect(JSON.parse((await get('/api/verse/cloud')).text)).toEqual({ error: 'fallthrough' });
  });
});
