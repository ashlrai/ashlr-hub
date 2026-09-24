/**
 * dock/panes.test.tsx — the dock's own panes (Tasks, Context; unit C2):
 * empty states that name the next step, truncating names that keep their
 * full text as a tooltip, and a Context layout that does not jump when a
 * turn starts or ends. ChatUsage, SessionRoots and MemoryPanel are other
 * units' (and MemoryPanel fetches), so they are stood in for here.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../fixtures.test-support.js';
import type { ChatTask, TurnTask } from '../chat/tasks-model.js';
import { ContextPane } from './ContextPane.js';
import { TasksPane } from './TasksPane.js';

vi.mock('../context/ChatUsage.js', () => ({ ChatUsage: () => <p>usage</p> }));
vi.mock('../context/MemoryPanel.js', () => ({ MemoryPanel: () => <p>memory</p> }));
vi.mock('../SessionRoots.js', () => ({ SessionRoots: () => <p>roots</p> }));

const NEW_CHAT = /(⌘N|Ctrl\+N)/;

function task(over: Partial<TurnTask> = {}): TurnTask {
  return { toolUseId: 'tu-1', kind: 'tool', name: 'Bash', detail: 'npm test', startedAt: '2026-09-24T10:00:00.000Z', status: 'done', durationMs: 400, ...over };
}

describe('TasksPane', () => {
  it('an empty turn and no other chats each say what to do next', () => {
    render(<TasksPane turnTasks={[]} otherChats={[]} hasSession onOpenSession={vi.fn()} />);
    const turn = screen.getByRole('region', { name: /This chat/ });
    expect(within(turn).getByText('No tool calls in the latest turn.')).toBeInTheDocument();
    expect(within(turn).getByText(/^Send a message: each tool the agent runs shows up here/)).toBeInTheDocument();
    const others = screen.getByRole('region', { name: /Other chats/ });
    expect(within(others).getByText('No other chat is running.')).toBeInTheDocument();
    expect(within(others).getByText(new RegExp(`^Start another with ${NEW_CHAT.source} and it shows here while it works`))).toBeInTheDocument();
  });

  it('with no chat open, it says to open one', () => {
    render(<TasksPane turnTasks={[]} otherChats={[]} hasSession={false} onOpenSession={vi.fn()} />);
    expect(screen.getByText('Open a chat to see its tool calls here.')).toBeInTheDocument();
  });

  it('a name the row truncates keeps its full text as a tooltip', () => {
    const long = 'mcp__plugin_ashlr_ashlr__ashlr__search_replace_regex';
    const chat: ChatTask = { sessionId: 'vs-2', title: 'Fix the login bug across every service', engine: 'claude', startedAt: null, live: 'npm run build' };
    render(<TasksPane turnTasks={[task({ name: long })]} otherChats={[chat]} hasSession onOpenSession={vi.fn()} />);
    expect(screen.getByText(long)).toHaveAttribute('title', long);
    expect(screen.getByText(chat.title)).toHaveAttribute('title', chat.title);
    expect(screen.getByText('npm run build')).toHaveAttribute('title', 'npm run build');
  });

  it('never renders a raw ISO timestamp', () => {
    render(<TasksPane turnTasks={[task(), task({ toolUseId: 'tu-2', status: 'failed' })]} otherChats={[]} hasSession onOpenSession={vi.fn()} />);
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe('ContextPane', () => {
  const base = { seats: [], events: [], roots: null, rootsError: null, onOpenAccounts: vi.fn(), visible: true } as const;

  it('keeps the handoff reason line mounted, so Memory below does not jump as turns start and end', () => {
    const s = session();
    const { rerender } = render(<ContextPane {...base} session={s} onHandoff={vi.fn()} handoffDisabledReason={null} />);
    const button = screen.getByRole('button', { name: 'Continue in a fresh chat…' });
    expect(button).toBeEnabled();
    const reason = button.nextElementSibling!;
    expect(reason.tagName).toBe('P');
    expect(reason).toHaveTextContent(/^$/);
    rerender(<ContextPane {...base} session={s} onHandoff={vi.fn()} handoffDisabledReason="Available when the current turn finishes." />);
    expect(screen.getByRole('button', { name: 'Continue in a fresh chat…' })).toBeDisabled();
    // The SAME element carries the reason: nothing was inserted above Memory.
    expect(button.nextElementSibling).toBe(reason);
    expect(reason).toHaveTextContent('Available when the current turn finishes.');
  });

  it('with no chat open, it says to open one', () => {
    render(<ContextPane {...base} session={null} />);
    expect(screen.getByText('Open a chat to see its usage and context.')).toBeInTheDocument();
  });
});
