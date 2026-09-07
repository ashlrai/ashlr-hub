import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseGraph as GraphReport, UniverseGraphNode } from '../../../core/universe/graph-types.js';
import { evictAll } from '../../data/cache.js';
import { UniverseGraph } from './UniverseGraph.js';

function node(id: string, kind: UniverseGraphNode['kind'], label: string, extra: Partial<UniverseGraphNode> = {}): UniverseGraphNode {
  return { id, kind, label, universeId: 'compiler', state: 'recorded', evidence: 'recorded', ...extra };
}

function graph(extra: Partial<GraphReport> = {}): GraphReport {
  const nodes = [
    node('universe', 'universe', 'Compiler'), node('seed', 'seed', 'Pinned seed'), node('comparator', 'comparator', 'Pinned evaluator'),
    node('run-first', 'run', 'First run', { generation: 1, runId: 'run-first' }),
    node('first', 'trial', 'First candidate', { generation: 1, runId: 'run-first', trialId: 'trial-first', niche: 'efficient', score: 2 }),
    node('failed', 'trial', 'Failed correction', { generation: 1, runId: 'run-first', trialId: 'trial-failed', niche: 'accurate', state: 'failed', score: null }),
    node('run-next', 'run', 'Second run', { generation: 2, runId: 'run-next' }),
    node('current', 'trial', 'Current candidate', { generation: 2, runId: 'run-next', trialId: 'trial-current', niche: 'efficient', currentElite: true, score: 4 }),
    node('artifact', 'artifact', 'Current artifact', { generation: 2, runId: 'run-next', trialId: 'trial-current', artifactDigest: '[REDACTED]' }),
    node('delivery', 'delivery', 'Branch codex/fixture', { generation: 2, runId: 'run-next', trialId: 'trial-current', state: 'delivered', evidence: 'verified-local-delivery' }),
  ];
  const edges: GraphReport['edges'] = [
    { id: 'contains-first', from: 'universe', to: 'run-first', kind: 'contains' },
    { id: 'contains-next', from: 'universe', to: 'run-next', kind: 'contains' },
    { id: 'seed-first', from: 'seed', to: 'first', kind: 'seed-parent' },
    { id: 'seed-failed', from: 'seed', to: 'failed', kind: 'seed-parent' },
    { id: 'parent-current', from: 'first', to: 'current', kind: 'parent' },
    { id: 'feedback-current', from: 'failed', to: 'current', kind: 'feedback' },
    { id: 'evaluation-current', from: 'comparator', to: 'current', kind: 'evaluates' },
    { id: 'artifact-current', from: 'current', to: 'artifact', kind: 'produced' },
    { id: 'delivery-current', from: 'artifact', to: 'delivery', kind: 'delivered-as' },
  ];
  return { schemaVersion: 1, sampledAt: '2026-09-06T22:00:00.000Z', universeId: 'compiler', sourceState: 'healthy', complete: true,
    authority: 'observation-only', measurementScope: 'local-experiment', nodes, edges, findings: [], issues: [],
    counts: { nodes: nodes.length, edges: edges.length, trials: 3, currentElites: 1, verifiedDeliveries: 1 },
    limits: { maxNodes: 25000, maxEdges: 100000, maxFindings: 128 }, ...extra };
}

function mount(initial = graph(), onInspectTrial = vi.fn(() => true)) {
  let current = initial;
  let fail = false;
  const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(fail ? JSON.stringify({ error: 'Fixture unavailable' }) : JSON.stringify(current), { status: fail ? 503 : 200 }));
  vi.stubGlobal('fetch', fetch);
  render(<UniverseGraph universeId="compiler" onInspectTrial={onInspectTrial} />);
  return { fetch, onInspectTrial, update: (next: GraphReport) => { current = next; }, fail: () => { fail = true; } };
}

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open graph' }));
  await screen.findByText('Source: healthy');
  return user;
}

