/**
 * DOM tests for the Chat surface against a stubbed fetch + EventSource.
 * These moved here from VerseApp.test.tsx when the shell gained its rail:
 * the shell lazily mounts this section, so mounting it directly keeps the
 * assertions about chat behavior free of Suspense timing.
 *
 *   - bootstrap renders seats / projects / sessions
 *   - creating a session POSTs the contract body
 *   - sending a turn appends the user message, then renders streamed
 *     text-deltas from the fake per-session EventSource, then the final
 *     assistant-message replaces the streaming turn
 *   - stop → POST …/cancel, and the transcript stays clean
 *   - mutation guard: no token → dialog, action runs once unlocked
 *   - the panel resizers: their ARIA contract, keyboard steps, double-click
 *     reset, and that a hidden panel leaves no handle behind
 *   - 3.10: the dock replaced the resources column (Tasks / Context panes,
 *     width handle, persisted with the shell's v3 blob)
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { bootstrap as bootstrapFixture, ev, MockEventSource, session as sessionFixture, verseFetch } from '../fixtures.test-support.js';
import { CLAUDE_CONTEXT_SEAT } from '../seat-fixtures.test-support.js';
import { resetVerseStore } from '../verse-store.js';
import { getVerseUiState, openVerseSession, requestVerseCommand, resetVerseUi, VERSE_UI_STORAGE_KEY } from '../verse-ui-store.js';
import { resetCommandBus, runCommand } from '../shell/command-bus.js';
import { mockCompactViewport } from '../shell/viewport.test-support.js';
import { getDockSnapshot, requestTerminal, resetDockStore } from '../dock/dock-store.js';
import { resetLocalSeen } from '../chat/use-chat-activity.js';
import { CHAT_PANEL_RANGES, CHAT_PANEL_SIZING_KEY, resetChatPanelSizing } from '../chat-panel-sizing.js';
import { ApiError } from '../../../data/client.js';
import { ChatSection, describeChatError } from './ChatSection.js';

const TOKEN = 'b'.repeat(64);

function mount() {
  return render(<ToastProvider><ChatSection /></ToastProvider>);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/');
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  resetDockStore();
  resetLocalSeen();
  resetCommandBus();
  resetChatPanelSizing();
  clearMutationToken();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
});
afterEach(() => {
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('ChatSection bootstrap', () => {
  it('renders seats, projects and grouped sessions from the stubbed bootstrap', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    mount();

    const nav = await screen.findByRole('navigation', { name: 'Chats' });
    await within(nav).findByRole('button', { name: /Fix the login bug/ });
    expect(within(nav).getByRole('button', { name: /Write the docs/ })).toBeInTheDocument();
    // Grouped by project, project name as the header.
    expect(within(nav).getByRole('heading', { name: /^hub/ })).toBeInTheDocument();
    expect(within(nav).getByRole('heading', { name: /^site/ })).toBeInTheDocument();
    // A row carries its engine identity as a 2px marker, not a seat-name badge
    // (DESIGN §4) — the seat is in the row's tooltip and the header pill.
    expect(within(nav).getByRole('button', { name: /Fix the login bug/ })).toHaveAttribute('data-engine', 'claude');
    expect(within(nav).getByRole('button', { name: /Write the docs/ })).toHaveAttribute('data-engine', 'local');
    // That seat used to ride in a native `title`, which a keyboard operator
    // could never see. It is a tooltip now, so it is asked for rather than
    // read off an attribute.
    const row = within(nav).getByRole('button', { name: /Fix the login bug/ });
    expect(row).not.toHaveAttribute('title');
    // mouseOver, not mouseEnter: React synthesises onMouseEnter from the
    // bubbling mouseover, and a dispatched `mouseenter` never reaches it.
    // The tooltip also opens after a delay and portals on open, so findBy.
    fireEvent.mouseOver(row);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Claude Max');
    fireEvent.mouseOut(row);

    // 3.10: no resources column — the dock starts closed, and seat capacity
    // lives in Apps & Accounts. Nothing in the chat surface lists seats.
    expect(screen.queryByRole('complementary', { name: /^Dock/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Personal Codex')).not.toBeInTheDocument();

    // Empty workspace state with the ⌘N hint.
    expect(screen.getByRole('heading', { name: 'Pick a chat, or start a new one' })).toBeInTheDocument();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(['/api/verse/bootstrap', '/api/verse/sessions']));
    // Only the sidebar digest channel is open (no session selected yet).
    expect(MockEventSource.instances.map((i) => i.url.split('?')[0])).toEqual(['/api/events']);
  });

  it('shows the empty-state copy when there are no chats', async () => {
    const { fetch } = verseFetch({ sessions: [] });
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByRole('heading', { name: 'No chats yet — ⌘N' });
    // The sidebar's own empty state no longer folds the shortcut into a line
    // of prose. It states the situation and then OFFERS the action, with the
    // shortcut on the control that performs it.
    expect(screen.getByText('No chats yet', { selector: 'p' })).toBeInTheDocument();
    const start = screen.getByRole('button', { name: /Start your first chat/ });
    expect(start).toHaveTextContent('⌘N');
  });
});

describe('ChatSection sessions', () => {
  it('creates a session with the contract body and selects it', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    setMutationToken(TOKEN);
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: /Fix the login bug/ });

    await user.click(within(screen.getByRole('navigation', { name: 'Chats' })).getByRole('button', { name: 'New chat' }));
    const dialog = await screen.findByRole('dialog', { name: 'New chat' });
    await user.selectOptions(within(dialog).getByLabelText('Project'), '/Users/mason/dev/site');
    await user.selectOptions(within(dialog).getByLabelText('Seat and model'), JSON.stringify(['local:qwen3-coder', 'qwen3-coder']));
    await user.type(within(dialog).getByLabelText(/Title/), 'Refactor nav');
    await user.click(within(dialog).getByRole('button', { name: 'Start chat' }));

    await waitFor(() => expect(state.calls.some((c) => c.path === '/api/verse/sessions' && c.method === 'POST')).toBe(true));
    const post = state.calls.find((c) => c.path === '/api/verse/sessions' && c.method === 'POST')!;
    expect(post.body).toEqual({ projectPath: '/Users/mason/dev/site', seatId: 'local:qwen3-coder', model: 'qwen3-coder', title: 'Refactor nav' });
    expect(post.headers['x-ashlr-token']).toBe(TOKEN);

    // The new chat is selected: its title is in the workspace header and a per-session stream opened.
    await screen.findByRole('heading', { name: 'Refactor nav' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const created = state.sessions[0]!;
    expect(MockEventSource.forSession(created.id).url).toMatch(/\?client=[a-f0-9]{64}$/);
    expect(MockEventSource.forSession(created.id).withCredentials).toBe(true);
  });

  it('sends a turn, appends the user message, streams deltas, then replaces them with the final message', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    setMutationToken(TOKEN);
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    await screen.findByRole('heading', { name: 'Fix the login bug' });
    const stream = MockEventSource.forSession('vs_1');
    act(() => stream.emitOpen());

    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'Add a test{Enter}');

    await waitFor(() => expect(state.calls.some((c) => c.path === '/api/verse/sessions/vs_1/turns')).toBe(true));
    const turn = state.calls.find((c) => c.path === '/api/verse/sessions/vs_1/turns')!;
    expect(turn.method).toBe('POST');
    expect(turn.body).toEqual({ text: 'Add a test' });
    expect(turn.headers['x-ashlr-token']).toBe(TOKEN);

    // Server echoes the user message and starts streaming.
    act(() => {
      stream.emit(ev(1, 'user-message', { turnId: 't1', text: 'Add a test' }));
      stream.emit(ev(2, 'turn-started', { turnId: 't1', pid: 4242 }));
    });
    const log = screen.getByRole('log');
    expect(within(log).getByText('Add a test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop the running turn/ })).toBeInTheDocument();
    // The box stays editable for drafting the next message; only Send is withheld.
    expect(box).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /Send message/ })).not.toBeInTheDocument();

    act(() => {
      stream.emit(ev(3, 'text-delta', { turnId: 't1', text: 'Sure — ' }));
      stream.emit(ev(4, 'text-delta', { turnId: 't1', text: 'adding **one**' }));
    });
    const streaming = within(log).getByText((_, node) => node?.tagName === 'P' && node.textContent === 'Sure — adding one');
    expect(streaming.closest('[data-streaming]')).not.toBeNull();

    act(() => {
      stream.emit(ev(5, 'assistant-message', { turnId: 't1', text: 'Sure — adding **one** test.' }));
      stream.emit(ev(6, 'tool-use', { turnId: 't1', toolUseId: 'tu1', name: 'Write', input: { file_path: '/x/a.test.ts', content: '…' } }));
      stream.emit(ev(7, 'tool-result', { turnId: 't1', toolUseId: 'tu1', output: 'ok', isError: false }));
      stream.emit(ev(8, 'usage', { turnId: 't1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 150_000, contextWindow: 200_000 } }));
      stream.emit(ev(9, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 3200 }));
    });
    expect(within(log).queryByText('Sure — adding one')).not.toBeInTheDocument();
    expect(within(log).getByText((_, node) => node?.tagName === 'P' && node.textContent === 'Sure — adding one test.')).toBeInTheDocument();
    expect(log.querySelector('[data-streaming]')).toBeNull();
    // Tool call collapsed to one dense line: name + truncated argument.
    const card = within(log).getByText('Write').closest('details')!;
    expect(card.open).toBe(false);
    expect(card).toHaveTextContent('/x/a.test.ts');
    // Context meter moved with the usage frame and crossed the 70% threshold.
    const meter = screen.getByRole('meter', { name: 'Context window' });
    expect(meter).toHaveAttribute('aria-valuenow', '75');
    expect(meter).toHaveAttribute('data-tone', 'warn');
    // Send is back once the turn finished, and focus returns to the box.
    await waitFor(() => expect(screen.getByRole('button', { name: /Send message/ })).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Message' })).not.toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
  });

  it('stops a running turn via POST …/cancel and leaves a clean transcript', async () => {
    const { fetch, state } = verseFetch();
    state.details.vs_1 = { session: { ...state.details.vs_1!.session, status: 'running' }, events: [] };
    vi.stubGlobal('fetch', fetch);
    setMutationToken(TOKEN);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    await user.click(await screen.findByRole('button', { name: /Stop the running turn/ }));
    await waitFor(() => expect(state.calls.some((c) => c.path === '/api/verse/sessions/vs_1/cancel' && c.method === 'POST')).toBe(true));

    // The server's own frames land next: a stopped turn reads "Stopped." and
    // goes back to idle — never an error badge.
    const stream = MockEventSource.forSession('vs_1');
    act(() => {
      stream.emit(ev(1, 'user-message', { turnId: 't1', text: 'go' }));
      stream.emit(ev(2, 'turn-started', { turnId: 't1', pid: 9 }));
      stream.emit(ev(3, 'cancelled', { turnId: 't1' }));
      stream.emit(ev(4, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 900 }));
    });
    const log = screen.getByRole('log');
    expect(within(log).getByText('Stopped.')).toBeInTheDocument();
    expect(within(log).queryByText(/Turn ended without a result/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Send message/ })).toBeInTheDocument());
  });

  it('asks for the mutation token first and runs the send once unlocked', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(box, 'hello{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(state.calls.some((c) => c.method === 'POST')).toBe(false);
    await user.type(within(dialog).getByLabelText('Mutation token'), TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(state.calls.some((c) => c.path === '/api/verse/sessions/vs_1/turns' && c.method === 'POST')).toBe(true));
    expect(state.calls.find((c) => c.path === '/api/verse/sessions/vs_1/turns')!.headers['x-ashlr-token']).toBe(TOKEN);
    // Token never lands in storage.
    expect(Object.values(localStorage)).not.toContain(TOKEN);
    expect(Object.values(sessionStorage)).not.toContain(TOKEN);
  });
});

describe('ChatSection refusals', () => {
  const UNAVAILABLE = 'model claude-opus-5-5 cannot run on seat claude-a: needs Claude Code 2.1.280; this seat runs 2.1.257';

  it('says why a 409 was refused instead of calling every 409 "a turn is already running"', () => {
    const unavailable = new ApiError('POST … failed (HTTP 409).', 409, '/api/verse/sessions/vs_1/turns', UNAVAILABLE, 'VERSE_MODEL_UNAVAILABLE');
    const text = describeChatError(unavailable);
    expect(text).toContain(`${UNAVAILABLE}.`);
    expect(text).toContain('Continue in a fresh chat');
    expect(text).toContain('ashlr resources profile repin');
    expect(text).not.toMatch(/already running/);
    // The busy refusal — coded or from an older, codeless server — keeps its copy.
    expect(describeChatError(new ApiError('x', 409, '/p', 'busy', 'VERSE_SESSION_BUSY'))).toBe('A turn is already running in this chat. Stop it first.');
    expect(describeChatError(new ApiError('x', 409, '/p'))).toBe('A turn is already running in this chat. Stop it first.');
    // Any other refusal: the route's own sentence, not the HTTP wrapper.
    expect(describeChatError(new ApiError('POST /p failed (HTTP 400): bad.', 400, '/p', 'model x has no expansive context mode', 'VERSE_INVALID')))
      .toBe('model x has no expansive context mode');
  });

  it('shows the model-unavailable reason when a send is refused, and leaves the chat idle', async () => {
    const { fetch, state } = verseFetch();
    const refusing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input.toString();
      if (path === '/api/verse/sessions/vs_1/turns' && init?.method === 'POST') {
        state.calls.push({ path, method: 'POST', body: undefined, headers: {} });
        return new Response(JSON.stringify({ code: 'VERSE_MODEL_UNAVAILABLE', error: UNAVAILABLE }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      return (fetch as unknown as typeof globalThis.fetch)(input, init);
    });
    vi.stubGlobal('fetch', refusing);
    setMutationToken(TOKEN);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'hello{Enter}');
    expect(await screen.findByText(/needs Claude Code 2\.1\.280/)).toBeInTheDocument();
    expect(screen.queryByText(/already running/)).toBeNull();
    // Idle again: Send is back, not Stop.
    await waitFor(() => expect(screen.getByRole('button', { name: /Send message/ })).toBeInTheDocument());
    expect(state.calls.some((c) => c.path === '/api/verse/sessions/vs_1/turns')).toBe(true);
  });
});

describe('ChatSection layout', () => {
  it('collapses and restores the sidebar, persisting the choice in the shell\'s v3 blob', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });

    await user.click(screen.getByRole('button', { name: 'Hide chat list' }));
    expect(JSON.parse(localStorage.getItem(VERSE_UI_STORAGE_KEY) ?? '{}')).toMatchObject({ sidebarCollapsed: true });
    await user.click(screen.getByRole('button', { name: 'Show chat list' }));
    expect(JSON.parse(localStorage.getItem(VERSE_UI_STORAGE_KEY) ?? '{}')).toMatchObject({ sidebarCollapsed: false });
  });

  it('opens the dock on Tasks, switches to Context, and persists it with the shell blob', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    await screen.findByRole('heading', { name: 'Fix the login bug' });

    await user.click(screen.getByRole('button', { name: 'Dock' }));
    // The dock loads on first open (lazy chunk).
    const dock = await screen.findByRole('complementary', { name: 'Dock: Tasks' });
    expect(within(dock).getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dock).getByText('No tool calls in the latest turn.')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(VERSE_UI_STORAGE_KEY) ?? '{}').dock).toMatchObject({ open: true, active: 'tasks', tabs: ['tasks'] });

    // "+" adds Context; it is the ResourcesPanel minus the accounts.
    await user.click(within(dock).getByRole('button', { name: 'Add a pane' }));
    await user.click(screen.getByRole('menuitem', { name: 'Context' }));
    const context = screen.getByRole('complementary', { name: 'Dock: Context' });
    expect(within(context).getByRole('tab', { name: 'Context' })).toHaveAttribute('aria-selected', 'true');
    expect(within(context).getByLabelText('Context efficiency')).toBeInTheDocument();
    expect(within(context).getByRole('button', { name: 'Accounts & capacity →' })).toBeInTheDocument();
    expect(within(context).queryByText('Personal Codex')).not.toBeInTheDocument();

    // ←/→ move between tabs; the close button closes the dock.
    within(context).getByRole('tab', { name: 'Context' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('complementary', { name: 'Dock: Tasks' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close the dock' }));
    expect(screen.queryByRole('complementary', { name: /^Dock/ })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(VERSE_UI_STORAGE_KEY) ?? '{}').dock).toMatchObject({ open: false });
  });
});

describe('ChatSection resizers', () => {
  const SIDE = CHAT_PANEL_RANGES.sidebar;

  /**
   * jsdom implements no PointerEvent, so synthesise one. `pointerId` is the
   * field the handle keys its drag on — a bare MouseEvent would silently
   * fail that identity check and prove nothing.
   */
  function pointer(type: string, init: { pointerId: number; clientX: number; button?: number }): MouseEvent {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.clientX,
      button: init.button ?? 0,
    });
    Object.defineProperty(event, 'pointerId', { value: init.pointerId });
    return event;
  }

  const stored = () => JSON.parse(localStorage.getItem(CHAT_PANEL_SIZING_KEY) ?? '{}') as Record<string, number>;

  async function mounted() {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
  }

  it('gives each inner edge a separator with the full window-splitter contract', async () => {
    await mounted();

    // NOT a pixel assertion — jsdom computes no layout, and none of this
    // needs it. What is asserted is the contract a screen reader and a
    // keyboard operator actually consume.
    const handle = screen.getByRole('separator', { name: 'Resize chat list' });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuemin', String(SIDE.min));
    expect(handle).toHaveAttribute('aria-valuemax', String(SIDE.max));
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def));
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  it('gives the dock column its own width handle: 320px … 60% of the window, keys and double-click', async () => {
    const user = userEvent.setup();
    await mounted();
    await user.click(screen.getByRole('button', { name: 'Dock' }));
    const handle = await screen.findByRole('separator', { name: 'Resize the dock' });
    // jsdom's window is 1024 wide: the column presentation, capped at 60%.
    expect(handle).toHaveAttribute('aria-valuemin', '320');
    expect(handle).toHaveAttribute('aria-valuemax', String(Math.floor(window.innerWidth * 0.6)));
    const start = Number(handle.getAttribute('aria-valuenow'));
    // The dock grows LEFTward: ← widens it.
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle).toHaveAttribute('aria-valuenow', '320');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '336');
    fireEvent.doubleClick(handle);
    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(start);
  });

  it('moves the width with the arrow keys and persists it under its own key', async () => {
    await mounted();
    const handle = screen.getByRole('separator', { name: 'Resize chat list' });
    handle.focus();
    expect(handle).toHaveFocus();

    // The sidebar grows to the RIGHT; the resources panel is the mirror.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def + 16));
    // Shift asks for the coarse step.
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def + 16 + 64));
    expect(stored().sidebar).toBe(SIDE.def + 16 + 64);
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def + 16));

  });

  it('clamps the keyboard to the range, and Home/End go to the extremes', async () => {
    await mounted();
    const handle = screen.getByRole('separator', { name: 'Resize chat list' });

    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.max));
    // Past the end is not an error, it is simply the end.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.max));

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.min));
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.min));
    expect(stored().sidebar).toBe(SIDE.min);

    // A key the handle does not own is left to the page.
    fireEvent.keyDown(handle, { key: 'a' });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.min));
  });

  it('restores the default width on a double-click', async () => {
    await mounted();
    const handle = screen.getByRole('separator', { name: 'Resize chat list' });
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.max));

    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def));
    expect(stored().sidebar).toBe(SIDE.def);
  });

  it('drags from the pointer, suppresses selection, and releases outside the handle', async () => {
    await mounted();
    const handle = screen.getByRole('separator', { name: 'Resize chat list' });

    fireEvent(handle, pointer('pointerdown', { pointerId: 7, clientX: 300 }));
    expect(handle).toHaveAttribute('data-dragging', 'true');
    // The app-wide selection guard: without it, dragging past the transcript
    // selects it.
    expect(document.body.dataset.verseResizing).toBe('true');

    // Moves are listened for on the WINDOW, so a pointer that has left the
    // 9px handle — which is every pointer, immediately — still resizes.
    fireEvent(window, pointer('pointermove', { pointerId: 7, clientX: 340 }));
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def + 40));

    // A stray pointer from another gesture must not hijack this drag.
    fireEvent(window, pointer('pointermove', { pointerId: 99, clientX: 900 }));
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def + 40));

    // Released over the document, not over the handle: the stuck-drag case.
    fireEvent(window, pointer('pointerup', { pointerId: 7, clientX: 340 }));
    expect(handle).not.toHaveAttribute('data-dragging');
    expect(document.body.dataset.verseResizing).toBeUndefined();

    // And the drag really is over — a later move changes nothing.
    fireEvent(window, pointer('pointermove', { pointerId: 7, clientX: 900 }));
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def + 40));
    expect(stored().sidebar).toBe(SIDE.def + 40);
  });

  it('abandons a drag on Escape and on the window losing focus', async () => {
    await mounted();
    const handle = screen.getByRole('separator', { name: 'Resize chat list' });

    fireEvent(handle, pointer('pointerdown', { pointerId: 3, clientX: 300 }));
    fireEvent(window, pointer('pointermove', { pointerId: 3, clientX: 380 }));
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def + 80));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE.def));
    expect(document.body.dataset.verseResizing).toBeUndefined();

    // ⌘-tab mid-drag never delivers a pointerup.
    fireEvent(handle, pointer('pointerdown', { pointerId: 4, clientX: 300 }));
    expect(document.body.dataset.verseResizing).toBe('true');
    fireEvent.blur(window);
    expect(handle).not.toHaveAttribute('data-dragging');
    expect(document.body.dataset.verseResizing).toBeUndefined();
  });

  it('ignores a non-primary button', async () => {
    await mounted();
    const handle = screen.getByRole('separator', { name: 'Resize chat list' });
    fireEvent(handle, pointer('pointerdown', { pointerId: 5, clientX: 300, button: 2 }));
    expect(handle).not.toHaveAttribute('data-dragging');
    expect(document.body.dataset.verseResizing).toBeUndefined();
  });

  it('leaves no stranded handle when a panel is hidden, and brings it back', async () => {
    const user = userEvent.setup();
    await mounted();
    expect(screen.getByRole('separator', { name: 'Resize chat list' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dock' }));
    expect(await screen.findByRole('separator', { name: 'Resize the dock' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide chat list' }));
    expect(screen.queryByRole('separator', { name: 'Resize chat list' })).not.toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize the dock' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dock' }));
    expect(screen.queryByRole('complementary', { name: /^Dock/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize the dock' })).not.toBeInTheDocument();

    // The show/hide toggles still work, and the handles come back with them.
    await user.click(screen.getByRole('button', { name: 'Show chat list' }));
    expect(screen.getByRole('separator', { name: 'Resize chat list' })).toBeInTheDocument();
  });

  it('keeps a chosen width across hiding and reshowing the panel', async () => {
    const user = userEvent.setup();
    await mounted();
    const handle = screen.getByRole('separator', { name: 'Resize chat list' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(stored().sidebar).toBe(SIDE.def + 32);

    await user.click(screen.getByRole('button', { name: 'Hide chat list' }));
    await user.click(screen.getByRole('button', { name: 'Show chat list' }));
    expect(screen.getByRole('separator', { name: 'Resize chat list' }))
      .toHaveAttribute('aria-valuenow', String(SIDE.def + 32));
  });
});

/**
 * V3.9 wiring this section owns: the dialog's own write goes through the same
 * token guard as every chat mutation, the create body carries the mode on
 * screen, the resources panel reads the open chat's log, and a handoff chat
 * links back to the chat it continues.
 */
describe('ChatSection — context orchestration wiring', () => {
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

  /** verseFetch plus the V3.9 reads/writes the dialog makes. */
  function contextFetch(boot = bootstrapFixture({ seats: [CLAUDE_CONTEXT_SEAT] })) {
    const base = verseFetch({ bootstrap: boot });
    const posted: unknown[] = [];
    let prefs = { version: 1, seats: {} as Record<string, { contextMode?: string }>, memory: { enabled: true, disabledProjects: [] as string[] } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (path === '/api/verse/preferences' && method === 'GET') return jsonResponse(prefs);
      if (path === '/api/verse/preferences' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { seatId: string; contextMode: string };
        posted.push({ body, token: (init?.headers as Record<string, string>)['x-ashlr-token'] });
        prefs = { ...prefs, seats: { ...prefs.seats, [body.seatId]: { contextMode: body.contextMode } } };
        return jsonResponse(prefs);
      }
      if (path.startsWith('/api/verse/context-fit')) {
        return jsonResponse({ roots: [{ path: '/Users/mason/dev/hub', files: 10, bytes: 400_000, estTokens: 100_000, truncated: false }], totalEstTokens: 100_000, estimator: 'bytes/4', sampledAt: '2026-09-23T10:00:00.000Z' });
      }
      // verseFetch types its mock loosely; it IS a fetch.
      return (base.fetch as unknown as typeof globalThis.fetch)(input, init);
    });
    return { fetch: fetchMock, state: base.state, posted };
  }

  it('saves a seat default through the mutation-token guard, then creates the chat in that mode', async () => {
    const { fetch, state, posted } = contextFetch();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: /Fix the login bug/ });
    await user.click(within(screen.getByRole('navigation', { name: 'Chats' })).getByRole('button', { name: 'New chat' }));
    const dialog = await screen.findByRole('dialog', { name: 'New chat' });
    await within(dialog).findByRole('radio', { name: 'Standard', checked: true });
    await user.click(within(dialog).getByRole('radio', { name: 'Expansive' }));
    await user.click(within(dialog).getByRole('button', { name: 'Make Expansive the default for Claude Max' }));

    // No token held: the guard asks first, and nothing is written yet.
    const unlock = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(posted).toEqual([]);
    await user.type(within(unlock).getByLabelText('Mutation token'), TOKEN);
    await user.click(within(unlock).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(posted).toEqual([{ body: { seatId: 'claude-a', contextMode: 'expansive' }, token: TOKEN }]));
    expect(await screen.findByText('New chats on Claude Max now start in Expansive.')).toBeInTheDocument();

    await user.click(within(screen.getByRole('dialog', { name: 'New chat' })).getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(state.calls.some((c) => c.path === '/api/verse/sessions' && c.method === 'POST')).toBe(true));
    expect(state.calls.find((c) => c.path === '/api/verse/sessions' && c.method === 'POST')!.body)
      .toEqual({ projectPath: '/Users/mason/dev/hub', seatId: 'claude-a', model: 'claude-fable-5-1', contextMode: 'expansive' });
  });

  it('feeds the open chat’s log to the Context pane’s per-turn figures', async () => {
    const boot = bootstrapFixture();
    const { fetch } = verseFetch({
      bootstrap: boot,
      details: {
        vs_1: {
          session: boot.sessions[0]!,
          events: [
            ev(1, 'usage', { turnId: 't1', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 30_000, contextWindow: null } }),
            ev(2, 'usage', { turnId: 't2', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 50_000, contextWindow: null } }),
          ],
        },
        vs_2: { session: boot.sessions[1]!, events: [] },
      },
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    await screen.findByRole('heading', { name: 'Fix the login bug' });
    // The Context pane is the dock's; open it the way ⌘\ + "+" would.
    await user.click(screen.getByRole('button', { name: 'Dock' }));
    await user.click(await screen.findByRole('button', { name: 'Add a pane' }));
    await user.click(screen.getByRole('menuitem', { name: 'Context' }));
    const efficiency = await screen.findByLabelText('Context efficiency');
    await waitFor(() => expect(within(efficiency).getByText('Peak context', { selector: 'dt' }).nextElementSibling).toHaveTextContent('50k'));
    expect(within(efficiency).getByText('Avg context / turn', { selector: 'dt' }).nextElementSibling).toHaveTextContent('40k');
  });

  it('opens the chat a handoff continues from its "Continued from" link', async () => {
    const boot = bootstrapFixture();
    const handoff = sessionFixture({ id: 'vs_3', title: 'Fix the login bug · part 2', updatedAt: '2026-09-19T11:00:00.000Z', handoffFrom: { sessionId: 'vs_1', title: 'Fix the login bug' } });
    const { fetch } = verseFetch({ bootstrap: { ...boot, sessions: [handoff, ...boot.sessions] } });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /part 2/ }));
    await screen.findByRole('heading', { name: 'Fix the login bug · part 2' });
    await user.click(within(screen.getByRole('log')).getByRole('button', { name: 'Fix the login bug' }));
    expect(await screen.findByRole('heading', { name: 'Fix the login bug' })).toBeInTheDocument();
    expect(localStorage.getItem('ashlr.verse.selected.v1')).toBe('vs_1');
  });
});

