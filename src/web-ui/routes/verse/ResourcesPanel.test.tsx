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
import type { VerseBootstrap, VerseEvent, VerseSeat, VerseSession } from '../../data/api-types.js';
import { evictAll } from '../../data/cache.js';
import { ResourcesPanel } from './ResourcesPanel.js';
import { RESOURCES_COLLAPSE_KEY } from './resources-collapse.js';
import { WINDOW_SOURCE_TEXT } from './verse-model.js';
import {
  CLAUDE_CONTEXT_SEAT,
  CLAUDE_MAX_SEAT,
  CLAUDE_SKEW_NOTE,
  CLAUDE_TIGHT_SEAT,
  CODEX_CONTEXT_SEAT,
  CODEX_CREDITS_SEAT,
  GROK_SEAT,
  LOCAL_CONTEXT_SEAT,
  LOCAL_SEAT_V2,
  UNREAD_SEAT,
  capacity,
  nativeSeat,
  seatWindow,
} from './seat-fixtures.test-support.js';

/**
 * MemoryPanel is U9's, with its own reads and token gate. Stubbed so these
 * tests pin only what this panel owns: that it is mounted, for which project,
 * and with which refresh key.
 */
vi.mock('./context/MemoryPanel.js', async () => {
  const { createElement } = await import('react');
  return {
    MemoryPanel: ({ projectPath, refreshKey }: { projectPath: string | null; refreshKey?: number | string }) =>
      createElement('section', {
        'aria-label': 'Project memory',
        'data-project': projectPath ?? '',
        'data-refresh': String(refreshKey ?? ''),
      }),
  };
});

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

// ---------------------------------------------------------------------------
// V3.9 — context
// ---------------------------------------------------------------------------

function chat(over: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'vs_ctx',
    title: 'Refactor the queue',
    projectPath: '/Users/mason/dev/hub',
    engine: 'claude',
    accountId: 'claude-a',
    seatId: 'claude-a',
    model: 'claude-fable-5-1',
    nativeSessionId: 'uuid-1',
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: new Date().toISOString(),
    status: 'idle',
    turnCount: 3,
    usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 8_000, cacheCreationTokens: 1_000, contextTokens: 142_000, contextWindow: 1_000_000 },
    lastError: null,
    ...over,
  };
}

let seq = 0;
function usageEvent(turnId: string, contextTokens: number, exact = true): VerseEvent {
  seq += 1;
  return {
    seq,
    at: '2026-09-23T10:00:00.000Z',
    type: 'usage',
    turnId,
    usage: {
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheCreationTokens: 0, contextTokens, contextWindow: null,
      ...(exact ? {} : { contextTokensExact: false }),
    },
  };
}

function mountChat(current: VerseSession, events: VerseEvent[] = [], seats: VerseSeat[] = [CLAUDE_CONTEXT_SEAT, CODEX_CONTEXT_SEAT, LOCAL_CONTEXT_SEAT]) {
  return render(
    <ResourcesPanel bootstrap={bootstrap(seats)} sessions={[current]} current={current} events={events}
      onStop={() => {}} onOpen={() => {}} onClose={() => {}} />,
  );
}

/** The value beside a label in one of the panel's <dl> grids. */
function stat(label: string, scope: HTMLElement = panel()): string {
  const dt = within(scope).getByText(label, { selector: 'dt' });
  return dt.nextElementSibling?.textContent ?? '';
}

describe('ResourcesPanel — seat context facts', () => {
  it('names the pinned CLI, leads with the seat’s own notes, and counts unavailable models', () => {
    mount([CLAUDE_CONTEXT_SEAT]);
    const row = within(panel()).getByRole('button', { name: 'Claude Max' }).closest('li')!;
    expect(within(row).getByText('Claude Code 2.1.257')).toBeInTheDocument();
    expect(within(row).getByText('3 models, 1 unavailable')).toBeInTheDocument();
    expect(within(row).getByText('1M ctx')).toBeInTheDocument();
    const notes = within(row).getAllByRole('listitem').map((li) => li.textContent);
    expect(notes[0]).toBe(CLAUDE_SKEW_NOTE);
  });

  it('adds nothing for a seat with no pinned version and no notes', () => {
    mount([LOCAL_SEAT_V2]);
    expect(within(panel()).queryByText(/Claude Code \d/)).not.toBeInTheDocument();
    expect(within(panel()).getByText('1 model')).toBeInTheDocument();
  });
});

