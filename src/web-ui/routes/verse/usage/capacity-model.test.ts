/**
 * capacity-model.test.ts — the top strip's claims, pinned at the four places
 * where the convenient summary would be a lie: an unread seat counted as
 * blocked, a prose reset turned into a countdown, an elapsed reset shown as
 * "soon", and a half-known memory budget reported as free headroom.
 */
import { describe, expect, it } from 'vitest';
import type { AccountCardModel, LocalCardModel, WindowView } from './accounts-model.js';
import type { LocalModelsView } from './local-model.js';
import {
  CAPACITY_CLASS,
  buildCapacityOverview,
  capacityHeadline,
  collectResets,
  formatUntil,
  nextReset,
} from './capacity-model.js';

const NOW = Date.parse('2026-09-20T10:00:00.000Z');

function window(over: Partial<WindowView> & { id: string }): WindowView {
  return {
    label: over.id,
    usedPct: null,
    tone: 'ok',
    resetText: null,
    resetsAt: null,
    limitReached: false,
    measured: true,
    ...over,
  };
}

function card(over: Partial<AccountCardModel> & { id: string }): AccountCardModel {
  return {
    label: over.id,
    engine: 'codex',
    color: 'var(--engine-codex)',
    plan: null,
    verdict: { state: 'available', headline: 'Usable now', detail: 'because', code: null },
    allWindows: [],
    evidence: {
      state: 'observed',
      authentication: 'signed-in',
      health: null,
      reasonCode: null,
      observedAt: null,
      notes: [],
      unsupported: null,
    },
    binding: null,
    others: [],
    credits: null,
    reconnectCommand: null,
    observedAt: null,
    rank: 0,
    hasDetail: true,
    sourceNote: null,
    ...over,
  };
}

describe('CAPACITY_CLASS — "nobody looked" is not "blocked"', () => {
  it('counts an unread seat in its own bucket', () => {
    expect(CAPACITY_CLASS.unknown).toBe('unread');
  });

  it('treats signed-out and a version-pinned probe as blocked, because the cause is known', () => {
    expect(CAPACITY_CLASS['signed-out']).toBe('blocked');
    expect(CAPACITY_CLASS['probe-unsupported']).toBe('blocked');
  });

  it('treats a spendable credit balance as ready, never as exhausted', () => {
    expect(CAPACITY_CLASS.credits).toBe('ready');
  });
});

describe('capacityHeadline', () => {
  it('never claims anything about a seat nobody read', () => {
    const line = capacityHeadline({ ready: 0, tight: 0, blocked: 1, unread: 2, total: 3, local: null });
    expect(line).toContain('2 seats have no reading yet');
    expect(line).not.toContain('3 blocked');
  });

  it('says an empty roster is empty rather than reporting zeros', () => {
    const line = capacityHeadline({ ready: 0, tight: 0, blocked: 0, unread: 0, total: 0, local: null });
    expect(line).toBe('No seats found.');
  });

  it('leads with what is usable when anything is', () => {
    expect(
      capacityHeadline({ ready: 2, tight: 1, blocked: 1, unread: 0, total: 4, local: null }),
    ).toMatch(/^2 of 4 seats are usable right now\./);
  });

  it('reports an unreachable local runtime as unknown, not as zero capacity', () => {
    const line = capacityHeadline({
      ready: 1,
      tight: 0,
      blocked: 0,
      unread: 0,
      total: 1,
      local: {
        reachable: false,
        residentCount: 0,
        installedCount: 0,
        agenticCount: 0,
        unknownToolCount: 0,
        residentBytes: null,
        memoryBudgetBytes: null,
        headroomBytes: null,
        freeMemoryBytes: null,
        usedPct: null,
      },
    });
    expect(line).toContain('local capacity is unknown');
  });
});

