/**
 * 3.15 — `/api/verse/devin*` (src/core/devin/devin-api.ts) through a real
 * http server, so the mutation gate, strict bodies and the sendJson
 * sanitizer are the production ones. The Devin API, the Keychain and `gh`
 * are fakes injected through setDevinApiDepsForTest; files live in the
 * worker's isolated ASHLR_HOME.
 */
import { rmSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleDevinApi, setDevinApiDepsForTest } from '../src/core/devin/devin-api.js';
import { storeDevinKey } from '../src/core/devin/secret.js';
import { resetDevinStatusCacheForTest, type DevinServiceDeps } from '../src/core/devin/service.js';
import { devinHome, writeDevinConnection } from '../src/core/devin/store.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { FAKE_KEY, FAKE_ORG, fakeDevin, type FakeDevin } from './helpers/fake-devin.js';
import { fakeKeychain, type FakeKeychain } from './helpers/fake-keychain.js';

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
  it('GET answers the overview (status with Chat/Fleet verdicts, ACU budget) and never the key', async () => {
    const { status, text } = await get('/api/verse/devin');
    expect(status).toBe(200);
    const body = JSON.parse(text) as { status: Record<string, unknown>; budget: Record<string, unknown>; tasks: unknown[] };
    expect(body.status).toMatchObject({ state: 'ready', connected: true, orgId: FAKE_ORG, chat: { word: 'Ready' } }); // 3.15: Devin is a chat seat
    expect(body.budget).toMatchObject({ acuBudgetTotal: 50, canLaunch: { ok: true } });
    expect(text).not.toContain(FAKE_KEY);
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

  it('task routes validate ids; there is no route that takes a key', async () => {
    expect((await post('/api/verse/devin/tasks/../../x/dismiss', {})).status).toBe(404);
    expect((await post('/api/verse/devin/tasks/ct_20260925T1200_abc123/dismiss', {})).status).toBe(400);
    expect((await post('/api/verse/devin/tasks/dv_20260925T1200_abc123/land', { headSha: 'x' })).status).toBe(400);
    expect((await post('/api/verse/devin/connect', { key: FAKE_KEY })).status).toBe(404);
    expect((await post('/api/verse/devin/key', { key: FAKE_KEY })).status).toBe(404);
  });

  it('declines paths outside its prefix without writing', async () => {
    expect(JSON.parse((await get('/api/verse/devinx')).text)).toEqual({ error: 'fallthrough' });
    expect(JSON.parse((await get('/api/verse/cloud')).text)).toEqual({ error: 'fallthrough' });
  });
});
