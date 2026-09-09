import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { AllocationControl, type AllocationSnapshot } from './AllocationControl.js';
import { ResourcePoolView } from './ResourcePoolView.js';
import { resourceFixture } from './fixtures.test-support.js';

const NOW = '2026-09-08T12:00:00.000Z';
const LEGACY: AllocationSnapshot = { ceilingPercent: null, revision: 0, updatedAt: null };
const SAVED: AllocationSnapshot = { ceilingPercent: 75, revision: 1, updatedAt: NOW };
const change = (value: number) => fireEvent.change(screen.getByRole('slider'), { target: { value: String(value) } });

describe('allocation control', () => {
  it('omits older server responses with no allocation contract', () => {
    const { container } = render(<AllocationControl allocation={undefined} writable onSave={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('presents 75% as explicitly unsaved on legacy policy, never as enforced', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render(<AllocationControl allocation={LEGACY} writable onSave={save} />);
    expect(screen.getByRole('slider')).toHaveValue('75');
    expect(screen.getByText('No pool-wide ceiling saved')).toBeVisible();
    expect(screen.getByText('(unsaved)')).toBeVisible();
    expect(screen.getByText('25%')).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(75, 0));
  });
  it('requires an explicit save, preserves revision and keeps rejected drafts', async () => {
    const save = vi.fn().mockResolvedValue(false);
    render(<AllocationControl allocation={SAVED} writable onSave={save} />);
    expect(screen.getByRole('button', { name: 'Save allocation' })).toBeDisabled();
    change(60); expect(save).not.toHaveBeenCalled();
    expect(screen.getByText('40%')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(60, 1));
    expect(screen.getByRole('slider')).toHaveValue('60');
    expect(screen.getByText('Saved ceiling: 75%')).toBeVisible();
  });
  it('blocks stale draft overwrites until the operator explicitly takes the latest revision', () => {
    const save = vi.fn();
    const { rerender } = render(<AllocationControl allocation={SAVED} writable onSave={save} />);
    change(60);
    rerender(<AllocationControl allocation={{ ...SAVED, ceilingPercent: 80, revision: 2 }} writable onSave={save} />);
    expect(screen.getByRole('alert')).toHaveTextContent('changed while you were editing');
    expect(screen.getByRole('slider')).toHaveValue('60');
    expect(screen.getByRole('button', { name: 'Save allocation' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use latest allocation' }));
    expect(screen.getByRole('slider')).toHaveValue('80');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    change(65); fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    expect(save).toHaveBeenCalledExactlyOnceWith(65, 2);
  });
  it('tracks new snapshots when no draft exists without creating an artificial conflict', () => {
    const { rerender } = render(<AllocationControl allocation={SAVED} writable onSave={vi.fn()} />);
    rerender(<AllocationControl allocation={{ ...SAVED, ceilingPercent: 90, revision: 2 }} writable onSave={vi.fn()} />);
    expect(screen.getByRole('slider')).toHaveValue('90');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each([{ disabled: true }, { busy: true }])('disables edits and saves while blocked %#', (props) => {
    render(<AllocationControl allocation={LEGACY} writable onSave={vi.fn()} {...props} />);
    expect(screen.getByRole('slider')).toBeDisabled();
    expect(screen.getByRole('button')).toBeDisabled();
  });
  it('renders existing allocation without controls in an observation-only console', () => {
    render(<AllocationControl allocation={SAVED} writable={false} onSave={vi.fn()} />);
    expect(screen.getByRole('slider')).toBeDisabled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Allocation changes are not enabled for this console.')).toBeVisible();
  });
  it('explains zero, unknown quota, native caps and in-flight overshoot', () => {
    render(<AllocationControl allocation={SAVED} writable onSave={vi.fn()} />);
    expect(screen.getByText(/including your manual work/)).toBeVisible();
    expect(screen.getByText(/Unknown remote quota blocks new dispatch/)).toBeVisible();
    change(0); expect(screen.getByText(/new remote dispatch is off; local models are unaffected/)).toBeVisible();
    change(100); expect(screen.getByText(/does not authorize API overages/)).toBeVisible();
    expect(screen.getByText(/in-flight tasks are not stopped and usage can overshoot/)).toBeVisible();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '100% total usage ceiling; 0% personal headroom target');
  });
});

describe('allocation-only resource desk integration', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/resources/'); evictAll(); clearMutationToken();
    vi.stubGlobal('EventSource', vi.fn()); markCheckComplete(true);
  });
  afterEach(() => {
    act(() => { clearMutationToken(); markCheckComplete(false); }); vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });
  function setup() {
    const fixture = resourceFixture();
    fixture.scope.readOnly = true; fixture.scope.allocationWritable = true;
    fixture.scope.workspace = null; fixture.snapshot.supervisor = null; fixture.snapshot.allocation = LEGACY;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/resources' && init?.method === 'GET') return new Response(JSON.stringify(fixture.snapshot));
      if (path === '/api/resources/allocation' && init?.method === 'POST') {
        const input = JSON.parse(init.body as string);
        fixture.snapshot.allocation = { ceilingPercent: input.ceilingPercent, revision: input.expectedRevision + 1, updatedAt: NOW };
        return new Response(JSON.stringify({ allocation: fixture.snapshot.allocation }));
      }
      throw new Error('Unexpected fixture request');
    });
    vi.stubGlobal('fetch', request);
    return { ...fixture, request };
  }
  it('saves through authenticated fixed allocation route without a supervisor or task authority', async () => {
    const fixture = setup(); setMutationToken('a'.repeat(64));
    render(<ResourcePoolView scope={fixture.scope} />);
    await screen.findByRole('slider'); change(80);
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    await screen.findByText('Saved ceiling: 80%');
    expect(screen.getByText('Observation only')).toBeVisible();
    const posts = fixture.request.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe('/api/resources/allocation');
    expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({ ceilingPercent: 80, expectedRevision: 0 });
    expect(posts[0]![1]!.headers).toMatchObject({ 'x-ashlr-token': 'a'.repeat(64) });
    expect(screen.queryByRole('button', { name: 'Resume queue' })).not.toBeInTheDocument();
  });
  it('opens shared control-token dialog without sending a write when locked', async () => {
    const fixture = setup(); render(<ResourcePoolView scope={fixture.scope} />);
    await screen.findByRole('slider');
    expect(screen.getByRole('button', { name: 'Unlock controls' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('allocation changes only. Task execution remains disabled');
    expect(fixture.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it('keeps an edited value on a revision conflict, refreshes evidence and never silently retries', async () => {
    const fixture = setup(); setMutationToken('a'.repeat(64));
    fixture.request.mockImplementation(async (path, init) => {
      if (path === '/api/resources/allocation') {
        fixture.snapshot.allocation = { ceilingPercent: 90, revision: 1, updatedAt: NOW };
        return new Response(JSON.stringify({ error: 'PRIVATE_SERVER_DETAIL' }), { status: 409 });
      }
      if (init?.method === 'GET') return new Response(JSON.stringify(fixture.snapshot));
      throw new Error('Unexpected fixture request');
    });
    const { container } = render(<ResourcePoolView scope={fixture.scope} />);
    await screen.findByRole('slider'); change(60);
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    await screen.findByText('Saved ceiling: 90%');
    expect(screen.getByRole('slider')).toHaveValue('60');
    expect(screen.getByRole('button', { name: 'Use latest allocation' })).toBeVisible();
    expect(fixture.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(container.innerHTML).not.toContain('PRIVATE_SERVER_DETAIL');
  });
});
