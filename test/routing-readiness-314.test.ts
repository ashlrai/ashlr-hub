/**
 * 3.14 — per-resource readiness (core/routing/readiness.ts): "ready for chat?"
 * and "ready for the fleet?" for every resource, with the one fix.
 *
 * Fixtures mirror Mason's machine as diagnosed on 2026-09-26: four accounts in
 * connections.json (codex-personal, codex-cmp, claude, grok), grant #1 active
 * at rollout stage 1 of 8 ("shadow": local, grok-cli, claude-cli), balanced
 * mode, Claude granted judge+leader only, Codex producer+judge (its lane opens
 * at stage 5, "3a"), and a capacity snapshot whose paid seats carry NO
 * readings — the exact shape ~/.ashlr/routing/capacity.json had that evening.
 * Pure: no I/O.
 */
import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_SETUP_COMMAND,
  buildResourceReadiness,
  CLOUD_SEAT_SETUP_COMMAND,
  OLLAMA_START_COMMAND,
  type ReadinessAccount,
  type ReadinessInput,
  type ReadinessStanding,
} from '../src/core/routing/readiness.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { StandingGrantSeat } from '../src/core/authority/types.js';
import type { SeatHealthReport } from '../src/core/verse/health-types.js';
import {
  capacity,
  codexOption,
  LOCAL_CONTEXT_SEAT,
  nativeSeat,
  seatWindow,
} from '../src/web-ui/routes/verse/seat-fixtures.test-support.js';
import type { VerseSeat } from '../src/core/verse/types.js';

const NOW = Date.parse('2026-09-27T00:05:00.000Z');
const FRESH = new Date(NOW - 30_000).toISOString();

const ACCOUNTS: ReadinessAccount[] = [
  { id: 'codex-personal', label: 'Personal Codex', provider: 'codex', state: 'unavailable', observedAt: null, reason: 'connection-polling-paused', lastReadingAt: '2026-09-26T20:56:26.150Z' },
  { id: 'codex-cmp', label: 'Cash Margin Partners', provider: 'codex', state: 'unavailable', observedAt: null, reason: 'connection-polling-paused', lastReadingAt: '2026-09-26T20:56:04.865Z' },
  { id: 'claude', label: 'Claude Code', provider: 'claude', state: 'unavailable', observedAt: null, reason: 'connection-polling-paused' },
  { id: 'grok', label: 'Grok', provider: 'grok', state: 'unavailable', observedAt: null, reason: 'collector-not-running' },
];

const unread = capacity({ usability: 'unknown' });
const SEATS: VerseSeat[] = [
  nativeSeat(unread, { id: 'codex-personal', engine: 'codex', label: 'Personal Codex', accountId: 'codex-personal', models: [codexOption('gpt-6-astra', 'GPT-6 Astra', 872_000)] }),
  nativeSeat(unread, { id: 'codex-cmp', engine: 'codex', label: 'Cash Margin Partners', accountId: 'codex-cmp', models: [codexOption('gpt-6-astra', 'GPT-6 Astra', 872_000)] }),
  nativeSeat(unread, { id: 'claude', label: 'Claude Code', accountId: 'claude' }),
  nativeSeat(unread, { id: 'grok', engine: 'grok', label: 'Grok', accountId: 'grok' }),
  LOCAL_CONTEXT_SEAT,
];

function paid(seatId: string, engine: SeatCapacity['engine'], label: string, over: Partial<SeatCapacity> = {}): SeatCapacity {
  return { seatId, engine, label, free: false, windows: [], signedOut: false, reachable: null, contextWindow: null, observedAt: null, spentTodayUsd: null, ...over };
}

/** capacity.json as it stood: paid seats present, no windows, no observedAt. */
const EMPTY_SNAPSHOT: SeatCapacity[] = [
  paid('codex-personal', 'codex', 'Personal Codex'),
  paid('codex-cmp', 'codex', 'Cash Margin Partners'),
  paid('claude', 'claude', 'Claude Code'),
  paid('grok', 'grok', 'Grok'),
  { seatId: 'local:qwen3.8:27b-ctx64k', engine: 'local', label: 'Qwen3.8 27B (64k, local)', free: true, windows: [], signedOut: false, reachable: true, contextWindow: 65_536, observedAt: null, spentTodayUsd: null },
];

