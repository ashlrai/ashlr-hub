/**
 * V3.10 Track B (U5): `/api/verse/fleet/live` and the fleet's R1
 * `needsYouItems()`. Every source is injected (ledger, holds, journal, tick
 * state, tasks, liveness, in-flight dispatches) and the handler is driven
 * through a real http server. Covers the dark / running / stopped states,
 * run phases from the ledger, the gate funnel, the repo table, Needs-you
 * items (validated with C0's isNeedsYouItem) and pause / resume.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  buildFleetLiveSnapshot,
  createDispatchTail,
  gateFunnelFromLedger,
  handleFleetLiveApi,
  needsYouItems,
  needsYouSourceState,
  proposalProgressFromLedger,
  resetFleetLiveApiForTest,
  setFleetLiveDepsForTest,
  type FleetLiveActionResult,
  type FleetLiveDeps,
} from '../src/core/verse/fleet-live-api.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';
import type { DaemonLivenessV1 } from '../src/core/daemon/liveness.js';
import type { EffectivePolicy, LedgerEntry, LedgerReadResult } from '../src/core/authority/types.js';
import type { FleetLiveSnapshotV1, LandingRecord, RepoHold, RepoHoldChange, SetRepoHoldRequest } from '../src/core/fleet/fleet-types.js';
import type { FleetJournalRecord, FleetTickStateV1 } from '../src/core/fleet/fleet-runtime-journal.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { PostMergeWatchView } from '../src/core/fleet/post-merge-watch.js';

const TOKEN = 'test-mutation-token';
const REPO = 'ashlrai/binshield';
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

let server: http.Server;
let base: string;
let ctx: VerseApiContext;
let rows: LedgerEntry[];
let holds: RepoHold[];
let holdsReadable: boolean;
let ledgerReadable: boolean;
let kill: 'active' | 'inactive' | 'unknown';
let policy: EffectivePolicy | null;
let alive: boolean;
let setHoldCalls: SetRepoHoldRequest[];
let journal: FleetJournalRecord[];
let tick: FleetTickStateV1 | null;
let watchViews: PostMergeWatchView[] = [];
let seq = 0;

function row<K extends LedgerEntry['kind']>(kind: K, data: Extract<LedgerEntry, { kind: K }>['data'], at: string): LedgerEntry {
  return { v: 1, seq: seq++, at, actor: 'daemon', grantId: 'g', repo: REPO, prevHash: '0'.repeat(64), hash: '1'.repeat(64), kind, data } as LedgerEntry;
}

function landing(id: string, kind: 'merge' | 'revert', over: Partial<LandingRecord> = {}): LandingRecord {
  return {
    v: 1, id, kind, repo: REPO, baseBranch: 'main', prNumber: 12, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40),
    proposalId: kind === 'merge' ? 'p-1' : null, revertsLandingId: null, grantId: 'g', rolloutStageId: '2a',
    gatesDigest: 'c'.repeat(64), ledgerHead: 'e'.repeat(64), enforcement: 'server', risk: 'low', files: 1, linesAdded: 3, linesDeleted: 1,
    producer: null, judgeId: null, proposedAt: iso(40 * MIN), landedAt: iso(20 * MIN), watchUntil: new Date(NOW + 100 * MIN).toISOString(), ...over,
  };
}

function gate(proposalId: string, g: 'G0' | 'G1' | 'G3' | 'G6' | 'G7', verdict: 'pass' | 'refuse' | 'owner-lane' | 'wait', at: string, code = 'ok'): LedgerEntry {
  return row('gate:result', { v: 1, gate: g, proposalId, repo: REPO, headSha: 'a'.repeat(40), verdict, code, reason: `${g} ${verdict}`, at, digest: 'd'.repeat(64) }, at);
}

function live(): DaemonLivenessV1 {
  return {
    v: 1, checkedAt: new Date(NOW).toISOString(), state: alive ? 'alive' : 'stopped', alive, pid: alive ? 4242 : null,
    recorded: { running: alive, pid: null, startedAt: null, lastTickAt: '2026-09-01T19:10:00.000Z' },
    lock: null, activity: null, staleRecord: false, reason: alive ? 'Running as pid 4242.' : 'The daemon is not running.',
  };
}

function policyFixture(): EffectivePolicy {
  return {
    v: 1, grantId: 'g', grantSeq: 1, keyId: 'k', issuedAt: iso(86_400_000), expiresAt: new Date(NOW + 86_400_000).toISOString(),
    switch: 'autonomous',
    rollout: { stageId: '2a', stageIndex: 1, stageCount: 5, enteredAt: iso(3_600_000) },
    repos: [{ nameWithOwner: REPO, stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null }],
    merge: { maxFiles: 4, maxLines: 150, selfRepo: 'propose-only', localAuthored: { maxRisk: 'low', maxFiles: 4, maxLines: 150 } },
    spend: { maxMode: 'balanced', meteredUsdPerDay: 0, seats: {} },
    engines: ['local', 'grok-cli'],
    leader: { classes: ['A'], vetoMinutes: 30 },
    conductorGoals: false,
    computedAt: new Date(NOW).toISOString(),
  };
}

function deps(): Partial<FleetLiveDeps> {
  return {
    now: () => NOW,
    policy: () => policy,
    killSwitch: () => kill,
    paused: () => false,
    liveness: live,
    tickState: () => tick,
    journal: async () => journal,
    ledger: async (): Promise<LedgerReadResult> => {
      if (!ledgerReadable) throw new Error('ledger unreadable');
      return { entries: rows, head: null, chain: rows.length > 0 ? 'ok' : 'empty', brokenAtSeq: null, reason: null };
    },
    holds: () => {
      if (!holdsReadable) throw new Error('holds corrupt');
      return holds;
    },
    setHold: (req): RepoHoldChange => {
      setHoldCalls.push(req);
      const after: RepoHold | null = req.hold
        ? { v: 1, repo: req.repo, kind: req.kind, reason: req.hold.reason, since: new Date(NOW).toISOString(), until: req.hold.until, setBy: req.actor, landingId: null }
        : null;
      holds = [...holds.filter((h) => !(h.repo === req.repo && h.kind === req.kind)), ...(after ? [after] : [])];
      return { ok: true, reason: null, before: null, after };
    },
    tasks: () => ({ ok: true, tasks: [] }),
    inFlight: () => [{ runId: 'run-live', itemId: 'item-9', repoPath: '/tmp/mirrors/ashlrai__binshield', backend: 'llama-server', model: 'qwen', startedAt: iso(2 * MIN) }],
    enrolled: () => ['/tmp/mirrors/ashlrai__binshield'],
    repoIdentity: (path) => (path.endsWith('ashlrai__binshield') ? REPO : null),
    // U4's watch store: empty unless a test sets it (the ledger is then the source).
    watches: () => watchViews,
    greenPct: (opts) => {
      const finished = watchViews.filter((v) => v.kind === 'merge' && v.verdict !== null && v.checkedAt !== null
        && Date.parse(v.checkedAt) >= opts.sinceMs && (opts.repo === undefined || v.repo === opts.repo));
      const green = finished.filter((v) => v.verdict === 'green').length;
      return { finished: finished.length, green, pct: finished.length === 0 ? null : Math.round((green / finished.length) * 1000) / 10 };
    },
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleFleetLiveApi(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  rows = [];
  holds = [];
  holdsReadable = true;
  ledgerReadable = true;
  kill = 'inactive';
  policy = null;
  alive = false;
  setHoldCalls = [];
  journal = [];
  tick = null;
  watchViews = [];
  setFleetLiveDepsForTest(deps());
});

afterEach(() => {
  setFleetLiveDepsForTest();
  resetFleetLiveApiForTest();
});

async function get(): Promise<{ status: number; body: FleetLiveSnapshotV1 }> {
  const res = await fetch(`${base}/api/verse/fleet/live`);
  return { status: res.status, body: (await res.json()) as FleetLiveSnapshotV1 };
}

async function post<T>(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/api/verse/fleet/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe('GET /api/verse/fleet/live — states', () => {
  it('is DARK with its own sentence when no standing grant is in force', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('dark');
    expect(res.body.stateReason).toMatch(/No standing grant is in force\. Fleet dark since Sep 1/);
    expect(res.body.lanes.every((l) => l.slots === 0 && l.capReason !== null)).toBe(true);
    // The ledger was readable and empty: zero is a measurement here, not a default.
    expect(res.body.summary).toMatchObject({ mergedToday: 0, merged7d: 0, revertsToday: 0, postMergeGreenPct7d: null, cycleTimeP50Ms7d: null });
  });

  it('is STOPPED while the kill switch is engaged (or unreadable)', async () => {
    kill = 'active';
    expect((await get()).body.state).toBe('stopped');
    resetFleetLiveApiForTest();
    kill = 'unknown';
    expect((await get()).body.stateReason).toMatch(/treated as stopped/);
  });

  it('reports unknown sources as null, never zero', async () => {
    ledgerReadable = false;
    const res = await get();
    expect(res.body.summary.mergedToday).toBeNull();
    expect(res.body.summary.merged7d).toBeNull();
    expect(res.body.funnel).toBeNull();
    expect(res.body.stateReason).toMatch(/the authority ledger could not be read/);
    expect(res.body.repos[0]!.openFleetPrs).toBeNull();
  });

  it('is RUNNING with lanes, phases, funnel and the repo table under a standing grant', async () => {
    policy = policyFixture();
    alive = true;
    tick = {
      v: 1, at: iso(MIN), capabilityKind: 'resident-standing', dryRun: false,
      standing: { grantId: 'g', stageId: '2a', switch: 'autonomous' },
      lanes: [
        { lane: 'local', slots: 2, busy: 0, capReason: 'You are active (a verse chat turn is running), so the local lane is held to 2.' },
        { lane: 'grok-cli', slots: 2, busy: 0, capReason: null },
        { lane: 'claude-cli', slots: 0, busy: 0, capReason: 'judge only' },
        { lane: 'codex', slots: 0, busy: 0, capReason: 'off' },
      ],
      presence: { present: true, reason: 'A Verse chat turn is running.', evidenceAt: iso(MIN) },
      holdProduction: null, pausedRepos: [], waitingVerify: 1, openPrsByRepo: {}, ledgerHead: { seq: 4, hash: 'h'.repeat(64) },
      held: [{ itemId: 'big-1', repo: REPO, title: 'Rewrite everything', hold: { kind: 'split', reason: 'too big', nextEligibleAt: null }, seatDecision: null, at: iso(MIN) }],
      watch: { available: true, reason: null },
    };
    journal = [
      {
        v: 1, type: 'dispatch', at: iso(30 * MIN), itemId: 'item-1', taskId: null, runId: 'run-1', repo: REPO, title: 'Fix the parser',
        source: 'todo', backend: 'grok-cli', model: 'grok-4.7', lane: 'grok-cli', seatId: 'grok', dispatched: true, skipReason: null,
        proposalId: 'p-1', spentUsd: 0, seatDecision: { seatId: 'grok', candidates: ['grok'], exclusions: [], why: 'Routed to Grok.', mode: 'balanced' }, hold: null,
      },
    ];
    rows = [
      gate('p-1', 'G0', 'pass', iso(29 * MIN)),
      gate('p-1', 'G3', 'pass', iso(28 * MIN)),
      gate('p-1', 'G6', 'pass', iso(27 * MIN)),
      gate('p-2', 'G0', 'pass', iso(26 * MIN)),
      gate('p-2', 'G3', 'refuse', iso(25 * MIN), 'verify-failed'),
      row('pr:opened', { v: 1, repo: REPO, number: 12, proposalId: 'p-1', branch: 'ashlr/fleet/p-1', headSha: 'a'.repeat(40), kind: 'change', ownerLane: false, at: iso(24 * MIN) }, iso(24 * MIN)),
      row('merge:landed', landing('L1', 'merge'), iso(20 * MIN)),
    ];
    const res = await get();
    const body = res.body;
    expect(body.state).toBe('running');
    expect(body.lanes.find((l) => l.lane === 'local')).toMatchObject({ slots: 2, busy: 1 });
    const producing = body.runs.find((r) => r.id === 'run-live');
    expect(producing).toMatchObject({ phase: 'producing', lane: 'local', repo: REPO, endedAt: null });
    const watched = body.runs.find((r) => r.id === 'run-1');
    expect(watched).toMatchObject({ phase: 'watching', prNumber: 12, outcome: null, seatDecision: { seatId: 'grok' } });
    expect(body.runs.find((r) => r.id === 'held:big-1')).toMatchObject({ phase: 'parked', hold: { kind: 'split' } });
    expect(body.summary).toMatchObject({ building: 1, mergedToday: 1, merged7d: 1, waitingVerify: 1 });
    expect(body.summary.cycleTimeP50Ms7d).toBe(20 * MIN);
    const g3 = body.funnel!.stages.find((s) => s.gate === 'G3')!;
    expect(g3).toMatchObject({ entered: 2, passed: 1 });
    expect(g3.refusals).toEqual([{ code: 'verify-failed', reason: 'G3 refuse', count: 1 }]);
    expect(body.repos).toEqual([expect.objectContaining({
      repo: REPO, stage: 'merge', enforcement: 'server', maxMergesPerDay: 6, mergesToday: 1, openFleetPrs: 0, holds: [],
    })]);
    expect(body.repos[0]!.greenTrend).toHaveLength(14);
  });
});

describe('ledger projections', () => {
  it('walks a proposal through verify → judge → land → watch → merged, and a revert', () => {
    const merged = proposalProgressFromLedger([
      gate('p-1', 'G3', 'pass', iso(50 * MIN)),
      row('merge:landed', landing('L1', 'merge'), iso(40 * MIN)),
      row('post-merge:result', { v: 1, landingId: 'L1', repo: REPO, mergeSha: 'b'.repeat(40), ci: 'green', suite: 'pass', verdict: 'green', detail: 'green', checkedAt: iso(10 * MIN) }, iso(10 * MIN)),
    ]);
    expect(merged.get('p-1')).toMatchObject({ outcome: 'merged', landingId: 'L1' });
    const reverted = proposalProgressFromLedger([
      row('merge:landed', landing('L1', 'merge'), iso(40 * MIN)),
      row('post-merge:result', { v: 1, landingId: 'L1', repo: REPO, mergeSha: 'b'.repeat(40), ci: 'red', suite: 'fail', verdict: 'red', detail: 'CI red', checkedAt: iso(20 * MIN) }, iso(20 * MIN)),
      row('revert:landed', landing('R1', 'revert', { revertsLandingId: 'L1', prNumber: 13, landedAt: iso(10 * MIN) }), iso(10 * MIN)),
    ]);
    expect(reverted.get('p-1')).toMatchObject({ phase: 'reverting', outcome: 'reverted' });
    const owner = proposalProgressFromLedger([gate('p-9', 'G1', 'owner-lane', iso(5 * MIN), 'protected-path')]);
    expect(owner.get('p-9')).toMatchObject({ phase: 'landing', outcome: 'owner-lane' });
  });

  it('counts each gate\'s LAST decision per proposal in the funnel', () => {
    const funnel = gateFunnelFromLedger([
      gate('p-1', 'G6', 'wait', iso(30 * MIN), 'no-judge-seat'),
      gate('p-1', 'G6', 'pass', iso(20 * MIN)),
    ], NOW - 3_600_000, NOW);
    expect(funnel.stages.find((s) => s.gate === 'G6')).toMatchObject({ entered: 1, passed: 1, refusals: [] });
  });
});

describe('needsYouItems (R1)', () => {
  it('answers [] with source state WARMING until the first snapshot (never an all-clear, never an error)', async () => {
    // L1 leftover 2: a cold start used to THROW, which activity reported as the
    // fleet source erroring on every start. Now it is [] + 'warming', which
    // activity maps to 'unavailable' — still not an all-clear.
    expect(needsYouSourceState()).toBe('warming');
    expect(needsYouItems()).toEqual([]);
    expect(needsYouSourceState()).toBe('warming');
    // needsYouItems scheduled the first read off the caller's stack; once it lands the source vouches.
    await new Promise((resolve) => setImmediate(resolve));
    await get();
    expect(needsYouSourceState()).toBe('ok');
  });

  it('says ERROR (and throws) when the first read failed with nothing cached', async () => {
    setFleetLiveDepsForTest({ ...deps(), now: () => { throw new Error('clock gone'); } });
    expect(needsYouItems()).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(needsYouSourceState()).toBe('error');
    expect(() => needsYouItems()).toThrow(/could not be read/);
  });

  it('serves owner-hold, quarantine, recent reverts and open owner-lane PRs from cache', async () => {
    holds = [
      { v: 1, repo: REPO, kind: 'owner-hold', reason: 'A revert conflicted.', since: iso(60 * MIN), until: null, setBy: 'post-merge-watch', landingId: 'L1' },
      { v: 1, repo: 'ashlrai/ashlrcode', kind: 'quarantine', reason: 'Post-merge suite red.', since: iso(30 * MIN), until: new Date(NOW + 5 * 3_600_000).toISOString(), setBy: 'post-merge-watch', landingId: 'L2' },
      { v: 1, repo: 'ashlrai/locus', kind: 'cooldown', reason: '3 rejects', since: iso(10 * MIN), until: new Date(NOW + 3_600_000).toISOString(), setBy: 'backpressure', landingId: null },
    ];
    rows = [
      row('post-merge:result', { v: 1, landingId: 'L1', repo: REPO, mergeSha: 'b'.repeat(40), ci: 'red', suite: 'fail', verdict: 'red', detail: 'CI `test` failed on bbbbbbb', checkedAt: iso(50 * MIN) }, iso(50 * MIN)),
      row('revert:landed', landing('R1', 'revert', { revertsLandingId: 'L1', prNumber: 13, landedAt: iso(45 * MIN) }), iso(45 * MIN)),
      row('revert:landed', landing('R0', 'revert', { revertsLandingId: 'L0', prNumber: 7, landedAt: iso(30 * 3_600_000) }), iso(30 * 3_600_000)),
      row('pr:opened', { v: 1, repo: REPO, number: 20, proposalId: 'p-20', branch: 'ashlr/fleet/p-20', headSha: 'a'.repeat(40), kind: 'change', ownerLane: true, at: iso(15 * MIN) }, iso(15 * MIN)),
      row('pr:opened', { v: 1, repo: REPO, number: 21, proposalId: 'p-21', branch: 'ashlr/fleet/p-21', headSha: 'a'.repeat(40), kind: 'change', ownerLane: true, at: iso(14 * MIN) }, iso(14 * MIN)),
      row('pr:closed', { repo: REPO, number: 21, reason: 'superseded', actor: 'mason', at: iso(13 * MIN) }, iso(13 * MIN)),
    ];
    await get();
    const items = needsYouItems();
    expect(items.map((i) => i.id)).toEqual([
      `fleet:owner-hold:${REPO}`,
      'fleet:quarantine:ashlrai/ashlrcode',
      expect.stringMatching(/^fleet:revert:R1$/),
      `fleet:owner-lane-pr:${REPO}#20`,
    ]);
    for (const item of items) expect(isNeedsYouItem(item)).toBe(true);
    expect(items[0]!.actions[0]!.request).toEqual({ method: 'POST', path: '/api/verse/fleet/live', body: { action: 'resume-repo', repo: REPO, kind: 'owner-hold' } });
    expect(items[2]!.detail).toMatch(/CI `test` failed/);
    expect(items[3]!.target).toEqual({ kind: 'url', url: `https://github.com/${REPO}/pull/20` });
  });

  it('refuses to vouch for an all-clear when holds cannot be read', async () => {
    holdsReadable = false;
    await get();
    expect(() => needsYouItems()).toThrow(/repo holds could not be read/);
  });
});

describe('POST pause / resume (as mason)', () => {
  it('pauses a repo with an owner-hold', async () => {
    const res = await post<FleetLiveActionResult>({ action: 'pause-repo', repo: REPO, reason: 'Investigating a flaky suite' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(setHoldCalls).toEqual([{ repo: REPO, kind: 'owner-hold', hold: { reason: 'Paused by you: Investigating a flaky suite', until: null }, actor: 'mason' }]);
    expect(res.body.snapshot?.repos[0]?.holds.map((h) => h.kind)).toEqual(['owner-hold']);
  });

  it('resumes every active hold, or just the named kind', async () => {
    holds = [
      { v: 1, repo: REPO, kind: 'owner-hold', reason: 'x', since: iso(MIN), until: null, setBy: 'mason', landingId: null },
      { v: 1, repo: REPO, kind: 'quarantine', reason: 'y', since: iso(MIN), until: new Date(NOW + 3_600_000).toISOString(), setBy: 'post-merge-watch', landingId: null },
    ];
    const one = await post<FleetLiveActionResult>({ action: 'resume-repo', repo: REPO, kind: 'quarantine' });
    expect(one.body.ok).toBe(true);
    expect(setHoldCalls.map((c) => [c.kind, c.hold, c.actor])).toEqual([['quarantine', null, 'mason']]);
    setHoldCalls = [];
    const all = await post<FleetLiveActionResult>({ action: 'resume-repo', repo: REPO });
    expect(all.body.note).toMatch(/resumed \(owner-hold cleared\)/);
    expect(setHoldCalls.map((c) => c.kind)).toEqual(['owner-hold']);
  });

  it('validates the body and sits behind the gate', async () => {
    expect((await post({ action: 'pause-repo', repo: 'nope', reason: 'r' })).status).toBe(400);
    expect((await post({ action: 'pause-repo', repo: REPO })).status).toBe(400);
    expect((await post({ action: 'resume-repo', repo: REPO, kind: 'forever' })).status).toBe(400);
    expect((await post({ action: 'delete-repo', repo: REPO })).status).toBe(400);
    expect((await post({ action: 'pause-repo', repo: REPO, reason: 'r' }, { 'x-ashlr-token': 'bad' })).status).toBe(401);
    ctx = { ...ctx, allowDispatch: false };
    expect((await post({ action: 'pause-repo', repo: REPO, reason: 'r' })).status).toBe(404);
    expect(setHoldCalls).toEqual([]);
  });
});

describe('mount chain', () => {
  it('owns exactly /api/verse/fleet/live — never Track A\'s fleet history', async () => {
    const req = {} as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    for (const path of ['/api/verse/fleet/history', '/api/verse/fleet/live/x', '/api/verse/overnight', '/api/verse/budget']) {
      await expect(handleFleetLiveApi(ctx, req, res, path, 'GET')).resolves.toBe(false);
    }
  });

  it('builds without a network, a seat or a daemon', async () => {
    const built = await buildFleetLiveSnapshot({ ...(deps() as FleetLiveDeps) });
    expect(built.snapshot.v).toBe(1);
  });
});

describe('U4 post-merge watch store (INT1)', () => {
  function view(over: Partial<PostMergeWatchView>): PostMergeWatchView {
    return {
      landingId: 'L1', repo: REPO, prNumber: 12, kind: 'merge', mergeSha: 'b'.repeat(40), phase: 'watching',
      landedAt: iso(20 * MIN), watchUntil: new Date(NOW + 100 * MIN).toISOString(), ci: null, suite: 'not-run',
      outcome: null, verdict: null, detail: null, checkedAt: null, ...over,
    };
  }

  it('moves a landed proposal to REVERTING as soon as the watch sees red, before any verdict is ledgered', async () => {
    rows = [gate('p-1', 'G7', 'pass', iso(25 * MIN)), row('merge:landed', landing('L1', 'merge'), iso(20 * MIN))];
    journal = [{
      v: 1, type: 'dispatch', at: iso(60 * MIN), itemId: 'item-1', taskId: null, runId: 'r-1', repo: REPO, title: 'Fix the parser',
      source: 'todo', backend: 'builtin', model: null, lane: 'local', seatId: 'local', dispatched: true, skipReason: null,
      proposalId: 'p-1', spentUsd: 0, seatDecision: null, hold: null,
    }];
    watchViews = [];
    let built = await buildFleetLiveSnapshot({ ...(deps() as FleetLiveDeps) });
    expect(built.snapshot.runs.find((r) => r.prNumber === 12)?.phase).toBe('watching');
    watchViews = [view({ phase: 'reverting', ci: 'red', checkedAt: iso(5 * MIN) })];
    built = await buildFleetLiveSnapshot({ ...(deps() as FleetLiveDeps) });
    expect(built.snapshot.stateReason ?? '').not.toMatch(/post-merge watches/);
    expect(built.snapshot.runs.find((r) => r.prNumber === 12)?.phase).toBe('reverting');
  });

  it('takes post-merge green % from the watch store, and falls back to the ledger when it has no finished watch', async () => {
    rows = [
      row('merge:landed', landing('L1', 'merge'), iso(20 * MIN)),
      row('post-merge:result', { v: 1, landingId: 'L1', repo: REPO, mergeSha: 'b'.repeat(40), ci: 'green', suite: 'pass', verdict: 'green', detail: 'ok', checkedAt: iso(5 * MIN) } as never, iso(5 * MIN)),
    ];
    watchViews = [
      view({ landingId: 'L1', phase: 'done', verdict: 'green', checkedAt: iso(5 * MIN) }),
      view({ landingId: 'L2', phase: 'done', verdict: 'red', checkedAt: iso(4 * MIN) }),
    ];
    let built = await buildFleetLiveSnapshot({ ...(deps() as FleetLiveDeps) });
    expect(built.snapshot.summary.postMergeGreenPct7d).toBe(50);
    expect(built.snapshot.repos.find((r) => r.repo === REPO)?.greenPct7d).toBe(50);

    watchViews = [];
    built = await buildFleetLiveSnapshot({ ...(deps() as FleetLiveDeps) });
    expect(built.snapshot.summary.postMergeGreenPct7d).toBe(100);
  });

  it('says the watches are unknown (never "nothing watched") when the store is corrupt', async () => {
    const built = await buildFleetLiveSnapshot({
      ...(deps() as FleetLiveDeps),
      watches: () => { throw new Error('post-merge watches unknown: corrupt'); },
    });
    expect(built.snapshot.stateReason).toMatch(/Unknown: .*post-merge watches could not be read/);
  });
});

describe('mirrors apart from repos (R3f, L1 leftover 3)', () => {
  it('keeps enrolled fleet mirrors OUT of the repo table and exposes them as snapshot.mirrors', async () => {
    const built = await buildFleetLiveSnapshot({
      ...(deps() as FleetLiveDeps),
      enrolled: () => ['/work/binshield', '/m/ashlrai__binshield', '/m/ashlrai__locus', '/m/odd'],
      isMirror: (path) => path.startsWith('/m/'),
      repoIdentity: (path) => (path.endsWith('binshield') ? REPO : path.endsWith('locus') ? 'ashlrai/locus' : null),
    });
    expect(built.snapshot.mirrors).toEqual({ count: 3, repos: ['ashlrai/binshield', 'ashlrai/locus', 'odd'] });
    // ashlrai/locus is known ONLY through a mirror: it gets no repo row of its own.
    expect(built.snapshot.repos.map((r) => r.repo)).toEqual([REPO]);
  });

  it('says mirrors are unknown (null), not zero, when the enrollment registry cannot be read', async () => {
    const built = await buildFleetLiveSnapshot({
      ...(deps() as FleetLiveDeps),
      enrolled: () => { throw new Error('registry corrupt'); },
    });
    expect(built.snapshot.mirrors).toBeNull();
    const none = await buildFleetLiveSnapshot({ ...(deps() as FleetLiveDeps), enrolled: () => [] });
    expect(none.snapshot.mirrors).toEqual({ count: 0, repos: [] });
  });
});

describe('in-flight dispatches: incremental async ledger tail (review c11)', () => {
  let dir: string;
  const DAY = '2026-09-20';
  const at = (h: number, m = 0) => `${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  const T0 = Date.parse(at(0));

  function dispatchRow(action: 'daemon:dispatch-start' | 'daemon:dispatch' | 'daemon:dispatch-skip', runId: string, ts: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: 1, ts, actor: 'daemon', kind: 'dispatch', outcome: action === 'daemon:dispatch-start' ? 'started' : 'succeeded',
      action, summary: 'dispatch', runId, itemId: `item-${runId}`, repo: '/r/binshield', backend: 'codex', model: 'gpt-5.5', ...extra,
    });
  }
  function tickRow(ts: string, i: number): string {
    return JSON.stringify({ schemaVersion: 1, ts, actor: 'daemon', kind: 'tick', outcome: 'succeeded', action: 'daemon:tick', summary: `tick ${i} ${'x'.repeat(400)}` });
  }
  function file(name: string): string {
    return nodePath.join(dir, name);
  }
  function append(name: string, lines: string[]): void {
    fs.appendFileSync(file(name), lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
    fs.chmodSync(file(name), 0o600);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dispatch-tail-'));
    fs.chmodSync(dir, 0o700);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers started-and-unfinished runs, newest first, and [] with no ledger at all', async () => {
    const missing = createDispatchTail({ dir: () => nodePath.join(dir, 'nope') });
    expect(await missing.read(T0)).toEqual([]);
    append(`${DAY}.jsonl`, [
      dispatchRow('daemon:dispatch-start', 'a', at(1)),
      tickRow(at(1, 5), 1),
      dispatchRow('daemon:dispatch-start', 'b', at(2)),
      dispatchRow('daemon:dispatch', 'a', at(2, 30)),
      dispatchRow('daemon:dispatch-start', 'c', at(3)),
      dispatchRow('daemon:dispatch-skip', 'c', at(3, 1)),
      dispatchRow('daemon:dispatch-start', 'd', at(4), { model: 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    ]);
    const tail = createDispatchTail({ dir: () => dir });
    const out = await tail.read(T0);
    expect(out?.map((f) => f.runId)).toEqual(['d', 'b']);
    expect(out?.[1]).toEqual({ runId: 'b', itemId: 'item-b', repoPath: '/r/binshield', backend: 'codex', model: 'gpt-5.5', startedAt: at(2) });
    // Strings leaving the ledger are scrubbed like the ledger's own reader does.
    expect(out?.[0]?.model).not.toContain('AAAAAAAAAAAAAAAAAAAA');
    // The window start filters starts, not terminal rows.
    expect((await tail.read(Date.parse(at(3))))?.map((f) => f.runId)).toEqual(['d']);
  });

  it('parses ONLY the bytes appended since the last read, and waits for a half-written row', async () => {
    const name = `${DAY}.jsonl`;
    append(name, [dispatchRow('daemon:dispatch-start', 'a', at(1))]);
    const tail = createDispatchTail({ dir: () => dir });
    expect((await tail.read(T0))?.map((f) => f.runId)).toEqual(['a']);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const partial = dispatchRow('daemon:dispatch-start', 'b', at(2));
      fs.appendFileSync(file(name), partial.slice(0, 40));
      expect((await tail.read(T0))?.map((f) => f.runId)).toEqual(['a']);
      expect(parse).not.toHaveBeenCalled();
      fs.appendFileSync(file(name), `${partial.slice(40)}\n${dispatchRow('daemon:dispatch', 'a', at(2, 5))}\n`);
      expect((await tail.read(T0))?.map((f) => f.runId)).toEqual(['b']);
      // Exactly the two new rows were parsed — never the first one again.
      expect(parse).toHaveBeenCalledTimes(2);
    } finally {
      parse.mockRestore();
    }
  });

  it('starts over when the partition is replaced or truncated, and joins a terminal row across UTC midnight', async () => {
    const name = `${DAY}.jsonl`;
    append(name, [dispatchRow('daemon:dispatch-start', 'a', at(23, 50)), dispatchRow('daemon:dispatch-start', 'b', at(23, 55))]);
    const tail = createDispatchTail({ dir: () => dir });
    expect((await tail.read(T0))?.map((f) => f.runId)).toEqual(['b', 'a']);
    fs.rmSync(file(name));
    append(name, [dispatchRow('daemon:dispatch-start', 'a', at(23, 50))]);
    expect((await tail.read(T0))?.map((f) => f.runId)).toEqual(['a']);
    append('2026-09-21.jsonl', [dispatchRow('daemon:dispatch', 'a', '2026-09-21T00:03:00.000Z')]);
    expect(await tail.read(T0)).toEqual([]);
  });

  it('is UNKNOWN (null), never a smaller count, when a dispatch row or the store cannot be trusted', async () => {
    const name = `${DAY}.jsonl`;
    append(name, [dispatchRow('daemon:dispatch-start', 'a', at(1))]);
    const tail = createDispatchTail({ dir: () => dir });
    expect(await tail.read(T0)).toHaveLength(1);
    // A broken row of another kind says nothing about dispatches.
    append(name, ['{"kind":"tick", broken']);
    expect(await tail.read(T0)).toHaveLength(1);
    // A broken dispatch row does.
    append(name, ['{"action":"daemon:dispatch-start", broken']);
    expect(await tail.read(T0)).toBeNull();
    // A row whose day does not match its partition is refused like the ledger refuses it.
    fs.rmSync(file(name));
    append(name, [dispatchRow('daemon:dispatch-start', 'a', '2026-09-19T10:00:00.000Z')]);
    expect(await tail.read(T0)).toBeNull();
    // Group-writable partition / directory: refused.
    fs.rmSync(file(name));
    append(name, [dispatchRow('daemon:dispatch-start', 'a', at(1))]);
    expect(await tail.read(T0)).toHaveLength(1);
    fs.chmodSync(file(name), 0o620);
    expect(await tail.read(T0)).toBeNull();
    fs.chmodSync(file(name), 0o600);
    fs.chmodSync(dir, 0o770);
    expect(await tail.read(T0)).toBeNull();
    fs.chmodSync(dir, 0o700);
    // A symlinked partition is never followed.
    fs.rmSync(file(name));
    const outside = nodePath.join(os.tmpdir(), `outside-${process.pid}.jsonl`);
    fs.writeFileSync(outside, `${dispatchRow('daemon:dispatch-start', 'z', at(1))}\n`, { mode: 0o600 });
    try {
      fs.symlinkSync(outside, file(name));
      expect(await tail.read(T0)).toBeNull();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  // retry: a wall-clock probe can be descheduled by an unrelated load spike;
  // the old whole-partition synchronous read failed this on every attempt.
  it('never blocks the event loop past the 20 ms budget, even on a cold multi-MB partition', { retry: 2 }, async () => {
    const name = `${DAY}.jsonl`;
    const lines: string[] = [];
    for (let i = 0; i < 9_000; i += 1) {
      const ts = new Date(T0 + i * 5_000).toISOString();
      lines.push(i % 20 === 0 ? dispatchRow('daemon:dispatch-start', `r${i}`, ts) : tickRow(ts, i));
      if (i % 20 === 1) lines.push(dispatchRow('daemon:dispatch', `r${i - 1}`, ts));
    }
    lines.push(dispatchRow('daemon:dispatch-start', 'open-run', new Date(T0 + 9_000 * 5_000).toISOString()));
    append(name, lines);
    expect(fs.statSync(file(name)).size).toBeGreaterThan(3 * 1024 * 1024);
    const tail = createDispatchTail({ dir: () => dir });
    let maxGap = 0;
    let last = performance.now();
    let probing = true;
    const probe = (): void => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (probing) setImmediate(probe);
    };
    setImmediate(probe);
    const started = performance.now();
    const out = await tail.read(T0);
    const coldMs = performance.now() - started;
    probing = false;
    expect(out?.map((f) => f.runId)).toEqual(['open-run']);
    console.log(`[c11] cold tail of ${(fs.statSync(file(name)).size / 1e6).toFixed(1)} MB: ${coldMs.toFixed(1)} ms total, longest loop stall ${maxGap.toFixed(1)} ms`);
    expect(maxGap).toBeLessThan(20);
    // A warm refresh with nothing appended is a stat, not a read.
    const warmStart = performance.now();
    await tail.read(T0);
    expect(performance.now() - warmStart).toBeLessThan(20);
  });

  it('the snapshot awaits an asynchronous inFlight source (only while the daemon is alive)', async () => {
    alive = true;
    const built = await buildFleetLiveSnapshot({
      ...(deps() as FleetLiveDeps),
      inFlight: async () => [{ runId: 'run-async', itemId: 'item-a', repoPath: '/tmp/mirrors/ashlrai__binshield', backend: 'codex', model: null, startedAt: iso(MIN) }],
    });
    expect(built.snapshot.runs.find((r) => r.id === 'run-async')?.phase).toBe('producing');
    const unknown = await buildFleetLiveSnapshot({ ...(deps() as FleetLiveDeps), inFlight: async () => { throw new Error('io'); } });
    expect(unknown.snapshot.summary.building).toBeNull();
  });
});
