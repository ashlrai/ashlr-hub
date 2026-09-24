import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseSeat } from '../../../data/api-types.js';
import { CLAUDE_MAX_SEAT, CLAUDE_TIGHT_SEAT, CODEX_CREDITS_SEAT, GROK_SEAT, LOCAL_SEAT_V2 } from '../seat-fixtures.test-support.js';
import { ComposerSeatBlockView } from './ComposerSeatBlock.js';
import { healthReport } from './health.test-support.js';

const NOW = Date.parse('2026-09-23T20:00:00.000Z');

describe('ComposerSeatBlockView', () => {
  it('renders nothing while the chat’s seat can run a turn', () => {
    const { container } = render(<ComposerSeatBlockView now={NOW} seats={[CLAUDE_TIGHT_SEAT, GROK_SEAT]} seatId="claude"
      onSeatChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains an exhausted seat and offers ranked alternatives that start a new chat', async () => {
    const onSeatChange = vi.fn();
    const user = userEvent.setup();
    render(<ComposerSeatBlockView now={NOW} seats={[CLAUDE_MAX_SEAT, LOCAL_SEAT_V2, CODEX_CREDITS_SEAT, GROK_SEAT]} seatId="claude"
      onSeatChange={onSeatChange} />);
    const alert = screen.getByRole('alert');
    // Claude publishes prose only; it is shown verbatim, never turned into a countdown.
    expect(alert).toHaveTextContent('Claude Max is out of usage — resets Sep 25 at 7pm (America/New_York).');
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    // Headroom first (Grok ready), then tight (Codex with credits), then local.
    expect(buttons).toEqual(['Grok', 'Personal Codex', 'Qwen3 Coder (local)']);
    await user.click(screen.getByRole('button', { name: 'Grok' }));
    expect(onSeatChange).toHaveBeenCalledWith({ seatId: 'grok', model: 'claude-opus-5' });
  });

  it('offers Reconnect for a signed-out seat, from the health report', async () => {
    const onReconnect = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<ComposerSeatBlockView now={NOW} seats={[CLAUDE_TIGHT_SEAT, GROK_SEAT]} seatId="claude" onSeatChange={() => {}}
      onReconnect={onReconnect} reports={[healthReport('claude', { connection: 'signed-out', fix: { kind: 'reauth' } })]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Claude Max is signed out — reconnect it to use this seat.');
    await user.click(screen.getByRole('button', { name: /Reconnect Claude Max/ }));
    expect(onReconnect).toHaveBeenCalledWith('claude');
    expect(await screen.findByText(/Sign-in opened in Terminal/)).toBeInTheDocument();
  });

  it('says so when nowhere else is ready', () => {
    const lonely: VerseSeat[] = [CLAUDE_MAX_SEAT];
    render(<ComposerSeatBlockView now={NOW} seats={lonely} seatId="claude" onSeatChange={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('No other seat is ready right now.');
  });
});
