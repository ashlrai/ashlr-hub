/**
 * Sidebar.test.tsx — the chat list stays quiet, with ONE exception.
 *
 * A turn in flight on a seat whose binding window is spent is the turn about
 * to fail, so that row is marked. Nothing else in the list gains a badge: a
 * badge that is always there is a badge nobody reads, and the capacity rides
 * in the row's `title` where it costs no pixels.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseSeat, VerseSession } from '../../data/api-types.js';
import type { VerseSearchResponse } from '../../../core/verse/types.js';
import { CLAUDE_SEAT, bootstrap, session } from './fixtures.test-support.js';
import { CLAUDE_MAX_SEAT } from './seat-fixtures.test-support.js';
import { Sidebar } from './Sidebar.js';
import { findCommand, formatChord } from './shell/command-catalog.js';

// Message search is the one network read the sidebar itself triggers; its
// wire contract is pinned in context/context-queries.test.ts, so here it is
// replaced by an in-memory answer.
const search = vi.hoisted(() => ({ searchSessions: vi.fn() }));
vi.mock('./context/context-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context/context-queries.js')>();
  return { ...actual, ...search };
});

beforeEach(() => {
  search.searchSessions.mockImplementation(async (q: string): Promise<VerseSearchResponse> => ({
    query: q,
    hits: [],
    scannedSessions: 1,
    truncated: false,
  }));
});

/** Claude with its per-model week spent, under the session fixture's seat id. */
const SPENT: VerseSeat = { ...CLAUDE_MAX_SEAT, id: CLAUDE_SEAT.id, accountId: CLAUDE_SEAT.accountId, models: CLAUDE_SEAT.models };

function mount(sessions: VerseSession[], seats: readonly VerseSeat[]) {
  const boot = bootstrap();
  return render(
    <Sidebar sessions={sessions} sessionsStatus="success" sessionsError={null} projects={boot.projects}
      seats={seats} selectedId={null} query="" onQuery={() => {}} onSelect={() => {}} onNew={() => {}}
      onRetry={() => {}} onCollapse={() => {}} onDisconnect={() => {}} />,
  );
}

describe('Sidebar — an exhausted seat under a running turn', () => {
  it('marks a running chat whose seat has no window left', () => {
    mount([session({ status: 'running' })], [SPENT]);
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(within(nav).getByRole('img', { name: 'Seat limit reached: weekly fable window limit reached' })).toBeInTheDocument();
  });

  it('says nothing on an idle chat on that same seat', async () => {
    const user = userEvent.setup();
    mount([session({ status: 'idle' })], [SPENT]);
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(within(nav).queryByRole('img', { name: /Seat limit reached/ })).not.toBeInTheDocument();
    // The fact is still reachable — it just costs no pixels. It used to ride
    // in a native `title`, i.e. mouse-only; it is now a tooltip the keyboard
    // can reach as well.
    const row = within(nav).getByRole('button', { name: /Fix the login bug/ });
    expect(row).not.toHaveAttribute('title');
    await user.hover(row);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('weekly fable window limit reached');
  });

  it('says nothing at all on a healthy seat', async () => {
    const user = userEvent.setup();
    mount([session({ status: 'running' })], [CLAUDE_SEAT]);
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(within(nav).queryByRole('img', { name: /Seat limit reached/ })).not.toBeInTheDocument();
    const row = within(nav).getByRole('button', { name: /Fix the login bug/ });
    await user.hover(row);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Fix the login bug · Claude Max · Opus 5');
  });
});

