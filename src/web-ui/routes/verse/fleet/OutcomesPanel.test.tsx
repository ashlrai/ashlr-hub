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
        scope: body.scope as OutcomeView['scope'] ?? current.scope, status: path.endsWith('/pause') ? 'paused' : 'waiting-plan' };
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
    fixture([{ ...outcome(), status: 'plan-verified', tasks: [{ key: 'a', title: 'Improve sidebar', repo,
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
  it('handles an old or malformed server as unavailable without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ outcomes: [{}] })));
    render(<Host />);
    expect(await screen.findByText('Outcome records are unavailable. Refresh to reconnect.')).toBeInTheDocument();
  });
});
