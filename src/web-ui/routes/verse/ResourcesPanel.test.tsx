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
import { RESOURCES_COLLAPSE_KEY } from './resources-collapse.js';
import {
  CLAUDE_MAX_SEAT,
  CLAUDE_TIGHT_SEAT,
  CODEX_CREDITS_SEAT,
  GROK_SEAT,
  LOCAL_SEAT_V2,
  UNREAD_SEAT,
  capacity,
  nativeSeat,
  seatWindow,
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
  localStorage.clear();
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

    // All three windows the Claude probe reports — session, weekly, and the
    // per-model week — are bars, not one bar and a disclosure.
    const meters = within(panel()).getAllByRole('meter');
    expect(meters.map((meter) => meter.getAttribute('aria-label'))).toEqual([
      'Claude Max weekly fable window used',
      'Claude Max 5-hour window used',
      'Claude Max weekly window used',
    ]);
  });

  it('renders a prose reset verbatim instead of collapsing it to a clock time', () => {
    mount([CLAUDE_TIGHT_SEAT]);
    // The weekly windows share a reset; the 5-hour window has its own.
    expect(screen.getAllByText('resets Sep 25 at 7pm (America/New_York)')).toHaveLength(2);
    expect(screen.getByText('resets Sep 21 at 1:40am (America/New_York)')).toBeInTheDocument();
  });

  it('shows each reported limit as its own bar and does not invent one the probe omitted', () => {
    const hour = CLAUDE_TIGHT_SEAT.capacity!.windows[0]!;
    const week = CLAUDE_TIGHT_SEAT.capacity!.windows[1]!;
    mount([nativeSeat(capacity({
      planType: 'max',
      windows: [hour, week],
      binding: week,
      usability: 'tight',
      observedAt: '2026-09-20T18:32:00.000Z',
    }))]);
    expect(within(panel()).queryByText(/more window/)).not.toBeInTheDocument();
    expect(within(panel()).getAllByRole('meter')).toHaveLength(2);
    expect(within(panel()).queryByRole('meter', { name: /fable/ })).not.toBeInTheDocument();
    expect(within(panel()).queryByText(/fable/)).not.toBeInTheDocument();
  });

  it('says a reported limit was not measured instead of drawing an empty bar', () => {
    const hour = CLAUDE_TIGHT_SEAT.capacity!.windows[0]!;
    mount([nativeSeat(capacity({
      planType: 'max',
      windows: [hour, seatWindow({ id: 'seven_day_fable', usedPercent: null, measured: false })],
      binding: hour,
      usability: 'ready',
      observedAt: '2026-09-20T18:32:00.000Z',
    }))]);
    expect(within(panel()).getAllByRole('meter')).toHaveLength(1);
    expect(within(panel()).getByText('weekly fable window')).toBeInTheDocument();
    expect(within(panel()).getByText('no reading')).toBeInTheDocument();
  });

  it('says "limit reached" for a flagged window and prints no percentage for it', async () => {
    const user = userEvent.setup();
    mount([CLAUDE_MAX_SEAT]);
    // Exhausted seats start collapsed. The verdict is visible; the bars are not.
    expect(within(panel()).getByText('blocked')).toBeInTheDocument();
    expect(within(panel()).queryByRole('meter')).not.toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Claude Max' }));
    expect(within(panel()).getByText('limit reached')).toBeInTheDocument();
    expect(within(panel()).queryByText('100%')).not.toBeInTheDocument();
    expect(within(panel()).getAllByRole('meter')).toHaveLength(3);
  });

  it('reports a spent Codex week with spendable credits as tight, and shows both facts', () => {
    mount([CODEX_CREDITS_SEAT]);
    expect(within(panel()).getByText('tight')).toBeInTheDocument();
    expect(within(panel()).getByText('limit reached')).toBeInTheDocument();
    expect(within(panel()).getByText('2048.42 credits left')).toBeInTheDocument();
    expect(within(panel()).getByText('pro')).toBeInTheDocument();
    // The probe reported one window. Credits are not a second bar, and an
    // absent secondary window is not invented.
    expect(within(panel()).getAllByRole('meter')).toHaveLength(1);
    expect(within(panel()).queryByRole('meter', { name: /secondary/ })).not.toBeInTheDocument();
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

describe('ResourcesPanel — collapsing what cannot be used', () => {
  it('starts a blocked seat shut and a usable one open, per provider group', () => {
    mount([CLAUDE_MAX_SEAT, CODEX_CREDITS_SEAT, GROK_SEAT, LOCAL_SEAT_V2]);
    expect(within(panel()).getByRole('button', { name: 'Claude seats' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel()).getByRole('button', { name: 'Codex seats' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel()).getByRole('button', { name: 'Grok seats' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel()).getByRole('button', { name: 'Local seats' })).toHaveAttribute('aria-expanded', 'true');

    expect(within(panel()).getByRole('button', { name: 'Claude Max' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel()).queryByRole('meter', { name: /Claude Max/ })).not.toBeInTheDocument();
    // Grok reported exactly one window. It is open because it is usable.
    expect(within(panel()).getByRole('meter', { name: 'Grok unified weekly window used' })).toHaveAttribute('aria-valuenow', '1');
    expect(within(panel()).getAllByRole('meter', { name: /Grok/ })).toHaveLength(1);
  });

  it('remembers an opened spent seat and a collapsed group across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = mount([CLAUDE_MAX_SEAT, CODEX_CREDITS_SEAT]);
    await user.click(within(panel()).getByRole('button', { name: 'Claude Max' }));
    expect(within(panel()).getByRole('meter', { name: /weekly fable/ })).toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Codex seats' }));
    expect(within(panel()).queryByText('Personal Codex')).not.toBeInTheDocument();
    unmount();

    mount([CLAUDE_MAX_SEAT, CODEX_CREDITS_SEAT]);
    expect(within(panel()).getByRole('button', { name: 'Claude Max' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel()).getByRole('meter', { name: /weekly fable/ })).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Codex seats' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel()).queryByText('Personal Codex')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(RESOURCES_COLLAPSE_KEY) ?? '{}')).toMatchObject({
      collapsedGroups: ['codex'],
      seats: { claude: true },
    });
  });

  it('does not let Refresh close a seat the operator opened', async () => {
    const user = userEvent.setup();
    mount([CLAUDE_MAX_SEAT]);
    await user.click(within(panel()).getByRole('button', { name: 'Claude Max' }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(within(panel()).getByRole('button', { name: 'Claude Max' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel()).getByText('limit reached')).toBeInTheDocument();
  });
});

describe('ResourcesPanel — the seat row after the title sweep', () => {
  /**
   * THE REGRESSION A CARELESS title -> Tooltip SWEEP CAUSES. The seat toggle
   * is an expandable control whose accessible name is its aria-label; the
   * subscription sentence that used to hang off a `title` on the inner label
   * span is a DESCRIPTION. If the sweep ever lets the tooltip supply the name
   * instead, every seat in this list becomes "Claude Max Max plan tight ..."
   * to a screen reader, and the list stops being navigable by name.
   */
  it('keeps the seat toggle named by its label, not by its tooltip', async () => {
    const user = userEvent.setup();
    mount([CLAUDE_TIGHT_SEAT]);
    const toggle = within(panel()).getByRole('button', { name: 'Claude Max' });
    expect(toggle).toHaveAccessibleName('Claude Max');
    expect(toggle).not.toHaveAttribute('title');

    // The sentence is still reachable — and now on keyboard focus too, which
    // a native `title` never managed.
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.hover(toggle);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Claude Max');
    // Naming is unchanged by the tooltip being open.
    expect(toggle).toHaveAccessibleName('Claude Max');
  });

  it('does not repeat the same sentence on the capacity chip beside it', async () => {
    const user = userEvent.setup();
    mount([CLAUDE_TIGHT_SEAT]);
    const toggle = within(panel()).getByRole('button', { name: 'Claude Max' });
    await user.hover(toggle);
    // One row, one tooltip. It used to be on the label span AND the chip.
    // findAll, not getAll: the tooltip opens after a delay and portals on open.
    expect(await screen.findAllByRole('tooltip')).toHaveLength(1);
  });
});
