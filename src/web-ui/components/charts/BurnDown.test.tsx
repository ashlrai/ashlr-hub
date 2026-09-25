import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BurnDown, burnVerdict, formatLead } from './BurnDown.js';
import { projectBurnDown } from './chart-math.js';
import { formatClockTime } from './format.js';
import { axisLabelBoxes, clearDisplaySize, noOverlap, setDisplaySize, showTable } from './chart-test-support.js';

const H = 3_600_000;
const START = Date.parse('2026-09-23T10:00:00Z');
const fmtT = (ms: number) => `T+${Math.round((ms - START) / H)}h`;
const pct = (v: number) => `${Math.round(v)}%`;

describe('BurnDown', () => {
  it('projects the reserve crossing and says it in words', () => {
    const points = [{ t: START, remaining: 100 }, { t: START + H, remaining: 85 }, { t: START + 2 * H, remaining: 70 }];
    const { container } = render(
      <BurnDown
        title="Claude 5-hour window"
        width={600}
        points={points}
        capacity={100}
        start={START}
        resetAt={START + 5 * H}
        now={START + 2 * H}
        reserve={{ value: 30, label: 'Reserve' }}
        formatValue={pct}
        formatTime={fmtT}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('At this pace: Reserve reached T+5h');
    expect(container.querySelector('[data-role="projection"]')).not.toBeNull();
    expect(container.querySelector('[data-role="pace"]')).not.toBeNull();
    expect(container.querySelector('[data-role="reserve"]')).not.toBeNull();
  });

  it('flags exhaustion before reset as the most severe verdict', () => {
    const p = projectBurnDown([{ t: 0, remaining: 100 }, { t: H, remaining: 50 }], 5 * H, { reserve: 20 });
    const v = burnVerdict(p, 5 * H, pct, (ms) => `${ms / H}h`);
    expect(v.severity).toBe('danger');
    expect(v.text).toBe('At this pace: runs out 2h, 3h before reset.');
  });

  it('refuses to project from one reading', () => {
    render(<BurnDown title="W" width={600} points={[{ t: START, remaining: 90 }]} capacity={100} start={START} resetAt={START + 5 * H} now={START} />);
    expect(screen.getByRole('status')).toHaveTextContent('Not enough readings to project this window yet.');
  });

  it('shows designed states for no readings and for unknown readings', () => {
    const { rerender } = render(<BurnDown title="W" points={[]} capacity={100} start={START} resetAt={START + H} now={START} />);
    expect(screen.getByText('No readings in this window yet.')).toBeInTheDocument();
    rerender(<BurnDown title="W" points={[{ t: START, remaining: null }]} capacity={100} start={START} resetAt={START + H} now={START} />);
    expect(screen.getByRole('note')).toHaveTextContent('Unknown');
  });

  it('formats lead times compactly', () => {
    expect(formatLead(45 * 60_000)).toBe('45m');
    expect(formatLead(2 * H)).toBe('2h');
    expect(formatLead(3.5 * H)).toBe('3h 30m');
    expect(formatLead(72 * H)).toBe('3d');
  });
});

describe('burnVerdict V3.10 — already past a line', () => {
  it('says "used up" for an exhausted window and "inside your reserve" below the reserve', async () => {
    const { burnVerdict } = await import('./BurnDown.js');
    const { projectBurnDown } = await import('./chart-math.js');
    const fmt = (v: number) => `${v}%`;
    const time = () => 'Thu 09:00';
    const used = projectBurnDown([{ t: 1, remaining: 0 }], 100);
    expect(burnVerdict(used, 100, fmt, time, 'Reserved for you')).toEqual({ text: 'Used up — resets Thu 09:00.', severity: 'danger' });
    const inside = projectBurnDown([{ t: 1, remaining: 50 }, { t: 2, remaining: 30 }], 100, { reserve: 40 });
    expect(burnVerdict(inside, 100, fmt, time, 'Reserved for you').text).toBe('Inside reserved for you — autonomy has stopped using this window until Thu 09:00.');
  });

  it('says what is already true and projects nothing when the reset is unknown (V3.10.1 review)', () => {
    const fmt = (v: number) => `${v}%`;
    const time = () => 'Thu 09:00';
    const used = projectBurnDown([{ t: 1, remaining: 0 }], null);
    expect(burnVerdict(used, null, fmt, time)).toEqual({ text: 'Used up — reset time unknown.', severity: 'danger' });
    const inside = projectBurnDown([{ t: 1, remaining: 50 }, { t: 2, remaining: 30 }], null, { reserve: 40 });
    expect(burnVerdict(inside, null, fmt, time, 'Reserved for you')).toEqual({
      text: 'Inside reserved for you — autonomy has stopped using this window until it resets (reset time unknown).',
      severity: 'warn',
    });
    // Burning fast, reset NaN: not "about NaN% left at reset", not green.
    const burning = projectBurnDown([{ t: 1, remaining: 90 }, { t: 2, remaining: 40 }], Number.NaN);
    expect(burnVerdict(burning, Number.NaN, fmt, time)).toEqual({ text: 'Reset time unknown — not projecting this window.', severity: 'unknown' });
  });
});

describe('BurnDown V3.10.1 — axes that never overprint', () => {
  const DAY = 86_400_000;
  // The live weekly format: "Fri, Sep 18, 11:46 PM" (or "… at 11:46 PM" on newer ICU).
  const weekly = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const RESET = Date.parse('2026-09-26T03:46:00Z');
  const WEEK_START = RESET - 7 * DAY;
  const pctFmt = (v: number) => `${Math.round(v)}%`;

  function weeklyCard(width: number, extra: { t: number; remaining: number | null }[] = []) {
    return render(
      <BurnDown
        title="Codex · weekly"
        width={width}
        points={[...extra, { t: WEEK_START + DAY, remaining: 80 }, { t: WEEK_START + 2 * DAY, remaining: 70 }]}
        capacity={100}
        start={WEEK_START}
        resetAt={RESET}
        now={WEEK_START + 2 * DAY}
        formatValue={pctFmt}
        formatTime={weekly}
      />,
    );
  }

  it('shortens the start and reset labels to fit a 300 px card instead of printing them over each other', () => {
    const { container } = weeklyCard(300);
    const boxes = axisLabelBoxes(container);
    expect(boxes.map((b) => b.key)).toEqual(['start', 'reset']);
    expect(noOverlap(boxes)).toBe(true);
    // One rung for both: the date alone, the reset still named.
    expect(boxes[1]!.text).toMatch(/^Resets [A-Z][a-z]{2} \d{1,2}$/);
    expect(boxes[0]!.text).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('keeps the caller\'s full format when the card is wide enough', () => {
    const { container } = weeklyCard(900);
    const boxes = axisLabelBoxes(container);
    expect(boxes[1]!.text).toBe(`Resets ${weekly(RESET)}`);
    expect(noOverlap(boxes)).toBe(true);
  });

  it('never overprints at the narrowest chart width, and always keeps the reset marker', () => {
    // A 5-hour window at the 280 px floor with the widest tick gutter.
    // (Dropping the start when even the shortest pair collides is pinned in
    // chart-math.test.ts layoutAxisLabels.)
    const { container } = render(
      <BurnDown title="W" width={280} points={[{ t: START, remaining: 90 }]} capacity={100} start={START} resetAt={START + 5 * H} now={START} formatValue={(v) => `${v.toFixed(3)} percent`} />,
    );
    const boxes = axisLabelBoxes(container);
    expect(boxes.map((b) => b.key)).toContain('reset');
    expect(noOverlap(boxes)).toBe(true);
  });

  it('labels a window inside one day with clock times only', () => {
    const { container } = render(
      <BurnDown title="W" width={600} points={[{ t: START, remaining: 90 }, { t: START + H, remaining: 80 }]} capacity={100} start={START} resetAt={START + 5 * H} now={START + H} formatTime={weekly} />,
    );
    for (const b of axisLabelBoxes(container)) expect(b.text).toMatch(/^(Resets )?\d{1,2}:\d{2} [AP]M$/);
  });

  it('ignores an epoch-0 reading: no 1969 axis, no slope dragged back to 1970', () => {
    const { container } = weeklyCard(600, [{ t: 0, remaining: 100 }]);
    const texts = [...container.querySelectorAll('svg text')].map((t) => t.textContent ?? '');
    expect(texts.some((t) => /Dec 31|1969|1970/.test(t))).toBe(false);
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('At this pace');
    showTable();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + the two real readings
  });

  it('draws percent cards on one 0–100% scale', () => {
    const { container } = weeklyCard(600);
    const ticks = [...container.querySelectorAll('svg text')].map((t) => t.textContent).filter((t) => /^\d+%$/.test(t ?? ''));
    expect(ticks).toEqual(['0%', '25%', '50%', '75%', '100%']);
  });

  it('widens a degenerate window instead of stacking its labels', () => {
    const { container } = render(
      <BurnDown title="W" width={600} points={[{ t: START, remaining: 90 }]} capacity={100} start={START} resetAt={START} now={START} />,
    );
    const boxes = axisLabelBoxes(container);
    expect(noOverlap(boxes)).toBe(true);
    expect(new Set(boxes.map((b) => b.text.replace(/^Resets /, ''))).size).toBe(boxes.length);
  });
});

describe('BurnDown V3.10.1 review — an implausible reset is an unknown reset', () => {
  const NOW = Date.parse('2026-09-24T19:42:00Z');
  // About 10% an hour: the seat is burning fast.
  const readings = [{ t: NOW - 6 * H, remaining: 90 }, { t: NOW - 3 * H, remaining: 60 }, { t: NOW - H, remaining: 40 }];
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

  it.each([
    ['epoch 0 (a 1970-01-01T00:00:00Z machine reset)', Date.parse('1970-01-01T00:00:00Z')],
    ['NaN', Number.NaN],
    ['pre-2000', Date.parse('1999-12-31T23:00:00Z')],
  ])('invents neither a reset nor a green verdict for a %s reset', (_name, resetAt) => {
    const { container } = render(
      <BurnDown
        title="Codex · 5-hour"
        width={600}
        points={readings}
        capacity={100}
        start={NOW - 6 * H}
        resetAt={resetAt}
        now={NOW}
        reserve={{ value: 8, label: 'Reserved for you' }}
        formatValue={pct}
        formatTime={clock}
      />,
    );
    const verdict = container.querySelector('[data-severity]')!;
    expect(verdict).toHaveTextContent('Reset time unknown — not projecting this window.');
    expect(verdict.getAttribute('data-severity')).toBe('unknown');
    // Nothing drawn toward a reset nobody placed.
    expect(container.querySelector('[data-role="pace"]')).toBeNull();
    expect(container.querySelector('[data-role="projection"]')).toBeNull();
    expect(container.textContent).not.toContain('Even pace');
    // The right edge is now (the latest reading is an hour old), in plain
    // clock time (a 6-hour span) — and it is not called a reset.
    const labels = axisLabelBoxes(container);
    expect(labels.map((l) => l.key)).toEqual(['start', 'end']);
    expect(labels.some((l) => /Reset/.test(l.text))).toBe(false);
    expect(labels[1]!.text).toBe(formatClockTime(NOW));
    const aria = container.querySelector('svg[role="img"]')!.getAttribute('aria-label')!;
    expect(aria).toContain('reset time unknown');
    expect(aria).not.toMatch(/NaN|1969|1970|1999|Dec 31|left at reset|resets \d/);
  });

  it('still projects to a real reset', () => {
    const { container } = render(
      <BurnDown title="Codex · 5-hour" width={600} points={readings} capacity={100} start={NOW - 6 * H} resetAt={NOW + 3 * H} now={NOW} formatValue={pct} formatTime={clock} />,
    );
    expect(container.querySelector('[data-severity]')!.getAttribute('data-severity')).toBe('danger');
    expect(container.querySelector('[data-role="pace"]')).not.toBeNull();
    expect(container.querySelector('[data-role="projection"]')).not.toBeNull();
    expect(axisLabelBoxes(container).map((l) => l.key)).toEqual(['start', 'reset']);
  });
});

describe('BurnDown V3.10.1 review — labels budgeted at the Display size', () => {
  afterEach(clearDisplaySize);
  const DAY = 86_400_000;
  const weekly = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const RESET = Date.parse('2026-09-26T03:46:00Z');
  const WEEK_START = RESET - 7 * DAY;
  const card = (width: number) => render(
    <BurnDown
      title="Codex · weekly"
      width={width}
      points={[{ t: WEEK_START + DAY, remaining: 80 }, { t: WEEK_START + 2 * DAY, remaining: 70 }]}
      capacity={100}
      start={WEEK_START}
      resetAt={RESET}
      now={WEEK_START + 2 * DAY}
      formatValue={(v) => `${Math.round(v)}%`}
      formatTime={weekly}
    />,
  );

  it('shortens the start and reset labels at XLarge where 12 px estimates let them overprint', () => {
    const fullReset = `Resets ${weekly(RESET)}`;
    const chars = weekly(WEEK_START).length + fullReset.length;
    // Wide enough for both full labels at 12 px — gutter 38 ("100%"), right
    // pad 14, an 8 px gap, and 12 px spare (more than XLarge's wider y
    // gutter takes, so only the label budget decides) — but not at 15 px.
    const width = Math.ceil(chars * 7.2 + 8 + 38 + 14) + 12;
    expect(axisLabelBoxes(card(width).container)[1]!.text).toBe(fullReset);
    cleanup();

    const scale = setDisplaySize('xlarge');
    expect(scale).toBe(1.25);
    const boxes = axisLabelBoxes(card(width).container, scale);
    expect(boxes.map((b) => b.key)).toEqual(['start', 'reset']);
    expect(boxes[1]!.text).not.toBe(fullReset);
    expect(boxes[1]!.text).toMatch(/^Resets /);
    expect(noOverlap(boxes)).toBe(true);
  });

  it('never overprints at any Display size across card widths', () => {
    for (const size of ['default', 'large', 'xlarge'] as const) {
      const scale = setDisplaySize(size);
      for (const width of [280, 320, 360, 420, 480, 560]) {
        const boxes = axisLabelBoxes(card(width).container, scale);
        expect(boxes.map((b) => b.key), `${size} @ ${width}`).toContain('reset');
        expect(noOverlap(boxes), `${size} @ ${width}: ${boxes.map((b) => b.text).join(' | ')}`).toBe(true);
        cleanup();
      }
    }
  });
});
