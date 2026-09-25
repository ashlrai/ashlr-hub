/**
 * AccountsGroup.test.tsx — the Accounts group as the operator reads it: every
 * account (Claude Code, both Codex accounts, Grok, local) leads with a status
 * — usable now, spent until a LOCAL reset time with a countdown, signed out
 * with Reconnect — says when it was last checked, lists usable accounts
 * first, and offers "Check again" where a fresh sweep is what would change it.
 *
 * Instants are built in local time so "Sat 11:46 PM" holds in any zone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { capacity, CLAUDE_TIGHT_SEAT, GROK_SEAT, LOCAL_SEAT_V2, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { AccountsGroup, ACCOUNTS_EMPTY_TEXT } from './AccountsGroup.js';

const TOKEN = 'test-token';
const NOW = new Date(2026, 8, 25, 16, 34).getTime(); // Fri Sep 25, 4:34 PM local
/** The literal en-US words are pinned only under that default locale; everywhere else the formatter's own output is. */
const EN_US = new Intl.DateTimeFormat().resolvedOptions().locale === 'en-US';
const RESET = new Date(2026, 8, 26, 23, 46).toISOString(); // Sat 11:46 PM local
const CHECKED = new Date(NOW - 2 * 60_000).toISOString();

const spentWindow = seatWindow({ id: 'codex_codex_primary', usedPercent: 100, resetsAt: RESET, limitReached: true, measured: false });
const PERSONAL = nativeSeat(capacity({ planType: 'plus', windows: [spentWindow], binding: spentWindow, usability: 'exhausted', observedAt: CHECKED }),
  { id: 'codex-personal', engine: 'codex', label: 'Personal Codex', accountId: 'codex-personal' });
const okWindow = seatWindow({ id: 'codex_codex_primary', usedPercent: 31, resetsAt: RESET });
const CMP = nativeSeat(capacity({ planType: 'pro', windows: [okWindow], binding: okWindow, usability: 'ready', observedAt: CHECKED }),
  { id: 'codex-cmp', engine: 'codex', label: 'Cash Margin Partners', accountId: 'codex-cmp' });
const CLAUDE = { ...CLAUDE_TIGHT_SEAT, id: 'claude-a', accountId: 'claude-a', label: 'Claude Code' };

function report(seatId: string, over: Partial<SeatHealthReport> = {}): SeatHealthReport {
  return {
    seatId, engine: 'codex', connection: 'connected', checkedAt: CHECKED, cliVersion: null, newestCliVersion: null,
    credentialExpiresAt: null, lastRefreshAt: null, resetAt: null, reasons: [], fix: { kind: 'none' }, ...over,
  };
}

const HEALTH: SeatHealthReport[] = [
  report('codex-personal', { connection: 'exhausted', resetAt: RESET, reasons: ['Every usage window with a reading is spent.'], fix: { kind: 'wait' } }),
  report('codex-cmp'),
  report('grok', { engine: 'grok', connection: 'signed-out', reasons: ['Grok CLI reports this account is not signed in.'], fix: { kind: 'reauth' } }),
  report('claude-a', { engine: 'claude' }),
];
const ROSTER = [PERSONAL, GROK_SEAT, CLAUDE, CMP, LOCAL_SEAT_V2];

let posts: string[];
let release: (() => void) | null;

beforeEach(() => {
  evictAll();
  setMutationToken(TOKEN);
  posts = [];
  release = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      posts.push(url);
      // Hold the sweep open so the row can be seen mid-check.
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ checkedAt: CHECKED, seats: HEALTH }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ checkedAt: CHECKED, seats: HEALTH }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

function renderGroup(over: Partial<Parameters<typeof AccountsGroup>[0]> = {}) {
  const onReconnect = vi.fn();
  render(
    <AccountsGroup seats={ROSTER} health={HEALTH} budget={null} loading={false} reconnecting={null}
      onReconnect={onReconnect} now={NOW} {...over} />,
  );
  return { onReconnect, list: screen.getByRole('list', { name: 'Accounts' }) };
}

function rowOf(list: HTMLElement, name: string): HTMLElement {
  return within(list).getAllByRole('listitem').find((li) => within(li).queryByText(name) !== null)!;
}

