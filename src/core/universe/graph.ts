import { createHash } from 'node:crypto';
import type { UniverseOverview, UniverseRun, UniverseTrial } from './types.js';
import type { UniverseGraph, UniverseGraphEdgeKind, UniverseGraphFinding, UniverseGraphNode, UniverseGraphNodeKind } from './graph-types.js';

export const UNIVERSE_GRAPH_LIMITS = Object.freeze({ maxNodes: 25_000, maxEdges: 100_000, maxFindings: 256 });
interface TrialOccurrence { nodeId: string; artifactId?: string; run: UniverseRun; trial: UniverseTrial }

/** Opaque occurrence identities cannot disclose private source IDs or merge equal-content artifacts. */
function identity(kind: string, ...parts: Array<string | number>): string {
  const hash = createHash('sha256').update(JSON.stringify(['universe-evidence-graph-v1', kind, ...parts])).digest('hex');
  return `${kind}:${hash.match(/.{16}/g)!.join('-')}`;
}
function canonicalEvidence(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function usage(items: TrialOccurrence[]): Pick<UniverseGraphFinding, 'recordedTokens' | 'reportedTokens' | 'usageComplete'> {
  let recordedTokens = 0;
  let usageComplete = true;
  for (const { run, trial } of items) {
    const receipt = trial.generation;
    if (receipt?.usage.state === 'reported') {
      const count = receipt.usage.inputTokens! + receipt.usage.outputTokens!;
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(recordedTokens + count)) usageComplete = false;
      else recordedTokens += count;
    } else usageComplete = false;
    if (run.status !== 'completed') usageComplete = false;
  }
  return { recordedTokens, reportedTokens: usageComplete ? recordedTokens : null, usageComplete };
}

