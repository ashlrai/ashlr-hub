/**
 * V3.10 unit C1 — activity + session meta (src/core/verse/{activity,
 * session-meta,activity-api}.ts).
 *
 * Everything runs under a relocated HOME with a FAKE engine (no session is
 * ever started, no seat is ever prompted), a fake health view and fake Track B
 * producers. The inbox scan reads proposal files this test writes into the
 * temporary HOME.
 *
 * What is pinned:
 *   - unread is tracked by turnCount, with a baseline so upgrading does not
 *     mark history unread; `seen` only moves forward and is clamped;
 *   - completions: first poll is not "new", a foreign cursor resets, C3's
 *     engine ring is used when present;
 *   - Needs you: C1's own items validate against the R1 boundary check, a
 *     missing producer is `unavailable`, a throwing or malformed one is
 *     `error` (never a false all-clear), a producer cannot file under another
 *     source, approvals are counted exactly past the item cap;
 *   - the routes: strict queries and bodies, the mutation gate, 404s;
 *   - the budget: a warm activity read answers in < 5 ms.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  ApprovalsScanner,
  approvalItem,
  compareNeedsYou,
  createActivityReader,
  parseActivityCursor,
  scarcestSeat,
  TurnEndTracker,
  type ActivityDeps,
  type ActivityEngine,
  type ApprovalsView,
  type HealthView,
} from '../src/core/verse/activity.js';
import { handleActivityApi, setActivityWiringForTest } from '../src/core/verse/activity-api.js';
import { createSessionMetaStore, parseSessionMetaFile, VERSE_SESSION_META_FILE } from '../src/core/verse/session-meta.js';
import type { SeatHealthReport } from '../src/core/verse/health-types.js';
import type { VerseSeat, VerseSession } from '../src/core/verse/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  isNeedsYouItem,
  VERSE_ACTIVITY_BUDGET_MS,
  type NeedsYouItem,
  type VerseActivityResponse,
  type VerseLiveStatus,
  type VerseSessionMeta,
  type VerseTurnEnd,
} from '../src/core/verse/workbench-types.js';

const TOKEN = 'c1-activity-token';
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-activity-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  setActivityWiringForTest(null);
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-09-24T10:00:00.000Z');

function session(id: string, over: Partial<VerseSession> = {}): VerseSession {
  return {
    id,
    title: `Chat ${id}`,
    projectPath: `/tmp/projects/${id}-repo`,
    engine: 'claude',
    accountId: 'claude-a',
    seatId: 'claude-a',
    model: 'claude-opus-5-5',
    nativeSessionId: null,
    createdAt: new Date(T0 - 3_600_000).toISOString(),
    updatedAt: new Date(T0 - 3_600_000).toISOString(),
    status: 'idle',
    turnCount: 2,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null } as unknown as VerseSession['usage'],
    lastError: null,
    ...over,
  };
}

class FakeEngine implements ActivityEngine {
  sessions: VerseSession[] = [];
  listSessions(): VerseSession[] {
    return this.sessions.map((s) => ({ ...s }));
  }
}

function seat(id: string, engine: VerseSeat['engine'], used: number | null, windowId = 'five_hour'): VerseSeat {
  return {
    id,
    engine,
    label: `Seat ${id}`,
    accountId: id,
    models: [],
    contextWindow: null,
    health: { state: 'ok' } as unknown as VerseSeat['health'],
    ...(engine === 'local'
      ? {}
      : {
          capacity: {
            planType: 'max',
            binding: used === null ? null : { id: windowId, usedPercent: used, resetsAt: null, resetDescription: null, limitReached: false, measured: true },
            windows: [],
            credits: null,
            usability: 'ready',
            observedAt: null,
            evidenceSource: 'collector',
            notes: [],
          } as unknown as VerseSeat['capacity'],
        }),
  };
}

function report(seatId: string, connection: SeatHealthReport['connection'], over: Partial<SeatHealthReport> = {}): SeatHealthReport {
  return {
    seatId,
    engine: 'claude',
    connection,
    checkedAt: new Date(T0).toISOString(),
    cliVersion: '2.1.280',
    newestCliVersion: '2.1.300',
    credentialExpiresAt: null,
    lastRefreshAt: null,
    resetAt: null,
    reasons: connection === 'connected' ? [] : ['the CLI reports no usable login'],
    fix: { kind: 'none' },
    ...over,
  };
}

function producerItem(source: NeedsYouItem['source'], kind: NeedsYouItem['kind'], ref: string, over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: `${source}:${kind}:${ref}`,
    source,
    kind,
    severity: 'warn',
    title: `Item ${ref}`,
    detail: null,
    since: new Date(T0 - 60_000).toISOString(),
    expiresAt: null,
    subject: { repo: 'ashlrai/binshield', pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'section', section: 'fleet', anchor: null },
    actions: [{ kind: 'resume', label: 'Resume repo', request: { method: 'POST', path: '/api/verse/fleet/live', body: { repo: ref } }, confirm: null, destructive: false }],
    ...over,
  };
}

interface Harness {
  engine: FakeEngine;
  deps: ActivityDeps;
  clock: { now: number };
  approvals: ApprovalsView;
  health: HealthView | null;
}

function harness(): Harness {
  const engine = new FakeEngine();
  const clock = { now: T0 };
  const h: Harness = {
    engine,
    clock,
    approvals: { state: 'ok', items: [], total: 0 },
    health: null,
    deps: null as unknown as ActivityDeps,
  };
  h.deps = {
    engine: () => engine,
    meta: createSessionMetaStore({ now: () => clock.now }),
    producers: () => ({ authority: null, fleet: null, leader: null }),
    approvals: () => h.approvals,
    health: () => h.health,
    autonomy: () => null,
    latestMemoAt: null,
    now: () => clock.now,
  };
  return h;
}

// ---------------------------------------------------------------------------
// session-meta
// ---------------------------------------------------------------------------

describe('session-meta store', () => {
  it('treats history that predates the baseline as read, and new turns after it as unread', () => {
    const clock = { now: T0 };
    const store = createSessionMetaStore({ now: () => clock.now });
    const old = session('old', { turnCount: 7, updatedAt: new Date(T0 - 86_400_000).toISOString() });
    const fresh = session('fresh', { turnCount: 1, updatedAt: new Date(T0 + 60_000).toISOString() });
    expect(store.isUnread(old)).toBe(false);
    expect(store.seenTurnCount(old)).toBe(7);
    expect(store.isUnread(fresh)).toBe(true);
    // The baseline was written on first load, 0600 — a restart cannot move it.
    const file = path.join(home, '.ashlr', 'verse', VERSE_SESSION_META_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    clock.now = T0 + 7 * 86_400_000;
    const reopened = createSessionMetaStore({ now: () => clock.now });
    expect(reopened.baselineAt()).toBe(new Date(T0).toISOString());
    expect(reopened.isUnread(fresh)).toBe(true);
    // The same chat getting a new turn after the baseline is unread again.
    expect(reopened.isUnread({ ...old, turnCount: 8, updatedAt: new Date(T0 + 1_000).toISOString() })).toBe(true);
  });

  it('only moves seen forward, and persists pin/archive across a reload', () => {
    const store = createSessionMetaStore({ now: () => T0 });
    const s = session('a', { turnCount: 4, updatedAt: new Date(T0 + 1).toISOString() });
    expect(store.markSeen(s, 4).seenTurnCount).toBe(4);
    expect(store.markSeen(s, 2).seenTurnCount).toBe(4);
    expect(store.update(s, { pinned: true }).pinned).toBe(true);
    expect(store.update(s, { archived: true })).toMatchObject({ pinned: true, archived: true, seenTurnCount: 4 });
    const reloaded = createSessionMetaStore({ now: () => T0 });
    expect(reloaded.get(s)).toEqual<VerseSessionMeta>({ sessionId: 'a', pinned: true, archived: true, seenTurnCount: 4 });
    expect(reloaded.update(s, { pinned: false, archived: false })).toMatchObject({ pinned: false, archived: false, seenTurnCount: 4 });
  });

  it('seeds existing chats once, so a resumed old chat shows only its NEW turns unread (C2)', () => {
    const clock = { now: T0 };
    const store = createSessionMetaStore({ now: () => clock.now });
    const old = session('old', { turnCount: 40, updatedAt: new Date(T0 - 86_400_000).toISOString() });
    const fresh = session('fresh', { turnCount: 1, updatedAt: new Date(T0 + 60_000).toISOString() });
    expect(store.seedBaseline([old, fresh])).toBe(1);
    // Written, 0600 — a restart reads the seed, not the moving updatedAt.
    const file = path.join(home, '.ashlr', 'verse', VERSE_SESSION_META_FILE);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: Record<string, unknown> };
    expect(onDisk.sessions).toEqual({ old: { seen: 40 } });
    // Idempotent: nothing new to seed, no second write needed.
    expect(store.seedBaseline([old, fresh])).toBe(0);
    // The operator resumes the old chat after the upgrade: one new turn, one unread — not 41.
    clock.now = T0 + 3_600_000;
    const reopened = createSessionMetaStore({ now: () => clock.now });
    const resumed = { ...old, turnCount: 41, updatedAt: new Date(T0 + 120_000).toISOString() };
    expect(reopened.seenTurnCount(resumed)).toBe(40);
    expect(reopened.isUnread(resumed)).toBe(true);
    expect(reopened.isUnread(fresh)).toBe(true); // made after the baseline: genuinely new
  });

  it('seeding never lowers or overwrites a seen the operator already wrote', () => {
    const store = createSessionMetaStore({ now: () => T0 });
    const old = session('old', { turnCount: 9, updatedAt: new Date(T0 - 1_000).toISOString() });
    store.update(old, { pinned: true });
    expect(store.seedBaseline([old])).toBe(0);
    expect(store.get(old)).toMatchObject({ pinned: true, seenTurnCount: 9 });
  });

  it('loads a hand-mangled file field by field instead of failing', () => {
    const parsed = parseSessionMetaFile(
      {
        baselineAt: 'yesterday',
        mindSeenAt: '2026-09-20T00:00:00Z',
        sessions: { ok: { pinned: true, seen: 3 }, 'bad id!': { pinned: true }, neg: { seen: -1 }, junk: 'x' },
      },
      '2026-09-24T00:00:00.000Z',
    );
    expect(parsed.baselineAt).toBe('2026-09-24T00:00:00.000Z');
    expect(parsed.mindSeenAt).toBe('2026-09-20T00:00:00Z');
    expect(parsed.sessions).toEqual({ ok: { pinned: true, seen: 3 } });
  });
});

// ---------------------------------------------------------------------------
// The activity fold
// ---------------------------------------------------------------------------

describe('activity reader', () => {
  it('lists running chats with their live status, and counts unread by turnCount', () => {
    const h = harness();
    const live: VerseLiveStatus = {
      sessionId: 'run',
      turnId: 't9',
      startedAt: new Date(T0 - 62_000).toISOString(),
      phase: 'tool',
      tool: 'npm test',
      elapsedMs: 62_000,
      thinkingTail: 'checking the failing snapshot',
      outTokens: 10,
      tokPerSec: 38,
    };
    Object.assign(h.engine, { peekLiveStatus: (id: string) => (id === 'run' ? live : null) });
    h.engine.sessions = [
      session('run', { status: 'running', updatedAt: new Date(T0 + 5).toISOString() }),
      session('new', { turnCount: 3, updatedAt: new Date(T0 + 10).toISOString() }),
      session('old', { turnCount: 9 }),
    ];
    const reader = createActivityReader(h.deps, 'aaaaaaaa');
    const { response } = reader.build(null);
    expect(response.running).toEqual([
      expect.objectContaining({ sessionId: 'run', title: 'Chat run', startedAt: live.startedAt, live: { phase: 'tool', tool: 'npm test', elapsedMs: 62_000, thinkingTail: 'checking the failing snapshot' } }),
    ]);
    // `new` has 3 turns nobody opened; `old` predates the baseline; `run` is running.
    expect(response.counts).toMatchObject({ running: 1, unread: 1 });
    h.deps.meta.markSeen(h.engine.sessions[1]!, 3);
    expect(reader.build(null).response.counts.unread).toBe(0);
  });

  it('reports no completions on the first poll, then the turns that ended since the cursor', () => {
    const h = harness();
    h.engine.sessions = [session('a', { status: 'running', turnCount: 1 }), session('b', { turnCount: 1 })];
    const reader = createActivityReader(h.deps, 'bbbbbbbb');
    const first = reader.build(null).response;
    expect(first.completions).toEqual([]);

    h.engine.sessions = [
      session('a', { status: 'idle', turnCount: 2, updatedAt: new Date(T0 + 1_000).toISOString() }),
      // b ran a whole turn between polls and failed.
      session('b', { status: 'error', turnCount: 2, lastError: 'exit 1', updatedAt: new Date(T0 + 2_000).toISOString() }),
    ];
    const second = reader.build(parseActivityCursor(first.cursor)).response;
    expect(second.completions).toEqual([
      { sessionId: 'a', title: 'Chat a', outcome: 'ok', at: new Date(T0 + 1_000).toISOString(), durationMs: null },
      { sessionId: 'b', title: 'Chat b', outcome: 'failed', at: new Date(T0 + 2_000).toISOString(), durationMs: null },
    ]);
    // Polling again from the new cursor: nothing new.
    expect(reader.build(parseActivityCursor(second.cursor)).response.completions).toEqual([]);
    // A cursor from another server process resets instead of replaying.
    const foreign = parseActivityCursor(first.cursor.replace('bbbbbbbb', 'cccccccc'));
    expect(reader.build(foreign).response.completions).toEqual([]);
  });

  it("uses C3's engine ring when the engine has one", () => {
    const h = harness();
    h.engine.sessions = [session('a', { turnCount: 5 })];
    const ends: VerseTurnEnd[] = [
      { seq: 4, sessionId: 'a', turnId: 't4', outcome: 'cancelled', at: new Date(T0).toISOString(), durationMs: 4_200, turnCount: 5 },
      { seq: 5, sessionId: 'gone', turnId: 't1', outcome: 'ok', at: new Date(T0).toISOString(), durationMs: 10, turnCount: 1 },
    ];
    Object.assign(h.engine, {
      turnEndsSince: (cursor: number) => ({ cursor: 5, ends: ends.filter((e) => e.seq > cursor) }),
    });
    const reader = createActivityReader(h.deps, 'dddddddd');
    const first = reader.build(null).response;
    expect(first.cursor).toBe('v1.dddddddd.e.5');
    expect(reader.build({ boot: 'dddddddd', mode: 'e', seq: 3 }).response.completions).toEqual([
      // The deleted chat is dropped: there is nothing to open.
      { sessionId: 'a', title: 'Chat a', outcome: 'cancelled', at: new Date(T0).toISOString(), durationMs: 4_200 },
    ]);
  });

  it('files failed chats and seat problems as Needs-you items that pass the R1 boundary check', () => {
    const h = harness();
    h.engine.sessions = [
      session('boom', { status: 'error', turnCount: 3, lastError: 'CLI exited 1 (token sk-ant-api03-SECRETSECRETSECRETSECRET)', updatedAt: new Date(T0 + 1).toISOString() }),
      session('quiet', { status: 'error', turnCount: 2 }), // predates the baseline: already seen
    ];
    h.health = {
      seats: [seat('claude-a', 'claude', 62), seat('codex-b', 'codex', 91, 'codex_codex_secondary'), seat('local:qwen', 'local', null)],
      reports: [
        report('claude-a', 'connected'),
        report('codex-b', 'signed-out', { engine: 'codex' }),
        report('grok-a', 'binary-skew', { engine: 'grok' }),
        report('local:qwen', 'signed-out', { engine: 'local' }),
      ],
    };
    const { response } = createActivityReader(h.deps, 'eeeeeeee').build(null);
    for (const item of response.needsYou) expect(isNeedsYouItem(item), item.id).toBe(true);
    const kinds = response.needsYou.map((i) => `${i.kind}:${i.subject.seatId ?? i.subject.sessionId}`);
    expect(kinds).toEqual(['reconnect:codex-b', 'chat-failed:claude-a', 'repin:grok-a']);
    const failed = response.needsYou.find((i) => i.kind === 'chat-failed')!;
    expect(failed.target).toEqual({ kind: 'session', sessionId: 'boom' });
    expect(failed.detail).not.toContain('SECRETSECRET');
    expect(failed.actions[0]).toMatchObject({ kind: 'done', request: { path: '/api/verse/activity/seen', body: { sessionId: 'boom', turnCount: 3 } } });
    expect(response.sources).toMatchObject({ chats: 'ok', accounts: 'ok', approvals: 'ok' });
    expect(response.capacity).toEqual({ seatId: 'codex-b', engine: 'codex', label: 'Seat codex-b', usedPercent: 91, window: 'weekly', resetsAt: null });
  });

  it("files C3's held follow-up queues as chat items, and drops a malformed one as an error", () => {
    const h = harness();
    h.engine.sessions = [session('q', { turnCount: 3, updatedAt: new Date(T0 + 1).toISOString() })];
    const held = producerItem('chats', 'queue-held', 'q', {
      title: '1 follow-up waiting in “Chat q”',
      subject: { repo: null, pr: null, seatId: 'claude-a', sessionId: 'q', engine: 'claude' },
      target: { kind: 'session', sessionId: 'q' },
      actions: [{ kind: 'resume', label: 'Send next', request: { method: 'POST', path: '/api/verse/queue/q/qi-1/send', body: {} }, confirm: null, destructive: false }],
    });
    const engine = h.engine as FakeEngine & { queueNeedsYou?: () => NeedsYouItem[] };
    engine.queueNeedsYou = () => [held];
    const reader = createActivityReader(h.deps, 'dddddddd');
    const first = reader.build(null).response;
    expect(first.needsYou.map((i) => i.id)).toContain('chats:queue-held:q');
    expect(first.sources.chats).toBe('ok');
    // A queue item filed under another source, or pointing off /api/, never reaches the drawer.
    engine.queueNeedsYou = () => [held, producerItem('fleet', 'owner-hold', 'x'), { ...held, id: 'chats:queue-held:evil', actions: [{ ...held.actions[0]!, request: { method: 'POST', path: 'https://evil.example/x', body: {} } }] }];
    const second = reader.build(null);
    expect(second.response.needsYou.filter((i) => i.kind === 'queue-held').map((i) => i.id)).toEqual(['chats:queue-held:q']);
    expect(second.response.sources.chats).toBe('error');
    expect(second.dropped.chats).toBe(2);
    engine.queueNeedsYou = () => { throw new Error('queue store unreadable'); };
    expect(reader.build(null).response.sources.chats).toBe('error');
  });

  it('seeds the unread baseline on every read, before counting unread', () => {
    const h = harness();
    h.engine.sessions = [session('old', { turnCount: 12, updatedAt: new Date(T0 - 60_000).toISOString() })];
    createActivityReader(h.deps, 'cccccccc').build(null);
    // The chat is resumed: its updatedAt passes the baseline. Seeded, it shows one unread turn's worth.
    h.engine.sessions = [session('old', { turnCount: 13, updatedAt: new Date(T0 + 60_000).toISOString() })];
    expect(h.deps.meta.seenTurnCount(h.engine.sessions[0]!)).toBe(12);
    expect(createActivityReader(h.deps, 'cccccccc').build(null).response.counts.unread).toBe(1);
  });

  it('never reports a false all-clear: missing producers are unavailable, broken ones are error', () => {
    const h = harness();
    const good = producerItem('fleet', 'owner-hold', 'ashlrai/binshield');
    h.deps.producers = () => ({
      authority: () => {
        throw new Error('not implemented');
      },
      fleet: () => [
        good,
        // Filed under another unit's source — dropped at the boundary.
        producerItem('leader', 'leader-question', 'q1'),
        // A token-bearing POST aimed off-origin — dropped.
        producerItem('fleet', 'quarantine', 'x', { actions: [{ kind: 'resume', label: 'Resume', request: { method: 'POST', path: 'https://evil.example/x', body: {} }, confirm: null, destructive: false }] }),
      ],
      leader: null,
    });
    h.health = null;
    const built = createActivityReader(h.deps, 'ffffffff').build(null);
    expect(built.response.sources).toMatchObject({ authority: 'error', fleet: 'error', leader: 'unavailable', accounts: 'unavailable' });
    expect(built.response.needsYou.map((i) => i.id)).toEqual([good.id]);
    expect(built.dropped).toEqual({ fleet: 2 });
  });

  it('counts approvals past the item cap and sorts by urgency', () => {
    const h = harness();
    const low = approvalItem({ id: 'p-low', status: 'pending', kind: 'patch', title: 'Low', summary: '', repo: '/Users/x/repos/alpha', riskClass: 'low', createdAt: new Date(T0).toISOString() });
    const high = approvalItem({ id: 'p-high', status: 'pending', kind: 'pr', title: 'High', summary: 'why', repo: '/Users/x/repos/beta', riskClass: 'high', createdAt: new Date(T0 - 1).toISOString() });
    h.approvals = { state: 'ok', items: [low, high], total: 250 };
    const { response } = createActivityReader(h.deps, '12345678').build(null);
    expect(response.needsYou.map((i) => i.id)).toEqual(['approvals:approval:p-high', 'approvals:approval:p-low']);
    expect(response.counts.needsYou).toBe(250);
    // Paths never leave in an approval: the repo is its name.
    expect(high.subject.repo).toBe('beta');
    expect(high.actions.map((a) => [a.kind, a.request?.path, a.destructive])).toEqual([
      ['approve', '/api/inbox/p-high/approve', true],
      ['reject', '/api/inbox/p-high/reject', false],
    ]);
    expect(high.actions[0]!.confirm!.confirmLabel).toBe('Approve and open the pull request');
    expect(isNeedsYouItem(high)).toBe(true);
  });

  it('marks the Mind badge unseen only for a memo newer than the last visit', () => {
    const h = harness();
    let latest: string | null = null;
    h.deps.latestMemoAt = () => latest;
    const reader = createActivityReader(h.deps, '0a0a0a0a');
    expect(reader.build(null).response.mind).toEqual({ latestMemoAt: null, unseen: false });
    latest = new Date(T0 + 60_000).toISOString();
    expect(reader.build(null).response.mind!.unseen).toBe(true);
    h.deps.meta.markMindSeen(new Date(T0 + 120_000).toISOString());
    expect(reader.build(null).response.mind!.unseen).toBe(false);
    // No Leader module at all: unknown, not "no memo".
    h.deps.latestMemoAt = null;
    expect(createActivityReader(h.deps, '0b0b0b0b').build(null).response.mind).toBeNull();
  });

  it(`answers a warm read in under ${VERSE_ACTIVITY_BUDGET_MS} ms with 300 chats and 200 approvals`, () => {
    const h = harness();
    h.engine.sessions = Array.from({ length: 300 }, (_, i) =>
      session(`s${i}`, { status: i % 25 === 0 ? 'running' : i % 17 === 0 ? 'error' : 'idle', turnCount: i % 9, updatedAt: new Date(T0 + i).toISOString() }),
    );
    h.approvals = {
      state: 'ok',
      items: Array.from({ length: 200 }, (_, i) =>
        approvalItem({ id: `p${i}`, status: 'pending', kind: 'patch', title: `P${i}`, summary: 's', repo: '/r/x', riskClass: 'low', createdAt: new Date(T0 - i).toISOString() }),
      ),
      total: 200,
    };
    h.health = { seats: [seat('claude-a', 'claude', 40)], reports: [report('claude-a', 'connected')] };
    const reader = createActivityReader(h.deps, '99999999');
    reader.build(null); // warm: meta file load, tracker prime
    const times: number[] = [];
    let cursor = parseActivityCursor(reader.build(null).response.cursor);
    for (let i = 0; i < 25; i += 1) {
      const started = performance.now();
      const { response } = reader.build(cursor);
      times.push(performance.now() - started);
      cursor = parseActivityCursor(response.cursor);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(VERSE_ACTIVITY_BUDGET_MS);
  });
});

describe('turn-end tracker + ordering', () => {
  it('keeps at most the buffer and orders Needs you by severity, expiry, then recency', () => {
    const tracker = new TurnEndTracker();
    tracker.observe([session('a', { status: 'running' })], T0);
    for (let i = 0; i < 205; i += 1) {
      tracker.observe([session('a', { status: 'idle', turnCount: 3 + 2 * i })], T0 + i);
      tracker.observe([session('a', { status: 'running', turnCount: 3 + 2 * i })], T0 + i);
    }
    expect(tracker.since(0).ends).toHaveLength(200);

    const a = producerItem('fleet', 'owner-hold', 'a', { severity: 'info' });
    const b = producerItem('fleet', 'owner-hold', 'b', { severity: 'high' });
    const c = producerItem('fleet', 'veto-window', 'c', { severity: 'high', expiresAt: new Date(T0 + 60_000).toISOString() });
    expect([a, b, c].sort(compareNeedsYou).map((i) => i.id)).toEqual([c.id, b.id, a.id]);
    expect(scarcestSeat([seat('x', 'claude', null), seat('l', 'local', null)])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inbox scan
// ---------------------------------------------------------------------------

describe('approvals scanner', () => {
  function writeProposal(dir: string, id: string, status: string, extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({ id, status, kind: 'pr', title: `Proposal ${id}`, summary: 'fix it', repo: '/Users/m/repos/binshield', origin: 'swarm', riskClass: 'medium', createdAt: new Date(T0).toISOString(), ...extra }),
    );
  }

  it('lists pending proposals only, and picks up a status change on the next scan', async () => {
    const dir = path.join(home, '.ashlr', 'inbox');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeProposal(dir, 'p1', 'pending');
    writeProposal(dir, 'p2', 'approved');
    fs.writeFileSync(path.join(dir, 'mismatch.json'), JSON.stringify({ id: 'other', status: 'pending', createdAt: new Date(T0).toISOString() }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    let clock = T0;
    const scanner = new ApprovalsScanner(() => dir, 1_000, () => clock);
    expect(scanner.snapshot().state).toBe('unavailable');
    await scanner.refresh();
    expect(scanner.snapshot()).toMatchObject({ state: 'ok', total: 1 });
    expect(scanner.snapshot().items.map((i) => i.id)).toEqual(['approvals:approval:p1']);

    writeProposal(dir, 'p1', 'approved', { title: 'changed' });
    writeProposal(dir, 'p3', 'pending');
    // Directory mtimes have 1 ms resolution on some filesystems: nudge it.
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(dir, future, future);
    clock += 2_000;
    await scanner.refresh();
    expect(scanner.snapshot().items.map((i) => i.id)).toEqual(['approvals:approval:p3']);
  });

  it('reports an absent inbox as an honest empty, not unavailable', async () => {
    const scanner = new ApprovalsScanner(() => path.join(home, 'no-inbox'));
    await scanner.refresh();
    expect(scanner.snapshot()).toEqual({ state: 'ok', items: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('activity routes', () => {
  let server: http.Server;
  let base: string;
  let ctx: VerseApiContext;
  let engine: FakeEngine;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      void handleActivityApi(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
        if (!handled && !res.headersSent) {
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
    ctx = { cfg: {} as VerseApiContext['cfg'], token: TOKEN, allowDispatch: true };
    engine = new FakeEngine();
    engine.sessions = [session('s1', { turnCount: 3, updatedAt: new Date(Date.now() + 60_000).toISOString() })];
    setActivityWiringForTest({
      engine: () => engine,
      hooks: {
        producers: { authority: () => [], fleet: null, leader: () => [] },
        autonomy: () => ({ mode: 'propose', paused: false, stopped: false, label: 'Propose · 2 building' }),
        latestMemoAt: () => null,
      },
      deps: { health: () => null },
    });
  });

  const get = async <T>(p: string) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, body: (await res.json()) as T };
  };
  const post = async <T>(p: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };

  it('GET /api/verse/activity answers the contract shape with honest source states', async () => {
    const { status, body } = await get<VerseActivityResponse>('/api/verse/activity');
    expect(status).toBe(200);
    expect(body.cursor).toMatch(/^v1\.[0-9a-f]{8}\.t\.\d+$/);
    expect(body.sources).toEqual({ approvals: 'ok', authority: 'ok', fleet: 'unavailable', leader: 'ok', chats: 'ok', accounts: 'unavailable' });
    expect(body.autonomy).toEqual({ mode: 'propose', paused: false, stopped: false, label: 'Propose · 2 building' });
    expect(body.counts).toEqual({ running: 0, needsYou: 0, unread: 1 });
    const again = await get<VerseActivityResponse>(`/api/verse/activity?since=${encodeURIComponent(body.cursor)}`);
    expect(again.status).toBe(200);
    expect((await get('/api/verse/activity?since=garbage')).status).toBe(400);
    expect((await get('/api/verse/activity?foo=1')).status).toBe(400);
  });

  it('POST /activity/seen marks a chat read, clamped to its real turnCount, behind the gate', async () => {
    expect((await post('/api/verse/activity/seen', { sessionId: 's1', turnCount: 3 }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    const marked = await post<VerseSessionMeta>('/api/verse/activity/seen', { sessionId: 's1', turnCount: 99 });
    expect(marked).toEqual({ status: 200, body: { sessionId: 's1', pinned: false, archived: false, seenTurnCount: 3 } });
    const after = await get<VerseActivityResponse>('/api/verse/activity');
    expect(after.body.counts.unread).toBe(0);
    expect((await post('/api/verse/activity/seen', { sessionId: 'nope', turnCount: 1 })).status).toBe(404);
    expect((await post('/api/verse/activity/seen', { sessionId: 's1', turnCount: 1, extra: true })).status).toBe(400);
    expect((await post('/api/verse/activity/seen', { sessionId: 's1', turnCount: -1 })).status).toBe(400);
    expect((await post<{ ok: boolean }>('/api/verse/activity/seen', { surface: 'mind' })).body.ok).toBe(true);
    ctx = { ...ctx, allowDispatch: false };
    expect((await post('/api/verse/activity/seen', { sessionId: 's1', turnCount: 1 })).status).toBe(404);
  });

  it('session-meta: strict pin/archive, per-id reads, and the list of non-default chats', async () => {
    expect((await get('/api/verse/session-meta/nope')).status).toBe(404);
    expect((await post('/api/verse/session-meta/s1', { pinned: 'yes' })).status).toBe(400);
    expect((await post('/api/verse/session-meta/s1', {})).status).toBe(400);
    expect((await post('/api/verse/session-meta/s1', { pinned: true, color: 'red' })).status).toBe(400);
    const pinned = await post<VerseSessionMeta>('/api/verse/session-meta/s1', { pinned: true });
    expect(pinned.body).toEqual({ sessionId: 's1', pinned: true, archived: false, seenTurnCount: 0 });
    expect((await get<VerseSessionMeta>('/api/verse/session-meta/s1')).body.pinned).toBe(true);
    const list = await get<{ sessions: Record<string, VerseSessionMeta> }>('/api/verse/session-meta');
    expect(Object.keys(list.body.sessions)).toEqual(['s1']);
    expect((await get('/api/verse/session-meta?x=1')).status).toBe(400);
    const stored = JSON.parse(fs.readFileSync(path.join(home, '.ashlr', 'verse', VERSE_SESSION_META_FILE), 'utf8')) as { sessions: unknown };
    expect(stored.sessions).toEqual({ s1: { pinned: true } });
  });

  describe('a chat engine that cannot start is named, never emptied', () => {
    beforeEach(() => {
      setActivityWiringForTest({
        engine: () => null,
        hooks: { producers: { authority: () => [], fleet: null, leader: () => [] }, autonomy: null, latestMemoAt: null },
        deps: { health: () => null },
      });
    });

    it('session-meta answers 503 VERSE_ENGINE_UNAVAILABLE instead of an empty list or a false 404', async () => {
      for (const p of ['/api/verse/session-meta', '/api/verse/session-meta/s1']) {
        const { status, body } = await get<{ code: string; error: string }>(p);
        expect(status).toBe(503);
        expect(body.code).toBe('VERSE_ENGINE_UNAVAILABLE');
        expect(body.error).toMatch(/^The chat engine is not answering\. Restart ashlr verse\.$/);
        expect(body.error).not.toContain(home);
      }
      const pin = await post<{ code: string }>('/api/verse/session-meta/s1', { pinned: true });
      expect(pin).toMatchObject({ status: 503, body: { code: 'VERSE_ENGINE_UNAVAILABLE' } });
      const seen = await post<{ code: string }>('/api/verse/activity/seen', { sessionId: 's1', turnCount: 1 });
      expect(seen).toMatchObject({ status: 503, body: { code: 'VERSE_ENGINE_UNAVAILABLE' } });
      // Nothing was written for a chat nobody could look up.
      expect(fs.existsSync(path.join(home, '.ashlr', 'verse', VERSE_SESSION_META_FILE))).toBe(false);
    });

    it('GET /activity still answers, with chats as error (not "not answering yet")', async () => {
      const { status, body } = await get<VerseActivityResponse>('/api/verse/activity');
      expect(status).toBe(200);
      expect(body.sources.chats).toBe('error');
      expect(body.sources.approvals).toBe('ok');
    });
  });

  it('an engine whose listSessions throws is a 503 on every route, with no detail leaked', async () => {
    setActivityWiringForTest({
      engine: () => ({ listSessions: () => { throw new Error(`store corrupt at ${home}`); } }),
      hooks: { producers: { authority: null, fleet: null, leader: null }, autonomy: null, latestMemoAt: null },
      deps: { health: () => null },
    });
    const activity = await fetch(`${base}/api/verse/activity`);
    expect(activity.status).toBe(503);
    const text = await activity.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'VERSE_ACTIVITY_UNREADABLE' });
    expect(text).not.toContain(home);
    expect(text).not.toContain('store corrupt');
    const meta = await get<{ code: string }>('/api/verse/session-meta');
    expect(meta).toMatchObject({ status: 503, body: { code: 'VERSE_ENGINE_UNAVAILABLE' } });
  });

  it('declines paths and methods it does not own', async () => {
    expect((await get<{ error: string }>('/api/verse/activityx')).body.error).toBe('fallthrough');
    const res = await fetch(`${base}/api/verse/activity`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN }, body: '{}' });
    expect(res.status).toBe(404);
  });
});
