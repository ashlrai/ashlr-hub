import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BurnDown, burnVerdict, formatLead } from './BurnDown.js';
import { projectBurnDown } from './chart-math.js';

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
