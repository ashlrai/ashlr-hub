/**
 * SessionSearch.test.tsx — message search, as the sidebar mounts it (driven
 * by the sidebar's own field) and standalone.
 *
 * The promises under test: a query under two characters asks nothing;
 * keystrokes collapse into one request; one row per CHAT with the matched
 * words marked; a server without the route stays silent instead of printing
 * a permanent error; a real failure can be retried.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseSearchHit, VerseSearchResponse } from '../../../../core/verse/types.js';
import { ApiError } from '../../../data/client.js';
import { SEARCH_LIMIT } from './context-model.js';

const queries = vi.hoisted(() => ({ searchSessions: vi.fn() }));
vi.mock('./context-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context-queries.js')>();
  return { ...actual, ...queries };
});

const { SessionSearch } = await import('./SessionSearch.js');

function hit(over: Partial<VerseSearchHit> = {}): VerseSearchHit {
  return {
    sessionId: 'vs_1',
    title: 'Fix the login bug',
    projectPath: '/Users/mason/dev/hub',
    engine: 'claude',
    seq: 12,
    at: '2026-09-22T10:00:00.000Z',
    kind: 'assistant',
    snippet: 'We settled the retry policy: exponential backoff, three attempts.',
    score: 4.2,
    ...over,
  };
}

function answer(q: string, hits: VerseSearchHit[], over: Partial<VerseSearchResponse> = {}): VerseSearchResponse {
  return { query: q, hits, scannedSessions: 42, truncated: false, ...over };
}

beforeEach(() => {
  queries.searchSessions.mockImplementation(async (q: string) => answer(q, [
    hit(),
    hit({ seq: 30, kind: 'user', snippet: 'what was the retry policy again?', at: '2026-09-22T11:00:00.000Z', score: 2 }),
    hit({ sessionId: 'vs_2', title: 'Payments', engine: 'codex', snippet: 'Retry policy for webhooks is separate.', score: 1.5 }),
  ]));
});

describe('driven by the sidebar field', () => {
  it('asks nothing and draws nothing for a query under two characters', async () => {
    const { container } = render(<SessionSearch query="r" onOpenSession={() => {}} />);
    await new Promise((r) => setTimeout(r, 350));
    expect(queries.searchSessions).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('collapses keystrokes into one request for the final query', async () => {
    const { rerender } = render(<SessionSearch query="re" onOpenSession={() => {}} />);
    rerender(<SessionSearch query="retr" onOpenSession={() => {}} />);
    rerender(<SessionSearch query="retry policy " onOpenSession={() => {}} />);
    await screen.findByRole('region', { name: /In messages/ });
    await waitFor(() => expect(queries.searchSessions).toHaveBeenCalledTimes(1));
    expect(queries.searchSessions).toHaveBeenCalledWith('retry policy', SEARCH_LIMIT, expect.any(AbortSignal));
  });

  it('lists one row per chat, with the matched words marked, and opens it', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<SessionSearch query="retry policy" onOpenSession={onOpen} selectedId="vs_2" />);
    const results = await screen.findByRole('region', { name: /In messages/ });
    const rows = await within(results).findAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Fix the login bug');
    expect(rows[0]).toHaveTextContent('Agent · 2 matches:');
    const marks = [...rows[0]!.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['retry', 'policy']);
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).toHaveAttribute('data-engine', 'codex');
    expect(within(results).getByText(/Searched 42 chats\./)).toBeInTheDocument();
    // The title is cut to one line, so it carries itself in full as a tooltip.
    expect(within(rows[0]!).getByText('Fix the login bug')).toHaveAttribute('title', 'Fix the login bug');

    await user.click(rows[0]!);
    expect(onOpen).toHaveBeenCalledWith('vs_1');
  });

  it('says when nothing matches', async () => {
    queries.searchSessions.mockResolvedValue(answer('zebra', []));
    render(<SessionSearch query="zebra" onOpenSession={() => {}} />);
    // An empty result names the next thing to try, not only that nothing matched.
    expect(await screen.findByText('No messages match “zebra”. Try fewer or different words.')).toBeInTheDocument();
  });

  it('says when the scan was bounded', async () => {
    queries.searchSessions.mockResolvedValue(answer('retry', [hit()], { scannedSessions: 200, truncated: true }));
    render(<SessionSearch query="retry" onOpenSession={() => {}} />);
    expect(await screen.findByText(/Searched 200 chats — the most recent ones only/)).toBeInTheDocument();
  });

  it('stays silent on a server without the route, and stops asking', async () => {
    queries.searchSessions.mockRejectedValue(new ApiError('GET /api/verse/search failed (HTTP 404).', 404, '/api/verse/search'));
    const { container, rerender } = render(<SessionSearch query="retry" onOpenSession={() => {}} />);
    await waitFor(() => expect(queries.searchSessions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    rerender(<SessionSearch query="retry policy" onOpenSession={() => {}} />);
    await new Promise((r) => setTimeout(r, 350));
    expect(queries.searchSessions).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a real failure with the server’s words, and retries', async () => {
    queries.searchSessions.mockRejectedValueOnce(new ApiError('GET failed', 400, '/api/verse/search', 'q must be at most 200 characters'));
    const user = userEvent.setup();
    render(<SessionSearch query="retry" onOpenSession={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not search messages: q must be at most 200 characters');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Fix the login bug')).toBeInTheDocument();
    expect(queries.searchSessions).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous answer on screen while the next one loads', async () => {
    const { rerender } = render(<SessionSearch query="retry" onOpenSession={() => {}} />);
    await screen.findByText('Fix the login bug');
    let release: (value: VerseSearchResponse) => void = () => {};
    queries.searchSessions.mockImplementationOnce(() => new Promise<VerseSearchResponse>((resolve) => { release = resolve; }));
    rerender(<SessionSearch query="retry backoff" onOpenSession={() => {}} />);
    await waitFor(() => expect(queries.searchSessions).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('region', { name: /In messages/ })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Fix the login bug')).toBeInTheDocument();
    release(answer('retry backoff', [hit({ sessionId: 'vs_9', title: 'Backoff chat' })]));
    expect(await screen.findByText('Backoff chat')).toBeInTheDocument();
    expect(screen.queryByText('Fix the login bug')).toBeNull();
  });
});

describe('standalone', () => {
  it('renders its own field, explains itself, and searches as you type', async () => {
    const user = userEvent.setup();
    render(<SessionSearch onOpenSession={() => {}} />);
    const field = screen.getByRole('searchbox', { name: 'Search messages in every chat' });
    expect(screen.getByText(/Nothing is sent to a model/)).toBeInTheDocument();
    await user.type(field, 'retry');
    expect(await screen.findByText('Fix the login bug')).toBeInTheDocument();
    expect(queries.searchSessions).toHaveBeenLastCalledWith('retry', SEARCH_LIMIT, expect.any(AbortSignal));
  });

  it('keeps its field and says why on a server without the route', async () => {
    queries.searchSessions.mockRejectedValue(new ApiError('nope', 404, '/api/verse/search'));
    const user = userEvent.setup();
    render(<SessionSearch onOpenSession={() => {}} />);
    await user.type(screen.getByRole('searchbox'), 'retry');
    expect(await screen.findByText(/This server cannot search messages yet/)).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
  });
});
