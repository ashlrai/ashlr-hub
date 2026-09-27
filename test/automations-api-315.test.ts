/**
 * 3.15 — Verse automations routes (/api/verse/automations/**) on a real
 * loopback server: overview + journal reads, create / update / enable /
 * disable / delete, fire (dry run and real, through fake lanes), the local
 * webhook (loopback + mutation token), review approve / reject, and the
 * posture every Verse route keeps (mutation token, dispatch switch, strict
 * bodies and queries, plain errors).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createAutomationsApi } from '../src/core/verse/automations-api.js';
import { readAutomationState, type AutomationsOverviewResponse, type AutomationInput } from '../src/core/automations/index.js';
import { fakeClock, fakeGh, fakeLanes, isolateAshlrHome } from './helpers/automations-fakes.js';

const TOKEN = 'automations-test-token';

let server: http.Server;
let base: string;
let allowDispatch = true;
let loopback = true;
let restore: () => void;
const clock = fakeClock(new Date('2026-09-27T12:00:00Z'));
let lanes = fakeLanes();
const gh = fakeGh(() => ({
  status: 200,
  body: [{ number: 1, title: 'Bug', body: 'b', html_url: 'https://github.com/acme/app/issues/1', updated_at: '2026-09-27T10:00:00Z', state: 'open' }],
})).gh;

beforeAll(async () => {
  const api = createAutomationsApi({
    engine: new Proxy({}, { get: (_t, key) => ({ ...lanes.deps, gh, now: clock.now, decider: null } as Record<string | symbol, unknown>)[key] }),
    schedulerRunning: () => true,
    isLoopback: () => loopback,
  });
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: VerseApiContext = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch };
    void api(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(418, { 'Content-Type': 'application/json' });
        res.end('{"error":"not mine"}');
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
  restore = isolateAshlrHome();
  allowDispatch = true;
  loopback = true;
  lanes = fakeLanes();
});
afterEach(() => restore());

const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body: unknown, token: string | null = TOKEN) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-ashlr-token': token } : {}) },
    body: JSON.stringify(body),
  });

const definition: AutomationInput = {
  name: 'Issues',
  enabled: true,
  trigger: { kind: 'github-issues', labels: ['ashlr'], query: null, includePrs: false, pollMinutes: 15 },
  lane: 'fleet',
  playbookId: null,
  repos: ['acme/app'],
  instructions: 'Fix it.',
  maxConcurrent: 2,
  maxPerDay: 5,
  queueDepth: 10,
  spendCapUsd: 0,
  dedupeKey: null,
  triage: null,
};

describe('/api/verse/automations', () => {
  it('declines other paths and serves the overview with templates', async () => {
    expect((await get('/api/verse/automationsx')).status).toBe(418);
    const res = await get('/api/verse/automations');
    expect(res.status).toBe(200);
    const view = (await res.json()) as AutomationsOverviewResponse;
    expect(view.automations).toEqual([]);
    expect(view.templates.map((t) => t.id)).toEqual(['fix-labeled-issues', 'nightly-flaky-tests', 'weekly-dependency-bumps', 'fix-red-main']);
    expect(view.schedulerRunning).toBe(true);
    expect((await get('/api/verse/automations?x=1')).status).toBe(400);
  });

  it('create → update → disable → enable → delete, strictly', async () => {
    let res = await post('/api/verse/automations', definition);
    expect(res.status).toBe(201);
    const { automation } = (await res.json()) as { automation: { id: string } };
    expect(automation.id).toBe('au_issues');

    expect((await post('/api/verse/automations', { ...definition, bogus: true })).status).toBe(400);
    const invalid = await post('/api/verse/automations', { ...definition, repos: ['nope'] });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toMatch(/owner\/name/);

    res = await post('/api/verse/automations/au_issues', { maxPerDay: 7 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { automation: { maxPerDay: number } }).automation.maxPerDay).toBe(7);
    expect((await post('/api/verse/automations/au_missing', { maxPerDay: 7 })).status).toBe(404);

    res = await post('/api/verse/automations/au_issues/disable', {});
    expect(((await res.json()) as { automation: { enabled: boolean } }).automation.enabled).toBe(false);
    res = await post('/api/verse/automations/au_issues/enable', {});
    expect(((await res.json()) as { automation: { enabled: boolean } }).automation.enabled).toBe(true);
    expect((await post('/api/verse/automations/au_issues/enable', { extra: 1 })).status).toBe(400);

    expect((await post('/api/verse/automations/au_issues/delete', {})).status).toBe(200);
    expect((await post('/api/verse/automations/au_issues/delete', {})).status).toBe(404);
  });

  it('fire: dry run writes nothing, a real fire dispatches and is journalled', async () => {
    await post('/api/verse/automations', definition);
    let res = await post('/api/verse/automations/au_issues/fire', { dryRun: true });
    expect(res.status).toBe(200);
    const dry = (await res.json()) as { dryRun: boolean; planned: Array<{ verdict: string }> };
    expect(dry.dryRun).toBe(true);
    expect(dry.planned.map((p) => p.verdict)).toEqual(['dispatch to fleet']);
    expect((await readAutomationState()).firings).toEqual([]);

    res = await post('/api/verse/automations/au_issues/fire', {});
    expect(res.status).toBe(200);
    expect(lanes.fleetCalls).toHaveLength(1);
    const journal = (await (await get('/api/verse/automations/journal')).json()) as { entries: Array<{ event: string; sourceUrl: string }> };
    expect(journal.entries.map((e) => e.event)).toEqual(['fired', 'dispatched']);
    expect(journal.entries[0]!.sourceUrl).toBe('https://github.com/acme/app/issues/1');
    expect((await post('/api/verse/automations/au_issues/fire', { dryRun: 'yes' })).status).toBe(400);
  });

  it('webhook: loopback only, token required, text required', async () => {
    await post('/api/verse/automations', { ...definition, name: 'Hook', trigger: { kind: 'webhook' } });
    expect((await post('/api/verse/automations/au_hook/webhook', { text: 'Do it' }, null)).status).toBe(401);
    loopback = false;
    expect((await post('/api/verse/automations/au_hook/webhook', { text: 'Do it' })).status).toBe(403);
    loopback = true;
    expect((await post('/api/verse/automations/au_hook/webhook', { title: 'no text' })).status).toBe(400);
    const res = await post('/api/verse/automations/au_hook/webhook', { text: 'Do it', key: 'n8n-1' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deduped: boolean }).deduped).toBe(false);
    const dup = (await (await post('/api/verse/automations/au_hook/webhook', { text: 'Do it again', key: 'n8n-1' })).json()) as { deduped: boolean };
    expect(dup.deduped).toBe(true);
    expect(lanes.fleetCalls).toHaveLength(1);
  });

  it('review: approve and reject a leader-review firing', async () => {
    await post('/api/verse/automations', { ...definition, lane: 'leader-review' });
    await post('/api/verse/automations/au_issues/fire', {});
    const firing = (await readAutomationState()).firings[0]!;
    expect(firing.state).toBe('awaiting-review');
    expect((await post(`/api/verse/automations/firings/${firing.id}/nope`, {})).status).toBe(404);
    const res = await post(`/api/verse/automations/firings/${firing.id}/approve`, {});
    expect(res.status).toBe(200);
    expect(lanes.fleetCalls).toHaveLength(1);
    expect((await post(`/api/verse/automations/firings/${firing.id}/reject`, {})).status).toBe(409);
  });

  it('mutations need the token and the dispatch switch', async () => {
    expect((await post('/api/verse/automations', definition, 'wrong')).status).toBe(401);
    allowDispatch = false;
    expect((await post('/api/verse/automations', definition)).status).toBe(404);
    expect((await get('/api/verse/automations')).status).toBe(200);
    expect((await fetch(`${base}/api/verse/automations`, { method: 'DELETE' })).status).toBe(404);
  });
});