describe('collectResets — two channels that must never merge', () => {
  it('only a machine-readable resetsAt becomes a dated instant', () => {
    const { instants, prose } = collectResets(
      [
        {
          label: 'Claude',
          windows: [
            // Claude's resetsAt is structurally null; the sentence is all there is.
            window({ id: 'seven_day', resetText: 'resets Sep 25 at 7pm (America/New_York)' }),
          ],
        },
        {
          label: 'Codex A',
          windows: [window({ id: 'codex', resetsAt: '2026-09-20T12:00:00.000Z' })],
        },
      ],
      NOW,
    );
    expect(instants).toHaveLength(1);
    expect(instants[0]?.seatLabel).toBe('Codex A');
    expect(prose).toHaveLength(1);
    expect(prose[0]?.text).toBe('resets Sep 25 at 7pm (America/New_York)');
  });

  it('marks an elapsed reset overdue rather than reporting a negative countdown', () => {
    const { instants } = collectResets(
      [{ label: 'Codex A', windows: [window({ id: 'codex', resetsAt: '2026-09-20T09:00:00.000Z' })] }],
      NOW,
    );
    expect(instants[0]?.overdue).toBe(true);
    expect(formatUntil(instants[0]?.inMs ?? 0)).toBe('overdue');
  });

  it('falls back to prose when resetsAt is present but unparseable', () => {
    const { instants, prose } = collectResets(
      [{ label: 'X', windows: [window({ id: 'w', resetsAt: 'not-a-date', resetText: 'soon-ish' })] }],
      NOW,
    );
    expect(instants).toHaveLength(0);
    expect(prose[0]?.text).toBe('soon-ish');
  });
});

describe('nextReset', () => {
  const at = (iso: string, overdue: boolean) => ({
    seatLabel: 's',
    windowLabel: 'w',
    atMs: Date.parse(iso),
    inMs: Date.parse(iso) - NOW,
    overdue,
  });

  it('picks the soonest reset still ahead of us', () => {
    const chosen = nextReset([
      at('2026-09-21T10:00:00.000Z', false),
      at('2026-09-20T11:00:00.000Z', false),
    ]);
    expect(chosen?.atMs).toBe(Date.parse('2026-09-20T11:00:00.000Z'));
  });

  it('never picks an overdue instant over one still ahead', () => {
    const chosen = nextReset([
      at('2026-09-20T09:00:00.000Z', true),
      at('2026-09-20T18:00:00.000Z', false),
    ]);
    expect(chosen?.overdue).toBe(false);
  });

  it('returns the most recent overdue one when everything has elapsed, rather than nothing', () => {
    const chosen = nextReset([
      at('2026-09-19T09:00:00.000Z', true),
      at('2026-09-20T09:00:00.000Z', true),
    ]);
    expect(chosen?.atMs).toBe(Date.parse('2026-09-20T09:00:00.000Z'));
  });

  it('returns null when nothing dated was reported', () => {
    expect(nextReset([])).toBeNull();
  });
});

