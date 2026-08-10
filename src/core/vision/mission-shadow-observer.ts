/**
 * Read-only adapter from current Mission OS sources to a verified shadow
 * suggestion. This module never creates a receipt or mutates planning state.
 */

import {
  captureMissionObservation,
  type MissionObservationCaptureFailureReason,
  type MissionObservationCaptureInput,
} from './mission-observation-capture.js';
import {
  readMissionObservationReceipts,
  verifyMissionObservationReceipt,
  type MissionObservationReceiptReadResult,
  type MissionObservationReceiptV1,
} from './mission-receipt.js';
import {
  planMissionReconcileShadow,
  verifyMissionReconcileSuggestion,
  type MissionReconcilePreviewCandidate,
  type MissionReconcileShadowHoldReason,
  type MissionReconcileShadowSkipReason,
  type MissionReconcileSuggestionV1,
} from './mission-reconcile-shadow.js';
import type { BriefingAdoptionPreview } from './strategist.js';

export interface MissionShadowObservationInput extends MissionObservationCaptureInput {
  preview: BriefingAdoptionPreview;
}

export type MissionShadowObservationReason =
  | 'would-create'
  | MissionReconcileShadowHoldReason
  | MissionReconcileShadowSkipReason
  | MissionObservationCaptureFailureReason
  | 'receipt-source-degraded'
  | 'suggestion-invalid';

interface MissionShadowReceiptSource {
  state: 'verified' | 'missing' | 'degraded';
  recordedAt: string | null;
}

interface MissionShadowObservationBase {
  schemaVersion: 1;
  mode: 'shadow';
  authority: 'observation-only';
  receipt: MissionShadowReceiptSource;
}

export type MissionShadowObservation =
  | (MissionShadowObservationBase & {
      state: 'would-create';
      reason: 'would-create';
      suggestion: MissionReconcileSuggestionV1;
    })
  | (MissionShadowObservationBase & {
      state: 'held';
      reason: MissionReconcileShadowHoldReason;
      suggestion: MissionReconcileSuggestionV1;
    })
  | (MissionShadowObservationBase & {
      state: 'missing';
      reason: 'receipt-missing';
      suggestion: null;
    })
  | (MissionShadowObservationBase & {
      state: 'withheld';
      reason: Exclude<MissionShadowObservationReason, 'would-create' | MissionReconcileShadowHoldReason | 'receipt-missing'>;
      suggestion: null;
    });

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function latestReceiptForMission(
  receipts: readonly MissionObservationReceiptV1[],
  missionKey: string,
  graphDigest: string,
): MissionObservationReceiptV1 | null {
  let latest: MissionObservationReceiptV1 | null = null;
  for (const candidate of receipts) {
    const receipt = verifyMissionObservationReceipt(candidate);
    if (!receipt || receipt.missionKey !== missionKey || receipt.graphDigest !== graphDigest) continue;
    if (latest === null || codeUnitCompare(latest.recordedAt, receipt.recordedAt) < 0 ||
      (latest.recordedAt === receipt.recordedAt && codeUnitCompare(latest.receiptId, receipt.receiptId) < 0)) {
      latest = receipt;
    }
  }
  return latest;
}

function previewCandidates(input: MissionShadowObservationInput): MissionReconcilePreviewCandidate[] | null {
  const graphOrder = new Map(input.graph.nodes.map((node, index) => [node.key, index]));
  const graphKind = new Map(input.graph.nodes.map((node) => [node.key, node.kind]));
  if (input.preview.entries.length !== input.graph.nodes.length) return null;

  const seen = new Set<string>();
  const candidates: MissionReconcilePreviewCandidate[] = [];
  for (const entry of input.preview.entries) {
    const nodeKey = entry.missionNodeKey;
    if (typeof nodeKey !== 'string' || seen.has(nodeKey) || entry.missionKey !== input.graph.missionKey ||
      entry.missionGraphDigest !== input.graph.graphDigest || entry.reason === 'goal-source-degraded') return null;
    const order = graphOrder.get(nodeKey);
    const kind = graphKind.get(nodeKey);
    if (order === undefined || kind === undefined) return null;
    seen.add(nodeKey);
    candidates.push({
      graphOrder: order,
      nodeKey,
      kind,
      disposition: entry.disposition,
      reason: entry.reason,
    });
  }
  return seen.size === input.graph.nodes.length ? candidates : null;
}

