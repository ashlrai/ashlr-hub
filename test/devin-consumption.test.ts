import { describe, expect, it } from 'vitest';
import { DevinApiError, DevinClient, parseDevinDailyConsumption } from '../src/core/devin/client.js';
import { DevinConsumptionCache, DEVIN_CONSUMPTION_TTL_MS } from '../src/core/devin/consumption.js';
import { FAKE_KEY, FAKE_ORG, fakeDevin } from './helpers/fake-devin.js';

const wire = { total_acus: 3.125, consumption_by_date: [{ date: 123, acus: 3.125,
  acus_by_product: { devin: 2.5, cascade: 0.625, terminal: 0, automation: null, review: null } }] };
const report = parseDevinDailyConsumption(wire)!;
const tick = new Date('2026-10-05T00:00:00Z').getTime();

describe('documented organization daily consumption', () => {
  it('preserves fractional ACUs, provider date integers and unknown product buckets', () => {
    expect(report).toEqual({ totalAcus: 3.125, days: [{ date: 123, acus: 3.125,
      products: { devin: 2.5, cascade: 0.625, terminal: 0, automation: null, review: null } }] });
    expect(parseDevinDailyConsumption({ total_acus: 0, consumption_by_date: [] })).toEqual({ totalAcus: 0, days: [] });
    expect(parseDevinDailyConsumption({ ...wire, consumption_by_date: [{ ...wire.consumption_by_date[0], acus_by_product: {} }] })?.days[0]?.products.devin).toBeNull();
  });

  it.each([{}, { ...wire, total_acus: '3' }, { ...wire, total_acus: -1 }, { ...wire, total_acus: Infinity },
    { ...wire, consumption_by_date: [{ ...wire.consumption_by_date[0], date: 1.5 }] },
    { ...wire, consumption_by_date: [{ ...wire.consumption_by_date[0], acus: NaN }] },
    { ...wire, consumption_by_date: [{ ...wire.consumption_by_date[0], acus_by_product: { review: 'unknown' } }] },
    { ...wire, consumption_by_date: [wire.consumption_by_date[0], wire.consumption_by_date[0]] },
  ])('refuses malformed or ambiguous consumption without inferring zero', value => {
    expect(parseDevinDailyConsumption(value)).toBeNull();
  });

  it('holds continuation envelopes instead of claiming a partial history is complete', () => {
    expect(parseDevinDailyConsumption({ ...wire, next_cursor: 'another-page' })).toBeNull();
    expect(parseDevinDailyConsumption({ ...wire, pagination: { has_more: true } })).toBeNull();
  });

  it('performs only the connected organization GET, with no invented date filters or billing call', async () => {
    const api = fakeDevin(); api.forced.push({ status: 200, body: wire });
    const client = new DevinClient({ apiKey: FAKE_KEY, fetch: api.fetch, retries: 0 });
    expect(await client.getDailyConsumption(FAKE_ORG)).toEqual(report);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: 'GET', path: `/v3/organizations/${FAKE_ORG}/consumption/daily` });
    await expect(client.getDailyConsumption('../other')).rejects.toMatchObject({ code: 'not-connected' });
    expect(api.requests).toHaveLength(1);
  });

  it('re-admits every retry and refuses old-identity provider contact after backoff', async () => {
    const api = fakeDevin(); api.forced.push({ status: 429, body: {} });
    let current = true;
    const client = new DevinClient({ apiKey: FAKE_KEY, fetch: api.fetch, retries: 2, sleep: async () => { current = false; } });
    await expect(client.getDailyConsumption(FAKE_ORG, () => current)).rejects.toMatchObject({ code: 'not-connected' });
    expect(api.requests).toHaveLength(1);
  });

  it.each([[403, 'forbidden'], [429, 'rate-limited']] as const)('keeps HTTP%s separate from quota exhaustion', async (status, code) => {
    const api = fakeDevin(); api.forced.push({ status, body: { detail: `Bearer ${FAKE_KEY}` } });
    const client = new DevinClient({ apiKey: FAKE_KEY, fetch: api.fetch, retries: 0 });
    await expect(client.getDailyConsumption(FAKE_ORG)).rejects.toMatchObject({ code, status });
    expect(JSON.stringify(api.requests.map(r => r.path))).not.toMatch(/billing|enterprise|sessions/);
  });
});