describe('Universe evidence graph', () => {
  beforeEach(() => evictAll());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('loads only on demand and performs no new read when selecting or filtering nodes', async () => {
    const { fetch } = mount();
    expect(fetch).not.toHaveBeenCalled();
    const user = await open();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]![0])).toContain('/api/universe/graph?universeId=compiler');
    await user.click(screen.getByRole('button', { name: 'Inspect trial: First candidate' }));
    await user.selectOptions(screen.getByLabelText('Entity type'), 'trial');
    await user.selectOptions(screen.getByLabelText('Niche'), 'efficient');
    expect(within(screen.getByRole('group', { name: 'Graph nodes' })).getAllByRole('button')).toHaveLength(2);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('distinguishes candidate parent from failed-attempt feedback and opens the exact selected trial', async () => {
    const { onInspectTrial } = mount();
    const user = await open();
    const inspector = screen.getByRole('region', { name: 'Selected graph evidence' });
    expect(within(inspector).getByText('Candidate parent from')).toBeInTheDocument();
    expect(within(inspector).getByText('Evaluator feedback from')).toBeInTheDocument();
    expect(within(inspector).getByRole('button', { name: 'Failed correction' })).toBeInTheDocument();
    await user.click(within(inspector).getByRole('button', { name: 'Inspect exact trial evidence' }));
    expect(onInspectTrial).toHaveBeenCalledWith('run-next', 'trial-current');
    await user.click(within(inspector).getByRole('button', { name: 'Failed correction' }));
    expect(within(inspector).getByRole('heading', { name: 'Failed correction' })).toBeInTheDocument();
    expect(within(inspector).getByText('failed', { selector: 'dd' })).toBeInTheDocument();
    expect(within(inspector).queryByText('Current local elite')).not.toBeInTheDocument();
  });

  it('traverses ancestors with an explicit depth limit independently from source completeness', async () => {
    mount(); const user = await open();
    await user.selectOptions(screen.getByLabelText('Trace from selection'), 'ancestors');
    await user.selectOptions(screen.getByLabelText('Traversal depth'), '1');
    const nodes = screen.getByRole('group', { name: 'Graph nodes' });
    expect(within(nodes).getAllByRole('button')).toHaveLength(4);
    expect(within(nodes).queryByRole('button', { name: 'Inspect seed: Pinned seed' })).not.toBeInTheDocument();
    expect(screen.getByText(/Traversal is incomplete; the depth bound/)).toBeInTheDocument();
    expect(screen.getByText('Source graph complete')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Traversal depth'), '2');
    expect(within(nodes).getByRole('button', { name: 'Inspect seed: Pinned seed' })).toBeInTheDocument();
    expect(screen.queryByText(/Traversal is incomplete; the depth bound/)).not.toBeInTheDocument();
  });

  it('traverses descendants without reversing the feedback relationship', async () => {
    mount(); const user = await open();
    await user.click(screen.getByRole('button', { name: 'Inspect trial: First candidate' }));
    await user.selectOptions(screen.getByLabelText('Trace from selection'), 'descendants');
    const nodes = screen.getByRole('group', { name: 'Graph nodes' });
    expect(within(nodes).getByRole('button', { name: 'Inspect trial: Current candidate' })).toBeInTheDocument();
    expect(within(nodes).getByRole('button', { name: 'Inspect artifact: Current artifact' })).toBeInTheDocument();
    expect(within(nodes).queryByRole('button', { name: 'Inspect trial: Failed correction' })).not.toBeInTheDocument();
    expect(within(nodes).queryByRole('button', { name: 'Inspect delivery: Branch codex/fixture' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Traversal depth'), '3');
    expect(within(nodes).getByRole('button', { name: 'Inspect delivery: Branch codex/fixture' })).toBeInTheDocument();
  });

  it('preserves node selection across refresh and explicitly reports disappearance instead of substituting a trial', async () => {
    const value = graph(); const fixture = mount(value); const user = await open();
    await user.click(screen.getByRole('button', { name: 'Inspect trial: First candidate' }));
    fixture.update({ ...value, sampledAt: '2026-09-06T22:01:00.000Z', nodes: value.nodes.map((item) => item.id === 'first' ? { ...item, label: 'First candidate refreshed' } : item) });
    await user.click(screen.getByRole('button', { name: 'Refresh graph' }));
    await screen.findByRole('heading', { name: 'First candidate refreshed' });
    fixture.update({ ...value, nodes: value.nodes.filter((item) => item.id !== 'first'), edges: value.edges.filter((edge) => edge.from !== 'first' && edge.to !== 'first') });
    await user.click(screen.getByRole('button', { name: 'Refresh graph' }));
    await screen.findByText(/selected node is no longer present/);
    expect(screen.queryByRole('region', { name: 'Selected graph evidence' })).not.toBeInTheDocument();
    expect(fixture.onInspectTrial).not.toHaveBeenCalled();
  });

  it('does not navigate to a substitute when graph and overview observations disagree', async () => {
    const onInspectTrial = vi.fn(() => false); mount(graph(), onInspectTrial); const user = await open();
    await user.click(screen.getByRole('button', { name: 'Inspect exact trial evidence' }));
    expect(onInspectTrial).toHaveBeenCalledWith('run-next', 'trial-current');
    expect(screen.getByText(/exact trial is not present in the current overview/)).toBeInTheDocument();
  });

  it('retains the last successful graph on transport failure with an explicit stale notice', async () => {
    const fixture = mount(); const user = await open(); fixture.fail();
    await user.click(screen.getByRole('button', { name: 'Refresh graph' }));
    await screen.findByRole('alert');
    expect(screen.getByText(/Last successful read/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspect trial: Current candidate' })).toBeInTheDocument();
  });

  it('keeps privacy-redacted artifacts distinct and separates recorded from checked delivery evidence', async () => {
    const value = graph(); value.nodes.push(node('artifact-other', 'artifact', 'Previous artifact', { artifactDigest: '[REDACTED]' }));
    mount(value); const user = await open();
    await user.selectOptions(screen.getByLabelText('Entity type'), 'artifact');
    expect(within(screen.getByRole('group', { name: 'Graph nodes' })).getAllByRole('button')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Inspect artifact: Previous artifact' }));
    const inspector = screen.getByRole('region', { name: 'Selected graph evidence' });
    expect(within(inspector).getByText('Recorded evidence')).toBeInTheDocument();
    await user.click(within(inspector).getByText('Record identity'));
    expect(within(inspector).getByText('Hidden by the console privacy filter')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Entity type'), 'delivery');
    await user.click(screen.getByRole('button', { name: 'Inspect delivery: Branch codex/fixture' }));
    expect(within(inspector).getByText('Local delivery checked')).toBeInTheDocument();
  });

  it('keeps incomplete observed usage distinct from a complete repeated-output total', async () => {
    const value = graph({ findings: [{ id: 'repeat', kind: 'repeated-output', nodeIds: ['first', 'current'], trialIds: ['trial-first', 'trial-current'], artifactDigest: '[REDACTED]', trialCount: 2, recordedTokens: 123, reportedTokens: null, usageComplete: false }] });
    mount(value); await open();
    const findings = screen.getByRole('region', { name: 'Graph observations' });
    expect(within(findings).getByText(/Total generation tokens unavailable; recorded subtotal: 123/)).toBeInTheDocument();
    expect(within(findings).getByText(/not cost savings/)).toBeInTheDocument();
  });

  it('displays zero reported usage as zero and keeps undelivered findings observational', async () => {
    const value = graph({ findings: [
      { id: 'repeat', kind: 'repeated-output', nodeIds: ['first', 'current'], trialIds: ['trial-first', 'trial-current'], artifactDigest: '[REDACTED]', trialCount: 2, recordedTokens: 0, reportedTokens: 0, usageComplete: true },
      { id: 'undelivered', kind: 'undelivered-current-elite', nodeIds: ['current'], trialIds: ['trial-current'], artifactDigest: '[REDACTED]', trialCount: 1, recordedTokens: 0, reportedTokens: null, usageComplete: false },
    ] });
    mount(value); await open();
    expect(screen.getByText(/Reported generation tokens: 0/)).toBeInTheDocument();
    expect(screen.getByText('No verified delivery is linked to this current local elite in the observation.')).toBeInTheDocument();
  });

  it('provides every matching node through bounded pages and moves to a finding selection', async () => {
    const nodes = Array.from({ length: 65 }, (_, i) => node(`page-${i}`, 'trial', `Candidate ${i}`, { trialId: `trial-${i}`, runId: 'run-first' }));
    mount(graph({ nodes, edges: [], findings: [{ id: 'late', kind: 'undelivered-current-elite', nodeIds: ['page-64'], trialIds: ['trial-64'], artifactDigest: '[REDACTED]', trialCount: 1, recordedTokens: 0, reportedTokens: null, usageComplete: false }] }));
    const user = await open(); const list = screen.getByRole('group', { name: 'Graph nodes' });
    expect(within(list).getAllByRole('button')).toHaveLength(60);
    await user.click(screen.getByRole('button', { name: 'Next node page' }));
    expect(within(list).getAllByRole('button')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Previous node page' }));
    await user.click(screen.getByRole('button', { name: 'Inspect Candidate 64' }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Inspect trial: Candidate 64' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('supports keyboard selection directly in the graph', async () => {
    mount(); const user = await open();
    const target = screen.getByRole('button', { name: 'Select trial: First candidate' });
    target.focus(); await user.keyboard('{Enter}');
    expect(target).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('region', { name: 'Selected graph evidence' })).getByRole('heading', { name: 'First candidate' })).toBeInTheDocument();
  });

  it('shows incomplete source diagnostics without describing unreadable evidence as a clean empty graph', async () => {
    mount(graph({ sourceState: 'degraded', complete: false, nodes: [], edges: [], issues: [{ code: 'source-unavailable', message: 'The recorded source could not be read.', nodeIds: [] }] }));
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Open graph' }));
    await screen.findByText('Source: degraded');
    expect(screen.getByText(/Graph nodes could not be established from incomplete evidence/)).toBeInTheDocument();
    await user.click(screen.getByText('Source issues (1)'));
    expect(screen.getByText(/The recorded source could not be read/)).toBeInTheDocument();
    expect(screen.queryByText('This observation contains no graph nodes.')).not.toBeInTheDocument();
  });

  it('does not poll graph data after opening or closing the inspector', async () => {
    const fixture = mount(); const user = await open();
    await user.click(screen.getByRole('button', { name: 'Close graph' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Graph nodes' })).not.toBeInTheDocument());
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });
});
