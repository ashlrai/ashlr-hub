/** Explicit opt-in; legacy replacement-only generation has no such property. */
export interface UniverseFileOperationsConfig {
  schemaVersion: 1;
  contextFiles: string[];
}

export interface UniverseFileState {
  path: string;
  /** Null means absent, never an empty file or an unreadable source. */
  contentDigest: string | null;
}

export interface UniverseFileOperationEvidence {
  op: 'create' | 'replace' | 'delete';
  path: string;
  beforeDigest: string | null;
  afterDigest: string | null;
}

export interface UniverseFileOperationsReceipt {
  schemaVersion: 1;
  contextDigest: string | null;
  /** Actual changes only; a byte-identical replacement is omitted. */
  operations: UniverseFileOperationEvidence[];
}

export interface UniverseFileOperationsContext {
  schemaVersion: 1;
  universeId: string;
  manifestDigest: string;
  comparatorDigest: string;
  variantId: string;
  generation: number;
  parent: {
    /** Both null and generation zero identify the unmeasured pinned seed. */
    runId: string | null;
    trialId: string | null;
    generation: number;
    artifactDigest: string;
  };
  files: UniverseFileState[];
  contextFiles: Array<{ path: string; contentDigest: string; content: string }>;
  /** Null when feedback is disabled or there is no previous completed variant. */
  previous: {
    runId: string;
    trialId: string;
    generation: number;
    artifactDigest: string | null;
    /** Empty when the previous attempt has no artifact (unknown, not absent). */
    files: UniverseFileState[];
  } | null;
}
