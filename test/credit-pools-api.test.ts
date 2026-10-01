/** Read-only HTTP/display boundaries. Synthetic metadata; no provider requests. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCreditPoolsApi, _resetCreditPoolsCacheForTest } from '../src/core/verse/credit-pools-api.js';
import { CREDIT_POOLS_PATH } from '../src/core/verse/credit-pools-api-types.js';
import { setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';
import type { ReadProjectionReader } from '../src/core/web/read-projections.js';
import { normalizeReadProjectionPayload } from '../src/core/web/read-projections.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { ResourceAccountIdentitySnapshot } from '../src/core/resources/account-identity-witness.js';
import type { CreditPoolReadView } from '../src/core/resources/credit-pool-types.js';
import { startServer } from '../src/core/web/server.js';
const f = vi.hoisted(() => ({ get: vi.fn(), snapshot: vi.fn(), touch: vi.fn(), invalidated: vi.fn(), revision: vi.fn() }));
vi.mock('../src/core/verse/accounts.js', async original => ({ ...await original<typeof import('../src/core/verse/accounts.js')>(), getVerseAccountCollector: f.get }));
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const root = '/private/fixture-accounts';
function identity(now = NOW, accountDigest = 'a'.repeat(64)): ResourceAccountIdentitySnapshot {
  return { witness: { provider: 'claude', accountId: 'demo-claude', accountDigest, profileDigest: 'b'.repeat(64), generation: 1,
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), source: 'native-account-checked' },
    localEpoch: { profileDigest: 'b'.repeat(64), epochDigest: 'c'.repeat(64), accountDigest } };
}
const view: CreditPoolReadView = { v: 1, sourceState: 'healthy', rows: [{ poolId: 'demo-gift', accountId: 'demo-claude', provider: 'claude',
  kind: 'gifted-cloud', amount: '12.34', total: '50', unit: 'USD', surface: 'cloud-session', capturedAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 86_400_000).toISOString(), expiryKind: 'fixed', source: { kind: 'verified-manual', adapter: 'claude-account-ui' },
  identityState: 'matched', evidenceState: 'recorded', expiryState: 'upcoming' }] };
function cfg(): AshlrConfig { return { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {}, verse: { accountsRoot: root } } as AshlrConfig; }
function context(read?: unknown): VerseApiContext { return { cfg: cfg(), token: 'fixture', allowDispatch: false,
  ...(read ? { readProjections: { read } as ReadProjectionReader } : {}) }; }
async function request(ctx: VerseApiContext, method = 'GET', query = '', path = CREDIT_POOLS_PATH) {
  let status = 0; let body = '';
  const res = { writeHead(code: number) { status = code; }, end(v: string) { body = v; } } as unknown as ServerResponse;
  const handled = await handleCreditPoolsApi(ctx, { url: path + query } as IncomingMessage, res, path, method);
  return { status, handled, body: body ? JSON.parse(body) : null };
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
beforeEach(() => {
  _resetCreditPoolsCacheForTest(); vi.useFakeTimers(); vi.setSystemTime(NOW);
  f.get.mockReset(); f.snapshot.mockReset().mockReturnValue([identity()]); f.touch.mockReset(); f.invalidated.mockReset().mockReturnValue([]); f.revision.mockReset().mockReturnValue(0);
  f.get.mockReturnValue({ accountsRoot: root, status: () => ({ mode: 'owned', state: 'running', reasonCode: null }),
    identityWitnessesSnapshot: f.snapshot, invalidatedIdentityAccountIdsSnapshot: f.invalidated, identitySnapshotRevision: f.revision, touch: f.touch });
});
afterEach(() => vi.useRealTimers());
describe('credit display API', () => {
  it('returns before a slow read, coalesces and never exposes private witnesses on wire', async () => {
    let finish!: (v: CreditPoolReadView) => void;
    const read = vi.fn(() => new Promise<CreditPoolReadView>(resolve => { finish = resolve; })); const ctx = context(read);
    expect((await request(ctx)).body).toMatchObject({ state: 'warming', pools: null }); await request(ctx);
    expect(read).toHaveBeenCalledExactlyOnceWith('credit-pools', { identitySnapshots: [identity()], invalidatedAccountIds: [] });
    finish(view); await settle(); const result = await request(ctx);
    expect(result.body).toMatchObject({ state: 'current', pools: view });
    for (const privateKey of ['accountDigest', 'profileDigest', 'epochDigest', 'generation', '"capture"', root, 'a'.repeat(64)]) expect(JSON.stringify(result)).not.toContain(privateKey);
    expect(f.touch).not.toHaveBeenCalled();
  });
  it('clears old identity amounts even during a pending read, with only one worker request', async () => {
    let finish!: (v: CreditPoolReadView) => void; const read = vi.fn(() => new Promise<CreditPoolReadView>(resolve => { finish = resolve; }));
    const ctx = context(read); await request(ctx); f.snapshot.mockReturnValue([identity(NOW, 'd'.repeat(64))]);
    expect((await request(ctx)).body).toMatchObject({ state: 'warming', pools: null }); expect(read).toHaveBeenCalledTimes(1);
    finish(view); await settle(); expect((await request(ctx)).body.pools).toBeNull();
    expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls[1]).toEqual(['credit-pools', { identitySnapshots: [identity(NOW, 'd'.repeat(64))], invalidatedAccountIds: [] }]);
  });
  it('rejects completed old worker evidence after a native invalidation, before another GET', async () => {
    let finish!: (v: CreditPoolReadView) => void; const read = vi.fn(() => new Promise<CreditPoolReadView>(resolve => { finish = resolve; }));
    const ctx = context(read); await request(ctx);
    f.snapshot.mockReturnValue([]); f.invalidated.mockReturnValue(['demo-claude']); f.revision.mockReturnValue(1);
    finish(view); await settle(); const result = await request(ctx);
    expect(result.body).toMatchObject({ state: 'warming', pools: null });
    expect(read.mock.calls[1]).toEqual(['credit-pools', { identitySnapshots: [], invalidatedAccountIds: ['demo-claude'] }]);
  });
  it('drops expired native snapshots and cannot renew their expiry on GET', async () => {
    const read = vi.fn().mockResolvedValue(view); const ctx = context(read); await request(ctx); await settle();
    vi.advanceTimersByTime(60_000); expect((await request(ctx)).body.pools).toBeNull();
    await settle(); expect(read.mock.calls[1]).toEqual(['credit-pools', { identitySnapshots: [], invalidatedAccountIds: [] }]);
  });
  it('reports stale worker failure without leaking private error text or retrying each poll', async () => {
    const read = vi.fn().mockResolvedValueOnce(view).mockRejectedValue(new Error('private-account-secret'));
    const ctx = context(read); await request(ctx); await settle(); vi.advanceTimersByTime(30_000);
    expect((await request(ctx)).body.state).toBe('stale'); await settle(); const result = await request(ctx);
    expect(result.body).toMatchObject({ state: 'stale', pools: view }); expect(JSON.stringify(result)).not.toContain('private-account-secret');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(['missing', 'other-root', 'stopped'])('does not use %s collector or trigger acquisition', async mode => {
    const read = vi.fn().mockResolvedValue({ v: 1, sourceState: 'missing', rows: [] });
    if (mode === 'missing') f.get.mockReturnValue(null);
    else f.get.mockReturnValue({ accountsRoot: mode === 'other-root' ? '/private/other' : root,
      status: () => ({ mode: 'owned', state: mode === 'stopped' ? 'stopped' : 'running', reasonCode: null }), identityWitnessesSnapshot: f.snapshot });
    await request(context(read)); await settle(); expect(read).toHaveBeenCalledExactlyOnceWith('credit-pools', { identitySnapshots: [], invalidatedAccountIds: [] });
    expect(f.snapshot).not.toHaveBeenCalled();
  });
  it('retains known invalidation tombstones when a same-root collector stops', async () => {
    const read = vi.fn().mockResolvedValue({ v: 1, sourceState: 'missing', rows: [] });
    f.get.mockReturnValue({ accountsRoot: root, status: () => ({ mode: 'owned', state: 'stopped', reasonCode: null }),
      identityWitnessesSnapshot: f.snapshot, invalidatedIdentityAccountIdsSnapshot: () => ['demo-claude'], identitySnapshotRevision: () => 2 });
    await request(context(read)); await settle();
    expect(read).toHaveBeenCalledExactlyOnceWith('credit-pools', { identitySnapshots: [], invalidatedAccountIds: ['demo-claude'] });
    expect(f.snapshot).not.toHaveBeenCalled();
  });
  it('refuses query/mutation and has no sync fallback without the worker', async () => {
    const read = vi.fn(); expect((await request(context(read), 'POST')).status).toBe(404);
    expect((await request(context(read), 'GET', '?root=/private/other')).status).toBe(400);
    expect((await request(context(read), 'GET', '', CREDIT_POOLS_PATH + '/child')).handled).toBe(false);
    expect(read).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
    expect((await request(context())).body).toEqual({ v: 1, state: 'unavailable', refreshedAt: null, pools: null });
  });
  it('rejects unknown options, paths, duplicate identities and accessors without executing them', () => {
    expect(normalizeReadProjectionPayload('credit-pools', { identitySnapshots: [identity()], invalidatedAccountIds: [] })).toEqual({ identitySnapshots: [identity()], invalidatedAccountIds: [] });
    const getter = vi.fn(); const bad = Object.defineProperty({}, 'identitySnapshots', { get: getter });
    for (const input of [bad, { root }, { identitySnapshots: [], invalidatedAccountIds: [], root }, { identitySnapshots: [identity(), identity()], invalidatedAccountIds: [] },
      { identitySnapshots: [null], invalidatedAccountIds: [] }, { identitySnapshots: [{ ...identity(), localEpoch: { ...identity().localEpoch, file: '/secret' } }], invalidatedAccountIds: [] },
      { identitySnapshots: new Array(1000000000), invalidatedAccountIds: [] }]) expect(() => normalizeReadProjectionPayload('credit-pools', input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('authenticates real HTTP before the snapshot getter or worker and rejects POST', async () => {
    vi.useRealTimers(); f.snapshot.mockReturnValue([identity(Date.now())]);
    let finish!: (v: CreditPoolReadView) => void; const read = vi.fn(() => new Promise<CreditPoolReadView>(resolve => { finish = resolve; }));
    const reader = { read, invalidate: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as ReadProjectionReader;
    const cloud = vi.fn(async () => async () => false);
    setMountedApiModulesForTest([{ id: 'cloud', load: cloud }]);
    const server = await startServer(cfg(), { port: 0, open: false, allowDispatch: false }, { readProjections: reader });
    f.get.mockClear(); f.snapshot.mockClear();
    try {
      const url = server.url + CREDIT_POOLS_PATH;
      expect((await fetch(url, { signal: AbortSignal.timeout(2000) })).status).toBe(401);
      expect(f.get).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
      const headers = { 'x-ashlr-token': server.readToken };
      const result = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      expect(await result.json()).toMatchObject({ state: 'warming', pools: null }); expect(read).toHaveBeenCalledTimes(1);
      finish(view); await settle(); const current = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      const wire = await current.text(); expect(JSON.parse(wire)).toMatchObject({ state: 'current', pools: view });
      expect(wire).not.toContain('accountDigest'); expect(wire).not.toContain('profileDigest');
      expect((await fetch(url, { headers, method: 'POST', signal: AbortSignal.timeout(2000) })).status).toBe(404);
      expect((await fetch(url + '?file=x', { headers, signal: AbortSignal.timeout(2000) })).status).toBe(400);
      expect((await fetch(url + '/unknown', { headers, signal: AbortSignal.timeout(2000) })).status).toBe(404);
      expect(cloud).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1); expect(reader.invalidate).not.toHaveBeenCalled(); expect(f.touch).not.toHaveBeenCalled();
    } finally { await server.close(); setMountedApiModulesForTest(null); }
  });
});
