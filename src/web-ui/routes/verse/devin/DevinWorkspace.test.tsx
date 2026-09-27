/**
 * 3.15 — a Devin chat's header: the live ACU meter in place of the context
 * ring ("remote" context), and "End the Devin session…" in Chat actions.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerseSeat, VerseSession } from '../../../data/api-types.js';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { bootstrap, CLAUDE_SEAT, session, verseFetch } from '../fixtures.test-support.js';
import type { VerseSessionView } from '../useVerseSession.js';
import { resetVerseStore } from '../verse-store.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { Workspace, type WorkspaceProps } from '../Workspace.js';

const DEVIN_SEAT: VerseSeat = {
  id: 'devin', engine: 'devin', label: 'Devin (cloud)', accountId: 'devin',
  models: [{ id: 'devin', label: 'Devin', contextWindow: null }], contextWindow: null,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

function devinSession(over: Partial<VerseSession> = {}): VerseSession {
  return session({
    id: 'vs_devin', engine: 'devin', seatId: 'devin', accountId: 'devin', model: 'devin', nativeSessionId: 'dv_20260927T0500_000001',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null },
    remote: { provider: 'devin', lane: 'cloud', url: 'https://app.devin.ai/sessions/devin-abc', state: 'waiting', acusConsumed: 7.5, acuCap: 10 },
    ...over,
  });
}

function view(s: VerseSession): VerseSessionView {
  return { sessionId: s.id, session: s, events: [], lastSeq: 0, loaded: true, loadError: null, stream: 'idle', transcript: { items: [], live: false, usage: null } };
}

function props(over: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    view: view(devinSession()), seats: [DEVIN_SEAT], projects: bootstrap().projects, dispatchEnabled: true, locked: false, hasAnySessions: true,
    onSend: vi.fn(async () => true), onStop: vi.fn(), onRename: vi.fn(async () => true), onRequestDelete: vi.fn(), onSeatChange: vi.fn(),
    onNew: vi.fn(), onRetry: vi.fn(), sidebarCollapsed: false, onToggleSidebar: vi.fn(), handoffOpen: false, onHandoffOpenChange: vi.fn(),
    otherRunning: [], ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  clearMutationToken();
  vi.stubGlobal('fetch', verseFetch({ bootstrap: bootstrap({ seats: [DEVIN_SEAT], sessions: [devinSession()] }) }).fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a Devin chat’s header', () => {
  it('shows the ACU meter (warn past 70% of the cap) instead of a context ring', () => {
    render(<Workspace {...props()} />);
    const meter = screen.getByTestId('devin-meter');
    expect(meter).toHaveTextContent('7.5/10 ACU');
    expect(meter).toHaveAttribute('data-tone', 'warn');
    expect(meter.getAttribute('aria-label')).toMatch(/Context: remote/);
    expect(screen.queryByRole('meter', { name: 'Context window' })).toBeNull();
  });

  it('says "remote" before any ACU reading', () => {
    render(<Workspace {...props({ view: view(devinSession({ remote: undefined, nativeSessionId: null })) })} />);
    expect(screen.getByTestId('devin-meter')).toHaveTextContent('remote');
  });

  it('offers "End the Devin session…" in Chat actions', async () => {
    const user = userEvent.setup();
    const onRequestDevinStop = vi.fn();
    render(<Workspace {...props({ onRequestDevinStop })} />);
    await user.click(screen.getByRole('button', { name: 'Chat actions' }));
    await user.click(screen.getByRole('menuitem', { name: /End the Devin session/ }));
    expect(onRequestDevinStop).toHaveBeenCalledTimes(1);
  });
});

describe('Auto seat on a Devin chat', () => {
  it('is offered exactly as on a Claude chat (3.15): Devin is a routable elite seat, so Auto can stay on it', async () => {
    const claude = session({ id: 'vs_claude', engine: 'claude', seatId: CLAUDE_SEAT.id, accountId: CLAUDE_SEAT.accountId, model: CLAUDE_SEAT.models[0]!.id, turnCount: 1 });
    const { unmount } = render(<Workspace {...props({ view: view(claude), seats: [CLAUDE_SEAT, DEVIN_SEAT] })} />);
    expect(await screen.findByRole('combobox', { name: 'Auto seat' })).toBeInTheDocument();
    unmount();

    render(<Workspace {...props({ seats: [CLAUDE_SEAT, DEVIN_SEAT] })} />);
    await waitFor(() => expect(screen.getByTestId('devin-meter')).toBeInTheDocument());
    expect(await screen.findByRole('combobox', { name: 'Auto seat' })).toBeInTheDocument();
  });
});

