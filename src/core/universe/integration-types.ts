/** Explicit read-only request to compose already delivered local branch evidence. */
export interface UniverseIntegrationDefinition {
  schemaVersion: 1;
  id: string;
  target: {
    repo: string;
    baseCommit: string;
    /** Exact paths that a source delivery may add, edit, delete, or chmod. */
    allowedPaths: string[];
  };
  /** Two or more independently pinned delivered receipts; source order is intentional. */
  sources: Array<{ universeId: string; deliveryId: string; commit: string; tree: string }>;
}

export interface UniverseIntegrationSourceSummary {
  universeId: string;
  deliveryId: string;
  commit: string;
  tree: string;
  /** Hash of the verified immutable receipt, never a claim about a new artifact. */
  receiptDigest: string | null;
  state: 'verified' | 'unavailable' | 'mismatched';
  changedPathCount: number;
}

/** Final overlay entries only; nulls mean a source deletes the path from the common base. */
export interface UniverseIntegrationEntry {
  path: string;
  oid: string | null;
  executable: boolean | null;
  sourceDeliveryIds: string[];
}

export interface UniverseIntegrationConflict {
  code: 'path-conflict' | 'file-directory-conflict' | 'case-fold-conflict';
  paths: string[];
  sourceDeliveryIds: string[];
}

/**
 * A read-only recipe over verified delivery evidence. This does not write a Git
 * tree or ref, create an artifact, run an evaluator, or establish acceptance.
 */
export interface UniverseIntegrationPlan {
  schemaVersion: 1;
  scope: 'same-repository-pinned-base-overlay';
  authority: 'observation-only';
  definition: UniverseIntegrationDefinition;
  sourceState: 'healthy' | 'degraded';
  reasons: string[];
  sources: UniverseIntegrationSourceSummary[];
  /** Overlay edits only, not a materialized final tree. */
  entries: UniverseIntegrationEntry[];
  conflicts: UniverseIntegrationConflict[];
  /** Recipe identity only; it is not a Git tree, artifact, evaluator, or acceptance digest. */
  compositionDigest: string | null;
  compositionReady: boolean;
}
