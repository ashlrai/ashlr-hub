import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHART_TABLE_KEY, ChartFrame, sinceLabel } from './ChartFrame.js';
import { TEST_ZONES, inTimeZone } from '../../routes/verse/growth/time-zone.test-support.js';
import { TableView } from './TableView.js';
import { findCommand } from '../../routes/verse/shell/command-catalog.js';

const table = <TableView caption="t" columns={[{ key: 'a', label: 'A', render: (r: { a: number }) => r.a }]} rows={[{ a: 7 }]} rowKey={() => 'r'} />;

describe('ChartFrame', () => {
  it('names the figure by its title and moves between chart and table through the ⋯ menu', async () => {
    const user = userEvent.setup();
    render(<ChartFrame title="Runs per day" table={table}><svg data-testid="plot" /></ChartFrame>);
    expect(screen.getByRole('figure', { name: 'Runs per day' })).toBeInTheDocument();
    expect(screen.getByTestId('plot')).toBeInTheDocument();
    // No segmented toggle beside the title any more (SPEC-310C §6).
    expect(screen.queryByRole('radiogroup')).toBeNull();

    const more = screen.getByRole('button', { name: 'Runs per day: view options' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitemradio', { name: /Show as chart/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('menuitemradio', { name: /Show as table/ }));
    expect(screen.queryByTestId('plot')).toBeNull();
    expect(screen.getByRole('cell', { name: '7' })).toBeInTheDocument();
    // Focus returns to the menu button after a pick.
    expect(more).toHaveFocus();
  });

  it('is fully keyboard operable: arrows move, Enter picks, Escape closes back to the button', async () => {
    const user = userEvent.setup();
    render(<ChartFrame title="Runs" table={table}><svg data-testid="plot" /></ChartFrame>);
    const more = screen.getByRole('button', { name: 'Runs: view options' });
    more.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: /Show as chart/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: /Show as table/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('plot')).toBeNull();
    expect(more).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(more).toHaveFocus();
  });

  it('toggles the table with T while focus is anywhere in the card, never while typing', async () => {
    const user = userEvent.setup();
    render(
      <ChartFrame title="Runs" table={table} actions={<input aria-label="filter" />}>
        <div tabIndex={0} data-testid="plot">plot</div>
      </ChartFrame>,
    );
    screen.getByTestId('plot').focus();
    await user.keyboard('t');
    expect(screen.queryByTestId('plot')).toBeNull();
    expect(screen.getByRole('cell', { name: '7' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Runs: view options' }).focus();
    await user.keyboard('t');
    expect(screen.getByTestId('plot')).toBeInTheDocument();
    // Typing a "t" into a field inside the card is text, not a command.
    await user.type(screen.getByRole('textbox', { name: 'filter' }), 't');
    expect(screen.getByTestId('plot')).toBeInTheDocument();
    // ⌘T / Ctrl+T belong to the browser.
    fireEvent.keyDown(screen.getByTestId('plot'), { key: 't', metaKey: true });
    expect(screen.getByTestId('plot')).toBeInTheDocument();
  });

  it('uses the same key as the catalog command (single source of truth for the shortcuts overlay)', () => {
    const command = findCommand('chart.table');
    expect(command?.scope).toBe('chart');
    expect(command?.keys).toEqual([{ key: CHART_TABLE_KEY }]);
  });

  it('designs the dark state instead of drawing empty axes', () => {
    render(
      <ChartFrame title="Fleet" status={{ kind: 'dark', since: '2026-09-01T19:10:00Z' }} table={table}>
        <svg data-testid="plot" />
      </ChartFrame>,
    );
    expect(screen.getByText('Fleet dark since Sep 1')).toBeInTheDocument();
    expect(screen.queryByTestId('plot')).toBeNull();
    expect(screen.queryByRole('button', { name: /view options/ })).toBeNull();
  });

  it('says unknown in words for an unreadable source', () => {
    render(<ChartFrame title="x" status={{ kind: 'unknown', reason: 'the run store is unreadable.' }} table={table}><svg /></ChartFrame>);
    expect(screen.getByRole('note')).toHaveTextContent('Unknown — the run store is unreadable.');
  });

  it('shows a caveat and supports starting on the table', () => {
    render(<ChartFrame title="x" caveat="Lower bound: 6 files unreadable." defaultView="table" table={table}><svg data-testid="plot" /></ChartFrame>);
    expect(screen.getByText('Lower bound: 6 files unreadable.')).toBeInTheDocument();
    expect(screen.queryByTestId('plot')).toBeNull();
  });

  it('hides the menu for a chart that is its own numbers', () => {
    render(<ChartFrame title="x" hideToggle table={table}><svg data-testid="plot" /></ChartFrame>);
    expect(screen.queryByRole('button', { name: /view options/ })).toBeNull();
  });
});

describe('TableView', () => {
  it('renders an explicit empty row', () => {
    render(<TableView caption="c" columns={[{ key: 'a', label: 'A', render: () => '' }]} rows={[]} rowKey={() => 'k'} emptyMessage="No runs." />);
    expect(screen.getByRole('cell', { name: 'No runs.' })).toBeInTheDocument();
  });
});

describe('sinceLabel — the day in the viewer\'s zone', () => {
  it('names an ISO instant by its LOCAL day (22:52 EDT Sep 25 is 02:52Z Sep 26)', () => {
    // Fleet history's darkSince is an instant; slicing it read "Sep 26" here.
    expect(inTimeZone('America/New_York', () => sinceLabel('2026-09-26T02:52:00.000Z'))).toBe('Sep 25');
    expect(inTimeZone('America/New_York', () => sinceLabel('2026-09-26T04:05:00.000Z'))).toBe('Sep 26');
    expect(inTimeZone('Asia/Tokyo', () => sinceLabel('2026-09-25T20:00:00.000Z'))).toBe('Sep 26');
  });

  it('prints a YYYY-MM-DD calendar day as written, in every zone', () => {
    for (const zone of TEST_ZONES) expect(inTimeZone(zone, () => sinceLabel('2026-09-25')), zone).toBe('Sep 25');
  });

  it('falls back to the written date for an unparseable stamp', () => {
    expect(sinceLabel('2026-09-25T99:99')).toBe('Sep 25');
  });
});
