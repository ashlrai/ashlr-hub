import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineeringSupervision } from './EngineeringSupervision.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../../core/resources/console-engineering-supervisor-types.js';
let value: Snapshot;
let writes: RequestInit[];
beforeEach(() => {
  writes = []; setMutationToken('a'.repeat(64));
  value = { schemaVersion: 1, configId: 'fleet', configDigest: 'b'.repeat(64), sourceState: 'healthy', state: 'idle',
    deadlineAt: '2026-09-11T00:00:00.000Z', paused: false, revision: 0,
    entries: [{ enrollmentId: 'hub-repair', enrollmentDigest: 'c'.repeat(64), state: 'held', reasons: ['unchanged-evidence'], attempts: 1 }] };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(init); const body = JSON.parse(init.body as string);
      value = { ...value, paused: body.paused, revision: value.revision + 1, state: body.paused ? 'paused' : 'idle' };
    }
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { act(() => clearMutationToken()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('automatic engineering operating panel', () => {
  it('shows held evidence and scope, then pauses and resumes only on explicit clicks', async () => {
    render(<EngineeringSupervision available unlocked />);
    await screen.findByText('hub-repair');
    expect(screen.getByText(/Unresolved evidence has not changed/)).toBeInTheDocument();
    expect(screen.getByText(/Pause affects new automatic launches across all projects/)).toBeInTheDocument();
    expect(screen.getByText(/1 graph invocations; not model-request usage/)).toBeInTheDocument();
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Pause automatic launches' }));
    await screen.findByRole('button', { name: 'Resume automatic launches' });
    expect(writes).toHaveLength(1); expect(JSON.parse(writes[0]!.body as string)).toEqual({ paused: true, expectedRevision: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Resume automatic launches' }));
    await screen.findByRole('button', { name: 'Pause automatic launches' }); expect(writes).toHaveLength(2);
  });
  it('keeps control disabled while locked or disconnected and marks prior evidence stale', async () => {
    const view = render(<EngineeringSupervision available unlocked={false} />); await screen.findByText('hub-repair');
    expect(screen.getByRole('button', { name: 'Unlock supervision controls' })).toBeDisabled();
    view.rerender(<EngineeringSupervision available={false} unlocked />);
    expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeDisabled();
    expect(screen.getByText(/Displayed evidence may be stale/)).toBeInTheDocument(); expect(writes).toHaveLength(0);
  });
  it('does not turn an expired budget into a resume action', async () => {
    value = { ...value, state: 'timed-out', paused: true };
    render(<EngineeringSupervision available unlocked />); await screen.findByText('timed-out');
    expect(screen.getByRole('button', { name: 'Resume automatic launches' })).toBeDisabled(); expect(writes).toHaveLength(0);
  });
  it('holds controls when backend evidence is malformed', async () => {
    value = { ...value, configDigest: 'not-a-digest' };
    render(<EngineeringSupervision available unlocked />); await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeDisabled(); expect(writes).toHaveLength(0);
  });
});
