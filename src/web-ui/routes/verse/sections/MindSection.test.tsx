import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MindSection } from './MindSection.js';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { reasoningDigest } from '../command/fixtures.test-support.js';
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

  it('names each insight by its project — registered name, else folder — with the path in the tooltip and a scratch tag for temp folders', async () => {
    const now = Date.now();
    const SCRATCH = '/private/tmp/claude-501/-Users-masonwyatt-Desktop/9d28bdb1-4c1e/scratchpad/grokpad';
    const live = reasoningDigest('live', now);
    const digest = {
      ...live,
      insights: live.insights.map((i) => (i.id === 'i1' ? { ...i, repo: SCRATCH } : i.id === 'i2' ? { ...i, repo: '/Users/me/dev/binshield' } : i)),
    };
    stubSurfaceFetch({
      kind: 'live',
      now,
      routes: {
        '/api/reasoning/digest': digest,
        '/api/verse/bootstrap': { projects: [{ path: '/Users/me/dev/binshield', name: 'Binshield', enrolled: true }] },
        '/api/verse/workspaces': { workspaces: [] },
      },
    });
    render(<MindSection />);
    const list = await screen.findByRole('list', { name: 'Reasoning insights' });
    await waitFor(() => expect(within(list).getByText('Binshield')).toBeInTheDocument());
    const [first, second] = within(list).getAllByRole('listitem');
    // The scratch folder: its own name, the full path only as the tooltip, and a quiet tag.
    const place = within(first!).getByText('grokpad');
    expect(place).toHaveAttribute('title', SCRATCH);
    expect(within(first!).getByText('scratch')).toBeInTheDocument();
    expect(first!.textContent).not.toContain('/private/tmp');
    // "last seen 20m ago" — never the doubled "last 20m ago".
    expect(first!.textContent).toMatch(/last seen \d+[smhd] ago/);
    expect(first!.textContent).not.toMatch(/last \d/);
    // A registered project reads by its name, untagged.
    expect(within(second!).getByText('Binshield')).toHaveAttribute('title', '/Users/me/dev/binshield');
    expect(within(second!).queryByText('scratch')).not.toBeInTheDocument();
    // The Repo facet offers the same labels, never the raw path.
    const select = screen.getByRole('combobox', { name: 'Repo' });
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('grokpad · scratch');
    expect(options).toContain('Binshield');
    expect(options.some((o) => o?.includes('/'))).toBe(false);
    fireEvent.change(select, { target: { value: SCRATCH } });
    await waitFor(() => expect(screen.getByRole('figure', { name: 'Insights by kind and engine' })).toHaveTextContent('In grokpad · scratch'));
  });

  it('labels the struggles-and-wins axis in whole counts — never 0.3 of a struggle', async () => {
    // Per-day counts topping out at 1 used to tick 0, 0.3, 0.5, 0.8, 1. The
    // series are all integers, which is what makes the chart kit pick
    // integer ticks (AreaTrend: axisTicks … integer: allIntegers(values)).
    const now = Date.now();
    const live = reasoningDigest('live', now);
    const trends = live.trends.map((d, i) => ({ ...d, steps: 5, struggles: i % 2, wins: 1 - (i % 2) }));
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/reasoning/digest': { ...live, trends } } });
    render(<MindSection />);
    const fig = await screen.findByRole('figure', { name: 'Struggles and wins' });
    await waitFor(() => expect(fig.querySelector('svg')).not.toBeNull());
    const numeric = [...fig.querySelectorAll('svg text')].map((t) => t.textContent ?? '').filter((t) => /^-?[\d.,]+$/.test(t));
    expect(numeric.length).toBeGreaterThan(1);
    for (const label of numeric) expect(Number.isInteger(Number(label.replace(/,/g, ''))), label).toBe(true);
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
