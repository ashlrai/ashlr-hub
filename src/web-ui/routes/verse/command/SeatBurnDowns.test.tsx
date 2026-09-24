/**
 * Seat burn-down cards (review 3.10 c17 + d2): the weekly axis carries dates,
 * and a 5-hour chart draws the 5-hour ceiling — so its verdict agrees with the
 * server's eligibility instead of claiming autonomy stopped at the weekly
 * reserve.
 *
 * 3.10.1: every paid card shares one frame — 0–100% up the side and the
 * WINDOW along the bottom (reset − length → reset, or the window's length
 * ending now when no reset is placed), never the span of the readings. The
 * live Claude card drew one minute of samples on a 0–40% axis.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { reasonSentence } from '../../../../core/routing/seat-reasons.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { SeatBurnCard } from './SeatBurnDowns.js';
import { burnTimeFormat, recordReading, resetInstantFromWords, seatBurns, type SeatBurn } from './command-model.js';
import { budgetView } from './fixtures.test-support.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function burn(over: Partial<SeatBurn>): SeatBurn {
  return {
    seatId: 'claude-a',
    label: 'Claude',
    engine: 'claude',
    window: 'weekly',
    points: [],
    start: null,
    resetAt: null,
    resetFrom: null,
    resetText: null,
    reservePercent: 40,
    line: { value: 40, label: 'Reserved for you' },
    enabled: true,
    free: false,
    eligible: true,
    reason: null,
    recorded: false,
    ...over,
  };
}

/** "Sep 18" — the chart kit's shortest time label (its ladder's last rung). */
function day(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Every text drawn inside the plot, in document order. */
function svgTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent ?? '');
}

/** The y-axis range, read from the tick labels ("0%" … "100%"). */
function percentTicks(container: HTMLElement): { min: number; max: number } {
  const ticks = svgTexts(container).filter((l) => /^\d+%$/.test(l)).map((l) => Number(l.slice(0, -1)));
  return { min: Math.min(...ticks), max: Math.max(...ticks) };
}

/** The x of every vertex in an "M x,y L x,y …" path. */
function pathXs(d: string): number[] {
  return Array.from(d.matchAll(/[ML](-?[\d.]+),/g)).map((m) => Number(m[1]));
}

