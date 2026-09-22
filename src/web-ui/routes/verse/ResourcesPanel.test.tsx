/**
 * ResourcesPanel.test.tsx — the SEATS list, which is the surface Mason looks
 * at all day and which showed a bare "unknown" pill for every account.
 *
 * Each test below pins one of the two faults that produced that, or one of the
 * honesty rules in docs/VERSE-TELEMETRY-V2.md that the fix must not trade away.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseBootstrap, VerseSeat } from '../../data/api-types.js';
import { evictAll } from '../../data/cache.js';
import { ResourcesPanel } from './ResourcesPanel.js';
import {
  CLAUDE_MAX_SEAT,
  CLAUDE_TIGHT_SEAT,
  CODEX_CREDITS_SEAT,
  LOCAL_SEAT_V2,
  UNREAD_SEAT,
  capacity,
  nativeSeat,
} from './seat-fixtures.test-support.js';

function bootstrap(seats: VerseSeat[]): VerseBootstrap {
  return {
    seats,
    projects: [],
    sessions: [],
    dispatchEnabled: true,
    localRuntime: { ollama: { reachable: true, baseUrl: 'http://127.0.0.1:11434', models: ['qwen3-coder'] } },
  };
}

function mount(seats: VerseSeat[]) {
  return render(
    <ResourcesPanel bootstrap={bootstrap(seats)} sessions={[]} current={null}
      onStop={() => {}} onOpen={() => {}} onClose={() => {}} />,
  );
}

const panel = () => screen.getByRole('complementary', { name: 'Resources' });

beforeEach(() => {
  evictAll();
  // The panel subscribes to the bootstrap query for the refreshing signal.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(bootstrap([])), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
});

describe('ResourcesPanel — the seat rows', () => {
  it('leads with the plan and the BINDING window, not the roomiest one', () => {
    mount([CLAUDE_TIGHT_SEAT]);
    expect(within(panel()).getByText('max')).toBeInTheDocument();

    // The per-model week is the constraint; 85% all-models would have been the
    // comforting number to lead with.
    const binding = within(panel()).getByRole('meter', { name: 'Claude Max weekly fable window used' });
    expect(binding).toHaveAttribute('aria-valuenow', '92');
    expect(within(panel()).getByText('92%')).toBeInTheDocument();

    // All three windows exist — the other two sit inside the collapsed
    // disclosure, reachable without leaving the screen.
    expect(within(panel()).getAllByRole('meter')).toHaveLength(3);
  });

  it('renders a prose reset verbatim instead of collapsing it to a clock time', () => {
    mount([CLAUDE_TIGHT_SEAT]);
    expect(screen.getAllByText('resets Sep 25 at 7pm (America/New_York)').length).toBeGreaterThan(0);
  });

  it('keeps the other two windows one disclosure away, not one navigation away', async () => {
    const user = userEvent.setup();
    mount([CLAUDE_TIGHT_SEAT]);
    await user.click(within(panel()).getByText('2 more windows'));
    expect(within(panel()).getByRole('meter', { name: 'Claude Max 5-hour window used' })).toHaveAttribute('aria-valuenow', '15');
    expect(within(panel()).getByRole('meter', { name: 'Claude Max weekly window used' })).toHaveAttribute('aria-valuenow', '85');
  });

  it('says "limit reached" for a flagged window and prints no percentage for it', () => {
    mount([CLAUDE_MAX_SEAT]);
    expect(within(panel()).getByText('limit reached')).toBeInTheDocument();
    expect(within(panel()).queryByText('100%')).not.toBeInTheDocument();
    expect(within(panel()).getByText('blocked')).toBeInTheDocument();
  });

  it('reports a spent Codex week with spendable credits as tight, and shows both facts', () => {
    mount([CODEX_CREDITS_SEAT]);
    expect(within(panel()).getByText('tight')).toBeInTheDocument();
    expect(within(panel()).getByText('limit reached')).toBeInTheDocument();
    expect(within(panel()).getByText('2048.42 credits left')).toBeInTheDocument();
    expect(within(panel()).getByText('pro')).toBeInTheDocument();
  });

  it('draws no meter at all for an account nothing was read from', () => {
    mount([UNREAD_SEAT]);
    // Never a 0% bar: an empty meter reads "plenty left".
    expect(within(panel()).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(panel()).getByText('no capacity reading')).toBeInTheDocument();
    // The provider's own explanation is shown rather than swallowed.
    expect(within(panel()).getByText('No probe has run for this account yet in this server.')).toBeInTheDocument();
  });

  it('gives a local seat its readiness and no subscription, quota or bill', () => {
    mount([LOCAL_SEAT_V2]);
    expect(within(panel()).getByText('Qwen3 Coder (local)')).toBeInTheDocument();
    expect(within(panel()).getByText('runs on this machine')).toBeInTheDocument();
    expect(within(panel()).queryByRole('meter')).not.toBeInTheDocument();
  });
});

describe('ResourcesPanel — freshness and provenance', () => {
  it('says when the reading was taken, and offers to take a new one', () => {
    mount([CLAUDE_TIGHT_SEAT]);
    expect(within(panel()).getByText(/^as of /)).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('says so plainly when no seat has been observed yet, rather than implying now', () => {
    mount([UNREAD_SEAT]);
    expect(within(panel()).getByText('no reading yet')).toBeInTheDocument();
  });

  it('never presents another process’s shared evidence as a live probe', () => {
    mount([nativeSeat(capacity({ usability: 'unknown', evidenceSource: 'shared-evidence' }))]);
    expect(within(panel()).getByText(/not probed here/)).toBeInTheDocument();
  });

  it('adds no provenance line when the reading came from this server’s collector', () => {
    mount([CLAUDE_TIGHT_SEAT]);
    expect(within(panel()).queryByText(/not probed here/)).not.toBeInTheDocument();
    expect(within(panel()).queryByText(/not a live reading/)).not.toBeInTheDocument();
  });

  it('re-reads the roster when Refresh is pressed', async () => {
    const user = userEvent.setup();
    mount([CLAUDE_TIGHT_SEAT]);
    const mock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    const before = mock.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mock.mock.calls.length).toBeGreaterThan(before);
  });
});
