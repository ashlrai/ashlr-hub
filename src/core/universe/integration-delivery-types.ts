import type { UniverseIntegrationEvaluationRequest } from './integration-evaluation-types.js';

/** Explicit promotion request for an already verified, passing integration evaluation. */
export interface UniverseIntegrationDeliveryRequest {
  schemaVersion: 1;
  evaluation: UniverseIntegrationEvaluationRequest;
  expectedEvaluationDigest: string;
  branch: string;
  /** Covers evidence inspection, Git plumbing, and one ref transaction. */
  maxDurationMs: number;
}

/** Durable branch-publication evidence for an integration evaluation; not a trial or elite receipt. */
export interface UniverseIntegrationDeliveryReceipt {
  schemaVersion: 1;
  id: string;
  requestDigest: string;
  evaluationRequestDigest: string;
  evaluationResultDigest: string;
  universeId: string;
  evaluationId: string;
  manifestDigest: string;
  comparatorDigest: string;
  compositionDigest: string;
  artifactDigest: string;
  repo: string;
  branch: string;
  baseCommit: string;
  commit: string;
  tree: string;
  changedFiles: string[];
  status: 'pending' | 'delivered' | 'unchanged';
  createdAt: string;
  completedAt: string | null;
}
