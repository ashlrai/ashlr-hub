/**
 * Workspace.header.test.tsx — the chat pane's header strip.
 *
 * THE STATE THIS PINS. At 1920px with nothing selected, the strip used to be
 * a --strip-height band holding exactly one icon, floated against the right
 * edge: no answer to "where am I", no anchor on the left, and the sidebar
 * toggle only present at all when the sidebar happened to be collapsed — one
 * stray control rather than a pair. Everything below is behaviour and
 * accessible names; the layout half of the same contract (who shrinks, who
 * does not, and the desktop traffic-light clearance) is in
 * Workspace.title.test.ts, which reads the stylesheet.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../data/cache.js';
import { getDockState, resetDockStore } from './dock/dock-store.js';
import { bootstrap, CLAUDE_SEAT, CODEX_SEAT, ev, LOCAL_SEAT, session } from './fixtures.test-support.js';
import { buildTranscript } from './verse-transcript.js';
import type { VerseSessionView } from './useVerseSession.js';
import { Workspace, type WorkspaceProps } from './Workspace.js';

const SEATS = [CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT];
const PROJECTS = bootstrap().projects;

function view(over: Partial<VerseSessionView> = {}): VerseSessionView {
  return {
    sessionId: '',
    session: null,
    events: [],
    lastSeq: 0,
    loaded: true,
    loadError: null,
    stream: 'idle',
    transcript: { items: [], live: false, usage: null },
    ...over,
  };
}

/** A view with a chat actually open. */
function opened(over: Parameters<typeof session>[0] = {}): VerseSessionView {
  const s = session(over);
  return view({ sessionId: s.id, session: s });
}

