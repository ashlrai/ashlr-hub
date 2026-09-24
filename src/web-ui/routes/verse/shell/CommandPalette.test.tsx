/**
 * CommandPalette — ⌘K from the keyboard (unit C1). RTL + user-event.
 *
 *   - opening it never switches surface;
 *   - ↑ ↓ ↩ run, ⇥ fills an argument, Esc steps back then closes;
 *   - a guarded action confirms FIRST, then asks for the token, then runs;
 *   - it renders at 375.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { bootstrap, MockEventSource, session } from '../fixtures.test-support.js';
import { useVerseUi } from '../useVerseUi.js';
import { getVerseUiState, openVerseOverlay, resetVerseUi, setVerseSection } from '../verse-ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { resetCommandBus } from './command-bus.js';
import { GuardHost, resetGuard } from './guarded-action.js';
import { activity, approvalNeed, shellFetch, TOKEN, type ShellFetch } from './shell-fixtures.test-support.js';
import { useShellCommands } from './run-command.js';
import { resetActivityForTest } from './useActivity.js';
import { mockCompactViewport, type ViewportMock } from './viewport.test-support.js';

/** Mirrors the shell: the palette is mounted while the overlay says so. */
function Harness() {
  useShellCommands();
  const ui = useVerseUi();
  return (
    <>
      {ui.overlay === 'palette' ? <CommandPalette /> : null}
      <GuardHost />
    </>
  );
}

let net: ShellFetch;
let viewport: ViewportMock | null = null;

function mount() {
  return render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetGuard();
  resetCommandBus();
  clearMutationToken();
  const running = session({ id: 'vs_run', title: 'Refactor the store', status: 'running' });
  net = shellFetch(
    activity({
      needsYou: [approvalNeed('p-1')],
      running: [{ sessionId: 'vs_run', title: 'Refactor the store', engine: 'claude', seatId: 'claude-main', startedAt: new Date().toISOString(), live: null }],
    }),
    { bootstrap: bootstrap({ sessions: [session(), running] }) },
  );
  resetActivityForTest((path) => net.fetch(path).then((r: Response) => r.json()));
  vi.stubGlobal('fetch', net.fetch);
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
});

afterEach(() => {
  viewport?.restore();
  viewport = null;
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  resetActivityForTest();
});

async function openPalette() {
  act(() => openVerseOverlay('palette'));
  const input = await screen.findByRole('combobox', { name: 'Search commands' });
  await waitFor(() => expect(screen.getByRole('group', { name: 'Needs you' })).toBeInTheDocument());
  return input;
}

describe('CommandPalette', () => {
  it('opens on the search box without switching surface, showing what needs you and recent actions', async () => {
    act(() => setVerseSection('fleet'));
    mount();
    const input = await openPalette();
    expect(input).toHaveFocus();
    expect(getVerseUiState().section).toBe('fleet');
    expect(within(screen.getByRole('group', { name: 'Needs you' })).getByRole('option', { name: /fix the flaky snapshot/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Recent' })).toBeInTheDocument();
  });

  it('moves with ↑ ↓ and runs with ↩ — a chat opens in Chat', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette();
    await user.type(input, '#refactor');
    const option = await screen.findByRole('option', { name: /Refactor the store/ });
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', option.id);
    await user.keyboard('{Enter}');
    expect(getVerseUiState()).toMatchObject({ section: 'chat', overlay: null });
    expect(getVerseUiState().command).toMatchObject({ name: 'open-session', sessionId: 'vs_run' });
  });

  it('⇥ fills an argument: New chat on… → a seat', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette();
    await user.type(input, 'new chat on');
    await waitFor(() => expect(screen.getByRole('option', { name: /New chat on…/ })).toHaveAttribute('aria-selected', 'true'));
    await user.keyboard('{Tab}');
    const seatInput = screen.getByRole('combobox', { name: 'Seat' });
    expect(seatInput).toHaveFocus();
    await user.type(seatInput, 'codex');
    await user.keyboard('{Enter}');
    expect(getVerseUiState().command).toMatchObject({ name: 'new-chat', seatId: 'codex-personal' });
    expect(getVerseUiState().recentActions).toContain('chat.new-on');
  });

  it('Esc leaves the argument step first, then closes', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette();
    await user.type(input, '>new chat on');
    await user.keyboard('{Tab}');
    expect(screen.getByRole('combobox', { name: 'Seat' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('combobox', { name: 'Search commands' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(getVerseUiState().overlay).toBeNull();
  });

  it('a guarded action confirms first, then asks for the token, then runs', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette();
    await user.type(input, 'stop running');
    await user.keyboard('{Enter}');
    // 1. Confirmation — before any token prompt.
    const confirm = await screen.findByRole('dialog', { name: 'Stop every running chat?' });
    expect(screen.queryByRole('dialog', { name: 'Unlock actions' })).not.toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Stop chats' }));
    // 2. Token.
    const unlock = await screen.findByRole('dialog', { name: 'Unlock actions' });
    await user.type(within(unlock).getByLabelText('Mutation token'), TOKEN);
    await user.click(within(unlock).getByRole('button', { name: 'Unlock' }));
    // 3. The run: one cancel per running chat, with the token.
    await waitFor(() => expect(net.posts().map((p) => p.path)).toContain('/api/verse/sessions/vs_run/cancel'));
    expect(net.posts().find((p) => p.path.endsWith('/cancel'))!.token).toBe(TOKEN);
    await screen.findByText('Stopped 1 chat.');
  });

  it('cancelling the confirmation runs nothing and asks for no token', async () => {
    const user = userEvent.setup();
    mount();
    const input = await openPalette();
    await user.type(input, 'stop the fleet');
    await user.keyboard('{Enter}');
    const confirm = await screen.findByRole('dialog', { name: 'Stop the fleet?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(net.posts()).toEqual([]);
  });

  it('says so when nothing matches, and renders at 375', async () => {
    viewport = mockCompactViewport();
    const user = userEvent.setup();
    mount();
    const input = await openPalette();
    await user.type(input, 'zzzzqqq');
    expect(screen.getByText('Nothing matches “zzzzqqq”.')).toBeInTheDocument();
    expect(screen.getByText('0 results')).toHaveAttribute('aria-live', 'polite');
  });
});
