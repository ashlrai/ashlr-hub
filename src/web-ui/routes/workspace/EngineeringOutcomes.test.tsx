import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceEngineeringOutcomes as Outcomes } from '../../../core/resources/engineering-outcomes-types.js';
import { EngineeringOutcomes } from './EngineeringOutcomes.js';
import { WorkspaceEngineering } from './WorkspaceEngineering.js';
import { engineeringEnrollment, engineeringJob, engineeringReadiness } from './engineering-fixture.test-support.js';
import { phaseFixture } from './engineering-phase-fixture.test-support.js';
import { markCheckComplete } from '../../data/auth-store.js';
const enrollment = engineeringEnrollment();
const usage = () => ({ attempts: 1, joinedAttempts: 1, reportedAttempts: 1, unknownAttempts: 0, recordedInputTokens: 20, recordedOutputTokens: 10, totalTokens: 30, complete: true });
const timing = () => ({ scope: 'summed-worker-execution' as const, attempts: 1, measuredAttempts: 1, recordedDurationMs: 125, totalDurationMs: 125, complete: true });
function fixture(): Outcomes {
  return { schemaVersion: 1, enrollmentId: enrollment.id, enrollmentDigest: enrollment.enrollmentDigest, sampledAt: '2026-09-11T00:00:00.000Z', sourceState: 'healthy',
    scope: 'campaign-evaluations-and-recorded-worker-usage', authority: 'observation-only', acceptanceScope: 'fixed-evaluator-and-local-branch-only',
    attribution: 'campaign-cumulative-not-graph-invocation', productionAccepted: null, routingChanged: false, complete: true, reasons: [], usage: usage(), timing: timing(),
    campaigns: [{ campaignId: enrollment.campaigns[0]!.id, universeId: 'integer', definitionDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), state: 'completed', sourceState: 'healthy', reasons: [],
      metric: { name: 'value', direction: 'maximize', minImprovement: 1 }, seed: { status: 'measured', score: 0, passed: false },
      stages: { trials: 1, evaluated: 1, passed: 1, rejected: 0, selected: 1, strictImprovements: 0, verifiedLocalDeliveries: 1 }, usage: usage(), timing: timing(),
      niches: [{ niche: 'integer', score: 3, deltaFromSeed: 3, artifactDigest: 'd'.repeat(64), runId: 'run-1', trialId: 'trial-1' }],
      workers: [{ workerId: 'local-fixture', provider: 'local', model: 'fixture-model', evaluated: 1, passed: 1, rejected: 0, usage: usage(), timing: timing() }] }] };
}
let value: Outcomes;
beforeEach(() => {
  window.history.replaceState(null, '', '/resources/');
  markCheckComplete(true); value = fixture();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(value), { status: 200 })));
});
afterEach(() => { act(() => markCheckComplete(false)); window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const read = () => fireEvent.click(screen.getByRole('button', { name: 'Read outcome evidence' }));
describe('on-demand engineering outcomes', () => {
  it('constrains the outer grid track while keeping wide evidence tables locally scrollable', () => {
    // jsdom does not calculate layout; actual 390px browser geometry is checked
    // separately. Guard the root min-content fix that makes local scroll possible.
    const resourceViewCss = readFileSync('src/web-ui/routes/resources/ResourcePoolView.module.css', 'utf8');
    const outcomesCss = readFileSync('src/web-ui/routes/workspace/EngineeringOutcomes.module.css', 'utf8');
    const view = /\.view\s*\{([^}]+)\}/.exec(resourceViewCss)?.[1];
    expect(view).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(resourceViewCss).toMatch(/\.view\s*>\s*\*\s*\{\s*min-width:\s*0;/);
    expect(outcomesCss).toMatch(/\.tableScroll\s*\{[^}]*overflow-x:\s*auto;/);
  });
  it('does not auto-read, then shows separate evaluation, seed and local delivery stages', async () => {
    render(<EngineeringOutcomes enrollment={enrollment} available />);
    expect(fetch).not.toHaveBeenCalled(); read();
    await screen.findByText('Seed measurement: measured; score 0; failed.');
    const stages = within(screen.getByRole('region', { name: 'integer-campaign evaluation stages' }));
    expect(stages.getAllByRole('cell').map(c => c.textContent)).toEqual(['1', '1', '1', '0', '1', '0', '1']);
    expect(screen.getByText(/not a trial parent or a rewritten trial delta/)).toBeInTheDocument();
    expect(screen.getByText(/Campaign totals include historical work/)).toBeInTheDocument();
    expect(screen.getByText(/Production acceptance is unmeasured/)).toBeInTheDocument();
    expect(screen.getAllByText('125 ms summed worker execution')).toHaveLength(3);
    expect(screen.getByText('run-1')).toBeInTheDocument(); expect(screen.getByText('trial-1')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Campaign and worker attribution'));
    expect(screen.getByText('local-fixture')).toBeInTheDocument(); expect(screen.getByText('local / fixture-model')).toBeInTheDocument();
    expect(screen.getByText('c'.repeat(64))).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
    const request = vi.mocked(fetch).mock.calls[0]!;
    expect(request[0]).toBe('/api/resources/engineering/default-build/outcomes');
    expect(request[1]?.method).toBe('GET'); expect(request[1]?.headers).not.toHaveProperty('x-ashlr-token');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh outcome evidence' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
  it('renders incomplete tokens as a subtotal and unavailable delivery as unknown', async () => {
    value.complete = false; value.sourceState = 'degraded'; value.reasons = ['outcome-evidence-incomplete'];
    value.usage = { ...usage(), attempts: 2, unknownAttempts: 1, complete: false, totalTokens: null };
    value.timing = { ...timing(), attempts: 2, complete: false, totalDurationMs: null };
    value.campaigns[0]!.stages.verifiedLocalDeliveries = null;
    render(<EngineeringOutcomes enrollment={enrollment} available />); read();
    await screen.findByText('30 recorded token subtotal');
    expect(screen.getByText('1 of 2 attempts report usage; 1 unknown.')).toBeInTheDocument();
    expect(screen.getByText('Total usage is unavailable.')).toBeInTheDocument();
    expect(screen.getByText('125 ms recorded execution subtotal')).toBeInTheDocument();
    expect(screen.getByText('Total execution time is unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Some outcome or usage evidence is incomplete.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'integer-campaign evaluation stages' })).getByText('Unavailable')).toBeInTheDocument();
  });
  it('clears old evidence on a failed refresh and never exposes raw errors', async () => {
    render(<EngineeringOutcomes enrollment={enrollment} available />); read(); await screen.findByText('run-1');
    vi.mocked(fetch).mockRejectedValueOnce(new Error('/private/token'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh outcome evidence' })); await screen.findByRole('alert');
    expect(screen.queryByText('run-1')).not.toBeInTheDocument(); expect(screen.queryByText(/private\/token/)).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([429, 504])('shows a fixed actionable read message for HTTP %s without automatic retry', async status => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: '/private/token' }), { status }));
    render(<EngineeringOutcomes enrollment={enrollment} available />); read();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(status === 429 ? 'proof read is in progress' : 'proof exceeded its read deadline');
    expect(alert).not.toHaveTextContent('/private/token');
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Read outcome evidence' })).toBeEnabled();
  });
  it.each([
    { status: 429, code: 'OUTCOME_READ_BUSY', message: 'Another outcome proof read is in progress.' },
    { status: 504, code: 'OUTCOME_READ_TIMEOUT', message: 'Outcome proof exceeded its read deadline.' },
    { status: 503, code: 'OUTCOME_READ_UNAVAILABLE', message: 'Outcome reader is unavailable. Check the local console diagnostics.' },
  ])('recovers only on operator request after a $status refresh, without preserving stale phase success', async ({ status, code, message }) => {
    value.campaigns[0]!.phaseEvidence = phaseFixture();
    const view = render(<EngineeringOutcomes enrollment={enrollment} available />);
    read(); await screen.findByText('run-1');
    fireEvent.click(screen.getByText('Generation 1'));
    expect(screen.getByText('Evaluator process group settled')).toBeVisible();
    let settle!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { settle = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh outcome evidence' }));
    const pending = screen.getByRole('button', { name: 'Reading outcome evidence…' });
    expect(pending).toBeDisabled(); expect(screen.getByRole('status')).toHaveTextContent('Reading campaign and local delivery evidence');
    fireEvent.click(pending); expect(fetch).toHaveBeenCalledTimes(2);
    // Local disclosure controls still work while the asynchronous proof is pending.
    fireEvent.click(screen.getByText('Campaign and worker attribution'));
    expect(screen.getByText('local-fixture')).toBeVisible();
    await act(async () => settle(new Response(JSON.stringify({ code, error: '/private/token: native cleanup details' }), { status })));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message); expect(alert).toHaveTextContent('No work was started.');
    expect(alert).not.toHaveTextContent('/private/token');
    expect(screen.queryByText('run-1')).not.toBeInTheDocument();
    expect(screen.queryByText('Evaluator process group settled')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'integer-campaign evaluation stages' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    view.rerender(<EngineeringOutcomes enrollment={{ ...enrollment }} available />);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(fetch).toHaveBeenCalledTimes(2); expect(screen.getByRole('button', { name: 'Read outcome evidence' })).toBeEnabled();

    value = fixture(); value.campaigns[0]!.niches[0]!.runId = 'recovered-run';
    value.campaigns[0]!.phaseEvidence = { ...phaseFixture(), sourceState: 'unavailable', reason: 'phase-evidence-changed', seed: null, runs: [] };
    read(); await screen.findByText('recovered-run');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/changed during this read/)).toBeInTheDocument();
    expect(screen.queryByText('Evaluator process group settled')).not.toBeInTheDocument();
    expect(screen.getAllByText('30 reported tokens')).toHaveLength(3);
    expect(screen.getByText(/Production acceptance is unmeasured/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls.every(([path, options]) => String(path).endsWith('/outcomes') && options?.method === 'GET')).toBe(true);
  });
  it('aborts a disconnected read and ignores its late timeout after an explicit recovery succeeds', async () => {
    let settleOld!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { settleOld = resolve; }));
    const view = render(<EngineeringOutcomes enrollment={enrollment} available />); read();
    const abandonedSignal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    expect(abandonedSignal.aborted).toBe(false);
    view.rerender(<EngineeringOutcomes enrollment={enrollment} available={false} />);
    expect(abandonedSignal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Read outcome evidence' })).toBeDisabled();
    view.rerender(<EngineeringOutcomes enrollment={enrollment} available />);
    expect(fetch).toHaveBeenCalledOnce(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    value.campaigns[0]!.niches[0]!.runId = 'reconnected-run';
    read(); await screen.findByText('reconnected-run');
    await act(async () => settleOld(new Response(JSON.stringify({ error: '/private/stale-timeout' }), { status: 504 })));
    expect(screen.getByText('reconnected-run')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh outcome evidence' })).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps cleanup uncertainty visible when another operator read is also refused', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      code: 'OUTCOME_READ_CLEANUP_UNCONFIRMED', error: '/private/native/error',
    }), { status: 503 }));
    render(<EngineeringOutcomes enrollment={enrollment} available />);
    read();
    expect(await screen.findByRole('alert')).toHaveTextContent('If cleanup is unconfirmed');
    expect(fetch).toHaveBeenCalledOnce();
    read();
    expect(await screen.findByRole('alert')).toHaveTextContent('retrying cannot clear it');
    expect(screen.getByRole('alert')).not.toHaveTextContent('/private/');
    expect(screen.queryByText('run-1')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });
  it.each(['enrollment', 'project', 'session', 'connection'])('clears evidence when %s changes, without a new read', async kind => {
    const view = render(<EngineeringOutcomes enrollment={enrollment} available />); read(); await screen.findByText('run-1');
    if (kind === 'session') act(() => markCheckComplete(false));
    else view.rerender(<EngineeringOutcomes enrollment={kind === 'project' ? { ...enrollment, projectId: 'other' } : kind === 'enrollment' ? { ...enrollment, enrollmentDigest: 'f'.repeat(64) } : enrollment} available={kind !== 'connection'} />);
    expect(screen.queryByText('run-1')).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('discards a late read after a project change', async () => {
    let resolve!: (v: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
    const view = render(<EngineeringOutcomes enrollment={enrollment} available />); read();
    view.rerender(<EngineeringOutcomes enrollment={engineeringEnrollment('other')} available />);
    await act(async () => resolve(new Response(JSON.stringify(value), { status: 200 })));
    expect(screen.queryByText('run-1')).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('is disabled when disconnected and never treats malformed evidence as acceptance', async () => {
    const view = render(<EngineeringOutcomes enrollment={enrollment} available={false} />);
    expect(screen.getByRole('button', { name: 'Read outcome evidence' })).toBeDisabled(); expect(fetch).not.toHaveBeenCalled();
    view.rerender(<EngineeringOutcomes enrollment={enrollment} available />);
    Object.assign(value, { productionAccepted: 1 }); read(); await screen.findByRole('alert');
    expect(screen.queryByText('run-1')).not.toBeInTheDocument();
  });
  it('does not present unavailable campaign counters as observed zero or a prior success', async () => {
    value.sourceState = 'degraded'; value.complete = false; value.campaigns[0]!.sourceState = 'unavailable';
    value.campaigns[0]!.reasons = ['campaign-evidence-unavailable'];
    render(<EngineeringOutcomes enrollment={enrollment} available />); read();
    await screen.findByText(/No zero-outcome claim is made/);
    expect(screen.queryByRole('region', { name: 'integer-campaign evaluation stages' })).not.toBeInTheDocument();
    expect(screen.queryByText('run-1')).not.toBeInTheDocument(); expect(screen.queryByText(/Seed measurement:/)).not.toBeInTheDocument();
  });
  it('is capability-gated in the engineering workspace and graph reads never trigger outcomes', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const path = String(input);
      const response = path === '/api/resources/engineering' ? [enrollment] : path.endsWith('/readiness') ? engineeringReadiness(enrollment) :
        path.endsWith('/outcomes') ? value : engineeringJob(enrollment);
      return new Response(JSON.stringify(response), { status: 200 });
    });
    const props = { projectId: 'default', projectName: 'Default', available: true, canStart: true, canStop: true, unlocked: false, onUnlock: vi.fn() };
    const view = render(<WorkspaceEngineering {...props} />);
    await screen.findByText('OBJECTIVE SUMMARY');
    expect(screen.queryByRole('button', { name: 'Read outcome evidence' })).not.toBeInTheDocument();
    view.rerender(<WorkspaceEngineering {...props} outcomesSupported />);
    expect(await screen.findByRole('button', { name: 'Read outcome evidence' })).toBeEnabled();
    expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/outcomes'))).toHaveLength(0);
    read(); await screen.findByText('run-1');
    expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/outcomes'))).toHaveLength(1);
  });
});
