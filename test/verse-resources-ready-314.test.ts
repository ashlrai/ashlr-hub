/**
 * 3.14 — every account connected, accurate and ready for chat and the fleet.
 *
 * The defects diagnosed against Mason's machine on 2026-09-26, each pinned:
 *
 *  1. An IDLE Verse collector kept the exclusive native-metadata lease for
 *     hours, so the fleet daemon's capacity publisher was refused every five
 *     minutes and every paid seat read "unknown usage" to autonomy. It now
 *     hands the lease back once polling pauses, and takes it again at once on
 *     the next request.
 *  2. A Verse with no live collector republished an EMPTY capacity snapshot
 *     every 60 s, which kept the daemon's own publisher dormant (budget-api
 *     gate — covered in routing-budget-api.test.ts) — and when the lease holder
 *     publishes live shared evidence, the daemon now relays it.
 *  3. A retained connection snapshot was served verbatim after its monitor
 *     stopped, so an hour-old row still read `observed`.
 *  4. Codex rows blinked to "no reading" between connection passes while the
 *     quota refresher in the same process held a verified reading.
 *  5. The read-only note blamed `ashlr resource-console`, which was not running.
 *  6. llama-server (the third local runtime) was invisible in the Local card.
 *
 * Real lease files under a tmp root and a tmp HOME; the real ~/.ashlr is never
 * touched and no native account is ever contacted (fixture launchers do not exist).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acquireResourceQuotaRefreshLease, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { expireConnectionRow } from '../src/core/resources/connection-monitor.js';
import type { ResourceAccountConnection, ResourceConnectionsSnapshot } from '../src/core/resources/connection-types.js';
import type { ResourceObservation } from '../src/core/resources/pool-policy.js';
import {
  accountsLedgerRoot,
  buildVerseAccountsSnapshot,
  leaseHolderSentence,
  readLeaseHolderPid,
  startVerseAccountCollector,
  verseCollectorLive,
  type VerseAccountCollector,
  type VerseAccountsCollectorStatus,
} from '../src/core/verse/accounts.js';
import {
  createDaemonCapacityPublisher,
  type DaemonCapacityPublisherDeps,
  type PublisherCollector,
} from '../src/core/daemon/capacity-publisher.js';
import type { CapacitySnapshot } from '../src/core/routing/budget-store.js';
import { collectVerseLocalModels } from '../src/core/verse/local-models.js';
import type { AshlrConfig } from '../src/core/types.js';

const FAKE_NODE = '/opt/fixture-does-not-exist/bin/node';
const launcherFor = (profile: string) => `/opt/fixture-does-not-exist/.ashlr/native-profiles/${profile}/launcher.mjs`;

const POOL = {
  schemaVersion: 1,
  id: 'ashlr-subscriptions-fixture',
  workers: [
    { id: 'codex-personal', provider: 'codex', model: 'gpt-6-astra', maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 6, taskWindowMs: 3_600_000, priority: 50 },
  ],
};
const BINDINGS = [{ workerId: 'codex-personal', capacityKey: 'personal', kind: 'native-cli', command: [FAKE_NODE, launcherFor('codex-a')] }];
const QUOTA_CONFIG = {
  schemaVersion: 1,
  poolDigest: digest(canonical({ pool: POOL, bindings: BINDINGS })),
  workers: [{ workerId: 'codex-personal', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }],
};
const CONNECTIONS = {
  schemaVersion: 1,
  intervalMs: 30_000,
  accounts: [
    { id: 'codex-personal', label: 'Personal Codex', provider: 'codex', command: [FAKE_NODE, launcherFor('codex-a')] },
    { id: 'claude', label: 'Claude Code', provider: 'claude', command: [FAKE_NODE, launcherFor('claude-a')] },
  ],
};

function writePrivate(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function makeRoot(): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ashlr-ready-314-')));
  fs.chmodSync(base, 0o700);
  fs.mkdirSync(path.join(base, 'ledger'), { mode: 0o700 });
  fs.chmodSync(path.join(base, 'ledger'), 0o700);
  writePrivate(path.join(base, 'pool.json'), POOL);
  writePrivate(path.join(base, 'bindings.json'), BINDINGS);
  writePrivate(path.join(base, 'quota-config.json'), QUOTA_CONFIG);
  writePrivate(path.join(base, 'connections.json'), CONNECTIONS);
  writePrivate(path.join(base, 'observations.json'), []);
  return base;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

let root: string;
let tmpHome: string;
let prevHome: string | undefined;
let held: ResourceQuotaRefreshLease | null = null;
let collector: VerseAccountCollector | null = null;
let clockOffset = 0;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-ready-314-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  root = makeRoot();
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
});

afterEach(async () => {
  if (collector) { try { await collector.close(); } catch { /* reported inside */ } collector = null; }
  if (held) { try { held.close(false); } catch { /* best effort */ } held = null; }
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Idle lease hand-back
// ---------------------------------------------------------------------------

