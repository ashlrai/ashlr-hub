import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { EngineeringObjectiveComposer } from './EngineeringObjectiveComposer.js';
import { WorkspaceEngineering } from './WorkspaceEngineering.js';
import { preparationPlan, preparationProfile, preparationResult } from './preparation-fixture.test-support.js';
import { engineeringJob, engineeringReadiness } from './engineering-fixture.test-support.js';
import type { ResourceConsoleEngineeringObjective as Objective, ResourceConsoleEngineeringObjectivePrepared as Prepared } from '../../../core/resources/console-engineering-preparation-types.js';

const token = 'a'.repeat(64);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function props() { return { projectId: 'default', available: true, unlocked: true, onUnlock: vi.fn(), onPrepared: vi.fn(), onRefresh: vi.fn() }; }
function transport() {
  let prepared: Prepared | null = null;
  const request = vi.fn(async (path: string, options?: RequestInit): Promise<Response> => {
    if (path === '/api/resources/engineering/profiles') return json({ profiles: [preparationProfile(JSON.parse(String(options?.body)).projectId)] });
    if (path === '/api/resources/engineering/prepare/check') return json(preparationPlan(JSON.parse(String(options?.body)) as Objective));
    if (path === '/api/resources/engineering/prepare') {
      const { expectedPlanDigest: _digest, ...input } = JSON.parse(String(options?.body)) as Objective & { expectedPlanDigest: string };
      prepared = preparationResult(preparationPlan(input)); return json(prepared);
    }
    if (path === '/api/resources/engineering') return json(prepared ? [prepared.enrollment] : []);
    if (prepared && path === `/api/resources/engineering/${prepared.enrollment.id}/readiness`) return json(engineeringReadiness(prepared.enrollment));
    if (prepared && (path === `/api/resources/engineering/${prepared.enrollment.id}` || path === '/api/resources/engineering/start')) return json(engineeringJob(prepared.enrollment));
    throw new Error('Unexpected fixture request');
  }); vi.stubGlobal('fetch', request);
  return { request, posts: (path: string) => request.mock.calls.filter(([url]) => url === path) };
}
async function fill() {
  await screen.findByRole('option', { name: 'Reviewed parser cases' });
  await waitFor(() => expect(screen.getByLabelText('Objective name')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Objective name'), { target: { value: 'Parser correction' } });
  fireEvent.change(screen.getByLabelText('Engineering objective'), { target: { value: 'Fix escaped whitespace against the reviewed cases.' } });
}
async function check() {
  fireEvent.click(screen.getByRole('button', { name: 'Check plan' }));
  await screen.findByRole('region', { name: 'Checked objective plan' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare plan' })).toBeEnabled());
}
beforeEach(() => { setMutationToken(token); });
afterEach(() => { act(() => clearMutationToken()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('objective preparation composer', () => {
  it.each(['admitted', 'unavailable'] as const)('discloses prepare-and-queue and preserves automatic admission %s', async state => {
    const f = transport(); const original = f.request.getMockImplementation()!; const input = props();
    f.request.mockImplementation(async (path, options) => {
      const response = await original(path, options);
      if (path !== '/api/resources/engineering/prepare') return response;
      return json({ ...await response.json(), automaticAdmission: { state, supervisionId: 'fleet' } });
    });
    render(<EngineeringObjectiveComposer {...input} autoAdmission />); await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Check plan' }));
    const button = await screen.findByRole('button', { name: 'Prepare and queue' }); await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText(/Preparing also queues this plan/)).toBeInTheDocument();
    expect(screen.getByText(/This check is read-only/)).toHaveTextContent('Queued execution may create worktrees and a local delivery branch');
    expect(screen.getByText(/This check is read-only/)).toHaveTextContent('no push, merge or remote deployment is requested');
    expect(f.posts('/api/resources/engineering/prepare')).toHaveLength(0);
    fireEvent.click(button); await waitFor(() => expect(input.onPrepared).toHaveBeenCalledOnce());
    expect(screen.getByRole('status')).toHaveTextContent(state === 'admitted' ? 'Plan prepared and added to automatic work' : 'Registration is preserved');
    if (state === 'unavailable') {
      expect(screen.getByRole('status')).toHaveTextContent('If this plan was durably registered for automatic admission, the host retries within the original deadline and enrollment cap');
      expect(screen.getByRole('status')).toHaveTextContent('Unmarked registrations are not automatically queued');
      expect(screen.getByRole('status')).toHaveTextContent('a paused queue stays paused');
      expect(screen.getByRole('status')).not.toHaveTextContent('before adding or running it');
    }
    expect(screen.queryByText(/Nothing has launched/)).not.toBeInTheDocument();
    expect(f.posts('/api/resources/engineering/start')).toHaveLength(0);
    expect(f.posts('/api/resources/engineering/prepare')).toHaveLength(1);
  });
  it('invalidates a checked manual plan when automatic admission mode changes', async () => {
    transport(); const input = props(); const view = render(<EngineeringObjectiveComposer {...input} />); await fill(); await check();
    view.rerender(<EngineeringObjectiveComposer {...input} autoAdmission />);
    expect(screen.queryByRole('region', { name: 'Checked objective plan' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare and queue' })).toBeDisabled();
  });
  it('requires unlock before even loading profiles', () => {
    clearMutationToken(); const f = transport(); const input = props(); render(<EngineeringObjectiveComposer {...input} unlocked={false} />);
    expect(f.request).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Check plan' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock preparation controls' })); expect(input.onUnlock).toHaveBeenCalledOnce();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('shows fixed acceptance, pinned scope and limits before checking', async () => {
    transport(); render(<EngineeringObjectiveComposer {...props()} />); await fill();
    expect(screen.getByText(preparationProfile().acceptance)).toBeVisible(); expect(screen.getByText('src/parser.ts')).toBeVisible();
    expect(screen.getByText('test/cases.json')).toBeVisible(); expect(screen.getByText('codex-a')).toBeVisible();
    expect(screen.getByText('9,000')).toBeVisible(); expect(screen.getByRole('button', { name: 'Prepare plan' })).toBeDisabled();
  });
  it('requires explicit check then prepare and never launches or writes drafts to browser storage', async () => {
    const f = transport(); const input = props(); render(<EngineeringObjectiveComposer {...input} />); await fill(); await check();
    expect(screen.getByText(/This check is read-only/)).toHaveTextContent('Preparation registers the plan without running it');
    expect(f.posts('/api/resources/engineering/prepare')).toHaveLength(0);
    const checked = JSON.parse(String(f.posts('/api/resources/engineering/prepare/check')[0]?.[1]?.body)) as Objective;
    expect(checked.id).toMatch(/^objective-[a-f0-9-]+$/); expect(Object.keys(checked).sort()).toEqual(['id', 'name', 'objective', 'profileId']);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare plan' }));
    await waitFor(() => expect(input.onPrepared).toHaveBeenCalledOnce());
    expect(f.posts('/api/resources/engineering/prepare')).toHaveLength(1); expect(f.posts('/api/resources/engineering/start')).toHaveLength(0);
    expect(JSON.parse(String(f.posts('/api/resources/engineering/prepare')[0]?.[1]?.body))).toEqual({ ...checked, expectedPlanDigest: 'c'.repeat(64) });
    expect(screen.getByRole('status')).toHaveTextContent('Nothing has launched');
    expect(Object.values(localStorage).join('')).not.toContain(checked.objective); expect(Object.values(sessionStorage).join('')).not.toContain(checked.objective);
  });
  it('invalidates the checked plan on edits without changing the objective ID', async () => {
    const f = transport(); render(<EngineeringObjectiveComposer {...props()} />); await fill(); await check();
    const before = JSON.parse(String(f.posts('/api/resources/engineering/prepare/check')[0]?.[1]?.body)) as Objective;
    fireEvent.change(screen.getByLabelText('Engineering objective'), { target: { value: 'A different parser correction' } });
    expect(screen.queryByRole('region', { name: 'Checked objective plan' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare plan' })).toBeDisabled(); await check();
    expect(JSON.parse(String(f.posts('/api/resources/engineering/prepare/check')[1]?.[1]?.body)).id).toBe(before.id);
  });
  it('keeps the same request/digest after uncertainty and reconciles only on explicit action', async () => {
    const f = transport(); const original = f.request.getMockImplementation()!;
    let failed = false;
    f.request.mockImplementation(async (path, options) => {
      if (path === '/api/resources/engineering/prepare' && !failed) { failed = true; return json({ error: 'PRIVATE_DETAIL' }, 503); }
      return original(path, options);
    });
    render(<EngineeringObjectiveComposer {...props()} />); await fill(); await check(); fireEvent.click(screen.getByRole('button', { name: 'Prepare plan' }));
    await screen.findByRole('button', { name: 'Reconcile preparation' });
    expect(screen.getByRole('alert')).not.toHaveTextContent('PRIVATE_DETAIL'); expect(screen.getByLabelText('Engineering objective')).toBeDisabled();
    expect(f.posts('/api/resources/engineering/prepare')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile preparation' })); await screen.findByText(/Plan prepared and selected below/);
    const bodies = f.posts('/api/resources/engineering/prepare').map(([, init]) => init?.body); expect(bodies[0]).toBe(bodies[1]);
    expect(f.posts('/api/resources/engineering/start')).toHaveLength(0);
  });
  it('distinguishes uncertain registration from automatic recovery without reposting preparation', async () => {
    const f = transport(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, options) => path === '/api/resources/engineering/prepare'
      ? json({ error: 'PRIVATE_DETAIL' }, 503) : original(path, options));
    render(<EngineeringObjectiveComposer {...props()} autoAdmission />); await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Check plan' }));
    await screen.findByRole('region', { name: 'Checked objective plan' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare and queue' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare and queue' }));
    await screen.findByRole('button', { name: 'Reconcile preparation' });
    expect(screen.getByText(/Registration may not have completed/)).toHaveTextContent('the host may recover admission and run it before reconciliation');
    expect(screen.getByText(/Registration may not have completed/)).toHaveTextContent('within the original deadline and cap; a paused queue stays paused');
    expect(screen.getByRole('alert')).not.toHaveTextContent('PRIVATE_DETAIL');
    expect(f.posts('/api/resources/engineering/prepare')).toHaveLength(1);
    expect(f.posts('/api/resources/engineering/start')).toHaveLength(0);
  });
  it.each(['control', 'project', 'connection'] as const)('invalidates check across %s changes', async mode => {
    transport(); const input = props(); const view = render(<EngineeringObjectiveComposer {...input} />); await fill(); await check();
    if (mode === 'control') act(() => clearMutationToken());
    else view.rerender(<EngineeringObjectiveComposer {...input} {...(mode === 'project' ? { projectId: 'other' } : { available: false })} />);
    expect(screen.queryByRole('region', { name: 'Checked objective plan' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare plan' })).toBeDisabled();
  });
  it('discards a late preparation acknowledgment after project switch', async () => {
    const f = transport(); const original = f.request.getMockImplementation()!; let finish!: (value: Response) => void; let pending: Prepared | null = null;
    f.request.mockImplementation(async (path, options) => {
      if (path === '/api/resources/engineering/prepare') {
        const { expectedPlanDigest: _digest, ...input } = JSON.parse(String(options?.body)) as Objective & { expectedPlanDigest: string };
        pending = preparationResult(preparationPlan(input)); return new Promise(resolve => { finish = resolve; });
      }
      return original(path, options);
    });
    const input = props(); const view = render(<EngineeringObjectiveComposer {...input} />); await fill(); await check();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare plan' }));
    await waitFor(() => expect(f.posts('/api/resources/engineering/prepare')).toHaveLength(1));
    const signal = f.posts('/api/resources/engineering/prepare')[0]?.[1]?.signal;
    view.rerender(<EngineeringObjectiveComposer {...input} projectId="other" />); expect(signal?.aborted).toBe(true);
    await act(async () => finish(json(pending))); expect(input.onPrepared).not.toHaveBeenCalled();
    expect(screen.queryByText(/Plan prepared and selected below/)).not.toBeInTheDocument();
  });
  it('blocks Unicode byte overflow without checking', async () => {
    const f = transport(); render(<EngineeringObjectiveComposer {...props()} />); await fill();
    fireEvent.change(screen.getByLabelText('Objective name'), { target: { value: 'é'.repeat(61) } });
    expect(screen.getByRole('alert')).toHaveTextContent('120 UTF-8 bytes'); expect(screen.getByRole('button', { name: 'Check plan' })).toBeDisabled();
    expect(f.posts('/api/resources/engineering/prepare/check')).toHaveLength(0);
  });
  it('selects a prepared enrollment in the same engineering pane and waits for a separate Run action', async () => {
    const f = transport(); render(<WorkspaceEngineering projectId="default" projectName="Hub" available canStart canStop unlocked
      preparationSupported onUnlock={vi.fn()} />);
    await fill(); await check(); fireEvent.click(screen.getByRole('button', { name: 'Prepare plan' }));
    await screen.findByText(/Plan prepared and selected below/);
    const run = await screen.findByRole('button', { name: 'Run enrolled plan' }); await waitFor(() => expect(run).toBeEnabled());
    expect(f.posts('/api/resources/engineering/start')).toHaveLength(0);
    const preparedId = JSON.parse(String(f.posts('/api/resources/engineering/prepare')[0]?.[1]?.body)).id;
    expect(screen.getByLabelText('Enrolled engineering plan')).toHaveValue(preparedId);
    fireEvent.click(run); await waitFor(() => expect(f.posts('/api/resources/engineering/start')).toHaveLength(1));
    expect(JSON.parse(String(f.posts('/api/resources/engineering/start')[0]?.[1]?.body))).toEqual({ enrollmentId: preparedId, expectedEnrollmentDigest: 'a'.repeat(64) });
  });
});
