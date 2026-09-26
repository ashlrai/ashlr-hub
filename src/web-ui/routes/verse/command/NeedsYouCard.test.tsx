/**
 * NeedsYouCard — the Command card's rows read like the ⌘J drawer's
 * (shell/needs-you-model needsYouRowView): the wire shorthand ("patch: claude
 * run: …", "TITRR … 2 file(s) (+384/-0)", "38d") never reaches the page as
 * text, only as tooltips, and the card's own actions are untouched.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { activity, approvalNeed } from '../shell/shell-fixtures.test-support.js';
import type { ActivityState } from '../shell/useActivity.js';
import type { ConfirmSpec, SurfaceActions } from './actions.js';
import { needsYouItems } from './fixtures.test-support.js';
import { activityRead, cardKindLabel, NeedsYouCard, type SeatNames } from './NeedsYouCard.js';

const DAY = 86_400_000;
const RAW_TITLE = 'patch: claude run: Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a deg';
const RAW_DETAIL = 'TITRR claude:claude-fable-5 run produced 2 file(s) (+384/-0). Review before applying.';

/** Renders the card with a recording `act`; returns the recorder (what was asked, never run). */
function renderCard(needsYou: NeedsYouItem[], seatNames?: SeatNames) {
  const act = vi.fn<(fn: () => Promise<unknown>, reason: string, options?: { confirm?: ConfirmSpec }) => void>();
  const actions: SurfaceActions = {
    act: (fn, reason, options) => act(fn, reason, options),
    busy: false,
    error: null,
    clearError: () => {},
    readOnly: false,
    dialogs: null,
  };
  const state: ActivityState = { status: 'ready', data: activity({ needsYou }), updatedAt: Date.now() };
  render(<NeedsYouCard state={state} actions={actions} fleetLine="Fleet idle." seatNames={seatNames} />);
  return act;
}

function runApproval(over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return approvalNeed('p-live', {
    title: RAW_TITLE,
    detail: RAW_DETAIL,
    since: new Date(Date.now() - 38 * DAY).toISOString(),
    ...over,
  });
}

describe('NeedsYouCard rows', () => {
  it('reads a sandboxed-run approval in words, keeping the server text for tooltips', () => {
    renderCard([runApproval()]);
    const row = within(screen.getByRole('region', { name: 'Needs you (1)' })).getByRole('listitem');
    expect(within(row).getByText('Patch · Claude run')).toBeInTheDocument();
    const title = within(row).getByText('Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a…"');
    expect(title).toHaveAttribute('title', RAW_TITLE);
    expect(within(row).getByText('2 files · +384 −0')).toBeInTheDocument();
    expect(within(row).getByText('2 files changed, 384 lines added, 0 removed')).toHaveClass('visually-hidden');
    expect(within(row).getByText('Test-and-repair loop')).toHaveAttribute('title', expect.stringMatching(/^TITRR — Test, Iterate/));
    expect(within(row).getByText('Review before applying.')).toBeInTheDocument();
    expect(within(row).getByText('binshield')).toBeInTheDocument();
    const age = within(row).getByText('38 days ago');
    expect(age.getAttribute('title')).toBeTruthy();
    // None of the wire shorthand reaches the page as text.
    expect(row.textContent).not.toMatch(/TITRR|patch:|claude run:|file\(s\)|\bdeg\b|38d\b/);
    // The card's actions are unchanged: Approve, Reject, Open.
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('shows a repo path by its short name, the full path as the tooltip', () => {
    renderCard([runApproval({ subject: { repo: '/Users/me/src/binshield', pr: 12, seatId: null, sessionId: null, engine: null } })]);
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('binshield')).toHaveAttribute('title', '/Users/me/src/binshield');
    expect(within(row).getByText('#12')).toBeInTheDocument();
    expect(row.textContent).not.toContain('/Users/me');
  });

  it('keeps an item that is not an approval as sent, with no kind label', () => {
    const ownerLane = needsYouItems().find((i) => i.kind === 'owner-lane-pr')!;
    renderCard([ownerLane]);
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('PR #81 touches a protected path — owner lane')).toHaveAttribute('title', ownerLane.title);
    expect(within(row).getByText('Edits .github/workflows/ci.yml; never auto-merged.')).toBeInTheDocument();
    expect(within(row).getByText('ashlrcode')).toHaveAttribute('title', 'ashlrai/ashlrcode');
    expect(within(row).getByText('#81')).toBeInTheDocument();
    expect(within(row).getByText('3 hours ago')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /Open/ })).toHaveAttribute('href', 'https://github.com/ashlrai/ashlrcode/pull/81');
  });

  it('runs Approve through the item’s own confirmation, naming the readable title', async () => {
    const user = userEvent.setup();
    const act = renderCard([runApproval()]);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(act).toHaveBeenCalledTimes(1);
    const [, reason, options] = act.mock.calls[0]!;
    expect(reason).toBe('Approve: Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a…"');
    expect(options).toEqual({
      confirm: {
        title: 'Approve this pr against binshield?',
        body: "Pushes a branch to binshield's remote and opens a real pull request.",
        confirmLabel: 'Approve and open the pull request',
        destructive: true,
      },
    });
  });

  it('a generic confirmation quotes the readable title, not the wire title', async () => {
    const user = userEvent.setup();
    const item = runApproval();
    const act = renderCard([{ ...item, actions: item.actions.map((a) => ({ ...a, confirm: null })) }]);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const [, , options] = act.mock.calls[0]!;
    expect(options?.confirm).toEqual({
      title: 'Reject?',
      body: 'Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a…"',
      confirmLabel: 'Reject',
      destructive: false,
    });
  });
});

