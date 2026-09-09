import type { UniversePortfolioDefinition, UniversePortfolioGraphNode, UniversePortfolioGraphProjection,
  UniversePortfolioNodeState, UniversePortfolioPlanNode } from './portfolio-types.js';

type IntrinsicStates = ReadonlyMap<string, UniversePortfolioNodeState>;

function emptyStateCounts(): Record<UniversePortfolioNodeState, number> {
  return { ready: 0, waiting: 0, completed: 0, blocked: 0, busy: 0, unavailable: 0 };
}

function unique(items: Iterable<string>): string[] { return [...new Set(items)]; }

/**
 * Pure bounded DAG frontier derived from an already-propagated portfolio plan.
 * `intrinsicStates` is captured before ordinary dependency propagation so roots
 * never rely on human-readable reason strings.
 */
export function buildUniversePortfolioGraph(definition: UniversePortfolioDefinition,
  nodes: readonly UniversePortfolioPlanNode[], topologicalOrder: readonly string[],
  sourceState: 'healthy' | 'degraded', intrinsicStates: IntrinsicStates): UniversePortfolioGraphProjection {
  const byId = new Map(nodes.map((node) => [node.campaignId, node]));
  const taskById = new Map(definition.tasks.map((task) => [task.campaignId, task]));
  const dependants = new Map(definition.tasks.map((task) => [task.campaignId, [] as string[]]));
  for (const task of definition.tasks) for (const dependency of task.dependsOn) dependants.get(dependency)!.push(task.campaignId);

  const layersById = new Map<string, number>();
  const layers: string[][] = [];
  for (const id of topologicalOrder) {
    const task = taskById.get(id)!;
    const layer = task.dependsOn.reduce((maximum, dependency) => Math.max(maximum, layersById.get(dependency)! + 1), 0);
    layersById.set(id, layer);
    (layers[layer] ??= []).push(id);
  }

  const structuralDescendants = new Map<string, Set<string>>();
  for (const id of [...topologicalOrder].reverse()) {
    const descendants = new Set<string>();
    for (const dependant of dependants.get(id)!) {
      descendants.add(dependant);
      for (const descendant of structuralDescendants.get(dependant)!) descendants.add(descendant);
    }
    structuralDescendants.set(id, descendants);
  }

  const blockingRoots = new Map<string, string[]>();
  const waitingRoots = new Map<string, string[]>();
  // Ready roots are ordinary unsatisfied ordering prerequisites. They seed
  // descendant waiting causes without claiming that the ready node itself is
  // waiting for anything.
  const waitingPropagationRoots = new Map<string, string[]>();
  const unmet = new Map<string, string[]>();
  const topologyIndex = new Map(topologicalOrder.map((id, index) => [id, index]));
  const ordered = (ids: Iterable<string>): string[] => unique(ids).sort((left, right) =>
    topologyIndex.get(left)! - topologyIndex.get(right)!);
  for (const id of topologicalOrder) {
    const node = byId.get(id)!;
    const task = taskById.get(id)!;
    // Completion is an ordering barrier: a recorded completed campaign does not
    // carry its old prerequisite causes into currently-planned descendants.
    const missing = node.state === 'completed' ? [] : task.dependsOn.filter((dependency) => byId.get(dependency)!.state !== 'completed');
    unmet.set(id, missing);
    const intrinsic = intrinsicStates.get(id)!;
    const dependencyBlockingRoots = ordered(task.dependsOn.flatMap((dependency) => blockingRoots.get(dependency) ?? []));
    const dependencyWaitingRoots = ordered(task.dependsOn.flatMap((dependency) => waitingPropagationRoots.get(dependency) ?? []));
    if (node.state === 'completed') {
      blockingRoots.set(id, []);
      waitingRoots.set(id, []);
      waitingPropagationRoots.set(id, []);
    } else if (intrinsic === 'blocked' || intrinsic === 'unavailable') {
      blockingRoots.set(id, [id]);
      waitingRoots.set(id, []);
      waitingPropagationRoots.set(id, []);
    } else if (intrinsic === 'busy') {
      blockingRoots.set(id, []);
      waitingRoots.set(id, [id]);
      waitingPropagationRoots.set(id, [id]);
    } else if (node.state === 'blocked' || node.state === 'unavailable') {
      blockingRoots.set(id, dependencyBlockingRoots);
      // A blocked node can still report independent waiting prerequisites; the
      // state remains blocked because that is the current scheduling frontier.
      waitingRoots.set(id, dependencyWaitingRoots);
      waitingPropagationRoots.set(id, dependencyWaitingRoots);
    } else if (node.state === 'waiting') {
      blockingRoots.set(id, []);
      waitingRoots.set(id, dependencyWaitingRoots);
      waitingPropagationRoots.set(id, dependencyWaitingRoots);
    } else {
      blockingRoots.set(id, []);
      waitingRoots.set(id, []);
      waitingPropagationRoots.set(id, [id]);
    }
  }

  const graphNodes: UniversePortfolioGraphNode[] = nodes.map((node) => {
    const id = node.campaignId;
    const descendants = [...structuralDescendants.get(id)!].sort((left, right) =>
      topologyIndex.get(left)! - topologyIndex.get(right)!);
    return { campaignId: id, state: node.state, dependsOn: [...taskById.get(id)!.dependsOn],
      unmetDependencyIds: [...unmet.get(id)!], blockingRootIds: [...blockingRoots.get(id)!],
      waitingRootIds: [...waitingRoots.get(id)!], structuralDescendantIds: descendants,
      affectedDescendantIds: descendants.filter((descendant) => {
        const causes = [...blockingRoots.get(descendant)!, ...waitingRoots.get(descendant)!];
        return causes.includes(id);
      }), layer: layersById.get(id)! };
  });
  const states = emptyStateCounts();
  for (const node of graphNodes) states[node.state] += 1;
  // The frontier is consumed in dependency order, even though graph.nodes
  // intentionally retains definition order for a stable caller-facing lookup.
  const dependencyReadyCampaignIds = topologicalOrder.filter((id) => byId.get(id)!.state === 'ready');
  return { schemaVersion: 1, scope: 'campaign-ordering-only', authority: 'observation-only', dependencyReadyCampaignIds,
    invocationCandidateIds: sourceState === 'healthy' ? [...dependencyReadyCampaignIds] : [], layers: layers.map((layer) => [...layer]),
    counts: { nodes: graphNodes.length, edges: definition.tasks.reduce((total, task) => total + task.dependsOn.length, 0), states },
    nodes: graphNodes };
}
