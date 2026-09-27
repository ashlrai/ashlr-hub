/**
 * 3.15 — Devin as a chat seat, in the web UI: the transcript's status chips
 * and PR card, the store folding `remote-status` into the session (the
 * header meter), the seat picker's disabled "Connect Devin" state, and the
 * Stop confirmation.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { VerseSeat } from '../../../data/api-types.js';
import { ev, session } from '../fixtures.test-support.js';
import { SeatSelector } from '../SeatSelector.js';
import { Transcript } from '../Transcript.js';
import { applyVerseEvents, getVerseSessionState, resetVerseStore, seedVerseSession } from '../verse-store.js';
import { buildTranscript } from '../verse-transcript.js';
import { DevinStopDialog } from './DevinStopDialog.js';

const DEVIN_SEAT: VerseSeat = {
  id: 'devin',
  engine: 'devin',
  label: 'Devin (cloud)',
  accountId: 'devin',
  models: [{ id: 'devin', label: 'Devin', contextWindow: null, unavailableReason: 'Connect Devin: `ashlr devin connect`' }],
  contextWindow: null,
  health: { state: 'unavailable', summary: 'Connect Devin: `ashlr devin connect`', windows: [], observedAt: null },
};

describe('Devin in the transcript', () => {
  const events = [
    ev(1, 'user-message', { turnId: 't1', text: 'Add a health check' }),
    ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
    ev(3, 'remote-status', { turnId: 't1', provider: 'devin', state: 'working', message: 'Devin is working…', url: 'https://app.devin.ai/sessions/devin-abc', acusConsumed: 0.5, acuCap: 10 }),
    ev(4, 'assistant-message', { turnId: 't1', text: 'Opened a PR with the endpoint.' }),
    ev(5, 'remote-pr', { turnId: 't1', provider: 'devin', url: 'https://github.com/ashlrai/devin-canary/pull/42', state: 'open' }),
    ev(6, 'remote-status', { turnId: 't1', provider: 'devin', state: 'waiting', message: 'Devin is waiting for you.', url: 'https://app.devin.ai/sessions/devin-abc', acusConsumed: 1.25, acuCap: 10 }),
    ev(7, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: 'dv_20260927T0500_000001', durationMs: 90_000 }),
  ];

  it('shows status chips (with ACUs and the session link) and a PR card', () => {
    render(<Transcript transcript={buildTranscript(events)} loaded loadError={null} />);
    const log = screen.getByRole('log');
    const chips = log.querySelectorAll('[data-kind="remote"]');
    expect(chips).toHaveLength(2);
    expect(within(chips[1] as HTMLElement).getByText('Devin is waiting for you.')).toBeInTheDocument();
    expect(within(chips[1] as HTMLElement).getByText('1.3 of 10 ACU')).toBeInTheDocument();
    const open = within(chips[1] as HTMLElement).getByRole('link', { name: /Open in Devin/ });
    expect(open).toHaveAttribute('href', 'https://app.devin.ai/sessions/devin-abc');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');

    const card = log.querySelector('[data-kind="remote-pr"]') as HTMLElement;
    expect(within(card).getByText('Devin opened a pull request')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /ashlrai\/devin-canary#42/ })).toHaveAttribute('href', 'https://github.com/ashlrai/devin-canary/pull/42');
    expect(within(log).getByText('Opened a PR with the endpoint.')).toBeInTheDocument();
  });

  it('never renders a non-https session link or a non-GitHub PR', () => {
    render(<Transcript transcript={buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'x' }),
      ev(2, 'remote-status', { turnId: 't1', provider: 'devin', state: 'working', message: 'Devin is working…', url: 'javascript:alert(1)', acusConsumed: null, acuCap: null }),
      ev(3, 'remote-pr', { turnId: 't1', provider: 'devin', url: 'https://evil.example/pull/1', state: null }),
    ])} loaded loadError={null} />);
    const log = screen.getByRole('log');
    expect(within(log).queryByRole('link')).toBeNull();
    expect(log.querySelector('[data-kind="remote-pr"]')).toBeNull();
  });

  it('folds remote-status into the session record (the header ACU meter reads it live)', () => {
    resetVerseStore();
    seedVerseSession('vs_devin', session({ id: 'vs_devin', engine: 'devin', seatId: 'devin', model: 'devin' }), []);
    applyVerseEvents('vs_devin', events.slice(0, 6));
    expect(getVerseSessionState('vs_devin').session?.remote).toEqual({
      provider: 'devin', lane: 'cloud', url: 'https://app.devin.ai/sessions/devin-abc', state: 'waiting', acusConsumed: 1.25, acuCap: 10,
    });
  });
});

describe('the Devin seat in the picker', () => {
  it('is listed but disabled until connected, with the connect command', () => {
    render(<SeatSelector seats={[DEVIN_SEAT]} value={null} onChange={() => undefined} />);
    const option = screen.getByRole('option', { name: /Devin \(cloud\)/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toMatch(/Connect Devin: `ashlr devin connect`/);
  });
});

describe('DevinStopDialog', () => {
  it('offers stop-watching and terminate, focusing Cancel first', async () => {
    const user = userEvent.setup();
    const onStopWatching = vi.fn();
    const onTerminate = vi.fn();
    render(<DevinStopDialog open chatLabel="Add a health check" running onCancel={() => undefined} onStopWatching={onStopWatching} onTerminate={onTerminate} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Stop watching' }));
    expect(onStopWatching).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Terminate session' }));
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it('when nothing runs, only terminate is offered', () => {
    render(<DevinStopDialog open chatLabel="x" running={false} onCancel={() => undefined} onStopWatching={() => undefined} onTerminate={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Stop watching' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Terminate session' })).toBeInTheDocument();
  });
});
