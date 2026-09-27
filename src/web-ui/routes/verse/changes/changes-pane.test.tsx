/**
 * The Changes pane through the workbench pane registry: discovered from
 * ./register.ts, it REPLACES the first-party `diff` pane (keeping ⇧⌘D, its
 * order and header toggle), and ⇧⌘D in a rendered chat opens it.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseCheckpointListResponse } from '../../../../core/verse/checkpoint-types.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource, verseFetch } from '../fixtures.test-support.js';
import { resetVerseStore } from '../verse-store.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { resetCommandBus } from '../shell/command-bus.js';
import { detectKeyPlatform } from '../shell/command-keys.js';
import { resetDockStore } from '../dock/dock-store.js';
import { resetLocalSeen } from '../chat/use-chat-activity.js';
import { resetChatPanelSizing } from '../chat-panel-sizing.js';
import { ChatSection, preloadChatSurface } from '../sections/ChatSection.js';
import { getPane, UNIT_PANE_IDS, type PaneProps } from '../panes/index.js';
import { ChangesPaneHost } from './ChangesPaneHost.js';
import { CHANGES_PANE } from './register.js';

const LIST: VerseCheckpointListResponse = {
  chatId: 'vs_1',
  running: false,
  roots: [{ rootId: 'aaaabbbbcccc', path: '/Users/mason/dev/hub', name: 'hub' }],
  turns: [],
  redo: null,
};

/** The chat fixtures' fetch, plus the checkpoint routes. */
function fetchWithCheckpoints() {
  const base = verseFetch();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    if (path.startsWith('/api/verse/checkpoints')) {
      return new Response(JSON.stringify(LIST), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return (base.fetch as unknown as typeof globalThis.fetch)(input, init);
  });
  return { fetch, state: base.state };
}

beforeAll(() => preloadChatSurface());

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

describe('Changes pane registration', () => {
  it('is discovered from register.ts and replaces the first-party diff pane, keeping ⇧⌘D and its toggle', () => {
    expect(CHANGES_PANE.id).toBe('changes');
    expect(UNIT_PANE_IDS).toContain('diff');
    expect(getPane('diff')).toMatchObject({ title: 'Changes', command: 'dock.diff', toggle: true });
  });

  it('⇧⌘D in an open chat opens the dock on the Changes pane, showing the turn review', async () => {
    const { fetch } = fetchWithCheckpoints();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    render(<ToastProvider><ChatSection /></ToastProvider>);
    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    await screen.findByRole('heading', { name: 'Fix the login bug' });

    const mod = detectKeyPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(document, { key: 'D', code: 'KeyD', shiftKey: true, ...mod });

    const dock = await screen.findByRole('complementary', { name: 'Dock: Changes' });
    expect(within(dock).getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
    // Our pane, not the old Review body: the Turns/Git switch, and the checkpoint list read.
    expect(await within(dock).findByRole('radiogroup', { name: 'Changes view' })).toBeInTheDocument();
    expect(await within(dock).findByText('No checkpoints yet')).toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.some(([p]) => String(p) === '/api/verse/checkpoints?chatId=vs_1')).toBe(true));
  });
});

vi.mock('../panes/builtin/SlotPanes.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../panes/builtin/SlotPanes.js')>();
  return { ...real, ChangesPaneBody: () => <p>git review body</p> };
});

describe('ChangesPaneHost', () => {
  const props = (over: Partial<PaneProps> = {}): PaneProps => ({
    paneId: 'diff',
    sessionId: 'vs_1',
    session: null,
    roots: [],
    events: [],
    turnFiles: [],
    visible: false,
    presentation: 'column',
    requests: { terminal: null, preview: null, diff: null },
    host: {} as PaneProps['host'],
    ...over,
  });

  it('switches between Turns and the Git review, and a diff request opens Git', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ChangesPaneHost {...props()} />);
    expect(screen.queryByText('git review body')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Git' }));
    expect(screen.getByText('git review body')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Turns' }));
    expect(screen.queryByText('git review body')).toBeNull();
    rerender(<ChangesPaneHost {...props({ requests: { terminal: null, preview: null, diff: { root: '/r', scope: 'working', nonce: 7 } as never } })} />);
    expect(await screen.findByText('git review body')).toBeInTheDocument();
  });

  it('with no chat open, says so', () => {
    render(<ChangesPaneHost {...props({ sessionId: null })} />);
    expect(screen.getByText('No chat open')).toBeInTheDocument();
  });
});
