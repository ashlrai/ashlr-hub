/**
 * Workspace.composer.test.tsx — how the chat pane wires C3's Composer into
 * the rest of the workbench (3.10 integration of the C2/C3/C5 requests):
 *
 *   - the composer bridge: Review's "Add to message" and Terminal's "Send
 *     selection to chat" (insertIntoComposer) land in the draft, never sent;
 *   - `/handoff` and "Continue on ‹seat›" open the handoff, with the same
 *     reason the ⋯ menu gives when it cannot;
 *   - "Queued turns" sits between the notice slot and the live row
 *     (SPEC-310C §2 order), portalled out of the composer;
 *   - a queue read that answers `{}` no longer takes the composer down.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseQueueResponse } from '../../../core/verse/workbench-types.js';
import { evictAll } from '../../data/cache.js';
import { insertIntoComposer } from './chat/composer-bridge.js';
import { resetDockStore } from './dock/dock-store.js';
import { bootstrap, CLAUDE_SEAT, LOCAL_SEAT, ev, session } from './fixtures.test-support.js';
import { mockCompactViewport, type ViewportMock } from './shell/viewport.test-support.js';
import { useVerseSession } from './useVerseSession.js';
import { resetVerseStore, seedVerseSession } from './verse-store.js';
import { Workspace, type WorkspaceProps } from './Workspace.js';

function Harness(p: Omit<WorkspaceProps, 'view'> & { sessionId: string }) {
  const view = useVerseSession(p.sessionId);
  return <Workspace {...p} view={view} />;
}

function props(over: Partial<WorkspaceProps> = {}): Omit<WorkspaceProps, 'view'> {
  return {
    seats: [CLAUDE_SEAT, LOCAL_SEAT], projects: bootstrap().projects, dispatchEnabled: true, locked: false, hasAnySessions: true,
    onSend: vi.fn(async () => true), onStop: vi.fn(), onRename: vi.fn(async () => true), onRequestDelete: vi.fn(),
    onSeatChange: vi.fn(), onNew: vi.fn(), onRetry: vi.fn(), sidebarCollapsed: false, onToggleSidebar: vi.fn(),
    handoffOpen: false, onHandoffOpenChange: vi.fn(), otherRunning: [], ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Every route 404s except the queue, which answers `queueBody`. */
function stubQueue(queueBody: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/verse/queue/')) return json(queueBody);
    return new Response('not found', { status: 404 });
  }));
}

function seed(status: 'idle' | 'running') {
  const events = [ev(1, 'user-message', { turnId: 't1', text: 'run the tests' })];
  if (status === 'running') events.push({ ...ev(2, 'turn-started', { turnId: 't1', pid: 1 }), at: new Date(Date.now() - 14_000).toISOString() });
  else events.push(ev(2, 'turn-started', { turnId: 't1', pid: 1 }), ev(3, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1000 }));
  seedVerseSession('vs_1', session({ id: 'vs_1', status, turnCount: 1 }), events);
}

let vp: ViewportMock | null = null;
beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetDockStore();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource);
});
afterEach(() => {
  vp?.restore();
  vp = null;
  vi.unstubAllGlobals();
});

