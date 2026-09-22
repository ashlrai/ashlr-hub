/**
 * CapacityStrip.test.tsx — the two-second read, pinned where it would
 * otherwise mislead: a state carried by color alone, a percentage printed for
 * a flagged limit, a prose reset rendered as a countdown, and an unreachable
 * runtime drawn as zero headroom.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountCardModel, WindowView } from './accounts-model.js';
import { buildCapacityOverview } from './capacity-model.js';
import { CapacityStrip } from './CapacityStrip.js';

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
    verdict: { state: 'available', headline: 'Usable now', detail: 'd', code: null },
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

function strip(cards: AccountCardModel[], onSelect: ((id: string) => void) | null = null): void {
  render(
    <CapacityStrip
      overview={buildCapacityOverview({ cards, localCard: null, localView: null, nowMs: NOW })}
      selectedId={null}
      onSelectSeat={onSelect}
    />,
  );
}

describe('CapacityStrip', () => {
  it('states every seat with a WORD, never with color alone', () => {
    strip([
      card({ id: 'a', label: 'Codex A', binding: window({ id: 'codex', usedPct: 40 }) }),
      card({
        id: 'b',
        label: 'Codex B',
        verdict: { state: 'exhausted', headline: 'Limit reached', detail: 'd', code: null },
      }),
      card({
        id: 'c',
        label: 'Claude',
        verdict: { state: 'unknown', headline: 'No reading', detail: 'd', code: null },
      }),
    ]);
    expect(screen.getByText('usable')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('no reading')).toBeInTheDocument();
  });

  it('prints no percentage for a flagged limit, because the sentinel is not a measurement', () => {
    strip([
      card({
        id: 'b',
        label: 'Codex B',
        verdict: { state: 'exhausted', headline: 'Limit reached', detail: 'd', code: null },
        binding: window({ id: 'codex', usedPct: null, limitReached: true, measured: false }),
      }),
    ]);
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
  });

  it('prints a real binding percentage when there is one', () => {
    strip([card({ id: 'a', label: 'Codex A', binding: window({ id: 'codex', usedPct: 73 }) })]);
    expect(screen.getByText('73%')).toBeInTheDocument();
  });

  /**
   * Claude's resetsAt is structurally null. Its reset sentence must appear
   * verbatim under its own heading and must never become a countdown.
   */
  it('renders a prose-only reset verbatim, under a heading that says it is text', () => {
    strip([
      card({
        id: 'claude',
        label: 'Claude',
        allWindows: [
          window({ id: 'seven_day', resetText: 'resets Sep 25 at 7pm (America/New_York)' }),
        ],
      }),
    ]);
    expect(screen.getByText('Resets reported as text')).toBeInTheDocument();
    expect(
      screen.getByText(/resets Sep 25 at 7pm \(America\/New_York\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/never turned into a countdown/)).toBeInTheDocument();
  });

  it('says a missing dated reset is absent rather than "never"', () => {
    strip([card({ id: 'a', label: 'Codex A' })]);
    expect(screen.getByText(/absent timestamp, not "never"/)).toBeInTheDocument();
  });

  it('says an elapsed reset predates the rollover instead of counting down past zero', () => {
    strip([
      card({
        id: 'a',
        label: 'Codex A',
        allWindows: [window({ id: 'codex', resetsAt: '2026-09-20T09:00:00.000Z' })],
      }),
    ]);
    expect(screen.getByText(/predates the rollover/)).toBeInTheDocument();
  });

  /**
   * The regression this pins: `buildCapacityOverview` bakes `inMs`/`overdue`
   * in at build time, and it is memoized on the ACCOUNT DATA. The strip armed
   * a 30s interval whose own comment says "a countdown that does not tick is
   * worse than no countdown" — and then re-rendered the same frozen number
   * every 30 seconds forever, because nothing recomputed the elapsed time.
   * `sameData` reference-preservation in the cache made even pressing Refresh
   * fail to advance it.
   */
  describe('the countdown is derived from a live clock, not from the model', () => {
    it('counts down as time passes', () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.parse('2026-09-20T10:00:00.000Z');
        vi.setSystemTime(startedAt);
        render(
          <CapacityStrip
            overview={buildCapacityOverview({
              cards: [
                card({
                  id: 'a',
                  label: 'Codex A',
                  // Two hours and one minute out, so the printed form is
                  // `2h 1m` now and `1h 59m` after two minutes.
                  allWindows: [window({ id: 'codex', resetsAt: '2026-09-20T12:01:00.000Z' })],
                }),
              ],
              localCard: null,
              localView: null,
              nowMs: startedAt,
            })}
            selectedId={null}
            onSelectSeat={null}
          />,
        );
        expect(screen.getByText('2h 1m')).toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(120_000);
        });
        expect(screen.queryByText('2h 1m')).not.toBeInTheDocument();
        expect(screen.getByText('1h 59m')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('switches to the overdue copy once the instant actually passes', () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.parse('2026-09-20T10:00:00.000Z');
        vi.setSystemTime(startedAt);
        render(
          <CapacityStrip
            overview={buildCapacityOverview({
              cards: [
                card({
                  id: 'a',
                  label: 'Codex A',
                  // 40s out: ahead of us when the model is built, behind us a
                  // minute later. The model still says `overdue: false`.
                  allWindows: [window({ id: 'codex', resetsAt: '2026-09-20T10:00:40.000Z' })],
                }),
              ],
              localCard: null,
              localView: null,
              nowMs: startedAt,
            })}
            selectedId={null}
            onSelectSeat={null}
          />,
        );
        expect(screen.queryByText(/predates the rollover/)).not.toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByText(/predates the rollover/)).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('never reports local headroom as zero when no local source answered', () => {
    strip([card({ id: 'a' })]);
    expect(screen.getByText('No local source answered.')).toBeInTheDocument();
  });

  it('opens a seat detail when its chip is pressed', async () => {
    const onSelect = vi.fn();
    strip([card({ id: 'codex-a', label: 'Codex A' })], onSelect);
    await userEvent.click(screen.getByRole('button', { name: /Codex A/ }));
    expect(onSelect).toHaveBeenCalledWith('codex-a');
  });

  it('renders an inert chip when there is nothing to open', () => {
    strip([card({ id: 'codex-a', label: 'Codex A' })], null);
    expect(screen.queryByRole('button', { name: /Codex A/ })).not.toBeInTheDocument();
  });
});
