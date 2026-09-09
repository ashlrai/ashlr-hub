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
  expect(screen.getByText('Pinned seed')).toBeTruthy();
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
