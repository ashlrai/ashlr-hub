import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TaskContextEvidence } from '../../../../core/context/task-temporal-context.js';
import type { OutcomeTaskContextView } from '../../../../core/verse/outcome-task-context.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { TaskContext } from './TaskContext.js';
import { TaskContextToggle } from './TaskContextToggle.js';

const evidence: TaskContextEvidence = { schemaVersion: 1, eventId: 'event-one', taskRef: 'task-one',
  source: { kind: 'phantom', provider: 'phantom', accountRef: 'phantom-local', objectRef: 'outcome-one', revisionRef: 'revision-one' },
  sourceRefs: ['phantom:source:one'], occurredAt: null, observedAt: '2026-10-09T08:00:00.000Z', validFrom: null, validUntil: null,
  kind: 'upsert', epistemic: 'recorded', content: 'A saved observation', supersedes: [], status: 'current', temporalResolution: 'unknown', replacedBy: [] };
function context(over: Partial<OutcomeTaskContextView> = {}): OutcomeTaskContextView {
  return { schemaVersion: 1, outcomeId: 'outcome-one', taskId: 'task-one', taskRef: 'task-one', outcomeRevision: 2, active: true,
    asOf: '2026-10-09T09:00:00.000Z', observedThrough: '2026-10-09T09:00:00.000Z',
    coverage: { sourceState: 'healthy', complete: true, stopReasons: [] }, current: [evidence], history: [], conflicts: [],
    sources: [{ source: 'outcome', sourceState: 'healthy', complete: true, stopReasons: [] }], ...over };
}
beforeEach(() => evictAll());
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });
describe('task context evidence', () => {
  it('fetches only when opened and preserves exact outcome/task isolation', async () => {
    const { calls } = installFetch(call => call.path === '/api/verse/outcomes/outcome-one/tasks/task-one/context' ? json(context()) : json({ error: 'not found' }, 404));
    render(<TaskContextToggle outcomeId="outcome-one" taskId="task-one" title="Build the UI" />);
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'View task context' }));
    await screen.findByText('Current record · recorded');
    expect(calls).toHaveLength(1); expect(calls[0]?.method).toBe('GET');
    expect(screen.getByText(/Occurred Unknown/)).toBeInTheDocument();
    expect(screen.getByText('Effective time is unknown.')).toBeInTheDocument();
    expect(screen.getByText(/External inboxes and personal agent accounts are not imported/)).toBeInTheDocument();
  });
  it('keeps missing evidence and incomplete coverage visible instead of asserting verified empty', async () => {
    installFetch(() => json(context({ current: [], history: [], coverage: { sourceState: 'missing', complete: false, stopReasons: ['missing-source'] } })));
    render(<TaskContext outcomeId="outcome-one" taskId="task-one" title="Task" />);
    await screen.findByText('Context is incomplete. Missing records and current facts remain unknown.');
    expect(screen.getByText('No current records available; coverage is incomplete.')).toBeInTheDocument();
    expect(screen.queryByText('No current records in this projection.')).not.toBeInTheDocument();
  });
  it('separates canceled history, conflicts and retired task state from current records', async () => {
    installFetch(() => json(context({ active: false, current: [], history: [{ ...evidence, status: 'canceled' }], conflicts: [{ kind: 'unknown-effective-time', eventIds: ['event-one'] }] })));
    render(<TaskContext outcomeId="outcome-one" taskId="task-one" title="Task" />);
    await screen.findByText('This task belongs to an earlier outcome revision.');
    expect(screen.getByText(/Conflicting or unresolved evidence: unknown effective time/)).toBeInTheDocument();
    expect(screen.getByText('canceled · recorded')).toBeInTheDocument();
  });
  it('refuses a different task response and keeps server failures distinct from an empty projection', async () => {
    installFetch(() => json(context({ taskId: 'another-task' })));
    render(<TaskContext outcomeId="outcome-one" taskId="task-one" title="Task" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Task context is unavailable');
    expect(screen.queryByText('Current record · recorded')).not.toBeInTheDocument();
  });
  it('refuses malformed evidence rather than crashing or displaying it as current', async () => {
    installFetch(() => json({ ...context(), current: [{ ...evidence, source: null }] }));
    render(<TaskContext outcomeId="outcome-one" taskId="task-one" title="Task" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Task context is unavailable');
    expect(screen.queryByText('Current record · recorded')).not.toBeInTheDocument();
  });
  it('preserves conflicting alternatives and their provenance without choosing a winner', async () => {
    installFetch(() => json(context({ current: [], conflicts: [{ kind: 'revision-conflict', eventIds: ['event-one'],
      alternatives: [{ ...evidence, content: 'First source claim' }, { ...evidence, content: 'Different source claim', sourceRefs: ['phantom:source:two'] }] }] })));
    render(<TaskContext outcomeId="outcome-one" taskId="task-one" title="Task" />);
    await screen.findByText('Conflicting versions');
    expect(screen.getByText('First source claim')).toBeInTheDocument();
    expect(screen.getByText('Different source claim')).toBeInTheDocument();
    expect(screen.getByText('phantom:source:two')).toBeInTheDocument();
  });
  it('renders context as text with retained source references rather than executing instructions or markup', async () => {
    const content = '<script>steal()</script>';
    installFetch(() => json(context({ current: [{ ...evidence, content }] })));
    const { container } = render(<TaskContext outcomeId="outcome-one" taskId="task-one" title="Task" />);
    await screen.findByText(content);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('phantom:source:one')).toBeInTheDocument();
    expect(screen.getByText('phantom-local')).toBeInTheDocument();
  });
});
