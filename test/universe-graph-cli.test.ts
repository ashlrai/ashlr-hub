import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { UniverseGraph } from '../src/core/universe/index.js';

const core = vi.hoisted(() => ({ readUniverseGraph: vi.fn(), traverseUniverseGraph: vi.fn() }));
vi.mock('../src/core/universe/index.js', () => core);
import { cmdUniverseGraph } from '../src/cli/universe-graph.js';

function graph(overrides: Partial<UniverseGraph> = {}): UniverseGraph {
  return {
    schemaVersion: 1, universeId: 'calendar', sampledAt: '2026-09-06T12:00:00.000Z',
    sourceState: 'healthy', complete: true, authority: 'observation-only', measurementScope: 'local-experiment',
    nodes: [
      { id: 'run:example', kind: 'run', universeId: 'calendar', label: 'Generation 1', state: 'completed', evidence: 'recorded' },
      { id: 'trial:example', kind: 'trial', universeId: 'calendar', label: 'Calendar candidate', state: 'passed', evidence: 'recorded' },
    ],
    edges: [{ id: 'edge:example', from: 'run:example', to: 'trial:example', kind: 'contains' }],
    findings: [], issues: [], counts: { nodes: 2, edges: 1, trials: 1, currentElites: 1, verifiedDeliveries: 0 },
    limits: { maxNodes: 2_048, maxEdges: 4_096, maxFindings: 128 }, ...overrides,
  };
}