const grantSeat = (roles: StandingGrantSeat['roles'], reserve: number, ceiling?: number): StandingGrantSeat =>
  ({ enabled: true, reserveFloorPercent: reserve, ...(ceiling !== undefined ? { maxSessionWindowPercent: ceiling } : {}), roles });

const GRANT_SEATS: Record<string, StandingGrantSeat> = {
  claude: grantSeat(['judge', 'leader'], 40, 70),
  'codex-personal': grantSeat(['producer', 'judge'], 40, 70),
  'codex-cmp': grantSeat(['producer', 'judge'], 40, 70),
  grok: grantSeat(['producer', 'judge', 'leader'], 0),
  local: grantSeat(['producer', 'leader'], 0),
};

const STAGES = ['shadow', '1', '2b', '2c', '3a', '3b', '3c', '3d'].map((id, index) => ({
  id,
  engines: index < 4 ? ['local', 'grok-cli', 'claude-cli'] : ['local', 'grok-cli', 'claude-cli', 'codex'],
}));

function standing(stageIndex = 0): ReadinessStanding {
  const engines = STAGES[stageIndex]!.engines;
  const seats = Object.fromEntries(Object.entries(GRANT_SEATS).map(([seatId, s]) => [seatId, {
    seatId,
    enabled: s.enabled && (seatId === 'local' ? engines.includes('local') : seatId.startsWith('codex') ? engines.includes('codex') : true),
    reserveFloorPercent: s.reserveFloorPercent,
    maxSessionWindowPercent: s.maxSessionWindowPercent ?? null,
    roles: s.roles,
  }]));
  return {
    policy: {
      engines: engines as never,
      rollout: { stageId: STAGES[stageIndex]!.id, stageIndex, stageCount: STAGES.length, enteredAt: '2026-09-26T20:30:13.751Z' },
      spend: { maxMode: 'balanced', meteredUsdPerDay: 0, seats },
    },
    inactiveReason: null,
    noGrant: false,
    grant: { seats: GRANT_SEATS, engines: ['local', 'grok-cli', 'claude-cli', 'codex'], stages: STAGES },
  };
}

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    nowMs: NOW,
    seats: SEATS,
    reports: null,
    accounts: ACCOUNTS,
    capacity: EMPTY_SNAPSHOT,
    capacitySnapshotAt: '2026-09-27T00:04:05.812Z',
    standing: standing(),
    budget: { mode: 'balanced', seats: {}, updatedAt: '2026-09-01T00:00:00.000Z' },
    codexDirective: false,
    local: { reachable: true, baseUrl: 'http://127.0.0.1:11434' },
    cloud: {
      seatReady: true,
      seatReason: null,
      signedOutSeatId: null,
      canLaunch: { ok: true, reason: null },
      canSelfImprove: { ok: false, reason: '4 of 4 self-improvement launches used today.' },
      selfImprove: { enabled: true, maxPerDay: 4, reserveUsd: 40 },
      remainingUsd: 186,
      totalUsd: 250,
    },
    ...over,
  };
}

const row = (r: ReturnType<typeof buildResourceReadiness>, id: string) => r.resources.find((x) => x.id === id)!;

