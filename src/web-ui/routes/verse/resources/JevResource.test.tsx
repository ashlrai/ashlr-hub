/**
 * JevResource.test.tsx — the Jev card in Resources (⌘.) and the Jev panel in
 * Usage (3.15): nothing on a server without the route; "Not set up" when
 * unkeyed; today's decisions, confidence and the estimate when on.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { jevQuery } from '../jev/jev-queries.js';
import { JevResource } from './JevResource.js';
import { JevPanel } from '../jev/JevPanel.js';
import { narrowJevResponse, jevEvidenceLines, jevHeadline, formatUsd } from '../jev/jev-model.js';

let body: unknown;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function status(over: Record<string, unknown> = {}) {
  return {
    enabled: true, keyed: true, day: '2026-09-27', decisionsToday: 7, callsToday: 5, dailyCallBudget: 1500,
    inputTokensToday: 3000, outputTokensToday: 200, estCostUsdToday: 0.0019, fallbackRateToday: 2 / 7,
    avgConfidenceToday: 0.9, avgLatencyMsToday: 380, disabledKinds: [],
    byKind: [
      { kind: 'engine-error', decisions: 4, jev: 3, fallback: 1, cached: 1, calls: 3, avgConfidence: 0.93, fallbackRate: 0.25, estCostUsd: 0.0012, avgLatencyMs: 400, topFallbackReasons: [{ reason: 'below-threshold', count: 1 }] },
      { kind: 'operator-intent', decisions: 3, jev: 2, fallback: 1, cached: 0, calls: 2, avgConfidence: 0.86, fallbackRate: 1 / 3, estCostUsd: 0.0007, avgLatencyMs: 350, topFallbackReasons: [{ reason: 'escalate-only', count: 1 }] },
    ],
    ...over,
  };
}

beforeEach(() => {
  evictAll();
  body = { generatedAt: '2026-09-27T00:00:00.000Z', status: status(), kinds: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/verse/jev') return body === 404 ? json({ error: 'not found' }, 404) : json(body);
    return json({ error: 'not found' }, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JevResource', () => {
  it('renders nothing on a server without the route', async () => {
    body = 404;
    const { container } = render(<ul><JevResource /></ul>);
    await waitFor(() => expect(container.querySelector('[data-resource="jev"][data-jev="loading"]')).toBeNull());
    expect(container.querySelector('[data-resource="jev"]')).toBeNull();
  });

  it('says Not set up when unkeyed, and never asks for a key', async () => {
    body = { generatedAt: 'x', status: status({ keyed: false, decisionsToday: 0, byKind: [] }), kinds: [] };
    render(<ul><JevResource /></ul>);
    expect(await screen.findByText('Not set up')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows today\'s decisions, confidence and the estimate when on', async () => {
    body = { generatedAt: '2026-09-27T00:00:00.000Z', status: status({ callsToday: 5912, dailyCallBudget: 129744,
      byKind: [{ ...status().byKind[0], decisions: 129744, jev: 5912 }] }), kinds: [] };
    const original = structuredClone(body);
    const { container } = render(<ul><JevResource /></ul>);
    expect(await screen.findByText('Configured')).toBeTruthy();
    expect(container.querySelector('[data-jev-today]')?.textContent).toBe('7 decisions · 5,900 calls · 29% fell back');
    expect(container.querySelector('[data-jev-kind="engine-error"]')?.textContent).toBe('engine-error: 130K · 5.9K by Jev · conf 0.93');
    expect(screen.getByText(/5.9K of 130K API call attempts today/)).toBeInTheDocument();
    expect(screen.getByText('phm jev status')).toBeInTheDocument();
    expect(body).toEqual(original);
    expect(screen.getByText('estimate')).toBeTruthy();
  });

  it('shows unknown cost and actual cached/call provenance without implying a live connection', async () => {
    body = { generatedAt: '2026-10-01T12:00:00.000Z', status: status({ dailyCallBudget: null, estCostUsdToday: null,
      lastSuccessfulCallAt: null, costCoverage: { pricedCalls: 3, unknownCalls: 2, source: 'recorded-estimates' },
      usageCoverage: { reportedCalls: 3, unknownCalls: 2 }, inputTokensToday: null, outputTokensToday: null }), kinds: [] };
    const { container } = render(<ul><JevResource /></ul>);
    await screen.findByText('Configured');
    expect(screen.getByText(/1 cached decisions · 2 deterministic fallbacks/)).toBeInTheDocument();
    expect(screen.getByText(/No successful Jev call recorded/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated cost unknown · 3 recorded cost estimates · 2 calls with unknown cost/)).toBeInTheDocument();
    expect(screen.getByText(/5 API call attempts today · no call-count preference/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('$0');
    expect(container.querySelector('button,input,select')).toBeNull();
  });
});

describe('JevPanel', () => {
  it('tabulates decisions by kind', async () => {
    body = { generatedAt: '2026-09-27T00:00:00.000Z', status: status({
      byKind: [status().byKind[0], { ...status().byKind[1], decisions: 129744, jev: 5912,
        topFallbackReasons: [{ reason: 'escalate-only', count: 5912 }] }] }), kinds: [] };
    const original = structuredClone(body);
    const { container } = render(<JevPanel />);
    await screen.findByText('Jev decisions');
    const row = container.querySelector('[data-jev-kind="operator-intent"]');
    expect(row?.querySelectorAll('td')[1]?.textContent).toBe('130K');
    expect(row?.querySelectorAll('td')[2]?.textContent).toBe('5.9K');
    expect(row?.querySelector('td')?.title).toBe('escalate-only ×5.9K');
    expect(body).toEqual(original);
    expect(row?.textContent).toContain('33%');
    expect(row?.textContent).toContain('0.86');
    expect(screen.getByRole('figure', { name: 'Jev response time today' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'operator-intent · 2 calls: 350 ms' })).toBeInTheDocument();
  });

  it('retains measured history when a refresh fails rather than drawing a zero', async () => {
    render(<JevPanel />);
    await screen.findByRole('figure', { name: 'Jev response time today' });
    vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'read session expired' }, 401));
    await act(async () => { await refetchQuery(jevQuery.key, () => jevQuery.fetch(), true); });
    expect(screen.getByText('Refresh unavailable · showing the last snapshot.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'engine-error · 3 calls: 400 ms' })).toBeInTheDocument();
  });

  it('keeps an unavailable server route absent and an unrecognized response explicit', async () => {
    body = 404;
    const first = render(<JevPanel />);
    await act(async () => { await refetchQuery(jevQuery.key, () => jevQuery.fetch(), true); });
    expect(screen.queryByRole('figure')).toBeNull();
    first.unmount();
    evictAll();
    body = { generatedAt: 'x', status: status({ callsToday: 'many' }), kinds: [] };
    render(<JevPanel />);
    expect(await screen.findByText(/Unrecognized response — update Phantom/)).toBeInTheDocument();
    expect(screen.queryByRole('figure')).toBeNull();
  });

});

describe('jev-model', () => {
  it('narrows strictly', () => {
    expect(narrowJevResponse({ generatedAt: 'x', status: status(), kinds: [] })).not.toBeNull();
    expect(narrowJevResponse({ generatedAt: 'x', status: { ...status(), callsToday: 'many' }, kinds: [] })).toBeNull();
    expect(narrowJevResponse(null)).toBeNull();
  });

  it('headline and money', () => {
    expect(jevHeadline(status({ enabled: false, disabledBy: 'ASHLR_JEV_DISABLE is set' }) as never).word).toBe('Off');
    expect(jevHeadline(status({ callsToday: 1500 }) as never).word).toBe('Budget spent');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.004)).toBe('$0.004');
    expect(formatUsd(1.234)).toBe('$1.2');
    expect(formatUsd(null)).toBe('unknown');
    expect(formatUsd(NaN)).toBe('unknown');
    expect(jevHeadline(status({ dailyCallBudget: null, callsToday: 1501 }) as never).word).toBe('Configured');
  });

  it('qualifies successful history separately from configuration and keeps old-server coverage unknown', () => {
    expect(jevEvidenceLines(status({ lastSuccessfulCallAt: '2026-10-01T01:00:00.000Z' }) as never).join(' ')).toMatch(/Historical evidence, not a live connection check/);
    expect(jevEvidenceLines(status() as never).join(' ')).toMatch(/Successful-call history unavailable.*price coverage unavailable/);
    expect(narrowJevResponse({ generatedAt: 'x', status: status({ dailyCallBudget: null, estCostUsdToday: null,
      byKind: [{ ...status().byKind[0], estCostUsd: null }] }), kinds: [] })).not.toBeNull();
  });
});