// Review 3.10.1: the card named a seat by its raw id ("claude-a · 2 hours
// ago") beside a burn-down titled "Claude Max", and a partial run's label
// read "Partial claude run" beside "Claude run".
describe('NeedsYouCard names seats and engines as every other surface does', () => {
  function signedOut(seatId: string): NeedsYouItem {
    return {
      id: `accounts:reconnect:${seatId}`,
      source: 'accounts',
      kind: 'reconnect',
      severity: 'high',
      title: 'Claude Max is signed out',
      detail: null,
      since: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      expiresAt: null,
      subject: { repo: null, pr: null, seatId, sessionId: null, engine: 'claude' },
      target: { kind: 'seat', seatId },
      actions: [],
    };
  }

  it('shows the seat by its label, with the id only as the tooltip', () => {
    renderCard([signedOut('claude-a')], new Map([['claude-a', 'Claude Max']]));
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Claude Max', { selector: 'span[title]' })).toHaveAttribute('title', 'claude-a');
    expect(within(row).getByText('2 hours ago')).toBeInTheDocument();
    expect(row.textContent).not.toContain('claude-a');
  });

  it('shows an id neither the roster nor the budget route knows as sent, with no tooltip', () => {
    renderCard([signedOut('claude-z')], new Map([['claude-a', 'Claude Max']]));
    const seat = within(screen.getByRole('listitem')).getByText('claude-z');
    expect(seat).not.toHaveAttribute('title');
  });

  it('capitalises the engine of a partial run like a whole one', () => {
    renderCard([runApproval({ title: `patch: [partial] claude run: ${RAW_TITLE.slice('patch: claude run: '.length)}` })]);
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Patch · Partial Claude run')).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/Partial claude/);
  });

  it('touches only the trailing engine eyebrow', () => {
    expect(cardKindLabel('Patch · Partial claude run')).toBe('Patch · Partial Claude run');
    expect(cardKindLabel('Partial grok run')).toBe('Partial Grok run');
    expect(cardKindLabel('Partial ollama run')).toBe('Partial Ollama run');
    expect(cardKindLabel('Patch · Claude run')).toBe('Patch · Claude run');
    expect(cardKindLabel('Patch')).toBe('Patch');
    expect(cardKindLabel('Dry run')).toBe('Dry run');
    expect(cardKindLabel(null)).toBeNull();
  });
});

describe('activityRead', () => {
  it('a first poll that failed names the server’s reason; only a clean 404 is "not in this build"', () => {
    const failed = activityRead({ status: 'unavailable', data: null, updatedAt: null, error: 'Could not read activity: building the answer failed.' });
    expect(failed.reason).toBe('Could not read the Needs-you inbox. Could not read activity: building the answer failed.');
    const missing = activityRead({ status: 'unavailable', data: null, updatedAt: null, error: null });
    expect(missing.reason).toMatch(/not in this build yet/);
  });
});
