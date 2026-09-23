/**
 * Workspace.context.test.tsx — the V3.9 context surfaces as the chat pane
 * wires them: the meter on the session's real budget, the mode chip and its
 * write, the advice banner, and the handoff hand-over (create → pre-filled
 * draft → switch). The pieces are unit-tested in ContextMeter.test.tsx; this
 * file pins the wiring between them and the stores.
 *
 * The handoff dialog itself is U9's and has its own suite; here it is stubbed
 * down to the one contract the workspace depends on — `onCreated(session,
 * text)` — so the test pins what the WORKSPACE does with a created chat.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseSession } from '../../data/api-types.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { loadDraft } from './chat/composer-state.js';
import { bootstrap, CLAUDE_1M_SEAT, CLAUDE_SEAT, CODEX_EXPANSIVE_SEAT, GROK_SEAT, LOCAL_SEAT, session, verseFetch } from './fixtures.test-support.js';
import type { VerseSessionView } from './useVerseSession.js';
import { getVerseSessionState, resetVerseStore, seedVerseSession } from './verse-store.js';
import { lastVerseSeat, resetVerseUi } from './verse-ui-store.js';
import { Workspace, type WorkspaceProps } from './Workspace.js';

const CREATED: VerseSession = session({
  id: 'vs_handoff',
  title: 'Continue: Fix the login bug',
  seatId: 'claude-a',
  model: 'claude-opus-5',
  turnCount: 0,
  handoffFrom: { sessionId: 'vs_1m', title: 'Fix the login bug' },
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 1_000_000 },
});

vi.mock('./context/HandoffDialog.js', () => ({
  HandoffDialog: (props: { session: VerseSession; open: boolean; onClose: () => void; onCreated: (s: VerseSession, text: string) => void }) => (
    <div role="dialog" aria-label="Continue in a fresh chat">
      <span>from {props.session.id}</span>
      <button type="button" onClick={() => props.onCreated(CREATED, 'Handoff note: finish the login fix.')}>Create chat</button>
      <button type="button" onClick={props.onClose}>Cancel</button>
    </div>
  ),
}));

const TOKEN = 'c'.repeat(64);
const SEATS = [CLAUDE_1M_SEAT, CLAUDE_SEAT, GROK_SEAT];

function viewFor(s: VerseSession | null): VerseSessionView {
  return {
    sessionId: s?.id ?? '',
    session: s,
    events: [],
    lastSeq: 0,
    loaded: true,
    loadError: null,
    stream: 'idle',
    transcript: { items: [], live: false, usage: null },
  };
}

function props(over: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    view: viewFor(null),
    seats: SEATS,
    projects: bootstrap().projects,
    dispatchEnabled: true,
    locked: false,
    hasAnySessions: true,
    onSend: vi.fn(async () => true),
    onStop: vi.fn(),
    onRename: vi.fn(async () => true),
    onDelete: vi.fn(async () => true),
    onSeatChange: vi.fn(),
    onNew: vi.fn(),
    onRetry: vi.fn(),
    sidebarCollapsed: false,
    onToggleSidebar: vi.fn(),
    resourcesOpen: true,
    onToggleResources: vi.fn(),
    ...over,
  };
}

/** A 1M Opus session, 300k deep — 82% of the way to its 367k compaction point. */
function nearSession(over: Partial<VerseSession> = {}): VerseSession {
  return session({
    id: 'vs_1m',
    seatId: 'claude-a',
    accountId: 'claude-a',
    model: 'claude-opus-5',
    updatedAt: new Date().toISOString(),
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 300_000, contextWindow: 1_000_000 },
    ...over,
  });
}

let fetchState: ReturnType<typeof verseFetch>['state'];

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  clearMutationToken();
  const s = nearSession();
  const stub = verseFetch({ bootstrap: bootstrap({ seats: SEATS, sessions: [s] }) });
  fetchState = stub.state;
  vi.stubGlobal('fetch', stub.fetch);
});
afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

