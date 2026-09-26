/**
 * AccountDetail.test.tsx — the depth view, pinned where depth turns into
 * invention: a health of `unknown` drawn as a fault, a flagged window given a
 * percentage, and a "history" conjured from a single reading.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountCardModel, WindowView } from './accounts-model.js';
import { AccountCard } from './AccountCard.js';
import { AccountDetail, NO_HISTORY_NOTE } from './AccountDetail.js';

function window(over: Partial<WindowView> & { id: string }): WindowView {
  return {
    label: over.id,
    usedPct: null,
    tone: 'ok',
    resetText: null,
    resetsAt: null,
    limitReached: false,
    measured: true,
    ...over,
  };
}

function card(over: Partial<AccountCardModel> & { id: string }): AccountCardModel {
  return {
    label: over.id,
    engine: 'claude',
    color: 'var(--engine-claude)',
    plan: 'max',
    verdict: { state: 'tight', headline: 'Running tight', detail: 'the sentence', code: null },
    allWindows: [],
    evidence: {
      state: 'observed',
      authentication: 'signed-in',
      health: null,
      reasonCode: null,
      observedAt: null,
      notes: [],
      unsupported: null,
    },
    binding: null,
    others: [],
    credits: null,
    reconnectCommand: null,
    observedAt: null,
    rank: 2,
    hasDetail: true,
    sourceNote: null,
    ...over,
  };
}

function detail(model: AccountCardModel, onClose = vi.fn()): void {
  render(<AccountDetail card={model} onClose={onClose} headingId="h" />);
}

describe('AccountDetail', () => {
  it('shows every window, not just the binding one', () => {
    detail(
      card({
        id: 'claude',
        label: 'Claude',
        allWindows: [
          window({ id: 'seven_day_fable', label: 'Week · Fable', usedPct: 100 }),
          window({ id: 'seven_day', label: 'Week · all models', usedPct: 58 }),
          window({ id: 'five_hour', label: 'Session · rolling 5h', usedPct: 47 }),
        ],
      }),
    );
    expect(screen.getByText('All windows (3)')).toBeInTheDocument();
    expect(screen.getByText('Week · all models')).toBeInTheDocument();
    expect(screen.getByText('Session · rolling 5h')).toBeInTheDocument();
  });

  /**
   * Claude's health is `unknown` by construction — the probe has no health
   * channel for it. Rendering that as a fault invents a problem that is not
   * there and sends the operator looking for it.
   */
  it("describes Claude's structural unknown health as not-a-fault", () => {
    detail(card({ id: 'claude', engine: 'claude', evidence: { ...card({ id: 'x' }).evidence, health: 'unknown' } }));
    expect(screen.getByText(/It is not a fault\./)).toBeInTheDocument();
  });

  it('says plainly when no health verdict was reported at all', () => {
    detail(card({ id: 'codex-a' }));
    expect(screen.getByText(/reports no health verdict at all/)).toBeInTheDocument();
  });

  it('shows the probe code as a code, never as the sentence', () => {
    detail(
      card({
        id: 'grok',
        evidence: { ...card({ id: 'x' }).evidence, reasonCode: 'probe-account-unavailable' },
      }),
    );
    const code = screen.getByText('probe-account-unavailable');
    expect(code.tagName).toBe('CODE');
  });

  it('names a version pin as a pin rather than an outage', () => {
    detail(
      card({
        id: 'claude',
        evidence: {
          ...card({ id: 'x' }).evidence,
          unsupported: { code: 'usage-version-unsupported', pinnedVersion: '2.1.257' },
        },
      }),
    );
    expect(screen.getByText('2.1.257')).toBeInTheDocument();
    expect(screen.getByText(/not an outage/)).toBeInTheDocument();
  });

  it('flags a sentinel window so a denial is not read as a measurement', () => {
    detail(
      card({
        id: 'codex-a',
        allWindows: [window({ id: 'codex', limitReached: true, measured: false })],
      }),
    );
    expect(screen.getByText(/Flagged windows show no percentage/)).toBeInTheDocument();
  });

  it('refuses to invent a history the data does not carry', () => {
    detail(card({ id: 'codex-a' }));
    expect(screen.getByText(NO_HISTORY_NOTE)).toBeInTheDocument();
  });

  it('closes on demand', async () => {
    const onClose = vi.fn();
    detail(card({ id: 'codex-a' }), onClose);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AccountCard — the card head is the control that opens the detail', () => {
  it('exposes the head as a keyboard-reachable expander tied to the detail region', async () => {
    const onOpen = vi.fn();
    render(
      <AccountCard
        card={card({ id: 'codex-a', label: 'Codex A' })}
        onOpen={onOpen}
        expanded={false}
        triggerId="t"
        detailId="d"
      />,
    );
    const trigger = screen.getByRole('button', { name: /Codex A/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-controls', 'd');
    await userEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledWith('codex-a');
  });

  it('stays inert text when there is nothing to open', () => {
    render(<AccountCard card={card({ id: 'codex-a', label: 'Codex A', hasDetail: false })} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