describe('buildCapacityOverview', () => {
  const localView = (over: Partial<LocalModelsView> = {}): LocalModelsView => ({
    reachable: true,
    reason: null,
    rows: [],
    residentBytes: 0,
    memoryBudgetBytes: 128 * 1024 ** 3,
    memoryUsedPct: 0,
    freeMemoryBytes: 64 * 1024 ** 3,
    runtimes: [],
    notes: [],
    agenticCount: 3,
    nonAgenticCount: 1,
    unknownToolCount: 2,
    ...over,
  });

  const localCard = (over: Partial<LocalCardModel> = {}): LocalCardModel => ({
    residentCount: 0,
    installedCount: 6,
    residentBytes: 0,
    memoryBudgetBytes: 128 * 1024 ** 3,
    usedPct: 0,
    tone: 'ok',
    verdict: { state: 'tight', headline: 'Installed, not loaded', detail: 'x', code: null },
    color: 'var(--engine-local)',
    rank: 2,
    ...over,
  });

  it('gives a flagged limit no percentage, because the sentinel 100 is not a reading', () => {
    const overview = buildCapacityOverview({
      cards: [
        card({
          id: 'codex-a',
          verdict: { state: 'exhausted', headline: 'Limit reached', detail: 'x', code: null },
          binding: window({ id: 'codex', usedPct: null, limitReached: true, measured: false }),
        }),
      ],
      localCard: null,
      localView: null,
      nowMs: NOW,
    });
    expect(overview.seats[0]?.usedPct).toBeNull();
    expect(overview.seats[0]?.measured).toBe(false);
    expect(overview.blocked).toBe(1);
  });

  it('carries a real measurement through to the chip', () => {
    const overview = buildCapacityOverview({
      cards: [card({ id: 'codex-a', binding: window({ id: 'codex', usedPct: 42 }) })],
      localCard: null,
      localView: null,
      nowMs: NOW,
    });
    expect(overview.seats[0]?.usedPct).toBe(42);
    expect(overview.ready).toBe(1);
  });

  it('withholds local headroom when only one side of the subtraction is known', () => {
    const overview = buildCapacityOverview({
      cards: [],
      localCard: localCard({ residentBytes: null, usedPct: null }),
      localView: localView({ residentBytes: null }),
      nowMs: NOW,
    });
    expect(overview.local?.headroomBytes).toBeNull();
  });

  it('computes headroom when both sides are known', () => {
    const overview = buildCapacityOverview({
      cards: [],
      localCard: localCard({ residentBytes: 28 * 1024 ** 3 }),
      localView: localView(),
      nowMs: NOW,
    });
    expect(overview.local?.headroomBytes).toBe(100 * 1024 ** 3);
  });

  it('flags no-capacity only when nothing is ready AND nothing is merely tight', () => {
    const blocked = buildCapacityOverview({
      cards: [
        card({
          id: 'a',
          verdict: { state: 'exhausted', headline: 'Window exhausted', detail: 'x', code: null },
        }),
      ],
      localCard: null,
      localView: null,
      nowMs: NOW,
    });
    expect(blocked.noCapacity).toBe(true);

    const tight = buildCapacityOverview({
      cards: [card({ id: 'a', verdict: { state: 'tight', headline: 'Running tight', detail: 'x', code: null } })],
      localCard: null,
      localView: null,
      nowMs: NOW,
    });
    expect(tight.noCapacity).toBe(false);
  });

  it('does not flag no-capacity over a roster that is entirely unread', () => {
    // Every seat came back `unknown`, which is the shape of a collector that
    // never ran — not of a set of exhausted accounts. Tinting the headline as a
    // warning here asserts something about seats nobody measured.
    const unread = buildCapacityOverview({
      cards: [
        card({
          id: 'a',
          verdict: { state: 'unknown', headline: 'No reading', detail: 'x', code: null },
        }),
        card({
          id: 'b',
          verdict: { state: 'unknown', headline: 'No reading', detail: 'x', code: null },
        }),
      ],
      localCard: null,
      localView: null,
      nowMs: NOW,
    });
    expect(unread.unread).toBe(2);
    expect(unread.noCapacity).toBe(false);
  });

  it('still flags no-capacity when a roster is only PARTLY unread', () => {
    // One seat is measured and blocked. That is a real constraint, and the
    // unread one alongside it does not soften it.
    const mixed = buildCapacityOverview({
      cards: [
        card({
          id: 'a',
          verdict: { state: 'exhausted', headline: 'Window exhausted', detail: 'x', code: null },
        }),
        card({
          id: 'b',
          verdict: { state: 'unknown', headline: 'No reading', detail: 'x', code: null },
        }),
      ],
      localCard: null,
      localView: null,
      nowMs: NOW,
    });
    expect(mixed.noCapacity).toBe(true);
  });

  it('sorts the local seat into the same roster the cloud seats are counted in', () => {
    const overview = buildCapacityOverview({
      cards: [card({ id: 'codex-a' })],
      localCard: localCard(),
      localView: localView(),
      nowMs: NOW,
    });
    expect(overview.total).toBe(2);
    expect(overview.seats.map((s) => s.kind)).toEqual(['account', 'local']);
    expect(overview.tight).toBe(1);
  });
});

describe('formatUntil', () => {
  it('never prints a negative duration', () => {
    expect(formatUntil(-5_000)).toBe('overdue');
    expect(formatUntil(0)).toBe('overdue');
  });

  it('degrades to days and hours for a weekly window', () => {
    expect(formatUntil(5 * 86_400_000 + 3 * 3_600_000)).toBe('5d 3h');
    expect(formatUntil(90 * 60_000)).toBe('1h 30m');
    expect(formatUntil(45 * 1000)).toBe('45s');
  });
});
