/**
 * Workspace.live.test.tsx — what sits ABOVE THE COMPOSER while a turn runs
 * (SPEC-310C §2): the live status line on its amber hairline with Stop, the
 * "◌ N running tasks" chip beside it (opening the dock's Tasks pane), and the
 * engine's retry / watchdog notice in the one notice slot — not in the log.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseEvent } from '../../data/api-types.js';
import { evictAll } from '../../data/cache.js';
import { getDockState, resetDockStore } from './dock/dock-store.js';
import { bootstrap, CLAUDE_SEAT, ev, session } from './fixtures.test-support.js';
import { mockCompactViewport, type ViewportMock } from './shell/viewport.test-support.js';
import { useVerseSession } from './useVerseSession.js';
import { applyVerseEvents, resetVerseStore, seedVerseSession } from './verse-store.js';
import { Workspace, type WorkspaceProps } from './Workspace.js';

function Harness(p: Omit<WorkspaceProps, 'view'> & { sessionId: string }) {
  const view = useVerseSession(p.sessionId);
  return <Workspace {...p} view={view} />;
}

function props(over: Partial<WorkspaceProps> = {}): Omit<WorkspaceProps, 'view'> {
  return {
    seats: [CLAUDE_SEAT], projects: bootstrap().projects, dispatchEnabled: true, locked: false, hasAnySessions: true,
    onSend: vi.fn(async () => true), onStop: vi.fn(), onRename: vi.fn(async () => true), onRequestDelete: vi.fn(),
    onSeatChange: vi.fn(), onNew: vi.fn(), onRetry: vi.fn(), sidebarCollapsed: false, onToggleSidebar: vi.fn(),
    handoffOpen: false, onHandoffOpenChange: vi.fn(), otherRunning: [], ...over,
  };
}

const transient = (seq: number, e: Record<string, unknown>) => ({ seq, at: new Date().toISOString(), ...e }) as VerseEvent;

let vp: ViewportMock | null = null;
beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetDockStore();
  // Every read is an unmounted route (404); the session is seeded, so no stream opens.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource);
  seedVerseSession('vs_1', session({ id: 'vs_1', status: 'running' }), [
    ev(1, 'user-message', { turnId: 't1', text: 'run the tests' }),
    { ...ev(2, 'turn-started', { turnId: 't1', pid: 1 }), at: new Date(Date.now() - 14_000).toISOString() },
  ]);
});
afterEach(() => {
  vp?.restore();
  vp = null;
  vi.unstubAllGlobals();
});

describe('Workspace — the live row above the composer', () => {
  it('says what the turn is doing, with Stop, between the log and the message box', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<Harness sessionId="vs_1" {...props({ onStop })} />);
    act(() => { applyVerseEvents('vs_1', [ev(3, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Bash', input: { command: 'npm test' } })]); });
    const status = screen.getAllByRole('status').find((el) => el.textContent === 'Running: npm test');
    expect(status).toBeDefined();
    const row = status!.closest('[data-running]') as HTMLElement;
    expect(row).toHaveTextContent('npm test');
    // Order: log → live row → message box.
    const log = screen.getByRole('log');
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(log.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Stop this turn' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('counts running tasks — this turn\'s calls plus other chats — and opens the Tasks pane', async () => {
    const user = userEvent.setup();
    render(<Harness sessionId="vs_1" {...props({ otherRunning: [{ sessionId: 'vs_2', title: 'Docs', engine: 'local', startedAt: null, live: null }] })} />);
    act(() => { applyVerseEvents('vs_1', [ev(3, 'tool-use', { turnId: 't1', toolUseId: 't', name: 'Task', input: { description: 'review' } })]); });
    const chip = screen.getByRole('button', { name: '2 running tasks: 1 in this chat, 1 other chat. Open the Tasks pane.' });
    expect(chip).toHaveTextContent('2running tasks');
    await user.click(chip);
    expect(getDockState()).toMatchObject({ open: true, active: 'tasks' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('puts the engine\'s retry notice in the notice slot, and clears it when the turn ends', () => {
    render(<Harness sessionId="vs_1" {...props()} />);
    act(() => {
      applyVerseEvents('vs_1', [
        ev(3, 'text-delta', { turnId: 't1', text: 'Tests ' }),
        transient(3, { type: 'status', turnId: 't1', kind: 'retry', message: 'The API is overloaded — retrying (2 of 10).' }),
      ]);
    });
    const slot = screen.getByRole('region', { name: 'Notices' });
    expect(slot).toHaveTextContent('RetryingThe API is overloaded — retrying (2 of 10).');
    expect(screen.getByRole('log')).not.toHaveTextContent('overloaded');
    act(() => { applyVerseEvents('vs_1', [ev(4, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 64_000 })]); });
    expect(screen.queryByRole('region', { name: 'Notices' })).toBeNull();
    expect(screen.queryByRole('button', { name: /running task/ })).toBeNull();
  });

  it('at 375 (dark): the row still fits — the tasks word drops, the count stays', () => {
    vp = mockCompactViewport({ dark: true });
    render(<Harness sessionId="vs_1" {...props({ otherRunning: [{ sessionId: 'vs_2', title: 'Docs', engine: 'local', startedAt: null, live: null }] })} />);
    const chip = screen.getByRole('button', { name: /1 running task/ });
    expect(chip).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: 'Stop this turn' })).toBeInTheDocument();
  });
});