describe('Sidebar — the chat list after the title sweep', () => {
  /**
   * THE REGRESSION THIS FILE EXISTS TO CATCH. Sweeping `title=` onto a
   * tooltip primitive is one search-and-replace away from stripping the only
   * readable label off an icon-only control: a tooltip is a DESCRIPTION and
   * never an accessible name. Every icon-only control in the sidebar is
   * asserted by NAME here, so the sweep cannot quietly un-name one.
   */
  it('keeps an accessible name on every icon-only control', () => {
    mount([session({ status: 'idle' })], [CLAUDE_SEAT]);
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    for (const name of ['New chat', 'Hide chat list']) {
      const button = within(nav).getByRole('button', { name });
      expect(button).toHaveAccessibleName(name);
      expect(button).not.toHaveAttribute('title');
    }
  });

  it('opens the new-chat tooltip on keyboard focus and closes it on Escape', async () => {
    const user = userEvent.setup();
    mount([session({ status: 'idle' })], [CLAUDE_SEAT]);
    const button = screen.getByRole('button', { name: 'New chat' });

    // A native title never appears for a keyboard operator at all.
    expect(screen.queryByRole('tooltip')).toBeNull();
    button.focus();
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible());
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('New chat');
    // The shortcut travels with the label rather than being folded into the
    // accessible name, where a screen reader would read it out as part of it.
    expect(tip).toHaveTextContent(formatChord(findCommand('chat.new')!.keys[0]!));
    expect(button).toHaveAccessibleName('New chat');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('shows the actual Ctrl shortcuts on non-Mac platforms', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    try {
      mount([], [CLAUDE_SEAT]);
      expect(screen.getByRole('button', { name: /Start your first chat/ })).toHaveTextContent('Ctrl+N');
      const newChat = screen.getByRole('button', { name: 'New chat' });
      newChat.focus();
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Ctrl+N');
    } finally {
      platform.mockRestore();
    }
  });

  it('truncates a very long chat title instead of letting it set the row width', async () => {
    const user = userEvent.setup();
    const long = 'Refactor '.repeat(40).trim();
    mount([session({ status: 'idle', title: long })], [CLAUDE_SEAT]);
    const row = screen.getByRole('button', { name: new RegExp(long.slice(0, 40)) });

    // The clipping itself is a CSS concern jsdom does not compute. What is
    // testable — and what actually breaks when a wrapper element lands
    // between the <li> and the row — is that the row still renders the title
    // on ONE line whose overflow is hidden, and that the full text stays
    // reachable rather than being thrown away by the ellipsis.
    const text = row.querySelector('span:not([aria-hidden])');
    expect(text).not.toBeNull();
    expect(text).toHaveTextContent(long);

    await user.hover(row);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(long);
  });

  it('offers a way out of an empty search rather than a dead end', async () => {
    const user = userEvent.setup();
    const onQuery = vi.fn();
    const boot = bootstrap();
    render(
      <Sidebar sessions={[session({ status: 'idle' })]} sessionsStatus="success" sessionsError={null}
        projects={boot.projects} seats={[CLAUDE_SEAT]} selectedId={null} query="zzzznomatch"
        onQuery={onQuery} onSelect={() => {}} onNew={() => {}} onRetry={() => {}}
        onCollapse={() => {}} onDisconnect={() => {}} />,
    );
    expect(screen.getByText(/No chat titles match/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Clear search/ }));
    expect(onQuery).toHaveBeenCalledWith('');
  });

  it('marks which row is open so a hovered row cannot be mistaken for it', () => {
    const open = session({ id: 'open-one', title: 'The open chat' });
    const other = session({ id: 'other-one', title: 'Another chat' });
    const boot = bootstrap();
    render(
      <Sidebar sessions={[open, other]} sessionsStatus="success" sessionsError={null}
        projects={boot.projects} seats={[CLAUDE_SEAT]} selectedId="open-one" query=""
        onQuery={() => {}} onSelect={() => {}} onNew={() => {}} onRetry={() => {}}
        onCollapse={() => {}} onDisconnect={() => {}} />,
    );
    // aria-current is the affordance assistive tech reads; the accent edge
    // rule is keyed off the same attribute, so one assertion pins both.
    expect(screen.getByRole('button', { name: /The open chat/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /Another chat/ })).not.toHaveAttribute('aria-current');
  });
});

