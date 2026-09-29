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
  buildStandingGrantDraft,
  handleAuthorityApi,
  needsYouItems,
  resetAuthorityApiCachesForTest,
} from '../src/core/verse/authority-api.js';
import { invalidateStandingPolicyCache } from '../src/core/authority/effective-config.js';
import { resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import { registerExecutionLease, type ExecutionLease } from '../src/core/sandbox/execution-leases.js';
import { acquireOutwardMutationFence, ownsOutwardMutationFence, releaseOutwardMutationFence } from '../src/core/sandbox/mutation-fence.js';
import { killSwitchOn } from '../src/core/sandbox/policy.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';
import type { AuthorityStatusV1 } from '../src/core/authority/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

const TOKEN = 'authority-test-token';
let restore: () => void;
let ctx: VerseApiContext;
const leases: ExecutionLease[] = [];

function heldAgent(runId: string): ExecutionLease {
  const fence = acquireOutwardMutationFence(2_000);
  expect(ownsOutwardMutationFence(fence)).toBe(true);
  try {
    const registration = registerExecutionLease(fence, { runId, repoKey: '/repo/a', engine: 'local' });
    if (!registration.ok) throw new Error(registration.reason);
    leases.push(registration.lease);
    return registration.lease;
  } finally {
    releaseOutwardMutationFence(fence);
  }
}

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
  for (const lease of leases.splice(0)) lease.release();
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
    // A held lease proves the API returns without waiting for the running
    // agent to drain, independent of host load or filesystem latency.
    const stopLease = heldAgent('api-stop');
    const stopped = await call('POST', '/api/verse/authority', { action: 'stop' });
    expect(stopped?.status).toBe(200);
    const stop = (stopped!.body['result'] as Record<string, Record<string, unknown>>)['stop']!;
    expect(stop).toMatchObject({ armed: true, quiesced: false, liveExecutionLeases: 1,
      mergesRevoked: 0, mergeRevokeFailures: [] });
    expect(killSwitchOn()).toBe(true);
    expect(stopLease.signal.aborted).toBe(true);
    expect(stopLease.isHeld()).toBe(true);
    stopLease.release();
    expect((await call('POST', '/api/verse/authority', { action: 'clear-stop' }))?.status).toBe(200);

    const revokeLease = heldAgent('api-revoke');
    const revoked = await call('POST', '/api/verse/authority', { action: 'revoke', reason: 'test revoke' });
    expect(revoked?.status).toBe(200);
    const revoke = (revoked!.body['result'] as Record<string, Record<string, unknown>>)['revoke']!;
    expect(revoke).toMatchObject({ stopped: true, liveExecutionLeases: 1,
      mergesRevoked: 0, mergeRevokeFailures: [] });
    expect(revoked?.body['kill']).toBe(true);
    expect(killSwitchOn()).toBe(true);
    expect(revokeLease.signal.aborted).toBe(true);
    expect(revokeLease.isHeld()).toBe(true);
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

  it('3.15 grant editor: POST /draft applies a scope edit within the draft, diffs it, and the edited draft is what gets signed', async () => {
    state.roots.push(TEST_ROOT);
    const plain = await call('GET', '/api/verse/authority/draft');
    expect(plain?.status).toBe(200);
    const editable = plain!.body['editable'] as { repos: string[]; engines: string[]; leaderClasses: string[]; maxDays: number };
    expect(editable.leaderClasses).toEqual(['A', 'B']);
    expect(editable.maxDays).toBe(30);
    expect(editable.repos).toContain('ashlrai/fleet-canary');
    // No grant in force: every diff line is new.
    expect((plain!.body['diff'] as { direction: string }[]).some((line) => line.direction === 'wider')).toBe(true);

    // The mutation token is required (the draft store feeds the next approve).
    expect((await call('POST', '/api/verse/authority/draft', { scope: {} }, { 'x-ashlr-token': 'wrong' }))?.status).toBe(401);
    expect((await call('POST', '/api/verse/authority/draft', { scope: { nope: 1 } }))?.status).toBe(400);
    expect((await call('POST', '/api/verse/authority/draft', { scope: { repos: ['evil/repo'] } }))?.body).toMatchObject({ code: 'scope-invalid' });

    const edited = await call('POST', '/api/verse/authority/draft', { kind: 'new', scope: { leaderClasses: ['A'], days: 7, maxMode: 'reserve' } });
    expect(edited?.status).toBe(200);
    const payload = edited!.body['payload'] as { leader: { classes: string[] }; spend: { maxMode: string } };
    expect(payload.leader.classes).toEqual(['A']);
    expect(payload.spend.maxMode).toBe('reserve');
    const digest = edited!.body['digest'] as string;
    const granted = await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: digest });
    expect(granted?.status).toBe(200);
    expect(granted?.body).toMatchObject({ grant: { state: 'active', maxMode: 'reserve' } });

    // Re-approving now diffs against the grant in force.
    const again = await call('POST', '/api/verse/authority/draft', { kind: 'reapprove', scope: { leaderClasses: ['A', 'B'] } });
    expect(again?.status).toBe(200);
    expect((again!.body['diff'] as { label: string; direction: string }[]).find((line) => line.label === 'Leader classes')).toMatchObject({ direction: 'wider' });
  });

  it('elite-direct (3.15): the draft is one signed rung, and once granted it is the live stage', async () => {
    state.roots.push(TEST_ROOT);
    expect((await call('GET', '/api/verse/authority/draft?eliteDirect=2'))?.status).toBe(400);
    const plain = await call('GET', '/api/verse/authority/draft');
    expect(plain!.body).toMatchObject({ startStageId: 'shadow', eliteDirect: false });
    const draft = await call('GET', '/api/verse/authority/draft?eliteDirect=1');
    expect(draft?.status).toBe(200);
    expect(draft!.body).toMatchObject({ kind: 'new', startStageId: 'elite-direct', eliteDirect: true });
    expect(((draft!.body['payload'] as { rollout: { stages: unknown[] } }).rollout.stages)).toHaveLength(1);
    expect((draft!.body['summary'] as string[]).some((line) => line.includes('no judge'))).toBe(true);
    expect((await call('POST', '/api/verse/authority/draft', { kind: 'new', scope: {}, eliteDirect: 'yes' }))?.status).toBe(400);
    const edited = await call('POST', '/api/verse/authority/draft', { kind: 'new', scope: { leaderClasses: ['A'] }, eliteDirect: true });
    expect(edited?.body).toMatchObject({ startStageId: 'elite-direct', eliteDirect: true });
    expect(((edited!.body['payload'] as { leader: { classes: string[] } }).leader.classes)).toEqual(['A']);
    const granted = await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: edited!.body['digest'] });
    expect(granted?.status).toBe(200);
    const switched = await call('POST', '/api/verse/authority', { action: 'switch', to: 'autonomous' });
    expect(switched?.body).toMatchObject({ rollout: { stageId: 'elite-direct', stageIndex: 0 } });
    // A re-approval continues elite-direct; asking to leave it that way is refused (a new grant does that).
    const again = await call('GET', '/api/verse/authority/draft?kind=reapprove');
    expect(again!.body).toMatchObject({ kind: 'reapprove', startStageId: 'elite-direct', eliteDirect: true });
    const leave = await call('GET', '/api/verse/authority/draft?kind=reapprove&eliteDirect=0');
    expect(leave?.status).toBe(409);
    expect(leave?.body).toMatchObject({ code: 'elite-direct-reapprove' });
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

