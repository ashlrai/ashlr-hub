import { describe, expect, it } from 'vitest';
import { buildUniverseGraph } from '../src/core/universe/graph.js';
import { traverseUniverseGraph } from '../src/core/universe/graph-query.js';
import type { UniverseOverview, UniverseRun, UniverseTrial } from '../src/core/universe/types.js';
import type { UniverseDeliveryReceipt } from '../src/core/universe/delivery.js';

const H = 'a'.repeat(64);
const M = 'c'.repeat(64);
const C = 'd'.repeat(64);
const REV = 'b'.repeat(40);
function fixture(): UniverseOverview {
  const runs: UniverseRun[] = [1, 2, 3].map((generation) => {
    const trial: UniverseTrial = { id: `trial-${generation}`, variantId: 'repair', niche: 'correctness',
      parentTrialId: generation === 1 ? null : 'trial-1', status: 'passed', score: 10, metrics: {},
      artifact: { path: `/private/archive/run-${generation}/trial-${generation}`, digest: H, revision: REV },
      durationMs: 100, delta: generation === 1 ? null : 0, selected: generation === 1,
      generation: { schemaVersion: 1, provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture',
        status: 'succeeded', requestStarted: true, promptDigest: 'e'.repeat(64), responseDigest: 'f'.repeat(64), durationMs: 50,
        usage: { state: 'reported', inputTokens: generation * 10, outputTokens: 5 }, changedFiles: generation === 1 ? ['value.txt'] : [],
        ...(generation === 1 ? {} : { feedback: { runId: `run-${generation - 1}`, trialId: `trial-${generation - 1}`, generation: generation - 1,
          comparatorDigest: C, artifactDigest: H, digest: '1'.repeat(64) } }) } };
    return { id: `run-${generation}`, universeId: 'fixture', generation, manifestDigest: M, comparatorDigest: C,
      startedAt: `2026-09-06T12:00:0${generation}.000Z`, finishedAt: `2026-09-06T12:00:1${generation}.000Z`,
      status: 'completed', trials: [trial], durationMs: 100, tokensUsed: generation * 10 + 5, costUsd: null,
      generationUsage: { scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 1, inputTokens: generation * 10, outputTokens: 5 },
      feedbackEnabled: true };
  });
  return { schemaVersion: 1, sampledAt: '2026-09-06T13:00:00.000Z', sourceState: 'healthy', reasons: [], measurementScope: 'local-experiment',
    campaigns: [], deliveryReports: [{ universeId: 'fixture', sourceState: 'missing', deliveries: [], reasons: [] }],
    universes: [{ manifest: { schemaVersion: 1, id: 'fixture', name: 'Fixture', objective: 'Improve a fixture',
      seed: { repo: '/private/repo', revision: REV }, metric: { name: 'quality', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxDurationMs: 10_000, trialTimeoutMs: 1_000, maxParallel: 1 },
      evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 1000 },
      variants: [{ id: 'repair', niche: 'correctness', hypothesis: 'Repair', generation: { kind: 'local-chat',
        endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture', files: ['value.txt'], maxOutputTokens: 100 } }] },
    manifestDigest: M, comparatorDigest: C, runs, elites: [{ niche: 'correctness', variantId: 'repair', trialId: 'trial-1', runId: 'run-1',
      generation: 1, score: 10, metrics: {}, artifact: runs[0]!.trials[0]!.artifact!, comparatorDigest: C }],
    activeRun: null, sourceState: 'healthy', reasons: [] }] };
}
function delivery(status: UniverseDeliveryReceipt['status'] = 'delivered'): UniverseDeliveryReceipt {
  return { schemaVersion: 1, id: '2'.repeat(64), universeId: 'fixture', trialId: 'trial-1', runId: 'run-1', niche: 'correctness',
    manifestDigest: M, comparatorDigest: C, artifactDigest: H, repo: '/private/repo', branch: 'codex/delivery',
    baseCommit: REV, commit: status === 'unchanged' ? REV : '3'.repeat(40), tree: '4'.repeat(40), changedFiles: status === 'unchanged' ? [] : ['value.txt'],
    status, createdAt: '2026-09-06T12:01:00.000Z', completedAt: status === 'pending' ? null : '2026-09-06T12:01:01.000Z' };
}

describe('Universe graph measured-output and delivery analysis', () => {
  it('keeps repeated outputs as distinct occurrences with exact measured usage and distinct feedback lineage', () => {
    const graph = buildUniverseGraph(fixture(), 'fixture');
    expect(graph).toMatchObject({ sourceState: 'healthy', complete: true, counts: { trials: 3, currentElites: 1, verifiedDeliveries: 0 } });
    expect(graph.nodes.filter((node) => node.kind === 'artifact')).toHaveLength(3);
    expect(graph.findings.find((finding) => finding.kind === 'repeated-output')).toMatchObject({ trialCount: 3, recordedTokens: 75, reportedTokens: 75, usageComplete: true });
    const trial = (generation: number) => graph.nodes.find((node) => node.kind === 'trial' && node.generation === generation)!;
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'parent', from: trial(1).id, to: trial(3).id }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'feedback', from: trial(2).id, to: trial(3).id }));
    const all = traverseUniverseGraph(graph, { nodeId: graph.nodes.find((node) => node.kind === 'universe')!.id, direction: 'descendants' });
    expect(all.complete).toBe(true);
    expect(all.nodeIds).toHaveLength(graph.nodes.length);
  });

  it('finds undelivered current elites and stops claiming a gap after a verified local branch delivery', () => {
    const overview = fixture();
    expect(buildUniverseGraph(overview, 'fixture').findings.filter((finding) => finding.kind === 'undelivered-current-elite')).toHaveLength(1);
    overview.deliveryReports = [{ universeId: 'fixture', sourceState: 'healthy', reasons: [], deliveries: [delivery()] }];
    const graph = buildUniverseGraph(overview, 'fixture');
    expect(graph.counts.verifiedDeliveries).toBe(1);
    expect(graph.findings.filter((finding) => finding.kind === 'undelivered-current-elite')).toEqual([]);
    expect(graph.nodes.find((node) => node.kind === 'delivery')).toMatchObject({ generation: 1, branch: 'codex/delivery', evidence: 'verified-local-delivery' });
  });

  it.each(['pending', 'unchanged'] as const)('does not count a %s receipt as a verified branch', (status) => {
    const overview = fixture();
    overview.deliveryReports = [{ universeId: 'fixture', sourceState: 'healthy', reasons: [], deliveries: [delivery(status)] }];
    const graph = buildUniverseGraph(overview, 'fixture');
    expect(graph.complete).toBe(true);
    expect(graph.counts.verifiedDeliveries).toBe(0);
    expect(graph.findings.filter((finding) => finding.kind === 'undelivered-current-elite')).toHaveLength(1);
  });

  it('withholds delivery success and gap claims when the delivery report is degraded', () => {
    const overview = fixture();
    overview.deliveryReports = [{ universeId: 'fixture', sourceState: 'degraded', reasons: ['private failure text'], deliveries: [delivery()] }];
    const graph = buildUniverseGraph(overview, 'fixture');
    expect(graph.sourceState).toBe('degraded');
    expect(graph.counts.verifiedDeliveries).toBe(0);
    expect(graph.findings.filter((finding) => finding.kind === 'undelivered-current-elite')).toEqual([]);
    expect(JSON.stringify(graph)).not.toContain('private failure text');
  });

  it('keeps historical delivered branches separate from a later current elite', () => {
    const overview = fixture(); const universe = overview.universes[0]!;
    const latest = universe.runs[2]!.trials[0]!;
    latest.selected = true; latest.score = 11; latest.delta = 1;
    universe.elites = [{ ...universe.elites[0]!, runId: 'run-3', trialId: 'trial-3', generation: 3, score: 11 }];
    overview.deliveryReports = [{ universeId: 'fixture', sourceState: 'healthy', reasons: [], deliveries: [delivery()] }];
    const graph = buildUniverseGraph(overview, 'fixture');
    expect(graph.counts).toMatchObject({ currentElites: 1, verifiedDeliveries: 1 });
    expect(graph.findings.find((finding) => finding.kind === 'undelivered-current-elite')?.trialIds).toEqual(['trial-3']);
    expect(graph.nodes.filter((node) => node.admitted)).toHaveLength(2);
  });

  it('renders orphan reservations as recorded intent without inventing a run or receipt', () => {
    const overview = fixture();
    overview.campaigns = [{ definition: { schemaVersion: 1, id: 'orphan', universeId: 'fixture', feedback: true,
      budget: { maxGenerations: 4, maxDurationMs: 1000, maxModelRequests: 4, maxStagnantGenerations: 4, maxReportedTokens: null } },
    definitionDigest: '5'.repeat(64), manifestDigest: M, comparatorDigest: C, createdAt: overview.sampledAt, state: 'interrupted', reason: null,
    startedAt: overview.sampledAt, deadlineAt: overview.sampledAt, finishedAt: null, owner: null, sourceState: 'healthy', reasons: [],
    steps: [{ ordinal: 1, runId: 'unstarted-run', generation: 4, variantIds: ['repair'], reservedModelRequests: 1, createdAt: overview.sampledAt,
      state: 'interrupted', trialCount: 0, passedTrials: 0, admissions: 0, improvements: 0, tokensUsed: null }],
    progress: { attempts: 1, completedRuns: 0, interruptedRuns: 1, reservedModelRequests: 1, reportedTokens: null, recordedTokens: 0,
      usageComplete: false, admissions: 0, improvements: 0, stagnantGenerations: 0 } }];
    const graph = buildUniverseGraph(overview, 'fixture');
    expect(graph.complete).toBe(true);
    expect(graph.nodes.find((node) => node.kind === 'reservation')).toMatchObject({ runId: 'unstarted-run', state: 'interrupted' });
    expect(graph.nodes.filter((node) => node.kind === 'run')).toHaveLength(3);
    expect(graph.edges.filter((edge) => edge.kind === 'executed-as')).toEqual([]);
  });

  it('does not mutate its input and gives stable topology when observation time changes', () => {
    const overview = fixture(); const before = JSON.stringify(overview);
    const first = buildUniverseGraph(overview, 'fixture');
    expect(JSON.stringify(overview)).toBe(before);
    overview.sampledAt = '2026-09-06T14:00:00.000Z';
    const second = buildUniverseGraph(overview, 'fixture');
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
    expect(second.findings).toEqual(first.findings);
    expect(second.sampledAt).not.toBe(first.sampledAt);
  });
});