describe('Sidebar — one search field, two answers', () => {
  function mountWithQuery(query: string, onSelect = vi.fn()) {
    const boot = bootstrap();
    render(
      <Sidebar sessions={[session({ id: 'vs_1', title: 'Fix the login bug' }), session({ id: 'vs_2', title: 'Payments webhooks' })]}
        sessionsStatus="success" sessionsError={null} projects={boot.projects} seats={[CLAUDE_SEAT]} selectedId={null}
        query={query} onQuery={() => {}} onSelect={onSelect} onNew={() => {}} onRetry={() => {}}
        onCollapse={() => {}} onDisconnect={() => {}} />,
    );
    return { onSelect };
  }

  it('names the field for both things it searches', () => {
    mountWithQuery('');
    expect(screen.getByRole('searchbox', { name: 'Search chats and messages' })).toBeInTheDocument();
  });

  it('does not scan transcripts for an empty field', async () => {
    mountWithQuery('');
    await new Promise((r) => setTimeout(r, 350));
    expect(search.searchSessions).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: /In messages/ })).toBeNull();
  });

  it('lists chats whose MESSAGES match, below the title matches, and opens them', async () => {
    search.searchSessions.mockResolvedValue({
      query: 'backoff',
      hits: [{
        sessionId: 'vs_2', title: 'Payments webhooks', projectPath: '/Users/mason/dev/hub', engine: 'claude', seq: 7,
        at: '2026-09-19T10:04:00.000Z', kind: 'assistant', snippet: 'Webhook retries use exponential backoff.', score: 3,
      }],
      scannedSessions: 2,
      truncated: false,
    });
    const user = userEvent.setup();
    const { onSelect } = mountWithQuery('backoff');
    // No TITLE says "backoff" — the list is not a dead end, it points below.
    expect(screen.getByText(/No chat titles match “backoff”/)).toBeInTheDocument();
    const results = await screen.findByRole('region', { name: /In messages/ });
    const row = await within(results).findByRole('button', { name: /Payments webhooks/ });
    expect(row.querySelector('mark')).toHaveTextContent('backoff');
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith('vs_2');
    expect(search.searchSessions).toHaveBeenCalledWith('backoff', expect.any(Number), expect.any(AbortSignal));
  });

  it('keeps instant title matches and adds message matches under them', async () => {
    mountWithQuery('login');
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(within(nav).getByRole('button', { name: /Fix the login bug/ })).toBeInTheDocument();
    expect(await screen.findByText(/^No messages match “login”\./)).toBeInTheDocument();
  });
});

// ===========================================================================
// 3.10 — filters, pins, archive, unread, the live line, the row menu
// ===========================================================================

