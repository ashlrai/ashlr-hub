/** Read-only occurrence graph; recorded artifact digests are not fresh byte checks. */
export type UniverseGraphNodeKind = 'universe' | 'seed' | 'comparator' | 'campaign' | 'reservation' | 'run' | 'trial' | 'artifact' | 'delivery';
export type UniverseGraphEdgeKind = 'contains' | 'seed-parent' | 'parent' | 'feedback' | 'evaluates' | 'produced' | 'reserved' | 'executed-as' | 'delivered-as';

export interface UniverseGraphNode {
  id: string;
  kind: UniverseGraphNodeKind;
  label: string;
  universeId: string;
  state: string;
  evidence: 'recorded' | 'verified-local-delivery' | 'pending' | 'unavailable';
  runId?: string;
  trialId?: string;
  niche?: string;
  generation?: number;
  score?: number | null;
  artifactDigest?: string;
  currentElite?: boolean;
  admitted?: boolean;
  variantId?: string;
  campaignId?: string;
  deliveryId?: string;
  branch?: string;
  commit?: string;
  manifestDigest?: string;
  comparatorDigest?: string;
}
export interface UniverseGraphEdge { id: string; from: string; to: string; kind: UniverseGraphEdgeKind }
export interface UniverseGraphIssue { code: string; message: string; nodeIds: string[] }
export interface UniverseGraphFinding {
  id: string;
  kind: 'repeated-output' | 'undelivered-current-elite';
  nodeIds: string[];
  trialIds: string[];
  artifactDigest: string;
  trialCount: number;
  recordedTokens: number;
  reportedTokens: number | null;
  usageComplete: boolean;
}
export interface UniverseGraph {
  schemaVersion: 1;
  sampledAt: string;
  universeId: string;
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  authority: 'observation-only';
  measurementScope: 'local-experiment';
  nodes: UniverseGraphNode[];
  edges: UniverseGraphEdge[];
  findings: UniverseGraphFinding[];
  issues: UniverseGraphIssue[];
  /** Counts cover included nodes; they are not complete totals when complete is false. */
  counts: { nodes: number; edges: number; trials: number; currentElites: number; verifiedDeliveries: number };
  limits: { maxNodes: number; maxEdges: number; maxFindings: number };
}
export interface UniverseGraphTraversal {
  nodeIds: string[];
  edgeIds: string[];
  complete: boolean;
  issues: UniverseGraphIssue[];
}
