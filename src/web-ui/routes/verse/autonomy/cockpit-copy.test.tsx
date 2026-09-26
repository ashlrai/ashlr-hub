/**
 * cockpit-copy.test.tsx — the words and numerals the autonomy cockpit prints,
 * pinned against the recurring presentation defects: raw ISO instants in the
 * server's own prose, a checkout's absolute path where its folder name
 * belongs, "1 repos", a "0%" that is really a sliver, and empty states that
 * say what is missing without saying what to do about it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { evictAll } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import { AUDIT_ENTRIES, CAPS, controlSnapshot } from '../sections/section-fixtures.test-support.js';
import { ActivityPanel } from './ActivityPanel.js';
import { CapsPanel } from './CapsPanel.js';
import { GoalsBacklogPanel } from './GoalsBacklogPanel.js';
import { SafetyPanel } from './SafetyPanel.js';
import { ScopePanel } from './ScopePanel.js';
import { StatusHeader } from './StatusHeader.js';
import { describeControlError, type GuardedAction } from './use-guarded-action.js';

function guard(over: Partial<GuardedAction> = {}): GuardedAction {
  return {
    request: vi.fn(),
    busy: false,
    error: null,
    clearError: vi.fn(),
    readOnly: false,
    tokenOpen: false,
    tokenReason: '',
    closeToken: vi.fn(),
    ...over,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

interface Reads {
  audit?: unknown;
  goals?: unknown;
  backlog?: unknown;
  safety?: unknown;
  scope?: unknown;
}

function stubReads(reads: Reads = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/verse/audit')) return json(reads.audit ?? { entries: AUDIT_ENTRIES, truncated: false });
      if (url.startsWith('/api/goals')) return json(reads.goals ?? []);
      if (url.startsWith('/api/backlog')) return json(reads.backlog ?? null);
      if (url.startsWith('/api/verse/safety')) return json(reads.safety ?? { ok: true, checks: [] });
      if (url.startsWith('/api/verse/scope')) return json(reads.scope ?? { repos: [] });
      if (url.startsWith('/api/verse/autonomy-scope')) return json({ entries: [] });
      return new Response('not found', { status: 404 });
    }),
  );
}

beforeEach(() => {
  evictAll();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Status header
// ---------------------------------------------------------------------------

describe('StatusHeader', () => {
  it('counts one repo and one approval in the singular', () => {
    render(<StatusHeader snapshot={controlSnapshot({ pendingApprovals: 1 })} />);
    expect(screen.getByText('1 repo')).toBeInTheDocument();
    expect(screen.getByText('1 approval')).toBeInTheDocument();
    expect(screen.queryByText('1 repos')).not.toBeInTheDocument();
  });

  it('keeps the plural for anything but one', () => {
    const snapshot = controlSnapshot({
      pendingApprovals: 0,
      scope: { repos: [{ path: '/a/x', name: 'x', exists: true }, { path: '/a/y', name: 'y', exists: true }] },
    });
    render(<StatusHeader snapshot={snapshot} />);
    expect(screen.getByText('2 repos')).toBeInTheDocument();
    expect(screen.getByText('0 approvals')).toBeInTheDocument();
  });

  it('dates a last tick that was not today, instead of a bare clock time', () => {
    const lastTickAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const base = controlSnapshot();
    const snapshot = controlSnapshot({ daemon: { ...base.daemon!, lastTickAt, ticks: [{ ...base.daemon!.ticks![0]!, ts: lastTickAt }] } });
    render(<StatusHeader snapshot={snapshot} />);
    const clock = new Date(lastTickAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cell = screen.getByText(/· ok$/);
    expect(cell.textContent!.startsWith(`${clock} ·`)).toBe(false);
    expect(cell).toHaveTextContent(clock);
  });

  it('says "<1%" of the budget for a sliver of real spend, never "0%"', () => {
    const snapshot = controlSnapshot({ spend: { ...controlSnapshot().spend!, todayUsd: 0.05 } });
    render(<StatusHeader snapshot={snapshot} />);
    expect(screen.getByText('$0.05 of $25.00 today · <1%')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Activity: ticks, dispatches, audit
// ---------------------------------------------------------------------------

describe('ActivityPanel', () => {
  it('names the dispatch repo by its folder, with the full path as the tooltip', () => {
    stubReads();
    render(<ActivityPanel snapshot={controlSnapshot()} />);
    const dispatches = screen.getByRole('columnheader', { name: 'Item' }).closest('table')!;
    const cell = within(dispatches).getByText('hub');
    expect(cell).toHaveAttribute('title', '/Users/m/code/hub');
    expect(within(dispatches).queryByText('/Users/m/code/hub')).not.toBeInTheDocument();
  });

  it('gives each timestamp its relative age as a phrase in the tooltip', () => {
    stubReads();
    render(<ActivityPanel snapshot={controlSnapshot()} />);
    const ticks = screen.getByRole('columnheader', { name: 'Proposals' }).closest('table')!;
    const time = within(ticks).getAllByRole('cell')[0]!;
    expect(time.getAttribute('title')).toMatch(/ ago$/);
  });

  it('reads an ISO instant in an audit summary as local time', async () => {
    const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
    stubReads({
      audit: {
        entries: [{ ts: new Date().toISOString(), action: 'budget.set', repo: null, sandboxId: null, summary: `paused until ${at}`, result: 'ok' }],
        truncated: false,
      },
    });
    render(<ActivityPanel snapshot={controlSnapshot()} />);
    const summary = await screen.findByText(/^paused until /);
    expect(summary.textContent).not.toContain(at);
    expect(summary.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('says how to see every entry when a filter matches nothing', async () => {
    stubReads({ audit: { entries: [], truncated: false } });
    const user = userEvent.setup();
    render(<ActivityPanel snapshot={controlSnapshot()} />);
    await user.type(screen.getByPlaceholderText('e.g. enroll.add'), 'nothing.matches{Enter}');
    expect(await screen.findByText(/No audit entries match this filter\. Clear the Action or Result filter/)).toBeInTheDocument();
  });

  it('points at the next step when no dispatches were recorded', () => {
    stubReads();
    const base = controlSnapshot();
    const snapshot = controlSnapshot({ daemon: { ...base.daemon!, ticks: [{ ...base.daemon!.ticks![0]!, dispatches: [] }] } });
    render(<ActivityPanel snapshot={snapshot} />);
    expect(screen.getByText(/No dispatches in the recorded ticks/)).toHaveTextContent('Run one tick from Controls');
  });
});

// ---------------------------------------------------------------------------
// Goals and backlog
// ---------------------------------------------------------------------------

describe('GoalsBacklogPanel', () => {
  it('says "<1%" for a goal that has started, and a whole percent otherwise', async () => {
    stubReads({
      goals: [
        { id: 'g1', objective: 'Ship the audit trail', status: 'active', milestones: [], progress: { fractionDone: 0.004, counts: {}, nextActionableId: null } },
        { id: 'g2', objective: 'Retire the v1 router', status: 'active', milestones: [], progress: { fractionDone: 0.5, counts: {}, nextActionableId: null } },
      ],
    });
    render(<GoalsBacklogPanel />);
    expect(await screen.findByText('<1% · active')).toBeInTheDocument();
    expect(screen.getByText('50% · active')).toBeInTheDocument();
  });

  it('names the command that adds a goal and the one that builds a backlog', async () => {
    stubReads();
    render(<GoalsBacklogPanel />);
    const goals = await screen.findByText(/No active goals/);
    expect(within(goals).getByText('ashlr goals add "<objective>"', { selector: 'code' })).toBeInTheDocument();
    const backlog = await screen.findByText(/No backlog has been built yet/);
    expect(within(backlog).getByText('ashlr backlog', { selector: 'code' })).toBeInTheDocument();
    // Commands are code, not prose wrapped in literal backticks.
    expect(backlog.textContent).not.toContain('`');
  });

  it('says what gives an empty backlog work', async () => {
    stubReads({ backlog: { items: [] } });
    render(<GoalsBacklogPanel />);
    expect(await screen.findByText(/The backlog is empty/)).toHaveTextContent(/Enroll another repository in Scope, or add a goal/);
  });

  it('names a backlog item’s repo by its folder, with the full path as the tooltip', async () => {
    stubReads({ backlog: { items: [{ id: 'b1', title: 'Fix flaky test', repo: '/Users/m/code/hub', score: 7 }] } });
    render(<GoalsBacklogPanel />);
    const meta = await screen.findByText('hub · 7');
    expect(meta).toHaveAttribute('title', '/Users/m/code/hub');
  });
});

// ---------------------------------------------------------------------------
// Safety, scope, caps
// ---------------------------------------------------------------------------

describe('SafetyPanel', () => {
  it('tells the operator to re-run an empty report before treating it as a failure', async () => {
    stubReads({ safety: { ok: true, checks: [] } });
    render(<SafetyPanel />);
    expect(await screen.findByText(/came back with no checks/)).toHaveTextContent(/Press Re-run checks/);
  });
});

describe('ScopePanel', () => {
  it('isolates each enrolled path so its leading "/" stays in front under the head-first ellipsis', async () => {
    stubReads({ scope: { repos: [{ path: '/Users/m/code/hub', name: 'hub', exists: true }] } });
    render(<ScopePanel guard={guard()} dispatchEnabled />);
    const path = await screen.findByText('/Users/m/code/hub');
    expect(path.tagName).toBe('BDI');
    expect(path.parentElement).toHaveAttribute('title', '/Users/m/code/hub');
  });
});

describe('CapsPanel', () => {
  it('says where a per-engine limit is configured when there are none', () => {
    render(<CapsPanel caps={{ ...CAPS, foundryLimits: [] }} snapshot={controlSnapshot()} guard={guard()} dispatchEnabled />);
    const empty = screen.getByText(/No per-engine dispatch limits are configured/);
    expect(within(empty).getByText('foundry.limits', { selector: 'code' })).toBeInTheDocument();
    expect(within(empty).getByText('~/.ashlr/config.json', { selector: 'code' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The server's refusal, as the panels print it
// ---------------------------------------------------------------------------

describe('describeControlError', () => {
  it('reads an ISO instant in the server’s refusal as local time', () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const text = describeControlError(new ApiError('POST failed', 409, '/api/verse/daemon', `Budget spent — resets ${at}.`));
    expect(text).toBe(`Budget spent — resets ${describeResetAt(at)}.`);
  });

  it('collapses a ".;" left where the server joined two sentences', () => {
    const text = describeControlError(new ApiError('POST failed', 409, '/api/verse/daemon', 'Kill switch engaged.; Budget spent.'));
    expect(text).toBe('Kill switch engaged; Budget spent.');
  });
});
