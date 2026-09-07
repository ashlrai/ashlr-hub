import { describe, expect, it } from 'vitest';
import { traverseUniverseGraph } from '../src/core/universe/graph-query.js';
import type { UniverseGraph } from '../src/core/universe/graph-types.js';
import { buildUniverseGraph } from '../src/core/universe/graph.js';
import type { UniverseOverview, UniverseRun, UniverseTrial } from '../src/core/universe/types.js';

function queryGraph(nodeIds: string[], pairs: Array<[string, string]>): UniverseGraph {
  return {
    schemaVersion: 1, universeId: 'independent-review', sampledAt: '2026-09-06T12:00:00.000Z',
    sourceState: 'healthy', complete: true, authority: 'observation-only', measurementScope: 'local-experiment',
    nodes: nodeIds.map((id) => ({ id, kind: 'trial', label: id, universeId: 'independent-review', state: 'passed', evidence: 'recorded' })),
    edges: pairs.map(([from, to], index) => ({ id: `edge-${index}`, from, to, kind: 'parent' })),
    findings: [], issues: [], counts: { nodes: nodeIds.length, edges: pairs.length, trials: nodeIds.length, currentElites: 0, verifiedDeliveries: 0 },
    limits: { maxNodes: 25_000, maxEdges: 100_000, maxFindings: 128 },
  };
}

describe('independent Universe traversal review', () => {
  it('returns every relationship among reached nodes at the exact depth boundary', () => {
    const graph = queryGraph(['root', 'left', 'right'], [['root', 'left'], ['root', 'right'], ['left', 'right']]);
    const result = traverseUniverseGraph(graph, { nodeId: 'root', direction: 'descendants', maxDepth: 1 });
    expect(result.nodeIds).toEqual(['left', 'right', 'root']);
    expect(result.edgeIds).toEqual(['edge-0', 'edge-1', 'edge-2']);
    expect(result.complete).toBe(true);
  });

  it('keeps complete ancestor evidence closure at an exact-depth diamond', () => {
    const graph = queryGraph(['root', 'left', 'right'], [['root', 'left'], ['root', 'right'], ['left', 'right']]);
    const result = traverseUniverseGraph(graph, { nodeId: 'right', direction: 'ancestors', maxDepth: 1 });
    expect(result.nodeIds).toEqual(['left', 'right', 'root']);
    expect(result.edgeIds).toEqual(['edge-0', 'edge-1', 'edge-2']);
    expect(result.complete).toBe(true);
  });

  it.each(([
    [['a', 'a']],
    [['a', 'b'], ['b', 'a']],
    [['a', 'b'], ['b', 'c'], ['c', 'a']],
  ] as Array<Array<[string, string]>>).map((pairs) => ({ pairs })))('does not accept cyclic evidence as a healthy traversal ($pairs)', ({ pairs }) => {
    const result = traverseUniverseGraph(queryGraph(['a', 'b', 'c'], pairs), { nodeId: 'a', direction: 'descendants' });
    expect(result.complete).toBe(false);
    expect(result.issues.some((issue) => /cycle|cyclic/.test(`${issue.code} ${issue.message}`))).toBe(true);
  });

  it('bounds a deep graph at 64 hops and reports rather than hides the remaining evidence', () => {
    const ids = Array.from({ length: 70 }, (_, index) => `node-${String(index).padStart(2, '0')}`);
    const graph = queryGraph(ids, ids.slice(1).map((id, index) => [ids[index]!, id]));
    const result = traverseUniverseGraph(graph, { nodeId: ids[0]!, direction: 'descendants' });
    expect(result.nodeIds).toHaveLength(65);
    expect(result.edgeIds).toHaveLength(64);
    expect(result.complete).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('depth-limit');
    expect(result.nodeIds).not.toContain(ids[65]);
  });

  it('distinguishes a complete 64-hop chain from depth truncation', () => {
    const ids = Array.from({ length: 65 }, (_, index) => `node-${String(index).padStart(2, '0')}`);
    const result = traverseUniverseGraph(queryGraph(ids, ids.slice(1).map((id, index) => [ids[index]!, id])), {
      nodeId: ids[0]!, direction: 'descendants', maxDepth: 64,
    });
    expect(result.nodeIds).toHaveLength(65);
    expect(result.edgeIds).toHaveLength(64);
    expect(result.complete).toBe(true);
  });

  it('does not upgrade degraded source evidence when the requested neighborhood is small', () => {
    const graph = queryGraph(['a', 'b'], [['a', 'b']]);
    graph.sourceState = 'degraded';
    const result = traverseUniverseGraph(graph, { nodeId: 'a', direction: 'ancestors', maxDepth: 1 });
    expect(result.nodeIds).toEqual(['a']);
    expect(result.complete).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('source-incomplete');
  });

  it('fails closed on duplicate nodes and dangling edges without manufacturing targets', () => {
    const duplicate = queryGraph(['a', 'a'], []);
    expect(traverseUniverseGraph(duplicate, { nodeId: 'a', direction: 'ancestors' }).complete).toBe(false);
    const unresolved = queryGraph(['a'], [['missing', 'a']]);
    const result = traverseUniverseGraph(unresolved, { nodeId: 'a', direction: 'ancestors' });
    expect(result.complete).toBe(false);
    expect(result.nodeIds).not.toContain('missing');
  });
});

