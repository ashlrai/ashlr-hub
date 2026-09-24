/**
 * V3.10 Track B (U5): fleet backpressure (SPEC-310B §3 "Backpressure").
 *   - ≤ 3 open fleet PRs per repo; production stops while > 4 wait to verify;
 *   - 3 consecutive rejects or reverts → 6 h repo cooldown; on one route
 *     (engine × repo × kind) → the route is demoted;
 *   - a cooldown / demotion needs 3 NEW failures after the previous one;
 *   - unknown inputs fail closed.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BACKPRESSURE_LIMITS,
  UNKNOWN_PR_STATE_COUNT_MS,
  awaitsVerification,
  emptyBackpressureState,
  evaluateBackpressure,
  fleetPrKey,
  loadBackpressureState,
  openFleetPrRefsFromLedger,
  openFleetPrsFromLedger,
  prStateFromMergeState,
  reconcileOpenFleetPrs,
  type ObservedPrState,
  outcomeEventsFromLedger,
  saveBackpressureState,
  trailingFailures,
  type OutcomeEvent,
} from '../src/core/fleet/backpressure.js';
import type { LedgerEntry } from '../src/core/authority/types.js';
import type { GateId, LandingRecord } from '../src/core/fleet/fleet-types.js';
import { mkdirSync } from 'node:fs';
import { makeFixture } from './helpers/h1-fixture.js';
import { newFleetMergeState, writeFleetMergeState, type FleetMergeStateRead, type FleetMergeStateV1 } from '../src/core/fleet/fleet-merge-state.js';
import { createProposal } from '../src/core/inbox/store.js';
import { defaultLiveHooksDeps } from '../src/core/fleet/tick-hooks-live.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const REPO = 'ashlrai/binshield';
let seq = 0;

function entry<K extends LedgerEntry['kind']>(kind: K, data: Extract<LedgerEntry, { kind: K }>['data'], at: string): LedgerEntry {
  return { v: 1, seq: seq++, at, actor: 'daemon', grantId: 'g', repo: REPO, prevHash: '0'.repeat(64), hash: '1'.repeat(64), kind, data } as LedgerEntry;
}

function minutes(n: number): string {
  return new Date(NOW - n * 60_000).toISOString();
}

function refusal(proposalId: string, gate: GateId, at: string, code = 'verify-failed'): LedgerEntry {
  return entry('gate:result', {
    v: 1, gate, proposalId, repo: REPO, headSha: 'a'.repeat(40), verdict: 'refuse', code, reason: `${gate} said no`, at, digest: 'd'.repeat(64),
  }, at);
}

function landing(id: string, proposalId: string | null, pr: number, at: string, kind: 'merge' | 'revert' = 'merge', reverts: string | null = null): LandingRecord {
  return {
    v: 1, id, kind, repo: REPO, baseBranch: 'main', prNumber: pr, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40),
    proposalId, revertsLandingId: reverts, grantId: 'g', rolloutStageId: '2a', gatesDigest: 'c'.repeat(64),
    ledgerHead: 'e'.repeat(64), enforcement: 'server', risk: 'low', files: 1, linesAdded: 1, linesDeleted: 0,
    producer: kind === 'merge' ? { engine: 'grok-cli', model: 'grok-4.7', family: 'xai', seatId: 'grok' } : null,
    judgeId: kind === 'merge' ? 'claude-cli:opus' : null, proposedAt: at, landedAt: at, watchUntil: at,
  };
}

const route = (id: string) => (id.startsWith('p-') ? { engine: 'grok-cli', kind: 'todo' } : null);

describe('outcome events from the ledger', () => {
  it('counts refusals only at gates that judge the work, once per proposal head', () => {
    const rows = [
      refusal('p-1', 'G0', minutes(50), 'daily-cap'),
      refusal('p-2', 'G3', minutes(40)),
      refusal('p-2', 'G3', minutes(39)),
      entry('gate:result', { v: 1, gate: 'G1', proposalId: 'p-3', repo: REPO, headSha: null, verdict: 'owner-lane', code: 'protected-path', reason: 'owner lane', at: minutes(30), digest: 'd'.repeat(64) }, minutes(30)),
    ];
    const events = outcomeEventsFromLedger(rows, route);
    expect(events.map((e) => [e.proposalId, e.kind])).toEqual([['p-2', 'reject']]);
    expect(events[0]!.route).toEqual({ engine: 'grok-cli', kind: 'todo' });
  });

  it('treats merges and would-merges as successes and attributes reverts to the reverted landing', () => {
    const rows = [
      entry('merge:landed', landing('L1', 'p-1', 12, minutes(60)), minutes(60)),
      entry('gate:would-merge', { v: 1, proposalId: 'p-2', repo: REPO, headSha: 'a'.repeat(40), gatesDigest: 'c'.repeat(64), withheldBecause: 'shadow', risk: 'low', files: 1, linesAdded: 1, linesDeleted: 0, at: minutes(50) }, minutes(50)),
      entry('revert:landed', landing('R1', null, 13, minutes(40), 'revert', 'L1'), minutes(40)),
    ];
    const events = outcomeEventsFromLedger(rows, route);
    expect(events.map((e) => e.kind)).toEqual(['success', 'success', 'revert']);
    expect(events[2]!.proposalId).toBe('p-1');
    expect(events[2]!.route).toEqual({ engine: 'grok-cli', kind: 'todo' });
  });

  it('measures the trailing run of failures, stopping at a success or the watermark', () => {
    const ev = (kind: OutcomeEvent['kind'], at: string): OutcomeEvent => ({ repo: REPO, at, kind, proposalId: null, route: null, detail: kind });
    const events = [ev('reject', minutes(50)), ev('success', minutes(40)), ev('reject', minutes(30)), ev('revert', minutes(20)), ev('reject', minutes(10))];
    expect(trailingFailures(events, Number.NEGATIVE_INFINITY)).toBe(3);
    expect(trailingFailures(events, Date.parse(minutes(25)))).toBe(2);
  });
});

describe('open fleet PRs', () => {
  it('opens, closes, reopens and lands', () => {
    const pr = (kind: 'pr:opened' | 'pr:closed' | 'pr:reopened', number: number, at: string): LedgerEntry => (kind === 'pr:opened'
      ? entry('pr:opened', { v: 1, repo: REPO, number, proposalId: `p-${number}`, branch: `ashlr/fleet/p-${number}`, headSha: 'a'.repeat(40), kind: 'change', ownerLane: false, at }, at)
      : entry(kind, { repo: REPO, number, reason: 'r', actor: 'mason', at }, at));
    const rows = [
      pr('pr:opened', 1, minutes(90)),
      pr('pr:opened', 2, minutes(80)),
      pr('pr:opened', 3, minutes(70)),
      pr('pr:closed', 2, minutes(60)),
      pr('pr:reopened', 2, minutes(50)),
      entry('merge:landed', landing('L3', 'p-3', 3, minutes(40)), minutes(40)),
    ];
    expect(openFleetPrsFromLedger(rows)).toEqual({ [REPO]: 2 });
  });
});

describe('evaluateBackpressure', () => {
  const base = {
    nowMs: NOW,
    repos: [REPO],
    openPrsByRepo: {},
    waitingVerify: 0,
    outcomes: [] as OutcomeEvent[],
    holds: [],
    state: emptyBackpressureState(),
  };

  it('pauses a repo at 3 open fleet PRs and leaves one under the cap alone', () => {
    expect(evaluateBackpressure({ ...base, openPrsByRepo: { [REPO]: 2 } }).pausedRepos).toEqual({});
    const verdict = evaluateBackpressure({ ...base, openPrsByRepo: { [REPO]: BACKPRESSURE_LIMITS.maxOpenFleetPrsPerRepo } });
    expect(verdict.pausedRepos[REPO]).toMatch(/3 fleet PRs are already open/);
  });

  it('pauses every repo when open PRs cannot be counted (fail closed)', () => {
    const verdict = evaluateBackpressure({ ...base, openPrsByRepo: null });
    expect(verdict.pausedRepos[REPO]).toMatch(/could not be counted/);
  });

  it('holds production while more than 4 proposals wait for verification, and when the queue is unknown', () => {
    expect(evaluateBackpressure({ ...base, waitingVerify: 4 }).holdProduction).toBeNull();
    expect(evaluateBackpressure({ ...base, waitingVerify: 5 }).holdProduction).toMatch(/5 proposals are waiting for verification/);
    expect(evaluateBackpressure({ ...base, waitingVerify: null }).holdProduction).toMatch(/could not be read/);
  });

  it('cools a repo down for 6 h after 3 consecutive rejects or reverts, and demotes the failing route', () => {
    const rows = [refusal('p-1', 'G3', minutes(30)), refusal('p-2', 'G6', minutes(20), 'judge-refused'), entry('revert:landed', landing('R', null, 9, minutes(10), 'revert', null), minutes(10))];
    const outcomes = outcomeEventsFromLedger(rows, route);
    const verdict = evaluateBackpressure({ ...base, outcomes });
    expect(verdict.cooldowns).toHaveLength(1);
    expect(verdict.cooldowns[0]!.repo).toBe(REPO);
    expect(Date.parse(verdict.cooldowns[0]!.until) - NOW).toBe(BACKPRESSURE_LIMITS.cooldownMs);
    // Only two of the three failures carry the grok-cli route (the revert's landing is unknown).
    expect(verdict.demotions).toHaveLength(0);

    const three = outcomeEventsFromLedger([refusal('p-1', 'G3', minutes(30)), refusal('p-2', 'G6', minutes(20)), refusal('p-3', 'G2', minutes(10), 'risk-over-cap')], route);
    const demoted = evaluateBackpressure({ ...base, outcomes: three });
    expect(demoted.demotions).toEqual([expect.objectContaining({ engine: 'grok-cli', repo: REPO, kind: 'todo' })]);
    expect(demoted.nextState.demotions).toHaveLength(1);
  });

  it('does not re-trigger on the same failures after the cooldown began (watermark)', () => {
    const outcomes = outcomeEventsFromLedger([refusal('p-1', 'G3', minutes(30)), refusal('p-2', 'G3', minutes(20)), refusal('p-3', 'G3', minutes(10))], route);
    const first = evaluateBackpressure({ ...base, outcomes });
    expect(first.cooldowns).toHaveLength(1);
    // Seven hours later the hold has expired; the same three failures must not cool it down again.
    const later = evaluateBackpressure({ ...base, nowMs: NOW + 7 * 3_600_000, outcomes, state: first.nextState });
    expect(later.cooldowns).toHaveLength(0);
    expect(later.demotions).toHaveLength(0);
    // Expired demotions are dropped.
    expect(later.nextState.demotions).toHaveLength(0);
  });

  it('does not stack a second cooldown while one is active', () => {
    const outcomes = outcomeEventsFromLedger([refusal('p-1', 'G3', minutes(30)), refusal('p-2', 'G3', minutes(20)), refusal('p-3', 'G3', minutes(10))], route);
    const verdict = evaluateBackpressure({
      ...base,
      outcomes,
      holds: [{ v: 1, repo: REPO, kind: 'cooldown', reason: 'cooling', since: minutes(5), until: new Date(NOW + 3_600_000).toISOString(), setBy: 'backpressure', landingId: null }],
    });
    expect(verdict.cooldowns).toHaveLength(0);
  });
});

describe('state store', () => {
  it('round-trips at 0600 and reads a mangled file as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'u5-bp-'));
    try {
      const file = join(dir, 'fleet', 'backpressure.json');
      const state = { ...emptyBackpressureState(), lastCooldownAt: { [REPO]: new Date(NOW).toISOString() } };
      saveBackpressureState(state, file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(loadBackpressureState(file).lastCooldownAt[REPO]).toBe(new Date(NOW).toISOString());
      writeFileSync(file, '{not json', { mode: 0o600 });
      expect(loadBackpressureState(file)).toEqual(emptyBackpressureState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Review c1: "waiting for verification" counts only work G3 will reach.
// ---------------------------------------------------------------------------

function mergeRecord(over: Partial<FleetMergeStateV1> = {}): FleetMergeStateV1 {
  return {
    ...newFleetMergeState({ key: 'p-1', kind: 'change', proposalId: 'p-1', revertsLandingId: null, repo: REPO, repoPath: '/m', enforcement: 'server', nowIso: new Date(NOW).toISOString() }),
    ...over,
  };
}

function memo(verdict: 'pass' | 'wait' | 'owner-lane' | 'refuse', code = 'x') {
  return { digest: 'd'.repeat(64), verdict, code, headSha: null, at: new Date(NOW).toISOString() };
}

const prMemo = {
  number: 7, nodeId: 'n', repositoryId: 'r', branch: 'ashlr/fleet/p-1', baseBranch: 'main', baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), ownerLane: true, ownerLaneReason: 'protected path', openedAt: new Date(NOW).toISOString(),
  ledgered: true, state: 'open' as const, closedBy: null, nextCheckAt: null, checkBackoffMs: 0, checks: null, wouldMergeHeadSha: null,
};

describe('awaitsVerification (review c1)', () => {
  const ok = (record: FleetMergeStateV1): FleetMergeStateRead => ({ state: 'ok', record });

  it('counts work the verifier will reach: not yet evaluated, or every pre-G3 gate passed', () => {
    expect(awaitsVerification({ state: 'missing' })).toBe(true);
    expect(awaitsVerification(ok(mergeRecord()))).toBe(true);
    expect(awaitsVerification(ok(mergeRecord({ gates: { G0: memo('pass'), G1: memo('pass'), G1b: memo('pass'), G2: memo('pass') } })))).toBe(true);
    // Verify-infra retry at G3 is still the verifier's work.
    expect(awaitsVerification(ok(mergeRecord({ gates: { G0: memo('pass'), G2: memo('pass'), G3: memo('wait', 'verify-infra') } })))).toBe(true);
  });

  it('does not count G2 over-cap waits, G0 waits, owner-lane PRs, outcomes or unreadable state', () => {
    expect(awaitsVerification(ok(mergeRecord({ gates: { G0: memo('pass'), G1: memo('pass'), G2: memo('wait', 'risk-over-cap') } })))).toBe(false);
    expect(awaitsVerification(ok(mergeRecord({ gates: { G0: memo('wait', 'no-judge-seat') } })))).toBe(false);
    expect(awaitsVerification(ok(mergeRecord({ gates: { G0: memo('pass'), G1: memo('owner-lane') }, pr: prMemo })))).toBe(false);
    expect(awaitsVerification(ok(mergeRecord({ outcome: 'rejected' })))).toBe(false);
    expect(awaitsVerification({ state: 'corrupt', reason: 'bad' })).toBe(false);
  });

  it('five medium-risk proposals parked at G2 no longer hold the whole fleet (end to end, tmp HOME)', async () => {
    const fx = makeFixture();
    try {
      const mirror = `${fx.home}/.ashlr/fleet/mirrors/ashlrai__binshield`;
      mkdirSync(mirror, { recursive: true });
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const p = createProposal({ repo: mirror, origin: 'swarm', kind: 'patch', title: `change ${i}`, summary: 's', diff: `diff --git a/f${i} b/f${i}\n` });
        expect(p.status).toBe('pending');
        ids.push(p.id);
      }
      // Five parked at G2 over the stage cap; one untouched (it may go straight to G3).
      for (const id of ids.slice(0, 5)) {
        expect(writeFleetMergeState({ ...mergeRecord({ gates: { G0: memo('pass'), G1: memo('pass'), G1b: memo('pass'), G2: memo('wait', 'risk-over-cap') } }), key: id, proposalId: id })).toBe(true);
      }
      const waiting = await defaultLiveHooksDeps().waitingVerify([mirror]);
      expect(waiting).toBe(1);
      const verdict = evaluateBackpressure({ nowMs: NOW, repos: [REPO], openPrsByRepo: {}, waitingVerify: waiting, outcomes: [], holds: [], state: emptyBackpressureState() });
      expect(verdict.holdProduction).toBeNull();
    } finally {
      fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Review c5: open fleet PRs reconcile with GitHub / merge state.
// ---------------------------------------------------------------------------

describe('open fleet PR reconciliation (review c5)', () => {
  function opened(number: number, at: string, proposalId: string | null = `p-${number}`): LedgerEntry {
    return entry('pr:opened', { v: 1, repo: REPO, number, proposalId, branch: `ashlr/fleet/p-${number}`, headSha: 'a'.repeat(40), kind: 'change', ownerLane: true, at }, at);
  }

  it('PRs Mason merged or closed on GitHub stop counting, so the repo is not paused for 7 days', () => {
    const rows = [opened(1, minutes(60)), opened(2, minutes(50)), opened(3, minutes(40))];
    expect(openFleetPrsFromLedger(rows)).toEqual({ [REPO]: 3 });
    const refs = openFleetPrRefsFromLedger(rows);
    expect(refs.map((r) => r.proposalId)).toEqual(['p-1', 'p-2', 'p-3']);
    const observed = new Map<string, ObservedPrState>([
      [fleetPrKey(REPO, 1), 'merged'],
      [fleetPrKey(REPO, 2), 'closed'],
      [fleetPrKey(REPO, 3), 'open'],
    ]);
    const counts = reconcileOpenFleetPrs(refs, observed, NOW);
    expect(counts).toEqual({ [REPO]: 1 });
    const verdict = evaluateBackpressure({ nowMs: NOW, repos: [REPO], openPrsByRepo: counts, waitingVerify: 0, outcomes: [], holds: [], state: emptyBackpressureState() });
    expect(verdict.pausedRepos[REPO]).toBeUndefined();
  });

  it('unknown state counts (fail closed) but only for a bounded time, never the whole evidence window', () => {
    const fresh = opened(1, new Date(NOW - 60_000).toISOString());
    const stale = opened(2, new Date(NOW - UNKNOWN_PR_STATE_COUNT_MS - 60_000).toISOString());
    const counts = reconcileOpenFleetPrs(openFleetPrRefsFromLedger([fresh, stale]), new Map(), NOW);
    expect(counts).toEqual({ [REPO]: 1 });
    // Observed open is never aged out.
    const openStale = reconcileOpenFleetPrs(openFleetPrRefsFromLedger([stale]), new Map([[fleetPrKey(REPO, 2), 'open' as const]]), NOW);
    expect(openStale).toEqual({ [REPO]: 1 });
  });

  it('reads terminal PR state from the fleet merge record', () => {
    const ok = (record: FleetMergeStateV1): FleetMergeStateRead => ({ state: 'ok', record });
    expect(prStateFromMergeState(ok(mergeRecord({ pr: { ...prMemo, state: 'merged' } })), 7)).toBe('merged');
    expect(prStateFromMergeState(ok(mergeRecord({ pr: { ...prMemo, state: 'closed', closedBy: 'github' }, outcome: 'closed' })), 7)).toBe('closed');
    expect(prStateFromMergeState(ok(mergeRecord({ pr: prMemo, outcome: 'merged' })), 7)).toBe('merged');
    expect(prStateFromMergeState(ok(mergeRecord({ pr: prMemo })), 7)).toBe('open');
    expect(prStateFromMergeState(ok(mergeRecord({ pr: prMemo })), 8)).toBeNull();
    expect(prStateFromMergeState({ state: 'missing' }, 7)).toBeNull();
  });
});
