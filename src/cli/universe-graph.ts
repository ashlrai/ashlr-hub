import { resolve } from 'node:path';
import { readUniverseGraph, traverseUniverseGraph, type UniverseGraph } from '../core/universe/index.js';
import { MAX_UNIVERSE_GRAPH_DEPTH } from '../core/universe/graph-query.js';

const USAGE = `usage: ashlr universe graph <id>
       [--node <node-id>] [--direction ancestors|descendants] [--depth N]
       [--root <private directory>] [--json]

Read recorded experiment relationships without executing candidates or models.
Copy a node id from the graph to trace its ancestors (default) or descendants.
--direction and --depth require --node. Depth defaults to ${MAX_UNIVERSE_GRAPH_DEPTH} (range 1..${MAX_UNIVERSE_GRAPH_DEPTH}).
Traversal JSON is {graph, traversal}; graph counts describe the full projection.
Selected-parent and feedback relationships are distinct. Graph findings are
observations, not causal explanations or accepted production changes. Local
branch delivery is not a push, merge, deployment, or production acceptance.
--root defaults to ~/.ashlr/universe. Reads never create a missing store.
Exit codes: 0 complete read, 1 missing/degraded/incomplete, 2 invalid arguments.
`;

class UsageError extends Error {}
interface Options {
  id?: string;
  nodeId?: string;
  direction: 'ancestors' | 'descendants';
  maxDepth?: number;
  root?: string;
  json: boolean;
  help: boolean;
}

function containsControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function parse(args: string[]): Options {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (containsControls(arg)) throw new UsageError('Arguments must not contain control characters');
    if (arg === '--help' || arg === '-h') {
      if (help) throw new UsageError('--help may only be specified once');
      help = true;
    } else if (arg === '--json') {
      if (json) throw new UsageError('--json may only be specified once');
      json = true;
    } else if (['--root', '--node', '--direction', '--depth'].includes(arg)) {
      if (values.has(arg)) throw new UsageError(`${arg} may only be specified once`);
      const value = args[++index];
      if (!value?.trim() || value.startsWith('-') || containsControls(value)) throw new UsageError(`${arg} requires a value`);
      values.set(arg, value);
    } else if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new UsageError('graph accepts exactly one universe id');
  const id = positional[0];
  if (id !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new UsageError('Invalid universe id');
  const nodeId = values.get('--node');
  if (nodeId !== undefined && (nodeId.length > 4_096 || nodeId !== nodeId.trim())) throw new UsageError('Invalid graph node id');
  if (nodeId === undefined && (values.has('--direction') || values.has('--depth'))) {
    throw new UsageError('--direction and --depth require --node');
  }
  const direction = values.get('--direction') ?? 'ancestors';
  if (direction !== 'ancestors' && direction !== 'descendants') throw new UsageError('Expected --direction ancestors or descendants');
  const depth = values.get('--depth');
  if (depth !== undefined && (!/^[1-9][0-9]{0,2}$/.test(depth) || Number(depth) > MAX_UNIVERSE_GRAPH_DEPTH)) {
    throw new UsageError(`--depth must be an integer from 1 to ${MAX_UNIVERSE_GRAPH_DEPTH}`);
  }
  if (!help && id === undefined) throw new UsageError('graph requires a universe id');
  const root = values.get('--root');
  return { id, nodeId, direction, maxDepth: depth === undefined ? undefined : Number(depth),
    root: root === undefined ? undefined : resolve(root), json, help };
}

function render(graph: UniverseGraph, traversal?: ReturnType<typeof traverseUniverseGraph>): string {
  const selected = traversal ? new Set(traversal.nodeIds) : undefined;
  const edges = traversal ? new Set(traversal.edgeIds) : undefined;
  return [
    `${graph.universeId} · evidence graph · source ${graph.sourceState} · ${graph.complete ? 'complete' : 'incomplete'} projection`,
    `Full graph: ${graph.counts.nodes} nodes · ${graph.counts.edges} relationships · ${graph.counts.trials} trials`,
    `Included current elites: ${graph.counts.currentElites} · verified local branch deliveries: ${graph.counts.verifiedDeliveries}`,
    ...(!graph.complete ? ['Counts cover included graph nodes only; complete totals are unavailable.'] : []),
    ...(traversal ? [`Traversal: ${traversal.nodeIds.length} nodes · ${traversal.edgeIds.length} relationships · ${traversal.complete ? 'complete' : 'incomplete'}`] : []),
    ...graph.nodes.filter((node) => !selected || selected.has(node.id)).map((node) =>
      `  ${node.id} · ${node.kind} · ${node.state} · ${node.evidence} · ${node.label}`),
    ...graph.edges.filter((edge) => !edges || edges.has(edge.id)).map((edge) =>
      `  ${edge.from} --${edge.kind}--> ${edge.to}`),
    ...(!traversal ? graph.findings.map((finding) => `Finding: ${finding.kind} · ${finding.trialCount} trials · ${finding.nodeIds.join(', ')}`) : []),
    ...graph.issues.map((issue) => `Issue ${issue.code}: ${issue.message}`),
    ...(traversal?.issues.map((issue) => `Traversal issue ${issue.code}: ${issue.message}`) ?? []),
    'Observation-only local experiment evidence. Parent ancestry and feedback are distinct relationships.',
    'Passing, selection, and local branch delivery are not production acceptance.',
  ].join('\n');
}

/** This command only reads validated projections; traversal grants no execution authority. */
export async function cmdUniverseGraph(args: string[]): Promise<number> {
  try {
    const options = parse(args);
    if (options.help) { console.log(USAGE); return 0; }
    const graph = readUniverseGraph(options.id!, { root: options.root });
    const traversal = options.nodeId === undefined ? undefined : traverseUniverseGraph(graph, {
      nodeId: options.nodeId, direction: options.direction, maxDepth: options.maxDepth,
    });
    console.log(options.json ? JSON.stringify(traversal ? { graph, traversal } : graph, null, 2) : render(graph, traversal));
    return graph.sourceState === 'healthy' && graph.complete && (!traversal || traversal.complete) ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`universe graph: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}