describe('Workspace — meter and mode chip', () => {
  it('measures the session against its model budget and offers the mode chip for a 1M model', () => {
    render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    const meter = screen.getByRole('meter', { name: 'Context window' });
    expect(meter).toHaveTextContent('300k / 1M');
    expect(meter).toHaveTextContent('compacts ≈367k');
    expect(meter).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByRole('button', { name: 'Context mode: Standard' })).toBeInTheDocument();
  });

  it('offers no mode chip where no expansive budget exists (200k Claude, Grok)', () => {
    const { unmount } = render(<Workspace {...props({ view: viewFor(session()) })} />);
    expect(screen.queryByRole('button', { name: /Context mode/ })).toBeNull();
    unmount();
    const grok = session({ id: 'vs_g', engine: 'grok', seatId: 'grok-a', model: 'build-fast', usage: { ...session().usage, contextWindow: 500_000 } });
    render(<Workspace {...props({ view: viewFor(grok) })} />);
    expect(screen.queryByRole('button', { name: /Context mode/ })).toBeNull();
    expect(screen.getByRole('meter')).toHaveTextContent('compacts ≈400k');
  });

  it('switches mode through the API on a click and moves the meter with the answer', async () => {
    const user = userEvent.setup();
    setMutationToken(TOKEN);
    const s = nearSession();
    seedVerseSession(s.id, s, []);
    const view1 = render(<Workspace {...props({ view: viewFor(s) })} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Standard' }));
    await user.click(screen.getByRole('menuitemradio', { name: /Expansive/ }));

    await waitFor(() => expect(getVerseSessionState(s.id).session?.contextMode).toBe('expansive'));
    const call = fetchState.calls.find((c) => c.path === '/api/verse/sessions/vs_1m/context-mode');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ mode: 'expansive' });
    expect(call?.headers['x-ashlr-token']).toBe(TOKEN);

    // The host re-renders with the store's record, as useVerseSession does.
    view1.rerender(<Workspace {...props({ view: viewFor(getVerseSessionState(s.id).session) })} />);
    expect(screen.getByRole('button', { name: 'Context mode: Expansive' })).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveTextContent('compacts ≈967k');
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'ok');
  });

  it('asks for the mutation token before switching when none is held — and sends nothing', async () => {
    const user = userEvent.setup();
    render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Standard' }));
    await user.click(screen.getByRole('menuitemradio', { name: /Expansive/ }));
    expect(await screen.findByText(/compaction flag this chat runs with/)).toBeInTheDocument();
    expect(fetchState.calls.some((c) => c.path.endsWith('/context-mode'))).toBe(false);
  });
});

describe('Workspace — no mode change mid-turn', () => {
  it('disables the mode chip while a turn runs, saying why, and sends nothing', async () => {
    const user = userEvent.setup();
    setMutationToken(TOKEN);
    render(<Workspace {...props({ view: viewFor(nearSession({ status: 'running' })) })} />);
    const chip = screen.getByRole('button', { name: 'Context mode: Standard' });
    expect(chip).toBeDisabled();
    expect(chip.getAttribute('title')).toMatch(/current turn finishes/);
    await user.click(chip);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(fetchState.calls.some((c) => c.path.endsWith('/context-mode'))).toBe(false);
  });

  it('closes an open mode menu when a turn starts under it', async () => {
    const user = userEvent.setup();
    const view = render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Standard' }));
    expect(screen.getByRole('menu', { name: 'Context mode' })).toBeInTheDocument();
    view.rerender(<Workspace {...props({ view: viewFor(nearSession({ status: 'running' })) })} />);
    expect(screen.queryByRole('menu', { name: 'Context mode' })).toBeNull();
  });
});