function history(): UniverseOverview {
  const hash = (letter: string): string => letter.repeat(64);
  const trial = (generation: number): UniverseTrial => ({
    id: 'same-trial-id', variantId: 'calendar-fix', niche: 'correctness', parentTrialId: generation === 1 ? null : 'same-trial-id',
    status: 'passed', score: generation, metrics: { cases: generation }, selected: true, delta: generation === 1 ? null : 1,
    durationMs: 100, artifact: { path: `/private/artifact-secret/run-${generation}/same-trial-id`, digest: hash(String(generation)), revision: 'a'.repeat(40) },
    diagnostics: [{ code: 'TestResult', message: 'private-diagnostic-message', path: 'private-diagnostic-file.ts', line: 1 }],
  });
  const runs: UniverseRun[] = [1, 2, 3].map((generation) => ({
    id: `run-${generation}`, universeId: 'review', generation, manifestDigest: hash('b'), comparatorDigest: hash('c'),
    startedAt: `2026-09-06T12:00:0${generation}.000Z`, finishedAt: `2026-09-06T12:00:1${generation}.000Z`,
    status: 'completed', trials: [trial(generation)], durationMs: 100, tokensUsed: null, costUsd: null,
  }));
  return {
    schemaVersion: 1, sampledAt: '2026-09-06T13:00:00.000Z', sourceState: 'healthy', reasons: [],
    measurementScope: 'local-experiment', campaigns: [], deliveryReports: [{ universeId: 'review', deliveries: [], sourceState: 'missing', reasons: [] }],
    universes: [{
      manifest: { schemaVersion: 1, id: 'review', name: 'private-experiment-name', objective: 'private-objective-context',
        seed: { repo: '/private/repository-secret', revision: 'a'.repeat(40) },
        metric: { name: 'cases', direction: 'maximize', minImprovement: 0 },
        budget: { maxTrials: 1, maxDurationMs: 30_000, trialTimeoutMs: 10_000, maxParallel: 1 },
        evaluation: { command: ['node', 'private-evaluator-command.mjs'], timeoutMs: 1_000 },
        variants: [{ id: 'calendar-fix', niche: 'correctness', hypothesis: 'private-hypothesis-context', command: ['node', 'private-worker-command.mjs'] }] },
      manifestDigest: hash('b'), comparatorDigest: hash('c'), runs, activeRun: null, sourceState: 'healthy', reasons: [],
      elites: [{ niche: 'correctness', variantId: 'calendar-fix', trialId: 'same-trial-id', runId: 'run-3', generation: 3,
        score: 3, metrics: {}, artifact: runs[2]!.trials[0]!.artifact!, comparatorDigest: hash('c') }],
    }],
  };
}

