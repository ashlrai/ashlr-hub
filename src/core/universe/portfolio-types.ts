import type { UniverseCampaignSummary } from './types.js';

export interface UniversePortfolioTask {
  campaignId: string;
  /** Ordering only: a completed dependency does not prove accepted work or causality. */
  dependsOn: string[];
}

/** Caller-owned, explicitly enrolled campaigns; no implicit inventory discovery. */
export interface UniversePortfolioDefinition {
  schemaVersion: 1;
  id: string;
  tasks: UniversePortfolioTask[];
  /** This invocation's concurrency, not a machine-wide or provider quota. */
  maxParallel: number;
  /** This invocation's duration; existing campaign deadlines are never reset. */
  maxDurationMs: number;
}

export type UniversePortfolioNodeState = 'ready' | 'waiting' | 'completed' | 'blocked' | 'busy' | 'unavailable';

export interface UniversePortfolioPlanNode {
  campaignId: string;
  dependsOn: string[];
  universeId: string | null;
  campaign: UniverseCampaignSummary | null;
  /** Pins are present only when the selected campaign evidence is healthy. */
  definitionDigest: string | null;
  manifestDigest: string | null;
  comparatorDigest: string | null;
  state: UniversePortfolioNodeState;
  reason: string | null;
}

export interface UniversePortfolioPlan {
  schemaVersion: 1;
  definition: UniversePortfolioDefinition;
  definitionDigest: string;
  sampledAt: string;
  measurementScope: 'local-experiment';
  sourceState: 'healthy' | 'degraded';
  /** Fixed bounded diagnostics, never copied storage errors or private paths. */
  reasons: string[];
  /** Nodes retain definition order; topologicalOrder provides dependency order. */
  nodes: UniversePortfolioPlanNode[];
  topologicalOrder: string[];
}