describe('Universe graph CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.readUniverseGraph.mockReturnValue(graph());
    core.traverseUniverseGraph.mockReturnValue({ nodeIds: ['trial:example'], edgeIds: [], complete: true, issues: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [], ['calendar', 'extra'], ['CALENDAR'], ['../escape'], ['a'.repeat(65)],
    ['calendar', '--unknown'], ['calendar', '--root'], ['calendar', '--root', '--json'],
    ['calendar', '--root', '/one', '--root', '/two'], ['calendar', '--root', '\0'],
    ['calendar', '--node'], ['calendar', '--node', ''], ['calendar', '--node', ' '],
    ['calendar', '--node', ' trial:example'], ['calendar', '--node', 'n'.repeat(4_097)],
    ['calendar', '--node', 'first', '--node', 'second'], ['calendar', '--node', 'a\nb'],
    ['calendar', '--node', 'a\x85b'], ['calendar', '--node', '-h'],
    ['calendar', '--direction', 'ancestors'], ['calendar', '--depth', '1'],
    ['calendar', '--node', 'trial:example', '--direction', 'both'],
    ['calendar', '--node', 'trial:example', '--direction', 'ancestors', '--direction', 'descendants'],
    ['calendar', '--node', 'trial:example', '--depth', '1', '--depth', '2'],
    ['calendar', '--json'], ['calendar', '--help', '-h'],
    ['calendar', '--help', '--unknown'], ['calendar', '--help', '--depth', '2'],
  ])('rejects invalid invocation %j before reading any evidence', async (...args) => {
    expect(await cmdUniverseGraph([...args, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(core.readUniverseGraph).not.toHaveBeenCalled();
    expect(core.traverseUniverseGraph).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '65', '256', '99999999999999999999', '01', '1.5', '1e1', 'NaN', 'Infinity', ' 2 ', '0x2'])(
    'rejects depth %j without reading', async (depth) => {
      expect(await cmdUniverseGraph(['calendar', '--node', 'trial:example', '--depth', depth, '--json'])).toBe(2);
      expect(core.readUniverseGraph).not.toHaveBeenCalled();
    },
  );

  it('returns the whole exact graph without invoking traversal', async () => {
    expect(await cmdUniverseGraph(['calendar', '--root', 'private store', '--json'])).toBe(0);
    expect(core.readUniverseGraph).toHaveBeenCalledWith('calendar', { root: resolve('private store') });
    expect(core.traverseUniverseGraph).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(graph());
  });

  it('defaults node queries to ancestors and preserves the opaque node id', async () => {
    expect(await cmdUniverseGraph(['calendar', '--node', 'trial:example', '--json'])).toBe(0);
    expect(core.traverseUniverseGraph).toHaveBeenCalledWith(graph(), {
      nodeId: 'trial:example', direction: 'ancestors', maxDepth: undefined,
    });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ graph: graph(),
      traversal: { nodeIds: ['trial:example'], edgeIds: [], complete: true, issues: [] } });
  });

  it.each(['1', '64'])('accepts depth boundary %s for descendant traversal', async (depth) => {
    expect(await cmdUniverseGraph(['calendar', '--node', 'run:example', '--direction', 'descendants', '--depth', depth])).toBe(0);
    expect(core.traverseUniverseGraph).toHaveBeenCalledWith(graph(), {
      nodeId: 'run:example', direction: 'descendants', maxDepth: Number(depth),
    });
  });

  it.each(['missing', 'degraded'] as const)('reports %s evidence without a successful-read exit', async (sourceState) => {
    const value = graph({ sourceState });
    core.readUniverseGraph.mockReturnValue(value);
    expect(await cmdUniverseGraph(['calendar', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(value);
  });

  it('preserves a bounded incomplete projection and its limitations', async () => {
    const value = graph({ complete: false, issues: [{ code: 'graph-limit', message: 'Graph node limit reached', nodeIds: [] }] });
    core.readUniverseGraph.mockReturnValue(value);
    expect(await cmdUniverseGraph(['calendar'])).toBe(1);
    expect(output.mock.calls[0]![0]).toContain('incomplete projection');
    expect(output.mock.calls[0]![0]).toContain('Issue graph-limit: Graph node limit reached');
    expect(output.mock.calls[0]![0]).toContain('complete totals are unavailable');
  });

  it('executes a real deep-graph traversal without treating omitted descendants as a complete result', async () => {
    const { traverseUniverseGraph } = await import('../src/core/universe/graph-query.js');
    const value = graph();
    value.nodes = Array.from({ length: 70 }, (_, index) => ({ id: `node-${index}`, kind: 'trial',
      universeId: 'calendar', label: `Trial ${index}`, state: 'passed', evidence: 'recorded' }));
    value.edges = value.nodes.slice(1).map((node, index) => ({ id: `edge-${index}`,
      from: value.nodes[index]!.id, to: node.id, kind: 'parent' }));
    value.counts = { nodes: 70, edges: 69, trials: 70, currentElites: 1, verifiedDeliveries: 0 };
    core.readUniverseGraph.mockReturnValue(value);
    core.traverseUniverseGraph.mockImplementation(traverseUniverseGraph);
    expect(await cmdUniverseGraph(['calendar', '--node', 'node-0', '--direction', 'descendants', '--json'])).toBe(1);
    const result = JSON.parse(output.mock.calls[0]![0] as string);
    expect(result.graph.counts.nodes).toBe(70);
    expect(result.traversal.nodeIds).toHaveLength(65);
    expect(result.traversal.complete).toBe(false);
    expect(result.traversal.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'depth-limit' })]));
  });

  it('keeps failed or depth-limited traversal distinct from a healthy source', async () => {
    core.traverseUniverseGraph.mockReturnValue({ nodeIds: [], edgeIds: [], complete: false,
      issues: [{ code: 'invalid-node', message: 'Node not found in graph', nodeIds: [] }] });
    expect(await cmdUniverseGraph(['calendar', '--node', 'missing'])).toBe(1);
    expect(output.mock.calls[0]![0]).toContain('source healthy');
    expect(output.mock.calls[0]![0]).toContain('Traversal: 0 nodes · 0 relationships · incomplete');
    expect(output.mock.calls[0]![0]).toContain('Traversal issue invalid-node');
  });

  it('renders only visited nodes while retaining explicit full-graph counts', async () => {
    expect(await cmdUniverseGraph(['calendar', '--node', 'trial:example'])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Full graph: 2 nodes · 1 relationships · 1 trials');
    expect(text).toContain('trial:example · trial');
    expect(text).not.toContain('run:example · run');
    expect(text).not.toContain('--contains-->');
    expect(text).toContain('Parent ancestry and feedback are distinct');
    expect(text).toContain('not production acceptance');
  });

  it('routes graph through the existing Universe dispatcher', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['graph', 'calendar', '--json'])).toBe(0);
    expect(core.readUniverseGraph).toHaveBeenCalledWith('calendar', { root: undefined });
  });

  it.each([['--help'], ['calendar', '-h']])('prints graph help for %j without reading', async (...args) => {
    expect(await cmdUniverseGraph(args)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('range 1..64');
    expect(output.mock.calls[0]![0]).toContain('Reads never create a missing store');
    expect(core.readUniverseGraph).not.toHaveBeenCalled();
  });

  it('reports a read exception in JSON without retrying', async () => {
    core.readUniverseGraph.mockImplementation(() => { throw new Error('Evidence unavailable'); });
    expect(await cmdUniverseGraph(['calendar', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Evidence unavailable' });
    expect(core.readUniverseGraph).toHaveBeenCalledOnce();
    expect(core.traverseUniverseGraph).not.toHaveBeenCalled();
  });

  it('reports non-JSON errors on stderr', async () => {
    core.readUniverseGraph.mockImplementation(() => { throw new Error('Evidence unavailable'); });
    expect(await cmdUniverseGraph(['calendar'])).toBe(1);
    expect(errors).toHaveBeenCalledWith('universe graph: Evidence unavailable');
  });

  it('registers read-only agent help and the bounded traversal JSON shape', async () => {
    const { AGENT_COMMANDS } = await import('../src/cli/help.js');
    const entry = AGENT_COMMANDS.find((item) => item.usage.startsWith('ashlr universe graph'))!;
    expect(entry.safety).toBe('read');
    expect(entry.jsonShape).toContain('{graph: UniverseGraph, traversal: UniverseGraphTraversal}');
    expect(entry.description).toContain('No provider calls');
  });

  it.each(['bash', 'zsh'])('includes graph in %s completion', async (shell) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { cmdCompletions } = await import('../src/cli/completions.js');
    expect(await cmdCompletions([shell])).toBe(0);
    expect(stdout.mock.calls.map(([value]) => value).join('')).toMatch(/universe\).*graph/);
  });
});
