import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup as cleanupRender, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLAUDE_1M_SEAT, CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT } from './fixtures.test-support.js';
import { Composer, costConsequence, type ComposerProps } from './Composer.js';
import { clearComposerMemory, costHint, loadDraft, saveDraft } from './chat/composer-state.js';
import type { VerseSeat } from '../../data/api-types.js';

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

  it('shows the bound seat as a chip whose menu starts a new chat on another seat', async () => {
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
    expect(screen.getByRole('button', { name: /Stop the running turn/ })).toHaveAttribute('title', 'Stop the running turn (⌘. or Esc from an empty box)');

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

describe('Composer — V3.9 cost hint on the compaction point', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('warns against the compaction point, not the window, and says how much is left', async () => {
    const user = userEvent.setup();
    // 300k of a 1M window is 30% — comfortable by the old rule — but 82% of the way to compaction at 367k.
    render(<Composer {...props({ sessionId: 'vs_1', contextTokens: 300_000, contextWindow: 1_000_000, autoCompactAt: 367_000 })} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one more thing');
    const hint = screen.getByRole('status');
    expect(hint).toHaveAttribute('data-tone', 'warn');
    expect(hint).toHaveTextContent('30% of the context window');
    expect(hint).toHaveTextContent('About 67k left before the CLI auto-compacts.');
  });

  it('says the CLI will compact when the message reaches the compaction point', () => {
    const hint = costHint('x'.repeat(40_000), { contextTokens: 360_000, contextWindow: 1_000_000, autoCompactAt: 367_000 })!;
    expect(hint.pastCompaction).toBe(true);
    expect(hint.tone).toBe('danger');
    expect(costConsequence(hint)).toContain('the CLI will summarise earlier turns during this reply');
  });

  it('calls out a projection past the whole window', () => {
    const hint = costHint('ask', { contextTokens: 210_000, contextWindow: 200_000, autoCompactAt: 167_000 })!;
    expect(hint.tone).toBe('over');
    expect(hint.projectedPercent).toBe(105);
    expect(costConsequence(hint)).toContain('past the whole window');
  });

  it('flags an upper-bound reading instead of presenting it as measured', () => {
    const hint = costHint('ask', { contextTokens: 240_000, contextWindow: 258_400, autoCompactAt: 244_800, exact: false })!;
    expect(hint.exact).toBe(false);
    expect(costConsequence(hint)).toContain('upper bound');
  });

  it('stays quiet for a comfortable session and for an unknown window', () => {
    expect(costHint('hello', { contextTokens: 100_000, contextWindow: 1_000_000, autoCompactAt: 367_000 })).toBeNull();
    expect(costHint('hello', { contextTokens: 190_000, contextWindow: null })).toBeNull();
    expect(costHint('   ', { contextTokens: 190_000, contextWindow: 200_000 })).toBeNull();
  });

  it('explains a pre-filled handoff note until it is sent', async () => {
    const user = userEvent.setup();
    saveDraft('vs_new', 'Continuing “Old chat”. Goal: finish it.');
    const p = props({ sessionId: 'vs_new', handoffDraft: true });
    render(<Composer {...p} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).toHaveValue('Continuing “Old chat”. Goal: finish it.');
    expect(screen.getByText(/Handoff note drafted from the previous chat/)).toBeInTheDocument();
    expect(p.onSend).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith('Continuing “Old chat”. Goal: finish it.'));
    expect(screen.queryByText(/Handoff note drafted/)).toBeNull();
  });

  it('keeps a handoff note in memory when storage refuses the write, and the new chat still opens with it', async () => {
    // Blocked or full storage: setItem throws. The note is the ONLY copy.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      saveDraft('vs_blocked', 'Handoff note: keep going.');
      expect(loadDraft('vs_blocked')).toBe('Handoff note: keep going.');
      render(<Composer {...props({ sessionId: 'vs_blocked', handoffDraft: true })} />);
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Handoff note: keep going.');
      // A clear that also cannot be written must not resurrect the note.
      saveDraft('vs_blocked', '');
      expect(loadDraft('vs_blocked')).toBe('');
    } finally {
      setItem.mockRestore();
      clearComposerMemory();
    }
    // Once storage accepts a write again, storage is the answer.
    saveDraft('vs_blocked', 'stored');
    expect(localStorage.getItem('ashlr.verse.drafts.v1')).toContain('stored');
    expect(loadDraft('vs_blocked')).toBe('stored');
  });

  it('draws no cost warning from an upper bound past the compaction point', () => {
    // A codex turn total, not the prompt: nothing honest to say about "past the window".
    expect(costHint('x'.repeat(400), { contextTokens: 697_060, contextWindow: 258_400, autoCompactAt: 244_800, exact: false })).toBeNull();
  });

  it('never offers a model the seat cannot run in the new-chat menu', async () => {
    const user = userEvent.setup();
    // A seat whose FIRST listed model needs a newer CLI.
    const skewed: VerseSeat = { ...CLAUDE_1M_SEAT, id: 'claude-b', label: 'Claude B', models: [CLAUDE_1M_SEAT.models[1]!, CLAUDE_1M_SEAT.models[0]!] };
    const allUnavailable: VerseSeat = { ...CLAUDE_1M_SEAT, id: 'claude-c', label: 'Claude C', models: [CLAUDE_1M_SEAT.models[1]!] };
    const p = props({ seats: [CLAUDE_SEAT, skewed, allUnavailable] });
    render(<Composer {...p} />);
    await user.click(screen.getByRole('button', { name: /Claude Max · Opus 5/ }));
    const menu = screen.getByRole('menu', { name: 'Seat' });
    expect(within(menu).queryByRole('menuitem', { name: /Claude C/ })).toBeNull();
    const item = within(menu).getByRole('menuitem', { name: /New chat on Claude B/ });
    expect(item).toHaveTextContent('Opus 5');
    expect(item).not.toHaveTextContent('Opus 5.5');
    await user.click(item);
    expect(p.onSeatChange).toHaveBeenCalledWith({ seatId: 'claude-b', model: 'claude-opus-5' });
  });
});

