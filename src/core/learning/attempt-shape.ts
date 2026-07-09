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

export const PRODUCTION_ATTEMPT_LEARNING_LABEL_SCHEMA_VERSION = 1;
export const PRODUCTION_ATTEMPT_LEARNING_CLASSIFIER_VERSION = 'attempt-shape-v1';

export interface ProductionAttemptLearningClassification {
  attemptShape: ProductionAttemptShape;
  policySuppressed: boolean;
  diagnosticNoProposal: boolean;
  diagnosticAttempt: boolean;
  kind: ProductionAttemptLearningKind;
}

export interface ProductionAttemptLearningLabel {
  schemaVersion: typeof PRODUCTION_ATTEMPT_LEARNING_LABEL_SCHEMA_VERSION;
  classifierVersion: typeof PRODUCTION_ATTEMPT_LEARNING_CLASSIFIER_VERSION;
  authoritative: true;
  learningKind: ProductionAttemptLearningKind;
  attemptShape: ProductionAttemptShape;
  policySuppressed: boolean;
  diagnosticNoProposal: boolean;
  diagnosticAttempt: boolean;
}

const PRODUCTION_ATTEMPT_LEARNING_KINDS = new Set<ProductionAttemptLearningKind>([
  'proposal-created',
  'diagnostic-no-proposal',
  'policy-suppressed',
  'failed',
  'blocked',
  'unknown',
]);

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

export function productionAttemptLearningLabelFromSignals(
  signals: ProductionAttemptShapeSignals,
): ProductionAttemptLearningLabel {
  return productionAttemptLearningLabelFromClassification(classifyProductionAttemptForLearning(signals));
}

export function productionAttemptLearningLabelFromClassification(
  classification: ProductionAttemptLearningClassification,
): ProductionAttemptLearningLabel {
  return {
    schemaVersion: PRODUCTION_ATTEMPT_LEARNING_LABEL_SCHEMA_VERSION,
    classifierVersion: PRODUCTION_ATTEMPT_LEARNING_CLASSIFIER_VERSION,
    authoritative: true,
    learningKind: classification.kind,
    policySuppressed: classification.policySuppressed,
    diagnosticNoProposal: classification.diagnosticNoProposal,
    diagnosticAttempt: classification.diagnosticAttempt,
    attemptShape: {
      backendNoDiff: nonNegativeInteger(classification.attemptShape.backendNoDiff) ?? 0,
      captureOrGateBlocked: nonNegativeInteger(classification.attemptShape.captureOrGateBlocked) ?? 0,
      repairAttempts: nonNegativeInteger(classification.attemptShape.repairAttempts) ?? 0,
      policyDisabled: nonNegativeInteger(classification.attemptShape.policyDisabled) ?? 0,
    },
  };
}

export function sanitizeProductionAttemptLearningLabel(
  value: unknown,
): ProductionAttemptLearningLabel | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== PRODUCTION_ATTEMPT_LEARNING_LABEL_SCHEMA_VERSION) return undefined;
  if (record['classifierVersion'] !== PRODUCTION_ATTEMPT_LEARNING_CLASSIFIER_VERSION) return undefined;
  if (record['authoritative'] !== true) return undefined;
  const learningKind = typeof record['learningKind'] === 'string' &&
    PRODUCTION_ATTEMPT_LEARNING_KINDS.has(record['learningKind'] as ProductionAttemptLearningKind)
    ? record['learningKind'] as ProductionAttemptLearningKind
    : undefined;
  if (!learningKind) return undefined;
  const policySuppressed = optionalBoolean(record['policySuppressed']);
  const diagnosticNoProposal = optionalBoolean(record['diagnosticNoProposal']);
  const diagnosticAttempt = optionalBoolean(record['diagnosticAttempt']);
  const canonical = learningFlagsForKind(learningKind);
  if (
    policySuppressed === undefined ||
    diagnosticNoProposal === undefined ||
    diagnosticAttempt === undefined
  ) {
    return undefined;
  }
  const attemptShape = productionAttemptShapeFromUnknown(record['attemptShape']);
  if (!attemptShape) return undefined;
  return {
    schemaVersion: PRODUCTION_ATTEMPT_LEARNING_LABEL_SCHEMA_VERSION,
    classifierVersion: PRODUCTION_ATTEMPT_LEARNING_CLASSIFIER_VERSION,
    authoritative: true,
    learningKind,
    policySuppressed: canonical.policySuppressed,
    diagnosticNoProposal: canonical.diagnosticNoProposal,
    diagnosticAttempt: canonical.diagnosticAttempt,
    attemptShape,
  };
}

export function classifyProductionAttemptForLearningWithLabel(
  signals: ProductionAttemptShapeSignals,
  label: unknown,
): ProductionAttemptLearningClassification {
  const stored = sanitizeProductionAttemptLearningLabel(label);
  if (stored) {
    return {
      kind: stored.learningKind,
      policySuppressed: stored.policySuppressed,
      diagnosticNoProposal: stored.diagnosticNoProposal,
      diagnosticAttempt: stored.diagnosticAttempt,
      attemptShape: stored.attemptShape,
    };
  }
  return classifyProductionAttemptForLearning(signals);
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

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function productionAttemptShapeFromUnknown(value: unknown): ProductionAttemptShape | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    backendNoDiff: nonNegativeInteger(record['backendNoDiff']) ?? 0,
    captureOrGateBlocked: nonNegativeInteger(record['captureOrGateBlocked']) ?? 0,
    repairAttempts: nonNegativeInteger(record['repairAttempts']) ?? 0,
    policyDisabled: nonNegativeInteger(record['policyDisabled']) ?? 0,
  };
}

function learningFlagsForKind(kind: ProductionAttemptLearningKind): {
  policySuppressed: boolean;
  diagnosticNoProposal: boolean;
  diagnosticAttempt: boolean;
} {
  return {
    policySuppressed: kind === 'policy-suppressed',
    diagnosticNoProposal: kind === 'diagnostic-no-proposal',
    diagnosticAttempt: kind !== 'policy-suppressed' && kind !== 'unknown',
  };
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
