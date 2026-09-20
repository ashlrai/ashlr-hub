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

    // The option name now carries the seat's capacity too — see the
    // "capacity at the point of choice" block below for why.
    const opus = screen.getByRole('option', { name: /^Claude Max — Opus 5\b/ }) as HTMLOptionElement;
    expect(opus).not.toBeDisabled();
    expect(opus.textContent).toContain('usable · 12% of 5h window used');
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

/**
 * The gap this closes: the picker showed NO capacity at all. It annotated an
 * option only via `seatUnavailableReason`, which fires solely on
 * `health.state === 'unavailable'` — and Claude's health is `unknown` BY
 * CONSTRUCTION (docs/VERSE-TELEMETRY-V2.md). So a Claude seat whose binding
 * weekly window read 100% used appeared as an ordinary, enabled, unannotated
 * choice, and the exhaustion surfaced only when the turn failed.
 */
describe('SeatSelector — capacity at the point of choice', () => {
  const seatWith = (windows: Array<{ id: string; usedPercent: number | null; resetsAt: string | null }>) => ({
    ...CLAUDE_SEAT,
    health: { ...CLAUDE_SEAT.health, state: 'unknown' as const, summary: null, windows },
  });

  it('shows the binding window on a seat whose health is unknown', () => {
    render(
      <SeatSelector
        seats={[seatWith([
          { id: 'five_hour', usedPercent: 12, resetsAt: null },
          { id: 'seven_day_fable', usedPercent: 92, resetsAt: null },
        ])]}
        value={null}
        onChange={() => {}}
      />,
    );
    // The BINDING window is the one that bites, not the roomiest.
    const option = screen.getByRole('option', { name: /Claude Max — Opus 5/ }) as HTMLOptionElement;
    expect(option.textContent).toContain('tight');
    expect(option.textContent).toContain('92% of weekly fable window used');
  });

  it('calls a spent window "limit reached" and still lets the seat be chosen', () => {
    render(
      <SeatSelector
        seats={[seatWith([{ id: 'seven_day', usedPercent: 100, resetsAt: null }])]}
        value={null}
        onChange={() => {}}
      />,
    );
    const option = screen.getByRole('option', { name: /Claude Max — Opus 5/ }) as HTMLOptionElement;
    expect(option.textContent).toContain('limit reached');
    // Never "100% used": upstream writes a sentinel 100 for a provider denial,
    // which is not a measurement.
    expect(option.textContent).not.toContain('100%');
    // Credits can outlive a window, so a blocked seat is marked, not refused.
    expect(option).not.toBeDisabled();
  });

  it('says nothing at all when no window reported a number', () => {
    render(<SeatSelector seats={[seatWith([])]} value={null} onChange={() => {}} />);
    const option = screen.getByRole('option', { name: /Claude Max — Opus 5/ }) as HTMLOptionElement;
    // An absent figure already says "unread"; "no reading" on every row is noise.
    expect(option.textContent).not.toContain('no reading');
    expect(option).not.toBeDisabled();
  });
});
