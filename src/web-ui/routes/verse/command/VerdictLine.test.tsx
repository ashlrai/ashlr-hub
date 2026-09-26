import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SINCE_MIN_GAP_MS, SinceStrip } from './VerdictLine.js';
import type { SinceItem } from './command-model.js';

const NOW = Date.parse('2026-09-25T15:00:00Z');
const items: SinceItem[] = [{ id: 'merged', text: '3 merged', tone: 'success' }];
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('SinceStrip', () => {
  it('shows what changed when the last look was at least an hour ago', () => {
    render(<SinceStrip lastLookedAt={ago(2 * SINCE_MIN_GAP_MS)} items={items} now={NOW} />);
    expect(screen.getByRole('group', { name: /^Since you looked at/ })).toHaveTextContent('3 merged');
  });

  it('stays hidden when nothing changed — never "nothing new"', () => {
    const { container } = render(<SinceStrip lastLookedAt={ago(2 * SINCE_MIN_GAP_MS)} items={[]} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden for a glance back within the hour, and on a first visit', () => {
    const { container, rerender } = render(<SinceStrip lastLookedAt={ago(SINCE_MIN_GAP_MS - 60_000)} items={items} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SinceStrip lastLookedAt={null} items={items} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });
});