/**
 * 3.10: the ways INTO the chat from the rest of the workbench, and the
 * chat-scope keys (SPEC-310C §1 key table, "Chat" row).
 */
describe('ChatSection — commands and keys (3.10)', () => {
  it('serves the catalog\'s dock and chat commands on the shell\'s command bus', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    expect(runCommand('dock.toggle')).toBe(true);
    expect(await screen.findByRole('complementary', { name: 'Dock: Tasks' })).toBeInTheDocument();
    act(() => { runCommand('dock.toggle'); });
    expect(screen.queryByRole('complementary', { name: /^Dock/ })).not.toBeInTheDocument();
    act(() => { runCommand('chat.sidebar'); });
    expect(getVerseUiState().sidebarCollapsed).toBe(true);
    expect(screen.getByRole('button', { name: 'Show chat list' })).toBeInTheDocument();
  });

  it('handles ⌘\\ and ⌘B itself when the shell has not taken the key, and never twice', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    // jsdom reports no macOS platform, so the catalog's "mod" is Ctrl here.
    fireEvent.keyDown(document.body, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(await screen.findByRole('complementary', { name: 'Dock: Tasks' })).toBeInTheDocument();
    // A key the shell already handled (defaultPrevented) is left alone.
    const handled = new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: true, bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => { document.body.dispatchEvent(handled); });
    expect(screen.getByRole('complementary', { name: 'Dock: Tasks' })).toBeInTheDocument();
    // ⌘B — the chat list.
    fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(getVerseUiState().sidebarCollapsed).toBe(true);
  });

  it('opens the chat an open-session command names, and reports what is open to the shell', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    act(() => { openVerseSession('vs_2'); });
    expect(await screen.findByRole('heading', { name: 'Write the docs' })).toBeInTheDocument();
    expect(getVerseUiState().activeSessionId).toBe('vs_2');
    expect(localStorage.getItem('ashlr.verse.selected.v1')).toBe('vs_2');
  });

  it('prefills "New chat on…" from the command\'s seat', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    act(() => { requestVerseCommand('new-chat', { seatId: 'local:qwen3-coder', projectPath: '/Users/mason/dev/site' }); });
    const dialog = await screen.findByRole('dialog', { name: 'New chat' });
    expect(within(dialog).getByLabelText('Project')).toHaveValue('/Users/mason/dev/site');
    expect(within(dialog).getByLabelText('Seat and model')).toHaveValue(JSON.stringify(['local:qwen3-coder', 'qwen3-coder']));
  });

  it('confirms a delete from the chat list in a dialog before anything is removed', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    setMutationToken(TOKEN);
    const user = userEvent.setup();
    mount();
    const nav = await screen.findByRole('navigation', { name: 'Chats' });
    const row = await within(nav).findByRole('button', { name: /Write the docs/ });
    row.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this chat?' });
    expect(dialog).toHaveTextContent('“Write the docs” and its transcript are removed');
    await user.click(within(dialog).getByRole('button', { name: 'Keep' }));
    expect(state.calls.some((c) => c.path.endsWith('/delete'))).toBe(false);

    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Delete this chat?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(state.calls.some((c) => c.path === '/api/verse/sessions/vs_2/delete')).toBe(true));
    await waitFor(() => expect(within(nav).queryByRole('button', { name: /Write the docs/ })).not.toBeInTheDocument());
  });

  it('⌃` asks the dock for a terminal (the active tab, else one at the root); pressed again it hides Terminal', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    await screen.findByRole('heading', { name: 'Fix the login bug' });
    // jsdom has no macOS platform: the catalog's ⌃ is Ctrl either way.
    fireEvent.keyDown(document.body, { key: '`', code: 'Backquote', ctrlKey: true });
    const first = getDockSnapshot();
    expect(first.state).toMatchObject({ open: true, active: 'terminal' });
    // An EMPTY request: TerminalPane focuses the active tab or opens one at the chat's root.
    expect(first.requests.terminal).toEqual({ nonce: expect.any(Number) });
    fireEvent.keyDown(document.body, { key: '`', code: 'Backquote', ctrlKey: true });
    expect(getDockSnapshot().state.open).toBe(false);
  });

  it('⌃⇧` always asks for a NEW tab (in the active tab\'s root)', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    act(() => { runCommand('dock.terminal-new'); });
    expect(getDockSnapshot().requests.terminal).toEqual({ nonce: expect.any(Number), newTab: true });
    expect(getDockSnapshot().state).toMatchObject({ open: true, active: 'terminal' });
  });

  it('keeps an Apps [Launch ▸] terminal request raised before Chat mounted; a chat SWITCH drops it', async () => {
    localStorage.setItem('ashlr.verse.selected.v1', 'vs_1');
    // Apps raised it on its own surface, then brought Chat forward.
    requestTerminal({ newTab: true, appId: 'codex', via: 'ollama', model: 'qwen3.8:27b' });
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await screen.findByRole('heading', { name: 'Fix the login bug' });
    expect(getDockSnapshot().requests.terminal).toMatchObject({ appId: 'codex', via: 'ollama', model: 'qwen3.8:27b', newTab: true });
    await user.click(screen.getByRole('button', { name: /Write the docs/ }));
    await screen.findByRole('heading', { name: 'Write the docs' });
    expect(getDockSnapshot().requests.terminal).toBeNull();
  });

  it('"Accounts & capacity →" in the Context pane goes to Apps & Accounts', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    await screen.findByRole('heading', { name: 'Fix the login bug' });
    act(() => { runCommand('dock.toggle'); });
    const dock = await screen.findByRole('complementary', { name: 'Dock: Tasks' });
    await user.click(within(dock).getByRole('button', { name: 'Add a pane' }));
    await user.click(screen.getByRole('menuitem', { name: 'Context' }));
    await user.click(screen.getByRole('button', { name: 'Accounts & capacity →' }));
    expect(getVerseUiState().section).toBe('apps');
  });

  it('at 375 (dark): the dock is a bottom sheet over the chat, and Escape closes it', async () => {
    const vp = mockCompactViewport({ dark: true });
    try {
      const { fetch } = verseFetch();
      vi.stubGlobal('fetch', fetch);
      const user = userEvent.setup();
      mount();
      await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
      await screen.findByRole('heading', { name: 'Fix the login bug' });
      await user.click(screen.getByRole('button', { name: 'Dock' }));
      const sheet = await screen.findByRole('dialog', { name: 'Dock: Tasks' });
      expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
      // Not a grid column: the chat keeps its full width underneath.
      expect(document.querySelector('[data-dock]')).toHaveAttribute('data-dock', 'closed');
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: /^Dock/ })).not.toBeInTheDocument();
    } finally {
      vp.restore();
    }
  });
});
