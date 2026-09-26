import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatDecision, SeatHeadroom } from '../../../../core/routing/types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN } from '../context/context-fixtures.test-support.js';
import { BudgetControl, BudgetControlView, BUDGET_COMMIT_DELAY_MS } from './BudgetControl.js';
import { buildBudgetRows, budgetSummary, clampPercent, readingAge } from './budget-model.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
/** Literal en-US words are pinned only under that default locale; elsewhere the formatter's own output is. */
const EN_US = new Intl.DateTimeFormat().resolvedOptions().locale === 'en-US';

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

  it('prints the router\u2019s reasons verbatim except for a raw ISO instant and a ".;" join', () => {
    const at = new Date(2026, 8, 26, 23, 46); // local, so the words hold in any zone
    const now = new Date(2026, 8, 25, 12, 0).getTime();
    const rows = buildBudgetRows(view({
      headroom: [headroom('claude', { reasons: [
        `Weekly window at 100% (resets ${at.toISOString()}).; Autonomy waits for the reset.`,
      ] })],
    }), now);
    // The shared reset wording in the default locale — "Sat 11:46 PM" under en-US.
    expect(rows[0]!.why).toBe(`Weekly window at 100% (resets ${describeResetAt(at.toISOString(), now)}); Autonomy waits for the reset.`);
    if (EN_US) expect(rows[0]!.why).toBe('Weekly window at 100% (resets Sat 11:46 PM); Autonomy waits for the reset.');
    expect(rows[0]!.why).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
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
  it('says a missing reading time plainly, localises the next-task reason, and gives a truncating name its tooltip', () => {
    const at = new Date(2026, 8, 26, 23, 46);
    const nowMs = new Date(2026, 8, 25, 12, 0).getTime();
    renderView({
      view: view({ sampledAt: 'x' }),
      preview: { ...PREVIEW, why: `Claude is held back until ${at.toISOString()}.` },
      nowMs,
    });
    expect(screen.getByText('Reading time not reported')).toBeInTheDocument();
    expect(screen.queryByText(/Readings unknown/)).not.toBeInTheDocument();
    expect(screen.getByText(`Claude is held back until ${describeResetAt(at.toISOString(), nowMs)}.`)).toBeInTheDocument();
    if (EN_US) expect(describeResetAt(at.toISOString(), nowMs)).toBe('Sat 11:46 PM');
    expect(screen.getByText('Personal Codex')).toHaveAttribute('title', 'Personal Codex');
  });

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

  it('a grant ceiling disables the modes above it, with the reason; lowering stays one keystroke', async () => {
    const user = userEvent.setup();
    const { onMode } = renderView({ maxMode: 'balanced' });
    const allIn = screen.getByRole('radio', { name: 'All-in — above your grant' });
    expect(allIn).toBeDisabled();
    expect(screen.getByText('Your grant allows up to Balanced; modes above it are off. Re-approve the grant to raise it.')).toBeInTheDocument();
    // Arrow keys skip the disabled mode; toward Reserve is always allowed.
    screen.getByRole('radio', { name: 'Balanced' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onMode).not.toHaveBeenCalledWith('all-in');
    await user.click(screen.getByRole('radio', { name: 'Reserve' }));
    expect(onMode).toHaveBeenCalledWith('reserve');
  });

  it('a mode already above a lowered ceiling says what autonomy actually spends', () => {
    renderView({ view: view({ mode: 'all-in' }), maxMode: 'reserve' });
    expect(screen.getByText('Your grant allows up to Reserve, so autonomy spends as Reserve until this moves down.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Balanced — above your grant' })).toBeDisabled();
  });

  it('no grant ceiling: every mode is selectable and no ceiling line is shown', () => {
    renderView({ maxMode: null });
    expect(screen.getByRole('radio', { name: 'All-in' })).toBeEnabled();
    expect(screen.queryByText(/Your grant allows/)).toBeNull();
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

  it('drops a seat with a garbled policy instead of calling it "off"', () => {
    const garbled = view();
    (garbled.effective as Record<string, unknown>)['grok'] = { enabled: 'yes' };
    renderView({ view: garbled });
    expect(screen.queryByText('Grok')).toBeNull();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
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

  // Apps' "Edit budget" sheet used to crash here: buildBudgetRows was handed
  // the raw answer and threw on `{}` (no seatInfo / headroom arrays).
  it('a malformed budget answer renders the empty panel instead of crashing', async () => {
    installFetch((call) => {
      if (call.path === '/api/verse/budget' && call.method === 'GET') return json({});
      if (call.path.startsWith('/api/verse/budget/preview')) return json({});
      return json({ error: 'not found' }, 404);
    });
    render(<BudgetControl />);
    expect(await screen.findByRole('heading', { name: 'Budget' })).toBeInTheDocument();
    expect(screen.getByText(/No seats yet/)).toBeInTheDocument();
    expect(screen.getByText('The server did not say which mode is on.')).toBeInTheDocument();
    for (const option of screen.getAllByRole('radio')) expect(option).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/whose reading is stale/)).toBeInTheDocument();
  });

  it('a failed read says so instead of rendering empty bars', async () => {
    installFetch(() => json({ error: 'boom' }, 500));
    render(<BudgetControl />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Budget unavailable/);
  });

  // budget-api.ts answers a read it could not make with 503 { code, error };
  // the panel used to print "GET /api/verse/budget failed (HTTP 503)." — a
  // URL, not a cause.
  it('a failed read shows the server’s reason, not the request URL', async () => {
    installFetch(() => json({
      code: 'VERSE_STORE_UNREADABLE',
      error: 'The budget policy file is not valid JSON. Fix or remove it to use the defaults.',
    }, 503));
    render(<BudgetControl />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Budget unavailable. The budget policy file is not valid JSON. Fix or remove it to use the defaults.');
    expect(alert).not.toHaveTextContent(/HTTP|\/api\//);
  });

  it('a refresh that fails keeps the last readings AND says they are old, with the reason', async () => {
    let failing = false;
    installFetch((call) => {
      if (failing && call.path === '/api/verse/budget') {
        return json({ code: 'VERSE_BUDGET_CAPACITY_UNREADABLE', error: 'Seat capacity could not be read.' }, 503);
      }
      if (call.path === '/api/verse/budget' && call.method === 'GET') return json(view());
      if (call.path.startsWith('/api/verse/budget/preview')) return json(PREVIEW);
      return json({ error: 'not found' }, 404);
    });
    render(<BudgetControl />);
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.queryByText(/Showing the last readings/)).toBeNull();
    failing = true;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    const notice = await screen.findByText(/Showing the last readings/);
    expect(notice).toHaveTextContent('Showing the last readings. Seat capacity could not be read.');
    // The bars are still there — a failed refresh is not "no seats".
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });
});
