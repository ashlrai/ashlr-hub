import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FleetDashboardView } from './FleetDashboardView.js';
import { evictAll } from '../../data/cache.js';

const SNAPSHOT = {
  generatedAt: new Date().toISOString(),
  repos: { total: 12, dirty: 2, stale: 1 },
  tools: { installed: 8, total: 10 },
  activity: { sessions: 4, tokens: 12_345, estCostUsd: 1.23, commits: 6 },
  runs: [{ id: 'r1', goal: 'ship the thing', status: 'running', tokens: 500 }],
  swarms: [{ id: 's1', goal: 'refactor auth', status: 'active', tasksDone: 3, tasksTotal: 8, phase: 'implement' }],
  mcp: [{ name: 'figma', ok: true, tools: 5 }],
  genome: { entries: 100, projects: 3 },
  inbox: { pending: 2 },
};

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
    service: { registrationState: 'unknown', installed: false, running: false, runtimeState: 'unknown', platformSpec: 'unknown' },
  },
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/snapshot')) {
      return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
    }
    if (url.startsWith('/api/control')) {
      return new Response(JSON.stringify(CONTROL), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

describe('FleetDashboardView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders stat grid, runs, swarms, and daemon panels from real snapshot/control data', async () => {
    render(<FleetDashboardView />);

    await waitFor(() => expect(screen.getByText('ship the thing')).toBeInTheDocument());

    // StatGrid
    expect(screen.getByText('12')).toBeInTheDocument(); // repos.total
    expect(screen.getByText('2')).toBeInTheDocument(); // inbox pending

    // RunsPanel
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);

    // SwarmsPanel
    expect(screen.getByText('refactor auth')).toBeInTheDocument();
    expect(screen.getByText('3/8 · implement')).toBeInTheDocument();

    // DaemonPanel — healthy sourceQuality renders the real state, not "unknown".
    await waitFor(() => expect(screen.getByText('123')).toBeInTheDocument()); // pid
    expect(screen.getByText('$4.50')).toBeInTheDocument();
    expect(screen.queryByText('unknown')).not.toBeInTheDocument();
  });

  it('withholds daemon detail behind Epistemic when control sourceQuality is degraded', async () => {
    const degraded = {
      ...CONTROL,
      daemon: { ...CONTROL.daemon, sourceQuality: { sourceState: 'degraded', complete: false, reason: 'state file missing' } },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/snapshot')) return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
        if (url.startsWith('/api/control')) return new Response(JSON.stringify(degraded), { status: 200 });
        return new Response('not found', { status: 404 });
      }),
    );

    render(<FleetDashboardView />);
    await waitFor(() => expect(screen.getAllByText('unknown').length).toBeGreaterThan(0));
  });
});
