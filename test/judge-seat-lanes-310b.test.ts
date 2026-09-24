/**
 * V3.10 Track B unit U3 — G0 / G6 judge-seat routing against the REAL A9
 * router and capacity snapshot, clamped by B-U1's clampBudgetPolicy
 * (standing-merge-pass.ts defaultJudgeSeatLanes). The snapshot is written
 * into the isolated test HOME; no seat is ever prompted.
 *
 * "No downgrade" at the seat level: a local producer's judge is the Grok
 * seat; when Grok has no headroom the answer is "no lane" (wait), never a
 * local or same-family judge — and only after 24 h any other qualifying seat.
 * Invariant I5: a seat inside Mason's reserve (or above the 5-hour ceiling)
 * is never offered to autonomy.
 */
import { describe, expect, it } from 'vitest';

import { writeCapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultJudgeSeatLanes } from '../src/core/fleet/standing-merge-pass.js';
import { JUDGE_PREFERENCE_WAIT_MS } from '../src/core/fleet/merge-gates.js';
import { repoPolicy, standingPolicy } from './helpers/fleet-github-310b.js';

const NOW = Date.now();

function claude(fiveHour: number, weekly: number): SeatCapacity {
  return {
    seatId: 'claude-a',
    engine: 'claude',
    label: 'Claude (a)',
    free: false,
    windows: [
      { id: 'five_hour', usedPercent: fiveHour, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(), resetDescription: null, limitReached: false },
      { id: 'seven_day', usedPercent: weekly, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(), resetDescription: null, limitReached: false },
    ],
    signedOut: false,
    reachable: true,
    contextWindow: 200_000,
    observedAt: new Date(NOW - 60_000).toISOString(),
    spentTodayUsd: null,
  };
}

function grok(limitReached: boolean): SeatCapacity {
  return {
    seatId: 'grok-a',
    engine: 'grok',
    label: 'Grok (a)',
    free: false,
    windows: [{ id: 'weekly', usedPercent: limitReached ? 100 : 10, resetsAt: new Date(NOW + 86_400_000).toISOString(), resetDescription: null, limitReached }],
    signedOut: false,
    reachable: true,
    contextWindow: 256_000,
    observedAt: new Date(NOW - 60_000).toISOString(),
    spentTodayUsd: null,
  };
}

const policy = standingPolicy([repoPolicy('ashlrai/fleet-canary')]);

function lanes(producerFamily: 'local' | 'xai', waitSinceMs: number | null = null, p = policy) {
  return defaultJudgeSeatLanes({ producerFamily, policy: p, waitSinceMs, nowMs: NOW }).lanes;
}

describe('judge seat routing (A9 router × grant clamp)', () => {
  it('local work is judged by the Grok seat when it has headroom', () => {
    writeCapacitySnapshot([claude(10, 20), grok(false)], new Date(NOW));
    expect(lanes('local')).toEqual(['grok-cli']);
  });

  it('NO DOWNGRADE: Grok spent ⇒ no lane for local work (wait) until 24 h, then the Claude slice', () => {
    writeCapacitySnapshot([claude(10, 20), grok(true)], new Date(NOW));
    expect(lanes('local')).toEqual([]);
    expect(lanes('local', NOW - JUDGE_PREFERENCE_WAIT_MS)).toEqual(['claude-cli']);
  });

  it('Grok work goes to the claude-a slice — and never while Claude is inside Mason\'s reserve or above 70% of its 5-hour window', () => {
    writeCapacitySnapshot([claude(10, 20), grok(false)], new Date(NOW));
    expect(lanes('xai')).toEqual(['claude-cli']);
    writeCapacitySnapshot([claude(75, 20), grok(false)], new Date(NOW));
    expect(lanes('xai')).toEqual([]);
    writeCapacitySnapshot([claude(10, 65), grok(false)], new Date(NOW)); // 40% weekly reserve floor
    expect(lanes('xai')).toEqual([]);
    // Grok never judges Grok, however long it waits.
    expect(lanes('xai', 0)).not.toContain('grok-cli');
  });

  it('a seat the grant does not give the judge role, or an engine outside the grant, is never offered', () => {
    writeCapacitySnapshot([claude(10, 20), grok(false)], new Date(NOW));
    const noJudgeRole = standingPolicy([repoPolicy('ashlrai/fleet-canary')], {
      spend: { ...policy.spend, seats: { ...policy.spend.seats, 'grok-a': { ...policy.spend.seats['grok-a']!, roles: ['producer'] } } },
    });
    expect(lanes('local', null, noJudgeRole)).toEqual([]);
    const noGrokEngine = standingPolicy([repoPolicy('ashlrai/fleet-canary')], { engines: ['local', 'claude-cli'] });
    expect(lanes('local', null, noGrokEngine)).toEqual([]);
  });

  it('unknown usage is not headroom: a stale reading offers nothing', () => {
    const stale = { ...grok(false), observedAt: new Date(NOW - 60 * 60_000).toISOString() };
    writeCapacitySnapshot([claude(10, 20), stale], new Date(NOW));
    expect(lanes('local')).toEqual([]);
  });
});
