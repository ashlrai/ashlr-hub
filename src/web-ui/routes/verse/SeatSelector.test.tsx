import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT } from './fixtures.test-support.js';
import { decodeSeatChoice, defaultSeatChoice, encodeSeatChoice, SeatSelector } from './SeatSelector.js';

const SEATS = [LOCAL_SEAT, CODEX_SEAT, CLAUDE_SEAT];

describe('SeatSelector', () => {
  it('groups seats Claude · Codex · Grok · Local and disables unavailable seats with the reason', () => {
    render(<SeatSelector seats={SEATS} value={{ seatId: 'claude-main', model: 'claude-opus-5' }} onChange={() => {}} />);
    const select = screen.getByLabelText('Seat and model') as HTMLSelectElement;
    const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => g.label);
    expect(groups).toEqual(['Claude', 'Codex', 'Local']);

    const codex = screen.getByRole('option', { name: /Personal Codex — GPT-5.5/ }) as HTMLOptionElement;
    expect(codex).toBeDisabled();
    expect(codex.textContent).toContain('unavailable: quota exhausted until 14:00');
    expect(codex).toHaveAttribute('title', 'Unavailable: quota exhausted until 14:00');

    const opus = screen.getByRole('option', { name: 'Claude Max — Opus 5' }) as HTMLOptionElement;
    expect(opus).not.toBeDisabled();
    expect(select.value).toBe(encodeSeatChoice({ seatId: 'claude-main', model: 'claude-opus-5' }));
  });

  it('emits the decoded seat/model pair on change', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SeatSelector seats={SEATS} value={{ seatId: 'claude-main', model: 'claude-opus-5' }} onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText('Seat and model'), encodeSeatChoice({ seatId: 'local:qwen3-coder', model: 'qwen3-coder' }));
    expect(onChange).toHaveBeenCalledWith({ seatId: 'local:qwen3-coder', model: 'qwen3-coder' });
  });

  it('defaults to the first selectable seat in engine order and round-trips ids with colons', () => {
    expect(defaultSeatChoice(SEATS)).toEqual({ seatId: 'claude-main', model: 'claude-opus-5' });
    expect(defaultSeatChoice([CODEX_SEAT, LOCAL_SEAT])).toEqual({ seatId: 'local:qwen3-coder', model: 'qwen3-coder' });
    expect(defaultSeatChoice([CODEX_SEAT])).toBeNull();
    const choice = { seatId: 'local:qwen3-coder-next:ctx64k', model: 'qwen3-coder-next:ctx64k' };
    expect(decodeSeatChoice(encodeSeatChoice(choice))).toEqual(choice);
    expect(decodeSeatChoice('garbage')).toBeNull();
  });
});
