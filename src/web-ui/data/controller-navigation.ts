import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';

type Outcome = UniversePortfolioControllerView['outcomes'][number];
export type ControllerCampaignStateFilter = 'all' | Outcome['state'];

/** Navigation filters recorded evidence without changing declared execution priority. */
export function matchControllerCampaigns(
  outcomes: readonly Outcome[], query: string, filter: ControllerCampaignStateFilter,
): Outcome[] {
  const needle = query.trim().toLowerCase();
  return outcomes.filter((outcome) => (filter === 'all' || outcome.state === filter) &&
    (outcome.campaignId.toLowerCase().includes(needle) || outcome.reasonCode.toLowerCase().includes(needle)));
}

/** Spend the visual edge budget on selected context first; this never changes task order. */
export function prioritizeControllerEdges<T extends { from: string; to: string }>(
  edges: readonly T[], selectedId: string | null, limit: number,
): T[] {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (selectedId === null) return edges.slice(0, cap);
  const incident: T[] = [];
  const other: T[] = [];
  for (const edge of edges) {
    (edge.from === selectedId || edge.to === selectedId ? incident : other).push(edge);
  }
  return [...incident, ...other].slice(0, cap);
}
