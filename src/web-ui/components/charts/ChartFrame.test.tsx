import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChartFrame } from './ChartFrame.js';
import { TableView } from './TableView.js';

const table = <TableView caption="t" columns={[{ key: 'a', label: 'A', render: (r: { a: number }) => r.a }]} rows={[{ a: 7 }]} rowKey={() => 'r'} />;

describe('ChartFrame', () => {
  it('names the figure by its title and toggles between chart and table', async () => {
    render(<ChartFrame title="Runs per day" table={table}><svg data-testid="plot" /></ChartFrame>);
    expect(screen.getByRole('figure', { name: 'Runs per day' })).toBeInTheDocument();
    expect(screen.getByTestId('plot')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.queryByTestId('plot')).toBeNull();
    expect(screen.getByRole('cell', { name: '7' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Chart' }));
    expect(screen.getByTestId('plot')).toBeInTheDocument();
  });

  it('designs the dark state instead of drawing empty axes', () => {
    render(
      <ChartFrame title="Fleet" status={{ kind: 'dark', since: '2026-09-01T19:10:00Z' }} table={table}>
        <svg data-testid="plot" />
      </ChartFrame>,
    );
    expect(screen.getByText('Fleet dark since Sep 1')).toBeInTheDocument();
    expect(screen.queryByTestId('plot')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
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
});

describe('TableView', () => {
  it('renders an explicit empty row', () => {
    render(<TableView caption="c" columns={[{ key: 'a', label: 'A', render: () => '' }]} rows={[]} rowKey={() => 'k'} emptyMessage="No runs." />);
    expect(screen.getByRole('cell', { name: 'No runs.' })).toBeInTheDocument();
  });
});
