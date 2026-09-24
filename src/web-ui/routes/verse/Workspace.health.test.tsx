/**
 * Workspace.health.test.tsx — the seat health banner's mount in the chat pane
 * (V3.10). The banner itself (wording, Reconnect, Copy, Check again) is
 * pinned in health/SeatHealthBanner.test.tsx; this file pins WHERE it shows:
 * under the header strip whether or not a chat is selected, and not at all —
 * no empty column padding either — while every seat is fine.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeatHealthReport } from '../../../core/verse/health-types.js';
import { evictAll } from '../../data/cache.js';
import { bootstrap, CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT, session } from './fixtures.test-support.js';
import { healthReport } from './health/health.test-support.js';
import type { VerseSessionView } from './useVerseSession.js';
import { Workspace, type WorkspaceProps } from './Workspace.js';

const SEATS = [CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT];

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

function props(over: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    view: view(),
    seats: SEATS,
    projects: bootstrap().projects,
    dispatchEnabled: true,
    locked: false,
    hasAnySessions: true,
    onSend: vi.fn(async () => true),
    onStop: vi.fn(),
    onRename: vi.fn(async () => true),
    onDelete: vi.fn(async () => true),
    onSeatChange: vi.fn(),
    onNew: vi.fn(),
    onRetry: vi.fn(),
    sidebarCollapsed: false,
    onToggleSidebar: vi.fn(),
    resourcesOpen: false,
    onToggleResources: vi.fn(),
    ...over,
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Every read answers `{}` except /api/verse/health, which answers `reports`. */
function stubHealth(reports: SeatHealthReport[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/verse/health') return json({ checkedAt: '2026-09-23T20:00:00.000Z', seats: reports });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const SIGNED_OUT = healthReport(CLAUDE_SEAT.id, {
  connection: 'signed-out',
  reasons: ['Claude Code reports this account is not signed in.'],
  fix: { kind: 'reauth' },
});

beforeEach(() => {
  evictAll();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Workspace — seat health banner mount', () => {
  it('shows a signed-out seat under the strip with no chat selected', async () => {
    const fetchMock = stubHealth([SIGNED_OUT]);
    const { container } = render(<Workspace {...props()} />);
    const region = await screen.findByRole('region', { name: 'Seat health' });
    expect(region).toHaveTextContent('Claude Max');
    expect(screen.getByRole('button', { name: 'Reconnect Claude Max' })).toBeInTheDocument();
    // Under the header, never inside the fixed-height strip.
    expect(container.querySelector('header')?.contains(region)).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/verse/health'))).toBe(true);
  });

  it('shows it with a chat open, too', async () => {
    stubHealth([SIGNED_OUT]);
    const s = session();
    render(<Workspace {...props({ view: view({ sessionId: s.id, session: s }) })} />);
    expect(await screen.findByRole('region', { name: 'Seat health' })).toHaveTextContent('Claude Max');
  });

  it('renders nothing — not even the column wrapper — while every seat is fine', async () => {
    const fetchMock = stubHealth([healthReport(CLAUDE_SEAT.id), healthReport(CODEX_SEAT.id, { engine: 'codex' })]);
    const { container } = render(<Workspace {...props()} />);
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/verse/health'))).toBe(true));
    // Let the read settle before asserting absence.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('region', { name: 'Seat health' })).not.toBeInTheDocument();
    const section = container.querySelector('section')!;
    // header + empty state only: no stray wrapper between them.
    expect([...section.children].map((el) => el.tagName)).toEqual(['HEADER', 'DIV']);
  });
});
