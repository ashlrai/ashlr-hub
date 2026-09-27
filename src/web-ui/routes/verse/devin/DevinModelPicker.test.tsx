/**
 * 3.15 — the Devin (CLI) seat's model catalog in the SHARED pickers (no fork):
 * New chat's SeatSelector gives each family its own optgroup with SWE-2 first
 * and every row priced; the composer's Model menu (ControlMenu) shows one
 * heading per family ("SWE-2 · Free") and a variant's own price when it
 * differs; the header / button helpers read the price off the seat.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { VerseSeat } from '../../../data/api-types.js';
import { modelOptionsFor } from '../../../../core/verse/session-controls.js';
import { ControlMenu, optionRuns } from '../composer/ControlMenu.js';
import { CLAUDE_SEAT } from '../fixtures.test-support.js';
import { SeatSelector, seatOptionGroups, seatOptionText, seatOptionTitle } from '../SeatSelector.js';
import { modelPriceNote } from '../verse-model.js';

const row = (id: string, label: string, group: string, priceNote: string) => ({ id, label, contextWindow: null, windowSource: 'fallback' as const, group, priceNote });

const DEVIN_CLI: VerseSeat = {
  id: 'devin-cli',
  engine: 'devin',
  label: 'Devin (CLI)',
  accountId: 'devin-cli',
  contextWindow: null,
  models: [
    row('swe-2-high', 'SWE-2 High', 'SWE-2', 'Free'),
    row('swe-2-medium', 'SWE-2 Medium', 'SWE-2', 'Free'),
    row('swe-2-max', 'SWE-2 Max', 'SWE-2', 'Free'),
    row('claude-opus-5-5-medium', 'Claude Opus 5.5 Medium', 'Claude Opus 5.5', '$4 in · $20 out per 1M'),
    row('claude-opus-5-5-high-fast', 'Claude Opus 5.5 High Fast', 'Claude Opus 5.5', '$8 in · $40 out per 1M'),
  ],
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

const DEVIN_CLOUD: VerseSeat = {
  id: 'devin',
  engine: 'devin',
  label: 'Devin (cloud)',
  accountId: 'devin',
  contextWindow: null,
  models: [{ id: 'devin', label: 'Devin', contextWindow: null, windowSource: 'fallback' }],
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

describe('New chat: the Devin (CLI) models in SeatSelector', () => {
  it('one optgroup per family (SWE-2 first), every row priced; other seats unchanged', () => {
    render(<SeatSelector seats={[CLAUDE_SEAT, DEVIN_CLOUD, DEVIN_CLI]} value={{ seatId: 'devin-cli', model: 'swe-2-high' }} onChange={() => {}} />);
    const select = screen.getByLabelText('Seat and model') as HTMLSelectElement;
    expect(Array.from(select.querySelectorAll('optgroup')).map((g) => g.label)).toEqual([
      'Claude', 'Devin', 'Devin (CLI) · SWE-2', 'Devin (CLI) · Claude Opus 5.5',
    ]);
    const swe = screen.getByRole('option', { name: 'Devin (CLI) — SWE-2 High · Free' }) as HTMLOptionElement;
    expect(swe.selected).toBe(true);
    expect(swe.getAttribute('title')).toContain('Price: Free.');
    expect(screen.getByRole('option', { name: 'Devin (CLI) — Claude Opus 5.5 High Fast · $8 in · $40 out per 1M' })).toBeTruthy();
    // The cloud seat keeps its old row.
    expect(screen.getByRole('option', { name: /^Devin \(cloud\) — Devin · window unknown/ })).toBeTruthy();
  });

  it('seatOptionGroups keeps consecutive families together and ungrouped seats under the engine', () => {
    const groups = seatOptionGroups('Devin', [DEVIN_CLOUD, DEVIN_CLI]);
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([['Devin', 1], ['Devin (CLI) · SWE-2', 3], ['Devin (CLI) · Claude Opus 5.5', 2]]);
    const model = DEVIN_CLI.models[0]!;
    expect(seatOptionText({ seat: DEVIN_CLI, model, mode: 'standard', note: null })).toBe('Devin (CLI) — SWE-2 High · Free');
    expect(seatOptionTitle(DEVIN_CLI, model, null).split('\n')).toContain('Price: Free.');
  });
});

describe('Composer: the Devin (CLI) Model menu', () => {
  it('groups by family under a priced heading; a variant priced differently says so', async () => {
    const user = userEvent.setup();
    const options = modelOptionsFor(DEVIN_CLI);
    expect(optionRuns(options).map((r) => [r.group, r.options.length])).toEqual([['SWE-2 · Free', 3], ['Claude Opus 5.5 · $4 in · $20 out per 1M', 2]]);
    render(<ControlMenu<string> label="Model" valueLabel="SWE-2 High · Free" value="swe-2-high" onChange={() => {}} options={options} />);
    await user.click(screen.getByRole('button', { name: 'Model: SWE-2 High · Free' }));
    const swe = screen.getByRole('group', { name: 'SWE-2 · Free' });
    expect(within(swe).getAllByRole('menuitemradio').map((i) => i.getAttribute('data-label'))).toEqual(['SWE-2 High', 'SWE-2 Medium', 'SWE-2 Max']);
    expect(within(swe).getByRole('menuitemradio', { name: 'SWE-2 High' }).getAttribute('aria-checked')).toBe('true');
    const opus = screen.getByRole('group', { name: 'Claude Opus 5.5 · $4 in · $20 out per 1M' });
    expect(within(opus).getByText('$8 in · $40 out per 1M')).toBeTruthy();
    // Arrow keys still walk every item across groups.
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5);
  });

  it('an ungrouped menu renders exactly as before (no group elements)', async () => {
    const user = userEvent.setup();
    render(<ControlMenu<string> label="Model" valueLabel="Opus 5" value="a" onChange={() => {}}
      options={[{ id: 'a', label: 'Opus 5', available: true }, { id: 'b', label: 'Sonnet 5', available: true }]} />);
    await user.click(screen.getByRole('button', { name: 'Model: Opus 5' }));
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
  });

  it('the price for the header and the Model button comes off the seat', () => {
    const seats = [CLAUDE_SEAT, DEVIN_CLI];
    expect(modelPriceNote(seats, { seatId: 'devin-cli', model: 'swe-2-max' })).toBe('Free');
    expect(modelPriceNote(seats, { seatId: 'devin-cli', model: 'claude-opus-5-5-medium' })).toBe('$4 in · $20 out per 1M');
    expect(modelPriceNote(seats, { seatId: 'claude-main', model: 'claude-opus-5' })).toBeNull();
    expect(modelPriceNote(seats, { seatId: 'devin-cli', model: 'devin' })).toBeNull();
  });
});
