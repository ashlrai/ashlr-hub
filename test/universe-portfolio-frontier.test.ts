import { describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { buildUniversePortfolioPlan } from '../src/core/universe/portfolio-plan.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';

const sampledAt = '2026-09-09T00:00:00.000Z';

function definition(tasks: Array<[string, string[]]>): UniversePortfolioDefinition {
  return { schemaVersion: 1, id: 'frontier', maxParallel: 2, maxDurationMs: 60_000,
    tasks: tasks.map(([campaignId, dependsOn]) => ({ campaignId, dependsOn: [...dependsOn] })) };
}

function campaign(id: string, state: UniverseCampaignSummary['state'] = 'ready'): UniverseCampaignSummary {
  const campaignDefinition = { schemaVersion: 1 as const, id, universeId: `universe-${id}`, feedback: true,
    budget: { maxGenerations: 3, maxDurationMs: 60_000, maxModelRequests: 3, maxStagnantGenerations: 2, maxReportedTokens: null } };
  return { definition: campaignDefinition, definitionDigest: digest(canonical(campaignDefinition)), manifestDigest: 'a'.repeat(64),
    comparatorDigest: 'b'.repeat(64), createdAt: sampledAt, state, reason: null, startedAt: null, deadlineAt: null,
    finishedAt: null, steps: [], progress: { attempts: 0, completedRuns: 0, interruptedRuns: 0, reservedModelRequests: 0,
      reportedTokens: 0, recordedTokens: 0, usageComplete: true, admissions: 0, improvements: 0, stagnantGenerations: 0 },
    owner: null, sourceState: 'healthy', reasons: [] };
}

function plan(tasks: Array<[string, string[]]>, states: Record<string, UniverseCampaignSummary['state']> = {}) {
  const value = definition(tasks);
  return buildUniversePortfolioPlan(value, new Map(value.tasks.map((task) => [task.campaignId,
    campaign(task.campaignId, states[task.campaignId] ?? 'ready')])), sampledAt);
}

describe('Universe portfolio graph frontier', () => {
  it('projects a busy chain with causal roots, structural depth, and no scheduling claim', () => {
    const result = plan([['a', []], ['b', ['a']], ['c', ['b']]], { a: 'running' });
    const [a, b, c] = result.graph.nodes;
    expect(result.graph).toMatchObject({ schemaVersion: 1, scope: 'campaign-ordering-only', authority: 'observation-only',
      dependencyReadyCampaignIds: [], invocationCandidateIds: [], layers: [['a'], ['b'], ['c']],
      counts: { nodes: 3, edges: 2, states: { ready: 0, waiting: 2, completed: 0, blocked: 0, busy: 1, unavailable: 0 } } });
    expect(a).toMatchObject({ state: 'busy', unmetDependencyIds: [], waitingRootIds: ['a'], structuralDescendantIds: ['b', 'c'],
      affectedDescendantIds: ['b', 'c'], layer: 0 });
    expect(b).toMatchObject({ state: 'waiting', unmetDependencyIds: ['a'], waitingRootIds: ['a'], structuralDescendantIds: ['c'],
      affectedDescendantIds: [] });
    expect(c).toMatchObject({ state: 'waiting', unmetDependencyIds: ['b'], waitingRootIds: ['a'], structuralDescendantIds: [] });
  });

  it('deduplicates a blocked diamond root across every derived branch', () => {
    const result = plan([['a', []], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]], { a: 'failed' });
    expect(result.graph.nodes.map((node) => [node.campaignId, node.state, node.blockingRootIds]))
      .toEqual([['a', 'blocked', ['a']], ['b', 'blocked', ['a']], ['c', 'blocked', ['a']], ['d', 'blocked', ['a']]]);
    expect(result.graph.nodes[0]).toMatchObject({ structuralDescendantIds: ['b', 'c', 'd'], affectedDescendantIds: ['b', 'c', 'd'] });
    expect(result.graph.nodes[3]!.unmetDependencyIds).toEqual(['b', 'c']);
  });

  it('keeps mixed blocked, unavailable, and busy causes separate and bounded to the current state', () => {
    const value = definition([['blocked', []], ['missing', []], ['busy', []], ['join', ['blocked', 'missing', 'busy']], ['waiter', ['busy']]]);
    const evidence = new Map<string, UniverseCampaignSummary | null>([
      ['blocked', campaign('blocked', 'failed')], ['missing', null], ['busy', campaign('busy', 'running')],
      ['join', campaign('join')], ['waiter', campaign('waiter')],
    ]);
    const result = buildUniversePortfolioPlan(value, evidence, sampledAt);
    const byId = new Map(result.graph.nodes.map((node) => [node.campaignId, node]));
    expect(byId.get('blocked')).toMatchObject({ blockingRootIds: ['blocked'], affectedDescendantIds: ['join'] });
    expect(byId.get('missing')).toMatchObject({ blockingRootIds: ['missing'], affectedDescendantIds: ['join'] });
    expect(byId.get('busy')).toMatchObject({ waitingRootIds: ['busy'], affectedDescendantIds: ['join', 'waiter'] });
    expect(byId.get('join')).toMatchObject({ state: 'blocked', blockingRootIds: ['blocked', 'missing'], waitingRootIds: ['busy'] });
    expect(byId.get('waiter')).toMatchObject({ state: 'waiting', waitingRootIds: ['busy'] });
  });

  it('treats completed evidence as an ordering barrier while retaining existing ready semantics', () => {
    const result = plan([['failed', []], ['done', ['failed']], ['next', ['done']]], { failed: 'failed', done: 'completed' });
    const byId = new Map(result.graph.nodes.map((node) => [node.campaignId, node]));
    expect(result.nodes.map((node) => node.state)).toEqual(['blocked', 'completed', 'ready']);
    expect(result.graph.dependencyReadyCampaignIds).toEqual(['next']);
    expect(result.graph.invocationCandidateIds).toEqual(['next']);
    expect(byId.get('done')).toMatchObject({ unmetDependencyIds: [], blockingRootIds: [], waitingRootIds: [], affectedDescendantIds: [] });
    expect(byId.get('next')).toMatchObject({ unmetDependencyIds: [], blockingRootIds: [], waitingRootIds: [] });
  });

  it('keeps an intrinsic busy node as its own waiting root even with a failed ancestor', () => {
    const result = plan([['failed', []], ['busy', ['failed']], ['after-busy', ['busy']]], { failed: 'failed', busy: 'running' });
    const byId = new Map(result.graph.nodes.map((node) => [node.campaignId, node]));
    expect(byId.get('busy')).toMatchObject({ state: 'busy', blockingRootIds: [], waitingRootIds: ['busy'] });
    expect(byId.get('after-busy')).toMatchObject({ state: 'waiting', blockingRootIds: [], waitingRootIds: ['busy'] });
    expect(byId.get('failed')).toMatchObject({ affectedDescendantIds: [] });
  });

  it('stops causes at completed barriers while an alternate open path still reaches a shared descendant', () => {
    const result = plan([['failed', []], ['completed-barrier', ['failed']], ['alternate', ['failed']],
      ['join', ['completed-barrier', 'alternate']]], { failed: 'failed', 'completed-barrier': 'completed' });
    const byId = new Map(result.graph.nodes.map((node) => [node.campaignId, node]));
    expect(byId.get('completed-barrier')).toMatchObject({ blockingRootIds: [], affectedDescendantIds: [] });
    expect(byId.get('alternate')).toMatchObject({ blockingRootIds: ['failed'] });
    expect(byId.get('join')).toMatchObject({ state: 'blocked', blockingRootIds: ['failed'] });
    expect(byId.get('failed')).toMatchObject({ structuralDescendantIds: ['completed-barrier', 'alternate', 'join'],
      affectedDescendantIds: ['alternate', 'join'] });
  });

  it('suppresses invocation candidates for degraded sources without changing dependency-ready observation', () => {
    const value = definition([['missing', []], ['ready', []]]);
    const result = buildUniversePortfolioPlan(value, new Map([['missing', null], ['ready', campaign('ready')]]), sampledAt);
    expect(result.sourceState).toBe('degraded');
    expect(result.graph.dependencyReadyCampaignIds).toEqual(['ready']);
    expect(result.graph.invocationCandidateIds).toEqual([]);
  });

  it('supports the maximum dense DAG with caller-stable topology and detached graph arrays', () => {
    const ids = Array.from({ length: 64 }, (_, index) => `node-${index}`);
    const input = definition(ids.map((id, index) => [id, ids.slice(0, index)]));
    const snapshots = new Map(input.tasks.map((task) => [task.campaignId, campaign(task.campaignId)]));
    const first = buildUniversePortfolioPlan(input, snapshots, sampledAt);
    const second = buildUniversePortfolioPlan(input, snapshots, sampledAt);
    expect(first.graph.counts).toMatchObject({ nodes: 64, edges: 2_016, states: { ready: 1, waiting: 63 } });
    expect(first.topologicalOrder).toEqual(ids);
    expect(first.graph.layers).toEqual(ids.map((id) => [id]));
    expect(first.graph.nodes[0]!.structuralDescendantIds).toEqual(ids.slice(1));
    expect(first.graph.nodes[0]!.affectedDescendantIds).toEqual(ids.slice(1));
    expect(first.graph.nodes[63]!.waitingRootIds).toEqual(['node-0']);
    expect(first.graph).toEqual(second.graph);
    input.tasks[1]!.dependsOn.length = 0;
    snapshots.clear();
    first.graph.layers[0]!.push('mutated');
    first.graph.nodes[0]!.dependsOn.push('mutated');
    first.graph.nodes[1]!.waitingRootIds.push('mutated');
    first.graph.dependencyReadyCampaignIds.push('mutated');
    first.graph.invocationCandidateIds.push('mutated');
    first.nodes[1]!.dependsOn.push('mutated');
    expect(second.graph.layers[0]).toEqual(['node-0']);
    expect(second.graph.nodes[0]!.dependsOn).toEqual([]);
    expect(second.graph.nodes[1]!.waitingRootIds).toEqual(['node-0']);
    expect(second.graph.dependencyReadyCampaignIds).toEqual(['node-0']);
    expect(second.graph.invocationCandidateIds).toEqual(['node-0']);
    expect(second.nodes[1]!.dependsOn).toEqual(['node-0']);
  });

  it('retains definition node order while using caller-stable topological ordering for graph layers', () => {
    const result = plan([['dependent', ['root']], ['root', []], ['independent', []]]);
    expect(result.topologicalOrder).toEqual(['root', 'dependent', 'independent']);
    expect(result.graph.nodes.map((node) => node.campaignId)).toEqual(['dependent', 'root', 'independent']);
    expect(result.graph.layers).toEqual([['root', 'independent'], ['dependent']]);
    expect(result.graph.dependencyReadyCampaignIds).toEqual(['root', 'independent']);
    expect(result.graph.nodes[0]).toMatchObject({ state: 'waiting', waitingRootIds: ['root'] });
  });

  it('uses caller-stable topology for deduplicated ready roots, not direct dependency-array order', () => {
    const result = plan([['join', ['a', 'b']], ['b', []], ['a', []]]);
    expect(result.topologicalOrder).toEqual(['b', 'a', 'join']);
    expect(result.graph.nodes[0]).toMatchObject({ state: 'waiting', waitingRootIds: ['b', 'a'], unmetDependencyIds: ['a', 'b'] });
    expect(result.graph.nodes.find((node) => node.campaignId === 'b')).toMatchObject({ affectedDescendantIds: ['join'] });
    expect(result.graph.nodes.find((node) => node.campaignId === 'a')).toMatchObject({ affectedDescendantIds: ['join'] });
  });

  it('orders the ready frontier by topology instead of definition order across a completed barrier', () => {
    const result = plan([['child', ['completed-parent']], ['independent-root', []], ['completed-parent', []]],
      { 'completed-parent': 'completed' });
    expect(result.graph.nodes.map((node) => node.campaignId)).toEqual(['child', 'independent-root', 'completed-parent']);
    expect(result.topologicalOrder).toEqual(['independent-root', 'completed-parent', 'child']);
    expect(result.graph.dependencyReadyCampaignIds).toEqual(['independent-root', 'child']);
    expect(result.graph.invocationCandidateIds).toEqual(['independent-root', 'child']);
  });
});