describe('independent Universe occurrence graph review', () => {
  it('keeps reused trial IDs scoped to each run and binds the most recent actual parent', () => {
    const graph = buildUniverseGraph(history(), 'review');
    const trials = graph.nodes.filter((node) => node.kind === 'trial');
    expect(trials).toHaveLength(3);
    expect(new Set(trials.map((node) => node.id)).size).toBe(3);
    const first = trials.find((node) => node.runId === 'run-1')!;
    const second = trials.find((node) => node.runId === 'run-2')!;
    const third = trials.find((node) => node.runId === 'run-3')!;
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: first.id, to: second.id, kind: 'parent' }),
      expect.objectContaining({ from: second.id, to: third.id, kind: 'parent' }),
    ]));
    expect(graph.edges).not.toContainEqual(expect.objectContaining({ from: first.id, to: third.id, kind: 'parent' }));
    expect(trials.filter((node) => node.currentElite)).toEqual([third]);
  });

  it('never relabels a missing parent relationship as seed ancestry', () => {
    const overview = history();
    overview.universes[0]!.runs[2]!.trials[0]!.parentTrialId = 'missing-trial';
    const graph = buildUniverseGraph(overview, 'review');
    const third = graph.nodes.find((node) => node.kind === 'trial' && node.runId === 'run-3')!;
    expect(graph.complete).toBe(false);
    expect(graph.issues.length).toBeGreaterThan(0);
    expect(graph.edges).not.toContainEqual(expect.objectContaining({ to: third.id, kind: 'seed-parent' }));
    expect(graph.edges).not.toContainEqual(expect.objectContaining({ to: third.id, kind: 'parent' }));
  });

  it('separates rejected-attempt feedback from the selected parent that supplied candidate bytes', () => {
    const overview = history();
    const universe = overview.universes[0]!;
    universe.manifest.variants = [{ id: 'calendar-fix', niche: 'correctness', hypothesis: 'Repair the fixture',
      generation: { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture', files: ['format.ts'], maxOutputTokens: 100 } }];
    for (const run of universe.runs) {
      run.tokensUsed = 42;
      run.generationUsage = { scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 1, inputTokens: 23, outputTokens: 19 };
      run.trials[0]!.generation = { schemaVersion: 1, provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture',
        status: 'succeeded', requestStarted: true, promptDigest: '8'.repeat(64), responseDigest: '7'.repeat(64), durationMs: 50,
        usage: { state: 'reported', inputTokens: 23, outputTokens: 19 }, changedFiles: ['format.ts'] };
    }
    const rejected = universe.runs[1]!.trials[0]!;
    rejected.status = 'failed'; rejected.selected = false; rejected.delta = null;
    const last = universe.runs[2]!;
    last.feedbackEnabled = true;
    last.trials[0]!.delta = 2;
    last.trials[0]!.generation = {
      schemaVersion: 1, provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture',
      status: 'succeeded', requestStarted: true, promptDigest: '8'.repeat(64), responseDigest: '7'.repeat(64), durationMs: 50,
      usage: { state: 'reported', inputTokens: 23, outputTokens: 19 }, changedFiles: ['format.ts'],
      feedback: { runId: 'run-2', trialId: rejected.id, generation: 2, comparatorDigest: universe.comparatorDigest,
        artifactDigest: rejected.artifact!.digest, digest: '9'.repeat(64) },
    };
    const graph = buildUniverseGraph(overview, 'review');
    const byRun = (id: string): string => graph.nodes.find((node) => node.kind === 'trial' && node.runId === id)!.id;
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: byRun('run-1'), to: byRun('run-3'), kind: 'parent' }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: byRun('run-2'), to: byRun('run-3'), kind: 'feedback' }));
    expect(graph.edges).not.toContainEqual(expect.objectContaining({ from: byRun('run-2'), to: byRun('run-3'), kind: 'parent' }));
    expect(graph.nodes.find((node) => node.id === byRun('run-2'))!.currentElite).toBe(false);
  });

  it('does not duplicate an active run already present in runs', () => {
    const overview = history();
    const universe = overview.universes[0]!;
    const run = universe.runs[2]!;
    run.status = 'running'; run.finishedAt = null;
    run.trials[0]!.selected = false; run.trials[0]!.delta = null;
    universe.elites = [];
    universe.activeRun = JSON.parse(JSON.stringify(run)) as UniverseRun;
    const graph = buildUniverseGraph(overview, 'review');
    expect(graph.nodes.filter((node) => node.kind === 'run' && node.runId === run.id)).toHaveLength(1);
    expect(graph.nodes.filter((node) => node.kind === 'trial' && node.runId === run.id)).toHaveLength(1);
  });

  it('surfaces a divergent duplicate active run rather than silently choosing one payload', () => {
    const overview = history();
    const universe = overview.universes[0]!;
    const run = universe.runs[2]!;
    run.status = 'running'; run.finishedAt = null;
    run.trials[0]!.selected = false; run.trials[0]!.delta = null;
    universe.elites = [];
    universe.activeRun = { ...run, durationMs: run.durationMs + 100 };
    const graph = buildUniverseGraph(overview, 'review');
    expect(graph.complete).toBe(false);
    expect(graph.issues.length).toBeGreaterThan(0);
  });

  it('treats object key order as irrelevant when the duplicated active run is semantically identical', () => {
    const overview = history();
    const universe = overview.universes[0]!;
    const run = universe.runs[2]!;
    run.status = 'running'; run.finishedAt = null;
    run.trials[0]!.selected = false; run.trials[0]!.delta = null;
    universe.elites = [];
    universe.activeRun = Object.fromEntries(Object.entries(run).reverse()) as unknown as UniverseRun;
    const graph = buildUniverseGraph(overview, 'review');
    expect(graph.issues.some((issue) => issue.code === 'active-run-mismatch')).toBe(false);
    expect(graph.complete).toBe(true);
  });

  it('does not reveal command, source, diagnostic, or prompt contents in the graph projection', () => {
    const graph = buildUniverseGraph(history(), 'review');
    const serialized = JSON.stringify(graph);
    for (const privateText of ['private-artifact-secret', '/private/artifact-secret', '/private/repository-secret',
      'private-diagnostic-message', 'private-diagnostic-file.ts', 'private-worker-command.mjs',
      'private-evaluator-command.mjs', 'private-objective-context', 'private-hypothesis-context']) {
      expect(serialized).not.toContain(privateText);
    }
    for (const node of graph.nodes) {
      expect(node.id).not.toContain('same-trial-id');
      expect(node.id).not.toContain('run-1');
      expect(node.id).not.toContain('c'.repeat(64));
    }
  });

  it('keeps missing and corrupt experiment sources distinct without inventing a seed', () => {
    const overview = history();
    overview.universes = [];
    overview.sourceState = 'missing';
    const missing = buildUniverseGraph(overview, 'review');
    expect(missing.sourceState).toBe('missing');
    expect(missing.nodes).toEqual([]);
    overview.sourceState = 'degraded'; overview.reasons = ['private-path-to-broken-source'];
    const degraded = buildUniverseGraph(overview, 'review');
    expect(degraded.sourceState).toBe('degraded');
    expect(degraded.nodes).toEqual([]);
    expect(JSON.stringify(degraded)).not.toContain('private-path-to-broken-source');
  });

  it('preserves unavailable cross-store evidence even when the experiment itself is healthy', () => {
    const overview = history();
    overview.sourceState = 'degraded';
    overview.reasons = ['private-path-to-unreadable-campaign-creation-record'];
    const graph = buildUniverseGraph(overview, 'review');
    expect(graph.sourceState).toBe('degraded');
    expect(graph.complete).toBe(false);
    expect(graph.findings.filter((finding) => finding.kind === 'undelivered-current-elite')).toEqual([]);
    expect(JSON.stringify(graph)).not.toContain('private-path-to-unreadable-campaign-creation-record');
    expect(graph.counts.currentElites).toBe(graph.nodes.filter((node) => node.currentElite).length);
    expect(graph.counts.verifiedDeliveries).toBe(graph.nodes.filter((node) => node.evidence === 'verified-local-delivery').length);
  });

  it('does not identify distinct immutable comparator scopes as the same seed or evaluator nodes', () => {
    const first = history();
    const second = history();
    const changed = second.universes[0]!;
    changed.manifestDigest = 'd'.repeat(64); changed.comparatorDigest = 'e'.repeat(64);
    changed.manifest.seed.revision = 'f'.repeat(40);
    for (const run of changed.runs) {
      run.manifestDigest = changed.manifestDigest; run.comparatorDigest = changed.comparatorDigest;
      for (const trial of run.trials) if (trial.artifact) trial.artifact.revision = changed.manifest.seed.revision;
    }
    for (const elite of changed.elites) elite.comparatorDigest = changed.comparatorDigest;
    const before = buildUniverseGraph(first, 'review');
    const after = buildUniverseGraph(second, 'review');
    for (const kind of ['seed', 'comparator'] as const) {
      expect(before.nodes.find((node) => node.kind === kind)!.id).not.toBe(after.nodes.find((node) => node.kind === kind)!.id);
    }
  });

  it('does not treat an absent optional campaign inventory as verified empty history', () => {
    const overview = history();
    delete overview.campaigns;
    const graph = buildUniverseGraph(overview, 'review');
    expect(graph.complete).toBe(false);
    expect(graph.issues.some((issue) => /campaign/i.test(`${issue.code} ${issue.message}`))).toBe(true);
  });

  it('marks active-run-only input incomplete without inventing its missing durable run', () => {
    const overview = history();
    const universe = overview.universes[0]!;
    universe.activeRun = { ...universe.runs[0]!, status: 'running', finishedAt: null, trials: [] };
    universe.runs = []; universe.elites = [];
    const graph = buildUniverseGraph(overview, 'review');
    expect(graph.complete).toBe(false);
    expect(graph.issues.some((issue) => issue.code === 'active-run-mismatch')).toBe(true);
    expect(graph.nodes.some((node) => node.kind === 'run')).toBe(false);
  });

  it('does not convert repeated command artifacts into zero measured model-token usage', () => {
    const overview = history();
    for (const run of overview.universes[0]!.runs) run.trials[0]!.artifact!.digest = '4'.repeat(64);
    const repeated = buildUniverseGraph(overview, 'review').findings.find((finding) => finding.kind === 'repeated-output')!;
    expect(repeated.trialCount).toBe(3);
    expect(repeated.recordedTokens).toBe(0);
    expect(repeated.reportedTokens).toBeNull();
    expect(repeated.usageComplete).toBe(false);
  });

  it('retains recorded token subtotals without claiming complete usage for interrupted work', () => {
    const overview = history();
    const universe = overview.universes[0]!;
    universe.elites = [];
    for (const run of universe.runs) {
      run.status = 'interrupted';
      const trial = run.trials[0]!;
      trial.selected = false; trial.delta = null; trial.parentTrialId = null; trial.artifact!.digest = '4'.repeat(64);
      trial.generation = { schemaVersion: 1, provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture',
        status: 'succeeded', requestStarted: true, promptDigest: '8'.repeat(64), responseDigest: '7'.repeat(64), durationMs: 50,
        usage: { state: 'reported', inputTokens: 23, outputTokens: 19 }, changedFiles: ['format.ts'] };
    }
    const repeated = buildUniverseGraph(overview, 'review').findings.find((finding) => finding.kind === 'repeated-output')!;
    expect(repeated.recordedTokens).toBe(126);
    expect(repeated.reportedTokens).toBeNull();
    expect(repeated.usageComplete).toBe(false);
  });

  it('caps large input with closed edge references and incomplete rather than complete totals', () => {
    const overview = history();
    const universe = overview.universes[0]!;
    const template = universe.runs[0]!;
    universe.runs = Array.from({ length: 10_001 }, (_, index) => ({ ...template, id: `bounded-${index}`, generation: index + 1,
      trials: [{ ...template.trials[0]!, selected: false, parentTrialId: null, artifact: { ...template.trials[0]!.artifact! } }] }));
    universe.elites = [];
    const graph = buildUniverseGraph(overview, 'review');
    expect(graph.complete).toBe(false);
    expect(graph.nodes.length).toBeLessThanOrEqual(graph.limits.maxNodes);
    expect(graph.edges.length).toBeLessThanOrEqual(graph.limits.maxEdges);
    expect(graph.findings.length).toBeLessThanOrEqual(graph.limits.maxFindings);
    const included = new Set(graph.nodes.map((node) => node.id));
    expect(graph.edges.every((edge) => included.has(edge.from) && included.has(edge.to))).toBe(true);
    expect(graph.issues.some((issue) => issue.code === 'graph-limit')).toBe(true);
  }, 10_000);
});
