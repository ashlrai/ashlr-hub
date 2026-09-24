/**
 * V3.10 fixer L1-core — the R3 leftovers in core/verse code:
 *   - revokeStandingAndDrain takes an optional `waitMs` (the Verse Revoke
 *     answers as instantly as Stop);
 *   - grok-cli spawns keep the no-diff detector ON with a finite, delta-aware
 *     threshold (was switched off with MAX_SAFE_INTEGER);
 *   - fleet-live / overnight count enrolled repositories WITHOUT the fleet's
 *     mirror clones and show mirrors apart;
 *   - Needs-you producers expose 'warming'; activity maps it to
 *     'unavailable' (never a false all-clear, never a false error), and
 *     fleet-live no longer throws before its first read.
 * HOME-isolated; no daemon, no seat, no socket (routes are called in-process).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));
// clamp.ts loads U3's armed-merge revocation lazily; faked so nothing real is touched.
vi.mock('../src/core/fleet/host-merge.js', () => ({
  revokeArmedHostMerges: () => ({ revoked: 0, failed: [] }),
}));

import { revokeStandingAndDrain } from '../src/core/authority/clamp.js';
import { acquireOutwardMutationFence, releaseOutwardMutationFence } from '../src/core/sandbox/mutation-fence.js';
import { killSwitchOn } from '../src/core/sandbox/policy.js';
import { resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import { grokNoDiffMinEvents } from '../src/core/run/sandboxed-engine.js';
import {
  buildFleetLiveSnapshot,
  needsYouItems as fleetNeedsYouItems,
  needsYouSourceState as fleetNeedsYouSourceState,
  resetFleetLiveApiForTest,
  setFleetLiveDepsForTest,
  type FleetLiveDeps,
} from '../src/core/verse/fleet-live-api.js';
import {
  handleOvernightApi,
  setOvernightApiDepsForTest,
  type OvernightActionResult,
} from '../src/core/verse/overnight-api.js';
import { readOvernightStatus } from '../src/core/daemon/overnight-status.js';
import { createActivityReader, type ActivityDeps, type NeedsYouSourceState } from '../src/core/verse/activity.js';
import { createSessionMetaStore } from '../src/core/verse/session-meta.js';
import type { NeedsYouItem } from '../src/core/verse/workbench-types.js';
import type { DaemonLivenessV1 } from '../src/core/daemon/liveness.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { withTempHome } from './helpers/authority-310b.js';

let restoreHome: () => void;

beforeEach(() => {
  restoreHome = withTempHome('l1-core-').restore;
  resetLedgerCachesForTest();
});

afterEach(() => {
  resetLedgerCachesForTest();
  restoreHome();
});

function liveness(alive = false): DaemonLivenessV1 {
  return {
    v: 1,
    checkedAt: new Date().toISOString(),
    state: alive ? 'alive' : 'stopped',
    alive,
    pid: alive ? 4242 : null,
    recorded: { running: alive, pid: null, startedAt: null, lastTickAt: null },
    lock: null,
    activity: null,
    staleRecord: false,
    reason: alive ? 'Running as pid 4242.' : 'The daemon is not running.',
  };
}

// ---------------------------------------------------------------------------

describe('revokeStandingAndDrain waitMs (Verse Revoke answers instantly)', () => {
  it('waitMs:0 does not wait for a held outward-mutation fence; KILL is armed regardless', async () => {
    const fence = acquireOutwardMutationFence(2_000);
    try {
      const started = Date.now();
      const revoked = await revokeStandingAndDrain({ actor: 'mason', reason: 'instant', drainMs: 0, waitMs: 0 });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(1_000);
      expect(revoked.mergesRevoked).toBe(0);
      expect(killSwitchOn()).toBe(true);
    } finally {
      releaseOutwardMutationFence(fence);
    }
  });

  it('control: without waitMs 0 the same revoke waits on the held fence', async () => {
    const fence = acquireOutwardMutationFence(2_000);
    try {
      const started = Date.now();
      await revokeStandingAndDrain({ actor: 'mason', reason: 'waits', drainMs: 0, waitMs: 1_200 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    } finally {
      releaseOutwardMutationFence(fence);
    }
  });
});

// ---------------------------------------------------------------------------

describe('grok-cli no-diff threshold', () => {
  it('is finite (detector on) and scaled for per-delta streaming', () => {
    const cfg = {} as AshlrConfig;
    expect(grokNoDiffMinEvents(cfg)).toBe(4_000);
    expect(Number.isFinite(grokNoDiffMinEvents(cfg))).toBe(true);
    expect(grokNoDiffMinEvents({ foundry: { noDiffMinEvents: 100 } } as unknown as AshlrConfig)).toBe(1_000);
  });

  it('falls back to the shared default on an invalid configured value and stays bounded', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '400']) {
      expect(grokNoDiffMinEvents({ foundry: { noDiffMinEvents: bad } } as unknown as AshlrConfig)).toBe(4_000);
    }
    expect(grokNoDiffMinEvents({ foundry: { noDiffMinEvents: Number.MAX_SAFE_INTEGER } } as unknown as AshlrConfig)).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------

const MIRROR = '/m/ashlrai__gone';
const CHECKOUT = '/src/ashlrai/locus';

function fleetDeps(over: Partial<FleetLiveDeps> = {}): FleetLiveDeps {
  return {
    now: () => Date.now(),
    policy: () => null,
    killSwitch: () => 'inactive',
    paused: () => false,
    liveness: () => liveness(false),
    tickState: () => null,
    journal: async () => [],
    ledger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
    holds: () => [],
    setHold: () => ({ ok: false, reason: 'test', before: null, after: null }),
    tasks: () => ({ ok: true, tasks: [] }),
    inFlight: () => [],
    enrolled: () => [CHECKOUT, MIRROR],
    isMirror: (path) => path.startsWith('/m/'),
    repoIdentity: (path) => (path === CHECKOUT ? 'ashlrai/locus' : path === MIRROR ? 'ashlrai/gone' : null),
    watches: () => [],
    greenPct: () => ({ finished: 0, green: 0, pct: null }),
    ...over,
  };
}

describe('fleet-live: mirrors are not repositories', () => {
  it('lists enrolled checkouts but not a mirror whose repo is neither enrolled nor granted', async () => {
    const built = await buildFleetLiveSnapshot(fleetDeps());
    expect(built.snapshot.repos.map((r) => r.repo)).toEqual(['ashlrai/locus']);
  });

  it('control: classified as a checkout, the same path would have added a row', async () => {
    const built = await buildFleetLiveSnapshot(fleetDeps({ isMirror: () => false }));
    expect(built.snapshot.repos.map((r) => r.repo)).toEqual(['ashlrai/gone', 'ashlrai/locus']);
  });
});

describe('fleet-live Needs-you: warming, not a throw', () => {
  afterEach(() => {
    setFleetLiveDepsForTest();
    resetFleetLiveApiForTest();
  });

  it('answers [] with state warming before the first read, then ok once a snapshot lands', async () => {
    setFleetLiveDepsForTest(fleetDeps());
    expect(fleetNeedsYouSourceState()).toBe('warming');
    expect(fleetNeedsYouItems()).toEqual([]);
    await vi.waitFor(() => expect(fleetNeedsYouSourceState()).toBe('ok'), { timeout: 2_000 });
    expect(fleetNeedsYouItems()).toEqual([]);
  });

  it('reports error (and throws) when the first build fails, never warming forever', async () => {
    setFleetLiveDepsForTest(fleetDeps({ now: () => { throw new Error('clock broke'); } }));
    expect(fleetNeedsYouItems()).toEqual([]);
    await vi.waitFor(() => expect(fleetNeedsYouSourceState()).toBe('error'), { timeout: 2_000 });
    expect(() => fleetNeedsYouItems()).toThrow(/could not be read/);
  });

  it('reports error when a source it needs cannot be read', async () => {
    setFleetLiveDepsForTest(fleetDeps({ holds: () => { throw new Error('holds corrupt'); } }));
    fleetNeedsYouItems();
    await vi.waitFor(() => expect(fleetNeedsYouSourceState()).toBe('error'), { timeout: 2_000 });
    expect(() => fleetNeedsYouItems()).toThrow(/incomplete/);
  });
});

// ---------------------------------------------------------------------------

describe('activity maps producer warming to unavailable', () => {
  function deps(
    producers: ActivityDeps['producers'],
    producerStates?: ActivityDeps['producerStates'],
  ): ActivityDeps {
    return {
      engine: () => null,
      meta: createSessionMetaStore({ now: () => Date.now() }),
      producers,
      ...(producerStates ? { producerStates } : {}),
      approvals: () => ({ state: 'ok', items: [], total: 0 }),
      health: () => null,
      autonomy: () => null,
      latestMemoAt: null,
    };
  }
  const warming = (): NeedsYouSourceState => 'warming';
  const ok = (): NeedsYouSourceState => 'ok';
  const failed = (): NeedsYouSourceState => 'error';
  const empty = (): NeedsYouItem[] => [];
  const loading = (): NeedsYouItem[] => {
    throw new Error('still loading');
  };

  it('warming [] is unavailable, warming throw is unavailable, ok [] is ok', () => {
    const built = createActivityReader(deps(
      () => ({ authority: loading, fleet: empty, leader: empty }),
      () => ({ authority: warming, fleet: warming, leader: ok }),
    ), 'aaaaaaaa').build(null);
    expect(built.response.sources).toMatchObject({ authority: 'unavailable', fleet: 'unavailable', leader: 'ok' });
  });

  it("a producer's own 'error' wins over an empty answer; a throw without state stays error", () => {
    const built = createActivityReader(deps(
      () => ({ authority: loading, fleet: empty, leader: empty }),
      () => ({ fleet: failed, leader: () => 'bogus' as NeedsYouSourceState }),
    ), 'bbbbbbbb').build(null);
    expect(built.response.sources).toMatchObject({ authority: 'error', fleet: 'error', leader: 'error' });
  });

  it('a state probe that throws is an error, not an all-clear', () => {
    const built = createActivityReader(deps(
      () => ({ authority: null, fleet: empty, leader: null }),
      () => ({ fleet: () => { throw new Error('probe broke'); } }),
    ), 'cccccccc').build(null);
    expect(built.response.sources.fleet).toBe('error');
  });

  it('without producerStates the old contract holds (older wiring / fakes)', () => {
    const built = createActivityReader(deps(() => ({ authority: loading, fleet: empty, leader: null })), 'dddddddd').build(null);
    expect(built.response.sources).toMatchObject({ authority: 'error', fleet: 'ok', leader: 'unavailable' });
  });
});

// ---------------------------------------------------------------------------

describe('overnight arm: repositories without mirrors', () => {
  const TOKEN = 'l1-token';
  let ctx: VerseApiContext;
  let checkouts: number | null;
  let mirrors: number | null;

  beforeEach(() => {
    ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
    checkouts = 2;
    mirrors = 3;
    setOvernightApiDepsForTest({
      killSwitch: () => 'inactive',
      enrolledCount: () => checkouts,
      mirrorCount: () => mirrors,
      liveness: () => liveness(false),
      autoMerge: () => false,
      halts: () => [],
    });
  });

  afterEach(() => {
    setOvernightApiDepsForTest();
    rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
  });

  /** In-process POST (no socket): the handler reads a stream and answers via writeHead/end. */
  async function arm(): Promise<{ status: number; body: OvernightActionResult }> {
    const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(req, {
      method: 'POST',
      url: '/api/verse/overnight',
      headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN },
    });
    req.end(JSON.stringify({ action: 'arm', stopRule: { kind: 'until-paused' } }));
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
    expect(await handleOvernightApi(ctx, req, res, '/api/verse/overnight', 'POST')).toBe(true);
    return { status, body: JSON.parse(payload || 'null') as OvernightActionResult };
  }

  it('records the checkouts as the repositories and names the mirrors apart', async () => {
    const res = await arm();
    expect(res.status).toBe(200);
    expect(readOvernightStatus().repos).toBe(2);
    expect(res.body.note).toMatch(/2 enrolled repositories, plus 3 fleet mirrors/);
  });

  it('mirrors only: the run has work, and each mirror is one repository', async () => {
    checkouts = 0;
    const res = await arm();
    expect(res.status).toBe(200);
    expect(readOvernightStatus().repos).toBe(3);
    expect(res.body.note).toMatch(/3 fleet mirrors \(no checkouts are enrolled\)/);
  });

  it('nothing enrolled at all is still refused', async () => {
    checkouts = 0;
    mirrors = 0;
    const res = await arm();
    expect(res.status).toBe(409);
    expect(res.body.note).toMatch(/no repositories are enrolled/);
  });

  it('an unreadable registry is refused as unknown', async () => {
    checkouts = null;
    const res = await arm();
    expect(res.status).toBe(409);
    expect(res.body.note).toMatch(/could not be read/);
  });
});
