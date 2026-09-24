import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT } from './fixtures.test-support.js';
import {
  CLAUDE_MAX_SEAT,
  CLAUDE_CONTEXT_SEAT,
  CLAUDE_SKEW_NOTE,
  CLAUDE_TIGHT_SEAT,
  CODEX_CONTEXT_SEAT,
  CODEX_CREDITS_SEAT,
  GROK_CONTEXT_SEAT,
  GROK_SEAT,
  LOCAL_CONTEXT_SEAT,
  OPUS_55_REASON,
  UNKNOWN_WINDOW_SEAT,
  UNREAD_SEAT,
} from './seat-fixtures.test-support.js';
import { decodeSeatChoice, defaultSeatChoice, encodeSeatChoice, SeatSelector, seatBlockedNote, seatOptionTitle } from './SeatSelector.js';
import { healthReport } from './health/health.test-support.js';
import { WINDOW_SOURCE_TEXT } from './verse-model.js';

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
    // The reason leads the tooltip; the model's context sentence follows it.
    expect(codex.getAttribute('title')?.split('\n')[0]).toBe('Unavailable: quota exhausted until 14:00');

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

/**
 * Owner S's `VerseSeat.capacity` carries the PLAN too — the provider's own
 * tier, and only when it published one. "Which account can I use" is half a
 * question without "on what plan".
 */
describe('SeatSelector — plan and binding window from the capacity record', () => {
  it('reads plan, binding window and credits off the capacity record', () => {
    render(<SeatSelector seats={[CODEX_CREDITS_SEAT]} value={null} onChange={() => {}} />);
    const option = screen.getByRole('option', { name: /Personal Codex/ }) as HTMLOptionElement;
    expect(option.textContent).toContain('pro · tight · primary window limit reached · credits still spendable');
    // Spent window, spendable balance: marked, never refused.
    expect(option).not.toBeDisabled();
  });

  it('leads with the binding window on a seat whose reachability is merely "ready"', () => {
    render(<SeatSelector seats={[CLAUDE_TIGHT_SEAT]} value={null} onChange={() => {}} />);
    const option = screen.getByRole('option', { name: /Claude Max — Opus 5/ }) as HTMLOptionElement;
    expect(option.textContent).toContain('max · tight · 92% of weekly fable window used');
  });

  it('says nothing about a seat nothing was read from', () => {
    render(<SeatSelector seats={[UNREAD_SEAT]} value={null} onChange={() => {}} />);
    const option = screen.getByRole('option', { name: /Claude Max — Opus 5/ }) as HTMLOptionElement;
    // An absent figure already says "unread"; "no reading" on every row is noise.
    expect(option.textContent).not.toContain('no capacity reading');
    expect(option).not.toBeDisabled();
  });
});

/**
 * V3.9 — every row says what context it buys. The picker used to show no
 * window at all, and the only one near it was the seat's DEFAULT model's
 * (200k for every 1M Claude model).
 */
