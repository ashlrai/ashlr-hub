import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JevKindStats } from '../../../../core/decide/types.js';
import { JevLatencyChart } from './JevLatencyChart.js';

function kind(over: Partial<JevKindStats> = {}): JevKindStats {
  return { kind: 'engine-error', decisions: 40, jev: 30, fallback: 10, cached: 25, calls: 3,
    avgConfidence: 0.9, fallbackRate: 0.25, estCostUsd: null, avgLatencyMs: 1234,
    topFallbackReasons: [], ...over };
}

function table() {
  fireEvent.keyDown(screen.getByRole('figure', { name: 'Jev response time today' }), { key: 't' });
  return screen.getByRole('table', { name: 'Jev response time today by decision kind' });
}

describe('JevLatencyChart', () => {
  it('shows recorded call samples, not decisions or cache hits, with a keyboard table twin', () => {
    render(<JevLatencyChart byKind={[kind()]} />);
    expect(screen.getByRole('img', { name: 'engine-error · 3 calls: 1.2 s' })).toBeInTheDocument();
    expect(screen.getByText(/Cached decisions are excluded; batched questions count as one call/)).toBeInTheDocument();
    const twin = table();
    expect(within(twin).getByRole('row', { name: 'engine-error 3 1.2 s' })).toBeInTheDocument();
    expect(twin.textContent).not.toContain('40');
    expect(twin.textContent).not.toContain('25');
  });

  it('retains a genuine measured zero and keeps no-call and unknown rows distinct', () => {
    render(<JevLatencyChart byKind={[kind({ avgLatencyMs: 0 }), kind({ kind: 'operator-intent', calls: 0, avgLatencyMs: null }),
      kind({ kind: 'completion-claim', calls: 2, avgLatencyMs: null })]} />);
    expect(screen.getByRole('img', { name: 'engine-error · 3 calls: 0 ms' })).toBeInTheDocument();
    const twin = table();
    expect(within(twin).getByRole('row', { name: 'engine-error 3 0 ms' })).toBeInTheDocument();
    expect(within(twin).getByRole('row', { name: 'operator-intent 0 No calls' })).toBeInTheDocument();
    expect(within(twin).getByRole('row', { name: 'completion-claim 2 Not measured' })).toBeInTheDocument();
  });

  it.each([{ byKind: [] }, { byKind: [kind({ calls: 0, avgLatencyMs: null })] }])('does not draw empty axes for a known no-call day', ({ byKind }) => {
    render(<JevLatencyChart byKind={byKind} />);
    expect(screen.getByText('No Jev calls recorded today.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it.each([
    kind({ avgLatencyMs: null }), kind({ avgLatencyMs: NaN }), kind({ avgLatencyMs: Infinity }),
    kind({ avgLatencyMs: -1 }), kind({ calls: 0, avgLatencyMs: 20 }), kind({ calls: -1 }),
    kind({ calls: 1.5 }), kind({ calls: Number.MAX_SAFE_INTEGER + 1 }), kind({ calls: undefined } as never),
  ])('does not invent zero from unavailable or inconsistent timing: %j', (row) => {
    render(<JevLatencyChart byKind={[row]} />);
    expect(screen.getByText(/Unknown — recorded call counts or timing/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps a malformed sample count unknown alongside a usable measurement', () => {
    render(<JevLatencyChart byKind={[kind(), kind({ kind: 'operator-intent', calls: NaN })]} />);
    expect(within(table()).getByRole('row', { name: 'operator-intent Unknown Not measured' })).toBeInTheDocument();
  });
});
