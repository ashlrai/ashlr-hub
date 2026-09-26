/**
 * Workspace.context.test.tsx — the V3.9 context surfaces as the 3.10 chat
 * pane wires them: the header's context RING on the session's real budget,
 * the mode switch and Compact now in the ⋯ "Chat actions" menu, the advice
 * in the ONE notice slot above the composer, and the handoff hand-over
 * (create → pre-filled draft → switch). The pieces are unit-tested in
 * ContextMeter.test.tsx; this file pins the wiring between them and the
 * stores.
 *
 * The handoff dialog itself is U9's and has its own suite; here it is stubbed
 * down to the one contract the workspace depends on — `onCreated(session,
 * text)` — so the test pins what the WORKSPACE does with a created chat.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseEvent, VerseSession } from '../../data/api-types.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { loadDraft } from './chat/composer-state.js';
import { bootstrap, CLAUDE_1M_SEAT, CLAUDE_SEAT, CODEX_EXPANSIVE_SEAT, ev, GROK_SEAT, LOCAL_SEAT, session, verseFetch } from './fixtures.test-support.js';
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

function viewFor(s: VerseSession | null, events: VerseEvent[] = []): VerseSessionView {
  return {
    sessionId: s?.id ?? '',
    session: s,
    events,
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
    onRequestDelete: vi.fn(),
    onSeatChange: vi.fn(),
    onNew: vi.fn(),
    onRetry: vi.fn(),
    sidebarCollapsed: false,
    onToggleSidebar: vi.fn(),
    handoffOpen: false,
    onHandoffOpenChange: vi.fn(),
    otherRunning: [],
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

/**
 * The handoff dialog's open state is lifted to the Chat section in 3.10 (the
 * dock and the sidebar open it too); this holds it the way the section does.
 */
function Stateful(p: WorkspaceProps) {
  const [open, setOpen] = useState(false);
  return <Workspace {...p} handoffOpen={open} onHandoffOpenChange={setOpen} />;
}

async function openActions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Chat actions' }));
  return screen.getByRole('menu', { name: 'Chat actions' });
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

describe('Workspace — the context ring', () => {
  it('measures the session against its model budget: the ring, its percent and the full reading', () => {
    render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    const meter = screen.getByRole('meter', { name: 'Context window' });
    expect(meter).toHaveTextContent('30%');
    expect(meter.getAttribute('aria-valuetext')).toContain('300k / 1M');
    expect(meter.getAttribute('aria-valuetext')).toContain('compacts at about 367k');
    expect(meter).toHaveAttribute('data-tone', 'warn');
    // The compaction point is drawn on the ring.
    expect(meter.querySelector('[data-testid="compaction-tick"]')).not.toBeNull();
    // And the ring lives in the header strip.
    expect(meter.closest('header')).not.toBeNull();
  });

  it('draws a local chat against the window the CLI was told, not the seat\'s current option', () => {
    // Stored at creation on the Ollama lane; LOCAL_SEAT now lists the tag at 65,536.
    const local = session({
      id: 'vs_local', engine: 'local', seatId: LOCAL_SEAT.id, accountId: 'local', model: LOCAL_SEAT.models[0]!.id, updatedAt: new Date().toISOString(),
      usage: { ...session().usage, contextTokens: 120_000, contextWindow: 262_144, contextWindowSource: 'provider-catalog', autoCompactAt: 229_144 },
    });
    render(<Workspace {...props({ view: viewFor(local), seats: [...SEATS, LOCAL_SEAT] })} />);
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuetext')).toContain('120k / 256k');
    expect(meter).not.toHaveAttribute('data-tone', 'over');
    expect(meter.getAttribute('title')).toContain('Verse passes this window to Claude Code');
    expect(screen.queryByRole('region', { name: 'Context advice' })).toBeNull();
  });
});