describe('SeatSelector — context per model', () => {
  const SEATS_V39 = [CLAUDE_CONTEXT_SEAT, CODEX_CONTEXT_SEAT, GROK_CONTEXT_SEAT, LOCAL_CONTEXT_SEAT];

  it('shows each model’s own window and compaction point', () => {
    render(<SeatSelector seats={SEATS_V39} value={null} onChange={() => {}} />);
    expect(screen.getByRole('option', { name: /Claude Max — Fable 5\.1 · 1M ctx · compacts ≈367k$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude Max — Haiku 4\.5 · 200k ctx · compacts ≈167k$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Work Codex — GPT-6 Astra · 258k ctx · compacts ≈245k$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Grok — Grok 4\.7 Fast · 500k ctx · compacts ≈400k$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /qwen3\.8:27b-ctx64k · 66k ctx · compacts ≈33k$/ })).toBeInTheDocument();
  });

  it('lists a model the pinned CLI cannot run, disabled, with the reason', () => {
    render(<SeatSelector seats={SEATS_V39} value={null} onChange={() => {}} />);
    const opus = screen.getByRole('option', { name: /Claude Max — Opus 5\.5/ }) as HTMLOptionElement;
    expect(opus).toBeDisabled();
    expect(opus.textContent).toContain(`(unavailable: ${OPUS_55_REASON})`);
    expect(opus.getAttribute('title')?.split('\n')[0]).toBe(`Unavailable: ${OPUS_55_REASON}`);
    // Its siblings on the same seat stay choosable.
    expect(screen.getByRole('option', { name: /Claude Max — Fable 5\.1/ })).not.toBeDisabled();
  });

  it('carries the pinned CLI version and the seat notes in every row’s tooltip', () => {
    render(<SeatSelector seats={SEATS_V39} value={null} onChange={() => {}} />);
    const fable = screen.getByRole('option', { name: /Claude Max — Fable 5\.1/ });
    const title = fable.getAttribute('title') ?? '';
    expect(title).toContain('1M-token window; compacts at about 367k in Standard. Expansive runs to about 967k before compacting.');
    expect(title).toContain('Runs Claude Code 2.1.257.');
    expect(title).toContain(CLAUDE_SKEW_NOTE);
    expect(seatOptionTitle(GROK_CONTEXT_SEAT, GROK_CONTEXT_SEAT.models[0]!, null)).toBe(
      `500k-token window; compacts at about 400k. Window ${WINDOW_SOURCE_TEXT['provider-catalog']}.`,
    );
  });

  it('says a window is unknown rather than printing a default', () => {
    render(<SeatSelector seats={[UNKNOWN_WINDOW_SEAT]} value={null} onChange={() => {}} />);
    expect(screen.getByRole('option', { name: 'Claude Team — Mystery 9 · window unknown' })).toBeInTheDocument();
  });

  it('adds a fit verdict to every row once the chosen folders are sized', () => {
    render(<SeatSelector seats={SEATS_V39} value={null} onChange={() => {}} workingSetTokens={300_000} />);
    expect(screen.getByRole('option', { name: /Fable 5\.1 .* · code fits, tight$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /GPT-6 Astra .* · code needs expansive$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /GPT-5\.5 .* · code too big — split$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /qwen3\.8:27b-ctx64k .* · code too big — split$/ })).toBeInTheDocument();
  });

  it('shows the budget of the mode each row would run in', () => {
    render(<SeatSelector seats={SEATS_V39} value={null} onChange={() => {}}
      modeFor={(seat) => (seat.id === 'claude-a' || seat.id === 'grok-a' ? 'expansive' : 'standard')} />);
    expect(screen.getByRole('option', { name: /Fable 5\.1 · 1M ctx · compacts ≈967k \(expansive\)$/ })).toBeInTheDocument();
    // A model with no expansive budget falls back to its one real budget.
    expect(screen.getByRole('option', { name: /Haiku 4\.5 · 200k ctx · compacts ≈167k$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Grok 4\.7 Fast · 500k ctx · compacts ≈400k$/ })).toBeInTheDocument();
  });

  it('defaults to a RUNNABLE model even when an unavailable one is listed first', () => {
    const skewFirst = { ...CLAUDE_CONTEXT_SEAT, models: [CLAUDE_CONTEXT_SEAT.models[1]!, CLAUDE_CONTEXT_SEAT.models[2]!] };
    expect(defaultSeatChoice([skewFirst])).toEqual({ seatId: 'claude-a', model: 'claude-haiku-4-5-20251001' });
    const nothingRunnable = { ...CLAUDE_CONTEXT_SEAT, models: [CLAUDE_CONTEXT_SEAT.models[1]!] };
    expect(defaultSeatChoice([nothingRunnable, GROK_CONTEXT_SEAT])).toEqual({ seatId: 'grok-a', model: 'grok-4.7-build-fast' });
  });
});

/**
 * V3.10 — the engine now REFUSES a turn on a seat that is exhausted or signed
 * out (core/verse/seat-readiness.ts). The picker uses the same rule, so it
 * never offers a choice the first send would bounce.
 */
describe('SeatSelector — seats the engine would refuse', () => {
  it('disables an exhausted seat and says when it resets and where to go instead', () => {
    render(<SeatSelector seats={[CLAUDE_MAX_SEAT, GROK_SEAT]} value={null} onChange={() => {}} />);
    const blocked = screen.getByRole('option', { name: /^Claude Max — Opus 5/ }) as HTMLOptionElement;
    expect(blocked).toBeDisabled();
    expect(blocked.textContent).toContain('unavailable: out of usage — resets Sep 25 at 7pm (America/New_York) · try Grok');
    expect(screen.getByRole('option', { name: /^Grok — Opus 5/ })).not.toBeDisabled();
  });

  it('keeps a merely tight seat selectable (spent window, spendable credits)', () => {
    render(<SeatSelector seats={[CODEX_CREDITS_SEAT]} value={null} onChange={() => {}} />);
    expect(screen.getByRole('option', { name: /Personal Codex/ })).not.toBeDisabled();
  });

  it('disables a seat the health sweep found signed out', () => {
    const reports = [healthReport('grok', { engine: 'grok', connection: 'signed-out', fix: { kind: 'reauth' } })];
    render(<SeatSelector seats={[GROK_SEAT, CLAUDE_TIGHT_SEAT]} value={null} onChange={() => {}} healthReports={reports} />);
    const grok = screen.getByRole('option', { name: /^Grok — Opus 5/ }) as HTMLOptionElement;
    expect(grok).toBeDisabled();
    expect(grok.textContent).toContain('unavailable: signed out — reconnect it · try Claude Max');
    expect(seatBlockedNote(CLAUDE_TIGHT_SEAT, [GROK_SEAT, CLAUDE_TIGHT_SEAT], reports)).toBeNull();
  });

  it('never defaults to a refused seat', () => {
    expect(defaultSeatChoice([CLAUDE_MAX_SEAT, GROK_SEAT])).toEqual({ seatId: 'grok', model: 'claude-opus-5' });
    expect(defaultSeatChoice([CLAUDE_MAX_SEAT])).toBeNull();
    const reports = [healthReport('grok', { connection: 'signed-out' })];
    expect(defaultSeatChoice([GROK_SEAT, CLAUDE_TIGHT_SEAT], reports)).toEqual({ seatId: 'claude', model: 'claude-opus-5' });
  });
});
