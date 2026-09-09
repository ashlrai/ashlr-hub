import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Experiment } from '../app/experiment';
import evidence from '../app/data/demo.json';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('shows measured second-generation results and recorded-demo scope without fetching', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<Experiment evidence={evidence} />);
  expect(screen.getByText('Recorded deterministic demonstration')).toBeTruthy();
  expect(screen.getByText('47 bytes')).toBeTruthy();
  expect(screen.getByText('210 bytes')).toBeTruthy();
  expect(screen.getByText('227 bytes')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
it('inspects retained and rejected trials without treating failures as measured scores', async () => {
  const user = userEvent.setup();
  render(<Experiment evidence={evidence} />);
  await user.click(
    screen.getByRole('button', { name: 'Inspect readable, generation 2' }),
  );
  expect(screen.getByText('107 bytes')).toBeTruthy();
  expect(screen.getByText('readable · generation 1')).toBeTruthy();
  await user.click(
    screen.getByRole('button', { name: 'Inspect broken, generation 2' }),
  );
  expect(
    screen.getByText(/The evaluator rejected this candidate/),
  ).toBeTruthy();
  expect(screen.getByText('No passing score')).toBeTruthy();
});
it('switches generations and preserves a valid inspector selection', async () => {
  const user = userEvent.setup();
  render(<Experiment evidence={evidence} />);
  await user.click(screen.getByRole('tab', { name: 'Generation 1' }));
  expect(screen.getByText('274 bytes')).toBeTruthy();
  expect(screen.getByText('317 bytes')).toBeTruthy();
  expect(screen.getByText('Pinned seed', { selector: 'dd' })).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: 'Generation 2' }));
  expect(screen.getByText('227 bytes')).toBeTruthy();
});
it('provides public evidence, not a connection to private operational APIs', () => {
  render(<Experiment evidence={evidence} />);
  expect(
    screen
      .getByRole('link', { name: 'Download evidence' })
      .getAttribute('href'),
  ).toBe('/evidence/demo.json');
  expect(JSON.stringify(evidence)).not.toMatch(
    /\/Users\/|readToken|controlToken|accountHint|seedRepo/,
  );
});
it('selects lineage nodes across generations and keeps measurements synchronized', async () => {
  const user = userEvent.setup();
  render(<Experiment evidence={evidence} />);
  const first = screen.getByRole('button', {
    name: 'Select readable lineage, generation 1',
  });
  await user.click(first);
  expect(first.getAttribute('aria-pressed')).toBe('true');
  expect(
    screen
      .getByRole('tab', { name: 'Generation 1' })
      .getAttribute('aria-selected'),
  ).toBe('true');
  expect(screen.getByText('317 bytes')).toBeTruthy();
  expect(screen.getByText('Pinned seed', { selector: 'dd' })).toBeTruthy();
  await user.click(
    screen.getByRole('button', {
      name: 'Select compact lineage, generation 2',
    }),
  );
  expect(screen.getByText('227 bytes')).toBeTruthy();
  expect(
    screen
      .getByRole('tab', { name: 'Generation 2' })
      .getAttribute('aria-selected'),
  ).toBe('true');
});
it('keeps rejected lineage outcomes explicit and operable from the keyboard', async () => {
  const user = userEvent.setup();
  render(<Experiment evidence={evidence} />);
  const rejected = screen.getByRole('button', {
    name: 'Select broken lineage, generation 2',
  });
  rejected.focus();
  await user.keyboard('{Enter}');
  expect(rejected.getAttribute('aria-pressed')).toBe('true');
  expect(
    screen.getByText(/The evaluator rejected this candidate/),
  ).toBeTruthy();
  expect(screen.getByText('No passing score')).toBeTruthy();
});
