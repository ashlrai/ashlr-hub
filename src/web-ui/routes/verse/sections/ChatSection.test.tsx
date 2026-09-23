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
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { ev, MockEventSource, verseFetch } from '../fixtures.test-support.js';
import { resetVerseStore } from '../verse-store.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { ChatSection } from './ChatSection.js';

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

    // Resources panel lists every seat with its health and the local runtime.
    const resources = screen.getByRole('complementary', { name: 'Resources' });
    expect(within(resources).getByText('Personal Codex')).toBeInTheDocument();
    expect(within(resources).getByText('quota exhausted until 14:00')).toBeInTheDocument();
    expect(within(resources).getByText('http://127.0.0.1:11434')).toBeInTheDocument();
    expect(within(resources).getByText('reachable')).toBeInTheDocument();

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

describe('ChatSection layout', () => {
  it('collapses and restores the sidebar, persisting the choice under ashlr.verse.ui.v2', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });

    await user.click(screen.getByRole('button', { name: 'Hide chat list' }));
    expect(JSON.parse(localStorage.getItem('ashlr.verse.ui.v2') ?? '{}')).toMatchObject({ sidebarCollapsed: true });
    await user.click(screen.getByRole('button', { name: 'Show chat list' }));
    expect(JSON.parse(localStorage.getItem('ashlr.verse.ui.v2') ?? '{}')).toMatchObject({ sidebarCollapsed: false });
  });

  it('hides the resources panel on request and remembers that too', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    mount();
    await screen.findByRole('complementary', { name: 'Resources' });

    await user.click(screen.getByRole('button', { name: 'Resources' }));
    expect(screen.queryByRole('complementary', { name: 'Resources' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('ashlr.verse.ui.v2') ?? '{}')).toMatchObject({ resourcesOpen: false });
  });
});