describe('AccountsGroup', () => {
  it('lists usable accounts first, then spent, then signed out', () => {
    const { list } = renderGroup();
    const labels = ['Cash Margin Partners', LOCAL_SEAT_V2.label, 'Claude Code', 'Personal Codex', 'Grok'];
    const names = within(list).getAllByRole('listitem').map((li) => labels.find((l) => within(li).queryByText(l) !== null));
    expect(names).toEqual(labels);
  });

  it('leads every row with a status, and says when it was last checked', () => {
    const { list } = renderGroup();
    const cmp = rowOf(list, 'Cash Margin Partners');
    expect(within(cmp).getByText('Connected')).toBeInTheDocument();
    expect(within(cmp).getByText('· usable now')).toBeInTheDocument();
    const checkedTitle = within(cmp).getByText('checked 2m ago').getAttribute('title') ?? '';
    expect(checkedTitle.startsWith('Last checked ')).toBe(true);
    if (EN_US) expect(checkedTitle).toMatch(/^Last checked Fri, Sep 25/);

    const personal = rowOf(list, 'Personal Codex');
    expect(within(personal).getByText('Spent')).toBeInTheDocument();
    // The shared reset wording, built against the injected clock: "Sat 11:46 PM" under en-US.
    expect(within(personal).getByText(`· resets ${describeResetAt(RESET, NOW)}`)).toBeInTheDocument();
    if (EN_US) expect(describeResetAt(RESET, NOW)).toBe('Sat 11:46 PM');
    expect(within(personal).getByText('usable again in 1d 7h')).toBeInTheDocument();
    // The status already says it: no second "out of usage" word, and no ISO anywhere.
    expect(within(personal).queryByText('out of usage')).not.toBeInTheDocument();
    expect(personal.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    const grok = rowOf(list, 'Grok');
    expect(within(grok).getByText('Signed out')).toBeInTheDocument();
    expect(within(grok).getByText('· reconnect to use it')).toBeInTheDocument();
    expect(within(grok).getByRole('button', { name: 'Reconnect: Grok' })).toBeInTheDocument();
    expect(within(grok).queryByRole('button', { name: /^Check again/ })).not.toBeInTheDocument();
  });

  it('reads "Checking…" before the health sweep has answered', () => {
    const { list } = renderGroup({ health: null, seats: [CMP] });
    expect(within(rowOf(list, 'Cash Margin Partners')).getByText('Usable now')).toBeInTheDocument();
    const unread = nativeSeat(capacity({ usability: 'unknown' }), { id: 'codex-new', engine: 'codex', label: 'New Codex', accountId: 'codex-new' });
    const second = renderGroupInto([unread]);
    expect(within(second).getByText('Checking…')).toBeInTheDocument();
  });

  it('Check again runs a sweep with the token, reads "Checking…" in place, and says when it is done', async () => {
    const user = userEvent.setup();
    const { list } = renderGroup();
    const personal = rowOf(list, 'Personal Codex');
    const button = within(personal).getByRole('button', { name: 'Check again: Personal Codex' });
    await user.click(button);
    await waitFor(() => expect(posts).toEqual(['/api/verse/health/refresh']));
    // The button stays where it was (busy), and the row says what is happening.
    expect(within(personal).getByRole('button', { name: 'Check again: Personal Codex' })).toHaveAttribute('aria-busy', 'true');
    expect(within(personal).getByText('Checking…')).toBeInTheDocument();
    release?.();
    expect(await screen.findByText('Checked Personal Codex again.')).toBeInTheDocument();
    expect(within(personal).queryByText('Checking…')).not.toBeInTheDocument();
  });

  it('an empty roster says what to do next', () => {
    const container = renderGroupInto([]);
    expect(within(container).getByText(ACCOUNTS_EMPTY_TEXT)).toBeInTheDocument();
    expect(ACCOUNTS_EMPTY_TEXT).toMatch(/Sign in to Claude Code, Codex or Grok/);
  });
});

function renderGroupInto(seats: Parameters<typeof AccountsGroup>[0]['seats']): HTMLElement {
  const { container } = render(
    <AccountsGroup seats={seats} health={null} budget={null} loading={false} reconnecting={null} onReconnect={() => {}} now={NOW} />,
  );
  return container;
}
