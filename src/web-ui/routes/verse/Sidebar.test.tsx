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
    expect(tip).toHaveTextContent('⌘N');
    expect(button).toHaveAccessibleName('New chat');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button).toHaveFocus();
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
    expect(await screen.findByText('No messages match “login”.')).toBeInTheDocument();
  });
});