describe('an idle Verse collector hands the lease back (the fleet daemon was starved)', () => {
  it('pauses, releases the lease so another collector can sample, and re-takes it on the next request without waiting', async () => {
    const logs: string[] = [];
    collector = await startVerseAccountCollector({ accountsRoot: root, idleSuspendMs: 60_000, idleCheckMs: 20, log: (m) => logs.push(m) });
    expect(collector.status()).toMatchObject({ mode: 'owned', owner: 'this-server' });
    expect(verseCollectorLive(collector)).toBe(true);

    // Nobody asks for account data for longer than the idle window.
    clockOffset += 61_000;
    expect(await waitFor(() => collector!.status().mode === 'read-only')).toBe(true);
    const paused = collector.status();
    expect(paused).toMatchObject({ mode: 'read-only', state: 'suspended', owner: 'none', reasonCode: 'connection-polling-paused' });
    expect(paused.note).toContain('handed back so the fleet daemon can keep sampling');
    expect(verseCollectorLive(collector)).toBe(false);
    expect(logs.some((m) => m.includes('lease handed back'))).toBe(true);

    // The daemon's publisher can now take it — this is the whole point.
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    expect(held).toBeTruthy();
    held.close(false);
    held = null;

    // The next request re-acquires immediately (no 30 s retry spacing).
    collector.touch();
    expect(await waitFor(() => collector!.status().mode === 'owned')).toBe(true);
    expect(collector.status()).toMatchObject({ owner: 'this-server', reasonCode: null });
    expect(logs.some((m) => m.includes('native polling resumed'))).toBe(true);
  });

  it('while another process holds it after the hand-back, Verse reports the holder by pid and stays read-only', async () => {
    collector = await startVerseAccountCollector({ accountsRoot: root, idleSuspendMs: 60_000, idleCheckMs: 20 });
    clockOffset += 61_000;
    expect(await waitFor(() => collector!.status().mode === 'read-only')).toBe(true);
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    collector.touch();
    expect(await waitFor(() => collector!.status().owner === 'another-collector')).toBe(true);
    const status: VerseAccountsCollectorStatus = collector.status();
    expect(status).toMatchObject({ mode: 'read-only', reasonCode: 'collector-owned', holderPid: process.pid });
    expect(status.note).not.toContain('resource-console');
  });

  it('a request that arrives before the watchdog fires keeps the lease (no hand-back while in use)', async () => {
    collector = await startVerseAccountCollector({ accountsRoot: root, idleSuspendMs: 60_000, idleCheckMs: 20 });
    for (let i = 0; i < 5; i += 1) {
      clockOffset += 20_000;
      collector.touch();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(collector.status()).toMatchObject({ mode: 'owned', owner: 'this-server' });
  });
});

// ---------------------------------------------------------------------------
// 3–5. Snapshot projection: retained rows expire, Codex gaps bridge, notes
// ---------------------------------------------------------------------------

function connection(over: Partial<ResourceAccountConnection>): ResourceAccountConnection {
  return {
    id: 'codex-personal', label: 'Personal Codex', provider: 'codex', state: 'observed', authentication: 'signed-in',
    health: 'reachable', planType: 'pro', observedAt: null, expiresAt: null, windows: [], reason: 'probe-observed',
    onDemandEnabled: null, executionSupported: true, ...over,
  };
}

function fakeCollector(opts: {
  rows: ResourceAccountConnection[];
  observations?: ResourceObservation[];
  unavailable?: string[];
  last?: Record<string, string>;
}): VerseAccountCollector {
  const snapshot: ResourceConnectionsSnapshot = { sampledAt: new Date().toISOString(), refreshing: false, accounts: opts.rows };
  return {
    accountsRoot: root,
    status: () => ({ mode: 'owned', state: 'running', owner: 'this-server', reasonCode: null, pollIntervalMs: 30_000,
      idleSuspendMs: 300_000, lastPolledAt: null, lastRequestAt: null, note: '' }),
    touch: () => {},
    connections: () => snapshot,
    observations: () => opts.observations ?? [],
    unavailableWorkerIds: () => opts.unavailable ?? [],
    credits: () => null,
    lastReadingAt: (id) => opts.last?.[id] ?? null,
    close: async () => {},
  };
}

function codexObservation(ageMs = 5_000, usedPercent = 0): ResourceObservation {
  const observed = Date.now() - ageMs;
  return {
    workerId: 'codex-personal', health: 'ready', retryAfter: null,
    observedAt: new Date(observed).toISOString(), expiresAt: new Date(observed + 60_000).toISOString(),
    windows: [{ id: 'codex_codex_primary', usedPercent, resetsAt: new Date(observed + 7 * 86_400_000).toISOString() }],
  };
}

describe('Codex readings: the quota refresher bridges a connection-pass gap', () => {
  const expired = connection({ state: 'unavailable', authentication: 'unknown', health: 'unknown', planType: null, reason: 'connection-reading-expired' });

  it('an expired connection row is answered by the refresher\'s verified reading from the same process', () => {
    const snap = buildVerseAccountsSnapshot({ accountsRoot: root, collector: fakeCollector({ rows: [expired], observations: [codexObservation()] }) });
    const codex = snap.accounts.find((a) => a.id === 'codex-personal')!;
    expect(codex).toMatchObject({ state: 'observed', authentication: 'signed-in', health: 'reachable', reason: 'probe-observed' });
    expect(codex.windows.map((w) => [w.id, w.usedPercent])).toEqual([['codex_codex_primary', 0]]);
    expect(codex.binding).toMatchObject({ usedPercent: 0 });
  });

  it('never bridges a FAILED check, a vetoed account, or an expired refresher reading (#491 holds)', () => {
    const failed = connection({ state: 'unavailable', authentication: 'unknown', health: 'unavailable', reason: 'probe-account-changed' });
    const a = buildVerseAccountsSnapshot({ accountsRoot: root, collector: fakeCollector({ rows: [failed], observations: [codexObservation()] }) });
    expect(a.accounts.find((x) => x.id === 'codex-personal')!.state).toBe('unavailable');

    const b = buildVerseAccountsSnapshot({ accountsRoot: root, collector: fakeCollector({ rows: [expired], observations: [codexObservation()], unavailable: ['codex-personal'] }) });
    expect(b.accounts.find((x) => x.id === 'codex-personal')!.state).toBe('unavailable');

    const c = buildVerseAccountsSnapshot({ accountsRoot: root, collector: fakeCollector({ rows: [expired], observations: [codexObservation(61_000)] }) });
    expect(c.accounts.find((x) => x.id === 'codex-personal')!.state).toBe('unavailable');
  });

  it('never bridges a Claude row, whatever the evidence holds', () => {
    const claude = connection({ id: 'claude', label: 'Claude Code', provider: 'claude', state: 'unavailable', reason: 'connection-reading-expired' });
    const snap = buildVerseAccountsSnapshot({ accountsRoot: root, collector: fakeCollector({ rows: [claude], observations: [codexObservation()] }) });
    expect(snap.accounts.find((x) => x.id === 'claude')!.state).toBe('unavailable');
  });

  it('an account with no current reading carries an honest lastReadingAt, and never alongside a current one', () => {
    const last = '2026-09-26T20:56:26.150Z';
    const snap = buildVerseAccountsSnapshot({ accountsRoot: root, collector: fakeCollector({ rows: [expired], last: { 'codex-personal': last, claude: last } }) });
    const codex = snap.accounts.find((a) => a.id === 'codex-personal')!;
    expect(codex.observedAt).toBeNull();
    expect(codex.lastReadingAt).toBe(last);
    expect(codex.windows).toEqual([]);

    const live = buildVerseAccountsSnapshot({ accountsRoot: root, collector: fakeCollector({ rows: [expired], observations: [codexObservation()], last: { 'codex-personal': last } }) });
    expect(live.accounts.find((a) => a.id === 'codex-personal')!.lastReadingAt).toBeUndefined();
  });
});

describe('retained connection rows expire exactly like live ones', () => {
  it('an observed row past its expiry is no longer a current claim', () => {
    const now = Date.parse('2026-09-26T21:00:00.000Z');
    const row = connection({ observedAt: '2026-09-26T20:56:00.000Z', expiresAt: '2026-09-26T20:57:00.000Z',
      windows: [{ id: 'codex_codex_primary', usedPercent: 0, resetsAt: null }] });
    expect(expireConnectionRow(row, now)).toMatchObject({ state: 'unavailable', windows: [], observedAt: null, reason: 'connection-reading-expired' });
    expect(expireConnectionRow(row, Date.parse('2026-09-26T20:56:30.000Z'))).toBe(row);
    const signedOut = connection({ state: 'signed-out', expiresAt: '2026-09-26T20:57:00.000Z' });
    expect(expireConnectionRow(signedOut, now)).toBe(signedOut);
  });
});

describe('verseCollectorLive: only an owned, running, healthy collector publishes', () => {
  const status = (over: Partial<VerseAccountsCollectorStatus>): VerseAccountCollector => ({
    ...fakeCollector({ rows: [] }),
    status: () => ({ mode: 'owned', state: 'running', owner: 'this-server', reasonCode: null, pollIntervalMs: 30_000,
      idleSuspendMs: 300_000, lastPolledAt: null, lastRequestAt: null, note: '', ...over }),
  });
  it('answers per state', () => {
    expect(verseCollectorLive(status({}))).toBe(true);
    expect(verseCollectorLive(status({ state: 'suspended' }))).toBe(false);
    expect(verseCollectorLive(status({ mode: 'read-only', owner: 'another-collector', reasonCode: 'collector-owned', state: 'blocked' }))).toBe(false);
    expect(verseCollectorLive(status({ state: 'running', reasonCode: 'collector-unavailable' }))).toBe(false);
    expect(verseCollectorLive(null)).toBe(false);
    expect(verseCollectorLive({ ...status({}), status: () => { throw new Error('boom'); } })).toBe(false);
  });
});

describe('lease holder diagnostics never carry the lock token', () => {
  it('reads only the pid', () => {
    const ledger = accountsLedgerRoot(root);
    const token = 'f'.repeat(64);
    writePrivate(path.join(ledger, '.resource-quota-refresh.lock'), { pid: 2211, token, startRef: '0'.repeat(64) });
    expect(readLeaseHolderPid(ledger)).toBe(2211);
    const sentence = leaseHolderSentence(2211);
    expect(sentence).toContain('pid 2211');
    expect(sentence).not.toContain(token);
    expect(sentence).not.toContain('resource-console');
    writePrivate(path.join(ledger, '.resource-quota-refresh.lock'), { pid: 'x' });
    expect(readLeaseHolderPid(ledger)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Daemon relays live shared evidence when it cannot hold the lease
// ---------------------------------------------------------------------------

describe('daemon capacity publisher relays the lease holder\'s live shared evidence', () => {
  function harness(sharedLive: boolean | undefined) {
    const published: string[] = [];
    let current: CapacitySnapshot | null = null;
    let now = Date.parse('2026-09-27T00:00:00Z');
    let closed = 0;
    const deps: DaemonCapacityPublisherDeps = {
      nowMs: () => now,
      sleep: async (ms) => { now += ms; },
      readSnapshot: () => current,
      startCollector: async () => {
        const c: PublisherCollector = {
          status: () => ({ mode: 'read-only', reasonCode: 'collector-owned' }),
          connections: () => null,
          close: async () => { closed += 1; },
        };
        return c;
      },
      publish: async () => {
        const at = new Date(now).toISOString();
        published.push(at);
        current = { v: 1, publishedAt: at, seats: [] };
        return at;
      },
      log: () => {},
      ...(sharedLive === undefined ? {} : { sharedEvidenceLive: async () => sharedLive }),
    };
    return { deps, published, closed: () => closed };
  }

  it('publishes the holder\'s live evidence instead of leaving the fleet cold', async () => {
    const h = harness(true);
    const status = await createDaemonCapacityPublisher({} as AshlrConfig, h.deps).cycle();
    expect(status.state).toBe('published-shared');
    expect(h.published).toHaveLength(1);
    expect(h.closed()).toBe(1);
  });

  it('with no live shared evidence (or no probe for it) stays cold, exactly as before', async () => {
    for (const shared of [false, undefined]) {
      const h = harness(shared);
      const status = await createDaemonCapacityPublisher({} as AshlrConfig, h.deps).cycle();
      expect(status.state).toBe('lease-held-elsewhere');
      expect(h.published).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. llama-server joins the Local resource
// ---------------------------------------------------------------------------

describe('local models: llama-server is reported beside Ollama and LM Studio', () => {
  function fetchStub(llama: 'timeout' | 'refused' | 'ok'): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:8080')) {
        if (llama === 'refused') throw new TypeError('fetch failed');
        if (llama === 'timeout') {
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
          });
        }
        if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
        if (url.endsWith('/props')) return Response.json({ total_slots: 4 });
        if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: '/Users/someone/.ollama/models/blobs/sha256-abc' }] });
      }
      throw new TypeError('fetch failed');
    }) as typeof fetch;
  }

  it('a wedged server (listening, never answering) reads as a timeout, not as absent', async () => {
    const snap = await collectVerseLocalModels({ fetchImpl: fetchStub('timeout'), timeoutMs: 30, ollamaServerDefault: null, lastGoodTtlMs: 0 });
    expect(snap.llamaServer).toMatchObject({ reachable: false, status: 'down', reason: 'llama-server-timeout' });
  });

  it('refused is "not running"; answering reports slots and a COUNT for a path-named model, never the path', async () => {
    const refused = await collectVerseLocalModels({ fetchImpl: fetchStub('refused'), timeoutMs: 30, ollamaServerDefault: null, lastGoodTtlMs: 0 });
    expect(refused.llamaServer).toMatchObject({ status: 'down', reason: 'llama-server-refused' });
    const ok = await collectVerseLocalModels({ fetchImpl: fetchStub('ok'), timeoutMs: 30, ollamaServerDefault: null, lastGoodTtlMs: 0 });
    expect(ok.llamaServer).toMatchObject({ reachable: true, status: 'ok', slots: 4, modelCount: 1, models: [] });
    expect(JSON.stringify(ok)).not.toContain('/Users/');
  });

  it('can be switched off (null) and then is simply absent', async () => {
    const snap = await collectVerseLocalModels({ fetchImpl: fetchStub('ok'), timeoutMs: 30, ollamaServerDefault: null, lastGoodTtlMs: 0, llamaServerBaseUrl: null });
    expect(snap.llamaServer).toBeUndefined();
  });
});
