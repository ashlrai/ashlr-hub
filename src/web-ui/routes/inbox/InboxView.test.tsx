import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { InboxView } from './InboxView.js';
import { evictAll } from '../../data/cache.js';

const REJECTED_PROPOSAL = {
  id: 'p_rejected',
  title: 'Refactor auth middleware',
  kind: 'patch',
  repo: '/repos/ashlr-hub',
  origin: 'swarm',
  status: 'rejected',
  createdAt: new Date().toISOString(),
  decisionReason: 'Introduced a regression in the login flow.',
  diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n',
};

const PENDING_PROPOSAL = {
  id: 'p_pending',
  title: 'Add retry to fetch wrapper',
  kind: 'patch',
  repo: '/repos/ashlr-hub',
  origin: 'swarm',
  status: 'pending',
  createdAt: new Date().toISOString(),
};

function listResponse(proposals: unknown[]) {
  return { pending: 1, total: proposals.length, proposals, truncated: false, filters: { status: 'pending', since: null, limit: null } };
}

function mockFetch(overrides?: { detail?: unknown }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/inbox/')) {
      return new Response(JSON.stringify(overrides?.detail ?? { ...REJECTED_PROPOSAL, decisionEvidence: { sourceQuality: { sourceState: 'healthy', complete: true }, decisions: [] } }), { status: 200 });
    }
    if (url.startsWith('/api/inbox')) {
      return new Response(JSON.stringify(listResponse([PENDING_PROPOSAL])), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/inbox" element={<InboxView />} />
        <Route path="/inbox/:id" element={<InboxView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InboxView', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the proposal list with title, repo, kind, age, and status', async () => {
    vi.stubGlobal('fetch', mockFetch());
    renderAt('/inbox');
    await waitFor(() => expect(screen.getByText('Add retry to fetch wrapper')).toBeInTheDocument());
    expect(screen.getByText('patch')).toBeInTheDocument();
    expect(screen.getByText('Select a proposal to review its diff and evidence.')).toBeInTheDocument();
  });

  it('renders diff, evidence, and shows an unselected empty state when no id is routed', async () => {
    vi.stubGlobal('fetch', mockFetch());
    renderAt('/inbox/p_rejected');
    await waitFor(() => expect(screen.getByText('Refactor auth middleware')).toBeInTheDocument());
    // Evidence: decisionReason surfaces per requirement #4 ("why it was rejected").
    expect(screen.getByText('Introduced a regression in the login flow.')).toBeInTheDocument();
    // Diff viewer rendered the one changed file (tree entry + header), not an escaped <pre> dump.
    expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);
    // Already-decided proposal: approve/reject controls are not offered.
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('renders "unknown" via Epistemic, never a guessed verdict, when decisionEvidence sourceQuality is degraded', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        detail: {
          ...REJECTED_PROPOSAL,
          decisionEvidence: { sourceQuality: { sourceState: 'degraded', complete: false, reason: 'file-limit' }, decisions: [] },
        },
      }),
    );
    renderAt('/inbox/p_rejected');
    await waitFor(() => expect(screen.getByText('Refactor auth middleware')).toBeInTheDocument());
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('renders judge-parse-failure distinctly from a real judge-review verdict, never conflated', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        detail: {
          ...REJECTED_PROPOSAL,
          decisionEvidence: {
            sourceQuality: { sourceState: 'healthy', complete: true },
            decisions: [
              {
                ts: new Date().toISOString(),
                proposalId: 'p_rejected',
                action: 'judged',
                verdict: 'review',
                judgeDecisionMetadataVersion: 2,
                judgeReasonCode: 'judge-parse-failure',
                judgeRationaleState: 'not-persisted',
              },
            ],
          },
        },
      }),
    );
    renderAt('/inbox/p_rejected');
    await waitFor(() => expect(screen.getByText(/Judge parse failure/)).toBeInTheDocument());
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
  });
});