describe('Sidebar 3.10', () => {
  const NOW = new Date().toISOString();
  const S = [
    session({ id: 'vs_run', title: 'Running one', status: 'running', updatedAt: NOW }),
    session({ id: 'vs_fail', title: 'Failed one', status: 'error', updatedAt: NOW }),
    session({ id: 'vs_new', title: 'Unread one', turnCount: 4, updatedAt: NOW }),
    session({ id: 'vs_pin', title: 'Pinned one', updatedAt: NOW }),
    session({ id: 'vs_old', title: 'Archived one', updatedAt: NOW }),
  ];
  const activity = {
    cursor: 'c', generatedAt: NOW, completions: [], counts: { running: 1, needsYou: 1, unread: 1 },
    sources: { approvals: 'ok', authority: 'ok', fleet: 'ok', leader: 'ok', chats: 'ok', accounts: 'ok' },
    autonomy: null, capacity: null, mind: null,
    running: [{ sessionId: 'vs_run', title: 'Running one', engine: 'claude', seatId: CLAUDE_SEAT.id, startedAt: new Date(Date.now() - 62_000).toISOString(),
      live: { phase: 'tool', tool: 'npm test', elapsedMs: 62_000, thinkingTail: null } }],
    needsYou: [{ id: 'chats:chat-failed:vs_fail', source: 'chats', kind: 'chat-failed', severity: 'warn', title: 'Failed one failed', detail: null,
      since: NOW, expiresAt: null, subject: { repo: null, pr: null, seatId: null, sessionId: 'vs_fail', engine: 'claude' },
      target: { kind: 'session', sessionId: 'vs_fail' }, actions: [] }],
  } as unknown as import('../../../core/verse/workbench-types.js').VerseActivityResponse;
  const meta = {
    sessions: {
      vs_new: { sessionId: 'vs_new', pinned: false, archived: false, seenTurnCount: 2 },
      vs_pin: { sessionId: 'vs_pin', pinned: true, archived: false, seenTurnCount: 1 },
      vs_old: { sessionId: 'vs_old', pinned: false, archived: true, seenTurnCount: 1 },
      vs_run: { sessionId: 'vs_run', pinned: false, archived: false, seenTurnCount: 1 },
      vs_fail: { sessionId: 'vs_fail', pinned: false, archived: false, seenTurnCount: 1 },
    },
  };

  function actions() {
    return {
      setPinned: vi.fn(), setArchived: vi.fn(), rename: vi.fn(async () => true), handoff: vi.fn(), requestDelete: vi.fn(), dispatchEnabled: true,
    };
  }

  function mount310(over: Partial<import('./Sidebar.js').SidebarProps> = {}) {
    const boot = bootstrap();
    const a = actions();
    const onSelect = vi.fn();
    const view = render(
      <Sidebar sessions={S} sessionsStatus="success" sessionsError={null} projects={boot.projects}
        seats={[CLAUDE_SEAT]} selectedId={null} query="" onQuery={() => {}} onSelect={onSelect} onNew={() => {}}
        onRetry={() => {}} onCollapse={() => {}} onDisconnect={() => {}} activity={activity} meta={meta} actions={a} {...over} />,
    );
    return { ...view, actions: a, onSelect };
  }

  it('groups Pinned first, then projects, then a collapsed Archived', async () => {
    const user = userEvent.setup();
    mount310();
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    const groups = within(nav).getAllByRole('region').filter((r) => r.hasAttribute('data-group'));
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Pinned', 'hub', 'Archived']);
    expect(within(groups[0]!).getByRole('button', { name: /Pinned one/ })).toBeInTheDocument();
    // Archived starts folded; its heading is a disclosure.
    const archived = within(groups[2]!).getByRole('button', { name: 'Archived' });
    expect(archived).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).queryByRole('button', { name: /Archived one/ })).toBeNull();
    await user.click(archived);
    expect(within(nav).getByRole('button', { name: /Archived one/ })).toBeInTheDocument();
  });

  it('gives each row ONE status, named: running with its elapsed time and live line, failed, unread, or the time', () => {
    mount310();
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    const running = within(nav).getByRole('button', { name: /Running one/ });
    expect(within(running).getByRole('img', { name: 'Running' })).toBeInTheDocument();
    expect(running).toHaveTextContent('npm test');
    expect(running).toHaveTextContent(/1m \d+s/);
    expect(within(within(nav).getByRole('button', { name: /Failed one/ })).getByRole('img', { name: 'Last turn failed' })).toBeInTheDocument();
    expect(within(within(nav).getByRole('button', { name: /Unread one/ })).getByRole('img', { name: '2 new turns' })).toBeInTheDocument();
    const quiet = within(nav).getByRole('button', { name: /Pinned one/ });
    expect(quiet.querySelector('time')).not.toBeNull();
    expect(within(quiet).queryByRole('img')).toBeNull();
  });

  it('says nothing is unread when read state is unknown (no session-meta route)', () => {
    mount310({ meta: null });
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(within(nav).queryByRole('img', { name: /new turn/ })).toBeNull();
  });

  it('filters with a radio group: one tab stop, ←/→ between All, Running, Needs you, Pinned', async () => {
    const user = userEvent.setup();
    mount310();
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    const group = within(nav).getByRole('radiogroup', { name: 'Show chats' });
    const all = within(group).getByRole('radio', { name: 'All' });
    expect(all).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: 'Running 1' })).toHaveAttribute('tabindex', '-1');
    all.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: 'Running 1' })).toHaveFocus();
    expect(within(nav).getAllByRole('button', { name: /one/ }).map((b) => b.textContent)).toEqual([expect.stringContaining('Running one')]);
    await user.keyboard('{ArrowRight}');
    expect(within(nav).getAllByRole('button', { name: / one/ }).map((b) => b.getAttribute('data-focus-key'))).toEqual(['verse-session:vs_fail']);
    await user.keyboard('{ArrowRight}');
    expect(within(nav).getAllByRole('button', { name: / one/ }).map((b) => b.getAttribute('data-focus-key'))).toEqual(['verse-session:vs_pin']);
    await user.keyboard('{End}{ArrowRight}');
    expect(all).toHaveAttribute('aria-checked', 'true');
  });

  it('offers a way out of an empty filter', async () => {
    const user = userEvent.setup();
    mount310({ activity: { ...activity, running: [] }, sessions: S.map((s) => ({ ...s, status: 'idle' as const })) });
    await user.click(screen.getByRole('radio', { name: 'Running' }));
    expect(screen.getByText('No chat is running')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all chats' }));
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
  });

  it('opens the row menu with Shift+F10 and right-click; pins, archives, hands off and asks to delete', async () => {
    const user = userEvent.setup();
    const { actions: a } = mount310();
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    const row = within(nav).getByRole('button', { name: /Unread one/ });
    expect(row).toHaveAttribute('aria-haspopup', 'menu');
    row.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    let menu = screen.getByRole('menu', { name: 'Actions for Unread one' });
    expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(a.setPinned).toHaveBeenCalledWith('vs_new', true);
    expect(row).toHaveFocus();

    await user.pointer({ keys: '[MouseRight]', target: row });
    menu = screen.getByRole('menu', { name: 'Actions for Unread one' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Archive' }));
    expect(a.setArchived).toHaveBeenCalledWith('vs_new', true);

    await user.pointer({ keys: '[MouseRight]', target: row });
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Continue in a fresh chat…' }));
    expect(a.handoff).toHaveBeenCalledWith('vs_new');

    await user.pointer({ keys: '[MouseRight]', target: row });
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete…' }));
    expect(a.requestDelete).toHaveBeenCalledWith('vs_new');
  });

  it('renames in place: Enter commits, Escape keeps the old title', async () => {
    const user = userEvent.setup();
    const { actions: a } = mount310();
    const row = within(screen.getByRole('navigation', { name: 'Chats' })).getByRole('button', { name: /Unread one/ });
    row.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const box = screen.getByRole('textbox', { name: 'Chat title' });
    expect(box).toHaveFocus();
    await user.clear(box);
    await user.type(box, 'Read me{Enter}');
    expect(a.rename).toHaveBeenCalledWith('vs_new', 'Read me');

    const again = within(screen.getByRole('navigation', { name: 'Chats' })).getByRole('button', { name: /Unread one/ });
    again.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.type(screen.getByRole('textbox', { name: 'Chat title' }), 'nope{Escape}');
    expect(a.rename).toHaveBeenCalledTimes(1);
  });

  it('shows pin and archive disabled, with the reason, on a server without session meta; delete is refused while running', async () => {
    const user = userEvent.setup();
    mount310({ meta: null });
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    const row = within(nav).getByRole('button', { name: /Running one/ });
    row.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Pin/ })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitem', { name: /Pin/ })).toHaveTextContent('Not available on this server yet.');
    expect(within(menu).getByRole('menuitem', { name: /Delete/ })).toHaveTextContent('Stop its turn before deleting.');
  });

  it('a session-meta read that FAILED names the reason on pin and archive, not "not on this server"', async () => {
    const user = userEvent.setup();
    mount310({ meta: null, metaError: 'The chat engine is not answering. Restart ashlr verse.' });
    const row = within(screen.getByRole('navigation', { name: 'Chats' })).getByRole('button', { name: /Running one/ });
    row.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu');
    for (const name of [/^Pin/, /^Archive/]) {
      const item = within(menu).getByRole('menuitem', { name });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveTextContent('Pins and archive unavailable. The chat engine is not answering. Restart ashlr verse.');
      expect(item).not.toHaveTextContent('Not available on this server yet.');
    }
  });
});

