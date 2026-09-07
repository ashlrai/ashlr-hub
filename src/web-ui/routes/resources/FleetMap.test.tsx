import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import { FleetMap } from './FleetMap.js';
import { resourceFixture } from './fixtures.test-support.js';

function mount(snapshot = resourceFixture().snapshot, overrides: Partial<Parameters<typeof FleetMap>[0]> = {}) {
  const onSelect = vi.fn();
  return { ...render(<FleetMap snapshot={snapshot} stale={false} selection={null} onSelect={onSelect} {...overrides} />), onSelect };
}
function largeFixture() {
  const snapshot = resourceFixture().snapshot;
  const worker = snapshot.pool.workers[2]!;
  const group = snapshot.groups[1]!;
  snapshot.pool.workers = Array.from({ length: 32 }, (_, index) => ({ ...worker, id: `local-${String(index).padStart(2, '0')}`, capacityKey: `machine-${Math.floor(index / 2)}`, model: `coder-${index}` }));
  snapshot.groups = Array.from({ length: 16 }, (_, index) => ({ ...group, capacityKey: `machine-${index}`, occupiedSlots: 0, reservedCount: 0,
    workerIds: [`local-${String(index * 2).padStart(2, '0')}`, `local-${String(index * 2 + 1).padStart(2, '0')}`] }));
  snapshot.plan!.candidates = snapshot.pool.workers.map((item) => ({ ...snapshot.plan!.candidates[0]!, workerId: item.id }));
  snapshot.plan!.exclusions = [];
  snapshot.activeAttempts = []; snapshot.recentAttempts = [];
  const queued = snapshot.supervisor!.jobs[0]!;
  snapshot.supervisor!.jobs = Array.from({ length: 64 }, (_, index) => ({ ...queued, id: `queued-${String(index).padStart(2, '0')}`, allowedWorkerIds: ['local-00'] }));
  snapshot.supervisor!.queuedCount = 64; snapshot.supervisor!.activeCount = 0;
  snapshot.counts.omittedHistory = 9;
  return snapshot;
}

