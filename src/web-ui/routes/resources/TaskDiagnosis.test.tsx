import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceNativeProcessDiagnostic } from '../../../core/resources/native-diagnostics.js';
import type { ResourceTaskReceipt } from '../../../core/resources/pool-runtime.js';
import { buildResourceFleet } from './fleet-model.js';
import { resourceFixture } from './fixtures.test-support.js';
import { TaskDiagnosis } from './TaskDiagnosis.js';
import { TaskInspector } from './TaskInspector.js';

const native: ResourceNativeProcessDiagnostic = { schemaVersion: 1, scope: 'native-process',
  exitCode: 1, signal: null, stderrPresent: true, outputTruncated: false };
function receipt(patch: Partial<ResourceTaskReceipt> = {}): ResourceTaskReceipt {
  return { ...resourceFixture().snapshot.recentAttempts[0]!, workerId: 'codex-a', capacityKey: 'codex-account',
    status: 'failed', outputDigest: null, reason: 'worker-exit-failed', nativeProcess: { ...native }, ...patch };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('receipt-bound task diagnosis', () => {
  it('shows measured process facts without guessing a provider fault or fetching output', () => {
    render(<TaskDiagnosis receipt={receipt()} />);
    const region = within(screen.getByRole('region', { name: 'Receipt diagnosis' }));
    expect(region.getByRole('heading', { name: 'Receipt diagnosis' })).toBeVisible();
    expect(region.getByText(/exit status alone does not identify an authentication, quota, or provider fault/)).toBeVisible();
    expect(screen.getByText('Native exit code').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Native signal').parentElement).toHaveTextContent('Not reported');
    expect(screen.getByText('Stderr captured').parentElement).toHaveTextContent('Yes. Captured stderr may include runner notices');
    expect(screen.getByText('Capture truncated').parentElement).toHaveTextContent('No. Bounded stdout or stderr capture');
    expect(region.getByText(/No automatic retry/)).toBeVisible();
    expect(region.getByText(/Process facts do not establish accepted work/)).toBeVisible();
    expect(region.queryByRole('button')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a failed terminal reason authoritative when the measured exit code is zero', () => {
    render(<TaskDiagnosis receipt={receipt({ reason: 'worker-terminal-failed', nativeProcess: { ...native, exitCode: 0, stderrPresent: false } })} />);
    expect(screen.getByText('Native exit code').parentElement).toHaveTextContent('0');
    expect(screen.getByText(/zero exit code does not override that result/)).toBeVisible();
    expect(screen.getByText('Stderr captured').parentElement).toHaveTextContent('No. Captured stderr may include runner notices');
    expect(screen.queryByText(/no error|successful execution/i)).not.toBeInTheDocument();
  });

  it('shows a signal and truncation without inventing a measured exit for uncertain termination', () => {
    render(<TaskDiagnosis receipt={receipt({ status: 'uncertain', reason: 'worker-termination-uncertain',
      nativeProcess: { ...native, exitCode: null, signal: 'SIGKILL', outputTruncated: true } })} />);
    expect(screen.getByText('Native exit code').parentElement).toHaveTextContent('Not reported');
    expect(screen.getByText('Native signal').parentElement).toHaveTextContent('SIGKILL');
    expect(screen.getByText('Capture truncated').parentElement).toHaveTextContent('Yes.');
    expect(screen.getByText(/continues occupying shared capacity/)).toBeVisible();
    expect(screen.getByText(/Do not delete the ledger to release capacity/)).toBeVisible();
  });

  it.each([
    ['worker-cli-upgrade-required', 'Native CLI upgrade required', /recheck the enrolled account and quota/],
    ['worker-terminal-missing', 'Complete terminal event missing', /supported event format/],
    ['worker-invalid-events', 'Native events could not be validated', /supported event format/],
    ['worker-process-failed', 'Native process could not complete', /configured launcher and native executable/],
    ['worker-output-truncated', 'Native capture was truncated', /Reduce the task or response scope/],
    ['worker-output-token-limit', 'Reported output exceeded the task limit', /deliberately review the task budget/],
    ['worker-timed-out', 'Worker deadline reached', /confirm cleanup and fresh capacity evidence/],
    ['worker-cancelled', 'Worker invocation cancelled', /recorded task and cancellation intent/],
  ] as const)('offers a fixed next check for %s', (reason, label, nextCheck) => {
    render(<TaskDiagnosis receipt={receipt({ reason })} />);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(nextCheck)).toBeVisible();
  });

  it.each(['worker-exit-failed', 'worker-transport-failed', 'worker-invalid-configuration'])('keeps missing diagnostics unknown for %s', (reason) => {
    render(<TaskDiagnosis receipt={receipt({ reason, nativeProcess: undefined })} />);
    expect(screen.getByText(/Native process details were not recorded/)).toBeVisible();
    expect(screen.getByText(/Missing details are not a zero exit code/)).toBeVisible();
    expect(screen.queryByText('Native exit code')).not.toBeInTheDocument();
    expect(screen.queryByText('Stderr captured')).not.toBeInTheDocument();
  });

  it.each([undefined, receipt({ status: 'reserved', nativeProcess: undefined }), receipt({ status: 'completed', reason: 'worker-completed' })])(
    'does not label an absent, reserved, or completed receipt as a failure %#', (value) => {
      const { container } = render(<TaskDiagnosis receipt={value} />);
      expect(container).toBeEmptyDOMElement();
    });

  it.each([
    { ...native, stderr: 'PRIVATE_ERROR /private/auth fixture@example.invalid' },
    { ...native, exitCode: -1 }, { ...native, exitCode: 256 }, { ...native, exitCode: 1.5 },
    { ...native, signal: 'PRIVATE_SIGNAL' }, { ...native, signal: 'SIGTERM' },
    { ...native, schemaVersion: 2 }, { ...native, scope: 'PRIVATE_SCOPE' },
    { ...native, stderrPresent: 'PRIVATE_STDERR' }, { ...native, outputTruncated: 1 },
    null,
  ])('does not render unsupported native details or private fields %#', (value) => {
    const row = receipt(); Object.assign(row, { nativeProcess: value });
    const { container } = render(<TaskDiagnosis receipt={row} />);
    expect(screen.getByText(/Native process details are unavailable or unsupported/)).toBeVisible();
    expect(screen.queryByText('Native exit code')).not.toBeInTheDocument();
    for (const privateValue of ['PRIVATE_', '/private/', 'fixture@example.invalid']) expect(container.innerHTML).not.toContain(privateValue);
  });

  it.each(['private-provider-error', '__proto__', 'constructor'])('never echoes an unknown reason from either source: %s', (reason) => {
    const row = receipt({ reason });
    const job = { ...resourceFixture().snapshot.supervisor!.jobs[2]!, reason, outputAvailable: false };
    const { container } = render(<TaskInspector row={{ id: row.id, receipt: row, job }} enabled busy={false} onCancel={vi.fn()} />);
    expect(screen.getAllByText('Unrecognized recorded reason')).toHaveLength(2);
    expect(screen.getByText(/without a recognized diagnosis/)).toBeVisible();
    expect(container.innerHTML).not.toContain(reason);
    expect(container.textContent).not.toContain(reason.replaceAll('-', ' '));
  });

  it('keeps unknown uncertain receipts occupied without guessing their cause', () => {
    render(<TaskDiagnosis receipt={receipt({ status: 'uncertain', reason: 'future-reason', nativeProcess: undefined })} />);
    expect(screen.getByText(/This unresolved receipt still occupies capacity/)).toBeVisible();
    expect(screen.getByText(/No provider cause can be inferred/)).toBeVisible();
  });

  it('binds diagnosis to the failed receipt when the supervisor reports completion, without reading output or retrying', () => {
    const { snapshot } = resourceFixture();
    snapshot.recentAttempts[0] = receipt({ reason: 'worker-cli-upgrade-required' });
    const job = snapshot.supervisor!.jobs[2]!;
    Object.assign(job, { workerId: 'codex-a', reason: 'worker-completed' });
    const row = buildResourceFleet(snapshot).tasks.find((task) => task.id === job.id)!;
    const cancel = vi.fn();
    render(<TaskInspector row={row} fleetTask={row} enabled busy={false} onCancel={cancel} />);
    expect(screen.getByText('Supervisor reason').parentElement).toHaveTextContent('Worker completed');
    expect(screen.getByText('Receipt state').parentElement).toHaveTextContent('failed');
    expect(screen.getByText(/Supervisor and receipt states differ/)).toBeVisible();
    const diagnosis = within(screen.getByRole('region', { name: 'Receipt diagnosis' }));
    expect(diagnosis.getByText('Native CLI upgrade required')).toBeVisible();
    expect(diagnosis.getByText(/not the supervisor’s current state/)).toBeVisible();
    expect(screen.getByText('Verified accepted work').parentElement).toHaveTextContent('Not measured');
    expect(diagnosis.queryByRole('button')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  });
});
