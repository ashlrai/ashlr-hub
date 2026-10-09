/**
 * fleet-panels.test.tsx — the three local-fleet surfaces, asserted mostly on
 * what does NOT appear.
 *
 * The rendering failures worth a test are all of the same kind: a number that
 * is real but answers a different question. A configured slot count shown as
 * concurrency, an unread policy shown as "off", a queued turn's wall time
 * shown under the same header as a running turn's work. Each of those reads
 * as a fact and is not one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FleetPanel } from './FleetPanel.js';
import { LocalOnlyPanel } from './LocalOnlyPanel.js';
import { LocalRuntimePanel } from './LocalRuntimePanel.js';
import { SteerPanel } from '../fleet/SteerPanel.js';
import { FLEET_CONTROL_KEYS } from '../fleet/fleet-control-queries.js';
import type { FleetControlQueueV1 } from '../../../../core/fleet/fleet-control-types.js';
import { GoalsBacklogPanel } from './GoalsBacklogPanel.js';
import { evictAll, getQuerySnapshot, runQuery } from '../../../data/cache.js';
import { useFleetPolling } from './fleet-queries.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import type { GoalSummary } from '../../../data/queries.js';
import type { VerseBacklogSummary } from './control-queries.js';
import type {
  FleetAgent,
  FleetSnapshot,
  LocalOnlyPolicy,
  OptionalFleetRead,
  ServingRuntimeSnapshot,
} from './fleet-contract.js';
import type { GuardedAction } from './use-guarded-action.js';

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

function ok<T>(value: T): OptionalFleetRead<T> {
  return { value, available: true, reason: null };
}

function runtime(over: Partial<ServingRuntimeSnapshot> = {}): ServingRuntimeSnapshot {
  return {
    kind: 'llama-server',
    state: 'running',
    endpoint: '127.0.0.1:8080',
    model: 'qwen3.8:27b-ctx64k',
    slotsTotal: 4,
    slotsBusy: 1,
    contextTokens: 16384,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    parallel: { capable: true, refusal: null, slots: 4 },
    reason: null,
    supervised: true,
    sampledAt: null,
    ...over,
  };
}

describe('Advanced live polling', () => {
  beforeEach(() => { evictAll(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function Poller() { useFleetPolling(); return null; }

  it('refreshes the daemon control alongside existing fleet/runtime reads only while visible', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      calls.push(path);
      return Promise.resolve(new Response(JSON.stringify({ pid: 35431 }), { status: 200 }));
    }));
    await runQuery('verse-control', async () => ({ pid: 56295 }));
    const { rerender, unmount } = render(<SectionVisibilityProvider visible><Poller /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(calls.sort()).toEqual(['/api/verse/control', '/api/verse/fleet', '/api/verse/runtime']);
    expect(getQuerySnapshot<{ pid: number }>('verse-control').data?.pid).toBe(35431);
    rerender(<SectionVisibilityProvider visible={false}><Poller /></SectionVisibilityProvider>);
    calls.length = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls).toEqual([]);
    rerender(<SectionVisibilityProvider visible><Poller /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls.sort()).toEqual(['/api/verse/control', '/api/verse/fleet', '/api/verse/runtime']);
    unmount();
    calls.length = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Serving runtime
// ---------------------------------------------------------------------------

describe('LocalRuntimePanel', () => {
  it('states the runtime, model, slots and context at a glance', () => {
    render(<LocalRuntimePanel read={ok(runtime())} guard={guard()} dispatchEnabled />);
    expect(screen.getByText('llama-server · running')).toBeInTheDocument();
    expect(screen.getByText('qwen3.8:27b-ctx64k')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:8080')).toBeInTheDocument();
    expect(screen.getByText('16k')).toBeInTheDocument();
    expect(screen.getByText('4 agents in parallel')).toBeInTheDocument();
  });

  it('shows ONE, not four, when the runtime will not batch — and shows the measurement', () => {
    render(
      <LocalRuntimePanel
        read={ok(
          runtime({
            kind: 'ollama',
            parallel: {
              capable: false,
              refusal: 'model architecture does not currently support parallel requests',
              slots: 4,
            },
          }),
        )}
        guard={guard()}
        dispatchEnabled
      />,
    );
    expect(screen.getByText('Ollama serializes requests')).toBeInTheDocument();
    // The headline numeral is the effective concurrency.
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText(/the real capacity is one agent/)).toBeInTheDocument();
    // And the measured evidence, both rows.
    expect(screen.getByText('3.7 · 7.6 · 11.4 · 15.2')).toBeInTheDocument();
    expect(screen.getByText('8.6 · 8.9 · 9 · 9')).toBeInTheDocument();
    expect(
      screen.getByText('model architecture does not currently support parallel requests'),
    ).toBeInTheDocument();
  });

  it('does not show the measurement when the configured count IS the real one', () => {
    render(<LocalRuntimePanel read={ok(runtime())} guard={guard()} dispatchEnabled />);
    expect(screen.queryByText('3.7 · 7.6 · 11.4 · 15.2')).not.toBeInTheDocument();
  });

  it('draws one busy slot on a serializing runtime as full, not a quarter', () => {
    render(
      <LocalRuntimePanel
        read={ok(runtime({ slotsBusy: 1, parallel: { capable: false, refusal: null, slots: 4 } }))}
        guard={guard()}
        dispatchEnabled
      />,
    );
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText(/All 1 slot busy/)).toBeInTheDocument();
  });

  it('quotes no concurrency when batching is unconfirmed', () => {
    render(
      <LocalRuntimePanel
        read={ok(runtime({ parallel: { capable: null, refusal: null, slots: 4 } }))}
        guard={guard()}
        dispatchEnabled
      />,
    );
    expect(screen.getByText('Batching not confirmed')).toBeInTheDocument();
    expect(screen.getByText(/cannot stand behind/)).toBeInTheDocument();
  });

  it('disables the controls for a runtime it does not manage, and says why', () => {
    render(
      <LocalRuntimePanel read={ok(runtime({ supervised: false }))} guard={guard()} dispatchEnabled />,
    );
    expect(screen.getByRole('button', { name: 'Stop runtime' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restart runtime' })).toBeDisabled();
    expect(screen.getByText(/Managed outside the hub/)).toBeInTheDocument();
  });

  it('calls an absent route a missing source, not a stopped runtime', () => {
    render(
      <LocalRuntimePanel
        read={{ value: null, available: false, reason: 'This server does not expose /api/verse/runtime.' }}
        guard={guard()}
        dispatchEnabled
      />,
    );
    expect(screen.getByText(/No serving-runtime source/)).toBeInTheDocument();
    expect(screen.queryByText(/Not serving/)).not.toBeInTheDocument();
  });

  it('confirms before stopping, and says what a stop ends', async () => {
    const g = guard();
    const user = userEvent.setup();
    render(<LocalRuntimePanel read={ok(runtime())} guard={g} dispatchEnabled />);
    await user.click(screen.getByRole('button', { name: 'Stop runtime' }));
    expect(screen.getByText(/Every local agent turn in flight/)).toBeInTheDocument();
    // Not sent until the confirm is pressed.
    expect(g.request).not.toHaveBeenCalled();
  });
});

describe('GoalsBacklogPanel disclosures', () => {
  beforeEach(() => evictAll());
  afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

  function goal(id: number, status = 'active'): GoalSummary {
    return { id: `g${id}`, objective: `Goal ${id}`, status, milestones: [],
      progress: { fractionDone: 0.5, counts: {}, nextActionableId: null } };
  }

  async function seed(goals: GoalSummary[], backlog: VerseBacklogSummary = { items: [], absent: false }) {
    await runQuery('goals', async () => goals);
    await runQuery('backlog', async () => backlog);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  it('projects a steering goal label without changing its stored objective or retarget identifier', async () => {
    const queue: FleetControlQueueV1 = { v: 1, tasks: [], goals: [{ id: 'old-goal', objective: 'Improve Ashlr Verse',
      status: 'active', project: null, missionBound: false }], targets: { paths: ['/repo'], repos: [] }, reason: null };
    const original = JSON.stringify(queue);
    await runQuery(FLEET_CONTROL_KEYS.queue, async () => ok(queue)); vi.stubGlobal('fetch', vi.fn());
    render(<SteerPanel live={null} now={0} actions={{ act: vi.fn(), busy: false, error: null, clearError: vi.fn(), readOnly: true, dialogs: null }} />);
    expect(await screen.findByRole('combobox', { name: 'Target repo for Improve Phantom' })).toBeDisabled();
    expect(screen.getByText('Improve Phantom', { exact: false })).toBeInTheDocument();
    expect(JSON.stringify(queue)).toBe(original);
  });

  it('uses current product names in old goal labels without altering the API projection', async () => {
    const saved = { ...goal(1), objective: 'Improve Ashlrverse; keep `Ashlr Verse`' };
    const original = JSON.stringify(saved); await seed([saved]); render(<GoalsBacklogPanel />);
    expect(await screen.findByTitle('Improve Phantom; keep `Ashlr Verse`')).toHaveTextContent('Improve Phantom; keep `Ashlr Verse`');
    expect(JSON.stringify(saved)).toBe(original);
    expect(getQuerySnapshot<GoalSummary[]>('goals').data?.[0]?.objective).toBe(saved.objective);
  });

  it('expands every open goal, counts statuses accurately and preserves source order and records', async () => {
    const user = userEvent.setup();
    const goals = [...Array.from({ length: 21 }, (_, i) => goal(i + 1)),
      goal(22, 'paused'), goal(23, 'paused'), goal(24, 'planning'), goal(25, 'done'), goal(26, 'archived')];
    const original = JSON.stringify(goals);
    const fetcher = await seed(goals);
    render(<GoalsBacklogPanel />);
    expect(screen.getByText('21 active · 2 paused · 1 planning')).toBeInTheDocument();
    expect(screen.queryByText('Goal 9')).not.toBeInTheDocument();
    const expand = screen.getByRole('button', { name: 'Expand all goals (24)' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    const list = document.getElementById(expand.getAttribute('aria-controls')!)!;
    expect(list.children).toHaveLength(8);
    expand.focus();
    await user.keyboard('{Enter}');
    const collapse = screen.getByRole('button', { name: 'Collapse goals' });
    expect(collapse).toHaveFocus();
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(list.children).toHaveLength(24);
    expect([...list.children].map((row) => row.querySelector('[title]')?.textContent)).toEqual(goals.slice(0, 24).map((g) => g.objective));
    expect(screen.getAllByText('50% · paused')).toHaveLength(2);
    expect(screen.getByText('50% · planning')).toBeInTheDocument();
    expect(screen.queryByText('Goal 25')).not.toBeInTheDocument();
    expect(screen.queryByText('Goal 26')).not.toBeInTheDocument();
    await user.keyboard(' ');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(list.children).toHaveLength(8);
    expect(JSON.stringify(goals)).toBe(original);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('expands and collapses backlog independently, retaining the full queue order', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, title: `Task ${i}`, repo: '/demo/hub', score: i }));
    const fetcher = await seed(Array.from({ length: 10 }, (_, i) => goal(i)), { items, absent: false });
    render(<GoalsBacklogPanel />);
    await user.click(screen.getByRole('button', { name: 'Expand all backlog items (12)' }));
    const collapse = screen.getByRole('button', { name: 'Collapse backlog' });
    const list = document.getElementById(collapse.getAttribute('aria-controls')!)!;
    expect(list.children).toHaveLength(12);
    expect([...list.children].map((row) => row.querySelector('[title]')?.textContent)).toEqual(items.map((item) => item.title));
    expect(screen.getByRole('button', { name: 'Expand all goals (10)' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(collapse);
    expect(list.children).toHaveLength(8);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps expansion across read updates without selecting or rewriting a goal', async () => {
    const user = userEvent.setup();
    await seed(Array.from({ length: 9 }, (_, i) => goal(i)));
    render(<GoalsBacklogPanel />);
    await user.click(screen.getByRole('button', { name: 'Expand all goals (9)' }));
    await act(async () => { await runQuery('goals', async () => [...Array.from({ length: 9 }, (_, i) => goal(i)), goal(9, 'paused')]); });
    expect(screen.getByText('9 active · 1 paused · 0 planning')).toBeInTheDocument();
    expect(screen.getByText('Goal 9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse goals' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows no expansion control for eight rows and retains absent-backlog guidance', async () => {
    await seed(Array.from({ length: 8 }, (_, i) => goal(i)), { items: [], absent: true });
    render(<GoalsBacklogPanel />);
    expect(screen.queryByRole('button', { name: /Expand all|Collapse/ })).not.toBeInTheDocument();
    expect(screen.getByText(/No backlog has been built yet/)).toBeInTheDocument();
    expect(screen.queryByText(/The backlog is empty/)).not.toBeInTheDocument();
  });

  it('does not present failed reads as zero goals or an empty queue', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(input.toString() === '/api/goals' ? 'Goal source unavailable' : 'Backlog source unavailable');
    }));
    render(<GoalsBacklogPanel />);
    expect(await screen.findByText('Goal source unavailable')).toHaveAttribute('role', 'alert');
    expect(await screen.findByText('Backlog source unavailable')).toHaveAttribute('role', 'alert');
    expect(screen.queryByText(/0 active|No active goals|The backlog is empty/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Expand all|Collapse/ })).not.toBeInTheDocument();
  });

  it('does not infer empty goals or backlog while their first reads are pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<GoalsBacklogPanel />);
    expect(screen.queryByText(/0 active|No active goals|The backlog is empty|No backlog has been built/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Expand all|Collapse/ })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Local only
// ---------------------------------------------------------------------------

const SEATS = [
  { id: 'claude', engine: 'claude', label: 'Claude Code' },
  { id: 'codex-a', engine: 'codex', label: 'Personal Codex' },
  { id: 'local:qwen', engine: 'local', label: 'Qwen3.8 (local)' },
];

function policy(over: Partial<LocalOnlyPolicy> = {}): LocalOnlyPolicy {
  return {
    enabled: false,
    source: 'config',
    refuses: [],
    mutable: true,
    detail: null,
    sampledAt: null,
    ...over,
  };
}

describe('LocalOnlyPanel', () => {
  it('calls it a refusal, not a preference', () => {
    render(
      <LocalOnlyPanel read={ok(policy())} seats={SEATS} guard={guard()} dispatchEnabled />,
    );
    expect(screen.getAllByText(/unreachable/).length).toBeGreaterThan(0);
    // The guarantee, stated plainly: a cloud dispatch fails outright. Never
    // worded as a preference ("prefers local", "deprioritised"), which would
    // turn the guarantee back into a probability.
    expect(screen.getByText(/While on, cloud engines are unreachable/)).toBeInTheDocument();
    expect(screen.getByText(/a\s+dispatch to one fails outright/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/prefer|deprioriti/i);
  });

  it('names which of the operator’s own seats would stop working', () => {
    render(
      <LocalOnlyPanel read={ok(policy())} seats={SEATS} guard={guard()} dispatchEnabled />,
    );
    expect(screen.getByText(/2 of 3 seats would become unreachable/)).toBeInTheDocument();
    const list = screen.getByRole('list');
    expect(within(list).getByText('Claude Code')).toBeInTheDocument();
    expect(within(list).getByText('Personal Codex')).toBeInTheDocument();
    expect(within(list).queryByText('Qwen3.8 (local)')).not.toBeInTheDocument();
  });

  it('confirms before turning on, naming the seats in the dialog', async () => {
    const g = guard();
    const user = userEvent.setup();
    render(<LocalOnlyPanel read={ok(policy())} seats={SEATS} guard={g} dispatchEnabled />);
    await user.click(screen.getByRole('button', { name: 'Turn local-only on' }));
    expect(screen.getByText(/2 of your 3 seats stop working/)).toBeInTheDocument();
    expect(g.request).not.toHaveBeenCalled();
  });

  it('turns OFF without a dialog — reopening a door the operator closed is their call', async () => {
    const g = guard();
    const user = userEvent.setup();
    render(
      <LocalOnlyPanel read={ok(policy({ enabled: true }))} seats={SEATS} guard={g} dispatchEnabled />,
    );
    await user.click(screen.getByRole('button', { name: 'Turn local-only off' }));
    expect(g.request).toHaveBeenCalledTimes(1);
  });

  it('shows an env-pinned policy as read-only, with the reason', () => {
    render(
      <LocalOnlyPanel
        read={ok(policy({ enabled: true, source: 'env', mutable: false }))}
        seats={SEATS}
        guard={guard()}
        dispatchEnabled
      />,
    );
    expect(screen.getByRole('button', { name: 'Turn local-only off' })).toBeDisabled();
    expect(screen.getByText(/pinned by an environment variable/)).toBeInTheDocument();
  });

  it('does not render an unread policy as "off"', () => {
    render(
      <LocalOnlyPanel
        read={{ value: null, available: false, reason: 'No local-only route here.' }}
        seats={SEATS}
        guard={guard()}
        dispatchEnabled
      />,
    );
    expect(screen.getByText(/No local-only source/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn local-only/ })).not.toBeInTheDocument();
  });

  it('warns when local-only would leave nothing to dispatch to', () => {
    render(
      <LocalOnlyPanel
        read={ok(policy())}
        seats={SEATS.slice(0, 2)}
        guard={guard()}
        dispatchEnabled
      />,
    );
    expect(screen.getByText(/No local seat is configured/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

function agent(over: Partial<FleetAgent> & { id: string }): FleetAgent {
  return {
    task: null,
    repo: null,
    engine: null,
    model: null,
    state: 'running',
    startedAt: null,
    slot: null,
    ...over,
  };
}

function fleet(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return { agents: [], queueDepth: 0, slotsTotal: 4, slotsBusy: 0, notes: [], sampledAt: null, ...over };
}

describe('FleetPanel', () => {
  it('answers "is it working, and on what" without a log', () => {
    render(
      <FleetPanel
        read={ok(
          fleet({
            slotsBusy: 2,
            agents: [
              agent({
                id: 'a1',
                task: 'Tighten the audit filter',
                repo: 'ashlr-hub',
                model: 'qwen3.8',
                slot: 0,
                startedAt: new Date(Date.now() - 95_000).toISOString(),
              }),
              agent({ id: 'a2', task: 'Backfill seat fixtures', repo: 'ashlrcode', slot: 1 }),
            ],
          }),
        )}
        runtime={runtime({ slotsBusy: 2 })}
      />,
    );
    expect(screen.getByText('2 in flight')).toBeInTheDocument();
    expect(screen.getByText('Tighten the audit filter')).toBeInTheDocument();
    expect(screen.getByText('ashlr-hub')).toBeInTheDocument();
    expect(screen.getByText('1m 35s')).toBeInTheDocument();
  });

  it('says turns are WAITING rather than letting a queue read as slowness', () => {
    render(
      <FleetPanel
        read={ok(
          fleet({
            queueDepth: 3,
            slotsBusy: 4,
            agents: [
              agent({
                id: 'q1',
                state: 'queued',
                task: 'Waiting on a slot',
                startedAt: new Date(Date.now() - 120_000).toISOString(),
              }),
            ],
          }),
        )}
        runtime={runtime({ slotsBusy: 4 })}
      />,
    );
    expect(screen.getByText('3 waiting for a slot')).toBeInTheDocument();
    expect(screen.getByText(/queueing, not work/)).toBeInTheDocument();
    // A queued turn's elapsed time is qualified IN THE CELL as queued, so two
    // minutes of waiting can never be read as two minutes of work.
    const row = screen.getByRole('row', { name: /Waiting on a slot/ });
    expect(row).toHaveTextContent(/2m 00s\s*queued/);
    expect(within(row).getByText('no slot')).toBeInTheDocument();
  });

  it('says the queue drains one at a time on a serializing runtime', () => {
    render(
      <FleetPanel
        read={ok(fleet({ queueDepth: 3, slotsBusy: 1 }))}
        runtime={runtime({
          kind: 'ollama',
          slotsBusy: 1,
          parallel: { capable: false, refusal: null, slots: 4 },
        })}
      />,
    );
    expect(screen.getByText(/one at a time/)).toBeInTheDocument();
    expect(screen.getByText(/not slow inference/)).toBeInTheDocument();
  });

  it('says plainly when every slot is busy and nothing is waiting yet', () => {
    render(
      <FleetPanel
        read={ok(
          fleet({
            queueDepth: 0,
            slotsBusy: 4,
            agents: [0, 1, 2, 3].map((i) => agent({ id: `a${i}`, slot: i })),
          }),
        )}
        runtime={runtime({ slotsBusy: 4 })}
      />,
    );
    expect(screen.getByText('All slots busy · 4 in flight')).toBeInTheDocument();
    expect(screen.getByText(/the next turn will/)).toBeInTheDocument();
  });

  it('distinguishes a reported-empty fleet from a missing reading', () => {
    const { unmount } = render(<FleetPanel read={ok(fleet())} runtime={runtime()} />);
    expect(screen.getByText(/an idle fleet/)).toBeInTheDocument();
    unmount();

    render(
      <FleetPanel
        read={{ value: null, available: false, reason: 'No /api/verse/fleet here.' }}
        runtime={runtime()}
      />,
    );
    expect(screen.getByText(/Fleet status unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/an idle fleet/)).not.toBeInTheDocument();
  });

  it('draws no utilisation at all when the effective concurrency is unknown', () => {
    render(
      <FleetPanel
        read={ok(fleet({ slotsBusy: 2 }))}
        runtime={runtime({ parallel: { capable: null, refusal: null, slots: 4 } })}
      />,
    );
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Copy: paths, prose, plurals, truncation
// ---------------------------------------------------------------------------

describe('local-fleet copy', () => {
  it('names an agent’s repo by its folder, with the checkout path as the tooltip', () => {
    render(
      <FleetPanel
        read={ok(fleet({ agents: [agent({ id: 'a1', task: 'Fix it', repo: '/Users/m/code/ashlr-hub', slot: 0 })], slotsBusy: 1 }))}
        runtime={runtime()}
      />,
    );
    const cell = screen.getByText('ashlr-hub');
    expect(cell).toHaveAttribute('title', '/Users/m/code/ashlr-hub');
    expect(screen.queryByText('/Users/m/code/ashlr-hub')).not.toBeInTheDocument();
  });

  it('reads an ISO instant in a fleet note as local time', () => {
    const at = new Date(Date.now() - 600_000).toISOString();
    render(<FleetPanel read={ok(fleet({ notes: [`last snapshot written ${at}`] }))} runtime={runtime()} />);
    const note = screen.getByText(/^last snapshot written /);
    expect(note.textContent).not.toContain(at);
  });

  it('points at the next step when nothing is in flight', () => {
    render(<FleetPanel read={ok(fleet())} runtime={runtime()} />);
    expect(screen.getByText(/an idle fleet/)).toHaveTextContent('Run one tick from Controls');
  });

  it('never ends the lane-cap sentence with ".." when the tick’s reason is a full sentence', () => {
    render(
      <LocalRuntimePanel
        read={ok(runtime())}
        guard={guard()}
        dispatchEnabled
        fleet={ok(fleet({ notes: ["bounded by this tick's lane cap, not by slots: lane cap 2 is below 4 (presence): Mason is present."] }))}
      />,
    );
    const line = screen.getByRole('note');
    expect(line).toHaveTextContent('a lane cap is tighter than this runtime: Mason is present.');
    expect(line.textContent).not.toContain('..');
  });

  it('carries a truncatable endpoint or model name in full as a tooltip', () => {
    render(<LocalRuntimePanel read={ok(runtime())} guard={guard()} dispatchEnabled fleet={null} />);
    expect(screen.getByText('127.0.0.1:8080')).toHaveAttribute('title', '127.0.0.1:8080');
    expect(screen.getByText('qwen3.8:27b-ctx64k')).toHaveAttribute('title', 'qwen3.8:27b-ctx64k');
  });

  it('agrees in number when one seat of one stops working', async () => {
    const user = userEvent.setup();
    render(<LocalOnlyPanel read={ok(policy())} seats={SEATS.slice(0, 1)} guard={guard()} dispatchEnabled />);
    await user.click(screen.getByRole('button', { name: 'Turn local-only on' }));
    expect(screen.getByText(/1 of your 1 seat stops working: Claude Code\./)).toBeInTheDocument();
  });
});
