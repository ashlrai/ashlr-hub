import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MindSection } from './MindSection.js';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';

let vp: ViewportMock | null = null;
beforeEach(() => {
  evictAll();
  clearMutationToken();
  vp = mockWideViewport();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  vp?.restore();
});

describe('MindSection', () => {
  it('shows memos with 7-day outcomes, the hit rate, insights, the matrix, trends and the action log', async () => {
    stubSurfaceFetch({ kind: 'live' });
    const { container } = render(<MindSection />);
    const memos = await screen.findByRole('region', { name: 'Memos' });
    await waitFor(() => expect(within(memos).getAllByRole('listitem').length).toBe(7));
    expect(within(memos).getAllByText(/^missed \(actual/)).toHaveLength(1);
    expect(screen.getByRole('meter', { name: 'Leader hit rate' })).toHaveAttribute('aria-valuetext', 'Leader hit rate: 67%');
    expect(screen.getByRole('region', { name: 'Standards' })).toHaveTextContent('Every producer change that edits a parser adds a test');
    await waitFor(() => expect(screen.getByRole('list', { name: 'Reasoning insights' }).children).toHaveLength(3));
    expect(screen.getByRole('figure', { name: 'Insights by kind and engine' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-cell]').length).toBe(18);
    expect(screen.getByRole('figure', { name: 'Struggles and wins' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Action log' })).toHaveTextContent('Raise Grok to 3 lanes');
  });

  it('facets the matrix by repo', async () => {
    stubSurfaceFetch({ kind: 'live' });
    const { container } = render(<MindSection />);
    const select = await screen.findByRole('combobox', { name: 'Repo' });
    fireEvent.change(select, { target: { value: 'binshield' } });
    await waitFor(() => expect(screen.getByRole('figure', { name: 'Insights by kind and engine' })).toHaveTextContent('In binshield'));
    const counts = [...container.querySelectorAll('[data-cell]')].map((c) => c.getAttribute('data-value')).filter((v) => v !== 'unknown' && v !== '0');
    expect(counts.sort()).toEqual(['2', '3']);
  });

  it('vetoes from the action log through the confirmation', async () => {
    setMutationToken('c'.repeat(64));
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<MindSection />);
    const log = await screen.findByRole('region', { name: 'Action log' });
    await user.click(within(log).getByRole('button', { name: /Veto: Archive goal/ }));
    await user.click(within(screen.getByRole('dialog', { name: 'Veto this action?' })).getByRole('button', { name: 'Veto' }));
    await waitFor(() => expect(posted[0]).toEqual({ url: '/api/verse/leader', body: { action: 'veto', actionId: 'a1' } }));
  });

  it('designs the empty and not-landed states', async () => {
    stubSurfaceFetch({ kind: 'dark', routes: { '/api/reasoning/digest': null } });
    render(<MindSection />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Memos' })).toHaveTextContent('No memos yet — last run: No eligible seat'));
    await waitFor(() => expect(screen.getAllByText(/The reasoning digest is not in this build yet/).length).toBeGreaterThanOrEqual(1));
    expect(screen.getByRole('meter', { name: 'Leader hit rate' })).toHaveAttribute('aria-valuetext', 'Leader hit rate: unknown');
  });

  it('starts the matrix on its table at 375', async () => {
    vp?.restore();
    vp = mockCompactViewport({ dark: true });
    stubSurfaceFetch({ kind: 'live' });
    const { container } = render(<MindSection />);
    const fig = await screen.findByRole('figure', { name: 'Insights by kind and engine' });
    await waitFor(() => expect(within(fig).getByRole('columnheader', { name: 'Total' })).toBeInTheDocument());
    expect(container.querySelectorAll('[data-cell]').length).toBe(0);
  });
});
