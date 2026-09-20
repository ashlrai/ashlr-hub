import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApprovalsSection } from './ApprovalsSection.js';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { BOOTSTRAP } from './section-fixtures.test-support.js';

const TOKEN = 'a'.repeat(64);

const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,3 +1,4 @@',
  ' const guard = true;',
  '+const stricter = true;',
  ' export { guard };',
].join('\n');

const OLD_PENDING = {
  id: 'p-old',
  repo: '/Users/m/code/hub',
  origin: 'backlog',
  kind: 'pr',
  title: 'Open a PR for the enrollment guard',
  summary: 'Tightens the enrollment guard and adds a regression test.',
  status: 'pending',
  createdAt: new Date(Date.now() - 7_200_000).toISOString(),
  riskClass: 'high',
  engineModel: 'codex:gpt-5.5',
  engineTier: 'frontier',
  diff: DIFF,
  producerProvenanceSig: 'redacted-never-rendered',
  producerProvenanceVersion: 2,
  diffHash: 'abc123',
  verifyResult: { passed: true, ran: [{ kind: 'typecheck', cmd: ['tsc'] }] },
};

const NEW_REJECTED = {
  id: 'p-rejected',
  repo: '/Users/m/code/site',
  origin: 'backlog',
  kind: 'patch',
  title: 'Tidy the docs',
  summary: 'Docs pass.',
  status: 'rejected',
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  riskClass: 'low',
  engineModel: 'claude:opus',
};

function listResponse(proposals: unknown[]) {
  return {
    pending: proposals.filter((p) => (p as { status: string }).status === 'pending').length,
    total: proposals.length,
    proposals,
    truncated: false,
    filters: { status: 'pending', since: null, limit: 500 },
  };
}

function stubFetch(opts: { proposals?: unknown[]; bootstrap?: unknown; approveStatus?: number } = {}) {
  const proposals = opts.proposals ?? [NEW_REJECTED, OLD_PENDING];
  const posted: { url: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST') {
        posted.push({ url });
        return new Response(opts.approveStatus === 404 ? 'not found' : JSON.stringify({ ok: true }), {
          status: opts.approveStatus ?? 200,
        });
      }
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
      if (url.startsWith('/api/verse/bootstrap')) return json(opts.bootstrap ?? BOOTSTRAP);
      const detail = proposals.find((p) => url === `/api/inbox/${(p as { id: string }).id}`);
      if (detail) return json({ ...(detail as object), decisionEvidence: { sourceQuality: { sourceState: 'healthy', complete: true }, decisions: [] } });
      if (url.startsWith('/api/inbox')) return json(listResponse(proposals));
      return new Response('not found', { status: 404 });
    }),
  );
  return { posted };
}

describe('ApprovalsSection', () => {
  beforeEach(() => {
    evictAll();
    clearMutationToken();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearMutationToken();
  });

  it('sorts pending first even when a decided proposal is newer, and shows risk, repo, engine and age', async () => {
    stubFetch({ proposals: [NEW_REJECTED, OLD_PENDING] });
    render(<ApprovalsSection />);

    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Open a PR for the enrollment guard');
    expect(rows[1]).toHaveTextContent('Tidy the docs');

    expect(within(rows[0]!).getByText('high risk')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('hub')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('codex:gpt-5.5')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('2h')).toBeInTheDocument();
    expect(screen.getByText('1 awaiting you')).toBeInTheDocument();
  });

  it('renders the diff, the verify result and provenance without ever printing a signature', async () => {
    stubFetch();
    render(<ApprovalsSection />);

    fireEvent.click(await screen.findByText('Open a PR for the enrollment guard'));

    expect(await screen.findByText('Tightens the enrollment guard and adds a regression test.')).toBeInTheDocument();
    // DiffViewer (reused from routes/inbox) parsed the unified diff.
    expect(screen.getByRole('tree', { name: 'Changed files' })).toBeInTheDocument();
    expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);
    expect(screen.getByText('passed')).toBeInTheDocument();
    expect(screen.getByText(/signed by the sandboxed producer \(v2\)/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('redacted-never-rendered');
  });

  it('requires an explicit confirm naming the repo and the kind before approving', async () => {
    const { posted } = stubFetch();
    setMutationToken(TOKEN);
    render(<ApprovalsSection />);

    fireEvent.click(await screen.findByText('Open a PR for the enrollment guard'));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve…' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Approve this pr against hub\?/)).toBeInTheDocument();
    expect(within(dialog).getByText('/Users/m/code/hub')).toBeInTheDocument();
    expect(within(dialog).getByText(/opens a real pull request/)).toBeInTheDocument();
    // Nothing has been sent on the first click.
    expect(posted).toHaveLength(0);

    // The weight goes on the IRREVERSIBLE branch. Approve pushes a branch and
    // opens a real PR; Reject only discards a proposal that stays in history.
    // It used to be the other way round, which trained the reflex that the red
    // button is the safe one.
    const approve = within(dialog).getByRole('button', { name: 'Approve and open the pull request' });
    expect(approve.className).toMatch(/destructive/);

    fireEvent.click(approve);
    await waitFor(() => expect(posted).toEqual([{ url: '/api/inbox/p-old/approve' }]));
  });

  it('does not weight Reject as the dangerous branch', async () => {
    stubFetch();
    setMutationToken(TOKEN);
    render(<ApprovalsSection />);

    fireEvent.click(await screen.findByText('Open a PR for the enrollment guard'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Reject' }).className).not.toMatch(/destructive/);
  });

  it('asks for the mutation token before the confirm when none is held', async () => {
    const { posted } = stubFetch();
    render(<ApprovalsSection />);

    fireEvent.click(await screen.findByText('Open a PR for the enrollment guard'));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve…' }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Unlock actions');
    expect(posted).toHaveLength(0);
  });

  it('renders a dispatch-less server as a read-only session and disables both decisions', async () => {
    stubFetch({ bootstrap: { ...BOOTSTRAP, dispatchEnabled: false } });
    render(<ApprovalsSection />);

    expect(await screen.findByText('Read-only session')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open a PR for the enrollment guard'));

    expect(await screen.findByRole('button', { name: 'Approve…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    // The evidence is still readable — that is the point of the mode.
    expect(screen.getByRole('tree', { name: 'Changed files' })).toBeInTheDocument();
  });

  it('turns a 404 from approve into the read-only explanation, not an error', async () => {
    stubFetch({ approveStatus: 404 });
    setMutationToken(TOKEN);
    render(<ApprovalsSection />);

    fireEvent.click(await screen.findByText('Open a PR for the enrollment guard'));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open the pull request' }));

    expect(await screen.findByText('Read-only session')).toBeInTheDocument();
  });

  it('explains an empty queue instead of showing a bare "no data"', async () => {
    stubFetch({ proposals: [] });
    render(<ApprovalsSection />);

    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
    expect(screen.getByText(/check the scope list in Autonomy/)).toBeInTheDocument();
  });

  it('offers no decision controls on an already-decided proposal', async () => {
    stubFetch({ proposals: [NEW_REJECTED] });
    render(<ApprovalsSection />);

    fireEvent.click(await screen.findByText('Tidy the docs'));

    expect(await screen.findByText(/is already/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve…' })).not.toBeInTheDocument();
  });
});
