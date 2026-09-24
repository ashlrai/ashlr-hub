import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatDecision, SeatHeadroom } from '../../../../core/routing/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN } from '../context/context-fixtures.test-support.js';
import { BudgetControl, BudgetControlView, BUDGET_COMMIT_DELAY_MS } from './BudgetControl.js';
import { buildBudgetRows, budgetSummary, clampPercent, readingAge } from './budget-model.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function headroom(seatId: string, patch: Partial<SeatHeadroom> = {}): SeatHeadroom {
  return {
    seatId,
    sessionUsedPercent: null,
    weeklyUsedPercent: null,
    bindingWindow: null,
    autonomyHeadroomPercent: null,
    resetAt: null,
    eligibleForAutonomy: false,
    reasons: [],
    ...patch,
  };
}

function view(patch: Partial<BudgetView> = {}): BudgetView {
  return {
    mode: 'balanced',
    seats: {},
    updatedAt: new Date(0).toISOString(),
    sampledAt: new Date(NOW - 30_000).toISOString(),
    readingMaxAgeMs: 15 * 60_000,
    seatInfo: [
      { seatId: 'claude', label: 'Claude Code', engine: 'claude', free: false },
      { seatId: 'codex-personal', label: 'Personal Codex', engine: 'codex', free: false },
      { seatId: 'grok', label: 'Grok', engine: 'grok', free: false },
      { seatId: 'local:qwen', label: 'Qwen (local)', engine: 'local', free: true },
    ],
    effective: {
      claude: { seatId: 'claude', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 },
      'codex-personal': { seatId: 'codex-personal', enabled: false, reservePercent: 40, maxSessionWindowPercent: 70 },
      grok: { seatId: 'grok', enabled: true, reservePercent: 0 },
      'local:qwen': { seatId: 'local:qwen', enabled: true, reservePercent: 0 },
    },
    headroom: [
      headroom('claude', {
        sessionUsedPercent: 15, weeklyUsedPercent: 20, bindingWindow: 'weekly', autonomyHeadroomPercent: 40,
        eligibleForAutonomy: true,
        reasons: ['40% of the weekly window is left for autonomy (40% kept for you).',
          'The Fable-only weekly window is spent — it limits that model only, not the account.'],
      }),
      headroom('codex-personal', { reasons: ['Autonomy is switched off for this seat.'] }),
      headroom('grok', { reasons: ['No usage reading for this seat — unknown usage is not headroom, so autonomy stays off it.'] }),
      headroom('local:qwen', { autonomyHeadroomPercent: 100, eligibleForAutonomy: true, reasons: ['Local model — free, with no usage window to protect.'] }),
    ],
    ...patch,
  };
}

const PREVIEW: SeatDecision = {
  seatId: 'local:qwen',
  candidates: ['local:qwen', 'claude'],
  exclusions: [],
  why: 'Routed autonomous medium-difficulty code work to Qwen (local) (local:qwen) at no cost: balanced mode prefers local models first for this work.',
  mode: 'balanced',
};

function renderView(overrides: Partial<Parameters<typeof BudgetControlView>[0]> = {}) {
  const onMode = vi.fn();
  const onSeat = vi.fn();
  render(<BudgetControlView view={view()} preview={PREVIEW} nowMs={NOW} pending={null} error={null}
    onMode={onMode} onSeat={onSeat} {...overrides} />);
  return { onMode, onSeat };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearMutationToken();
  evictAll();
});