describe('Workspace — compact now', () => {
  it('opens from the mode menu and sends /compact [focus] through the composer’s own send path', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    render(<Workspace {...props({ view: viewFor(nearSession()), onSend })} />);
    await user.click(screen.getByRole('button', { name: 'Context mode: Standard' }));
    await user.click(screen.getByRole('menuitem', { name: /Compact now/ }));

    const panel = screen.getByRole('region', { name: 'Compact this chat' });
    // Under the strip, like the advice — never in the fixed-height header.
    expect(panel.closest('header')).toBeNull();
    expect(panel).toHaveTextContent('Spends usage on this seat');
    await user.type(within(panel).getByLabelText('Keep in focus (optional)'), 'the login fix');
    await user.click(within(panel).getByRole('button', { name: 'Compact now' }));

    expect(onSend).toHaveBeenCalledWith('/compact the login fix');
    expect(screen.queryByRole('region', { name: 'Compact this chat' })).toBeNull();
    // Not a side channel: no request of its own, and no mode change.
    expect(fetchState.calls.some((c) => c.path.endsWith('/context-mode'))).toBe(false);
  });

  it('is reachable from the handoff note on a local chat, where it is free but slow', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    // 30k of a 64k tag the CLI reported, compacting near 32.5k: well into the handoff range.
    const local = session({
      id: 'vs_local', engine: 'local', seatId: LOCAL_SEAT.id, accountId: 'local', model: 'qwen3-coder', updatedAt: new Date().toISOString(),
      usage: { ...session().usage, contextTokens: 30_000, contextWindow: 65_536, contextWindowSource: 'runtime', autoCompactAt: 32_536 },
    });
    render(<Workspace {...props({ view: viewFor(local), seats: [...SEATS, LOCAL_SEAT], onSend })} />);
    // Local has no modes, so no chip — the note is the way in.
    expect(screen.queryByRole('button', { name: /Context mode/ })).toBeNull();
    const note = screen.getByRole('region', { name: 'Context advice' });
    await user.click(within(note).getByRole('button', { name: 'Compact now…' }));
    const panel = screen.getByRole('region', { name: 'Compact this chat' });
    expect(panel).toHaveTextContent('Free — it runs on the local model');
    expect(panel).toHaveTextContent('can take minutes');
    await user.click(within(panel).getByRole('button', { name: 'Compact now' }));
    expect(onSend).toHaveBeenCalledWith('/compact');
  });

  it('is not offered on codex, whose exec has no compact verb, nor on grok', () => {
    const codex = session({
      id: 'vs_codex', engine: 'codex', seatId: CODEX_EXPANSIVE_SEAT.id, accountId: 'codex-b', model: 'gpt-6-astra', updatedAt: new Date().toISOString(),
      usage: { ...session().usage, contextTokens: 230_000, contextWindow: CODEX_EXPANSIVE_SEAT.contextWindow },
    });
    const { unmount } = render(<Workspace {...props({ view: viewFor(codex), seats: [...SEATS, CODEX_EXPANSIVE_SEAT] })} />);
    // The codex chat has modes and a handoff note — but no compact action in either.
    expect(screen.getByRole('button', { name: 'Context mode: Standard' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Context advice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compact now…' })).toBeNull();
    unmount();

    const grok = session({ id: 'vs_g', engine: 'grok', seatId: 'grok-a', model: 'build-fast', updatedAt: new Date().toISOString(),
      usage: { ...session().usage, contextTokens: 390_000, contextWindow: 500_000 } });
    render(<Workspace {...props({ view: viewFor(grok) })} />);
    expect(screen.getByRole('region', { name: 'Context advice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compact now…' })).toBeNull();
  });

  it('keeps an open panel but disables it once a turn is running', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    const view = render(<Workspace {...props({ view: viewFor(nearSession()), onSend })} />);
    await user.click(within(screen.getByRole('region', { name: 'Context advice' })).getByRole('button', { name: 'Compact now…' }));
    view.rerender(<Workspace {...props({ view: viewFor(nearSession({ status: 'running' })), onSend })} />);
    const panel = screen.getByRole('region', { name: 'Compact this chat' });
    expect(within(panel).getByRole('button', { name: 'Compact now' })).toBeDisabled();
    expect(panel).toHaveTextContent('Available when the current turn finishes.');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('Workspace — handoff', () => {
  it('shows the advice under the header, and hands the created chat over with its note pre-filled', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    render(<Workspace {...props({ view: viewFor(nearSession()), onOpenSession })} />);

    const note = screen.getByRole('region', { name: 'Context advice' });
    // Not in the header strip: that is one fixed-height row.
    expect(note.closest('header')).toBeNull();
    expect(note).toHaveTextContent('About 67k tokens left before the CLI auto-compacts.');

    await user.click(within(note).getByRole('button', { name: 'Continue in a fresh chat…' }));
    const dialog = screen.getByRole('dialog', { name: 'Continue in a fresh chat' });
    expect(dialog).toHaveTextContent('from vs_1m');
    await user.click(within(dialog).getByRole('button', { name: 'Create chat' }));

    // Switched to the new chat; nothing was sent — the note waits in its draft.
    expect(onOpenSession).toHaveBeenCalledWith('vs_handoff');
    expect(loadDraft('vs_handoff')).toBe('Handoff note: finish the login fix.');
    expect(getVerseSessionState('vs_handoff').session?.handoffFrom).toEqual({ sessionId: 'vs_1m', title: 'Fix the login bug' });
    expect(lastVerseSeat(CREATED.projectPath)).toEqual({ seatId: 'claude-a', model: 'claude-opus-5' });
    expect(fetchState.calls.some((c) => c.path.endsWith('/turns'))).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Continue in a fresh chat' })).toBeNull();
  });

  it('announces the new chat when the host cannot switch to it', async () => {
    const user = userEvent.setup();
    render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    await user.click(screen.getByRole('button', { name: 'Continue in a fresh chat…' }));
    await user.click(screen.getByRole('button', { name: 'Create chat' }));
    expect(screen.getByRole('status')).toHaveTextContent('Started “Continue: Fix the login bug” — open it from the chat list');
    expect(loadDraft('vs_handoff')).toBe('Handoff note: finish the login fix.');
  });

  it('opens a continued chat with a link back to its source and the note in the composer', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    localStorage.clear();
    const { saveDraft } = await import('./chat/composer-state.js');
    saveDraft(CREATED.id, 'Handoff note: finish the login fix.');
    render(<Workspace {...props({ view: viewFor(CREATED), onOpenSession })} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Handoff note: finish the login fix.');
    expect(screen.getByText(/Handoff note drafted from the previous chat/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fix the login bug' }));
    expect(onOpenSession).toHaveBeenCalledWith('vs_1m');
  });

  it('mounts no dialog — and so fetches nothing — until the operator asks', () => {
    render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    expect(screen.queryByRole('dialog', { name: 'Continue in a fresh chat' })).toBeNull();
    expect(fetchState.calls.some((c) => c.path.includes('handoff-preview'))).toBe(false);
  });
});
