import { describe, expect, it } from 'vitest';
import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';
import { matchControllerCampaigns, prioritizeControllerEdges } from './controller-navigation.js';

const outcomes: UniversePortfolioControllerView['outcomes'] = [
  { campaignId: 'ship', state: 'pending', attempted: false, reasonCode: 'dependency-held' },
  { campaignId: 'foundation', state: 'completed', attempted: true, reasonCode: 'completed' },
  { campaignId: 'engine', state: 'in-flight', attempted: true, reasonCode: 'dispatch-unresolved' },
  { campaignId: 'interface', state: 'held', attempted: true, reasonCode: 'dispatch-not-started' },
];

describe('controller campaign navigation', () => {
  it('matches campaign IDs and reason codes as case-insensitive trimmed substrings', () => {
    expect(matchControllerCampaigns(outcomes, '  InTer  ', 'all')).toEqual([outcomes[3]]);
    expect(matchControllerCampaigns(outcomes, ' DISPATCH ', 'all')).toEqual([outcomes[2], outcomes[3]]);
    expect(matchControllerCampaigns(outcomes, 'held', 'all')).toEqual([outcomes[0]]);
  });

  it('combines state and text filters without changing input order or evidence', () => {
    const original = structuredClone(outcomes);
    const frozen = Object.freeze(outcomes.map((outcome) => Object.freeze({ ...outcome })));
    expect(matchControllerCampaigns(frozen, 'dispatch', 'held')).toEqual([outcomes[3]]);
    expect(matchControllerCampaigns(frozen, 'dispatch', 'pending')).toEqual([]);
    expect(matchControllerCampaigns(frozen, '', 'all')).toEqual(outcomes);
    expect(matchControllerCampaigns(frozen, '  ', 'all')).not.toBe(frozen);
    expect(outcomes).toEqual(original);
  });

  it.each(['pending', 'in-flight', 'completed', 'held'] as const)('matches only the recorded %s state', (state) => {
    expect(matchControllerCampaigns(outcomes, '', state)).toEqual(outcomes.filter((outcome) => outcome.state === state));
  });

  it.each(['.*', '[', 'ship|engine', '^ship$', 'absent'])('treats query %s literally, not as a pattern', (query) => {
    expect(matchControllerCampaigns(outcomes, query, 'all')).toEqual([]);
  });

  it('handles an empty observation without inventing outcomes', () => {
    expect(matchControllerCampaigns([], '', 'all')).toEqual([]);
  });
});

describe('selected controller edge context', () => {
  const edges = [
    { from: 'a', to: 'b', id: 0 }, { from: 'b', to: 'c', id: 1 },
    { from: 'a', to: 'd', id: 2 }, { from: 'c', to: 'd', id: 3 },
  ];

  it('keeps each partition in declared order, retains edge objects and never duplicates them', () => {
    const frozen = Object.freeze(edges.map((edge) => Object.freeze({ ...edge })));
    const visible = prioritizeControllerEdges(frozen, 'c', 4);
    expect(visible).toEqual([edges[1], edges[3], edges[0], edges[2]]);
    expect(visible[0]).toBe(frozen[1]);
    expect(new Set(visible).size).toBe(4);
    expect(frozen).toEqual(edges);
  });

  it('preserves ordinary order for no selection or a selection with no incident edges', () => {
    expect(prioritizeControllerEdges(edges, null, 2)).toEqual(edges.slice(0, 2));
    expect(prioritizeControllerEdges(edges, 'missing', 2)).toEqual(edges.slice(0, 2));
    expect(prioritizeControllerEdges(edges, null, 100)).not.toBe(edges);
  });

  it('applies the limit after prioritizing selected incoming and outgoing context', () => {
    expect(prioritizeControllerEdges(edges, 'c', 2)).toEqual([edges[1], edges[3]]);
    expect(prioritizeControllerEdges(edges, 'c', 1)).toEqual([edges[1]]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('returns no edges for an invalid or empty budget %s', (limit) => {
    expect(prioritizeControllerEdges(edges, 'c', limit)).toEqual([]);
  });

  it('truncates a fractional budget and handles empty input', () => {
    expect(prioritizeControllerEdges(edges, 'c', 2.9)).toHaveLength(2);
    expect(prioritizeControllerEdges([], 'c', 256)).toEqual([]);
  });

  it('keeps all selected context visible within the 256-edge budget for a dense 64-campaign graph', () => {
    const dense = Array.from({ length: 64 }, (_, to) => Array.from({ length: to }, (_, from) => ({ from: `task-${from}`, to: `task-${to}` }))).flat();
    const before = structuredClone(dense);
    expect(dense).toHaveLength(2016);
    for (let selected = 0; selected < 64; selected++) {
      const id = `task-${selected}`;
      const incident = dense.filter((edge) => edge.from === id || edge.to === id);
      const visible = prioritizeControllerEdges(dense, id, 256);
      expect(incident).toHaveLength(63);
      expect(incident.length).toBeLessThanOrEqual(126);
      expect(visible).toHaveLength(256);
      expect(visible.slice(0, incident.length)).toEqual(incident);
      expect(visible.slice(incident.length)).toEqual(dense.filter((edge) => edge.from !== id && edge.to !== id).slice(0, 256 - incident.length));
      expect(new Set(visible).size).toBe(256);
    }
    expect(dense).toEqual(before);
  });
});
