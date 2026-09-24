/**
 * overnight-panel.test.tsx — the Overnight panel, asserted on the four things
 * it exists to get right.
 *
 *   1. Each of the three stop rules produces the REQUEST it describes. A rule
 *      the operator can see on screen but that never reaches the wire is the
 *      failure mode this control cannot have.
 *   2. The armed state renders every field an operator needs at 3am: what it
 *      is doing, which repo, how long, how far to the stop, what it merged,
 *      what it discarded and why.
 *   3. The halt is PAUSE, it is reachable, and it is not the emergency stop.
 *      `stopDaemon()` is `setKill(true)`, so wiring the primary halt to the
 *      ordinary "Stop loop" would have given a woken operator's first instinct
 *      the widest blast radius in the app.
 *   4. The backend does not exist yet, and an absent route renders as a
 *      designed state — never a crash, never a spinner that never resolves.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OvernightPanel } from './OvernightPanel.js';
import type { OptionalFleetRead } from './fleet-contract.js';
import type { OvernightStatus } from './overnight-contract.js';
import type { GuardedAction } from './use-guarded-action.js';
import { controlSnapshot } from '../sections/section-fixtures.test-support.js';

const armOvernight = vi.hoisted(() =>
  vi.fn(async (_stopRule: unknown) => ({ ok: true, note: null, status: null })),
);
const disarmOvernight = vi.hoisted(() => vi.fn(async () => ({ ok: true, note: null, status: null })));
const runDaemonAction = vi.hoisted(() => vi.fn(async () => ({ ok: true, note: null })));

// Partial mocks: the panel's two writes and the daemon pause. Everything else
// in these modules (the QueryDefs, the locked-error class) stays real, so the
// mock cannot drift from the module it is standing in for.
vi.mock('./overnight-queries.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./overnight-queries.js')>()),
  armOvernight,
  disarmOvernight,
}));
vi.mock('./control-queries.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./control-queries.js')>()),
  runDaemonAction,
}));

/** A guard that actually runs the action, so the request reaches the mock. */
function guard(over: Partial<GuardedAction> = {}): GuardedAction {
  function request<T>(fn: () => Promise<T>, _reason: string, onResult?: (result: T) => void): void {
    void fn().then((result) => onResult?.(result));
  }
  return {
    request,
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

function ok(value: OvernightStatus): OptionalFleetRead<OvernightStatus> {
  return { value, available: true, reason: null };
}

const IDLE: OvernightStatus = {
  armed: false,
  run: null,
  repos: 9,
  gate: { tests: true, lint: true, typecheck: true, autoMerge: true, branch: 'master' },
};

function armedStatus(): OvernightStatus {
  return {
    armed: true,
    repos: 9,
    gate: { tests: true, lint: true, typecheck: true, autoMerge: true, branch: 'master' },
    run: {
      runId: 'run-1',
      startedAt: new Date(Date.now() - 3_720_000).toISOString(),
      stopRule: { kind: 'after-iterations', iterations: 20 },
      iterationsDone: 5,
      repo: 'ashlr-hub',
      activity: 'running the test gate',
      merged: [
        {
          id: 'm1',
          repo: 'ashlr-hub',
          title: 'drop the dead cache key',
          at: new Date().toISOString(),
          commit: 'abc1234',
        },
      ],
      discarded: [
        {
          id: 'd1',
          repo: 'ashlrcode',
          title: 'rewrite the router',
          at: new Date().toISOString(),
          reason: 'typecheck: 3 errors',
        },
      ],
    },
  };
}

function renderPanel(read: OptionalFleetRead<OvernightStatus> | null, over: Partial<GuardedAction> = {}) {
  return render(
    <OvernightPanel read={read} snapshot={controlSnapshot()} guard={guard(over)} dispatchEnabled />,
  );
}

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

describe('OvernightPanel — arming', () => {
  it('arms an open-ended run with the until-paused rule', async () => {
    renderPanel(ok(IDLE));
    expect(screen.getByRole('radio', { name: 'Until I pause it' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Arm overnight run' }));

    await waitFor(() => expect(armOvernight).toHaveBeenCalledWith({ kind: 'until-paused' }));
  });

  it('arms a wall-clock stop at the NEXT occurrence of the chosen time', async () => {
    renderPanel(ok(IDLE));

    fireEvent.click(screen.getByRole('radio', { name: 'At a time' }));
    fireEvent.change(screen.getByLabelText('Stop at'), { target: { value: '07:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Arm overnight run' }));

    await waitFor(() => expect(armOvernight).toHaveBeenCalled());
    const rule = armOvernight.mock.calls.at(-1)?.[0] as unknown as { kind: string; at: string };
    expect(rule.kind).toBe('at-time');
    // An absolute instant, in the future, at the operator's 07:00.
    const at = new Date(rule.at);
    expect(at.getTime()).toBeGreaterThan(Date.now());
    expect(at.getHours()).toBe(7);
    expect(at.getMinutes()).toBe(0);
  });

  it('arms an iteration cap', async () => {
    renderPanel(ok(IDLE));

    fireEvent.click(screen.getByRole('radio', { name: 'After N iterations' }));
    fireEvent.change(screen.getByLabelText('Iterations'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Arm overnight run' }));

    await waitFor(() =>
      expect(armOvernight).toHaveBeenCalledWith({ kind: 'after-iterations', iterations: 12 }),
    );
  });

  it('refuses an out-of-range iteration cap before the round trip', async () => {
    renderPanel(ok(IDLE));

    fireEvent.click(screen.getByRole('radio', { name: 'After N iterations' }));
    fireEvent.change(screen.getByLabelText('Iterations'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Arm overnight run' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/between 1 and 500/);
    expect(armOvernight).not.toHaveBeenCalled();
  });

  /**
   * The statement of what is being authorised is visible WITHOUT clicking
   * anything. That is the whole design: a confirm dialog can be clicked
   * through, a paragraph above the button cannot be un-read.
   */
  it('says plainly, before the click, that it merges to master unattended', () => {
    renderPanel(ok(IDLE));
    expect(screen.getByText('What it does while you sleep')).toBeInTheDocument();
    expect(screen.getByText(/merged to master without asking you/)).toBeInTheDocument();
    expect(screen.getByText(/tests, lint and typecheck/)).toBeInTheDocument();
    // The operator's own repo count, not an abstraction.
    expect(screen.getByText('your 9 enrolled repositories')).toBeInTheDocument();
  });

  // P4: the mirrors F5 records are shown APART from the repo count — never added to it.
  it('states the fleet mirrors separately from the repositories', () => {
    renderPanel(ok({ ...IDLE, mirrors: 9 }));
    expect(screen.getByText('your 9 enrolled repositories')).toBeInTheDocument();
    const line = screen.getByTestId('overnight-mirrors');
    expect(line).toHaveTextContent('Fleet mirrors: 9 — the standing fleet’s own clones of enrolled repositories, counted apart.');
    expect(line).toHaveTextContent('A mirror is not an additional repository.');
    expect(screen.queryByText(/18/)).toBeNull();
  });

  it('says a mirror count was not recorded for an armed run, and nothing for an older server', () => {
    const { unmount } = renderPanel(ok({ ...armedStatus(), mirrors: null }));
    expect(screen.getByTestId('overnight-mirrors')).toHaveTextContent('Fleet mirrors were not recorded for this run');
    unmount();
    renderPanel(ok(armedStatus()));
    expect(screen.queryByTestId('overnight-mirrors')).toBeNull();
  });

  it('shows unstated gate checks as unstated rather than as checks that run', () => {
    renderPanel(
      ok({ ...IDLE, gate: { tests: true, lint: null, typecheck: null, autoMerge: true, branch: 'master' } }),
    );
    expect(screen.getByText(/did not state whether lint and typecheck/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The armed state
// ---------------------------------------------------------------------------

describe('OvernightPanel — armed', () => {
  it('renders what it is doing, where, for how long and how far from stopping', () => {
    renderPanel(ok(armedStatus()));

    expect(screen.getByText('armed — running')).toBeInTheDocument();
    expect(screen.getByText('running the test gate')).toBeInTheDocument();
    // Scoped to the fact, because the same repo name also appears in the
    // merged ledger below — which is the point: they agree.
    const repoFact = screen.getByText('Repository').closest('div')!;
    expect(within(repoFact).getByText('ashlr-hub')).toBeInTheDocument();
    expect(screen.getByText('1h 02m')).toBeInTheDocument();
    expect(screen.getByText('Stops after 20 iterations')).toBeInTheDocument();
    expect(screen.getByText('5 of 20 done')).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '25');
  });

  it('renders what it merged and what it discarded, with the reason', () => {
    renderPanel(ok(armedStatus()));

    const merged = screen.getByText('Merged').closest('div')!;
    expect(within(merged).getByText('drop the dead cache key')).toBeInTheDocument();
    expect(within(merged).getByText(/abc1234/)).toBeInTheDocument();

    const discarded = screen.getByText('Discarded').closest('div')!;
    expect(within(discarded).getByText('rewrite the router')).toBeInTheDocument();
    expect(within(discarded).getByText(/typecheck: 3 errors/)).toBeInTheDocument();
  });

  it('draws no progress bar for an open-ended run', () => {
    const status = armedStatus();
    status.run!.stopRule = { kind: 'until-paused' };
    renderPanel(ok(status));

    expect(screen.getByText('Runs until you pause it')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText(/no finish line to draw it against/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The halt
// ---------------------------------------------------------------------------

describe('OvernightPanel — the halt', () => {
  it('halts with the daemon-scoped PAUSE, not the kill switch', async () => {
    renderPanel(ok(armedStatus()));

    const pause = screen.getByRole('button', { name: 'Pause now' });
    fireEvent.click(pause);

    await waitFor(() => expect(runDaemonAction).toHaveBeenCalledWith('pause'));
    // Never the ordinary stop, which is `setKill(true)` under another name.
    expect(runDaemonAction).not.toHaveBeenCalledWith('stop');
  });

  it('keeps the emergency stop distinct: named as heavier, not duplicated here', () => {
    renderPanel(ok(IDLE));

    // No second Emergency stop button — it lives in Controls, under a rule.
    expect(screen.queryByRole('button', { name: /emergency/i })).toBeNull();
    expect(screen.getByText(/global kill switch/)).toBeInTheDocument();
    expect(screen.getByText(/anything, anywhere, until you release it/)).toBeInTheDocument();
  });

  it('distinguishes disarming from halting at the point of the click', async () => {
    renderPanel(ok(armedStatus()));

    expect(screen.getByText(/Disarm stops the next run from starting but leaves this one going/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disarm' }));
    await waitFor(() => expect(disarmOvernight).toHaveBeenCalled());
    expect(runDaemonAction).not.toHaveBeenCalled();
  });

  it('offers resume, and says nothing is being dispatched, while paused', async () => {
    render(
      <OvernightPanel
        read={ok(armedStatus())}
        snapshot={controlSnapshot({
          pause: {
            state: 'paused',
            sourceState: 'healthy',
            reason: 'present',
            note: '',
            pausedAt: null,
            by: 'cli',
          },
        })}
        guard={guard()}
        dispatchEnabled
      />,
    );

    expect(screen.getByText('armed — dispatch paused')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    await waitFor(() => expect(runDaemonAction).toHaveBeenCalledWith('resume'));
  });

  /** `unknown` fails safe as paused — the daemon does, so the panel must. */
  it('treats an unreadable pause sentinel as paused', () => {
    render(
      <OvernightPanel
        read={ok(armedStatus())}
        snapshot={controlSnapshot({
          pause: {
            state: 'unknown',
            sourceState: 'degraded',
            reason: 'unreadable',
            note: '',
            pausedAt: null,
            by: null,
          },
        })}
        guard={guard()}
        dispatchEnabled
      />,
    );
    expect(screen.getByText(/fails safe rather than running on an unreadable signal/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// No backend
// ---------------------------------------------------------------------------

describe('OvernightPanel — absent backend', () => {
  it('renders a designed not-available state, not a crash and not a spinner', () => {
    renderPanel({
      value: null,
      available: false,
      reason: 'This build does not expose /api/verse/overnight, so an overnight run cannot be armed from here.',
    });

    expect(screen.getByText('Not available in this build.')).toBeInTheDocument();
    expect(screen.getByText(/does not expose \/api\/verse\/overnight/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Arm overnight run' })).toBeNull();
    expect(screen.queryByText('Reading the overnight lane…')).toBeNull();
  });

  it('renders a null read without crashing', () => {
    renderPanel(null);
    expect(screen.getByText('Not available in this build.')).toBeInTheDocument();
  });

  it('shows the loading line only while the first read is genuinely in flight', () => {
    render(
      <OvernightPanel read={null} snapshot={controlSnapshot()} guard={guard()} dispatchEnabled loading />,
    );
    expect(screen.getByText('Reading the overnight lane…')).toBeInTheDocument();
  });

  it('says the reading was unreadable when the route answered an unknown shape', () => {
    renderPanel({ value: null, available: true, reason: 'answered in a shape this client does not recognise' });
    expect(screen.getByText('Unreadable reading.')).toBeInTheDocument();
  });

  it('renders a read-only session without offering a control that would refuse', () => {
    render(
      <OvernightPanel
        read={ok(IDLE)}
        snapshot={controlSnapshot()}
        guard={guard()}
        dispatchEnabled={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Arm overnight run' })).toBeDisabled();
  });
});