describe('Workspace — context mode, from the ⋯ menu', () => {
  it('offers the switch only where an expansive budget exists (1M yes; 200k Claude, Grok no)', async () => {
    const user = userEvent.setup();
    const first = render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    let menu = await openActions(user);
    const item = within(menu).getByRole('menuitem', { name: /Context: switch to Expansive/ });
    // The cost is said in the item, before the click.
    expect(item).toHaveTextContent('Every turn re-sends the whole context');
    first.unmount();

    const second = render(<Workspace {...props({ view: viewFor(session()) })} />);
    menu = await openActions(user);
    expect(within(menu).queryByRole('menuitem', { name: /Context: switch/ })).toBeNull();
    // …but a 200k Claude chat can still compact on request.
    expect(within(menu).getByRole('menuitem', { name: /Compact now/ })).toBeInTheDocument();
    second.unmount();

    const grok = session({ id: 'vs_g', engine: 'grok', seatId: 'grok-a', model: 'build-fast', usage: { ...session().usage, contextWindow: 500_000 } });
    render(<Workspace {...props({ view: viewFor(grok) })} />);
    menu = await openActions(user);
    // Grok can neither switch modes nor compact on request.
    expect(within(menu).queryByRole('menuitem', { name: /Context: switch/ })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: /Compact now/ })).toBeNull();
  });

  it('switches mode through the API and moves the ring with the answer', async () => {
    const user = userEvent.setup();
    setMutationToken(TOKEN);
    const s = nearSession();
    seedVerseSession(s.id, s, []);
    const view1 = render(<Workspace {...props({ view: viewFor(s) })} />);
    const menu = await openActions(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Context: switch to Expansive/ }));

    await waitFor(() => expect(getVerseSessionState(s.id).session?.contextMode).toBe('expansive'));
    const call = fetchState.calls.find((c) => c.path === '/api/verse/sessions/vs_1m/context-mode');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ mode: 'expansive' });
    expect(call?.headers['x-ashlr-token']).toBe(TOKEN);

    view1.rerender(<Workspace {...props({ view: viewFor(getVerseSessionState(s.id).session) })} />);
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuetext')).toContain('compacts at about 967k');
    expect(meter).toHaveAttribute('data-tone', 'ok');
    // …and the menu now offers the way back, warning that it compacts.
    const again = await openActions(user);
    expect(within(again).getByRole('menuitem', { name: /Context: switch to Standard/ })).toBeInTheDocument();
  });

  it('asks for the mutation token before switching when none is held — and sends nothing', async () => {
    const user = userEvent.setup();
    render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    const menu = await openActions(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Context: switch to Expansive/ }));
    expect(await screen.findByText(/compaction flag this chat runs with/)).toBeInTheDocument();
    expect(fetchState.calls.some((c) => c.path.endsWith('/context-mode'))).toBe(false);
  });

  it('disables the switch while a turn runs, saying why, and sends nothing', async () => {
    const user = userEvent.setup();
    setMutationToken(TOKEN);
    render(<Workspace {...props({ view: viewFor(nearSession({ status: 'running' })) })} />);
    const menu = await openActions(user);
    const item = within(menu).getByRole('menuitem', { name: /Context: switch to Expansive/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent(/current turn finishes/);
    await user.click(item);
    expect(fetchState.calls.some((c) => c.path.endsWith('/context-mode'))).toBe(false);
  });

  it('keyboard: ↓ moves through the menu, Esc closes it and returns focus to ⋯', async () => {
    const user = userEvent.setup();
    render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    const trigger = screen.getByRole('button', { name: 'Chat actions' });
    await user.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Chat actions' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('Workspace — compact now', () => {
  it('opens from the ⋯ menu into the notice slot and sends /compact [focus] through the composer’s own send path', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    render(<Workspace {...props({ view: viewFor(nearSession()), onSend })} />);
    const menu = await openActions(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Compact now/ }));

    const panel = screen.getByRole('region', { name: 'Compact this chat' });
    expect(within(panel).getByLabelText('Keep in focus (optional)')).toHaveFocus();
    // In the one slot above the composer — never in the header. The advice
    // note is also active on this chat, but the panel the operator just
    // asked for is the one shown.
    expect(panel.closest('header')).toBeNull();
    expect(screen.getByRole('region', { name: 'Notices' }).contains(panel)).toBe(true);
    expect(panel).toHaveTextContent('Spends usage on this seat');
    await user.type(within(panel).getByLabelText('Keep in focus (optional)'), 'the login fix');
    await user.click(within(panel).getByRole('button', { name: 'Compact now' }));

    expect(onSend).toHaveBeenCalledWith('/compact the login fix');
    expect(screen.queryByRole('region', { name: 'Compact this chat' })).toBeNull();
    expect(fetchState.calls.some((c) => c.path.endsWith('/context-mode'))).toBe(false);
  });

  it('hands focus back to ⋯ when the panel is cancelled', async () => {
    const user = userEvent.setup();
    render(<Workspace {...props({ view: viewFor(nearSession()) })} />);
    const menu = await openActions(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Compact now/ }));
    const panel = screen.getByRole('region', { name: 'Compact this chat' });
    expect(within(panel).getByLabelText('Keep in focus (optional)')).toHaveFocus();
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Compact this chat' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Chat actions' })).toHaveFocus();
  });

  it('is on demand for a local chat with no advice showing, and disabled with a reason on an empty chat', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    const local = session({
      id: 'vs_local', engine: 'local', seatId: LOCAL_SEAT.id, accountId: 'local', model: 'qwen3-coder', updatedAt: new Date().toISOString(), turnCount: 3,
      usage: { ...session().usage, contextTokens: 20_000, contextWindow: 65_536, contextWindowSource: 'runtime', autoCompactAt: 32_536 },
    });
    const view = render(<Workspace {...props({ view: viewFor(local), seats: [...SEATS, LOCAL_SEAT], onSend })} />);
    expect(screen.queryByRole('region', { name: 'Context advice' })).toBeNull();
    let menu = await openActions(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Compact now/ }));
    await user.click(within(screen.getByRole('region', { name: 'Compact this chat' })).getByRole('button', { name: 'Compact now' }));
    expect(onSend).toHaveBeenCalledWith('/compact');
    view.unmount();

    render(<Workspace {...props({ view: viewFor({ ...local, turnCount: 0 }), seats: [...SEATS, LOCAL_SEAT], onSend })} />);
    menu = await openActions(user);
    const item = within(menu).getByRole('menuitem', { name: /Compact now/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('Nothing to compact yet');
  });

  it('is reachable from the handoff note on a local chat, where it is free but slow', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    const local = session({
      id: 'vs_local', engine: 'local', seatId: LOCAL_SEAT.id, accountId: 'local', model: 'qwen3-coder', updatedAt: new Date().toISOString(),
      usage: { ...session().usage, contextTokens: 30_000, contextWindow: 65_536, contextWindowSource: 'runtime', autoCompactAt: 32_536 },
    });
    render(<Workspace {...props({ view: viewFor(local), seats: [...SEATS, LOCAL_SEAT], onSend })} />);
    const note = screen.getByRole('region', { name: 'Context advice' });
    await user.click(within(note).getByRole('button', { name: 'Compact now…' }));
    const panel = screen.getByRole('region', { name: 'Compact this chat' });
    expect(panel).toHaveTextContent('Free — it runs on the local model');
    expect(panel).toHaveTextContent('can take minutes');
    await user.click(within(panel).getByRole('button', { name: 'Compact now' }));
    expect(onSend).toHaveBeenCalledWith('/compact');
  });

  it('is not offered on codex, whose exec has no compact verb, nor on grok', async () => {
    const user = userEvent.setup();
    const codex = session({
      id: 'vs_codex', engine: 'codex', seatId: CODEX_EXPANSIVE_SEAT.id, accountId: 'codex-b', model: 'gpt-6-astra', updatedAt: new Date().toISOString(),
      usage: { ...session().usage, contextTokens: 230_000, contextWindow: CODEX_EXPANSIVE_SEAT.contextWindow },
    });
    const { unmount } = render(<Workspace {...props({ view: viewFor(codex), seats: [...SEATS, CODEX_EXPANSIVE_SEAT] })} />);
    expect(screen.getByRole('region', { name: 'Context advice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compact now…' })).toBeNull();
    const menu = await openActions(user);
    expect(within(menu).getByRole('menuitem', { name: /Context: switch to Expansive/ })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Compact now/ })).toBeNull();
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

