import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLAUDE_MAX_SEAT, GROK_SEAT } from '../seat-fixtures.test-support.js';
import { SeatHealthBannerView } from './SeatHealthBanner.js';
import { healthReport } from './health.test-support.js';

const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const SEATS = [CLAUDE_MAX_SEAT, GROK_SEAT];


describe('SeatHealthBannerView', () => {
  it('renders nothing while every seat is connected (or simply not checked yet)', () => {
    const { container } = render(<SeatHealthBannerView now={NOW} seats={SEATS} reports={[
      healthReport('claude'),
      healthReport('grok', { connection: 'unknown', reasons: ['No status reading yet — the background health sweep has not reached this seat.'] }),
    ]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names a signed-out seat, says why, and opens its sign-in on Reconnect', async () => {
    const onReconnect = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<SeatHealthBannerView now={NOW} seats={SEATS} onReconnect={onReconnect} reports={[
      healthReport('claude', { connection: 'signed-out', reasons: ['Claude Code reports this account is not signed in.'], fix: { kind: 'reauth' } }),
    ]} />);
    const region = screen.getByRole('region', { name: 'Seat health' });
    expect(region).toHaveTextContent("Claude Max can't run turns right now.");
    expect(region).toHaveTextContent('signed out');
    expect(region).toHaveTextContent('Claude Code reports this account is not signed in.');
    await user.click(screen.getByRole('button', { name: 'Reconnect Claude Max' }));
    expect(onReconnect).toHaveBeenCalledWith('claude');
    expect(await screen.findByText(/Sign-in opened in Terminal/)).toBeInTheDocument();
  });

  it('shows the server’s refusal sentence when Reconnect fails', async () => {
    const user = userEvent.setup();
    render(<SeatHealthBannerView now={NOW} seats={SEATS}
      onReconnect={async () => { throw new Error('Opening a sign-in window is supported on macOS only.'); }}
      reports={[healthReport('claude', { connection: 'signed-out', fix: { kind: 'reauth' } })]} />);
    await user.click(screen.getByRole('button', { name: 'Reconnect Claude Max' }));
    expect(await screen.findByText('Opening a sign-in window is supported on macOS only.')).toHaveAttribute('data-error', 'true');
  });

  it('offers the repin command to copy — never runs it', async () => {
    // userEvent installs its own clipboard; spy on it after setup.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const command = ['ashlr', 'resources', 'profile', 'repin', '--directory', '~/.ashlr/native-profiles/grok-a',
      '--executable', '~/.grok/downloads/grok-0.2.118-macos-aarch64'];
    render(<SeatHealthBannerView now={NOW} seats={SEATS} reports={[
      healthReport('grok', { engine: 'grok', connection: 'binary-skew', fix: { kind: 'repin', command },
        reasons: ['Pinned to Grok CLI 0.2.106; 0.2.118 is installed. Re-pin to pick up newer models.'] }),
    ]} />);
    const text = command.join(' ');
    expect(screen.getByText(text).tagName).toBe('CODE');
    expect(screen.queryByRole('button', { name: /Reconnect/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Copy the repin command for Grok' }));
    expect(writeText).toHaveBeenCalledWith(text);
    expect(await screen.findByText('Command copied.')).toBeInTheDocument();
  });

  it('shows an exhausted seat’s reset time and runs a check on demand', async () => {
    const onRefresh = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<SeatHealthBannerView now={NOW} seats={SEATS} onRefresh={onRefresh} reports={[
      healthReport('grok', { engine: 'grok', connection: 'exhausted', resetAt: '2026-09-25T18:25:00.000Z', fix: { kind: 'wait' } }),
    ]} />);
    // The reset is local wall-clock time with a countdown beside it — never the raw ISO instant.
    const reset = screen.getByText(/^resets /);
    expect(reset).toHaveTextContent(/ · usable again in \d/);
    expect(reset).not.toHaveTextContent('2026-09-25T');
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });
});
