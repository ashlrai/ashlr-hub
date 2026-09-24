/**
 * V3.10 P1 — standing-merge-pass legacyJudgeSeatLanes: the router path the
 * LEGACY automerge red team now goes through. Same core as G5/G6's
 * defaultJudgeSeatLanes (capacity snapshot → A9 budget → routeSeat for an
 * autonomous review), minus the grant clamp the legacy path has no grant for.
 *
 * Hermetic: the capacity snapshot, the budget policy and the router are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshot = vi.hoisted(() => ({ value: null as unknown, throws: false }));
const budget = vi.hoisted(() => ({ value: { mode: 'balanced', seats: {} } as unknown, throws: false }));
vi.mock('../src/core/routing/budget-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/routing/budget-store.js')>()),
  readCapacitySnapshot: () => {
    if (snapshot.throws) throw new Error('unreadable');
    return snapshot.value;
  },
  loadBudgetPolicy: () => {
    if (budget.throws) throw new Error('budget unreadable');
    return budget.value;
  },
}));

const routeSeat = vi.fn();
vi.mock('../src/core/routing/router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/routing/router.js')>()),
  routeSeat: (...args: unknown[]) => routeSeat(...args),
}));

const { legacyJudgeSeatLanes } = await import('../src/core/fleet/standing-merge-pass.js');

const SEATS = [
  { seatId: 'claude-a', engine: 'claude' },
  { seatId: 'codex-main', engine: 'codex' },
  { seatId: 'grok-main', engine: 'grok' },
];

beforeEach(() => {
  snapshot.value = { seats: SEATS };
  snapshot.throws = false;
  budget.value = { mode: 'balanced', seats: {} };
  budget.throws = false;
  routeSeat.mockReset();
});

describe('legacyJudgeSeatLanes (P1)', () => {
  it('returns only the independent lanes the router ADMITS, in preference order, under A9\'s policy', () => {
    routeSeat.mockReturnValue({ candidates: ['codex-main'], exclusions: [{ seatId: 'claude-a', reasons: ['at reserve'], nextEligibleAt: '2026-09-24T12:00:00.000Z' }] });
    const nowMs = Date.parse('2026-09-24T08:00:00Z');
    const out = legacyJudgeSeatLanes({ producerFamily: 'xai', nowMs });
    expect(out).toEqual({ lanes: ['codex'], nextEligibleAt: '2026-09-24T12:00:00.000Z' });
    const [req, seats, policy, opts] = routeSeat.mock.calls[0]!;
    expect(req).toEqual({ task: 'review', difficulty: 'medium', autonomous: true });
    // A Grok producer is never judged by a Grok seat: that seat never reaches the router.
    expect((seats as { seatId: string }[]).map((s) => s.seatId)).toEqual(['claude-a', 'codex-main']);
    expect(policy).toBe(budget.value);
    expect(opts).toEqual({ nowMs });
  });

  it('fails closed to NO lane: no snapshot, an unreadable snapshot or budget, or an unknown producer', () => {
    routeSeat.mockReturnValue({ candidates: ['claude-a'], exclusions: [] });
    snapshot.value = null;
    expect(legacyJudgeSeatLanes({ producerFamily: 'xai', nowMs: Date.now() }).lanes).toEqual([]);
    snapshot.value = { seats: SEATS };
    snapshot.throws = true;
    expect(legacyJudgeSeatLanes({ producerFamily: 'xai', nowMs: Date.now() }).lanes).toEqual([]);
    snapshot.throws = false;
    budget.throws = true;
    expect(legacyJudgeSeatLanes({ producerFamily: 'xai', nowMs: Date.now() }).lanes).toEqual([]);
    budget.throws = false;
    expect(legacyJudgeSeatLanes({ producerFamily: 'unknown', nowMs: Date.now() }).lanes).toEqual([]);
    expect(routeSeat).not.toHaveBeenCalled();
  });

  it('a router that admits nothing admits no lane', () => {
    routeSeat.mockReturnValue({ candidates: [], exclusions: [] });
    expect(legacyJudgeSeatLanes({ producerFamily: 'local', nowMs: Date.now() }).lanes).toEqual([]);
  });
});
