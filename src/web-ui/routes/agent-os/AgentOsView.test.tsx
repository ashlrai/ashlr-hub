import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { evictAll } from '../../data/cache.js';
import type { AgentOsSnapshotResponse } from '../../data/api-types.js';
import { AgentOsView } from './AgentOsView.js';

const SNAPSHOT = {
  sourceState: 'healthy' as const,
  livingEndState: {
    northStar: 'Convert verified engineering intelligence into retained customer value.',
    currentBottleneck: 'Outcome evidence is incomplete.',
    revisionLabel: 'Vision v1',
    evidenceState: 'complete' as const,
  },
  capabilitySpectrum: [{
    lane: 'codex' as const,
    label: 'Codex',
    state: 'ready' as const,
    headroom: 'usable' as const,
    resetUrgency: 'soon' as const,
    resetLabel: 'Reset window verified',
    allocationLabel: 'One value bet ready',
  }],
  activeValueBets: [{
    key: 'verified-bet',
    title: 'Verified value bet',
    valueCase: 'Acceptance contract and outcome window are bound.',
    allocationLabel: 'Bound allocation',
    decision: 'continue' as const,
    assurance: 'targeted' as const,
    outcome: { state: 'pending' as const, label: 'Observation window open' },
    evidence: { state: 'complete' as const, label: 'Preverified' },
  }],
  nextAction: {
    kind: 'attention' as const,
    title: 'Collect the next outcome observation',
    reason: 'The bound observation window remains open.',
    evidenceState: 'complete' as const,
  },
};

function response(overrides: Partial<AgentOsSnapshotResponse> = {}): AgentOsSnapshotResponse {
  return {
    sourceState: 'healthy',
    complete: true,
    reason: null,
    snapshot: SNAPSHOT,
    authentication: 'authenticated',
    authority: 'observation-only',
    sameUserTamperResistant: false,
    rollbackProtected: false,
    historicalAuthority: false,
    executionAuthority: false,
    proposalAuthority: false,
    mergeAuthority: false,
    deployAuthority: false,
    publicationAuthority: false,
    externalMutationAuthority: false,
    ...overrides,
  };
}

function mockFetch(body: AgentOsSnapshotResponse, status = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/agent-os') return new Response(JSON.stringify(body), { status });
    return new Response('not found', { status: 404 });
  });
}

describe('AgentOsView', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());

  it('queries the read-only endpoint and mounts the cockpit only for complete authenticated evidence', async () => {
    const fetch = mockFetch(response());
    vi.stubGlobal('fetch', fetch);
    render(<MemoryRouter><AgentOsView /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Verified value bet')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith('/api/agent-os', expect.objectContaining({
      method: 'GET',
      signal: expect.any(AbortSignal),
    }));
    expect(screen.getByText('Outcome evidence is incomplete.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders an explicit missing state without inventing cockpit values', async () => {
    vi.stubGlobal('fetch', mockFetch(response({
      sourceState: 'missing',
      complete: false,
      reason: 'snapshot-store-missing',
      snapshot: null,
      authentication: 'unavailable',
    })));
    render(<MemoryRouter><AgentOsView /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('No Agent OS snapshot yet')).toBeInTheDocument());
    expect(screen.getByText('snapshot-store-missing')).toBeInTheDocument();
    expect(screen.queryByText('Verified value bet')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Capability spectrum' })).not.toBeInTheDocument();
  });

  it.each([
    ['degraded chain', response({ sourceState: 'degraded', complete: false, reason: 'broken-predecessor' })],
    ['invalid authentication', response({ authentication: 'invalid', reason: 'invalid-file' })],
    ['unexpected authority', { ...response(), executionAuthority: true } as unknown as AgentOsSnapshotResponse],
    ['unsupported tamper claim', { ...response(), sameUserTamperResistant: true } as unknown as AgentOsSnapshotResponse],
  ])('withholds the cockpit for %s', async (_label, body) => {
    vi.stubGlobal('fetch', mockFetch(body));
    render(<MemoryRouter><AgentOsView /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Agent OS snapshot degraded')).toBeInTheDocument());
    expect(screen.queryByText('Verified value bet')).not.toBeInTheDocument();
    expect(screen.getByText(/cockpit remains hidden/i)).toBeInTheDocument();
  });

  it('renders transport failure as unknown and does not synthesize a snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 503 })));
    render(<MemoryRouter><AgentOsView /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/No capability, value, or next-action values are inferred/)).toBeInTheDocument();
    expect(screen.queryByText('Verified value bet')).not.toBeInTheDocument();
  });
});