describe('identity-fenced metadata cache', () => {
  it('peeks without contact, joins concurrent refreshes and expires successful retrievals', async () => {
    const cache = new DevinConsumptionCache(); let now = tick; let calls = 0; let done!: () => void;
    const wait = new Promise<void>(resolve => { done = resolve; });
    const options = { identity: () => 'org-A/key-1', now: () => new Date(now), read: async () => { calls++; await wait; return report; } };
    expect(cache.peek('org-A/key-1').report).toBeNull(); expect(calls).toBe(0);
    const first = cache.refresh(options); const second = cache.refresh(options);
    await Promise.resolve(); expect(calls).toBe(1); done();
    expect((await first).report?.totalAcus).toBe(3.125); expect((await second).state).toBe('ready');
    await cache.refresh(options); expect(calls).toBe(1);
    now += DEVIN_CONSUMPTION_TTL_MS;
    expect(cache.peek('org-A/key-1', new Date(now)).stale).toBe(true);
    await cache.refresh(options); expect(calls).toBe(2);
    const copy = cache.peek('org-A/key-1', new Date(now)); copy.report!.totalAcus = 999;
    expect(cache.peek('org-A/key-1', new Date(now)).report?.totalAcus).toBe(3.125);
  });

  it('discards old responses through same-organization credential rebinding and A→B→A races', async () => {
    const cache = new DevinConsumptionCache(); let identity = 'org-A/key-1'; let done!: () => void;
    const options = { identity: () => identity, now: () => new Date(tick) };
    const old = cache.refresh({ ...options, read: async () => { await new Promise<void>(resolve => { done = resolve; }); return report; } });
    await Promise.resolve(); identity = 'org-A/key-2'; cache.peek(identity);
    identity = 'org-A/key-1';
    await cache.refresh({ ...options, read: async () => ({ ...report, totalAcus: 7 }) });
    done(); await old;
    expect(cache.peek(identity, new Date(tick)).report?.totalAcus).toBe(7);
  });

  it('old-flight cleanup cannot clear the new identity’s pending singleflight', async () => {
    const cache = new DevinConsumptionCache(); let identity = 'A'; let oldDone!: () => void; let newDone!: () => void; let calls = 0;
    const options = { identity: () => identity };
    const old = cache.refresh({ ...options, read: async () => { await new Promise<void>(resolve => { oldDone = resolve; }); return report; } });
    await Promise.resolve(); identity = 'B';
    const read = async () => { calls++; await new Promise<void>(resolve => { newDone = resolve; }); return report; };
    const fresh = cache.refresh({ ...options, read });
    await Promise.resolve(); oldDone(); await old;
    const joined = cache.refresh({ ...options, read });
    expect(calls).toBe(1); newDone(); await Promise.all([fresh, joined]);
    expect(calls).toBe(1);
  });

  it('refuses contact when a connection changes before the asynchronous admission seam', async () => {
    const cache = new DevinConsumptionCache(); let identity: string | null = 'A'; let calls = 0;
    const pending = cache.refresh({ identity: () => identity, read: async () => { calls++; return report; } });
    identity = null; await pending;
    expect(calls).toBe(0); expect(cache.peek(null).report).toBeNull();
  });

  it.each(['forbidden', 'rate-limited'] as const)('retains only stale historical readings on %s and never exposes raw errors', async code => {
    const cache = new DevinConsumptionCache(); let now = tick; let calls = 0;
    const options = { identity: () => 'A', now: () => new Date(now), read: async () => { calls++; return report; } };
    await cache.refresh(options);
    const failed = await cache.refresh({ ...options, force: true, read: async () => { calls++; throw new DevinApiError(code, `Secret ${FAKE_KEY}`); } });
    expect(failed).toMatchObject({ state: 'unavailable', stale: true, report: { totalAcus: 3.125 }, error: { code } });
    expect(JSON.stringify(failed)).not.toContain(FAKE_KEY);
    await cache.refresh(options); expect(calls).toBe(2);
    if (code === 'rate-limited') { await cache.refresh({ ...options, force: true }); expect(calls).toBe(2); }
    now += 5 * 60_000; expect((await cache.refresh(options)).state).toBe('ready'); expect(calls).toBe(3);
  });
});