describe('resource fleet topology', () => {
  it('shows shared capacity once and connects only recorded assignments', () => {
    mount();
    const codex = screen.getByRole('region', { name: 'Fleet capacity codex-account' });
    expect(within(codex).getByRole('meter', { name: 'codex-account occupied shared slots' })).toHaveAttribute('value', '1');
    expect(within(codex).getByText('2 enrolled aliases sharing this cap')).toBeVisible();
    expect(within(codex).getByRole('button', { name: 'Inspect map task external-task' })).toBeVisible();
    expect(within(codex).queryByRole('button', { name: 'Inspect map task queued-task' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Declared sharing, not verified account identity')).toHaveLength(2);
    expect(screen.getByText(/Lines mean configured sharing or recorded assignments/)).toBeVisible();
  });

  it('keeps queued allowlist possibilities in a separate unconnected lane', () => {
    const snapshot = resourceFixture().snapshot;
    snapshot.supervisor!.jobs[0]!.allowedWorkerIds = ['local-a'];
    mount(snapshot);
    const waiting = screen.getByRole('region', { name: 'Waiting for assignment' });
    expect(within(waiting).getByRole('button', { name: 'Inspect map task queued-task' })).toHaveTextContent('1 eligible in preview; not assigned');
    expect(screen.getByRole('list', { name: 'Assignments for local-a' })).not.toHaveTextContent('queued-task');
    expect(screen.getByText('Queue ready')).toBeVisible();
  });

  it('does not manufacture assignment for dispatch intent without a worker', () => {
    const snapshot = resourceFixture().snapshot;
    snapshot.supervisor!.jobs[1]!.workerId = null;
    mount(snapshot);
    const unresolved = screen.getByRole('region', { name: 'Unassigned or unresolved placement' });
    expect(within(unresolved).getByRole('button', { name: 'Inspect map task owned-task' })).toHaveTextContent('Dispatch requested; worker assignment is not yet recorded');
    expect(screen.getByRole('list', { name: 'Assignments for local-a' })).not.toHaveTextContent('owned-task');
  });

  it('explains a completed supervisor state alongside a separately sampled occupied receipt', () => {
    const snapshot = resourceFixture().snapshot;
    snapshot.supervisor!.jobs[1]!.state = 'settled'; snapshot.supervisor!.jobs[1]!.outcome = 'completed';
    mount(snapshot);
    const task = screen.getByRole('button', { name: 'Inspect map task owned-task' });
    expect(task).toHaveTextContent('completed');
    expect(task).toHaveTextContent('Recorded occupancy; not a process heartbeat');
    expect(task).toHaveTextContent('Supervisor and receipt states differ; sources sampled separately.');
  });

  it('does not call a terminal receipt occupied when the supervisor still reports dispatching', () => {
    const snapshot = resourceFixture().snapshot;
    snapshot.activeAttempts[0]!.status = 'completed';
    mount(snapshot);
    const task = screen.getByRole('button', { name: 'Inspect map task owned-task' });
    expect(task).toHaveTextContent('dispatching');
    expect(task).toHaveTextContent('Supervisor and receipt states differ; sources sampled separately.');
    expect(task).not.toHaveTextContent('Receipt still records occupancy');
  });

  it('keeps conflicting assignment evidence in the unassigned lane', () => {
    const snapshot = resourceFixture().snapshot;
    snapshot.supervisor!.jobs[1]!.workerId = 'codex-a';
    mount(snapshot);
    const unassigned = screen.getByRole('region', { name: 'Unassigned or unresolved placement' });
    expect(within(unassigned).getByRole('button', { name: 'Inspect map task owned-task' })).toHaveTextContent('Assignment evidence disagrees; no worker relationship is asserted');
    expect(screen.getByRole('list', { name: 'Assignments for local-a' })).not.toHaveTextContent('owned-task');
    expect(screen.getByRole('list', { name: 'Assignments for codex-a' })).not.toHaveTextContent('owned-task');
  });

  it('selects workers and tasks with native keyboard controls and highlights the selected relationship', async () => {
    const user = userEvent.setup(); const snapshot = resourceFixture().snapshot;
    const view = mount(snapshot);
    const worker = screen.getByRole('button', { name: 'Inspect map worker local-a' });
    worker.focus(); await user.keyboard('{Enter}');
    expect(view.onSelect).toHaveBeenLastCalledWith({ kind: 'worker', id: 'local-a' });
    const task = screen.getByRole('button', { name: 'Inspect map task owned-task' });
    task.focus(); await user.keyboard(' ');
    expect(view.onSelect).toHaveBeenLastCalledWith({ kind: 'task', id: 'owned-task' });
    view.rerender(<FleetMap snapshot={snapshot} stale={false} selection={{ kind: 'task', id: 'owned-task' }} onSelect={view.onSelect} />);
    expect(task).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Selected path:/)).toHaveTextContent('local-machine / local-a / owned-task');
  });

  it('withholds fresh eligibility and labels retained reads when stale', () => {
    mount(undefined, { stale: true });
    expect(screen.getByText('Previous snapshot')).toBeVisible();
    expect(screen.getByText(/Eligibility and queue previews are withheld/)).toBeVisible();
    expect(screen.getAllByText('Unknown eligibility')).toHaveLength(3);
    expect(screen.queryByText('Eligible preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspect map task owned-task' })).toBeEnabled();
    expect(screen.getByText('Queue unavailable')).toBeVisible();
  });

  it('preserves unknown occupancy rather than drawing a zero-filled meter', () => {
    const snapshot = resourceFixture().snapshot;
    snapshot.sourceState = 'degraded'; snapshot.plan = null;
    snapshot.groups.forEach((group) => { group.occupiedSlots = null; });
    mount(snapshot);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByLabelText('codex-account occupancy unknown')).toBeVisible();
    expect(screen.getAllByText('Unknown eligibility')).toHaveLength(3);
    expect(screen.getByText(/Known configuration and retained assignments do not establish current capacity/)).toBeVisible();
  });

  it('distinguishes legitimate known zero from unknown capacity', () => {
    const snapshot = resourceFixture().snapshot; snapshot.groups[1]!.occupiedSlots = 0;
    mount(snapshot);
    expect(screen.getByRole('meter', { name: 'local-machine occupied shared slots' })).toHaveAttribute('value', '0');
  });

  it('explains operator-capped unknown quota without inventing a percentage', () => {
    const snapshot = resourceFixture().snapshot;
    snapshot.plan!.candidates[0]!.reason = 'operator-capped-unknown-quota';
    mount(snapshot);
    const worker = screen.getByRole('button', { name: 'Inspect map worker local-a' });
    expect(worker).toHaveTextContent('Unknown provider quota; explicit operator caps apply');
    expect(worker).not.toHaveTextContent(/0%|100%/);
  });

  it('bounds worker rendering and makes every worker reachable through paging and search', async () => {
    const user = userEvent.setup(); mount(largeFixture());
    expect(screen.getAllByRole('button', { name: /^Inspect map worker / })).toHaveLength(8);
    expect(screen.getByText('1–8 of 32 matching workers; 32 enrolled')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next workers' }));
    expect(screen.getByRole('button', { name: 'Inspect map worker local-08' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Inspect map worker local-00' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Find a worker or task' }), 'coder-31');
    expect(screen.getAllByRole('button', { name: /^Inspect map worker / })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Inspect map worker local-31' })).toBeVisible();
    expect(screen.getByText('1–1 of 1 matching workers; 32 enrolled')).toBeVisible();
    await user.clear(screen.getByRole('searchbox'));
    expect(screen.getByRole('button', { name: 'Inspect map worker local-00' })).toBeVisible();
  });

  it('pages 64 queued tasks without inventing assignments or silently dropping records', async () => {
    const user = userEvent.setup(); mount(largeFixture());
    const waiting = screen.getByRole('region', { name: 'Waiting for assignment' });
    expect(within(waiting).getAllByRole('button', { name: /^Inspect map task / })).toHaveLength(8);
    expect(within(waiting).getByText('Showing 1–8 of 64 included in snapshot')).toBeVisible();
    for (let page = 0; page < 7; page += 1) await user.click(within(waiting).getByRole('button', { name: 'Next waiting for assignment' }));
    expect(within(waiting).getByRole('button', { name: 'Inspect map task queued-63' })).toBeVisible();
    expect(within(waiting).getByRole('button', { name: 'Next waiting for assignment' })).toBeDisabled();
    expect(screen.getByText('64 task records included; 9 historical records omitted by the source.')).toBeVisible();
  });

  it('pages assignments per worker and allows direct task-ID search', async () => {
    const user = userEvent.setup(); const snapshot = resourceFixture().snapshot;
    const receipt = snapshot.recentAttempts[0]!;
    snapshot.recentAttempts = Array.from({ length: 12 }, (_, index) => ({ ...receipt, id: `history-${String(index).padStart(2, '0')}` }));
    mount(snapshot);
    const assignments = screen.getByRole('list', { name: 'Assignments for local-a' });
    expect(within(assignments).getAllByRole('button')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Next local-a assignments' }));
    expect(screen.getByText('4–6 of 14 assignments')).toBeVisible();
    await user.type(screen.getByRole('searchbox'), 'history-11');
    expect(screen.getByRole('button', { name: 'Inspect map task history-11' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: /^Inspect map worker / })).toHaveLength(1);
  });

  it('exposes a search match for waiting work without treating its allowlist as assigned', async () => {
    const user = userEvent.setup(); mount(largeFixture());
    await user.type(screen.getByRole('searchbox'), 'queued-63');
    expect(screen.getByText(/No workers match this search/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Inspect map task queued-63' })).toBeVisible();
    expect(screen.queryByRole('list', { name: /^Assignments for / })).not.toBeInTheDocument();
  });

  it('pages unassigned task records separately and preserves exact visible counts', async () => {
    const user = userEvent.setup(); const snapshot = largeFixture();
    snapshot.supervisor!.jobs = snapshot.supervisor!.jobs.slice(0, 17).map((job) => ({ ...job, state: 'dispatching', workerId: null }));
    snapshot.supervisor!.queuedCount = 0;
    mount(snapshot);
    const unassigned = screen.getByRole('region', { name: 'Unassigned or unresolved placement' });
    expect(within(unassigned).getAllByRole('button', { name: /^Inspect map task / })).toHaveLength(8);
    await user.click(within(unassigned).getByRole('button', { name: 'Next unassigned or unresolved placement' }));
    await user.click(within(unassigned).getByRole('button', { name: 'Next unassigned or unresolved placement' }));
    expect(within(unassigned).getByText('Showing 17–17 of 17 included in snapshot')).toBeVisible();
    expect(within(unassigned).getByRole('button', { name: 'Inspect map task queued-16' })).toBeVisible();
  });

  it('preserves shared slot totals when workers in one capacity group span pages', async () => {
    const user = userEvent.setup(); const snapshot = largeFixture();
    snapshot.pool.workers.forEach((worker) => { worker.capacityKey = 'shared'; });
    snapshot.groups = [{ ...snapshot.groups[0]!, capacityKey: 'shared', occupiedSlots: 1, workerIds: snapshot.pool.workers.map((worker) => worker.id) }];
    mount(snapshot);
    expect(screen.getByText('8 of 32 matching workers on this page')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next workers' }));
    expect(screen.getByRole('meter', { name: 'shared occupied shared slots' })).toHaveAttribute('value', '1');
    expect(screen.getByText('32 enrolled aliases sharing this cap')).toBeVisible();
    expect(screen.getByText('8 of 32 matching workers on this page')).toBeVisible();
  });

  it('renders actionable empty evidence without claiming a zero-live fleet', () => {
    const snapshot = resourceFixture().snapshot;
    snapshot.pool.workers = []; snapshot.groups = []; snapshot.activeAttempts = []; snapshot.recentAttempts = [];
    snapshot.supervisor = null; snapshot.plan = null; snapshot.counts.omittedHistory = null;
    mount(snapshot);
    expect(screen.getByText(/Configure a resource pool to establish the fleet topology/)).toBeVisible();
    expect(screen.getByText('No tasks in this lane in the supplied snapshot.')).toBeVisible();
    expect(screen.getByText('0 task records included; Unknown historical records omitted by the source.')).toBeVisible();
    expect(screen.queryByText(/0 live|0 running/)).not.toBeInTheDocument();
  });

  it('renders long identifiers as plain text and performs no reads or writes on inspection', () => {
    const snapshot = resourceFixture().snapshot;
    const malicious = '<script>fixture-only</script>';
    snapshot.pool.workers[2]!.model = malicious;
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    try {
      const view = mount(snapshot);
      expect(screen.getByText(`local / ${malicious}`)).toBeVisible();
      expect(view.container.querySelector('script')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Inspect map worker local-a' }));
      fireEvent.click(screen.getByRole('button', { name: 'Inspect map task owned-task' }));
      expect(request).not.toHaveBeenCalled();
      expect(view.onSelect).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not shift keyboard focus on a fresh poll or selection update', () => {
    const snapshot = resourceFixture().snapshot; const view = mount(snapshot);
    const search = screen.getByRole('searchbox'); search.focus();
    const next: ResourceConsoleSnapshot = { ...snapshot, sampledAt: '2026-09-07T12:00:01.000Z' };
    view.rerender(<FleetMap snapshot={next} stale={false} selection={{ kind: 'task', id: 'owned-task' }} onSelect={view.onSelect} />);
    expect(search).toHaveFocus();
  });
});
