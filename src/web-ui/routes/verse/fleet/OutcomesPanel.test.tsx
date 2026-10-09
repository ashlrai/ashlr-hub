import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { OutcomesPanel } from './OutcomesPanel.js';
import type { OutcomesRead, OutcomeView } from './outcomes-types.js';

const token = 'b'.repeat(64);
const repo = '/repo/ashlr-hub';
function outcome(): OutcomeView {
  return { id: 'outcome-test', revision: 1, scopeRevision: 1, status: 'waiting-plan', tasks: [],
    scope: { desiredOutcome: 'Improve the workbench', targetRepos: [repo], acceptance: ['Useful change tested and shipped'] } };
}
function residentManager(): NonNullable<OutcomeView['manager']> {
  return { sourceState: 'healthy', enabled: true, mode: 'resident', sessionId: null, conversationRevision: 0, running: null, next: null, latest: null };
}
function fixture(rows: OutcomeView[] = [], failure?: number, unknown = false) {
  let value: OutcomesRead = { v: 1, sourceState: unknown ? 'degraded' : 'healthy', outcomes: unknown ? null : rows,
    enrollment: { sourceState: 'healthy', repos: [repo] } };
  const posts: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body, headers: new Headers(init.headers) });
      if (failure) return Response.json({ error: failure === 409 ? 'This outcome changed. Refresh before saving.' : 'Outcome storage unavailable.' }, { status: failure });
      const current = value.outcomes?.find(row => path.includes(row.id)) ?? outcome();
      const next: OutcomeView = { ...current, id: String(body.id ?? current.id), revision: Number(body.expectedRevision) + 1,
        scope: body.scope as OutcomeView['scope'] ?? current.scope, status: path.endsWith('/pause') ? 'paused' : 'waiting-plan',
        ...(path.endsWith('/manager-configure') ? { manager: residentManager() } : {}) };
      value = { ...value, outcomes: [...(value.outcomes ?? []).filter(row => row.id !== next.id), next] };
      return Response.json({ ok: true, disposition: 'recorded', outcome: next });
    }
    return Response.json(value);
  });
  vi.stubGlobal('fetch', fetch);
  return { posts, fetch, set: (next: OutcomesRead) => { value = next; } };
}
function Host() {
  const actions = useSurfaceActions();
  return <><OutcomesPanel actions={actions} /><ActionStatus actions={actions} />{actions.dialogs}</>;
}
beforeEach(() => { evictAll(); clearMutationToken(); localStorage.clear(); setMutationToken(token); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New outcome' }));
  await user.type(screen.getByLabelText('Desired outcome'), 'Make the sidebar faster');
  await user.click(screen.getByRole('checkbox', { name: repo }));
  await user.type(screen.getByLabelText('How will we know it worked?'), 'Cold sidebar loads promptly\nRegression test passes');
}

describe('Work for me outcome editor', () => {
  it('starts a desired outcome once using exact repositories and no resource/model selector', async () => {
    const { posts } = fixture();
    const user = userEvent.setup(); render(<Host />);
    await screen.findByText('No saved outcomes. Start with the result you want to achieve.');
    await fill(user);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start outcome' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.path).toBe('/api/verse/outcomes/start');
    expect(posts[0]!.headers.get('x-ashlr-token')).toBe(token);
    expect(posts[0]!.body).toEqual({ id: expect.stringMatching(/^outcome-/), commandId: expect.any(String), expectedRevision: 0,
      scope: { desiredOutcome: 'Make the sidebar faster', targetRepos: [repo], acceptance: ['Cold sidebar loads promptly', 'Regression test passes'] } });
    expect(await screen.findByText('Waiting for a plan')).toBeInTheDocument();
    expect(screen.queryByText('Plan verified')).not.toBeInTheDocument();
  });
  it('keeps an uncertain first creation draft and reuses the command on retry', async () => {
    const { posts } = fixture([], 503);
    const user = userEvent.setup(); render(<Host />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Start outcome' }));
    await screen.findByText('Outcome storage unavailable.');
    expect(screen.getByLabelText('Desired outcome')).toHaveValue('Make the sidebar faster');
    await user.click(screen.getByRole('button', { name: 'Start outcome' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).toEqual(posts[0]!.body);
  });
  it('retains an edit conflict and requires explicit revision adoption without overwriting the draft', async () => {
    const { posts, set } = fixture([outcome()], 409);
    const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Improve the workbench'));
    await user.click(screen.getByRole('button', { name: 'Edit outcome' }));
    await user.type(screen.getByLabelText('Desired outcome'), ' further');
    await user.click(screen.getByRole('button', { name: 'Save outcome' }));
    await screen.findByText('This outcome changed. Refresh before saving.');
    set({ v: 1, sourceState: 'healthy', outcomes: [{ ...outcome(), revision: 2 }], enrollment: { sourceState: 'healthy', repos: [repo] } });
    await user.click(screen.getByRole('button', { name: 'Refresh outcomes' }));
    await user.click(await screen.findByRole('button', { name: 'Use latest revision' }));
    expect(screen.getByLabelText('Desired outcome')).toHaveValue('Improve the workbench further');
    await user.click(screen.getByRole('button', { name: 'Save outcome' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.map(post => post.body.expectedRevision)).toEqual([1, 2]);
    expect(posts[1]!.body.commandId).not.toBe(posts[0]!.body.commandId);
  });
  it('pauses and resumes with the observed revision and describes the external-session boundary', async () => {
    const { posts } = fixture([outcome()]);
    const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Improve the workbench'));
    expect(screen.getByText('Pause stops new requests and asks running work to stop. External provider jobs may continue until cancellation is confirmed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pause outcome' }));
    await user.click(await screen.findByRole('button', { name: 'Resume outcome' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.map(post => post.path)).toEqual(['/api/verse/outcomes/outcome-test/pause', '/api/verse/outcomes/outcome-test/resume']);
    expect(posts.map(post => post.body.expectedRevision)).toEqual([1, 2]);
  });
  it('keeps incomplete history unknown and does not show an empty-success state', async () => {
    const { posts } = fixture([], undefined, true); render(<Host />);
    await screen.findByText('Outcome history is incomplete. Current work and completion are unknown.');
    expect(screen.queryByText(/No saved outcomes/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New outcome' })).toBeDisabled();
    expect(posts).toEqual([]);
  });
  it('requires mutation unlock before posting an outcome', async () => {
    const { posts } = fixture(); clearMutationToken();
    const user = userEvent.setup(); render(<Host />);
    await fill(user); await user.click(screen.getByRole('button', { name: 'Start outcome' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();
    expect(posts).toEqual([]);
  });
  it('labels verified tasks as a verified plan while keeping global acceptance visible', async () => {
    fixture([{ ...outcome(), status: 'plan-verified', tasks: [{ id: `task-${Array(8).fill('aaaaaaaa').join('.')}`, key: 'a', title: 'Improve sidebar', repo,
      state: 'complete', runId: 'run-child', controllerRunId: 'run-controller', proposalId: 'proposal-1', mergeIdentity: 'merge-1' }] }]);
    const user = userEvent.setup(); render(<Host />);
    expect(await screen.findByText('Plan verified')).toBeInTheDocument();
    await user.click(screen.getByText('Improve the workbench'));
    expect(screen.getByText('Useful change tested and shipped')).toBeInTheDocument();
    expect(screen.getByText('Verified merge merge-1')).toBeInTheDocument();
    expect(screen.getByText('Run run-child')).toBeInTheDocument();
    expect(screen.getByText('Controller run run-controller')).toBeInTheDocument();
    expect(screen.queryByText('Outcome achieved')).not.toBeInTheDocument();
  });
  it('opens context for the exact admitted task on demand without a mutation', async () => {
    const taskId = `task-${Array(8).fill('aaaaaaaa').join('.')}`;
    const row = { ...outcome(), tasks: [{ id: taskId, key: 'a', title: 'Improve sidebar', repo, state: 'pending' as const, runId: null, controllerRunId: null, proposalId: null, mergeIdentity: null }] };
    const path = `/api/verse/outcomes/outcome-test/tasks/${taskId}/context`;
    const fetch = vi.fn(async (input: RequestInfo | URL) => String(input) === path ? Response.json({ schemaVersion: 1,
      outcomeId: 'outcome-test', taskId, taskRef: `outcome:outcome-test:node:${taskId}`, outcomeRevision: 1, active: true,
      snapshotObservedAt: '2026-10-09T09:00:00.000Z', metadataTemporalScope: 'current-read',
      asOf: '2026-10-09T09:00:00.000Z', observedThrough: '2026-10-09T09:00:00.000Z',
      coverage: { sourceState: 'missing', complete: false, stopReasons: ['missing-source'] }, current: [], history: [], conflicts: [],
      sources: [{ source: 'private-task-context', sourceState: 'missing', complete: false, stopReasons: ['missing-source'] }] })
      : Response.json({ v: 1, sourceState: 'healthy', outcomes: [row], enrollment: { sourceState: 'healthy', repos: [repo] } }));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Improve the workbench'));
    expect(fetch.mock.calls.some(call => String(call[0]) === path)).toBe(false);
    await user.click(screen.getByRole('button', { name: 'View task context' }));
    await screen.findByText('No current records available; coverage is incomplete.');
    expect(fetch.mock.calls.filter(call => String(call[0]) === path)).toHaveLength(1);
  });
  it('handles an old or malformed server as unavailable without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ outcomes: [{}] })));
    render(<Host />);
    expect(await screen.findByText('Outcome records are unavailable. Refresh to reconnect.')).toBeInTheDocument();
  });
});


describe('Work for me resident manager', () => {
  it('explicitly enables the manager using the current revision and fixed resident association', async () => {
    const { posts } = fixture([{ ...outcome(), revision: 7 }]); const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Improve the workbench'));
    await user.click(screen.getByRole('button', { name: 'Enable manager' }));
    expect(await screen.findByText('Manager idle')).toBeInTheDocument();
    expect(posts).toHaveLength(1); expect(posts[0]!.path).toBe('/api/verse/outcomes/outcome-test/manager-configure');
    expect(posts[0]!.headers.get('x-ashlr-token')).toBe(token);
    expect(posts[0]!.body).toEqual({ commandId: expect.any(String), expectedRevision: 7, mode: 'resident', sessionId: null });
    expect(screen.queryByRole('button', { name: 'Enable manager' })).not.toBeInTheDocument();
    expect(screen.queryByText('Outcome achieved')).not.toBeInTheDocument();
  });
  it('retains the configure identity and revision across uncertain responses and an intervening refresh', async () => {
    const { posts, set } = fixture([outcome()], 503); const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Improve the workbench'));
    await user.click(screen.getByRole('button', { name: 'Enable manager' }));
    await screen.findByText('Outcome storage unavailable.');
    set({ v: 1, sourceState: 'healthy', outcomes: [{ ...outcome(), revision: 2 }], enrollment: { sourceState: 'healthy', repos: [repo] } });
    await user.click(screen.getByRole('button', { name: 'Refresh outcomes' }));
    await screen.findByText('Revision 2 · 1 repositories');
    await user.click(screen.getByRole('button', { name: 'Enable manager' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    await user.click(screen.getByRole('button', { name: 'Use current manager revision' }));
    await user.click(screen.getByRole('button', { name: 'Enable manager' }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]!.body.expectedRevision).toBe(2);
    expect(posts[2]!.body.commandId).not.toBe(posts[0]!.body.commandId);
  });
  it('requires resume before enabling and retains ordinary outcome pause semantics', async () => {
    const { posts } = fixture([{ ...outcome(), status: 'paused' }]); const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Improve the workbench'));
    expect(screen.getByRole('button', { name: 'Enable manager' })).toBeDisabled();
    expect(screen.getByText('Resume this outcome before enabling its manager.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume outcome' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable manager' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Enable manager' }));
    await screen.findByText('Manager idle');
    expect(posts.map(post => post.path)).toEqual(['/api/verse/outcomes/outcome-test/resume', '/api/verse/outcomes/outcome-test/manager-configure']);
    expect(posts.map(post => post.body.expectedRevision)).toEqual([1, 2]);
  });
  it('shows actual captured route and manager intent without treating planning as completion', async () => {
    const running = { intent: 'replan', state: 'running', route: { engine: 'codex', tier: 'frontier', model: 'gpt-6.1-sol', seatId: 'codex:cofounder' } } as NonNullable<NonNullable<OutcomeView['manager']>['running']>;
    fixture([{ ...outcome(), manager: { ...residentManager(), running } }]); const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Improve the workbench'));
    expect(screen.getByText('Manager replanning')).toBeInTheDocument();
    expect(screen.getByText('Recorded route: Codex · gpt-6.1-sol')).toBeInTheDocument();
    expect(screen.queryByText(/codex:cofounder/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable manager' })).not.toBeInTheDocument();
    expect(screen.queryByText('Plan verified')).not.toBeInTheDocument();
  });
  it('keeps an interactive association linked to its conversation instead of offering conversion', async () => {
    const { posts } = fixture([{ ...outcome(), manager: { ...residentManager(), mode: 'interactive', sessionId: 'chat-1', conversationRevision: 1 } }]);
    const user = userEvent.setup(); render(<Host />); await user.click(await screen.findByText('Improve the workbench'));
    expect(screen.getByText('Chat manager idle')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable manager' })).not.toBeInTheDocument(); expect(posts).toEqual([]);
  });
  it('requires current mutation unlock to enable a manager', async () => {
    const { posts } = fixture([outcome()]); clearMutationToken(); const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Improve the workbench')); await user.click(screen.getByRole('button', { name: 'Enable manager' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument(); expect(posts).toEqual([]);
  });
  it('rejects malformed manager data rather than displaying a fabricated ready state', async () => {
    fixture([{ ...outcome(), manager: { ...residentManager(), mode: 'unsupported' } as unknown as NonNullable<OutcomeView['manager']> }]); render(<Host />);
    await screen.findByText('Outcome records are unavailable. Refresh to reconnect.');
    expect(screen.queryByRole('button', { name: 'Enable manager' })).not.toBeInTheDocument();
  });
  it('does not accept a configure response that omitted the saved manager', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ ok: true, disposition: 'recorded', outcome: { ...outcome(), revision: 2 } })
      : Response.json({ v: 1, sourceState: 'healthy', outcomes: [outcome()], enrollment: { sourceState: 'healthy', repos: [repo] } }));
    vi.stubGlobal('fetch', fetch); const user = userEvent.setup(); render(<Host />);
    await user.click(await screen.findByText('Improve the workbench')); await user.click(screen.getByRole('button', { name: 'Enable manager' }));
    await screen.findByText('The outcome write could not be confirmed. Refresh and retry with the same command.');
    expect(screen.queryByText('Manager idle')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Enable manager' })).toBeEnabled();
  });
});


it('enables a valid outcome whose ID matches an inherited object property', async () => {
  const { posts } = fixture([{ ...outcome(), id: 'constructor', revision: 4 }]); const user = userEvent.setup(); render(<Host />);
  await user.click(await screen.findByText('Improve the workbench')); await user.click(screen.getByRole('button', { name: 'Enable manager' }));
  await screen.findByText('Manager idle');
  expect(posts[0]!.path).toBe('/api/verse/outcomes/constructor/manager-configure');
  expect(posts[0]!.body).toEqual({ commandId: expect.any(String), expectedRevision: 4, mode: 'resident', sessionId: null });
});
