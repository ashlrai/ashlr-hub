import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Swimlane, VIRTUALIZE_AFTER, ROW_H, type SwimlaneLane } from './Swimlane.js';

const H = 3_600_000;
const FROM = Date.parse('2026-09-20T00:00:00Z');
const TO = FROM + 72 * H;

function lane(id: string, n = 2): SwimlaneLane {
  return {
    id,
    label: id,
    items: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, start: FROM + i * 10 * H, end: FROM + i * 10 * H + H, status: i % 2 ? 'failed' : 'done' })),
  };
}

describe('Swimlane', () => {
  it('draws one bar per run inside the window with a status legend', () => {
    const { container } = render(<Swimlane title="Runs" width={800} from={FROM} to={TO} lanes={[lane('alpha'), lane('beta', 1)]} />);
    expect(container.querySelectorAll('rect[data-item]')).toHaveLength(3);
    expect(screen.getByText('done', { selector: 'li' })).toBeInTheDocument();
    expect(screen.getByText('failed', { selector: 'li' })).toBeInTheDocument();
    for (const bar of container.querySelectorAll('rect[data-item]')) {
      const x = Number(bar.getAttribute('x'));
      expect(x + Number(bar.getAttribute('width'))).toBeLessThanOrEqual(800);
    }
  });

  it('extends open-ended runs to now and marks stale ones in words', () => {
    const lanes: SwimlaneLane[] = [{
      id: 'a', label: 'a', items: [{ id: 'r', start: FROM, end: null, status: 'running', stale: true }],
    }];
    const { container } = render(<Swimlane title="Runs" width={800} from={FROM} to={TO} now={FROM + 10 * H} lanes={lanes} />);
    const bar = container.querySelector('rect[data-item="r"]')!;
    expect(bar.getAttribute('data-open')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.getByRole('cell', { name: 'running (stale)' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '10h 0m+' })).toBeInTheDocument();
  });

  it('gives every lane a keyboard stop with a spoken summary', () => {
    render(<Swimlane title="Runs" width={800} from={FROM} to={TO} lanes={[lane('alpha', 3)]} />);
    expect(screen.getByRole('listitem', { name: 'alpha: 3 runs (2 done, 1 failed)' })).toHaveAttribute('tabindex', '0');
  });

  it(`virtualizes past ${VIRTUALIZE_AFTER} lanes and renders only rows near the viewport`, () => {
    const many = Array.from({ length: 300 }, (_, i) => lane(`repo-${i}`, 1));
    const { container } = render(<Swimlane title="Runs" width={800} from={FROM} to={TO} lanes={many} />);
    const scroller = container.querySelector('[data-virtualized="true"]') as HTMLDivElement;
    expect(scroller).not.toBeNull();
    const before = container.querySelectorAll('g[data-lane]').length;
    expect(before).toBeLessThan(40);
    fireEvent.scroll(scroller, { target: { scrollTop: 200 * ROW_H } });
    expect(container.querySelector('g[data-lane="repo-200"]')).not.toBeNull();
    expect(container.querySelector('g[data-lane="repo-0"]')).toBeNull();
  });

  it('shows a designed empty state when there are no runs', () => {
    render(<Swimlane title="Runs" from={FROM} to={TO} lanes={[]} />);
    expect(screen.getByText('No runs in this window.')).toBeInTheDocument();
  });
});

describe('spanTickFormatter', () => {
  it('uses dates for long windows and clock times for short ones', async () => {
    const { spanTickFormatter } = await import('./Swimlane.js');
    const long = spanTickFormatter(FROM, FROM + 30 * 24 * H)(FROM);
    expect(long).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    const short = spanTickFormatter(FROM, FROM + 6 * H)(FROM);
    expect(short).toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
  });
});