describe('budget-model', () => {
  it('derives a word verdict per seat — never colour alone — and keeps server order', () => {
    const rows = buildBudgetRows(view());
    expect(rows.map((r) => [r.seatId, r.status])).toEqual([
      ['claude', 'eligible'], ['codex-personal', 'off'], ['grok', 'unknown'], ['local:qwen', 'eligible'],
    ]);
    expect(rows[0]!.why).toBe('40% of the weekly window is left for autonomy (40% kept for you).');
    expect(rows[0]!.more).toHaveLength(1);
  });

  it('draws the weekly bar against the reserve and the 5-hour bar against its ceiling', () => {
    const [claude] = buildBudgetRows(view());
    expect(claude!.bars).toEqual([
      expect.objectContaining({ kind: 'weekly', usedPercent: 20, ceilingPercent: 60, binding: true }),
      expect.objectContaining({ kind: 'session', usedPercent: 15, ceilingPercent: 70, binding: false }),
    ]);
    expect(claude!.bars[0]!.description).toBe('Weekly window 20% used; autonomy stops at 60%, 40% kept for you.');
  });

  it('an unread window is null, not zero; a local seat has no bars', () => {
    const rows = buildBudgetRows(view());
    const grok = rows.find((r) => r.seatId === 'grok')!;
    expect(grok.bars).toEqual([expect.objectContaining({ kind: 'weekly', label: 'Billing period', usedPercent: null })]);
    expect(rows.find((r) => r.free)!.bars).toEqual([]);
  });

  it('summarises and ages honestly', () => {
    expect(budgetSummary(buildBudgetRows(view())).sentence).toBe('2 of 4 seats can take autonomous work (1 paid, 1 local).');
    expect(budgetSummary([]).sentence).toBe('No seats are known yet.');
    expect(readingAge(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now');
    expect(readingAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago');
    expect(readingAge('garbage', NOW)).toBe('unknown');
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN, 10)).toBe(10);
  });
});

describe('BudgetControlView', () => {
  it('shows the mode, the summary, the next-task line and every seat with its why', () => {
    renderView();
    expect(screen.getByRole('heading', { name: 'Budget' })).toBeInTheDocument();
    expect(screen.getByText('2 of 4 seats can take autonomous work (1 paid, 1 local).')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Balanced' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Autonomy stops at each seat’s reserve/)).toBeInTheDocument();
    expect(screen.getByText('Next medium task →')).toBeInTheDocument();
    expect(screen.getByText('Qwen (local)', { selector: 'strong' })).toBeInTheDocument();
    const claude = screen.getByRole('listitem', { name: 'Claude Code' });
    expect(within(claude).getByText('Eligible')).toBeInTheDocument();
    expect(within(claude).getByText('20% used · stops at 60%')).toBeInTheDocument();
    expect(within(claude).getByText('15% used · stops at 70%')).toBeInTheDocument();
    expect(within(claude).getByRole('img', { name: 'Weekly window 20% used; autonomy stops at 60%, 40% kept for you.' })).toBeInTheDocument();
    expect(within(claude).getByText('1 more note')).toBeInTheDocument();
  });

  it('renders an unread window as "no reading", never as a bar', () => {
    renderView();
    const grok = screen.getByRole('listitem', { name: 'Grok' });
    expect(within(grok).getByText('No reading')).toBeInTheDocument();
    expect(within(grok).getByText('no reading')).toBeInTheDocument();
    expect(within(grok).getByRole('img', { name: 'Weekly window: no reading.' })).toBeInTheDocument();
    expect(within(grok).queryByText(/% used/)).toBeNull();
  });

  it('a switched-off seat hides its reserve controls and can be switched on', async () => {
    const user = userEvent.setup();
    const { onSeat } = renderView();
    const codex = screen.getByRole('listitem', { name: 'Personal Codex' });
    expect(within(codex).getByText('Off')).toBeInTheDocument();
    expect(within(codex).queryByRole('slider')).toBeNull();
    await user.click(within(codex).getByRole('switch', { name: 'Autonomy on Personal Codex' }));
    expect(onSeat).toHaveBeenCalledWith('codex-personal', { enabled: true });
  });

  it('local seats say they are free and offer only the on/off switch', () => {
    renderView();
    const local = screen.getByRole('listitem', { name: 'Qwen (local)' });
    expect(within(local).getByText(/local models cost nothing/)).toBeInTheDocument();
    expect(within(local).queryByRole('slider')).toBeNull();
    expect(within(local).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('switching mode calls onMode once; re-selecting the current mode does nothing', async () => {
    const user = userEvent.setup();
    const { onMode } = renderView();
    await user.click(screen.getByRole('radio', { name: 'Balanced' }));
    expect(onMode).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: 'Reserve' }));
    expect(onMode).toHaveBeenCalledWith('reserve');
  });

  it('slider moves are committed once, after the hand leaves them', () => {
    vi.useFakeTimers();
    const { onSeat } = renderView();
    const claude = screen.getByRole('listitem', { name: 'Claude Code' });
    const reserve = within(claude).getByRole('slider', { name: 'Kept for you' });
    fireEvent.change(reserve, { target: { value: '45' } });
    fireEvent.change(reserve, { target: { value: '50' } });
    expect(onSeat).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(BUDGET_COMMIT_DELAY_MS + 10); });
    expect(onSeat).toHaveBeenCalledTimes(1);
    expect(onSeat).toHaveBeenCalledWith('claude', { reservePercent: 50 });
  });

  it('dragging the 5-hour ceiling to 100 clears it (null), shown as "none"', () => {
    vi.useFakeTimers();
    const { onSeat } = renderView();
    const claude = screen.getByRole('listitem', { name: 'Claude Code' });
    const ceiling = within(claude).getByRole('slider', { name: '5-hour ceiling' });
    fireEvent.change(ceiling, { target: { value: '100' } });
    expect(within(claude).getByText('none')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(BUDGET_COMMIT_DELAY_MS + 10); });
    expect(onSeat).toHaveBeenCalledWith('claude', { maxSessionWindowPercent: null });
  });

  it('shows an error and disables every control while read-only or saving', () => {
    renderView({ error: 'This server is read-only.', readOnly: true });
    expect(screen.getByRole('alert')).toHaveTextContent('This server is read-only.');
    for (const control of screen.getAllByRole('switch')) expect(control).toBeDisabled();
    for (const option of screen.getAllByRole('radio')) expect(option).toBeDisabled();
  });

  it('says so when there are no seats', () => {
    renderView({ view: view({ seatInfo: [], headroom: [], effective: {} }), preview: null });
    expect(screen.getByText(/No seats yet/)).toBeInTheDocument();
    expect(screen.getByText('No seats are known yet.')).toBeInTheDocument();
  });
});

