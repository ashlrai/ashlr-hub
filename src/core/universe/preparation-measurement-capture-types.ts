/** Private diagnostic custody evidence. Never a trial, score or delivery receipt. */
import type { FixedEvaluatorCustodyDiagnostics } from './fixed-evaluator-diagnostics.js';
export interface PreparationMeasurementCaptureRequest {
  root: string;
  universeId: string;
  captureId: string;
}
export interface PreparationMeasurementCaptureIntent {
  schemaVersion: 1;
  captureId: string;
  universeId: string;
  startedAt: string;
  deadlineAt: string;
  timeoutMs: number;
  manifestDigest: string;
  comparatorDigest: string;
  artifact: { path: string; digest: string; revision: string };
  evaluator: {
    id: 'preparation-measurement-v1'; digest: string; executableDigest: string;
    command: string[];
    files: Array<{ name: string; path: string; digest: string }>;
    tools: Array<{ path: string; digest: string }>;
    git: { path: string; digest: string };
  };
}
export interface PreparationMeasurementCaptureReceipt {
  schemaVersion: 1;
  intentDigest: string;
  finishedAt: string;
  durationMs: number;
  outcome: 'captured' | 'failed' | 'cancelled' | 'timed-out' | 'held';
  reason: 'execution-failed' | 'invalid-report' | 'integrity-changed' | 'cancelled' | 'deadline-reached' | 'settlement-unconfirmed' | null;
  processGroupSettlement: 'not-started' | 'group-exit-confirmed' | 'unconfirmed';
  identityVerified: boolean;
  /** Optional only for legacy records; observations never override held custody. */
  custodyDiagnostics?: FixedEvaluatorCustodyDiagnostics;
  /** Exact returned UTF-8 text, including whitespace; null if invalid or truncated. */
  report: { stdout: string; sha256: string; bytes: number; checksPassed: boolean } | null;
}
export interface PreparationMeasurementCapture {
  schemaVersion: 1;
  scope: 'diagnostic-only';
  state: 'missing' | 'held' | 'recorded';
  disposition: 'created' | 'replayed' | null;
  intent: PreparationMeasurementCaptureIntent | null;
  receipt: PreparationMeasurementCaptureReceipt | null;
}
