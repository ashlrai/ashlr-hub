import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT } from './fixtures.test-support.js';
import { Composer, type ComposerProps } from './Composer.js';

const SEATS = [CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT];

function props(over: Partial<ComposerProps> = {}): ComposerProps {
  return {
    seats: SEATS,
    seat: { seatId: 'claude-main', model: 'claude-opus-5' },
    engine: 'claude',
    running: false,
    disabled: false,
    locked: false,
    onSend: vi.fn(async () => true),
    onStop: vi.fn(),
    onSeatChange: vi.fn(),
    autoFocus: true,
    ...over,
  };
}

describe('Composer', () => {
  it('keeps the box editable while a reply runs and refocuses it when the turn finishes', async () => {
    const user = userEvent.setup();
    const p = props();
    const view = render(<Composer {...p} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).toHaveFocus();

    await user.type(box, 'hello{Enter}');
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith('hello'));
    expect(box).toHaveValue('');

    // Turn running: Stop replaces Send, the box stays enabled for drafting.
    view.rerender(<Composer {...p} running />);
    expect(box).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Stop the running turn/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send/ })).not.toBeInTheDocument();
    await user.type(box, 'next thought');
    expect(box).toHaveValue('next thought');
    // Enter while running does not send.
    await user.keyboard('{Enter}');
    expect(p.onSend).toHaveBeenCalledTimes(1);

    // Clicking Stop moves focus to the button, which then unmounts.
    await user.click(screen.getByRole('button', { name: /Stop the running turn/ }));
    expect(p.onStop).toHaveBeenCalledTimes(1);
    view.rerender(<Composer {...p} running={false} />);
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveValue('next thought');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('shows the bound seat as a read-only pill whose menu starts a new chat on another seat', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<Composer {...p} />);
    // No per-message model <select> in the composer any more.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const pill = screen.getByRole('button', { name: /Claude Max · Opus 5/ });
    expect(pill).toHaveAttribute('aria-haspopup', 'menu');

    await user.click(pill);
    const menu = screen.getByRole('menu', { name: 'Seat' });
    expect(menu).toHaveTextContent('This chat runs on Claude Max · Opus 5');
    // Unavailable seats are not offered; the local seat is.
    expect(within(menu).queryByRole('menuitem', { name: /Personal Codex/ })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /New chat on Qwen3 Coder \(local\)/ }));
    expect(p.onSeatChange).toHaveBeenCalledWith({ seatId: 'local:qwen3-coder', model: 'qwen3-coder' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // Escape closes it and returns focus to the pill.
    await user.click(pill);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(pill).toHaveFocus();
  });
});