/** Pure projection of strictly read evidence. This graph grants no execution or delivery authority. */
export function buildUniverseGraph(overview: UniverseOverview, universeId: string): UniverseGraph {
  const graph: UniverseGraph = { schemaVersion: 1, sampledAt: overview.sampledAt, universeId,
    sourceState: 'healthy', complete: true, authority: 'observation-only', measurementScope: 'local-experiment',
    nodes: [], edges: [], findings: [], issues: [], counts: { nodes: 0, edges: 0, trials: 0, currentElites: 0, verifiedDeliveries: 0 },
    limits: { ...UNIVERSE_GRAPH_LIMITS } };
  let capped = false;
  const issue = (code: string, message: string, nodeIds: string[] = []): void => {
    graph.sourceState = 'degraded'; graph.complete = false;
    if (graph.issues.length < 128 && !graph.issues.some((item) => item.code === code && item.message === message && item.nodeIds.join() === nodeIds.join())) {
      graph.issues.push({ code, message, nodeIds });
    }
  };
  const universe = overview.universes.find((item) => item.manifest.id === universeId);
  if (!universe) {
    graph.sourceState = overview.sourceState === 'degraded' ? 'degraded' : 'missing'; graph.complete = false;
    graph.issues.push({ code: 'universe-unavailable', message: 'The requested Universe has no readable experiment evidence.', nodeIds: [] });
    return graph;
  }
  if (universe.sourceState !== 'healthy') issue('experiment-degraded', 'Experiment evidence is degraded; archive and success claims are unavailable.');
  if (overview.sourceState === 'degraded') issue('source-degraded', 'One or more requested evidence sources could not be read completely.');
  if (universe.activeRun && !universe.runs.some((run) => run.id === universe.activeRun!.id && canonicalEvidence(run) === canonicalEvidence(universe.activeRun))) {
    issue('active-run-mismatch', 'The active-run projection differs from the recorded run collection.');
  }
  const { manifestDigest, comparatorDigest } = universe;
  const nodes = new Map<string, UniverseGraphNode>();
  const edges = new Set<string>();
  function addNode(kind: UniverseGraphNodeKind, parts: Array<string | number>, fields: Omit<UniverseGraphNode, 'id' | 'kind' | 'universeId'>): string {
    const id = identity(kind, universeId, manifestDigest, comparatorDigest, ...parts);
    if (nodes.has(id)) { issue('duplicate-node', 'Distinct evidence records share an occurrence identity.', [id]); return id; }
    if (nodes.size >= graph.limits.maxNodes) { capped = true; issue('graph-limit', 'Graph node limit reached; this projection is incomplete.'); return id; }
    const node = { id, kind, universeId, manifestDigest, comparatorDigest, ...fields };
    nodes.set(id, node); graph.nodes.push(node); return id;
  }
  function addEdge(from: string, to: string, kind: UniverseGraphEdgeKind): void {
    if (!nodes.has(from) || !nodes.has(to)) { if (!capped) issue('unresolved-edge', 'A recorded relationship has no included occurrence.'); return; }
    const id = identity('edge', from, to, kind);
    if (edges.has(id)) return;
    if (edges.size >= graph.limits.maxEdges) { capped = true; issue('graph-limit', 'Graph edge limit reached; this projection is incomplete.'); return; }
    edges.add(id); graph.edges.push({ id, from, to, kind });
  }
  const root = addNode('universe', [], { label: 'Universe', state: universe.sourceState, evidence: 'recorded' });
  const seed = addNode('seed', [], { label: 'Pinned seed', state: 'pinned', evidence: 'recorded', commit: universe.manifest.seed.revision });
  const comparator = addNode('comparator', [], { label: 'Pinned evaluator', state: 'pinned', evidence: 'recorded' });
  addEdge(root, seed, 'contains'); addEdge(root, comparator, 'contains');
  const trialIndex = new Map<string, TrialOccurrence>();
  const runIndex = new Map<string, { run: UniverseRun; nodeId: string }>();
  const parents = new Map<string, TrialOccurrence>();
  const feedback = new Map<string, TrialOccurrence>();
  const groups = new Map<string, TrialOccurrence[]>();
  const current = new Set(universe.elites.map((elite) => JSON.stringify([elite.runId, elite.trialId])));
  const runs = universe.runs.slice(0, 10_000).sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id));
  if (runs.length !== universe.runs.length) issue('graph-limit', 'Run input exceeds the graph envelope.');
  for (const run of runs) {
    if (capped) break;
    if (run.universeId !== universeId || run.manifestDigest !== universe.manifestDigest || run.comparatorDigest !== universe.comparatorDigest) {
      issue('run-identity', 'Run identity differs from the pinned Universe.'); continue;
    }
    const runNode = addNode('run', [run.id], { label: `Generation ${run.generation}`, state: run.status,
      evidence: run.finishedAt === null ? 'pending' : 'recorded', runId: run.id, generation: run.generation });
    addEdge(root, runNode, 'contains'); runIndex.set(run.id, { run, nodeId: runNode });
    const occurrences: TrialOccurrence[] = [];
    if (run.trials.length > 64) issue('graph-limit', 'Trial input exceeds the per-generation envelope.');
    for (const trial of run.trials.slice(0, 64)) {
      if (capped) break;
      const key = JSON.stringify([run.id, trial.id]);
      const isCurrent = universe.sourceState === 'healthy' && current.has(key) && run.status === 'completed' && trial.selected && trial.status === 'passed';
      const nodeId = addNode('trial', [run.id, trial.id], { label: `${trial.variantId} · generation ${run.generation}`, state: trial.status,
        evidence: 'recorded', runId: run.id, trialId: trial.id, generation: run.generation, niche: trial.niche, score: trial.score, currentElite: isCurrent,
        variantId: trial.variantId, admitted: universe.sourceState === 'healthy' && run.status === 'completed' && trial.selected && trial.status === 'passed' });
      const occurrence: TrialOccurrence = { nodeId, run, trial };
      trialIndex.set(key, occurrence); occurrences.push(occurrence);
      addEdge(runNode, nodeId, 'contains');
      if (trial.score !== null) addEdge(comparator, nodeId, 'evaluates');
      const parent = parents.get(trial.niche);
      if (trial.parentTrialId === null) {
        if (parent) issue('parent-mismatch', 'A trial omits its prior retained niche parent.', [nodeId]);
        else addEdge(seed, nodeId, 'seed-parent');
      } else if (!parent || parent.trial.id !== trial.parentTrialId) issue('parent-mismatch', 'A trial parent cannot be resolved to the prior retained niche elite.', [nodeId]);
      else addEdge(parent.nodeId, nodeId, 'parent');
      const source = trial.generation?.feedback;
      if (source) {
        const previous = feedback.get(trial.variantId);
        if (!previous || previous.run.id !== source.runId || previous.trial.id !== source.trialId || previous.run.generation !== source.generation ||
            source.comparatorDigest !== universe.comparatorDigest || source.artifactDigest !== (previous.trial.artifact?.digest ?? null)) {
          issue('feedback-mismatch', 'Feedback does not resolve to the preceding completed variant outcome.', [nodeId]);
        } else addEdge(previous.nodeId, nodeId, 'feedback');
      }
      if (trial.artifact) {
        occurrence.artifactId = addNode('artifact', [run.id, trial.id], { label: 'Recorded artifact', state: 'recorded', evidence: 'recorded',
          runId: run.id, trialId: trial.id, niche: trial.niche, generation: run.generation, artifactDigest: trial.artifact.digest, variantId: trial.variantId });
        addEdge(nodeId, occurrence.artifactId, 'produced');
        const group = groups.get(trial.artifact.digest) ?? []; group.push(occurrence); groups.set(trial.artifact.digest, group);
      }
    }
    // The parent is the preceding generation's retained niche elite, never a
    // sibling trial. Feedback advances separately even when its trial failed.
    if (run.status === 'completed') for (const occurrence of occurrences) {
      feedback.set(occurrence.trial.variantId, occurrence);
      if (occurrence.trial.selected && occurrence.trial.status === 'passed') parents.set(occurrence.trial.niche, occurrence);
    }
  }
  for (const key of current) if (!trialIndex.has(key)) issue('elite-unavailable', 'A current elite has no included historical trial occurrence.');

  if (overview.campaigns === undefined) issue('campaign-evidence-unavailable', 'Campaign inventory was not observed; the graph may omit reserved work.');
  const campaigns = (overview.campaigns ?? []).filter((campaign) => campaign.definition.universeId === universeId);
  if (campaigns.length > 64) issue('graph-limit', 'Campaign input exceeds the graph envelope.');
  for (const campaign of campaigns.slice(0, 64).sort((a, b) => a.definition.id.localeCompare(b.definition.id))) {
    if (capped) break;
    const healthy = campaign.sourceState === 'healthy' && campaign.manifestDigest === universe.manifestDigest && campaign.comparatorDigest === universe.comparatorDigest;
    const nodeId = addNode('campaign', [campaign.definition.id], { label: 'Campaign', state: campaign.state,
      evidence: healthy ? 'recorded' : 'unavailable', campaignId: campaign.definition.id });
    addEdge(root, nodeId, 'contains');
    if (!healthy) issue('campaign-degraded', 'Campaign evidence is degraded or bound to another comparator.', [nodeId]);
    if (campaign.steps.length > 128) issue('graph-limit', 'Campaign reservation input exceeds the graph envelope.');
    for (const step of campaign.steps.slice(0, 128)) {
      if (capped) break;
      const reservation = addNode('reservation', [campaign.definition.id, step.ordinal], { label: `Reserved generation ${step.generation}`, state: step.state,
        evidence: healthy ? step.state === 'pending' || step.state === 'running' ? 'pending' : 'recorded' : 'unavailable',
        generation: step.generation, runId: step.runId, campaignId: campaign.definition.id });
      addEdge(nodeId, reservation, 'reserved');
      const execution = runIndex.get(step.runId);
      // An orphan reservation is durable evidence, not a fabricated run.
      if (execution) {
        if (execution.run.generation !== step.generation || execution.run.campaign?.id !== campaign.definition.id ||
            execution.run.campaign?.ordinal !== step.ordinal || execution.run.campaign?.definitionDigest !== campaign.definitionDigest) {
          issue('reservation-mismatch', 'Campaign reservation does not match the recorded run.', [reservation]);
        } else addEdge(reservation, execution.nodeId, 'executed-as');
      }
    }
  }

  const reports = (overview.deliveryReports ?? []).filter((report) => report.universeId === universeId);
  const report = reports[0];
  const delivered = new Set<string>();
  const deliveryKnown = reports.length === 1 && (report!.sourceState === 'healthy' || report!.sourceState === 'missing');
  if (!deliveryKnown) issue('delivery-evidence-unavailable', 'Delivery evidence is unavailable or degraded; delivery gaps cannot be established.');
  if (reports.length > 1) issue('duplicate-delivery-report', 'Multiple delivery reports claim the same Universe.');
  if ((report?.deliveries.length ?? 0) > 128) issue('graph-limit', 'Delivery input exceeds the graph envelope.');
  for (const delivery of report?.deliveries.slice(0, 128) ?? []) {
    if (capped) break;
    const occurrence = trialIndex.get(JSON.stringify([delivery.runId, delivery.trialId]));
    const bound = delivery.universeId === universeId && delivery.manifestDigest === universe.manifestDigest && delivery.comparatorDigest === universe.comparatorDigest &&
      occurrence?.trial.artifact?.digest === delivery.artifactDigest && occurrence.trial.niche === delivery.niche && occurrence.trial.selected && occurrence.run.status === 'completed';
    const verified = bound && report?.sourceState === 'healthy' && universe.sourceState === 'healthy' && delivery.status === 'delivered';
    const nodeId = addNode('delivery', [delivery.branch], { label: `Local branch · ${delivery.branch}`, state: delivery.status,
      evidence: verified ? 'verified-local-delivery' : report?.sourceState === 'degraded' || !bound ? 'unavailable' : delivery.status === 'pending' ? 'pending' : 'recorded',
      runId: delivery.runId, trialId: delivery.trialId, niche: delivery.niche, artifactDigest: delivery.artifactDigest,
      deliveryId: delivery.id, branch: delivery.branch, commit: delivery.commit, ...(occurrence ? { generation: occurrence.run.generation } : {}) });
    if (!bound) issue('delivery-mismatch', 'Delivery does not match its historical selected trial.', [nodeId]);
    else {
      addEdge(occurrence!.artifactId!, nodeId, 'delivered-as');
      if (verified) delivered.add(JSON.stringify([delivery.runId, delivery.trialId]));
    }
  }
  function finding(kind: UniverseGraphFinding['kind'], items: TrialOccurrence[], artifactDigest: string): void {
    if (graph.findings.length >= graph.limits.maxFindings) { issue('graph-limit', 'Finding limit reached; this analysis is incomplete.'); return; }
    const nodeIds = items.map((item) => item.nodeId).sort();
    graph.findings.push({ id: identity('finding', universeId, kind, ...nodeIds), kind, nodeIds,
      trialIds: items.map((item) => item.trial.id), artifactDigest, trialCount: items.length, ...usage(items) });
  }
  if (universe.sourceState === 'healthy') {
    for (const [artifactDigest, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) if (items.length > 1) finding('repeated-output', items, artifactDigest);
    if (deliveryKnown && graph.complete) for (const key of [...current].sort()) {
      const occurrence = trialIndex.get(key);
      if (occurrence?.trial.artifact && !delivered.has(key)) finding('undelivered-current-elite', [occurrence], occurrence.trial.artifact.digest);
    }
  }
  graph.nodes.sort((a, b) => a.id.localeCompare(b.id)); graph.edges.sort((a, b) => a.id.localeCompare(b.id));
  graph.findings.sort((a, b) => a.id.localeCompare(b.id));
  graph.counts = { nodes: graph.nodes.length, edges: graph.edges.length,
    trials: graph.nodes.filter((node) => node.kind === 'trial').length,
    currentElites: graph.nodes.filter((node) => node.currentElite).length,
    verifiedDeliveries: graph.nodes.filter((node) => node.evidence === 'verified-local-delivery').length };
  return graph;
}
