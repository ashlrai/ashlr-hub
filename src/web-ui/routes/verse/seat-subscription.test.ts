/**
 * seat-subscription.test.ts — the projection behind every seat shown in the
 * Chat section.
 *
 * The fixtures are Mason's REAL roster as measured against a live server on
 * 2026-09-19 (docs/VERSE-TELEMETRY-V2.md). Every test below pins a place where
 * the obvious projection would have told him something false about it.
 */
import { describe, expect, it } from 'vitest';
import { describeResetAt } from '../../../core/verse/seat-readiness.js';
import type { VerseSeat } from '../../data/api-types.js';
import { seatCapacity } from './verse-model.js';
import {
  evidenceNote,
  formatResetInstant,
  seatCapacityWindowLabel,
  seatSubscription,
  seatSubscriptionSentence,
  worthFlagging,
} from './seat-subscription.js';
import {
  CLAUDE_MAX_SEAT,
  CLAUDE_TIGHT_SEAT,
  CODEX_CREDITS_SEAT,
  GROK_SEAT,
  LOCAL_SEAT_V2,
  UNREAD_SEAT,
  capacity,
  nativeSeat,
  seatWindow,
} from './seat-fixtures.test-support.js';

describe('seatSubscription — the binding window leads', () => {
  it('takes the server’s binding choice, not the first or the roomiest window', () => {
    const view = seatSubscription(CLAUDE_MAX_SEAT);
    // 85% all-models would have been the comforting number to lead with. The
    // per-model week is what actually blocks the turn.
    expect(view.binding?.id).toBe('seven_day_fable');
    expect(view.others.map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
    expect(view.plan).toBe('max');
    expect(view.extended).toBe(true);
  });

  it('calls a flagged limit "limit reached" and publishes no percentage for it', () => {
    const view = seatSubscription(CLAUDE_MAX_SEAT);
    expect(view.binding?.limitReached).toBe(true);
    // The sentinel 100 upstream is a flag, not a measurement.
    expect(view.binding?.usedPercent).toBeNull();
    expect(view.summary).toBe('weekly fable window limit reached');
    expect(view.cls).toBe('blocked');
    expect(view.word).toBe('blocked');
  });

  it('reports a measured binding window as a percentage of that window', () => {
    const view = seatSubscription(CLAUDE_TIGHT_SEAT);
    expect(view.cls).toBe('tight');
    expect(view.summary).toBe('92% of weekly fable window used');
    expect(view.binding?.usedPercent).toBe(92);
  });

  it('renders a prose reset verbatim and never parses it', () => {
    const view = seatSubscription(CLAUDE_MAX_SEAT);
    expect(view.binding?.resetText).toBe('resets Sep 25 at 7pm (America/New_York)');
    expect(view.binding?.resetsAt).toBeNull();
    expect(view.others[0]?.resetText).toBe('resets Sep 21 at 1:40am (America/New_York)');
  });

  it('formats a machine-readable reset, and only a machine-readable one', () => {
    const view = seatSubscription(GROK_SEAT);
    expect(view.binding?.resetsAt).toBe('2026-09-26T12:43:50.000Z');
    expect(view.binding?.resetText).toMatch(/^resets /);
    expect(view.cls).toBe('ready');
    expect(view.summary).toBe('1% of unified weekly window used');
  });

  it('words a machine reset exactly as describeResetAt does everywhere else — one reset wording, against the clock it is given', () => {
    // Local instants: "today" / a weekday / a date, whatever zone the suite runs in.
    const now = new Date(2026, 8, 24, 9, 0).getTime();
    const tonight = new Date(2026, 8, 24, 23, 46).toISOString();
    const tomorrow = new Date(2026, 8, 25, 23, 46).toISOString();
    const later = new Date(2026, 9, 20, 23, 46).toISOString();
    expect(formatResetInstant(tonight, now)).toBe(`resets ${describeResetAt(tonight, now)}`);
    expect(formatResetInstant(tonight, now)).toMatch(/^resets today /);
    expect(formatResetInstant(tomorrow, now)).toBe(`resets ${describeResetAt(tomorrow, now)}`);
    expect(formatResetInstant(later, now)).toBe(`resets ${describeResetAt(later, now)}`);
    // Never the retired second wording ("resets Sep 25 at 11:46 PM").
    for (const iso of [tonight, tomorrow, later]) expect(formatResetInstant(iso, now)).not.toMatch(/ at /);
    expect(formatResetInstant('not a date', now)).toBeNull();

    // The projection threads the same clock through, so the words are a
    // function of the inputs — never of the day the suite happens to run.
    const w = seatWindow({ id: 'codex_codex_primary', usedPercent: 40, resetsAt: tomorrow });
    const seat = nativeSeat(capacity({ windows: [w], binding: w, usability: 'ready' }), { id: 'codex', engine: 'codex', label: 'Codex' });
    expect(seatSubscription(seat, now).binding?.resetText).toBe(`resets ${describeResetAt(tomorrow, now)}`);
    const aDayLater = new Date(2026, 8, 25, 9, 0).getTime();
    expect(seatSubscription(seat, aDayLater).binding?.resetText).toBe(`resets ${describeResetAt(tomorrow, aDayLater)}`);
    expect(seatSubscription(seat, aDayLater).binding?.resetText).toMatch(/^resets today /);
  });

  it('prints the summary by the one percent rule — never "100%" short of spent, never "0%" for a real reading', () => {
    const at = (usedPercent: number) => {
      const w = seatWindow({ id: 'codex_codex_primary', usedPercent });
      return seatSubscription(nativeSeat(capacity({ windows: [w], binding: w, usability: 'tight' }), { id: 'codex', engine: 'codex', label: 'Codex' }));
    };
    expect(at(99.6).summary).toBe('99% of primary window used');
    expect(at(0.4).summary).toBe('<1% of primary window used');
    expect(at(62.4).summary).toBe('62% of primary window used');
    expect(at(100).summary).toBe('100% of primary window used');
  });
});

describe('seatCapacityWindowLabel', () => {
  it('strips the provider’s own name off its window ids, however often it repeats', () => {
    expect(seatCapacityWindowLabel('codex', 'codex_codex_primary')).toBe('primary window');
    expect(seatCapacityWindowLabel('grok', 'grok_unified_weekly')).toBe('unified weekly window');
    expect(seatCapacityWindowLabel('claude', 'five_hour')).toBe('5-hour window');
    expect(seatCapacityWindowLabel('claude', 'seven_day')).toBe('weekly window');
  });
});

describe('seatSubscription — credits are not the window', () => {
  it('does not report a spent Codex week with a spendable balance as blocked', () => {
    const view = seatSubscription(CODEX_CREDITS_SEAT);
    expect(view.cls).toBe('tight');
    expect(view.summary).toBe('primary window limit reached · credits still spendable');
    // Rounded for the line, raw kept for the tooltip — no precision invented.
    expect(view.credits).toBe('2048.42 credits left');
    expect(view.creditsTitle).toBe('2048.4196250000');
  });

  it('reports the same window as blocked when the server says exhausted', () => {
    const window = seatWindow({ id: 'codex_codex_primary', usedPercent: 100, limitReached: true, measured: false });
    const view = seatSubscription(nativeSeat(capacity({
      planType: 'pro',
      windows: [window],
      binding: window,
      usability: 'exhausted',
    }), { engine: 'codex', label: 'Work Codex' }));
    expect(view.cls).toBe('blocked');
    expect(view.summary).toBe('primary window limit reached');
    expect(view.credits).toBeNull();
  });
});

describe('seatSubscription — no signal is never zero', () => {
  it('labels a retained degraded meter as historical in chat and hides old credit spendability', () => {
    const prior = CODEX_CREDITS_SEAT;
    const seat = { ...prior, health: { ...prior.health, state: 'degraded' as const },
      capacity: { ...prior.capacity!, usability: 'unknown' as const } };
    const view = seatSubscription(seat);
    expect(view.cls).toBe('unread');
    expect(view.summary).toMatch(/^Last verified reading: .*current access unconfirmed$/);
    expect(view.credits).toBeNull();
    expect(seatSubscriptionSentence(seat, view)).toContain('Last verified reading:');
  });

  it('hides old credit spendability even when the failed check retained no percentage', () => {
    const prior = CODEX_CREDITS_SEAT;
    const window = seatWindow({ id: 'codex_codex_primary', usedPercent: null });
    const seat = { ...prior, health: { ...prior.health, state: 'degraded' as const },
      capacity: { ...prior.capacity!, windows: [window], binding: null, usability: 'unknown' as const } };
    const view = seatSubscription(seat);
    expect(view.binding).toBeNull();
    expect(view.summary).toBe('No current capacity reading; current access unconfirmed');
    expect(view.credits).toBeNull();
  });

  it('reports an unread account as unread, with no binding window to meter', () => {
    const view = seatSubscription(UNREAD_SEAT);
    expect(view.cls).toBe('unread');
    expect(view.binding).toBeNull();
    expect(view.summary).toBe('no capacity reading');
    // The provider's own plain-language fact travels so the panel can show it.
    expect(view.notes).toEqual(['No probe has run for this account yet in this server.']);
  });

  it('keeps a window with no percentage out of the meter entirely', () => {
    const view = seatSubscription(nativeSeat(capacity({
      windows: [seatWindow({ id: 'five_hour', usedPercent: null })],
      usability: 'unknown',
    })));
    expect(view.binding).toBeNull();
    expect(view.others[0]?.usedPercent).toBeNull();
    expect(view.cls).toBe('unread');
  });

  it('says what to DO about a signed-out account rather than "seat unavailable"', () => {
    // Owner S maps signed-out onto health.state 'unavailable' — the one
    // account state worth a red dot, because it has a remedy. The generic
    // reason there says nothing about the fix, so the verdict wins.
    const view = seatSubscription(nativeSeat(capacity({ usability: 'signed-out' }), {
      health: { state: 'unavailable', summary: null, windows: [], observedAt: null },
    }));
    expect(view.cls).toBe('blocked');
    expect(view.summary).toBe('signed out — reconnect this account');
  });
});

describe('seatSubscription — provenance is part of the claim', () => {
  it('stays silent about a live collector reading and speaks up about every other kind', () => {
    expect(evidenceNote('collector')).toBeNull();
    expect(evidenceNote('shared-evidence')).toMatch(/not probed here/);
    expect(evidenceNote('baseline')).toMatch(/not a live reading/);
    expect(evidenceNote('none')).toMatch(/nothing here was measured/);
    // The V1 fallback path has no provenance to report, and invents none.
    expect(evidenceNote(null)).toBeNull();
  });

  it('carries the evidence source and the observation instant off the record', () => {
    const view = seatSubscription(CLAUDE_MAX_SEAT);
    expect(view.evidenceSource).toBe('collector');
    expect(view.observedAt).toBe('2026-09-20T18:32:00.000Z');
  });
});

describe('seatSubscription — local seats have no subscription', () => {
  it('gives a local seat its readiness and nothing that implies a quota', () => {
    const view = seatSubscription(LOCAL_SEAT_V2);
    expect(view.kind).toBe('local');
    expect(view.plan).toBeNull();
    expect(view.binding).toBeNull();
    expect(view.others).toEqual([]);
    expect(view.credits).toBeNull();
    expect(view.cls).toBe('ready');
    expect(view.summary).toBe('runs on this machine');
  });
});

/**
 * `capacity` is absent for a native seat the server could not build a record
 * for. The seat selector and the composer's seat menu already render
 * `verse-model.seatCapacity`'s exact words on that path, and two
 * implementations of one rule is how the picker and the panel would drift
 * apart again — so the fallback is pinned to produce the same verdict and the
 * same phrase.
 */
describe('seatSubscription — parity with the V1 rule when no capacity record exists', () => {
  const legacy = (windows: Array<{ id: string; usedPercent: number | null; resetsAt: string | null }>, over: Partial<VerseSeat> = {}): VerseSeat => ({
    id: 'claude',
    engine: 'claude',
    label: 'Claude Max',
    accountId: 'claude',
    models: [{ id: 'claude-opus-5', label: 'Opus 5', contextWindow: 200_000 }],
    contextWindow: 200_000,
    ...over,
    health: { state: 'unknown', summary: null, windows, observedAt: null, ...(over.health ?? {}) },
  });

  const cases: Array<Array<{ id: string; usedPercent: number | null; resetsAt: string | null }>> = [
    [{ id: '5h', usedPercent: 12, resetsAt: null }],
    [{ id: 'five_hour', usedPercent: 12, resetsAt: null }, { id: 'seven_day_fable', usedPercent: 92, resetsAt: null }],
    [{ id: 'seven_day', usedPercent: 100, resetsAt: null }],
    [{ id: 'seven_day', usedPercent: null, resetsAt: null }],
    [],
  ];

  it.each(cases)('agrees with seatCapacity on %j', (...windows) => {
    const seat = legacy(windows as Array<{ id: string; usedPercent: number | null; resetsAt: string | null }>);
    const view = seatSubscription(seat);
    const old = seatCapacity(seat);
    expect(view.cls).toBe(old.cls);
    expect(view.summary).toBe(old.text);
    expect(view.extended).toBe(false);
    expect(view.evidenceSource).toBeNull();
  });

  it('keeps an unavailable seat blocked, with the reason as the summary', () => {
    const seat = legacy([], { health: { state: 'unavailable', summary: 'quota exhausted until 14:00', windows: [], observedAt: null } });
    const view = seatSubscription(seat);
    expect(view.cls).toBe('blocked');
    expect(view.summary).toBe('quota exhausted until 14:00');
  });
});

describe('seatSubscriptionSentence / worthFlagging', () => {
  it('names the seat, the plan, the verdict, the evidence and the reset', () => {
    const view = seatSubscription(CLAUDE_MAX_SEAT);
    expect(seatSubscriptionSentence(CLAUDE_MAX_SEAT, view)).toBe(
      'Claude Max · max · blocked · weekly fable window limit reached · resets Sep 25 at 7pm (America/New_York)',
    );
  });

  it('flags only the states that change what the operator would do', () => {
    expect(worthFlagging('blocked')).toBe(true);
    expect(worthFlagging('tight')).toBe(true);
    expect(worthFlagging('ready')).toBe(false);
    // An unread seat is not a warning: nobody observed anything about it.
    expect(worthFlagging('unread')).toBe(false);
  });
});
