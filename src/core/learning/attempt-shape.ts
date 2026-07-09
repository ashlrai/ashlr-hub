import type { ProductionAttemptShape, RunActionCounts } from '../types.js';

export interface ProductionAttemptShapeSignals {
  outcome?: string | null;
  proposalCreated?: boolean | null;
  actionCounts?: RunActionCounts;
}

export type ProductionAttemptLearningKind =
  | 'proposal-created'
  | 'diagnostic-no-proposal'
  | 'policy-suppressed'
  | 'failed'
  | 'blocked'
  | 'unknown';

export interface ProductionAttemptLearningClassification {
  attemptShape: ProductionAttemptShape;
  policySuppressed: boolean;
  diagnosticNoProposal: boolean;
  diagnosticAttempt: boolean;
  kind: ProductionAttemptLearningKind;
}

export function emptyProductionAttemptShape(): ProductionAttemptShape {
  return {
    backendNoDiff: 0,
    captureOrGateBlocked: 0,
    repairAttempts: 0,
    policyDisabled: 0,
  };
}

export function addProductionAttemptShape(
  target: ProductionAttemptShape,
  source: ProductionAttemptShape | undefined,
): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  target.backendNoDiff = safeAdd(target.backendNoDiff, source.backendNoDiff);
  target.captureOrGateBlocked = safeAdd(target.captureOrGateBlocked, source.captureOrGateBlocked);
  target.repairAttempts = safeAdd(target.repairAttempts, source.repairAttempts);
  target.policyDisabled = safeAdd(target.policyDisabled, source.policyDisabled);
}

export function hasProductionAttemptShape(shape: ProductionAttemptShape): boolean {
  return shape.backendNoDiff > 0 ||
    shape.captureOrGateBlocked > 0 ||
    shape.repairAttempts > 0 ||
    shape.policyDisabled > 0;
}

export function productionAttemptShapeFromSignals(
  signals: ProductionAttemptShapeSignals,
): ProductionAttemptShape {
  const shape = emptyProductionAttemptShape();
  const outcome = normalizeOutcome(signals.outcome);
  const counts = actionCountsRecord(signals.actionCounts);
  const diffFiles = nonNegativeInteger(counts?.diffFiles);
  const proposalBlocked = nonNegativeInteger(counts?.proposalBlocked) ?? 0;
  const proposalDisabled = nonNegativeInteger(counts?.proposalDisabled) ?? 0;
  const completenessGateRuns = nonNegativeInteger(counts?.completenessGateRuns) ?? 0;
  const verifyRepairAttempts = nonNegativeInteger(counts?.verifyRepairAttempts) ?? 0;
  const produced = signals.proposalCreated === true || outcome === 'proposal-created';
  const policyDisabled = outcome === 'proposal-disabled' || proposalDisabled > 0;
  const gateish = outcome === 'gate-blocked' || outcome === 'proposal-capture-error';
  const backendNoDiff =
    !policyDisabled &&
    !produced &&
    (outcome === 'empty-diff' || (diffFiles === 0 && !gateish));

  if (backendNoDiff) shape.backendNoDiff = 1;
  if (policyDisabled) shape.policyDisabled = Math.max(1, proposalDisabled);
  if (
    !policyDisabled &&
    !backendNoDiff &&
    (gateish || proposalBlocked > 0 || completenessGateRuns > 0)
  ) {
    shape.captureOrGateBlocked = 1;
  }
  shape.repairAttempts = verifyRepairAttempts;
  return shape;
}

export function classifyProductionAttemptForLearning(
  signals: ProductionAttemptShapeSignals,
): ProductionAttemptLearningClassification {
  const attemptShape = productionAttemptShapeFromSignals(signals);
  const outcome = normalizeOutcome(signals.outcome);
  const produced = signals.proposalCreated === true || outcome === 'proposal-created';
  const policySuppressed = attemptShape.policyDisabled > 0;
  const failed = isFailedOutcome(outcome);
  const blocked = isBlockedOutcome(outcome);
  const diagnosticNoProposal = !produced && !policySuppressed && !failed && !blocked && (
    signals.proposalCreated === false ||
    outcome === 'no-proposal' ||
    outcome === 'empty-diff' ||
    outcome === 'gate-blocked' ||
    outcome === 'proposal-capture-error' ||
    attemptShape.backendNoDiff > 0 ||
    attemptShape.captureOrGateBlocked > 0
  );
  const kind: ProductionAttemptLearningKind = produced
    ? 'proposal-created'
    : policySuppressed
      ? 'policy-suppressed'
      : diagnosticNoProposal
        ? 'diagnostic-no-proposal'
        : failed
          ? 'failed'
          : blocked
            ? 'blocked'
            : 'unknown';
  return {
    attemptShape,
    policySuppressed,
    diagnosticNoProposal,
    diagnosticAttempt: kind !== 'policy-suppressed' && kind !== 'unknown',
    kind,
  };
}

function actionCountsRecord(counts: RunActionCounts | undefined): Record<string, unknown> | undefined {
  return counts && typeof counts === 'object' && !Array.isArray(counts)
    ? counts as Record<string, unknown>
    : undefined;
}

function normalizeOutcome(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function safeAdd(left: number, right: number): number {
  const a = nonNegativeInteger(left) ?? 0;
  const b = nonNegativeInteger(right) ?? 0;
  return Math.min(a + b, Number.MAX_SAFE_INTEGER);
}

function isFailedOutcome(outcome: string | undefined): boolean {
  return outcome === 'failed' ||
    outcome === 'rejected' ||
    outcome === 'engine-failed' ||
    outcome === 'sandbox-failed';
}

function isBlockedOutcome(outcome: string | undefined): boolean {
  return outcome === 'blocked' || outcome === 'skipped';
}