describe('Workspace ↔ composer bridge', () => {
  it('Add to message / Send to chat append to the draft on its own paragraph, focus the box, and never send', async () => {
    seed('idle');
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    render(<Harness sessionId="vs_1" {...props({ onSend })} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'Please fix');
    let ok = false;
    act(() => { ok = insertIntoComposer('vs_1', 'src/app.ts:12: this throws on null'); });
    expect(ok).toBe(true);
    await waitFor(() => expect(box).toHaveValue('Please fix\n\nsrc/app.ts:12: this throws on null'));
    // Two inserts in one tick (batched) both arrive — neither is lost.
    act(() => {
      insertIntoComposer('vs_1', '```\nnpm ERR! 1\n```');
      insertIntoComposer('vs_1', 'src/app.ts:40: and here');
    });
    await waitFor(() => expect(box).toHaveValue('Please fix\n\nsrc/app.ts:12: this throws on null\n\n```\nnpm ERR! 1\n```\n\nsrc/app.ts:40: and here'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('another chat, or a read-only server, is refused so the caller can say so', () => {
    seed('idle');
    render(<Harness sessionId="vs_1" {...props({ dispatchEnabled: false })} />);
    // No inserter registered and the box is disabled: the bridge answers false.
    expect(insertIntoComposer('vs_1', 'note')).toBe(false);
    expect(insertIntoComposer('vs_other', 'note')).toBe(false);
  });
});

describe('Workspace → Composer: handoff and Continue on', () => {
  it('/handoff opens the handoff dialog from the composer', async () => {
    seed('idle');
    const user = userEvent.setup();
    const onHandoffOpenChange = vi.fn();
    render(<Harness sessionId="vs_1" {...props({ onHandoffOpenChange })} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), '/handoff');
    await user.keyboard('{Enter}');
    expect(onHandoffOpenChange).toHaveBeenCalledWith(true);
  });

  it('while a turn runs, /handoff is listed disabled with the header menu\'s own reason', async () => {
    seed('running');
    const user = userEvent.setup();
    const onHandoffOpenChange = vi.fn();
    render(<Harness sessionId="vs_1" {...props({ onHandoffOpenChange })} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), '/hand');
    const option = screen.getByRole('option', { name: /handoff/i });
    expect(option).toHaveTextContent('Available when the current turn finishes.');
    await user.keyboard('{Enter}');
    expect(onHandoffOpenChange).not.toHaveBeenCalled();
  });

  it('seat chip ▸ Continue on ‹seat› opens the handoff (idle) — and a new chat on that seat while a turn runs', async () => {
    seed('idle');
    const user = userEvent.setup();
    const onHandoffOpenChange = vi.fn();
    const onSeatChange = vi.fn();
    const view = render(<Harness sessionId="vs_1" {...props({ onHandoffOpenChange, onSeatChange })} />);
    await user.click(screen.getByRole('button', { name: /^Seat: / }));
    await user.click(screen.getByRole('menuitem', { name: new RegExp(`Continue on ${LOCAL_SEAT.label.replace(/[()]/g, "\\$&")}`) }));
    expect(onHandoffOpenChange).toHaveBeenCalledWith(true);
    expect(onSeatChange).not.toHaveBeenCalled();
    view.unmount();

    resetVerseStore();
    seed('running');
    render(<Harness sessionId="vs_1" {...props({ onHandoffOpenChange, onSeatChange })} />);
    await user.click(screen.getByRole('button', { name: /^Seat: / }));
    await user.click(screen.getByRole('menuitem', { name: new RegExp(`Continue on ${LOCAL_SEAT.label.replace(/[()]/g, "\\$&")}`) }));
    expect(onSeatChange).toHaveBeenCalledWith(expect.objectContaining({ seatId: LOCAL_SEAT.id }));
  });
});

describe('Workspace — queued turns sit above the live row', () => {
  const queued: VerseQueueResponse = {
    sessionId: 'vs_1',
    items: [{ id: 'q1', sessionId: 'vs_1', text: 'then update the changelog', createdAt: new Date().toISOString() }],
    held: false,
    heldReason: null,
  };

  it('renders in the queue slot: notice → queued → live row → message box', async () => {
    seed('running');
    stubQueue(queued);
    render(<Harness sessionId="vs_1" {...props()} />);
    const row = await screen.findByRole('region', { name: '1 queued follow-up' });
    const slot = screen.getByTestId('queue-slot');
    expect(slot).toContainElement(row);
    const stop = screen.getByRole('button', { name: 'Stop this turn' });
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(row.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stop.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Its keys still work from the new place.
    expect(within(row).getByRole('button', { name: 'Edit queued message 1' })).toBeEnabled();
  });

  it('a queue read answering {} (no items) is "no queue", not a crash', async () => {
    seed('running');
    stubQueue({});
    render(<Harness sessionId="vs_1" {...props()} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await act(async () => { await Promise.resolve(); });
    expect(box).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /queued follow-up/ })).toBeNull();
    // With no usable queue, Enter during a turn keeps the draft (3.9 behaviour).
    const user = userEvent.setup();
    await user.type(box, 'later{Enter}');
    expect(box).toHaveValue('later');
  });

  it('at 375 (dark) the queued row still renders in its slot', async () => {
    vp = mockCompactViewport({ dark: true });
    seed('running');
    stubQueue({ ...queued, held: true, heldReason: 'the last turn was stopped.' });
    render(<Harness sessionId="vs_1" {...props()} />);
    const row = await screen.findByRole('region', { name: '1 queued follow-up' });
    expect(screen.getByTestId('queue-slot')).toContainElement(row);
    expect(row).toHaveTextContent('Held — the last turn was stopped.');
  });
});