describe('ResourcesPanel — this chat’s context and efficiency', () => {
  it('reads the window through the meter’s precedence and says where it came from', () => {
    // Stored at a stale creation-time 200k; the seat's catalog says 1M.
    mountChat(chat({ usage: { ...chat().usage, contextWindow: 200_000 } }));
    expect(stat('Context')).toBe('142k / 1M');
    expect(stat('Compacts at')).toBe('≈367k');
    expect(stat('Mode')).toBe('Standard');
    expect(within(panel()).getByText(`Window ${WINDOW_SOURCE_TEXT['cli-catalog']}.`)).toBeInTheDocument();
  });

  it('prefers a window the CLI reported at runtime', () => {
    mountChat(chat({ usage: { ...chat().usage, contextWindow: 200_000, contextWindowSource: 'runtime', autoCompactAt: 167_000 } }));
    expect(stat('Context')).toBe('142k / 200k');
    expect(stat('Compacts at')).toBe('≈167k');
    expect(within(panel()).getByText(`Window ${WINDOW_SOURCE_TEXT.runtime}.`)).toBeInTheDocument();
  });

  it('claims no provenance for a stored window that never recorded one', () => {
    // The seat no longer lists the model; the record predates window sources.
    mountChat(chat({ model: 'claude-retired-1', usage: { ...chat().usage, contextWindow: 200_000 } }));
    expect(stat('Context')).toBe('142k / 200k');
    expect(within(panel()).getByText('Window as stored when this chat was created; how it was known was not recorded.')).toBeInTheDocument();
  });

  it('shows cache hit, compactions and per-turn context from the chat’s own log', () => {
    mountChat(
      chat({ contextMode: 'expansive', compactionCount: 2 }),
      [usageEvent('t1', 40_000), usageEvent('t2', 90_000), usageEvent('t3', 20_000)],
    );
    const efficiency = within(panel()).getByLabelText('Context efficiency');
    expect(stat('Cache hit', efficiency)).toBe('80%');
    expect(stat('Compactions', efficiency)).toBe('2');
    expect(stat('Avg context / turn', efficiency)).toBe('50k');
    expect(stat('Peak context', efficiency)).toBe('90k');
    expect(stat('Mode', efficiency)).toBe('Expansive');
    expect(stat('Compacts at', efficiency)).toBe('≈967k');
  });

  it('marks codex’s turn total as an upper bound instead of a measurement', () => {
    mountChat(
      chat({ seatId: 'codex-b', engine: 'codex', model: 'gpt-6-astra', usage: { ...chat().usage, contextTokens: 2_800_000, contextTokensExact: false } }),
      [usageEvent('t1', 2_800_000, false)],
    );
    expect(stat('Context')).toBe('≤2.8M / 258k');
    expect(stat('Peak context')).toBe('≤2.8M');
    expect(within(panel()).getByText(/Figures marked ≤ are upper bounds/)).toBeInTheDocument();
  });

  it('says "none reported" for a provider that reported no cache activity, never 0%', () => {
    mountChat(chat({
      seatId: LOCAL_CONTEXT_SEAT.id, engine: 'local', model: 'qwen3.8:27b-ctx64k',
      usage: { inputTokens: 40_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 30_000, contextWindow: 65_536 },
    }));
    expect(stat('Cache hit')).toBe('none reported');
    expect(within(panel()).queryByText('0%')).not.toBeInTheDocument();
    // No log loaded: per-turn figures are unknown, not zero.
    expect(stat('Avg context / turn')).toBe('—');
  });

  /** The last provider contact is a turn's `turn-done`, not the record's updatedAt. */
  const lastTurnAgo = (ms: number): VerseEvent[] => [
    { seq: 1, at: new Date(Date.now() - ms).toISOString(), type: 'turn-done', turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1 },
  ];

  it('warns once the chat has sat idle past the prompt-cache lifetime', () => {
    mountChat(chat({ updatedAt: new Date(Date.now() - 61 * 60_000).toISOString() }), lastTurnAgo(61 * 60_000));
    expect(within(panel()).getByRole('status')).toHaveTextContent(/Idle for 1h 1m, past the ~1 h prompt-cache lifetime: the next turn likely re-reads ~142k tokens uncached/);
  });

  it('times idleness from the last turn: a rename moments ago does not silence the warning', () => {
    mountChat(chat({ updatedAt: new Date(Date.now() - 60_000).toISOString() }), lastTurnAgo(90 * 60_000));
    expect(within(panel()).getByRole('status')).toHaveTextContent(/prompt-cache lifetime/);
  });

  it('does not warn before the cache would have expired, or when no turn has run', () => {
    mountChat(chat({ updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() }), lastTurnAgo(30 * 60_000));
    expect(within(panel()).queryByText(/prompt-cache lifetime/)).not.toBeInTheDocument();
  });

  it('words a local chat’s idle cost as time, not spend', () => {
    mountChat(chat({
      seatId: LOCAL_CONTEXT_SEAT.id, engine: 'local', model: 'qwen3.8:27b-ctx64k',
      updatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      usage: { inputTokens: 40_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 40_000, contextWindow: 65_536 },
    }), lastTurnAgo(2 * 60 * 60_000));
    expect(within(panel()).getByText(/time, not spend/)).toBeInTheDocument();
  });

  it('says whether this chat was given shared memory, and mounts the project’s memory panel', () => {
    mountChat(chat({ memoryEnabled: true, turnCount: 7 }));
    // A paid seat: the sentence says what memory adds to every turn, never that it is free.
    const given = within(panel()).getByText(/^Shared project memory was given to this chat’s agent when it started:/);
    expect(given).toHaveTextContent(/a block of up to 6 KB in its system prompt, re-sent every turn \(cached after the first\)/);
    expect(given).toHaveTextContent(/this seat’s usage/);
    const memory = within(panel()).getByRole('region', { name: 'Project memory' });
    expect(memory).toHaveAttribute('data-project', '/Users/mason/dev/hub');
    expect(memory).toHaveAttribute('data-refresh', '7');
  });

  it('adds no usage caveat for memory on a local chat — it spends nothing there', () => {
    mountChat(chat({ memoryEnabled: true, seatId: LOCAL_CONTEXT_SEAT.id, engine: 'local', model: 'qwen3.8:27b-ctx64k' }));
    expect(within(panel()).getByText('Shared project memory was given to this chat’s agent when it started.')).toBeInTheDocument();
  });

  it('says so when a chat started without memory, and mounts the panel with no project when no chat is open', () => {
    const { unmount } = mountChat(chat());
    expect(within(panel()).getByText('This chat started without shared project memory.')).toBeInTheDocument();
    unmount();
    mount([CLAUDE_CONTEXT_SEAT]);
    expect(within(panel()).getByRole('region', { name: 'Project memory' })).toHaveAttribute('data-project', '');
  });
});