describe('Composer — V3.10 seat health block', () => {
  const SIGNED_OUT: VerseSeat = {
    ...CLAUDE_SEAT,
    capacity: { planType: 'max', binding: null, windows: [], credits: null, usability: 'signed-out', observedAt: null, evidenceSource: 'collector', notes: [] },
  };

  beforeEach(() => {
    // The block reads /api/verse/health; an empty report list leaves the
    // seat's own capacity to decide, which is what these tests drive.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ checkedAt: new Date().toISOString(), seats: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says a signed-out seat cannot run the turn and offers a ready seat — above the box, before anything is typed', async () => {
    const user = userEvent.setup();
    const p = props({ seats: [SIGNED_OUT, LOCAL_SEAT] });
    render(<Composer {...p} />);
    const block = await screen.findByText(/Claude Max is signed out/);
    const alert = block.closest('[role="alert"]') as HTMLElement;
    expect(alert).toBeInTheDocument();
    // Ahead of the message box in reading order.
    expect(alert.compareDocumentPosition(screen.getByRole('textbox', { name: 'Message' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: LOCAL_SEAT.label }));
    expect(p.onSeatChange).toHaveBeenCalledWith({ seatId: LOCAL_SEAT.id, model: LOCAL_SEAT.models[0]!.id });
  });

  it('adds nothing for a ready seat, or on a read-only server', async () => {
    const { rerender } = render(<Composer {...props()} />);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    rerender(<Composer {...props({ seats: [SIGNED_OUT, LOCAL_SEAT], disabled: true, disabledReason: 'read-only' })} />);
    await waitFor(() => expect(screen.queryByText(/is signed out/)).not.toBeInTheDocument());
  });
});