describe('Workspace — idle-cache advice', () => {
  it('times "idle over an hour" from the last turn in the log, so a rename or mode switch does not reset it', () => {
    const lastTurn = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const s = nearSession({ updatedAt: new Date().toISOString(), usage: { ...nearSession().usage, contextTokens: 150_000 } });
    const log: VerseEvent[] = [
      { ...ev(1, 'usage', { turnId: 't1', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 150_000, contextWindow: null } }), at: lastTurn },
      { ...ev(2, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1 }), at: lastTurn },
      { ...ev(3, 'context', { turnId: null, contextTokens: 150_000, contextWindow: 1_000_000, exact: true, autoCompactAt: 367_000 }), at: new Date().toISOString() },
    ];
    const view = render(<Workspace {...props({ view: viewFor(s, log) })} />);
    expect(screen.getByRole('region', { name: 'Context advice' })).toHaveTextContent('Idle over an hour');
    view.unmount();
    render(<Workspace {...props({ view: viewFor(s) })} />);
    expect(screen.queryByRole('region', { name: 'Context advice' })).toBeNull();
  });
});

describe('Workspace — handoff', () => {
  it('shows the advice above the composer, and hands the created chat over with its note pre-filled', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    render(<Stateful {...props({ view: viewFor(nearSession()), onOpenSession })} />);

    const note = screen.getByRole('region', { name: 'Context advice' });
    expect(note.closest('header')).toBeNull();
    expect(screen.getByRole('region', { name: 'Notices' }).contains(note)).toBe(true);
    expect(note).toHaveTextContent('About 67k tokens left before the CLI auto-compacts.');

    await user.click(within(note).getByRole('button', { name: 'Continue in a fresh chat…' }));
    // Loaded on request (a lazy chunk).
    const dialog = await screen.findByRole('dialog', { name: 'Continue in a fresh chat' });
    expect(dialog).toHaveTextContent('from vs_1m');
    await user.click(within(dialog).getByRole('button', { name: 'Create chat' }));

    expect(onOpenSession).toHaveBeenCalledWith('vs_handoff');
    expect(loadDraft('vs_handoff')).toBe('Handoff note: finish the login fix.');
    expect(getVerseSessionState('vs_handoff').session?.handoffFrom).toEqual({ sessionId: 'vs_1m', title: 'Fix the login bug' });
    expect(lastVerseSeat(CREATED.projectPath)).toEqual({ seatId: 'claude-a', model: 'claude-opus-5' });
    expect(fetchState.calls.some((c) => c.path.endsWith('/turns'))).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Continue in a fresh chat' })).toBeNull();
  });

  it('is in the ⋯ menu too, and announces the new chat when the host cannot switch to it', async () => {
    const user = userEvent.setup();
    render(<Stateful {...props({ view: viewFor(nearSession()) })} />);
    const menu = await openActions(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Continue in a fresh chat/ }));
    await user.click(await screen.findByRole('button', { name: 'Create chat' }));
    const slot = screen.getByRole('region', { name: 'Notices' });
    expect(within(slot).getByText(/Started “Continue: Fix the login bug” — open it from the chat list/)).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Fix the login bug' }));
    expect(onOpenSession).toHaveBeenCalledWith('vs_1m');
  });

  it('mounts no dialog — and so fetches nothing — until the operator asks', () => {
    render(<Stateful {...props({ view: viewFor(nearSession()) })} />);
    expect(screen.queryByRole('dialog', { name: 'Continue in a fresh chat' })).toBeNull();
    expect(fetchState.calls.some((c) => c.path.includes('handoff-preview'))).toBe(false);
  });
});

describe('Workspace — the rest of ⋯', () => {
  it('copies the chat id, renames, and asks the host to confirm a delete', async () => {
    const user = userEvent.setup();
    const onRequestDelete = vi.fn();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<Workspace {...props({ view: viewFor(nearSession()), onRequestDelete })} />);

    let menu = await openActions(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Copy chat id' }));
    expect(writeText).toHaveBeenCalledWith('vs_1m');

    menu = await openActions(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    expect(screen.getByRole('textbox', { name: 'Chat title' })).toHaveFocus();
    await user.keyboard('{Escape}');

    menu = await openActions(user);
    await user.click(within(menu).getByRole('menuitem', { name: /Delete chat/ }));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
  });

  it('will not delete a running chat: the item says why', async () => {
    const user = userEvent.setup();
    const onRequestDelete = vi.fn();
    render(<Workspace {...props({ view: viewFor(nearSession({ status: 'running' })), onRequestDelete })} />);
    const menu = await openActions(user);
    const del = within(menu).getByRole('menuitem', { name: /Delete chat/ });
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveTextContent('Stop the turn before deleting.');
    await user.click(del);
    expect(onRequestDelete).not.toHaveBeenCalled();
  });
});
