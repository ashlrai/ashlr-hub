import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup as cleanupRender, render, screen, waitFor, within } from '@testing-library/react';
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

describe('Composer — depth for a long day', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('keeps an unsent draft across unmounts and clears it once sent', async () => {
    const user = userEvent.setup();
    const p = props({ sessionId: 'vs_1' });
    const first = render(<Composer {...p} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'half a thought');
    first.unmount();

    // Reopening the same chat finds the draft; a different chat does not.
    render(<Composer {...p} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('half a thought');
    screen.getByRole('textbox', { name: 'Message' }).blur();
    cleanupRender();

    render(<Composer {...props({ sessionId: 'vs_2' })} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    cleanupRender();

    render(<Composer {...p} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, '{Enter}');
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith('half a thought'));
    cleanupRender();
    render(<Composer {...props({ sessionId: 'vs_1' })} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  it('recalls sent messages with ArrowUp and returns to the draft with ArrowDown', async () => {
    const user = userEvent.setup();
    const p = props({ sessionId: 'vs_1' });
    render(<Composer {...p} />);
    const box = screen.getByRole('textbox', { name: 'Message' });

    await user.type(box, 'first{Enter}');
    await waitFor(() => expect(box).toHaveValue(''));
    await user.type(box, 'second{Enter}');
    await waitFor(() => expect(box).toHaveValue(''));

    await user.type(box, 'unsent');
    await user.keyboard('{ArrowUp}');
    // The caret is at the end of "unsent", so ArrowUp edits, it does not recall.
    expect(box).toHaveValue('unsent');

    await user.clear(box);
    await user.keyboard('{ArrowUp}');
    expect(box).toHaveValue('second');
    await user.keyboard('{ArrowUp}');
    expect(box).toHaveValue('first');
    await user.keyboard('{ArrowDown}');
    expect(box).toHaveValue('second');
    await user.keyboard('{ArrowDown}');
    expect(box).toHaveValue('');
  });

  it('warns about the cost of a message only once the window is genuinely tight', async () => {
    const user = userEvent.setup();
    const roomy = props({ sessionId: 'vs_1', contextTokens: 10_000, contextWindow: 200_000 });
    const view = render(<Composer {...roomy} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'a short ask');
    expect(screen.queryByText(/of the context window/)).not.toBeInTheDocument();

    view.rerender(<Composer {...props({ sessionId: 'vs_1', contextTokens: 190_000, contextWindow: 200_000 })} />);
    const hint = screen.getByRole('status');
    expect(hint).toHaveTextContent('tokens for this message');
    expect(hint).toHaveTextContent('95%');
    // The figure is an estimate and says so, in the number and in full.
    expect(hint.textContent).toContain('≈');
    expect(hint.textContent).toContain('This is an estimate');
    expect(hint).toHaveAttribute('data-tone', 'danger');
  });

  it('says nothing about cost when the context window is unknown', async () => {
    const user = userEvent.setup();
    render(<Composer {...props({ sessionId: 'vs_1', contextTokens: 190_000, contextWindow: null })} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'anything');
    expect(screen.queryByText(/of the context window/)).not.toBeInTheDocument();
  });

  it('stops the running turn with the platform cancel chord', async () => {
    const user = userEvent.setup();
    const p = props({ sessionId: 'vs_1', running: true });
    const view = render(<Composer {...p} />);
    await user.keyboard('{Meta>}.{/Meta}');
    expect(p.onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Stop the running turn/ })).toHaveAttribute('title', 'Stop the running turn (⌘.)');

    // Never armed on an idle chat.
    view.rerender(<Composer {...props({ sessionId: 'vs_1', running: false, onStop: p.onStop })} />);
    await user.keyboard('{Meta>}.{/Meta}');
    expect(p.onStop).toHaveBeenCalledTimes(1);
  });

  it('also sends on ⌘Enter, for a hand already on the modifier', async () => {
    const user = userEvent.setup();
    const p = props({ sessionId: 'vs_1' });
    render(<Composer {...p} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'ship it');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith('ship it'));
  });
});
