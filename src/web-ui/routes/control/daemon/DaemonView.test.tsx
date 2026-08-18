import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DaemonView } from './DaemonView.js';
import { evictAll } from '../../../data/cache.js';

const CONTROL = {
  ts: new Date().toISOString(),
  daemon: {
    runtimeState: 'running',
    running: true,
    sourceQuality: { sourceState: 'healthy', complete: true },
    pid: 123,
    lastTickAt: new Date().toISOString(),
    todaySpentUsd: 4.5,
    activeDirectionMode: null,
    activeDirectionAt: null,
    activeDirectionReason: null,
    autonomyControlLoop: true,
    autonomyControlMode: 'enabled',
    service: { registrationState: 'registered', installed: true, running: true, runtimeState: 'running', platformSpec: 'launchd' },
  },
};

const OBSERVATION = {
  observedAt: new Date().toISOString(),
  runtimeState: 'running',
  sourceQuality: { sourceState: 'healthy', complete: true },
  running: true,
  pid: 123,
  startedAt: new Date().toISOString(),
  lastTickAt: new Date().toISOString(),
  todayDate: '2026-08-16',
  todaySpentUsd: 4.5,
  itemsProcessed: 2,
  ticks: [{ ts: new Date().toISOString(), itemsConsidered: 3, proposalsCreated: 1, spentUsd: 0.5, reason: 'ok' }],
};

function respondFor(controlBody: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/control')) return new Response(JSON.stringify(controlBody), { status: 200 });
    if (url.startsWith('/api/daemon-observation')) return new Response(JSON.stringify(OBSERVATION), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('DaemonView', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders real daemon state when sourceQuality is healthy', async () => {
    vi.stubGlobal('fetch', respondFor(CONTROL));
    render(
      <MemoryRouter>
        <DaemonView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('123')).toBeInTheDocument());
    expect(screen.getByText('$4.50')).toBeInTheDocument();
    expect(screen.queryByText('unknown')).not.toBeInTheDocument();
    expect(screen.queryByText(/Daemon state is unknown/)).not.toBeInTheDocument();
  });

  it('shows the recovery callout with the real CLI remedy when daemon state is degraded', async () => {
    const degraded = {
      ...CONTROL,
      daemon: {
        ...CONTROL.daemon,
        sourceQuality: { sourceState: 'degraded', complete: false, reason: 'unreadable' },
      },
    };
    vi.stubGlobal('fetch', respondFor(degraded));
    render(
      <MemoryRouter>
        <DaemonView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByText('unknown').length).toBeGreaterThan(0));
    expect(screen.getByText(/Daemon state is unknown \(unreadable\)/)).toBeInTheDocument();
    expect(screen.getByText(/ashlr daemon recover-state/)).toBeInTheDocument();
    expect(screen.getByText(/ashlr daemon resolve-state/)).toBeInTheDocument();
  });
});