function receiptReadComplete(read: MissionObservationReceiptReadResult): boolean {
  return read.complete === true && read.sourceState !== 'degraded' && read.limitExceeded !== true &&
    read.invalidFiles === 0;
}

function receiptReadMissing(read: MissionObservationReceiptReadResult): boolean {
  return read.sourceState === 'missing' && read.sourcePresent === false && read.receipts.length === 0 &&
    read.stopReasons.length === 0 && read.filesRead === 0 && read.bytesRead === 0 &&
    read.invalidFiles === 0 && read.limitExceeded === false;
}

/**
 * Produce a current shadow observation from a caller-supplied, bounded receipt
 * read. Exported separately so source selection and race semantics are directly
 * testable without adding an injectable production reader.
 */
export function observeMissionReconcileShadowFromRead(
  input: MissionShadowObservationInput,
  receiptRead: MissionObservationReceiptReadResult,
): MissionShadowObservation {
  const { preview: _preview, ...captureInput } = input;
  const captured = captureMissionObservation(captureInput);
  if (!captured.ok) {
    return {
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'withheld',
      reason: captured.reason,
      receipt: { state: 'degraded', recordedAt: null },
      suggestion: null,
    };
  }
  const candidates = previewCandidates(input);
  if (!candidates) {
    return {
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'withheld',
      reason: 'preview-invalid',
      receipt: { state: 'degraded', recordedAt: null },
      suggestion: null,
    };
  }
  if (receiptReadMissing(receiptRead)) {
    return {
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'missing',
      reason: 'receipt-missing',
      receipt: { state: 'missing', recordedAt: null },
      suggestion: null,
    };
  }
  if (!receiptReadComplete(receiptRead)) {
    return {
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'withheld',
      reason: 'receipt-source-degraded',
      receipt: { state: 'degraded', recordedAt: null },
      suggestion: null,
    };
  }

  const receipt = latestReceiptForMission(
    receiptRead.receipts,
    input.graph.missionKey,
    input.graph.graphDigest,
  );
  if (!receipt) {
    return {
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'missing',
      reason: 'receipt-missing',
      receipt: { state: 'missing', recordedAt: null },
      suggestion: null,
    };
  }

  const source = (value: typeof captured.receiptInput.goalSource) => ({
    state: value.sourceState,
    complete: value.complete,
    digest: value.digest,
  });
  const plan = planMissionReconcileShadow({
    mode: 'shadow',
    receiptEvidence: { state: 'verified', receipt },
    current: {
      missionKey: input.graph.missionKey,
      graphDigest: input.graph.graphDigest,
      briefingDigest: captured.receiptInput.briefingSource.digest,
      briefingSource: source(captured.receiptInput.briefingSource),
      enrollmentSource: source(captured.receiptInput.enrollmentSource),
      goalSource: source(captured.receiptInput.goalSource),
      proposalSource: source(captured.receiptInput.proposalSource),
      activeGoalThreshold: input.preview.activeThreshold,
      candidates,
    },
  });
  if (!plan.suggestion) {
    const reason = plan.reason === 'receipt-missing' ? 'receipt-invalid' : plan.reason;
    return {
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'withheld',
      reason,
      receipt: { state: 'verified', recordedAt: receipt.recordedAt },
      suggestion: null,
    };
  }
  const suggestion = verifyMissionReconcileSuggestion(plan.suggestion);
  if (!suggestion) {
    return {
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'withheld',
      reason: 'suggestion-invalid',
      receipt: { state: 'verified', recordedAt: receipt.recordedAt },
      suggestion: null,
    };
  }
  if (plan.disposition === 'would-create') {
    return {
      schemaVersion: 1,
      mode: 'shadow',
      authority: 'observation-only',
      state: 'would-create',
      reason: 'would-create',
      receipt: { state: 'verified', recordedAt: receipt.recordedAt },
      suggestion,
    };
  }
  return {
    schemaVersion: 1,
    mode: 'shadow',
    authority: 'observation-only',
    state: 'held',
    reason: plan.reason,
    receipt: { state: 'verified', recordedAt: receipt.recordedAt },
    suggestion,
  };
}

/** Read the complete immutable ledger and produce a zero-effect observation. */
export function observeMissionReconcileShadow(
  input: MissionShadowObservationInput,
): MissionShadowObservation {
  return observeMissionReconcileShadowFromRead(
    input,
    readMissionObservationReceipts({ requireComplete: true }),
  );
}