describe('readiness — the machine as diagnosed (idle Verse, empty capacity snapshot)', () => {
  it('never reports chat or fleet ready for an API seat using native Claude facts', () => {
    const s = standing();
    s.grant!.seats = { ...s.grant!.seats, 'claude-api': grantSeat(['producer'], 0) };
    s.policy!.spend.seats['claude-api'] = { seatId: 'claude-api', enabled: true, reserveFloorPercent: 0,
      maxSessionWindowPercent: null, roles: ['producer'] };
    const r = buildResourceReadiness(input({ standing: s,
      accounts: [{ id: 'claude-api', label: 'Claude API', provider: 'claude', state: 'observed', observedAt: FRESH }],
      seats: [nativeSeat(unread, { id: 'claude-api', accountId: 'claude-api' })],
      capacity: [paid('claude-api', 'claude-api', 'Claude API', { free: true, reachable: true, observedAt: FRESH })],
    }));
    expect(row(r, 'claude-api').chat).toMatchObject({ ready: false, word: 'Not commissioned' });
    expect(row(r, 'claude-api').fleet).toMatchObject({ ready: false, word: 'Not commissioned' });
  });
  const r = buildResourceReadiness(input());

  it('lists every account in roster order, then Local, then Cloud', () => {
    expect(r.resources.map((x) => x.id)).toEqual(['codex-personal', 'codex-cmp', 'claude', 'grok', 'local', 'cloud']);
    expect(r.autonomy).toEqual({ active: true, stage: 'shadow', detail: 'Stage 1 of 8 · shadow' });
  });

  it('Codex: chat-ready, but the fleet is waiting on the rollout — and says when the Codex lane opens', () => {
    const codex = row(r, 'codex-personal');
    expect(codex.chat).toMatchObject({ ready: true, tone: 'warn', word: 'Ready' });
    expect(codex.chat.fix).toEqual({ kind: 'check-again', label: 'Check again', seatId: 'codex-personal' });
    expect(codex.fleet).toMatchObject({ ready: false, tone: 'off', word: 'Not in this stage', roles: ['producer', 'judge'] });
    expect(codex.fleet.detail).toBe('The rollout is at stage 1 of 8 (shadow); the Codex lane opens at stage 5 (3a).');
  });

  it('shows an honest last reading while polling is paused, never a current one', () => {
    const codex = row(r, 'codex-personal');
    expect(codex.reading).toEqual({
      state: 'last',
      at: '2026-09-26T20:56:26.150Z',
      note: 'Polling is paused because nothing has asked for account data recently; it resumes the moment Verse is looked at.',
    });
    expect(row(r, 'grok').reading.state).toBe('none');
  });

  it('Claude and Grok: granted and in-stage, blocked ONLY by the missing reading (the lease/publisher defect)', () => {
    const claude = row(r, 'claude');
    expect(claude.fleet).toMatchObject({ ready: false, tone: 'blocked', word: 'No reading', roles: ['judge', 'leader'], reservePercent: 40 });
    expect(claude.fleet.detail).toContain('unknown usage is not headroom');
    expect(row(r, 'grok').fleet).toMatchObject({ ready: false, word: 'No reading', reservePercent: 0 });
  });

  it('Local: one resource, ready for both, free', () => {
    const local = row(r, 'local');
    expect(local.chat).toMatchObject({ ready: true, word: 'Ready' });
    expect(local.chat.detail).toContain('qwen3.8:27b-ctx64k');
    expect(local.fleet).toMatchObject({ ready: true, word: 'Ready', roles: ['producer', 'leader'], reservePercent: null });
  });

  it('Cloud: set up and launchable; self-improvement paused for today by its own budget', () => {
    const cloud = row(r, 'cloud');
    expect(cloud.chat).toMatchObject({ ready: true, word: 'Ready' });
    expect(cloud.chat.detail).toContain('About $186 of $250');
    expect(cloud.fleet).toMatchObject({ ready: false, tone: 'warn', word: 'Paused', detail: '4 of 4 self-improvement launches used today.' });
  });
});

