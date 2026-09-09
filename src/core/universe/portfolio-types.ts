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

/** A bounded, read-only ordering projection; it neither schedules nor delivers work. */
export interface UniversePortfolioGraphNode {
  campaignId: string;
  state: UniversePortfolioNodeState;
  /** Direct ordering prerequisites retained in declared order. */
  dependsOn: string[];
  /** Direct prerequisites that are not currently completed. */
  unmetDependencyIds: string[];
  /** Intrinsic or propagated blocked/unavailable causes, deduplicated. */
  blockingRootIds: string[];
  /** Intrinsic busy or propagated waiting causes, deduplicated. */
  waitingRootIds: string[];
  /** All transitive dependants, ordered by the caller-stable topology. */
  structuralDescendantIds: string[];
  /** Descendants currently carrying this campaign as a blocking or waiting root. */
  affectedDescendantIds: string[];
  /** Zero-based longest prerequisite depth. */
  layer: number;
}

export interface UniversePortfolioGraphProjection {
  schemaVersion: 1;
  scope: 'campaign-ordering-only';
  authority: 'observation-only';
  /** Ready under the existing portfolio state model; this is not a dispatch decision. */
  dependencyReadyCampaignIds: string[];
  /** Empty whenever the selected campaign source is degraded. */
  invocationCandidateIds: string[];
  /** Campaign IDs by structural prerequisite depth. */
  layers: string[][];
  counts: {
    nodes: number;
    edges: number;
    states: Record<UniversePortfolioNodeState, number>;
  };
  /** Nodes retain definition order. */
  nodes: UniversePortfolioGraphNode[];
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
  /** Ordering observation only; it grants no execution, delivery, or provider authority. */
  graph: UniversePortfolioGraphProjection;
}
