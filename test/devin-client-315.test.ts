/**
 * 3.15 — Devin REST client (src/core/devin/client.ts) against a fake v3 API
 * (test/helpers/fake-devin.ts). No network: fetch is always injected.
 *
 * Covered: request shapes per the docs (Bearer auth, v3 org paths, the
 * SessionCreateRequest fields), parsing per SessionResponse (tolerant of the
 * docs' short create response, fail-closed on unknown status / foreign URL /
 * bad id), retries (reads on 429/5xx/network; create only on 429), and that
 * the key never appears in an error, in JSON or in util.inspect output.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  DevinApiError,
  DevinClient,
  failureForStatus,
  parseDevinSelf,
  parseDevinSession,
  parseDevinSessionPage,
} from '../src/core/devin/client.js';
import { FAKE_KEY, FAKE_ORG, fakeDevin } from './helpers/fake-devin.js';

const noSleep = async (): Promise<void> => undefined;
const client = (f: ReturnType<typeof fakeDevin>, key = f.key, retries = 2): DevinClient =>
  new DevinClient({ apiKey: key, fetch: f.fetch, sleep: noSleep, retries, baseUrl: 'https://api.devin.ai/v3' });

describe('parsers (docs.devin.ai v3 schemas)', () => {
  it('reads ServiceUserSelf and PatUserSelf, with org_id only when it is an org- id', () => {
    expect(parseDevinSelf({ principal_type: 'service_user', service_user_id: 's', service_user_name: 'CI', org_id: null })).toEqual({ principal: 'service_user', name: 'CI', orgId: null });
    expect(parseDevinSelf({ principal_type: 'pat_user', user_id: 'u', user_name: 'Mason', api_key_id: 'k', api_key_name: 'n', org_id: 'org-abc' })).toEqual({ principal: 'pat_user', name: 'Mason', orgId: 'org-abc' });
    expect(parseDevinSelf({ principal_type: 'pat_user', user_name: 'x', org_id: '../evil' })?.orgId).toBeNull();
    expect(parseDevinSelf({})).toBeNull();
  });

  it('reads a full SessionResponse, and the docs\' three-field create response', () => {
    const full = parseDevinSession({
      session_id: 'devin-abc123', url: 'https://app.devin.ai/sessions/devin-abc123', status: 'running', status_detail: 'waiting_for_user',
      acus_consumed: 3.5, pull_requests: [{ pr_url: 'https://github.com/o/r/pull/7', pr_state: 'open' }], tags: ['a'], org_id: FAKE_ORG,
      created_at: 1, updated_at: 2, structured_output: { status: 'done' },
    });
    expect(full).toMatchObject({ sessionId: 'devin-abc123', status: 'running', statusDetail: 'waiting_for_user', acusConsumed: 3.5, pullRequests: [{ url: 'https://github.com/o/r/pull/7', state: 'open' }] });
    const short = parseDevinSession({ session_id: 'devin-abc123', url: 'https://app.devin.ai/sessions/devin-abc123', status: 'running' });
    expect(short).toMatchObject({ acusConsumed: null, pullRequests: [], tags: [] });
  });

  it('fails closed on an unknown status, a non-https URL, a bad id or a wrong-typed ACU count', () => {
    const base = { session_id: 'devin-abc', url: 'https://app.devin.ai/sessions/devin-abc', status: 'running' };
    expect(parseDevinSession({ ...base, status: 'done' })).toBeNull();
    expect(parseDevinSession({ ...base, url: 'http://app.devin.ai/x' })).toBeNull();
    expect(parseDevinSession({ ...base, session_id: 'abc' })).toBeNull();
    expect(parseDevinSession({ ...base, acus_consumed: '3' })).toBeNull();
    expect(parseDevinSession({ ...base, acus_consumed: -1 })).toBeNull();
    expect(parseDevinSession({ ...base, pull_requests: 'x' })).toBeNull();
    // A non-https PR hint is dropped, not trusted.
    expect(parseDevinSession({ ...base, pull_requests: [{ pr_url: 'javascript:alert(1)', pr_state: null }] })?.pullRequests).toEqual([]);
  });

  it('reads a cursor page and drops unparseable items', () => {
    const page = parseDevinSessionPage({ items: [{ session_id: 'devin-a', url: 'https://app.devin.ai/s', status: 'exit' }, { nope: 1 }], end_cursor: 'c', has_next_page: true });
    expect(page).toMatchObject({ endCursor: 'c', hasNextPage: true });
    expect(page!.items).toHaveLength(1);
    expect(parseDevinSessionPage({ sessions: [] })).toBeNull();
  });

  it('maps HTTP status to failure codes (docs overview#error-handling)', () => {
    expect([401, 403, 404, 422, 429, 500, 503].map(failureForStatus)).toEqual(['auth', 'forbidden', 'invalid-request', 'invalid-request', 'rate-limited', 'server', 'server']);
  });

  it('preserves provider organization context and reports lossy pages as incomplete recovery evidence', () => {
    const wire = { session_id: 'devin-a', url: 'https://app.devin.ai/sessions/devin-a', status: 'exit', org_id: FAKE_ORG, tags: [] };
    expect(parseDevinSession(wire)?.orgId).toBe(FAKE_ORG);
    expect(parseDevinSession({ ...wire, org_id: '../other' })).toBeNull();
    const page = (items: unknown[], patch = {}) => parseDevinSessionPage({ items, has_next_page: false, end_cursor: null, ...patch });
    expect(page([wire])?.complete).toBe(true);
    expect(page([wire, { nope: true }])?.complete).toBe(false);
    expect(page([{ ...wire, tags: ['tag', 7] }])?.complete).toBe(false);
    expect(page([{ ...wire, tags: Array.from({ length: 51 }, () => 'tag') }])?.complete).toBe(false);
    expect(page([wire], { has_next_page: true, end_cursor: null })?.complete).toBe(false);
    expect(page([wire], { has_next_page: undefined })?.complete).toBe(false);
  });
});

describe('requests', () => {
  it('GET /v3/self and org-scoped session routes with Bearer auth', async () => {
    const f = fakeDevin();
    const c = client(f);
    expect(await c.getSelf()).toMatchObject({ principal: 'service_user' });
    await c.listSessions(FAKE_ORG, { first: 5 });
    expect(f.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v3/self', `GET /v3/organizations/${FAKE_ORG}/sessions?first=5`]);
    expect(f.requests.every((r) => r.headers['authorization'] === `Bearer ${FAKE_KEY}`)).toBe(true);
  });

  it('creates a session with exactly the documented SessionCreateRequest fields', async () => {
    const f = fakeDevin();
    const session = await client(f).createSession(FAKE_ORG, {
      prompt: 'Do the thing', title: '[ashlr-devin] t', repos: ['ashlrai/x'], tags: ['ashlr-verse'], maxAcuLimit: 7,
      structuredOutputSchema: { type: 'object' }, structuredOutputRequired: false, devinMode: 'normal',
    });
    expect(session.sessionId).toMatch(/^devin-/);
    const req = f.requests[0]!;
    expect(`${req.method} ${req.path}`).toBe(`POST /v3/organizations/${FAKE_ORG}/sessions`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.body).toEqual({
      prompt: 'Do the thing', title: '[ashlr-devin] t', repos: ['ashlrai/x'], tags: ['ashlr-verse'], max_acu_limit: 7,
      devin_mode: 'normal', structured_output_schema: { type: 'object' }, structured_output_required: false,
    });
  });

  it('refuses a non-integer ACU cap, fusion mode and a missing org before any request', async () => {
    const f = fakeDevin();
    const c = client(f);
    await expect(c.createSession(FAKE_ORG, { prompt: 'x', maxAcuLimit: 1.5 })).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(c.createSession(FAKE_ORG, { prompt: 'x', devinMode: 'fusion' as never })).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(c.createSession('nope', { prompt: 'x' })).rejects.toMatchObject({ code: 'not-connected' });
    expect(f.requests).toEqual([]);
  });

  it('sends a message to POST …/sessions/{id}/messages', async () => {
    const f = fakeDevin();
    const c = client(f);
    const s = await c.createSession(FAKE_ORG, { prompt: 'x' });
    await c.sendMessage(FAKE_ORG, s.sessionId, 'Also add tests');
    expect(f.requests.at(-1)).toMatchObject({ method: 'POST', path: `/v3/organizations/${FAKE_ORG}/sessions/${s.sessionId}/messages`, body: { message: 'Also add tests' } });
  });

  it.each(['getSession', 'terminateSession'] as const)('rejects foreign session identity/account returned by %s without retry', async (method) => {
    for (const patch of [{ session_id: 'devin-other' }, { org_id: 'org-foreign' }]) {
      const f = fakeDevin();
      f.forced.push({ status: 200, body: { session_id: 'devin-wanted', org_id: FAKE_ORG,
        url: 'https://app.devin.ai/sessions/devin-wanted', status: 'exit', acus_consumed: 3, ...patch } });
      await expect(client(f)[method](FAKE_ORG, 'devin-wanted')).rejects.toMatchObject({ code: 'unparsed' });
      expect(f.requests).toHaveLength(1);
    }
  });
  it('does not manufacture terminal proof from an empty or still-running DELETE acknowledgement', async () => {
    const f = fakeDevin();
    f.forced.push({ status: 204 }, { status: 200, body: { session_id: 'devin-wanted', org_id: FAKE_ORG,
      url: 'https://app.devin.ai/sessions/devin-wanted', status: 'running', acus_consumed: 3 } });
    const c = client(f);
    expect(await c.terminateSession(FAKE_ORG, 'devin-wanted')).toBeNull();
    expect(await c.terminateSession(FAKE_ORG, 'devin-wanted')).toMatchObject({ status: 'running' });
  });
});

describe('retries and failures', () => {
  it('retries a read on 429 (honouring a sane Retry-After) and on 5xx, then succeeds', async () => {
    const f = fakeDevin();
    const slept: number[] = [];
    const c = new DevinClient({ apiKey: f.key, fetch: f.fetch, sleep: async (ms) => { slept.push(ms); }, retries: 2 });
    f.forced.push({ status: 429, headers: { 'retry-after': '2' }, body: { title: 'Too Many Requests', status: 429 } }, { status: 502 });
    expect(await c.getSelf()).toMatchObject({ principal: 'service_user' });
    expect(f.requests).toHaveLength(3);
    expect(slept).toContain(2000);
  });

  it('never retries a create after a network failure (it may have been processed) — only after a 429', async () => {
    const f = fakeDevin();
    f.forced.push({ status: 0, throws: true });
    await expect(client(f).createSession(FAKE_ORG, { prompt: 'x' })).rejects.toMatchObject({ code: 'network' });
    expect(f.requests).toHaveLength(1);

    const g = fakeDevin();
    g.forced.push({ status: 429 });
    await client(g).createSession(FAKE_ORG, { prompt: 'x' });
    expect(g.requests).toHaveLength(2);

    const h = fakeDevin();
    h.forced.push({ status: 503 });
    await expect(client(h).createSession(FAKE_ORG, { prompt: 'x' })).rejects.toMatchObject({ code: 'server' });
    expect(h.requests).toHaveLength(1);
  });

  it('a 401 is `auth` and is not retried', async () => {
    const f = fakeDevin();
    await expect(client(f, 'cog_wrongKey_abcdefghijklmnopqrstu').getSelf()).rejects.toMatchObject({ code: 'auth', status: 401 });
    expect(f.requests).toHaveLength(1);
  });
});

describe('secrets never leave the Authorization header', () => {
  it('an error never carries the key — even when the server or the transport echoes it', async () => {
    const f = fakeDevin();
    const wrong = 'cog_leakyKeyValue_abcdefghijklmnopqrstuvwxyz';
    const e1 = await client(f, wrong).getSelf().catch((e: unknown) => e) as DevinApiError;
    expect(e1).toBeInstanceOf(DevinApiError);
    expect(e1.message).not.toContain(wrong);
    expect(e1.message).not.toContain('leakyKeyValue');
    expect(JSON.stringify(e1)).not.toContain('leakyKeyValue');

    const g = fakeDevin();
    g.forced.push({ status: 0, throws: true }, { status: 0, throws: true }, { status: 0, throws: true });
    const e2 = await client(g).getSelf().catch((e: unknown) => e) as DevinApiError;
    expect(e2.code).toBe('network');
    expect(`${e2.message} ${e2.stack ?? ''}`).not.toContain(FAKE_KEY);
  });

  it('JSON and util.inspect of a client show only the base URL', () => {
    const f = fakeDevin();
    const c = client(f);
    expect(JSON.stringify(c)).not.toContain(FAKE_KEY);
    expect(inspect(c, { depth: 5, showHidden: true })).not.toContain(FAKE_KEY);
  });

  it('refuses to construct without a key', () => {
    expect(() => new DevinClient({ apiKey: '' })).toThrow(DevinApiError);
  });
});