describe('SeatBurnCard', () => {
  // 360 px: wide enough for the full date-and-time labels (at 320 the kit
  // steps down to the date alone — see the words-placed test below).
  it('weekly: the start and reset labels differ (they carry the date)', () => {
    const resetAt = NOW + 2 * 24 * HOUR;
    const { container } = render(
      <SeatBurnCard burn={burn({ start: resetAt - 7 * 24 * HOUR, resetAt, resetFrom: 'provider', points: [{ t: NOW - HOUR, remaining: 70 }, { t: NOW, remaining: 68 }] })} now={NOW} width={360} />,
    );
    const fmt = burnTimeFormat('weekly');
    const labels = svgTexts(container);
    // The window start (7 days earlier) is on the same weekday and time, so
    // only the date tells them apart. Local time: Sep 19 in New York, Sep 20
    // in Tokyo — compared as formatted, never as a hard-coded day.
    const startLabel = fmt(resetAt - 7 * 24 * HOUR);
    expect(startLabel).toContain(day(resetAt - 7 * 24 * HOUR));
    expect(labels).toContain(startLabel);
    expect(labels).toContain(`Resets ${fmt(resetAt)}`);
    expect(startLabel).not.toBe(fmt(resetAt));
    // The reset is written once — as the marker — never again as a plain end label.
    expect(labels.filter((l) => l.includes(fmt(resetAt)))).toHaveLength(1);
  });

  it('5-hour binding: 35% remaining is above the 70% ceiling, so it never says autonomy stopped', () => {
    // Review scenario: weekly 20% used, 5-hour 65% used → server: session binds, eligible.
    const resetAt = NOW + 2 * HOUR;
    render(
      <SeatBurnCard
        burn={burn({ window: 'session', start: resetAt - 5 * HOUR, resetAt, resetFrom: 'provider', line: { value: 30, label: '5-hour ceiling' }, points: [{ t: NOW - 30 * MIN, remaining: 36 }, { t: NOW, remaining: 35 }] })}
        now={NOW}
        width={320}
      />,
    );
    expect(screen.getByText('Autonomy may use it now')).toBeInTheDocument();
    expect(screen.queryByText(/Inside .* autonomy has stopped/)).toBeNull();
    expect(screen.queryByText(/Reserved for you/)).toBeNull();
  });

  // P4 regression: Claude windows carry readings but no machine reset time.
  // The card used to say "No window reading" whenever resetAt was null. Words
  // the model could not place (here: a 5-hour reset 6 h away) still draw the
  // readings and the words — with no reset marker or projection.
  it('unplaced reset words: shows the reading and the provider\'s words, and projects nothing', () => {
    const { container } = render(
      <SeatBurnCard
        burn={burn({ window: 'session', line: { value: 30, label: '5-hour ceiling' }, resetText: 'Sep 24 at 5pm (America/New_York)', points: [{ t: NOW - 30 * MIN, remaining: 30 }, { t: NOW, remaining: 26 }], eligible: false, reason: '5-hour window at 74% — above the 70% ceiling' })}
        now={NOW}
        width={320}
      />,
    );
    expect(screen.queryByText(/No window reading/)).toBeNull();
    const text = container.textContent ?? '';
    expect(text).toContain('26% left · resets Sep 24 at 5pm (America/New_York) · 5-hour window at 74% — above the 70% ceiling');
    expect(text).toContain("The provider's reset words could not be placed on a clock, so nothing is projected to a reset.");
    // No reset marker, no pace or projection line — nothing points at an instant nobody placed.
    expect(text).not.toMatch(/Resets /);
    expect(container.querySelector('[data-role="projection"]')).toBeNull();
    expect(container.querySelector('[data-role="pace"]')).toBeNull();
    // The readings ARE drawn, with the 5-hour ceiling as the stop line, on the shared axis.
    expect(text).toContain('5-hour ceiling');
    expect(container.querySelector('[data-role="remaining"] path')).not.toBeNull();
    expect(percentTicks(container)).toEqual({ min: 0, max: 100 });
  });

  // The live defect: "Claude Code · weekly" with a one-minute x-domain, a
  // 0–40% axis and "reported only in words" although the words name a time.
  it('reset placed from the provider\'s words: the full weekly window on 0–100%, pace, projection and one reset marker', () => {
    const now = Date.parse('2026-09-24T20:30:00Z'); // Thu 4:30 PM in New York
    const words = 'Sep 25 at 6:59pm (America/New_York)';
    const resetAt = resetInstantFromWords(words, now)!;
    expect(new Date(resetAt).toISOString()).toBe('2026-09-25T22:59:00.000Z');
    const start = resetAt - 7 * 24 * HOUR;
    const { container } = render(
      <SeatBurnCard
        burn={burn({
          label: 'Claude Code',
          start,
          resetAt,
          resetFrom: 'words',
          resetText: words,
          points: [{ t: now - 60_000, remaining: 4 }, { t: now - 30_000, remaining: 3 }, { t: now, remaining: 3 }],
          eligible: false,
          reason: 'The weekly window is 97% used; 40% is kept for you, so autonomy stops at 60%',
        })}
        now={now}
        width={320}
      />,
    );
    const text = container.textContent ?? '';
    // The header keeps the provider's words verbatim, so the placed reset can be checked against them.
    expect(text).toContain('3% left · resets Sep 25 at 6:59pm (America/New_York) · The weekly window is 97% used');
    expect(text).not.toMatch(/only in words|could not be placed/);
    // The line started watching days into the window, and the card says so.
    expect(text).toContain('Readings since Verse opened');
    // The x-domain is the whole window: its start on the left, ONE reset marker
    // on the right — at 320 px both as the kit's short date-only fallback,
    // which fits side by side where "Sep 18, 6:59 PM" + "Resets Sep 25, 6:59 PM" collided.
    const fmt = burnTimeFormat('weekly');
    const labels = svgTexts(container);
    expect(labels).toContain(day(start));
    expect(labels.filter((l) => l.startsWith('Resets'))).toEqual([`Resets ${day(resetAt)}`]);
    expect(labels).not.toContain(fmt(start));
    expect(labels.filter((l) => l === fmt(now) || l === fmt(now - 60_000) || l === day(now))).toEqual([]);
    // 0–100% like every sibling, with the 40% reserve drawn on it.
    expect(percentTicks(container)).toEqual({ min: 0, max: 100 });
    expect(container.querySelector('[data-role="reserve-label"]')?.textContent).toBe('Reserved for you · 40%');
    expect(container.querySelector('[data-role="pace"]')).not.toBeNull();
    expect(container.querySelector('[data-role="projection"]')).not.toBeNull();
  });

  it('reset unknown: the window\'s length ending now, never the span of a minute of readings', () => {
    const { container } = render(
      <SeatBurnCard burn={burn({ points: [{ t: NOW - 60_000, remaining: 4 }, { t: NOW - 30_000, remaining: 3 }, { t: NOW, remaining: 3 }] })} now={NOW} width={320} />,
    );
    const fmt = burnTimeFormat('weekly');
    // Exactly two axis labels, one per end — no stacked per-reading labels.
    expect(svgTexts(container).filter((l) => !/%/.test(l))).toEqual([fmt(NOW - 7 * 24 * HOUR), 'Now']);
    expect(percentTicks(container)).toEqual({ min: 0, max: 100 });
    expect(container.querySelector('[data-role="reserve-label"]')?.textContent).toBe('Reserved for you · 40%');
    // A minute of readings sits at the right edge of a 7-day axis (320 px wide: the plot ends at x = 306).
    const xs = pathXs(container.querySelector('[data-role="remaining"] path:last-child')?.getAttribute('d') ?? '');
    expect(xs).toHaveLength(3);
    expect(Math.min(...xs)).toBeGreaterThan(300);
    expect(container.querySelector('[data-role="pace"]')).toBeNull();
    expect(svgTexts(container).some((l) => l.startsWith('Resets'))).toBe(false);
  });

  it('no machine reset and no words: says the reset was not reported', () => {
    render(<SeatBurnCard burn={burn({ window: 'weekly', points: [{ t: NOW, remaining: 46 }] })} now={NOW} width={320} />);
    expect(screen.getByText(/46% left · reset time not reported · Autonomy may use it now/)).toBeInTheDocument();
    expect(screen.getByText(/No reset time was reported for this window/)).toBeInTheDocument();
  });

  // 3.10.1: recorded history (GET /api/verse/budget/history) fills the line
  // after a reload. The "since Verse opened" note is kept only for a line the
  // page drew alone; a recorded line that still starts late names the gap.
  it('recorded history that covers the window: the whole line, and no "since Verse opened" note', () => {
    const resetAt = NOW + 2 * 24 * HOUR;
    const start = resetAt - 7 * 24 * HOUR;
    const points = [start + 20 * 60_000, start + 2 * 24 * HOUR, NOW - HOUR, NOW].map((t, i) => ({ t, remaining: 90 - 10 * i }));
    const { container } = render(<SeatBurnCard burn={burn({ start, resetAt, resetFrom: 'provider', recorded: true, points })} now={NOW} width={360} />);
    expect(container.textContent).not.toMatch(/Readings since Verse opened|No reading was recorded/);
    // The line starts at the window's left edge, not at "now".
    const xs = pathXs(container.querySelector('[data-role="remaining"] path:last-child')?.getAttribute('d') ?? '');
    expect(xs.length).toBeGreaterThanOrEqual(4);
    expect(Math.min(...xs)).toBeLessThan(80);
  });

  it('recorded history that starts late says when, instead of blaming the page', () => {
    const resetAt = NOW + 2 * 24 * HOUR;
    const start = resetAt - 7 * 24 * HOUR;
    const first = NOW - 26 * HOUR;
    const { container } = render(
      <SeatBurnCard burn={burn({ start, resetAt, resetFrom: 'provider', recorded: true, points: [{ t: first, remaining: 70 }, { t: NOW, remaining: 60 }] })} now={NOW} width={360} />,
    );
    expect(container.textContent).toContain(`No reading was recorded in this window before ${burnTimeFormat('weekly')(first)}.`);
    expect(container.textContent).not.toContain('Readings since Verse opened');
  });

  it('a trailing window (no reset placed) takes the same note', () => {
    const late = render(<SeatBurnCard burn={burn({ recorded: true, points: [{ t: NOW - 2 * HOUR, remaining: 50 }, { t: NOW, remaining: 48 }] })} now={NOW} width={320} />);
    expect(late.container.textContent).toContain('No reading was recorded in this window before');
    late.unmount();
    const full = render(<SeatBurnCard burn={burn({ recorded: true, points: [{ t: NOW - 7 * 24 * HOUR + HOUR, remaining: 90 }, { t: NOW, remaining: 48 }] })} now={NOW} width={320} />);
    expect(full.container.textContent).not.toMatch(/No reading was recorded|Readings since Verse opened/);
  });

  it('still says "No window reading" when there is no reading at all', () => {
    render(<SeatBurnCard burn={burn({ window: 'session', points: [] })} now={NOW} width={320} />);
    expect(screen.getByText(/No window reading/)).toBeInTheDocument();
    render(<SeatBurnCard burn={burn({ window: null, points: [{ t: NOW, remaining: 50 }] })} now={NOW} width={320} />);
    expect(screen.getAllByText(/No window reading/)).toHaveLength(2);
  });
});

