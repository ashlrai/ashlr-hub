import type { UniverseGraph, UniverseGraphEdge, UniverseGraphTraversal } from './graph-types.js';

export const MAX_UNIVERSE_GRAPH_DEPTH = 64;
const MAX_QUERY_NODES = 25_000;
const MAX_QUERY_EDGES = 100_000;

/** Browser-safe bounded breadth-first traversal, including the focus node. */
export function traverseUniverseGraph(graph: UniverseGraph, options: {
  nodeId: string; direction: 'ancestors' | 'descendants'; maxDepth?: number;
}): UniverseGraphTraversal {
  const result: UniverseGraphTraversal = { nodeIds: [], edgeIds: [], complete: true, issues: [] };
  const issue = (code: string, message: string): void => {
    result.complete = false;
    result.issues.push({ code, message, nodeIds: [] });
  };
  const depth = options.maxDepth ?? MAX_UNIVERSE_GRAPH_DEPTH;
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > MAX_UNIVERSE_GRAPH_DEPTH ||
      !['ancestors', 'descendants'].includes(options.direction)) {
    issue('invalid-query', 'Traversal requires a direction and depth from 1 to 64.'); return result;
  }
  if (graph.nodes.length > MAX_QUERY_NODES || graph.edges.length > MAX_QUERY_EDGES) {
    issue('graph-limit', 'Graph exceeds the traversal envelope.'); return result;
  }
  const nodes = new Set(graph.nodes.map((node) => node.id));
  if (nodes.size !== graph.nodes.length) { issue('duplicate-node', 'Graph contains duplicated node identities.'); return result; }
  if (!nodes.has(options.nodeId)) { issue('invalid-node', 'The requested graph node is unavailable.'); return result; }
  const adjacency = new Map<string, UniverseGraphEdge[]>();
  const forward = new Map<string, string[]>();
  const incoming = new Map([...nodes].map((id) => [id, 0]));
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edgeIds.has(edge.id)) {
      issue('invalid-edge', 'Graph contains an unresolved or duplicated edge.'); return result;
    }
    edgeIds.add(edge.id);
    const targets = forward.get(edge.from) ?? [];
    targets.push(edge.to); forward.set(edge.from, targets);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    const from = options.direction === 'ancestors' ? edge.to : edge.from;
    const list = adjacency.get(from) ?? [];
    list.push(edge); adjacency.set(from, list);
  }
  const ordered = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < ordered.length; index++) for (const target of forward.get(ordered[index]!) ?? []) {
    incoming.set(target, incoming.get(target)! - 1);
    if (incoming.get(target) === 0) ordered.push(target);
  }
  if (ordered.length !== nodes.size) { issue('cycle', 'Graph contains a dependency cycle.'); return result; }
  const seen = new Set([options.nodeId]);
  let frontier = [options.nodeId];
  for (let level = 0; frontier.length && level < depth; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of adjacency.get(id) ?? []) {
        const target = options.direction === 'ancestors' ? edge.from : edge.to;
        if (!seen.has(target)) { seen.add(target); next.push(target); }
      }
    }
    frontier = next;
  }
  if (frontier.some((id) => (adjacency.get(id) ?? []).some((edge) => !seen.has(options.direction === 'ancestors' ? edge.from : edge.to)))) {
    issue('depth-limit', 'Additional related nodes exist beyond the selected depth.');
  }
  if (!graph.complete || graph.sourceState !== 'healthy') issue('source-incomplete', 'Traversal uses incomplete or degraded source evidence.');
  result.nodeIds = [...seen].sort();
  // Return the induced graph, including cross-links between nodes discovered
  // at the exact depth boundary, not merely the breadth-first search tree.
  result.edgeIds = graph.edges.filter((edge) => seen.has(edge.from) && seen.has(edge.to)).map((edge) => edge.id).sort();
  return result;
}
