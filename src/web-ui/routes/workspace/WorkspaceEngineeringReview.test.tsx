import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleEngineeringEnrollment as Enrollment, ResourceConsoleEngineeringJob as Job } from '../../../core/resources/console-engineering-types.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { WorkspaceEngineering } from './WorkspaceEngineering.js';
import { engineeringReadiness } from './engineering-fixture.test-support.js';

const token = 'a'.repeat(64);
const enrollment: Enrollment = { id: 'fix', projectId: 'default', graphId: 'graph', enrollmentDigest: 'b'.repeat(64),
  objective: 'Evaluate a local correction', campaigns: [{ id: 'campaign', dependsOn: [], objective: 'Keep this literal <script>text</script>',
    branch: 'codex/review', budget: { maxTrials: 2, maxDurationMs: 60_000, trialTimeoutMs: 10_000, maxParallel: 1 },
    campaignBudget: { maxGenerations: 2, maxDurationMs: 60_000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: null } }],
  budget: { maxParallel: 1, maxDurationMs: 60_000 }, acceptanceScope: 'fixed-evaluator-and-local-branch-only' };
function job(patch: Partial<Job> = {}): Job {
  return { enrollmentId: enrollment.id, projectId: enrollment.projectId, graphId: enrollment.graphId,
    enrollmentDigest: enrollment.enrollmentDigest, state: 'ready', sourceState: 'missing', cancellable: false,
    launched: false, cancelled: false, definitionDigest: null, deadlineAt: null, nodes: [], reasons: [],
    acceptanceScope: enrollment.acceptanceScope, ...patch };
}
const props = () => ({ projectId: 'default', projectName: 'Fixture', available: true, canStart: true,
  canStop: true, unlocked: true, onUnlock: vi.fn() });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function transport(status: Job = job()) {
  const pending = deferred<Response>();
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return pending.promise;
    if (path === '/api/resources/engineering') return json([enrollment]);
    if (path === '/api/resources/engineering/fix/readiness') return json(engineeringReadiness(enrollment));
    if (path === '/api/resources/engineering/fix') return json(status);
    throw new Error(`Unexpected fixture route ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { pending, fetcher, posts: () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST') };
}
async function start() {
  const button = await screen.findByRole('button', { name: 'Run enrolled plan' });
  await vi.waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); return button;
}
beforeEach(() => { setMutationToken(token); });
afterEach(() => { act(() => clearMutationToken()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('independent engineering UI authority review', () => {
  it('gives an actionable preparation entry point without registering or launching from the empty state', async () => {
    const fetcher = vi.fn(async (_path: string) => json([])); vi.stubGlobal('fetch', fetcher);
    render(<WorkspaceEngineering {...props()} />);
    await screen.findByText('No engineering plan enrolled for this project.');
    expect(screen.getByText('ashlr resources pool engineering prepare --help')).toBeInTheDocument();
    expect(screen.getByText(/without starting work/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/resources/engineering');
  });
  it.each(['connection', 'control'])('discards a late mutation after %s loss without cancelling the owned run', async (kind) => {
    const f = transport(); const input = props(); const view = render(<WorkspaceEngineering {...input} />);
    await start(); expect(f.posts()).toHaveLength(1);
    const signal = f.posts()[0]![1]!.signal!;
    if (kind === 'control') act(() => clearMutationToken());
    view.rerender(<WorkspaceEngineering {...input} {...(kind === 'connection' ? { available: false } : { unlocked: false })} />);
    expect(signal.aborted).toBe(true);
    await act(async () => { f.pending.resolve(json(job({ state: 'running', launched: true, cancellable: true }))); });
    expect(screen.queryByText(/Request acknowledged/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Refresh evidence/);
    expect(f.posts()).toHaveLength(1); expect(f.posts()[0]![0]).toBe('/api/resources/engineering/start');
    if (kind === 'control') act(() => setMutationToken(token));
    view.rerender(<WorkspaceEngineering {...input} />);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Refresh evidence' })).toBeEnabled());
    expect(f.posts()).toHaveLength(1);
  });

  it('rejects an old-token result even when the boolean unlocked state never changes', async () => {
    const f = transport(); render(<WorkspaceEngineering {...props()} />); await start();
    act(() => setMutationToken('c'.repeat(64)));
    await act(async () => { f.pending.resolve(json(job({ state: 'running', launched: true }))); });
    expect(screen.queryByText(/Request acknowledged/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/interrupted/); expect(f.posts()).toHaveLength(1);
  });

  it('aborts a pending mutation on unmount and ignores its late response', async () => {
    const f = transport(); const view = render(<WorkspaceEngineering {...props()} />); await start();
    const signal = f.posts()[0]![1]!.signal!; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { f.pending.resolve(json(job({ state: 'running', launched: true }))); });
    expect(f.posts()).toHaveLength(1); expect(screen.queryByText(/Request acknowledged/)).not.toBeInTheDocument();
  });

  it('does not offer replay for an accepted launch with no signed graph intent', async () => {
    const f = transport(job({ state: 'incomplete', launched: true })); render(<WorkspaceEngineering {...props()} />);
    const button = await screen.findByRole('button', { name: 'Reconcile completed work' });
    expect(button).toBeDisabled(); fireEvent.click(button); expect(f.posts()).toHaveLength(0);
  });

  it('deduplicates rapid start clicks and renders objective text without markup', async () => {
    const f = transport(); const view = render(<WorkspaceEngineering {...props()} />);
    const button = await start(); fireEvent.click(button); fireEvent.click(button);
    expect(f.posts()).toHaveLength(1); expect(JSON.parse(String(f.posts()[0]![1]!.body))).toEqual({ enrollmentId: 'fix', expectedEnrollmentDigest: enrollment.enrollmentDigest });
    expect(screen.getByText('Keep this literal <script>text</script>')).toBeInTheDocument(); expect(view.container.querySelector('script')).toBeNull();
    await act(async () => { f.pending.resolve(json({ error: 'missing' }, 404)); });
    expect(screen.getByRole('alert')).toHaveTextContent(/engineering/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent('--allow-dispatch');
  });
});
