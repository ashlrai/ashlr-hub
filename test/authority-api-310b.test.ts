/**
 * V3.10 Track B unit B-U1 — `/api/verse/authority*` (src/core/verse/authority-api.ts).
 *
 * Driven through in-memory request / response objects (the production
 * mutation gate, body reader and JSON sanitizer run for real). The custody
 * helper is faked — no Touch ID prompt, no Keychain — and the trust root is a
 * test key injected by module mocking. HOME-isolated.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  roots: [] as unknown[],
  surface: 'b'.repeat(64) as string | null,
  signMode: 'sign' as 'sign' | 'swap' | 'cancel',
}));

vi.mock('../src/core/authority/trust-roots.js', () => ({
  STANDING_GRANT_TRUST_ROOTS: state.roots,
  BURNED_KEY_IDS: Object.freeze(['mason-workstation']),
}));

vi.mock('../src/core/authority/surface.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/authority/surface.js')>();
  return {
    ...original,
    currentHostBinding: () => 'a'.repeat(64),
    confinementAvailable: () => ({ ok: true }),
    runningPackageRoot: () => '/test/release',
    verifyAuthoritySurface: (target: 'running' | 'installed') => (state.surface
      ? { ok: true, target, packageRoot: '/test/release', digest: state.surface, fileCount: 1, checkedAt: new Date().toISOString() }
      : { ok: false, target, packageRoot: null, code: 'manifest-missing', reason: 'no manifest in this test', checkedAt: new Date().toISOString() }),
  };
});

vi.mock('../src/core/authority/custody-client.js', async (importOriginal) => {
  const helpers = await import('./helpers/authority-310b.js');
  return {
    ...(await importOriginal<typeof import('../src/core/authority/custody-client.js')>()),
    custodyStatus: async () => ({
      installed: true,
      version: 'test',
      keyInitialized: true,
      keyId: helpers.TEST_KEY_ID,
      githubApp: false,
      claudeToken: null,
      checkedAt: new Date().toISOString(),
      reasons: [],
    }),
    signGrant: async (payload: import('../src/core/authority/types.js').StandingGrantV1) => {
      if (state.signMode === 'cancel') throw new Error('Touch ID was cancelled');
      if (state.signMode === 'swap') return helpers.signGrant({ ...payload, conductorGoals: !payload.conductorGoals });
      return helpers.signGrant(payload);
    },
  };
});

import {
  authorityNeedsYouItems,
  autonomyBadge,
  buildAuthorityStatus,
  handleAuthorityApi,
  needsYouItems,
  resetAuthorityApiCachesForTest,
} from '../src/core/verse/authority-api.js';
import { invalidateStandingPolicyCache } from '../src/core/authority/effective-config.js';
import { resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';
import type { AuthorityStatusV1 } from '../src/core/authority/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

const TOKEN = 'authority-test-token';
let restore: () => void;
let ctx: VerseApiContext;

beforeEach(() => {
  restore = withTempHome('bu1-api-').restore;
  state.roots.length = 0;
  state.surface = 'b'.repeat(64);
  state.signMode = 'sign';
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
  resetAuthorityApiCachesForTest();
});

afterEach(() => {
  resetLedgerCachesForTest();
  invalidateStandingPolicyCache();
  resetAuthorityApiCachesForTest();
  restore();
});

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Captured | null> {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, {
    method,
    url,
    headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
  });
  req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  let status = 0;
  let payload = '';
  const fake = { headersSent: false };
  const res = Object.assign(fake, {
    writeHead(code: number) {
      status = code;
      fake.headersSent = true;
      return fake;
    },
    end(chunk?: string) {
      payload = chunk ?? '';
      return fake;
    },
  }) as unknown as ServerResponse;
  const path = new URL(url, 'http://localhost').pathname;
  const handled = await handleAuthorityApi(ctx, req, res, path, method);
  if (!handled) return null;
  return { status, body: JSON.parse(payload || 'null') as Record<string, unknown> };
}

describe('routing and gates', () => {
  it('declines foreign paths so the mount chain continues', async () => {
    for (const path of ['/api/verse/budget', '/api/verse/authorityx', '/api/verse/activity', '/api/verse/fleet/history']) {
      expect(await call('GET', path)).toBeNull();
    }
  });

  it('GET reports the dark default honestly', async () => {
    const res = await call('GET', '/api/verse/authority');
    expect(res?.status).toBe(200);
    const status = res!.body as unknown as AuthorityStatusV1;
    expect(status).toMatchObject({ v: 1, switch: 'off', effectiveSwitch: 'off', maxSwitchWithoutGrant: 'off', kill: false, policy: null, rollout: null });
    expect(status.grant).toMatchObject({ state: 'none', repos: [], stageIds: [] });
    expect(status.custody).toEqual({ installed: true, keyInitialized: true, githubApp: false, claudeToken: null });
    expect((await call('GET', '/api/verse/authority?x=1'))?.status).toBe(400);
  });

  it('POST passes the dispatch and mutation-token gates and rejects unknown keys', async () => {
    ctx = { ...ctx, allowDispatch: false };
    expect((await call('POST', '/api/verse/authority', { action: 'stop' }))?.status).toBe(404);
    ctx = { ...ctx, allowDispatch: true };
    expect((await call('POST', '/api/verse/authority', { action: 'stop' }, { 'x-ashlr-token': 'wrong' }))?.status).toBe(401);
    expect((await call('POST', '/api/verse/authority', { action: 'stop' }, { 'content-type': 'text/plain' }))?.status).toBe(415);
    expect((await call('POST', '/api/verse/authority', { action: 'stop', force: true }))?.status).toBe(400);
    expect((await call('POST', '/api/verse/authority', { action: 'escalate' }))?.status).toBe(400);
    expect((await call('POST', '/api/verse/authority', '{nope'))?.status).toBe(400);
    expect((await call('POST', '/api/verse/authority', { action: 'switch', to: 'max' }))?.status).toBe(400);
  });
});

describe('actions', () => {
  it('raising past the grant is 409 grant-required; lowering is always fine', async () => {
    const raised = await call('POST', '/api/verse/authority', { action: 'switch', to: 'propose' });
    expect(raised?.status).toBe(409);
    expect(raised?.body).toMatchObject({ code: 'grant-required', maxSwitchWithoutGrant: 'off' });
    expect((await call('POST', '/api/verse/authority', { action: 'switch', to: 'off' }))?.status).toBe(200);
  });

  it('Stop and clear-stop', async () => {
    const stopped = await call('POST', '/api/verse/authority', { action: 'stop' });
    expect(stopped?.status).toBe(200);
    expect(stopped?.body).toMatchObject({ kill: true, result: { stop: { armed: true } } });
    const cleared = await call('POST', '/api/verse/authority', { action: 'clear-stop' });
    expect(cleared?.status).toBe(200);
    expect(cleared?.body['kill']).toBe(false);
  });

  it('Stop and Revoke await the armed-merge revocation but not the drain (R3b)', async () => {
    // mergesRevoked is a NUMBER only on the draining variants: the instant
    // stopAutonomy reports null (revocation started, not awaited).
    const started = Date.now();
    const stopped = await call('POST', '/api/verse/authority', { action: 'stop' });
    expect(stopped?.status).toBe(200);
    const stop = (stopped!.body['result'] as Record<string, Record<string, unknown>>)['stop']!;
    expect(stop).toMatchObject({ armed: true, mergesRevoked: 0, mergeRevokeFailures: [] });
    expect(stop['drainWaitedMs']).toBeLessThan(1_000);
    expect((await call('POST', '/api/verse/authority', { action: 'clear-stop' }))?.status).toBe(200);

    const revoked = await call('POST', '/api/verse/authority', { action: 'revoke', reason: 'test revoke' });
    expect(revoked?.status).toBe(200);
    const revoke = (revoked!.body['result'] as Record<string, Record<string, unknown>>)['revoke']!;
    expect(revoke).toMatchObject({ stopped: true, mergesRevoked: 0, mergeRevokeFailures: [] });
    expect(revoked?.body['kill']).toBe(true);
    // No drain wait: the whole exchange stays well inside the 2 s fence bound.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('drafting needs a compiled custody key', async () => {
    const res = await call('GET', '/api/verse/authority/draft');
    expect(res?.status).toBe(409);
    expect(res?.body).toMatchObject({ code: 'no-trust-roots' });
  });

  it('the Touch ID flow: draft → grant (the exact digest) → switch → a live policy', async () => {
    state.roots.push(TEST_ROOT);
    const draft = await call('GET', '/api/verse/authority/draft');
    expect(draft?.status).toBe(200);
    const digest = draft!.body['digest'] as string;
    // The scrubber would redact a bare 64-hex digest; the API restores ours.
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(draft!.body).toMatchObject({ kind: 'new', startStageId: 'shadow' });
    const payload = draft!.body['payload'] as Record<string, unknown>;
    expect(payload['authoritySurfaceDigest']).toBe('b'.repeat(64));
    expect(payload['hostBinding']).not.toBe('a'.repeat(64)); // a hardware fingerprint stays redacted
    expect((draft!.body['summary'] as string[]).length).toBeGreaterThan(3);

    expect((await call('POST', '/api/verse/authority', { action: 're-approve', draftDigest: digest }))?.status).toBe(400);
    const granted = await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: digest });
    expect(granted?.status).toBe(200);
    expect(granted?.body).toMatchObject({ grant: { state: 'active', grantSeq: 1 }, maxSwitchWithoutGrant: 'autonomous' });
    // A draft is single-use.
    expect((await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: digest }))?.body).toMatchObject({ code: 'draft-expired' });

    const switched = await call('POST', '/api/verse/authority', { action: 'switch', to: 'autonomous' });
    expect(switched?.status).toBe(200);
    expect(switched?.body).toMatchObject({ effectiveSwitch: 'autonomous', rollout: { stageId: 'shadow', stageIndex: 0 } });
    expect(switched!.body['policy']).not.toBeNull();

    const ledger = await call('GET', '/api/verse/authority/ledger?limit=5');
    const entries = ledger!.body['entries'] as { hash: string; prevHash: string; kind: string }[];
    expect(entries.map((e) => e.kind)).toContain('grant:accepted');
    for (const entry of entries) {
      expect(entry.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.prevHash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect((await call('GET', '/api/verse/authority/ledger?kind=nope'))?.status).toBe(400);
    expect((await call('GET', '/api/verse/authority/ledger?limit=abc'))?.status).toBe(400);
  });

  it('refuses a digest it never served, a helper that signed something else, and a cancelled Touch ID', async () => {
    state.roots.push(TEST_ROOT);
    expect((await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: 'f'.repeat(64) }))?.body).toMatchObject({ code: 'draft-expired' });
    const draft = await call('GET', '/api/verse/authority/draft');
    const digest = draft!.body['digest'] as string;
    state.signMode = 'swap';
    const swapped = await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: digest });
    expect(swapped?.status).toBe(502);
    expect(swapped?.body).toMatchObject({ code: 'custody-mismatch' });
    state.signMode = 'cancel';
    expect((await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: digest }))?.body).toMatchObject({ code: 'not-signed' });
    expect((await call('GET', '/api/verse/authority'))?.body).toMatchObject({ grant: { state: 'none' } });
  });
});

describe('Needs-you and the rail badge (R1)', () => {
  it('answer from cache: throw / null until the first refresh, then serve without I/O', async () => {
    expect(() => needsYouItems()).toThrow(/loading/);
    expect(autonomyBadge()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(needsYouItems()).toEqual([]);
    expect(autonomyBadge()).toMatchObject({ mode: 'off', paused: false, stopped: false, label: 'Off · no grant' });
  });

  it('Stop under an active grant and a paused grant produce valid, actionable items', async () => {
    state.roots.push(TEST_ROOT);
    const draft = await call('GET', '/api/verse/authority/draft');
    await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: draft!.body['digest'] });
    await call('POST', '/api/verse/authority', { action: 'switch', to: 'autonomous' });
    await call('POST', '/api/verse/authority', { action: 'stop' });
    const stopped = needsYouItems();
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ id: 'authority:kill:stop', kind: 'kill', severity: 'high' });
    expect(stopped[0]!.actions[0]).toMatchObject({ kind: 'resume', request: { method: 'POST', path: '/api/verse/authority', body: { action: 'clear-stop' } } });
    expect(stopped.every(isNeedsYouItem)).toBe(true);
    expect(autonomyBadge()).toMatchObject({ stopped: true, label: 'Stopped' });

    await call('POST', '/api/verse/authority', { action: 'clear-stop' });
    state.surface = 'c'.repeat(64);
    invalidateStandingPolicyCache();
    const { status, evaluation } = await buildAuthorityStatus();
    const items = authorityNeedsYouItems(status, evaluation, Date.now());
    expect(items.map((i) => i.title)).toEqual(['Authority code changed — re-approve the grant']);
    expect(items.every(isNeedsYouItem)).toBe(true);
    expect(autonomyBadge()).toMatchObject({ paused: true, label: 'Paused — re-approve' });
  });

  it('warns before a grant expires', async () => {
    state.roots.push(TEST_ROOT);
    const draft = await call('GET', '/api/verse/authority/draft');
    await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: draft!.body['digest'] });
    const { status, evaluation } = await buildAuthorityStatus();
    const expiresMs = Date.parse(status.grant.expiresAt!);
    expect(authorityNeedsYouItems(status, evaluation, expiresMs - 80 * 3_600_000)).toEqual([]);
    const soon = authorityNeedsYouItems(status, evaluation, expiresMs - 10 * 3_600_000);
    expect(soon[0]).toMatchObject({ kind: 'grant', severity: 'warn', title: 'Standing grant expires in 10 h — renew' });
    expect(soon.every(isNeedsYouItem)).toBe(true);
  });
});