// Review 3.10.1 (high): a held-back card printed the router's LOG sentence —
// "… stops at 92% (resets 2026-09-26T03:46:56.000Z)." — in its header and
// aria-label, "(resets Sep 25 at 7pm (America/New_York))." for Claude, and
// the trailing window's aria-label closed it with a second period.
describe('SeatBurnCard — held-back reasons in words', () => {
  const RESET_ISO = '2026-09-26T03:46:56.000Z';
  const REASON = 'The weekly window is 92% used; 8% is kept for you, so autonomy stops at 92%.';

  /** The Codex card exactly as Command builds it from the budget route's wire reason. */
  function codexCard(resetAt: string | null): SeatBurn {
    const view = budgetView('live', NOW);
    view.headroom[2] = { ...view.headroom[2]!, weeklyUsedPercent: 92, resetAt, eligibleForAutonomy: false, reasons: [reasonSentence({ kind: 'reserve', text: REASON, resetsAt: RESET_ISO })] };
    view.effective['codex-a'] = { seatId: 'codex-a', enabled: true, reservePercent: 8 };
    return seatBurns(view, recordReading({}, view)).find((b) => b.seatId === 'codex-a')!;
  }

  it('reset placed: the header is the sentence alone — the chart marks the reset in local time', () => {
    const { container } = render(<SeatBurnCard burn={codexCard(RESET_ISO)} now={NOW} width={360} />);
    const text = container.textContent ?? '';
    expect(text).toContain('The weekly window is 92% used; 8% is kept for you, so autonomy stops at 92%');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T|\(resets|\.\./);
    expect(svgTexts(container).filter((l) => l.startsWith('Resets '))).toEqual([`Resets ${burnTimeFormat('weekly')(Date.parse(RESET_ISO))}`]);
    const aria = container.querySelector('svg[role="img"]')?.getAttribute('aria-label') ?? '';
    expect(aria).not.toMatch(/\d{4}-\d{2}-\d{2}T|\(resets|\.\./);
  });

  it('no reset placed: the reason keeps its reset in local time, and the aria-label ends on one period', () => {
    const burn = codexCard(null);
    expect(burn.resetAt).toBeNull();
    // The card has no reset marker here, so the reason says when — in the viewer's zone.
    const sampledAt = Date.parse(budgetView('live', NOW).sampledAt);
    expect(burn.reason).toBe(`${REASON} Resets ${describeResetAt(RESET_ISO, sampledAt)}.`);
    const { container } = render(<SeatBurnCard burn={burn} now={NOW} width={320} />);
    const aria = container.querySelector('svg[role="img"]')?.getAttribute('aria-label') ?? '';
    expect(aria.endsWith(` ${burn.reason}`)).toBe(true);
    expect(aria).not.toMatch(/\.\.|\d{4}-\d{2}-\d{2}T|\(resets/);
    // In the header's " · " list it is a clause: no closing full stop.
    const header = `8% left · reset time not reported · ${burn.reason!.slice(0, -1)}`;
    expect(container.textContent).toContain(header);
    expect(container.textContent).not.toContain(`${header}.`);
  });

  it('the free local seat states its reason as one sentence', () => {
    render(<SeatBurnCard burn={burn({ seatId: 'local-qwen', label: 'Local Qwen', engine: 'local', window: null, free: true, eligible: false, reason: 'The local model runtime is not reachable.' })} now={NOW} />);
    expect(screen.getByText('Local — free, no provider window. The local model runtime is not reachable.')).toBeInTheDocument();
  });
});