describe('drafts name server enforcement only where GitHub enforces checks (3.14)', () => {
  const CANARY = 'ashlrai/fleet-canary';
  /** A GitHub whose canary either enforces a required check, is plan-gated, or cannot be read. */
  function github(mode: 'enforced' | 'unavailable' | 'offline') {
    const calls: string[] = [];
    const get = async (path: string) => {
      calls.push(path);
      if (mode === 'offline') return { status: 1, stdout: '', stderr: 'error connecting to api.github.com' };
      if (path === `repos/${CANARY}`) return { status: 0, stdout: JSON.stringify({ private: mode === 'unavailable', default_branch: 'main' }), stderr: '' };
      if (path.startsWith(`repos/${CANARY}/rules/branches/main`)) {
        return mode === 'unavailable'
          ? { status: 1, stdout: '', stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' }
          : { status: 0, stdout: JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }]), stderr: '' };
      }
      if (path === `repos/${CANARY}/branches/main`) return { status: 0, stdout: JSON.stringify({ name: 'main', protection: { enabled: false } }), stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected ${path}` };
    };
    return { get, calls };
  }
  const canaryOf = (payload: { repos: { nameWithOwner: string }[] }) => payload.repos.find((r) => r.nameWithOwner === CANARY);

  it('a new grant: server where GitHub enforces checks, local where rulesets are unavailable or unreadable', async () => {
    state.roots.push(TEST_ROOT);
    expect(canaryOf((await buildStandingGrantDraft('new', Date.now(), { githubGet: github('enforced').get })).payload))
      .toMatchObject({ enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 6 });
    expect(canaryOf((await buildStandingGrantDraft('new', Date.now(), { githubGet: github('unavailable').get })).payload))
      .toMatchObject({ enforcement: 'local', maxRisk: 'low', maxMergesPerDay: 4 });
    expect(canaryOf((await buildStandingGrantDraft('new', Date.now(), { githubGet: github('offline').get })).payload))
      .toMatchObject({ enforcement: 'local' });
    // The route's default reader never reaches GitHub under tests: the stricter answer, local.
    const routed = await call('GET', '/api/verse/authority/draft');
    expect(canaryOf(routed!.body['payload'] as { repos: { nameWithOwner: string }[] })).toMatchObject({ enforcement: 'local' });
  });

  it('the signed grant is not changed in place; a re-approval switches a server repo GitHub cannot protect to local', async () => {
    state.roots.push(TEST_ROOT);
    const first = await buildStandingGrantDraft('new', Date.now(), { githubGet: github('enforced').get });
    expect((await call('POST', '/api/verse/authority', { action: 'grant', draftDigest: first.digest }))?.status).toBe(200);
    // Offline during the re-approval: the signed choice stands (a flaky network never rewrites scope).
    const offline = await buildStandingGrantDraft('reapprove', Date.now(), { githubGet: github('offline').get });
    expect(offline.kind).toBe('reapprove');
    expect(canaryOf(offline.payload)).toMatchObject({ enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 6 });
    // GitHub definitively cannot protect it: local, at the local ceilings, shown in the Touch ID summary.
    const unavailable = await buildStandingGrantDraft('reapprove', Date.now(), { githubGet: github('unavailable').get });
    expect(canaryOf(unavailable.payload)).toMatchObject({ enforcement: 'local', maxRisk: 'low', maxMergesPerDay: 4 });
    expect(unavailable.summary.some((line) => line.includes(`${CANARY}: up to merge, low risk, 4/day, local enforcement`))).toBe(true);
    const reapproved = await call('POST', '/api/verse/authority', { action: 're-approve', draftDigest: unavailable.digest });
    expect(reapproved?.status).toBe(200);
  });
});