function props(over: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    view: view(),
    seats: SEATS,
    projects: PROJECTS,
    dispatchEnabled: true,
    locked: false,
    hasAnySessions: false,
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

// Workspace owns the seat poll (useSeatsRefresh), so it holds a cache
// subscription for as long as it is mounted. Nothing here advances the timer,
// but a stubbed fetch keeps an accidental read from hitting undefined.
beforeEach(() => {
  evictAll();
  // A 404 is what an unmounted route answers; every reader must survive it.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function header(container: HTMLElement): HTMLElement {
  const el = container.querySelector('header');
  expect(el, 'the chat pane always renders a header strip').not.toBeNull();
  return el as HTMLElement;
}

describe('Workspace header — nothing selected', () => {
  it('still says where you are, instead of leaving an empty band', () => {
    const view1 = render(<Workspace {...props({ hasAnySessions: true })} />);
    const strip = header(view1.container);
    // The section you are in, then the state you are in it — the same
    // two-line lockup shape a selected chat gets, so the strip does not
    // change structure when you pick one.
    expect(within(strip).getByText('Chat')).toBeInTheDocument();
    expect(within(strip).getByText('No chat selected')).toBeInTheDocument();
  });

  it('says so differently when there is nothing to select yet', () => {
    const view1 = render(<Workspace {...props({ hasAnySessions: false })} />);
    expect(within(header(view1.container)).getByText('No chats yet')).toBeInTheDocument();
  });

  it('uses the Ctrl shortcut in the empty state outside macOS', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    try {
      render(<Workspace {...props({ hasAnySessions: false })} />);
      expect(screen.getByRole('heading', { name: 'No chats yet — Ctrl+N' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New chat Ctrl+N' })).toBeInTheDocument();
    } finally {
      platform.mockRestore();
    }
  });

  it('carries both pane toggles even with no chat open', () => {
    const view1 = render(<Workspace {...props()} />);
    const strip = header(view1.container);
    expect(within(strip).getByRole('button', { name: 'Chat list' })).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Dock' })).toBeInTheDocument();
  });

  it('keeps the strip draggable in the desktop shell', () => {
    // desktop/README.md "Desktop shell contract" §2: the top strip of the
    // window is what moves it. Losing the attribute makes the Tauri window
    // undraggable from the main column, which no test would otherwise notice.
    const view1 = render(<Workspace {...props()} />);
    expect(header(view1.container)).toHaveAttribute('data-app-region', 'drag');
    const open = render(<Workspace {...props({ view: opened() })} />);
    expect(header(open.container)).toHaveAttribute('data-app-region', 'drag');
  });
});

describe('Workspace header — the pane toggles', () => {
  // The shell folds dock state into its persisted blob, so a clean dock is a
  // clean store AND clean storage.
  beforeEach(() => {
    localStorage.clear();
    resetDockStore();
  });

  it('groups them, labels them, and reports open/closed with aria-pressed', async () => {
    const user = userEvent.setup();
    const onToggleSidebar = vi.fn();
    const view1 = render(<Workspace {...props({ onToggleSidebar })} />);

    const group = within(header(view1.container)).getByRole('group', { name: 'Panels' });
    const sidebar = within(group).getByRole('button', { name: 'Chat list' });
    const dock = within(group).getByRole('button', { name: 'Dock' });
    expect(sidebar).toHaveAttribute('aria-pressed', 'true');
    // The dock starts closed; ⌘\ or this button opens it (on Tasks when empty).
    expect(dock).toHaveAttribute('aria-pressed', 'false');

    await user.click(sidebar);
    await user.click(dock);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(dock).toHaveAttribute('aria-pressed', 'true');
    expect(getDockState()).toMatchObject({ open: true, active: 'tasks' });
  });

  it('is unpressed — and the sidebar one renames — once the panes are closed', () => {
    const view1 = render(<Workspace {...props({ sidebarCollapsed: true })} />);
    const strip = header(view1.container);
    // "Show chat list" is the name the Chat section's own tests drive while
    // the list is hidden. It differs from the expanded name on purpose: the
    // sidebar owns a button called "Hide chat list", and two controls with
    // one accessible name is an ambiguity, not a pair.
    const sidebar = within(strip).getByRole('button', { name: 'Show chat list' });
    expect(sidebar).toHaveAttribute('aria-pressed', 'false');
    expect(within(strip).getByRole('button', { name: 'Dock' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(strip).queryByRole('button', { name: 'Hide chat list' })).toBeNull();
  });
});

describe('Workspace header — a chat is open', () => {
  it('puts the project above the title, and a compact status — not the seat or model — beside it', async () => {
    const user = userEvent.setup();
    const view1 = render(<Workspace {...props({ view: opened() })} />);
    const strip = header(view1.container);

    // "where am I": the project's short name, with the full path on hover.
    const project = within(strip).getByText('hub');
    expect(project).toHaveAttribute('title', '/Users/mason/dev/hub');
    expect(within(strip).getByRole('heading', { name: 'Fix the login bug' })).toBeInTheDocument();

    // 3.10.1: the composer's seat chip names seat · model, so the header does
    // not repeat them (nor the project). It says the chat's STATE instead…
    const chip = within(strip).getByTestId('chat-status');
    expect(chip).toHaveAttribute('data-engine', 'claude');
    expect(chip).toHaveTextContent('Ready');
    for (const repeated of ['Opus 5', 'Claude Max', 'hub']) expect(chip.textContent).not.toContain(repeated);
    // …and what it runs on stays one hover away.
    await user.hover(chip);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Runs on Claude Max · Opus 5');
  });

  // 3.10.1 review: seat, model and the capacity sentence moved from the chip's
  // text into its tooltip — on a span that could not take focus, so keyboard
  // and screen-reader users never reached them. The chip is a tab stop now.
  it('reaches seat and model from the keyboard: the chip is a tab stop, its tooltip its description', async () => {
    const user = userEvent.setup();
    const view1 = render(<Workspace {...props({ view: opened() })} />);
    const strip = header(view1.container);
    const chip = within(strip).getByTestId('chat-status');

    // In the tab order straight after the title, not skipped over.
    within(strip).getByRole('button', { name: 'Fix the login bug' }).focus();
    await user.tab();
    expect(chip).toHaveFocus();
    expect(chip).toHaveAccessibleName('Chat status: Ready');
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Runs on Claude Max · Opus 5');
    expect(chip).toHaveAccessibleDescription(expect.stringContaining('Runs on Claude Max · Opus 5'));
    // Escape dismisses the bubble; focus stays put (WCAG 1.4.13).
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(chip).toHaveFocus();
  });

  it('names a tight seat in the chip and says why in its focus tooltip', async () => {
    const tight = { ...CLAUDE_SEAT, health: { ...CLAUDE_SEAT.health, windows: [{ id: '7d', usedPercent: 92, resetsAt: null }] } };
    render(<Workspace {...props({ view: opened(), seats: [tight, CODEX_SEAT, LOCAL_SEAT] })} />);
    const chip = screen.getByTestId('chat-status');
    expect(chip).toHaveAttribute('data-seat-capacity', 'tight');
    expect(chip).toHaveAccessibleName('Chat status: Ready, tight');
    chip.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Runs on Claude Max · Opus 5 — .*92%/);
  });

  it('says the chat state in words: Running, Last turn failed, Read-only', () => {
    const running = render(<Workspace {...props({ view: opened({ status: 'running' }) })} />);
    expect(within(header(running.container)).getByTestId('chat-status')).toHaveTextContent('Running');
    running.unmount();
    const failed = render(<Workspace {...props({ view: opened({ status: 'error' }) })} />);
    const chip = within(header(failed.container)).getByTestId('chat-status');
    expect(chip).toHaveTextContent('Last turn failed');
    expect(chip).toHaveAttribute('data-status', 'error');
    failed.unmount();
    const readOnly = render(<Workspace {...props({ view: opened(), dispatchEnabled: false })} />);
    expect(within(header(readOnly.container)).getByTestId('chat-status')).toHaveTextContent('Read-only');
  });

  it('gives every icon-only control a name AND a tooltip that shows on keyboard focus', async () => {
    localStorage.clear();
    resetDockStore();
    const user = userEvent.setup();
    const view1 = render(<Workspace {...props({ view: opened() })} />);
    const strip = header(view1.container);
    for (const [name, tip] of [['Chat actions', 'Chat actions'], ['Chat list', 'Hide chat list'], ['Dock', 'Show the dock']] as const) {
      const button = within(strip).getByRole('button', { name });
      // A native title is mouse-only and doubles the bubble: the primitive replaces it.
      expect(button).not.toHaveAttribute('title');
      button.focus();
      await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(tip));
      expect(button).toHaveAccessibleName(name);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('tooltip')).toBeNull();
    }
  });

  it('keeps every action reachable behind a title long enough to fill the strip', () => {
    // The title truncates in CSS (see Workspace.title.test.ts for the
    // declarations that do it), so the accessible name stays whole while the
    // action cluster keeps its width. What must NEVER happen is the actions
    // being dropped, re-ordered before the title, or wrapped onto a row of
    // their own.
    const long = 'Refactor the authentication middleware '.repeat(8).trim();
    const view1 = render(<Workspace {...props({ view: opened({ title: long }) })} />);
    const strip = header(view1.container);

    const rename = within(strip).getByRole('button', { name: long });
    expect(rename.textContent).toBe(long);

    for (const name of ['Chat actions', 'Chat list', 'Dock']) {
      const action = within(strip).getByRole('button', { name });
      expect(action).toBeInTheDocument();
      // Every action sits after the title in document order — the actions are
      // the right-hand cluster, the lockup is what gives up room.
      expect(rename.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('shows a deep project path by its short name and keeps the full path on hover', () => {
    const deep = '/Users/mason/dev/monorepo/packages/services/identity/provider/edge';
    const view1 = render(<Workspace {...props({ view: opened({ projectPath: deep }) })} />);
    const strip = header(view1.container);
    const project = within(strip).getByText('edge');
    expect(project).toHaveAttribute('title', deep);
    // The actions survive it, which is the whole point of the short name.
    expect(within(strip).getByRole('button', { name: 'Dock' })).toBeInTheDocument();
  });

  it('renames from the title and leaves the lockup in place while editing', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => true);
    const view1 = render(<Workspace {...props({ view: opened(), onRename })} />);
    const strip = header(view1.container);

    await user.click(within(strip).getByRole('button', { name: 'Fix the login bug' }));
    const box = within(strip).getByRole('textbox', { name: 'Chat title' });
    // The project stays visible: renaming a chat does not lose you your place.
    expect(within(strip).getByText('hub')).toBeInTheDocument();

    await user.clear(box);
    await user.type(box, 'Fix the logout bug{Enter}');
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Fix the logout bug'));
  });

  it('renders the lockup as a skeleton, not a bare strip, while the chat loads', () => {
    const view1 = render(<Workspace {...props({ view: view({ sessionId: 'vs_1', session: null, loaded: false }) })} />);
    const strip = header(view1.container);
    expect(within(strip).getByLabelText('Loading chat')).toBeInTheDocument();
    // The toggles are chrome, not chat data — they are usable immediately.
    expect(within(strip).getByRole('button', { name: 'Dock' })).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Chat list' })).toBeInTheDocument();
  });
});

describe('Workspace — paths in the chat', () => {
  it('hands the chat\'s roots to the transcript, so a tool path reads relative to the project', () => {
    const s = session();
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'read it' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'r1', name: 'Read', input: { file_path: '/Users/mason/dev/hub/src/auth/login.ts' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'r1', output: 'ok', isError: false }),
    ]);
    render(<Workspace {...props({ view: view({ sessionId: s.id, session: s, transcript }) })} />);
    const log = screen.getByRole('log');
    expect(within(log).getByRole('button', { name: 'read src/auth/login.ts' })).toBeInTheDocument();
    const line = document.getElementById('verse-tool-r1')!.querySelector('summary')!;
    expect(within(line).getByText('src/auth/login.ts')).toHaveAttribute('title', '/Users/mason/dev/hub/src/auth/login.ts');
  });
});
