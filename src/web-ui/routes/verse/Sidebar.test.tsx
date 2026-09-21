/**
 * Sidebar.test.tsx — the chat list stays quiet, with ONE exception.
 *
 * A turn in flight on a seat whose binding window is spent is the turn about
 * to fail, so that row is marked. Nothing else in the list gains a badge: a
 * badge that is always there is a badge nobody reads, and the capacity rides
 * in the row's `title` where it costs no pixels.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { VerseSeat, VerseSession } from '../../data/api-types.js';
import { CLAUDE_SEAT, bootstrap, session } from './fixtures.test-support.js';
import { CLAUDE_MAX_SEAT } from './seat-fixtures.test-support.js';
import { Sidebar } from './Sidebar.js';

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

  it('says nothing on an idle chat on that same seat', () => {
    mount([session({ status: 'idle' })], [SPENT]);
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(within(nav).queryByRole('img', { name: /Seat limit reached/ })).not.toBeInTheDocument();
    // The fact is still reachable — it just costs no pixels.
    expect(within(nav).getByRole('button', { name: /Fix the login bug/ }))
      .toHaveAttribute('title', expect.stringContaining('weekly fable window limit reached'));
  });

  it('says nothing at all on a healthy seat', () => {
    mount([session({ status: 'running' })], [CLAUDE_SEAT]);
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(within(nav).queryByRole('img', { name: /Seat limit reached/ })).not.toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /Fix the login bug/ }))
      .toHaveAttribute('title', 'Fix the login bug · Claude Max · Opus 5');
  });
});
