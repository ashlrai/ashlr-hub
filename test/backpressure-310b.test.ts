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
  emptyBackpressureState,
  evaluateBackpressure,
  loadBackpressureState,
  openFleetPrsFromLedger,
  outcomeEventsFromLedger,
  saveBackpressureState,
  trailingFailures,
  type OutcomeEvent,
} from '../src/core/fleet/backpressure.js';
import type { LedgerEntry } from '../src/core/authority/types.js';
import type { GateId, LandingRecord } from '../src/core/fleet/fleet-types.js';

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
