import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BurnDown, burnVerdict, formatLead } from './BurnDown.js';
import { projectBurnDown } from './chart-math.js';
import { axisLabelBoxes, noOverlap, showTable } from './chart-test-support.js';

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