describe('readiness — once readings reach the snapshot (the fix working)', () => {
  const live: SeatCapacity[] = EMPTY_SNAPSHOT.map((seat) => {
    if (seat.seatId === 'claude') {
      return { ...seat, observedAt: FRESH, windows: [
        { id: 'five_hour', usedPercent: 22, resetsAt: null },
        { id: 'seven_day', usedPercent: 25, resetsAt: null },
      ] };
    }
    if (seat.seatId === 'grok') return { ...seat, observedAt: FRESH, windows: [{ id: 'grok_unified_weekly', usedPercent: 3, resetsAt: '2026-10-01T00:00:00.000Z' }] };
    if (seat.engine === 'codex') return { ...seat, observedAt: FRESH, windows: [{ id: 'codex_codex_primary', usedPercent: 0, resetsAt: '2026-10-03T20:56:27.000Z' }] };
    return seat;
  });

  it('Claude: "Ready" with the 40% reserve carried as data and what is LEFT for the fleet in words', () => {
    const r = buildResourceReadiness(input({ capacity: live }));
    const claude = row(r, 'claude');
    expect(claude.fleet).toMatchObject({ ready: true, tone: 'ok', word: 'Ready', reservePercent: 40 });
    // weekly: 100 − 40 reserve − 25 used = 35 · session: 70 ceiling − 22 = 48 → weekly binds.
    expect(claude.fleet.detail).toBe('35% of the weekly window is left for the fleet. Roles: judges, leads.');
  });

  it('Grok: ready with no reserve', () => {
    const r = buildResourceReadiness(input({ capacity: live }));
    expect(row(r, 'grok').fleet).toMatchObject({ ready: true, word: 'Ready', reservePercent: 0 });
  });

  it('eligible Codex is ready by default; an explicit disable and admitted directive remain visible', () => {
    const ready = buildResourceReadiness(input({ capacity: live, standing: standing(4) }));
    expect(row(ready, 'codex-cmp').fleet).toMatchObject({ ready: true, word: 'Ready', reservePercent: 40 });
    const budget: ReadinessInput['budget'] = { mode: 'balanced',
      seats: { 'codex-cmp': { seatId: 'codex-cmp', enabled: false, reservePercent: 40 } }, updatedAt: FRESH };
    const off = buildResourceReadiness(input({ capacity: live, standing: standing(4), budget }));
    expect(row(off, 'codex-cmp').fleet).toMatchObject({ ready: false, tone: 'off', word: 'Off in balanced' });
    expect(row(off, 'codex-cmp').fleet.detail).toContain('until the Leader turns the Codex lanes on');

    const on = buildResourceReadiness(input({ capacity: live, standing: standing(4), budget, codexDirective: true }));
    expect(row(on, 'codex-cmp').fleet).toMatchObject({ ready: true, word: 'Ready', reservePercent: 40 });
  });

  it('a reserve that is reached is a caveat with the reason, not a mystery', () => {
    const tight = live.map((s) => (s.seatId === 'claude'
      ? { ...s, windows: [{ id: 'five_hour', usedPercent: 10, resetsAt: null }, { id: 'seven_day', usedPercent: 61, resetsAt: null }] }
      : s));
    const claude = row(buildResourceReadiness(input({ capacity: tight })), 'claude');
    expect(claude.fleet).toMatchObject({ ready: false, tone: 'warn', word: 'Reserve reached', reservePercent: 40 });
    expect(claude.fleet.detail).toContain('40% is kept for you');
  });

  it('a stale snapshot is refused as stale', () => {
    const stale = live.map((s) => (s.seatId === 'grok' ? { ...s, observedAt: new Date(NOW - 20 * 60_000).toISOString() } : s));
    expect(row(buildResourceReadiness(input({ capacity: stale })), 'grok').fleet.detail).toContain('too stale');
  });
});

