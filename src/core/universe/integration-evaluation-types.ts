import type { UniverseIntegrationDefinition } from './integration-types.js';

export interface UniverseIntegrationEvaluationRequest {
  schemaVersion: 1;
  /** Binds one exact request; unresolved attempts require reconciliation, not a new ID. */
  id: string;
  integration: UniverseIntegrationDefinition;
  expectedCompositionDigest: string;
  acceptance: { universeId: string; manifestDigest: string; comparatorDigest: string };
  /** Covers all source checks, materialization, and one fixed evaluator attempt. */
  maxDurationMs: number;
}

export type UniverseIntegrationEvaluationStatus = 'passed' | 'rejected' | 'failed' | 'timed-out' | 'cancelled';

/** A durable local fixed-evaluator observation; it neither selects nor delivers work. */
export interface UniverseIntegrationEvaluationResult {
  schemaVersion: 1;
  id: string;
  requestDigest: string;
  status: UniverseIntegrationEvaluationStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  acceptance: UniverseIntegrationEvaluationRequest['acceptance'];
  compositionDigest: string;
  artifactDigest: string | null;
  /** Private frozen archive path, present only for a measured pass or rejection. */
  artifactPath: string | null;
  score: number | null;
  metrics: Record<string, number>;
  /** Fixed public classification only; evaluator output and private error text are withheld. */
  reason: 'rejected-by-fixed-evaluator' | 'composition-changed' | 'evaluator-failed' |
    'evaluation-timed-out' | 'evaluation-cancelled' | 'candidate-materialization-failed' | null;
}

/** Concise public alias for the durable evaluation receipt. */
export type UniverseIntegrationEvaluation = UniverseIntegrationEvaluationResult;