// ===========================================================================
// 3.10.1 — group names, the "!" explained, keyboard, the footer action
// ===========================================================================

describe('Sidebar 3.10.1', () => {
  function mountList(sessions: VerseSession[], over: Partial<import('./Sidebar.js').SidebarProps> = {}) {
    const onSelect = vi.fn();
    const onDisconnect = vi.fn();
    render(
      <Sidebar sessions={sessions} sessionsStatus="success" sessionsError={null} projects={[]} seats={[CLAUDE_SEAT]}
        selectedId={null} query="" onQuery={() => {}} onSelect={onSelect} onNew={() => {}} onRetry={() => {}}
        onCollapse={() => {}} onDisconnect={onDisconnect} {...over} />,
    );
    return { onSelect, onDisconnect, nav: screen.getByRole('navigation', { name: 'Chats' }) };
  }

  it('heads each group with the folder name as it is on disk, full path as the tooltip', async () => {
    const path = '/Users/mason/.claude/plugins/ashlr-plugin--local';
    const { nav } = mountList([session({ id: 'vs_p', title: 'Plugin work', projectPath: path })]);
    const heading = within(nav).getByRole('heading', { name: /^ashlr-plugin--local/ });
    // Normal case, not a shouted slug: the text is the basename verbatim…
    expect(within(heading).getByText('ashlr-plugin--local')).toBeInTheDocument();
    expect(heading).toHaveAttribute('title', path);
    // …and the stylesheet no longer upper-cases it.
    const { moduleDeclaration } = await import('../../design/token-probe.test-support.js');
    expect(moduleDeclaration('routes/verse/Sidebar.module.css', '.groupTitle', 'text-transform')).toBeNull();
  });

  it('explains the red "!" in the row tooltip, not only to a screen reader', async () => {
    const user = userEvent.setup();
    const { nav } = mountList([session({ id: 'vs_f', title: 'Broken build', status: 'error' })]);
    const row = within(nav).getByRole('button', { name: /Broken build/ });
    expect(within(row).getByRole('img', { name: 'Last turn failed' })).toHaveTextContent('!');
    await user.hover(row);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Broken build · Claude Max · Opus 5 · Last turn failed');
  });

  it('moves between chats with ↑/↓, Home/End, and opens one with Enter', async () => {
    const user = userEvent.setup();
    const { onSelect, nav } = mountList([
      session({ id: 'vs_a', title: 'Alpha', updatedAt: '2026-09-19T10:05:00.000Z' }),
      session({ id: 'vs_b', title: 'Bravo', updatedAt: '2026-09-19T10:04:00.000Z', projectPath: '/Users/mason/dev/site' }),
      session({ id: 'vs_c', title: 'Charlie', updatedAt: '2026-09-19T10:03:00.000Z' }),
    ]);
    const row = (title: string) => within(nav).getByRole('button', { name: new RegExp(`^${title}`) });
    // ↓ from the search field lands on the first chat.
    screen.getByRole('searchbox', { name: 'Search chats and messages' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(row('Alpha')).toHaveFocus();
    // Across group boundaries, in the order the list draws them (hub: Alpha, Charlie; site: Bravo).
    await user.keyboard('{ArrowDown}');
    expect(row('Charlie')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(row('Bravo')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(row('Bravo')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(row('Alpha')).toHaveFocus();
    await user.keyboard('{End}{ArrowUp}');
    expect(row('Charlie')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('vs_c');
  });

  it('labels the footer action for what it does, and explains it in a tooltip', async () => {
    const user = userEvent.setup();
    const { onDisconnect, nav } = mountList([session()]);
    const button = within(nav).getByRole('button', { name: 'Disconnect from hub' });
    button.focus();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Signs this window out');
    expect(tip).toHaveTextContent('unsent drafts');
    expect(tip).toHaveTextContent('Chats stay on the hub');
    // One click only ASKS (see "Sidebar — Disconnect from hub asks first").
    await user.click(button);
    expect(onDisconnect).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3.10.1 — the footer's Disconnect confirms, like Settings ▸ Connection
// ===========================================================================

describe('Sidebar — Disconnect from hub asks first', () => {
  /**
   * Disconnecting signs this window out AND throws away every unsent draft,
   * so one stray click in the footer must not do it. Settings ▸ Connection
   * already confirms; the footer uses the same Dialog primitive and the same
   * Cancel-first focus, and onDisconnect runs only from the red button.
   */
  function mountFooter() {
    const onDisconnect = vi.fn();
    render(
      <Sidebar sessions={[session()]} sessionsStatus="success" sessionsError={null} projects={[]} seats={[CLAUDE_SEAT]}
        selectedId={null} query="" onQuery={() => {}} onSelect={() => {}} onNew={() => {}} onRetry={() => {}}
        onCollapse={() => {}} onDisconnect={onDisconnect} />,
    );
    const trigger = within(screen.getByRole('navigation', { name: 'Chats' })).getByRole('button', { name: 'Disconnect from hub' });
    return { onDisconnect, trigger };
  }

  it('opens a confirm dialog, focused on Cancel, and does not disconnect on the first click', async () => {
    const user = userEvent.setup();
    const { onDisconnect, trigger } = mountFooter();
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Disconnect from this hub?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('Unsent drafts in open chats will be cleared.');
    // Announced, not just drawn: focus opens on Cancel, so the warning is
    // only heard because it is the dialog's description (3.10.1 review).
    expect(dialog).toHaveAccessibleDescription(
      'Unsent drafts in open chats will be cleared. Your chats stay on the hub; you will need the read token to reconnect.');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('Enter on the default (Cancel) keeps the session', async () => {
    const user = userEvent.setup();
    const { onDisconnect, trigger } = mountFooter();
    await user.click(trigger);
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('Cancel dismisses without disconnecting and returns focus to the footer button', async () => {
    const user = userEvent.setup();
    const { onDisconnect, trigger } = mountFooter();
    await user.click(trigger);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('Escape dismisses without disconnecting', async () => {
    const user = userEvent.setup();
    const { onDisconnect, trigger } = mountFooter();
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('the red Disconnect calls onDisconnect exactly once and closes the dialog', async () => {
    const user = userEvent.setup();
    const { onDisconnect, trigger } = mountFooter();
    await user.click(trigger);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks again every time: a cancelled confirm does not arm the next click', async () => {
    const user = userEvent.setup();
    const { onDisconnect, trigger } = mountFooter();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Disconnect from this hub?' })).toBeInTheDocument();
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