describe('readiness — chat gate and fixes', () => {
  const report = (seatId: string, connection: SeatHealthReport['connection'], over: Partial<SeatHealthReport> = {}): SeatHealthReport => ({
    seatId, engine: 'claude', connection, checkedAt: FRESH, cliVersion: null, newestCliVersion: null,
    credentialExpiresAt: null, lastRefreshAt: null, resetAt: null, reasons: [], fix: { kind: 'none' }, ...over,
  });

  it('a signed-out account offers Reconnect for chat and the fleet', () => {
    const seats = SEATS.map((s) => (s.id === 'claude' ? { ...s, capacity: capacity({ usability: 'signed-out' }) } : s));
    const r = buildResourceReadiness(input({
      seats,
      reports: [report('claude', 'signed-out')],
      capacity: EMPTY_SNAPSHOT.map((s) => (s.seatId === 'claude' ? { ...s, signedOut: true } : s)),
    }));
    const claude = row(r, 'claude');
    expect(claude.chat).toMatchObject({ ready: false, tone: 'blocked', word: 'Signed out', fix: { kind: 'reconnect', seatId: 'claude' } });
    expect(claude.fleet).toMatchObject({ ready: false, word: 'Signed out', fix: { kind: 'reconnect', seatId: 'claude' } });
  });

  it('an exhausted account names a ready alternative', () => {
    const w = seatWindow({ id: 'codex_codex_primary', usedPercent: 100, limitReached: true, measured: false, resetsAt: '2026-10-03T20:56:27.000Z' });
    const seats = SEATS.map((s) => (s.id === 'codex-cmp'
      ? { ...s, capacity: capacity({ usability: 'exhausted', windows: [w], binding: w }) }
      : s.id === 'codex-personal'
        ? { ...s, capacity: capacity({ usability: 'ready', windows: [seatWindow({ id: 'codex_codex_primary', usedPercent: 0 })], binding: seatWindow({ id: 'codex_codex_primary', usedPercent: 0 }), observedAt: FRESH }) }
        : s));
    const chat = row(buildResourceReadiness(input({ seats })), 'codex-cmp').chat;
    expect(chat).toMatchObject({ ready: false, word: 'Out of usage' });
    expect(chat.detail).toContain('Try Personal Codex');
  });

  it('no standing grant: autonomy is off everywhere, with the one setup command', () => {
    const r = buildResourceReadiness(input({ standing: { policy: null, inactiveReason: 'No standing grant is installed — autonomy is dark.', noGrant: true, grant: null } }));
    for (const id of ['claude', 'grok', 'codex-personal', 'local']) {
      expect(row(r, id).fleet).toMatchObject({ ready: false, tone: 'off', word: 'Autonomy off', fix: { kind: 'command', command: AUTHORITY_SETUP_COMMAND } });
    }
    expect(r.autonomy.active).toBe(false);
  });

  it('a seat the grant does not name is "Not in the grant"', () => {
    const s = standing();
    const seats = { ...GRANT_SEATS };
    delete seats['grok'];
    const r = buildResourceReadiness(input({ standing: { ...s, grant: { ...s.grant!, seats } } }));
    expect(row(r, 'grok').fleet).toMatchObject({ ready: false, word: 'Not in the grant', roles: [] });
  });
});

describe('readiness — local and cloud', () => {
  it('Ollama down: local is blocked for both, with the start command', () => {
    const r = buildResourceReadiness(input({ seats: SEATS.filter((s) => s.engine !== 'local'), local: { reachable: false, baseUrl: 'http://127.0.0.1:11434' } }));
    const local = row(r, 'local');
    expect(local.chat).toMatchObject({ ready: false, word: 'Not answering', fix: { kind: 'command', command: OLLAMA_START_COMMAND } });
    expect(local.fleet).toMatchObject({ ready: false, word: 'Not answering' });
    expect(local.reading.state).toBe('none');
  });

  it('the Claude seat missing: "Not set up" with the one command that creates claude-a', () => {
    const r = buildResourceReadiness(input({ cloud: { ...input().cloud!, seatReady: false, seatReason: "The Claude seat isn't set up on this Mac." } }));
    const cloud = row(r, 'cloud');
    expect(cloud.chat).toMatchObject({ ready: false, word: 'Not set up', fix: { kind: 'command', command: CLOUD_SEAT_SETUP_COMMAND } });
    expect(CLOUD_SEAT_SETUP_COMMAND).toContain('--provider claude');
    expect(CLOUD_SEAT_SETUP_COMMAND).toContain('~/.ashlr/native-profiles/claude-a');
    // Self-improvement can't launch either — same fix, one sentence why.
    expect(cloud.fleet.fix).toEqual(cloud.chat.fix);
  });

  it('the claude-a profile signed out: cloud offers Reconnect on the account that shares it', () => {
    const r = buildResourceReadiness(input({ cloud: { ...input().cloud!, signedOutSeatId: 'claude' } }));
    expect(row(r, 'cloud').chat).toMatchObject({ ready: false, word: 'Signed out', fix: { kind: 'reconnect', seatId: 'claude' } });
  });

  it('self-improvement off is "Off", not an error', () => {
    const r = buildResourceReadiness(input({ cloud: { ...input().cloud!, selfImprove: { enabled: false, maxPerDay: 4, reserveUsd: 40 } } }));
    expect(row(r, 'cloud').fleet).toMatchObject({ ready: false, tone: 'off', word: 'Off' });
  });

  it('never serializes a private path or a launcher', () => {
    const wire = JSON.stringify(buildResourceReadiness(input()));
    expect(wire).not.toContain('launcher');
    expect(wire).not.toContain('/Users/');
  });
});
