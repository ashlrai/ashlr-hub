/**
 * chat/NoticeSlot.test.tsx — one notice at a time, in order of consequence,
 * with "+N more" from the keyboard.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NoticeSlot, orderNotices, type NoticeCandidate } from './NoticeSlot.js';

function notice(id: string, kind: NoticeCandidate['kind'], label = id): NoticeCandidate {
  return { id, kind, label, render: () => <p>{label} body</p> };
}

const COMPACT = notice('compact', 'compact', 'Compact now');
const ADVICE = notice('advice', 'context', 'Context advice');
const RETRY = notice('engine:retry', 'engine', 'Retrying');
const HEALTH = notice('seat-health', 'seat-health', 'Seat health');

describe('orderNotices', () => {
  it('orders by consequence: seat health › engine › context advice › compact', () => {
    expect(orderNotices([COMPACT, ADVICE, RETRY, HEALTH]).map((n) => n.id)).toEqual(['seat-health', 'engine:retry', 'advice', 'compact']);
  });

  it('puts the notice the operator just asked for first, and keeps the rest in order', () => {
    expect(orderNotices([HEALTH, ADVICE, COMPACT], 'compact').map((n) => n.id)).toEqual(['compact', 'seat-health', 'advice']);
    // A pinned id that is not present changes nothing.
    expect(orderNotices([ADVICE, HEALTH], 'gone').map((n) => n.id)).toEqual(['seat-health', 'advice']);
  });
});

describe('NoticeSlot', () => {
  it('takes no room when there is nothing to say', () => {
    const { container } = render(<NoticeSlot notices={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the most important notice and "+N more", which opens the rest in place', async () => {
    const user = userEvent.setup();
    render(<NoticeSlot notices={[ADVICE, RETRY, HEALTH]} />);
    const slot = screen.getByRole('region', { name: 'Notices' });
    expect(slot).toHaveTextContent('Seat health body');
    expect(slot).not.toHaveTextContent('Retrying body');
    const more = screen.getByRole('button', { name: /\+2 more/ });
    // The hidden ones are named for a screen reader before they are opened.
    expect(more).toHaveAccessibleName('+2 more: Retrying, Context advice');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    more.focus();
    await user.keyboard('{Enter}');
    expect(slot).toHaveTextContent('Retrying body');
    expect(slot).toHaveTextContent('Context advice body');
    const fewer = screen.getByRole('button', { name: 'Show fewer' });
    expect(fewer).toHaveAttribute('aria-expanded', 'true');
    await user.click(fewer);
    expect(slot).not.toHaveTextContent('Context advice body');
  });

  it('drops the "+N more" control once only one notice is left', () => {
    const view = render(<NoticeSlot notices={[ADVICE, HEALTH]} />);
    expect(screen.getByRole('button', { name: /\+1 more/ })).toBeInTheDocument();
    view.rerender(<NoticeSlot notices={[ADVICE]} />);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
    expect(screen.getByRole('region', { name: 'Notices' })).toHaveTextContent('Context advice body');
  });
});