describe('BudgetControl (connected, real query layer)', () => {
  it('reads the budget and preview, then POSTs one change with the mutation token and shows the response', async () => {
    const user = userEvent.setup();
    setMutationToken(TEST_TOKEN);
    const after = view({ mode: 'reserve', sampledAt: new Date(Date.now()).toISOString() });
    const { calls } = installFetch((call) => {
      if (call.path === '/api/verse/budget' && call.method === 'GET') return json(view({ sampledAt: new Date(Date.now() - 60_000).toISOString() }));
      if (call.path.startsWith('/api/verse/budget/preview')) return json(PREVIEW);
      if (call.path === '/api/verse/budget' && call.method === 'POST') return json(after);
      return json({ error: 'not found' }, 404);
    });
    render(<BudgetControl />);
    expect(await screen.findByRole('heading', { name: 'Budget' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/verse/budget/preview?task=code&difficulty=medium&autonomous=true')).toBe(true);
    await user.click(screen.getByRole('radio', { name: 'Reserve' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Reserve' })).toHaveAttribute('aria-checked', 'true'));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ mode: 'reserve' });
    expect(post.headers['x-ashlr-token']).toBe(TEST_TOKEN);
  });

  it('a refused change shows the server’s sentence', async () => {
    const user = userEvent.setup();
    setMutationToken(TEST_TOKEN);
    installFetch((call) => {
      if (call.path === '/api/verse/budget' && call.method === 'GET') return json(view());
      if (call.path.startsWith('/api/verse/budget/preview')) return json(PREVIEW);
      return json({ code: 'VERSE_INVALID', error: 'mode must be one of: all-in, balanced, reserve' }, 400);
    });
    render(<BudgetControl />);
    await user.click(await screen.findByRole('radio', { name: 'All-in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('mode must be one of: all-in, balanced, reserve');
  });

  it('a failed read says so instead of rendering empty bars', async () => {
    installFetch(() => json({ error: 'boom' }, 500));
    render(<BudgetControl />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Budget unavailable/);
  });
});
