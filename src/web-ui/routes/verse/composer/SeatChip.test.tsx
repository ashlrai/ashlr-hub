/**
 * composer/SeatChip.test.tsx — the seat chip's detail bubble reads THE shared
 * capacity row (usage/capacity-strip-model `capacityRowFor`, C6 → C3), so it
 * says exactly what Apps & Accounts, Usage and the new-chat dialog say.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CLAUDE_TIGHT_SEAT, UNREAD_SEAT } from '../seat-fixtures.test-support.js';
import { mockCompactViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { SeatChip } from './SeatChip.js';

let vp: ViewportMock | null = null;
beforeEach(() => {
  evictAll();
  // Health and budget are unmounted (404): the bubble must say "no reading", not invent one.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
});
afterEach(() => {
  vp?.restore();
  vp = null;
  vi.unstubAllGlobals();
});

function chip(seat = CLAUDE_TIGHT_SEAT) {
  return render(<SeatChip seats={[seat]} seat={{ seatId: seat.id, model: seat.models[0]!.id }} engine={seat.engine}
    label={seat.label} onNewChat={vi.fn()} />);
}

describe('SeatChip — the detail bubble', () => {
  it('lists plan, every window with its verbatim reset, and the capacity word from the shared row', async () => {
    const user = userEvent.setup();
    chip();
    await user.hover(screen.getByRole('button', { name: /^Seat: Claude Max/ }));
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('Plan: max')).toBeInTheDocument();
    expect(within(tip).getByText(/^weekly fable window: 92% used, resets Sep 25 at 7pm \(America\/New_York\)$/)).toBeInTheDocument();
    expect(within(tip).getByText(/^Health: tight/)).toBeInTheDocument();
    // A1 honesty: an unread budget is said, never guessed.
    expect(await within(tip).findByText('Budget: no reading')).toBeInTheDocument();
  });

  it('a seat nothing was read from says so — no windows invented', async () => {
    const user = userEvent.setup();
    chip(UNREAD_SEAT);
    await user.hover(screen.getByRole('button', { name: /^Seat: / }));
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).queryByText(/% used/)).toBeNull();
  });

  it('at 375 (dark) the chip collapses to monogram + ring and keeps its full name for assistive tech', () => {
    vp = mockCompactViewport({ dark: true });
    render(<SeatChip seats={[CLAUDE_TIGHT_SEAT]} seat={{ seatId: CLAUDE_TIGHT_SEAT.id, model: CLAUDE_TIGHT_SEAT.models[0]!.id }}
      engine="claude" label="Claude Max" compact onNewChat={vi.fn()} />);
    const button = screen.getByRole('button', { name: /^Seat: Claude Max/ });
    expect(button).not.toHaveTextContent('Claude Max');
  });
});
